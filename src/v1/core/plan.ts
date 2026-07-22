/**
 * v1 Plan 类型（领域模型，零依赖）。
 *
 * 来源：v5 model §4.1（WorkUnitItem）、§4.2（Plan/Split）、§4.3（各层 Plan）、
 * wave 附录 A §3-§4（WavePlan 及 4 个条目类型）。
 */
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
