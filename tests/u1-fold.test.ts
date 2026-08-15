/**
 * u1 单测：fold 投影 + deriveStatus 语义状态派生（表驱动）。
 *
 * 对应验收文档「单测验收」第 1-5 条；另含 fold 输入域守护（孤儿 / 重复 UnitCreated）
 * 与「最后一条 pass VerifyRan」取用语义的锁定用例。
 */
import { describe, expect, it } from "vitest";

import { deriveStatus, fold } from "../src/core/fold.js";
import type {
  EventPayloadMap,
  EventType,
  LedgerEvent,
  SequencedProjection,
  SpecGate,
  SpecRulesResult,
} from "../src/events/types.js";

// ── 事件构造器（显式 seq，模拟账本顺序） ──────────────────────

const TS_BASE_MS = Date.parse("2026-08-15T00:00:00.000Z");

function makeEvent<K extends EventType>(
  seq: number,
  type: K,
  payload: EventPayloadMap[K],
): LedgerEvent {
  return { seq, ts: new Date(TS_BASE_MS + seq * 1000).toISOString(), type, payload };
}

function createdEvent(seq: number, unitId: string): LedgerEvent {
  return makeEvent(seq, "UnitCreated", {
    unitId,
    parentId: null,
    briefRef: "docs/brief.md",
  });
}

function specEvent(
  seq: number,
  unitId: string,
  specHash: string,
  acceptanceIds: string[],
): LedgerEvent {
  return makeEvent(seq, "SpecSubmitted", {
    unitId,
    specHash,
    acceptance: acceptanceIds.map((id) => ({
      id,
      core: true,
      title: `验收 ${id}`,
      type: "e2e-real",
      command: `npm test -- ${id}`,
    })),
    contracts: [],
    split: [],
  });
}

function specVerdictEvent(
  seq: number,
  unitId: string,
  verdict: "pass" | "fail",
): LedgerEvent {
  return makeEvent(seq, "VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict });
}

function execVerdictEvent(
  seq: number,
  unitId: string,
  verdict: "pass" | "fail",
): LedgerEvent {
  return makeEvent(seq, "VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict });
}

function evidenceEvent(seq: number, unitId: string, runId: string): LedgerEvent {
  return makeEvent(seq, "EvidenceSubmitted", {
    unitId,
    runId,
    commit: "c0ffee",
    paths: ["report.json"],
    sha256: ["deadbeef"],
    exitCode: 0,
  });
}

function verifyEvent(
  seq: number,
  unitId: string,
  runId: string,
  result: "pass" | "fail",
  acceptanceIds: string[],
): LedgerEvent {
  return makeEvent(seq, "VerifyRan", {
    unitId,
    runId,
    reportHash: "rh1",
    result,
    acceptanceIds,
  });
}

function unitOf(proj: SequencedProjection, unitId: string) {
  const unit = proj.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`投影中缺少 unit "${unitId}"`);
  }
  return unit;
}

// ── gate 注入 ─────────────────────────────────────────────────

const gatePass: SpecGate = () => ({ ok: true, failures: [] });
const gateFail: SpecGate = () => ({
  ok: false,
  failures: ["A1: 核心 case 缺 e2e 级机器验证"],
});
function gateOnlyHash(hash: string): SpecGate {
  return (spec): SpecRulesResult =>
    spec.specHash === hash
      ? { ok: true, failures: [] }
      : { ok: false, failures: [`${spec.specHash}: 不满足 gate（只认 ${hash}）`] };
}

// ── 用例 ──────────────────────────────────────────────────────

/** 验收 1：合法完整生命周期序列 */
const fullLifecycle: LedgerEvent[] = [
  createdEvent(1, "u-1"),
  specEvent(2, "u-1", "h1", ["A1", "A2"]),
  specVerdictEvent(3, "u-1", "pass"),
  evidenceEvent(4, "u-1", "run-1"),
  verifyEvent(5, "u-1", "run-1", "pass", ["A1", "A2"]),
  execVerdictEvent(6, "u-1", "pass"),
];

describe("fold + deriveStatus（验收 1-5）", () => {
  it("验收1：合法完整序列（created→spec→verdict→evidence→verify 全覆盖→exec verdict）→ closed", () => {
    const proj = fold(fullLifecycle);
    expect(proj.totalEvents).toBe(6);
    expect(proj.units.size).toBe(1);
    expect(deriveStatus(unitOf(proj, "u-1"), gatePass)).toBe("closed");
  });

  it("验收2：spec 提交两次 → specs 长度 2，deriveStatus 只认最后一条", () => {
    const events = [
      createdEvent(1, "u-1"),
      specEvent(2, "u-1", "spec-v1", ["A1"]),
      specVerdictEvent(3, "u-1", "pass"),
      specEvent(4, "u-1", "spec-v2", ["A1", "A2"]),
    ];
    const proj = fold(events);
    expect(unitOf(proj, "u-1").specs).toHaveLength(2);

    // gate 只放行旧 spec（v1）→ 当前生效的是 v2 → 停 created
    expect(deriveStatus(unitOf(proj, "u-1"), gateOnlyHash("spec-v1"))).toBe("created");

    // 重新提交 spec = 打回重审：v2 过 gate 但 v1 时代的 pass verdict 在 v2 之前，不计数
    expect(deriveStatus(unitOf(proj, "u-1"), gateOnlyHash("spec-v2"))).toBe("created");

    // v2 之后出现新的 spec-review pass → 可冻结
    const reReviewed = fold([...events, specVerdictEvent(5, "u-1", "pass")]);
    expect(deriveStatus(unitOf(reReviewed, "u-1"), gateOnlyHash("spec-v2"))).toBe("spec-frozen");
  });

  it("验收3：verify 覆盖不全（acceptanceIds 缺 A2）→ 停留 spec-frozen 而非 verified", () => {
    const events = [
      createdEvent(1, "u-1"),
      specEvent(2, "u-1", "h1", ["A1", "A2"]),
      specVerdictEvent(3, "u-1", "pass"),
      evidenceEvent(4, "u-1", "run-1"),
      verifyEvent(5, "u-1", "run-1", "pass", ["A1"]),
    ];
    expect(deriveStatus(unitOf(fold(events), "u-1"), gatePass)).toBe("spec-frozen");
  });

  it("验收4：replay 幂等——同一事件数组 fold 两次，两次结果 deep-equal", () => {
    expect(fold(fullLifecycle)).toEqual(fold(fullLifecycle));
  });

  it("验收5：deriveStatus 注入 gate——gate fail 停 created；同事件换 pass gate 可 spec-frozen", () => {
    const events = [
      createdEvent(1, "u-1"),
      specEvent(2, "u-1", "h1", ["A1"]),
      specVerdictEvent(3, "u-1", "pass"),
    ];
    const unit = unitOf(fold(events), "u-1");
    expect(deriveStatus(unit, gateFail)).toBe("created");
    expect(deriveStatus(unit, gatePass)).toBe("spec-frozen");
  });
});

describe("fold 投影细节与输入域守护", () => {
  it("空事件流 → 空投影", () => {
    const proj = fold([]);
    expect(proj.units.size).toBe(0);
    expect(proj.totalEvents).toBe(0);
  });

  it("投影记录 unit 基本字段，evidence/verify 按序入各自数组", () => {
    const proj = fold(fullLifecycle);
    const unit = unitOf(proj, "u-1");
    expect(unit.parentId).toBeNull();
    expect(unit.briefRef).toBe("docs/brief.md");
    expect(unit.evidences.map((e) => e.runId)).toEqual(["run-1"]);
    expect(unit.verifyRuns.map((v) => v.result)).toEqual(["pass"]);
    expect(unit.verdicts.map((v) => v.verdictKind)).toEqual(["spec-review", "exec-review"]);
  });

  it("孤儿事件（unit 未 create）抛错，不静默跳过", () => {
    const orphan = specEvent(1, "u-ghost", "h1", ["A1"]);
    expect(() => fold([orphan])).toThrow(/u-ghost/);
    expect(() => fold([orphan])).toThrow(/孤儿/);
  });

  it("重复 UnitCreated 抛错", () => {
    const events = [createdEvent(1, "u-1"), createdEvent(2, "u-1")];
    expect(() => fold(events)).toThrow(/重复的 UnitCreated/);
  });
});

describe("deriveStatus 边界语义锁定", () => {
  it("verified 判定取最后一条 pass 的 VerifyRan：后续部分覆盖的 pass 会拉回 spec-frozen", () => {
    const events = [
      createdEvent(1, "u-1"),
      specEvent(2, "u-1", "h1", ["A1", "A2"]),
      specVerdictEvent(3, "u-1", "pass"),
      evidenceEvent(4, "u-1", "run-1"),
      verifyEvent(5, "u-1", "run-1", "pass", ["A1", "A2"]),
      evidenceEvent(6, "u-1", "run-2"),
      verifyEvent(7, "u-1", "run-2", "pass", ["A1"]),
    ];
    expect(deriveStatus(unitOf(fold(events), "u-1"), gatePass)).toBe("spec-frozen");
  });

  it("exec-review fail → 停留 verified 而非 closed", () => {
    const events = [
      ...fullLifecycle.slice(0, 5),
      execVerdictEvent(6, "u-1", "fail"),
    ];
    expect(deriveStatus(unitOf(fold(events), "u-1"), gatePass)).toBe("verified");
  });

  it("spec-review verdict 为 fail → 不冻结（停 created）", () => {
    const events = [
      createdEvent(1, "u-1"),
      specEvent(2, "u-1", "h1", ["A1"]),
      specVerdictEvent(3, "u-1", "fail"),
    ];
    expect(deriveStatus(unitOf(fold(events), "u-1"), gatePass)).toBe("created");
  });
});
