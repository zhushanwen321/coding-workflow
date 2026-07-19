/**
 * skill 内化文本的类型定义。
 * skill 是按需触发的非固定节点方法论（对比固定节点内化在 src/prompts/）。
 * agent 通过 `cw skill list` / `cw skill <name>` 获取。
 *
 * 设计意图（参照 src/shapes/types.ts 的纯类型层模式）：
 *   - 纯类型，无逻辑、无实现类 import——避免循环依赖
 *   - registry.ts import 这些类型 + 各 skill 实现，types.ts 只 type-only export
 *   - 新增 skill：types.ts 的 SkillName 加字面量，registry.ts 同步加映射
 *
 * 与固定节点 prompt 的区别：
 *   - 固定节点（tdd/clarify/execute...）内化在 src/prompts/，必跑、被 buildNextAction 注入 guidance
 *   - skill 是非固定节点方法论，按需触发——agent 判断该用时调 `cw skill <name>` 拉取
 */

/** skill 名（字面量联合，每加一个 skill 加一项）。 */
export type SkillName =
  | "diagnosing-bugs"
  | "improve-codebase-architecture"
  | "wayfinder";

/** 单个 skill 的完整条目。 */
export interface SkillEntry {
  readonly name: SkillName;
  /** 一句话 summary，给 `cw skill list` 用。 */
  readonly summary: string;
  /** 触发条件描述，给 `cw skill list` 判断何时该用。 */
  readonly trigger: string;
  /** 完整方法论文本，给 `cw skill <name>` 用。 */
  readonly body: string;
}

/** `cw skill list` 返回的单项（不含 body，省 context）。 */
export type SkillListEntry = Pick<SkillEntry, "name" | "summary" | "trigger">;

/** `cw skill <name>` 的输出。 */
export interface SkillReadOutput {
  readonly name: SkillName;
  readonly body: string;
}

/** `cw skill list` 的输出。 */
export interface SkillListOutput {
  readonly skills: SkillListEntry[];
}
