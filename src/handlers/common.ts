/**
 * 写命令共享辅助（u2 三个 handler 的公共底座）。
 *
 * 职责边界：只做参数提取、账本定位与投影查询，不含命令语义——
 * 命令语义（slug 规则、深度上限、gate 链）留在各自 handler，验收文档逐条可对。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import type { CommandContext } from "../dispatch.js";
import type {
  DiscriminatedEvent,
  EventEnvelope,
  EventPayloadMap,
  EventType,
} from "../events/types.js";
import { EventLedger } from "../store/events-log.js";
import { attachmentsDir, getCwHome, ledgerPath } from "../store/project.js";

/** 按当前进程环境的 CW_HOME 语义定位 cwd 对应账本（project.ts 单一出处） */
export function ledgerForCwd(cwd: string): EventLedger {
  return new EventLedger(ledgerPath(getCwHome(), cwd));
}

/**
 * 相对路径相对执行者所在目录（process.cwd()）解析（wt-2 R-5 双锚分离：
 * CW_PROJECT_DIR / ctx.cwd 只锚账本定位与 git 仓库操作；文件路径参数
 * （--file / --brief）跟随执行者所在目录——agent 在 worktree 里执行
 * `cw evidence submit --file spec.json` 时读 worktree 的 spec.json，账本
 * 仍写项目 cwd。未设 CW_PROJECT_DIR 时两锚同值，既有行为不变）。
 */
export function resolveAgainstCwd(p: string): string {
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

/**
 * 提取字符串参数。key 用 minimist 解析后的原样键名（kebab-case 不转驼峰：
 * --run-id → "run-id"，实测 minimist 1.2.x 不做 camelCase 转换）。
 * 空串是「给了值但值为空」（如 --id ""），原样返回交给各命令的具体规则报错——
 * 它与「未给参数」（undefined / minimist 的 boolean true）语义不同，
 * 提前吞掉会把「slug 为空」错报成「缺少参数」。
 */
export function stringArg(
  argv: CommandContext["argv"],
  key: string,
): string | undefined {
  const value = argv[key];
  return typeof value === "string" ? value : undefined;
}

/** 提取可重复字符串参数（--file a --file b → [a, b]；单次给值 → [值]）；非字符串项丢弃 */
export function stringArrayArg(
  argv: CommandContext["argv"],
  key: string,
): string[] {
  const value = argv[key];
  if (typeof value === "string") {
    return value === "" ? [] : [value];
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v !== "");
  }
  return [];
}

/** 校验失败出口：stderr 一条可操作信息（缺什么 + 恢复动作），exit code 1 */
export function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

/** 成功出口：stdout 一行确认，exit code 0 */
export function succeed(message: string): number {
  process.stdout.write(`${message}\n`);
  return 0;
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 原文副本入 evidence（fx-4 设计 D4，三类提交一致布局）：
 * evidence/<unitId>/attachments/<sha256(内容)>.<原文件名>。
 * 内容 hash 命名天然幂等——同内容重复提交覆盖同路径，零增长；账本零变更
 * （paths/specHash/briefRef 字段不动），副本是纯增量审计资产：原文可从
 * attachments 重读，不依赖 commit 树可达或 worktree 存活（spec 本体 / untracked
 * 产物 / designer 的 brief 文件都会随 reset/clean/reclaim 丢失）。
 * 入账成功后调用；copy 失败不阻断命令成功（账本是权威），stderr 出声留恢复路径。
 */
export function copyAttachmentToEvidence(
  cwd: string,
  unitId: string,
  absPath: string,
  raw: Buffer,
): void {
  const dir = attachmentsDir(getCwHome(), cwd, unitId);
  const dest = join(dir, `${sha256Hex(raw)}.${basename(absPath)}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, raw);
  } catch (e) {
    process.stderr.write(
      `原文副本写入失败（目标 ${dest}，事件已入账不受影响）：` +
        `${e instanceof Error ? e.message : String(e)}。` +
        `恢复动作：确认目录可写后手工复制原文到该路径（文件名 = sha256(原文字节) + 原文件名）。\n`,
    );
  }
}

/** 读取文件原始字节；不可读时返回 errno code 供错误信息定位（ENOENT/EACCES/EISDIR…） */
export function readOrErrno(p: string): { ok: true; raw: Buffer } | { ok: false; errno: string } {
  try {
    return { ok: true, raw: readFileSync(p) };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { ok: false, errno: err.code ?? err.message };
  }
}

export interface UnitCreatedFact {
  unitId: string;
  parentId: string | null;
}

/** 账本内全部 UnitCreated 事实（unit 存在性与深度判定的输入） */
export function unitCreatedFacts(ledger: EventLedger): Map<string, UnitCreatedFact> {
  const facts = new Map<string, UnitCreatedFact>();
  for (const ev of ledger.readAll() as DiscriminatedEvent[]) {
    if (ev.type === "UnitCreated") {
      facts.set(ev.payload.unitId, { unitId: ev.payload.unitId, parentId: ev.payload.parentId });
    }
  }
  return facts;
}

/** 某 unit 已入账的全部 evidence runId（review 的 evidence-refs 存在性判定输入） */
export function evidenceRunIds(ledger: EventLedger, unitId: string): Set<string> {
  const runIds = new Set<string>();
  for (const ev of ledger.readAll() as DiscriminatedEvent[]) {
    if (ev.type === "EvidenceSubmitted" && ev.payload.unitId === unitId) {
      runIds.add(ev.payload.runId);
    }
  }
  return runIds;
}

export type AppendOutcome<K extends EventType> =
  | { ok: true; envelope: EventEnvelope<K> }
  | { ok: false; message: string };

/**
 * 追加入账；账本层拒绝（孤儿事件 / 幂等键重复等 u1 不变式）时错误信息原样透传给
 * 调用方打印——u1 的错误文案自带恢复动作，handler 不改写不包装。
 */
export function tryAppend<K extends EventType>(
  ledger: EventLedger,
  type: K,
  payload: EventPayloadMap[K],
): AppendOutcome<K> {
  try {
    return { ok: true, envelope: ledger.append(type, payload) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
