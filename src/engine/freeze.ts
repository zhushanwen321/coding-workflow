/**
 * FreezeRule + checkFreeze —— cw 1.0 的不可篡改抽象层。
 *
 * 替代 cw 0.x 的 validateAppendOnly（actions.ts:2533-2656）硬编码 5 种违规类型：
 *   - wave_deleted_committed
 *   - wave_modified_committed
 *   - case_deleted_passed
 *   - case_modified_passed
 *   - case_expected_tampered_failed
 *
 * 1.0 把这些硬编码违规抽象为 FreezeRule 声明表，每条规则描述：
 *   - 哪个 collection 受保护
 *   - collection 里哪些元素受保护（predicate）
 *   - 受保护后哪些字段不可改
 *   - 违规类型标识
 *
 * checkFreeze 函数遍历所有 FreezeRule，比对 old/new unit，返回所有违规。
 * 这是 cw 0.x VerificationStrategy.replanGuard 的通用化。
 */
import type { Unit } from "./unit.js";
import type { FreezeRule } from "./scope-config.js";

/**
 * freeze 违规 —— 与 cw 0.x Violation（shapes/types.ts:93）和 AppendOnlyViolation 对齐。
 *
 * 字段语义：
 *   - type：违规类型（wave_modified_committed / case_deleted_passed 等）
 *   - collection：哪个 collection 出问题（"waves" / "testCases"）
 *   - itemId：受保护元素的 id（waveId / caseId）
 *   - field：被改的字段（"committed" / "changes" / "expected"）
 *   - reason：给 agent 看的人类可读说明
 */
export interface FreezeViolation {
  /** 违规类型标识（与 FreezeRule.violationType 对齐）。 */
  type: string;
  /** 出问题的 collection。 */
  collection: string;
  /** 受保护元素的 id。 */
  itemId?: string;
  /** 被改的字段名。 */
  field?: string;
  /** 人类可读说明。 */
  reason: string;
}

/**
 * 检查 unit 是否违反 freeze 规则。
 *
 * 算法：
 *   1. 遍历每条 FreezeRule
 *   2. 在 oldUnit.collections[rule.collection] 里找出受保护的元素（predicate 返回 true）
 *   3. 对每个受保护元素，在 newUnit 里找对应元素（按 id 匹配）
 *   4. 如果找不到 → 违规 "deleted"（元素被删）
 *   5. 如果找到了，但 immutableFields 中任一字段变化 → 违规 "modified"（字段被改）
 *
 * @param oldUnit 流转前的 unit
 * @param newUnit 流转后的 unit（含新数据）
 * @param rules ScopeConfig.freezeRules
 * @returns 违规列表（空数组 = 无违规）
 */
export function checkFreeze<P>(
  oldUnit: Unit<string, P>,
  newUnit: Unit<string, P>,
  rules: ReadonlyArray<FreezeRule<P>>,
): FreezeViolation[] {
  const violations: FreezeViolation[] = [];

  for (const rule of rules) {
    const oldCollection = (oldUnit.collections[rule.collection] ?? []) as Array<{
      id?: string;
      [k: string]: unknown;
    }>;
    const newCollection = (newUnit.collections[rule.collection] ?? []) as Array<{
      id?: string;
      [k: string]: unknown;
    }>;

    // 找出受保护的元素
    const protectedItems = oldCollection.filter((item) => {
      try {
        return rule.predicate(item, oldUnit);
      } catch {
        return false;
      }
    });

    for (const oldItem of protectedItems) {
      const itemId = oldItem.id as string | undefined;
      // 按 id 匹配新元素
      const newItem = itemId
        ? newCollection.find((n) => n.id === itemId)
        : undefined;

      if (!newItem) {
        // 元素被删
        violations.push({
          type: rule.violationType.replace(/_modified_/, "_deleted_"),
          collection: rule.collection,
          itemId,
          reason: `受保护元素 ${itemId ?? "(no id)"} 被删除（违反 ${rule.id}）`,
        });
        continue;
      }

      // 检查 immutableFields 是否被改
      for (const field of rule.immutableFields) {
        const oldValue = JSON.stringify(oldItem[field]);
        const newValue = JSON.stringify(newItem[field]);
        if (oldValue !== newValue) {
          violations.push({
            type: rule.violationType,
            collection: rule.collection,
            itemId,
            field,
            reason: `受保护元素 ${itemId ?? "(no id)"} 的字段 ${field} 被修改（违反 ${rule.id}）`,
          });
        }
      }
    }
  }

  return violations;
}
