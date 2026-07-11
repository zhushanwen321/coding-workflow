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

/**
 * planCheck — lite plan gate 的结构校验。
 *
 * 委托 parseLitePlan 做 format === "lite" + typebox schema 校验。
 * parseLitePlan throw → gate fail（report 含错误消息）；成功 → gate pass。
 *
 * 砍掉旧版 check_plan.py 的 6 章节齐全 / 覆盖率阈值 / E2E mock+real 双层 / 依赖无环 /
 * 并行组无冲突——这些质量约束交回 skill 文档管，engine 只做最基础结构校验。
 */
export function planCheck(planJson: unknown): PlanCheckResult {
  try {
    parseLitePlan(planJson);
    return { result: "pass", report: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: "fail", report: msg };
  }
}

// ── devCheck（调 GitValidator.validate） ─────────────────────

/**
 * devCheck — 校验单个 commit 是否合法（存在 + 在 repo + 非空）。
 *
 * progressive gate：每次 dev 提交一组 task，逐个校验。handler 汇总结果。
 * 不在这里做「全 wave committed」判定——那是 computeGatePassed 的职责（state-machine.ts）。
 */
export function devCheck(
  commitHash: string,
  workspacePath: string,
): CommitValidation {
  const validator = new GitValidator(workspacePath);
  return validator.validate(commitHash);
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
