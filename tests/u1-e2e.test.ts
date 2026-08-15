/**
 * u1 E2E（真实子进程，零 mock）：两个真实 node 子进程并发对同一账本各 append 20 条。
 *
 * 探针目标（验收文档「E2E real 验收」）：
 *   - 40 条无交错损坏（每行 JSON 可解析）
 *   - seq 全局 1..40 连续不重复（文件锁串行化写）
 *   - 两 unit 事件各自完整（1 × UnitCreated + 19 × EvidenceSubmitted，runId 全套）
 *
 * 子进程脚本：tests/fixtures/append-worker.js（真实 EventLedger，来自 dist 构建产物）。
 * 起跑门：父进程 spawn 完两个子进程后创建 gate 文件，保证两 worker 真实并发。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { DiscriminatedEvent } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";

const WORKER_PATH = fileURLToPath(new URL("./fixtures/append-worker.js", import.meta.url));
const EVENTS_PER_UNIT = 20;
const UNITS = ["u-alpha", "u-beta"] as const;
const TOTAL_EVENTS = UNITS.length * EVENTS_PER_UNIT;

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u1-e2e-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface WorkerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** spawn 真实 node 子进程跑 worker；始终 resolve（退出码 + 输出供断言）。 */
function spawnWorker(
  ledgerFilePath: string,
  unitId: string,
  gateFilePath: string,
): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_PATH, ledgerFilePath, unitId, gateFilePath]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: `spawn error: ${err.message}` });
    });
  });
}

describe("E2E real：两子进程并发 append 同一账本", () => {
  it(
    "40 条无损坏、seq 1..40 连续、两 unit 事件完整（并发写串行化探针）",
    { timeout: 60_000 },
    async () => {
      const ledgerFilePath = join(tmpRoot, "shared", "events.log");
      const gateFilePath = join(tmpRoot, "start.gate");

      // 两个子进程先起跑等待 gate → 写 gate 同时放行，形成真实并发窗口
      const runs = Promise.allSettled(
        UNITS.map((unitId) => spawnWorker(ledgerFilePath, unitId, gateFilePath)),
      );
      writeFileSync(gateFilePath, "");

      const settled = await runs;
      expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const results = settled.map((r) =>
        r.status === "fulfilled"
          ? r.value
          : { code: -1, stdout: "", stderr: "unexpected rejection" },
      );
      for (const [i, result] of results.entries()) {
        expect(result.code, `worker ${UNITS[i]} 退出码（stderr: ${result.stderr}）`).toBe(0);
        expect(result.stderr, `worker ${UNITS[i]} stderr 应为空`).toBe("");
      }

      const ledger = new EventLedger(ledgerFilePath);
      const events = ledger.readAll();
      expect(events).toHaveLength(TOTAL_EVENTS);

      // 40 条无交错损坏：原始 JSONL 每行可解析、信封字段齐全、末行换行收尾
      const raw = readFileSync(ledgerFilePath, "utf-8");
      expect(raw.endsWith("\n")).toBe(true);
      const lines = raw.split("\n").slice(0, -1);
      expect(lines).toHaveLength(TOTAL_EVENTS);
      for (const [i, line] of lines.entries()) {
        const parsed = JSON.parse(line) as { seq: number; ts: string; type: string };
        expect(parsed.seq, `第 ${i + 1} 行 seq`).toBeGreaterThan(0);
        expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(parsed.type).toBeTruthy();
      }

      // seq 全局 1..40 连续不重复
      const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: TOTAL_EVENTS }, (_, i) => i + 1));

      // 探针有效性：两 unit 事件真实交错（非先后整块）——串行化在中途争用下依然成立
      const owners = events.map((e) => e.payload.unitId);
      const switches = owners.filter((u, i) => i > 0 && u !== owners[i - 1]).length;
      expect(switches, "两 unit 事件应至少交错一次（真实并发争用）").toBeGreaterThanOrEqual(1);

      // 两 unit 事件各自完整：1 × UnitCreated + 19 × EvidenceSubmitted（runId 全套）
      for (const unitId of UNITS) {
        const unitEvents = ledger.readUnit(unitId);
        expect(unitEvents, `unit ${unitId} 事件数`).toHaveLength(EVENTS_PER_UNIT);

        const kinds = unitEvents.map((e) => e.type);
        expect(kinds.filter((t) => t === "UnitCreated")).toHaveLength(1);

        const runIds = unitEvents
          .map((e) => e as DiscriminatedEvent)
          .filter((e) => e.type === "EvidenceSubmitted")
          .map((e) => e.payload.runId)
          .sort();
        const expected = Array.from(
          { length: EVENTS_PER_UNIT - 1 },
          (_, i) => `run-${unitId}-${i + 1}`,
        ).sort();
        expect(runIds, `unit ${unitId} 的 evidence runId 全套`).toEqual(expected);
      }
    },
  );
});
