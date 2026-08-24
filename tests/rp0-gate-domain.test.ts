/**
 * rp-0 gate 域基础件验收（design-release-pipeline.md §3.3 D1/D2/D5）：
 * 域描述符 / fold 投影 / artifacts 落盘 / project 布局函数 / runId 生成器。
 *
 * 零 mock：真实 tmp 目录 + 真实 EventLedger（文件锁 + fsync）+ 真实 fs。
 * wrapCheck/queryGate 的全链行为（A1a/A2/A3/GP5/GP6）在 rp0-gate-core.test.ts。
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  deriveHitReport,
  relativeReportRef,
  sha256OfContent,
  writeGateReport,
} from "../src/gate/artifacts.js";
import { DuplicateGateCheckError, gateLedgerDomain } from "../src/gate/domain.js";
import { foldGate, gateCacheKey } from "../src/gate/fold.js";
import { newGateRunId } from "../src/gate/wrap.js";
import type {
  GateCacheHitPayload,
  GateCheckRanPayload,
  GateEvent,
  GateEventMap,
} from "../src/gate/types.js";
import { EventLedger } from "../src/store/events-log.js";
import {
  encodeCwd,
  gateArtifactsDir,
  gateLedgerPath,
} from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rp0-gate-domain-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function newGateLedger(name: string): EventLedger<GateEventMap> {
  return new EventLedger(join(tmpRoot, name, "gate-events.log"), gateLedgerDomain);
}

function checkRanPayload(overrides: Partial<GateCheckRanPayload> = {}): GateCheckRanPayload {
  return {
    check: "typecheck",
    baseSha: "b".repeat(40),
    baseRef: "origin/main",
    scope: ["src"],
    headSha: "a".repeat(40),
    command: ["node", "-v"],
    runId: "run-1",
    result: "pass",
    exitCode: 0,
    durationMs: 100,
    reportRef: "gate-artifacts/typecheck/run-1/report.json",
    reportSha256: "c".repeat(64),
    ...overrides,
  };
}

function cacheHitPayload(overrides: Partial<GateCacheHitPayload> = {}): GateCacheHitPayload {
  return {
    check: "typecheck",
    baseSha: "b".repeat(40),
    baseRef: "origin/main",
    scope: ["src"],
    headSha: "a".repeat(40),
    sourceRunId: "run-1",
    reportRef: "gate-artifacts/typecheck/run-2/report.json",
    reportSha256: "d".repeat(64),
    ...overrides,
  };
}

// ── 域描述符（D2/D5）───────────────────────────────────────

describe("rp-0 gate 域描述符（gateLedgerDomain）", () => {
  it("两类事件可写可读：seq 从 1 单调、ts ISO、payload 原样往返", () => {
    const ledger = newGateLedger("write-read");
    const ran = ledger.append("GateCheckRan", checkRanPayload());
    const hit = ledger.append("GateCacheHit", cacheHitPayload());

    expect(ran.seq).toBe(1);
    expect(hit.seq).toBe(2);
    expect(Number.isNaN(Date.parse(ran.ts))).toBe(false);

    const events = ledger.readAll();
    expect(events.map((e) => e.type)).toEqual(["GateCheckRan", "GateCacheHit"]);
    expect(events[0]?.payload).toEqual(checkRanPayload());
    expect(events[1]?.payload).toEqual(cacheHitPayload());
  });

  it("GateCheckRan 的 check+runId 幂等：重复抛 DuplicateGateCheckError（instanceof 可区分），拒绝不写字节", () => {
    const ledger = newGateLedger("idempotency");
    ledger.append("GateCheckRan", checkRanPayload({ runId: "r-1" }));

    try {
      ledger.append("GateCheckRan", checkRanPayload({ runId: "r-1", durationMs: 999 }));
      expect.unreachable("同 check+runId 重复入账必须被拒绝");
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateGateCheckError);
      const dup = e as DuplicateGateCheckError;
      expect(dup.check).toBe("typecheck");
      expect(dup.runId).toBe("r-1");
      expect(dup.message).toContain("恢复动作");
    }
    expect(ledger.readAll()).toHaveLength(1); // 拒绝不写字节

    // 同 check 换 runId = 新事实，照常入账
    const next = ledger.append("GateCheckRan", checkRanPayload({ runId: "r-2" }));
    expect(next.seq).toBe(2); // 拒绝后 seq 不跳号
  });

  it("GateCacheHit 无孤儿概念：可独立存在（首条事件无需先导）；同内容重复命中照记", () => {
    const ledger = newGateLedger("no-orphan");
    expect(() => ledger.append("GateCacheHit", cacheHitPayload())).not.toThrow();
    // GateCacheHit 无幂等键：同 sourceRunId 的两次命中都入账（各自是一次独立验证请求）
    ledger.append("GateCacheHit", cacheHitPayload());
    expect(ledger.readAll()).toHaveLength(2);
  });

  it("readUnit 按域锚（check）过滤", () => {
    const ledger = newGateLedger("read-unit");
    ledger.append("GateCheckRan", checkRanPayload({ check: "typecheck", runId: "r-1" }));
    ledger.append("GateCheckRan", checkRanPayload({ check: "lint", runId: "r-2" }));
    ledger.append("GateCacheHit", cacheHitPayload({ check: "typecheck", sourceRunId: "r-1" }));

    const events = ledger.readUnit("typecheck");
    expect(events).toHaveLength(2);
    expect(ledger.readUnit("no-such")).toEqual([]);
  });

  it("信封校验：未知 type / 锚非字符串均按域描述符文案报错（F-1 形态）", () => {
    const path = join(tmpRoot, "corrupt", "gate-events.log");
    const ledger = new EventLedger(path, gateLedgerDomain);
    ledger.append("GateCheckRan", checkRanPayload());

    appendFileSync(
      path,
      `${JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:00.000Z", type: "UnitCreated", payload: { unitId: "u-1" } })}\n`,
    );
    expect(() => ledger.readAll()).toThrow(/第 2 行不是合法事件信封/);
    expect(() => ledger.readAll()).toThrow(/两类事件枚举（GateCheckRan\/GateCacheHit）/);

    const anchorPath = join(tmpRoot, "corrupt-anchor", "gate-events.log");
    const anchorLedger = new EventLedger(anchorPath, gateLedgerDomain);
    anchorLedger.append("GateCheckRan", checkRanPayload());
    appendFileSync(
      anchorPath,
      `${JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:00.000Z", type: "GateCacheHit", payload: { sourceRunId: "r-1" } })}\n`,
    );
    expect(() => anchorLedger.readAll()).toThrow(/payload\.check=undefined 非字符串/);
    expect(() => anchorLedger.readAll()).toThrow(/恢复动作/);
  });
});

// ── fold 投影（D5）─────────────────────────────────────────

describe("rp-0 gate 域 fold（foldGate）", () => {
  it("latestPassByKey：同键取最新 seq 的 pass；fail 不进；不同 (baseSha, scope) = 不同键", () => {
    const base1 = "1".repeat(40);
    const base2 = "2".repeat(40);
    const events: GateEvent[] = [
      { seq: 1, ts: "t1", type: "GateCheckRan", payload: checkRanPayload({ baseSha: base1, runId: "r-1", durationMs: 10 }) },
      // 同键 fail：入账审计但不进 pass 投影
      { seq: 2, ts: "t2", type: "GateCheckRan", payload: checkRanPayload({ baseSha: base1, runId: "r-2", result: "fail", exitCode: 1 }) },
      // 同键新 pass：覆盖 seq1（最新 pass）
      { seq: 3, ts: "t3", type: "GateCheckRan", payload: checkRanPayload({ baseSha: base1, runId: "r-3", headSha: "f".repeat(40), durationMs: 30 }) },
      // 不同 baseSha：不同键
      { seq: 4, ts: "t4", type: "GateCheckRan", payload: checkRanPayload({ baseSha: base2, runId: "r-4" }) },
      // 不同 scope：不同键
      { seq: 5, ts: "t5", type: "GateCheckRan", payload: checkRanPayload({ baseSha: base1, scope: ["docs"], runId: "r-5" }) },
    ];
    const projection = foldGate(events);

    expect(projection.latestPassByKey.get(gateCacheKey("typecheck", base1, ["src"]))?.payload.runId).toBe("r-3");
    expect(projection.latestPassByKey.get(gateCacheKey("typecheck", base2, ["src"]))?.payload.runId).toBe("r-4");
    expect(projection.latestPassByKey.get(gateCacheKey("typecheck", base1, ["docs"]))?.payload.runId).toBe("r-5");
    expect(projection.latestPassByKey).toHaveLength(3);
    // fail 只入账不进候选：同键无第五条目
  });

  it("GateCacheHit 不进 pass 投影与 duration 聚合（复用无新执行事实）", () => {
    const events: GateEvent[] = [
      { seq: 1, ts: "t1", type: "GateCheckRan", payload: checkRanPayload({ durationMs: 100 }) },
      { seq: 2, ts: "t2", type: "GateCacheHit", payload: cacheHitPayload() },
    ];
    const projection = foldGate(events);
    expect(projection.latestPassByKey).toHaveLength(1); // hit 未新增键
    expect(projection.durationStats.get("typecheck")).toEqual({ totalMs: 100, runs: 1 });
  });

  it("latestByCheck 与 durationStats：per check 聚合正确；多次 pass 累加", () => {
    const events: GateEvent[] = [
      { seq: 1, ts: "t1", type: "GateCheckRan", payload: checkRanPayload({ check: "typecheck", runId: "r-1", durationMs: 100 }) },
      { seq: 2, ts: "t2", type: "GateCacheHit", payload: cacheHitPayload({ check: "typecheck" }) },
      { seq: 3, ts: "t3", type: "GateCheckRan", payload: checkRanPayload({ check: "typecheck", runId: "r-2", durationMs: 50 }) },
      { seq: 4, ts: "t4", type: "GateCheckRan", payload: checkRanPayload({ check: "lint", runId: "r-3", durationMs: 7 }) },
    ];
    const projection = foldGate(events);
    expect(projection.latestByCheck.get("typecheck")?.type).toBe("GateCheckRan"); // seq3 最新
    expect(projection.latestByCheck.get("typecheck")?.seq).toBe(3);
    expect(projection.latestByCheck.get("lint")?.seq).toBe(4);
    expect(projection.durationStats.get("typecheck")).toEqual({ totalMs: 150, runs: 2 });
    expect(projection.durationStats.get("lint")).toEqual({ totalMs: 7, runs: 1 });
    expect(projection.totalEvents).toBe(4);
  });

  it("纯函数 replay 幂等：同一数组折叠两次 deep-equal；空账本 = 空投影", () => {
    const events: GateEvent[] = [
      { seq: 1, ts: "t1", type: "GateCheckRan", payload: checkRanPayload() },
      { seq: 2, ts: "t2", type: "GateCacheHit", payload: cacheHitPayload() },
    ];
    expect(foldGate(events)).toEqual(foldGate(events));
    const empty = foldGate([]);
    expect(empty.latestPassByKey.size).toBe(0);
    expect(empty.totalEvents).toBe(0);
  });

  it("未知事件 type 抛错（外部改账本的防线，不静默跳过）", () => {
    expect(() =>
      foldGate([
        { seq: 1, ts: "t1", type: "PipelineStepRan", payload: { pipeline: "p" } } as never,
      ]),
    ).toThrow(/foldGate: 未知事件类型/);
  });

  it("gateCacheKey：三元组隔离 + scope 声明原序参与（顺序漂移 = 不同键）", () => {
    const k1 = gateCacheKey("t", "b", ["a", "b"]);
    expect(k1).not.toBe(gateCacheKey("t2", "b", ["a", "b"]));
    expect(k1).not.toBe(gateCacheKey("t", "b2", ["a", "b"]));
    expect(k1).not.toBe(gateCacheKey("t", "b", ["b", "a"]));
    // 空数组 = 仓根口径，与任何显式 scope 不同键
    expect(gateCacheKey("t", "b", [])).not.toBe(gateCacheKey("t", "b", [""]));
  });
});

// ── artifacts（D4 记账闭合的产物侧）─────────────────────────

describe("rp-0 gate 产物（writeGateReport / deriveHitReport）", () => {
  it("落盘 report.json：内容可回读、sha256 与独立重算一致、目录递归创建", () => {
    const dir = join(tmpRoot, "artifacts-write", "typecheck", "run-1");
    const report = {
      check: "typecheck",
      runId: "run-1",
      baseSha: "b".repeat(40),
      baseRef: "origin/main",
      scope: ["src"],
      headSha: "a".repeat(40),
      command: ["node", "-v"],
      result: "pass" as const,
      exitCode: 0,
      durationMs: 1234,
    };
    const { reportPath, reportSha256 } = writeGateReport(dir, report);
    expect(reportPath).toBe(join(dir, "report.json"));

    const raw = readFileSync(reportPath, "utf-8");
    expect(reportSha256).toBe(sha256OfContent(raw));
    expect(JSON.parse(raw)).toEqual(report);
  });

  it("relativeReportRef：相对项目 CW 目录的稳定形态", () => {
    expect(relativeReportRef("typecheck", "01JXXX")).toBe(
      "gate-artifacts/typecheck/01JXXX/report.json",
    );
  });

  it("deriveHitReport（GP5 同构契约）：全字段原样 + source 追加为末键", () => {
    const source = {
      check: "typecheck",
      runId: "run-1",
      baseSha: "b".repeat(40),
      baseRef: "origin/main",
      scope: ["src"],
      headSha: "a".repeat(40),
      command: ["node", "-v"],
      result: "pass" as const,
      exitCode: 0,
      durationMs: 41200,
    };
    const hit = deriveHitReport(source, "run-1");
    expect(hit).toEqual({ ...source, source: "run-1" });
    // key 追加序：source 是最后一个键（JSON.stringify 后在字段末尾，逐字节可预测）
    expect(Object.keys(hit)[Object.keys(hit).length - 1]).toBe("source");
  });

  it("产物写失败抛原始错误（不吞——wrap 层包装为环境错误不入账）", () => {
    // 用一个已存在的文件路径充当目录：mkdirSync 递归创建其子路径时 ENOTDIR
    const blocker = join(tmpRoot, "artifacts-blocker-file");
    writeFileSync(blocker, "not a dir\n");
    const report = {
      check: "t",
      runId: "r",
      baseSha: "",
      baseRef: "",
      scope: [],
      headSha: "",
      command: [],
      result: "pass" as const,
      exitCode: 0,
      durationMs: 0,
    };
    expect(() => writeGateReport(join(blocker, "nested"), report)).toThrow();
  });
});

// ── runId 生成器 ────────────────────────────────────────────

describe("rp-0 gate runId 生成器（newGateRunId，ulid 风格）", () => {
  it("26 字符 Crockford Base32，时间戳前缀可反解，多次调用互异", () => {
    const now = Date.UTC(2026, 8, 24, 12, 0, 0);
    const id = newGateRunId(now);
    expect(id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    // 时间戳前缀（前 10 字符）由 48-bit ms Base32 编码，同 ms 生成的 id 前缀一致
    expect(newGateRunId(now).slice(0, 10)).toBe(id.slice(0, 10));
    // 随机后缀（后 16 字符）每次不同
    expect(newGateRunId(now).slice(10)).not.toBe(id.slice(10));
    // 时间前进，字典序前进（产物目录名列时时间有序的实益来源）
    expect(newGateRunId(now + 1) > id).toBe(true);
  });

  it("字符集排除 I/L/O/U（Crockford 防混淆字母表）", () => {
    for (let i = 0; i < 50; i++) {
      const id = newGateRunId();
      expect(id).not.toMatch(/[ILOU]/);
    }
  });
});

// ── project 布局（D1）───────────────────────────────────────

describe("rp-0 gate 布局函数（gateLedgerPath / gateArtifactsDir）", () => {
  it("gate 账本与 unit 账本同目录不同文件（硬隔离双域）", () => {
    const cwHome = "/tmp/cw-home";
    const cwd = "/Users/x/proj";
    expect(gateLedgerPath(cwHome, cwd)).toBe(
      join(cwHome, encodeCwd(cwd), "gate-events.log"),
    );
    expect(gateLedgerPath(cwHome, cwd)).not.toBe(
      join(cwHome, encodeCwd(cwd), "events.log"),
    );
  });

  it("产物目录布局 gate-artifacts/<check>/<runId>/（一次 wrap 一个目录）", () => {
    expect(gateArtifactsDir("/tmp/cw-home", "/Users/x/proj", "typecheck", "01JX")).toBe(
      join("/tmp/cw-home", encodeCwd("/Users/x/proj"), "gate-artifacts", "typecheck", "01JX"),
    );
  });
});
