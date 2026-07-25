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
import type { V1Deps, V1NextAction } from "../types.js";

// ═══════════════════════════════════════════════════════════════
// guidance 填充静态基建（w1 新增，w2 接入 buildEpicNextAction 主体）
// ═══════════════════════════════════════════════════════════════
//
// 以下 5 个 export 是 w1 的纯新增基建：ACTION_SCHEMA / getSchemaText / STATUS_DISPLAY /
// ACTION_TO_NEXT / FLAT_INPUT_HINT。w1 不改 buildEpicNextAction/buildEpicFailureNextAction
// 主体（w2 任务），这些常量声明为 exported const 避免 eslint unused 报错，w2 接入时使用。
// 模式照 wave internal.ts。

/**
 * action → 该 action 的 input schema 来源（core 源文件 + interface 名）。
 *
 * IF5 映射（epic 层）：clarify→Clarification@clarifications.ts（裸数组，与 slice 同）、
 * plan→Split@plan.ts（与 feature 同，Plan 基类只拆下层）。
 */
interface SchemaSource {
  sourceFilePath: string;
  interfaceName: string;
}

export const EPIC_ACTION_SCHEMA: Readonly<Record<string, SchemaSource | undefined>> = {
  create: undefined,
  clarify: { sourceFilePath: "src/v1/core/clarifications.ts", interfaceName: "Clarification" },
  plan: { sourceFilePath: "src/v1/core/plan.ts", interfaceName: "PlanEpicInput" },
  "design-review": { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "DesignReviewJudgment" },
  execute: undefined, // 下沉创建 child feature，不接收 input
  retrospect: { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "PlanningRetrospectData" },
  closeout: { sourceFilePath: "src/v1/core/evidence.ts", interfaceName: "ArtifactRef" },
  replan: undefined,
  abort: undefined,
};

/** schema 文本缓存（按 action，模块级）。照 wave internal.ts 模式。 */
const epicSchemaCache = new Map<string, string>();

/**
 * 取某 action 的 input schema 文本（带缓存 + 降级）。
 *
 * - 源文件缺失 / interface 不存在 → 返回降级提示文本（不抛错）。
 * - 同一 action 第二次调用命中缓存。
 */
export function getEpicSchemaText(action: string): string {
  const cached = epicSchemaCache.get(action);
  if (cached !== undefined) {
    return cached;
  }
  const source = EPIC_ACTION_SCHEMA[action];
  let text: string;
  if (source === undefined) {
    text = EPIC_FLAT_INPUT_HINT[action] ?? "（无结构化 input schema）";
  } else {
    try {
      text = injectSchema(source.sourceFilePath, source.interfaceName);
    } catch {
      text = `（无法从 ${source.sourceFilePath} 提取 ${source.interfaceName} schema，请检查源文件）`;
    }
  }
  epicSchemaCache.set(action, text);
  return text;
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
  crossLayer?: V1NextAction["crossLayer"];
}

/**
 * 构建 epic handler 正常路径的 V1NextAction（w2：接入 buildNormalGuidance 三段式）。
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
): V1NextAction {
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
  const schemaText = getEpicSchemaText(action);

  const nextAction = opts?.nextActionOverride ?? EPIC_ACTION_TO_NEXT_PUBLIC[action];
  const command = buildEpicCommand(action, unit.id, nextAction);

  const guidance = buildNormalGuidance({
    prefix,
    nextAction: action,
    goal,
    command,
    schemaText,
    templateText,
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
 * 组装 epic 命令字符串（照 wave internal.ts 的 buildCommand）。
 */
function buildEpicCommand(
  currentAction: PlanningAction,
  unitId: string,
  nextAction: string | undefined,
): string {
  if (nextAction === undefined) {
    return `（当前 ${currentAction} 已结束本层流程，无下一步命令）`;
  }
  const hasInput = EPIC_ACTION_SCHEMA[nextAction] !== undefined ||
    EPIC_FLAT_INPUT_HINT[nextAction] !== undefined;
  const inputPart = hasInput ? ` --input @${nextAction}.json` : "";
  return `cw v1 ${nextAction} --unitId ${unitId}${inputPart}`;
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
  deps: V1Deps,
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
 * 构建 epic handler fail 路径的 V1NextAction + failureCount（w2：接入 buildFailureGuidance 四段式）。
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
): { nextAction: V1NextAction; failureCount: number } {
  const statusDisplay = EPIC_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "epic",
    unitId: unit.id,
    status: `${statusDisplay}（未变）`,
    parentUnitId: unit.parentUnitId,
  });

  const failureCount = deriveFailureCount(unit.statusHistory, action);
  const failureHint = buildFailureHint(failureCount, unit.id, action);
  const fixCommand = buildEpicCommand(action, unit.id, action);

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
