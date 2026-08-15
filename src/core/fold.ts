/**
 * fold 投影与语义状态派生（canon §3.3 D2：status = fold(events)，纯函数）。
 *
 * fold 把 LedgerEvent[] 折叠为 SequencedProjection；同一事件数组折叠两次结果
 * deep-equal（replay 幂等）。输入域 = 账本可能产生的事件序列；违反账本不变式的
 * 序列（孤儿事件、重复 UnitCreated）抛错而非静默跳过——append 侧已拒绝这两类，
 * fold 再见到即事件流被外部改动，静默跳过会把损坏伪装成正常投影。
 *
 * deriveStatus（proj 为 fold 输出 Projection.units 中该 unit 的投影）：
 *   - created     = UnitCreated 存在（unit 投影存在即存在）
 *   - spec-frozen = 最后一条 spec 过 specGate ∧ 该 spec 之后存在 verdictKind=spec-review
 *                   且 verdict=pass 的 VerdictSubmitted（重新提交 spec = 打回重审，
 *                   新 spec 之前的旧 pass verdict 不计数）
 *   - verified    = spec-frozen ∧ 最后一条 result=pass 的 VerifyRan.acceptanceIds
 *                   ⊇ 当前 spec 全部验收 id
 *   - closed      = verified ∧ 存在 verdictKind=exec-review 且 verdict=pass
 *
 * specGate 为注入依赖（u3 的五规则实现）；fold/deriveStatus 不实现规则本身。
 */
import type {
  DiscriminatedEvent,
  LedgerEvent,
  SequencedProjection,
  SequencedUnitProjection,
  SpecGate,
  UnitStatus,
} from "../events/types.js";

/** 折叠事件流为账本投影（纯函数；见模块头对输入域的约定）。 */
export function fold(events: readonly LedgerEvent[]): SequencedProjection {
  const units = new Map<string, SequencedUnitProjection>();
  for (const record of events) {
    // 宽泛的泛型信封 type 与 payload 不联动，判别联合视图才能按 type 窄化
    const event = record as DiscriminatedEvent;

    if (event.type === "UnitCreated") {
      if (units.has(event.payload.unitId)) {
        throw new Error(
          `fold: 重复的 UnitCreated（unit "${event.payload.unitId}"，seq ${event.seq}）。账本 append 侧已拒绝重复创建；请核对事件流是否被外部改动。`,
        );
      }
      units.set(event.payload.unitId, {
        unitId: event.payload.unitId,
        parentId: event.payload.parentId,
        briefRef: event.payload.briefRef,
        specs: [],
        verdicts: [],
        evidences: [],
        verifyRuns: [],
        lastSpecSeq: null,
        verdictSeqs: [],
      });
      continue;
    }

    const unit = units.get(event.payload.unitId);
    if (unit === undefined) {
      throw new Error(
        `fold: 孤儿事件 ${event.type}（unit "${event.payload.unitId}" 不存在，seq ${event.seq}）。账本 append 侧已拒绝孤儿事件；请核对事件流是否被外部改动。`,
      );
    }
    switch (event.type) {
      case "SpecSubmitted":
        unit.specs.push(event.payload);
        unit.lastSpecSeq = event.seq;
        break;
      case "VerdictSubmitted":
        unit.verdicts.push(event.payload);
        unit.verdictSeqs.push(event.seq);
        break;
      case "EvidenceSubmitted":
        unit.evidences.push(event.payload);
        break;
      case "VerifyRan":
        unit.verifyRuns.push(event.payload);
        break;
      default: {
        const _exhaustive: never = event;
        throw new Error(`fold: 未知事件类型：${String(_exhaustive)}`);
      }
    }
  }
  return { units, totalEvents: events.length };
}

/** 从 unit 投影派生语义状态（四态：created → spec-frozen → verified → closed）。 */
export function deriveStatus(
  proj: SequencedUnitProjection,
  specGate: SpecGate,
): UnitStatus {
  const lastSpecSeq = proj.lastSpecSeq;
  if (proj.specs.length === 0 || lastSpecSeq === null) {
    return "created";
  }
  const spec = proj.specs[proj.specs.length - 1];

  // spec-frozen：最后一条 spec 过 gate ∧ 它之后有 spec-review pass verdict
  const specFrozen =
    specGate(spec).ok &&
    proj.verdicts.some(
      (verdict, i) =>
        proj.verdictSeqs[i] > lastSpecSeq &&
        verdict.verdictKind === "spec-review" &&
        verdict.verdict === "pass",
    );
  if (!specFrozen) {
    return "created";
  }

  // verified：最后一条 pass 的 VerifyRan 覆盖当前 spec 全部验收 id
  const requiredIds = spec.acceptance.map((item) => item.id);
  const lastPassRun = [...proj.verifyRuns]
    .reverse()
    .find((run) => run.result === "pass");
  if (lastPassRun === undefined) {
    return "spec-frozen";
  }
  const allCovered = requiredIds.every((id) => lastPassRun.acceptanceIds.includes(id));
  if (!allCovered) {
    return "spec-frozen";
  }

  // closed：verified ∧ exec-review pass verdict（按验收文档，此处不要求顺序）
  const execPassed = proj.verdicts.some(
    (verdict) => verdict.verdictKind === "exec-review" && verdict.verdict === "pass",
  );
  return execPassed ? "closed" : "verified";
}
