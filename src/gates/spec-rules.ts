/**
 * spec gate 五规则（canon《design-rewrite-architecture.md》§3.3 D3「机器前置规则」；
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
 * `--reporter=json` 冲突致 JSON 解析恒挂；禁令清单见 ADAPTER_FLAG_CONTRACTS）。
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
 * spec 提交时的机器前置规则（①-⑤ 为 u3 五规则，⑥ 为 fx-1 追加，⑦ 为 rv-2 追加，
 * ⑧ 为 mx-2 追加，⑨ 为 mx5-1 追加）。确定性检查（对同一 spec + 同一 PATH 环境结果
 * 恒定），不做任何主观判断——「验收强不强」由独立 reviewer 审，不在本函数职责内。
 */
export function checkSpecRules(spec: SpecSubmittedPayload): SpecRulesResult {
  const failures: string[] = [];

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
    const tokens = (ac.command ?? "").trim().split(/\s+/).filter((t) => t !== "");
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

  return { ok: failures.length === 0, failures };
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
