/**
 * v1 Plan 类型（领域模型，运行时零依赖）。
 *
 * 来源：v5 model §4.1（WorkUnitItem）、§4.2（Plan/Split）、§4.3（各层 Plan）、
 * wave 附录 A §3-§4（WavePlan 及 4 个条目类型）、slice §2（SlicePlan 及 4 个条目类型）。
 *
 * 注：Decision（SlicePlan.decisions 的元素类型）从 clarifications.ts 引入，
 * 仅 type-only import（编译期擦除，不引入运行时依赖，不形成运行时循环）。
 */
import type { Clarification, Decision, FeatureSpec } from "./clarifications.js";

// 重新导出 Decision，让 plan 模块的消费者不必从 clarifications 取（slice plan 语义内聚）。
export type { Decision };
// ═══════════════════════════════════════════════════════════════
// WorkUnitItem（所有支持 replan 追踪的条目基类）
// ═══════════════════════════════════════════════════════════════

/**
 * model §4.1 — 所有 plan 内部条目的基类。
 *
 * 继承此接口的条目有唯一 id + 可废弃（status: active|abandoned）。
 * replan 时废弃条目标 status="abandoned"（不物理删除，append-only）。
 */
export interface WorkUnitItem {
  /** 条目唯一标识（在单个 WorkUnit 内唯一）。 */
  id: string;
  /** 条目状态：active=正常 / abandoned=已废弃（replan 时标记，不可删）。 */
  status: "active" | "abandoned";
}

// ═══════════════════════════════════════════════════════════════
// Plan 基类 + Split
// ═══════════════════════════════════════════════════════════════

/** model §4.2 — 所有层 plan 的基类。 */
export interface Plan {
  split: Split[];
}

/**
 * model §4.2 — 拆分项（无 lifecycle，不逐项废弃）。
 *
 * PlanningUnit 的 design 阶段，每个 Split 项声明「这个子层负责上游的哪些条目」。
 * execute 时 cw 根据 Split 创建子层，把 inheritedItemIds 写入子层的 basedOnParent。
 */
export interface Split {
  slug: string;
  description: string;
  dependsOn: string[];
  /** 这个子层继承上游的哪些条目 id（写入子层的 basedOnParent）。 */
  inheritedItemIds?: string[];
  /** 这样拆分（而非其他切法）的理由，供人审/复盘。 */
  justification?: string;
}

// ═══════════════════════════════════════════════════════════════
// WavePlan（ExecutionUnit 的 plan）
// ═══════════════════════════════════════════════════════════════

/**
 * model §4.3 / wave 附录 A §3 — wave 的 plan。
 *
 * 继承 Plan（split 字段冗余但保留，换取 WorkUnit.plan 结构兼容）。
 * wave 是叶子，cw 自动填 split=[]。
 */
export interface WavePlan extends Plan {
  testCases: WaveTestCase[];
  tasks: WaveTask[];
  files: WaveFile[];
  contracts: WaveContract[];
  /** 本 wave 测试执行命令（per-wave，取代全局 config.testRunner.command）。 */
  testCommand: string;
}

// ═══════════════════════════════════════════════════════════════
// WavePlan 的 4 个条目类型（都 extends WorkUnitItem）
// ═══════════════════════════════════════════════════════════════

/** wave 附录 A §4 — 测试用例（TDD 起点）。 */
export interface WaveTestCase extends WorkUnitItem {
  name: string;
  scenario: string;
  input: string;
  expected: string;
  type: "unit" | "integration" | "e2e" | "manual";
  /**
   * 验证方式（可选，从 AcceptanceCriterion.verification 投影）。
   * unit → 机器跑，manual/review → 退化验证。
   * 未设置时默认按 type 字段判断（manual type 走退化验证，其他走机器跑）。
   */
  verification?: "unit" | "manual" | "review";
}

/** wave 附录 A §4 — 执行任务清单。 */
export interface WaveTask extends WorkUnitItem {
  type: "impl" | "refactor" | "test" | "fix" | "doc" | "other";
  files: string[];
  steps: string[];
  dependsOn?: string[];
}

/** wave 附录 A §4 — 文件改动清单。 */
export interface WaveFile extends WorkUnitItem {
  path: string;
  action: "create" | "modify" | "delete";
  description: string;
}

/** wave 附录 A §4 — 接口契约。 */
export interface WaveContract extends WorkUnitItem {
  name: string;
  type: "function" | "api" | "class" | "event" | "schema" | "other";
  definition: string;
}

// ═══════════════════════════════════════════════════════════════
// SlicePlan（PlanningUnit/slice 的 plan）
// ═══════════════════════════════════════════════════════════════

/**
 * model §4.3 / slice §2 — slice 的 plan。
 *
 * 继承 Plan（split 拆 wave 清单），扩展 5 个技术方案字段。
 * slice 是纯技术层：把 feature 的需求 spec 翻译成 wave 能照着施工的技术方案。
 */
export interface SlicePlan extends Plan {
  /** 技术选型（核心库 / 工具库 / 状态管理 / 错误处理框架等）。 */
  techChoices: SliceTechChoice[];
  /** 接口契约（跨 wave 协调的关键）。 */
  interfaces: SliceInterface[];
  /** 数据模型（TS 类型 / SQL DDL / JSON schema / protobuf）。 */
  dataModels: SliceDataModel[];
  /** 错误规格（统一错误处理策略）。 */
  errorSpecs: SliceErrorSpec[];
  /** 技术决策（投影自本层 Clarification，跟随 Clarification replan）。 */
  decisions: Decision[];
}

/**
 * slice §2.1 — 技术选型（最核心的技术决策记录）。
 *
 * alternatives 至少 1 个候选；rationale 必须对比 alternatives 说明。
 */
export interface SliceTechChoice extends WorkUnitItem {
  /** 技术领域分类，如 "认证库" / "HTTP 客户端" / "状态管理"。 */
  area: string;
  /** 选定方案，含版本/配置（如 "oauth2-client v3.2"）。 */
  choice: string;
  /** 考虑过但没选的候选（至少 1 个）。 */
  alternatives: string[];
  /** 为什么选这个——必须对比 alternatives 说明。 */
  rationale: string;
}

/**
 * slice §2.2 — 接口契约（slice 对外 / 对其他 slice 的承诺）。
 *
 * signature 必须是 wave 能直接照抄实现的形式（TS 函数签名 / HTTP 路由签名）。
 * 不设 consumers 字段——跨 wave 引用走 basedOnParent 反查。
 */
export interface SliceInterface extends WorkUnitItem {
  /** 接口标识，如 "exchangeToken" / "POST /api/oauth/token"。 */
  name: string;
  /** 函数签名（TS）或 HTTP 路由签名（method + path + 参数）。 */
  signature: string;
  /** md 自由描述：输入约束 / 返回结构 / 错误码 / 副作用。 */
  contract: string;
}

/**
 * slice §2.3 — 数据模型（核心类型定义）。
 *
 * format 必须显式声明；definition 必须是 wave 能直接照抄实现的形式。
 */
export interface SliceDataModel extends WorkUnitItem {
  /** 类型名/表名，如 "TokenPair" / "users 表"。 */
  name: string;
  /** 定义格式。 */
  format: "typescript" | "sql" | "json-schema" | "protobuf" | "freeform";
  /** 具体定义（按 format 解读）。 */
  definition: string;
  /** 约束/索引/不变量说明（如 "accessToken 全局唯一"）。 */
  notes?: string;
}

/**
 * slice §2.4 — 错误规格（错误处理策略）。
 *
 * slice 是统一定错误处理策略的层。interfaceId 对接口级错误必填。
 */
export interface SliceErrorSpec extends WorkUnitItem {
  /** 关联的 SliceInterface id（接口级错误必填；全局策略可不填）。 */
  interfaceId?: string;
  /** 错误触发场景，如 "OAuth 提供商返回 invalid_grant"。 */
  scenario: string;
  /** 处理策略（重试/返回/日志）。 */
  strategy: string;
  /** 对外 HTTP 状态码（HTTP 接口必填）。 */
  httpStatus?: number;
  /** 业务错误码（如 "AUTH_INVALID_GRANT"）。 */
  errorCode?: string;
}

// ═══════════════════════════════════════════════════════════════
// Handler Input 类型（从 handlers/types.ts 搬入，供 schema-injector 解析）
// ═══════════════════════════════════════════════════════════════

/**
 * 声明脱离 parent 条目的 input 基类（append-only）。
 *
 * 被 Design*Input / ReplanInput 继承。abandonParentItems 声明脱离 parent 的某些条目——
 * append-only，一旦声明不可撤回。用于「我实际不用 parent 的这个条目」的场景。
 */
export interface AbandonParentItemsInput {
  /** 声明脱离的 parent 条目 id 列表。append-only——一旦声明不可撤回。 */
  abandonParentItems?: string[];
}

// ⚠️ 双份定义：与 src/handlers/types.ts 同名 interface 必须保持字段同步
/**
 * design handler 输入（写 WavePlan 4 类条目）。
 *
 * 由 schema-injector 从 core 源码自动提取 schema 文本，注入 design 阶段 guidance。
 * 原定义在 handlers/types.ts，搬入 core/plan.ts 让 ACTION_SCHEMA.design 能指向它。
 */
export interface DesignInput extends AbandonParentItemsInput {
  testCases: WaveTestCase[];
  tasks: WaveTask[];
  files: WaveFile[];
  contracts: WaveContract[];
  /** 本 wave 测试执行命令。 */
  testCommand: string;
  /** 补充澄清（progressive append，design 阶段可继续追加）。 */
  clarifications?: Clarification[];
}

// ⚠️ 双份定义：与 src/handlers/types.ts 同名 interface 必须保持字段同步
/**
 * slice design handler 输入（写 SlicePlan 5 字段 + split）。
 *
 * 与 wave 的 DesignInput 完全不同：wave 写 testCases/tasks/files/contracts，
 * slice 写技术方案（techChoices/interfaces/dataModels/errorSpecs）+ split（拆 wave 清单）。
 *
 * decisions 可选——不传时由 handler 从本层 Clarification 投影（model §5.10）。
 * 原定义在 handlers/types.ts，搬入 core/plan.ts 让 ACTION_SCHEMA.design 能指向它。
 */
export interface DesignSliceInput extends AbandonParentItemsInput {
  techChoices: SliceTechChoice[];
  interfaces: SliceInterface[];
  dataModels: SliceDataModel[];
  errorSpecs: SliceErrorSpec[];
  split: Split[];
  /** 技术决策（投影自本层 Clarification）。可选——不传由 handler 投影。 */
  decisions?: Decision[];
  /** 补充澄清（progressive append）。 */
  clarifications?: Clarification[];
}

// ⚠️ 双份定义：与 src/handlers/types.ts 同名 interface 必须保持字段同步
/**
 * feature design handler 输入（Plan 基类，只 split）。
 *
 * 与 slice 的 DesignSliceInput 完全不同：feature 不产技术方案，design 只拆 slice 清单。
 * spec 可选——传入时覆盖本层 spec（合并 clarify 语义，E1-20）。
 * 原定义在 handlers/types.ts，搬入 core/plan.ts 保持类型归位一致性。
 */
export interface DesignFeatureInput extends AbandonParentItemsInput {
  split: Split[];
  /** 补充澄清（progressive append）。 */
  clarifications?: Clarification[];
  /** 覆盖 spec（可选——feature design 阶段可更新需求规格）。 */
  spec?: FeatureSpec;
}

// ⚠️ 双份定义：与 src/handlers/types.ts 同名 interface 必须保持字段同步
/**
 * epic design handler 输入——与 DesignFeatureInput 同型（Plan 基类，只 split）。
 *
 * epic 与 feature 的 design 都是 Plan 基类（只拆下层清单，不产技术方案），结构完全一致。
 * 字段与 DesignFeatureInput 保持同步（types.ts 的 DesignEpicInput = DesignFeatureInput）。
 */
export interface DesignEpicInput extends AbandonParentItemsInput {
  split: Split[];
  /** 补充澄清（progressive append）。 */
  clarifications?: Clarification[];
  /** 覆盖 spec（epic 不消费 spec，字段保留仅为与 DesignFeatureInput 同步）。 */
  spec?: FeatureSpec;
}
