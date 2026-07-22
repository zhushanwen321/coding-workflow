/**
 * v1 handlers 内部编排辅助（不对外导出，仅 handlers/ 内部用）。
 *
 * 来源：v5 wave 附录 A §10（统一编排流程）。
 *
 * 职责：封装三个重复模式，避免 11 个 handler 各写一遍：
 *   1. transitionStatus / saveUnit：算 next status + append statusHistory + 更新 unit.status + 持久化
 *   2. buildNextAction：正常路径的 guidance 填充（prefix + 模板 + schema + 组装 V1NextAction）
 *   3. buildFailureNextAction / appendFailRecord：gate fail 路径的异常 guidance + failureCount 派生
 *
 * 注意：buildNextAction 是 handler 层内部的便利封装，不是业务规则（规则在 rules/state-machine.ts）。
 *
 * 不变量：transitionStatus / saveUnit / appendFailRecord 是纯编排（IO 仅经 deps）；guidance 填充
 *      读 core 源文件生成 schema（构建期/运行期均可，内部按 action 缓存，每 action 仅读一次）。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import type { ExecutionStatus } from "../core/status.js";
import {
  buildFailureHint,
  deriveFailureCount,
  buildPrefix,
  buildNormalGuidance,
  buildFailureGuidance,
  injectSchema,
  WAVE_STAGE_TEMPLATES,
} from "../guidance/index.js";
import type { WaveAction } from "../rules/state-machine.js";
import { nextWaveStatus } from "../rules/state-machine.js";
import type { WorkUnitRecord } from "../store/schema.js";
import type { V1NextAction, V1Deps } from "./types.js";

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

// ═══════════════════════════════════════════════════════════════
// guidance 填充辅助（W7：11 个 handler 共用）
// ═══════════════════════════════════════════════════════════════
//
// 设计：guidance 填充把 prefix-builder / schema-injector / templates / build-guidance
// 串成一条流水线，输出 V1NextAction。三个静态映射表是 handler 层内部知识
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
 * action → 该 action 的 input schema 来源（core 源文件 + interface 名）。
 *
 * injectSchema 从源码自动提取 schema 文本（§3.6），避免类型改了 guidance 漂移。
 * undefined 表示该 action 无结构化 input（create 的 slug/objective 是扁平参数，不走 schema block）。
 */
interface SchemaSource {
  sourceFilePath: string;
  interfaceName: string;
}

const ACTION_SCHEMA: Readonly<Record<string, SchemaSource | undefined>> = {
  create: undefined,
  clarify: { sourceFilePath: "src/v1/core/clarifications.ts", interfaceName: "Clarification" },
  plan: { sourceFilePath: "src/v1/core/plan.ts", interfaceName: "WaveTask" },
  "design-review": { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "DesignReviewJudgment" },
  execute: undefined,
  test: { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "TestJudgment" },
  "exec-review": { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "ExecReviewJudgment" },
  retrospect: { sourceFilePath: "src/v1/core/judgments.ts", interfaceName: "RetrospectData" },
  closeout: { sourceFilePath: "src/v1/core/evidence.ts", interfaceName: "ArtifactRef" },
  replan: undefined,
  abort: undefined,
};

/**
 * schema 文本缓存（按 action，模块级，整个进程只读一次源文件）。
 *
 * injectSchema 会 createSourceFile 解析 core TS（有成本），且 schema 是静态的
 * （core 源码运行期不变），缓存避免每次 handler 调用都重读重解析。
 */
const schemaCache = new Map<string, string>();

/**
 * 取某 action 的 input schema 文本（带缓存 + 降级）。
 *
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
    try {
      text = injectSchema(source.sourceFilePath, source.interfaceName);
    } catch {
      // 降级：源文件缺失或 interface 不存在时给出可读提示，不阻断 guidance。
      text = `（无法从 ${source.sourceFilePath} 提取 ${source.interfaceName} schema，请检查源文件）`;
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
  execute: "{ commitHash: string, changedFiles?: string[] }",
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
  crossLayer?: V1NextAction["crossLayer"];
}

/**
 * 构建正常路径的 V1NextAction（ok=true 时 handler 调用，填入 ActionResult.nextAction）。
 *
 * 流水线：prefix-builder → templates 查约束 → schema-injector（带缓存）→ buildNormalGuidance → 组装 V1NextAction。
 *
 * @param unit 刚完成流转 / 存好的 unit（读 status / id / parentUnitId 做位置 + 导航）
 * @param action 刚执行完的 action（查模板 + schema + 下一步）
 */
export function buildNextAction(
  unit: ExecutionUnit,
  action: WaveAction,
  opts?: BuildNextActionOpts,
): V1NextAction {
  const statusDisplay = STATUS_DISPLAY[unit.status] ?? unit.status;
  const prefix = buildPrefix({
    layer: "wave",
    unitId: unit.id,
    status: statusDisplay,
    parentUnitId: unit.parentUnitId,
  });

  const template = WAVE_STAGE_TEMPLATES[action];
  const templateText = template?.constraint ?? "";
  const schemaText = opts?.schemaTextOverride ?? getSchemaText(action);

  const nextAction = opts?.nextActionOverride ?? ACTION_TO_NEXT[action];
  const command = buildCommand(action, unit.id, nextAction);

  const guidance = buildNormalGuidance({
    prefix,
    nextAction: action,
    command,
    schemaText,
    templateText,
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
  nextAction: V1NextAction;
  /** 填入 ActionResult.failureCount（含本次 fail 的连续计数）。 */
  failureCount: number;
}

/**
 * 构建 gate fail 路径的 V1NextAction + failureCount（ok=false 时 handler 调用）。
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
  const failureHint = buildFailureHint(failureCount);

  const fixCommand = buildCommand(action, unit.id, action);

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
  deps: V1Deps,
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
 * 格式（§4.x）：`cw <action> --unitId <id>`（有 input 时附 `--input @<action>.json`）。
 * 终态（nextAction=undefined）→ 仅给状态提示，命令为空。
 */
function buildCommand(
  currentAction: WaveAction,
  unitId: string,
  nextAction: string | undefined,
): string {
  if (nextAction === undefined) {
    return `（当前 ${currentAction} 已结束本层流程，无下一步命令）`;
  }
  const hasInput = ACTION_SCHEMA[nextAction] !== undefined ||
    FLAT_INPUT_HINT[nextAction] !== undefined;
  const inputPart = hasInput ? ` --input @${nextAction}.json` : "";
  return `cw ${nextAction} --unitId ${unitId}${inputPart}`;
}
