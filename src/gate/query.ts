/**
 * queryGate —— gate 域只读查询（design-release-pipeline.md §3.3 D8 / §3.1 终态样例，rp-0）。
 *
 * fold 投影上的只读消费：不执行 git、不读产物文件、零副作用。输出各缓存键的
 * 最新 pass 条目 + report 指针 + sha256；过滤后空集 = miss 形态（CLI 层输出
 * 「miss: 无 (check, baseSha, scope) 的 pass 条目」，核心库以空数组承载）。
 *
 * base 的 ref → sha 解析属 CLI 层职责（query 的 base 输入是 ref 形态，本模块
 * 收已解析的 baseSha——比对键是 sha，ref 字符串只作审计展示，D3 入账规范）。
 */
import { EventLedger } from "../store/events-log.js";
import { gateLedgerPath } from "../store/project.js";
import { gateLedgerDomain } from "./domain.js";
import { foldGate } from "./fold.js";
import type { GateEventMap } from "./types.js";

export interface QueryGateOptions {
  cwHome: string;
  cwd: string;
  /** 过滤：只查该 check（缺省 = 全部 check） */
  check?: string;
  /** 过滤：只查该 baseSha（缺省 = 全部 base；注意是 sha 不是 ref） */
  baseSha?: string;
}

/**
 * 一条可复用的 pass 事实（消费方视角：report 指针 + 完整性锚 + 审计字段）。
 * reportRef 相对项目 CW 目录，绝对路径 = join(cwHome, encodeCwd(cwd), reportRef)。
 */
export interface GatePassEntry {
  check: string;
  baseSha: string;
  scope: string[];
  headSha: string;
  runId: string;
  result: "pass";
  durationMs: number;
  reportRef: string;
  reportSha256: string;
  /** 入账 seq（审计链：GateCacheHit.sourceRunId 反查的锚） */
  seq: number;
}

/** queryGate 的输出：pass 条目集（空 = miss 形态）+ per check 最新事件（审计展示） */
export interface QueryGateResult {
  /** 过滤后的各 (check, baseSha, scope) 键最新 pass 条目（按 seq 升序稳定输出） */
  passEntries: GatePassEntry[];
  /** 各 check 的最新事件（不过滤 check/baseSha——审计全景，CLI 的 status 形态消费） */
  latestByCheck: ReadonlyArray<{ seq: number; ts: string; type: string; check: string }>;
}

/** 只读查询（见模块头；投影消费纯读，无任何写入路径） */
export function queryGate(opts: QueryGateOptions): QueryGateResult {
  const ledger = new EventLedger<GateEventMap>(gateLedgerPath(opts.cwHome, opts.cwd), gateLedgerDomain);
  const projection = foldGate(ledger.readAll());

  const passEntries: GatePassEntry[] = [];
  for (const candidate of projection.latestPassByKey.values()) {
    const payload = candidate.payload;
    if (opts.check !== undefined && payload.check !== opts.check) continue;
    if (opts.baseSha !== undefined && payload.baseSha !== opts.baseSha) continue;
    passEntries.push({
      check: payload.check,
      baseSha: payload.baseSha,
      scope: payload.scope,
      headSha: payload.headSha,
      runId: payload.runId,
      result: "pass",
      durationMs: payload.durationMs,
      reportRef: payload.reportRef,
      reportSha256: payload.reportSha256,
      seq: candidate.seq,
    });
  }
  passEntries.sort((a, b) => a.seq - b.seq); // 稳定输出（Map 迭代序 = 入账序，按 seq 再排一次自证）

  const latestByCheck = [...projection.latestByCheck.values()]
    .map((event) => ({ seq: event.seq, ts: event.ts, type: event.type, check: event.payload.check }))
    .sort((a, b) => a.seq - b.seq);

  return { passEntries, latestByCheck };
}
