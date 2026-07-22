/**
 * ExistenceVerificationStrategy 单测 —— topic 2: postDevVerify 抽取 + existence/review-only 策略。
 *
 * 覆盖 AC：
 *   - AC-1: Topic.existenceArtifacts 字段存在（间接由 isDevVerified/postDevVerify 消费验证）
 *   - AC-2: getShape('delete-only') 返回 existence 策略
 *   - postDevVerify 检查文件存在性（present/absent → VerifyResult）
 *   - isDevVerified 读 existenceArtifacts[].verified 缓存（不跑 IO）
 *   - preDevCheck 对合法/非法 existence.json 的判定
 *
 * 这是 TDD 红灯阶段：测试引用的 `getShape('delete-only')` / ExistenceStrategy /
 * `Topic.existenceArtifacts` / `applyPreDevResult` 都尚不存在，运行时必然 fail（红灯）。
 * 实现由后续 subagent 完成（src/shapes/existence-strategy.ts + registry + types 扩展）。
 *
 * 测试规范（AGENTS.md）：
 *   - 零 mock 框架：真实 tmp 目录做 existsSync 验证
 *   - 禁 any：用具体接口形状 + 字面量联合
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getShape } from "../src/legacy/shapes/registry.js";
import type { Topic } from "../src/legacy/types.js";

// ── 测试夹具 ────────────────────────────────────────────────

let tmpWorkspace: string;

beforeEach(() => {
  // 真实 tmp 目录作为 workspacePath（postDevVerify 的 existsSync 需要真实路径）。
  tmpWorkspace = mkdtempSync(join(tmpdir(), "cw-existence-"));
});

afterEach(() => {
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

/**
 * 构造最小 topic（含 existence 策略需要的 workspacePath + existenceArtifacts）。
 * 用 Partial<Topic> + 强转避免补全所有必填字段——这里只测 existence 策略用到的字段。
 */
function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    topicId: "cw-existence-test",
    slug: "existence-test",
    objective: "test existence strategy",
    workspacePath: tmpWorkspace,
    topicDir: join(tmpWorkspace, ".xyz-harness", "existence-test"),
    createdAt: "2026-07-17T00:00:00.000Z",
    status: "created",
    taskShape: "delete-only" as Topic["taskShape"],
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

// ── AC-2: getShape('delete-only') 返回 existence 策略 ────────

describe("ExistenceVerificationStrategy 注册（AC-2）", () => {
  it("getShape('delete-only') 返回 shape，id='delete-only'", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    expect(shape.id).toBe("delete-only");
  });

  it("delete-only shape 含 verification 策略（id='existence'）", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    expect(shape.verification).toBeDefined();
    expect(shape.verification.id).toBe("existence");
    // 五个核心方法都是函数（含新增的 applyPreDevResult）
    expect(typeof shape.verification.preDevCheck).toBe("function");
    expect(typeof shape.verification.postDevVerify).toBe("function");
    expect(typeof shape.verification.replanGuard).toBe("function");
    expect(typeof shape.verification.isDevVerified).toBe("function");
    expect(typeof shape.verification.applyPreDevResult).toBe("function");
  });

  it("delete-only shape 含 review 策略（id='lean-review'）", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    expect(shape.review).toBeDefined();
    expect(shape.review.id).toBe("lean-review");
  });
});

// ── AC-1: preDevCheck 对合法/非法 existence.json 的判定 ──────

describe("ExistenceStrategy.preDevCheck（AC-1）", () => {
  it("合法 existence.json（含 artifacts，expectedState 合法）→ pass + parsed defined", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic();
    const payload = {
      artifacts: [
        { path: "src/old.ts", expectedState: "absent" },
        { path: "docs/readme.md", expectedState: "present" },
      ],
    };

    const result = shape.verification.preDevCheck(topic, payload);

    expect(result.result).toBe("pass");
    expect(result.parsed).toBeDefined();
  });

  it("空 artifacts → fail（至少需要 1 个 artifact）", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic();
    const result = shape.verification.preDevCheck(topic, { artifacts: [] });

    expect(result.result).toBe("fail");
  });

  it("非法 expectedState（非 present/absent）→ fail", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic();
    const result = shape.verification.preDevCheck(topic, {
      artifacts: [{ path: "x.ts", expectedState: "maybe" }],
    });

    expect(result.result).toBe("fail");
  });

  it("缺 artifacts 字段 → fail", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic();
    const result = shape.verification.preDevCheck(topic, {});

    expect(result.result).toBe("fail");
  });

  it("artifact.path 为空字符串 → fail", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic();
    const result = shape.verification.preDevCheck(topic, {
      artifacts: [{ path: "", expectedState: "absent" }],
    });

    expect(result.result).toBe("fail");
  });
});

// ── isDevVerified：读 existenceArtifacts[].verified 缓存 ─────

describe("ExistenceStrategy.isDevVerified（读 verified 缓存，不跑 IO）", () => {
  it("全 verified=true 的 existenceArtifacts → true", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [
        { path: "a.ts", expectedState: "absent", verified: true },
        { path: "b.ts", expectedState: "present", verified: true },
      ],
    } as Partial<Topic>);

    expect(shape.verification.isDevVerified(topic)).toBe(true);
  });

  it("含 verified=false → false", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [
        { path: "a.ts", expectedState: "absent", verified: true },
        { path: "b.ts", expectedState: "present", verified: false },
      ],
    } as Partial<Topic>);

    expect(shape.verification.isDevVerified(topic)).toBe(false);
  });

  it("verified=undefined（未跑 postDevVerify）→ false", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [{ path: "a.ts", expectedState: "absent" }],
    } as Partial<Topic>);

    expect(shape.verification.isDevVerified(topic)).toBe(false);
  });

  it("空 existenceArtifacts → false（未声明产物 = 未验证）", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [],
    } as Partial<Topic>);

    expect(shape.verification.isDevVerified(topic)).toBe(false);
  });

  it("无 existenceArtifacts 字段 → false（兼容 tdd_plan 前状态）", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic();

    expect(shape.verification.isDevVerified(topic)).toBe(false);
  });
});

// ── postDevVerify：真实 tmp 目录 existsSync 检查 ─────────────

describe("ExistenceStrategy.postDevVerify（真实 tmp 目录 existsSync）", () => {
  it("absent 文件已删除 + present 文件存在 → 全 passed", () => {
    // 准备 tmp workspace：present 文件创建，absent 文件不创建
    mkdirSync(join(tmpWorkspace, "src"), { recursive: true });
    writeFileSync(join(tmpWorkspace, "src", "keep.ts"), "export const x = 1;");
    // absent 文件 src/old.ts 不创建（已删除状态）

    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [
        { path: "src/old.ts", expectedState: "absent" },
        { path: "src/keep.ts", expectedState: "present" },
      ],
    } as Partial<Topic>);

    const results = shape.verification.postDevVerify(topic);

    expect(results).toHaveLength(2);
    // 每个 caseId 应能锁定到对应 artifact（用 path 作 caseId 语义）
    const byPath = new Map(results.map((r) => [r.caseId, r.passed]));
    // absent: 文件不存在 → 符合 absent 期望 → passed
    expect(byPath.get("src/old.ts")).toBe(true);
    // present: 文件存在 → 符合 present 期望 → passed
    expect(byPath.get("src/keep.ts")).toBe(true);
  });

  it("absent 文件仍存在（未删干净）→ passed=false", () => {
    // absent 文件仍存在（agent 没删干净）
    mkdirSync(join(tmpWorkspace, "src"), { recursive: true });
    writeFileSync(join(tmpWorkspace, "src", "old.ts"), "should be deleted");

    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [{ path: "src/old.ts", expectedState: "absent" }],
    } as Partial<Topic>);

    const results = shape.verification.postDevVerify(topic);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].failureReason).toBeDefined();
  });

  it("present 文件缺失（被误删）→ passed=false", () => {
    // present 文件不存在（不应删的被删了）
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [{ path: "src/keep.ts", expectedState: "present" }],
    } as Partial<Topic>);

    const results = shape.verification.postDevVerify(topic);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].failureReason).toBeDefined();
  });

  it("空 existenceArtifacts → 返回空数组（无产物可验证）", () => {
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [],
    } as Partial<Topic>);

    const results = shape.verification.postDevVerify(topic);
    expect(results).toEqual([]);
  });

  it("返回的 VerifyResult 含 actual（供 report 渲染 + verified 缓存写回）", () => {
    mkdirSync(join(tmpWorkspace, "src"), { recursive: true });
    writeFileSync(join(tmpWorkspace, "src", "keep.ts"), "x");

    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [{ path: "src/keep.ts", expectedState: "present" }],
    } as Partial<Topic>);

    const results = shape.verification.postDevVerify(topic);

    expect(results).toHaveLength(1);
    // actual 含 exists 布尔（供 handleTest 缓存到 existenceArtifacts[].verified）
    expect(results[0].actual).toBeDefined();
  });

  it("postDevVerify 本身只读不改 topic（verified 缓存由 handleTest 写回）", () => {
    // 验证 postDevVerify 是纯查询：调完后 topic.existenceArtifacts 不变
    mkdirSync(join(tmpWorkspace, "src"), { recursive: true });
    writeFileSync(join(tmpWorkspace, "src", "keep.ts"), "x");

    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [
        { path: "src/keep.ts", expectedState: "present" },
      ],
    } as Partial<Topic>);

    const before = JSON.parse(JSON.stringify(topic.existenceArtifacts));
    shape.verification.postDevVerify(topic);
    const after = JSON.parse(JSON.stringify(topic.existenceArtifacts));

    expect(after).toEqual(before);
  });
});

// ── applyPreDevResult：把 parsed existence.json 写入 topic.existenceArtifacts ──

describe("ExistenceStrategy.applyPreDevResult（写 existenceArtifacts）", () => {
  it("applyPreDevResult 把 parsed.artifacts 写入 store（existenceArtifacts 可读出）", () => {
    // applyPreDevResult 签名预期：(topicId, store, parsed) => void
    // 这里用一个最小 fake store 捕获 setExistenceArtifacts 调用。
    // 注意：红灯阶段 applyPreDevResult 尚不存在，这个测试必然 fail。
    const shape = getShape("delete-only" as Topic["taskShape"]);
    const captured: { topicId: string; artifacts: unknown } | null = {
      topicId: "",
      artifacts: null,
    };
    const fakeStore = {
      setExistenceArtifacts: (topicId: string, artifacts: unknown) => {
        captured.topicId = topicId;
        captured.artifacts = artifacts;
      },
    };

    const parsed = {
      artifacts: [{ path: "src/old.ts", expectedState: "absent" }],
    };

    expect(() =>
      shape.verification.applyPreDevResult(
        "cw-1",
        fakeStore as never,
        parsed,
      ),
    ).not.toThrow();

    expect(captured.topicId).toBe("cw-1");
    expect(captured.artifacts).toEqual(parsed.artifacts);
  });
});

// ── 兜底：确认 isDevVerified 不跑 IO（不依赖文件系统状态）────

describe("isDevVerified 纯缓存读取（不跑 existsSync）", () => {
  it("verified=true 但文件实际不存在 → 仍 true（信缓存，不信 IO）", () => {
    // 文件不存在（tmpWorkspace 是空目录），但缓存说 verified=true
    expect(existsSync(join(tmpWorkspace, "ghost.ts"))).toBe(false);

    const shape = getShape("delete-only" as Topic["taskShape"]);
    const topic = makeTopic({
      existenceArtifacts: [
        { path: "ghost.ts", expectedState: "absent", verified: true },
      ],
    } as Partial<Topic>);

    // isDevVerified 应信缓存 verified=true，不跑 existsSync → 仍 true
    expect(shape.verification.isDevVerified(topic)).toBe(true);
  });
});

// ── replanGuard（P1 补测：5 场景） ────────────────────────

describe("ExistenceStrategy.replanGuard（P1：契约篡改检测 + 空 payload 降级）", () => {
  const shape = getShape("delete-only");
  const verification = shape.verification;

  /** 构造带 verified artifacts 的 topic。 */
  function makeTopicWithVerified(
    artifacts: Array<{ path: string; expectedState: "present" | "absent"; verified?: boolean }>,
  ): Topic {
    return {
      ...makeTopic({ taskShape: "delete-only" as Topic["taskShape"] }),
      existenceArtifacts: artifacts,
    };
  }

  it("P0: payload 不含 artifacts（dev-plan.json 格式）→ 降级 no-op，无违规", () => {
    const topic = makeTopicWithVerified([
      { path: "src/old.ts", expectedState: "absent", verified: true },
    ]);
    // dev-plan.json 格式，无 artifacts 键
    const payload = { format: "lite", objective: "x", waves: [] };
    const violations = verification.replanGuard(topic, payload);
    expect(violations).toEqual([]);
  });

  it("P0: payload 为空对象 → 降级 no-op", () => {
    const topic = makeTopicWithVerified([
      { path: "src/old.ts", expectedState: "absent", verified: true },
    ]);
    expect(verification.replanGuard(topic, {})).toEqual([]);
  });

  it("payload 含完整 artifacts 且无篡改 → 无违规", () => {
    const topic = makeTopicWithVerified([
      { path: "src/a.ts", expectedState: "absent", verified: true },
      { path: "src/b.ts", expectedState: "present", verified: true },
    ]);
    // 新清单与旧清单完全一致
    const payload = {
      artifacts: [
        { path: "src/a.ts", expectedState: "absent" },
        { path: "src/b.ts", expectedState: "present" },
      ],
    };
    expect(verification.replanGuard(topic, payload)).toEqual([]);
  });

  it("篡改 verified artifact 的 expectedState → existence_artifact_state_changed", () => {
    const topic = makeTopicWithVerified([
      { path: "src/legacy.ts", expectedState: "absent", verified: true },
    ]);
    // 把 absent 改成 present（篡改契约）
    const payload = {
      artifacts: [{ path: "src/legacy.ts", expectedState: "present" }],
    };
    const violations = verification.replanGuard(topic, payload);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.type).toBe("existence_artifact_state_changed");
    expect(violations[0]!.caseId).toBe("src/legacy.ts");
  });

  it("移除 verified artifact（新清单不含）→ existence_artifact_removed", () => {
    const topic = makeTopicWithVerified([
      { path: "src/old-a.ts", expectedState: "absent", verified: true },
      { path: "src/old-b.ts", expectedState: "absent", verified: true },
    ]);
    // 新清单只保留 old-b（移除 old-a）
    const payload = {
      artifacts: [{ path: "src/old-b.ts", expectedState: "absent" }],
    };
    const violations = verification.replanGuard(topic, payload);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.type).toBe("existence_artifact_removed");
    expect(violations[0]!.caseId).toBe("src/old-a.ts");
  });

  it("无 verified artifact → 短路返回空（不检查 payload）", () => {
    const topic = makeTopicWithVerified([
      { path: "src/new.ts", expectedState: "absent" }, // verified 未设（undefined）
    ]);
    // 即使 payload 完全不匹配，无 verified artifact 也不报违规
    expect(verification.replanGuard(topic, { artifacts: [] })).toEqual([]);
  });

  it("未 verified 的 artifact 被篡改 → 不报违规（只保护 verified）", () => {
    const topic = makeTopicWithVerified([
      { path: "src/unverified.ts", expectedState: "absent", verified: false },
    ]);
    const payload = {
      artifacts: [{ path: "src/unverified.ts", expectedState: "present" }],
    };
    // verified=false 的 artifact 不受保护——可以自由修改
    expect(verification.replanGuard(topic, payload)).toEqual([]);
  });
});
