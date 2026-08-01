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
  injectSchema,
  PLANNING_ACTION_TO_NEXT,
  PLANNING_STAGE_TEMPLATES,
  PLANNING_STATUS_DISPLAY,
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
import type { CwDeps, CwNextAction } from "../types.js";

// ═══════════════════════════════════════════════════════════════
// guidance 填充静态基建（w1 新增，w2 接入 buildFeatureNextAction 主体）
// ═══════════════════════════════════════════════════════════════
//
// 以下 5 个 export 是 w1 的纯新增基建：ACTION_SCHEMA / getSchemaText / STATUS_DISPLAY /
// ACTION_TO_NEXT / FLAT_INPUT_HINT。w1 不改 buildFeatureNextAction/buildFeatureFailureNextAction
// 主体（w2 任务），这些常量声明为 exported const 避免 eslint unused 报错，w2 接入时使用。
// 模式照 wave internal.ts。

/**
 * action → 该 action 的 input schema 来源（core 源文件 + interface 名）。
 *
 * IF5 映射（feature 层）：clarify→FeatureClarification@clarifications.ts、plan→Split@plan.ts。
 * feature clarify 产物是 FeatureClarification 容器（{ clarifications, spec }），
 * plan 只写 split（Plan 基类，不产技术方案）。
 */
interface SchemaSource {
  sourceFilePath: string;
  interfaceName: string;
}

export const FEATURE_ACTION_SCHEMA: Readonly<Record<string, SchemaSource | undefined>> = {
  create: undefined,
  clarify: { sourceFilePath: "src/core/clarifications.ts", interfaceName: "FeatureClarification" },
  plan: { sourceFilePath: "src/core/plan.ts", interfaceName: "PlanFeatureInput" },
  "design-review": { sourceFilePath: "src/core/judgments.ts", interfaceName: "DesignReviewJudgment" },
  execute: undefined, // 下沉创建 child slice，不接收 input
  retrospect: { sourceFilePath: "src/core/judgments.ts", interfaceName: "PlanningRetrospectData" },
  closeout: { sourceFilePath: "src/core/evidence.ts", interfaceName: "ArtifactRef" },
  replan: undefined,
  abort: undefined,
};

/** schema 文本缓存（按 action，模块级）。照 wave internal.ts 模式。 */
const featureSchemaCache = new Map<string, string>();

/**
 * 取某 action 的 input schema 文本（带缓存 + 降级）。
 *
 * - 源文件缺失 / interface 不存在 → 返回降级提示文本（不抛错）。
 * - 同一 action 第二次调用命中缓存。
 */
export function getFeatureSchemaText(action: string): string {
  const cached = featureSchemaCache.get(action);
  if (cached !== undefined) {
    return cached;
  }
  const source = FEATURE_ACTION_SCHEMA[action];
  let text: string;
  if (source === undefined) {
    text = FEATURE_FLAT_INPUT_HINT[action] ?? "（无结构化 input schema）";
  } else {
    try {
      text = injectSchema(source.sourceFilePath, source.interfaceName);
    } catch {
      text = `（无法从 ${source.sourceFilePath} 提取 ${source.interfaceName} schema，请检查源文件）`;
    }
  }
  featureSchemaCache.set(action, text);
  return text;
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
  const schemaText = getFeatureSchemaText(action);
  // design-review 特判：基类 DesignReviewJudgment 的 layerSpecific 下界是 Record<string,string>，
  // 这里追加 feature 专属 6 字段名，提示 agent 必须填这些 key（机器 gate layer-specific-non-empty 会验）。
  const finalSchemaText =
    action === "design-review"
      ? `${schemaText}\nlayerSpecific 必须包含以下 key: specMeceNote, sliceSplitRationale, acVerifiabilityNote, consistencyNote, frAcCoverageNote, sliceSpecCoverageNote`
      : schemaText;

  const nextAction = opts?.nextActionOverride ?? FEATURE_ACTION_TO_NEXT_PUBLIC[action];
  const command = buildFeatureCommand(action, unit.id, nextAction, unit.slug);

  const guidance = buildNormalGuidance({
    prefix,
    nextAction: action,
    goal,
    command,
    schemaText: finalSchemaText,
    templateText,
    commonGuidance: buildSubagentGuidance("planning", action),
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
  const hasInput = FEATURE_ACTION_SCHEMA[nextAction] !== undefined ||
    FEATURE_FLAT_INPUT_HINT[nextAction] !== undefined;
  const inputPart = hasInput ? `--input ${inputFilePath(slug, nextAction)}` : "";
  return buildCommand(nextAction, `--unitId ${unitId}`, inputPart);
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
