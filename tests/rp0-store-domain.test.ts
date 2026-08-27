/**
 * rp-0 store 域描述符泛化验收（design-release-pipeline.md §3.3 D2）。
 *
 * 证明三件事（零 mock：真实 tmp 目录账本 + 真实文件锁 + 真实 fs）：
 *   1. EventLedger 注入自定义（非 unit）域描述符后可写 / 读非 unit 事件——
 *      自定义封闭集（TestCheckRan）、锚 = payload.check（gate 域形态的先行）；
 *      信封骨架（seq 单调 / ts ISO / 损坏行报错）在非 unit 域照常工作
 *   2. unit 域缺省行为不变：不传 domain 的构造 = 泛化前行为（六类封闭集 +
 *      孤儿拒绝 + UnitCreated 唯一 + EvidenceSubmitted 幂等 + unitId 锚文案）
 *   3. 域级 validateAppend 生效：测试域的 check+runId 幂等键拒绝重复入账，
 *      且「无孤儿概念」成立（首条事件无需任何创建先导——与 unit 域结构性差异）
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { EventPayloadMap, SpecSubmittedPayload } from "../src/events/types.js";
import { DuplicateEvidenceError, EventLedger } from "../src/store/events-log.js";
import type { DomainEvent, LedgerDomain } from "../src/store/ledger-domain.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rp0-domain-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── 测试域（gate 域形态的先行：锚 = check、幂等键 = check+runId、无孤儿） ──

interface TestCheckRanPayload {
  check: string;
  runId: string;
  result: "pass" | "fail";
}

type TestEventMap = { TestCheckRan: TestCheckRanPayload };

const testDomain: LedgerDomain<TestEventMap> = {
  knownEventTypes: new Set(["TestCheckRan"]),
  typeSetLabel: "测试域事件枚举（TestCheckRan）",
  anchorOf: (payload) => ({ name: "check", value: payload.check }),
  anchorLabel: "测试域 payload 的共有锚字段",
  validateAppend(type, payload, prior) {
    if (type !== "TestCheckRan") return;
    const duplicated = prior.some(
      (e) => e.payload.check === payload.check && e.payload.runId === payload.runId,
    );
    if (duplicated) {
      throw new Error(
        `测试域: 拒绝重复 TestCheckRan：check "${payload.check}" + runId "${payload.runId}" 已入账（幂等键防重复记账）。恢复动作：重跑请使用新 runId。`,
      );
    }
  },
};

function newTestLedger(name: string): EventLedger<TestEventMap> {
  return new EventLedger(join(tmpRoot, name, "gate-events.log"), testDomain);
}

// ── unit 域缺省行为夹具（与泛化前构造完全一致：不传 domain） ──

function newUnitLedger(name: string): EventLedger<EventPayloadMap> {
  return new EventLedger(join(tmpRoot, name, "events.log"));
}

function unitCreatedPayload(unitId: string) {
  return { unitId, parentId: null, briefRef: "docs/brief.md" };
}

function specPayload(unitId: string): SpecSubmittedPayload {
  return {
    unitId,
    specHash: "h1",
    acceptance: [
      { id: "A1", core: true, title: "验收 A1", type: "e2e-real", command: "npm test" },
    ],
    contracts: [],
    split: [],
  };
}

function evidencePayload(unitId: string, runId: string) {
  return {
    unitId,
    runId,
    commit: "c0ffee",
    paths: ["run/report.json"],
    sha256: ["deadbeef"],
    exitCode: 0,
  };
}

// ── 1. 非 unit 域可写 / 读 ────────────────────────────────────

describe("rp-0 D2：自定义域（锚 = check）注入 EventLedger", () => {
  it("非 unit 事件可写可读：seq 从 1 单调递增、ts 为 ISO、payload 原样往返", () => {
    const ledger = newTestLedger("custom-write-read");
    const first = ledger.append("TestCheckRan", {
      check: "typecheck",
      runId: "r-1",
      result: "pass",
    });
    const second = ledger.append("TestCheckRan", {
      check: "lint",
      runId: "r-2",
      result: "fail",
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(Number.isNaN(Date.parse(first.ts))).toBe(false); // ISO 8601
    expect(() => Number.isNaN(Date.parse(second.ts))).not.toThrow();

    const events = ledger.readAll();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["TestCheckRan", "TestCheckRan"]);
    expect(events[0]?.payload).toEqual({ check: "typecheck", runId: "r-1", result: "pass" });
    expect(events[1]?.payload).toEqual({ check: "lint", runId: "r-2", result: "fail" });
  });

  it("域级幂等键生效：同 check+runId 重复入账被拒，不同 runId 照常入账", () => {
    const ledger = newTestLedger("custom-idempotency");
    ledger.append("TestCheckRan", { check: "typecheck", runId: "r-1", result: "pass" });

    expect(() =>
      ledger.append("TestCheckRan", { check: "typecheck", runId: "r-1", result: "pass" }),
    ).toThrow(/拒绝重复 TestCheckRan.*typecheck.*r-1/s);
    // 拒绝不写字节：账本仍只有 1 条
    expect(ledger.readAll()).toHaveLength(1);

    // 同 check 换 runId = 新事实，照常入账
    ledger.append("TestCheckRan", { check: "typecheck", runId: "r-2", result: "fail" });
    expect(ledger.readAll()).toHaveLength(2);
  });

  it("无孤儿概念：首条事件无需任何创建先导（与 unit 域的结构性差异）", () => {
    const ledger = newTestLedger("custom-no-orphan");
    expect(() =>
      ledger.append("TestCheckRan", { check: "typecheck", runId: "r-1", result: "pass" }),
    ).not.toThrow();
  });

  it("readUnit 泛化：按域锚过滤（测试域锚 = check）", () => {
    const ledger = newTestLedger("custom-read-unit");
    ledger.append("TestCheckRan", { check: "typecheck", runId: "r-1", result: "pass" });
    ledger.append("TestCheckRan", { check: "lint", runId: "r-2", result: "pass" });
    ledger.append("TestCheckRan", { check: "typecheck", runId: "r-3", result: "fail" });

    const typecheckEvents = ledger.readUnit("typecheck");
    expect(typecheckEvents).toHaveLength(2);
    expect(typecheckEvents.map((e) => (e.payload as TestCheckRanPayload).runId)).toEqual([
      "r-1",
      "r-3",
    ]);
    expect(ledger.readUnit("no-such-check")).toEqual([]);
  });

  it("信封骨架照常工作：坏 JSON 行 / 未知 type / 锚非字符串均按域描述符报错", () => {
    const path = join(tmpRoot, "custom-corrupt", "gate-events.log");
    const ledger = new EventLedger(path, testDomain);
    ledger.append("TestCheckRan", { check: "typecheck", runId: "r-1", result: "pass" });

    // 未知 type：封闭集来自域描述符，文案含测试域枚举描述
    appendFileSync(
      path,
      `${JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:00.000Z", type: "HackedEvent", payload: { check: "typecheck" } })}\n`,
    );
    expect(() => ledger.readAll()).toThrow(/第 2 行不是合法事件信封/);
    expect(() => ledger.readAll()).toThrow(/HackedEvent/);
    expect(() => ledger.readAll()).toThrow(/测试域事件枚举（TestCheckRan）/);

    // 锚非字符串：文案锚名来自域描述符（payload.check=…）
    const anchorPath = join(tmpRoot, "custom-corrupt-anchor", "gate-events.log");
    const anchorLedger = new EventLedger(anchorPath, testDomain);
    anchorLedger.append("TestCheckRan", { check: "typecheck", runId: "r-1", result: "pass" });
    appendFileSync(
      anchorPath,
      `${JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:00.000Z", type: "TestCheckRan", payload: { runId: "r-2" } })}\n`,
    );
    expect(() => anchorLedger.readAll()).toThrow(/payload\.check=undefined 非字符串/);
    expect(() => anchorLedger.readAll()).toThrow(/恢复动作/);
  });

  it("域校验拒绝时账本不变 + seq 不跳号（拒绝不写字节）", () => {
    const ledger = newTestLedger("custom-reject-no-write");
    ledger.append("TestCheckRan", { check: "typecheck", runId: "r-1", result: "pass" });
    expect(() =>
      ledger.append("TestCheckRan", { check: "typecheck", runId: "r-1", result: "pass" }),
    ).toThrow();
    // 拒绝后下一条合法事件 seq 仍连续（无空洞）
    const next = ledger.append("TestCheckRan", { check: "typecheck", runId: "r-9", result: "pass" });
    expect(next.seq).toBe(2);
  });
});

// ── 2. unit 域缺省行为不变 ────────────────────────────────────

describe("rp-0 D2：unit 域缺省（不传 domain）行为不变", () => {
  it("六类事件照常写入，孤儿拒绝照常生效", () => {
    const ledger = newUnitLedger("default-orphan");
    ledger.append("UnitCreated", unitCreatedPayload("u-1"));

    // 孤儿：无 UnitCreated 的 unit 提交事件被拒（文案含恢复动作）
    expect(() => ledger.append("SpecSubmitted", specPayload("u-ghost"))).toThrow(/u-ghost/);
    expect(() => ledger.append("SpecSubmitted", specPayload("u-ghost"))).toThrow(/UnitCreated/);

    ledger.append("SpecSubmitted", specPayload("u-1"));
    const events = ledger.readAll() as DomainEvent<EventPayloadMap>[];
    expect(events.map((e) => e.type)).toEqual(["UnitCreated", "SpecSubmitted"]);
  });

  it("UnitCreated 唯一性照常生效", () => {
    const ledger = newUnitLedger("default-unique-create");
    ledger.append("UnitCreated", unitCreatedPayload("u-1"));
    expect(() => ledger.append("UnitCreated", unitCreatedPayload("u-1"))).toThrow(/已创建/);
  });

  it("EvidenceSubmitted 幂等照常抛 DuplicateEvidenceError（可区分拒绝导出不变）", () => {
    const ledger = newUnitLedger("default-duplicate");
    ledger.append("UnitCreated", unitCreatedPayload("u-1"));
    ledger.append("EvidenceSubmitted", evidencePayload("u-1", "run-1"));

    try {
      ledger.append("EvidenceSubmitted", evidencePayload("u-1", "run-1"));
      expect.unreachable("同 unitId+runId 重复提交必须被拒绝");
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateEvidenceError);
      const dup = e as DuplicateEvidenceError;
      expect(dup.unitId).toBe("u-1");
      expect(dup.runId).toBe("run-1");
      expect(dup.message).toContain("readUnit(\"u-1\")"); // 恢复动作文案原样
    }
    // 幂等拒绝不重复记账
    expect(ledger.readAll()).toHaveLength(2);
  });

  it("readUnit 按 unitId 过滤照常（缺省域锚 = unitId）", () => {
    const ledger = newUnitLedger("default-read-unit");
    ledger.append("UnitCreated", unitCreatedPayload("u-a"));
    ledger.append("UnitCreated", unitCreatedPayload("u-b"));
    ledger.append("SpecSubmitted", specPayload("u-a"));

    const eventsOfA = ledger.readUnit("u-a");
    expect(eventsOfA).toHaveLength(2);
    expect(ledger.readUnit("u-none")).toEqual([]);
  });

  it("信封校验锚文案逐字保留：payload.unitId 缺失 → 带行号错误", () => {
    const path = join(tmpRoot, "default-corrupt-anchor", "events.log");
    // 缺省构造（不传 domain）——本用例的泛化锚：信封锚校验仍用 unit 域描述符
    const ledger = new EventLedger(path);
    ledger.append("UnitCreated", unitCreatedPayload("u-1"));
    appendFileSync(
      path,
      `${JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:00.000Z", type: "UnitCreated", payload: { parentId: null, briefRef: "b.md" } })}\n`,
    );
    expect(() => ledger.readAll()).toThrow(/payload\.unitId=undefined 非字符串/);
    expect(() => ledger.readAll()).toThrow(/五类事件 payload 的共有锚字段/);
  });
});
