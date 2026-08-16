/**
 * u1b 单测（status + frontier）：render 纯函数内容断言 + dispatch 级 exit code 断言。
 * fixture 用 EventLedger API 直写（不依赖 u2 的 CLI 写命令——并行保护）。
 * 用例编号「验收#N」对应 docs/rewrite/acceptance/u1b-acceptance.md「单测验收」第 1/2 组。
 *
 * 分层：内容断言测导出的纯函数（渲染与投影计算），exit code / 只读性 / 空账本行为
 * 走完整 dispatch 路径；stdout 端到端内容断言在 tests/u1b-e2e.test.ts（真实子进程）。
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
import type { UnitStatus } from "../src/events/types.js";
import { computeFrontier, renderFrontier } from "../src/readonly/frontier.js";
import { treeStatuses } from "../src/readonly/load.js";
import { renderStatusDetail, renderStatusList, statusJson, unitJson } from "../src/readonly/status.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

// ---- fixture 基建（EventLedger 直写，零 mock） ----

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u1b-sf-"));
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

/** 独立项目目录（per-cwd 账本隔离），返回直写用 ledger */
function makeProject(name: string): Project {
  const cwd = join(tmpRoot, name);
  mkdirSync(cwd, { recursive: true });
  return { cwd, ledger: new EventLedger(ledgerPath(cwHome, cwd)) };
}

/** 从投影取 unit；fixture 破损（不可能路径）时抛错而非静默 */
function getUnit(proj: SequencedProjection, unitId: string): SequencedUnitProjection {
  const unit = proj.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`fixture 破损：unit "${unitId}" 不在投影中`);
  }
  return unit;
}

/** 从投影取 unit 的树感知状态；缺失时抛错而非静默（同 getUnit 口径） */
function getStatus(proj: SequencedProjection, unitId: string): UnitStatus {
  const status = treeStatuses(proj).get(unitId);
  if (status === undefined) {
    throw new Error(`fixture 破损：unit "${unitId}" 不在树感知状态集合中`);
  }
  return status;
}

/** 过 spec gate 五规则的 acceptance（core=e2e-real 带可解析 command + unit 级） */
const STRONG_ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "A1 核心链路真实跑通", type: "e2e-real", command: "node -v" },
  { id: "A2", core: false, title: "A2 单元级", type: "unit" },
];

function strongSpec(unitId: string): SpecSubmittedPayload {
  return {
    unitId,
    specHash: `${unitId}-strong-spec-hash`,
    acceptance: [...STRONG_ACCEPTANCE],
    contracts: [],
    split: [],
  };
}

/** 弱 spec：acceptance 为空 → checkSpecRules rule① fail（真实 gate 接线的反向探针） */
function weakSpec(unitId: string): SpecSubmittedPayload {
  return {
    unitId,
    specHash: `${unitId}-weak-spec-hash`,
    acceptance: [],
    contracts: [],
    split: [],
  };
}

/** 构造 spec-frozen unit 的事件序列（spec 过 gate + spec-review pass） */
function appendFrozenSequence(ledger: EventLedger, unitId: string): void {
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: `brief-${unitId}.md` });
  ledger.append("SpecSubmitted", strongSpec(unitId));
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass" });
}

/**
 * 「root 过早 exec-review」fixture：root u-pm 自身证据链闭合（spec 过审 → verify
 * 全覆盖 → exec-review pass = 单 unit 口径 closed），子 u-pm-c 停在 verified
 * （无 exec-review）——树感知口径 root 不 closed。
 */
function appendPrematureExecLedger(ledger: EventLedger): void {
  ledger.append("UnitCreated", { unitId: "u-pm", parentId: null, briefRef: "b-pm.md" });
  ledger.append("SpecSubmitted", strongSpec("u-pm"));
  ledger.append("VerdictSubmitted", { unitId: "u-pm", verdictKind: "spec-review", verdict: "pass" });
  ledger.append("VerifyRan", {
    unitId: "u-pm",
    runId: "vr-pm-1",
    reportHash: "rh-pm-1",
    result: "pass",
    acceptanceIds: ["A1", "A2"],
  });
  ledger.append("VerdictSubmitted", { unitId: "u-pm", verdictKind: "exec-review", verdict: "pass" });
  ledger.append("UnitCreated", { unitId: "u-pm-c", parentId: "u-pm", briefRef: "b-pmc.md" });
  ledger.append("SpecSubmitted", strongSpec("u-pm-c"));
  ledger.append("VerdictSubmitted", { unitId: "u-pm-c", verdictKind: "spec-review", verdict: "pass" });
  ledger.append("VerifyRan", {
    unitId: "u-pm-c",
    runId: "vr-pmc-1",
    reportHash: "rh-pmc-1",
    result: "pass",
    acceptanceIds: ["A1", "A2"],
  });
}

// ---- 验收#1：status ----

describe("status 渲染（验收#1）", () => {
  it("多 unit 账本：每行含 unitId / status / specs / evidences / lastVerify", () => {
    const { ledger } = makeProject("p-status-list");
    ledger.append("UnitCreated", {
      unitId: "u-created",
      parentId: null,
      briefRef: "brief-created.md",
    });
    appendFrozenSequence(ledger, "u-frozen");
    ledger.append("EvidenceSubmitted", {
      unitId: "u-frozen",
      runId: "run-frozen-1",
      commit: "c" + "0".repeat(39),
      paths: ["report.json"],
      sha256: ["d" + "0".repeat(63)],
      exitCode: 0,
    });
    // 只覆盖 A1 未覆盖 A2 → 状态停在 spec-frozen（verifyRuns 非空 → lastVerify:pass）
    ledger.append("VerifyRan", {
      unitId: "u-frozen",
      runId: "vr-frozen-1",
      reportHash: "rh-frozen-1",
      result: "pass",
      acceptanceIds: ["A1"],
    });

    const out = renderStatusList(fold(ledger.readAll()));
    expect(out).toContain("u-created  created  specs:0 evidences:0 lastVerify:-");
    expect(out).toContain("u-frozen  spec-frozen  specs:1 evidences:1 lastVerify:pass");
  });

  it("树感知 closed：root 过早 exec-review（子停在 verified）→ status 列表显示 root 非 closed", () => {
    const { ledger } = makeProject("p-status-premature");
    appendPrematureExecLedger(ledger);
    const out = renderStatusList(fold(ledger.readAll()));
    // root 单 unit 口径已 closed，但子未收尾 → 树感知压回 verified（投影即真相）
    expect(out).toContain("u-pm  verified  specs:1 evidences:0 lastVerify:pass");
    expect(out).toContain("u-pm-c  verified  specs:1 evidences:0 lastVerify:pass");
    expect(out).not.toContain("closed");
  });

  it("--unit 详情：briefRef、spec hash 前 12 位、全部 verdict、evidence runId、verify 覆盖 id", () => {
    const { ledger } = makeProject("p-status-detail");
    appendFrozenSequence(ledger, "u-full");
    ledger.append("VerdictSubmitted", {
      unitId: "u-full",
      verdictKind: "spec-review",
      verdict: "fail",
      comment: "首轮验收偏弱",
    });
    ledger.append("SpecSubmitted", strongSpec("u-full"));
    ledger.append("VerdictSubmitted", { unitId: "u-full", verdictKind: "spec-review", verdict: "pass" });
    ledger.append("EvidenceSubmitted", {
      unitId: "u-full",
      runId: "run-full-1",
      commit: "ab" + "0".repeat(38),
      paths: ["report.json"],
      sha256: ["e" + "0".repeat(63)],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "u-full",
      runId: "vr-full-1",
      reportHash: "rh-full-1",
      result: "fail",
      acceptanceIds: [],
    });

    const proj = fold(ledger.readAll());
    const out = renderStatusDetail(getUnit(proj, "u-full"), getStatus(proj, "u-full"));
    expect(out).toContain("briefRef: brief-u-full.md");
    expect(out).toContain("status: spec-frozen");
    // spec hash 前 12 位 = "u-full-stron"（两次提交各一行）
    expect(out.match(/u-full-stron/g)).toHaveLength(2);
    // verdict 全列：1 条 fail（带评论）+ 2 条 pass
    expect(out.match(/- spec-review pass/g)).toHaveLength(2);
    expect(out).toContain("- spec-review fail — 首轮验收偏弱");
    expect(out).toContain("runId=run-full-1 commit=ab");
    expect(out).toContain("runId=vr-full-1 result=fail acceptance=-");
  });

  it("--json：可 JSON.parse，units 数组字段与 types.ts 一致，note 注明 Map 投影形状", () => {
    const { ledger } = makeProject("p-status-json");
    appendFrozenSequence(ledger, "u-j1");
    ledger.append("UnitCreated", {
      unitId: "u-j2",
      parentId: "u-j1",
      briefRef: "brief-j2.md",
    });

    const proj = fold(ledger.readAll());
    const parsed = JSON.parse(statusJson(proj)) as {
      units: Array<{
        unitId: string;
        parentId: string | null;
        briefRef: string;
        status: string;
        specs: unknown[];
        verdicts: unknown[];
        evidences: unknown[];
        verifyRuns: unknown[];
      }>;
      totalEvents: number;
      note: string;
    };
    expect(parsed.totalEvents).toBe(4);
    expect(parsed.units.map((u) => u.unitId)).toEqual(["u-j1", "u-j2"]);
    expect(parsed.units[1]?.parentId).toBe("u-j1");
    expect(parsed.units[0]?.status).toBe("spec-frozen");
    expect(parsed.units[0]?.specs).toHaveLength(1);
    expect(parsed.units[1]?.specs).toHaveLength(0);
    // Map → 数组的形状注明（验收文档「并注明」条款）
    expect(parsed.note).toContain("Map");
    expect(parsed.note).toContain("数组");

    const unitParsed = JSON.parse(
      unitJson(getUnit(proj, "u-j2"), getStatus(proj, "u-j2")),
    ) as {
      unitId: string;
      status: string;
      briefRef: string;
    };
    expect(unitParsed).toEqual(
      expect.objectContaining({ unitId: "u-j2", status: "created", briefRef: "brief-j2.md" }),
    );
  });
});

describe("status dispatch 级（验收#1 通用条款）", () => {
  it("正常账本 exit 0；账本保持只读", async () => {
    const { cwd, ledger } = makeProject("p-status-dispatch");
    appendFrozenSequence(ledger, "u-d1");

    const before = ledger.readAll();
    expect(await dispatch(["status"], cwd)).toBe(0);
    expect(ledger.readAll()).toEqual(before);
  });

  it("flag 路径（dispatch 级）：--unit 命中 exit 0、不存在 exit 1、缺值 exit 1、--json exit 0", async () => {
    const { cwd, ledger } = makeProject("p-status-flags");
    appendFrozenSequence(ledger, "u-f1");

    const before = ledger.readAll();
    expect(await dispatch(["status", "--unit", "u-f1"], cwd)).toBe(0);
    expect(await dispatch(["status", "--unit", "no-such-unit"], cwd)).toBe(1);
    expect(await dispatch(["status", "--unit"], cwd)).toBe(1);
    expect(await dispatch(["status", "--json"], cwd)).toBe(0);
    expect(await dispatch(["status", "--json", "--unit", "u-f1"], cwd)).toBe(0);
    expect(ledger.readAll()).toEqual(before);
  });

  it("空账本：exit 0 且不创建账本文件（真只读）", async () => {
    const { cwd } = makeProject("p-status-empty");
    expect(await dispatch(["status"], cwd)).toBe(0);
    expect(existsSync(ledgerPath(cwHome, cwd))).toBe(false);
  });
});

// ---- 验收#2：frontier ----

describe("frontier（验收#2）", () => {
  it("三态账本：specReady 恰含 created 者、buildReady 恰含 spec-frozen 者（verified 不入组）", () => {
    const { ledger } = makeProject("p-frontier-3states");
    ledger.append("UnitCreated", { unitId: "f-created", parentId: null, briefRef: "b1.md" });
    appendFrozenSequence(ledger, "f-frozen");
    appendFrozenSequence(ledger, "f-verified");
    ledger.append("VerifyRan", {
      unitId: "f-verified",
      runId: "vr-verified-1",
      reportHash: "rh-verified-1",
      result: "pass",
      acceptanceIds: ["A1", "A2"],
    });

    const proj = fold(ledger.readAll());
    const groups = computeFrontier(proj);
    expect(groups).toEqual({ specReady: ["f-created"], buildReady: ["f-frozen"] });

    const out = renderFrontier(groups);
    expect(out).toContain("specReady:");
    expect(out).toContain("buildReady:");
    expect(out).toContain("  f-created");
    expect(out).toContain("  f-frozen");
    expect(out).not.toContain("f-verified");
  });

  it("真实 checkSpecRules 接线：弱 spec + spec-review pass → 停在 created，进 specReady 不进 buildReady", () => {
    const { ledger } = makeProject("p-frontier-weak");
    appendFrozenSequence(ledger, "w-frozen");
    ledger.append("UnitCreated", { unitId: "w-weak", parentId: null, briefRef: "b-weak.md" });
    ledger.append("SpecSubmitted", weakSpec("w-weak"));
    // 审查通过也无效：gate 挂在 spec 本身（rule① 验收为空）
    ledger.append("VerdictSubmitted", { unitId: "w-weak", verdictKind: "spec-review", verdict: "pass" });

    const proj = fold(ledger.readAll());
    expect(renderStatusList(proj)).toContain("w-weak  created  specs:1");
    const groups = computeFrontier(proj);
    expect(groups.specReady).toContain("w-weak");
    expect(groups.buildReady).not.toContain("w-weak");
    expect(groups.buildReady).toEqual(["w-frozen"]);
  });

  it("dispatch 级：frontier 与 frontier --json 均 exit 0，账本只读", async () => {
    const { cwd, ledger } = makeProject("p-frontier-dispatch");
    appendFrozenSequence(ledger, "f-d1");

    const before = ledger.readAll();
    expect(await dispatch(["frontier"], cwd)).toBe(0);
    expect(await dispatch(["frontier", "--json"], cwd)).toBe(0);
    expect(ledger.readAll()).toEqual(before);
  });
});
