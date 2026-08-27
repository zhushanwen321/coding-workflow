/**
 * gate 域描述符（design-release-pipeline.md §3.3 D2/D5，rp-0；PipelineStepRan 加法属 rp-2/W2 预落地）
 * ——EventLedger 泛化机制的域注入点，对照 unit 域的 unitLedgerDomain（src/store/ledger-domain.ts）。
 *
 * 三层域知识收敛于此：
 *   1. 封闭集 = {GateCheckRan, GateCacheHit, PipelineStepRan}（信封形状校验 readAll 检测用）
 *   2. 锚 = check 类事件的 payload.check / step 类事件的 payload.pipeline（信封锚校验 + readUnit 按锚过滤）
 *   3. validateAppend = GateCheckRan 的 check+runId 幂等 + PipelineStepRan 的
 *      pipeline+step+runId 幂等；**无孤儿概念**——GateCacheHit/PipelineStepRan
 *      可独立存在（首条事件无需任何先导，与 unit 域「一切事件须先有
 *      UnitCreated」结构性不同：缓存/步骤事实没有生命周期，命中复用不依赖
 *      任何「创建」事实）
 */
import type { LedgerDomain } from "../store/ledger-domain.js";
import type {
  GateCheckRanPayload,
  GateDiscriminatedEvent,
  GateEventMap,
  PipelineStepRanPayload,
} from "./types.js";

/**
 * GateCheckRan 幂等命中（同 check+runId 已入账）的可区分拒绝。
 *
 * 对照 unit 域 DuplicateEvidenceError 的消费模式：wrap 层据此把「重试同一
 * 提交」转为幂等成功（不 append——账本本就无重复记账）；其他消费方仍可当
 * 普通 Error 透传（消息自带恢复动作）。
 */
export class DuplicateGateCheckError extends Error {
  readonly check: string;
  readonly runId: string;

  constructor(check: string, runId: string) {
    super(
      `gate 账本: 拒绝重复追加 GateCheckRan：check "${check}" + runId "${runId}" 已入账（幂等键防重复记账）。恢复动作：确认已入账可 queryGate 查看该 check；重跑请使用新 runId 或不传 --run-id 交由 wrap 自动生成。`,
    );
    this.name = "DuplicateGateCheckError";
    this.check = check;
    this.runId = runId;
  }
}

/** gate 域事件 type 的运行时枚举集（types.ts GateEventType 的投影，信封校验单一出处） */
const GATE_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "GateCheckRan",
  "GateCacheHit",
  "PipelineStepRan",
]);

/** PipelineStepRan 幂等命中（同 pipeline+step+runId 已入账）的可区分拒绝（对照 DuplicateGateCheckError 同构）。 */
export class DuplicatePipelineStepError extends Error {
  readonly pipeline: string;
  readonly step: string;
  readonly runId: string;

  constructor(pipeline: string, step: string, runId: string) {
    super(
      `gate 账本: 拒绝重复追加 PipelineStepRan：pipeline "${pipeline}" + step "${step}" + runId "${runId}" 已入账（幂等键防重复记账）。恢复动作：确认已入账可查 pipeline status；重跑请使用新 runId。`,
    );
    this.name = "DuplicatePipelineStepError";
    this.pipeline = pipeline;
    this.step = step;
    this.runId = runId;
  }
}

/**
 * gate 域描述符。validateAppend 校验两类幂等键——GateCacheHit 无 runId 字段
 * （命中复用不是新执行事实），同内容多次命中照记（每次 wrap 都是独立的一次
 * 验证请求，审计链完整优先于条目去重）。
 */
export const gateLedgerDomain: LedgerDomain<GateEventMap> = {
  knownEventTypes: GATE_EVENT_TYPES,
  typeSetLabel: "三类事件枚举（GateCheckRan/GateCacheHit/PipelineStepRan）",
  anchorOf: (payload) =>
    // check 类事件锚 = check；step 类事件锚 = pipeline（两类锚字段不同，
    // 按实际字段分支；两锚全缺 = 损坏信封，报组合锚名方便定位）
    typeof payload.check === "string"
      ? { name: "check", value: payload.check }
      : typeof payload.pipeline === "string"
        ? { name: "pipeline", value: payload.pipeline }
        : { name: "check/pipeline", value: payload.check },
  anchorLabel: "gate 域事件锚字段（check 类=payload.check，step 类=payload.pipeline）",

  validateAppend(type, payload, prior) {
    // 宽泛的泛型信封 type 与 payload 不联动，判别联合视图才能按 type 窄化
    // （对照 unitLedgerDomain 对 DiscriminatedEvent 的同款处理）
    const events = prior as GateDiscriminatedEvent[];
    if (type === "GateCheckRan") {
      const checkPayload = payload as GateCheckRanPayload;
      const duplicated = events.some(
        (e) => e.type === "GateCheckRan" && e.payload.runId === checkPayload.runId && e.payload.check === checkPayload.check,
      );
      if (duplicated) {
        throw new DuplicateGateCheckError(checkPayload.check, checkPayload.runId);
      }
      return;
    }
    if (type === "PipelineStepRan") {
      const step = payload as PipelineStepRanPayload;
      const duplicated = events.some(
        (e) =>
          e.type === "PipelineStepRan" &&
          e.payload.pipeline === step.pipeline &&
          e.payload.step === step.step &&
          e.payload.runId === step.runId,
      );
      if (duplicated) {
        throw new DuplicatePipelineStepError(step.pipeline, step.step, step.runId);
      }
      return;
    }
    // GateCacheHit：无孤儿概念、无幂等键，独立存在
  },
};
