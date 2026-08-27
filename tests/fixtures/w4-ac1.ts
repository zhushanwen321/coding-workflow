/**
 * w4 AC-1 双域边界锁的纯判定函数（tests/w4-grep-ac.test.ts 使用）。
 *
 * 抽出为纯函数的动机：AC-1 的「适用域门控」若失灵（如路径前缀笔误导致恒跳过），
 * 边界锁将静默失效——这正是要防的「狼来了」反面。门控本身由
 * tests/w4-ac1-classify.test.ts 机器复核。
 */

/** 门控触发标记：分支触碰了这些路径 = 边界敏感波次（gate·pipeline 域开发）。 */
export const GATE_PIPELINE_TRIGGER_PREFIXES = ["src/gate/", "src/pipeline/"];

/** AC-1 保护对象：unit 域九路径。目录项以 `/` 结尾按前缀匹配，单文件精确匹配。 */
export const UNIT_LOCKED_PATHS = [
  "src/events/types.ts",
  "src/core/fold.ts",
  "src/readonly/",
  "src/runner/",
  "src/verify/",
  "src/testrun/",
  "src/gates/",
  "pi-coding-workflow-extension/",
];

export function isGatePipelinePath(rel: string): boolean {
  return GATE_PIPELINE_TRIGGER_PREFIXES.some((p) => rel.startsWith(p));
}

export function isUnitLockedPath(rel: string): boolean {
  return UNIT_LOCKED_PATHS.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
}

/** 给定分支相对分叉点的改动文件清单，判定 AC-1 是否适用 + 违规路径。 */
export function classifyBranch(changedFiles: readonly string[]): {
  applies: boolean;
  offenders: string[];
} {
  const applies = changedFiles.some(isGatePipelinePath);
  return { applies, offenders: applies ? changedFiles.filter(isUnitLockedPath) : [] };
}
