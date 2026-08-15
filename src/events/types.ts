/**
 * 领域类型契约（canon《design-rewrite-architecture.md》v3 §3.3 D2/D3 的代码投影）。
 *
 * 本文件是跨 unit 的共享契约层，由主 agent（协调者）维护：
 * - 已有定义不得改名改义；新增类型由 owner unit 追加并经其验收文档背书。
 * 与 canon 的两处显式补充（均为 fold 可判定所必需）：
 *   1. EvidenceSubmitted.sha256 为数组，与 paths 一一对应（canon 为单值，数组化以支持多产物）；
 *   2. VerifyRanPayload.acceptanceIds 记录本次 verify 覆盖的验收 id 集合
 *      （"全部冻结验收 verify 通过"的判定输入，canon 事件清单未含）。
 */

/** 验收用例 type 枚举（canon D3 唯一权威，核心 case 禁 manual 由 spec gate 规则②执行） */
export type AcceptanceType = "unit" | "integration" | "e2e-real" | "e2e-mock" | "manual";

/** 验收（Acceptance）——unit「完成」的可运行定义的原子条目 */
export interface AcceptanceItem {
  /** 验收 id，unit 内唯一，如 "A1" */
  id: string;
  /** 是否核心 case（spec gate 规则②的作用域：核心 case 必须有 e2e 级机器验证） */
  core: boolean;
  /** 用例一句话描述 */
  title: string;
  type: AcceptanceType;
  /** 可执行命令；type ∈ {e2e-real, e2e-mock} 时必填（spec gate 规则③） */
  command?: string;
  /** 场景描述 */
  scenario?: string;
  /** mock 保真度说明；type = e2e-mock 时必填非空（spec gate 规则④） */
  mockFidelityNote?: string;
}

/** 契约（Contract）——跨单元接口承诺，随 spec 一起 hash 冻结 */
export interface Contract {
  id: string;
  kind: "function" | "api" | "class" | "event" | "schema" | "other";
  /** 提供方 unitId */
  provider: string;
  /** 消费方 unitId */
  consumer: string;
  /** 签名文本（集成 verify 机器比对的 hash 对象） */
  signature: string;
  description?: string;
}

/** 分解条目——内部节点 spec 的子节点拆分 */
export interface SplitEntry {
  unitId: string;
  briefRef?: string;
  dependsOn: string[];
  /** 预期触碰文件（文件冲突检查与受影响验收选择的输入） */
  files?: string[];
}

// ---- 五类事件 payload（canon D2 事件模型） ----

export interface UnitCreatedPayload {
  unitId: string;
  /** null = 根节点 */
  parentId: string | null;
  /** 任务书（brief）文件路径 */
  briefRef: string;
}

export interface SpecSubmittedPayload {
  unitId: string;
  /** spec 内容 hash（冻结锚点） */
  specHash: string;
  acceptance: AcceptanceItem[];
  contracts: Contract[];
  split: SplitEntry[];
}

/** 审查结论。append-only，一次写入不可改；引用的 evidenceRefs 必须已存在 */
export interface VerdictSubmittedPayload {
  unitId: string;
  /** spec-review：解冻验收（进入 build）；exec-review：closed 的必要条件 */
  verdictKind: "spec-review" | "exec-review";
  verdict: "pass" | "fail";
  comment?: string;
  /** 引用的证据 id（EvidenceSubmitted.runId），必须已存在 */
  evidenceRefs?: string[];
}

export interface EvidenceSubmittedPayload {
  unitId: string;
  /** 幂等键：同一 runId 重复提交不重复记账 */
  runId: string;
  /** 产物对应的 git commit hash */
  commit: string;
  /** 产物文件路径（相对 evidence 目录） */
  paths: string[];
  /** 与 paths 一一对应的 sha256 */
  sha256: string[];
  exitCode: number;
}

export interface VerifyRanPayload {
  unitId: string;
  runId: string;
  /** EvidenceReport 产物文件内容的 hash */
  reportHash: string;
  result: "pass" | "fail";
  /** 本次 verify 覆盖且通过的验收 id 集合（verified 判定输入） */
  acceptanceIds: string[];
}

// ---- 事件信封与账本 ----

export type EventType =
  | "UnitCreated"
  | "SpecSubmitted"
  | "VerdictSubmitted"
  | "EvidenceSubmitted"
  | "VerifyRan";

export type EventPayloadMap = {
  UnitCreated: UnitCreatedPayload;
  SpecSubmitted: SpecSubmittedPayload;
  VerdictSubmitted: VerdictSubmittedPayload;
  EvidenceSubmitted: EvidenceSubmittedPayload;
  VerifyRan: VerifyRanPayload;
};

export interface EventEnvelope<K extends EventType = EventType> {
  /** 账本内单调递增序号，从 1 起 */
  seq: number;
  /** ISO 8601 时间戳 */
  ts: string;
  type: K;
  payload: EventPayloadMap[K];
}

/** JSONL 一行的运行时形状（反序列化后即 EventEnvelope） */
export type LedgerEvent = EventEnvelope;

// ---- 状态投影 ----

/** canon 四态投影：created → spec-frozen → verified → closed */
export type UnitStatus = "created" | "spec-frozen" | "verified" | "closed";

/** spec gate 结果（u3 的 checkSpecRules 产出；fold 判定 spec-frozen 的注入依赖） */
export interface SpecRulesResult {
  ok: boolean;
  /** 可操作错误信息：每条指向具体缺口（验收 id + 缺什么） */
  failures: string[];
}

/** 单个 unit 的原始投影（事件性事实，fold 直出；语义状态由 deriveStatus 派生） */
export interface UnitProjection {
  unitId: string;
  parentId: string | null;
  briefRef: string;
  /** 按提交顺序的 spec 列表（最后一条为当前生效 spec） */
  specs: SpecSubmittedPayload[];
  verdicts: VerdictSubmittedPayload[];
  evidences: EvidenceSubmittedPayload[];
  verifyRuns: VerifyRanPayload[];
}

/** 账本整体投影（全部 unit + 事件总数） */
export interface Projection {
  units: Map<string, UnitProjection>;
  totalEvents: number;
}
