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

/**
 * 验收 id 字符集（rv-2 规则⑦与 e2e-sh marker 的同源锚）：字母数字开头，后续可含
 * `.` `_` `-`；禁空格与中文。id 是 e2e-sh 标记行第一列与 nameMatch 名字比对的锚，
 * 字符集外的 id 产出的 e2e 用例永远无法匹配标记行。spec gate（规则⑦）与 e2e-sh
 * 的 MARKER_RE 均由本常量派生——两路合法集同源，禁止各自手写正则漂移。
 */
export const ACCEPTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
  /**
   * 测试框架显式声明（mx-2）：合法值来自 TestRun registry（knownAdapterTypes()：
   * vitest / e2e-sh / pytest / playwright），大小写敏感，须与 registry key 完全
   * 一致。缺省按 type 推导（unit/integration→vitest、e2e-real/e2e-mock→e2e-sh）。
   * 显式声明优先于 type 推导——canon §6.1「适配器选择是确定性查找」裁决 A。
   * 非法值由 spec gate 规则⑧在提交时拦（verify 侧不再二次校验，gate 是唯一入口）。
   */
  runner?: string;
  /**
   * 显式声明该用例含随机性（rv-5，canon 纪律②收口）。豁免且仅豁免两处：
   * 名字比对必过集合（nameMatch 跳过，结果标注 nameSkipped）与单次 fail 的
   * 整体判定（verify/集成的聚合 result 不因该条单次 fail 翻红）；执行照跑、
   * 产物照落盘、原始结果照录 report.json——声明 ≠ 逃逸。
   * 滥用防线 = spec-review 语义审查 + 永远不能自动豁免（flakeReview 转人工
   * 通道不以声明为豁免条件；本字段不是 gate 规则——随机性判定是语义判断）。
   * 已知边界（事件流粒度）：VerifyRan 只记录聚合 pass 集（acceptanceIds），
   * 声明条目经豁免后恒在 pass 集内，其逐次 fail 不进入 flakeReview 的连挂
   * 投影——声明条目的连挂治理依赖 spec-review 把关与人工审计 report.json。
   */
  nondeterministic?: true;
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
  /** 签名应存在的文件（相对仓库根路径）；缺省 = 集成时全树搜索（M2 口径，主 agent 2026-08-15 追加） */
  file?: string;
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
  /**
   * 提交者自报 role（mx-1，canon :221「VerdictSubmitted ← 独立 reviewer」的落地
   * 弱声明）：可选、自报、可伪造——是审计载体不是信任边界（cw review submit 的
   * --role flag 枚举校验只拦手滑不拦伪造）。信任增强来自结构隔离：spec-review
   * 由独立 reviewer spawn 提交（mx-1），role 字段是其旁证之一。
   *
   * mx5-4 改名记档：本枚举的实现角色旧值已改为 developer——触发本文件头部
   * 「已有定义不得改名改义」纪律，属设计 mx-5 D4 用户拍板的例外授权（直接改，
   * 不做兼容别名）。历史账本兼容已核实：fold 对 exec-review verdict 不比对
   * role（携带改名前旧角色值的 exec-review pass 照常驱动 closed）、对
   * spec-review 只认 reviewer（旧角色值本就不算数），重放语义改名前后一致。
   */
  role?: "reviewer" | "designer" | "developer" | "human";
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
  /**
   * 本次 verify 中产物解析失败的验收 id（mx5-1）。`parseError===true` 的实际
   * 来源**非穷举**——完整集合以四适配器 parse/translate 实现（`src/testrun/`）
   * 与 `src/verify/run.ts` 的路由为准，代表形态：①适配器 parse 抛错——
   * vitest/playwright stdout 非法 JSON 或 **JSON 合法但形状不符**；e2e-sh 无
   * 标记行且 exit 0、或标记 id 与验收 id 不符；②零条目且 exit 0 防线——
   * playwright/pytest 零 result/条目行且 exit 0 判无区分力抛错；③translate
   * 抛错——如 `runner:"e2e-sh"` 显式声明的条目 command 缺省（unit 型合法缺省
   * 绕过规则③，适配器不代拟命令）；④路由不到适配器的旁路——非法 runner 绕过
   * gate 规则⑧时 runOne 的 fail 分支同样置 parseError。不含 e2e-sh「无标记行
   * 且 exit≠0」——该分支返回 no-markers fail case 不抛错，见投影语义的诚实
   * 边界。result 仍为 "pass"|"fail" 不变，此字段只用于投影分类——解析失败是
   * 确定性挂，不计入 flake 连挂。exemptNondeterministic 豁免条目不入列（豁免
   * 语义 = 不计入任何聚合判定）。无解析失败不写该键：旧账本缺字段 = 无解析
   * 失败，重放兼容。
   */
  parseFailedAcceptanceIds?: string[];
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

// ---- fold 顺序视图与 gate 注入（u1 追加） ----

/**
 * 事件信封的判别联合视图：与 EventEnvelope<EventType> 同构，但 type 与 payload 联动，
 * 消费者 switch (ev.type) 时 TypeScript 能正确窄化 payload（宽泛的泛型信封做不到）。
 * 仅类型层视图，账本 JSONL 序列化格式不变。
 */
export type DiscriminatedEvent = {
  [K in EventType]: EventEnvelope<K>;
}[EventType];

/** spec gate 注入签名（u3 的 checkSpecRules 是标准实现；deriveStatus 只依赖此签名） */
export type SpecGate = (spec: SpecSubmittedPayload) => SpecRulesResult;

/**
 * deriveStatus「之后存在」语义所需的顺序锚点。
 *
 * 为什么需要：UnitProjection 的 specs / verdicts 是平行数组，折叠时丢失了跨数组的
 * 账本顺序；「最后一条 spec 之后是否存在 spec-review pass verdict」（重新提交
 * spec = 打回重审，旧 verdict 不计数）无法从平行数组判定，由 fold 折叠时补记 seq。
 */
export interface SequencedUnitProjection extends UnitProjection {
  /** 最后一条 SpecSubmitted 的账本 seq；未提交过 spec 时为 null */
  lastSpecSeq: number | null;
  /** 各 VerdictSubmitted 的账本 seq，与 verdicts 一一对应（同为提交顺序） */
  verdictSeqs: number[];
}

/** fold 的返回类型：units 是带顺序锚点的 unit 投影（UnitProjection 的超集） */
export interface SequencedProjection extends Projection {
  units: Map<string, SequencedUnitProjection>;
}
