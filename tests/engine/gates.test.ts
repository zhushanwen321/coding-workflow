/**
 * gates.test.ts — gate 注册表 + runGate 执行器 + GateRunner dispatch + GitValidator。
 *
 * Mock 层：
 *   - execFileSync 被 vi.mock 桩掉（不真跑 git）；GitValidator 测试用。
 *   - GateRunner.runCheck 用 vi.spyOn 桩掉（不真调 check 函数）；runGate 测试用。
 *
 * 覆盖：
 *   - GATE_REGISTRY 完整性（11 行表 / 4 checker / progressive 空）
 *   - lookupGateTier
 *   - runGate 全量报告（跑完所有 checker 收集全部错误）+ progressive 不跑 checker
 *   - GateRunner.runCheck dispatch（未知 key → infraError；check crash → infraError）
 *   - GitValidator（execFileSync git 三项校验 + ENOENT throw vs 业务 fail）
 *
 * 历史（2026-07-04）：原 GateRunner.runCheck 的 subprocess 契约测试（T2.19/T2.20/T2.21a/b/c/T2.22）
 * 已删除——TS check 函数世界无 spawnSync/verdict 行/exit code/timeout，这些场景物理上不存在。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted 保证 mock 引用在 vi.mock 工厂（被 hoist 到 import 之前）里可用。
const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

import { GATE_REGISTRY, type GateContext, GateRunner, GitValidator, lookupGateTier, runGate } from "../../src/engine/gates.js";
import type { CwTopic } from "../../src/engine/types.js";

// ── fixtures ─────────────────────────────────────────────────

/** 最小 CwTopic（runGate 不读 topic 字段，只需满足 GateContext 类型）。 */
function makeTopic(): CwTopic {
  return {
    schemaVersion: 1,
    topicId: "cw-demo",
    slug: "demo",
    tier: "lite",
    objective: "build X",
    workspacePath: "/tmp/ws",
    createdAt: "2026-07-04T00:00:00.000Z",
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
  };
}

function makeCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    topic: makeTopic(),
    // topicDir 与 workspacePath 一致（绝对路径），与生产 index.ts 一致。
    topicDir: "/tmp/ws",
    workspacePath: "/tmp/ws",
    runner: new GateRunner("/tmp/ws"),
    git: new GitValidator("/tmp/ws"),
    ...overrides,
  };
}

// ── execFileSync 错误构造 ───────────────────────────────────

/** git 非零退出（业务 fail：commit 不存在/不属仓库/空）。 */
function gitExitError(status: number): Error {
  const e = new Error(`git exited ${status}`);
  Object.assign(e, { status });
  return e;
}

/** git 可执行文件缺失（基础设施异常，应 throw）。 */
function gitEnoentError(): Error {
  const e = new Error("spawn git ENOENT");
  Object.assign(e, { code: "ENOENT" });
  return e;
}

/** check 函数返回值常量（runGate 测试 spyOn runCheck 时用）。 */
const PASS_CHECK = { passed: true, report: "[plan] machine check: 5/5 passed → PASS" };
const FAIL_CHECK = { passed: false, report: "[plan] machine check: 3/5 passed → FAIL" };

beforeEach(() => {
  mocks.execFileSync.mockReset();
  vi.restoreAllMocks();
});

// ── GATE_REGISTRY 完整性 ────────────────────────────────────

describe("GATE_REGISTRY", () => {
  it("§5.2 的 11 行表 1:1 编码", () => {
    expect(GATE_REGISTRY).toHaveLength(11);
    const lite = GATE_REGISTRY.filter((r) => r.tier === "lite");
    const mid = GATE_REGISTRY.filter((r) => r.tier === "mid");
    expect(lite).toHaveLength(5);
    expect(mid).toHaveLength(6);
  });

  it("mid detail 含 4 个 checker（check_issues/nfr/code_arch/execution）", () => {
    const detail = GATE_REGISTRY.find((r) => r.tier === "mid" && r.phase === "detail");
    expect(detail).toBeDefined();
    expect(detail!.checkers).toHaveLength(4);
  });

  it("progressive gate（dev/test）checkers 空", () => {
    for (const phase of ["dev", "test"] as const) {
      const liteDev = GATE_REGISTRY.find((r) => r.tier === "lite" && r.phase === phase);
      expect(liteDev!.progressive).toBe(true);
      expect(liteDev!.checkers).toHaveLength(0);
    }
  });

  it("m-6 — retrospect 行 progressive:true（与 TRANSITIONS.retrospect.progressive=true 对齐）", () => {
    for (const tier of ["lite", "mid"] as const) {
      const rule = GATE_REGISTRY.find((r) => r.tier === tier && r.phase === "retrospect");
      expect(rule).toBeDefined();
      expect(rule!.progressive).toBe(true);
    }
  });
});

// ── lookupGateTier（progressive 透传 gateTier） ──────────────

describe("lookupGateTier", () => {
  it("lite dev → medium-git", () => {
    expect(lookupGateTier("lite", "dev")).toBe("medium-git");
  });
  it("lite test → strong-recompute", () => {
    expect(lookupGateTier("lite", "test")).toBe("strong-recompute");
  });
  it("mid test → medium-coverage", () => {
    expect(lookupGateTier("mid", "test")).toBe("medium-coverage");
  });
  it("未知 (tier,phase) → throw", () => {
    expect(() => lookupGateTier("mid", "plan")).toThrow(/no gate rule/);
  });
});

// ── runGate ──────────────────────────────────────────────────

describe("runGate", () => {
  it("progressive gate（dev）不跑 checker，直接返 gateTier + passed", () => {
    const spy = vi.spyOn(GateRunner.prototype, "runCheck");
    const ctx = makeCtx();
    const result = runGate(ctx, "lite", "dev");
    expect(result.passed).toBe(true);
    expect(result.gateTier).toBe("medium-git");
    expect(result.reports).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("T2.5 — 单 checker gate fail（check_plan FAIL）→ passed:false；status 不由 gate 层碰", () => {
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(FAIL_CHECK);
    const ctx = makeCtx();
    const before = ctx.topic.status;
    const result = runGate(ctx, "lite", "plan");
    expect(result.passed).toBe(false);
    expect(result.gateTier).toBe("weak-structural");
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]!.passed).toBe(false);
    expect(ctx.topic.status).toBe(before);
  });

  it("单 checker gate pass（check_plan PASS）→ passed:true + report", () => {
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(PASS_CHECK);
    const ctx = makeCtx();
    const result = runGate(ctx, "lite", "plan");
    expect(result.passed).toBe(true);
    expect(result.reports[0]!.passed).toBe(true);
    expect(result.reports[0]!.report).toContain("PASS");
  });

  it("T2.7 — mid detail 4 checker 全量报告（首个 fail 仍跑剩余 checker 收集全部错误）", () => {
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(FAIL_CHECK);
    const ctx = makeCtx();
    const result = runGate(ctx, "mid", "detail");
    expect(result.passed).toBe(false);
    expect(result.reports).toHaveLength(4); // 全量跑完所有 checker，不再 fail-fast
    expect(result.reports.every((r) => !r.passed)).toBe(true); // 4 个全 fail
  });

  it("mid detail 部分 fail 部分 pass → passed:false + 全部 4 个 report（去短路核心价值场景）", () => {
    // checker 1 fail，checker 2-4 pass：模拟 issues 过了但 nfr 挂了
    const spy = vi.spyOn(GateRunner.prototype, "runCheck");
    spy.mockReturnValueOnce(FAIL_CHECK); // check_issues fail
    spy.mockReturnValue(PASS_CHECK); // check_nfr/code_arch/execution pass
    const ctx = makeCtx();
    const result = runGate(ctx, "mid", "detail");
    expect(result.passed).toBe(false); // 有 fail 就 false
    expect(result.reports).toHaveLength(4); // 4 个全跑了，不短路
    expect(result.reports[0]!.passed).toBe(false); // issues fail
    expect(result.reports[1]!.passed).toBe(true); // nfr pass
    expect(result.reports[2]!.passed).toBe(true); // code_arch pass
    expect(result.reports[3]!.passed).toBe(true); // execution pass
  });

  it("mid detail 全 checker pass → passed:true（4 个都跑）", () => {
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(PASS_CHECK);
    const ctx = makeCtx();
    const result = runGate(ctx, "mid", "detail");
    expect(result.passed).toBe(true);
    expect(result.reports).toHaveLength(4);
  });
});

// ── GateRunner.runCheck dispatch（取代原 subprocess adapter 测试） ──

describe("GateRunner.runCheck dispatch", () => {
  const runner = new GateRunner("/tmp/ws");

  it("未知 scriptPath key → infraError（dispatch 表未注册）", () => {
    const out = runner.runCheck("check_nonexistent.py", "/tmp/topic");
    expect(out.passed).toBe(false);
    expect(out.infraError).toMatch(/unknown check/);
  });

  it("check 函数 crash（throw）→ infraError 兜底", () => {
    // check_clarity 已实现；传 null topicDir 让 join(null, ...) throw → dispatch catch 兜底。
    // 这模拟 check 函数内部意外异常（文件系统错、解析错等）。
    // 故意传 null 让 join(null, ...) throw——测 crash 兜底路径，类型违规是测试意图
    // eslint-disable-next-line taste/no-unsafe-cast -- 测试专用：故意传错类型触发异常
    const out = runner.runCheck("check_clarity.py", null as unknown as string);
    expect(out.passed).toBe(false);
    expect(out.infraError).toMatch(/crashed|crash/i);
  });
});

// ── GitValidator（execFileSync adapter，#3） ─────────────────

describe("GitValidator.validate", () => {
  /**
   * 装配 execFileSync mock：按 git 子命令分发。
   * missing/empty 控制两项校验各自是否 throw（业务 fail）。
   *
   * ADR-029 robustness #1（2026-07）：merge-base --is-ancestor HEAD 已移除
   * （worktree 隔离下误杀合法 dev commit），inRepo 合并入 exists（cat-file）。
   */
  function mockGit(opts: {
    catFileThrows?: boolean;
    diffTreeOutput?: string;
    enoent?: boolean;
    /** m-5: rev-parse --is-inside-work-tree 是否 throw（非 git 仓库场景） */
    revParseThrows?: boolean;
  }): void {
    mocks.execFileSync.mockImplementation((cmd: string, args: readonly string[]) => {
      if (opts.enoent) throw gitEnoentError();
      const sub = args[0];
      if (sub === "rev-parse") {
        // m-5: rev-parse --is-inside-work-tree 探测。默认成功（在 git 仓库内）。
        if (opts.revParseThrows) throw gitExitError(128);
        return "true\n";
      }
      if (sub === "cat-file") {
        if (opts.catFileThrows) throw gitExitError(128);
        return "";
      }
      if (sub === "diff-tree") {
        return opts.diffTreeOutput ?? "";
      }
      throw new Error(`unexpected git subcommand: ${sub}`);
    });
  }

  it("合法 commit（两项全过）→ valid:true", () => {
    mockGit({ diffTreeOutput: " 1 file changed, 2 insertions(+)\n" });
    const v = new GitValidator("/tmp/ws").validate("abc1234");
    expect(v.exists).toBe(true);
    expect(v.inRepo).toBe(true);
    expect(v.nonEmpty).toBe(true);
    expect(v.valid).toBe(true);
    expect(v.reason).toBeUndefined();
  });

  it("T2.15 — commit 不存在（cat-file 非零退出）→ exists:false, inRepo:false, valid:false，不 throw", () => {
    mockGit({ catFileThrows: true, diffTreeOutput: " 1 file changed\n" });
    const v = new GitValidator("/tmp/ws").validate("deadbee");
    expect(v.exists).toBe(false);
    expect(v.inRepo).toBe(false); // ADR-029 robustness #1：inRepo = exists
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/cat-file/);
  });

  it("空 commit（diff-tree 空输出，--allow-empty）→ nonEmpty:false, valid:false", () => {
    mockGit({ diffTreeOutput: "" });
    const v = new GitValidator("/tmp/ws").validate("abc1234");
    expect(v.nonEmpty).toBe(false);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/empty/);
  });

  it("T2.15 — git ENOENT（可执行文件缺失）→ throw infra-error，不是业务 fail", () => {
    mockGit({ enoent: true });
    expect(() => new GitValidator("/tmp/ws").validate("abc1234")).toThrow(/ENOENT|git/);
  });

  it("m-5 — 非 git 仓库（rev-parse 非零退出）→ valid:false, reason='not a git repo'（不跑后续三命令）", () => {
    mockGit({ revParseThrows: true });
    const v = new GitValidator("/tmp/ws").validate("abc1234");
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("not a git repo");
    expect(v.exists).toBe(false);
    expect(v.inRepo).toBe(false);
    expect(v.nonEmpty).toBe(false);
  });
});
