/**
 * spec gate 十二规则（canon《design-rewrite-architecture.md》§3.3 D3「机器前置规则」；
 * 判定语义与 M0 口径锁定于 docs/rewrite/acceptance/u3-acceptance.md）。
 *
 * ① 验收非空；② core 用例自身 type 必须为 e2e-real/e2e-mock（M0 口径：核心 case
 * 逐条自检，而非集合模糊对应——canon 原文的集合口径无法机器判定，见验收文档）；
 * ③ e2e 用例 command 非空且首 token 在 PATH 可解析；④ e2e-mock 须附非空保真说明；
 * ⑤ 至少一条 unit 级用例；⑥ split 不得自引用（fx-1：终验 leaf-renderer 抄 root
 * 模板未改，split 含自身 → loop 判内部节点 → 等自己 verified → 确定性死锁）；
 * ⑦ 验收 id 字符集（rv-2：与 e2e-sh marker 同源正则，入口拦截非法 id）；
 * ⑧ runner 显式声明时必须在 knownAdapterTypes() 集合内（mx-2：gate 是唯一
 * 入口，verify 侧 adapterTypeFor 不二次校验——非法 runner 靠此处拦截）；
 * ⑨ 验收命令契约（mx5-1，mx-5 设计 D1：按最终适配器路由分派的输出契约
 * 静态检查——M4 gate 三跑实证 `--reporter=verbose` 与 cw 自动追加的
 * `--reporter=json` 冲突致 JSON 解析恒挂；禁令清单见 ADAPTER_FLAG_CONTRACTS）；
 * ⑩ topic 层条目要求 split 非空（al-3，《验收分层与成本治理》D4：叶子/无子
 * 节点 unit 声明 topic = 条目永无执行点的真空，fail 级提交期拒绝）；
 * ⑪ unit 层条目 command 命中全量回归形态（al-3，同设计 D5：warning 级成本
 * 启发式，词法判定不执行命令——命中入账继续 + warnings 交 evidence submit
 * 打 stderr；形态枚举见 FULL_REGRESSION_FORMS）；
 * ⑫ 验收 command 路径逃逸词法拦截（lv-1，M6 设计《cw 自治运行活性与契约防护》
 * D3，fail 级：".cw-worktrees" 子串或目录选择词法族后随剥引号 /~ 开头 token——
 * 逃逸使 verify 绑定执行瞬间的工作区状态而非账本 commit，语义失效同⑩真空
 * 声明；词法族见 DIRECTORY_FLAG_TOKENS / DIRECTORY_FLAG_EQUALS_PREFIXES
 * （分离 / -C 紧贴 / 等号紧贴三形态均已覆盖），漏报面由 reviewer 第五维语义审兜底）。
 * 多缺口按规则序号升序全部列出，不短路。
 *
 * 规则③的 PATH 解析是 `which` 等价检查：只验证设计期可得的事实（bin 可解析），
 * 不检查项目内文件（设计期尚不存在）；command 真正跑得通由 verify 期裁决。
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter as pathDelimiter, join } from "node:path";

import type {
  AcceptanceType,
  SpecRulesResult,
  SpecSubmittedPayload,
} from "../events/types.js";
import { ACCEPTANCE_ID_RE } from "../events/types.js";
import { knownAdapterTypes } from "../testrun/registry.js";
import { adapterTypeFor } from "../verify/run.js";

/** 规则②③的作用域：e2e 级机器验证（区别于 unit/integration/manual） */
function isE2eType(type: AcceptanceType): boolean {
  return type === "e2e-real" || type === "e2e-mock";
}

/**
 * command 空白切分（规则⑨⑪⑫ 共用口径，单一事实源防漂移）：缺失按空串处理，
 * trim 后按空白切分并剔除空 token——三处的「command 缺失或 tokenize 后为空则
 * 跳过」判定同源。
 */
function tokenizeCommand(command: string | undefined): string[] {
  return (command ?? "").trim().split(/\s+/).filter((t) => t !== "");
}

/**
 * spec 提交时的机器前置规则（①-⑤ 为 u3 五规则，⑥ 为 fx-1 追加，⑦ 为 rv-2 追加，
 * ⑧ 为 mx-2 追加，⑨ 为 mx5-1 追加，⑩⑪ 为 al-3 追加，⑫ 为 lv-1 追加）。确定性检查（对同一 spec +
 * 同一 PATH 环境结果恒定），不做任何主观判断——「验收强不强」由独立 reviewer 审，
 * 不在本函数职责内。
 */
export function checkSpecRules(spec: SpecSubmittedPayload): SpecRulesResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  // ① 验收非空
  if (spec.acceptance.length === 0) {
    failures.push("rule①: spec.acceptance 为空（至少需要一条验收用例）");
  }

  // ② core 用例自身必须是 e2e 级机器验证（M0 口径，逐条自检）
  for (const ac of spec.acceptance) {
    if (ac.core && !isE2eType(ac.type)) {
      failures.push(
        `rule②: ${ac.id} (${ac.type}) 是核心 case 但 type 非 e2e 级` +
          "（core 用例自身 type 须为 e2e-real 或 e2e-mock，口径见 docs/rewrite/acceptance/u3-acceptance.md）",
      );
    }
  }

  // ③ e2e 用例必须有可执行 command（非空 + 首 token 在 PATH 可解析）
  for (const ac of spec.acceptance) {
    if (!isE2eType(ac.type)) continue;
    const command = ac.command?.trim() ?? "";
    if (command === "") {
      failures.push(`rule③: ${ac.id} (${ac.type}) 缺可执行 command`);
      continue;
    }
    const firstToken = command.split(/\s+/)[0];
    if (!isResolvableOnPath(firstToken)) {
      failures.push(
        `rule③: ${ac.id} (${ac.type}) command 首 token "${firstToken}" 在 PATH 不可解析` +
          "（检查拼写、安装对应工具，或改用绝对路径）",
      );
    }
  }

  // ④ e2e-mock 必须附保真说明
  for (const ac of spec.acceptance) {
    if (ac.type !== "e2e-mock") continue;
    if ((ac.mockFidelityNote ?? "").trim() === "") {
      failures.push(
        `rule④: ${ac.id} (e2e-mock) 缺 mock 保真说明（mockFidelityNote 须为非空字符串，说明 mock 了什么、保真到什么程度）`,
      );
    }
  }

  // ⑤ 至少一条 unit 级用例
  if (!spec.acceptance.some((ac) => ac.type === "unit")) {
    failures.push("rule⑤: spec 无任何 unit 级用例");
  }

  // ⑥ split 不得自引用（fx-1 R1 第一道防线：gate 在提交时拒，账本 fold 同注入此
  // 函数——自引用 spec 无法达到 spec-frozen，loop 的内部节点等待不会发生）
  if (spec.split.some((entry) => entry.unitId === spec.unitId)) {
    failures.push(
      `规则⑥: split 自引用 ${spec.unitId}（拆分子节点不得包含自身；叶子 unit 的 split 应为空）。` +
        `恢复动作：从 spec.split 移除 "${spec.unitId}" 条目（叶子 unit 置空数组）后重新提交。`,
    );
  }

  // ⑦ 验收 id 字符集（rv-2：入口拦截而非追溯清洗——只拦新提交，既有账本 id 全部
  // 合规不受影响）。id 是 e2e-sh 标记行第一列与 nameMatch 比对的锚：gate 不校验时
  // 含空格/中文的 id 能入账，但其 e2e 用例在 verify 期永远匹配不到标记行，报错
  // 误导为「无标记行」。与 e2e-sh MARKER_RE 同源（均派生自 ACCEPTANCE_ID_RE）
  for (const ac of spec.acceptance) {
    if (!ACCEPTANCE_ID_RE.test(ac.id)) {
      failures.push(
        `规则⑦: 验收 id "${ac.id}" 不符字符集约束（须字母数字开头，后续可含 "." "_" "-"，禁空格与中文）。` +
          `id 是 e2e 标记行与名字比对的锚，字符集外 id 的 e2e 用例永远无法匹配。` +
          `恢复动作：修正该 id 后重新提交 spec。`,
      );
    }
  }

  // ⑧ runner 显式声明时必须在已注册适配器集合内（mx-2：唯一入口——verify 侧
  // adapterTypeFor 对 runner 只做确定性查找不校验合法性，绕过 gate 的非法值
  // 会路由不到适配器 fail，错误指向装配而非「runner 写错」，故在此前置拦截）。
  // 大小写敏感：合法值与 registry key 逐字符一致（"pytest" 全小写）。
  // 缺省不校验——走 type 推导路径（回归锁：存量无 runner 的 spec 行为不变）
  const legalRunners = knownAdapterTypes();
  for (const ac of spec.acceptance) {
    if (ac.runner === undefined) {
      continue;
    }
    if (!legalRunners.includes(ac.runner)) {
      failures.push(
        `规则⑧: 验收 ${ac.id} 的 runner "${ac.runner}" 不在合法值集合 [${legalRunners.join("/")}] 内（大小写敏感，须与 registry key 完全一致）。` +
          `恢复动作：改用上述合法值之一，或删除 runner 字段走 type 默认推导（unit/integration→vitest、e2e-real/e2e-mock→e2e-sh）。`,
      );
    }
  }

  // ⑨ 验收命令契约（mx5-1）：按最终适配器路由（adapterTypeFor——runner 显式
  // 声明优先，缺省按 type 推导，与 verify 执行时同一路由）分派 flag 契约检查。
  // 契约是 cw 自定义协议（适配器输出形态），与规则③（PATH 可解析）同性质、
  // 同层位——入账前确定性拦截，错误暴露在 designer 写 spec 的工作现场而非
  // 40 分钟后的 verify 阶段（M4 gate 三跑实证：flag 冲突致解析恒挂被误判
  // flake）。command 缺失（unit/integration 型合法缺省，走适配器默认命令）
  // 无 flag 可查，不触发。非法 runner 由规则⑧拦截，路由结果不在
  // ADAPTER_FLAG_CONTRACTS 表中即跳过（不双重报错）
  for (const ac of spec.acceptance) {
    const tokens = tokenizeCommand(ac.command);
    if (tokens.length === 0) {
      continue;
    }
    const check = ADAPTER_FLAG_CONTRACTS[adapterTypeFor(ac.type, ac.runner)];
    if (check === undefined) {
      continue;
    }
    for (const gap of check(tokens)) {
      failures.push(
        `规则⑨: 验收 ${ac.id} 的 command 含冲突 flag "${gap.flag}"${gap.valueNote}。${gap.fact}恢复动作：${gap.recovery}`,
      );
    }
  }

  // ⑩ topic 层条目要求 split 非空（al-3，设计 D4，fail 级结构规则）。语义闭环：
  // split 非空 ⟺ 有子节点 ⟺ 有集成执行点 ⟺ topic 条目会被执行（集成批次本就
  // 含 root 全部验收）；split 为空却声明 topic = 该条目永无执行点（真空声明）→
  // 提交期拒绝，不允许「声明了却永不执行」进账本。与两道 handler 级防线正交、
  // 无绕过面：fx-1 R1 拦叶子的一切 split 声明（叶子 split 必空 → 叶子声明 topic
  // 必被本规则拦），fx-3 R5.1 保证 split 非空 ⟹ 子已入账（执行点对象在提交时点
  // 已存在）——本规则在 gate 层从另一侧收口。已知边界（写进文案不静默）：单
  // unit topic（root 无子、split 空）也不能声明 topic 层——它本就没有集成执行
  // 点，全部验收按 unit 层跑。注意规则⑤不豁免 topic 条目：root 上收回归后仍须
  // 至少一条 type: "unit" 用例（提示归 designer 指引，不属本规则文案职责）
  if (spec.split.length === 0) {
    for (const ac of spec.acceptance) {
      if (ac.layer !== "topic") {
        continue;
      }
      failures.push(
        `规则⑩: 验收 ${ac.id} 声明了 layer: "topic"，但本 spec 的 split 为空——叶子/无子节点 ` +
          `unit 没有集成执行点，topic 层条目将永不被执行（声明即真空）。已知边界：单 unit ` +
          `topic（root 无子、split 为空）同样不能声明 topic 层——它本就没有集成执行点，全部验收按 unit 层跑。` +
          `恢复动作（二选一）：topic 层验收归有子节点的 root spec 声明（其执行点是内部节点集成）` +
          `——若本条是全量回归，上收 root spec 并标 layer: "topic"；若确属本 unit 功能验收，` +
          `去掉 layer 字段按 unit 层声明。`,
      );
    }
  }

  // ⑪ unit 层全量回归形态 warning（al-3，设计 D5，成本启发式——纯词法判定，
  // 不执行命令）。warning 级而非 fail 级的理由：静态形态判定有误杀面（小仓的
  // 全量单测可能就是叶子的合理范围），硬拒会逼出规避动作（把命令包进 wrapper
  // 脚本绕开启发式）；硬防线在 reviewer 第六维语义审（brief.ts）。与规则⑨对
  // e2e/manual「无静态规则，漏网走回炉通道」的诚实边界哲学同款。作用域：layer
  // 未声明或 unit 层（topic 条目已归集成层，不查）；命中一条 command 只出一条
  // warning（多形态叠加无增量信息）
  for (const ac of spec.acceptance) {
    if (ac.layer === "topic") {
      continue;
    }
    const tokens = tokenizeCommand(ac.command);
    if (tokens.length === 0) {
      continue;
    }
    for (const match of FULL_REGRESSION_FORMS) {
      const form = match(tokens);
      if (form === null) {
        continue;
      }
      warnings.push(
        spec.split.length === 0
          ? `规则⑪: 验收 ${ac.id} 的 command 是全量回归形态（${form}），且本 spec 的 split 为空 ` +
              `（叶子）——叶子 verify 每轮 fix（含红阶段）都会全价重跑它。` +
              `建议：若为全量回归，上收 root spec 并标 layer: "topic"（集成层唯一执行）；` +
              `若确为本 unit 范围，为 command 加文件参数收窄。`
          : `规则⑪: 验收 ${ac.id} 的 command 是全量回归形态（${form}），且本 spec 的 split 非空 ` +
              `（内部节点的 unit 层回归，执行点与 topic 层相同）。` +
              `建议显式标 layer: "topic"（成本归属可审计）。`,
      );
      break;
    }
  }

  // ⑫ 验收 command 路径逃逸词法拦截（lv-1，M6 设计《cw 自治运行活性与契约防护》
  // D3，fail 级——同规则⑩「真空声明」哲学：逃逸使 verify 语义失效，结果绑定
  // 执行瞬间的工作区状态而非账本 commit，防线从「verify 挂后人工修 spec」提前
  // 到提交期。触发案例：agent-managed-session u1 的 cd <开发worktree绝对路径>
  // 打回 7 轮假循环）。作用域：全部非 manual 型条目（manual 不执行命令豁免——
  // 同规则③作用域先例逻辑；unit/integration/e2e 级 command 都会被执行，逃逸面
  // 相同），不含 layer 维度（topic/unit 层条目同等受检——逃逸面与层级正交）。
  // command 缺失或 tokenize 后为空则跳过（同规则⑨先例）；tokenize 口径与规则⑨
  // 一致。诚实漏报面（不静默，由 reviewer 任务书第五维「干净 checkout 可执行
  // 性」语义审兜底，lv-3 将在第五维文案点名路径逃逸）：cd ../.. 类相对上跳
  // （不以 / 或 ~ 开头）；bash -c 'cd /abs && …' 类引号包裹关键词（'cd 非裸
  // token）；引号包裹的含空白绝对路径（cd "/abs path"——tokenize 按空白切分，
  // "/abs 与 path" 两 token 引号均不成对，剥引号剥不掉）；$(echo cd) /abs 类
  // 动态构造与 env 拼接；CW_WORKTREE_HOME 自定义非默认工作区名（子串检查只盖
  // 默认 .cw-worktrees——自定义名依赖用户配置，词法层不可枚举）
  for (const ac of spec.acceptance) {
    if (ac.type === "manual") {
      continue;
    }
    const command = ac.command ?? "";
    const tokens = tokenizeCommand(command);
    if (tokens.length === 0) {
      continue;
    }
    for (const gap of pathEscapeGaps(command, tokens)) {
      failures.push(
        `规则⑫: 验收 ${ac.id} 的 command 含路径逃逸（${gap.hit}）` +
          `——verify 在干净 checkout 执行（cwd = 检出树根），绝对路径 cd / .cw-worktrees 引用会让结果绑定执行瞬间的工作区状态而非账本 commit。` +
          `恢复动作：改用相对路径（cd packages/app && …）或 git -C <相对路径>；引用的脚本/文件必须提交进仓库（干净 checkout 只含账本 commit 的内容）。`,
      );
    }
  }

  return { ok: failures.length === 0, failures, warnings };
}

// ── 规则⑨：验收命令契约检查（单一事实源，可扩展枚举） ──────────────

/** 单个 flag 契约缺口：文案要素 = flag 原文 + 取值说明 + 冲突事实 + 恢复动作 */
interface FlagGap {
  /** 命令中的 flag 原文 token（如 "--reporter=verbose"、"-qq"） */
  flag: string;
  /** 取值说明（如 "（值=verbose）"）；无值形态的缺口说明取值缺失 */
  valueNote: string;
  /** 该 flag 与适配器输出契约的冲突事实（为什么必挂） */
  fact: string;
  /** 可操作恢复动作 */
  recovery: string;
}

/**
 * vitest / playwright 型共用契约：产物是命令 stdout 上的整体 JSON。
 *   - `--reporter` 只放行**等号形态且值恰为 `json`**（`--reporter=json`——
 *     存量夹具锁定的 includes 幂等合法形态，u5b/fx2/fx4/fx5/wt5 等 10 文件的
 *     `-- --reporter=json` 靠它零翻红）；等号形态其他值与 cw 自动追加的
 *     `--reporter=json` 并存，stdout 变成「人类可读文本 + JSON」混合体，
 *     JSON.parse 恒挂；
 *   - 空格形态 `--reporter <值>` 一律拒绝（无论值，mx5-5 S2 收紧）：translate
 *     幂等检查只认等号子串（src/testrun/vitest.ts 的 includes），空格形态命令
 *     不含该子串 → cw 再追加 `--reporter=json` → 双 reporter → 混合体恒挂——
 *     拦得住的拦死，错误暴露在 designer 工作现场而非 verify 期；
 *   - 禁 `--outputFile`（任何形式）：把 JSON 重定向到文件、stdout 无 JSON，
 *     解析必挂（真实 vitest 探针实测形态）。
 */
function jsonProductContract(tokens: readonly string[]): FlagGap[] {
  const gaps: FlagGap[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "--reporter") {
      // 空格形态一律拒绝（mx5-5 S2）：无论下一 token 取值——命令不含等号子串
      // --reporter=json，translate 幂等检查不命中，cw 会再追加形成双 reporter
      const next = tokens[i + 1];
      const valueNote =
        next === undefined || next.startsWith("-")
          ? "（空格形态，取值缺失）"
          : `（空格形态，值=${next}）`;
      gaps.push(spaceReporterGap(token, valueNote));
    } else if (token.startsWith("--reporter=")) {
      const value = token.slice("--reporter=".length);
      if (value !== "json") {
        gaps.push(reporterGap(token, `（值=${value}）`));
      }
    }
    if (token === "--outputFile" || token.startsWith("--outputFile=")) {
      gaps.push({
        flag: token,
        valueNote: "",
        fact:
          "--outputFile 会把 JSON 产物重定向到文件、stdout 上无 JSON，vitest/playwright 适配器从 stdout 解析必挂（实测形态）。",
        recovery: "删除该 flag——cw 从命令 stdout 解析产物，不接受输出重定向。",
      });
    }
  }
  return gaps;
}

function reporterGap(flag: string, valueNote: string): FlagGap {
  return {
    flag,
    valueNote,
    fact:
      "vitest/playwright 适配器由 cw 自动追加 --reporter=json，命令自带其他 reporter 值会与之并存，stdout 混入人类可读文本，JSON 解析恒挂、验收恒判 fail。",
    recovery: "删除该 flag——cw 会自动追加正确的 reporter。",
  };
}

/**
 * 空格形态 `--reporter <值>` 的缺口（mx5-5 S2）：理由链与恢复动作都指向等号
 * 形态——它不是「值选错」而是「形态选错」，改值救不了（值恰为 json 也恒挂）。
 */
function spaceReporterGap(flag: string, valueNote: string): FlagGap {
  return {
    flag,
    valueNote,
    fact:
      "空格形态不含 translate 幂等检查认定的等号子串 --reporter=json，cw 会再追加该 flag 形成双 reporter，stdout 混入人类可读文本，JSON 解析恒挂、验收恒判 fail。",
    recovery:
      "改用等号形态 --reporter=json（唯一幂等安全形态）或删除该 flag——cw 会自动追加正确的 reporter。",
  };
}

/** pytest 短选项簇：单 `-` 开头且不含第二个 `-`（如 -q、-v、-qq、-vq、-x） */
const SHORT_OPTION_CLUSTER_RE = /^-[^-]+$/;

/**
 * `--quiet` 的 argparse 合法前缀缩写链（mx5-5 S3）：--q / --qu / --qui / --quie /
 * --quiet（严格逐字符前缀，非任意 startWith——`--query`、`--quietly` 等更长选项
 * 不是链成员，不因本禁令拦截；argparse 对它们按独立选项解析）。前缀缩写与全称
 * 等价触发 verbosity 相抵，漏拦即确定性解析失败漏网。
 */
const QUIET_LONG_PREFIX_RE = /^--q(?:u(?:i(?:e(?:t)?)?)?)?$/;

/**
 * pytest 型契约：禁 `-q` / `--quiet` 及其长选项前缀缩写——与适配器自动追加的
 * `-v` verbosity 相抵、条目行消失，全 pass 且 exit 0 仍解析失败（真实 pytest
 * 探针实测；「同 flag 幂等」只对同 flag 成立，反义词 flag 是真冲突）。短选项
 * 可连写（-qq/-vq/-qqq 等），token 精确枚举不可行——对簇 token 逐字符展开
 * （includes("q") 即簇中含 quiet）；长选项前缀缩写走 QUIET_LONG_PREFIX_RE
 * 严格前缀链。适配器追加的 `--tb=no`、`-p no:cacheprovider` 与命令自带同值
 * 幂等，不设禁。
 */
function noQuietContract(tokens: readonly string[]): FlagGap[] {
  const gaps: FlagGap[] = [];
  for (const token of tokens) {
    if (
      QUIET_LONG_PREFIX_RE.test(token) ||
      (SHORT_OPTION_CLUSTER_RE.test(token) && token.includes("q"))
    ) {
      gaps.push({
        flag: token,
        valueNote: "（pytest quiet）",
        fact:
          "-q/--quiet（含前缀缩写）与适配器自动追加的 -v verbosity 相抵、条目行消失，测试全 pass 且 exit 0 仍解析失败（短选项合写簇同样命中）。",
        recovery: "删除该 flag——cw 会自动追加正确的 verbosity 参数。",
      });
    }
  }
  return gaps;
}

/**
 * 规则⑨禁令清单（单一事实源内的可扩展枚举）：key = adapterTypeFor 路由结果，
 * value = 该适配器的 flag 契约检查（输入 = command 的空白切分 token）。
 * e2e-sh / manual 型不在表中 = 不设静态规则（诚实边界：无法静态证明标记行
 * 产出——标记可能在脚本内、可能条件执行；漏网形态由 mx5-2 verify 阶段回炉
 * 通道与 mx5-3 reviewer 任务书契约清单兜底）。新冲突形态（适配器扩容 / 新
 * flag）在此一处追加，禁止散落多个函数。
 */
const ADAPTER_FLAG_CONTRACTS: Readonly<
  Record<string, (tokens: readonly string[]) => FlagGap[]>
> = {
  vitest: jsonProductContract,
  playwright: jsonProductContract,
  pytest: noQuietContract,
};

// ── 规则⑪：全量回归形态枚举（单一事实源，可扩展，与 ADAPTER_FLAG_CONTRACTS 同型组织） ──

/** 形态 A 的 vitest 前允许的包管理器前缀 token（`npm vitest run` 非合法调用形态，不列） */
const VITEST_PREFIX_TOKENS: readonly string[] = ["npx", "pnpm", "yarn", "bun", "bunx"];

/** 形态 B 的包管理器首 token（script 调用形态） */
const SCRIPT_MANAGER_TOKENS: readonly string[] = ["npm", "pnpm", "yarn", "bun"];

/** 形态 B 触发成本警告的 script 名（全仓作用域的 test / lint） */
const WHOLE_REPO_SCRIPT_NAMES: readonly string[] = ["test", "lint"];

/** 形态 A 的词法锚跨距：`vitest run` 两 token（run 之后首个 token 的偏移） */
const VITEST_RUN_TOKEN_SPAN = 2;

/** 命中形态的人读描述（进规则⑪ warning 的事实段：形态 + 原文命令，供审计定位） */
function formLabel(kind: string, command: string): string {
  return `${kind}，原文 "${command}"`;
}

/** from 起「无位置参数」判定：无后续 token，或后续 token 全部以 `-` 开头（flag） */
function noPositionalArgs(tokens: readonly string[], from: number): boolean {
  return tokens.slice(from).every((t) => t.startsWith("-"));
}

/**
 * 形态 A（vitest 全量）：token 序列 = [可选包管理器前缀] vitest run [flag...]，
 * 且 run 之后无位置参数（后续 token 全部 `-` 开头或无后续）→ 全仓 vitest run。
 * run 之后存在不以 `-` 开头的 token（文件/目录参数）→ 已收窄，不命中。
 */
function vitestFullRunForm(tokens: readonly string[]): string | null {
  let i = 0;
  if (VITEST_PREFIX_TOKENS.includes(tokens[0] ?? "")) {
    i = 1;
  }
  if (tokens[i] !== "vitest" || tokens[i + 1] !== "run") {
    return null;
  }
  if (!noPositionalArgs(tokens, i + VITEST_RUN_TOKEN_SPAN)) {
    return null;
  }
  return formLabel("无文件参数的全量 vitest run", tokens.join(" "));
}

/**
 * 形态 B（全仓 script）：首 token 为包管理器（npm/pnpm/yarn/bun），其后允许
 * `run` 中缀，script 名恰为 test / lint，且 script 名之后无位置参数 → 全仓
 * test / lint script 调用。
 */
function wholeRepoScriptForm(tokens: readonly string[]): string | null {
  if (!SCRIPT_MANAGER_TOKENS.includes(tokens[0] ?? "")) {
    return null;
  }
  let i = 1;
  if (tokens[i] === "run") {
    i += 1;
  }
  const script = tokens[i];
  if (script === undefined || !WHOLE_REPO_SCRIPT_NAMES.includes(script)) {
    return null;
  }
  if (!noPositionalArgs(tokens, i + 1)) {
    return null;
  }
  return formLabel(`全仓 ${script} script`, tokens.join(" "));
}

/**
 * 规则⑪形态枚举（单一事实源内的可扩展枚举）：每个成员 = 一种全量回归形态的
 * 词法判定，命中返回形态描述、不命中返回 null。显式不枚举（诚实漏报面，设计
 * D5）：wrapper 脚本（`bash xxx.sh`——内部跑什么词法不可见，触发案例 E7 的
 * 实际形态）、script 别名封装、`make test` 等——这些形态的语义审查归 reviewer
 * 任务书第六维（须追进脚本/别名内容，brief.ts），gate 词法层不猜。新形态在此
 * 一处追加，禁止散落多个函数。
 */
const FULL_REGRESSION_FORMS: readonly ((
  tokens: readonly string[],
) => string | null)[] = [vitestFullRunForm, wholeRepoScriptForm];

// ── 规则⑫：路径逃逸词法拦截（单一事实源，与 ADAPTER_FLAG_CONTRACTS 同型组织） ──

/** cw 专属工作区目录名（规则⑫判据一的子串锚）：验收命令零合法引用面 */
const CW_WORKTREE_DIR_NAME = ".cw-worktrees";

/**
 * 目录选择词法族（规则⑫判据二，单一事实源内的可扩展枚举，与
 * ADAPTER_FLAG_CONTRACTS / FULL_REGRESSION_FORMS 同型组织）：族成员后随剥引号
 * 以 `/` 或 `~` 开头的 token → 路径逃逸拦截（`vitest --root /abs/worktree` 与
 * `cd /abs` 逃逸语义完全等价 = 换树执行）。`git -C` 由 `-C` 成员覆盖（token
 * 序列判定不区分宿主命令）；判定要求后随绝对路径 token，`grep -C 2` 类数值
 * 后随不误拦。后续按真实逃逸案例增补，禁止散落多个函数。
 */
const DIRECTORY_FLAG_TOKENS: readonly string[] = [
  "cd",
  "-C",
  "--dir",
  "--prefix",
  "--root",
];

/**
 * 目录选择长 flag 等号紧贴形态前缀（规则⑫判据二的等号分支，单一事实源内的
 * 可扩展枚举，与 DIRECTORY_FLAG_TOKENS 同型组织）：`--root=/abs` 这类 token
 * 整体不等于裸 `--root`，严格相等匹配盖不住，前缀命中后取等号后的值部分剥
 * 引号判定（`--root="/abs"` 整 token 引号形态也覆盖）。`cd` 与 `-C` 无 `=`
 * 赋值语义，不入本清单；空值（`--root=`）无路径部分、逃逸面为零，不拦（对齐
 * -C 紧贴分支的最小长度处理理由）。后续按真实逃逸案例增补，禁止散落多个函数。
 */
const DIRECTORY_FLAG_EQUALS_PREFIXES: readonly string[] = [
  "--dir=",
  "--prefix=",
  "--root=",
];

/** 单个路径逃逸缺口（对齐规则⑨ FlagGap 形态）：文案要素 = 命中片段 */
interface EscapeGap {
  /** 命中片段：判据一 ".cw-worktrees"（子串），判据二 "<族token> <绝对路径token>" */
  hit: string;
}

/** 成对引号的最小 token 长度（首尾各占一个引号字符，短于此必非成对包裹） */
const MIN_QUOTED_TOKEN_LENGTH = 2;

/**
 * -C 紧贴绝对路径形态的最小 token 长度（"-C/" / "-C~" 本身；再短无路径部分，
 * 裸 -C/ 的空值逃逸面为零）。lint 层 magic number 治理与语义命名兼得。
 */
const MIN_GLUED_ESCAPE_TOKEN_LENGTH = 3;

/**
 * 剥引号：去除成对首尾单/双引号一层（`cd "/abs/path"` 的值 token 剥后以 /
 * 开头即拦）。非成对包裹原样返回。族成员本身须裸 token——`'cd'` 带引号前缀
 * 不匹配（诚实漏报面，见规则⑫注释）。
 */
function stripPairedQuotes(token: string): string {
  if (token.length < MIN_QUOTED_TOKEN_LENGTH) {
    return token;
  }
  const first = token[0];
  if ((first === '"' || first === "'") && token[token.length - 1] === first) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * 规则⑫两判据（纯词法不执行命令，对齐规则③⑨⑪形态）：① 子串——command
 * 原文含 ".cw-worktrees"（cw 专属工作区目录名，verify 在干净 checkout 执行，
 * 引用开发工作区即绑定执行瞬间状态）；② 词法族——某 token 命中
 * DIRECTORY_FLAG_TOKENS 且下一 token 剥引号后以 `/` 或 `~` 开头，或 token
 * 自身为 `-C` 紧贴绝对路径形态（`-C/abs`、`-C~x`——git 短选项合法写法，
 * 严格相等匹配盖不住，剥 `-C` 前缀后即绝对路径），或 token 命中
 * DIRECTORY_FLAG_EQUALS_PREFIXES 等号紧贴形态（`--root=/abs`——长 flag 合法
 * 赋值写法，token 整体不等于裸 flag，取等号后值部分剥引号判定）。一条
 * command 命中两判据（如 cd /x/.cw-worktrees/y）出两条缺口——多缺口全列
 * 不短路，对齐模块头既有约定。
 */
function pathEscapeGaps(
  command: string,
  tokens: readonly string[],
): EscapeGap[] {
  const gaps: EscapeGap[] = [];
  if (command.includes(CW_WORKTREE_DIR_NAME)) {
    gaps.push({ hit: `"${CW_WORKTREE_DIR_NAME}"` });
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    // -C 紧贴绝对路径（长度 >3：裸 -C/ 或 -C~ 无路径部分罕见且空值逃逸面为零）
    if (
      token.length > MIN_GLUED_ESCAPE_TOKEN_LENGTH &&
      (token.startsWith("-C/") || token.startsWith("-C~"))
    ) {
      gaps.push({ hit: `"${token}"` });
      continue;
    }
    // 长目录 flag 等号紧贴绝对路径（--root=/abs、--dir="~/x"：值部分剥引号后
    // 以 / 或 ~ 开头才拦；空值 --root= 与相对/数值值不拦）
    const equalsPrefix = DIRECTORY_FLAG_EQUALS_PREFIXES.find((prefix) =>
      token.startsWith(prefix),
    );
    if (equalsPrefix !== undefined) {
      const value = stripPairedQuotes(token.slice(equalsPrefix.length));
      if (value.startsWith("/") || value.startsWith("~")) {
        gaps.push({ hit: `"${token}"` });
      }
      continue;
    }
    if (!DIRECTORY_FLAG_TOKENS.includes(token)) {
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined) {
      continue;
    }
    const stripped = stripPairedQuotes(next);
    if (stripped.startsWith("/") || stripped.startsWith("~")) {
      gaps.push({ hit: `"${token} ${next}"` });
    }
  }
  return gaps;
}

/**
 * `which` 等价检查：含路径分隔符时直接验证该文件可执行，否则遍历 PATH
 * 各目录查找可执行文件。目录不通过（实测 macOS `which /private/tmp` 返回
 * not found——目录对 X_OK 恒真，故必须叠加 isFile 检查）；Windows 的
 * PATHEXT 扩展查找不支持（本项目运行环境为类 Unix）。
 */
function isResolvableOnPath(bin: string): boolean {
  if (bin.includes("/")) {
    return isExecutable(bin);
  }
  const pathDirs = (process.env.PATH ?? "").split(pathDelimiter);
  return pathDirs.some((dir) => dir !== "" && isExecutable(join(dir, bin)));
}

function isExecutable(candidate: string): boolean {
  try {
    // 目录对 accessSync(X_OK) 恒真（目录天然可遍历），须叠加 isFile 才与 which
    // 行为一致——首 token 是目录（如 /tmp）不是可执行 command
    if (!statSync(candidate).isFile()) {
      return false;
    }
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    // statSync/accessSync 抛错即「非普通文件/不可执行/不存在」，这正是要返回的
    // 结果而非需传播的错误
    return false;
  }
}
