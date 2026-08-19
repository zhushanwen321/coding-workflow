/**
 * 派发 brief 渲染层（从 loop.ts 抽出的纯渲染职责，循环六步之 2：unit 上下文 +
 * role 任务书模板，file-based 传递）。loop.ts 只负责派发决策（frontier → role），
 * 本模块负责「给定维度 → 任务书全文 → 落盘」。
 *
 * 任务书形态按派发依据的 frontier 维度选择（mx-1 起 reviewer 分 spec-review /
 * exec-review 两形态，不再按 role 单值映射）：
 *   - specReady                → designer 首派（撰写 spec；root 无子时含建子第 0 步）
 *   - specReviewPending        → reviewer 独立审 spec（mx-1：内嵌 attachments 绝对路径
 *                                + canon D3 审查语义 + --role reviewer 提交命令）
 *   - specFixPending           → designer 按 fail comment 全文修 spec 重提（mx-1 MF1）
 *   - specContractBroken       → designer 回炉修 spec 的验收命令契约（mx5-2：内嵌
 *                                当前周期逐轮解析失败原文 + 规则⑨式恢复指引；复用
 *                                specFixPending 骨架）
 *   - missingChildren          → designer 补建 split 子（fx-3 R5.3）
 *   - integrationDrift         → designer 处置集成契约漂移（fx-2 R4a / rv-4）
 *   - buildReady / execReviewReady → builder / reviewer（exec-review 含 rv-2 必填
 *                                --evidence-refs 与 mx-1 --role reviewer）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { VerifySequencedUnitProjection } from "../core/fold.js";
import type {
  SequencedProjection,
  SequencedUnitProjection,
  VerifyRanPayload,
} from "../events/types.js";
import {
  type FrontierGroups,
  INTEGRATION_MAX_CONSECUTIVE_FAILS,
  splitChildrenNotCreated,
  splitOf,
} from "../readonly/frontier.js";
import { unitStatus } from "../readonly/load.js";
import { attachmentsDir, evidenceDir, getCwHome } from "../store/project.js";
import { integrationRecoveryGuidance, readIntegrateReport } from "./integrate.js";
import type { AgentRole } from "./spawn/types.js";
import { unitBranchName } from "./worktree.js";

/**
 * 会派发 spawn 的 frontier 维度（specReviewDeadlock / flakeReview /
 * specContractDeadlock 是转人工维度，无任务书——loop 的派发排除清单与本 Exclude
 * 三处联动，设计 mx-5 D2「specReviewDeadlock 同款」）
 */
export type DispatchDimension = Exclude<
  keyof FrontierGroups,
  "specReviewDeadlock" | "flakeReview" | "specContractDeadlock"
>;

/** brief 渲染的派发目标（loop 的 DispatchTarget 结构子集——渲染只需这三元组） */
export interface BriefTarget {
  role: AgentRole;
  unitId: string;
  dimension: DispatchDimension;
}

const ROLE_TASKS: Record<Exclude<AgentRole, "designer">, (unitId: string) => string> = {
  builder: (unitId) => [
    "## 你的任务（builder）",
    "1. 在 workdir 实现该 unit 冻结验收要求的目标并 git commit（取 hash：git rev-parse HEAD）。",
    `2. 提交 build 证据：cw evidence submit --kind build --unit ${unitId} --commit <hash> --run-id <自拟唯一 runId> [--file <产物路径>...]`,
    `3. 触发干净重跑验证：cw verify --unit ${unitId}（默认含红阶段检查——新测试在旧代码树必须 fail，恒真测试会被拒）。`,
    "完成标志：unit 进入 verified。",
  ].join("\n"),
  reviewer: (unitId) => [
    "## 你的任务（reviewer：exec-review）",
    `对该 unit 提交 exec-review 结论（审查依据：cw report --unit ${unitId} 的证据链与 verify 结果）：`,
    `cw review submit --unit ${unitId} --verdict-kind exec-review --verdict pass|fail --role reviewer --comment <意见> --evidence-refs <已入账 runId,...>`,
    "说明：--evidence-refs 是 exec-review 的必填项（rv-2：结论必须引用至少 1 个已入账的",
    "build / verify runId——可用 runId 见 cw report --unit 的输出）；fail 时 --comment 逐条列出不合格项与恢复动作。",
    "完成标志：verdict 为 pass 时 unit 进入 closed。",
  ].join("\n"),
};

/**
 * mx-1：spec-review 的 reviewer 任务书（specReviewPending 派发形态）。审查语义
 * 按 canon §1.3 信任链与 D3「reviewer 第一审对象是验收集合」逐项列出。spec 原文经
 * attachments 绝对路径内嵌（S2：渲染时由 attachmentsDir 计算，不依赖相对路径
 * 锚点——副本由 evidence submit --kind spec 落盘，内容寻址幂等）。
 *
 * mx5-3：审查清单升级为五维度对抗式核对（设计 mx-5 D3）——M4 gate 三跑实证
 * reviewer 曾放行结构性不可通过的验收命令（pass 意见写「A3 区分力较弱……不
 * 构成阻塞，pass」，而其 session 全程未接触机器 gate 硬约束清单；root designer
 * 转述子任务书时又恰好丢掉被违反的两条）。清单进机制生成的任务书模板本体，
 * 不再依赖人转述；输出分级（must-fix / suggestion / info）+ pass 逐项显式
 * 「核过无问题」，针对性反制含糊放行。
 */
function specReviewReviewerTasks(
  unit: SequencedUnitProjection,
  projectCwd: string,
): string {
  const attachDir = attachmentsDir(getCwHome(), projectCwd, unit.unitId);
  return [
    "## 你的任务（reviewer：spec-review）",
    "你是独立 reviewer——审查他人提交的 spec 并给出结论（pass / fail），不修改 spec。",
    "",
    `1. 读 spec 原文：最后一条 SpecSubmitted 的原文副本在 ${attachDir}/ 下`,
    `   （内容寻址文件 = <sha256>.<原文件名>；结构化视图可 cw report --unit ${unit.unitId}）。`,
    "2. 按五维度对抗式核对清单逐条核对（reviewer 的第一审对象是验收集合，不是文风；",
    "   对 spec 的每条验收逐项过——任何一条不过即 fail，不得以「较弱/可补充」为由放行）：",
    "   ① 验收命令契约逐条核对（cw verify 按适配器解析命令产物——契约错 = 实现再对也恒 fail）：",
    "      - unit / integration 型逐条问：命令是否 vitest 兼容——--reporter 值若出现必须",
    "        恰为 json（与 spec gate 规则⑨同口径：cw 自动追加 --reporter=json，命令里混入",
    "        其他 reporter 值会让 stdout 变成文本+JSON 混合体、解析必挂）；install 步骤带 --silent。",
    "      - e2e 型逐条问：stdout 从哪产出 `<验收id> PASS` 标记行？命令里指得出来吗？",
    "        （e2e-sh 适配器靠该标记行判定——裸 build/test 命令 exit 0 也永不产出标记行，",
    "        属结构性不可通过，必须打回）",
    "   ② 覆盖度：brief 的核心风险面是否逐条映射到验收、有无验收真空；e2e 级用例的",
    "      command 是否真实可执行、断言是否指向行为而非实现细节。",
    "   ③ 区分力反例追问（每条验收问两个反例）：无实现时它必然挂吗？换一个实现它还过吗？",
    "      （恒真测试 = 无区分力，须拒）",
    "   ④ 契约（contracts）一致性：spec 声明的跨 unit 接口与冻结 hash 逐条对照关联 unit 的",
    "      冻结契约——签名 / 期望文件任一不符，集成期必炸（不得只看本 unit 自身声明）。",
    "   ⑤ 干净 checkout 可执行性：命令用到的依赖是否全在 package.json 声明、命令是否",
    "      自带 install（verify 在一次性工作区重跑，没有提交者本机的全局依赖与环境）。",
    "   语义关（canon D3 既有要求）：e2e-mock 用例的 mockFidelityNote 是否说明与真实环境的",
    "   差异边界；nondeterministic 声明是否被滥用（声明 ≠ 逃逸执行，随机性判定是语义判断）。",
    "3. 提交结论（输出分级格式约定——--comment 缺分级清单的 verdict 视为无效审查）：",
    `   cw review submit --unit ${unit.unitId} --verdict-kind spec-review --verdict pass|fail --role reviewer --comment <依据>`,
    "   --comment 中的问题逐条按三级列出：must-fix（不修不能过）/ suggestion（应修）/ info（仅记录）。",
    "   verdict 为 pass 时必须对上述每条核对项逐项显式写明「核过无问题」——禁止",
    "   「区分力较弱……不构成阻塞，pass」式含糊放行：未逐项核对的 pass 不被接受。",
    "4. fail 时 --comment 必须逐条列出不合格项与恢复动作（该 comment 会全文内嵌进",
    "   designer 的修 spec 任务书——是打回修复的唯一失败事实来源，勿写「见报告」类空引用）。",
    "完成标志：verdict 入账（pass → unit 进入 spec-frozen；fail → designer 修 spec 后你会再审）。",
  ].join("\n");
}

/**
 * mx-1：specFixPending 的 designer 任务书（fail 打回后的修 spec 形态）。内嵌
 * reviewer fail verdict 的 comment 全文（MF1：失败事实不退化成「见报告」）+
 * 修 spec 指令 + 重提后自然回流 specReviewPending 的说明（designer 不自审）。
 */
function specFixPendingTasks(unit: SequencedUnitProjection): string {
  const lastSpecSeq = unit.lastSpecSeq;
  let failComment: string | null = null;
  if (lastSpecSeq !== null) {
    for (let i = unit.verdicts.length - 1; i >= 0; i -= 1) {
      const verdict = unit.verdicts[i];
      if (
        verdict !== undefined &&
        unit.verdictSeqs[i] !== undefined &&
        unit.verdictSeqs[i] > lastSpecSeq &&
        verdict.verdictKind === "spec-review"
      ) {
        if (verdict.verdict === "fail") {
          failComment = verdict.comment ?? "（reviewer 未附 comment——按不合格项自行核对验收五规则）";
        }
        break;
      }
    }
  }
  return [
    "## 你的任务（designer：按 spec-review 打回意见修 spec）",
    "",
    `unit "${unit.unitId}" 的 spec 被独立 reviewer 判 fail——请按以下失败事实修正 spec 后重提：`,
    "",
    "### reviewer 打回意见（fail verdict comment 全文）",
    failComment ?? "（账本内未见打回 verdict 的 comment——不可达：本任务书仅在 fail 后派发）",
    "",
    "### 修 spec 指令",
    `1. 按上述意见修正 spec.json（验收五规则见 src/gates/spec-rules.ts）。`,
    `2. 重提：cw evidence submit --kind spec --unit ${unit.unitId} --file spec.json`,
    "3. 重提后 unit 自动回流 spec-review 待审队列——由独立 reviewer 再审，你无需（也不得）",
    "   自行提交 review 结论；reviewer 再 fail 将累计打回代数（重提不清零，达预算——默认",
    "   10 代——转人工）。",
    "完成标志：修正后的 spec 已提交入账（审查结论由 reviewer 给出）。",
  ].join("\n");
}

/**
 * 解析失败条目的产物文件名 stem（与 src/verify/run.ts 的 fileStem 同源口径：
 * 白名单外字符替换为 `_`——id 是 spec 作者输入，产物文件名按该规则落盘）。
 * verify/run.ts 属 mx5-2 禁改领地且 fileStem 未导出，此处按同一字符集镜像实现；
 * 两处字符集由 ACCEPTANCE_ID_RE 派生的 id 生态约束（gate 规则⑦拦新账本非法
 * id），漂移面收敛在白名单字符集本身。
 */
function reportStemOf(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 回炉任务书的单条解析失败事实（取数路径见 specContractBrokenTasks 注释） */
interface ParseFailFact {
  acceptanceId: string;
  runId: string;
  /** <id>.report.json 顶层 reason；产物不可读 / 无 reason 时为 null（降级备案） */
  reason: string | null;
  /** 产物文件绝对路径（降级与审计的兜底锚点） */
  reportPath: string;
}

/**
 * <id>.report.json 解析失败形态的形状守卫（顶层 {parseError: true, reason}——
 * src/verify/run.ts 的 parse 抛错分支落盘结构；readIntegrateReport 同款守卫式）
 */
function isParseErrorReport(value: unknown): value is { parseError: true; reason: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.parseError === true && typeof v.reason === "string";
}

/**
 * 当前 spec 周期内逐条解析失败事实的取数（mx5-2 基线 §4 取数检查点——developer
 * 已核实：解析失败原文不在 VerdictSubmitted（那是 reviewer 的语义结论），机器
 * 原文的落盘载体 = verify 产物 <id>.report.json 顶层 {parseError, reason}
 * （src/verify/run.ts parse 抛错分支落盘；VerifyRan payload 只带 id 清表不带
 * 原文）。选取路径 = 周期内每条携带 parseFailedAcceptanceIds 的 VerifyRan，
 * 按其 runId 定位 evidence/<unitId>/<runId>/<stem>.report.json 读 reason——
 * 与 verify 落盘结构一一对应、可审计可降级。周期边界锚 lastSpecSeq（run 的
 * 账本 seq 需晚于最后一条 SpecSubmitted），seq 锚点取 fold 输出的结构超集
 * （deriveStatus 同款访问方式，手写投影缺锚点时保守视为不在周期内）。
 */
function parseFailFactsOf(
  unit: SequencedUnitProjection,
  projectCwd: string,
): ParseFailFact[] {
  const lastSpecSeq = unit.lastSpecSeq;
  const runSeqs: readonly number[] =
    (unit as VerifySequencedUnitProjection).verifyRunSeqs ?? [];
  const facts: ParseFailFact[] = [];
  unit.verifyRuns.forEach((run: VerifyRanPayload, i: number) => {
    const seq = runSeqs[i] ?? 0;
    if (lastSpecSeq === null || seq <= lastSpecSeq) {
      return;
    }
    for (const id of run.parseFailedAcceptanceIds ?? []) {
      const reportPath = join(
        evidenceDir(getCwHome(), projectCwd, unit.unitId, run.runId),
        `${reportStemOf(id)}.report.json`,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(reportPath, "utf-8"));
      } catch {
        parsed = null; // 产物不可读 / 非法 JSON → 降级为 id + 产物路径（事实行兜底）
      }
      const reason = isParseErrorReport(parsed) ? parsed.reason : null;
      facts.push({ acceptanceId: id, runId: run.runId, reason, reportPath });
    }
  });
  return facts;
}

/**
 * mx5-2：specContractBroken 的 designer 回炉任务书（解析失败连挂 ≥2 触发，复用
 * specFixPending 模板骨架——失败事实全文内嵌 + 修 spec 指令 + 重提回流独立
 * reviewer）。与 specFixPending 的差异仅在失败事实来源：那里是 reviewer fail
 * verdict 的 comment（语义结论），这里必须内嵌机器错误原文（<id>.report.json
 * 的 reason——designer 修的是命令契约，错的不是语义而是产物形态）；逐轮列出
 * （连挂 2 轮 = 2 份原文，审计可对账）。附规则⑨式恢复指引（按验收 type 对照
 * 适配器输出契约——回炉任务书的「怎么修」不依赖 designer 记得规则⑨）。
 */
function specContractBrokenTasks(
  unit: SequencedUnitProjection,
  projectCwd: string,
): string {
  const facts = parseFailFactsOf(unit, projectCwd);
  const spec = unit.specs[unit.specs.length - 1];
  const factLines =
    facts.length === 0
      ? [
          "  （账本内未见携带解析失败字段的 VerifyRan——不可达：本任务书仅在解析失败连挂 ≥2 后派发；",
          "    可 cw report --unit " + unit.unitId + " 核对逐轮产物）",
        ]
      : facts.map(
          (f) =>
            `  - 验收 ${f.acceptanceId}（runId=${f.runId}）：${f.reason ?? `（原文不可读——产物：${f.reportPath}）`}`,
        );
  return [
    "## 你的任务（designer：验收命令契约回炉——修 spec 的解析失败形态）",
    "",
    `unit "${unit.unitId}" 的验收在 verify 阶段解析失败连挂 ≥2 次——冻结 spec 的验收命令`,
    "与 cw 适配器的输出契约不符（实现写得再对也恒判 fail），不是实现问题，是 spec 的命令契约",
    "问题。请按以下机器错误原文修正 spec 后重提：",
    "",
    "### 解析失败事实（当前 spec 周期内逐轮原文，<id>.report.json 顶层 reason）",
    ...factLines,
    "",
    "### 命令契约恢复指引（按验收 type 对照，与 spec gate 规则⑨同口径）",
    "  - unit / integration 型（vitest 适配器从 stdout 解析 JSON）：删除冲突 flag——cw 会自动",
    "    追加 --reporter=json，命令自带的其他 --reporter 值或 --outputFile 会让 stdout 混入",
    "    文本 / 重定向走 JSON，解析必挂；命令须为 vitest 兼容形态。",
    "  - e2e 型（e2e-sh 适配器靠标记行判定）：stdout 必须产出独立标记行 `<验收id> PASS|FAIL`",
    "    ——命令里指得出来吗？裸 build/test 命令 exit 0 也永不产出标记行；可改走脚本或追加",
    '    `&& echo "<验收id> PASS"` 形态（确属实现职责的输出也行，但命令要保证它产出）。',
    "  - manual 型免机器验证，不会出现在上述事实里。",
    "",
    "### 修 spec 指令（回炉）",
    `1. 按上述失败事实与恢复指引修正 spec.json 中对应验收的 command（当前 spec 共 ${spec?.acceptance.length ?? 0} 条验收；`,
    "   验收规则见 src/gates/spec-rules.ts——规则⑨对 flag 契约在入账前拒绝，改后重提会重新过全部 gate）。",
    "2. spec diff 只改验收命令契约相关字段，其余验收与 contracts 不动（契约 hash 变更会牵动",
    "   集成期跨 unit 比对，无谓变更制造漂移）。",
    `3. 重提：cw evidence submit --kind spec --unit ${unit.unitId} --file spec.json`,
    "4. 新 spec 照旧过独立 reviewer 再审（spec-review 一律由独立 reviewer 提交，你无需也不得",
    "   自审）；过审后 verify 若仍解析失败连挂 ≥2，将累计回炉代数（已 2 代回炉转人工——每次",
    "   修复都经完整 verify 检验后才计满）。",
    "完成标志：修正后的 spec 已提交入账（审查结论由 reviewer 给出）。",
  ].join("\n");
}
/**
 * designer 首派任务书（created 且 specs===0）。fx-3 R5.2：root 无子时追加第 0 步
 * 建子指令——建子职责从 brief 实施建议的「建议」措辞（print 模式 agent 会停下
 * 询问，终验第 3 次现场）升级为系统任务书的指令化步骤，与 fx-3 R5.1 gate
 *（先建子后提 spec）口径对齐。条件收窄到 root 无子：已有子的 root 重派 /
 * 叶子首派不重复教建子。mx-1：不再含 spec-review 自审步骤——审查由独立
 * reviewer spawn 接手，完成标志 = spec 已提交入账。
 */
function designerFirstTasks(unit: SequencedUnitProjection, projection: SequencedProjection): string {
  const isRootWithoutChildren =
    unit.parentId === null &&
    ![...projection.units.values()].some((candidate) => candidate.parentId === unit.unitId);
  const stepZero = isRootWithoutChildren
    ? [
        `0. 本 unit 是根节点且尚无子 unit——若任务书/brief 含拆分建议：先为每个子执行`,
        `   cw create --id <slug> --brief <子brief文件> --parent ${unit.unitId}（子 brief 可为占位文件），`,
        "   再进入第 1 步（spec.split 声明的子必须已创建，否则提交会被拒）。",
      ]
    : [];
  return [
    "## 你的任务（designer）",
    ...stepZero,
    `1. 撰写该 unit 的 spec.json。验收五规则（src/gates/spec-rules.ts）：验收非空；`,
    "   核心 case 的 type 须为 e2e-real / e2e-mock 且带可执行 command；含 mock 须附",
    "   mock 保真度说明；至少一条 unit 级用例。",
    `2. 提交 spec：cw evidence submit --kind spec --unit ${unit.unitId} --file spec.json`,
    "完成标志：spec 已提交入账（spec-review 由独立 reviewer 在下一轮接手，无需自审）。",
  ].join("\n");
}

/**
 * fx-3 R5.3 兜底出口的任务书（spec-frozen 且 split 子未建的 designer）：清单式
 * 建子指令。designer 建完子即完成本任务书退出——子 unit 的 spec 由下轮首派的
 * designer 撰写，本 unit 的冻结 spec 无需改动。
 */
function missingChildrenTasks(unit: SequencedUnitProjection, missing: readonly string[]): string {
  return [
    "## 你的任务（designer：补建 split 子 unit）",
    "",
    `unit "${unit.unitId}" 的冻结 spec 声明了 ${splitOf(unit).length} 个子 unit 但 ${missing.length} 个未创建`,
    "（子不齐则集成永不发生，分解树无法建立）——请先创建缺失子：",
    ...missing.map((childId) => `  cw create --id ${childId} --brief <文件> --parent ${unit.unitId}`),
    "",
    "子 brief 可为占位文件；建完即完成本任务书，无需改动本 unit 的冻结 spec。",
    `完成标志：cw status 中上述子 unit 均为 created。`,
  ].join("\n");
}

/**
 * fx-2 R4a 上限出口的任务书（集成连续 fail 达上限后的 designer）：内嵌最近一次
 * 集成报告的失败事实（merge 冲突清单 + 契约清单 + 失败验收 id）与二选一处置指引
 * ——契约漂移/冲突的归属（改 spec 契约还是修实现/人工解冲突）需要语义判断，是
 * designer 的职责而非 runner 的（canon D4：runner 无智能）。报告不可读时降级为
 * 冻结 spec 的契约全集 + 指向查证命令（错误可操作闭环）。rv-4 起 MAX=1：首次
 * fail 即进入本出口（确定性失败无瞬时态可重试），且 merge 冲突事实（报告
 * mergeFailures 节）不再退化为「契约比对无失败项」类笼统文案。
 */
function integrationDriftTasks(unit: SequencedUnitProjection, cwd: string): string {
  const lastFailRun = [...unit.verifyRuns]
    .reverse()
    .find((run) => run.result === "fail" && run.runId.startsWith("integrate-"));
  const read =
    lastFailRun === undefined
      ? null
      : readIntegrateReport(cwd, unit.unitId, lastFailRun.runId);

  const factLines: string[] = [];
  if (read === null) {
    const contracts = unit.specs[unit.specs.length - 1]?.contracts ?? [];
    factLines.push(
      `- 最近一次集成报告不可读——失败明细见 cw report --unit ${unit.unitId}；当前冻结 spec 的契约全集：`,
      ...(contracts.length === 0
        ? ["  （无契约——fail 来自 merge 冲突、验收红或 commit 可达性，见失败明细）"]
        : contracts.map(
            (c) => `  - ${c.id}: signature "${c.signature}" 期望文件 ${c.file ?? "（全树搜索）"}`,
          )),
    );
  } else {
    // rv-4：merge 冲突事实独立提取（报告 mergeFailures 节；旧报告无该节按空清单）
    const mergeFailures = read.report.mergeFailures ?? [];
    if (mergeFailures.length > 0) {
      factLines.push(
        "- merge 冲突清单（步骤 0 汇聚失败原文，含冲突子 unitId 与 root worktree 路径）：",
        ...mergeFailures.map((f) => `  - ${f}`),
      );
    }
    const contractFailures = read.report.contracts.failures;
    factLines.push(
      ...(contractFailures.length === 0
        ? [
            mergeFailures.length > 0
              ? "- 契约比对无失败项（fail 的机器事实见上方 merge 冲突清单与失败验收）"
              : "- 契约比对无失败项（fail 来自验收红或 commit 可达性，见失败明细）",
          ]
        : [
            "- 契约比对失败清单（机器判定原文，含 id + signature + 期望文件）：",
            ...contractFailures.map((f) => `  - ${f}`),
          ]),
    );
    const failedAcceptances = read.report.acceptanceBatches.flatMap((batch) =>
      batch.results
        .filter((r) => r.status === "fail")
        .map((r) => `${r.id}（unit ${batch.unitId}）`),
    );
    factLines.push(
      failedAcceptances.length === 0
        ? "- 失败验收：无（验收批次全绿，fail 全部来自契约比对）"
        : `- 失败验收：${failedAcceptances.join("、")}`,
    );
    factLines.push(`- 完整报告：${read.reportPath}`);
  }

  return [
    "## 你的任务（designer：集成契约漂移处置）",
    "",
    `unit "${unit.unitId}" 的集成已连续 fail ${INTEGRATION_MAX_CONSECUTIVE_FAILS} 次（重派上限），`,
    "runner 已停止自动重派集成——契约漂移/merge 冲突的处置需要语义判断，由你按下述指引处置。",
    "",
    "### 集成失败事实（最近一次集成报告）",
    ...factLines,
    "",
    "### 处置指引（二选一）",
    integrationRecoveryGuidance(unit.unitId),
  ].join("\n");
}

function renderBrief(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
  target: BriefTarget,
  rootId: string,
  projectCwd: string,
  workdir: string,
): string {
  let briefContent: string;
  try {
    briefContent = readFileSync(unit.briefRef, "utf-8");
  } catch {
    briefContent = `(原始任务书文件不可读：${unit.briefRef})`;
  }
  // 任务书按派发依据的 frontier 维度选择（口径与 loop 的 computeDispatchTargets
  // 同一投影）：spec-frozen + split 子未建 = fx-3 R5.3 兜底出口（补建子）；其余
  // spec-frozen designer = fx-2 R4a 集成上限出口（契约漂移处置）；specFixPending
  // = mx-1 fail 打回修 spec；specContractBroken = mx5-2 解析失败回炉（命令契约
  // 修复，内嵌机器错误原文）；specReviewPending = mx-1 独立 reviewer 审 spec；
  // specReady = 首派（撰写 spec，root 无子时含 fx-3 R5.2 第 0 步建子指令）
  const roleTasks =
    target.dimension === "missingChildren"
      ? missingChildrenTasks(unit, splitChildrenNotCreated(projection, unit))
      : target.dimension === "integrationDrift"
        ? integrationDriftTasks(unit, projectCwd)
        : target.dimension === "specFixPending"
          ? specFixPendingTasks(unit)
          : target.dimension === "specContractBroken"
            ? specContractBrokenTasks(unit, projectCwd)
            : target.dimension === "specReviewPending"
              ? specReviewReviewerTasks(unit, projectCwd)
              : target.dimension === "specReady"
                ? designerFirstTasks(unit, projection)
                : target.dimension === "buildReady"
                  ? ROLE_TASKS.builder(unit.unitId)
                  : ROLE_TASKS.reviewer(unit.unitId);
  return [
    `# ${target.role} 任务书：unit "${unit.unitId}"`,
    "",
    "## Unit 上下文",
    `- unitId: ${unit.unitId}`,
    `- parentId: ${unit.parentId ?? "（根节点）"}`,
    `- 当前状态: ${unitStatus(unit)}`,
    `- 原始任务书: ${unit.briefRef}`,
    "",
    "### 原始任务书内容",
    briefContent,
    "",
    roleTasks,
    "",
    "## 环境约定",
    `- workdir: ${workdir}（unit 专属 git worktree，分支 ${unitBranchName(rootId, unit.unitId)}）`,
    `- 账本命令：直接在 workdir 下执行 cw …（CW_PROJECT_DIR 已注入 env，自动锚定项目账本 ${projectCwd}）`,
    "",
  ].join("\n");
}

/**
 * brief 落盘到 <artifactDir>/<unitId>.<role>.brief.md（fx-4：产物根随 run 级 topic
 * 目录，worktree 内不再有任何 cw 自身文件）。覆盖写语义不变——brief 内容随投影
 * 变化，append 会拼接出多版本任务书（设计 D2）。
 */
export function writeBriefFile(
  artifactDir: string,
  target: BriefTarget,
  unit: SequencedUnitProjection,
  projection: SequencedProjection,
  rootId: string,
  projectCwd: string,
  workdir: string,
): string {
  const path = join(artifactDir, `${target.unitId}.${target.role}.brief.md`);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(path, renderBrief(projection, unit, target, rootId, projectCwd, workdir));
  return path;
}
