/**
 * gate — 极简 gate 检查 + GitValidator（lite 单轨极简版）。
 *
 * 与旧版的差异（重构 = 推倒重建）：
 * - 砍掉 GateRegistry 声明表 + GateRunner dispatch 表（旧版 gates.ts 的 8 check 脚本 dispatch）
 * - 砍掉 GateTier 分档强度（gateHistory 不再记 tier 字段，types 已砍）
 * - 砍掉 runGate 通用执行器——4 个具名 check 函数内联各 phase 的校验逻辑
 * - 保留 GitValidator（validate + isAncestorOfAny），从旧 gates.ts 1:1 移植
 * - 保留 judgeByExpected（已在 types.ts，testCheck 调用）
 *
 * engine 职责边界（选项 A）：只做最基础结构校验，质量约束交回 skill 文档管。
 *   - planCheck：format === "lite" + waves ≥ 1 + testCases ≥ 1（typebox schema，不读 plan.md）
 *   - devCheck：commit 存在 + 非空（GitValidator.validate）
 *   - testCheck：judgeByExpected 机器重算（丢 claimedStatus，D-008）
 *   - fileExistsCheck：文件存在 + 非空（retrospect/closeout gate）
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

import { parseLitePlan } from "./plan-parser.js";
import {
  type Actual,
  type Expected,
  type TestCase,
  type Topic,
  judgeByExpected,
} from "./types.js";

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
  constructor(private workspacePath: string) {}

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

  /**
   * 判断 commitHash 是否是 candidates 中任一 commit 的后代（即 candidate 是 commitHash 的祖先）。
   *
   * 用途：replan 时无（lite 单轨砍掉了 mid test gate 的 commitHash 追溯），
   * 但保留方法供未来扩展或外部调用。语义：commitHash 可追溯到任一 candidate ancestor。
   *
   * 接线：git merge-base --is-ancestor <ancestor> <commitHash>，退出码 0 = 是祖先。
   */
  isAncestorOfAny(
    commitHash: string,
    candidates: readonly string[],
  ): boolean {
    if (candidates.length === 0) return false;
    for (const ancestor of candidates) {
      try {
        execFileSync(
          "git",
          ["merge-base", "--is-ancestor", ancestor, commitHash],
          {
            cwd: this.workspacePath,
            encoding: "utf8",
            stdio: "ignore",
          },
        );
        return true;
      } catch (e) {
        if (isENOENT(e)) throw e;
        // 非零退出 = ancestor 不是 commitHash 的祖先，试下一个
      }
    }
    return false;
  }
}

// ── planCheck（调 parseLitePlan，返回结构化报告） ─────────────

export interface PlanCheckResult {
  result: "pass" | "fail";
  report: string;
}

/// P0: 模糊 expected 值正则（不区分大小写，全词匹配）。
/// 匹配这些值的 expected.text 表示 agent 未真正跑测试，只填了结论词。
const FUZZY_EXPECTED_RE =
  /^(passed|ok|success|fail|failed|true|false|yes|no|done|completed|正确|错误|成功|失败)$/i;

/**
 * planCheck — lite plan gate 的结构校验 + 模糊 expected 值检测。
 *
 * 委托 parseLitePlan 做 format === "lite" + typebox schema 校验。
 * P0 补充：schema 通过后，遍历 testCases 的 expected.text，
 * 若匹配模糊结论词（passed/ok/success 等）则 gate fail。
 * 目的：防 agent 填 expected.text="passed" 然后 actual.text="passed" 跳过真实测试。
 */
export function planCheck(planJson: unknown): PlanCheckResult {
  try {
    const parsed = parseLitePlan(planJson);

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

    return { result: "pass", report: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: "fail", report: msg };
  }
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
  commitHash: string,
  workspacePath: string,
  waveId?: string,
  topic?: Topic,
): CommitValidation {
  const validator = new GitValidator(workspacePath);
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
      { cwd: workspacePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
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
