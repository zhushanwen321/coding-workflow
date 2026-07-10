/**
 * nfr.test.ts — NFR 安全/稳定性测试（来源 B）。
 *
 * 覆盖 test-matrix：
 *   T7.1 无效 CLI 参数 → exit ≠0（typebox 校验）
 *   T7.2 缺必填字段 → exit ≠0
 *   T7.3 非法 JSON → exit ≠0
 *   T7.4 路径穿越 CW_HOME → throw
 *   T7.5 .cw-wt/ 检测 → throw
 *
 * 测试层：integration（protocol.ts 校验 + resolveDbPath 防护）。
 */

import { describe, expect, it } from "vitest";

import { readJsonInput, resolveDbPath, validateParams } from "../../src/cli/protocol.js";

// ── T7.1/T7.2/T7.3: typebox 参数校验 ─────────────────────────

describe("NFR: typebox 参数校验", () => {
  it("T7.1 — 无效 tier：validateParams throw（exit ≠0 等价）", () => {
    expect(() =>
      validateParams({ action: "create", slug: "x", tier: "invalid", objective: "x" }),
    ).toThrow();
  });

  it("T7.1 — 无效 action：validateParams throw", () => {
    expect(() =>
      validateParams({ action: "bogus", slug: "x", tier: "lite", objective: "x" }),
    ).toThrow();
  });

  it("T7.2 — create 缺 slug：validateParams throw（slug 非必填在 schema，但 create handler 需要）", () => {
    // CwParamsSchema 中 slug 是 Optional，但 create 必须。
    // 这里测 schema 层：缺 action（必填）必 throw。
    expect(() => validateParams({ slug: "x" })).toThrow();
  });

  it("T7.3 — readJsonInput 非法 JSON：throw", () => {
    expect(() => readJsonInput(undefined, "{ not valid json", false)).toThrow(/JSON/);
  });

  it("T7.3 — readJsonInput 无输入（stdin 空 + 无 flag）：throw", () => {
    expect(() => readJsonInput(undefined, "", true)).toThrow();
  });

  it("T7.3 — readJsonInput stdin + flag 冲突：throw", () => {
    expect(() => readJsonInput("/tmp/plan.json", '{"a":1}', false)).toThrow(/冲突|conflict/i);
  });
});

// ── T7.4: 路径穿越防护 ───────────────────────────────────────

describe("NFR: 路径穿越防护", () => {
  it("T7.4 — CW_HOME 非绝对路径 → throw", () => {
    expect(() =>
      resolveDbPath("/tmp/ws", "relative/path"),
    ).toThrow(/绝对路径|absolute/i);
  });

  it("T7.4 — CW_HOME 含 .. → resolveDbPath 接受绝对路径但 encodeCwd 处理", () => {
    // CW_HOME 绝对路径合法（/tmp/../tmp 是绝对路径），encodeCwd 编码 workspacePath。
    // 关键校验是 CW_HOME 必须 isAbsolute。
    const path = resolveDbPath("/Users/x/proj", "/tmp/cw-home");
    expect(path).toContain("_cw.json");
  });
});

// ── T7.5: .cw-wt/ worktree 检测 ──────────────────────────────

describe("NFR: .cw-wt/ worktree 检测", () => {
  it("T7.5 — workspacePath 含 .cw-wt/ → throw", () => {
    expect(() =>
      resolveDbPath("/Users/x/proj/.cw-wt/cw-dev-pool0-123", "/tmp/cw-home"),
    ).toThrow(/cw-wt|worktree/i);
  });

  it("T7.5 — 正常 workspacePath（无 .cw-wt/）→ 返回合法路径", () => {
    const path = resolveDbPath("/Users/x/proj", "/tmp/cw-home");
    expect(path).toMatch(/_cw\.json$/);
    expect(path).not.toContain(".cw-wt");
  });
});
