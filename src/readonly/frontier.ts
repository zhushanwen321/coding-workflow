/**
 * `cw frontier [--json]`：就绪集合视图；同时是 runner 派发就绪判定的单一出处。
 *
 * 全维度口径（fx1/fx2/fx3 修复前只有 specReady/buildReady 两维，且与 loop 自带的
 * 派发计算分叉——frontier 报 buildReady 的内部节点（spec-frozen 缺子）实际会被
 * loop 派 designer 补建子，A4「零上下文接手」场景输出与真实派发行为不一致。现
 * 派发就绪计算收口于此，loop 的 computeDispatchTargets 与本命令消费同一结果）：
 *   - specReady：created 且无 spec——待 designer 撰写 spec（首派）
 *   - reflectionPending：created 且有 spec，最新 SpecSubmitted 的 specHash 无对应
 *     ReflectionRan——待反思（ph-i1 R4：loop 对长驻 spawn 发 followUp，完成后写
 *     ReflectionRan 再派 reviewer；事件锚 = specHash，重提新 spec 即重新 pending）
 *   - specReviewPending：created 且有 spec，最后一条 SpecSubmitted 之后无任何
 *     spec-review verdict——待独立 reviewer 审查（mx-1：spec-review 的
 *     VerdictSubmitted 一律由 reviewer spawn 提交，designer 不自审）
 *   - specFixPending：created 且有 spec，最后一条 SpecSubmitted 之后最近的
 *     role=reviewer spec-review verdict 是 fail——待 designer 修 spec 重提
 *     （mx-1 MF1：fail 后的修复出口；fail verdict 的 comment 是任务书的失败事实
 *     来源；同代后续 fail 不改变本谓词——mx-3 按代计数后同代双 fail 仍是
 *     specFixPending 派 designer，不再误判 deadlock）
 *   - specReviewDeadlock：created 且本账本内该 unit 的 spec-review 打回代数 ≥ 阈值
 *     （默认 10；mx-4 起可经 computeFrontier opts.maxSpecRejects 注入运行策略值）
 *     （mx-3 语义迁移：从「fail 总数」改「打回代数」——同条 SpecSubmitted 之后
 *     多条 role=reviewer fail 只计 1 代；MF2 教训由代数累计保持：重提不清零，
 *     fail → 重提 → fail = 2 代 = deadlock）——防 ping-pong 活锁的转人工维度，
 *     机器派发无出口（loop 停派 + stderr 转人工；
 *     人工 pass verdict 使 unit 离开 created 态后投影自然消失）
 *     （reReview 维度已删除：其谓词「最后 spec 后无 pass」被 specReviewPending
 *     （无任何 verdict）∪ specFixPending（有 verdict 且全 fail）精确剖分，
 *     剩余形态「有 pass 但仍 created」= 弱 spec 停 created 的无组态——推导见
 *     computeFrontier 内注释）
 *   - missingChildren：spec-frozen 内部节点（split 非空非自引用）且 split 声明的
 *     子有未创建者——待 designer 补建子（fx-3 R5.3）
 *   - integrationDrift：spec-frozen 内部节点、子全 verified、集成连续 fail 达上限
 *     ——待 designer 处置契约漂移（fx-2 R4a）
 *   - integrationReady：spec-frozen 内部节点、子全 verified、未达 fail 上限——
 *     可执行集成（u8：不派 agent，loop 直接跑 runIntegrationVerify）
 *   - flakeReview：spec-frozen 且当前 spec 周期内某 e2e 级验收连挂 ≥2 次——
 *     待人工判定（rv-5，canon §5.2：不自动豁免防 Goodhart；机器派发无出口，
 *     loop 停派该 unit 的 developer，其余 unit 照常）。连挂输入排除解析失败条目
 *     （mx5-2：解析失败是确定性 spec 缺陷走 specContractBroken 回炉，不再误判
 *     为随机挂——M4 gate 三跑现场五的根因拆除）
 *   - specContractBroken：spec-frozen 且当前 spec 周期内某验收解析失败
 *     （VerifyRan.parseFailedAcceptanceIds，mx5-1）连挂 ≥2 次 ∧ 回炉代数 <2——
 *     待 designer 回炉修 spec 的验收命令契约（mx5-2，任务书内嵌逐轮解析失败
 *     原文；新 spec 照旧过独立 reviewer 再审）。判定序先于 flakeReview：解析
 *     失败有自动修复通道且 flake 启发式有误判前科，契约回炉优先拆死局
 *   - specContractDeadlock：specContractBroken 的连挂谓词成立 ∧ 回炉代数 ≥2
 *     （两轮「连挂 → 修 spec → verify 检验」完整走完仍解析失败）——转人工，
 *     机器派发无出口（防 designer-developer 回炉活锁；loop 停派 + stderr
 *     转人工，与 specReviewDeadlock 同款三处联动）。已知逃逸面（设计记档）：
 *     新 SpecSubmitted 整体重置该 unit 全部连挂状态——断言失败条目的 flake
 *     连挂同样被清，每 unit 至多被清 2 次（代数上界）且计数可重建
 *   - buildDrift：spec-frozen 且当前 spec 周期内 build 证据（EvidenceSubmitted
 *     计数）≥K（默认 5）且无 pass verify——缓慢进展转人工（lv-2，回溯「做
 *     不完的单元」的有限成本出口：每轮有产出但期望完成时间发散，布尔进展
 *     判定对其失明）。停派 + stderr 转人工（三选一：人工接手 / 拆 unit /
 *     调大 K 续跑）；账本态跨 run 持久（Ctrl-C 重跑计数不丢）
 *   - buildReady：spec-frozen 叶子（split 空 ∨ 自引用按叶子语义）且子全部
 *     closed（rootLast）——待 developer
 *   - execReviewReady：verified 且未 closed——待 reviewer（exec-review）
 * closed 的 unit 与「等待子树推进」的 unit 不在任何组（已越过 / 尚未到达本
 * frontier 推进点）。弱 spec（gate 红）停在 created 且已有过审记录的 unit 亦无组：
 * 机器派发对它无出口（重派 designer 只会重提交-重审-仍弱循环），需人工修 spec。
 *
 * 状态口径用 unitStatus（单 unit 语义）：树感知 deriveStatuses 只会把 closed 拉回
 * verified（core/fold.ts deriveStatusInTree），对上表全部维度的判定输入无影响，
 * closed 本身不入组。spec gate 经 load.ts 注入真实 checkSpecRules。
 */
import { existsSync } from "node:fs";

import { fold } from "../core/fold.js";
import type { CommandContext } from "../dispatch.js";
import type {
  DiscriminatedEvent,
  LedgerEvent,
  SequencedProjection,
  SequencedUnitProjection,
  SplitEntry,
} from "../events/types.js";
import { EventLedger } from "../store/events-log.js";
import { getCwHome, ledgerPath } from "../store/project.js";
import { EMPTY_LEDGER_HINT, unitStatus } from "./load.js";

/** frontier 全维度分组（维度语义见模块头；组内序 = 投影插入序 = 账本创建序） */
export interface FrontierGroups {
  specReady: string[];
  /**
   * ph-i1 R4：created 且有 spec，最新 SpecSubmitted 的 specHash 无对应
   * ReflectionRan——待反思（loop 检测到后对长驻 spawn 发 followUp，完成后
   * 写 ReflectionRan 事件再派 reviewer）。事件锚 = specHash：重提新 spec
   * （新 hash）即重新 pending。旧账本无 ReflectionRan 事件照常判定。
   */
  reflectionPending: string[];
  specReviewPending: string[];
  specFixPending: string[];
  /** mx-1/mx-3：spec-review 打回代数 ≥ 阈值（默认 10，mx-4）的 created unit（转人工，机器派发无出口） */
  specReviewDeadlock: string[];
  missingChildren: string[];
  integrationDrift: string[];
  integrationReady: string[];
  /** mx5-2：解析失败连挂 ≥2 ∧ 回炉代数 <2 的 spec-frozen unit（派 designer 回炉修 spec 命令契约） */
  specContractBroken: string[];
  /** mx5-2：解析失败连挂 ≥2 ∧ 回炉代数 ≥2 的 spec-frozen unit（转人工，防回炉活锁） */
  specContractDeadlock: string[];
  /** rv-5：e2e 验收连挂 ≥2 的 unit（转人工判定，机器派发无出口） */
  flakeReview: string[];
  /** lv-2：本 spec 周期内 build 证据 ≥K 且无 pass verify 的 unit（缓慢进展转人工，机器派发无出口） */
  buildDrift: string[];
  buildReady: string[];
  execReviewReady: string[];
}

/**
 * 组的展示序 = 生命周期推进序（spec → 审 → 修 → 审死锁转人工 → 子 → 集成 →
 * 契约回炉 / 回炉死锁转人工 → flake 转人工 → build 预算转人工 → build → 收尾
 * 审查）。specContract 两组插在 flakeReview 之前与 computeFrontier 的判定序同步
 * （单组归属，序即裁决——混合 unit 两谓词同真时回炉优先，见设计 mx-5 D2 并存
 * 语义）。lv-2 buildDrift 位次 = flakeReview 之后、buildReady 之前（「flake 转人
 * 工 → build 预算转人工 → build 推进」的生命周期序）。
 */
const GROUP_ORDER: ReadonlyArray<keyof FrontierGroups> = [
  "specReady",
  "reflectionPending",
  "specReviewPending",
  "specFixPending",
  "specReviewDeadlock",
  "missingChildren",
  "integrationDrift",
  "integrationReady",
  "specContractBroken",
  "specContractDeadlock",
  "flakeReview",
  "buildDrift",
  "buildReady",
  "execReviewReady",
];

/**
 * 同一内部节点集成的连续 fail 重派上限（fx-2 R4a 引入，rv-4 起改 1）：达到后
 * 不再自动重派集成（fail 的 VerifyRan 审计事件每轮喂活 idle 判定 = R4b 无限
 * 循环），改派 designer 处置契约漂移。loop 的 designer 处置任务书
 * （integrationDriftTasks）与派发日志引用同一常量。
 *
 * rv-4 语义迁移（rv4-acceptance §4）：集成 fail 是确定性失败（冲突/契约不匹配/
 * 验收红），不存在「重试一次就好」的瞬时态——MAX=2 的第二次重试语义作废，首次
 * fail 即转 drift（停自动重试、派 designer 处置、人工窗口不被销毁）。连续计数
 * 语义结构不变（事件流重放、逐 unit，见 consecutiveIntegrationFails），仅上限
 * 值改 1。
 */
export const INTEGRATION_MAX_CONSECUTIVE_FAILS = 1;

/**
 * 各 unit 的最新事件 seq 高水位（loop 连续 TIMEOUT 计数的进展清零输入）：各类
 * 事件 payload 均含 unitId，任何类型的新事件（SpecSubmitted / EvidenceSubmitted /
 * VerdictSubmitted / VerifyRan / UnitCreated / ReflectionRan）都视为该 unit 有
 * 进展。（mx5-2 起 hosted 于 frontier——纯事件重放投影，loop 只消费）
 */
export function unitEventHighWaterSeqs(events: readonly LedgerEvent[]): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.seq > (seqs.get(event.payload.unitId) ?? 0)) {
      seqs.set(event.payload.unitId, event.seq);
    }
  }
  return seqs;
}

// ---- 判定辅助（loop 的派发分支与 computeFrontier 共用；从 loop.ts 收口至此） ----

/** 内部节点判定锚点 = 最后一条冻结 spec 的 split（canon D1：层级是数据不是代码） */
export function splitOf(
  unit: SequencedUnitProjection,
): SplitEntry[] {
  return unit.specs[unit.specs.length - 1]?.split ?? [];
}

/** split 自引用判定（fx-1 R1）：任一条目 unitId === 自身 unitId */
export function splitSelfReferences(unit: SequencedUnitProjection): boolean {
  return splitOf(unit).some((entry) => entry.unitId === unit.unitId);
}

/**
 * 内部节点的集成等待条件（u8 rootLast 升级）：split 声明的全部子 unit 已 verified
 * （closed 蕴含 verified，同样放行——证据链已闭合）。子以 split 为权威集合而非
 * 账本 parentId：split 声明了但子尚未创建时，parentId 集合的「部分子全 verified」
 * 会放行一次缺子集成（静默漏掉一个子树），split 口径下未创建 = 未 verified = 等待。
 */
export function splitChildrenAllVerified(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
): boolean {
  return splitOf(unit).every((entry) => {
    const child = projection.units.get(entry.unitId);
    if (child === undefined) {
      return false;
    }
    const status = unitStatus(child);
    return status === "verified" || status === "closed";
  });
}

/**
 * split 声明但尚未 created 的子 unitId 清单（fx-3 R5.3 派发兜底的判定输入）。
 * 与 splitChildrenAllVerified 同口径以 split 为权威集合（非账本 parentId）。
 */
export function splitChildrenNotCreated(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
): string[] {
  return splitOf(unit)
    .filter((entry) => !projection.units.has(entry.unitId))
    .map((entry) => entry.unitId);
}

/**
 * root 子树的 unit 列表（BFS 序 = root 先、子按账本创建序）。实现与 human-loop
 * 的同名私有函数一致（泛化期两处并存，human-loop 退役后单一化）。（mx5-2 起
 * hosted 于 frontier——树形投影工具与 splitChildren* 同族，loop 只消费）
 */
export function subtreeUnits(
  projection: SequencedProjection,
  rootId: string,
): SequencedUnitProjection[] {
  const childrenOf = new Map<string, string[]>();
  for (const unit of projection.units.values()) {
    if (unit.parentId !== null) {
      const siblings = childrenOf.get(unit.parentId) ?? [];
      siblings.push(unit.unitId);
      childrenOf.set(unit.parentId, siblings);
    }
  }
  const units: SequencedUnitProjection[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const unit = projection.units.get(current);
    if (unit === undefined) break; // 不可达：BFS 只入账内 id
    units.push(unit);
    queue.push(...(childrenOf.get(current) ?? []));
  }
  return units;
}

/**
 * 最后一条 SpecSubmitted 之后最近一条 role=reviewer 的 spec-review verdict 结论
 * （mx-1 维度重排的判定输入；mx-3 起只认 reviewer，与 deriveStatus 的消费口径
 * 同步）："pass" | "fail" | null（无可消费的 spec-review verdict）。与
 * deriveStatus 的「之后存在」语义同口径——重提 spec = 打回重审，旧 verdict
 * 不计数。非 reviewer 的 spec-review verdict 被无视（designer 自审无效，unit
 * 回 specReviewPending 等待真正的独立审查）。verdicts 数组按账本序追加，逆序
 * 首条命中即最近——specReviewPending（null → reviewer 首审）与 specFixPending
 * （fail → designer 修 spec）的分维依据。
 */
export function latestSpecReviewAfterLastSpec(
  unit: SequencedUnitProjection,
): "pass" | "fail" | null {
  const lastSpecSeq = unit.lastSpecSeq;
  if (lastSpecSeq === null) {
    return null;
  }
  for (let i = unit.verdicts.length - 1; i >= 0; i -= 1) {
    const verdict = unit.verdicts[i];
    if (verdict === undefined || unit.verdictSeqs[i] === undefined) {
      continue;
    }
    if (
      unit.verdictSeqs[i] > lastSpecSeq &&
      verdict.verdictKind === "spec-review" &&
      verdict.role === "reviewer"
    ) {
      return verdict.verdict;
    }
  }
  return null;
}

/**
 * 最新 spec 是否已有对应反思（ph-i1 R4，reflectionPending 的判定输入）：
 * 最新 SpecSubmitted 的 specHash 在 reflections 记录中有对应条目即完成。
 * 事件锚语义：重提新 spec = 新 hash = 无对应记录 = 需重新反思（spec 级语义）。
 * 旧账本无 ReflectionRan 事件 = reflections 恒空 → 恒 pending（新版 cw 的
 * 四流程前反思步，与旧版 cw 读旧账本的兼容边界由 fold 的默认分支守卫）。
 */
export function reflectionDone(unit: SequencedUnitProjection): boolean {
  const lastSpec = unit.specs[unit.specs.length - 1];
  if (lastSpec === undefined) {
    return false;
  }
  return unit.reflections.some(
    (reflection) => reflection.specHash === lastSpec.specHash,
  );
}

/**
 * developer 的 rootLast 等待条件（叶子路径）：该 unit 的全部子 unit（按账本
 * parentId）已 closed。全投影口径与 loop 时代的「root 子树内遍历」等价——
 * 子树内 unit 的子（parentId 边）必然仍在子树内（BFS 收集性质）。
 */
function childrenAllClosed(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
): boolean {
  return [...projection.units.values()].every(
    (candidate) =>
      candidate.parentId !== unit.unitId || unitStatus(candidate) === "closed",
  );
}

/**
 * 各 unit 的连续 VerifyRan fail 计数（fx-2 R4a 重派上限的判定输入）：自该 unit
 * 上一条 SpecSubmitted / result=pass 的 VerifyRan 之后连续 fail 的次数（任何
 * pass / 新 spec 提交清零——验收文档锁定的口径）。SpecSubmitted 与 VerifyRan
 * 的相对顺序在 fold 投影里已丢失（平行数组），须从原始事件流重放；调用方 =
 * computeFrontier（integrationDrift 维度判定）与 loop（每轮重读账本后计算）。
 */
export function consecutiveIntegrationFails(
  events: readonly LedgerEvent[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted") {
      counts.set(event.payload.unitId, 0);
    } else if (event.type === "VerifyRan") {
      const previous = counts.get(event.payload.unitId) ?? 0;
      counts.set(
        event.payload.unitId,
        event.payload.result === "fail" ? previous + 1 : 0,
      );
    }
  }
  return counts;
}

// ---- mx-1：spec-review 打回循环的防活锁投影（specReviewDeadlock 维度判定输入） ----

/**
 * spec-review 打回代数的转人工阈值（mx-1 MF2 引入，mx-3 改按代数，mx-4 放宽 2→10）：
 * 同一 unit 累计 10 个打回代数（designer 修出的第 10 版 spec 仍被打回）即判
 * designer-reviewer 打回循环活锁，停止机器派发转人工。活锁防护语义保留（mx-1
 * MF2）：真 ping-pong 活锁烧穿 10 代同样触顶（每轮 ≥2 spawn 成本可控），重提
 * 不清零代数累计。放宽依据（用户 2026-08-19 裁决，M4 gate 二跑实证）：
 * leaf-renderer 被 reviewer 两代全新实质意见打回（v1 验收真空 → v2 e2e 脚本
 * 未定义）即触顶转人工——2 代预算对「reviewer 真意见非活锁」场景过紧，designer
 * 未获充分自愈空间。runner 侧可经 cw run --max-spec-rejects 注入更紧的运行
 * 策略值；只读命令（frontier/status）恒用本默认值（投影展示语义）。
 */
export const SPEC_REVIEW_DEADLOCK_FAILS = 10;

/**
 * 各 unit 的 spec-review 打回代数（mx-3 语义迁移：从「fail verdict 总数」改为
 * 「打回代数」，纯投影——事件流重放，范式对齐 consecutiveIntegrationFails）。
 * 一条「打回」= 某条 SpecSubmitted 之后的首条 role=reviewer fail verdict；
 * 同一 SpecSubmitted 之后的后续 fail（reviewer 试探、重复提交）不重复计数——
 * 消解 M4 gate §5.3「单 spawn 内试探性 verdict 耗尽 2 额度误杀 designer」。
 * MF2 教训由「代数累计」保持：重提（新 SpecSubmitted）不清零——fail → 重提 →
 * fail = 2 代打回 = deadlock（真 ping-pong）。代数锚点 = SpecSubmitted 事件边界
 * （specHash 变化必然伴随新 SpecSubmitted）。只消费 role=reviewer 的 fail
 * （与 fold/deriveStatus 的消费口径同步）。调用方 = computeFrontier
 * （specReviewDeadlock 维度）与 loop（每轮重读账本后计算，转人工指引）。
 */
export function specReviewFailCounts(
  events: readonly LedgerEvent[],
): Map<string, number> {
  const counts = new Map<string, number>();
  const countedInGeneration = new Set<string>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted") {
      countedInGeneration.delete(event.payload.unitId);
    } else if (
      event.type === "VerdictSubmitted" &&
      event.payload.verdictKind === "spec-review" &&
      event.payload.verdict === "fail" &&
      event.payload.role === "reviewer"
    ) {
      if (!countedInGeneration.has(event.payload.unitId)) {
        counts.set(
          event.payload.unitId,
          (counts.get(event.payload.unitId) ?? 0) + 1,
        );
        countedInGeneration.add(event.payload.unitId);
      }
    }
  }
  return counts;
}

/**
 * 该 unit 各打回代数的首条 fail comment（mx-3：只认 role=reviewer 的 fail、按
 * SpecSubmitted 代数取每代首条——与 specReviewFailCounts 的计数口径完全同构，
 * 转人工指引列出的意见数 = 打回代数；缺 comment 时给可定位占位）。需原始事件
 * 流（fold 投影的平行数组丢失跨类型顺序）。（mx5-2 起 hosted 于 frontier——
 * 纯事件重放投影与 specReviewFailCounts 同族，loop 只消费）
 */
export function specReviewFailComments(
  events: readonly LedgerEvent[],
  unitId: string,
): string[] {
  const comments: string[] = [];
  let countedInGeneration = false;
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted" && event.payload.unitId === unitId) {
      countedInGeneration = false;
    } else if (
      event.type === "VerdictSubmitted" &&
      event.payload.unitId === unitId &&
      event.payload.verdictKind === "spec-review" &&
      event.payload.verdict === "fail" &&
      event.payload.role === "reviewer"
    ) {
      if (!countedInGeneration) {
        comments.push(
          event.payload.comment ??
            "（该次 fail 未附 comment——按 cw report --unit 的 verdict 时间线核对）",
        );
        countedInGeneration = true;
      }
    }
  }
  return comments;
}

/**
 * VerdictSubmitted 的 seq → 入账时刻映射（mx-3 S7 抢答检查的输入）：fold 投影
 * 不含 ts，从原始事件流提取；ts 不可解析的条目不入表（消费侧保守告警）。
 * （mx5-2 起 hosted 于 frontier——纯事件重放投影，loop 只消费）
 */
export function specVerdictTsBySeq(events: readonly LedgerEvent[]): Map<number, number> {
  const tsBySeq = new Map<number, number>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "VerdictSubmitted") {
      const ts = Date.parse(event.ts);
      if (Number.isFinite(ts)) {
        tsBySeq.set(event.seq, ts);
      }
    }
  }
  return tsBySeq;
}

// ---- rv-5：e2e 验收连挂投影（flakeReview 维度的判定输入，canon §5.2） ----

/** e2e 用例连挂转人工阈值（canon §5.2 原文口径：连挂 2 次标 flake 转人工） */
export const FLAKE_MIN_CONSECUTIVE_FAILS = 2;

/** 单条验收的连挂事实（flakeReview 出口的转人工指引消费） */
export interface FlakeReviewFact {
  /** 连挂的验收 id（仅 e2e-real / e2e-mock 级条目参与计数） */
  acceptanceId: string;
  /** 当前 spec 周期内的连续 fail 次数（返回值恒 ≥ FLAKE_MIN_CONSECUTIVE_FAILS） */
  consecutiveFails: number;
  /** 构成连挂的 VerifyRan runId（账本序；转人工指引逐个列出供查产物） */
  runIds: string[];
}

/**
 * 各 unit 当前 spec 周期内 e2e 级验收的连挂事实（rv-5，纯投影——事件流重放，
 * 零新事件类型、无内存态）。逐条 fail 的判定信号 = VerifyRan.acceptanceIds
 * （聚合 pass 集）：当前 spec 的 e2e 条目在某次 unit 级 verify 中不在 pass 集
 * 即该次 fail。口径锁定（rv5-acceptance §4）：
 *   - 只认 e2e 级（e2e-real / e2e-mock）：unit/integration 连挂是稳定 bug，
 *     走正常 fail 打回（developer 修），不转人工；
 *   - 连续 = 当前 spec 周期内该条目在每次 unit 级 VerifyRan 中都 fail 且次数
 *     ≥2；中间任何一次 pass 即清零（投影天然重算，无内存态）；
 *   - 集成 verify（integrate- 前缀 runId）不参与计数也不清零（集成是全量重跑
 *     语义，随机挂由重跑覆盖）；
 *   - 新 SpecSubmitted 即周期重置（清零，锚 lastSpecSeq 语义）。
 * 已知边界：nondeterministic 声明条目经 rv-5 豁免后恒在 pass 集内，其逐次
 * fail 对本投影不可见（VerifyRan payload 零变更下的粒度边界，见 types.ts
 * 的 nondeterministic 注释）。调用方 = computeFrontier（flakeReview 维度）与
 * loop（每轮重读账本后计算，转人工指引）。
 */
export function flakeReviewFacts(
  events: readonly LedgerEvent[],
): Map<string, FlakeReviewFact[]> {
  interface UnitFlakeState {
    e2eIds: string[];
    streaks: Map<string, { count: number; runIds: string[] }>;
  }
  const states = new Map<string, UnitFlakeState>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted") {
      // spec 变更即周期重置：连挂清零，e2e 条目集合按新 spec 重锚
      states.set(event.payload.unitId, {
        e2eIds: event.payload.acceptance
          .filter((ac) => ac.type === "e2e-real" || ac.type === "e2e-mock")
          .map((ac) => ac.id),
        streaks: new Map(),
      });
    } else if (event.type === "VerifyRan") {
      if (event.payload.runId.startsWith("integrate-")) {
        continue;
      }
      const state = states.get(event.payload.unitId);
      if (state === undefined) {
        continue; // 无 spec 周期锚的 verify：正常流程不可达（handler 先查 spec）
      }
      for (const id of state.e2eIds) {
        if ((event.payload.parseFailedAcceptanceIds ?? []).includes(id)) {
          // mx5-2：解析失败条目不进 flake 连挂输入（解析失败是确定性 spec 缺陷，
          // 走 specContractBroken 回炉通道——三跑现场五：确定性挂被误判随机挂即
          // 此口径缺失）。跳过 = 本次 run 对该条目既不计数也不清零
          continue;
        }
        if (event.payload.acceptanceIds.includes(id)) {
          state.streaks.delete(id); // 中间 pass 即清零
        } else {
          const previous = state.streaks.get(id) ?? { count: 0, runIds: [] };
          state.streaks.set(id, {
            count: previous.count + 1,
            runIds: [...previous.runIds, event.payload.runId],
          });
        }
      }
    }
  }
  const facts = new Map<string, FlakeReviewFact[]>();
  for (const [unitId, state] of states) {
    const active = [...state.streaks.entries()]
      .filter(([, streak]) => streak.count >= FLAKE_MIN_CONSECUTIVE_FAILS)
      .map(([acceptanceId, streak]) => ({
        acceptanceId,
        consecutiveFails: streak.count,
        runIds: streak.runIds,
      }));
    if (active.length > 0) {
      facts.set(unitId, active);
    }
  }
  return facts;
}

// ---- mx5-2：解析失败回炉投影（specContractBroken / specContractDeadlock 判定输入） ----

/** 解析失败连挂转回炉阈值（连挂 2 次：第 1 次给 developer 正常迭代机会，第 2 次定性为 spec 命令契约缺陷） */
export const SPEC_CONTRACT_MIN_CONSECUTIVE_FAILS = 2;

/**
 * 回炉代数上限（防活锁独立预算，mx5-2）：designer 共获 2 次修复机会且每次都
 * 经完整 verify 检验后才计满——2 代仍解析失败即判 spec/brief 层有更深问题，
 * 转人工。不可复用 specReviewFailCounts（那数的是 reviewer fail verdict；回炉
 * 环里 reviewer 对每版新 spec 的裁定是 pass，代数恒不增长）。代数累计绝不清理
 * （新 spec 只清连挂计数）——同打回代数的防活锁依赖累计语义。
 */
export const SPEC_CONTRACT_MAX_GENERATIONS = 2;

/** 单条验收的解析失败连挂事实（回炉任务书与转人工指引的失败事实来源） */
export interface SpecContractStreakFact {
  /** 解析失败的验收 id（VerifyRan.parseFailedAcceptanceIds 的条目） */
  acceptanceId: string;
  /** 当前 spec 周期内的连续解析失败次数（返回值恒 ≥ SPEC_CONTRACT_MIN_CONSECUTIVE_FAILS） */
  consecutiveFails: number;
  /** 构成连挂的 VerifyRan runId（账本序；任务书按 runId 取 <id>.report.json 原文） */
  runIds: string[];
}

/** 单 unit 的解析失败回炉事实：连挂条目 + 回炉代数（两维度判定输入） */
export interface SpecContractFacts {
  /** 当前 spec 周期内解析失败连挂 ≥2 的条目（<2 的连挂不外露——谓词不成立） */
  streaks: SpecContractStreakFact[];
  /** 回炉代数（「连挂 ≥2 → 新 SpecSubmitted」累计次数；绝不清理） */
  generations: number;
}

/**
 * 各 unit 的解析失败连挂与回炉代数（mx5-2，纯投影——事件流重放，与
 * flakeReviewFacts 同构范式）。口径锁定（mx5-2 基线 §4 / 设计 D2 同构条目）：
 *   - 逐条目计数：VerifyRan.parseFailedAcceptanceIds 内的 id 连挂 +1；该 id
 *     不在该次 run 的清单内（中间一次解析成功）即清零；
 *   - 周期边界 = SpecSubmitted 事件（不比 specHash——同内容重提同开新周期），
 *     新 spec 入账清零全部连挂计数；
 *   - 集成 verify（integrate- 前缀 runId）不参与计数也不清零（集成解析失败走
 *     rv-4 集成处置链，且字段提取只在常规 verify 路径）；
 *   - 无 spec 周期锚的 VerifyRan 忽略（flake 同款防御）；
 *   - 回炉代数：SpecSubmitted 入账时仍有条目连挂 ≥2 即 +1（「连挂 ≥2 → 新
 *     SpecSubmitted」的因果链成立），**累计绝不清理**。
 * 调用方 = computeFrontier（两维度判定）与 loop（每轮重读账本后计算，转人工
 * 指引与派发排除）。
 */
export function specContractFacts(
  events: readonly LedgerEvent[],
): Map<string, SpecContractFacts> {
  interface UnitContractState {
    streaks: Map<string, { count: number; runIds: string[] }>;
    generations: number;
  }
  const states = new Map<string, UnitContractState>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted") {
      const previous = states.get(event.payload.unitId);
      if (
        previous !== undefined &&
        [...previous.streaks.values()].some(
          (streak) => streak.count >= SPEC_CONTRACT_MIN_CONSECUTIVE_FAILS,
        )
      ) {
        // 连挂达成 2 后的新 spec：回炉代数 +1（累计不清零），连挂计数随周期重置
        previous.generations += 1;
      }
      states.set(event.payload.unitId, {
        streaks: new Map(),
        generations: previous?.generations ?? 0,
      });
    } else if (event.type === "VerifyRan") {
      if (event.payload.runId.startsWith("integrate-")) {
        continue;
      }
      const state = states.get(event.payload.unitId);
      if (state === undefined) {
        continue; // 无 spec 周期锚的 verify：正常流程不可达（handler 先查 spec）
      }
      const parseFailed = event.payload.parseFailedAcceptanceIds ?? [];
      // 该 run 未解析失败的连挂条目清零（中间一次解析成功即清零——逐条目粒度）
      for (const id of [...state.streaks.keys()]) {
        if (!parseFailed.includes(id)) {
          state.streaks.delete(id);
        }
      }
      for (const id of parseFailed) {
        const previous = state.streaks.get(id) ?? { count: 0, runIds: [] };
        state.streaks.set(id, {
          count: previous.count + 1,
          runIds: [...previous.runIds, event.payload.runId],
        });
      }
    }
  }
  const facts = new Map<string, SpecContractFacts>();
  for (const [unitId, state] of states) {
    const streaks = [...state.streaks.entries()]
      .filter(([, streak]) => streak.count >= SPEC_CONTRACT_MIN_CONSECUTIVE_FAILS)
      .map(([acceptanceId, streak]) => ({
        acceptanceId,
        consecutiveFails: streak.count,
        runIds: streak.runIds,
      }));
    // 代数 >0 但当前周期未再连挂的 unit 也要外露（F6：既非 broken 也非 deadlock
    // 的判定输入——computeFrontier 按谓词裁决，不在本函数预判）
    if (streaks.length > 0 || state.generations > 0) {
      facts.set(unitId, { streaks, generations: state.generations });
    }
  }
  return facts;
}

// ---- lv-2：缓慢进展停派投影（buildDrift 维度的判定输入） ----

/**
 * buildDrift 的停派预算默认值（lv-2）：本 spec 周期内 build 证据计数 ≥K 且无
 * pass verify 即判「缓慢进展」（每轮有产出但期望完成时间发散——u4 案例 6 次
 * spawn ≈3h 无限重派的直接对策；布尔进展判定对「有产出但做不完」失明）。
 * K=5 依据：正常单元 1-3 次证据，u4 案例 8 次已太晚。runner 侧可经
 * cw run --max-build-attempts 注入运行策略值；只读命令（frontier/status）
 * 恒用本默认值（转人工预算是运行策略，默认值是投影展示语义——对齐
 * maxSpecRejects 先例）。
 */
export const BUILD_DRIFT_MAX_ATTEMPTS = 5;

/** 单 unit 的缓慢进展事实（buildDrift 出口的转人工指引消费） */
export interface BuildDriftFact {
  /** 当前 spec 周期内的 EvidenceSubmitted 计数（返回值恒 ≥ 注入的 maxAttempts） */
  buildCount: number;
  /** 该 unit 累计 SpecSubmitted 次数（出声去重签名的周期维度——新周期再达预算时签名变化重出声） */
  specEpoch: number;
}

/**
 * 各 unit 当前 spec 周期内的 build 证据计数与 pass 事实（lv-2，纯投影——事件流
 * 重放，与 flakeReviewFacts 同构范式）。口径锁定（lv-2 基线 §4.A / 设计 D1）：
 *   - 事实源 = EvidenceSubmitted 事件即 build 证据（spec 提交走独立的
 *     SpecSubmitted 事件——payload 无 kind 区分，仓内事实源如此），逐条 +1；
 *   - 周期锚 = SpecSubmitted 入账即重置（buildCount=0、hasPass=false；specEpoch
 *     累计 +1）——对齐 flakeReviewFacts 的周期重置锚（入账只保证过 gate，与
 *     reviewer 过审无关）；
 *   - pass 豁免：非集成 VerifyRan 且 result=pass → hasPass=true（**不清零
 *     buildCount**——「计数 ≥K 且无 pass」是谓词合取，pass 过的 unit 能完成，
 *     不属「做不完」；已知边界：pass 后 exec-review 打回再卡 build 循环不触发，
 *     记档不静默）；
 *   - 集成排除：runId 以 integrate- 开头的 VerifyRan 跳过（不计数、不清零、
 *     不置 pass——对齐 flakeReviewFacts 的跳过口径，防口径漂移）；
 *   - 无 spec 周期锚的 EvidenceSubmitted / VerifyRan 忽略（flake 同款防御）；
 *   - 外露：仅 buildCount ≥ maxAttempts ∧ !hasPass 的 unit 进 map（谓词不成立
 *     不外露，同 flakeReviewFacts 只外露 active 的范式）。
 * 回炉边界（记档）：specContractBroken 回炉重提 spec 时计数随周期清零、预算
 * 重建——最坏「回炉 × buildDrift」交织成本 ≤ 2 代回炉上限 × K，有界不发散，
 * specContractDeadlock 兜底。
 * 调用方 = computeFrontier（buildDrift 维度）与 loop（每轮重读账本后计算，
 * 转人工指引与派发排除——K 注入点在本函数调用侧，computeFrontier 只消费
 * 已算好的 facts map）。
 */
export function buildDriftFacts(
  events: readonly LedgerEvent[],
  maxAttempts: number = BUILD_DRIFT_MAX_ATTEMPTS,
): Map<string, BuildDriftFact> {
  interface UnitDriftState {
    buildCount: number;
    hasPass: boolean;
    specEpoch: number;
  }
  const states = new Map<string, UnitDriftState>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted") {
      // spec 变更即周期重置：计数与 pass 清零、周期数累计（出声去重的签名维度）
      const previous = states.get(event.payload.unitId);
      states.set(event.payload.unitId, {
        buildCount: 0,
        hasPass: false,
        specEpoch: (previous?.specEpoch ?? 0) + 1,
      });
    } else if (event.type === "EvidenceSubmitted") {
      const state = states.get(event.payload.unitId);
      if (state === undefined) {
        continue; // 无 spec 周期锚的证据：正常流程不可达（handler 先查 spec）
      }
      state.buildCount += 1;
    } else if (event.type === "VerifyRan") {
      if (event.payload.runId.startsWith("integrate-")) {
        continue;
      }
      const state = states.get(event.payload.unitId);
      if (state === undefined) {
        continue; // 无 spec 周期锚的 verify：正常流程不可达（handler 先查 spec）
      }
      if (event.payload.result === "pass") {
        // pass 豁免（不清零 buildCount）：pass 过的 unit 能完成，不属「做不完」
        state.hasPass = true;
      }
    }
  }
  const facts = new Map<string, BuildDriftFact>();
  for (const [unitId, state] of states) {
    if (state.buildCount >= maxAttempts && !state.hasPass) {
      facts.set(unitId, { buildCount: state.buildCount, specEpoch: state.specEpoch });
    }
  }
  return facts;
}

/**
 * 就绪集合计算（纯函数，维度语义见模块头）。consecutiveIntegrationFails 省略时
 * 上限判定退化为「无 fail 记录」——仅供无账本上下文的纯函数调用；命令与 loop
 * 消费时必须传入真实计数，否则 integrationDrift / integrationReady 判定分叉。
 * flakeReviewFacts 同理：省略时 flakeReview 维度恒空；specReviewFailCounts 同理：
 * 省略时 specReviewDeadlock 维度恒空（纯函数调用方）；specContractFacts（mx5-2）
 * 同理：省略时 specContractBroken / specContractDeadlock 恒空；buildDriftFacts
 * （lv-2）同理：省略时 buildDrift 维度恒空。maxSpecRejects（mx-4）：
 * specReviewDeadlock 的打回代数阈值——缺省回落常量
 * SPEC_REVIEW_DEADLOCK_FAILS（默认 10）；cw run 经 --max-spec-rejects 注入运行
 * 策略值，只读命令恒用默认。
 *
 * created 态内 spec 相关维度的互斥推导（mx-1 重排，if/else 序保证单组归属）：
 * specs===0 → specReady；failCount ≥ 阈值 → specReviewDeadlock（优先于审/修，
 * 死锁后两个推进维度都不再派）；无 spec-review verdict → specReviewPending；
 * 最近 verdict 是 fail → specFixPending；剩余 = 「有 pass 但仍 created」——
 * deriveStatus 下这只能是 gate 红（弱 spec），无组（机器派发无出口，需人工修
 * spec）。旧 reReview 谓词「最后 spec 后无 pass」= 前两个维度的并集，故删除。
 *
 * spec-frozen 态内契约回炉两维度（mx5-2，判定序先于 flakeReview——单组归属，
 * 序即裁决）：连挂 ≥2 ∧ 代数 <2 → specContractBroken（派 designer 回炉）；
 * 连挂 ≥2 ∧ 代数 ≥2 → specContractDeadlock（转人工，不再派 designer）。代数
 * 满但当前周期未再连挂时两谓词皆不成立（unit 正常参与其余维度）。
 */
export function computeFrontier(
  projection: SequencedProjection,
  opts?: {
    consecutiveIntegrationFails?: ReadonlyMap<string, number>;
    flakeReviewFacts?: ReadonlyMap<string, readonly FlakeReviewFact[]>;
    /** mx5-2：解析失败连挂 + 回炉代数（specContract 两维度判定输入） */
    specContractFacts?: ReadonlyMap<string, SpecContractFacts>;
    specReviewFailCounts?: ReadonlyMap<string, number>;
    /** lv-2：本 spec 周期内 build 证据 ≥K 且无 pass 的事实（buildDrift 维度判定输入） */
    buildDriftFacts?: ReadonlyMap<string, BuildDriftFact>;
    /** specReviewDeadlock 的打回代数阈值（mx-4；缺省回落 SPEC_REVIEW_DEADLOCK_FAILS） */
    maxSpecRejects?: number;
  },
): FrontierGroups {
  const groups: FrontierGroups = {
    specReady: [],
    reflectionPending: [],
    specReviewPending: [],
    specFixPending: [],
    specReviewDeadlock: [],
    missingChildren: [],
    integrationDrift: [],
    integrationReady: [],
    specContractBroken: [],
    specContractDeadlock: [],
    flakeReview: [],
    buildDrift: [],
    buildReady: [],
    execReviewReady: [],
  };
  const fails = opts?.consecutiveIntegrationFails;
  const flakes = opts?.flakeReviewFacts;
  const contracts = opts?.specContractFacts;
  const specFails = opts?.specReviewFailCounts;
  const buildDrifts = opts?.buildDriftFacts;
  const maxSpecRejects = opts?.maxSpecRejects ?? SPEC_REVIEW_DEADLOCK_FAILS;
  for (const unit of projection.units.values()) {
    const status = unitStatus(unit);
    if (status === "created") {
      if (unit.specs.length === 0) {
        groups.specReady.push(unit.unitId);
      } else if ((specFails?.get(unit.unitId) ?? 0) >= maxSpecRejects) {
        groups.specReviewDeadlock.push(unit.unitId);
      } else if (
        !reflectionDone(unit) &&
        latestSpecReviewAfterLastSpec(unit) === null
      ) {
        // ph-i1 R4：反思先于审查（R3 流：SpecSubmitted → followUp 反思 →
        // ReflectionRan 入账 → 派 reviewer）。锚 = specHash：最新 spec 的 hash
        // 在 reflections 中无对应记录即 pending。兼容语义（R4 兼容栏）：仅对
        // 「最新 spec 尚无任何 spec-review verdict」的 unit 生效——旧账本
        // （无 ReflectionRan 但 verdict 已流转）恒走四流程原判定，不被反思劫持
        groups.reflectionPending.push(unit.unitId);
      } else if (latestSpecReviewAfterLastSpec(unit) === null) {
        groups.specReviewPending.push(unit.unitId);
      } else if (latestSpecReviewAfterLastSpec(unit) === "fail") {
        groups.specFixPending.push(unit.unitId);
      }
      // 已过审但 gate 红（弱 spec 停 created）：无组（模块头口径）
    } else if (status === "spec-frozen") {
      const selfReferencing = splitSelfReferences(unit);
      // mx5-2：契约回炉两维度先于 flakeReview（单组归属，序即裁决——混合 unit
      // 下「自动回炉」优先于「转人工判 flake」，rv-5 逃逸面已记档：新 spec 整体
      // 清零连挂，但每 unit 至多被清 2 次（代数上界）且计数可重建）
      const contract = contracts?.get(unit.unitId);
      if (
        (contract?.streaks.length ?? 0) > 0 &&
        (contract?.generations ?? 0) >= SPEC_CONTRACT_MAX_GENERATIONS
      ) {
        // 两轮「连挂 → 修 spec → verify 检验」完整走完仍解析失败——不再派
        // designer（防回炉活锁），转人工；处置写入账本后投影自然消失
        groups.specContractDeadlock.push(unit.unitId);
      } else if ((contract?.streaks.length ?? 0) > 0) {
        groups.specContractBroken.push(unit.unitId);
      } else if ((flakes?.get(unit.unitId)?.length ?? 0) > 0) {
        // rv-5 flakeReview 优先于推进组：e2e 连挂的判定权在人，机器继续派发
        // （developer 打回 / 集成重跑）对随机挂无解——转人工期间该 unit 停止
        // 自动推进，其余 unit 照常；人工处置后投影自然消失，自愈
        groups.flakeReview.push(unit.unitId);
      } else if (!selfReferencing && splitOf(unit).length > 0) {
        if (splitChildrenNotCreated(projection, unit).length > 0) {
          groups.missingChildren.push(unit.unitId);
        } else if (splitChildrenAllVerified(projection, unit)) {
          if ((fails?.get(unit.unitId) ?? 0) >= INTEGRATION_MAX_CONSECUTIVE_FAILS) {
            groups.integrationDrift.push(unit.unitId);
          } else {
            groups.integrationReady.push(unit.unitId);
          }
        }
        // 子已建未全 verified：等待子树推进，无组
      } else if (childrenAllClosed(projection, unit)) {
        // 叶子（split 空 ∨ 自引用按叶子语义，fx-1 R1）：rootLast 等待条件。
        // lv-2 buildDrift 优先于 buildReady（单组归属，序即裁决——预算耗尽的
        // 缓慢进展 unit 停派转人工，不再喂 developer 重派循环）
        if (buildDrifts?.has(unit.unitId)) {
          groups.buildDrift.push(unit.unitId);
        } else {
          groups.buildReady.push(unit.unitId);
        }
      }
    } else if (status === "verified") {
      groups.execReviewReady.push(unit.unitId);
    }
    // closed：已越过全部推进点，无组
  }
  return groups;
}

/** 分组文本视图（纯函数）：空组显示 (无) 保持分组标题恒在 */
export function renderFrontier(groups: FrontierGroups): string {
  const groupLines = (ids: readonly string[]): string =>
    ids.length === 0 ? "  (无)" : ids.map((id) => `  ${id}`).join("\n");
  return `${GROUP_ORDER.map((key) => `${key}:\n${groupLines(groups[key])}`).join("\n")}\n`;
}

/**
 * 该 unit 当前的停派态描述（mx5-2 D6：TIMEOUT 结算行诚实化的输入）。停派态 =
 * 四个转人工维度之一（specContractDeadlock / flakeReview / specReviewDeadlock
 * / buildDrift——TIMEOUT 封顶的转人工是单进程内存态且封顶后不再有新 spawn，
 * 无需投影判定）。停派态下的「可重派」承诺不兑现（三跑现场五：flake 停派中的
 * developer TIMEOUT 结算行写可重派，死局），文案须改述真实行为。纯投影：调用方
 * 传入结算时刻的最新事件流（被 kill 的 agent 死前可能已写入处置事件）。检查序
 * 按 computeFrontier 单组归属下各停派维度互斥（同一 unit 只能进一组），
 * buildDrift 插入位次 = 第四，理由：与三个停派维度单组互斥，序不裁决语义
 * （防御性文档化——先匹配先返回）。
 *
 * 预算参数与派发侧同源（F1 修复）：loop 的结算路径必须传 runLoop 注入的
 * maxBuildAttempts / maxSpecRejects——结算行描述的「是否停派」须与下一轮派发
 * 判定用同一预算，否则注入非默认值时结算行谎报（默认 K=5 下 buildCount=6 的
 * unit 注入 K=10 后照常重派，结算行却写 buildDrift 停派）。只读命令与其他
 * 调用方不传 = 默认常量行为（与 frontierHandler 同口径）。
 */
export function stoppedDispatchState(
  events: readonly LedgerEvent[],
  unitId: string,
  opts?: {
    /** buildDrift 停派预算 K（缺省回落 BUILD_DRIFT_MAX_ATTEMPTS——与派发侧注入同源） */
    maxBuildAttempts?: number;
    /** specReviewDeadlock 打回代数阈值（缺省回落 SPEC_REVIEW_DEADLOCK_FAILS） */
    maxSpecRejects?: number;
  },
): string | null {
  const groups = computeFrontier(fold(events), {
    consecutiveIntegrationFails: consecutiveIntegrationFails(events),
    flakeReviewFacts: flakeReviewFacts(events),
    specContractFacts: specContractFacts(events),
    specReviewFailCounts: specReviewFailCounts(events),
    buildDriftFacts: buildDriftFacts(events, opts?.maxBuildAttempts),
    maxSpecRejects: opts?.maxSpecRejects,
  });
  if (groups.specContractDeadlock.includes(unitId)) {
    return "specContractDeadlock（验收命令解析失败已 2 代回炉，防活锁转人工）";
  }
  if (groups.flakeReview.includes(unitId)) {
    return "flakeReview（e2e 验收连挂转人工判定）";
  }
  if (groups.specReviewDeadlock.includes(unitId)) {
    return "specReviewDeadlock（spec 打回代数达预算转人工）";
  }
  if (groups.buildDrift.includes(unitId)) {
    return "buildDrift（build 证据达预算无 pass，缓慢进展转人工）";
  }
  return null;
}

/** --json 缩进宽度（2 空格，与文本视图缩进一致） */
const JSON_INDENT = 2;

export async function frontierHandler(ctx: CommandContext): Promise<number> {
  // 直接读原始事件流（loadLedger 只回投影；integrationDrift / flakeReview /
  // specContract / buildDrift 各维度需要事件重放的计数）。existsSync 前置探测
  // 保持只读保证（不构造 EventLedger 建目录）
  const path = ledgerPath(getCwHome(), ctx.cwd);
  const events = existsSync(path) ? new EventLedger(path).readAll() : [];
  const projection = fold(events);
  const groups = computeFrontier(projection, {
    consecutiveIntegrationFails: consecutiveIntegrationFails(events),
    flakeReviewFacts: flakeReviewFacts(events),
    specContractFacts: specContractFacts(events),
    specReviewFailCounts: specReviewFailCounts(events),
    // lv-2：只读命令恒用默认 K（转人工预算是运行策略，默认值是投影展示语义
    //——对齐 maxSpecRejects 先例；--max-build-attempts 只作用于 cw run 循环）
    buildDriftFacts: buildDriftFacts(events),
  });

  if (ctx.argv.json === true) {
    process.stdout.write(`${JSON.stringify(groups, null, JSON_INDENT)}\n`);
    return 0;
  }
  if (projection.units.size === 0) {
    process.stdout.write(EMPTY_LEDGER_HINT);
    return 0;
  }
  process.stdout.write(renderFrontier(groups));
  return 0;
}
