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
import { join } from "node:path";

import { parseDevPlan, type ParsedTestJson,parseTestJson } from "./plan-parser.js";
import {
  type Actual,
  CwError,
  type Expected,
  judgeByExpected,
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
export function planCheck(planJson: unknown): PlanCheckResult {
  try {
    const parsed = parseDevPlan(planJson);

    // 校验 waves 非空（parseDevPlan schema 允许空数组，这里补一刀）。
    if (parsed.waves.length === 0) {
      return {
        result: "fail",
        report: "dev-plan waves 为空：至少需要 1 个 wave。",
      };
    }

    return { result: "pass", report: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: "fail", report: msg };
  }
}

// ── tddPlanCheck（调 parseTestJson，校验 testCases） ────────────

export interface TddPlanCheckResult {
  result: "pass" | "fail";
  report: string;
  /** 解析后的 testCases（pass 时供 handler 写入 store） */
  parsed?: ParsedTestJson;
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
 *
 * pass 时返回 parsed，供 handler 写入 store。fail 时 parsed 为 undefined。
 */
export function tddPlanCheck(testJson: unknown): TddPlanCheckResult {
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

  // P0: 检查模糊 expected 值
  const fuzzyIds: string[] = [];
  for (const tc of parsed.testCases) {
    if (tc.expected.text && FUZZY_EXPECTED_RE.test(tc.expected.text)) {
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

  return { result: "pass", report: "", parsed };
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
 *
 * spawn 异常（命令不存在、权限错误等基础设施问题）返回 redLight=false + reason，
 * 不抛错——交给上层判定（区分「测试通过了」和「测试根本跑不起来」）。
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
 * P1: 从 plan changes 描述中提取文件路径。
 * changes 格式如 "修改 src/store.ts 加 fileLock 方法"，
 * 用正则匹配 "修改/创建/删除/更新/新增/add/modify/create/delete/update + 路径.ext"。
 */
const PLAN_FILE_RE =
  /(?:修改|创建|删除|更新|新增|add|modify|create|delete|update)\s+([\w./-]+(?:\.\w+))/gi;

function extractFilesFromChanges(changes: string[]): Set<string> {
  const files = new Set<string>();
  for (const change of changes) {
    // 每次 exec 重置 lastIndex（g flag）
    PLAN_FILE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLAN_FILE_RE.exec(change)) !== null) {
      if (match[1]) files.add(match[1]);
    }
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

  // commit 校验不通过时直接返回，不做文件覆盖校验
  if (!result.valid) return result;

  // P1: 文件覆盖校验（宽松模式，只警告不 fail）
  if (!waveId || !topic) return result;

  try {
    // 获取该 commit 实际改动的文件列表
    const diffOutput = execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", commitHash],
      { cwd: validator.workspacePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const actualFiles = new Set(
      diffOutput
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0),
    );

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
  } catch (e) {
    // git 命令失败不阻塞 commit 校验，只跳过文件覆盖检查
    if (isENOENT(e)) throw e;
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
