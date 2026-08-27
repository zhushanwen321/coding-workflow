/**
 * fb-3 单测（fb 波次，设计 .tmp/design-fail-attribution.md §3.1 场景 5 / D10，
 * 验收 V12）：人工处置体验两件套——
 *   ① 五类停派 escalation 文案（TIMEOUT 封顶 / specReviewDeadlock / flakeReview
 *      / specContractDeadlock / buildDrift）+ TIMEOUT 出口汇总统一附人工闭环句；
 *   ② renderStatusDetail 的 specs 列表对当前生效版（末项 = 最后一条
 *      SpecSubmitted 的 specHash）标 ← active，其余行不标。
 *
 * 分层：escalationMessage / escalationExitMessage 是导出纯函数直接调用断言；
 * 其余四类文案函数不导出（fx-6 归属边界：loop 消费），经 announceManualEscalations
 * （真实事件账本直写触发投影事实，与 u1b 同款 EventLedger 直写基建）+ stderr
 * 捕获断言——零 mock。特征词断言按验收基线钉死五词；escalation 文案为多行拼接
 * 串，闭环句自身单行无内部换行，子串断言即可命中（跨行容忍指各句在整段文案中
 * 的位置无关性，不放宽词内空白）。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fold } from "../src/core/fold.js";
import type { AcceptanceItem, SpecSubmittedPayload } from "../src/events/types.js";
import { treeStatuses } from "../src/readonly/load.js";
import { renderStatusDetail } from "../src/readonly/status.js";
import {
  announceManualEscalations,
  escalationExitMessage,
  escalationMessage,
} from "../src/runner/escalations.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

// ---- fixture 基建（EventLedger 直写，零 mock） ----

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fb3-ux-"));
const cwHome = join(tmpRoot, "home");

beforeAll(() => {
  process.env.CW_HOME = cwHome;
});

afterAll(() => {
  delete process.env.CW_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 独立项目目录（per-cwd 账本隔离），返回直写用 ledger */
function makeProject(name: string): EventLedger {
  const cwd = join(tmpRoot, name);
  mkdirSync(cwd, { recursive: true });
  return new EventLedger(ledgerPath(cwHome, cwd));
}

/** e2e 条目在列的 acceptance（flakeReviewFacts 只对 e2e 级条目计数） */
const E2E_ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "A1 核心链路", type: "e2e-real", command: "node -v" },
  { id: "A2", core: false, title: "A2 单元级", type: "unit" },
];

function specOf(unitId: string, specHash: string): SpecSubmittedPayload {
  return { unitId, specHash, acceptance: [...E2E_ACCEPTANCE], contracts: [], split: [] };
}

/** announceManualEscalations 的最小调用参数（五维 dedup 全空 Map 首次出声） */
function announceCaptured(
  ledger: EventLedger,
  unitIds: readonly string[],
  opts: {
    maxSpecRejects?: number;
    driftFacts?: ReadonlyMap<string, { buildCount: number; specEpoch: number }>;
  } = {},
): string {
  const chunks: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: unknown, cb?: (err?: Error | null) => void) => {
    chunks.push(String(chunk));
    if (typeof cb === "function") {
      cb();
    }
    return true;
  }) as typeof process.stderr.write;
  try {
    announceManualEscalations(
      "fb3-root",
      ledger.readAll(),
      new Set(unitIds),
      {
        maxSpecRejects: opts.maxSpecRejects ?? 10,
        driftFacts: opts.driftFacts ?? new Map(),
        maxBuildAttempts: 5,
        artifactDir: join(tmpRoot, "art"),
      },
      {
        flake: new Map(),
        contract: new Map(),
        spec: new Map(),
        specProgress: new Map(),
        buildDrift: new Map(),
      },
    );
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

// ---- ① 五类 escalation 文案 + 出口汇总统一附人工闭环句 ----

describe("fb-3 ① 五类停派文案 + TIMEOUT 出口统一附人工闭环句（V12 文案半）", () => {
  /** 特征词五连断言（任务书钉死；全部为闭环句内单行子串） */
  function expectClosingLoop(out: string): void {
    expect(out).toContain("人工闭环顺序：重提 spec → 独立 spec-review → build 证据 → cw verify → exec-review");
    expect(out).toContain("处置入账后运行中的 cw run 下轮自愈，已退出则重跑 cw run 续接。");
    // 五特征词逐词命中（「人工闭环顺序」「重提 spec」「cw verify」「下轮自愈」「重跑 cw run 续接」）
    for (const marker of ["人工闭环顺序", "重提 spec", "cw verify", "下轮自愈", "重跑 cw run 续接"]) {
      expect(out).toContain(marker);
    }
  }

  it("TIMEOUT 封顶：escalationMessage 逐 unit 指引附闭环句", () => {
    const out = escalationMessage(
      "fb3-root",
      "fb3-timeout",
      "developer",
      join(tmpRoot, "art"),
      30 * 60_000,
    );
    expect(out).toContain("连续 2 次 spawn TIMEOUT");
    expectClosingLoop(out);
  });

  it("TIMEOUT 封顶：escalationExitMessage 退出汇总附闭环句", () => {
    const out = escalationExitMessage("fb3-root", new Map([["fb3-timeout", "developer"]]));
    expect(out).toContain("转人工 unit 共 1 个");
    expectClosingLoop(out);
  });

  it("flakeReview：e2e 连挂停派文案附闭环句（真实账本触发投影事实）", () => {
    const ledger = makeProject("p-flake");
    ledger.append("UnitCreated", { unitId: "u-flake", parentId: null, briefRef: "b.md" });
    ledger.append("SpecSubmitted", specOf("u-flake", "flake-s-1"));
    // A1 两次不在 pass 集（非 integrate runId）→ e2e 连挂 2 → flakeReview 命中
    ledger.append("VerifyRan", {
      unitId: "u-flake", runId: "vr-flake-1", reportHash: "rh-f1", result: "fail", acceptanceIds: [],
    });
    ledger.append("VerifyRan", {
      unitId: "u-flake", runId: "vr-flake-2", reportHash: "rh-f2", result: "fail", acceptanceIds: [],
    });
    const err = announceCaptured(ledger, ["u-flake"]);
    expect(err).toContain("e2e 验收连挂 2 次以上（flake 疑似）");
    expectClosingLoop(err);
  });

  it("specContractDeadlock：两代回炉活锁停派文案附闭环句（真实账本触发投影事实）", () => {
    const ledger = makeProject("p-contract");
    ledger.append("UnitCreated", { unitId: "u-contract", parentId: null, briefRef: "b.md" });
    // 三周期各 2 连挂：周期 1 连挂 → 重提（gen=1）→ 连挂 → 重提（gen=2）→ 连挂
    // → streaks=2 ∧ generations≥2 → deadlock 出声（max=2 语义见 SPEC_CONTRACT_MAX_GENERATIONS）
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      ledger.append("SpecSubmitted", specOf("u-contract", `contract-s-${cycle}`));
      for (let n = 1; n <= 2; n += 1) {
        ledger.append("VerifyRan", {
          unitId: "u-contract",
          runId: `vr-contract-${cycle}-${n}`,
          reportHash: `rh-c-${cycle}-${n}`,
          result: "fail",
          acceptanceIds: [],
          parseFailedAcceptanceIds: ["A1"],
        });
      }
    }
    const err = announceCaptured(ledger, ["u-contract"]);
    expect(err).toContain("解析失败已 2 代回炉仍连挂");
    expectClosingLoop(err);
  });

  it("specReviewDeadlock：打回活锁停派文案附闭环句（真实账本触发投影事实）", () => {
    const ledger = makeProject("p-spec");
    ledger.append("UnitCreated", { unitId: "u-spec", parentId: null, briefRef: "b.md" });
    ledger.append("SpecSubmitted", specOf("u-spec", "spec-s-1"));
    ledger.append("VerdictSubmitted", {
      unitId: "u-spec",
      verdictKind: "spec-review",
      verdict: "fail",
      role: "reviewer",
      comment: "验收范围不足",
    });
    // 预算注入 1：1 代打回即达预算 → 停派文案（绕开 10 代默认只为最小化 fixture）
    const err = announceCaptured(ledger, ["u-spec"], { maxSpecRejects: 1 });
    expect(err).toContain("判定 designer-reviewer 打回循环活锁");
    expectClosingLoop(err);
  });

  it("buildDrift：缓慢进展停派文案附闭环句（driftFacts 由 loop 算好传入）", () => {
    const ledger = makeProject("p-drift");
    ledger.append("UnitCreated", { unitId: "u-drift", parentId: null, briefRef: "b.md" });
    const err = announceCaptured(ledger, ["u-drift"], {
      driftFacts: new Map([["u-drift", { buildCount: 5, specEpoch: 1 }]]),
    });
    expect(err).toContain("build 证据已达 5 次");
    expectClosingLoop(err);
  });

  it("六处文案闭环句逐字一致（单一常量拼接，无复制粘贴漂移）：全文恰含 1 句、句式完整", () => {
    const outs: string[] = [
      escalationMessage("fb3-root", "u-x", "developer", join(tmpRoot, "art"), 30 * 60_000),
      escalationExitMessage("fb3-root", new Map([["u-x", "developer"]])),
    ];
    // flake
    const ledgerFlake = makeProject("p-all5-flake");
    ledgerFlake.append("UnitCreated", { unitId: "u-all5f", parentId: null, briefRef: "b.md" });
    ledgerFlake.append("SpecSubmitted", specOf("u-all5f", "all5f-s-1"));
    ledgerFlake.append("VerifyRan", {
      unitId: "u-all5f", runId: "vr-all5f-1", reportHash: "rh-f1", result: "fail", acceptanceIds: [],
    });
    ledgerFlake.append("VerifyRan", {
      unitId: "u-all5f", runId: "vr-all5f-2", reportHash: "rh-f2", result: "fail", acceptanceIds: [],
    });
    outs.push(announceCaptured(ledgerFlake, ["u-all5f"]));
    // specContractDeadlock
    const ledgerContract = makeProject("p-all5-contract");
    ledgerContract.append("UnitCreated", { unitId: "u-all5c", parentId: null, briefRef: "b.md" });
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      ledgerContract.append("SpecSubmitted", specOf("u-all5c", `all5c-s-${cycle}`));
      for (let n = 1; n <= 2; n += 1) {
        ledgerContract.append("VerifyRan", {
          unitId: "u-all5c",
          runId: `vr-all5c-${cycle}-${n}`,
          reportHash: `rh-c-${cycle}-${n}`,
          result: "fail",
          acceptanceIds: [],
          parseFailedAcceptanceIds: ["A1"],
        });
      }
    }
    outs.push(announceCaptured(ledgerContract, ["u-all5c"]));
    // specReviewDeadlock
    const ledgerSpec = makeProject("p-all5-spec");
    ledgerSpec.append("UnitCreated", { unitId: "u-all5s", parentId: null, briefRef: "b.md" });
    ledgerSpec.append("SpecSubmitted", specOf("u-all5s", "all5s-s-1"));
    ledgerSpec.append("VerdictSubmitted", {
      unitId: "u-all5s", verdictKind: "spec-review", verdict: "fail", role: "reviewer", comment: "弱",
    });
    outs.push(announceCaptured(ledgerSpec, ["u-all5s"], { maxSpecRejects: 1 }));
    // buildDrift
    const ledgerDrift = makeProject("p-all5-drift");
    ledgerDrift.append("UnitCreated", { unitId: "u-all5d", parentId: null, briefRef: "b.md" });
    outs.push(
      announceCaptured(ledgerDrift, ["u-all5d"], {
        driftFacts: new Map([["u-all5d", { buildCount: 5, specEpoch: 1 }]]),
      }),
    );
    const sentence = "人工闭环顺序：重提 spec → 独立 spec-review → build 证据 → cw verify → exec-review；" +
      "处置入账后运行中的 cw run 下轮自愈，已退出则重跑 cw run 续接。";
    expect(outs).toHaveLength(6); // 五类停派 + TIMEOUT 出口汇总
    for (const out of outs) {
      expect(out.split(sentence).length - 1).toBe(1); // 恰一次、整句一字不差
    }
  });
});

// ---- ② status 详情视图 specs 列表 active 标注 ----

describe("fb-3 ② status specs 列表对生效版标 ← active（V12 标注半）", () => {
  /** 直写 N 条 SpecSubmitted 后渲染详情视图 */
  function renderDetail(project: string, unitId: string, specHashes: readonly string[]): string {
    const ledger = makeProject(project);
    ledger.append("UnitCreated", { unitId, parentId: null, briefRef: `b-${unitId}.md` });
    for (const hash of specHashes) {
      ledger.append("SpecSubmitted", specOf(unitId, hash));
    }
    const proj = fold(ledger.readAll());
    const unit = proj.units.get(unitId);
    const status = treeStatuses(proj).get(unitId);
    if (unit === undefined || status === undefined) {
      throw new Error(`fixture 破损：unit "${unitId}" 不在投影中`);
    }
    return renderStatusDetail(unit, status);
  }

  it("3 条 specs：恰末行（最后一条 SpecSubmitted）带 ← active，前两行不带", () => {
    const out = renderDetail("p-multi", "u-multi", [
      "fb3-first-spec-hash",
      "fb3-second-spec-hash",
      "fb3-third-spec-hash",
    ]);
    const specLines = out
      .split("\n")
      .filter((line) => line.startsWith("  - ") && line.includes("acceptance="));
    expect(specLines).toHaveLength(3);
    expect(specLines[0]).toContain("fb3-first-sp");
    expect(specLines[0]).not.toContain("← active");
    expect(specLines[1]).toContain("fb3-second-s");
    expect(specLines[1]).not.toContain("← active");
    expect(specLines[2]).toContain("fb3-third-s");
    expect(specLines[2]).toMatch(/← active$/);
    // 全文恰一处标注（防 verdicts/evidences 段误染）
    expect(out.split("← active").length - 1).toBe(1);
  });

  it("单条 spec：该行即 active（末项 = 唯一一条 SpecSubmitted）", () => {
    const out = renderDetail("p-single", "u-single", ["fb3-only-spec-hash-0000000000000"]);
    const specLines = out
      .split("\n")
      .filter((line) => line.startsWith("  - ") && line.includes("acceptance="));
    expect(specLines).toHaveLength(1);
    expect(specLines[0]).toContain("fb3-only-spe");
    expect(specLines[0]).toMatch(/← active$/);
    expect(out.split("← active").length - 1).toBe(1);
  });

  it("0 条 spec：specs 段渲染 (无)，不崩、零标注", () => {
    const out = renderDetail("p-empty", "u-empty", []);
    expect(out).toContain("specs:\n  (无)");
    expect(out).not.toContain("← active");
  });
});
