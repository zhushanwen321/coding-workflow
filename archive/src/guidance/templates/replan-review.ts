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
  /**
   * 状态机是否有回流通道（design/design-review 是否可达，如 executing 内容 replan 时均 illegal）。
   * false 时省略「重新 design 并重新 design-review（完整重走）」引导句——该句在无回流状态与
   * blockedHint 同屏矛盾，agent 读到仍可能发起非法 cw design（illegal_transition 死锁）。
   */
  planReachable?: boolean;
}): string {
  const { abandonedIds, replanCount, planReachable = true } = args;
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
  sections.push("→ 考虑废弃更多条目，甚至重新 design 补充澄清约束");
  sections.push("");
  sections.push("审视维度（新方案必须回答）：");
  sections.push("- 架构合理性：归位到正确的层了吗？");
  sections.push("- 鲁棒性：边界条件成立吗？");
  sections.push("- 兼容性：破坏已有 interface 契约了吗？");
  sections.push("");
  // 有回流通道（design/design-review 可达）才引导重新 design + design-review；
  // 无回流状态省略该句（见 args.planReachable 注释）。
  if (planReachable) {
    sections.push("审视完后，重新 design 并重新 design-review（design → design-review → execute 完整重走）。");
    sections.push("");
  }
  sections.push(
    "replan input 还支持可选字段 abandonParentItems: string[]（声明脱离 parent 条目，" +
      "CLI: --abandonParentItems '[\"TC1\"]'）——" +
      "如果你废弃条目的同时也要声明脱离 parent 的某些条目，可一并带上。",
  );

  // 渐进式递进提示（阈值：第 2 次起加系统性问题警告，第 3 次起强烈建议 abort）
  const REPLAN_WARN_THRESHOLD = 2;
  const REPLAN_ABORT_THRESHOLD = 3;
  if (replanCount >= REPLAN_WARN_THRESHOLD) {
    sections.push("");
    sections.push("⚠️ 你已经 replan 过一次了。如果又要 replan，说明方案层面有系统性问题。");
    sections.push("考虑重新 design 补充澄清需求/技术约束，或 abort 整个 unit 重新设计。");
  }
  if (replanCount >= REPLAN_ABORT_THRESHOLD) {
    sections.push("");
    sections.push("🚨 已 replan 3 次。强烈建议 abort 整个 unit——反复 replan 说明方案根基有问题。");
  }

  return sections.join("\n");
}
