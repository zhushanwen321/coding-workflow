/**
 * v1 epic handlers 内部编排辅助（不对外导出，仅 handlers/epic/ 内部用）。
 *
 * 设计来源：与 wave 的 handlers/internal.ts 同构——epic 层有专属 unit 类型（Epic）和
 * PlanningAction，但 guidance 流水线（buildNormalGuidance / buildFailureGuidance）与 wave
 * 完全一致，故照 wave internal.ts 模式接入（w2 完成，消除 W4 的一句话占位）。
 *
 * 职责（epic 版）：
 * 1. epicTransition：算 next PlanningStatus + append statusHistory + 更新 unit.status
 *    （复用 nextPlanningStatus，PlanningAction 与 feature 共用，epic 7 步流程状态机一致）
 * 2. saveEpic：把 Epic 存到 store（unknown 中转，同 saveFeature 模式）
 * 3. buildEpicNextAction：构建正常路径三段式 guidance（prefix + template + schema + 命令）
 * 4. appendEpicFailRecord / buildEpicFailureNextAction：gate/freeze fail 路径四段式异常导航
 * 5. runEpicRetrospectGates：epic 版 retrospect gate 聚合（rules/gates/retrospect.ts
 *    未提供 epic 专用聚合，epic 与 slice/feature 的 retrospectData / plan.split / judgment 同型，
 *    复用 6 个子 gate 组装；rules 层零 IO，子 gate 均为独立纯函数）
 *
 * 不变量：本文件只做编排（IO 仅经 deps）+ guidance 填充（调 guidance/ 纯函数）+ gate 子函数组装。
 */
import type { PlanningStatus, StatusChange } from "../../core/status.js";
import type { Epic } from "../../core/workunit.js";
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
// guidance 填充静态基建（w1 新增，w2 接入 buildEpicNextAction 主体）
// ═══════════════════════════════════════════════════════════════
//
// ACTION_SCHEMA（EPIC_ACTION_SCHEMA）与 wave 同源，定义集中在 guidance/action-schemas.ts
// （四层一处管理 + 供 buildSchemaGenFile 消费，避免 schema-injector 反向 import handlers 造成
// ESM 循环依赖）。

/** re-export：tests 与部分调用方按 layer 从本文件取 schema 表（保持原 import 路径稳定）。 */
export { EPIC_ACTION_SCHEMA } from "../../guidance/action-schemas.js";
import { EPIC_ACTION_SCHEMA } from "../../guidance/action-schemas.js";

/** schema 文本缓存（key 用 `${scope}:${action}`，与 schemas.gen.json 的 key 格式一致）。照 wave internal.ts 模式。 */
const epicSchemaCache = new Map<string, string>();

/**
 * 取某 action 的 input schema 文本（缓存优先：dist/guidance/schemas.gen.json → injectSchema → 兜底）。
 *
 * 优先读预计算产物 `epic:${action}` 条目（npm pack 后 src/core 不存在，靠此命中）；
 * 未命中降级到 injectSchema 实时解析（开发时无 build 产物）。同一 action 第二次调用命中缓存。
 */
export function getEpicSchemaText(action: string): string {
  return readSchemaText({
    scope: "epic",
    action,
    source: EPIC_ACTION_SCHEMA[action],
    flatHint: EPIC_FLAT_INPUT_HINT[action],
    cache: epicSchemaCache,
  });
}

/**
 * status → 中文展示（三层共用）。直接 re-export guidance 层公共常量。
 */
export const EPIC_STATUS_DISPLAY = PLANNING_STATUS_DISPLAY as Readonly<
  Record<PlanningStatus, string>
>;

/**
 * action → 下一步 action（PLANNING_TRANSITIONS 状态机映射，三层共用）。
 * 直接 re-export guidance 层公共 PLANNING_ACTION_TO_NEXT。
 */
export const EPIC_ACTION_TO_NEXT_PUBLIC = PLANNING_ACTION_TO_NEXT;

/**
 * 无结构化 schema 的 action 的扁平参数提示。
 */
export const EPIC_FLAT_INPUT_HINT: Readonly<Record<string, string>> = {
  create: "{ slug: string, objective: string, parentUnitId?: string, basedOnParent?: string[], layer?: 'epic' }",
  execute: "（execute 按 plan.split 自动创建 child feature，不接收 input；cw 返回 crossLayer.descend）",
  replan: "{ abandonedIds: string[], note: string }",
  abort: "{ reason?: string }",
};

// ═══════════════════════════════════════════════════════════════
// status 流转 + 持久化
// ═══════════════════════════════════════════════════════════════

/**
 * 流转 Epic 的 status：算 next PlanningStatus → append StatusChange → 更新 unit.status。
 *
 * PlanningAction scope 无关（epic/feature/slice 共用 PLANNING_TRANSITIONS），故与 featureTransition
 * 逻辑完全一致，只是入参类型收窄为 Epic。
 *
 * @param unit 待流转的 Epic（会被 mutate）
 * @param action 触发的 PlanningAction
 * @param at ISO 8601 时间戳（来自 deps.clock.now()）
 * @param note 可选说明（replan 原因 / abort 原因）
 */
export function epicTransition(
  unit: Epic,
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
 * 把 Epic 存到 store。
 *
 * 同 wave/slice/feature 的 save 模式：Epic 无索引签名，WorkUnitRecord 带 `[key: string]: unknown`，
 * 需 unknown 中转。语义安全——Epic 字段全 JSON 可序列化，store 不解释不裁剪。
 */
export function saveEpic(
  deps: { store: { save: (u: WorkUnitRecord) => void } },
  unit: Epic,
): void {
  // eslint-disable-next-line taste/no-unsafe-cast
  deps.store.save(unit as unknown as WorkUnitRecord);
}

// ═══════════════════════════════════════════════════════════════
// 最小导航（W6 guidance worker 会美化）
// ═══════════════════════════════════════════════════════════════

/** buildEpicNextAction 可选参数。 */
export interface BuildEpicNextActionOpts {
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
 * 构建 epic handler 正常路径的 CwNextAction（w2：接入 buildNormalGuidance 三段式）。
 *
 * 照 wave internal.ts 的 buildNextAction 流水线：
 *   prefix → PLANNING_STAGE_TEMPLATES 查约束 → getEpicSchemaText 取 schema → buildNormalGuidance 组装。
 *
 * @param unit 刚完成流转的 Epic
 * @param action 刚执行完的 PlanningAction
 * @param opts 可选覆盖（下一步 action / crossLayer）
 */
export function buildEpicNextAction(
  unit: Epic,
  action: PlanningAction,
  opts?: BuildEpicNextActionOpts,
): CwNextAction {
  const statusDisplay = EPIC_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "epic",
    unitId: unit.id,
    status: statusDisplay,
    parentUnitId: unit.parentUnitId,
  });

  const template = PLANNING_STAGE_TEMPLATES[action];
  const templateText = template?.constraint ?? "";
  const goal = template?.goal ?? `（${action} 阶段）`;

  // #1 schema 错位修复：nextAction 提前计算，schema 段取 nextAction（与命令段同指下一步）。
  const nextAction = opts?.nextActionOverride ?? EPIC_ACTION_TO_NEXT_PUBLIC[action];
  // 终态守卫：closeout/abort 后 nextAction=undefined，无「下一步 input」可展示 → 跳过 schema 段。
  let schemaText = "";
  if (nextAction !== undefined) {
    const baseSchemaText = getEpicSchemaText(nextAction);
    // design-review 特判（跟随 nextAction）：基类 DesignReviewJudgment 的 layerSpecific 下界
    // 是 Record<string,string>，这里追加 epic 专属 5 字段名，提示 agent 必须填这些 key
    //（机器 gate layer-specific-non-empty 会验）。
    schemaText =
      nextAction === "design-review"
        ? `${baseSchemaText}\nlayerSpecific 必须包含以下 key: strategicAlignment, featureSplitRationale, scopeBoundary, priorityRationale, resourceEstimate`
        : baseSchemaText;
  }

  const command = buildEpicCommand(action, unit.id, nextAction, unit.slug);

  const guidance = buildNormalGuidance({
    prefix,
    nextAction: action,
    goal,
    command,
    schemaText,
    templateText,
    commonGuidance: buildSubagentGuidance("planning", action, { orchestration: opts?.orchestration, childLayer: "feature" }),
  });

  return {
    action: nextAction,
    guidance,
    unitPath: {
      layer: "epic",
      unitId: unit.id,
      parentUnitId: unit.parentUnitId,
      rootUnitId: unit.id,
    },
    ...(opts?.crossLayer !== undefined ? { crossLayer: opts.crossLayer } : {}),
  };
}

/**
 * 组装 epic 命令字符串（照 wave internal.ts 的 buildWaveNextCommand）。
 * 命令本体由 buildCommand（utils/command.ts）统一构造，input 路径由 inputFilePath 算出。
 */
function buildEpicCommand(
  currentAction: PlanningAction,
  unitId: string,
  nextAction: string | undefined,
  slug: string,
): string {
  if (nextAction === undefined) {
    return `（当前 ${currentAction} 已结束本层流程，无下一步命令）`;
  }
  // execute 特判：planning execute 按 plan.split 自动创建 child feature，不接收 input（CLI 忽略 --input）。
  // EPIC_FLAT_INPUT_HINT.execute 仍 defined，被 getEpicSchemaText("execute") 用作 schema 段兜底文本，故这里必须特判跳过。
  if (nextAction === "execute") {
    return buildCommand(nextAction, `--unitId ${unitId}`);
  }
  const hasInput = EPIC_ACTION_SCHEMA[nextAction] !== undefined ||
    EPIC_FLAT_INPUT_HINT[nextAction] !== undefined;
  const inputPart = hasInput ? `--input ${inputFilePath(slug, nextAction)}` : "";
  return buildCommand(nextAction, `--unitId ${unitId}`, inputPart);
}

/**
 * 为 handoff 路径构建「当前步」命令（command 用当前 action，不是 nextAction）。
 *
 * 与 buildEpicCommand 的区别：后者用 nextAction 组装命令（导航下一步）；
 * 本函数用 action 自身组装命令（重建「现在该跑什么」认知）。handoff 的接手 agent
 * 看 guidance 应得到与外层「下一步执行」一致的命令，而非「跑完后再跑的下一步」。
 */
function buildEpicCurrentCommand(
  action: PlanningAction,
  unitId: string,
  slug: string,
): string {
  // execute 特判：与 buildEpicCommand 一致，planning execute 不接收 input（按 plan.split 自动创建 child feature）。
  if (action === "execute") {
    return buildCommand(action, `--unitId ${unitId}`);
  }
  const hasInput = EPIC_ACTION_SCHEMA[action] !== undefined ||
    EPIC_FLAT_INPUT_HINT[action] !== undefined;
  const inputPart = hasInput ? `--input ${inputFilePath(slug, action)}` : "";
  return buildCommand(action, `--unitId ${unitId}`, inputPart);
}

/**
 * 构建 epic handler handoff 路径的「当前步」guidance（command 用当前 action）。
 *
 * 与 buildEpicNextAction 的区别：后者返回「跑完 action 后的下一步导航」
 * （command 用 nextAction，供 handler 填 ActionResult.nextAction）；本函数返回
 * 「现在该跑的 guidance」（command 用当前 action，供 handoff 重建当前步认知）。
 * 其余片段（prefix/goal/template/schemaText）复用与 buildEpicNextAction 完全一致的查表逻辑。
 *
 * @param unit 待交接的 Epic
 * @param action 接手 agent 现在该跑的 PlanningAction（handoff 视角的当前步）
 * @param orchestration 编排模式（G5，recursive 时 subagent 调度段含派发/续 turn 指导；缺省 serial）
 */
export function buildEpicCurrentActionGuidance(
  unit: Epic,
  action: PlanningAction,
  orchestration?: OrchestrationMode,
): string {
  const statusDisplay = EPIC_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "epic",
    unitId: unit.id,
    status: statusDisplay,
    parentUnitId: unit.parentUnitId,
  });

  const template = PLANNING_STAGE_TEMPLATES[action];
  const templateText = template?.constraint ?? "";
  const goal = template?.goal ?? `（${action} 阶段）`;
  const baseSchemaText = getEpicSchemaText(action);
  // design-review 特判：与 buildEpicNextAction 一致（layerSpecific 必含 epic 专属 5 key）。
  const schemaText =
    action === "design-review"
      ? `${baseSchemaText}\nlayerSpecific 必须包含以下 key: strategicAlignment, featureSplitRationale, scopeBoundary, priorityRationale, resourceEstimate`
      : baseSchemaText;

  const command = buildEpicCurrentCommand(action, unit.id, unit.slug);

  return buildNormalGuidance({
    prefix,
    nextAction: action,
    goal,
    command,
    schemaText,
    templateText,
    commonGuidance: buildSubagentGuidance("planning", action, { orchestration, childLayer: "feature" }),
  });
}

// ═══════════════════════════════════════════════════════════════
// gate/freeze fail 路径（最小异常导航）
// ═══════════════════════════════════════════════════════════════

/**
 * 往 statusHistory append 一条 gate/freeze fail 记录（failureCount 的派生源）。
 *
 * 同 slice/feature appendFailRecord 模式：记录形态 `{ action, to: 当前 status, note: "gate fail: <原因>" }`，
 * 不改 status（fail 诊断记录不是状态转换）。
 */
export function appendEpicFailRecord(
  deps: CwDeps,
  unit: Epic,
  action: PlanningAction,
  reason: string,
): void {
  unit.statusHistory.push({
    to: unit.status,
    at: deps.clock.now(),
    action,
    note: `gate fail: ${reason}`,
  });
  saveEpic(deps, unit);
}

/**
 * 构建 epic handler fail 路径的 CwNextAction + failureCount（w2：接入 buildFailureGuidance 四段式）。
 *
 * 照 wave internal.ts 的 buildFailureNextAction 流水线：
 *   prefix（status 标注「未变」）→ deriveFailureCount（含本次）→ buildFailureHint → buildFailureGuidance。
 *
 * @param unit 已 appendEpicFailRecord 的 Epic
 * @param action 触发 fail 的 PlanningAction（修正后重提同一 action）
 * @param problem gate fail 的具体问题（哪个字段/哪个条件没满足）
 */
export function buildEpicFailureNextAction(
  unit: Epic,
  action: PlanningAction,
  problem: string,
): { nextAction: CwNextAction; failureCount: number } {
  const statusDisplay = EPIC_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "epic",
    unitId: unit.id,
    status: `${statusDisplay}（未变）`,
    parentUnitId: unit.parentUnitId,
  });

  const failureCount = deriveFailureCount(unit.statusHistory, action);
  const failureHint = buildFailureHint(failureCount, unit.id, action, unit.slug);
  const fixCommand = buildEpicCommand(action, unit.id, action, unit.slug);

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
        layer: "epic",
        unitId: unit.id,
        parentUnitId: unit.parentUnitId,
        rootUnitId: unit.id,
      },
    },
    failureCount,
  };
}

// ═══════════════════════════════════════════════════════════════
// epic retrospect gate 聚合
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 epic retrospect 全部 7 个 gate。
 *
 * rules/gates/retrospect.ts 只提供 slice 版聚合（runSliceRetrospectGates，签名锁 Slice），
 * 未提供 epic 专用版。epic 与 slice/feature 的 retrospectData（PlanningRetrospectData）、
 * plan.split（Split[]）、designReviewJudgment（DesignReviewJudgment）类型完全一致，7 个子 gate
 * 均接收这三种入参（不依赖 Slice 特有字段），故 epic 直接复用 7 个子 gate 组装。
 *
 * 语义对应：epic 的 child 是 feature（feature 的 child 是 slice），allWavesClosed 判定
 * 「所有 child 终态」的语义对 epic 同样成立（child feature 终态 = closed/aborted）。
 *
 * @param unit 待校验的 Epic
 * @param childStatuses 所有 child feature 的当前 status（handler 从 store.findChildren 注入）
 */
export function runEpicRetrospectGates(
  unit: Epic,
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
 * child 可能是任意层（feature/slice/wave/...），status 联合类型无法静态收窄，统一按 string 读。
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
