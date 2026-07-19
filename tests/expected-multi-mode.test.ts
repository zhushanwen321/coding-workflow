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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import { GitValidator, tddPlanCheck } from "../src/gate.js";
import { CwStore } from "../src/store.js";
import { type Actual, type Expected, judgeByExpected } from "../src/types.js";
import { readExitStatus } from "../src/actions.js";
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
  store.updateStatus(topicId, "pre_dev_verified");
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
  waves: [{ id: "W1", changes: [{ file: "src/app.ts", action: "create", description: "change1" }], dependsOn: [] }],
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
// R1（review fix）: symlink 绕过沙箱 — realpathSync 校验
// 核心：workspace 内的 symlink（如 .cw/evil.sh -> /tmp/xxx）resolve 后仍落在 workspace 前缀内
// （lexical 通过），但 execFileSync 跟随 symlink 执行真实目标 → 绕过沙箱。
// 必须先 realpathSync 解析 symlink 后再检查前缀。测试用真实 fs.symlinkSync，零 mock。
// ════════════════════════════════════════════════════════════════

describe("R1: symlink 绕过沙箱（realpathSync 校验）", () => {
  const testRunner = { mode: "nodejs" as const, command: "npx vitest run" };

  it("gate 层：script.path 是指向 workspace 外的 symlink（已存在）→ tddPlanCheck fail（symlink 绕过）", () => {
    // 真实 fs 操作：workspace 外建 target 文件，workspace 内建 symlink 指向它。
    // tddPlanCheck 必须用 realpathSync 解析 symlink，发现真实目标越出 workspace → 拒绝。
    const outsideTarget = join(tmpdir(), `cw-r1-target-${Date.now()}.sh`);
    writeFileSync(outsideTarget, "#!/usr/bin/env bash\nexit 0\n");
    const symlinkRel = "scripts/evil.sh";
    const symlinkAbs = join(tmpDir, symlinkRel);
    mkdirSync(join(symlinkAbs, ".."), { recursive: true });
    symlinkSync(outsideTarget, symlinkAbs);

    try {
      const testJson = {
        testRunner,
        testCases: [
          {
            id: "S1",
            layer: "mock",
            scenario: "s",
            steps: "st",
            expected: { type: "script", path: symlinkRel },
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
      // 显式传 workspacePath=tmpDir（默认 process.cwd() 是 repo 根，不匹配 tmpDir）。
      const result = tddPlanCheck(testJson, undefined, tmpDir);
      expect(result.result).toBe("fail");
      expect(result.report).toContain("S1");
      // 报告必须点出 path 沙箱问题（含 symlink 字样更佳）。
      expect(result.report.toLowerCase()).toContain("path");
    } finally {
      rmSync(outsideTarget, { force: true });
    }
  });

  it("gate 层：script.path 指向 workspace 内合法脚本（非 symlink）→ pass（realpath 不误伤）", () => {
    // 反面回归：合法的 workspace 内真实脚本，realpath 后仍在 workspace 内，不应被误判。
    makeRunnableScript("scripts/legit.sh", "#!/usr/bin/env bash\nexit 0\n");
    const testJson = {
      testRunner,
      testCases: [
        {
          id: "S1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "script", path: "scripts/legit.sh" },
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
    const result = tddPlanCheck(testJson, undefined, tmpDir);
    expect(result.result).toBe("pass");
  });

  it("执行层：handleTest 执行前 symlink 越界被拦（case failed，不执行真实目标）", () => {
    // 场景：tdd_plan 时 script.path 文件还不存在（lexical 通过，realpath ENOENT 回退 lexical），
    // dev 阶段写入一个指向 workspace 外的 symlink。test 阶段 handleTest 执行前再 realpath 校验，
    // 此时 symlink 已存在 → realpath 解析到真实目标 → 越界 → case failed（不执行）。
    const { deps, store } = makeDeps();
    const outsideTarget = join(tmpdir(), `cw-r1-exec-${Date.now()}.sh`);
    // target 故意 exit 0——若沙箱失效执行了它，case 会 passed。沙箱生效则 failed。
    writeFileSync(outsideTarget, "#!/usr/bin/env bash\nexit 0\n");

    const createResult = dispatch(
      { action: "create", slug: "emm-r1-symlink", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    // tdd_plan gate：此时 scripts/evil.sh 还不存在，realpath ENOENT 回退 lexical（通过）。
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "script", path: "scripts/evil.sh" } },
      { id: "E2", expected: { type: "exact", text: "real-out" } },
    ]);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);

    // dev 阶段后建 symlink：workspace 内 scripts/evil.sh → workspace 外 target。
    const symlinkAbs = join(tmpDir, "scripts/evil.sh");
    mkdirSync(join(symlinkAbs, ".."), { recursive: true });
    symlinkSync(outsideTarget, symlinkAbs);

    try {
      dispatch(
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
      // 关键断言：E1 必须 failed（symlink 越界被拦），不能 passed（passed 说明执行了越界 target）。
      const e1 = topic!.testCases.find((c) => c.id === "E1")!;
      expect(e1.status).toBe("failed");
      // failureReason 应点出沙箱/symlink 问题。
      expect(e1.failureReason).toContain("沙箱");
    } finally {
      rmSync(outsideTarget, { force: true });
    }
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

// ════════════════════════════════════════════════════════════════
// 盲区 #1: readExitStatus 非 number / 非有限 number status 分支（纯函数单测）
// readExitStatus 是 handleTest catch 分支区分「业务失败（有合法 status）」vs
// 「基础设施异常（spawn 失败/timeout/非法 status）」的开关。非 number + 非有限 number
// 一律归到 null（基础设施异常 → case failed，不当作业务 exit code）。
// ════════════════════════════════════════════════════════════════

describe("盲区 #1: readExitStatus 非 number / 非有限 number status 分支", () => {
  // NaN/Infinity/-Infinity 虽然 typeof === "number"，但不是合法进程退出码。
  // readExitStatus 用 Number.isFinite 收窄，让这些非法值归到 null（基础设施异常分支），
  // 而非泄漏给 actual.exitCode 判定。职责归位：本函数只返回合法 exit code。
  it("status=NaN → null（typeof==='number' 但非有限值，isFinite 收窄拦截）", () => {
    expect(readExitStatus({ status: NaN })).toBe(null);
  });

  it("status=Infinity → null（typeof==='number' 但非有限值）", () => {
    expect(readExitStatus({ status: Infinity })).toBe(null);
  });

  it("status=-Infinity → null（typeof==='number' 但非有限值）", () => {
    expect(readExitStatus({ status: -Infinity })).toBe(null);
  });

  it("status='1'（字符串）→ null（typeof !== 'number'）", () => {
    expect(readExitStatus({ status: "1" })).toBe(null);
  });

  it("status=0 → 0（正常整数仍返回，0 是合法业务退出码）", () => {
    expect(readExitStatus({ status: 0 })).toBe(0);
  });

  it("status=2 → 2（正常非零整数仍返回）", () => {
    expect(readExitStatus({ status: 2 })).toBe(2);
  });

  it("status=undefined → null（'status' in e 但值非 number）", () => {
    expect(readExitStatus({ status: undefined })).toBe(null);
  });

  it("status=null → null（值非 number）", () => {
    expect(readExitStatus({ status: null })).toBe(null);
  });

  it("无 status 字段（{}）→ null", () => {
    expect(readExitStatus({})).toBe(null);
  });

  it("入参 null → null（非对象）", () => {
    expect(readExitStatus(null)).toBe(null);
  });

  it("入参 'error'（字符串非对象）→ null", () => {
    expect(readExitStatus("error")).toBe(null);
  });
});

// ════════════════════════════════════════════════════════════════
// 盲区 #2: script spawn 异常 → case failed 不抛断整批
// spawn 失败（EACCES 无执行位 / ENOENT 文件不存在）时 readExitStatus 返回 null，
// handleTest 把它记为该 case 的 error（failed reason），同批其他 case 不受影响。
// 这验证「spawn 异常不抛断」契约——agent 不需因一个坏脚本重跑整批。
// ════════════════════════════════════════════════════════════════

describe("盲区 #2: script spawn 异常 → case failed 不抛断", () => {
  it("脚本无执行位（EACCES）→ 该 case failed（reason 含执行异常），同批 exact case 正常 passed", () => {
    const { deps, store } = makeDeps();
    // 建脚本但 chmod 0o644（不可执行）→ execFileSync 抛 EACCES。
    const noExecAbs = join(tmpDir, "scripts/noexec.sh");
    mkdirSync(join(noExecAbs, ".."), { recursive: true });
    writeFileSync(noExecAbs, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(noExecAbs, 0o644);

    const createResult = dispatch(
      { action: "create", slug: "emm-bs2-eacces", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    // E1 = 无执行位的 script（spawn 异常），E2 = exact exit 0（对照，应正常 passed）。
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "script", path: "scripts/noexec.sh" } },
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
        cases: [
          { caseId: "E1" }, // script 不接收 actual
          { caseId: "E2", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    const e1 = topic!.testCases.find((c) => c.id === "E1")!;
    // E1 必须 failed（EACCES → readExitStatus=null → error 分支）。
    expect(e1.status).toBe("failed");
    // failureReason 必须点出执行异常（含路径或「执行异常」字样）。
    expect(e1.failureReason).toMatch(/执行异常|noexec\.sh/);
    // 关键契约：E2 不受 E1 spawn 异常影响，正常 passed（不抛断整批）。
    const e2 = topic!.testCases.find((c) => c.id === "E2")!;
    expect(e2.status).toBe("passed");
  });

  it("脚本文件不存在（ENOENT）→ 该 case failed（reason 含执行异常），不抛断", () => {
    const { deps, store } = makeDeps();
    // 不建脚本——passTddPlanGateWith 时文件不存在，realpath ENOENT 回退 lexical 通过（与 R1 测试同构）。
    const createResult = dispatch(
      { action: "create", slug: "emm-bs2-enoent", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "script", path: "scripts/nonexistent.sh" } },
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
        cases: [
          { caseId: "E1" },
          { caseId: "E2", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    const e1 = topic!.testCases.find((c) => c.id === "E1")!;
    expect(e1.status).toBe("failed");
    expect(e1.failureReason).toMatch(/执行异常|nonexistent\.sh/);
    // E2 正常 passed（spawn 异常不抛断）。
    const e2 = topic!.testCases.find((c) => c.id === "E2")!;
    expect(e2.status).toBe("passed");
  });
});

// ════════════════════════════════════════════════════════════════
// 盲区 #3: AC-6 对称分支（改非 type 字段）
// AC-6 现有测试只测「failed case 改 expected.type → throw」。对称分支无单独 it。
// 实际行为（src/actions.ts:2391-2433 validateAppendOnly，已读代码确认）：
//   - passed case：全字段校验（expected 整体 JSON.stringify 对比 + layer/scenario/
//     steps/executor/requiresScreenshot/dependsOn），任一改 → case_modified_passed throw
//   - failed case：只校验 expected 整体（JSON.stringify 对比），改 expected →
//     case_expected_tampered_failed throw；改 scenario/steps（非 expected）→ 允许
// 关键：expected 是整体 JSON 对比，不是只看 type——所以改 text 不改 type 对 passed
// 和 failed 都触发违规。
// ════════════════════════════════════════════════════════════════

describe("盲区 #3: AC-6 对称分支（改非 type 字段）", () => {
  it("passed case 改 expected.text（不改 type）→ throw case_modified_passed（expected 整体 JSON 对比）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "emm-bs3-passed-text", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "exact", text: "real-out" } },
      { id: "E2", expected: { type: "exit_zero" } },
    ]);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    // 跑 test：E1 exact 匹配 → passed；E2 exit_zero 不配 testRunner → failed。
    store.setTestRunner(topicId, {
      mode: "nodejs",
      command: 'node -e "process.exit(1)"',
    });
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { text: "real-out" } },
          { caseId: "E2" },
        ],
      },
      deps,
    );
    // E1 当前 passed。replan 改 E1 的 expected.text（type 仍 exact，不改 type）。
    // 实际行为：validateAppendOnly 对 passed case 做 expected 整体 JSON.stringify 对比，
    // text 变了 → expected JSON 不同 → case_modified_passed 违规 → throw。
    const newTestJson = {
      testRunner: { mode: "nodejs", command: 'node -e "process.exit(1)"' },
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { type: "exact", text: "tampered-text" }, // text 变了，type 没变
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
    expect(() =>
      dispatch({ action: "replan", topicId, testJson: newTestJson }, deps),
    ).toThrow(/case_modified_passed/);
  });

  it("passed case 改 scenario（非 expected 字段）→ throw case_modified_passed", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "emm-bs3-passed-scen", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "exact", text: "real-out" } },
      { id: "E2", expected: { type: "exit_zero" } },
    ]);
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    store.setTestRunner(topicId, {
      mode: "nodejs",
      command: 'node -e "process.exit(1)"',
    });
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { text: "real-out" } },
          { caseId: "E2" },
        ],
      },
      deps,
    );
    // E1 passed。replan 改 E1 的 scenario（非 expected 字段，expected 完全不动）。
    // 实际行为：validateAppendOnly 对 passed case 也校验 scenario → case_modified_passed。
    const newTestJson = {
      testRunner: { mode: "nodejs", command: 'node -e "process.exit(1)"' },
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "changed-scenario", // scenario 变了，expected 不动
          steps: "st",
          expected: { type: "exact", text: "real-out" },
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
    expect(() =>
      dispatch({ action: "replan", topicId, testJson: newTestJson }, deps),
    ).toThrow(/case_modified_passed/);
  });

  it("failed case 改 scenario（非 expected）→ 允许（不 throw）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "emm-bs3-failed-scen", objective: "obj", workspacePath: tmpDir },
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
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    store.setTestRunner(topicId, {
      mode: "nodejs",
      command: 'node -e "process.exit(1)"',
    });
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" }, // exit_zero + testRunner exit 1 → failed
          { caseId: "E2", actual: { text: "wrong" } }, // exact mismatch → failed
        ],
      },
      deps,
    );
    // E1 / E2 都 failed。replan 改 E1 的 scenario（非 expected 字段）。
    // 实际行为：validateAppendOnly 对 failed case 只校验 expected，改 scenario 不触发违规 → 允许。
    const newTestJson = {
      testRunner: { mode: "nodejs", command: 'node -e "process.exit(1)"' },
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "changed-scenario", // scenario 变了，expected 不动
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
          expected: { type: "exact", text: "real-out" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    // 不 throw——failed case 改非 expected 字段是合法的（replan 重构测试场景）。
    expect(() =>
      dispatch({ action: "replan", topicId, testJson: newTestJson }, deps),
    ).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// 盲区 #4: exit_zero 共享执行去重（多 case 一次 spawn）
// exit_zero 模式下所有 case 共享一次 testRunner 执行（handleTest 去重逻辑，
// src/actions.ts:1138-1158）。用 side-effect 文件计数法验证「只 spawn 一次」：
// testRunner command 每次执行往 counter 文件追加一行，跑完读行数 = 1（即使 N 个 case）。
// ════════════════════════════════════════════════════════════════

describe("盲区 #4: exit_zero 共享执行去重（多 case 一次 spawn）", () => {
  it("3 个 exit_zero case + testRunner exit 0 → 全部 passed（共享结果传播）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "emm-bs4-shared-pass", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    // 3 个 exit_zero case + 1 个 exact（对照，按 actual 判）。
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E2", expected: { type: "exit_zero" } },
      { id: "E3", expected: { type: "exit_zero" } },
      { id: "E4", expected: { type: "exact", text: "real-out" } },
    ]);
    store.setTestRunner(topicId, {
      mode: "nodejs",
      command: 'node -e "process.exit(0)"',
    });
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" },
          { caseId: "E2" },
          { caseId: "E3" },
          { caseId: "E4", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    // 所有 exit_zero case 共享同一次 exit 0 → 全部 passed。
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(topic!.testCases.find((c) => c.id === "E2")!.status).toBe("passed");
    expect(topic!.testCases.find((c) => c.id === "E3")!.status).toBe("passed");
    // exact 对照按 actual 判。
    expect(topic!.testCases.find((c) => c.id === "E4")!.status).toBe("passed");
  });

  it("3 个 exit_zero case + testRunner exit 1 → 全部 failed（共享失败也传播）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "emm-bs4-shared-fail", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E2", expected: { type: "exit_zero" } },
      { id: "E3", expected: { type: "exit_zero" } },
      { id: "E4", expected: { type: "exact", text: "real-out" } },
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
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" },
          { caseId: "E2" },
          { caseId: "E3" },
          { caseId: "E4", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    const topic = store.loadTopic(topicId);
    // 所有 exit_zero case 共享同一次 exit 1 → 全部 failed。
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("failed");
    expect(topic!.testCases.find((c) => c.id === "E2")!.status).toBe("failed");
    expect(topic!.testCases.find((c) => c.id === "E3")!.status).toBe("failed");
    // exact 对照仍按 actual 判（passed，不受 exit_zero 共享失败影响）。
    expect(topic!.testCases.find((c) => c.id === "E4")!.status).toBe("passed");
  });

  it("去重执行验证：3 个 exit_zero case → testRunner 只 spawn 一次（counter 文件行数=1）", () => {
    const { deps, store } = makeDeps();
    // counter 文件放 tmpDir 下（CI 并发安全，每个测试独立 tmpDir）。
    const counterFile = join(tmpDir, "spawn-counter.txt");

    const createResult = dispatch(
      { action: "create", slug: "emm-bs4-dedup", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    confirmClarify(store, topicId);
    passSpecReview(store, topicId);
    dispatch({ action: "plan", topicId, planJson: validPlanJson }, deps);
    passPlanReview(store, topicId);
    passTddPlanGateWith(store, topicId, [
      { id: "E1", expected: { type: "exit_zero" } },
      { id: "E2", expected: { type: "exit_zero" } },
      { id: "E3", expected: { type: "exit_zero" } },
      { id: "E4", expected: { type: "exact", text: "real-out" } },
    ]);
    // testRunner command：每次执行往 counter 文件追加 'x\n'，然后 exit 0。
    // 用绝对路径字面量注入（dispatch 不传 env，字面量最可靠）。
    // 注意：counter 文件路径含 tmpDir，tmpDir 路径无空格（mkdtempSync 用 cw-emm- 前缀）。
    const escapedPath = counterFile.replace(/\\/g, "\\\\");
    store.setTestRunner(topicId, {
      mode: "nodejs",
      command: `node -e "require('node:fs').appendFileSync('${escapedPath}', 'x\\n'); process.exit(0)"`,
    });
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: realCommitHash }] },
      deps,
    );
    passReviewGate(store, topicId);
    dispatch(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1" },
          { caseId: "E2" },
          { caseId: "E3" },
          { caseId: "E4", actual: { text: "real-out" } },
        ],
      },
      deps,
    );
    // 读 counter 文件：若去重生效，3 个 exit_zero case 共享一次 spawn → 文件只有 1 行。
    // 若未去重，会 spawn 3 次 → 文件有 3 行。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const content = fs.readFileSync(counterFile, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    // 所有 exit_zero case 都 passed（共享的 exit 0 传播）。
    const topic = store.loadTopic(topicId);
    expect(topic!.testCases.find((c) => c.id === "E1")!.status).toBe("passed");
    expect(topic!.testCases.find((c) => c.id === "E2")!.status).toBe("passed");
    expect(topic!.testCases.find((c) => c.id === "E3")!.status).toBe("passed");
  });
});
