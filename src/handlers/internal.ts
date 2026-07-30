/**
 * v1 handlers 内部编排辅助（不对外导出，仅 handlers/ 内部用）。
 *
 * 来源：v5 wave 附录 A §10（统一编排流程）。
 *
 * 职责：封装三个重复模式，避免 11 个 handler 各写一遍：
 *   1. transitionStatus / saveUnit：算 next status + append statusHistory + 更新 unit.status + 持久化
 *   2. buildNextAction：正常路径的 guidance 填充（prefix + 模板 + schema + 组装 CwNextAction）
 *   3. buildFailureNextAction / appendFailRecord：gate fail 路径的异常 guidance + failureCount 派生
 *
 * 注意：buildNextAction 是 handler 层内部的便利封装，不是业务规则（规则在 rules/state-machine.ts）。
 *
 * 不变量：transitionStatus / saveUnit / appendFailRecord 是纯编排（IO 仅经 deps）；guidance 填充
 *      读 core 源文件生成 schema（构建期/运行期均可，内部按 action 缓存，每 action 仅读一次）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AbandonedRef, ExecutionStatus, StatusChange } from "../core/status.js";
import type { ExecutionUnit, WorkUnitBase } from "../core/workunit.js";
import { ACTION_SCHEMA } from "../guidance/action-schemas.js";
import {
  buildFailureGuidance,
  buildFailureHint,
  buildNormalGuidance,
  buildPrefix,
  buildSubagentGuidance,
  deriveFailureCount,
  injectSchema,
  WAVE_STAGE_TEMPLATES,
} from "../guidance/index.js";
import type { WaveAction } from "../rules/state-machine.js";
import { nextWaveStatus } from "../rules/state-machine.js";
import type { CwStore } from "../store/cw-store.js";
import type { WorkUnitRecord } from "../store/schema.js";
import { buildCommand, inputFilePath } from "../utils/command.js";
import type { CwDeps,CwNextAction } from "./types.js";

/**
 * 流转 unit status：算 next → append StatusChange → 更新 unit.status。
 *
 * 对 replan 旁路 action 也适用（nextWaveStatus 返回 current 不变，from=to=current 仍 append）。
 *
 * @param unit 待流转的 unit（会被 mutate：push statusHistory + 改 status）
 * @param action 触发的 action
 * @param at ISO 8601 时间戳（来自 deps.clock.now()）
 * @param note 可选说明（replan 原因 / abort 原因）
 */
export function transitionStatus(
  unit: ExecutionUnit,
  action: WaveAction,
  at: string,
  note?: string,
): void {
  const from = unit.status;
  const next = nextWaveStatus(action, from);
  unit.statusHistory.push({
    from,
    to: next,
    at,
    action,
    note,
  });
  unit.status = next;
}

/**
 * 把 ExecutionUnit 存到 store。
 *
 * store 的 WorkUnitRecord 带 `[key: string]: unknown` 索引签名（schema.ts 注释：直接序列化
 * ExecutionUnit 全字段），而 ExecutionUnit 是具名接口无索引签名——TS 结构兼容性要求赋值方也有索引签名，
 * 故需要一次 `unknown` 中转。语义安全：ExecutionUnit 字段全 JSON 可序列化，store 不解释不裁剪。
 *
 * @param deps 依赖注入（取 store）
 * @param unit 待持久化的 ExecutionUnit
 */
export function saveUnit(deps: { store: { save: (u: WorkUnitRecord) => void } }, unit: ExecutionUnit): void {
  // 双重断言是必要的：ExecutionUnit 无索引签名，无法直接赋值给带 `[key: string]: unknown`
  // 的 WorkUnitRecord。store 按 schema.ts 设计直接序列化全字段，语义安全。
  // eslint-disable-next-line taste/no-unsafe-cast
  deps.store.save(unit as unknown as WorkUnitRecord);
}

/**
 * append-only 合并 input.abandonParentItems 到 unit.abandonedParentItems（Set 去重）。
 *
 * 跨层跨时机的 abandon parent 条目声明通道（ADR-0010）：
 *   - 任何层的 plan/replan handler 调一次（显式 input 通道）
 *   - wave execute handler 用 commit trailer 解析结果调（顺便通道）
 *
 * input 无 abandonParentItems 或为空数组时是 no-op（null/undefined 安全）。
 * 空字符串、纯空白、非字符串值会被过滤（避免 trailer 解析噪声或空 input 污染集合）。
 * 一旦声明不可撤回（append-only，符合 model §5.6）。
 */
export function mergeAbandonParentItems(
  unit: { abandonedParentItems?: string[] },
  input: { abandonParentItems?: string[] },
): void {
  if (!input.abandonParentItems || input.abandonParentItems.length === 0) return;
  const existing = new Set(unit.abandonedParentItems ?? []);
  for (const id of input.abandonParentItems) {
    if (typeof id === "string" && id.trim() !== "") existing.add(id);
  }
  unit.abandonedParentItems = [...existing];
}

// ═══════════════════════════════════════════════════════════════
// guidance 填充辅助（W7：11 个 handler 共用）
// ═══════════════════════════════════════════════════════════════
//
// 设计：guidance 填充把 prefix-builder / schema-injector / templates / build-guidance
// 串成一条流水线，输出 CwNextAction。三个静态映射表是 handler 层内部知识
// （哪个 action 的下一步是什么 / 哪个 input 用哪个 schema / 状态如何中文化），
// 放这里而不是 guidance/ 下——因为这些映射只服务于 wave handler 编排，
// 且会随 action 增减而变（guidance/ 是通用渲染层，不感知 wave 的 action 列表）。

/**
 * status → 中文展示（prefix-builder 的 status 参数要中文字符串）。
 *
 * 设计来源：v5 cli-and-guidance §4.x 示例（位置段用中文状态）。
 */
const STATUS_DISPLAY: Readonly<Record<ExecutionStatus, string>> = {
  created: "已创建",
  clarifying: "需求澄清中",
  planning: "计划编写中",
  "design-reviewed": "已过设计审查",
  executing: "执行编码中",
  tested: "已测试",
  "exec-reviewed": "已过代码品味审查",
  retrospected: "已复盘",
  closed: "已冻结交付",
  aborted: "已中止",
};

/**
 * action → 下一步 action（WAVE_TRANSITIONS 状态机的 next-action 映射）。
 *
 * 终态 action（closeout / abort）的下一步不在本层——由调用方额外填 crossLayer
 * （closeout）或留 undefined（abort，流程结束）。
 */
const ACTION_TO_NEXT: Readonly<Record<string, string | undefined>> = {
  create: "clarify",
  clarify: "plan",
  plan: "design-review",
  "design-review": "execute",
  execute: "test",
  test: "exec-review",
  "exec-review": "retrospect",
  retrospect: "closeout",
  closeout: undefined,
  replan: "plan",
  abort: undefined,
};

/**
 * schema 文本缓存（按 action，模块级，整个进程只读一次源文件）。
 *
 * 优先读取 build 阶段预生成的 dist/guidance/schemas.gen.json；未命中时降级到
 * injectSchema 实时解析 src/core/*.ts（开发时无 build 产物仍可工作）。
 */
const schemaCache = new Map<string, string>();

/** 从预计算 JSON 产物读取某 action 的 schema 文本。 */
interface SchemaGenFile {
  [action: string]: { schemaText: string } | undefined;
}

/**
 * 定位预计算 schema 产物路径。
 *
 * 本文件在 src/handlers/internal.ts 或 dist/handlers/internal.js 中运行，
 * 向上三层即项目根目录，再拼 dist/guidance/schemas.gen.json。
 */
function getSchemaGenFilePath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const projectRoot = dirname(dirname(dirname(currentFile)));
  return resolve(projectRoot, "dist", "guidance", "schemas.gen.json");
}

/**
 * 取某 action 的 input schema 文本（带缓存 + 优先读预计算产物 + 降级）。
 *
 * - 命中 dist/guidance/schemas.gen.json 中对应 action → 直接返回产物中的 schemaText。
 * - 产物缺失或损坏 → 降级到 injectSchema 实时解析 src/core/*.ts。
 * - 源文件缺失 / interface 不存在 → 返回降级提示文本（不抛错，guidance 不应因 schema 生成失败而中断；
 *   schema 是给 agent 看的辅助信息，缺失只降级体验）。
 * - 同一 action 第二次调用命中缓存。
 */
function getSchemaText(action: string): string {
  const cached = schemaCache.get(action);
  if (cached !== undefined) {
    return cached;
  }
  const source = ACTION_SCHEMA[action];
  let text: string;
  if (source === undefined) {
    // 无结构化 schema 的 action（create / execute / replan / abort）：用扁平参数提示。
    text = FLAT_INPUT_HINT[action] ?? "（无结构化 input schema）";
  } else {
    const genPath = getSchemaGenFilePath();
    if (existsSync(genPath)) {
      try {
        const genFile = JSON.parse(readFileSync(genPath, "utf-8")) as SchemaGenFile;
        const entry = genFile[action];
        if (entry?.schemaText !== undefined) {
          text = entry.schemaText;
        } else {
          text = injectSchema(source.sourceFilePath, source.interfaceName);
        }
      } catch {
        text = injectSchema(source.sourceFilePath, source.interfaceName);
      }
    } else {
      try {
        text = injectSchema(source.sourceFilePath, source.interfaceName);
      } catch {
        // 降级：源文件缺失或 interface 不存在时给出可读提示，不阻断 guidance。
        text = `（无法从 ${source.sourceFilePath} 提取 ${source.interfaceName} schema，请检查源文件）`;
      }
    }
  }
  schemaCache.set(action, text);
  return text;
}

/**
 * 无结构化 schema 的 action 的扁平参数提示（§4.x：命令直接带参数）。
 */
const FLAT_INPUT_HINT: Readonly<Record<string, string>> = {
  create: "{ slug: string, objective: string, parentUnitId?: string, basedOnParent?: string[] }",
  execute: "{ commitHash: string }（changedFiles 已废弃，cw 从 commit 自动提取）",
  replan: "{ abandonedIds: string[], note: string }",
  abort: "{ reason?: string }",
};

/** buildNextAction 可选参数。 */
export interface BuildNextActionOpts {
  /**
   * 覆盖默认的「下一步 action」（如 progressive action 时下一步仍是自身）。
   * 不传则按 ACTION_TO_NEXT 查。
   */
  nextActionOverride?: string;
  /** 覆盖默认的 schema 文本（极少用，replan 等特殊场景）。 */
  schemaTextOverride?: string;
  /** 填 crossLayer（closeout 后回溯，由调用方调 computeCrossLayerAfterCloseout 算好传入）。 */
  crossLayer?: CwNextAction["crossLayer"];
}

/**
 * 构建正常路径的 CwNextAction（ok=true 时 handler 调用，填入 ActionResult.nextAction）。
 *
 * 流水线：prefix-builder → templates 查约束 → schema-injector（带缓存）→ buildNormalGuidance → 组装 CwNextAction。
 *
 * @param unit 刚完成流转 / 存好的 unit（读 status / id / parentUnitId 做位置 + 导航）
 * @param action 刚执行完的 action（查模板 + schema + 下一步）
 */
export function buildNextAction(
  unit: ExecutionUnit,
  action: WaveAction,
  opts?: BuildNextActionOpts,
): CwNextAction {
  const statusDisplay = STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "wave",
    unitId: unit.id,
    status: statusDisplay,
    parentUnitId: unit.parentUnitId,
  });

  const template = WAVE_STAGE_TEMPLATES[action];
  const templateText = template?.constraint ?? "";
  const goal = template?.goal ?? `（${action} 阶段）`;
  const schemaText = opts?.schemaTextOverride ?? getSchemaText(action);

  const nextAction = opts?.nextActionOverride ?? ACTION_TO_NEXT[action];
  const command = buildWaveNextCommand(action, unit.id, nextAction, unit.slug);

  const guidance = buildNormalGuidance({
    prefix,
    nextAction: action,
    goal,
    command,
    schemaText,
    templateText,
    commonGuidance: buildSubagentGuidance("wave", action),
  });

  return {
    action: nextAction,
    guidance,
    unitPath: {
      layer: "wave",
      unitId: unit.id,
      parentUnitId: unit.parentUnitId,
      rootUnitId: unit.id,
    },
    ...(opts?.crossLayer !== undefined ? { crossLayer: opts.crossLayer } : {}),
  };
}

/** buildFailureNextAction 返回。 */
export interface FailureNextAction {
  /** 填入 ActionResult.nextAction 的异常 guidance 结构。 */
  nextAction: CwNextAction;
  /** 填入 ActionResult.failureCount（含本次 fail 的连续计数）。 */
  failureCount: number;
}

/**
 * 构建 gate fail 路径的 CwNextAction + failureCount（ok=false 时 handler 调用）。
 *
 * 流水线：prefix-builder（status 标注「未变」）→ deriveFailureCount（含本次）→ buildFailureHint → buildFailureGuidance（四段式）。
 *
 * failureCount 语义（§5.1 + FR-4-amend）：appendFailRecord 已把本次 fail 记录入 statusHistory 尾部，
 * 故从 statusHistory 派生的计数含本次（如首次 fail → count=1，第 3 次 fail → count=3）。
 *
 * @param unit 已 appendFailRecord 的 unit（statusHistory 尾部已含本次 gate fail 记录）
 * @param action 触发 fail 的 action（修正后重提同一 action）
 * @param problem gate fail 的具体问题（哪个条件没满足）
 */
export function buildFailureNextAction(
  unit: ExecutionUnit,
  action: WaveAction,
  problem: string,
): FailureNextAction {
  const statusDisplay = STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "wave",
    unitId: unit.id,
    status: `${statusDisplay}（未变）`,
    parentUnitId: unit.parentUnitId,
  });

  // 含本次的连续 fail 次数（appendFailRecord 已 append，故扫描含本次）。
  const failureCount = deriveFailureCount(unit.statusHistory, action);
  const failureHint = buildFailureHint(failureCount, unit.id, action, unit.slug);

  const fixCommand = buildWaveNextCommand(action, unit.id, action, unit.slug);

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
        layer: "wave",
        unitId: unit.id,
        parentUnitId: unit.parentUnitId,
        rootUnitId: unit.id,
      },
    },
    failureCount,
  };
}

/**
 * 往 statusHistory append 一条 gate fail 记录（FR-4-amend：failureCount 的派生源）。
 *
 * 记录形态：`{ action, to: 当前 status, note: "gate fail: <原因>" }`（不改 status，from 留空——
 *   这是 fail 诊断记录不是状态转换，§5.1 派生算法按 note 含 "gate fail" 标记扫描）。
 *
 * append 后 save 到 store，使 failureCount 跨 session 可派生（§5.1「跨 session 不重置」）。
 *
 * @param deps 依赖注入（store + clock）
 * @param unit 触发 fail 的 unit（被 mutate：push statusHistory）
 * @param action 触发 fail 的 action
 * @param reason fail 原因（写入 note）
 */
export function appendFailRecord(
  deps: CwDeps,
  unit: ExecutionUnit,
  action: WaveAction,
  reason: string,
): void {
  unit.statusHistory.push({
    to: unit.status,
    at: deps.clock.now(),
    action,
    note: `gate fail: ${reason}`,
  });
  saveUnit(deps, unit);
}

/**
 * 组装命令字符串（正常路径用 nextAction，异常路径 fixCommand 用 action 自身重提）。
 *
 * 格式（§4.x）：`cw <action> --unitId <id>`（有 input 时附 `--input .cw/<slug>/<action>.json`），
 * 命令本体由 buildCommand（utils/command.ts）统一构造，input 路径由 inputFilePath 算出。
 * 终态（nextAction=undefined）→ 仅给状态提示，命令为空。
 */
function buildWaveNextCommand(
  currentAction: WaveAction,
  unitId: string,
  nextAction: string | undefined,
  slug: string,
): string {
  if (nextAction === undefined) {
    return `（当前 ${currentAction} 已结束本层流程，无下一步命令）`;
  }
  const hasInput = ACTION_SCHEMA[nextAction] !== undefined ||
    FLAT_INPUT_HINT[nextAction] !== undefined;
  const inputPart = hasInput ? `--input ${inputFilePath(slug, nextAction)}` : "";
  return buildCommand(nextAction, `--unitId ${unitId}`, inputPart);
}

// ═══════════════════════════════════════════════════════════════
// PlanningUnit replan 共享 helper（loadChildrenAsWorkUnitBase 的字段映射，
// 供 slice/feature/epic replan handler 的 computeImpactCascade 使用）
// ═══════════════════════════════════════════════════════════════

/**
 * 从 WorkUnitRecord 安全读 statusHistory（返回可 mutate 的副本）。
 *
 * 供 loadChildrenAsWorkUnitBase 和 cascadeAbortUnit 复用——原本三个 PlanningUnit 各自
 * 的 *-internal.ts 有一份完全相同的实现，搬到此处统一导出。
 */
export function readRecordStatusHistory(record: WorkUnitRecord): StatusChange[] {
  const h = record.statusHistory;
  return Array.isArray(h) ? [...(h as StatusChange[])] : [];
}

/**
 * 从 WorkUnitRecord 安全读 basedOnParent（string[]，默认空数组）。
 * 供 loadChildrenAsWorkUnitBase 复用。
 */
export function readBasedOnParent(record: WorkUnitRecord): string[] {
  const v = record.basedOnParent;
  return Array.isArray(v) ? (v as string[]) : [];
}

/**
 * 从 WorkUnitRecord 安全读 abandonedRefs（AbandonedRef[]，默认空数组）。
 * 返回浅拷贝避免外部 mutate 污染 record。
 */
export function readAbandonedRefs(record: WorkUnitRecord): AbandonedRef[] {
  const v = record.abandonedRefs;
  return Array.isArray(v) ? [...(v as AbandonedRef[])] : [];
}

/**
 * 从 WorkUnitRecord 安全读 abandonedParentItems（string[]，默认空数组）。
 * 返回浅拷贝。
 */
export function readAbandonedParentItems(record: WorkUnitRecord): string[] {
  const v = record.abandonedParentItems;
  return Array.isArray(v) ? [...(v as string[])] : [];
}

/**
 * 把 store.findChildren 返回的 WorkUnitRecord[] 映射为 WorkUnitBase[]。
 *
 * computeImpactCascade 只读 id/parentUnitId/basedOnParent/abandonedParentItems
 * （影响面计算基础），从 WorkUnitRecord 的 unknown 字段安全提取。
 *
 * defaultScope 用于 record.scope 缺失时的回退（slice 的 child 默认 wave、
 * feature 的 child 默认 slice、epic 的 child 默认 feature）。
 */
export function loadChildrenAsWorkUnitBase(
  store: CwStore,
  parentId: string,
  defaultScope: WorkUnitBase["scope"],
): WorkUnitBase[] {
  const records = store.findChildren(parentId);
  return records.map((r) => ({
    id: r.id,
    scope: typeof r.scope === "string" ? (r.scope as WorkUnitBase["scope"]) : defaultScope,
    slug: typeof r.slug === "string" ? r.slug : r.id,
    parentUnitId: r.parentUnitId,
    status: typeof r.status === "string" ? (r.status as WorkUnitBase["status"]) : "created",
    statusHistory: readRecordStatusHistory(r),
    basedOnParent: readBasedOnParent(r),
    abandonedRefs: readAbandonedRefs(r),
    abandonedParentItems: readAbandonedParentItems(r),
    objective: typeof r.objective === "string" ? r.objective : "",
  }));
}
