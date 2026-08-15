/**
 * u4a 单测：cleanCheckout / runAcceptances / cw verify exit 语义
 * （dispatch 层完整路径，真实 git 子进程 + tmp 目录 + 隔离 CW_HOME，零 mock）。
 *
 * 用例编号「验收N」逐条对应 docs/rewrite/acceptance/u4a-acceptance.md「单测验收」：
 *   验收1/2 → cleanCheckout；验收3/4 → runAcceptances；验收5 → verify handler。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";
import { cleanCheckout, cleanupCheckout } from "../src/verify/checkout.js";
import { runAcceptances } from "../src/verify/run.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u4a-"));
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

/** 真实 tmp git 仓库：init + 每次提交写入一批根目录文件；返回各 commit hash（按提交序） */
function makeGitRepo(dir: string, commitsFiles: ReadonlyArray<Record<string, string>>): string[] {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "cw-test@example.com"]);
  git(dir, ["config", "user.name", "cw-test"]);
  const hashes: string[] = [];
  commitsFiles.forEach((files, i) => {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", `commit-${i + 1}`]);
    hashes.push(
      (spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim(),
    );
  });
  return hashes;
}

function ac(id: string, command: string | undefined, type: AcceptanceItem["type"] = "unit"): AcceptanceItem {
  return { id, core: false, title: `标题-${id}`, type, ...(command === undefined ? {} : { command }) };
}

// ── 验收1/2：cleanCheckout ───────────────────────────────────

describe("验收1：cleanCheckout 检出指定 commit", () => {
  it("检出第 1 个 commit → 目录内容与该 commit 一致（第 2 个 commit 的文件不存在）；porcelain 为空", () => {
    const repo = join(tmpRoot, "co-repo-1");
    const [c1] = makeGitRepo(repo, [{ "a.txt": "v1" }, { "b.txt": "v2" }]);
    expect(c1).toMatch(/^[0-9a-f]{40}$/);

    const out = cleanCheckout(repo, c1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    try {
      expect(existsSync(join(out.dir, "a.txt"))).toBe(true);
      expect(readFileSync(join(out.dir, "a.txt"), "utf-8")).toBe("v1");
      expect(existsSync(join(out.dir, "b.txt"))).toBe(false);
      const porcelain = spawnSync("git", ["-C", out.dir, "status", "--porcelain"], {
        encoding: "utf-8",
      });
      expect(porcelain.status).toBe(0);
      expect(porcelain.stdout.trim()).toBe("");
    } finally {
      cleanupCheckout(out.dir);
    }
  });
});

describe("验收2：cleanCheckout 对不存在 commit 返回 error", () => {
  it("不存在的 commit → { ok:false, error }（不抛裸异常）", () => {
    const repo = join(tmpRoot, "co-repo-2");
    makeGitRepo(repo, [{ "a.txt": "v1" }]);
    const out = cleanCheckout(repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("deadbeef");
  });
});

// ── 验收3/4：runAcceptances ──────────────────────────────────

describe("验收3：runAcceptances 三态判定与产物落盘", () => {
  it("真过 / 真挂 / sleep 超时（500ms 上限）→ pass/fail/timeout 判定正确、产物存在且非空", () => {
    const checkoutDir = mkdtempSync(join(tmpRoot, "co-3"));
    const evidenceBase = mkdtempSync(join(tmpRoot, "ev-3"));
    const outcome = runAcceptances(
      checkoutDir,
      [ac("A1", "echo pass-out"), ac("A2", "echo boom >&2; exit 3"), ac("A3", "sleep 2")],
      evidenceBase,
      500,
    );

    // 判定：pass / fail(exit 3) / fail(timeout)
    const [r1, r2, r3] = outcome.results;
    expect(r1?.status).toBe("pass");
    expect(r1?.timeout).toBe(false);
    expect(r2?.status).toBe("fail");
    expect(r2?.reason).toContain("exit 3");
    expect(r3?.status).toBe("fail");
    expect(r3?.timeout).toBe(true);
    expect(r3?.reason).toContain("超时");

    // 产物：stdout 非空 / 挂的 stderr 有内容 / 超时有 .timeout 标记
    expect(readFileSync(r1?.stdoutPath ?? "", "utf-8")).toContain("pass-out");
    expect(readFileSync(r2?.stderrPath ?? "", "utf-8")).toContain("boom");
    const timeoutMarker = join(evidenceBase, "A3.timeout");
    expect(existsSync(timeoutMarker)).toBe(true);
    expect(readFileSync(timeoutMarker, "utf-8")).toContain("timed out");
    expect(readFileSync(r3?.stderrPath ?? "", "utf-8")).toContain("timed out");

    // 总报告：cases 三条 + exitCode 1，manual 不在此例（由 handler 并入 acceptanceIds）
    expect(outcome.report.exitCode).toBe(1);
    expect(outcome.report.cases.map((c) => [c.id, c.status])).toEqual([
      ["A1", "pass"],
      ["A2", "fail"],
      ["A3", "fail"],
    ]);
    const onDisk = JSON.parse(readFileSync(join(evidenceBase, "report.json"), "utf-8")) as {
      cases: Array<{ id: string; status: string }>;
    };
    expect(onDisk.cases).toHaveLength(3);
  });
});

describe("验收4：非 manual 无 command → 该条 fail", () => {
  it("unit 用例缺 command → fail + 错误信息含「验收 X9 缺 command」", () => {
    const checkoutDir = mkdtempSync(join(tmpRoot, "co-4"));
    const evidenceBase = mkdtempSync(join(tmpRoot, "ev-4"));
    const outcome = runAcceptances(checkoutDir, [ac("X9", undefined)], evidenceBase, 1000);

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.status).toBe("fail");
    expect(outcome.results[0]?.reason).toContain("验收 X9 缺 command");
    expect(readFileSync(outcome.results[0]?.stderrPath ?? "", "utf-8")).toContain("验收 X9 缺 command");
  });
});

// ── 验收5：cw verify exit 语义（dispatch 层） ─────────────────

let caseNo = 0;
let cwd: string;
let ledger: EventLedger;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
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

/** 建 git 仓库 + 入账 UnitCreated / SpecSubmitted(可选) / EvidenceSubmitted(可选) */
function makeVerifyFixture(opts: {
  withSpec: boolean;
  withEvidence: boolean;
  acceptance?: AcceptanceItem[];
}): string {
  const [head] = makeGitRepo(cwd, [{ "seed.txt": "seed" }]);
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
  if (opts.withSpec) {
    ledger.append("SpecSubmitted", {
      unitId: "u-1",
      specHash: "0".repeat(64),
      acceptance: opts.acceptance ?? [],
      contracts: [],
      split: [],
    });
  }
  if (opts.withEvidence) {
    ledger.append("EvidenceSubmitted", {
      unitId: "u-1",
      runId: "run-1",
      commit: head,
      paths: [],
      sha256: [],
      exitCode: 0,
    });
  }
  return head;
}

interface VerifyRanFact {
  runId: string;
  reportHash: string;
  result: string;
  acceptanceIds: string[];
}

function verifyRans(): VerifyRanFact[] {
  return ledger
    .readAll()
    .filter((e) => e.type === "VerifyRan")
    .map((e) => {
      const p = e.payload as VerifyRanFact;
      return { runId: p.runId, reportHash: p.reportHash, result: p.result, acceptanceIds: p.acceptanceIds };
    });
}

describe("验收5：cw verify exit 语义（dispatch 层）", () => {
  it("全过 → exit 0 + stdout 逐行摘要 + VerifyRan(result=pass)；reportHash 与落盘 report.json 一致", async () => {
    makeVerifyFixture({
      withSpec: true,
      withEvidence: true,
      acceptance: [{ ...ac("A1", 'node -e "process.exit(0)"', "e2e-real"), core: true }],
    });

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("A1 pass");
    expect(res.stdout).toContain("result=pass");

    const runs = verifyRans();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("pass");
    expect(runs[0]?.acceptanceIds).toEqual(["A1"]);
    expect(runs[0]?.runId).toMatch(/^verify-/);

    // reportHash 独立重算（node:crypto，不经被测代码的 sha256Hex）
    const reportPath = join(evidenceDir(cwHome, cwd, "u-1", runs[0]?.runId ?? ""), "report.json");
    const digest = createHash("sha256").update(readFileSync(reportPath)).digest("hex");
    expect(runs[0]?.reportHash).toBe(digest);
  });

  it("有 fail → exit 1 + stderr 列失败 id 与原因；fail 也入账，acceptanceIds 含 pass 与 manual、不含 fail", async () => {
    makeVerifyFixture({
      withSpec: true,
      withEvidence: true,
      acceptance: [
        { ...ac("A1", 'node -e "process.exit(0)"', "e2e-real"), core: true },
        { ...ac("A2", 'node -e "process.exit(7)"', "e2e-real"), core: true },
        ac("M1", undefined, "manual"),
      ],
    });

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("exit 7");
    expect(res.stdout).toContain("M1 manual");

    const runs = verifyRans();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("fail");
    expect(runs[0]?.acceptanceIds).toEqual(["A1", "M1"]);
  });

  it("缺 spec → exit 2（环境错误），无 VerifyRan 入账", async () => {
    makeVerifyFixture({ withSpec: false, withEvidence: true });
    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("spec");
    expect(verifyRans()).toHaveLength(0);
  });

  it("缺 build 证据 → exit 2（环境错误），无 VerifyRan 入账", async () => {
    makeVerifyFixture({ withSpec: true, withEvidence: false, acceptance: [ac("A1", "true")] });
    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("build");
    expect(verifyRans()).toHaveLength(0);
  });

  it("unit 不存在 → exit 2；缺 --unit → exit 1（用法错误）", async () => {
    const noUnit = await run(["verify", "--unit", "ghost"]);
    expect(noUnit.code).toBe(2);
    expect(noUnit.stderr).toContain("ghost");

    const noArg = await run(["verify"]);
    expect(noArg.code).toBe(1);
    expect(noArg.stderr).toContain("--unit");
  });

  it("--timeout-ms 500（minimist 解析为 number，非 string）+ sleep 2 验收 → 该条超时 fail + .timeout 标记落盘", async () => {
    makeVerifyFixture({
      withSpec: true,
      withEvidence: true,
      acceptance: [{ ...ac("T1", "sleep 2", "e2e-real"), core: true }],
    });

    const res = await run(["verify", "--unit", "u-1", "--timeout-ms", "500"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("T1");
    expect(res.stderr).toContain("超时");

    const runs = verifyRans();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("fail");
    expect(existsSync(join(evidenceDir(cwHome, cwd, "u-1", runs[0]?.runId ?? ""), "T1.timeout"))).toBe(true);
  });

  it("非法 --timeout-ms（abc / 0）→ exit 1 用法错误，stderr 含合法形式与恢复动作，不入账", async () => {
    makeVerifyFixture({ withSpec: true, withEvidence: true, acceptance: [ac("A1", "true")] });

    const bad = await run(["verify", "--unit", "u-1", "--timeout-ms", "abc"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--timeout-ms");
    expect(bad.stderr).toContain("恢复动作");
    expect(verifyRans()).toHaveLength(0);

    const zero = await run(["verify", "--unit", "u-1", "--timeout-ms", "0"]);
    expect(zero.code).toBe(1);
    expect(zero.stderr).toContain("--timeout-ms");
    expect(verifyRans()).toHaveLength(0);
  });
});
