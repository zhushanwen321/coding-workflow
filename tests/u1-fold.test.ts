/**
 * u1 单测：fold 投影 + deriveStatus 语义状态派生（表驱动）。
 *
 * 对应验收文档「单测验收」第 1-5 条；另含 fold 输入域守护（孤儿 / 重复 UnitCreated）
 * 与「最后一条 pass VerifyRan」取用语义的锁定用例。
 */
import { describe, expect, it } from "vitest";

import { deriveStatus, deriveStatuses, deriveStatusInTree, fold } from "../src/core/fold.js";
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

function childCreatedEvent(seq: number, unitId: string, parentId: string): LedgerEvent {
  return makeEvent(seq, "UnitCreated", {
    unitId,
    parentId,
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

// ── 时序收紧：verified / closed 的证据必须晚于当前 spec ──────────

describe("时序收紧（closed 不可逆的 fold 半边）", () => {
  /** 完整链到 closed 后再插入新 SpecSubmitted（模拟手改账本，seq 更大） */
  function closedThenNewSpec(): LedgerEvent[] {
    return [
      ...fullLifecycle, // seq 1-6：u-1 完整链 closed（spec=2, verify pass=5, exec pass=6）
      specEvent(7, "u-1", "h2", ["A1", "A2"]),
    ];
  }

  it("closed 后插入新 spec（seq 更大）→ 旧 VerifyRan/旧 exec-review 全部失效，投影回 created", () => {
    expect(deriveStatus(unitOf(fold(closedThenNewSpec()), "u-1"), gatePass)).toBe("created");
  });

  it("新 spec 之后再补 spec-review pass（无新 verify）→ 只到 spec-frozen，旧 pass run 不复用", () => {
    const events = [...closedThenNewSpec(), specVerdictEvent(8, "u-1", "pass")];
    expect(deriveStatus(unitOf(fold(events), "u-1"), gatePass)).toBe("spec-frozen");
  });

  it("旧 verify pass 复用被拒后补新 verify → verified；旧 exec pass 仍不计数 → 非 closed", () => {
    const events = [
      ...closedThenNewSpec(),
      specVerdictEvent(8, "u-1", "pass"),
      verifyEvent(9, "u-1", "run-2", "pass", ["A1", "A2"]),
    ];
    // 新 verify 晚于新 spec → verified 恢复；但 closed 要求 exec-review pass 晚于
    // 新 spec（seq 6 的旧 pass 不计数）→ 停 verified
    expect(deriveStatus(unitOf(fold(events), "u-1"), gatePass)).toBe("verified");
  });

  it("新 exec-review pass（晚于新 spec）才重新 closed——零新证据不可能直达 closed", () => {
    const events = [
      ...closedThenNewSpec(),
      specVerdictEvent(8, "u-1", "pass"),
      verifyEvent(9, "u-1", "run-2", "pass", ["A1", "A2"]),
      execVerdictEvent(10, "u-1", "pass"),
    ];
    expect(deriveStatus(unitOf(fold(events), "u-1"), gatePass)).toBe("closed");
  });
});

// ── 树感知：内部节点 closed 的「子全 closed」条件 ────────────────

describe("deriveStatusInTree / deriveStatuses（树感知口径）", () => {
  /** root + 两子：root 自身完整链（单 unit 口径 closed）；child 状态由参数事件控制 */
  function treeEvents(childExtra: LedgerEvent[]): LedgerEvent[] {
    return [
      createdEvent(1, "root"),
      childCreatedEvent(2, "c-1", "root"),
      childCreatedEvent(3, "c-2", "root"),
      // root 完整链：spec → review pass → verify 全覆盖 → exec pass
      specEvent(4, "root", "hr", ["RA1"]),
      specVerdictEvent(5, "root", "pass"),
      verifyEvent(6, "root", "run-r", "pass", ["RA1"]),
      execVerdictEvent(7, "root", "pass"),
      // 两子各自完整链（c-1 全 closed；c-2 的收尾事件由 childExtra 决定）
      specEvent(8, "c-1", "h1", ["A1"]),
      specVerdictEvent(9, "c-1", "pass"),
      verifyEvent(10, "c-1", "run-1", "pass", ["A1"]),
      execVerdictEvent(11, "c-1", "pass"),
      specEvent(12, "c-2", "h2", ["A1"]),
      specVerdictEvent(13, "c-2", "pass"),
      verifyEvent(14, "c-2", "run-2", "pass", ["A1"]),
      ...childExtra,
    ];
  }

  it("内部节点：子未全 closed（c-2 停 verified）→ root 不 closed，压回 verified；单 unit 口径仍 closed（对照）", () => {
    const proj = fold(treeEvents([]));
    expect(deriveStatus(unitOf(proj, "root"), gatePass)).toBe("closed"); // 单 unit 口径
    expect(deriveStatuses(proj.units, gatePass).get("root")).toBe("verified"); // 树感知
    expect(deriveStatuses(proj.units, gatePass).get("c-1")).toBe("closed");
    expect(deriveStatuses(proj.units, gatePass).get("c-2")).toBe("verified");
  });

  it("子全 closed 后 root closed（序列推进：c-2 补 exec pass）", () => {
    const proj = fold(treeEvents([execVerdictEvent(15, "c-2", "pass")]));
    const statuses = deriveStatuses(proj.units, gatePass);
    expect(statuses.get("c-2")).toBe("closed");
    expect(statuses.get("root")).toBe("closed");
  });

  it("deriveStatusInTree 与 deriveStatuses 同口径：closed 追加子条件，其余状态原样", () => {
    const proj = fold(treeEvents([]));
    const root = unitOf(proj, "root");
    expect(deriveStatusInTree(root, [], gatePass)).toBe("closed"); // 无子参数 = 叶子语义
    expect(deriveStatusInTree(root, ["closed", "verified"], gatePass)).toBe("verified");
    expect(deriveStatusInTree(root, ["closed", "closed"], gatePass)).toBe("closed");
    // 非 closed 的单 unit 状态不被子条件抬高
    const c2 = unitOf(proj, "c-2");
    expect(deriveStatusInTree(c2, ["closed"], gatePass)).toBe("verified");
  });

  it("多层树传播：孙未 closed → 子不 closed → 根不 closed（逐层压回）", () => {
    const events = [
      createdEvent(1, "root"),
      childCreatedEvent(2, "mid", "root"),
      childCreatedEvent(3, "leaf", "mid"),
      specEvent(4, "root", "hr", ["RA1"]),
      specVerdictEvent(5, "root", "pass"),
      verifyEvent(6, "root", "run-r", "pass", ["RA1"]),
      execVerdictEvent(7, "root", "pass"),
      specEvent(8, "mid", "hm", ["A1"]),
      specVerdictEvent(9, "mid", "pass"),
      verifyEvent(10, "mid", "run-m", "pass", ["A1"]),
      execVerdictEvent(11, "mid", "pass"),
      specEvent(12, "leaf", "hl", ["A1"]),
      specVerdictEvent(13, "leaf", "pass"),
      verifyEvent(14, "leaf", "run-l", "pass", ["A1"]),
      // leaf 无 exec-review → verified；mid/root 逐层压回
    ];
    const statuses = deriveStatuses(fold(events).units, gatePass);
    expect(statuses.get("leaf")).toBe("verified");
    expect(statuses.get("mid")).toBe("verified");
    expect(statuses.get("root")).toBe("verified");
  });

  it("孤儿 unit（parent 不存在）按根节点对待：自身链闭合即 closed，防御不崩溃", () => {
    const events = [
      // 孤儿 root-orphan 的 parent u-ghost 不存在（外部手改账本产物）
      childCreatedEvent(1, "root-orphan", "u-ghost"),
      specEvent(2, "root-orphan", "ho", ["A1"]),
      specVerdictEvent(3, "root-orphan", "pass"),
      verifyEvent(4, "root-orphan", "run-o", "pass", ["A1"]),
      execVerdictEvent(5, "root-orphan", "pass"),
    ];
    const statuses = deriveStatuses(fold(events).units, gatePass);
    expect(statuses.get("root-orphan")).toBe("closed");
  });

  it("parentId 环（外部手改账本产物）：不崩溃不死循环，收敛到自洽不动点", () => {
    const events = [
      childCreatedEvent(1, "a", "b"),
      childCreatedEvent(2, "b", "a"),
      specEvent(3, "a", "ha", ["A1"]),
      specVerdictEvent(4, "a", "pass"),
      verifyEvent(5, "a", "run-a", "pass", ["A1"]),
      execVerdictEvent(6, "a", "pass"),
      specEvent(7, "b", "hb", ["A1"]),
      specVerdictEvent(8, "b", "pass"),
      verifyEvent(9, "b", "run-b", "pass", ["A1"]),
      execVerdictEvent(10, "b", "pass"),
    ];
    const statuses = deriveStatuses(fold(events).units, gatePass);
    // 双方均 closed 时环上互相确认，自洽保持 closed（防御目标 = 不崩溃不死循环，
    // 不是强行降级——环本身是外部改坏的数据，投影如实反映自洽状态）
    expect(statuses.get("a")).toBe("closed");
    expect(statuses.get("b")).toBe("closed");

    // 一方未收尾（b 无 exec-review）→ 另一方被拉回 verified
    const events2 = [
      childCreatedEvent(1, "a", "b"),
      childCreatedEvent(2, "b", "a"),
      specEvent(3, "a", "ha", ["A1"]),
      specVerdictEvent(4, "a", "pass"),
      verifyEvent(5, "a", "run-a", "pass", ["A1"]),
      execVerdictEvent(6, "a", "pass"),
      specEvent(7, "b", "hb", ["A1"]),
      specVerdictEvent(8, "b", "pass"),
      verifyEvent(9, "b", "run-b", "pass", ["A1"]),
    ];
    const statuses2 = deriveStatuses(fold(events2).units, gatePass);
    expect(statuses2.get("b")).toBe("verified");
    expect(statuses2.get("a")).toBe("verified");
  });
});
