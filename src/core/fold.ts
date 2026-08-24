/**
 * fold 投影与语义状态派生（canon §3.3 D2：status = fold(events)，纯函数）。
 *
 * fold 把 LedgerEvent[] 折叠为投影；同一事件数组折叠两次结果 deep-equal（replay
 * 幂等）。输入域 = 账本可能产生的事件序列；违反账本不变式的序列（孤儿事件、重复
 * UnitCreated）抛错而非静默跳过——append 侧已拒绝这两类，fold 再见到即事件流被
 * 外部改动，静默跳过会把损坏伪装成正常投影。
 *
 * deriveStatus（proj 为 fold 输出 units 中该 unit 的投影）：
 *   - created     = UnitCreated 存在（unit 投影存在即存在）
 *   - spec-frozen = 最后一条 spec 过 specGate ∧ 该 spec 之后存在 verdictKind=spec-review
 *                   且 verdict=pass 且 role=reviewer 的 VerdictSubmitted（重新提交
 *                   spec = 打回重审，新 spec 之前的旧 pass verdict 不计数；mx-3 起
 *                   非 reviewer 的 spec-review verdict 不驱动转换）
 *   - verified    = spec-frozen ∧ 最后一条「seq 晚于当前 spec」的 pass VerifyRan
 *                   覆盖当前 spec 全部验收 id（时序收紧：重提 spec 后旧 pass run
 *                   不复用——验的必须是当前 spec）
 *   - closed      = verified ∧ 存在 verdictKind=exec-review 且 verdict=pass 的
 *                   VerdictSubmitted 且其 seq 晚于当前 spec（审的必须是当前 spec；
 *                   「closed 不可逆」的时序半边）
 *
 * 树感知口径（deriveStatusInTree 是唯一语义出处，deriveStatuses 只提供批量
 * 传播机制）：canon D2 的 closed 公式为「verified ∧ exec-review pass ∧（内部
 * 节点追加：子节点全 closed ∧ 集成 verify 通过）」。「集成 verify 通过」半边已
 * 并入 verified——集成通过即本 unit 有一条覆盖全部验收 id 的 pass VerifyRan，
 * 正是 verified 的判定输入，不重复设条件；「子节点全 closed」半边是单 unit
 * 投影物理上够不到的树结构信息，由 deriveStatusInTree 追加：closed 额外要求
 * 全部直接子节点（账本 parentId 口径）状态为 closed。叶子/无子 unit 两口径
 * 同构（deriveStatus 向后兼容保留）。
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

/**
 * VerifyRan 的顺序锚点（与 SequencedUnitProjection 的 verdictSeqs 同族）。
 *
 * 为什么需要：verified 时序判定（「最后一条 pass 的 VerifyRan 须晚于最后一条
 * SpecSubmitted」）无法从 verifyRuns 平行数组判定，由 fold 折叠时补记 seq。
 * SequencedUnitProjection 定义在共享契约层 types.ts（本模块无权追加字段），
 * 此处以结构超集承接——fold 的输出恒满足，所有按 SequencedProjection 消费
 * 的既有调用方不受影响。
 */
export interface VerifySequencedUnitProjection extends SequencedUnitProjection {
  /** 各 VerifyRan 的账本 seq，与 verifyRuns 一一对应（同为入账顺序） */
  verifyRunSeqs: number[];
}

/** fold 的返回类型：units 带 spec/verdict/verify 三类顺序锚点 */
export interface VerifySequencedProjection extends SequencedProjection {
  units: Map<string, VerifySequencedUnitProjection>;
}

/** 折叠事件流为账本投影（纯函数；见模块头对输入域的约定）。 */
export function fold(events: readonly LedgerEvent[]): VerifySequencedProjection {
  const units = new Map<string, VerifySequencedUnitProjection>();
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
        reflections: [],
        lastSpecSeq: null,
        verdictSeqs: [],
        verifyRunSeqs: [],
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
        unit.verifyRunSeqs.push(event.seq);
        break;
      // ph-i1 R4：纯记录，不驱动状态转换（旧账本无此事件 = 无反思，重放兼容）
      case "ReflectionRan":
        unit.reflections.push(event.payload);
        break;
      default: {
        const _exhaustive: never = event;
        throw new Error(
          `fold: 未知事件类型：${String(_exhaustive)}。若账本包含新版事件（ReflectionRan），请升级：npm i -g @zhushanwen/coding-workflow@latest`,
        );
      }
    }
  }
  return { units, totalEvents: events.length };
}

/** 从 unit 投影派生语义状态（单 unit 口径；四态公式见模块头）。 */
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
  // （mx-3：只消费 role === "reviewer" 的 verdict——入账层已拦截无 role/错 role 的
  // 新事件，此处是纵深第二层，兜住任何绕过入账层的路径（历史事件 / 手改账本）；
  // 非 reviewer 的 spec-review verdict 不驱动状态转换，防御性兼容不抛错）
  const specFrozen =
    specGate(spec).ok &&
    proj.verdicts.some(
      (verdict, i) =>
        proj.verdictSeqs[i] > lastSpecSeq &&
        verdict.verdictKind === "spec-review" &&
        verdict.verdict === "pass" &&
        verdict.role === "reviewer",
    );
  if (!specFrozen) {
    return "created";
  }

  // verified：最后一条「seq 晚于当前 spec」的 pass VerifyRan 覆盖全部验收 id
  // （时序收紧：手改账本插入新 spec 后，旧 pass run 因 seq 更小全部失效——
  // 不可能零新证据恢复 verified）。run seq 锚点由 fold 填充
  // （VerifySequencedUnitProjection.verifyRunSeqs）；参数保持 SequencedUnitProjection
  // 弱签名兼容既有调用方，手写投影对象缺锚点时按「无有效 pass run」保守降级
  const runSeqs: readonly number[] =
    (proj as VerifySequencedUnitProjection).verifyRunSeqs ?? [];
  const requiredIds = spec.acceptance.map((item) => item.id);
  const lastPassRun = [...proj.verifyRuns]
    .map((run, i) => ({ run, seq: runSeqs[i] }))
    .reverse()
    .find(({ run, seq }) => seq > lastSpecSeq && run.result === "pass");
  if (lastPassRun === undefined) {
    return "spec-frozen";
  }
  const allCovered = requiredIds.every((id) => lastPassRun.run.acceptanceIds.includes(id));
  if (!allCovered) {
    return "spec-frozen";
  }

  // closed：verified ∧ exec-review pass verdict 且其 seq 晚于当前 spec
  // （审的必须是当前 spec——零新证据恢复 closed 的另一半闸门）
  const execPassed = proj.verdicts.some(
    (verdict, i) =>
      proj.verdictSeqs[i] > lastSpecSeq &&
      verdict.verdictKind === "exec-review" &&
      verdict.verdict === "pass",
  );
  return execPassed ? "closed" : "verified";
}

/**
 * 树感知状态派生（canon D2 closed 公式的唯一权威实现）。
 *
 * 语义：单 unit 口径（deriveStatus）的结果上，closed 追加「全部直接子节点状态为
 * closed」（childStatuses 为空数组 = 叶子/无子，与 deriveStatus 同构）；其余状态
 * 原样返回——子条件只会把 closed 拉低到 verified，不会抬高。「集成 verify 通过」
 * 半边已并入 verified（见模块头），此处不重复设条件。孤儿 unit（parentId 指向
 * 不存在的 unit）不构成任何 unit 的子边，按根节点口径对待（无「作为子」的条件）。
 *
 * 接线：deriveStatuses 的初值与不动点每步重求值都经过本谓词（孩子传当前状态），
 * 树感知 closed 判定全库只此一处，无平行实现。
 */
export function deriveStatusInTree(
  unit: SequencedUnitProjection,
  childStatuses: readonly UnitStatus[],
  specGate: SpecGate,
): UnitStatus {
  const local = deriveStatus(unit, specGate);
  if (local !== "closed" || childStatuses.length === 0) {
    return local;
  }
  return childStatuses.every((status) => status === "closed") ? "closed" : "verified";
}

/**
 * 全投影的树感知状态集合（deriveStatusInTree 的批量形态，readonly 四命令与
 * runner 退出状态的唯一权威入口）。
 *
 * 语义单一出处：closed 的树感知判定全在 deriveStatusInTree，本函数只提供传播
 * 机制——初值 = 各 unit 的空孩子（叶子口径）状态，再按「以孩子当前状态重求值
 * 谓词」不动点迭代。传播只降不升（closed → verified，孩子状态一旦非 closed
 * 永不回升），必然终止；parentId 环（外部手改账本的产物，正常流程不可能——
 * create 只允许指向已存在 unit）不崩溃不死循环：环上节点互相确认，收敛到自洽
 * 不动点（如双方均 closed 时保持 closed，一方未 closed 时另一方被拉回 verified）。
 * 自底向上逐层求值与非环不动点结果一致（每轮至少沉淀一个「子已定」的节点）。
 */
export function deriveStatuses(
  units: ReadonlyMap<string, SequencedUnitProjection>,
  specGate: SpecGate,
): Map<string, UnitStatus> {
  const statuses = new Map<string, UnitStatus>();
  for (const unit of units.values()) {
    statuses.set(unit.unitId, deriveStatusInTree(unit, [], specGate));
  }
  // parentId → 直接子 unitId（孤儿边：parent 不在投影中时不会进入任何 childIds 值）
  const childIds = new Map<string, string[]>();
  for (const unit of units.values()) {
    if (unit.parentId === null) {
      continue;
    }
    const siblings = childIds.get(unit.parentId) ?? [];
    siblings.push(unit.unitId);
    childIds.set(unit.parentId, siblings);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of units.values()) {
      const current = statuses.get(unit.unitId);
      if (current !== "closed") {
        // 传播只降不升：谓词对非 closed 原样返回，重求值必得原值，剪枝跳过
        continue;
      }
      // 孩子 id 恒来自 units（childIds 由 units 收集），初值已填且从不删除，
      // statuses.get 恒有值；断言只收窄类型，不掩盖运行时可空
      const childStatuses = (childIds.get(unit.unitId) ?? []).map(
        (id) => statuses.get(id) as UnitStatus,
      );
      const next = deriveStatusInTree(unit, childStatuses, specGate);
      if (next !== current) {
        statuses.set(unit.unitId, next);
        changed = true;
      }
    }
  }
  return statuses;
}
