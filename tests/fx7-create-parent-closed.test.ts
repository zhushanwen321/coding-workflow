/**
 * fx-7 S-3 回归：`cw create --parent` 指向树感知 closed 的 unit 时拒绝建子。
 *
 * 「closed 不可逆」此前在 create 路径失守：closed 根下新建子 unit 直接成功，
 * deriveStatusInTree 立即把根从 closed 拉回 verified（「全部直接子节点 closed」
 * 不再成立）——历史结论被一条新事件篡改。修复后 create 校验父的树感知状态，
 * closed 父 exit 1 拒绝（与 evidence-submit spec 重提路径的 closed 拒绝同族）。
 *
 * 场景：
 *   1. closed 根下建子 → exit 1 + 可操作文案，账本不变，根状态保持 closed
 *   2. 非 closed 父（created / verified）正常路径不回归 → exit 0，子建成
 *
 * 真实环境：dispatch 完整路径 + 真实 EventLedger（锁与 fsync）+ tmp 目录，零 mock。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { SpecSubmittedPayload } from "../src/events/types.js";
import { loadLedger, treeStatuses } from "../src/readonly/load.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx7-create-parent-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;

beforeAll(() => {
  process.env.CW_HOME = cwHome;
});

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 过 spec gate 的合法 spec payload（e2e-real command 用 node，PATH 必可解析） */
function legalSpec(unitId: string, specHash: string): SpecSubmittedPayload {
  return {
    unitId,
    specHash,
    acceptance: [
      { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: "node -v" },
      { id: "A2", core: false, title: "单元行为正确", type: "unit" },
    ],
    contracts: [],
    split: [],
  };
}

/**
 * 直写构造走到 verified 的叶子根（spec 冻结 → verify 全覆盖 pass）。
 * 事件经 EventLedger API 入账（真实账本）；状态判定只依赖 fold 投影，与写入
 * 路径无关。再补一条 exec-review pass 即 closed。
 */
function seedVerifiedRoot(ledger: EventLedger, unitId: string): void {
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: `brief-${unitId}.md` });
  ledger.append("SpecSubmitted", legalSpec(unitId, "spec-hash-v1"));
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  ledger.append("VerifyRan", {
    unitId,
    runId: "run-1",
    reportHash: "rh-1",
    result: "pass",
    acceptanceIds: ["A1", "A2"],
  });
}

function seedClosedRoot(ledger: EventLedger, unitId: string): void {
  seedVerifiedRoot(ledger, unitId);
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass" });
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: readonly string[], cwd: string): Promise<Captured> {
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

function treeStatusOf(cwd: string, unitId: string): string {
  const status = treeStatuses(loadLedger(cwd).projection).get(unitId);
  if (status === undefined) {
    throw new Error(`fixture 破损：unit "${unitId}" 不在树感知状态集合中`);
  }
  return status;
}

describe("fx-7 S-3：--parent 指向 closed unit 拒绝建子（closed 不可逆 create 半边）", () => {
  it("场景1：closed 根下建子 → exit 1，文案含状态与恢复指引，账本不变，根保持 closed", async () => {
    const cwd = join(tmpRoot, "case-closed-parent");
    mkdirSync(cwd, { recursive: true });
    const briefAbs = join(cwd, "brief.md");
    writeFileSync(briefAbs, "# brief");
    const ledger = new EventLedger(ledgerPath(cwHome, cwd));
    seedClosedRoot(ledger, "root-a");
    expect(treeStatusOf(cwd, "root-a")).toBe("closed");
    const eventsBefore = ledger.readAll().length;

    const res = await run(["create", "--id", "child-x", "--brief", briefAbs, "--parent", "root-a"], cwd);
    expect(res.code).toBe(1);
    // 可操作文案：当前状态 + 不可逆原因 + 恢复动作（含命令模板）
    expect(res.stderr).toContain('"root-a" 已 closed');
    expect(res.stderr).toContain("不可逆");
    expect(res.stderr).toContain("恢复动作");
    expect(res.stderr).toContain("cw create");
    // 拒绝发生在 append 前：账本不变，closed 未被拉回
    expect(ledger.readAll()).toHaveLength(eventsBefore);
    expect(treeStatusOf(cwd, "root-a")).toBe("closed");
  });

  it("场景2a：created 根（仅 UnitCreated）下建子 → exit 0 不回归", async () => {
    const cwd = join(tmpRoot, "case-created-parent");
    mkdirSync(cwd, { recursive: true });
    const briefAbs = join(cwd, "brief.md");
    writeFileSync(briefAbs, "# brief");
    const ledger = new EventLedger(ledgerPath(cwHome, cwd));
    ledger.append("UnitCreated", { unitId: "root-b", parentId: null, briefRef: "brief-root-b.md" });

    const res = await run(["create", "--id", "child-b", "--brief", briefAbs, "--parent", "root-b"], cwd);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('unit "child-b" 已创建');
    expect(res.stdout).toContain('parent "root-b"');
    expect(treeStatusOf(cwd, "child-b")).toBe("created");
  });

  it("场景2b：verified 根（无 exec-review）下建子 → exit 0，verified 合法演进不拦", async () => {
    const cwd = join(tmpRoot, "case-verified-parent");
    mkdirSync(cwd, { recursive: true });
    const briefAbs = join(cwd, "brief.md");
    writeFileSync(briefAbs, "# brief");
    const ledger = new EventLedger(ledgerPath(cwHome, cwd));
    seedVerifiedRoot(ledger, "root-c");
    expect(treeStatusOf(cwd, "root-c")).toBe("verified");

    const res = await run(["create", "--id", "child-c", "--brief", briefAbs, "--parent", "root-c"], cwd);
    expect(res.code).toBe(0);
    // 建子只影响 closed 的树感知条件，verified 不变
    expect(treeStatusOf(cwd, "root-c")).toBe("verified");
    expect(treeStatusOf(cwd, "child-c")).toBe("created");
  });
});
