/**
 * skill registry —— name → SkillEntry 的映射表 + 查询入口。
 *
 * 参照 src/shapes/registry.ts 的模式：单一 REGISTRY 数据源，
 * SKILL_NAMES / listSkills / getSkill 全部从它派生，避免第二份列表导致新增 skill 时漏改。
 *
 * 新增 skill：
 *   1. types.ts 的 SkillName 加字面量
 *   2. 新建 src/skills/<name>.ts 导出 <NAME>_SKILL: SkillEntry
 *   3. 这里 REGISTRY 加映射
 *
 * 调用方：src/cli.ts 的 `cw skill` 命令分支（只读、不进状态机、不需 topic）。
 */

import { DIAGNOSING_BUGS_SKILL } from "./diagnosing-bugs.js";
import { IMPROVE_CODEBASE_ARCHITECTURE_SKILL } from "./improve-codebase-architecture.js";
import { WAYFINDER_SKILL } from "./wayfinder.js";
import type { SkillEntry, SkillListEntry, SkillName } from "./types.js";

/**
 * skill 注册表。单一数据源——SKILL_NAMES / listSkills / getSkill 全部从它派生。
 * Partial：防御 SkillName 联合加了字面量但 REGISTRY 漏映射（getSkill 返回 null，CLI 层映射 exit 1）。
 */
const REGISTRY: Partial<Record<SkillName, SkillEntry>> = {
  "diagnosing-bugs": DIAGNOSING_BUGS_SKILL,
  "improve-codebase-architecture": IMPROVE_CODEBASE_ARCHITECTURE_SKILL,
  wayfinder: WAYFINDER_SKILL,
};

/** 按 name 查 skill，未找到返回 null（由 CLI 层映射 exit code）。 */
export function getSkill(name: string): SkillEntry | null {
  return REGISTRY[name as SkillName] ?? null;
}

/** 所有已注册 skill 的 name 列表（单一数据源，派生自 REGISTRY）。 */
export const SKILL_NAMES: SkillName[] = Object.keys(REGISTRY) as SkillName[];

/** `cw skill list` 的输出（不含 body）。 */
export function listSkills(): SkillListEntry[] {
  return SKILL_NAMES.map((name) => {
    const entry = REGISTRY[name]!;
    return { name: entry.name, summary: entry.summary, trigger: entry.trigger };
  });
}
