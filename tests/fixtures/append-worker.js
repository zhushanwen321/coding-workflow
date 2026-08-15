/**
 * E2E 并发探针 worker（真实 node 子进程，非 mock）。
 *
 * 由 tests/u1-e2e.test.ts spawn，argv：
 *   <ledgerPath> <unitId> <gateFilePath>
 *
 * 行为：等待起跑门文件（父进程 spawn 完两个子进程后创建，保证真实并发窗口），
 * 然后对同一账本 append 20 条事件（1 × UnitCreated + 19 × EvidenceSubmitted），
 * 全部通过 dist 里的真实 EventLedger（文件锁短事务串行化）。
 */
import { existsSync } from "node:fs";

import { EventLedger } from "../../dist/store/events-log.js";

const EVENTS_PER_UNIT = 20;
// append 间隔：单 worker 总时长（19 × 10ms 起步）必然超过对手的锁重试间隔 100ms，
// 保证另一 worker 能中途杀入临界区（探针测的是真实交错，不是先后整块）
const APPEND_PAUSE_MS = 10;

const [, , ledgerPath, unitId, gateFilePath] = process.argv;
if (ledgerPath === undefined || unitId === undefined || gateFilePath === undefined) {
  console.error("usage: node append-worker.js <ledgerPath> <unitId> <gateFilePath>");
  process.exit(2);
}

// 起跑门：10ms 步进等待，两个 worker 同时放行
while (!existsSync(gateFilePath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

const ledger = new EventLedger(ledgerPath);
ledger.append("UnitCreated", {
  unitId,
  parentId: null,
  briefRef: `brief-${unitId}.md`,
});
for (let i = 1; i < EVENTS_PER_UNIT; i++) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, APPEND_PAUSE_MS);
  ledger.append("EvidenceSubmitted", {
    unitId,
    runId: `run-${unitId}-${i}`,
    commit: "0000000000000000000000000000000000000000",
    paths: ["report.json"],
    sha256: ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"],
    exitCode: 0,
  });
}

const unitEvents = ledger.readUnit(unitId);
if (unitEvents.length !== EVENTS_PER_UNIT) {
  console.error(
    `worker ${unitId}: expected ${EVENTS_PER_UNIT} events, got ${unitEvents.length}`,
  );
  process.exit(1);
}
process.stdout.write(JSON.stringify({ unitId, appended: unitEvents.length }));
