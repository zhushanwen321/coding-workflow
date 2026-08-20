/**
 * 只读命令共享装载层：账本定位 → 读取 → fold 投影 → 状态派生。
 *
 * specGate 在此真实接线 u3 的 checkSpecRules（验收文档 u1b 指定的两 unit 首个
 * 接线点）：status / frontier / tree / report 四命令的状态列全部经同一注入点派生，
 * 与 fold/deriveStatus「gate 为注入依赖」的契约一致。
 *
 * 状态口径：unitStatus = 单 unit 语义（叶子/无子同构，供 runner 派发等单 unit
 * 场景）；treeStatuses = 树感知语义（canon D2 closed 公式含「子节点全 closed」，
 * 唯一权威——四命令的展示状态一律走它，投影即真相）。
 *
 * 只读保证：不 append 任何事件；账本文件不存在时不构造 EventLedger（其构造函数
 * 会 mkdirSync 父目录），用 existsSync 前置探测——空账本项目目录不会被只读命令创建。
 */
import { existsSync } from "node:fs";

import { deriveStatus, deriveStatuses, fold } from "../core/fold.js";
import type {
  SequencedProjection,
  SequencedUnitProjection,
  UnitStatus,
} from "../events/types.js";
import { checkSpecRules } from "../gates/spec-rules.js";
import { EventLedger } from "../store/events-log.js";
import { getCwHome, ledgerPath } from "../store/project.js";

export interface LoadedLedger {
  projection: SequencedProjection;
  /** 无任何 unit（账本文件不存在或账本为空） */
  empty: boolean;
}

/** 定位并读取 cwd 对应账本，折叠为投影。账本文件不存在 → 空事件折叠（正常态）。 */
export function loadLedger(cwd: string): LoadedLedger {
  const path = ledgerPath(getCwHome(), cwd);
  const events = existsSync(path) ? new EventLedger(path).readAll() : [];
  const projection = fold(events);
  return { projection, empty: projection.units.size === 0 };
}

/** 单 unit 状态派生（specGate = 真实 checkSpecRules；叶子/无子与树感知同构）。 */
export function unitStatus(unit: SequencedUnitProjection): UnitStatus {
  return deriveStatus(unit, checkSpecRules);
}

/**
 * 全投影树感知状态集合（唯一权威）：closed 含「全部直接子节点 closed」条件，
 * 四命令的每 unit 状态展示与 runner 的 root 退出判定一律经此（fold.ts
 * deriveStatuses 的接线点，canon D2 投影属性）。
 */
export function treeStatuses(projection: SequencedProjection): Map<string, UnitStatus> {
  return deriveStatuses(projection.units, checkSpecRules);
}

/** --unit 参数解析结果：未提供 / 合法（非空字符串）/ 非法（缺值或非字符串）。 */
export type UnitArg = { kind: "none" } | { kind: "ok"; unitId: string } | { kind: "invalid" };

export function parseUnitArg(value: unknown): UnitArg {
  if (value === undefined) return { kind: "none" };
  if (typeof value === "string" && value !== "") return { kind: "ok", unitId: value };
  return { kind: "invalid" };
}

/** 空账本的人可读提示（--json 模式输出空结构而非此文案） */
export const EMPTY_LEDGER_HINT = "(空账本)\n";

/** --unit 参数非法时的可操作错误（含命令名与恢复动作） */
export function unitArgUsageError(command: string): string {
  return (
    `${command}: --unit 需要一个 unitId 参数（如 cw ${command} --unit u1）。` +
    "恢复动作：补上 unitId，或去掉 --unit 查看全部 unit。\n"
  );
}

/** unit 不存在时的可操作错误（含恢复动作，指向可用的查证命令） */
export function unitNotFoundError(command: string, unitId: string): string {
  return (
    `${command}: unit "${unitId}" 不存在（当前账本无此 UnitCreated）。` +
    `恢复动作：运行 cw status 查看全部 unit，或 cw tree 检查分解树确认 id。\n`
  );
}
