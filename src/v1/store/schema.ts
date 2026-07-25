/**
 * v1 持久化层 — 存储格式定义与路径编码。
 *
 * 职责：
 *   - 定义 _v1.json 的顶层 schema（扁平集合 + parentUnitId 外键）
 *   - cwd → 目录名的编码（per-cwd 隔离）
 *   - v1 存储根目录解析（V1_HOME 环境变量覆盖）
 *
 * 来源：v5 store 层独立实现。POSIX 文件系统最佳实践参考 0.x 的 src/path-encoding.ts，
 * 但本文件零 0.x 依赖（不 import 任何 src/ 下 0.x 文件），仅按 v1 契约独立实现。
 *
 * 设计要点（vs 0.x）：
 *   - 0.x 一个 CwJsonFile 含 topics/waves/testCases/gateHistory/... 多集合；v1 只用
 *     单个 workUnits 集合（ExecutionUnit / PlanningUnit 直接扁平存，子 unit 通过
 *     parentUnitId 外键关联，不嵌套）。
 *   - encodeCwd 规则：把路径里的 `/` 替换为 `__`（独立于 0.x 的 `--...--` 规则）。
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// ═══════════════════════════════════════════════════════════════
// 存储格式
// ═══════════════════════════════════════════════════════════════

/** v1 持久化文件的顶层 schema（扁平集合 + parentUnitId 外键）。 */
export interface V1JsonFile {
  workUnits: WorkUnitRecord[];
}

/**
 * WorkUnit 的持久化记录。
 *
 * 扁平存储，子 WorkUnit 通过 parentUnitId 外键关联（不嵌套）。
 * 直接序列化 ExecutionUnit（或 PlanningUnit）的全部字段——由于这些类型字段都是
 * JSON 可序列化的（无函数、无 class 实例），直接存即可。
 * 除必填具名键外，其余字段以 unknown 透传（避免 store 层耦合 core 的字段细节）。
 */
export interface WorkUnitRecord {
  // 其余字段（statusHistory / plan / evidence / judgments ...）原样透传，
  // 由 core 层定义；store 层不解释、不裁剪。
  [key: string]: unknown;
  /** WorkUnit 唯一标识（如 "wave:auth-w1"）。主键。 */
  id: string;
  /** 层类型（"epic" | "feature" | "slice" | "wave"，以字符串存）。 */
  scope: string;
  /** 父层 WorkUnit 的 id（epic 无）。外键 → WorkUnitRecord.id。 */
  parentUnitId?: string;
}

// ═══════════════════════════════════════════════════════════════
// 路径编码
// ═══════════════════════════════════════════════════════════════

/**
 * 把 cwd 编码为目录名：把路径里的 `/` 替换为 `__`。
 *
 * 例：`/Users/x/proj` → `__Users__x__proj`。
 * 全局替换保留前导分隔符的痕迹（前导 `__` 即原前导 `/`），确定性、可逆。
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "__");
}

// ═══════════════════════════════════════════════════════════════
// 存储根目录
// ═══════════════════════════════════════════════════════════════

/**
 * v1 存储根目录。
 *
 * 默认 `~/.v1`，可通过 `V1_HOME` 环境变量覆盖。
 * 覆盖值必须是绝对路径（契约要求），否则抛错——per-cwd 隔离依赖稳定、唯一的根。
 */
export function getV1Home(): string {
  const override = process.env.V1_HOME;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(
        `V1_HOME must be an absolute path, got: ${override}`,
      );
    }
    return override;
  }
  return join(homedir(), ".v1");
}

/**
 * 给定 cwd，返回对应的 _v1.json 路径。
 *
 * `<v1Home>/<encodedCwd>/_v1.json`，per-cwd 隔离。
 */
export function getV1JsonPath(cwd: string): string {
  return join(getV1Home(), encodeCwd(cwd), "_v1.json");
}
