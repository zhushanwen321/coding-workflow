/**
 * e2e-assess 测试 — E8（post-closeout 质量评估，progressive）。
 *
 * 覆盖分支：
 *   E8a: closeout 后 assess(quality+score) → AS1, status 仍 closed
 *   E8b: progressive——多次 assess → AS1/AS2/AS3 顺序追加
 *   E8c: type=defect + --defect → defect 结构正确
 *   E8d: 非法——非 closed 状态调 assess → illegal_transition
 *   E8e: 非法——type=defect 缺 --defect → exit≠0
 *
 * assess 不走 gate、不流转 status（progressive），只在 closed 状态可调。
 * assess 用 flag：--type/--notes/--score/--defect（非 stdin）。
 *
 * 真实子进程跑 dist/cli.js，独立隔离环境。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  parseStdout,
  runCli,
  setupToClosed,
  setupToDeveloped,
} from "./helpers/e2e.js";

let e: E2eEnv;

beforeAll(() => {
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
});

/** assess 调用（全用 flag）。 */
function assess(
  topicId: string,
  args: string[],
): Record<string, unknown> {
  return parseStdout(runCli(["assess", "--topicId", topicId, ...args], e));
}

// ── E8a: closeout 后 assess(quality+score) ──────────────────

describe("E8a: closeout 后 assess(quality+score) → AS1, status 仍 closed", () => {
  it("调 assess → assessmentId=AS1, assessments 含 1 条", () => {
    const { topicId } = setupToClosed(e, "e8a-assess");
    const result = assess(topicId, [
      "--type", "quality",
      "--score", "4",
      "--notes", "代码结构清晰，类型安全到位",
    ]);

    expect(result.status).toBe("closed");
    expect(result.assessmentId).toBe("AS1");

    const assessments = result.assessments as Array<Record<string, unknown>>;
    expect(assessments.length).toBe(1);
    expect(assessments[0]!.id).toBe("AS1");
    expect(assessments[0]!.type).toBe("quality");
    expect(assessments[0]!.score).toBe(4);
  });
});

// ── E8b: progressive——多次 assess ───────────────────────────

describe("E8b: progressive——多次 assess → AS1/AS2/AS3", () => {
  it("3 次不同 type 的 assess → 顺序追加，status 始终 closed", () => {
    const { topicId } = setupToClosed(e, "e8b-progressive");

    assess(topicId, ["--type", "quality", "--score", "4", "--notes", "质量好"]);
    assess(topicId, ["--type", "test", "--score", "3", "--notes", "测试覆盖一般"]);
    const r3 = assess(topicId, ["--type", "stability", "--notes", "稳定无并发问题"]);

    expect(r3.status).toBe("closed");
    const assessments = r3.assessments as Array<Record<string, unknown>>;
    expect(assessments.length).toBe(3);
    const ids = assessments.map((a) => a.id);
    expect(ids).toEqual(["AS1", "AS2", "AS3"]);
    const types = assessments.map((a) => a.type);
    expect(types).toEqual(["quality", "test", "stability"]);
    // stability 可省 score
    expect(assessments[2]!.score).toBeUndefined();
  });
});

// ── E8c: type=defect + --defect ──────────────────────────────

describe("E8c: type=defect + --defect → defect 结构正确", () => {
  it("assess defect 带 defect 详情 → assessments[0].defect 存在", () => {
    const { topicId } = setupToClosed(e, "e8c-defect");
    const result = assess(topicId, [
      "--type", "defect",
      "--notes", "并发场景下数据丢失",
      "--defect", JSON.stringify({
        severity: "major",
        area: "store.ts",
        rootCause: "边界遗漏",
        foundInReview: false,
      }),
    ]);

    const assessments = result.assessments as Array<Record<string, unknown>>;
    expect(assessments[0]!.type).toBe("defect");
    const defect = assessments[0]!.defect as Record<string, unknown>;
    expect(defect).toBeDefined();
    expect(defect.severity).toBe("major");
    expect(defect.area).toBe("store.ts");
    expect(defect.rootCause).toBe("边界遗漏");
    expect(defect.foundInReview).toBe(false);
  });
});

// ── E8d: 非法——非 closed 状态调 assess ───────────────────────

describe("E8d: 非法——developed 状态调 assess → illegal_transition", () => {
  it("developed 调 assess → exit≠0, stderr 含 illegal_transition", () => {
    const { topicId } = setupToDeveloped(e, "e8d-illegal");

    const result = runCli(
      ["assess", "--topicId", topicId, "--type", "quality", "--notes", "x"],
      e,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("illegal_transition");
  });
});

// ── E8e: 非法——type=defect 缺 --defect ──────────────────────

describe("E8e: type=defect 缺 --defect → exit≠0", () => {
  it("type=defect 但不带 --defect → exit≠0（CwError）", () => {
    const { topicId } = setupToClosed(e, "e8e-missing");

    const result = runCli(
      ["assess", "--topicId", topicId, "--type", "defect", "--notes", "有缺陷"],
      e,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("defect");
  });
});
