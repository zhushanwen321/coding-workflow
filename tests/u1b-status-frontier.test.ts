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
import { computeFrontier, consecutiveIntegrationFails, renderFrontier, specReviewFailCounts } from "../src/readonly/frontier.js";
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
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

/** 同上但 parentId 指向指定 root（分解树内的子 unit 形态） */
function appendFrozenChild(ledger: EventLedger, unitId: string, parentId: string): void {
  ledger.append("UnitCreated", { unitId, parentId, briefRef: `brief-${unitId}.md` });
  ledger.append("SpecSubmitted", strongSpec(unitId));
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
}

/**
 * 「root 过早 exec-review」fixture：root u-pm 自身证据链闭合（spec 过审 → verify
 * 全覆盖 → exec-review pass = 单 unit 口径 closed），子 u-pm-c 停在 verified
 * （无 exec-review）——树感知口径 root 不 closed。
 */
function appendPrematureExecLedger(ledger: EventLedger): void {
  ledger.append("UnitCreated", { unitId: "u-pm", parentId: null, briefRef: "b-pm.md" });
  ledger.append("SpecSubmitted", strongSpec("u-pm"));
  ledger.append("VerdictSubmitted", { unitId: "u-pm", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
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
  ledger.append("VerdictSubmitted", { unitId: "u-pm-c", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
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
      role: "reviewer",
      comment: "首轮验收偏弱",
    });
    ledger.append("SpecSubmitted", strongSpec("u-full"));
    ledger.append("VerdictSubmitted", { unitId: "u-full", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
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
  it("三态账本：specReady 恰含 created 者、buildReady 恰含 spec-frozen 者、verified → execReviewReady（closed 不入组）", () => {
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
    expect(groups.specReady).toEqual(["f-created"]);
    expect(groups.buildReady).toEqual(["f-frozen"]);
    expect(groups.execReviewReady).toEqual(["f-verified"]);
    // 其余维度（本账本无对应形态）为空（mx-1 起 created+spec 维度重排为
    // specReviewPending / specFixPending / specReviewDeadlock 三组）
    expect(groups.specReviewPending).toEqual([]);
    expect(groups.specFixPending).toEqual([]);
    expect(groups.specReviewDeadlock).toEqual([]);
    expect(groups.missingChildren).toEqual([]);
    expect(groups.integrationDrift).toEqual([]);
    expect(groups.integrationReady).toEqual([]);

    const out = renderFrontier(groups);
    expect(out).toContain("specReady:");
    expect(out).toContain("buildReady:");
    expect(out).toContain("execReviewReady:");
    expect(out).toContain("  f-created");
    expect(out).toContain("  f-frozen");
    expect(out).toContain("  f-verified");
  });

  it("真实 checkSpecRules 接线：弱 spec + spec-review pass → 停在 created 且不入任何推进组（机器派发无出口）", () => {
    const { ledger } = makeProject("p-frontier-weak");
    appendFrozenSequence(ledger, "w-frozen");
    ledger.append("UnitCreated", { unitId: "w-weak", parentId: null, briefRef: "b-weak.md" });
    ledger.append("SpecSubmitted", weakSpec("w-weak"));
    // 审查通过也无效：gate 挂在 spec 本身（rule① 验收为空）
    ledger.append("VerdictSubmitted", { unitId: "w-weak", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });

    const proj = fold(ledger.readAll());
    expect(renderStatusList(proj)).toContain("w-weak  created  specs:1");
    const groups = computeFrontier(proj);
    // 弱 spec 已提交且已过审（gate 红）：既非首派也非待审/修复出口——重派 designer
    // 只会重提交-仍弱循环，与 runner 派发口径一致地不入组（需人工修 spec）
    expect(groups.specReady).not.toContain("w-weak");
    expect(groups.specReviewPending).not.toContain("w-weak");
    expect(groups.specFixPending).not.toContain("w-weak");
    expect(groups.buildReady).not.toContain("w-weak");
    expect(groups.buildReady).toEqual(["w-frozen"]);
  });

  it("fx 维度（与 loop 派发同口径）：spec-frozen 缺子 → missingChildren 而非 buildReady", () => {
    const { ledger } = makeProject("p-frontier-missing-children");
    // root spec-frozen：split 声明 2 个子，仅 1 个已创建 → 派 designer 补建子
    ledger.append("UnitCreated", { unitId: "mc-root", parentId: null, briefRef: "b-mc.md" });
    ledger.append("SpecSubmitted", {
      unitId: "mc-root",
      specHash: "mc-root-hash",
      acceptance: [...STRONG_ACCEPTANCE],
      contracts: [],
      split: [
        { unitId: "mc-c1", dependsOn: [] },
        { unitId: "mc-c2", dependsOn: [] },
      ],
    });
    ledger.append("VerdictSubmitted", { unitId: "mc-root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    appendFrozenChild(ledger, "mc-c1", "mc-root");

    const proj = fold(ledger.readAll());
    const groups = computeFrontier(proj);
    expect(groups.missingChildren).toContain("mc-root");
    expect(groups.buildReady).not.toContain("mc-root"); // 旧口径会误报 buildReady
    expect(groups.integrationReady).not.toContain("mc-root");
  });

  it("fx/mx 维度：created 且有 spec 未审 → specReviewPending（独立 reviewer）；连续 2 次 fail → specFixPending / specReviewDeadlock；内部节点子全 verified → integrationReady；连续 fail 达上限 → integrationDrift", () => {
    const { ledger } = makeProject("p-frontier-integration");
    // rr：spec 已提交、无 spec-review → 独立 reviewer 待审出口（mx-1：specReviewPending）
    ledger.append("UnitCreated", { unitId: "rr", parentId: null, briefRef: "b-rr.md" });
    ledger.append("SpecSubmitted", strongSpec("rr"));
    // sf：spec 已提交且最近 spec-review verdict 是 fail → designer 修 spec 出口（mx-1）
    ledger.append("UnitCreated", { unitId: "sf", parentId: null, briefRef: "b-sf.md" });
    ledger.append("SpecSubmitted", strongSpec("sf"));
    ledger.append("VerdictSubmitted", { unitId: "sf", verdictKind: "spec-review", verdict: "fail", role: "reviewer", comment: "不合格项：X" });

    // ig-root：spec-frozen 内部节点，两个子全部 verified → 集成就绪
    ledger.append("UnitCreated", { unitId: "ig-root", parentId: null, briefRef: "b-ig.md" });
    ledger.append("SpecSubmitted", {
      unitId: "ig-root",
      specHash: "ig-root-hash",
      acceptance: [...STRONG_ACCEPTANCE],
      contracts: [],
      split: [
        { unitId: "ig-c1", dependsOn: [] },
        { unitId: "ig-c2", dependsOn: [] },
      ],
    });
    ledger.append("VerdictSubmitted", { unitId: "ig-root", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    for (const child of ["ig-c1", "ig-c2"]) {
      appendFrozenChild(ledger, child, "ig-root");
      ledger.append("VerifyRan", {
        unitId: child,
        runId: `vr-${child}`,
        reportHash: `rh-${child}`,
        result: "pass",
        acceptanceIds: ["A1", "A2"],
      });
    }

    const events = ledger.readAll();
    const proj = fold(events);
    const ready = computeFrontier(proj, {
      specReviewFailCounts: specReviewFailCounts(events),
    });
    // ph-i1 R4：spec 提交后首审前插入反思步——rr 无 verdict 且无 ReflectionRan
    // → reflectionPending（不再直接 specReviewPending）
    expect(ready.reflectionPending).toContain("rr");
    expect(ready.specReviewPending).not.toContain("rr");
    // 补反思（锚 = specHash）后进入独立 reviewer 待审出口（mx-1：specReviewPending）
    ledger.append("ReflectionRan", {
      unitId: "rr",
      specHash: strongSpec("rr").specHash,
      round: 1,
    });
    const reflected = computeFrontier(fold(ledger.readAll()), {
      specReviewFailCounts: specReviewFailCounts(ledger.readAll()),
    });
    expect(reflected.reflectionPending).not.toContain("rr");
    expect(reflected.specReviewPending).toContain("rr");
    expect(ready.specFixPending).toContain("sf");
    expect(ready.specReviewDeadlock).toEqual([]); // 各 1 次 fail < 阈值（mx4 后默认 10）
    expect(ready.specReady).not.toContain("rr");
    expect(ready.integrationReady).toContain("ig-root");
    expect(ready.buildReady).not.toContain("ig-root");

    // 集成 fail 达上限（rv-4 语义迁移：MAX=1，首次 fail 即 drift；本断言 append
    // 两条 fail 后判定，在 MAX=1 与 MAX=2 下同为 drift——语义内核不变，上限值
    // 见 src/readonly/frontier.ts）→ integrationDrift 取代 integrationReady；
    // fails 计数由原始事件流重放（与 loop / frontier 命令同一口径）
    ledger.append("VerifyRan", { unitId: "ig-root", runId: "int-1", reportHash: "rh1", result: "fail", acceptanceIds: [] });
    ledger.append("VerifyRan", { unitId: "ig-root", runId: "int-2", reportHash: "rh2", result: "fail", acceptanceIds: [] });
    const drifted = computeFrontier(fold(ledger.readAll()), {
      consecutiveIntegrationFails: consecutiveIntegrationFails(ledger.readAll()),
    });
    expect(drifted.integrationDrift).toContain("ig-root");
    expect(drifted.integrationReady).not.toContain("ig-root");

    // mx-1 MF2：sf 的第二次 fail（重提 1 字节 spec 后再 fail——重提不清零计数）
    // → specReviewDeadlock 出现、specFixPending 消失（转人工维度取代推进维度）
    // （mx4 迁移：默认预算 10，注入 maxSpecRejects 2 快速构造 2 代触顶——语义
    // 回归保持「重提不清零、触顶转人工取代修复出口」）
    ledger.append("SpecSubmitted", strongSpec("sf"));
    ledger.append("VerdictSubmitted", { unitId: "sf", verdictKind: "spec-review", verdict: "fail", role: "reviewer", comment: "仍不合格" });
    const deadlocked = computeFrontier(fold(ledger.readAll()), {
      specReviewFailCounts: specReviewFailCounts(ledger.readAll()),
      maxSpecRejects: 2,
    });
    expect(deadlocked.specReviewDeadlock).toContain("sf");
    expect(deadlocked.specFixPending).not.toContain("sf");
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
