/**
 * P1 性能探针：fold 对「数百事件规模」账本的单次耗时 < 50ms。
 *
 * 探针出处：development-plan-v2 §3 探针总表 P1（「fold 对数百事件规模账本单次
 * < 50ms」，验证层 L0 单测）。2026-08-18 plan 完成度审查 D10 实锤：P2-P8 均有
 * 实证锚点唯 P1 缺失（tests/ 全库无性能断言），本文件补落地。
 *
 * 「数百事件」口径：1 root + 8 叶的多 unit 树，root 分解在前、集成收尾在后；
 * 每叶 12 轮 spec 重提（前 11 轮 spec-review fail）+ 18 轮 verify 重试（前 17 轮
 * fail，每轮含 evidence）+ exec-review fail→pass。合计 510 条事件（≥500），
 * 五类事件全混合。
 *
 * 测量口径：performance.now() 实测；先预热 10 次再采样 30 次——冷启动的 JIT
 * 编译/模块加载不计入（探针测的是稳态单次成本，即真实使用中每条 cw 命令
 * 调用一次 fold 的开销）。断言取采样最大单次 < 50ms（比均值口径严：任一采样
 * 超限即失败，均值会掩盖抖动）。2026-08-18 本机（Apple Silicon arm64 /
 * Node 24）实测：mean=0.012ms / worst=0.034ms，阈值余量三个数量级以上。
 *
 * 事件构造辅助与 u1-fold.test.ts 同款形态。该文件的构造器未导出且不可 import
 * （测试文件互相 import 会在本文件重复注册对端全部用例），故按同构形态重建。
 */
import { describe, expect, it } from "vitest";

import { deriveStatus, deriveStatuses, fold } from "../src/core/fold.js";
import type {
  AcceptanceItem,
  EventPayloadMap,
  EventType,
  LedgerEvent,
  SpecGate,
  SpecSubmittedPayload,
} from "../src/events/types.js";

// ── 规模参数（「数百事件」口径的自证锚点，精确计数见「口径自证」用例） ──

const ROOT_ID = "root";
/** 树形态：1 root + 8 叶 */
const LEAF_COUNT = 8;
/** 每叶 spec 提交轮数：前 11 轮 spec-review fail（打回重提），末轮 pass 冻结 */
const SPEC_ROUNDS = 12;
/** 每叶 verify 轮数：前 17 轮 fail（每轮 evidence + verify），末轮 pass 全覆盖 */
const VERIFY_ROUNDS = 18;
const LEAF_ACCEPTANCE_IDS = ["A1", "A2", "A3"];
/** 探针口径下限：构造结果必须 ≥ 500 条（「数百事件」的机器化下界） */
const MIN_EVENTS = 500;
/** 预热次数：触发 JIT 编译与内联缓存热身，冷启动开销不计入采样 */
const WARMUP_RUNS = 10;
/** 采样次数：断言取其中的最大单次 */
const MEASURED_RUNS = 30;
/** P1 探针阈值（development-plan-v2 §3 探针总表原文） */
const FOLD_BUDGET_MS = 50;

// ── 事件构造（与 u1-fold.test.ts 同款形态） ──────────────────────

const TS_BASE_MS = Date.parse("2026-08-15T00:00:00.000Z");

function specPayload(
  unitId: string,
  specHash: string,
  acceptanceIds: readonly string[],
): SpecSubmittedPayload {
  const acceptance: AcceptanceItem[] = acceptanceIds.map((id) => ({
    id,
    core: true,
    title: `验收 ${id}`,
    type: "e2e-real",
    command: `npm test -- ${id}`,
  }));
  return { unitId, specHash, acceptance, contracts: [], split: [] };
}

function leafIds(): string[] {
  return Array.from({ length: LEAF_COUNT }, (_, i) => `leaf-${i + 1}`);
}

/**
 * 构造 510 条事件的完整账本流：root 分解（create + spec[split 8 叶] + spec-review
 * pass）→ 各叶完整生命周期（多轮 spec 重提 + 多轮 verify 重试 + exec fail→pass）
 * → root 集成收尾（evidence + verify 全覆盖 + exec-review pass）。
 * seq 由 push 闭包单调递增（模拟账本顺序），ts 与 u1 同款按 seq 递增。
 */
function buildLedger(): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  let seq = 0;
  const push = <K extends EventType>(type: K, payload: EventPayloadMap[K]): void => {
    seq += 1;
    events.push({ seq, ts: new Date(TS_BASE_MS + seq * 1000).toISOString(), type, payload });
  };

  push("UnitCreated", { unitId: ROOT_ID, parentId: null, briefRef: "docs/brief-root.md" });
  push("SpecSubmitted", {
    ...specPayload(ROOT_ID, "root-spec-v1", ["RA1", "RA2"]),
    // root spec 携带 8 叶分解（真实内部节点形态；fold 不消费 split，仅丰富事件形状）
    split: leafIds().map((unitId) => ({ unitId, briefRef: "docs/brief-leaf.md", dependsOn: [] })),
  });
  push("VerdictSubmitted", { unitId: ROOT_ID, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });

  for (const leafId of leafIds()) {
    push("UnitCreated", { unitId: leafId, parentId: ROOT_ID, briefRef: "docs/brief-leaf.md" });
    for (let round = 1; round <= SPEC_ROUNDS; round += 1) {
      push("SpecSubmitted", specPayload(leafId, `${leafId}-spec-v${round}`, LEAF_ACCEPTANCE_IDS));
      push("VerdictSubmitted", {
        unitId: leafId,
        verdictKind: "spec-review",
        verdict: round === SPEC_ROUNDS ? "pass" : "fail",
        role: "reviewer",
      });
    }
    for (let round = 1; round <= VERIFY_ROUNDS; round += 1) {
      const last = round === VERIFY_ROUNDS;
      const runId = `${leafId}-run-${round}`;
      push("EvidenceSubmitted", {
        unitId: leafId,
        runId,
        commit: `commit-${leafId}-${round}`,
        paths: ["report.json"],
        sha256: ["deadbeef"],
        exitCode: last ? 0 : 1,
      });
      push("VerifyRan", {
        unitId: leafId,
        runId,
        reportHash: `report-${leafId}-${round}`,
        result: last ? "pass" : "fail",
        // fail run 无覆盖；末轮 pass 覆盖全部验收 id（verified 判定输入）
        acceptanceIds: last ? [...LEAF_ACCEPTANCE_IDS] : [],
      });
    }
    push("VerdictSubmitted", { unitId: leafId, verdictKind: "exec-review", verdict: "fail" });
    push("VerdictSubmitted", { unitId: leafId, verdictKind: "exec-review", verdict: "pass" });
  }

  push("EvidenceSubmitted", {
    unitId: ROOT_ID,
    runId: "root-run-1",
    commit: "commit-root",
    paths: ["report.json"],
    sha256: ["deadbeef"],
    exitCode: 0,
  });
  push("VerifyRan", {
    unitId: ROOT_ID,
    runId: "root-run-1",
    reportHash: "report-root",
    result: "pass",
    acceptanceIds: ["RA1", "RA2"],
  });
  push("VerdictSubmitted", { unitId: ROOT_ID, verdictKind: "exec-review", verdict: "pass" });

  return events;
}

const gatePass: SpecGate = () => ({ ok: true, failures: [] });

// ── 用例 ──────────────────────────────────────────────────────

describe("P1 性能探针：数百事件规模账本 fold", () => {
  const events = buildLedger();

  it("口径自证：510 条事件（≥500）、9 个 unit、五类事件按构造公式精确对账", () => {
    expect(events.length).toBeGreaterThanOrEqual(MIN_EVENTS);
    // UnitCreated 9（1 root + 8 叶）；SpecSubmitted 97（root 1 + 8×12）；
    // VerdictSubmitted 114（root 2 + 8×(12 spec-review + 2 exec)）；
    // Evidence/Verify 各 145（root 1 + 8×18）；合计 510
    expect(events.length).toBe(510);

    const typeCounts = new Map<EventType, number>();
    for (const event of events) {
      typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1);
    }
    expect(typeCounts.get("UnitCreated")).toBe(9);
    expect(typeCounts.get("SpecSubmitted")).toBe(97);
    expect(typeCounts.get("VerdictSubmitted")).toBe(114);
    expect(typeCounts.get("EvidenceSubmitted")).toBe(145);
    expect(typeCounts.get("VerifyRan")).toBe(145);
  });

  it("投影正确性：root 与 8 叶全部 closed（单 unit 口径与树感知口径一致）", () => {
    const proj = fold(events);
    expect(proj.totalEvents).toBe(events.length);
    expect(proj.units.size).toBe(LEAF_COUNT + 1);

    for (const [unitId, unit] of proj.units) {
      expect(unit.parentId).toBe(unitId === ROOT_ID ? null : ROOT_ID);
      if (unitId === ROOT_ID) {
        expect(unit.specs).toHaveLength(1);
        expect(unit.verdicts).toHaveLength(2);
        expect(unit.verifyRuns).toHaveLength(1);
      } else {
        // 多轮重试全部入账（fold 无丢失）+ exec fail→pass 两条 verdict
        expect(unit.specs).toHaveLength(SPEC_ROUNDS);
        expect(unit.verdicts).toHaveLength(SPEC_ROUNDS + 2);
        expect(unit.evidences).toHaveLength(VERIFY_ROUNDS);
        expect(unit.verifyRuns).toHaveLength(VERIFY_ROUNDS);
      }
      // 单 unit 口径：末轮 spec 过 gate ∧ 末轮 verify 全覆盖 ∧ exec pass → closed
      expect(deriveStatus(unit, gatePass)).toBe("closed");
    }

    // 树感知：8 叶全 closed → root 也 closed（canon D2 closed 公式）
    const statuses = deriveStatuses(proj.units, gatePass);
    expect(statuses.get(ROOT_ID)).toBe("closed");
    for (const leafId of leafIds()) {
      expect(statuses.get(leafId)).toBe("closed");
    }
  });

  it("P1 探针：预热后单次 fold < 50ms（采样最大单次口径，冷启动 JIT 不计入）", () => {
    // 预热：JIT 编译 + 内联缓存热身。探针测稳态单次成本，首次调用的编译
    // 开销与模块加载不属于稳态，不计入采样。
    for (let i = 0; i < WARMUP_RUNS; i += 1) {
      fold(events);
    }

    const durations: number[] = [];
    for (let i = 0; i < MEASURED_RUNS; i += 1) {
      const start = performance.now();
      const proj = fold(events);
      durations.push(performance.now() - start);
      // 消费投影防死代码消除（V8 不会消除有 observable 分支的调用，此处双保险）
      expect(proj.totalEvents).toBe(events.length);
    }

    const worst = Math.max(...durations);
    const mean = durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
    // 实测数据进测试输出，便于阈值余量追踪（2026-08-18 本机实测见文件头）
    console.log(
      `[P1] ${events.length} events × ${MEASURED_RUNS} runs: mean=${mean.toFixed(3)}ms worst=${worst.toFixed(3)}ms`,
    );
    expect(worst).toBeLessThan(FOLD_BUDGET_MS);
  });
});
