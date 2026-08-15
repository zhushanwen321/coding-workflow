/**
 * W1 wave: cw report 只读渲染层测试。
 *
 * 覆盖 collectDescendants（树收集 + 防环）与 renderReport（自包含 HTML 渲染）：
 *   - TC1: 4 层树 collectDescendants（长度/序/root 在首/含全部 id）
 *   - TC2: 循环 parentUnitId 防环（不抛 + 长度 2）
 *   - TC3: renderReport 结构（DOCTYPE 开头 + oklch + objective + ≥4 个 <details）
 *   - TC4: wave commitHash + retrospectData.lessonsLearned 渲染
 *   - TC5: XSS 转义（objective '<img>&"' → 实体化，不含 <img>）
 *
 * 测试策略：真实 fs + 真实 CwStore + 真实 JSON 文件（zero mock）。
 * CW_HOME 隔离：beforeEach 设独立 tmp CW_HOME（吸取 list-enhance Wave A C1 教训）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectDescendants, renderReport } from "../src/readonly/index.js";
import { CwStore } from "../src/store/cw-store.js";
import type { WorkUnitRecord } from "../src/store/schema.js";

// ── 最小合法 WorkUnitRecord 构造 helper ─────────────────────

function makeRecord(
  id: string,
  opts: {
    scope?: string;
    slug?: string;
    parentUnitId?: string;
    status?: string;
    objective?: string;
    commitHash?: string;
    lessonsLearned?: string;
    statusHistory?: unknown[];
  } = {},
): WorkUnitRecord {
  return {
    id,
    scope: opts.scope ?? "wave",
    slug: opts.slug ?? id.split(":")[1] ?? id,
    parentUnitId: opts.parentUnitId,
    status: opts.status ?? "created",
    statusHistory:
      opts.statusHistory ?? [
        { at: "2026-08-09T10:00:00.000Z", action: "create", to: "created" },
      ],
    objective: opts.objective ?? "test objective",
    plan: { split: [] },
    ...(opts.commitHash ? { executeResult: { commitHash: opts.commitHash } } : {}),
    ...(opts.lessonsLearned
      ? {
          retrospectData: {
            lessonsLearned: opts.lessonsLearned,
            reviewedItems: [],
          },
        }
      : {}),
  } as WorkUnitRecord;
}

describe("W1: cw report 只读渲染层", () => {
  let cwHome: string;
  let prevCwHome: string | undefined;
  let cwd: string;

  beforeEach(() => {
    cwHome = mkdtempSync(join(tmpdir(), "cw-report-home-"));
    prevCwHome = process.env.CW_HOME;
    process.env.CW_HOME = cwHome;
    cwd = mkdtempSync(join(tmpdir(), "cw-report-cwd-"));
  });

  afterEach(() => {
    if (prevCwHome === undefined) delete process.env.CW_HOME;
    else process.env.CW_HOME = prevCwHome;
    rmSync(cwHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("TC1: 4 层树 collectDescendants——长度 4、root 在首、含全部 id", () => {
    const store = new CwStore(cwd);
    const epic = makeRecord("epic:e", {
      scope: "epic",
      objective: "epic objective",
    });
    const feature = makeRecord("feature:f", {
      scope: "feature",
      parentUnitId: "epic:e",
      objective: "feature objective",
    });
    const slice = makeRecord("slice:s", {
      scope: "slice",
      parentUnitId: "feature:f",
      objective: "slice objective",
    });
    const wave = makeRecord("wave:w", {
      scope: "wave",
      parentUnitId: "slice:s",
      objective: "wave objective",
    });
    store.save(epic);
    store.save(feature);
    store.save(slice);
    store.save(wave);

    const desc = collectDescendants("epic:e", store);

    expect(desc).toHaveLength(4);
    expect(desc[0].id).toBe("epic:e"); // root 在首
    expect(desc.map((d) => d.id)).toEqual(
      expect.arrayContaining(["epic:e", "feature:f", "slice:s", "wave:w"]),
    );
  });

  it("TC2: 循环 parentUnitId 防环——不抛 + 长度 2", () => {
    const store = new CwStore(cwd);
    store.save(makeRecord("wave:a", { parentUnitId: "wave:b" }));
    store.save(makeRecord("wave:b", { parentUnitId: "wave:a" }));

    expect(() => collectDescendants("wave:a", store)).not.toThrow();

    const desc = collectDescendants("wave:a", store);
    expect(desc).toHaveLength(2);
    expect(desc.map((d) => d.id)).toEqual(
      expect.arrayContaining(["wave:a", "wave:b"]),
    );
  });

  it("TC3: renderReport 结构——DOCTYPE 开头 + oklch + objective + ≥4 个 <details", () => {
    const store = new CwStore(cwd);
    const epic = makeRecord("epic:e", {
      scope: "epic",
      objective: "Build the report feature",
    });
    const feature = makeRecord("feature:f", {
      scope: "feature",
      parentUnitId: "epic:e",
    });
    const slice = makeRecord("slice:s", {
      scope: "slice",
      parentUnitId: "feature:f",
    });
    const wave = makeRecord("wave:w", {
      scope: "wave",
      parentUnitId: "slice:s",
    });
    store.save(epic);
    store.save(feature);
    store.save(slice);
    store.save(wave);

    const html = renderReport(epic, store);

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("oklch(");
    expect(html).toContain("Build the report feature");
    const detailsCount = (html.match(/<details/g) ?? []).length;
    expect(detailsCount).toBeGreaterThanOrEqual(4);
  });

  it("TC4: wave commitHash + retrospectData.lessonsLearned 渲染", () => {
    const store = new CwStore(cwd);
    const wave = makeRecord("wave:w", {
      scope: "wave",
      commitHash: "abc123def",
      lessonsLearned: "always verify",
    });
    store.save(wave);

    const html = renderReport(wave, store);

    expect(html).toContain("abc123def");
    expect(html).toContain("always verify");
  });

  it("TC5: XSS 转义——objective '<img>&\"' → 实体化，不含 <img>", () => {
    const store = new CwStore(cwd);
    const epic = makeRecord("epic:e", {
      scope: "epic",
      objective: '<img>&"',
    });
    store.save(epic);

    const html = renderReport(epic, store);

    expect(html).toContain("&lt;img&gt;&amp;&quot;");
    expect(html).not.toContain("<img>");
  });
});
