/**
 * 域描述符（design-release-pipeline.md §3.3 D2）——EventLedger 泛化的领域注入点。
 *
 * store（events-log.ts）只保留领域无关的账本心机制：锁 / seq / fsync / 信封骨架
 * （seq·ts·type·payload 形状）。一切域特化知识——事件封闭集、锚字段、写入不变式
 * ——收敛为本文件的 LedgerDomain 描述符，由 EventLedger 构造注入（缺省 = unit 域
 * 描述符，存量调用点零改动）。后续 gate 域（gate-events.log + GateCheckRan 等
 * 独立事件集）复用同一 store 机制层，仅新增自己的描述符。
 */
import type {
  DiscriminatedEvent,
  EventPayloadMap,
  EvidenceSubmittedPayload,
} from "../events/types.js";

/**
 * 领域无关的账本事件信封（M = 域的 payload 映射表）。与 unit 域的
 * EventEnvelope 同构——M = EventPayloadMap 时两者结构等价，消费方零改动。
 */
export interface DomainEvent<M extends Record<string, unknown> = Record<string, unknown>> {
  seq: number;
  ts: string;
  type: keyof M & string;
  payload: M[keyof M];
}

/** append 的返回值形状（写入瞬间的窄化信封；M = EventPayloadMap 时 ≡ EventEnvelope<K>） */
export interface DomainEnvelope<
  M extends Record<string, unknown>,
  K extends keyof M & string,
> {
  seq: number;
  ts: string;
  type: K;
  payload: M[K];
}

/** 锚字段引用：name 供错误文案（`payload.<name>=…`），value 供信封形状校验。 */
export interface AnchorRef {
  readonly name: string;
  readonly value: unknown;
}

/**
 * 域描述符的读层形状（信封形状校验的依赖面）：封闭集 + 枚举文案 + 锚提取 +
 * 锚文案。validateAppend 不在此层——只读路径（readAll / readUnit）不依赖
 * 写入不变式，接口拆分让依赖面可见（rp-0 D2）。
 */
export interface LedgerDomainShape {
  readonly knownEventTypes: ReadonlySet<string>;
  readonly typeSetLabel: string;
  readonly anchorOf: (payload: Record<string, unknown>) => AnchorRef;
  readonly anchorLabel: string;
}

/**
 * 域描述符契约（领域无关）：
 *   - knownEventTypes：信封 type 校验的封闭集（readAll 损坏行检测）
 *   - typeSetLabel：type 校验失败错误文案里的枚举集描述（如「六类事件枚举（A/B/…）」）
 *   - anchorOf：从 payload 提取锚（unit 域锚 = payload.unitId；gate 域锚 =
 *     check / step / pipeline 等域内锚）——信封形状校验锚为字符串 + 错误文案用
 *   - anchorLabel：锚形状错误文案里的域内描述（如「五类事件 payload 的共有锚字段」）
 *   - validateAppend：锁内追加前的域级不变式（unit 域 = 孤儿拒绝 + UnitCreated
 *     唯一 + EvidenceSubmitted 幂等；gate 域 = check+runId 幂等，无孤儿概念）
 */
export interface LedgerDomain<M extends Record<string, unknown> = Record<string, unknown>>
  extends LedgerDomainShape {
  validateAppend(
    type: keyof M & string,
    payload: M[keyof M],
    prior: readonly DomainEvent<M>[],
  ): void;
}

/**
 * EvidenceSubmitted 幂等命中（同 unitId+runId 已入账）的可区分拒绝。
 *
 * 消费方区分处置：handler 层据此把「重试同一提交」转为幂等成功（exit 0 + 提示，
 * 不 append——账本本就无重复记账）；其他消费方仍可当普通 Error 透传（消息自带
 * 恢复动作）。
 */
export class DuplicateEvidenceError extends Error {
  readonly unitId: string;
  readonly runId: string;

  constructor(unitId: string, runId: string) {
    super(
      `EventLedger: 拒绝重复提交 EvidenceSubmitted：unit "${unitId}" + runId "${runId}" 已入账（幂等键防重复记账）。恢复动作：确认已入账可 readUnit("${unitId}")；重跑请使用新 runId 提交。`,
    );
    this.name = "DuplicateEvidenceError";
    this.unitId = unitId;
    this.runId = runId;
  }
}

/** unit 域事件 type 的运行时枚举集（types.ts EventType 的投影，信封校验单一出处；ph-i1 R4 起 +ReflectionRan） */
const UNIT_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "UnitCreated",
  "SpecSubmitted",
  "VerdictSubmitted",
  "EvidenceSubmitted",
  "VerifyRan",
  "ReflectionRan",
]);

/**
 * unit 域描述符（EventLedger 的缺省域）——原 store 内焊死的三层域概念原样搬迁：
 *   1. 六类事件封闭集（KNOWN_EVENT_TYPES → UNIT_EVENT_TYPES）
 *   2. 锚 = payload.unitId（信封形状校验 + 错误文案）
 *   3. validateAppend 三条 unit 不变式（孤儿拒绝 / UnitCreated 唯一 /
 *      EvidenceSubmitted unitId+runId 幂等，错误文案逐字保留——被 tests 断言）
 * 行为语义与搬迁前逐字节一致（rp-0 泛化是纯重构，行为保持由既有 710+ 用例背书）。
 */
export const unitLedgerDomain: LedgerDomain<EventPayloadMap> = {
  knownEventTypes: UNIT_EVENT_TYPES,
  typeSetLabel:
    "六类事件枚举（UnitCreated/SpecSubmitted/VerdictSubmitted/EvidenceSubmitted/VerifyRan/ReflectionRan）",
  anchorOf: (payload) => ({ name: "unitId", value: payload.unitId }),
  anchorLabel: "五类事件 payload 的共有锚字段",

  validateAppend(type, payload, prior) {
    // 宽泛的泛型信封无法按 type 窄化 payload，判别联合视图处理（见 types.ts）
    const events = prior as DiscriminatedEvent[];
    const unitCreated = events.some(
      (e) => e.type === "UnitCreated" && e.payload.unitId === payload.unitId,
    );

    if (type === "UnitCreated") {
      if (unitCreated) {
        throw new Error(
          `EventLedger: 拒绝追加 UnitCreated：unit "${payload.unitId}" 已创建。恢复动作：账本 append-only 不支持重复创建；如需重新开始请使用新 unitId，查现有 unit 用 readUnit("${payload.unitId}")。`,
        );
      }
      return;
    }
    if (!unitCreated) {
      throw new Error(
        `EventLedger: 拒绝追加 ${type}：unit "${payload.unitId}" 不存在（账本中无其 UnitCreated 事件）。恢复动作：先对该 unit 追加 UnitCreated（cw create），再提交本事件。`,
      );
    }
    if (type === "EvidenceSubmitted") {
      // 参数是宽 union，此分支按类型收窄到 EvidenceSubmittedPayload
      const runId = (payload as EvidenceSubmittedPayload).runId;
      const duplicated = events.some(
        (e) =>
          e.type === "EvidenceSubmitted" &&
          e.payload.unitId === payload.unitId &&
          e.payload.runId === runId,
      );
      if (duplicated) {
        throw new DuplicateEvidenceError(payload.unitId, runId);
      }
    }
  },
};
