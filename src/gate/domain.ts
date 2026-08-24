/**
 * gate 域描述符（design-release-pipeline.md §3.3 D2/D5，rp-0）——EventLedger
 * 泛化机制的域注入点，对照 unit 域的 unitLedgerDomain（src/store/ledger-domain.ts）。
 *
 * 三层域知识收敛于此：
 *   1. 封闭集 = {GateCheckRan, GateCacheHit}（信封形状校验 readAll 检测用）
 *   2. 锚 = payload.check（两类事件共有；信封锚校验 + readUnit 按锚过滤）
 *   3. validateAppend = 仅 GateCheckRan 的 check+runId 幂等；**无孤儿概念**
 *      ——GateCacheHit 可独立存在（首条事件无需任何先导，与 unit 域「一切
 *      事件须先有 UnitCreated」结构性不同：缓存条目没有生命周期，命中复用
 *      不依赖任何「创建」事实）
 */
import type { LedgerDomain } from "../store/ledger-domain.js";
import type { GateCheckRanPayload, GateDiscriminatedEvent, GateEventMap } from "./types.js";

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
]);

/**
 * gate 域描述符。validateAppend 只校验 GateCheckRan 的幂等键——GateCacheHit
 * 无 runId 字段（命中复用不是新执行事实），同内容多次命中照记（每次 wrap 都
 * 是独立的一次验证请求，审计链完整优先于条目去重）。
 */
export const gateLedgerDomain: LedgerDomain<GateEventMap> = {
  knownEventTypes: GATE_EVENT_TYPES,
  typeSetLabel: "两类事件枚举（GateCheckRan/GateCacheHit）",
  anchorOf: (payload) => ({ name: "check", value: payload.check }),
  anchorLabel: "gate 域两类事件 payload 的共有锚字段",

  validateAppend(type, payload, prior) {
    if (type !== "GateCheckRan") {
      return; // GateCacheHit：无孤儿概念、无幂等键，独立存在
    }
    // 参数是宽 union（type 与 payload 不联动），此分支按类型收窄到
    // GateCheckRanPayload（对照 unitLedgerDomain 对 EvidenceSubmittedPayload 的同款处理）
    const runId = (payload as GateCheckRanPayload).runId;
    // 宽泛的泛型信封 type 与 payload 不联动，判别联合视图才能按 type 窄化
    // （对照 unitLedgerDomain 对 DiscriminatedEvent 的同款处理）
    const events = prior as GateDiscriminatedEvent[];
    const duplicated = events.some(
      (e) => e.type === "GateCheckRan" && e.payload.runId === runId && e.payload.check === payload.check,
    );
    if (duplicated) {
      throw new DuplicateGateCheckError(payload.check, runId);
    }
  },
};
