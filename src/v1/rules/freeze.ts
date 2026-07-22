/**
 * v1 wave append-only 校验（replan 时改 WavePlan 的保护，领域规则，零 IO）。
 *
 * 来源：v5 model §5.6（abort + appendOnly 机制）、§4.1（WorkUnitItem.status: active|abandoned）、
 *      wave §8.1（wave replan：废弃条目 status=abandoned，append-only 保历史）。
 *
 * 职责：对比 before/after 两个 ExecutionUnit 的 WavePlan 条目，对 status="abandoned" 的条目
 *      校验 append-only 不变性——废弃的条目不可删、核心字段不可改（active 条目可改）。
 *
 * append-only 语义（model §5.6 / §4.4）：
 * - replan 废弃的条目 → status="abandoned"（不物理删除，保留演进历史）
 * - abandoned 条目的核心字段冻结（不可改）——改了就破坏历史一致性
 * - active 条目可正常修改（plan progressive / 新增条目）
 *
 * 不变量：rules 层零 IO。纯函数对比 before/after。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import type {
  WaveTestCase,
  WaveTask,
  WaveFile,
  WaveContract,
} from "../core/plan.js";

// ═══════════════════════════════════════════════════════════════
// FreezeViolation
// ═══════════════════════════════════════════════════════════════

/**
 * append-only 不变量违反记录。
 *
 * - type="wave_deleted_abandoned"：before 有但 after 无（被物理删除）
 * - type="wave_modified_abandoned"：核心字段被改（abandoned 条目应冻结）
 */
export interface FreezeViolation {
  /** 违反类型。 */
  type: "wave_deleted_abandoned" | "wave_modified_abandoned";
  /** 涉及的条目 id。 */
  itemId: string;
  /** 被改的字段（modified 类型必填，deleted 类型无）。 */
  field?: string;
  /** 人类可读说明。 */
  reason: string;
}

// ═══════════════════════════════════════════════════════════════
// 各条目类型的「核心字段」定义（append-only 冻结的字段集）
// ═══════════════════════════════════════════════════════════════

/**
 * 判定 WaveTestCase 是否核心字段被改。
 * 核心字段（spec）：expected（TDD 断言）。
 * 其余字段（name/scenario/input/type）改了不计 violation（次要描述字段）。
 */
function testCaseCoreChanged(
  before: WaveTestCase,
  after: WaveTestCase,
): string | undefined {
  if (before.expected !== after.expected) return "expected";
  return undefined;
}

/**
 * 判定 WaveTask 是否核心字段被改。
 * 核心字段（spec）：steps（执行步骤清单）。
 */
function taskCoreChanged(
  before: WaveTask,
  after: WaveTask,
): string | undefined {
  if (!arrayEqual(before.steps, after.steps)) return "steps";
  return undefined;
}

/**
 * 判定 WaveFile 是否核心字段被改。
 * 核心字段（spec）：path（物理路径）。
 */
function fileCoreChanged(
  before: WaveFile,
  after: WaveFile,
): string | undefined {
  if (before.path !== after.path) return "path";
  return undefined;
}

/**
 * 判定 WaveContract 是否核心字段被改。
 * 核心字段（spec）：definition（契约签名 / schema）。
 */
function contractCoreChanged(
  before: WaveContract,
  after: WaveContract,
): string | undefined {
  if (before.definition !== after.definition) return "definition";
  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// 工具：数组浅比较
// ═══════════════════════════════════════════════════════════════

function arrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// ═══════════════════════════════════════════════════════════════
// checkFreeze（主入口）
// ═══════════════════════════════════════════════════════════════

/**
 * 对比 before/after 的 WavePlan，校验 abandoned 条目的 append-only 不变量。
 *
 * 校验逻辑（对 status="abandoned" 的条目）：
 * 1. **被删除**（before 有 after 无）→ violation type="wave_deleted_abandoned"
 * 2. **核心字段被改**（如 testCase.expected / task.steps / file.path / contract.definition）
 *    → violation type="wave_modified_abandoned"
 * 3. status="active" 的条目可改（无 violation，plan progressive / 新增都允许）
 *
 * @param before replan 前的 ExecutionUnit
 * @param after  replan 后的 ExecutionUnit
 * @returns 违反列表（空数组 = 无违反，append-only 不变量保持）
 */
export function checkFreeze(
  before: ExecutionUnit,
  after: ExecutionUnit,
): FreezeViolation[] {
  const violations: FreezeViolation[] = [];
  const beforePlan = before.plan;
  const afterPlan = after.plan;

  // 逐类校验 4 种 WavePlan 条目（直接传 before/after 数组，类型由 plan[kind] 推断）
  collectViolations(
    "testCases",
    beforePlan.testCases,
    afterPlan.testCases,
    testCaseCoreChanged,
    violations,
  );
  collectViolations(
    "tasks",
    beforePlan.tasks,
    afterPlan.tasks,
    taskCoreChanged,
    violations,
  );
  collectViolations(
    "files",
    beforePlan.files,
    afterPlan.files,
    fileCoreChanged,
    violations,
  );
  collectViolations(
    "contracts",
    beforePlan.contracts,
    afterPlan.contracts,
    contractCoreChanged,
    violations,
  );

  return violations;
}

/**
 * 对单类条目（testCases/tasks/files/contracts）收集 append-only 违反。
 *
 * 泛型参数 T 是具体条目类型（WaveTestCase/WaveTask/WaveFile/WaveContract）。
 * 直接接收 before/after 数组（由调用方通过 plan[kind] 传入），避免 plan 索引的联合类型转换。
 *
 * @param kind 条目类别名（用于 report 诊断）
 * @param beforeItems before 侧该类条目数组
 * @param afterItems after 侧该类条目数组
 * @param coreChangedFn 判定该类条目核心字段是否被改的函数
 */
function collectViolations<T extends { id: string; status: "active" | "abandoned" }>(
  kind: "testCases" | "tasks" | "files" | "contracts",
  beforeItems: T[],
  afterItems: T[],
  coreChangedFn: (before: T, after: T) => string | undefined,
  violations: FreezeViolation[],
): void {
  const afterById = new Map(afterItems.map((it) => [it.id, it] as const));

  for (const beforeItem of beforeItems) {
    // 只校验 abandoned 条目（active 条目可改）
    if (beforeItem.status !== "abandoned") continue;

    const afterItem = afterById.get(beforeItem.id);

    // 情况 1：被删除（before 有 after 无）
    if (!afterItem) {
      violations.push({
        type: "wave_deleted_abandoned",
        itemId: beforeItem.id,
        reason: `abandoned ${kind} 条目 "${beforeItem.id}" 被物理删除（违反 append-only：应保留 status=abandoned）`,
      });
      continue;
    }

    // 情况 1b：status 被翻转（abandoned → active，"复活"废弃条目）
    if (afterItem.status !== "abandoned") {
      violations.push({
        type: "wave_modified_abandoned",
        itemId: beforeItem.id,
        field: "status",
        reason: `abandoned ${kind} 条目 "${beforeItem.id}" 的 status 被改为 "${afterItem.status}"（违反 append-only：abandoned 条目不可复活）`,
      });
      continue;
    }

    // 情况 2：核心字段被改
    const changedField = coreChangedFn(beforeItem, afterItem);
    if (changedField) {
      violations.push({
        type: "wave_modified_abandoned",
        itemId: beforeItem.id,
        field: changedField,
        reason: `abandoned ${kind} 条目 "${beforeItem.id}" 的核心字段 "${changedField}" 被改（违反 append-only：abandoned 条目应冻结）`,
      });
    }
  }
}
