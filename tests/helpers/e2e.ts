/**
 * 共享 E2E 基建 —— runCli / parseStdout / createE2eEnv + 阶段推进 helper。
 *
 * 从 e2e.test.ts 提取，供 e2e-*.test.ts 系列文件复用。
 * 所有子进程跑真实 dist/cli.js（零 mock），每个 createE2eEnv 产出独立隔离环境。
 *
 * 阶段 helper 封装 create→plan→tdd_plan→dev→...→closeout 的样板，
 * 各 E2E 测试文件按需调到目标阶段后专注测自己的分支路径。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { setupGitRepo } from "./git.js";
import {
  makeValidClarifyJson,
  makeValidDevPlanJson,
  makeValidTestJson,
} from "./plan.js";

// ── 路径常量 ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const CLI_PATH = join(__dirname, "..", "..", "dist", "cli.js");

// ── 子进程辅助 ──────────────────────────────────────────────

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface E2eEnv {
  workspaceDir: string;
  cwHome: string;
  /** 传给子进程的环境变量（含 CW_HOME）。 */
  env: Record<string, string>;
  /** setupGitRepo 产出的初始 commit hash，供 dev --tasks 使用。 */
  commitHash: string;
}

/**
 * runCli — 真实子进程调 dist/cli.js。
 *
 * 接受 E2eEnv（而非裸 env），cwd 自动设为 env.workspaceDir。
 * 原因：CLI 默认 workspacePath=process.cwd()，子进程 cwd 必须等于 workspaceDir，
 * 否则 encodeCwd(workspaceDir) 与 db 落盘路径不一致，跨子命令读写错位。
 * options.cwd 可覆盖（少数场景如 list 不依赖 cwd）。
 */
export function runCli(
  args: string[],
  env: E2eEnv,
  options: { input?: string; cwd?: string } = {},
): CliResult {
  const mergedEnv = {
    ...process.env,
    ...env.env,
    PATH: process.env.PATH ?? "",
  };
  const result = spawnSync("node", [CLI_PATH, ...args], {
    env: mergedEnv as NodeJS.ProcessEnv,
    encoding: "utf8",
    cwd: options.cwd ?? env.workspaceDir,
    input: options.input,
    timeout: 30000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** 解析 CLI stdout 为 JSON，要求 exitCode=0 且 stdout 非空。 */
export function parseStdout(result: CliResult): Record<string, unknown> {
  expect(
    result.exitCode,
    `CLI exit code should be 0, stderr: ${result.stderr}`,
  ).toBe(0);
  const trimmed = result.stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

// ── 环境管理 ────────────────────────────────────────────────

/**
 * createE2eEnv — 创建独立隔离环境（独立 tmp workspace + CW_HOME + git repo）。
 *
 * 每个 describe 的 beforeAll 调一次，afterAll 调 disposeE2eEnv 清理。
 * 内部调 setupGitRepo 创建非空初始 commit（dev gate GitValidator 校验需要）。
 */
export function createE2eEnv(): E2eEnv {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`dist/cli.js 不存在，请先 npm run build。路径: ${CLI_PATH}`);
  }
  const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "cw-e2e-ws-")));
  const cwHome = realpathSync(mkdtempSync(join(tmpdir(), "cw-e2e-home-")));
  const env = { CW_HOME: cwHome };
  const commitHash = setupGitRepo(workspaceDir);
  return { workspaceDir, cwHome, env, commitHash };
}

/** disposeE2eEnv — 清理 tmp 目录。 */
export function disposeE2eEnv(e: E2eEnv): void {
  rmSync(e.workspaceDir, { recursive: true, force: true });
  rmSync(e.cwHome, { recursive: true, force: true });
}

// ── 阶段推进 helper ─────────────────────────────────────────
//
// 每个函数返回 topicId（及辅助信息），用 makeValid* 系列 helper 造合法输入。
// expected.text 与 makeValidTestJson 保持一致：E1="expected-output"，E2="real-output"。
// 这些 helper 只走 happy path（一次过），E2E 测试在此基础上测自己的分支。

/** create + plan + tdd_plan + dev（W1 committed）→ developed。 */
export function setupToDeveloped(
  e: E2eEnv,
  slug: string,
): { topicId: string; commitHash: string } {
  const topicId = createAndPlan(e, slug);
  runCli(["tdd_plan", "--topicId", topicId], e, {
    input: JSON.stringify(makeValidTestJson()),
  });
  runCli(
    ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash: e.commitHash }])],
    e,
  );
  return { topicId, commitHash: e.commitHash };
}

/** setupToDeveloped + review（无 issue 一次过）→ reviewed。需创建 review.md。 */
export function setupToReviewed(e: E2eEnv, slug: string): { topicId: string } {
  const { topicId } = setupToDeveloped(e, slug);
  writeReviewMd(e.workspaceDir, slug);
  runCli(
    ["review", "--topicId", topicId, "--reviewPath", reviewMdPath(e.workspaceDir, slug)],
    e,
  );
  return { topicId };
}

/** setupToReviewed + test（全 pass）→ tested。 */
export function setupToTested(e: E2eEnv, slug: string): { topicId: string } {
  const { topicId } = setupToReviewed(e, slug);
  runCli(
    [
      "test",
      "--topicId",
      topicId,
      "--cases",
      JSON.stringify([
        { caseId: "E1", actual: { text: "expected-output" } },
        { caseId: "E2", actual: { text: "real-output" } },
      ]),
    ],
    e,
  );
  return { topicId };
}

/** setupToTested + retrospect + closeout → closed。需创建 retrospect.md。 */
export function setupToClosed(e: E2eEnv, slug: string): { topicId: string; slug: string } {
  const { topicId } = setupToTested(e, slug);
  writeRetrospectMd(e.workspaceDir, slug);
  runCli(
    ["retrospect", "--topicId", topicId, "--retrospect-path", retrospectMdPath(e.workspaceDir, slug)],
    e,
    { input: JSON.stringify({ knownRisks: [], processIssues: [] }) },
  );
  runCli(["closeout", "--topicId", topicId], e);
  return { topicId, slug };
}

// ── 阶段 helper 内部工具 ────────────────────────────────────

/**
 * 从 created 推进到 clarify_confirmed（FR-1: plan 前必须 confirm_clarify）。
 *
 * 流程：clarify 提交一条带 answer 的最简记录（status=resolved）→ confirm_clarify。
 * 供 e2e-*.test.ts 里那些不关心 clarify 流程、只想走到 plan 阶段的测试复用。
 */
export function setupToClarifyConfirmed(e: E2eEnv, slug: string, topicId: string): void {
  runCli(["clarify", "--topicId", topicId], e, {
    input: JSON.stringify(makeValidClarifyJson({ answer: `${slug} 已澄清` })),
  });
  // FR-8: confirm 前必须调 gen-spec（confirm gate 校验 artifacts.confirmSpec 存在）
  runCli(["gen-spec", "--topicId", topicId], e);
  runCli(["confirm_clarify", "--topicId", topicId], e);
}

/**
 * 从 clarify_confirmed 推进到 spec_reviewed（FR-4: plan 前必须 spec_review）。
 *
 * 流程：创建 spec-review.md（fileExistsCheck 要求文件存在 + 非空）→ spec_review
 * 提交空 issues（无问题直接过）。供 e2e-*.test.ts 里那些不关心 spec_review 流程、
 * 只想走到 plan 阶段的测试复用。
 */
export function setupToSpecReviewed(e: E2eEnv, slug: string, topicId: string): void {
  setupToClarifyConfirmed(e, slug, topicId);
  writeSpecReviewMd(e.workspaceDir, slug);
  runCli(
    ["spec_review", "--topicId", topicId, "--specReviewPath", specReviewMdPath(e.workspaceDir, slug)],
    e,
  );
}

/**
 * 从 spec_reviewed 推进到 plan_reviewed（FR-5: tdd_plan 前必须 plan_review）。
 *
 * 流程：plan（提交 dev-plan.json）→ 创建 plan-review.md → plan_review 提交空 issues。
 * 供 e2e-*.test.ts 里那些不关心 plan_review 流程、只想走到 tdd_plan 阶段的测试复用。
 */
export function setupToPlanReviewed(e: E2eEnv, slug: string, topicId: string): void {
  setupToSpecReviewed(e, slug, topicId);
  runCli(["plan", "--topicId", topicId], e, {
    input: JSON.stringify(makeValidDevPlanJson()),
  });
  writePlanReviewMd(e.workspaceDir, slug);
  runCli(
    ["plan_review", "--topicId", topicId, "--planReviewPath", planReviewMdPath(e.workspaceDir, slug)],
    e,
  );
}

/**
 * create + 全链 setup（clarify → confirm → spec_review → plan → plan_review）→ plan_reviewed。
 *
 * 名字保留 createAndPlan（语义=「到 plan 完成可进 tdd_plan」），但内部走全链：
 * FR-4/FR-5 后 plan 的前置是 spec_reviewed，tdd_plan 的前置是 plan_reviewed。
 * 下游 helper（setupToDeveloped）调 tdd_plan 时前置已满足。
 */
function createAndPlan(e: E2eEnv, slug: string): string {
  const createResult = parseStdout(
    runCli(
      ["create", "--slug", slug, "--objective", `E2E ${slug}`, "--workspace", e.workspaceDir],
      e,
    ),
  );
  const topicId = createResult.topicId as string;
  // FR-4/FR-5: plan 前必须 spec_review，tdd_plan 前必须 plan_review。
  setupToPlanReviewed(e, slug, topicId);
  return topicId;
}

export function reviewMdPath(workspaceDir: string, slug: string): string {
  return join(workspaceDir, ".xyz-harness", slug, "changes", "review.md");
}

export function retrospectMdPath(workspaceDir: string, slug: string): string {
  return join(workspaceDir, ".xyz-harness", slug, "retrospect.md");
}

/** spec_review 阶段的审查报告路径（FR-4）。 */
export function specReviewMdPath(workspaceDir: string, slug: string): string {
  return join(workspaceDir, ".xyz-harness", slug, "spec-review.md");
}

/** plan_review 阶段的审查报告路径（FR-5）。 */
export function planReviewMdPath(workspaceDir: string, slug: string): string {
  return join(workspaceDir, ".xyz-harness", slug, "plan-review.md");
}

function writeReviewMd(workspaceDir: string, slug: string): void {
  const reviewPath = reviewMdPath(workspaceDir, slug);
  mkdirSync(dirname(reviewPath), { recursive: true });
  writeFileSync(reviewPath, "# Code Review\n\n审查通过");
}

export function writeSpecReviewMd(workspaceDir: string, slug: string): void {
  const specReviewPath = specReviewMdPath(workspaceDir, slug);
  mkdirSync(dirname(specReviewPath), { recursive: true });
  writeFileSync(specReviewPath, "# Spec Review\n\nspec 审查通过");
}

export function writePlanReviewMd(workspaceDir: string, slug: string): void {
  const planReviewPath = planReviewMdPath(workspaceDir, slug);
  mkdirSync(dirname(planReviewPath), { recursive: true });
  writeFileSync(planReviewPath, "# Plan Review\n\nplan 审查通过");
}

function writeRetrospectMd(workspaceDir: string, slug: string): void {
  const retroPath = retrospectMdPath(workspaceDir, slug);
  mkdirSync(dirname(retroPath), { recursive: true });
  writeFileSync(retroPath, "# Retrospect\n\n复盘内容");
}

// ── 便捷：构造 clarifyJson（复用 plan.ts 但默认 pending） ────

export { makeValidClarifyJson };
