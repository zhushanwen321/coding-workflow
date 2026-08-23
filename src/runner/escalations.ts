/**
 * 转人工（escalation）出声函数族（fx-6 F1 自 loop.ts 整体迁入，函数体逐字节
 * 不变；先例 = mx5-2 四投影函数迁 frontier.ts，commit 9703d9f）：停派维度
 * （TIMEOUT 封顶 / spec 打回活锁 / flake 连挂 / 回炉活锁 / buildDrift 缓慢进展）
 * 的 stderr 指引与每轮出声去重。与 loop.ts 的归属边界：本文件只做出声文本与
 * 出声时机判定，不感知派发循环；emitErr 与 spawn 超时常量是 loop 其余逻辑共用项，
 * 留在 loop.ts 并 import 之（循环 import 安全——两侧顶层均只定义，运行时调用时
 * 已初始化完毕）。
 */
import { join } from "node:path";

import type { LedgerEvent } from "../events/types.js";
import {
  type BuildDriftFact,
  type FlakeReviewFact,
  flakeReviewFacts,
  SPEC_CONTRACT_MAX_GENERATIONS,
  type SpecContractFacts,
  specContractFacts,
  specReviewFailComments,
  specReviewFailCounts,
} from "../readonly/frontier.js";
import {
  AGENT_TIMEOUT_ESCALATION_AFTER,
  emitErr,
} from "./loop.js";
import type { AgentRole } from "./spawn/types.js";

/** ms → min 换算（转人工指引文案用） */
const MS_PER_MINUTE = 60_000;

/**
 * spec-review 代数中间档出声阈值（lv-3，设计 D5）：打回代数 ≥3 且 < 预算逐代
 * 一声一行提示（不进停派 map、不改变派发行为——给用户 3 代即可介入的可见性，
 * 不必等 10 代爆发一次性转人工）。与 brief.ts 的审查上下文历史截断
 * SPEC_REVIEW_HISTORY_MAX = 3 同源校准（3-9 代最多 7 行，非噪音）。
 */
const SPEC_REVIEW_PROGRESS_NOTICE_MIN = 3;

/**
 * spec-review 代数中间档的一行提示（lv-3）：文本含代数与预算值与介入命令——
 * 不停派、无强制动作，只给「若往返持续可提前介入」的选择权（复杂 spec 合理
 * 往返 3-5 代存在，3 代即停派会误杀——中间档与停派是两件事）
 */
function specProgressNoticeLine(
  rootId: string,
  unitId: string,
  failCount: number,
  maxSpecRejects: number,
): string {
  return (
    `cw run: unit "${unitId}" 的 spec-review 已打回 ${failCount} 代（预算 ${maxSpecRejects}）` +
    `——若往返持续，可提前人工介入：cw run --root ${rootId} --spawn human`
  );
}

/**
 * 转人工指引（连续 TIMEOUT 封顶时逐 unit 打印；错误指向恢复动作，规则 16）。
 * lv-2 起单次 spawn 超时可经 --spawn-timeout-ms / CW_SPAWN_TIMEOUT_MS 调大——
 * 第 3 条显示本循环实际值与入口（spawnTimeoutMs 由 loop 传入，非固定常量）。
 */
export function escalationMessage(
  rootId: string,
  unitId: string,
  role: AgentRole,
  artifactDir: string,
  spawnTimeoutMs: number,
): string {
  // 产物根随 fx-4 迁 run 级 topic 目录（stdout/stderr append 累积本 run 历次输出）
  const stdoutPath = join(artifactDir, `${unitId}.${role}.stdout`);
  return (
    `cw run: unit "${unitId}" 的 ${role} 连续 ${AGENT_TIMEOUT_ESCALATION_AFTER} 次 spawn TIMEOUT` +
    "（期间无该 unit 的任何账本进展）——停止自动重派，转人工处理（canon：不自动换模型重试，" +
    "防静默降级；本循环继续处理其余 unit）。恢复动作（按序）：\n" +
    `  1. 人工接手该 unit：重新运行 cw run --root ${rootId} --spawn human（按打印的指令手工推进；账本即状态，已完成进度不丢）\n` +
    `  2. 定位卡点：查看 ${stdoutPath} 与同级 .stderr（本次 run 的历次输出；跨 run 历史在 ~/.cw/topic/ 下按 runTs 目录可查）\n` +
    `  3. 若任务量确超单次 spawn 上限（--spawn-timeout-ms / CW_SPAWN_TIMEOUT_MS 可调，当前 ${spawnTimeoutMs / MS_PER_MINUTE}min）：` +
    "人工接手完成该 unit，或拆小任务另建 unit"
  );
}

/** 转人工收束的退出汇总（无可自动推进的 unit 且存在转人工 unit → exit 1） */
export function escalationExitMessage(rootId: string, escalated: ReadonlyMap<string, AgentRole>): string {
  return (
    `cw run: root "${rootId}" 已无可自动推进的 unit（无 in-flight、无待派发），转人工 unit 共 ` +
    `${escalated.size} 个：\n` +
    [...escalated]
      .map(([unitId, role]) => `  - ${unitId}（最后派发 role：${role}）`)
      .join("\n") +
    `\n恢复动作：按各 Unit 的转人工指引处理（cw run --root ${rootId} --spawn human 人工接手），` +
    "完成后重新运行 cw run --root ${rootId} 继续（账本即状态，重跑即续）。"
  );
}

/**
 * e2e 连挂转人工指引（rv-5，canon §5.2「连挂 2 次的 e2e 用例标 flake 转人工，
 * 不自动豁免，防 Goodhart」）：列出连挂用例 id 与逐次 fail 的 runId，人工判定
 * 动作二选一（判 flake → 修稳定性或声明 nondeterministic 重提 spec；判真 bug →
 * 人工修复）。出口形态复用 fx-2 上限出口的「审计-不喂-idle」模式：停止派发后
 * 不再产生新 VerifyRan 喂活 idle 判定——若树内无其他可推进目标，空转由
 * maxIdleMs 收束退出；人工处置（新 verify pass / 新 spec 过审）写入账本后投影
 * 自然消失，运行中的循环下轮自愈。
 */
function flakeEscalationMessage(
  rootId: string,
  unitId: string,
  facts: readonly FlakeReviewFact[],
): string {
  const factLines = facts.map(
    (f) =>
      `  - 验收 ${f.acceptanceId}：当前 spec 周期内连续 ${f.consecutiveFails} 次 fail（runId：${f.runIds.join("、")}）`,
  );
  return (
    `cw run: unit "${unitId}" 的 e2e 验收连挂 2 次以上（flake 疑似）——停止对该 unit 派发 developer（打回循环对随机挂无解），` +
    "转人工判定（canon §5.2：不自动豁免，防 Goodhart；本循环继续处理其余 unit）：\n" +
    factLines.join("\n") +
    "\n人工判定动作（按序）：\n" +
    `  1. 查看逐次产物：cw report --unit ${unitId}（各 runId 的 report.json 与 stdout/stderr）\n` +
    "  2. 判定为 flake（测试随机性不稳定）→ 修测试稳定性，或声明 nondeterministic 后重提 spec 并重新过审：\n" +
    `     cw evidence submit --kind spec --unit ${unitId} --file spec.json（新 spec 提交即清零连挂计数）\n` +
    "  3. 判定为真 bug → 人工修复实现后重新提交 build 证据并 cw verify\n" +
    "处置完成投影自然重算（账本即状态）：运行中的循环下轮自愈；已退出的重新运行 " +
    `cw run --root ${rootId} 即续。`
  );
}

/**
 * spec-review 打回活锁转人工指引（mx-1 MF2 引入，mx-3 计数改按打回代数，mx-4
 * 预算参数化：阈值经 --max-spec-rejects 注入，默认 10——防 ping-pong：fail →
 * designer 修 → fail → 修 → … 的无限循环对机器无解）。列出各代打回的首条 fail
 * verdict comment 摘要（审计事实，同代试探性提交不重复列出）与人工处置动作；
 * 文案同时含已达代数与预算值（mx-4 §4：人工能看出「已达预算 M 代」）。出口形态
 * 复用 fx-2 上限出口的「审计-不喂-idle」模式：停止派发后不再产生新事件——若树内
 * 无其他可推进目标，空转由 maxIdleMs 收束退出；人工处置（人工以 reviewer 身份
 * 提交 pass verdict，或改写后人工过审）写入账本后 unit 离开 created 态，投影
 * 自然消失，运行中的循环下轮自愈。
 */
function specDeadlockEscalationMessage(
  rootId: string,
  unitId: string,
  failComments: readonly string[],
  maxSpecRejects: number,
): string {
  const commentLines = failComments.map(
    (comment, i) => `  - 第 ${i + 1} 代打回的意见：${comment}`,
  );
  return (
    `cw run: unit "${unitId}" 的 spec-review 已打回 ${failComments.length} 代（已达打回代数预算 ${maxSpecRejects} 代，重提 spec 不清零代数累计）` +
    "——判定 designer-reviewer 打回循环活锁，停止对该 unit 派发（继续循环只会重演），转人工处置" +
    "（canon：不自动换模型重试，防静默降级；本循环继续处理其余 unit）：\n" +
    commentLines.join("\n") +
    "\n人工处置动作（按序）：\n" +
    `  1. 人工接手该 unit：cw run --root ${rootId} --spawn human（按打印的指令手工推进；账本即状态，已完成进度不丢）\n` +
    `  2. 人工审查该 spec：cw report --unit ${unitId}（原文副本见 evidence 目录 attachments/）\n` +
    `  3. 处置三选一：人工修 spec 重提后由你以 reviewer 身份判定（cw evidence submit --kind spec --unit ${unitId} --file spec.json + ` +
    `cw review submit --unit ${unitId} --verdict-kind spec-review --verdict pass --role reviewer——mx-3 起 spec-review 必须携带 --role reviewer）；` +
    "或判定任务书本身不可行，人工关闭/重构该 unit；或确认 reviewer 判定有误，人工提交 pass verdict\n" +
    "处置完成（unit 离开 created 态）投影自然重算（账本即状态）：运行中的循环下轮自愈；已退出的重新运行 " +
    `cw run --root ${rootId} 即续。`
  );
}

/**
 * 解析失败回炉活锁转人工指引（mx5-2，设计 mx-5 D2 防活锁独立预算）：两轮完整
 * 回炉（连挂 ≥2 → designer 修 spec → 新 spec 过审 → verify 仍解析失败连挂 ≥2）
 * 走满后判定 spec/brief 层有更深问题——继续派 designer 只会重演（每轮回炉都
 * 清空连挂再重建），停派转人工。列出当前周期的连挂事实（条目 id + 逐次 runId
 * ——原文在 <id>.report.json 顶层 reason，cw report 可查）与人工处置动作；出
 * 口形态复用 fx-2 上限出口的「审计-不喂-idle」模式（停派后无新 VerifyRan 喂活
 * idle 判定，空转由 maxIdleMs 收束）；人工处置（新 spec 过审 / 人工关闭）写入
 * 账本后投影自然消失，运行中的循环下轮自愈。
 */
function specContractDeadlockEscalationMessage(
  rootId: string,
  unitId: string,
  facts: SpecContractFacts,
): string {
  const factLines = facts.streaks.map(
    (f) =>
      `  - 验收 ${f.acceptanceId}：当前 spec 周期内连续 ${f.consecutiveFails} 次解析失败（runId：${f.runIds.join("、")}）`,
  );
  return (
    `cw run: unit "${unitId}" 的验收命令解析失败已 2 代回炉仍连挂 ≥2（两轮「连挂 → designer 修 spec → 过审 → verify 检验」完整走完；` +
    "代数累计不因重提清理）——判定 spec/任务书层有更深问题，停止对该 unit 派发（不再派 designer，防回炉活锁），" +
    "转人工处置（本循环继续处理其余 unit）：\n" +
    factLines.join("\n") +
    "\n人工处置动作（恢复指引，按序）：\n" +
    `  1. 人工接手该 unit：重新运行 cw run --root ${rootId} --spawn human（按打印的指令手工推进；账本即状态，已完成进度不丢）\n` +
    `  2. 查看逐次解析失败原文：cw report --unit ${unitId}（各 runId 目录的 <验收id>.report.json 顶层 reason）\n` +
    `  3. 人工修正验收命令契约（e2e 型补标记行产出；vitest 型删冲突 flag——cw 自动追加 --reporter=json）后重提并以 reviewer 身份过审：` +
    `cw evidence submit --kind spec --unit ${unitId} --file spec.json + cw review submit --unit ${unitId} --verdict-kind spec-review --verdict pass --role reviewer；` +
    "或判定任务书本身不可行，人工关闭/重构该 unit\n" +
    "处置完成投影自然重算（账本即状态）：运行中的循环下轮自愈；已退出的重新运行 " +
    `cw run --root ${rootId} 即续。`
  );
}

/**
 * buildDrift 缓慢进展转人工指引（lv-2，设计 §3.1 成功路径全文锁定）：本 spec
 * 周期内 build 证据 ≥K 且无 pass verify——每轮有产出但期望完成时间发散（布尔
 * 进展判定对其失明），停派转人工。恢复动作三选一（人工接手 / 拆 unit / 调大 K
 * 续跑）。出口形态复用 fx-2 上限出口的「审计-不喂-idle」模式：停派后无新
 * developer spawn 即无新 build 证据，若树内无其他可推进目标，空转由 maxIdleMs
 * 收束退出；人工处置（--max-build-attempts 续跑 / 新 spec 入账重置周期 / 人工
 * 完成）写入账本后投影自然消失，运行中的循环下轮自愈。
 */
function buildDriftEscalationMessage(
  rootId: string,
  unitId: string,
  fact: BuildDriftFact,
  maxBuildAttempts: number,
  artifactDir: string,
): string {
  // 产物根随 fx-4 迁 run 级 topic 目录（stdout/stderr append 累积本 run 历次输出）
  const stdoutPath = join(artifactDir, `${unitId}.developer.stdout`);
  return (
    `cw run: unit "${unitId}" 的 build 证据已达 ${fact.buildCount} 次（--max-build-attempts 预算 ${maxBuildAttempts}）` +
    "且本 spec 周期内无 pass verify——判定缓慢进展（每轮有产出但期望完成时间发散），\n" +
    "停止自动重派，转人工处理（本循环继续处理其余 unit）。恢复动作（按序）：\n" +
    `  1. 人工接手：cw run --root ${rootId} --spawn human（账本即状态，${fact.buildCount} 次证据的进度不丢）\n` +
    `  2. 定位卡点：${stdoutPath}（历次输出）\n` +
    "  3. 三选一：人工完成该 unit；或拆小任务另建 unit（cw create 深度上限内）；\n" +
    `     或确认可继续自动跑：cw run --root ${rootId} --max-build-attempts <更大值>`
  );
}

/**
 * flake 出声的稳定签名（fx-6 X5）：排序后的连挂 acceptanceId 集合（dedup map 按
 * unitId 键控，签名语义 = unitId + 该集合）。「本质事实变化才重出」——同一组
 * acceptanceId 连挂时 runId 单调追加 / 连挂计数增长只会改消息文本（四跑异常-1：
 * 连挂 runId 增长致 19 条重复出声，纯噪音），不构成重出理由；新增条目进入连挂
 * （本质变化）时集合变化 → 重出一次（消息含新条目）。
 */
function flakeAnnounceSignature(facts: readonly FlakeReviewFact[]): string {
  return facts.map((f) => f.acceptanceId).sort().join(",");
}

/**
 * 回炉活锁出声的稳定签名（fx-6 X5）：flake 同款集合 + 代数档（<上限 / ≥上限
 * 二值档）。本维度只在代数达上限后出声，档位字段保持签名语义完整——上限内的
 * 代数增长与 runId 追加一样不是重出理由，跨越档位才是本质变化。runIds 与恢复
 * 指引仍在消息文本内（信息不降级），签名与消息分离（dedup map 只存签名串）。
 */
function contractAnnounceSignature(facts: SpecContractFacts): string {
  const ids = facts.streaks.map((s) => s.acceptanceId).sort().join(",");
  const band =
    facts.generations >= SPEC_CONTRACT_MAX_GENERATIONS ? "capped" : "under";
  return `${ids}|${band}`;
}

/**
 * 出声去重同构骨架（五维度共用）：签名与已记录值不同才重出，get → set →
 * emitErr 顺序固定。render 用 thunk——出声文本只在签名变化时求值（specDeadlock
 * 分支的 specReviewFailComments 是每轮全量事件扫描，签名未变时跳过；纯函数，
 * 求值时机无观测差异）。
 */
function announceOnce(
  map: Map<string, string>,
  unitId: string,
  signature: string,
  render: () => string,
): void {
  if (map.get(unitId) !== signature) {
    map.set(unitId, signature);
    emitErr(render());
  }
}

/**
 * 四类转人工维度的每轮出声与事实计算（rv-5 flake / mx5-2 回炉活锁 / mx-1 spec
 * 打回活锁 / lv-2 buildDrift 缓慢进展）+ lv-3 spec-review 代数中间档：事实来自
 * 账本重放（flakeReviewFacts / specContractFacts / specReviewFailCounts——全部
 * 「重提清连挂、代数类计数不清零」语义；buildDriftFacts 由 loop 算好传入——
 * facts 只算一次，出声与派发计算消费同一份），人工处置写入新事件后投影自然
 * 消失。出声去重分两档（fx-6 X5）：flake 与回炉活锁按稳定签名（unitId + 排序后
 * acceptanceId 集合，回炉再加代数档）——连挂 runId 单调追加只改文本不改本质
 * 事实，不重出；spec 打回维度维持完整消息文本比较（mx-3 语义）——各代打回
 * 意见不同是有意重出（新代意见是新事实）；中间档同为完整文本比较（lv-3——
 * 代数进文本必然逐代不同，同代数不重出）；buildDrift 签名 = specEpoch:capped
 * （lv-2——必须含 specEpoch：新 spec 周期再次达预算时签名变化重出声，防「回炉
 * 后二次触发静默」；同周期内证据数继续增长不重出）。消息文本本身不变（仍含
 * runIds 与恢复指引）。返回事实映射供 computeDispatchTargets 复用（派发排除
 * 与出声同口径同源，不重放两遍）。其他 root 的 unit（同一账本多 root）不在本
 * run 职责内，跳过。
 */
export function announceManualEscalations(
  rootId: string,
  events: readonly LedgerEvent[],
  subtreeIds: ReadonlySet<string>,
  opts: {
    /** spec 打回活锁的代数预算（mx-4；cw run --max-spec-rejects 注入） */
    maxSpecRejects: number;
    /** loop 每轮算好的 buildDrift 事实（出声与派发计算消费同一份） */
    driftFacts: ReadonlyMap<string, BuildDriftFact>;
    /** buildDrift 停派预算 K（--max-build-attempts，进指引文案） */
    maxBuildAttempts: number;
    /** run 级 topic 产物目录（指引里的 stdout 路径锚） */
    artifactDir: string;
  },
  dedup: {
    flake: Map<string, string>;
    contract: Map<string, string>;
    spec: Map<string, string>;
    /** lv-3：spec-review 代数中间档（3 ≤ 代数 < 预算）出声去重（完整文本比较） */
    specProgress: Map<string, string>;
    buildDrift: Map<string, string>;
  },
): {
  flakes: ReadonlyMap<string, readonly FlakeReviewFact[]>;
  contractFacts: ReadonlyMap<string, SpecContractFacts>;
  specFails: ReadonlyMap<string, number>;
} {
  const { maxSpecRejects, driftFacts, maxBuildAttempts, artifactDir } = opts;
  const flakes = flakeReviewFacts(events);
  for (const [unitId, facts] of flakes) {
    if (!subtreeIds.has(unitId)) {
      continue;
    }
    const signature = flakeAnnounceSignature(facts);
    announceOnce(
      dedup.flake,
      unitId,
      signature,
      () => flakeEscalationMessage(rootId, unitId, facts),
    );
  }
  // mx5-2 specContractDeadlock：解析失败连挂 ≥2 且回炉代数达上限（两代完整回炉
  // 仍失败）→ 停派转人工（computeDispatchTargets 同口径不派）
  const contractFacts = specContractFacts(events);
  for (const [unitId, facts] of contractFacts) {
    if (
      !subtreeIds.has(unitId) ||
      facts.streaks.length === 0 ||
      facts.generations < SPEC_CONTRACT_MAX_GENERATIONS
    ) {
      continue;
    }
    const signature = contractAnnounceSignature(facts);
    announceOnce(
      dedup.contract,
      unitId,
      signature,
      () => specContractDeadlockEscalationMessage(rootId, unitId, facts),
    );
  }
  // mx-1 MF2 specReviewDeadlock：spec-review 打回代数 ≥ 预算（mx-4 参数化）。
  // 去重维持完整消息文本比较（fx-6 X5 不改本维度）：各代打回意见内嵌在消息里，
  // 代数从 N 到 N+1 意味着新代 fail 意见——是有意重出。
  // lv-3 中间档：3 ≤ 代数 < 预算逐代一声一行提示（区间与停派互斥——达预算走
  // 下方完整转人工文案；dedup 同为完整文本比较：代数进文本必然逐代不同，同代
  // 数不重出；不进停派 map、不改变任何派发行为）
  const specFails = specReviewFailCounts(events);
  for (const [unitId, failCount] of specFails) {
    if (!subtreeIds.has(unitId)) {
      continue;
    }
    if (
      failCount >= SPEC_REVIEW_PROGRESS_NOTICE_MIN &&
      failCount < maxSpecRejects
    ) {
      const notice = specProgressNoticeLine(rootId, unitId, failCount, maxSpecRejects);
      announceOnce(dedup.specProgress, unitId, notice, () => notice);
      continue;
    }
    if (failCount < maxSpecRejects) {
      continue;
    }
    // 签名 = 打回代数（数值串），与消息一一对应（意见按代取首条、账本只追加
    // 不可变，意见条数 = 代数）——等价于既有「完整消息文本比较」去重语义；
    // 消息构造（含 specReviewFailComments 全量事件扫描）经 thunk 只在代数
    // 变化时求值
    announceOnce(
      dedup.spec,
      unitId,
      String(failCount),
      () =>
        specDeadlockEscalationMessage(
          rootId,
          unitId,
          specReviewFailComments(events, unitId),
          maxSpecRejects,
        ),
    );
  }
  // lv-2 buildDrift：本 spec 周期内 build 证据 ≥K 且无 pass verify——缓慢进展
  // 停派转人工（computeDispatchTargets 同口径不派）。签名 = specEpoch:capped：
  // 新 spec 周期再次达预算时签名变化重出声（防「回炉后二次触发静默」），同周期
  // 内证据数继续增长（buildCount 5→6→…）不重出
  for (const [unitId, fact] of driftFacts) {
    if (!subtreeIds.has(unitId)) {
      continue;
    }
    const signature = `${fact.specEpoch}:capped`;
    announceOnce(
      dedup.buildDrift,
      unitId,
      signature,
      () =>
        buildDriftEscalationMessage(
          rootId,
          unitId,
          fact,
          maxBuildAttempts,
          artifactDir,
        ),
    );
  }
  return { flakes, contractFacts, specFails };
}
