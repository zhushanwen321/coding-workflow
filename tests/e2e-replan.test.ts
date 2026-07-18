/**
 * e2e-replan 测试 — replan action 的 happy path + bug-hunt。
 *
 * 覆盖：
 *   happy path: replan 追加 wave → status 回退 planned, append-only 校验生效
 *   [BUG-HUNT B] replan --plan only 后重走 tdd_plan → 旧 failed case 卡死/消失
 *   [BUG-HUNT E] replan 后 reviewIssues 应清空（对照组，验证 resetReviewLoop 生效）
 *   [BUG-HUNT F] replan 篡改 failed case expected → 应被 append-only 拒绝（防作弊）
 *   [BUG-HUNT G] retrospect/closeout 后 replan 被 guard 拒——状态死锁
 *
 * 真实子进程跑 dist/cli.js，独立隔离环境。
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  makeValidClarifyJson,
  parseStdout,
  planReviewMdPath,
  runCli,
  setupToTested,
  specReviewMdPath,
  writePlanReviewMd,
  writeSpecReviewMd,
} from "./helpers/e2e.js";

let e: E2eEnv;

beforeAll(() => {
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
});

// ── 本地 plan/test 构造（适配 changes 新 schema：Array<{file,description}>）──
// 不用 helpers/plan.ts 的 makeValidDevPlanJson，因为 replan 的 append-only 校验要求
// replan 前后的 wave changes 完全一致，用共享 helper 会导致内容不一致触发 append-only 误拒。

function planWithWaves(waveIds: string[]): string {
  return JSON.stringify({
    format: "lite",
    objective: "replan test",
    waves: waveIds.map((id, i) => ({
      id,
      changes: [{ file: `src/file${i}.ts`, action: "create", description: `change for ${id}` }],
      dependsOn: i === 0 ? [] : [waveIds[i - 1]!],
    })),
  });
}

const localTestJson = JSON.stringify({
  testCases: [
    {
      id: "E1", layer: "mock", scenario: "s", steps: "st",
      expected: { type: "exact", text: "expected-output" },
      executor: "vitest", requiresScreenshot: false,
    },
    {
      id: "E2", layer: "real", scenario: "s", steps: "st",
      expected: { type: "exact", text: "real-output" },
      executor: "vitest", requiresScreenshot: false,
    },
  ],
  testRunner: { mode: "nodejs", command: "npx vitest run" },
});

/** 自包含版「走到 developed」——用本地 plan/test 构造，保证 replan 时 changes 一致。 */
function setupToDevelopedLocal(slug: string): string {
  const create = parseStdout(
    runCli(["create", "--slug", slug, "--objective", `replan ${slug}`, "--workspace", e.workspaceDir], e),
  );
  const topicId = create.topicId as string;
  // FR-1/FR-4/FR-5: plan 前必须 clarify → confirm → spec_review，tdd_plan 前必须 plan_review。
  // 直接用 store 推进等效的 CLI 链：clarify(ans) → gen-spec → confirm → spec_review → plan → plan_review。
  runCli(["clarify", "--topicId", topicId], e, {
    input: JSON.stringify(makeValidClarifyJson({ answer: `${slug} 已澄清` })),
  });
  runCli(["gen-spec", "--topicId", topicId, "--no-open"], e);
  runCli(["confirm_clarify", "--topicId", topicId], e);
  writeSpecReviewMd(e.workspaceDir, slug);
  runCli(
    ["spec_review", "--topicId", topicId, "--specReviewPath", specReviewMdPath(e.workspaceDir, slug)],
    e,
  );
  runCli(["plan", "--topicId", topicId], e, { input: planWithWaves(["W1"]) });
  writePlanReviewMd(e.workspaceDir, slug);
  runCli(
    ["plan_review", "--topicId", topicId, "--planReviewPath", planReviewMdPath(e.workspaceDir, slug)],
    e,
  );
  runCli(["tdd_plan", "--topicId", topicId], e, { input: localTestJson });
  runCli(["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash: e.commitHash }])], e);
  return topicId;
}

// ── happy path: replan 追加 wave ─────────────────────────────

describe("happy path: replan 追加 wave → status 回退 planned, append-only 生效", () => {
  it("replan 追加 W2（保留 W1）→ status=planned, W1 committed 保留", () => {
    const topicId = setupToDevelopedLocal("replan-happy");

    // replan：追加 W2（W1 内容不变满足 append-only）
    const replanResult = parseStdout(
      runCli(["replan", "--topicId", topicId, "--plan"], e, {
        input: planWithWaves(["W1", "W2"]),
      }),
    );
    expect(replanResult.status).toBe("planned");

    // status 看到 W1 + W2
    const statusResult = parseStdout(runCli(["status", "--topicId", topicId], e));
    const waves = statusResult.waves as Array<{ id: string; committed: boolean }>;
    const waveIds = waves.map((w) => w.id).sort();
    expect(waveIds).toEqual(["W1", "W2"]);
    const w1 = waves.find((w) => w.id === "W1");
    expect(w1!.committed).toBe(true); // W1 已 committed，保留

    // append-only 违规：删 W1 → 应被拒绝
    const deleteResult = runCli(["replan", "--topicId", topicId, "--plan"], e, {
      input: JSON.stringify({ format: "lite", objective: "删 W1", waves: [] }),
    });
    expect(deleteResult.exitCode).not.toBe(0);
    expect(deleteResult.stderr).toContain("wave_deleted_committed");
  });
});

// ── [BUG-HUNT B] replan --plan only 后 failed case 卡死 ───────
//
// replan 只提交 --plan（不提交 --test），重走 tdd_plan 复用旧 case id，
// insertTestCases 按 id 去重跳过 → 旧的 failed testCase 不会被重置为 pending。

describe("[BUG-HUNT] replan --plan only 后重走 tdd_plan → 旧 failed case 应重置", () => {
  it("replan 不带 --test + 重走 tdd_plan 复用旧 id → failed case 应重置为 pending", () => {
    const topicId = setupToDevelopedLocal("bh-replan-case");
    // review 无 issue 一次过
    const reviewPath = join(e.workspaceDir, ".xyz-harness", "bh-replan-case", "changes", "review.md");
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, "# Review\n\npass");
    runCli(["review", "--topicId", topicId, "--reviewPath", reviewPath], e);
    // test：E1 fail, E2 pass
    runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E1", actual: { text: "wrong" } },
        { caseId: "E2", actual: { text: "real-output" } },
      ])],
      e,
    );

    // replan 只改 plan（追加 W2），不带 --test
    parseStdout(
      runCli(["replan", "--topicId", topicId, "--plan"], e, {
        input: planWithWaves(["W1", "W2"]),
      }),
    );
    // FR-5: replan --plan 回退到 planned，重走 tdd_plan 前必须先过 plan_review。
    writePlanReviewMd(e.workspaceDir, "bh-replan-case");
    runCli(
      ["plan_review", "--topicId", topicId, "--planReviewPath", planReviewMdPath(e.workspaceDir, "bh-replan-case")],
      e,
    );

    // 重走 tdd_plan，复用旧 case id
    runCli(["tdd_plan", "--topicId", topicId], e, { input: localTestJson });

    // 期望：E1 应重置为 pending
    const status = parseStdout(runCli(["status", "--topicId", topicId], e));
    const testCases = status.testCases as Array<{ id: string; status: string }>;
    const e1 = testCases.find((c) => c.id === "E1");
    expect(e1, "replan + tdd_plan 后 E1 不应消失").toBeDefined();
    expect(
      e1!.status,
      "replan 后重走 tdd_plan，旧的 failed case 应重置为 pending。" +
        `实际 E1 status=${e1!.status}——如果仍为 failed，说明 insertTestCases 按 id 去重导致旧 case 卡死。`,
    ).toBe("pending");
  });
});

// ── [BUG-HUNT E] replan 后 reviewIssues 应清空（对照组）───────
//
// replan 应清空 reviewIssues（resetReviewLoop）。对照组验证此行为正确。

describe("[BUG-HUNT] replan 后 reviewIssues 应清空（对照组）", () => {
  it("replan 带 --test 后重走 → 再 review 发现 issue 时 id 从 R1 重新开始", () => {
    const topicId = setupToDevelopedLocal("bh-review-reset");

    // review 发现 issue（R1）
    parseStdout(
      runCli(["review", "--topicId", topicId], e, {
        input: JSON.stringify([{ dimension: "type-safety", severity: "must-fix", description: "issue1" }]),
      }),
    );

    // replan 带 --test
    const testFile = join(e.workspaceDir, "test.json");
    writeFileSync(testFile, localTestJson);
    parseStdout(
      runCli(["replan", "--topicId", topicId, "--plan", "--test", "--testJsonFile", testFile], e, {
        input: planWithWaves(["W1", "W2"]),
      }),
    );
    // FR-5: replan --plan 回退到 planned，重走 tdd_plan 前必须先过 plan_review。
    writePlanReviewMd(e.workspaceDir, "bh-review-reset");
    runCli(
      ["plan_review", "--topicId", topicId, "--planReviewPath", planReviewMdPath(e.workspaceDir, "bh-review-reset")],
      e,
    );

    // 重走 tdd_plan + dev（W2）
    runCli(["tdd_plan", "--topicId", topicId], e, { input: localTestJson });
    runCli(["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W2", commitHash: e.commitHash }])], e);

    // 再 review 发现 issue——reviewIssues 清空后 id 从 R1 重新开始
    const reviewResult = parseStdout(
      runCli(["review", "--topicId", topicId], e, {
        input: JSON.stringify([{ dimension: "type-safety", severity: "must-fix", description: "new issue" }]),
      }),
    );
    expect(reviewResult.status).toBe("reviewed");

    // review_fix 引用 R1——清空后重新分配的 R1 应 status=open
    const fixResult = runCli(["review_fix", "--topicId", topicId], e, {
      input: JSON.stringify([
        { issueId: "R1", commitHash: "abc1234", resolution: "fix new R1" },
      ]),
    });
    expect(
      fixResult.exitCode,
      "replan 后 reviewIssues 应清空，新 review 的 issue 应从 R1 重新分配。" +
        `实际 exitCode=${fixResult.exitCode}, stderr=${fixResult.stderr}——` +
        "如果失败，可能 reviewIssues 没清空（R1 是旧的已 fixed issue）。",
    ).toBe(0);
  });
});

// ── [BUG-HUNT F] replan 篡改 failed case expected——append-only 缺口 ─
//
// validateAppendOnly 只保护 status="passed" 的 testCase。
// failed 的 testCase 不在保护范围——agent 可「fail → replan --test 改 expected → pass」作弊。

describe("[BUG-HUNT] replan 篡改 failed case expected → 应被 append-only 拒绝", () => {
  it("test(E1 fail) → replan --test 改 E1.expected → 应被拒绝（防作弊）", () => {
    const topicId = setupToDevelopedLocal("bh-cheat-expected");
    const reviewPath = join(e.workspaceDir, ".xyz-harness", "bh-cheat-expected", "changes", "review.md");
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, "# Review\n\npass");
    runCli(["review", "--topicId", topicId, "--reviewPath", reviewPath], e);

    // test：E1 fail
    runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E1", actual: { text: "wrong" } },
        { caseId: "E2", actual: { text: "real-output" } },
      ])],
      e,
    );

    // 作弊：replan --test 把 E1.expected 改成 "wrong"（与 actual 匹配）
    const cheatedTestJson = JSON.stringify({
      testCases: [
        {
          id: "E1", layer: "mock", scenario: "s", steps: "st",
          expected: { type: "exact", text: "wrong" }, // ← 篡改：原来是 "expected-output"
          executor: "vitest", requiresScreenshot: false,
        },
        {
          id: "E2", layer: "real", scenario: "s", steps: "st",
          expected: { type: "exact", text: "real-output" },
          executor: "vitest", requiresScreenshot: false,
        },
      ],
      testRunner: { mode: "nodejs", command: "npx vitest run" },
    });
    const testFile = join(e.workspaceDir, "cheated-test.json");
    writeFileSync(testFile, cheatedTestJson);

    const replanResult = runCli(
      ["replan", "--topicId", topicId, "--plan", "--test", "--testJsonFile", testFile],
      e,
      { input: planWithWaves(["W1"]) },
    );

    expect(
      replanResult.exitCode,
      "replan 篡改 failed case 的 expected 应被 append-only 拒绝（防 agent 作弊）。" +
        `实际 exitCode=${replanResult.exitCode}——如果=0，说明 append-only 安全门有缺口，` +
        "允许「fail → 改 expected → pass」作弊路径。",
    ).not.toBe(0);
  });
});

// ── [BUG-HUNT G] retrospect/closeout 后 replan 死锁 ───────────
//
// test 连续 5 轮 fail 后强制推进 retrospect。retrospected 不在 replan.expectedStatuses 内。
// blind agent 调了 retrospect → status=retrospected → replan 被 guard 拒 → 无法回退修复。

describe("[BUG-HUNT] retrospect/closeout 后 replan 被 guard 拒——状态死锁", () => {
  it("retrospected 状态下调 replan → illegal_transition（熔断后无法回退）", () => {
    const { topicId } = setupToTested(e, "bh-deadlock");

    const retroPath = join(e.workspaceDir, ".xyz-harness", "bh-deadlock", "retrospect.md");
    mkdirSync(dirname(retroPath), { recursive: true });
    writeFileSync(retroPath, "# 复盘\n\ntest 始终失败");
    runCli(
      ["retrospect", "--topicId", topicId, "--retrospect-path", retroPath],
      e,
      { input: JSON.stringify({ knownRisks: ["test 无法 pass"], processIssues: [] }),
       cwd: e.workspaceDir },
    );

    // 确认 status 到了 retrospected
    const preStatus = parseStdout(runCli(["status", "--topicId", topicId], e));
    if (preStatus.status !== "retrospected") {
      // retrospect 没推进 status 本身是另一个问题，不在 G 的范围
      console.warn(`G1 前置：retrospect 未推进到 retrospected（实际=${preStatus.status}），跳过死锁验证`);
      return;
    }

    const replanResult = runCli(
      ["replan", "--topicId", topicId, "--plan"],
      e,
      { input: planWithWaves(["W1"]) },
    );
    // 记录死锁行为：retrospected 下 replan 被拒
    expect(replanResult.exitCode).not.toBe(0);
    expect(replanResult.stderr).toContain("illegal_transition");
  });
});

// ── --test only 不 reset review loop（P2-8：选择性 reset）─────
//
// replan --test（不改 plan）时代码没变，review 审查结论仍有效。
// reviewIssues 应保留，不触发 resetReviewLoop。

describe("--test only 不清空 reviewIssues（代码没变，审查结论有效）", () => {
  it("replan --test only → reviewIssues 保留，再 review 发现新 issue 时 id 从 R2 继续", () => {
    const topicId = setupToDevelopedLocal("p28-test-only-review");

    // review 发现 issue（R1）
    parseStdout(
      runCli(["review", "--topicId", topicId], e, {
        input: JSON.stringify([{ dimension: "type-safety", severity: "must-fix", description: "issue1" }]),
      }),
    );

    // replan 只 --test（不 --plan），代码没变
    const testFile = join(e.workspaceDir, "test.json");
    writeFileSync(testFile, localTestJson);
    parseStdout(
      runCli(["replan", "--topicId", topicId, "--test", "--testJsonFile", testFile], e),
    );

    // 重走 tdd_plan + dev（progressive，W1 已 committed）
    runCli(["tdd_plan", "--topicId", topicId], e, { input: localTestJson });
    runCli(["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash: e.commitHash }])], e);

    // 再 review 发现新 issue——reviewIssues 未清空，id 从 R2 继续（R1 仍存在）
    const reviewResult = parseStdout(
      runCli(["review", "--topicId", topicId], e, {
        input: JSON.stringify([{ dimension: "type-safety", severity: "must-fix", description: "new issue" }]),
      }),
    );
    expect(reviewResult.status).toBe("reviewed");

    // R1 仍存在（open），新 issue 是 R2——验证 reviewIssues 没被清空
    const fixR2 = runCli(["review_fix", "--topicId", topicId], e, {
      input: JSON.stringify([
        { issueId: "R2", commitHash: "abc1234", resolution: "fix R2" },
      ]),
    });
    expect(fixR2.exitCode).toBe(0);
  });
});

// ── exit_zero / script 模式 e2e 集成（topic: cw-2026-07-17-expected-multi-mode） ──
//
// 通过 cw CLI 子进程走完整流程（create → ... → test），验证多模式在端到端的
// 真实行为。expected-multi-mode.test.ts 走的是进程内 dispatch()（直调函数），
// 这里补的是「真实 CLI 子进程 + 进程间状态读写（JSON 落盘）」这一层——确保
// testRunner 配置、exit_zero 去重执行、script 路径解析在跨进程边界仍然成立。

describe("exit_zero / script 模式 e2e（cw CLI 子进程全流程）", () => {
  /** 自包含版「走到 reviewed」——本地 plan/test 构造，testCases 用 exit_zero/script 模式。 */
  function setupToReviewedLocal(slug: string, testJson: string): string {
    const create = parseStdout(
      runCli(["create", "--slug", slug, "--objective", `e2e ${slug}`, "--workspace", e.workspaceDir], e),
    );
    const topicId = create.topicId as string;
    runCli(["clarify", "--topicId", topicId], e, {
      input: JSON.stringify(makeValidClarifyJson({ answer: `${slug} 已澄清` })),
    });
    runCli(["gen-spec", "--topicId", topicId, "--no-open"], e);
    runCli(["confirm_clarify", "--topicId", topicId], e);
    writeSpecReviewMd(e.workspaceDir, slug);
    runCli(
      ["spec_review", "--topicId", topicId, "--specReviewPath", specReviewMdPath(e.workspaceDir, slug)],
      e,
    );
    runCli(["plan", "--topicId", topicId], e, { input: planWithWaves(["W1"]) });
    writePlanReviewMd(e.workspaceDir, slug);
    runCli(
      ["plan_review", "--topicId", topicId, "--planReviewPath", planReviewMdPath(e.workspaceDir, slug)],
      e,
    );
    runCli(["tdd_plan", "--topicId", topicId], e, { input: testJson });
    runCli(["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash: e.commitHash }])], e);
    const reviewPath = join(e.workspaceDir, ".xyz-harness", slug, "changes", "review.md");
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, "# Review\n\npass");
    runCli(["review", "--topicId", topicId, "--reviewPath", reviewPath], e);
    return topicId;
  }

  it("exit_zero e2e: cw test（actual 省略）→ CW 机器重算 testRunner exit 0 → 判定 passed", () => {
    // exit_zero 模式 agent 不提交 actual；CW 子进程执行 testRunner.command（exit 0）→ passed。
    const exitZeroTestJson = JSON.stringify({
      testCases: [
        {
          id: "E1", layer: "mock", scenario: "s", steps: "st",
          expected: { type: "exit_zero" },
          executor: "vitest", requiresScreenshot: false,
        },
        {
          id: "E2", layer: "real", scenario: "s", steps: "st",
          expected: { type: "exact", text: "real-output" },
          executor: "vitest", requiresScreenshot: false,
        },
      ],
      // exit 0 的 testRunner → exit_zero case 判 passed。红灯校验跳过（无 redCheck case）。
      testRunner: { mode: "nodejs", command: 'node -e "process.exit(0)"' },
    });
    const topicId = setupToReviewedLocal("e2e-exit-zero", exitZeroTestJson);

    // cw test：exit_zero case (E1) 不传 actual；exact case (E2) 传匹配的 actual。
    const testResult = parseStdout(
      runCli(
        ["test", "--topicId", topicId, "--cases", JSON.stringify([
          { caseId: "E1" }, // exit_zero 省略 actual（FR-2a）
          { caseId: "E2", actual: { text: "real-output" } },
        ])],
        e,
      ),
    );
    expect(testResult.gatePassed).toBeDefined();
    expect((testResult.gatePassed as Record<string, unknown>).test).toBe(true);

    // status 确认两 case 都 passed。
    const status = parseStdout(runCli(["status", "--topicId", topicId], e));
    const cases = status.testCases as Array<{ id: string; status: string }>;
    expect(cases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(cases.find((c) => c.id === "E2")!.status).toBe("passed");
  });

  it("exit_zero e2e: testRunner exit 1 → exit_zero case 判 failed", () => {
    const exitZeroFailTestJson = JSON.stringify({
      testCases: [
        {
          id: "E1", layer: "mock", scenario: "s", steps: "st",
          expected: { type: "exit_zero" },
          executor: "vitest", requiresScreenshot: false,
        },
        {
          id: "E2", layer: "real", scenario: "s", steps: "st",
          expected: { type: "exact", text: "real-output" },
          executor: "vitest", requiresScreenshot: false,
        },
      ],
      // exit 1 的 testRunner → exit_zero case 判 failed。
      testRunner: { mode: "nodejs", command: 'node -e "process.exit(1)"' },
    });
    const topicId = setupToReviewedLocal("e2e-exit-zero-fail", exitZeroFailTestJson);

    const testResult = parseStdout(
      runCli(
        ["test", "--topicId", topicId, "--cases", JSON.stringify([
          { caseId: "E1" },
          { caseId: "E2", actual: { text: "real-output" } },
        ])],
        e,
      ),
    );
    expect((testResult.gatePassed as Record<string, unknown>).test).toBe(false);
    const status = parseStdout(runCli(["status", "--topicId", topicId], e));
    const cases = status.testCases as Array<{ id: string; status: string }>;
    expect(cases.find((c) => c.id === "E1")!.status).toBe("failed");
  });

  it("script e2e: cw test（actual 省略）→ CW 执行 script.path exit 0 → passed", () => {
    // 在 workspace 下建一个 exit 0 的可执行脚本（带 shebang + 执行位）。
    const scriptRel = join(".cw", "check.sh");
    const scriptAbs = join(e.workspaceDir, scriptRel);
    mkdirSync(dirname(scriptAbs), { recursive: true });
    writeFileSync(scriptAbs, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(scriptAbs, 0o755);

    const scriptTestJson = JSON.stringify({
      testCases: [
        {
          id: "E1", layer: "mock", scenario: "s", steps: "st",
          expected: { type: "script", path: scriptRel },
          executor: "vitest", requiresScreenshot: false,
        },
        {
          id: "E2", layer: "real", scenario: "s", steps: "st",
          expected: { type: "exact", text: "real-output" },
          executor: "vitest", requiresScreenshot: false,
        },
      ],
      testRunner: { mode: "nodejs", command: "npx vitest run" },
    });
    const topicId = setupToReviewedLocal("e2e-script", scriptTestJson);

    // cw test：script case (E1) 不传 actual；CW 子进程 resolve workspace + 执行脚本。
    const testResult = parseStdout(
      runCli(
        ["test", "--topicId", topicId, "--cases", JSON.stringify([
          { caseId: "E1" }, // script 省略 actual（AC-9）
          { caseId: "E2", actual: { text: "real-output" } },
        ])],
        e,
      ),
    );
    expect((testResult.gatePassed as Record<string, unknown>).test).toBe(true);
    const status = parseStdout(runCli(["status", "--topicId", topicId], e));
    const cases = status.testCases as Array<{ id: string; status: string }>;
    expect(cases.find((c) => c.id === "E1")!.status).toBe("passed");
  });
});
