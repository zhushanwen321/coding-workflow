/**
 * e2e-delete-only 测试 — AC-6 delete-only shape 完整 CW 流程。
 *
 * 覆盖 AC：
 *   - AC-6: delete-only topic 走完整流程（create→tdd_plan(existence.json)→dev→test→closeout），
 *     test 阶段 postDevVerify 跑文件存在性检查 → existenceArtifacts.verified 缓存 →
 *     isDevVerified=true → status=post_dev_verified → closeout → coverage=1.0
 *
 * 这是 TDD 红灯阶段：
 *   - create 命令没有 --taskShape flag（cli.ts 未解析），需手动在 _cw.json 注入 taskShape='delete-only'
 *   - delete-only shape / existence 策略 / existenceArtifacts 字段 / tdd_plan 对 existence.json
 *     的路由都尚未实现，整套流程必然在某个阶段崩（红灯）
 *
 * 实现由后续 subagent 完成。这里先把完整流程的「期望行为」锁住——实现完成后转绿。
 *
 * 流程说明（delete-only 专属）：
 *   1. create topic（默认 full-tdd，然后磁盘注入改成 delete-only）
 *   2. 走 clarify → confirm → spec_review → plan → plan_review（复用 e2e helper，状态推进）
 *   3. tdd_plan 提交 existence.json（而非 test.json）—— existence 策略的 preDevCheck 校验
 *   4. dev：删除目标文件 + commit
 *   5. review：提交空 issue（lean-review，单阶段 review）
 *   6. test：postDevVerify 跑 existsSync 验证文件已删 → existenceArtifacts.verified=true → post_dev_verified
 *   7. retrospect → closeout
 *
 * 测试规范（AGENTS.md）：真实子进程跑 dist/cli.js，独立隔离环境，零 mock。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveDbPath } from "../src/cli.js";
import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  parseStdout,
  reviewMdPath,
  runCli,
  setupToPlanReviewed,
} from "./helpers/e2e.js";

let e: E2eEnv;

beforeAll(() => {
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
});

/**
 * 在 _cw.json 里把 topic 的 taskShape 改成 delete-only。
 *
 * 背景：cli.ts 的 create 命令尚未解析 --taskShape flag（本 topic FR 才会加），
 * 所以 create 后默认是 full-tdd。测试在这里手动注入 delete-only 模拟
 * 「create 时传了 --taskShape delete-only」的效果。
 *
 * 注入点：create 之后、tdd_plan 之前——tdd_plan 的 preDevCheck 路由
 * 通过 getShape(topic.taskShape) 分流到 existence 策略。
 */
function injectTaskShape(topicId: string, taskShape: string): void {
  const dbPath = resolveDbPath(e.workspaceDir, e.cwHome);
  const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
    topics: Array<Record<string, unknown>>;
  };
  const t = raw.topics.find((x) => x.topicId === topicId);
  expect(t, `topic ${topicId} 应存在于 _cw.json`).toBeDefined();
  t!.taskShape = taskShape;
  writeFileSync(dbPath, JSON.stringify(raw));
}

/**
 * create + 全链 setup（clarify → confirm → spec_review → plan → plan_review）→ plan_reviewed，
 * 然后注入 delete-only taskShape。
 *
 * 复用 setupToPlanReviewed 但需要 topicId，所以手动展开 createAndPlan 的等价流程。
 */
function setupToDeleteOnlyPlanReviewed(slug: string): string {
  // 1. create
  const createResult = parseStdout(
    runCli(
      ["create", "--slug", slug, "--objective", `E2E delete-only ${slug}`, "--workspace", e.workspaceDir],
      e,
    ),
  );
  const topicId = createResult.topicId as string;

  // 2. 走到 plan_reviewed（复用 helper：clarify → confirm → spec_review → plan → plan_review）
  setupToPlanReviewed(e, slug, topicId);

  // 3. 注入 delete-only taskShape（create 命令没 --taskShape flag，磁盘注入模拟）
  injectTaskShape(topicId, "delete-only");

  return topicId;
}

/** existence.json 合法 payload（artifacts 声明待删文件 expectedState=absent）。 */
function makeExistenceJson(pathToFile: string): Record<string, unknown> {
  return {
    artifacts: [{ path: pathToFile, expectedState: "absent" }],
  };
}

// ── AC-6: delete-only 完整流程 e2e ────────────────────────────

describe("AC-6: delete-only shape 完整流程 e2e", () => {
  it("create→tdd_plan(existence.json)→dev→test→post_dev_verified，文件删除后 verified", () => {
    // ── 准备：在 workspace 建一个待删文件 + 一个 plan wave 声明 delete ──
    // 目标文件：src/legacy-feature.ts（待删除）
    const targetFile = "src/legacy-feature.ts";
    const targetAbs = join(e.workspaceDir, targetFile);
    mkdirSync(join(e.workspaceDir, "src"), { recursive: true });
    writeFileSync(targetAbs, "export const legacy = 'to be deleted';\n");

    // ── 1. create + 走到 plan_reviewed + 注入 delete-only ──
    const topicId = setupToDeleteOnlyPlanReviewed("ac6-delete-only");

    // ── 2. tdd_plan 提交 existence.json（而非 test.json）──
    // existence 策略的 preDevCheck 应校验 existence.json 结构。
    // 红灯阶段：tdd_plan 仍走 full-tdd 的 tddPlanCheck（test.json schema），
    // 对 existence.json payload 会 fail——这正是要实现的 existence 路由。
    const tddPlanResult = parseStdout(
      runCli(["tdd_plan", "--topicId", topicId], e, {
        input: JSON.stringify(makeExistenceJson(targetFile)),
      }),
    );

    // tdd_plan gate 通过 → status 流转到 pre_dev_verified
    expect(tddPlanResult.status).toBe("pre_dev_verified");
    expect((tddPlanResult.gatePassed as Record<string, unknown>).tdd_plan).toBe(true);

    // ── 3. dev：删除目标文件 + commit ──
    // 先在 git 里删文件并 commit
    const devCommit = commitFileDeletion(e, targetFile);
    runCli(
      ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash: devCommit }])],
      e,
    );

    // ── 4. review：提交空 issue（lean-review 单阶段）──
    // 建 review.md（fileExistsCheck 要求文件存在 + 非空）
    const slug = "ac6-delete-only";
    mkdirSync(join(dirname(reviewMdPath(e.workspaceDir, slug))), { recursive: true });
    writeFileSync(reviewMdPath(e.workspaceDir, slug), "# Review\n\n删除已验证");
    const reviewResult = parseStdout(
      runCli(
        ["review", "--topicId", topicId, "--reviewPath", reviewMdPath(e.workspaceDir, slug), "--issues", "[]"],
        e,
      ),
    );
    expect(reviewResult.status).toBe("reviewed");

    // ── 5. test：postDevVerify 验证文件已删 → existenceArtifacts.verified=true → post_dev_verified ──
    // delete-only 的 test 不传 --cases（existence 策略的 postDevVerify 跑 existsSync，
    // 不依赖 agent 提交的 actual）。但 CLI test 命令可能仍要求 --cases——
    // 实现层需适配（existence 策略 caseId 语义是 artifact.path）。
    // 红灯阶段：test 仍走 full-tdd 逻辑，会因 testCases 为空或 cases 不匹配 fail。
    const testResult = runCli(
      ["test", "--topicId", topicId],
      e,
    );
    expect(
      testResult.exitCode,
      `test 应 exit=0（postDevVerify 验证文件已删），实际 exit=${testResult.exitCode}, stderr: ${testResult.stderr}`,
    ).toBe(0);

    const testParsed = parseStdout(testResult);
    expect(testParsed.status).toBe("post_dev_verified");
    expect((testParsed.gatePassed as Record<string, unknown>).test).toBe(true);
  });

  it("完整流程到 closeout，coverage=1.0（全 existenceArtifacts verified）", () => {
    // 这个测试跑完整流程到 closeout，验证 delete-only 也能正常交付。
    // 与上一个测试的区别：上一个聚焦 test 阶段 verified，这个验证 closeout 的 coverage 计算。
    const targetFile = "src/obsolete.ts";
    const targetAbs = join(e.workspaceDir, targetFile);
    mkdirSync(join(e.workspaceDir, "src"), { recursive: true });
    writeFileSync(targetAbs, "export const obsolete = true;\n");

    const topicId = setupToDeleteOnlyPlanReviewed("ac6-closeout");
    const slug = "ac6-closeout";

    // tdd_plan
    parseStdout(
      runCli(["tdd_plan", "--topicId", topicId], e, {
        input: JSON.stringify(makeExistenceJson(targetFile)),
      }),
    );

    // dev 删文件
    const devCommit = commitFileDeletion(e, targetFile);
    runCli(
      ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash: devCommit }])],
      e,
    );

    // review
    mkdirSync(dirname(reviewMdPath(e.workspaceDir, slug)), { recursive: true });
    writeFileSync(reviewMdPath(e.workspaceDir, slug), "# Review\n\nok");
    runCli(
      ["review", "--topicId", topicId, "--reviewPath", reviewMdPath(e.workspaceDir, slug), "--issues", "[]"],
      e,
    );

    // test
    const testResult = runCli(["test", "--topicId", topicId], e);
    expect(testResult.exitCode, `test stderr: ${testResult.stderr}`).toBe(0);

    // retrospect
    const retroPath = join(e.workspaceDir, ".xyz-harness", slug, "retrospect.md");
    mkdirSync(dirname(retroPath), { recursive: true });
    writeFileSync(retroPath, "# Retrospect\n\n删除任务完成");
    runCli(
      ["retrospect", "--topicId", topicId, "--retrospect-path", retroPath],
      e,
      { input: JSON.stringify({ knownRisks: [], processIssues: [] }) },
    );

    // closeout
    const closeoutResult = parseStdout(runCli(["closeout", "--topicId", topicId], e));
    expect(closeoutResult.status).toBe("closed");

    // coverage 应为 1.0（全 existenceArtifacts verified = 100% 覆盖）
    const evidence = closeoutResult.evidence as { coverage?: number } | undefined;
    expect(evidence).toBeDefined();
    expect(evidence!.coverage).toBe(1.0);
  });
});

// ── AC-6 边界：文件未删干净 → test gate fail ──────────────────

describe("AC-6 边界：dev 未删干净 → test gate fail", () => {
  it("dev 没删目标文件 → test 阶段 postDevVerify 判 passed=false → status 仍 developed/reviewed", () => {
    const targetFile = "src/not-deleted.ts";
    const targetAbs = join(e.workspaceDir, targetFile);
    mkdirSync(join(e.workspaceDir, "src"), { recursive: true });
    writeFileSync(targetAbs, "export const stillHere = true;\n");

    const topicId = setupToDeleteOnlyPlanReviewed("ac6-not-deleted");
    const slug = "ac6-not-deleted";

    // tdd_plan 声明该文件 expectedState=absent
    parseStdout(
      runCli(["tdd_plan", "--topicId", topicId], e, {
        input: JSON.stringify(makeExistenceJson(targetFile)),
      }),
    );

    // dev：做一个空 commit（没真删文件）——用 git commit --allow-empty 模拟
    const emptyCommit = commitEmpty(e, "W1 empty dev");
    runCli(
      ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash: emptyCommit }])],
      e,
    );

    // review
    mkdirSync(dirname(reviewMdPath(e.workspaceDir, slug)), { recursive: true });
    writeFileSync(reviewMdPath(e.workspaceDir, slug), "# Review\n\nok");
    runCli(
      ["review", "--topicId", topicId, "--reviewPath", reviewMdPath(e.workspaceDir, slug), "--issues", "[]"],
      e,
    );

    // test：文件仍存在 → postDevVerify 判 absent 失败 → gatePassed.test=false。
    // 注：status 仍流转到 post_dev_verified（progressive 语义——status=post_dev_verified 只表示 test 命令已调，
    // 不表示全 pass；是否真通过看 gatePassed.test）。这与 full-tdd 一致：测试 case 失败时
    // status=post_dev_verified + gatePassed.test=false，retrospect 的 testTurn 逃生阀或 test_fix 才闭环。
    const testResult = parseStdout(runCli(["test", "--topicId", topicId], e));

    // 文件没删 → existenceArtifacts.verified 不会全 true → isDevVerified=false
    // → gatePassed.test=false（test gate 未通过）
    expect((testResult.gatePassed as Record<string, unknown>).test).not.toBe(true);

    // 补充断言：caseResults 里应能看到 absent 判失败（passed=false），
    // 证明 postDevVerify 确实跑了 existsSync 且文件仍存在被判失败。
    const caseResults = testResult.caseResults as Array<{ caseId: string; status: string }>;
    expect(caseResults).toHaveLength(1);
    expect(caseResults[0].status).toBe("failed");
  });
});

// ── 辅助：git 子进程封装（在 e.workspaceDir 跑） ──────────────

/** 在 workspace 删除 targetFile 并 commit，返回 commit hash。 */
function commitFileDeletion(env: E2eEnv, targetFile: string): string {
  // git rm 要求文件已被 git 追踪。测试创建的 targetFile 在初始 commit 之后写入、
  // 尚未 git add，git rm 会失败（untracked）。先 git add + commit 让文件进版本库，
  // 再 git rm 删除并 commit，模拟「先有文件 → dev 阶段删除」的真实场景。
  spawnSync("git", ["add", targetFile], {
    cwd: env.workspaceDir,
    encoding: "utf8",
  });
  spawnSync("git", ["commit", "-m", `chore: add ${targetFile}`], {
    cwd: env.workspaceDir,
    encoding: "utf8",
  });
  // 确认文件已被追踪后再 git rm（删除工作区文件 + 暂存删除）
  spawnSync("git", ["rm", targetFile], {
    cwd: env.workspaceDir,
    encoding: "utf8",
  });
  spawnSync("git", ["commit", "-m", `chore: delete ${targetFile}`], {
    cwd: env.workspaceDir,
    encoding: "utf8",
  });
  const hash = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: env.workspaceDir,
    encoding: "utf8",
  }).stdout.trim();
  return hash;
}

/** 在 workspace 做一个「不改 targetFile」的 commit（模拟 dev 没删目标文件）。
 *
 * 不用 git commit --allow-empty：devCheck 的 GitValidator.validate 会判 empty commit 为
 * nonEmpty=false → valid=false → wave 不 committed → dev gate 不过 → review 前置失败。
 * 改为提交一个无关的 marker 文件（.cw-dev-noop），让 commit 非空通过 devCheck，
 * 但 targetFile 保持不变（仍在工作区）——existence 的 postDevVerify 会判 absent 失败。
 */
function commitEmpty(env: E2eEnv, message: string): string {
  const markerPath = join(env.workspaceDir, ".cw-dev-noop");
  writeFileSync(markerPath, `dev noop: ${message}\n`);
  spawnSync("git", ["add", ".cw-dev-noop"], {
    cwd: env.workspaceDir,
    encoding: "utf8",
  });
  spawnSync("git", ["commit", "-m", message], {
    cwd: env.workspaceDir,
    encoding: "utf8",
  });
  return spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: env.workspaceDir,
    encoding: "utf8",
  }).stdout.trim();
}
