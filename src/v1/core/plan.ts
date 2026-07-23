/**
 * v1 Plan 类型（领域模型，运行时零依赖）。
 *
 * 来源：v5 model §4.1（WorkUnitItem）、§4.2（Plan/Split）、§4.3（各层 Plan）、
 * wave 附录 A §3-§4（WavePlan 及 4 个条目类型）、slice §2（SlicePlan 及 4 个条目类型）。
 *
 * 注：Decision（SlicePlan.decisions 的元素类型）从 clarifications.ts 引入，
 * 仅 type-only import（编译期擦除，不引入运行时依赖，不形成运行时循环）。
 */
import type { Decision } from "./clarifications.js";

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
 * PlanningUnit 的 plan 阶段，每个 Split 项声明「这个子层负责上游的哪些条目」。
 * execute 时 cw 根据 Split 创建子层，把 inheritedItemIds 写入子层的 basedOnParent。
 */
export interface Split {
  slug: string;
  description: string;
  dependsOn: string[];
  /** 这个子层继承上游的哪些条目 id（写入子层的 basedOnParent）。 */
  inheritedItemIds?: string[];
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

