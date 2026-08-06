/**
 * v1 feature handlers 内部编排辅助（不对外导出，仅 handlers/feature/ 内部用）。
 *
 * 设计来源：与 wave 的 handlers/internal.ts 同构——feature 层有专属 unit 类型（Feature）和
 * PlanningAction，但 guidance 流水线（buildNormalGuidance / buildFailureGuidance）与 wave
 * 完全一致，故照 wave internal.ts 模式接入（w2 完成，消除 W4 的一句话占位）。
 *
 * 职责（feature 版）：
 * 1. featureTransition：算 next PlanningStatus + append statusHistory + 更新 unit.status
 *    （复用 nextPlanningStatus，PlanningAction 与 slice 共用，feature 7 步流程状态机一致）
 * 2. saveFeature：把 Feature 存到 store（unknown 中转，同 saveSlice 模式）
 * 3. buildFeatureNextAction：构建正常路径三段式 guidance（prefix + template + schema + 命令）
 * 4. appendFeatureFailRecord / buildFeatureFailureNextAction：gate/freeze fail 路径四段式异常导航
 * 5. runFeatureRetrospectGates：feature 版 retrospect gate 聚合（rules/gates/retrospect.ts
 *    未提供 feature 专用聚合，feature 与 slice 的 retrospectData / plan.split / judgment 同型，
 *    复用 6 个子 gate 组装；rules 层零 IO，子 gate 均为独立纯函数）
 *
 * 不变量：本文件只做编排（IO 仅经 deps）+ guidance 填充（调 guidance/ 纯函数）+ gate 子函数组装。
 */
import type { PlanningStatus, StatusChange } from "../../core/status.js";
import type { Feature } from "../../core/workunit.js";
import {
  buildFailureGuidance,
  buildFailureHint,
  buildNormalGuidance,
  buildPrefix,
  buildSubagentGuidance,
  deriveFailureCount,
  PLANNING_ACTION_TO_NEXT,
  PLANNING_STAGE_TEMPLATES,
  PLANNING_STATUS_DISPLAY,
  readSchemaText,
} from "../../guidance/index.js";
import {
  allWavesClosed,
  childDeliveryConsistency,
  childUnitEvidenceComplete,
  deliveryVerdictNonEmpty,
  reviewedItemsCoverDesignReview,
  sliceLessonsLearnedNonEmpty,
  splitFulfillmentCoversPlan,
} from "../../rules/gates/retrospect.js";
import type { GateResult } from "../../rules/gates/types.js";
import type { PlanningAction } from "../../rules/state-machine.js";
import { nextPlanningStatus } from "../../rules/state-machine.js";
import type { WorkUnitRecord } from "../../store/schema.js";
import { buildCommand, inputFilePath } from "../../utils/command.js";
import type { CwDeps, CwNextAction, OrchestrationMode } from "../types.js";

// ═══════════════════════════════════════════════════════════════
// guidance 填充静态基建（w1 新增，w2 接入 buildFeatureNextAction 主体）
// ═══════════════════════════════════════════════════════════════
//
// ACTION_SCHEMA（FEATURE_ACTION_SCHEMA）与 wave 同源，定义集中在 guidance/action-schemas.ts
// （四层一处管理 + 供 buildSchemaGenFile 消费，避免 schema-injector 反向 import handlers 造成
// ESM 循环依赖）。

/** re-export：tests 与部分调用方按 layer 从本文件取 schema 表（保持原 import 路径稳定）。 */
export { FEATURE_ACTION_SCHEMA } from "../../guidance/action-schemas.js";
import { FEATURE_ACTION_SCHEMA } from "../../guidance/action-schemas.js";

/** schema 文本缓存（key 用 `${scope}:${action}`，与 schemas.gen.json 的 key 格式一致）。照 wave internal.ts 模式。 */
const featureSchemaCache = new Map<string, string>();

/**
 * 取某 action 的 input schema 文本（缓存优先：dist/guidance/schemas.gen.json → injectSchema → 兜底）。
 *
 * 优先读预计算产物 `feature:${action}` 条目（npm pack 后 src/core 不存在，靠此命中）；
 * 未命中降级到 injectSchema 实时解析（开发时无 build 产物）。同一 action 第二次调用命中缓存。
 */
export function getFeatureSchemaText(action: string): string {
  return readSchemaText({
    scope: "feature",
    action,
    source: FEATURE_ACTION_SCHEMA[action],
    flatHint: FEATURE_FLAT_INPUT_HINT[action],
    cache: featureSchemaCache,
  });
}

/**
 * status → 中文展示（三层共用）。直接 re-export guidance 层公共常量。
 */
export const FEATURE_STATUS_DISPLAY = PLANNING_STATUS_DISPLAY as Readonly<
  Record<PlanningStatus, string>
>;

/**
 * action → 下一步 action（PLANNING_TRANSITIONS 状态机映射，三层共用）。
 * 直接 re-export guidance 层公共 PLANNING_ACTION_TO_NEXT。
 */
export const FEATURE_ACTION_TO_NEXT_PUBLIC = PLANNING_ACTION_TO_NEXT;

/**
 * 无结构化 schema 的 action 的扁平参数提示。
 */
export const FEATURE_FLAT_INPUT_HINT: Readonly<Record<string, string>> = {
  create: "{ slug: string, objective: string, parentUnitId?: string, basedOnParent?: string[], layer?: 'feature' }",
  execute: "（execute 按 plan.split 自动创建 child slice，不接收 input；cw 返回 crossLayer.descend）",
  replan: "{ abandonedIds: string[], note: string }",
  abort: "{ reason?: string }",
};

// ═══════════════════════════════════════════════════════════════
// status 流转 + 持久化
// ═══════════════════════════════════════════════════════════════

/**
 * 流转 Feature 的 status：算 next PlanningStatus → append StatusChange → 更新 unit.status。
 *
 * PlanningAction scope 无关（feature/slice/epic 共用 PLANNING_TRANSITIONS），故与 sliceTransition
 * 逻辑完全一致，只是入参类型收窄为 Feature。
 *
 * @param unit 待流转的 Feature（会被 mutate）
 * @param action 触发的 PlanningAction
 * @param at ISO 8601 时间戳（来自 deps.clock.now()）
 * @param note 可选说明（replan 原因 / abort 原因）
 */
export function featureTransition(
  unit: Feature,
  action: PlanningAction,
  at: string,
  note?: string,
): void {
  const from = unit.status;
  const next = nextPlanningStatus(action, from);
  const change: StatusChange = { from, to: next, at, action };
  if (note !== undefined) {
    change.note = note;
  }
  unit.statusHistory.push(change);
  unit.status = next;
}

/**
 * 把 Feature 存到 store。
 *
 * 同 wave/slice 的 save 模式：Feature 无索引签名，WorkUnitRecord 带 `[key: string]: unknown`，
 * 需 unknown 中转。语义安全——Feature 字段全 JSON 可序列化，store 不解释不裁剪。
 */
export function saveFeature(
  deps: { store: { save: (u: WorkUnitRecord) => void } },
  unit: Feature,
): void {
  // eslint-disable-next-line taste/no-unsafe-cast
  deps.store.save(unit as unknown as WorkUnitRecord);
}

// ═══════════════════════════════════════════════════════════════
// 最小导航（W6 guidance worker 会美化）
// ═══════════════════════════════════════════════════════════════

/** buildFeatureNextAction 可选参数。 */
export interface BuildFeatureNextActionOpts {
  /** 覆盖默认下一步 action（execute/终态时调用方传 undefined 表示停留）。 */
  nextActionOverride?: string;
  /** 跨层建议（execute 下沉 / closeout 回溯）。 */
  crossLayer?: CwNextAction["crossLayer"];
  /**
   * 编排模式（G5）：recursive 时 subagent 调度段追加派发指导 + 续 turn 指导。
   * 缺省 serial（与现状一致）。仅 execute/closeout 等需要派发/续 turn 语义的调用方传入。
   */
  orchestration?: OrchestrationMode;
}

/**
 * 构建 feature handler 正常路径的 CwNextAction（w2：接入 buildNormalGuidance 三段式）。
 *
 * 照 wave internal.ts 的 buildNextAction 流水线：
 *   prefix → PLANNING_STAGE_TEMPLATES 查约束 → getFeatureSchemaText 取 schema → buildNormalGuidance 组装。
 *
 * @param unit 刚完成流转的 Feature
 * @param action 刚执行完的 PlanningAction
 * @param opts 可选覆盖（下一步 action / crossLayer）
 */
export function buildFeatureNextAction(
  unit: Feature,
  action: PlanningAction,
  opts?: BuildFeatureNextActionOpts,
): CwNextAction {
  const statusDisplay = FEATURE_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "feature",
    unitId: unit.id,
    status: statusDisplay,
    parentUnitId: unit.parentUnitId,
  });

  const template = PLANNING_STAGE_TEMPLATES[action];
  const templateText = template?.constraint ?? "";
  const goal = template?.goal ?? `（${action} 阶段）`;

  // #1 schema 错位修复：nextAction 提前计算，schema 段取 nextAction（与命令段同指下一步）。
  const nextAction = opts?.nextActionOverride ?? FEATURE_ACTION_TO_NEXT_PUBLIC[action];
  // 终态守卫：closeout/abort 后 nextAction=undefined，无「下一步 input」可展示 → 跳过 schema 段。
  let schemaText = "";
  if (nextAction !== undefined) {
    const baseSchemaText = getFeatureSchemaText(nextAction);
    // design-review 特判（跟随 nextAction）：基类 DesignReviewJudgment 的 layerSpecific 下界
    // 是 Record<string,string>，这里追加 feature 专属 6 字段名，提示 agent 必须填这些 key
    //（机器 gate layer-specific-non-empty 会验）。
    schemaText =
      nextAction === "design-review"
        ? `${baseSchemaText}\nlayerSpecific 必须包含以下 key: specMeceNote, sliceSplitRationale, acVerifiabilityNote, consistencyNote, frAcCoverageNote, sliceSpecCoverageNote`
        : baseSchemaText;
  }

  const command = buildFeatureCommand(action, unit.id, nextAction, unit.slug);

  const guidance = buildNormalGuidance({
    prefix,
    nextAction: action,
    goal,
    command,
    schemaText,
    templateText,
    commonGuidance: buildSubagentGuidance("planning", action, { orchestration: opts?.orchestration }),
  });

  return {
    action: nextAction,
    guidance,
    unitPath: {
      layer: "feature",
      unitId: unit.id,
      parentUnitId: unit.parentUnitId,
      rootUnitId: unit.id,
    },
    ...(opts?.crossLayer !== undefined ? { crossLayer: opts.crossLayer } : {}),
  };
}

/**
 * 组装 feature 命令字符串（照 wave internal.ts 的 buildWaveNextCommand）。
 * 命令本体由 buildCommand（utils/command.ts）统一构造，input 路径由 inputFilePath 算出。
 */
function buildFeatureCommand(
  currentAction: PlanningAction,
  unitId: string,
  nextAction: string | undefined,
  slug: string,
): string {
  if (nextAction === undefined) {
    return `（当前 ${currentAction} 已结束本层流程，无下一步命令）`;
  }
  // execute 特判：planning execute 按 plan.split 自动创建 child slice，不接收 input（CLI 忽略 --input）。
  // FEATURE_FLAT_INPUT_HINT.execute 仍 defined，被 getFeatureSchemaText("execute") 用作 schema 段兜底文本，故这里必须特判跳过。
  if (nextAction === "execute") {
    return buildCommand(nextAction, `--unitId ${unitId}`);
  }
  const hasInput = FEATURE_ACTION_SCHEMA[nextAction] !== undefined ||
    FEATURE_FLAT_INPUT_HINT[nextAction] !== undefined;
  const inputPart = hasInput ? `--input ${inputFilePath(slug, nextAction)}` : "";
  return buildCommand(nextAction, `--unitId ${unitId}`, inputPart);
}

/**
 * 为 handoff 路径构建「当前步」命令（command 用当前 action，不是 nextAction）。
 *
 * 与 buildFeatureCommand 的区别：后者用 nextAction 组装命令（导航下一步）；
 * 本函数用 action 自身组装命令（重建「现在该跑什么」认知）。handoff 的接手 agent
 * 看 guidance 应得到与外层「下一步执行」一致的命令，而非「跑完后再跑的下一步」。
 */
function buildFeatureCurrentCommand(
  action: PlanningAction,
  unitId: string,
  slug: string,
): string {
  // execute 特判：与 buildFeatureCommand 一致，planning execute 不接收 input（按 plan.split 自动创建 child slice）。
  if (action === "execute") {
    return buildCommand(action, `--unitId ${unitId}`);
  }
  const hasInput = FEATURE_ACTION_SCHEMA[action] !== undefined ||
    FEATURE_FLAT_INPUT_HINT[action] !== undefined;
  const inputPart = hasInput ? `--input ${inputFilePath(slug, action)}` : "";
  return buildCommand(action, `--unitId ${unitId}`, inputPart);
}

/**
 * 构建 feature handler handoff 路径的「当前步」guidance（command 用当前 action）。
 *
 * 与 buildFeatureNextAction 的区别：后者返回「跑完 action 后的下一步导航」
 * （command 用 nextAction，供 handler 填 ActionResult.nextAction）；本函数返回
 * 「现在该跑的 guidance」（command 用当前 action，供 handoff 重建当前步认知）。
 * 其余片段（prefix/goal/template/schemaText）复用与 buildFeatureNextAction 完全一致的查表逻辑。
 *
 * @param unit 待交接的 Feature
 * @param action 接手 agent 现在该跑的 PlanningAction（handoff 视角的当前步）
 * @param orchestration 编排模式（G5，recursive 时 subagent 调度段含派发/续 turn 指导；缺省 serial）
 */
export function buildFeatureCurrentActionGuidance(
  unit: Feature,
  action: PlanningAction,
  orchestration?: OrchestrationMode,
): string {
  const statusDisplay = FEATURE_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "feature",
    unitId: unit.id,
    status: statusDisplay,
    parentUnitId: unit.parentUnitId,
  });

  const template = PLANNING_STAGE_TEMPLATES[action];
  const templateText = template?.constraint ?? "";
  const goal = template?.goal ?? `（${action} 阶段）`;
  const baseSchemaText = getFeatureSchemaText(action);
  // design-review 特判：与 buildFeatureNextAction 一致（layerSpecific 必含 feature 专属 6 key）。
  const schemaText =
    action === "design-review"
      ? `${baseSchemaText}\nlayerSpecific 必须包含以下 key: specMeceNote, sliceSplitRationale, acVerifiabilityNote, consistencyNote, frAcCoverageNote, sliceSpecCoverageNote`
      : baseSchemaText;

  const command = buildFeatureCurrentCommand(action, unit.id, unit.slug);

  return buildNormalGuidance({
    prefix,
    nextAction: action,
    goal,
    command,
    schemaText,
    templateText,
    commonGuidance: buildSubagentGuidance("planning", action, { orchestration }),
  });
}

// ═══════════════════════════════════════════════════════════════
// gate/freeze fail 路径（最小异常导航）
// ═══════════════════════════════════════════════════════════════

/**
 * 往 statusHistory append 一条 gate/freeze fail 记录（failureCount 的派生源）。
 *
 * 同 slice appendSliceFailRecord 模式：记录形态 `{ action, to: 当前 status, note: "gate fail: <原因>" }`，
 * 不改 status（fail 诊断记录不是状态转换）。
 */
export function appendFeatureFailRecord(
  deps: CwDeps,
  unit: Feature,
  action: PlanningAction,
  reason: string,
): void {
  unit.statusHistory.push({
    to: unit.status,
    at: deps.clock.now(),
    action,
    note: `gate fail: ${reason}`,
  });
  saveFeature(deps, unit);
}

/**
 * 构建 feature handler fail 路径的 CwNextAction + failureCount（w2：接入 buildFailureGuidance 四段式）。
 *
 * 照 wave internal.ts 的 buildFailureNextAction 流水线：
 *   prefix（status 标注「未变」）→ deriveFailureCount（含本次）→ buildFailureHint → buildFailureGuidance。
 *
 * @param unit 已 appendFeatureFailRecord 的 Feature
 * @param action 触发 fail 的 PlanningAction（修正后重提同一 action）
 * @param problem gate fail 的具体问题（哪个字段/哪个条件没满足）
 */
export function buildFeatureFailureNextAction(
  unit: Feature,
  action: PlanningAction,
  problem: string,
): { nextAction: CwNextAction; failureCount: number } {
  const statusDisplay = FEATURE_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "feature",
    unitId: unit.id,
    status: `${statusDisplay}（未变）`,
    parentUnitId: unit.parentUnitId,
  });

  const failureCount = deriveFailureCount(unit.statusHistory, action);
  const failureHint = buildFailureHint(failureCount, unit.id, action, unit.slug);
  const fixCommand = buildFeatureCommand(action, unit.id, action, unit.slug);

  const guidance = buildFailureGuidance({
    prefix,
    problem,
    fixCommand,
    failureHint,
  });

  return {
    nextAction: {
      action,
      guidance,
      unitPath: {
        layer: "feature",
        unitId: unit.id,
        parentUnitId: unit.parentUnitId,
        rootUnitId: unit.id,
      },
    },
    failureCount,
  };
}

// ═══════════════════════════════════════════════════════════════
// feature retrospect gate 聚合
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 feature retrospect 全部 7 个 gate。
 *
 * rules/gates/retrospect.ts 只提供 slice 版聚合（runSliceRetrospectGates，签名锁 Slice），
 * 未提供 feature 专用版。feature 与 slice 的 retrospectData（PlanningRetrospectData）、
 * plan.split（Split[]）、designReviewJudgment（DesignReviewJudgment）类型完全一致，7 个子 gate
 * 均接收这三种入参（不依赖 Slice 特有字段），故 feature 直接复用 7 个子 gate 组装。
 *
 * 语义对应：feature 的 child 是 slice（slice 的 child 是 wave），allWavesClosed 判定
 * 「所有 child 终态」的语义对 feature 同样成立（child slice 终态 = closed/aborted）。
 *
 * @param unit 待校验的 Feature
 * @param childStatuses 所有 child slice 的当前 status（handler 从 store.findChildren 注入）
 */
export function runFeatureRetrospectGates(
  unit: Feature,
  childStatuses: ReadonlyArray<"closed" | "aborted" | string>,
  evidenceChildDelivery?: ReadonlyArray<{ splitSlug: string; childUnitId: string; childStatus: string }>,
): GateResult[] {
  return [
    allWavesClosed(childStatuses),
    sliceLessonsLearnedNonEmpty(unit.retrospectData),
    reviewedItemsCoverDesignReview(unit.retrospectData, unit.designReviewJudgment),
    splitFulfillmentCoversPlan(unit.retrospectData, unit.plan.split),
    childUnitEvidenceComplete(unit.retrospectData.childUnitIdsEvidence, unit.executeResult.childUnitIds),
    deliveryVerdictNonEmpty(unit.retrospectData.deliveryVerdict),
    childDeliveryConsistency(unit.retrospectData.childUnitIdsEvidence, evidenceChildDelivery ?? []),
  ];
}

// ═══════════════════════════════════════════════════════════════
// 安全读取辅助（从 WorkUnitRecord 读 status / statusHistory，用于级联 abort）
// ═══════════════════════════════════════════════════════════════

/**
 * 从 WorkUnitRecord 安全读 status 字符串（级联 abort 时读 child 状态用）。
 *
 * child 可能是任意层（slice/wave/...），status 联合类型无法静态收窄，统一按 string 读。
 * 数据缺失时回退 "created"（级联 abort 容错：宁可尝试 abort 也不漏）。
 */
export function readRecordStatus(record: WorkUnitRecord): string {
  const s = record.status;
  return typeof s === "string" ? s : "created";
}

/**
 * 从 WorkUnitRecord 安全读 statusHistory（返回可 mutate 的副本）。
 */
export function readRecordStatusHistory(record: WorkUnitRecord): StatusChange[] {
  const h = record.statusHistory;
  return Array.isArray(h) ? [...(h as StatusChange[])] : [];
}
