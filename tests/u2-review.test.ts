/**
 * u2 单测：cw review submit（dispatch 层完整路径，真实账本 + tmp 目录，零 mock）。
 *
 * 用例编号「验收N」逐条对应 docs/rewrite/acceptance/u2-acceptance.md「单测验收」：
 * 本文件覆盖第 4 条（review 全部行为）。
 * 前置 evidence 用真实 EventLedger 直接入账种子事件（review 语义只关心
 * runId 已存在，git/build 链路已在 u2-evidence.test.ts 覆盖，不重复搭 git 仓库）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u2-review-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

let caseNo = 0;
let cwd: string;
let ledger: EventLedger;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
  mkdirSync(cwd, { recursive: true });
  ledger = new EventLedger(ledgerPath(cwHome, cwd));
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: readonly string[]): Promise<Captured> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof origOut;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof origErr;
  try {
    const code = await dispatch(args, cwd);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** 创建 unit + 种子 evidence runId（真实账本直写，模拟已完成的 build 提交） */
function seedUnitWithEvidence(unitId: string, runIds: readonly string[]): void {
  const brief = join(cwd, "brief.md");
  writeFileSync(brief, "# 任务书\n");
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: brief });
  for (const runId of runIds) {
    ledger.append("EvidenceSubmitted", {
      unitId,
      runId,
      commit: "c0ffee",
      paths: [],
      sha256: [],
      exitCode: 0,
    });
  }
}

// ── 验收4：cw review submit ──────────────────────────────────

describe("验收4：cw review submit（dispatch 层）", () => {
  it("verdict-kind 枚举外 → exit 1，stderr 列出合法值 spec-review | exec-review", async () => {
    seedUnitWithEvidence("u-1", []);
    const res = await run([
      "review",
      "submit",
      "--unit",
      "u-1",
      "--verdict-kind",
      "design-review",
      "--verdict",
      "pass",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("design-review");
    expect(res.stderr).toContain("spec-review | exec-review");
    expect(ledger.readAll()).toHaveLength(1);
  });

  it("verdict 枚举外 → exit 1，stderr 列出合法值 pass | fail", async () => {
    seedUnitWithEvidence("u-1", []);
    const res = await run([
      "review",
      "submit",
      "--unit",
      "u-1",
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "maybe",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("maybe");
    expect(res.stderr).toContain("pass | fail");
    expect(ledger.readAll()).toHaveLength(1);
  });

  it("evidence-refs 引用不存在的 runId → exit 1，stderr 列出缺失项", async () => {
    seedUnitWithEvidence("u-1", ["run-1"]);
    const res = await run([
      "review",
      "submit",
      "--unit",
      "u-1",
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "pass",
      "--evidence-refs",
      "run-x,run-1,run-y",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("run-x");
    expect(res.stderr).toContain("run-y");
    expect(res.stderr).toContain("恢复动作");
    expect(ledger.readAll()).toHaveLength(2);
  });

  it("合法（spec-review + comment + evidence-refs）→ VerdictSubmitted 入账", async () => {
    seedUnitWithEvidence("u-1", ["run-1", "run-2"]);
    const res = await run([
      "review",
      "submit",
      "--unit",
      "u-1",
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "pass",
      "--comment",
      "验收可冻结",
      "--evidence-refs",
      "run-1,run-2",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("u-1");

    const events = ledger.readAll();
    expect(events).toHaveLength(4);
    expect(events[3]?.type).toBe("VerdictSubmitted");
    expect(events[3]?.payload).toEqual({
      unitId: "u-1",
      verdictKind: "spec-review",
      verdict: "pass",
      comment: "验收可冻结",
      evidenceRefs: ["run-1", "run-2"],
    });
  });

  it("合法（spec-review、无可选字段）→ payload 不含 comment/evidenceRefs 键", async () => {
    // rv-2 适配：exec-review 的 --evidence-refs 已改必填（rv2-engine-fixes.test.ts
    // T3 锁定），「无可选字段」的最小合法形态只剩 spec-review；本用例锁定的
    // payload 键省略行为与 verdict-kind 无关，载体换 spec-review 语义不变
    seedUnitWithEvidence("u-1", []);
    const res = await run([
      "review",
      "submit",
      "--unit",
      "u-1",
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "fail",
    ]);
    expect(res.code).toBe(0);

    const events = ledger.readAll();
    expect(events[1]?.type).toBe("VerdictSubmitted");
    expect(events[1]?.payload).toEqual({
      unitId: "u-1",
      verdictKind: "spec-review",
      verdict: "fail",
    });
  });

  it("unit 不存在 → exit 1，错误含恢复动作", async () => {
    const res = await run([
      "review",
      "submit",
      "--unit",
      "no-such",
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "pass",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no-such");
    expect(res.stderr).toContain("恢复动作");
    expect(ledger.readAll()).toHaveLength(0);
  });
});
