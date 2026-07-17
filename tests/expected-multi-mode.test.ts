/**
 * expected 多模式判定 — TDD 红灯测试（topicId: cw-2026-07-17-expected-multi-mode）。
 *
 * 验证 expected 字段从 {url?,text?} 扩展为判别联合
 *   {type:'exact',url?,text?} | {type:'exit_zero'} | {type:'script',path}
 * 后的全部 AC（AC-1 ~ AC-10，见 topic specSections）。
 *
 * 红灯原因：当前 src/types.ts 的 Expected 仍是旧 {url?,text?}，不认 type 字段；
 * judgeByExpected / testCheck / tddPlanCheck / handleTest / validateAppendOnly
 * 均未实现新 type 分支。这些测试断言新分支的行为，现在必然 fail。
 * W1 dev 阶段实现 Expected 判别联合后，测试转绿，并移除临时类型断言 helper。
 *
 * 测试规范（AGENTS.md）：
 *   - 零 mock 框架：真实 CwStore + tmp 目录 + 真实 git 子进程
 *   - 禁 any：用 unknown 中转；Expected 判别联合已成立，直接用字面量（type 字段）
 *
 * 三层覆盖：
 *   - 纯函数（judgeByExpected / testCheck）：AC-1 / AC-2 判定 / AC-3 判定 / AC-8
 *   - gate 层（tddPlanCheck）：AC-4a / AC-5 / AC-7
 *   - dispatch 层（handleTest / replan）：AC-2 执行 / AC-3 执行 / AC-6 / AC-9 / AC-10
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import { GitValidator, tddPlanCheck } from "../src/gate.js";
import { CwStore } from "../src/store.js";
import { type Actual, type Expected, judgeByExpected } from "../src/types.js";
import { setupGitRepo } from "./helpers/git.js";

// ── dispatch 测试基建（与 dispatch.test.ts 同构，零 mock） ──────

let tmpDir: string;
let dbPath: string;
let realCommitHash: string;

function makeDeps(): { deps: { store: CwStore; git: GitValidator; workspacePath: string }; store: CwStore } {
  const store = new CwStore(dbPath);
  const git = new GitValidator(tmpDir);
  return { deps: { store, git, workspacePath: tmpDir }, store };
}

function confirmClarify(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "clarify_confirmed");
  store.updateGatePassed(topicId, "confirm_clarify", true);
}
function passSpecReview(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "spec_reviewed");
  store.updateGatePassed(topicId, "spec_review", true);
}
function passPlanReview(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "plan_reviewed");
  store.updateGatePassed(topicId, "plan_review", true);
}
function passReviewGate(store: CwStore, topicId: string): void {
  store.updateStatus(topicId, "reviewed");
  store.updateGatePassed(topicId, "review", true);
  store.appendGateHistory(topicId, {
    phase: "review",
    action: "review",
    gate: "file-exists+non-empty",
    result: "pass",
    progressive: false,
  });
}

/**
 * 注入 testCases + tdd_plan gate pass。testCase 的 expected 可自定义（用于多模式场景）。
 */
function passTddPlanGateWith(
  store: CwStore,
  topicId: string,
  cases: Array<{ id: string; expected: Expected }>,
): void {
  store.insertTestCases(
    topicId,
    cases.map((c, i) => ({
      id: c.id,
      layer: i % 2 === 0 ? ("mock" as const) : ("real" as const),
      scenario: "s",
      steps: "st",
      expected: c.expected,
      executor: "vitest",
      requiresScreenshot: false,
    })),
  );
  store.updateStatus(topicId, "tdd_inited");
  store.updateGatePassed(topicId, "tdd_plan", true);
  store.appendGateHistory(topicId, {
    phase: "tdd_plan",
    action: "tdd_plan",
    gate: "test-json-schema",
    result: "pass",
    progressive: false,
  });
}

const validPlanJson = {
  format: "lite",
  objective: "obj",
  waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] }],
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-emm-"));
  dbPath = join(tmpDir, "cw.json");
  realCommitHash = setupGitRepo(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 在 workspace（tmpDir）下建一个带 shebang + 可执行位的脚本。
 * relPath 形如 "scripts/ok.sh"（相对 tmpDir）。自动建父目录。
 */
function makeRunnableScript(relPath: string, body: string): string {
  const abs = join(tmpDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  chmodSync(abs, 0o755);
  return abs;
}

// ════════════════════════════════════════════════════════════════
// AC-1: exact 模式行为与现状完全一致（精确 ===）
// ════════════════════════════════════════════════════════════════

describe("AC-1: exact 模式 = 精确 === 比较", () => {
  it("type:'exact' + text 精确匹配 → passed", () => {
    const r = judgeByExpected({ type: "exact", text: "2" }, { text: "2" });
    expect(r.status).toBe("passed");
  });

  it("type:'exact' + text 不等（多一个空格）→ failed，reason 精确文本", () => {
    const r = judgeByExpected({ type: "exact", text: "2" }, { text: "2 " });
    expect(r.status).toBe("failed");
    // reason 必须含 actual 与 expected 双方，便于排查。
    expect(r.reason).toContain("2 ");
    expect(r.reason).toContain('"2"');
  });

  it("type:'exact' + url 精确匹配（url-only）→ passed（url 仍是独立 === 判据，非 fetch）", () => {
    const r = judgeByExpected({ type: "exact", url: "http://x" }, {
      url: "http://x",
    });
    expect(r.status).toBe("passed");
  });

  it("type:'exact' + url 不等 → failed", () => {
    const r = judgeByExpected({ type: "exact", url: "http://a" }, {
      url: "http://b",
    });
    expect(r.status).toBe("failed");
  });

  it("type:'exact' 无 text 无 url → failed「no judgeable field」（与现状兜底一致）", () => {
    const r = judgeByExpected({ type: "exact" }, {});
    expect(r.status).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-2: exit_zero 模式 — testRunner exit 0 判 pass，非 0 判 failed
// （判定逻辑部分：judgeByExpected 对 exit_zero 不再要求 actual，按 exit code 归一化）
// ════════════════════════════════════════════════════════════════

describe("AC-2: exit_zero 判定逻辑（纯函数层）", () => {
  it("type:'exit_zero' + actual.exitCode=0 → passed（无需 text/url）", () => {
    const r = judgeByExpected({ type: "exit_zero" }, { exitCode: 0 });
    expect(r.status).toBe("passed");
  });

  it("type:'exit_zero' + actual.exitCode=1 → failed", () => {
    const r = judgeByExpected({ type: "exit_zero" }, { exitCode: 1 });
    expect(r.status).toBe("failed");
  });

  it("type:'exit_zero' + 无 actual（undefined）→ 按未执行处理，不报 no judgeable field", () => {
    // exit_zero 不依赖 agent 提交 actual（FR-2a: actual 可省略）。
    // 未跑/没结果不应判「no judgeable field」——这会与 exact 兜底混淆。
    const r = judgeByExpected({ type: "exit_zero" }, {} as Actual);
    // 预期：要么 failed（无 exitCode 视为非 0），要么由 handleTest 在执行后回填。
    // 关键断言：不是 exact 的「no judgeable field」错误。
    expect(r.reason).not.toContain("no judgeable field");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-3: script 模式 — 脚本 exit 0 判 pass，非 0 判 failed（判定逻辑部分）
// ════════════════════════════════════════════════════════════════

describe("AC-3: script 判定逻辑（纯函数层）", () => {
  it("type:'script' + actual.exitCode=0 → passed", () => {
    const r = judgeByExpected({ type: "script", path: "check.sh" }, {
      exitCode: 0,
    });
    expect(r.status).toBe("passed");
  });

  it("type:'script' + actual.exitCode=2 → failed", () => {
    const r = judgeByExpected({ type: "script", path: "check.sh" }, {
      exitCode: 2,
    });
    expect(r.status).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-4a: script.path 经 resolve 沙箱（覆盖非顶层 .. 和绝对路径）
// ════════════════════════════════════════════════════════════════

describe("AC-4a: tddPlanCheck 对 script.path 沙箱校验", () => {
  const testRunner = { mode: "nodejs" as const, command: "npx vitest run" };

  it("script.path='../../etc/passwd'（顶层 .. 越界）→ fail，报告点出 path 沙箱问题", () => {
    const testJson = {
      testRunner,
      testCases: [
        {
          id: "S1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "script", path: "../../etc/passwd" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "S2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-out" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("S1");
    // 必须是 path 沙箱拒绝（含 path / 越界 / workspace 等字样），而非其它原因。
    expect(result.report.toLowerCase()).toContain("path");
  });

  it("script.path='/etc/passwd'（绝对路径）→ fail，报告点出 path 沙箱问题", () => {
    const testJson = {
      testRunner,
      testCases: [
        {
          id: "S1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "script", path: "/etc/passwd" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "S2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-out" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report.toLowerCase()).toContain("path");
  });

  it("script.path='foo/../../../etc/passwd'（非顶层 .. 绕过）→ fail（字符串 substring 检查抓不到，必须 resolve）", () => {
    // 关键回归点：字符串 startsWith('..') 或 indexOf('..') 抓不到 "foo/../../etc"。
    // 必须 path.resolve(workspace, 'foo/../../../etc/passwd') 后再 startsWith(workspace) 才抓得到。
    const testJson = {
      testRunner,
      testCases: [
        {
          id: "S1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "script", path: "foo/../../../etc/passwd" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "S2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-out" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("S1");
    expect(result.report.toLowerCase()).toContain("path");
  });

  it("script.path='scripts/check.sh'（合法相对路径）→ pass（沙箱校验通过 + script 被认作判据）", () => {
    // 这是 AC-4a / AC-5 / AC-7 的反面回归：合法 script 不应被任何 gate 挡下。
    // 现状 fail（script 无 text/url → 空判据拒绝）；实现后 script 是合法判据 → pass。
    const testJson = {
      testRunner,
      testCases: [
        {
          id: "S1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "script", path: "scripts/check.sh" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "S2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-out" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("pass");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-5: exit_zero / script 模式跳过 FUZZY_EXPECTED_RE 检查
// ════════════════════════════════════════════════════════════════

describe("AC-5: exit_zero/script 跳过 FUZZY_EXPECTED_RE", () => {
  const testRunner = { mode: "nodejs" as const, command: "npx vitest run" };

  it("exit_zero 模式无 text → 不触发模糊检测，pass", () => {
    // 旧逻辑：expected.text 为空时不进 FUZZY 检查（pass），但这测的不是新行为。
    // 新行为断言：exit_zero 是合法的「无 text」判据，不应被判「缺少判据」（AC-7 的反面），
    // 也不应因缺 text 被挡。此处断言 result=pass。
    const testJson = {
      testRunner,
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exit_zero" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exit_zero" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("pass");
    expect(result.report).not.toContain("判据");
    expect(result.report).not.toContain("模糊");
  });

  it("script 模式无 text → 不触发模糊/空判据检测，pass", () => {
    const testJson = {
      testRunner,
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "script", path: "scripts/check.sh" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-out" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("pass");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-7: tdd_plan/test.json 不含 type 字段时 gate 拒绝
// ════════════════════════════════════════════════════════════════

describe("AC-7: expected 不含 type 字段 → gate 拒绝", () => {
  const testRunner = { mode: "nodejs" as const, command: "npx vitest run" };

  it("expected:{text:'x'}（旧格式，无 type）→ fail，报告含 type 必填提示", () => {
    const testJson = {
      testRunner,
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "real-out-1" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { text: "real-out-2" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("type");
    expect(result.report).toContain("E1");
  });

  it("expected:{}（空，无 type）→ fail（type 必填，而非「判据缺失」）", () => {
    const testJson = {
      testRunner,
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: {},
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exit_zero" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("type");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-6: append-only 对新结构生效 — 改 type 触发 case_expected_tampered_failed
// ════════════════════════════════════════════════════════════════

describe("AC-6: append-only — 改 expected.type 触发违规", () => {
  it("已 failed 的 exit_zero case 被 replan 改 type 为 exact → throw case_expected_tampered_failed", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "emm-ac6", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    // 注入两个新结构 case（exit_zero + exact），过 tdd_plan gate。
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    // 跑 test：exit_zero 在 E1 未实现 → failed；E2 exact 不匹配也 failed。
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { exitCode: 1 } },
          { caseId: "E2", actual: { text: "wrong" } },
        ],
      },
      deps,
    );
    // E1 当前 failed。replan 把 E1 的 type 从 exit_zero 改成 exact（防作弊路径）。
    store.updateStatus(topicId, "developed");
    const newTestJson = {
      testRunner: { mode: "nodejs", command: "npx vitest run" },
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "exit-1" },
          executor: "vitest",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "real-out" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    expect(() =>
      dispatch({ action: "replan", topicId, testJson: newTestJson }, deps),
    ).toThrow(/case_expected_tampered_failed/);
  });
});

// ════════════════════════════════════════════════════════════════
// AC-8: testCheck / judgeByExpected 函数体内无 child_process 调用
// （纯函数性 — 用 grep 源文件断言，避免读源码进运行时）
// ════════════════════════════════════════════════════════════════

describe("AC-8: judgeByExpected / testCheck 纯函数性（无 child_process）", () => {
  it("src/types.ts judgeByExpected 源码不含 child_process / execFileSync / spawn", () => {
    // 读源文件静态检查：判定逻辑不能直接调子进程。
    // 实现阶段把执行逻辑放到 handleTest，judgeByExpected 保持纯函数。
    const src = readSrc(join(__dirname, "..", "src", "types.ts"));
    // 取 judgeByExpected 函数体区间粗检（全文不含执行类调用即可，函数体更不可能含）。
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("execFileSync");
    expect(src).not.toContain("execSync");
    expect(src).not.toContain("spawnSync");
  });

  it("testCheck 不含 child_process 调用（命令执行只在 handleTest）", () => {
    const src = readSrc(join(__dirname, "..", "src", "gate.ts"));
    const testCheckBody = extractFunctionBody(src, "function testCheck");
    expect(testCheckBody).toBeTruthy();
    expect(testCheckBody).not.toContain("execFileSync");
    expect(testCheckBody).not.toContain("spawnSync");
    expect(testCheckBody).not.toContain("child_process");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-2 执行 + AC-9 + AC-10: handleTest 对 exit_zero 的执行模型
// （testRunner 跑一次，exit 0 → 全部 exit_zero case pass；非 0 → failed）
// ════════════════════════════════════════════════════════════════

describe("AC-2 执行: handleTest 执行 testRunner 判 exit_zero", () => {
  it("exit_zero case + testRunner exit 0 → case passed（无需 agent 提交 actual）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "emm-ac2-0", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    // 配置一个 exit 0 的 testRunner（topic 级单命令）。
    store.setTestRunner(topicId, {
      mode: "nodejs",
      command: 'node -e "process.exit(0)"',
    });
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    // exit_zero 的 case 不提交 actual（FR-2a: actual 可省略）。
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" }, // 无 actual
          { caseId: "E2", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(result.gatePassed.test).toBe(true);
  });

  it("exit_zero case + testRunner exit 1 → case failed", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "emm-ac2-1", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    store.setTestRunner(topicId, {
      mode: "nodejs",
      command: 'node -e "process.exit(1)"',
    });
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" },
          { caseId: "E2", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("failed");
    expect(result.gatePassed.test).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// AC-3 执行 + AC-9 + AC-10: handleTest 对 script 的执行模型
// （执行 path 指向的脚本，exit 0 → pass；不经 shell；不传 actual）
// ════════════════════════════════════════════════════════════════

describe("AC-3 执行: handleTest 执行 script.path 判 exit", () => {
  it("script case + 脚本 exit 0 → passed（脚本真实可执行，带 shebang + 执行位）", () => {
    const { deps, store } = makeDeps();
    makeRunnableScript("scripts/ok.sh", "#!/usr/bin/env bash\nexit 0\n");

    const createResult = dispatch(
      { action: "create", slug: "emm-ac3-0", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "script", path: "scripts/ok.sh" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" }, // script 不接收 actual（AC-9）
          { caseId: "E2", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(result.gatePassed.test).toBe(true);
  });

  it("script case + 脚本 exit 2 → failed", () => {
    const { deps, store } = makeDeps();
    makeRunnableScript("scripts/fail.sh", "#!/usr/bin/env bash\nexit 2\n");

    const createResult = dispatch(
      { action: "create", slug: "emm-ac3-2", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "script", path: "scripts/fail.sh" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    const result = dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" },
          { caseId: "E2", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("failed");
    expect(result.gatePassed.test).toBe(false);
  });

  it("AC-9: script 执行不传 agent actual（脚本自包含读系统状态）", () => {
    // 脚本验证 handleTest 没把 actual 注入 argv/env。任何 argv 或 ACTUAL env 都视为污染 → exit 1。
    const { deps, store } = makeDeps();
    makeRunnableScript(
      "scripts/noactual.sh",
      '#!/usr/bin/env bash\nif [ "$#" -gt 0 ] || [ -n "$ACTUAL" ]; then exit 1; fi\nexit 0\n',
    );

    const createResult = dispatch(
      { action: "create", slug: "emm-ac9", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "script", path: "scripts/noactual.sh" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    dispatch(
      {
        action: "test",
        topicId,
        // 故意提交 actual，验证 handleTest 执行 script 时不会把它传给脚本。
        cases: [
          { caseId: "E1", actual: { text: "should-be-ignored" } },
          { caseId: "E2", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("passed");
  });

  it("AC-10: script/exit_zero 执行不经 shell（handleTest 体内无 shell:true）", () => {
    // AC-10 核心契约：exit_zero/script 的执行用 execFileSync(shell:false 等价)，
    // 不经 shell 解析。现有 runTestRunner 用 shell:true（用于 nodejs/python/java testRunner），
    // 但 AC-10 要求新增的 exit_zero/script 执行路径不经 shell——静态断言 handleTest 函数体内不含 shell:true。
    // （行为层面，script.path 含 '$(exit 1)' 这种 shell 注入串经 shell 会被先解析；不经 shell 则按字面路径。）
    const actionsSrc = readSrc(join(__dirname, "..", "src", "actions.ts"));
    const handleTestBody = extractFunctionBody(actionsSrc, "function handleTest");
    expect(handleTestBody).toBeTruthy();
    // handleTest 新增的 exit_zero/script 执行路径必须不经 shell。
    // 实现阶段会加 execFileSync(... { shell: false })；现状 handleTest 无执行逻辑（全交给 testCheck）。
    expect(handleTestBody).not.toContain("shell: true");
    // 且实现后 handleTest 必须含 script/exit_zero 执行（execFileSync 调用）。
    expect(handleTestBody).toContain("execFileSync");
  });
});

// ════════════════════════════════════════════════════════════════
// 辅助：静态读源文件 + 提取函数体（AC-8/AC-10 静态契约）
// ════════════════════════════════════════════════════════════════

function readSrc(p: string): string {
  // 用 fs 直读（避免 import 触发编译 / 与 lint any 规则冲突）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readFileSync(p, "utf8");
}

/** 从源码文本里粗略提取 `function <name>(...) { ... }` 的函数体（花括号配平）。 */
function extractFunctionBody(src: string, namePrefix: string): string {
  const idx = src.indexOf(namePrefix);
  if (idx === -1) return "";
  // 从 namePrefix 起找第一个 '{'，然后花括号配平到匹配的 '}'。
  let i = src.indexOf("{", idx);
  if (i === -1) return "";
  let depth = 0;
  let start = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return src.slice(start, i + 1);
      }
    }
  }
  return "";
}
