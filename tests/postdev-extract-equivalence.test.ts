/**
 * TddStrategy.postDevVerify 抽取等价性单测 —— topic 2: postDevVerify 抽取。
 *
 * 覆盖 AC：
 *   - AC-3: TddStrategy.postDevVerify 不再返回空数组（抽取 handleTest 内联逻辑后有真实实现）
 *   - AC-5: postDevVerify 返回的 VerifyResult 与 handleTest 内联执行+判定的语义等价
 *
 * 背景：topic 1 把 TddVerificationStrategy.postDevVerify 做成占位（返回 []），
 * 注释说「W4 抽取 handleTest 内联逻辑后补全」。本 topic 就是那个 W4——抽取后 postDevVerify
 * 应返回每个 testCase 的 { caseId, passed, actual, failureReason }。
 *
 * 这是 TDD 红灯阶段：当前 postDevVerify 仍返回 []（占位），这些断言必然 fail（红灯）。
 * 抽取实现由后续 subagent 完成（src/shapes/tdd-strategy.ts 的 postDevVerify 方法体）。
 *
 * 等价性策略：
 *   postDevVerify(topic) 内部应等价于 handleTest 事务内的「exit_zero/script 执行 +
 *   testCheck 判定」链路，返回每个 case 的 VerifyResult。对同一 topic 配置，
 *   postDevVerify 返回的 passed 应与「跑 testRunner + judgeByExpected(exitCode)」一致。
 *
 * 测试规范（AGENTS.md）：
 *   - 零 mock 框架：真实 tmp 目录 + 真实 shell 执行（true/false 命令）
 *   - exit_zero 用 testRunner.command="true"（恒 exit 0）/ "false"（恒 exit 1）
 *   - script 用真实可执行脚本文件（shebang + chmod）
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Topic, TestCase, TestRunnerConfig } from "../src/types.js";
import { getShape } from "../src/shapes/registry.js";

// ── 测试夹具 ────────────────────────────────────────────────

let tmpWorkspace: string;

beforeEach(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "cw-postdev-"));
});

afterEach(() => {
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topicId: "cw-postdev-test",
    slug: "postdev-test",
    objective: "test postDevVerify extraction",
    workspacePath: tmpWorkspace,
    topicDir: join(tmpWorkspace, ".xyz-harness", "postdev-test"),
    createdAt: "2026-07-17T00:00:00.000Z",
    status: "developed",
    taskShape: "full-tdd",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    clarifyRecords: [],
    specSections: [],
    specHistory: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    specReviewIssues: [],
    specReviewTurn: 0,
    planReviewIssues: [],
    planReviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
    ...overrides,
  } as Topic;
}

/** 构造一个 exit_zero testCase（CW 执行 testRunner.command 拿 exitCode 判定）。 */
function makeExitZeroCase(id: string): TestCase {
  return {
    id,
    layer: "mock",
    scenario: "exit_zero 场景",
    steps: "跑 testRunner.command 看 exitCode",
    expected: { type: "exit_zero" },
    executor: "shell",
    status: "pending",
    requiresScreenshot: false,
    dependsOn: [],
  } as TestCase;
}

/** 构造一个 script testCase（CW 直接执行 expected.path 脚本看 exitCode）。 */
function makeScriptCase(id: string, scriptPath: string): TestCase {
  return {
    id,
    layer: "mock",
    scenario: "script 场景",
    steps: "执行 expected.path 看 exitCode",
    expected: { type: "script", path: scriptPath },
    executor: "shell",
    status: "pending",
    requiresScreenshot: false,
    dependsOn: [],
  } as TestCase;
}

// ── AC-3: postDevVerify 不再返回空数组 ─────────────────────────

describe("TddStrategy.postDevVerify 抽取完成（AC-3：不再返回 []）", () => {
  it("exit_zero + true 命令 → 返回非空 VerifyResult[]，passed=true", () => {
    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [makeExitZeroCase("T1")],
      testRunner: { mode: "nodejs", command: "true" } as TestRunnerConfig,
    });

    const results = shape.verification.postDevVerify(topic);

    // AC-3 核心断言：不再是占位 []
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].caseId).toBe("T1");
    // true 命令恒 exit 0 → exit_zero 判定 passed
    expect(results[0].passed).toBe(true);
  });

  it("exit_zero + false 命令 → passed=false", () => {
    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [makeExitZeroCase("T1")],
      testRunner: { mode: "nodejs", command: "false" } as TestRunnerConfig,
    });

    const results = shape.verification.postDevVerify(topic);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].caseId).toBe("T1");
    // false 命令恒 exit 1 → exit_zero 判定 failed
    expect(results[0].passed).toBe(false);
    expect(results[0].failureReason).toBeDefined();
  });
});

// ── AC-5: postDevVerify 返回值与 handleTest 内联语义等价 ───────

describe("TddStrategy.postDevVerify 与 handleTest 等价性（AC-5）", () => {
  it("多 case 混合 exit_zero：共享一次 testRunner 执行，每个 case 同 exitCode", () => {
    // handleTest 去重执行：多个 exit_zero case 共享一次 testRunner 跑，归一化 exitCode。
    // postDevVerify 抽取后应保持同样的去重语义（同 command 跑一次）。
    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [makeExitZeroCase("T1"), makeExitZeroCase("T2")],
      testRunner: { mode: "nodejs", command: "true" } as TestRunnerConfig,
    });

    const results = shape.verification.postDevVerify(topic);

    expect(results).toHaveLength(2);
    // 两 case 都 passed（共享同一次 true 命令的 exit 0）
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(true);
    // caseId 各自锁定
    const ids = results.map((r) => r.caseId).sort();
    expect(ids).toEqual(["T1", "T2"]);
  });

  it("script case：执行真实脚本文件，exit 0 → passed", () => {
    // 写一个 exit 0 的真实脚本
    const scriptDir = join(tmpWorkspace, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "pass.sh");
    writeFileSync(scriptPath, "#!/bin/bash\nexit 0\n");
    chmodSync(scriptPath, 0o755);

    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [makeScriptCase("S1", "scripts/pass.sh")],
    });

    const results = shape.verification.postDevVerify(topic);

    expect(results).toHaveLength(1);
    expect(results[0].caseId).toBe("S1");
    expect(results[0].passed).toBe(true);
  });

  it("script case：exit 1 → passed=false", () => {
    const scriptDir = join(tmpWorkspace, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "fail.sh");
    writeFileSync(scriptPath, "#!/bin/bash\nexit 1\n");
    chmodSync(scriptPath, 0o755);

    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [makeScriptCase("S1", "scripts/fail.sh")],
    });

    const results = shape.verification.postDevVerify(topic);

    expect(results).toHaveLength(1);
    expect(results[0].caseId).toBe("S1");
    expect(results[0].passed).toBe(false);
  });

  it("VerifyResult.actual 含 exitCode（供 report 渲染 + actual 回填）", () => {
    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [makeExitZeroCase("T1")],
      testRunner: { mode: "nodejs", command: "true" } as TestRunnerConfig,
    });

    const results = shape.verification.postDevVerify(topic);

    expect(results[0].actual).toBeDefined();
    // actual 应含 exitCode 字段（exit_zero/script 模式的观测值）
    const actual = results[0].actual as { exitCode?: number };
    expect(actual.exitCode).toBe(0);
  });
});

// ── 边界：缺 testRunner / 空 testCases ────────────────────────

describe("TddStrategy.postDevVerify 边界", () => {
  it("空 testCases → 返回空数组（无 case 可验证）", () => {
    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [],
      testRunner: { mode: "nodejs", command: "true" } as TestRunnerConfig,
    });

    const results = shape.verification.postDevVerify(topic);
    // 空 testCases 返回空数组是合法的（无 case），但不应是「占位 []」——
    // 这里区分：抽取后的空数组是「跑了但没有 case」，占位是「根本没跑」。
    // 对空 testCases 两者都返回 []，所以这条测试在红灯/绿灯都 pass，不作为红灯锚点。
    expect(results).toEqual([]);
  });

  it("exit_zero case 缺 testRunner → passed=false + failureReason 含 testRunner", () => {
    const shape = getShape("full-tdd");
    const topic = makeTopic({
      testCases: [makeExitZeroCase("T1")],
      // 故意不设 testRunner
    });

    const results = shape.verification.postDevVerify(topic);

    expect(results).toHaveLength(1);
    expect(results[0].caseId).toBe("T1");
    // 缺 testRunner 是基础设施问题 → failed + reason 提示
    expect(results[0].passed).toBe(false);
    expect(results[0].failureReason).toContain("testRunner");
  });
});
