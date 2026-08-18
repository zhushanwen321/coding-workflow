/**
 * `cw frontier [--json]`：就绪集合视图；同时是 runner 派发就绪判定的单一出处。
 *
 * 全维度口径（fx1/fx2/fx3 修复前只有 specReady/buildReady 两维，且与 loop 自带的
 * 派发计算分叉——frontier 报 buildReady 的内部节点（spec-frozen 缺子）实际会被
 * loop 派 designer 补建子，A4「零上下文接手」场景输出与真实派发行为不一致。现
 * 派发就绪计算收口于此，loop 的 computeDispatchTargets 与本命令消费同一结果）：
 *   - specReady：created 且无 spec——待 designer 撰写 spec（首派）
 *   - specReviewPending：created 且有 spec，最后一条 SpecSubmitted 之后无任何
 *     spec-review verdict——待独立 reviewer 审查（mx-1：spec-review 的
 *     VerdictSubmitted 一律由 reviewer spawn 提交，designer 不自审）
 *   - specFixPending：created 且有 spec，最后一条 SpecSubmitted 之后最近的
 *     role=reviewer spec-review verdict 是 fail——待 designer 修 spec 重提
 *     （mx-1 MF1：fail 后的修复出口；fail verdict 的 comment 是任务书的失败事实
 *     来源；同代后续 fail 不改变本谓词——mx-3 按代计数后同代双 fail 仍是
 *     specFixPending 派 designer，不再误判 deadlock）
 *   - specReviewDeadlock：created 且本账本内该 unit 的 spec-review 打回代数 ≥2
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
 *     loop 停派该 unit 的 builder，其余 unit 照常）
 *   - buildReady：spec-frozen 叶子（split 空 ∨ 自引用按叶子语义）且子全部
 *     closed（rootLast）——待 builder
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
  specReviewPending: string[];
  specFixPending: string[];
  /** mx-1/mx-3：spec-review 打回代数 ≥2 的 created unit（转人工，机器派发无出口） */
  specReviewDeadlock: string[];
  missingChildren: string[];
  integrationDrift: string[];
  integrationReady: string[];
  /** rv-5：e2e 验收连挂 ≥2 的 unit（转人工判定，机器派发无出口） */
  flakeReview: string[];
  buildReady: string[];
  execReviewReady: string[];
}

/** 组的展示序 = 生命周期推进序（spec → 审 → 修 → 审死锁转人工 → 子 → 集成 → flake 转人工 → build → 收尾审查） */
const GROUP_ORDER: ReadonlyArray<keyof FrontierGroups> = [
  "specReady",
  "specReviewPending",
  "specFixPending",
  "specReviewDeadlock",
  "missingChildren",
  "integrationDrift",
  "integrationReady",
  "flakeReview",
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
 * builder 的 rootLast 等待条件（叶子路径）：该 unit 的全部子 unit（按账本
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
 * spec-review 打回代数的转人工阈值（mx-1 MF2 引入，mx-3 改按代数）：同一 unit
 * 累计 2 个打回代数（designer 修出的第二版 spec 仍被打回）即判 designer-reviewer
 * 打回循环活锁，停止机器派发转人工。取 2 而非 3+：第二代的 fail 已证明「修一轮
 * 仍不过」——继续循环只会烧 token。
 */
export const SPEC_REVIEW_DEADLOCK_FAILS = 2;

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
 *     走正常 fail 打回（builder 修），不转人工；
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

/**
 * 就绪集合计算（纯函数，维度语义见模块头）。consecutiveIntegrationFails 省略时
 * 上限判定退化为「无 fail 记录」——仅供无账本上下文的纯函数调用；命令与 loop
 * 消费时必须传入真实计数，否则 integrationDrift / integrationReady 判定分叉。
 * flakeReviewFacts 同理：省略时 flakeReview 维度恒空；specReviewFailCounts 同理：
 * 省略时 specReviewDeadlock 维度恒空（纯函数调用方）。
 *
 * created 态内 spec 相关维度的互斥推导（mx-1 重排，if/else 序保证单组归属）：
 * specs===0 → specReady；failCount ≥ 阈值 → specReviewDeadlock（优先于审/修，
 * 死锁后两个推进维度都不再派）；无 spec-review verdict → specReviewPending；
 * 最近 verdict 是 fail → specFixPending；剩余 = 「有 pass 但仍 created」——
 * deriveStatus 下这只能是 gate 红（弱 spec），无组（机器派发无出口，需人工修
 * spec）。旧 reReview 谓词「最后 spec 后无 pass」= 前两个维度的并集，故删除。
 */
export function computeFrontier(
  projection: SequencedProjection,
  opts?: {
    consecutiveIntegrationFails?: ReadonlyMap<string, number>;
    flakeReviewFacts?: ReadonlyMap<string, readonly FlakeReviewFact[]>;
    specReviewFailCounts?: ReadonlyMap<string, number>;
  },
): FrontierGroups {
  const groups: FrontierGroups = {
    specReady: [],
    specReviewPending: [],
    specFixPending: [],
    specReviewDeadlock: [],
    missingChildren: [],
    integrationDrift: [],
    integrationReady: [],
    flakeReview: [],
    buildReady: [],
    execReviewReady: [],
  };
  const fails = opts?.consecutiveIntegrationFails;
  const flakes = opts?.flakeReviewFacts;
  const specFails = opts?.specReviewFailCounts;
  for (const unit of projection.units.values()) {
    const status = unitStatus(unit);
    if (status === "created") {
      if (unit.specs.length === 0) {
        groups.specReady.push(unit.unitId);
      } else if (
        (specFails?.get(unit.unitId) ?? 0) >= SPEC_REVIEW_DEADLOCK_FAILS
      ) {
        groups.specReviewDeadlock.push(unit.unitId);
      } else if (latestSpecReviewAfterLastSpec(unit) === null) {
        groups.specReviewPending.push(unit.unitId);
      } else if (latestSpecReviewAfterLastSpec(unit) === "fail") {
        groups.specFixPending.push(unit.unitId);
      }
      // 已过审但 gate 红（弱 spec 停 created）：无组（模块头口径）
    } else if (status === "spec-frozen") {
      const selfReferencing = splitSelfReferences(unit);
      if ((flakes?.get(unit.unitId)?.length ?? 0) > 0) {
        // rv-5 flakeReview 优先于推进组：e2e 连挂的判定权在人，机器继续派发
        // （builder 打回 / 集成重跑）对随机挂无解——转人工期间该 unit 停止
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
        // 叶子（split 空 ∨ 自引用按叶子语义，fx-1 R1）：rootLast 等待条件
        groups.buildReady.push(unit.unitId);
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

/** --json 缩进宽度（2 空格，与文本视图缩进一致） */
const JSON_INDENT = 2;

export async function frontierHandler(ctx: CommandContext): Promise<number> {
  // 直接读原始事件流（loadLedger 只回投影；integrationDrift / flakeReview 两维度
  // 需要事件重放的计数）。existsSync 前置探测保持只读保证（不构造 EventLedger 建目录）
  const path = ledgerPath(getCwHome(), ctx.cwd);
  const events = existsSync(path) ? new EventLedger(path).readAll() : [];
  const projection = fold(events);
  const groups = computeFrontier(projection, {
    consecutiveIntegrationFails: consecutiveIntegrationFails(events),
    flakeReviewFacts: flakeReviewFacts(events),
    specReviewFailCounts: specReviewFailCounts(events),
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
