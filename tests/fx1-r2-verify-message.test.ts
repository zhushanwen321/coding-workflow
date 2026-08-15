/**
 * fx-1 R2.1 回归（docs/rewrite/acceptance/fx-1-acceptance.md R2.1）：
 * `cw verify` 失败时的恢复动作文案。
 *
 * 根因（final-gate-report.md §5 R2）：旧文案「修复后重新提交 spec + build 证据并
 * 重审，再 cw verify」诱导 builder 重提 spec → deriveStatus 判回 created（重提 =
 * 打回重审）→ 派发真空死区。新文案必须指向「仅重提 build 证据，spec 冻结不动」。
 *
 * 真实环境零 mock：真实 git 仓库 + 干净 checkout 重跑（dispatch 层完整路径）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx1-r2-msg-"));
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

function git(dir: string, args: readonly string[]): void {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
}

let cwd: string;
let ledger: EventLedger;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  cwd = join(tmpRoot, `repo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(cwd, { recursive: true });
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "cw-fx1@example.com"]);
  git(cwd, ["config", "user.name", "cw-fx1"]);
  writeFileSync(join(cwd, "seed.txt"), "seed\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "init"]);
  const head = (spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim();
  ledger = new EventLedger(ledgerPath(cwHome, cwd));
  // 真实前置：unit + 过 gate 的 spec（A1 真过 / A2 标记 FAIL 真挂）+ build 证据
  const acceptance: AcceptanceItem[] = [
    { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: `node -e "console.log('A1 PASS')"` },
    { id: "A2", core: true, title: "失败路径可观测", type: "e2e-real", command: `node -e "console.log('A2 FAIL'); process.exit(7)"` },
  ];
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", { unitId: "u-1", specHash: "0".repeat(64), acceptance, contracts: [], split: [] });
  ledger.append("EvidenceSubmitted", { unitId: "u-1", runId: "run-1", commit: head, paths: [], sha256: [], exitCode: 0 });
});

async function runVerify(): Promise<{ code: number; stdout: string; stderr: string }> {
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
    const code = await dispatch(["verify", "--unit", "u-1"], cwd);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe("fx-1 R2.1 verify 失败恢复文案：spec 冻结不动，仅重提 build 证据", () => {
  it("验收 fail（A2 标记 FAIL）→ exit 1，stderr 含新文案、不含旧误导语", async () => {
    const res = await runVerify();

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A2");
    // 新文案（验收文档锁定）：修复代码并 git commit → 仅重提 build 证据 → 再 verify
    expect(res.stderr).toContain("修复代码并 git commit 后");
    expect(res.stderr).toContain(
      "仅重新 cw evidence submit --kind build --unit u-1 --commit <hash> --run-id <新id> 再 cw verify",
    );
    expect(res.stderr).toContain("spec 冻结不动（改验收走重新 spec 是另一路径，需重新过审）");
    // 旧误导语必须清除：它正是终验中 builder 落入派发真空死区的指令来源
    expect(res.stderr).not.toContain("重新提交 spec + build 证据");
  });
});
