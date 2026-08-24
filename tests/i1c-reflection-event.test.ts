/**
 * i1c 单测（ph-i1 R4，design-hi-spawn-pi-rpc.md §3.2）：ReflectionRan 第六类事件。
 *
 * 覆盖：
 *   - ReflectionRan 经真实 EventLedger 追加后 fold 不抛错、投影含记录（纯记录，
 *     不驱动四态转换）
 *   - reflectionPending 事件锚三态：提交 spec（无反思）→ pending；追加对应
 *     specHash 的 ReflectionRan → 不 pending；重提新 spec（新 hash）→ 又 pending
 *   - 旧账本（五类事件）重放语义不变
 *   - 未知事件类型 default 分支错误消息含升级指引
 *
 * 零 mock：真实事件账本（EventLedger 文件锁短事务）+ tmp 目录。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { fold } from "../src/core/fold.js";
import type { LedgerEvent, SpecSubmittedPayload } from "../src/events/types.js";
import { computeFrontier } from "../src/readonly/frontier.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-i1c-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeLedger(name: string): { ledger: EventLedger; path: string } {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  const path = ledgerPath(join(tmpRoot, "cw-home"), dir);
  return { ledger: new EventLedger(path), path };
}

function specPayload(unitId: string, specHash: string): SpecSubmittedPayload {
  return {
    unitId,
    specHash,
    acceptance: [
      { id: "A1", core: true, title: "验收 A1", type: "e2e-real", command: "npm test" },
    ],
    contracts: [],
    split: [],
  };
}

describe("i1c：ReflectionRan 事件与 fold 投影", () => {
  it("追加 ReflectionRan 后 fold 不抛错、投影含记录、不驱动状态转换", () => {
    const { ledger } = makeLedger("fold-record");
    ledger.append("UnitCreated", { unitId: "u1", parentId: null, briefRef: "docs/brief.md" });
    ledger.append("SpecSubmitted", specPayload("u1", "hash-v1"));
    const appended = ledger.append("ReflectionRan", {
      unitId: "u1",
      specHash: "hash-v1",
      round: 1,
      sessionFile: "/tmp/session-a.md",
      revisedSpec: false,
    });
    expect(appended.type).toBe("ReflectionRan");

    const proj = fold(ledger.readAll());
    const unit = proj.units.get("u1");
    expect(unit).toBeDefined();
    expect(unit?.reflections).toEqual([
      {
        unitId: "u1",
        specHash: "hash-v1",
        round: 1,
        sessionFile: "/tmp/session-a.md",
        revisedSpec: false,
      },
    ]);
    // 纯记录：spec 未过审（无 verdict），状态仍 created——ReflectionRan 不驱动转换
    expect(proj.units.size).toBe(1);
    expect(proj.totalEvents).toBe(3);
  });

  it("旧账本（五类事件，无 ReflectionRan）重放语义不变", () => {
    const { ledger } = makeLedger("old-ledger");
    ledger.append("UnitCreated", { unitId: "u1", parentId: null, briefRef: "docs/brief.md" });
    ledger.append("SpecSubmitted", specPayload("u1", "hash-v1"));
    ledger.append("VerdictSubmitted", {
      unitId: "u1",
      verdictKind: "spec-review",
      verdict: "fail",
      role: "reviewer",
      comment: "验收真空",
    });
    const proj = fold(ledger.readAll());
    const unit = proj.units.get("u1");
    expect(unit?.reflections).toEqual([]);
    expect(unit?.specs.length).toBe(1);
    expect(unit?.verdicts.length).toBe(1);
    expect(proj.totalEvents).toBe(3);
  });

  it("未知事件类型 default 分支错误消息含升级指引", () => {
    const bogus = {
      seq: 2,
      ts: "2026-08-24T00:00:00.000Z",
      type: "FutureEvent",
      payload: { unitId: "u1" },
    } as unknown as LedgerEvent;
    const events: LedgerEvent[] = [
      { seq: 1, ts: "2026-08-24T00:00:00.000Z", type: "UnitCreated", payload: { unitId: "u1", parentId: null, briefRef: "docs/brief.md" } },
      bogus,
    ];
    expect(() => fold(events)).toThrow(/未知事件类型/);
    expect(() => fold(events)).toThrow(
      /npm i -g @zhushanwen\/coding-workflow@latest/,
    );
  });
});

describe("i1c：reflectionPending 事件锚三态", () => {
  it("无反思 → pending；追加对应 specHash 的 ReflectionRan → 不 pending；重提新 spec → 又 pending", () => {
    const { ledger } = makeLedger("three-states");
    ledger.append("UnitCreated", { unitId: "u1", parentId: null, briefRef: "docs/brief.md" });
    ledger.append("SpecSubmitted", specPayload("u1", "hash-v1"));

    const pending1 = computeFrontier(fold(ledger.readAll()));
    expect(pending1.reflectionPending).toEqual(["u1"]);

    ledger.append("ReflectionRan", { unitId: "u1", specHash: "hash-v1", round: 1 });
    const done = computeFrontier(fold(ledger.readAll()));
    expect(done.reflectionPending).toEqual([]);
    // 反思完成后 unit 回到 specReviewPending（反思先于审查，R3 流）
    expect(done.specReviewPending).toEqual(["u1"]);

    // 重提新 spec（新 hash）：旧 hash 的反思不再覆盖新 spec → 又 pending
    ledger.append("SpecSubmitted", specPayload("u1", "hash-v2"));
    const pending2 = computeFrontier(fold(ledger.readAll()));
    expect(pending2.reflectionPending).toEqual(["u1"]);

    // 新 hash 的反思补上后再消
    ledger.append("ReflectionRan", { unitId: "u1", specHash: "hash-v2", round: 2, revisedSpec: true });
    const done2 = computeFrontier(fold(ledger.readAll()));
    expect(done2.reflectionPending).toEqual([]);
  });

  it("旧账本（无任何 ReflectionRan）的 created+有 spec unit 判 reflectionPending（四流程前反思步）", () => {
    const { ledger } = makeLedger("old-pending");
    ledger.append("UnitCreated", { unitId: "old", parentId: null, briefRef: "docs/brief.md" });
    ledger.append("SpecSubmitted", specPayload("old", "hash-old"));
    const groups = computeFrontier(fold(ledger.readAll()));
    expect(groups.reflectionPending).toEqual(["old"]);
    expect(groups.specReviewPending).toEqual([]);
  });
});
