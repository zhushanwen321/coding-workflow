/**
 * 回归：closed 不可逆 + 零新证据不可恢复 closed（对抗审查波次 2 缺陷 2 的三段
 * 场景固化，审查探针实测过两个洞：①完整链 closed 后重提 spec 状态退回 created；
 * ②仅追加一条 spec-review pass、不重跑 verify 即直达 closed）。
 *
 * 修复后的三段防线：
 *   段1 命令面：closed unit 的 spec 重提被拒（exit 1，错误指向新建 unit / replan）
 *   段2 fold 时序：绕过命令面手改账本插入新 SpecSubmitted → 投影回 created
 *        （旧 VerifyRan / 旧 exec-review 因 seq 更小全部失效）
 *   段3 fold 时序：再追加 spec-review pass（无新 verify）→ 只到 spec-frozen，
 *        旧 pass VerifyRan 不复用，不可能零新证据直达 verified/closed
 *
 * 真实环境：dispatch 完整路径 + 真实 CwStore（EventLedger）+ tmp 目录，零 mock。
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

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-closed-irreversible-"));
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

/** 过 u3 五规则的合法 spec payload（e2e-real command 用 node，PATH 必可解析） */
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
 * 直写构造一个「完整链 closed」的叶子 unit（u-1）。
 * 事件经 EventLedger API 入账（真实账本，含锁与 fsync）；closed 判定只依赖 fold
 * 投影，与写入路径无关——dispatch 写入和直写折叠结果一致（fold 是纯函数）。
 */
function seedClosedUnit(ledger: EventLedger): void {
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief-u1.md" });
  ledger.append("SpecSubmitted", legalSpec("u-1", "spec-hash-v1"));
  ledger.append("VerdictSubmitted", { unitId: "u-1", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  ledger.append("VerifyRan", {
    unitId: "u-1",
    runId: "run-1",
    reportHash: "rh-1",
    result: "pass",
    acceptanceIds: ["A1", "A2"],
  });
  ledger.append("VerdictSubmitted", { unitId: "u-1", verdictKind: "exec-review", verdict: "pass" });
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

describe("closed 不可逆三段场景（命令面拒绝 + fold 时序收紧）", () => {
  it("前置自证：seed 后 u-1 树感知状态为 closed（叶子，无子条件）", () => {
    const cwd = join(tmpRoot, "case-precondition");
    mkdirSync(cwd, { recursive: true });
    const ledger = new EventLedger(ledgerPath(cwHome, cwd));
    seedClosedUnit(ledger);
    expect(treeStatusOf(cwd, "u-1")).toBe("closed");
  });

  it("段1：closed 后经命令面重提 spec → exit 1，stderr 指向新建 unit / replan，账本不变", async () => {
    const cwd = join(tmpRoot, "case-segment1");
    mkdirSync(cwd, { recursive: true });
    const ledger = new EventLedger(ledgerPath(cwHome, cwd));
    seedClosedUnit(ledger);
    const eventsBefore = ledger.readAll().length;

    const specPath = join(cwd, "spec-v2.json");
    writeFileSync(specPath, JSON.stringify({
      acceptance: [
        { id: "A1", core: true, title: "改后的核心链路", type: "e2e-real", command: "node -v" },
        { id: "A2", core: false, title: "单元行为正确", type: "unit" },
      ],
      contracts: [],
      split: [],
    }));

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "u-1", "--file", specPath], cwd);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("已 closed");
    expect(res.stderr).toContain("不可逆");
    expect(res.stderr).toContain("cw create");
    expect(res.stderr).toContain("恢复动作");
    // 账本不变：拒绝发生在 append 前
    expect(ledger.readAll()).toHaveLength(eventsBefore);
    expect(treeStatusOf(cwd, "u-1")).toBe("closed");
  });

  it("段2：绕过命令面直接 append 新 SpecSubmitted（模拟手改账本）→ 投影回 created 而非 closed", () => {
    const cwd = join(tmpRoot, "case-segment2");
    mkdirSync(cwd, { recursive: true });
    const ledger = new EventLedger(ledgerPath(cwHome, cwd));
    seedClosedUnit(ledger);
    expect(treeStatusOf(cwd, "u-1")).toBe("closed");

    // 手改账本：新 spec 的 seq 更大，旧 VerifyRan / 旧 exec-review 全部因 seq
    // 更小失效——「closed 不可逆」的 fold 半边：插入新 spec 不可能保持 closed，
    // 更不可能零新证据直达 closed
    ledger.append("SpecSubmitted", legalSpec("u-1", "spec-hash-v2"));
    expect(treeStatusOf(cwd, "u-1")).toBe("created");
  });

  it("段3：再追加 spec-review pass（无新 verify）→ 停 spec-frozen，旧 pass VerifyRan 不复用", () => {
    const cwd = join(tmpRoot, "case-segment3");
    mkdirSync(cwd, { recursive: true });
    const ledger = new EventLedger(ledgerPath(cwHome, cwd));
    seedClosedUnit(ledger);
    ledger.append("SpecSubmitted", legalSpec("u-1", "spec-hash-v2"));
    expect(treeStatusOf(cwd, "u-1")).toBe("created");

    // 只补审不重验：spec-frozen 可达（新 pass verdict 晚于新 spec），但 verified
    // 需要晚于新 spec 的 pass VerifyRan——旧 run（seq 更小）不计数
    ledger.append("VerdictSubmitted", { unitId: "u-1", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
    expect(treeStatusOf(cwd, "u-1")).toBe("spec-frozen");
    expect(treeStatusOf(cwd, "u-1")).not.toBe("verified");
    expect(treeStatusOf(cwd, "u-1")).not.toBe("closed");
  });
});
