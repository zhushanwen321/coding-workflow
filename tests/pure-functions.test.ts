/**
 * 纯函数单测 — 补充 src 中零直接测试的 export 函数。
 *
 * 分 3 组：
 * - 零依赖纯函数：encodeCwd, judgeByExpected（import 即测）
 * - 有 fs 副作用：fileExistsCheck, testCheck, GitValidator.validate（tmpdir + 真实文件）
 * - 通过 export 函数间接测 module-private：assertSafeSize（经 parseLitePlan）、
 *   countConsecutiveGateFails/熔断（经 buildNextAction）
 */
import { execFileSync } from "node:child_process";
import { mkdirSync,mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { fileExistsCheck, GitValidator,testCheck } from "../src/gate.js";
import { encodeCwd } from "../src/path-encoding.js";
import { parseLitePlan } from "../src/plan-parser.js";
import { buildNextAction } from "../src/state-machine.js";
import { type Action,judgeByExpected, type Topic } from "../src/types.js";

// ── 辅助：构造带 gateHistory 的 topic（熔断测试用） ──────────

function makeTopicWithFails(phase: Action, failCount: number): Topic {
  const gateHistory = [];
  for (let i = 0; i < failCount; i++) {
    gateHistory.push({
      id: i,
      ts: `2026-01-01T00:00:0${i}.000Z`,
      phase,
      action: phase,
      gate: "file-exists+non-empty",
      result: "fail" as const,
      report: "file not found",
      progressive: false,
    });
  }
  return {
    topicId: "cw-test",
    slug: "test",
    objective: "test",
    workspacePath: "/tmp",
    topicDir: "/tmp/.xyz-harness/test",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "developed",
    waves: [],
    testCases: [],
    gateHistory,
    gatePassed: {},
    clarifyRecords: [],
    specSections: [],
    adrs: [],
    reviewIssues: [],
    reviewTurn: 0,
    testFixLog: [],
    testTurn: 0,
    assessments: [],
  };
}

// ── encodeCwd ───────────────────────────────────────────────

describe("encodeCwd", () => {
  it("Unix 绝对路径 → 去首 / + 分隔符替换 + 首尾 --", () => {
    expect(encodeCwd("/Users/x/proj")).toBe("--Users-x-proj--");
  });

  it("含冒号的路径 → 冒号替换为 -", () => {
    // encodeCwd: 不去开头非 /\\ 字符 → 替换所有 /\\: 为 - → C: → C-
    expect(encodeCwd("C:\\Users\\x")).toBe("--C--Users-x--");
  });

  it("空字符串 → 仅有首尾 --", () => {
    expect(encodeCwd("")).toBe("----");
  });

  it("单层路径 /a → 去 / 后 a", () => {
    expect(encodeCwd("/a")).toBe("--a--");
  });
});

// ── judgeByExpected ─────────────────────────────────────────

describe("judgeByExpected", () => {
  it("url + text 全匹配 → passed", () => {
    const r = judgeByExpected(
      { url: "http://x", text: "ok" },
      { url: "http://x", text: "ok" },
    );
    expect(r.status).toBe("passed");
  });

  it("url 不等 → failed，reason 含 url 不匹配", () => {
    const r = judgeByExpected({ url: "http://a" }, { url: "http://b" });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("http://b");
    expect(r.reason).toContain("http://a");
  });

  it("text 不等 → failed", () => {
    const r = judgeByExpected({ text: "yes" }, { text: "no" });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("yes");
  });

  it("expected 有 url 但 actual 缺 url → failed，reason 含 missing", () => {
    const r = judgeByExpected({ url: "http://x" }, {});
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("missing");
  });

  it("expected 无 url 无 text → failed，reason 含 no judgeable", () => {
    const r = judgeByExpected({}, {});
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("no judgeable field");
  });
});

// ── fileExistsCheck（有 fs 副作用） ─────────────────────────

describe("fileExistsCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cw-fec-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("空 path → fail, report 含 empty", () => {
    const r = fileExistsCheck("");
    expect(r.result).toBe("fail");
    expect(r.report).toContain("empty");
  });

  it("文件不存在 → fail, report 含 not found", () => {
    const r = fileExistsCheck(join(tmpDir, "nope.md"));
    expect(r.result).toBe("fail");
    expect(r.report).toContain("not found");
  });

  it("目录存在 → pass（closeout gate 用目录存在性）", () => {
    const dir = join(tmpDir, "subdir");
    mkdirSync(dir);
    const r = fileExistsCheck(dir);
    expect(r.result).toBe("pass");
  });

  it("空文件 → fail, report 含 empty", () => {
    const f = join(tmpDir, "empty.md");
    writeFileSync(f, "   \n  "); // trim 后长度 0
    const r = fileExistsCheck(f);
    expect(r.result).toBe("fail");
    expect(r.report).toContain("empty");
  });

  it("非空文件 → pass", () => {
    const f = join(tmpDir, "ok.md");
    writeFileSync(f, "# Review\n内容");
    const r = fileExistsCheck(f);
    expect(r.result).toBe("pass");
  });
});

// ── testCheck（有 fs 副作用） ───────────────────────────────

describe("testCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cw-tc-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requiresScreenshot=true 但未提供 screenshotPath → failed", () => {
    const tc = {
      id: "U1",
      layer: "mock" as const,
      scenario: "x",
      steps: "x",
      expected: { text: "ok" },
      executor: "vitest",
      status: "pending" as const,
      requiresScreenshot: true,
      dependsOn: [],
    };
    const r = testCheck(tc, { text: "ok" }, undefined);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("screenshot required");
  });

  it("requiresScreenshot=true 且 screenshot 文件存在 → 继续 judge", () => {
    const shot = join(tmpDir, "shot.png");
    writeFileSync(shot, "fake png");
    const tc = {
      id: "U1",
      layer: "mock" as const,
      scenario: "x",
      steps: "x",
      expected: { text: "ok" },
      executor: "vitest",
      status: "pending" as const,
      requiresScreenshot: true,
      dependsOn: [],
    };
    const r = testCheck(tc, { text: "ok" }, shot);
    expect(r.status).toBe("passed");
  });

  it("requiresScreenshot=false → 直接 judgeByExpected", () => {
    const tc = {
      id: "U1",
      layer: "mock" as const,
      scenario: "x",
      steps: "x",
      expected: { text: "42" },
      executor: "vitest",
      status: "pending" as const,
      requiresScreenshot: false,
      dependsOn: [],
    };
    expect(testCheck(tc, { text: "42" }, undefined).status).toBe("passed");
    expect(testCheck(tc, { text: "wrong" }, undefined).status).toBe("failed");
  });
});

// ── GitValidator.validate（有 git 副作用） ──────────────────

describe("GitValidator.validate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cw-gv-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("非 git repo → valid=false, reason 含 not a git repo", () => {
    const v = new GitValidator(tmpDir);
    const r = v.validate("abc1234567890123456789012345678901234567");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("not a git repo");
  });

  it("commit 不存在 → exists=false, valid=false", () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    const v = new GitValidator(tmpDir);
    const r = v.validate("nonexistent000000000000000000000000000000000000");
    expect(r.exists).toBe(false);
    expect(r.valid).toBe(false);
  });

  it("空 commit（git commit --allow-empty）→ nonEmpty=false, valid=false", () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "empty"], { cwd: tmpDir });
    const commitHash = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      encoding: "utf8",
    }).trim();

    const v = new GitValidator(tmpDir);
    const r = v.validate(commitHash);
    expect(r.exists).toBe(true);
    expect(r.nonEmpty).toBe(false);
    expect(r.valid).toBe(false);
  });
});

// ── 熔断（通过 buildNextAction 间接测 countConsecutiveGateFails） ──

describe("gate 熔断 (countConsecutiveGateFails via buildNextAction)", () => {
  it("plan gate 连续 fail < 5 → 普通.retry 文案（不含熔断）", () => {
    const topic = makeTopicWithFails("plan", 3);
    topic.status = "created"; // plan fail 时 status 不变（仍 created）
    const na = buildNextAction("plan", topic);
    expect(na.guidance).not.toContain("熔断");
  });

  it("plan gate 连续 fail >= 5 → guidance 含熔断文案", () => {
    const topic = makeTopicWithFails("plan", 5);
    topic.status = "created";
    const na = buildNextAction("plan", topic);
    expect(na.guidance).toContain("熔断");
    expect(na.guidance).toContain("熔断阈值");
  });

  it("review gate 连续 fail >= 5 → guidance 含熔断文案", () => {
    const topic = makeTopicWithFails("review", 6);
    topic.status = "developed"; // review fail 时 status 不变（仍 developed）
    const na = buildNextAction("review", topic);
    expect(na.guidance).toContain("熔断");
  });
});

// ── assertSafeSize（通过 parseLitePlan 间接测） ─────────────

describe("assertSafeSize (via parseLitePlan)", () => {
  it("超大 plan（> 1MB）→ throw CwError 含 too large", () => {
    // 构造一个 > 1MB 的合法 plan（大 changes 字段）
    const bigText = "x".repeat(1100000);
    const plan = {
      format: "lite",
      objective: "test",
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: bigText }], dependsOn: [] }],
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "x",
          steps: "x",
          expected: { text: "x" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    expect(() => parseLitePlan(plan)).toThrow(/too large/);
  });

  it("正常大小 plan → 不 throw", () => {
    const plan = {
      format: "lite",
      objective: "test",
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "改 src/app.ts" }], dependsOn: [] }],
      testCases: [
        {
          id: "U1",
          layer: "mock",
          scenario: "x",
          steps: "x",
          expected: { text: "x" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    };
    expect(() => parseLitePlan(plan)).not.toThrow();
  });
});
