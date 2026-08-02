/**
 * v1 slice handlers 内部编排辅助（不对外导出，仅 handlers/slice/ 内部用）。
 *
 * 设计来源：与 wave 的 handlers/internal.ts 同构——slice 层有专属 unit 类型（Slice）和
 * PlanningAction，但 guidance 流水线（buildNormalGuidance / buildFailureGuidance）
 * 与 wave 完全一致，故照 wave internal.ts 模式接入（w2 完成，消除 W4 的一句话占位）。
 *
 * 职责（slice 版）：
 * 1. sliceTransition：算 next PlanningStatus + append statusHistory + 更新 unit.status
 * 2. saveSlice：把 Slice 存到 store（unknown 中转，同 wave saveUnit 模式）
 * 3. buildSliceNextAction：构建正常路径三段式 guidance（prefix + template + schema + 命令）
 * 4. appendSliceFailRecord / buildSliceFailureNextAction：gate/freeze fail 路径四段式异常导航
 *
 * 不变量：本文件只做编排（IO 仅经 deps）+ guidance 填充（调 guidance/ 纯函数）。
 *      业务规则在 rules/，guidance 渲染在 guidance/。
 */
import type { PlanningStatus, StatusChange } from "../../core/status.js";
import type { Slice } from "../../core/workunit.js";
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
import type { PlanningAction } from "../../rules/state-machine.js";
import { nextPlanningStatus } from "../../rules/state-machine.js";
import type { WorkUnitRecord } from "../../store/schema.js";
import { buildCommand, inputFilePath } from "../../utils/command.js";
import type { CwDeps, CwNextAction } from "../types.js";

// ═══════════════════════════════════════════════════════════════
// guidance 填充静态基建（w1 新增，w2 接入 buildSliceNextAction 主体）
// ═══════════════════════════════════════════════════════════════
//
// ACTION_SCHEMA（action→core schema 来源）+ STATUS_DISPLAY + ACTION_TO_NEXT + FLAT_INPUT_HINT
// 是 slice handler 编排所需的静态映射表。ACTION_SCHEMA（SLICE_ACTION_SCHEMA）与 wave 同源，
// 定义集中在 guidance/action-schemas.ts（四层一处管理 + 供 buildSchemaGenFile 消费，
// 避免 schema-injector 反向 import handlers 造成 ESM 循环依赖）。

/** re-export：tests 与部分调用方按 layer 从本文件取 schema 表（保持原 import 路径稳定）。 */
export { SLICE_ACTION_SCHEMA } from "../../guidance/action-schemas.js";
import { SLICE_ACTION_SCHEMA } from "../../guidance/action-schemas.js";

/**
 * schema 文本缓存（key 用 `${scope}:${action}`，与 schemas.gen.json 的 key 格式一致）。
 *
 * 照 wave internal.ts 模式：injectSchema 会 createSourceFile 解析 core TS（有成本），
 * 且 schema 是静态的，缓存避免每次 handler 调用都重读重解析。实际读取逻辑下沉到
 * guidance/readSchemaText（四层共享），缓存 Map 各层自持避免跨 scope 串扰。
 */
const sliceSchemaCache = new Map<string, string>();

/**
 * 取某 action 的 input schema 文本（缓存优先：dist/guidance/schemas.gen.json → injectSchema → 兜底）。
 *
 * 优先读预计算产物 `slice:${action}` 条目（npm pack 后 src/core 不存在，靠此命中）；
 * 未命中降级到 injectSchema 实时解析（开发时无 build 产物）。同一 action 第二次调用命中缓存。
 */
export function getSliceSchemaText(action: string): string {
  return readSchemaText({
    scope: "slice",
    action,
    source: SLICE_ACTION_SCHEMA[action],
    flatHint: SLICE_FLAT_INPUT_HINT[action],
    cache: sliceSchemaCache,
  });
}

/**
 * status → 中文展示（prefix-builder 的 status 参数要中文字符串）。
 *
 * 三层共用同一份（PlanningStatus 8 状态），直接 re-export guidance 层公共常量。
 */
export const SLICE_STATUS_DISPLAY = PLANNING_STATUS_DISPLAY as Readonly<
  Record<PlanningStatus, string>
>;

/**
 * action → 下一步 action（PLANNING_TRANSITIONS 状态机映射，三层共用）。
 *
 * 三层完全一致，直接 re-export guidance 层公共 PLANNING_ACTION_TO_NEXT。
 */
export const SLICE_ACTION_TO_NEXT_PUBLIC = PLANNING_ACTION_TO_NEXT;

/**
 * 无结构化 schema 的 action 的扁平参数提示。
 *
 * PlanningUnit 的 create 按 layer 路由；execute 不接收 input（下沉）；replan/abort 同 wave。
 */
export const SLICE_FLAT_INPUT_HINT: Readonly<Record<string, string>> = {
  create: "{ slug: string, objective: string, parentUnitId?: string, basedOnParent?: string[], layer?: 'slice' }",
  execute: "（execute 按 plan.split 自动创建 child wave，不接收 input；cw 返回 crossLayer.descend）",
  replan: "{ abandonedIds: string[], note: string }",
  abort: "{ reason?: string }",
};

// ═══════════════════════════════════════════════════════════════
// status 流转 + 持久化
// ═══════════════════════════════════════════════════════════════

/**
 * 流转 Slice 的 status：算 next PlanningStatus → append StatusChange → 更新 unit.status。
 *
 * 对 replan 旁路 action 也适用（nextPlanningStatus 返回 current 不变，from=to=current 仍 append）。
 *
 * @param unit 待流转的 Slice（会被 mutate）
 * @param action 触发的 PlanningAction
 * @param at ISO 8601 时间戳（来自 deps.clock.now()）
 * @param note 可选说明（replan 原因 / abort 原因）
 */
export function sliceTransition(
  unit: Slice,
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
 * 把 Slice 存到 store。
 *
 * 同 wave 的 saveUnit 模式：Slice 无索引签名，WorkUnitRecord 带 `[key: string]: unknown`，
 * 需 unknown 中转。语义安全——Slice 字段全 JSON 可序列化，store 不解释不裁剪。
 */
export function saveSlice(
  deps: { store: { save: (u: WorkUnitRecord) => void } },
  unit: Slice,
): void {
  // eslint-disable-next-line taste/no-unsafe-cast
  deps.store.save(unit as unknown as WorkUnitRecord);
}

// ═══════════════════════════════════════════════════════════════
// 最小导航（W6 guidance worker 会美化）
// ═══════════════════════════════════════════════════════════════

/** buildSliceNextAction 可选参数。 */
export interface BuildSliceNextActionOpts {
  /** 覆盖默认下一步 action（execute/终态时调用方传 undefined 表示停留）。 */
  nextActionOverride?: string;
  /** 跨层建议（execute 下沉 / closeout 回溯）。 */
  crossLayer?: CwNextAction["crossLayer"];
}

/**
 * 构建 slice handler 正常路径的 CwNextAction（w2：接入 buildNormalGuidance 三段式）。
 *
 * 照 wave internal.ts 的 buildNextAction 流水线：
 *   prefix → PLANNING_STAGE_TEMPLATES 查约束 → getSliceSchemaText 取 schema → buildNormalGuidance 组装。
 *
 * @param unit 刚完成流转的 Slice
 * @param action 刚执行完的 PlanningAction
 * @param opts 可选覆盖（下一步 action / crossLayer）
 */
export function buildSliceNextAction(
  unit: Slice,
  action: PlanningAction,
  opts?: BuildSliceNextActionOpts,
): CwNextAction {
  const statusDisplay = SLICE_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "slice",
    unitId: unit.id,
    status: statusDisplay,
    parentUnitId: unit.parentUnitId,
  });

  const template = PLANNING_STAGE_TEMPLATES[action];
  const templateText = template?.constraint ?? "";
  const goal = template?.goal ?? `（${action} 阶段）`;
  const schemaText = getSliceSchemaText(action);
  // design-review 特判：基类 DesignReviewJudgment 的 layerSpecific 下界是 Record<string,string>，
  // 这里追加 slice 专属 6 字段名，提示 agent 必须填这些 key（机器 gate layer-specific-non-empty 会验）。
  const finalSchemaText =
    action === "design-review"
      ? `${schemaText}\nlayerSpecific 必须包含以下 key: techChoiceRationale, interfaceContractNote, dataModelSoundness, errorCoverage, testabilityNote, crossWaveContractNote`
      : schemaText;

  const nextAction = opts?.nextActionOverride ?? SLICE_ACTION_TO_NEXT_PUBLIC[action];
  const command = buildSliceCommand(action, unit.id, nextAction, unit.slug);

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
      layer: "slice",
      unitId: unit.id,
      parentUnitId: unit.parentUnitId,
      rootUnitId: unit.id,
    },
    ...(opts?.crossLayer !== undefined ? { crossLayer: opts.crossLayer } : {}),
  };
}

/**
 * 组装 slice 命令字符串（照 wave internal.ts 的 buildWaveNextCommand）。
 *
 * 终态（nextAction=undefined）→ 仅状态提示，命令为空；有结构化或扁平 input → 附 --input。
 * 命令本体由 buildCommand（utils/command.ts）统一构造，input 路径由 inputFilePath 算出。
 */
function buildSliceCommand(
  currentAction: PlanningAction,
  unitId: string,
  nextAction: string | undefined,
  slug: string,
): string {
  if (nextAction === undefined) {
    return `（当前 ${currentAction} 已结束本层流程，无下一步命令）`;
  }
  const hasInput = SLICE_ACTION_SCHEMA[nextAction] !== undefined ||
    SLICE_FLAT_INPUT_HINT[nextAction] !== undefined;
  const inputPart = hasInput ? `--input ${inputFilePath(slug, nextAction)}` : "";
  return buildCommand(nextAction, `--unitId ${unitId}`, inputPart);
}

/**
 * 为 handoff 路径构建「当前步」命令（command 用当前 action，不是 nextAction）。
 *
 * 与 buildSliceCommand 的区别：后者用 nextAction 组装命令（导航下一步）；
 * 本函数用 action 自身组装命令（重建「现在该跑什么」认知）。handoff 的接手 agent
 * 看 guidance 应得到与外层「下一步执行」一致的命令，而非「跑完后再跑的下一步」。
 */
function buildSliceCurrentCommand(
  action: PlanningAction,
  unitId: string,
  slug: string,
): string {
  const hasInput = SLICE_ACTION_SCHEMA[action] !== undefined ||
    SLICE_FLAT_INPUT_HINT[action] !== undefined;
  const inputPart = hasInput ? `--input ${inputFilePath(slug, action)}` : "";
  return buildCommand(action, `--unitId ${unitId}`, inputPart);
}

/**
 * 构建 slice handler handoff 路径的「当前步」guidance（command 用当前 action）。
 *
 * 与 buildSliceNextAction 的区别：后者返回「跑完 action 后的下一步导航」
 * （command 用 nextAction，供 handler 填 ActionResult.nextAction）；本函数返回
 * 「现在该跑的 guidance」（command 用当前 action，供 handoff 重建当前步认知）。
 * 其余片段（prefix/goal/template/schemaText）复用与 buildSliceNextAction 完全一致的查表逻辑，
 * 因为这些片段本就基于「当前 action」，与 nextAction 无关。
 *
 * @param unit 待交接的 Slice
 * @param action 接手 agent 现在该跑的 PlanningAction（handoff 视角的当前步）
 */
export function buildSliceCurrentActionGuidance(unit: Slice, action: PlanningAction): string {
  const statusDisplay = SLICE_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "slice",
    unitId: unit.id,
    status: statusDisplay,
    parentUnitId: unit.parentUnitId,
  });

  const template = PLANNING_STAGE_TEMPLATES[action];
  const templateText = template?.constraint ?? "";
  const goal = template?.goal ?? `（${action} 阶段）`;
  const baseSchemaText = getSliceSchemaText(action);
  // design-review 特判：与 buildSliceNextAction 一致（layerSpecific 必含 slice 专属 6 key）。
  const schemaText =
    action === "design-review"
      ? `${baseSchemaText}\nlayerSpecific 必须包含以下 key: techChoiceRationale, interfaceContractNote, dataModelSoundness, errorCoverage, testabilityNote, crossWaveContractNote`
      : baseSchemaText;

  const command = buildSliceCurrentCommand(action, unit.id, unit.slug);

  return buildNormalGuidance({
    prefix,
    nextAction: action,
    goal,
    command,
    schemaText,
    templateText,
    commonGuidance: buildSubagentGuidance("planning", action),
  });
}

// ═══════════════════════════════════════════════════════════════
// gate/freeze fail 路径（最小异常导航）
// ═══════════════════════════════════════════════════════════════

/**
 * 往 statusHistory append 一条 gate/freeze fail 记录（failureCount 的派生源）。
 *
 * 同 wave appendFailRecord 模式：记录形态 `{ action, to: 当前 status, note: "gate fail: <原因>" }`，
 * 不改 status（fail 诊断记录不是状态转换）。
 */
export function appendSliceFailRecord(
  deps: CwDeps,
  unit: Slice,
  action: PlanningAction,
  reason: string,
): void {
  unit.statusHistory.push({
    to: unit.status,
    at: deps.clock.now(),
    action,
    note: `gate fail: ${reason}`,
  });
  saveSlice(deps, unit);
}

/**
 * 构建 slice handler fail 路径的 CwNextAction + failureCount（w2：接入 buildFailureGuidance 四段式）。
 *
 * 照 wave internal.ts 的 buildFailureNextAction 流水线：
 *   prefix（status 标注「未变」）→ deriveFailureCount（含本次）→ buildFailureHint → buildFailureGuidance。
 *
 * @param unit 已 appendSliceFailRecord 的 Slice
 * @param action 触发 fail 的 PlanningAction（修正后重提同一 action）
 * @param problem gate fail 的具体问题（哪个字段/哪个条件没满足）
 */
export function buildSliceFailureNextAction(
  unit: Slice,
  action: PlanningAction,
  problem: string,
): { nextAction: CwNextAction; failureCount: number } {
  const statusDisplay = SLICE_STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "slice",
    unitId: unit.id,
    status: `${statusDisplay}（未变）`,
    parentUnitId: unit.parentUnitId,
  });

  const failureCount = deriveFailureCount(unit.statusHistory, action);
  const failureHint = buildFailureHint(failureCount, unit.id, action, unit.slug);
  const fixCommand = buildSliceCommand(action, unit.id, action, unit.slug);

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
        layer: "slice",
        unitId: unit.id,
        parentUnitId: unit.parentUnitId,
        rootUnitId: unit.id,
      },
    },
    failureCount,
  };
}

// ═══════════════════════════════════════════════════════════════
// 安全读取辅助（从 WorkUnitRecord 读 status / statusHistory，用于级联 abort）
// ═══════════════════════════════════════════════════════════════

/**
 * 从 WorkUnitRecord 安全读 status 字符串（级联 abort 时读 child 状态用）。
 *
 * child 可能是任意层（wave/slice/...），status 联合类型无法静态收窄，统一按 string 读。
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
