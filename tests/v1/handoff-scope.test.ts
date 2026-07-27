/**
 * Wave C: renderHandoff --scope upstream/full 测试。
 *
 * 覆盖 scope=upstream（父链）+ scope=full（父链+子树）+ size warning。
 * scope=self 的向后兼容由现有 readonly-handoff.test.ts 的 18 个测试覆盖。
 *
 * 测试策略：真实 V1Store + mkdtemp + 真实父子 unit（zero mock）。
 * V1_HOME 隔离（吸取 Wave A/B 教训）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderHandoff } from "../../src/readonly/render.js";
import type { WorkUnitRecord } from "../../src/store/schema.js";
import { V1Store } from "../../src/store/v1-store.js";

/** 造一个最小 WorkUnitRecord（靠索引签名过类型）。 */
function makeUnit(
  id: string,
  opts: {
    scope?: string;
    slug?: string;
    status?: string;
    objective?: string;
    parentUnitId?: string;
  } = {},
): WorkUnitRecord {
  return {
    id,
    scope: opts.scope ?? "wave",
    slug: opts.slug ?? id.split(":")[1] ?? id,
    status: opts.status ?? "created",
    statusHistory: [{ at: "2026-07-26T10:00:00.000Z", action: "create", to: "created" }],
    basedOnParent: [],
    abandonedRefs: [],
    objective: opts.objective ?? `objective for ${id}`,
    parentUnitId: opts.parentUnitId,
    clarifications: [],
    plan: { split: [], techChoices: [], interfaces: [], dataModels: [], errorSpecs: [], decisions: [] },
    designReviewJudgment: {
      necessity: "", sufficiency: { gaps: [], overlaps: [], meceNote: "" },
      alternatives: "", tradeoffs: [], risks: [],
    },
    executeResult: { childUnitIds: [] },
    retrospectData: {
      reviewedItems: [], lessonsLearned: "", deliveryVerdict: "failed",
      childUnitIdsEvidence: [], splitFulfillment: [],
    },
    evidence: { generatedAt: "", artifacts: [], childDelivery: [] },
  } as WorkUnitRecord;
}

/** 造 4 层 unit 树：epic → feature → slice → wave（wave 可多个）。 */
function makeFourLayerTree(): WorkUnitRecord[] {
  return [
    makeUnit("epic:root", { scope: "epic", objective: "epic objective", status: "executing" }),
    makeUnit("feature:feat", { scope: "feature", parentUnitId: "epic:root", objective: "feature objective", status: "executing" }),
    makeUnit("slice:slc", { scope: "slice", parentUnitId: "feature:feat", objective: "slice objective", status: "executing" }),
    makeUnit("wave:w1", { scope: "wave", parentUnitId: "slice:slc", objective: "wave1 objective", status: "closed" }),
    makeUnit("wave:w2", { scope: "wave", parentUnitId: "slice:slc", objective: "wave2 objective", status: "tested" }),
  ];
}

describe("Wave C: renderHandoff --scope self（向后兼容）", () => {
  it("TC-C1: 不传 scope 默认 self，输出单 unit 五段式（无 FOCUS 标记）", () => {
    const units = makeFourLayerTree();
    const out = renderHandoff(units[2]!); // slice，不传 store/scope
    expect(out).toMatch(/# Handoff: slice:slc/);
    expect(out).toMatch(/## 目标/);
    // self 模式不加 FOCUS 标记（那是 upstream/full 的）
    expect(out).not.toMatch(/=== FOCUS ===/);
    // self 模式不含父链/子树
    expect(out).not.toMatch(/epic:root/);
    expect(out).not.toMatch(/wave:w1/);
  });

  it("TC-C7: 非法 scope 抛错", () => {
    const units = makeFourLayerTree();
    expect(() => renderHandoff(units[0]!, undefined as never, "invalid" as never)).toThrow();
  });
});

describe("Wave C: renderHandoff --scope upstream", () => {
  let v1Home: string;
  let prevV1Home: string | undefined;
  let store: V1Store;

  beforeEach(() => {
    v1Home = mkdtempSync(join(tmpdir(), "cw-hscope-v1home-"));
    prevV1Home = process.env.V1_HOME;
    process.env.V1_HOME = v1Home;
    const cwd = mkdtempSync(join(tmpdir(), "cw-hscope-cwd-"));
    store = new V1Store(cwd);
    for (const u of makeFourLayerTree()) store.save(u);
  });
  afterEach(() => {
    if (prevV1Home === undefined) delete process.env.V1_HOME;
    else process.env.V1_HOME = prevV1Home;
    rmSync(v1Home, { recursive: true, force: true });
  });

  it("TC-C3: scope=upstream 焦点是 wave，输出含父链（epic/feature/slice）不含子树", () => {
    const focus = store.load("wave:w1")!;
    const out = renderHandoff(focus, store, "upstream");

    // 含 === FOCUS === 标记
    expect(out).toMatch(/=== FOCUS ===/);
    // 父链：epic → feature → slice（brief 形式，## 标题）
    expect(out).toMatch(/epic:root/);
    expect(out).toMatch(/feature:feat/);
    expect(out).toMatch(/slice:slc/);
    // 焦点 wave:w1 完整五段式
    expect(out).toMatch(/# Handoff: wave:w1/);
    // upstream 不含子树（wave 无 children，也不含兄弟 wave）
    expect(out).not.toMatch(/--- 子树 ---/);
    expect(out).not.toMatch(/wave:w2/);
  });

  it("TC-C6: 焦点是叶子（wave）时 upstream 仍含父链（无子树概念）", () => {
    const focus = store.load("wave:w2")!;
    const out = renderHandoff(focus, store, "upstream");
    expect(out).toMatch(/=== FOCUS ===/);
    expect(out).toMatch(/slice:slc/); // 父链含
    expect(out).toMatch(/# Handoff: wave:w2/);
  });

  it("TC-C5: 焦点是根（epic）时 upstream 无父链，直接 FOCUS", () => {
    const focus = store.load("epic:root")!;
    const out = renderHandoff(focus, store, "upstream");
    expect(out).toMatch(/=== FOCUS ===/);
    expect(out).toMatch(/# Handoff: epic:root/);
    // 根无父链，不含其他 unit 的 brief
    expect(out).not.toMatch(/feature:feat/);
  });
});

describe("Wave C: renderHandoff --scope full", () => {
  let v1Home: string;
  let prevV1Home: string | undefined;
  let store: V1Store;

  beforeEach(() => {
    v1Home = mkdtempSync(join(tmpdir(), "cw-hscope-v1home-"));
    prevV1Home = process.env.V1_HOME;
    process.env.V1_HOME = v1Home;
    const cwd = mkdtempSync(join(tmpdir(), "cw-hscope-cwd-"));
    store = new V1Store(cwd);
    for (const u of makeFourLayerTree()) store.save(u);
  });
  afterEach(() => {
    if (prevV1Home === undefined) delete process.env.V1_HOME;
    else process.env.V1_HOME = prevV1Home;
    rmSync(v1Home, { recursive: true, force: true });
  });

  it("TC-C2: scope=full 焦点是 slice，输出含父链（epic/feature）+ FOCUS + 子树（wave w1/w2）", () => {
    const focus = store.load("slice:slc")!;
    const out = renderHandoff(focus, store, "full");

    // FOCUS 标记
    expect(out).toMatch(/=== FOCUS ===/);
    expect(out).toMatch(/# Handoff: slice:slc/);
    // 父链：epic + feature（slice 的祖先）
    expect(out).toMatch(/epic:root/);
    expect(out).toMatch(/feature:feat/);
    // 子树：--- 子树 --- 分隔 + wave w1/w2 brief
    expect(out).toMatch(/--- 子树 ---/);
    expect(out).toMatch(/wave:w1/);
    expect(out).toMatch(/wave:w2/);
  });

  it("TC-C2b: 焦点是 epic（根），full 含 FOCUS + 子树（无父链）", () => {
    const focus = store.load("epic:root")!;
    const out = renderHandoff(focus, store, "full");

    expect(out).toMatch(/=== FOCUS ===/);
    expect(out).toMatch(/# Handoff: epic:root/);
    // 根无父链
    // 子树递归：feature → slice → wave
    expect(out).toMatch(/--- 子树 ---/);
    expect(out).toMatch(/feature:feat/);
    expect(out).toMatch(/slice:slc/);
    expect(out).toMatch(/wave:w1/);
  });

  it("TC-C6b: 焦点是叶子（wave），full 含父链 + FOCUS（无子树段）", () => {
    const focus = store.load("wave:w1")!;
    const out = renderHandoff(focus, store, "full");

    expect(out).toMatch(/=== FOCUS ===/);
    expect(out).toMatch(/# Handoff: wave:w1/);
    // 父链 epic/feature/slice
    expect(out).toMatch(/epic:root/);
    expect(out).toMatch(/slice:slc/);
    // wave 是叶子，无子树段（不输出 --- 子树 --- 或子树为空时不输出）
    // wave:w2 是兄弟不是子树，不应出现
    expect(out).not.toMatch(/wave:w2/);
  });
});

describe("Wave C: size warning", () => {
  let v1Home: string;
  let prevV1Home: string | undefined;
  let store: V1Store;

  beforeEach(() => {
    v1Home = mkdtempSync(join(tmpdir(), "cw-hscope-v1home-"));
    prevV1Home = process.env.V1_HOME;
    process.env.V1_HOME = v1Home;
    const cwd = mkdtempSync(join(tmpdir(), "cw-hscope-cwd-"));
    store = new V1Store(cwd);
  });
  afterEach(() => {
    if (prevV1Home === undefined) delete process.env.V1_HOME;
    else process.env.V1_HOME = prevV1Home;
    rmSync(v1Home, { recursive: true, force: true });
  });

  it("TC-C4: 超过 500 行时尾部追加 size warning，不截断内容", () => {
    // 造一个会爆行的树：1 个 slice 焦点 + 30 个 child wave，每个带多条长 clarification
    //（clarification 进 decisions section，是行数主要来源）
    const longText = "x".repeat(150);
    const makeClarifications = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `C${i}`, status: "active", type: "grilling" as const,
        question: `question ${i} ${longText}`,
        resolution: `resolution ${i} ${longText}`,
      }));
    const units: WorkUnitRecord[] = [
      {
        ...makeUnit("slice:focus", { scope: "slice", objective: "focus " + longText, status: "executing" }),
        clarifications: makeClarifications(5),
      } as WorkUnitRecord,
    ];
    for (let i = 0; i < 40; i++) {
      units.push({
        ...makeUnit(`wave:child${i}`, {
          scope: "wave",
          parentUnitId: "slice:focus",
          objective: `child ${i} ${longText}`,
          status: "closed",
        }),
        clarifications: makeClarifications(3),
      } as WorkUnitRecord);
    }
    for (const u of units) store.save(u);

    const focus = store.load("slice:focus")!;
    const out = renderHandoff(focus, store, "full");

    const lineCount = out.split("\n").length;
    // 确认确实超过 500 行（构造成功的前提）
    expect(lineCount).toBeGreaterThan(500);
    // 尾部有 size warning（actual 行数是拼接前的内容行数，比 lineCount 少几行）
    expect(out).toMatch(/⚠ Handoff exceeds 500 lines/);
    expect(out).toMatch(/actual: \d+/);
    expect(out).toMatch(/narrowing scope|--scope self|descending/);
    // 内容未被截断（仍有所有 child）
    for (let i = 0; i < 40; i++) {
      expect(out).toMatch(new RegExp(`wave:child${i}`));
    }
  });

  it("TC-C4b: 未超 500 行时不追加 warning", () => {
    const units = makeFourLayerTree();
    for (const u of units) store.save(u);
    const focus = store.load("slice:slc")!;
    const out = renderHandoff(focus, store, "full");
    expect(out).not.toMatch(/⚠ Handoff exceeds/);
  });
});
