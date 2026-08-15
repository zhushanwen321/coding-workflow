/**
 * u1b 单测（tree + report）：render 纯函数内容断言 + dispatch 级 exit code 断言。
 * fixture 用 EventLedger API 直写（不依赖 u2 的 CLI 写命令——并行保护）。
 * 用例编号「验收#N」对应 docs/rewrite/acceptance/u1b-acceptance.md「单测验收」第 3/4 组。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fold } from "../src/core/fold.js";
import { dispatch } from "../src/dispatch.js";
import type {
  AcceptanceItem,
  SequencedProjection,
  SequencedUnitProjection,
  SpecSubmittedPayload,
} from "../src/events/types.js";
import { renderReport, renderReportUnit } from "../src/readonly/report.js";
import { renderTree } from "../src/readonly/tree.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

// ---- fixture 基建（EventLedger 直写，零 mock） ----

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u1b-tr-"));
const cwHome = join(tmpRoot, "home");

beforeAll(() => {
  process.env.CW_HOME = cwHome;
});

afterAll(() => {
  delete process.env.CW_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface Project {
  cwd: string;
  ledger: EventLedger;
}

function makeProject(name: string): Project {
  const cwd = join(tmpRoot, name);
  mkdirSync(cwd, { recursive: true });
  return { cwd, ledger: new EventLedger(ledgerPath(cwHome, cwd)) };
}

function getUnit(proj: SequencedProjection, unitId: string): SequencedUnitProjection {
  const unit = proj.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`fixture 破损：unit "${unitId}" 不在投影中`);
  }
  return unit;
}

const STRONG_ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "A1 核心链路真实跑通", type: "e2e-real", command: "node -v" },
  { id: "A2", core: false, title: "A2 单元级", type: "unit" },
];

function strongSpec(unitId: string): SpecSubmittedPayload {
  return {
    unitId,
    specHash: `${unitId}-spec-hash`,
    acceptance: [...STRONG_ACCEPTANCE],
    contracts: [],
    split: [],
  };
}

// ---- 验收#3：tree ----

describe("tree（验收#3）", () => {
  it("三层含孤儿：缩进层级正确、孤儿以根层展示并标 !?（孤儿自身可再做父）", () => {
    const { ledger } = makeProject("p-tree");
    // 建造顺序打乱（先叶后根），验证渲染不依赖账本内 UnitCreated 顺序与层级顺序
    ledger.append("UnitCreated", { unitId: "t-leaf", parentId: "t-mid", briefRef: "b-leaf.md" });
    ledger.append("UnitCreated", { unitId: "t-root", parentId: null, briefRef: "b-root.md" });
    ledger.append("UnitCreated", { unitId: "t-mid", parentId: "t-root", briefRef: "b-mid.md" });
    ledger.append("UnitCreated", { unitId: "t-orphan-b", parentId: "t-orphan-a", briefRef: "b-ob.md" });
    ledger.append("UnitCreated", { unitId: "t-orphan-a", parentId: "t-ghost", briefRef: "b-oa.md" });

    const out = renderTree(fold(ledger.readAll()));
    expect(out.split("\n")).toEqual([
      // 根层顺序 = 账本内 UnitCreated 顺序：t-root、孤儿 t-orphan-a（parent t-ghost 不存在）
      "t-root (created)",
      "  t-mid (created)",
      "    t-leaf (created)",
      "t-orphan-a (created) !?",
      "  t-orphan-b (created)",
      "",
    ]);
  });

  it("dispatch 级：tree exit 0、账本只读；空账本 exit 0 且不创建账本文件", async () => {
    const { cwd, ledger } = makeProject("p-tree-dispatch");
    ledger.append("UnitCreated", { unitId: "t-d1", parentId: null, briefRef: "b.md" });

    const before = ledger.readAll();
    expect(await dispatch(["tree"], cwd)).toBe(0);
    expect(ledger.readAll()).toEqual(before);

    const empty = makeProject("p-tree-empty");
    expect(await dispatch(["tree"], empty.cwd)).toBe(0);
    expect(existsSync(ledgerPath(cwHome, empty.cwd))).toBe(false);
  });
});

// ---- 验收#4：report ----

describe("report（验收#4）", () => {
  it("完整链 unit：verify 覆盖标记正确（A1 ✓ / A2 ✗）、spec hash / evidence / verifyRuns 齐全", () => {
    const { ledger } = makeProject("p-report");
    ledger.append("UnitCreated", { unitId: "r-full", parentId: null, briefRef: "brief-r.md" });
    ledger.append("SpecSubmitted", strongSpec("r-full"));
    ledger.append("VerdictSubmitted", { unitId: "r-full", verdictKind: "spec-review", verdict: "pass" });
    ledger.append("EvidenceSubmitted", {
      unitId: "r-full",
      runId: "run-r-1",
      commit: "f00d" + "0".repeat(36),
      paths: ["report.json", "stdout.txt"],
      sha256: [
        "aa" + "0".repeat(62),
        "bb" + "0".repeat(62),
      ],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "r-full",
      runId: "vr-r-1",
      reportHash: "rh-r-1",
      result: "pass",
      acceptanceIds: ["A1"],
    });

    const out = renderReportUnit(getUnit(fold(ledger.readAll()), "r-full"));
    // spec hash 前 12 位（"r-full-spec-hash" → "r-full-spec-")
    expect(out).toContain("unit: r-full (spec-frozen)");
    expect(out).toContain("spec: r-full-spec-");
    // 覆盖标记：A1 被 pass run 覆盖 → ✓；A2 未覆盖 → ✗
    expect(out).toContain("A1 e2e-real [core] ✓");
    expect(out).toContain("A2 unit ✗");
    // evidence：runId / commit / 每文件 sha256 前 12 位
    expect(out).toContain("runId=run-r-1 commit=f00d");
    expect(out).toContain("report.json sha256=aa");
    expect(out).toContain("stdout.txt sha256=bb");
    // verifyRuns：result + acceptanceIds
    expect(out).toContain("runId=vr-r-1 result=pass acceptance=A1");
  });

  it("多 unit 汇总与空段占位：spec 未提交 → (未提交)；弱 spec（acceptance 空）→ hash 仍展示且 (无) 占位", () => {
    const { ledger } = makeProject("p-report-multi");
    ledger.append("UnitCreated", { unitId: "r-a", parentId: null, briefRef: "b-a.md" });
    ledger.append("UnitCreated", { unitId: "r-b", parentId: "r-a", briefRef: "b-b.md" });
    ledger.append("SpecSubmitted", {
      unitId: "r-b",
      specHash: "r-b-empty-spec-hash",
      acceptance: [],
      contracts: [],
      split: [],
    });

    const out = renderReport(fold(ledger.readAll()));
    expect(out).toContain("unit: r-a (created)");
    expect(out).toContain("unit: r-b (created)");
    expect(out).toContain("spec: (未提交)");
    expect(out).toContain("spec: r-b-empty-sp");
    expect(out).toContain("acceptance:");
    expect(out).toContain("    (无)");
    expect(out).toContain("evidences:");
    expect(out).toContain("verifyRuns:");
  });

  it("dispatch 级：report exit 0 只读；--unit 命中 0、不存在 1；空账本 exit 0 不建文件", async () => {
    const { cwd, ledger } = makeProject("p-report-dispatch");
    ledger.append("UnitCreated", { unitId: "r-d1", parentId: null, briefRef: "b.md" });

    const before = ledger.readAll();
    expect(await dispatch(["report"], cwd)).toBe(0);
    expect(await dispatch(["report", "--unit", "r-d1"], cwd)).toBe(0);
    expect(await dispatch(["report", "--unit", "no-such"], cwd)).toBe(1);
    expect(ledger.readAll()).toEqual(before);

    const empty = makeProject("p-report-empty");
    expect(await dispatch(["report"], empty.cwd)).toBe(0);
    expect(existsSync(ledgerPath(cwHome, empty.cwd))).toBe(false);
  });
});
