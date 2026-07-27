/**
 * replan 审视引导模板。
 *
 * replan 触发时注入 guidance，引导 agent 在动手重建之前先审视：
 * - 这是单点问题还是方向性问题？
 * - 其他条目是否也建立在错误假设上？
 * - 新方案的架构合理性、鲁棒性、兼容性。
 *
 * 渐进式：第 1 次给完整审视引导，第 2 次加系统性问题警告，第 3 次建议 abort。
 */

/** 构造 replan 审视引导文本（纯函数，零 IO）。 */
export function buildReplanReviewText(args: {
  abandonedIds: string[];
  replanCount: number;
}): string {
  const { abandonedIds, replanCount } = args;
  const idList = abandonedIds.map((id) => `"${id}"`).join("、");

  const sections: string[] = [];

  sections.push(`你刚发起了 replan，废弃了 ${idList}。`);
  sections.push("");
  sections.push("## 重新审视（在动手重建之前）");
  sections.push("");
  sections.push("先判断这是单点问题还是方向性问题：");
  sections.push("");
  sections.push("【单点问题】只有被废弃的条目不可行");
  sections.push("→ 补新条目替代，重走 design-review");
  sections.push("");
  sections.push("【方向性问题】底层假设错了");
  sections.push("→ 检查其他条目是否也依赖这个错误假设");
  sections.push("→ 考虑废弃更多条目，甚至回到 clarify 重新澄清约束");
  sections.push("");
  sections.push("审视维度（新方案必须回答）：");
  sections.push("- 架构合理性：归位到正确的层了吗？");
  sections.push("- 鲁棒性：边界条件成立吗？");
  sections.push("- 兼容性：破坏已有 interface 契约了吗？");
  sections.push("");
  sections.push("审视完后，重新 plan 并重新 design-review（plan → design-review → execute 完整重走）。");

  // 渐进式递进提示（阈值：第 2 次起加系统性问题警告，第 3 次起强烈建议 abort）
  const REPLAN_WARN_THRESHOLD = 2;
  const REPLAN_ABORT_THRESHOLD = 3;
  if (replanCount >= REPLAN_WARN_THRESHOLD) {
    sections.push("");
    sections.push("⚠️ 你已经 replan 过一次了。如果又要 replan，说明方案层面有系统性问题。");
    sections.push("考虑回到 clarify 重新澄清需求/技术约束，或 abort 整个 unit 重新设计。");
  }
  if (replanCount >= REPLAN_ABORT_THRESHOLD) {
    sections.push("");
    sections.push("🚨 已 replan 3 次。强烈建议 abort 整个 unit——反复 replan 说明方案根基有问题。");
  }

  return sections.join("\n");
}
