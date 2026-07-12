/**
 * gate 单测 — P0 模糊 expected 值检测 + P1 文件覆盖校验。
 *
 * P0：planCheck 拒除 expected.text 匹配模糊结论词（passed/ok/success 等）的 testCase。
 * P1：devCheck 对 commit 实际改动文件与 plan changes 对比，输出 extraFiles。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

import { planCheck, devCheck, GitValidator } from "../src/gate.js";
import type { Topic } from "../src/types.js";

// ── 真实 git 仓库辅助 ───────────────────────────────────────

function setupGitRepo(repoDir: string): string {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  git(["init"]);
  git(["config", "user.email", "gate@test.com"]);
  git(["config", "user.name", "Gate Test"]);
  writeFileSync(join(repoDir, "README.md"), "# Gate test repo\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
  return git(["rev-parse", "HEAD"]);
}

/** 创建一个修改指定文件的 commit，返回 commit hash。 */
function commitFile(repoDir: string, filePath: string, content: string, message: string): string {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  // 确保父目录存在
  mkdirSync(dirname(join(repoDir, filePath)), { recursive: true });
  writeFileSync(join(repoDir, filePath), content);
  git(["add", "."]);
  git(["commit", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

// ── 测试环境 ────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-gate-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 构造合法 planJson 的辅助函数 ────────────────────────────

function makePlanJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "lite",
    objective: "test objective",
    waves: [{ id: "W1", changes: ["修改 src/app.ts 加功能"], dependsOn: [] }],
    testCases: [
      {
        id: "E1",
        layer: "mock",
        scenario: "验证功能",
        steps: "执行测试",
        expected: { text: "返回 { status: 'planned' }" },
        executor: "agent",
        requiresScreenshot: false,
      },
      {
        id: "E2",
        layer: "real",
        scenario: "集成验证",
        steps: "执行集成测试",
        expected: { text: "集成测试通过" },
        executor: "agent",
        requiresScreenshot: false,
      },
    ],
    ...overrides,
  };
}

// ── P0: planCheck 模糊 expected 值检测 ──────────────────────

describe("P0: planCheck 拒除模糊 expected 值", () => {
  it("expected.text='passed' → gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "passed" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("E1");
    expect(result.report).toContain("模糊结论词");
  });

  it("expected.text='OK'（大写）→ gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "OK" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("E1");
  });

  it("expected.text='success' → gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "success" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
  });

  it("expected.text='fail' → gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "fail" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
  });

  it("expected.text='true' → gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "true" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
  });

  it("expected.text='done' → gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "done" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
  });

  it("expected.text='completed' → gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "completed" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
  });

  it("expected.text='成功'（中文）→ gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "成功" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
  });

  it("expected.text='失败'（中文）→ gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "失败" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
  });

  it("多个 testCase 部分模糊 → gate fail，报告列出所有模糊 id", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s1",
          steps: "st1",
          expected: { text: "passed" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "mock",
          scenario: "s2",
          steps: "st2",
          expected: { text: "返回 { status: 'ok', data: [1,2,3] }" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E3",
          layer: "mock",
          scenario: "s3",
          steps: "st3",
          expected: { text: "success" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("E1");
    expect(result.report).toContain("E3");
    // E2 不应出现在报告中（"返回 { status: 'ok', data: [1,2,3] }" 不是纯 "ok"）
    expect(result.report).not.toContain("E2");
  });

  /** real 层补充用例，与 mock 层用例配对以满足测试分层校验 */
  const realLayerCase = {
    id: "E2",
    layer: "real" as const,
    scenario: "s",
    steps: "st",
    expected: { text: "real layer output" },
    executor: "agent",
    requiresScreenshot: false,
  };

  it("expected.text='返回 { status: 'planned' }' → gate pass（非模糊值）", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "返回 { status: 'planned' }" },
          executor: "agent",
          requiresScreenshot: false,
        },
        realLayerCase,
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("pass");
    expect(result.report).toBe("");
  });

  it("expected.text 含 'ok' 但非纯 'ok' → gate pass", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "status is ok, count=42" },
          executor: "agent",
          requiresScreenshot: false,
        },
        realLayerCase,
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("pass");
  });

  it("expected.text 含 'passed' 但非纯 'passed' → gate pass", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "test passed with 0 errors" },
          executor: "agent",
          requiresScreenshot: false,
        },
        realLayerCase,
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("pass");
  });

  it("expected 只有 url 无 text → gate pass（不检查 url）", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { url: "http://localhost:3000" },
          executor: "agent",
          requiresScreenshot: false,
        },
        realLayerCase,
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("pass");
  });

  it("expected 为空对象 → gate pass（无 text 不触发模糊检查）", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: {},
          executor: "agent",
          requiresScreenshot: false,
        },
        realLayerCase,
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("pass");
  });

  it("合法 plan（无模糊值）→ gate pass", () => {
    const result = planCheck(makePlanJson());
    expect(result.result).toBe("pass");
    expect(result.report).toBe("");
  });
});

// ── 测试分层强制（mock + real 各≥1）──────────────────────────

describe("planCheck 测试分层强制（mock + real 各≥1）", () => {
  it("只有 mock 层 testCase（缺 real 层）→ gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "具体输出值" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("real");
  });

  it("只有 real 层 testCase（缺 mock 层）→ gate fail", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { text: "具体输出值" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("mock");
  });

  it("mock + real 各≥1 → 测试分层校验通过", () => {
    const result = planCheck(makePlanJson());
    expect(result.result).toBe("pass");
  });
});

// ── P1: devCheck 文件覆盖校验 ────────────────────────────────

describe("P1: devCheck 文件覆盖校验", () => {
  let initialCommit: string;

  beforeEach(() => {
    initialCommit = setupGitRepo(tmpDir);
  });

  it("commit 改了 plan 外文件 → extraFiles 包含该文件", () => {
    // plan 只提到 src/app.ts，但 commit 实际改了 src/utils.ts
    const commitHash = commitFile(tmpDir, "src/utils.ts", "export const x = 1;", "add utils");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
    };

    const result = devCheck(commitHash, tmpDir, "W1", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeDefined();
    expect(result.extraFiles).toContain("src/utils.ts");
  });

  it("commit 改的文件全在 plan 中 → extraFiles 为空或 undefined", () => {
    // plan 提到 src/app.ts，commit 也只改 src/app.ts
    const commitHash = commitFile(tmpDir, "src/app.ts", "export const app = true;", "add app");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
    };

    const result = devCheck(commitHash, tmpDir, "W1", topic);
    expect(result.valid).toBe(true);
    // extraFiles 应为 undefined 或空数组
    if (result.extraFiles !== undefined) {
      expect(result.extraFiles).toHaveLength(0);
    }
  });

  it("commit 同时改了 plan 内和 plan 外文件 → extraFiles 只含 plan 外文件", () => {
    // 先创建 src/app.ts（让它被 tracked）
    commitFile(tmpDir, "src/app.ts", "initial", "add app initial");
    // 第二个 commit 同时改 src/app.ts 和 src/extra.ts
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: tmpDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    writeFileSync(join(tmpDir, "src/app.ts"), "export const app = 2;");
    writeFileSync(join(tmpDir, "src/extra.ts"), "export const extra = true;");
    git(["add", "."]);
    git(["commit", "-m", "modify app + add extra"]);
    const commitHash = git(["rev-parse", "HEAD"]);

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
    };

    const result = devCheck(commitHash, tmpDir, "W1", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeDefined();
    expect(result.extraFiles).toContain("src/extra.ts");
    // src/app.ts 在 plan 中，不应出现在 extraFiles
    expect(result.extraFiles).not.toContain("src/app.ts");
  });

  it("waveId 不存在于 topic.waves → extraFiles 不设置（跳过校验）", () => {
    const commitHash = commitFile(tmpDir, "src/new.ts", "export const n = 1;", "add new");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
    };

    const result = devCheck(commitHash, tmpDir, "W-nonexistent", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeUndefined();
  });

  it("不传 waveId/topic → 跳过文件覆盖校验（向后兼容）", () => {
    const commitHash = commitFile(tmpDir, "src/any.ts", "export const a = 1;", "add any");

    // 不传 waveId 和 topic，模拟旧版调用
    const result = devCheck(commitHash, tmpDir);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeUndefined();
  });

  it("planData 为空（wave.changes 空数组）→ 跳过文件覆盖校验", () => {
    const commitHash = commitFile(tmpDir, "src/app.ts", "export const x = 1;", "add app");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: [], // 空 changes
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
    };

    const result = devCheck(commitHash, tmpDir, "W1", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeUndefined();
  });

  it("plan changes 格式含中文动词 → 正确提取文件路径", () => {
    // plan: "创建 src/store.ts 实现数据持久化"
    // commit 改了 src/store.ts 和 src/config.ts
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: tmpDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/store.ts"), "export const store = {};");
    writeFileSync(join(tmpDir, "src/config.ts"), "export const config = {};");
    git(["add", "."]);
    git(["commit", "-m", "add store and config"]);
    const commitHash = git(["rev-parse", "HEAD"]);

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["创建 src/store.ts 实现数据持久化"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
    };

    const result = devCheck(commitHash, tmpDir, "W1", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeDefined();
    expect(result.extraFiles).toContain("src/config.ts");
    expect(result.extraFiles).not.toContain("src/store.ts");
  });

  it("commit 校验不通过（不存在的 hash）→ 不触发文件覆盖校验", () => {
    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: null,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
    };

    const result = devCheck("nonexistent000000000000000000000000000000000000", tmpDir, "W1", topic);
    expect(result.valid).toBe(false);
    expect(result.extraFiles).toBeUndefined();
  });

  it("P1 不影响 valid 判定：有 extraFiles 时 valid 仍为 true（宽松模式）", () => {
    const commitHash = commitFile(tmpDir, "src/extra.ts", "export const x = 1;", "add extra");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
    };

    const result = devCheck(commitHash, tmpDir, "W1", topic);
    expect(result.valid).toBe(true); // 宽松模式：有 extraFiles 不 fail
    expect(result.extraFiles).toContain("src/extra.ts");
  });
});
