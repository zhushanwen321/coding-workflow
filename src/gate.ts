/**
 * gate — 极简 gate 检查 + GitValidator（lite 单轨极简版）。
 *
 * 与旧版的差异（重构 = 推倒重建）：
 * - 砍掉 GateRegistry 声明表 + GateRunner dispatch 表（旧版 gates.ts 的 8 check 脚本 dispatch）
 * - 砍掉 GateTier 分档强度（gateHistory 不再记 tier 字段，types 已砍）
 * - 砍掉 runGate 通用执行器——多个具名 check 函数内联各 phase 的校验逻辑
 * - 保留 GitValidator（validate），从旧 gates.ts 1:1 移植（isAncestorOfAny 已删：零调用 dead code）
 * - 保留 judgeByExpected（已在 types.ts，testCheck 调用）
 *
 * engine 职责边界（选项 A）：只做最基础结构校验，质量约束交回 skill 文档管。
 *   - planCheck：dev-plan（waves 部分）校验，只调 parseDevPlan，只校验 waves 非空（向后兼容旧格式）
 *   - tddPlanCheck：test.json 校验（testCases 非空 + mock+real 分层强制 + 模糊值检测），调 parseTestJson
 *   - redLightCheck：执行测试命令确认红灯（exit ≠ 0）
 *   - runTestRunner：按 TestRunnerConfig 执行测试，返回 stdout/stderr/exitCode
 *   - devCheck：commit 存在 + 非空（GitValidator.validate）
 *   - testCheck：judgeByExpected 机器重算（丢 claimedStatus，D-008）
 *   - fileExistsCheck：文件存在 + 非空（retrospect/closeout gate）
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";

import { parseClarifyJson, type ParsedClarify, type ParsedDevPlan, parseDevPlan, type ParsedTestJson, parseTestJson } from "./plan-parser.js";
import {
  type Actual,
  CwError,
  type Expected,
  judgeByExpected,
  type ReviewDimension,
  type ReviewIssueSubmission,
  type SpecSection,
  type TestCase,
  type TestRunnerConfig,
  type Topic,
} from "./types.js";

// ── 常量 ─────────────────────────────────────────────────────

/** POSIX exit code：命令未找到（shell 模式下 spawn 返回 127 而非 ENOENT 异常）。 */
const EXIT_COMMAND_NOT_FOUND = 127;

// ── GitValidator（从旧 gates.ts 1:1 移植） ──────────────────

export interface CommitValidation {
  commitHash: string;
  exists: boolean;
  inRepo: boolean;
  nonEmpty: boolean;
  valid: boolean;
  reason?: string;
  /**
   * 该 commit 实际改动的完整文件列表（git diff-tree --name-only）。
   * devCheck 填充，handleDev 持久化到 Wave.changedFiles。
   * 用于 plan 完成度客观核对、有效产出率、散弹枪修改指数。
   * diff-tree 异常或提前 return 路径时为 undefined。
   */
  changedFiles?: string[];
  /**
   * 不在 plan changes 中的额外改动文件（宽松模式，只警告不 fail）。
   * devCheck 用 git diff-tree 提取实际改动文件，与 planData.waves 对比后填充。
   */
  extraFiles?: string[];
  /**
   * 与此 commitHash 共享的其他 waveId 列表（只警告不 fail）。
   * handleDev 检测同一 commitHash 绑定多个 wave 时填充。
   * commit 是 Wave 级验证锚点——共享 commit 让两个 Wave 的验证脱节。
   */
  extraCommitReuse?: string[];
}

/** git 可执行文件缺失判定（ENOENT = 基础设施异常，应 throw 而非吞掉）。 */
function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    String((e as { code: unknown }).code) === "ENOENT"
  );
}

/**
 * GitValidator — git 三项校验（commit 存在 + 在 repo 内 + 非空）。
 *
 * 与旧版的差异：constructor 从接受 workspacePath 改为接受 workspacePath，
 * validate 方法签名不变。砍掉旧版「adapter 真引 SDK」的注释噪音，保留核心三项校验逻辑。
 *
 * 失败路径：
 *   - 非 git repo → valid:false, reason:"not a git repo"
 *   - git ENOENT（git 未安装）→ throw（基础设施异常，不吞）
 *   - commit 不存在 → exists:false
 *   - 空 commit → nonEmpty:false
 */
export class GitValidator {
  constructor(readonly workspacePath: string) {}

  /**
   * 三项校验：repo 探测 → cat-file 存在性 → diff-tree 非空。
   *
   * inRepo 合并入 exists（ADR-029 robustness #1）：cat-file 成功即证明 commit 在本 repo 的
   * object store 内，无需额外校验。
   */
  validate(commitHash: string): CommitValidation {
    // Step 0: 探测 git repo（rev-parse）。非 repo → valid:false。
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.workspacePath,
        encoding: "utf8",
        stdio: "ignore",
      });
    } catch (e) {
      if (isENOENT(e)) throw e;
      return {
        commitHash,
        exists: false,
        inRepo: false,
        nonEmpty: false,
        valid: false,
        reason: "not a git repo",
      };
    }

    let exists = false;
    let nonEmpty = false;

    // Step 1: cat-file -e（commit 对象存在性）
    try {
      execFileSync("git", ["cat-file", "-e", `${commitHash}^{commit}`], {
        cwd: this.workspacePath,
        encoding: "utf8",
        stdio: "ignore",
      });
      exists = true;
    } catch (e) {
      if (isENOENT(e)) throw e;
      exists = false;
    }

    // Step 2: inRepo 合并入 exists（ADR-029）
    const inRepo = exists;

    // Step 3: diff-tree --shortstat（非空 commit）。--root 让首 commit 也能算非空。
    try {
      const stat = execFileSync(
        "git",
        ["diff-tree", "--shortstat", "--root", commitHash],
        {
          cwd: this.workspacePath,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      nonEmpty = stat.trim().length > 0;
    } catch (e) {
      if (isENOENT(e)) throw e;
      nonEmpty = false;
    }

    const valid = exists && inRepo && nonEmpty;
    let reason: string | undefined;
    if (!valid) {
      const parts: string[] = [];
      if (!exists) parts.push("cat-file");
      if (!nonEmpty) parts.push("empty");
      reason = parts.join(",");
    }
    return { commitHash, exists, inRepo, nonEmpty, valid, reason };
  }
}

// ── planCheck（调 parseDevPlan，只校验 waves 部分） ─────────────

export interface PlanCheckResult {
  result: "pass" | "fail";
  report: string;
  /** 范围守门 warning（result=pass 但范围可能过大，不阻断） */
  warning?: string;
}

/**
 * planCheck — dev-plan gate 的结构校验（只校验 waves 部分）。
 *
 * 改造说明（W3）：planCheck 只调 parseDevPlan（不调 parseLitePlan），只校验 waves 非空。
 * 删除了原本绑定在 planCheck 上的 testCases 校验（模糊值检测、mock+real 分层强制）——
 * 这两块校验已搬到 tddPlanCheck，因为 test.json 现在是独立文件。
 *
 * 向后兼容：如果 planJson 含 testCases（旧版 plan.json 格式），parseDevPlan 会把 testCases
 * 提取到 legacyTestCases，但 planCheck 不再校验 testCases 内容，所以旧格式仍然 pass。
 *
 * 失败路径（parseDevPlan throw）：
 *   - format !== "lite" / 非 object / size 超 1MB / schema 不符 / 环形 dependsOn → fail。
 *   - waves 空数组 → fail（schema 允许空数组，planCheck 额外校验非空）。
 */
export function planCheck(planJson: unknown, specSections?: SpecSection[]): PlanCheckResult {
  try {
    const parsed = parseDevPlan(planJson);

    // 校验 waves 非空（parseDevPlan schema 允许空数组，这里补一刀）。
    if (parsed.waves.length === 0) {
      return {
        result: "fail",
        report: "dev-plan waves 为空：至少需要 1 个 wave。",
      };
    }

    // 合并 scope warning + FR 覆盖 warning
    const warnings: string[] = [];
    const scopeWarning = checkPlanScopeWarning(parsed);
    if (scopeWarning.warning) warnings.push(scopeWarning.warning);
    const frWarning = checkFrCoverage(parsed, specSections);
    if (frWarning) warnings.push(frWarning);

    return {
      result: "pass",
      report: "",
      ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: "fail", report: msg };
  }
}

/// 范围守门阈值。超过 = 返回 warning（不阻断），提示 agent 考虑拆分 topic。
/// stats.ts 复杂度分桶也复用这两个阈值。
export const SCOPE_WARN_WAVES = 10;
export const SCOPE_WARN_FILES = 15;

/**
 * checkPlanScopeWarning — 范围守门客观信号检查（warning 不阻断）。
 *
 * engine 层面只能从 dev-plan.json 的结构数据客观推断，不做语义判断。
 * 可判定的维度：waves 数量、涉及文件数（从 changes 文本提取路径）。
 * 不可判定的维度（仍由 prompt 把关）：是否涉及状态机/架构变更、是否需要架构决策。
 */
function checkPlanScopeWarning(
  parsed: ParsedDevPlan,
): { warning?: string } {
  const allChanges = parsed.waves.flatMap((w) => w.changes ?? []);
  const files = extractFilesFromChanges(allChanges);

  const warnings: string[] = [];
  if (parsed.waves.length > SCOPE_WARN_WAVES) {
    warnings.push(
      `waves 数量 ${parsed.waves.length} 超过 ${SCOPE_WARN_WAVES}，考虑拆分为多个 topic`,
    );
  }
  if (files.size > SCOPE_WARN_FILES) {
    warnings.push(
      `涉及文件数 ${files.size} 超过 ${SCOPE_WARN_FILES}，考虑拆分或升级流程`,
    );
  }

  if (warnings.length === 0) return {};
  return { warning: warnings.join("; ") };
}

/**
 * checkFrCoverage — plan waves 是否覆盖 spec 的功能需求（warning 不阻断）。
 *
 * 宽松匹配：FR 的 id 或 title 出现在任一 wave 的 changes[].description 里 = 覆盖。
 * 未覆盖的 FR 列入 warning，提示 agent 检查是否有遗漏（可能是有意的缩范围）。
 *
 * 无 spec 或 spec 无 FR 时返回 undefined（不触发检查）。
 */
export function checkFrCoverage(
  parsed: ParsedDevPlan,
  specSections?: SpecSection[],
): string | undefined {
  if (!specSections || specSections.length === 0) return undefined;

  // 聚合所有 FR
  const frs: Array<{ id: string; title: string }> = [];
  for (const s of specSections) {
    if (s.type === "functionalRequirements") {
      for (const fr of s.items) {
        frs.push({ id: fr.id, title: fr.title });
      }
    }
  }
  if (frs.length === 0) return undefined;

  // plan 的所有 description 拼成一个搜索池
  const allDescs = parsed.waves
    .flatMap((w) => w.changes ?? [])
    .map((c) => `${c.description} ${c.file}`)
    .join(" ");

  const unmatched = frs.filter(
    (fr) => !allDescs.includes(fr.id) && !allDescs.includes(fr.title),
  );

  if (unmatched.length === 0) return undefined;
  return `以下 spec FR 可能在 plan 中未覆盖（检查是否有意缩范围）：${unmatched.map((f) => f.id).join(", ")}`;
}

/**
 * checkAcMapping — test cases 是否映射 spec 的验收标准（warning 不阻断）。
 *
 * 宽松匹配：AC 的 id 出现在任一 testCase 的 scenario 或 steps 里 = 映射。
 * 未映射的 AC 列入 warning，提示 agent 检查测试是否遗漏验收条件。
 *
 * 无 spec 或 spec 无 AC 时返回 undefined（不触发检查）。
 */
export function checkAcMapping(
  parsed: ParsedTestJson,
  specSections?: SpecSection[],
): string | undefined {
  if (!specSections || specSections.length === 0) return undefined;

  // 聚合所有 AC id
  const acIds: string[] = [];
  for (const s of specSections) {
    if (s.type === "acceptanceCriteria") {
      for (const ac of s.items) {
        acIds.push(ac.id);
      }
    }
  }
  if (acIds.length === 0) return undefined;

  // test 的所有 scenario + steps 拼成搜索池
  const searchText = parsed.testCases
    .map((tc) => `${tc.scenario} ${tc.steps}`)
    .join(" ");

  const unmapped = acIds.filter((id) => !searchText.includes(id));

  if (unmapped.length === 0) return undefined;
  return `以下 spec AC 在 test 中可能未映射（检查是否遗漏验收条件）：${unmapped.join(", ")}`;
}

// ── tddPlanCheck（调 parseTestJson，校验 testCases） ────────────

export interface TddPlanCheckResult {
  result: "pass" | "fail";
  report: string;
  /** 解析后的 testCases（pass 时供 handler 写入 store） */
  parsed?: ParsedTestJson;
  /** AC 映射 warning（result=pass 但 AC 可能未全覆盖，不阻断） */
  warning?: string;
}

/// P0: 模糊 expected 值正则（不区分大小写，全词匹配）。
/// 匹配这些值的 expected.text 表示 agent 未真正跑测试，只填了结论词。
const FUZZY_EXPECTED_RE =
  /^(passed|ok|success|fail|failed|true|false|yes|no|done|completed|正确|错误|成功|失败)$/i;

/**
 * tddPlanCheck — test.json gate 校验（testCases 非空 + mock+real 分层强制 + 模糊值检测）。
 *
 * 三层校验（从旧版 planCheck 搬过来）：
 *   1. parseTestJson schema 校验（format + typebox）
 *   2. testCases 非空
 *   3. mock + real 分层强制（至少各 1 个）—— mock 层验证逻辑正确性，real 层验证集成契约
 *   4. 模糊 expected.text 检测（不能是 passed/ok/success 等结论词）
 *   5. expected 空/缺 type 判据检查（exact: url+text 都缺；缺 type 字段→友好报错 AC-7）
 *   6. script.path 沙箱校验（path 必须 resolve 在 workspacePath 内，AC-4a）
 *
 * pass 时返回 parsed，供 handler 写入 store。fail 时 parsed 为 undefined。
 *
 * @param workspacePath workspace 绝对路径，用于 script.path 沙箱校验（AC-4a）。
 *   省略时默认 process.cwd()。handleTddPlan 应传 deps.workspacePath / topic.workspacePath。
 */
export function tddPlanCheck(
  testJson: unknown,
  specSections?: SpecSection[],
  workspacePath: string = process.cwd(),
): TddPlanCheckResult {
  // AC-7: 预扫描 expected 缺 type 字段——typebox Union 失败时的报错是「Expected union value」，
  // 不含 "type" 字样也无法定位 testCase id。这里在 schema 校验前做一次友好的结构预检，
  // 报告明确点出 type 必填 + 哪些 testCase 缺。存量 fixture 已统一带 type，不会误伤。
  const missingTypeResult = checkMissingExpectedType(testJson);
  if (missingTypeResult) {
    return missingTypeResult;
  }

  let parsed: ParsedTestJson;
  try {
    parsed = parseTestJson(testJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: "fail", report: msg };
  }

  // 校验 testCases 非空（parseTestJson schema 允许空数组）。
  if (parsed.testCases.length === 0) {
    return {
      result: "fail",
      report: "test.json testCases 为空：至少需要 1 个 testCase。",
    };
  }

  // 测试分层强制：mock + real 各≥1。
  // mock 层验证逻辑正确性，real 层验证集成契约。只有一层 = 覆盖不完整。
  const hasMock = parsed.testCases.some((tc) => tc.layer === "mock");
  const hasReal = parsed.testCases.some((tc) => tc.layer === "real");
  const missingLayers: string[] = [];
  if (!hasMock) missingLayers.push("mock");
  if (!hasReal) missingLayers.push("real");
  if (missingLayers.length > 0) {
    return {
      result: "fail",
      report:
        `测试分层不完整：缺少 ${missingLayers.join(" 和 ")} 层 testCase。` +
        `plan 必须同时含 mock 层（验证逻辑正确性）和 real 层（验证集成契约）的测试用例。`,
    };
  }

  // P0: 检查模糊 expected 值（仅 exact 模式有 text 字段；exit_zero/script 无 text）。
  const fuzzyIds: string[] = [];
  for (const tc of parsed.testCases) {
    if (tc.expected.type === "exact" && tc.expected.text && FUZZY_EXPECTED_RE.test(tc.expected.text)) {
      fuzzyIds.push(tc.id);
    }
  }
  if (fuzzyIds.length > 0) {
    return {
      result: "fail",
      report:
        `expected.text 为模糊结论词（不允许填 passed/ok/success 等，需写具体判定条件）: ` +
        fuzzyIds.join(", "),
    };
  }

  // P1: 检查 expected 空判据 + script.path 沙箱（按 type 分支）。
  //   - exact：url 和 text 都缺 = 无法机器判定（空判据）
  //   - exit_zero：自带判据（type 本身即判据），不检查
  //   - script：path 缺/空 = 空判据；path 必须在 workspacePath 沙箱内（AC-4a）
  // 无判据的 testCase 到 test 阶段会被 judgeByExpected 判 failed「no judgeable field」，
  // 在 tdd_plan 前置拦截避免浪费整个 dev 周期。
  const noJudgeableIds: string[] = [];
  const sandboxLeakIds: string[] = [];
  for (const tc of parsed.testCases) {
    if (tc.expected.type === "exact") {
      if (tc.expected.url === undefined && tc.expected.text === undefined) {
        noJudgeableIds.push(tc.id);
      }
    } else if (tc.expected.type === "script") {
      if (!tc.expected.path || tc.expected.path.length === 0) {
        noJudgeableIds.push(tc.id);
        continue;
      }
      // AC-4a: path 必须 resolve 在 workspacePath 内。用 path.resolve 而非字符串 startsWith，
      // 才能抓到 "foo/../../../etc/passwd" 这种非顶层 .. 绕过。
      const resolved = pathResolve(workspacePath, tc.expected.path);
      const workspaceResolved = pathResolve(workspacePath);
      // 末尾加 sep 防止 "/foo" 误判 "/foobar" 为前缀（workspace 边界精确化）。
      const workspacePrefix =
        workspaceResolved.endsWith("/") ? workspaceResolved : workspaceResolved + "/";
      if (resolved !== workspaceResolved && !resolved.startsWith(workspacePrefix)) {
        sandboxLeakIds.push(tc.id);
      }
    }
    // exit_zero 无需检查判据。
  }
  if (sandboxLeakIds.length > 0) {
    return {
      result: "fail",
      report:
        `expected.path 越出 workspace 沙箱（script.path 必须 resolve 在 workspacePath 内，禁止 .. / 绝对路径越界）: ` +
        `${sandboxLeakIds.join(", ")}。`,
    };
  }
  if (noJudgeableIds.length > 0) {
    return {
      result: "fail",
      report:
        `expected 缺少判据字段（exact 需 url/text 至少一个，script 需 path）: ${noJudgeableIds.join(", ")}。` +
        `无判据的 testCase 无法被 CW 机器判定，到 test 阶段会被直接判 failed。`,
    };
  }

  // testRunner 必选——CW 需要它跑红灯校验（tdd_plan 阶段）和 test 机器重算（test 阶段）。
  // schema 层已强制 testRunner 存在（非 Optional），这里做语义校验：mode 对应的 command/path 必须有值。
  const runner = parsed.testRunner;
  if (runner.mode === "custom") {
    if (!runner.path) {
      return {
        result: "fail",
        report: "testRunner.mode=custom 时 path 必填（自定义脚本路径）。",
      };
    }
  } else {
    if (!runner.command) {
      return {
        result: "fail",
        report: `testRunner.mode=${runner.mode} 时 command 必填（如 "npx vitest run"、"python -m pytest"）。`,
      };
    }
  }

  // AC 映射 warning（不阻断）
  const acWarning = checkAcMapping(parsed, specSections);

  return { result: "pass", report: "", parsed, ...(acWarning ? { warning: acWarning } : {}) };
}

/**
 * checkMissingExpectedType — AC-7 友好预检：扫描 raw testJson 的 testCases，
 * 找出 expected 缺 type 字段的条目。typebox Union 失败报错是「Expected union value」，
 * 不含 "type" 字样且无法定位 testCase id，所以在这里前置成「expected 缺 type 字段（必填）」
 * 的明确报错。
 *
 * 只做最小结构推断（不重复 schema 全量校验）：找到 testCases 数组 + 每条 expected 对象，
 * 若 expected 不是对象或无 type 字段则视为缺 type。
 *
 * @returns 缺 type 时的 fail result；合法（无缺 type 或结构无法推断）时返回 undefined。
 */
function checkMissingExpectedType(testJson: unknown): TddPlanCheckResult | undefined {
  if (typeof testJson !== "object" || testJson === null) return undefined;
  const cases = (testJson as { testCases?: unknown }).testCases;
  if (!Array.isArray(cases)) return undefined;

  const missingIds: string[] = [];
  for (const tc of cases) {
    if (typeof tc !== "object" || tc === null) continue;
    const id = (tc as { id?: unknown }).id;
    const expected = (tc as { expected?: unknown }).expected;
    if (expected === undefined || typeof expected !== "object" || expected === null) {
      // expected 缺失或非对象：也算缺 type（schema 会拒绝，这里友好提示）。
      if (typeof id === "string") missingIds.push(id);
      continue;
    }
    if (!("type" in expected)) {
      if (typeof id === "string") missingIds.push(id);
    }
  }
  if (missingIds.length === 0) return undefined;
  return {
    result: "fail",
    report:
      `expected 缺 type 字段（type 必填，取值 exact | exit_zero | script）: ${missingIds.join(", ")}。` +
      `旧格式 {url?,text?} 已废弃，请补 type 字段。`,
  };
}

// ── redLightCheck（执行测试命令确认红灯） ─────────────────────

export interface RedLightResult {
  /** true=红灯确认（测试如期失败），false=非红灯（测试意外通过了） */
  redLight: boolean;
  reason: string;
}

/**
 * redLightCheck — 执行测试命令，确认测试如期失败（红灯）。
 *
 * TDD 红灯阶段：agent 写了测试但还没写实现，测试应该失败。
 *   - exit code !== 0 → redLight=true（红灯确认，符合预期）
 *   - exit code === 0 → redLight=false（测试已通过，不是红灯，TDD 违规——可能 agent 提前写了实现）
 *   - timeout（30s）→ redLight=false（测试还没跑完，无法确认红灯，不算违规也不算确认）
 *
 * spawn 异常（命令不存在、权限错误等基础设施问题）返回 redLight=false + reason，
 * 不抛错——交给上层判定（区分「测试通过了」和「测试根本跑不起来」）。
 *
 * timeout 误判修复：execFileSync timeout 时抛出的异常 status=null（非数字），
 * getExitCode 返回 -1，若不先拦会被当成 exit code !== 0 误判成红灯。
 * 所以 catch 里先检查 isTimeoutKilled（e.killed === true），timeout 时返回 redLight=false。
 *
 * 「命令不存在」的识别：shell 模式下 execFileSync 不会抛 ENOENT（shell 本身存在），
 * 而是返回 exit code 127（POSIX 约定的 command-not-found）。所以这里同时检测
 * isENOENT（spawn 失败）和 exit code 127（shell 内命令未找到），都视为 spawn error。
 *
 * @param testCommand 测试命令字符串，直接传给 shell 执行（如 "npx vitest run"）
 * @param cwd 执行目录（绝对路径）
 *
 * TODO(安全): 当前用 shell:true 执行 testCommand，存在命令注入风险。
 * testCommand 来自 testRunner.command（test.json），agent 产出，非常规可信输入。
 * 后续应改为 shell:false + 命令拆分（如 ["/bin/sh", "-c", ...] 或直接用 spawn），
 * 或在 prompt 中明确标注 command 字段会被 shell 执行。
 */
export function redLightCheck(testCommand: string, cwd: string): RedLightResult {
  try {
    execFileSync(testCommand, {
      cwd,
      encoding: "utf8",
      shell: true,
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // exit code === 0：测试通过了，不是红灯。
    return {
      redLight: false,
      reason: `测试意外通过（exit code 0），TDD 红灯阶段要求测试失败：${testCommand}`,
    };
  } catch (e) {
    // timeout → 不是红灯（测试可能还没跑完，无法确认红灯）。
    // execFileSync timeout 时 Node 发 SIGTERM 杀子进程，抛出的异常 status=null（非数字），
    // getExitCode 返回 -1。若不先拦 timeout，会被下面的 exit code !== 0 分支误判成红灯。
    // 特征：e.killed === true（execFileSync 标记被 kill），且 e.signal === "SIGTERM"。
    if (isTimeoutKilled(e)) {
      return {
        redLight: false,
        reason: `测试执行超时（30s timeout），无法确认红灯：${testCommand}`,
      };
    }
    // spawn 异常（命令不存在等）→ 不是真正的「测试失败」，返回 redLight=false。
    if (isENOENT(e) || getExitCode(e) === EXIT_COMMAND_NOT_FOUND) {
      return {
        redLight: false,
        reason: `测试命令执行失败（spawn error，命令不存在）：${testCommand}`,
      };
    }
    // exit code !== 0：测试如期失败，红灯确认。
    const exitCode = getExitCode(e);
    return {
      redLight: true,
      reason: `测试如期失败（exit code ${exitCode}），红灯确认。`,
    };
  }
}

/**
 * 判断 execFileSync 抛出的异常是否是 timeout kill。
 *
 * execFileSync 设了 timeout 后，超时 Node 会向子进程发 SIGTERM（默认 killSignal），
 * 然后抛出异常，其特征：killed === true（execFileSync 自己打的标记，表示因 timeout 被杀），
 * signal === "SIGTERM"。此时 status 通常为 null（进程没正常退出，拿不到 exit code）。
 *
 * 单看 signal === "SIGTERM" 不够（测试框架自己可能发 SIGTERM）；killed === true 是
 * execFileSync 专属标记，只有 timeout/killSignal 触发时才为 true，足以区分。
 */
function isTimeoutKilled(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  if (!("killed" in e)) return false;
  return (e as { killed: unknown }).killed === true;
}

/// 从 execFileSync 抛出的异常里提取 status/exit code（失败时返回 -1）。
function getExitCode(e: unknown): number {
  if (typeof e === "object" && e !== null && "status" in e) {
    const status = (e as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return -1;
}

// ── runTestRunner（按 TestRunnerConfig 执行测试） ─────────────

export interface RunTestRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * runTestRunner — 按 TestRunnerConfig 执行测试，返回 stdout/stderr/exitCode。
 *
 * 命令构造（按 mode）：
 *   - nodejs/python/java：直接用 config.command，在 config.cwd（相对 workspacePath）下执行。
 *     config.cwd 省略时在 workspacePath 下执行。
 *   - custom：用 `bash config.path`（path 相对 workspacePath），在 workspacePath 下执行。
 *
 * spawn 异常（ENOENT 等）抛出 CwError——区别于 runTestRunner 内部执行失败的 exitCode≠0。
 * 因为前者是「命令找不到」（基础设施异常），后者是「测试失败」（业务结果）。
 *
 * @param config TestRunnerConfig（来自 test.json 的 testRunner 字段）
 * @param workspacePath 工作区绝对路径，config.cwd/path 相对它解析
 */
export function runTestRunner(
  config: TestRunnerConfig,
  workspacePath: string,
): RunTestRunnerResult {
  let command: string;
  let cwd: string;

  if (config.mode === "custom") {
    if (!config.path) {
      throw new CwError(
        `testRunner custom 模式缺 path 字段（相对 workspacePath 的脚本路径）`,
      );
    }
    command = `bash ${config.path}`;
    cwd = workspacePath;
  } else {
    // nodejs / python / java
    if (!config.command) {
      throw new CwError(
        `testRunner ${config.mode} 模式缺 command 字段（测试执行命令）`,
      );
    }
    command = config.command;
    cwd = config.cwd ? join(workspacePath, config.cwd) : workspacePath;
  }

  try {
    const stdout = execFileSync(command, {
      cwd,
      encoding: "utf8",
      shell: true,
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (e) {
    // spawn 异常 / 命令不存在（exit 127）→ 抛 CwError（基础设施异常）。
    // shell 模式下命令找不到返回 exit 127（POSIX 约定），而非 ENOENT 异常。
    if (isENOENT(e) || getExitCode(e) === EXIT_COMMAND_NOT_FOUND) {
      throw new CwError(
        `测试命令执行失败（spawn error，命令不存在）：${command}`,
      );
    }
    // 执行失败（exit ≠ 0）——返回结构化结果，不抛错（业务结果）。
    const exitCode = getExitCode(e);
    const stdout = getStringField(e, "stdout");
    const stderr = getStringField(e, "stderr");
    return { exitCode: exitCode === -1 ? 1 : exitCode, stdout, stderr };
  }
}

/// 从 execFileSync 抛出的异常里安全取 stdout/stderr 字符串。
function getStringField(e: unknown, field: "stdout" | "stderr"): string {
  if (typeof e === "object" && e !== null && field in e) {
    const val = (e as Record<string, unknown>)[field];
    if (typeof val === "string") return val;
    if (Buffer.isBuffer(val)) return val.toString("utf8");
  }
  return "";
}

// ── devCheck（调 GitValidator.validate） ─────────────────────

/**
 * 从结构化 WaveChange[] 提取文件路径集合。
 * 取代旧版 extractFilesFromChanges（正则从自然语言提取）——changes 现在是结构化 {file, description}[]。
 */
export function extractFilesFromChanges(changes: { file: string }[]): Set<string> {
  const files = new Set<string>();
  for (const c of changes) {
    if (c.file) files.add(c.file);
  }
  return files;
}

/**
 * devCheck — 校验单个 commit 是否合法（存在 + 在 repo + 非空）。
 *
 * P1 补充：commit 校验通过后，用 git diff-tree 获取实际改动文件列表，
 * 与 topic.planData.waves 对应 wave 的 changes 对比，
 * 把不在 plan 里的额外文件写入 extraFiles（只警告不 fail）。
 *
 * progressive gate：每次 dev 提交一组 task，逐个校验。handler 汇总结果。
 * 不在这里做「全 wave committed」判定——那是 computeGatePassed 的职责（state-machine.ts）。
 *
 * @param waveId 当前 task 对应的 waveId，用于从 topic.waves 找对应 wave
 * @param topic Topic 对象（含 waves 和 planData），可选；缺省时跳过文件覆盖校验
 */
export function devCheck(
  validator: GitValidator,
  commitHash: string,
  waveId?: string,
  topic?: Topic,
): CommitValidation {
  const result = validator.validate(commitHash);

  // commit 校验不通过时直接返回，不做文件提取
  if (!result.valid) return result;

  // 提取 commit 实际改动文件列表（changedFiles），供持久化 + plan 覆盖校验复用。
  // 放在 waveId/topic 校验之前——即使缺 topic 也要拿到 changedFiles（评估指标需要）。
  let actualFiles: Set<string> | undefined;
  try {
    const diffOutput = execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", commitHash],
      { cwd: validator.workspacePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    actualFiles = new Set(
      diffOutput
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0),
    );
    result.changedFiles = Array.from(actualFiles);
  } catch (e) {
    // git 命令失败不阻塞 commit 校验，只跳过文件提取
    if (isENOENT(e)) throw e;
  }

  // P1: 文件覆盖校验（宽松模式，只警告不 fail）。需要 waveId + topic + actualFiles。
  if (!waveId || !topic || !actualFiles) return result;

  // 从 topic.waves 找对应 wave 的 changes
  const wave = topic.waves.find((w) => w.id === waveId);
  if (!wave) return result;

  // 提取 plan 中的文件路径
  const planFiles = extractFilesFromChanges(wave.changes);
  if (planFiles.size === 0) return result;

  // 找出不在 plan 中的额外文件
  const extra: string[] = [];
  for (const file of actualFiles) {
    if (!planFiles.has(file)) {
      extra.push(file);
    }
  }

  if (extra.length > 0) {
    result.extraFiles = extra;
  }

  return result;
}

// ── testCheck（judgeByExpected 机器重算） ────────────────────

export interface TestCheckResult {
  status: "passed" | "failed";
  reason: string;
}

/**
 * testCheck — 单个 testCase 的机器重算判定（strong-recompute，D-008）。
 *
 * 丢 claimedStatus：lite 单轨不信 agent 声明，用 judgeByExpected 按 expected.url/text
 * 精确匹配 actual。requiresScreenshot=true 时还校验 screenshotPath 存在。
 *
 * 砍掉旧版 mid 分支（信声明 + GitValidator 追溯 dev commit）——lite-only。
 *
 * expected 为空（无 url/text）的畸形数据：plan-parser schema 已要求 expected 至少一个字段
 * （typebox Optional 不强制非空，但 judgeByExpected 兜底返回 failed「no judgeable field」）。
 */
export function testCheck(
  testCase: TestCase,
  actual: Actual | undefined,
  screenshotPath: string | undefined,
): TestCheckResult {
  // requiresScreenshot 校验：plan 声明需要截图但未提供/文件不存在 → 直接 failed。
  if (testCase.requiresScreenshot) {
    if (!screenshotPath || !existsSync(screenshotPath)) {
      return {
        status: "failed",
        reason: `screenshot required by plan but missing (path=${screenshotPath ?? "undefined"})`,
      };
    }
  }

  // expected 为空的兜底防御（plan-parser schema 不强制 expected 非空字段，judgeByExpected 内部兜底）。
  const expected: Expected = testCase.expected ?? {};
  const verdict = judgeByExpected(expected, actual ?? {});
  return { status: verdict.status, reason: verdict.reason };
}

// ── fileExistsCheck（retrospect/closeout gate） ──────────────

export interface FileExistsResult {
  result: "pass" | "fail";
  report: string;
}

/**
 * fileExistsCheck — 文件存在 + 非空校验（retrospect/closeout gate）。
 *
 * 有意降级：旧版 check-closeout.ts 的 6 大类检查（ARCHIVED 溯源 / NFR 验证 / DESIGN-LOG 等）
 * 全部砍掉，本轮只验文件存在 + 非空。后续如需质量约束可再补。
 *
 * path 为空字符串 → fail（未提供路径）。
 */
export function fileExistsCheck(path: string): FileExistsResult {
  if (path.length === 0) {
    return { result: "fail", report: "path is empty" };
  }
  if (!existsSync(path)) {
    return { result: "fail", report: `file not found: ${path}` };
  }
  // 目录存在即 pass（closeout gate 校验 topicDir 目录就绪，目录无法 readFileSync）。
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return { result: "pass", report: "" };
  }
  const content = readFileSync(path, "utf8").trim();
  if (content.length === 0) {
    return { result: "fail", report: `file is empty: ${path}` };
  }
  return { result: "pass", report: "" };
}

// ── reviewIssueCheck（review issues schema 校验） ─────────────

export interface ReviewIssueCheckResult {
  result: "pass" | "fail";
  report: string;
  /** 校验通过的 issues（pass 时供 handler 写入 store） */
  parsed?: ReviewIssueSubmission[];
}

/** severity 合法枚举值集合（reviewIssueCheck 逐元素校验用）。 */
const REVIEW_SEVERITIES = new Set(["must-fix", "should-fix", "nit"]);

/** dimension 合法枚举值集合（reviewIssueCheck 逐元素校验用）。FR-3: 三阶段共用 12 个维度。 */
const REVIEW_DIMENSIONS = new Set<ReviewDimension>([
  "type-safety",
  "error-handling",
  "edge-case",
  "test-coverage",
  "plan-completeness",
  "design-consistency",
  "completeness",
  "consistency",
  "reasonableness",
  "coverage",
  "architecture",
  "feasibility",
]);

/**
 * reviewIssueCheck — review/spec_review/plan_review issues 的逐元素 schema 校验。
 *
 * FR-3 统一升级后三阶段共用此 check：
 *   - dimension 必填（不再可选，原 category 可选）——强制 agent 按维度归类发现
 *   - ref 泛化（原 file 限代码路径，现可为 spec 条目 ID 如 FR-3 / W2）
 *
 * 校验链：
 *   1. 必须是数组
 *   2. 每个元素必须有 dimension（枚举值，必填）
 *   3. severity（枚举值）+ description（非空字符串）
 *   4. ref 可选但提供时必须是字符串
 *
 * 与 planCheck/tddPlanCheck 的区别：reviewIssueCheck 不用 typebox（issues 结构简单，
 * 手写校验更直白），直接逐字段 typeof + 枚举检查。
 *
 * 失败路径：任何一条 issue 不合规 → fail + report 指明第几条、哪个字段。
 *
 * 背景修复：原先 cli.ts review case 只做 Array.isArray 弱校验，agent 传
 * `[{"foo":"bar"}]` 也能通过，导致 severity 为 undefined，buildNextAction 里的
 * `severity === "must-fix"` 永远 false，must-fix 被静默降级。
 */
export function reviewIssueCheck(raw: unknown): ReviewIssueCheckResult {
  if (!Array.isArray(raw)) {
    return { result: "fail", report: "issues 必须是 JSON 数组" };
  }

  const issues: ReviewIssueSubmission[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        result: "fail",
        report: `issues[${i}] 不是对象`,
      };
    }
    const obj = item as Record<string, unknown>;

    // dimension：必填，枚举校验（FR-3: 原 category 可选，现 dimension 必填）。
    if (!REVIEW_DIMENSIONS.has(obj.dimension as ReviewDimension)) {
      return {
        result: "fail",
        report: `issues[${i}].dimension 无效或缺失: ${JSON.stringify(obj.dimension)}`,
      };
    }

    // severity：枚举值校验（最关键字段，buildNextAction 用它判 must-fix）。
    if (!REVIEW_SEVERITIES.has(String(obj.severity))) {
      return {
        result: "fail",
        report: `issues[${i}].severity 无效: ${JSON.stringify(obj.severity)}`,
      };
    }

    // description：非空字符串（trim 后仍需有内容）。
    if (
      typeof obj.description !== "string" ||
      obj.description.trim().length === 0
    ) {
      return {
        result: "fail",
        report: `issues[${i}].description 缺失或为空`,
      };
    }

    // ref：可选，但提供时必须是字符串（原 file 逻辑改名，泛化为代码路径或 spec/plan 条目 ID）。
    if (obj.ref !== undefined && typeof obj.ref !== "string") {
      return { result: "fail", report: `issues[${i}].ref 必须是字符串` };
    }

    issues.push({
      dimension: obj.dimension as ReviewDimension,
      severity: obj.severity as ReviewIssueSubmission["severity"],
      description: obj.description,
      ...(obj.ref !== undefined ? { ref: obj.ref } : {}),
    });
  }

  return { result: "pass", report: "", parsed: issues };
}

// ── confirmClarifyCheck（FR-1: confirm gate 条件校验） ───────

export interface ConfirmClarifyCheckResult {
  result: "pass" | "fail";
  report: string;
}

/**
 * confirmClarifyCheck — FR-1: confirm_clarify 的 gate 条件。
 *
 * 条件：至少 1 条 status 为 resolved 或 skipped 的 clarifyRecord。
 * 空数组或全 pending → fail（防静默跳过 clarify）。
 *
 * 注意：这个 check 只验证"有记录"，不验证记录内容是否真实（CW 是 agent-agnostic 的，
 * 无法区分 agent 自填还是用户说的）。gate 的价值是强制 agent 至少停下来做一次显式确认。
 */
export function confirmClarifyCheck(topic: Topic): ConfirmClarifyCheckResult {
  const hasResolvedOrSkipped = topic.clarifyRecords.some(
    (c) => c.status === "resolved" || c.status === "skipped",
  );
  if (!hasResolvedOrSkipped) {
    return {
      result: "fail",
      report:
        "confirm_clarify 需要至少 1 条 resolved 或 skipped 的 clarifyRecord。" +
        "如果确认无需澄清，先提交一条 skipped 记录（cw clarify 带 status=skipped），再 confirm。",
    };
  }
  // FR-8: 必须先调过 gen-spec（artifacts.confirmSpec 存在）。
  // gen-spec 改为有写副作用——记 confirmSpec 到 artifacts。confirm gate 校验其存在性，
  // 堵住 agent 跳过 gen-spec 直接 confirm 的漏洞。
  const confirmSpec = topic.artifacts?.confirmSpec;
  if (!confirmSpec) {
    return {
      result: "fail",
      report:
        "confirm_clarify 前必须先调 cw(gen-spec) 生成确认文档并 open 给用户看。" +
        "当前 artifacts.confirmSpec 缺失（未调 gen-spec）。",
    };
  }
  return { result: "pass", report: "" };
}

// ── clarifyCheck（clarify gate，结构校验 + ADR projectPath 文件存在） ──

export interface ClarifyCheckResult {
  result: "pass" | "fail";
  report: string;
  /** 解析后的 clarify seeds（pass 时供 handler 写入 store） */
  parsed?: ParsedClarify[];
}

/**
 * clarifyCheck — clarifyJson 结构校验 + ADR projectPath 文件存在校验。
 *
 * 校验链：
 *   1. parseClarifyJson（size guard + typebox schema + extract）→ fail 时 report 带具体 schema 错误
 *   2. 对每条 parsed 中的 adr.projectPath（若存在）调 fileExistsCheck 校验文件存在
 *      ADR 要求是文件而非目录（与 fileExistsCheck 对目录放行不同），所以额外检查 isFile
 *
 * 失败路径：
 *   - parseClarifyJson throw（size/schema）→ fail
 *   - adr.projectPath 不存在/为目录/为空文件 → fail + report 指明哪条记录
 *
 * 与 planCheck/tddPlanCheck 的区别：clarifyCheck 是 progressive gate（status 不流转），
 * gate pass 只 append gateHistory(pass)，不 updateStatus。
 */
export function clarifyCheck(clarifyJson: unknown): ClarifyCheckResult {
  let parsed: ParsedClarify[];
  try {
    parsed = parseClarifyJson(clarifyJson);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: "fail", report: msg };
  }

  // 逐条校验 ADR projectPath（若存在）
  for (let i = 0; i < parsed.length; i++) {
    const adr = parsed[i].clarifySeed.adr;
    if (!adr || !adr.projectPath) continue;

    const path = adr.projectPath;
    if (path.length === 0) {
      return {
        result: "fail",
        report: `clarify[${i}].adr.projectPath 为空字符串`,
      };
    }
    if (!existsSync(path)) {
      return {
        result: "fail",
        report: `clarify[${i}].adr.projectPath 文件不存在: ${path}（先写 docs/adr/ 文件再提交）`,
      };
    }
    const stat = statSync(path);
    // ADR 必须是文件，不是目录（与 fileExistsCheck 对目录放行的行为不同）
    if (stat.isDirectory()) {
      return {
        result: "fail",
        report: `clarify[${i}].adr.projectPath 是目录而非文件: ${path}`,
      };
    }
    const content = readFileSync(path, "utf8").trim();
    if (content.length === 0) {
      return {
        result: "fail",
        report: `clarify[${i}].adr.projectPath 文件为空: ${path}`,
      };
    }
  }

  return { result: "pass", report: "", parsed };
}
