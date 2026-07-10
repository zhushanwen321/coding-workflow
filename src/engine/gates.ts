/**
 * gates — gate 注册表 + 执行器 + check/git adapter（骨架 stub）。
 *
 * Level 1 接线：
 *   - GateRunner.runCheck → dispatch 到 check 函数表（真接线，tsc 验签名）
 *   - GitValidator.validate → execFileSync 真调 git（adapter 真引 SDK，Tier 2 证伪）
 *   - runGate → 循环调 checker（真接线）
 */

import { execFileSync } from "node:child_process";

import type { CwAction, CwTopic, GateTier, Tier } from "./types.js";

// ── Gate 注册表类型 ─────────────────────────────────────────

export type Checker = (ctx: GateContext) => CheckerResult;

export interface CheckerResult {
  name: string;
  passed: boolean;
  report?: string;
}

export interface GateRule {
  tier: Tier;
  phase: CwAction;
  checkers: Checker[];
  gateTier: GateTier;
  progressive?: boolean;
}

export interface GateContext {
  topic: CwTopic;
  topicDir: string;
  workspacePath: string;
  runner: GateRunner;
  git: GitValidator;
}

export interface GateResult {
  passed: boolean;
  gateTier: GateTier;
  reports: CheckerResult[];
}

// ── CheckOutput（单一来源在 checks/shared.ts，此处声明） ──

export interface CheckOutput {
  passed: boolean;
  report?: string;
  infraError?: string;
}

// ── Gate Runner ─────────────────────────────────────────────

/** check 函数类型签名。 */
type CheckFn = (topicDir: string) => CheckOutput;

/** check 函数 dispatch 表（key = 原 python 脚本名，value = TS check 函数）。 */
const CHECK_DISPATCH: Record<string, CheckFn> = {
  // check_clarity: runCheckClarity,
  // check_architecture: runCheckArchitecture,
  // ... 搬迁时填充
};

/**
 * GateRunner — check 函数 dispatch。
 *
 * Level 1 接线：runCheck 真从 dispatch 表取函数并调用，tsc 验 CheckFn 签名匹配。
 * infraError：未知 key → infraError；check 函数 throw → infraError。
 */
export class GateRunner {
  constructor(private _cwd: string) { void this._cwd; }

  runCheck(scriptPath: string, topicDir: string): CheckOutput {
    // 接线：dispatch 表查找 + 调用。
    const fn = CHECK_DISPATCH[scriptPath];
    if (!fn) {
      return {
        passed: false,
        infraError: `unknown check: ${scriptPath}（dispatch 表未注册）`,
      };
    }
    try {
      return fn(topicDir);
    } catch (e) {
      return {
        passed: false,
        infraError: `check crashed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

// ── GitValidator ────────────────────────────────────────────

export interface CommitValidation {
  commitHash: string;
  exists: boolean;
  inRepo: boolean;
  nonEmpty: boolean;
  valid: boolean;
  reason?: string;
}

/** git 可执行文件缺失判定（ENOENT = 基础设施异常，应 throw）。 */
function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    String((e as { code: unknown }).code) === "ENOENT"
  );
}

/**
 * GitValidator — git 三项校验（adapter 真引 SDK，Tier 2 证伪）。
 *
 * Level 1 接线：validate 真调 execFileSync（cat-file / diff-tree），
 * tsc 对 node:child_process 声明验签。SDK 没装 → cannot find module；签名变 → 类型错。
 *
 * 三项校验：
 *   1. cat-file -e：commit 对象存在于 object store
 *   2. inRepo 合并入 exists（ADR-029 修复）
 *   3. diff-tree --shortstat：非空 commit
 */
export class GitValidator {
  constructor(private workspacePath: string) {}

  validate(commitHash: string): CommitValidation {
    // 接线：先探 git repo（rev-parse），再三项校验。
    // 失败路径：not git repo → valid:false；cat-file 失败 → exists:false；empty → nonEmpty:false。

    // Step 0: 探测 git repo
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

    // Step 1: cat-file -e（commit 存在性）
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

    // Step 2: inRepo 合并入 exists（ADR-029 robustness #1）
    const inRepo = exists;

    // Step 3: diff-tree --shortstat（非空 commit）
    try {
      const stat = execFileSync("git", ["diff-tree", "--shortstat", "--root", commitHash], {
        cwd: this.workspacePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
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
   * 校验 commitHash 是否可追溯到任一给定的祖先 commit（mid test gate 用）。
   *
   * 接线：execFileSync("git", ["merge-base", "--is-ancestor", ancestor, commitHash])。
   */
  isAncestorOfAny(commitHash: string, ancestors: readonly string[]): boolean {
    if (ancestors.length === 0) return false;
    for (const ancestor of ancestors) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, commitHash], {
          cwd: this.workspacePath,
          encoding: "utf8",
          stdio: "ignore",
        });
        return true;
      } catch (e) {
        if (isENOENT(e)) throw e;
        // 非零退出 = ancestor 不是 commitHash 的祖先，试下一个
      }
    }
    return false;
  }
}

// ── Gate 执行器 ─────────────────────────────────────────────

/** GATE_REGISTRY 声明式数组（§5.2 的 11 行表 1:1 编码）。 */
export const GATE_REGISTRY: GateRule[] = [
  // lite
  { tier: "lite", phase: "plan", checkers: [], gateTier: "weak-structural" },
  { tier: "lite", phase: "dev", checkers: [], gateTier: "medium-git", progressive: true },
  { tier: "lite", phase: "test", checkers: [], gateTier: "strong-recompute", progressive: true },
  { tier: "lite", phase: "retrospect", checkers: [], gateTier: "weak-structural", progressive: true },
  { tier: "lite", phase: "closeout", checkers: [], gateTier: "weak-structural" },
  // mid
  { tier: "mid", phase: "clarify", checkers: [], gateTier: "weak-structural" },
  { tier: "mid", phase: "detail", checkers: [], gateTier: "weak-structural" },
  { tier: "mid", phase: "dev", checkers: [], gateTier: "medium-git", progressive: true },
  { tier: "mid", phase: "test", checkers: [], gateTier: "medium-coverage", progressive: true },
  { tier: "mid", phase: "retrospect", checkers: [], gateTier: "weak-structural", progressive: true },
  { tier: "mid", phase: "closeout", checkers: [], gateTier: "weak-structural" },
];

/** 查 registry 单条规则。 */
function findRule(tier: Tier, phase: CwAction): GateRule {
  const rule = GATE_REGISTRY.find((r) => r.tier === tier && r.phase === phase);
  if (!rule) {
    throw new Error(`no gate rule for tier=${tier} phase=${phase}`);
  }
  return rule;
}

/**
 * 通用 gate 执行器（single-shot 用）。
 *
 * Level 1 接线：循环调 checker 并收集结果。
 */
export function runGate(ctx: GateContext, tier: Tier, phase: CwAction): GateResult {
  const rule = findRule(tier, phase);
  const reports: CheckerResult[] = [];
  let allPassed = true;
  // 接线：循环调 checker，fail 不 short-路（全量报告）。
  for (const checker of rule.checkers) {
    const r = checker(ctx);
    reports.push(r);
    if (!r.passed) allPassed = false;
  }
  return { passed: allPassed, gateTier: rule.gateTier, reports };
}

/** progressive gate 透传 gateTier 到 gateHistory。 */
export function lookupGateTier(tier: Tier, phase: CwAction): GateTier {
  return findRule(tier, phase).gateTier;
}
