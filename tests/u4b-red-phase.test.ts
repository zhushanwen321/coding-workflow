/**
 * u4b 单测：红阶段 gate（u4b 验收文档「单测验收」5/6，dispatch 层完整路径，
 * 真实 git 子进程 + tmp 目录 + 隔离 CW_HOME，零 mock）。
 *
 *   - 验收5a 两 commit（c1 无测试脚本、c2 有脚本 + 验收命令）→ --red-phase 在
 *     c1 树上命令必挂（文件缺失）→ 有区分力 exit 0，stdout 逐条「有区分力」，
 *     不写 VerifyRan，产物落 red-phase 前缀目录；
 *   - 验收5b 验收命令换成 echo ok（两树都过）→ 无区分力 exit 1 且 stderr 列 id，
 *     恢复动作指向「修测试而非修 gate」；
 *   - 验收6 初始 commit（无父）→ exit 2 附说明。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";
import { firstParentOf, judgeRedPhase } from "../src/verify/red-phase.js";
import type { AcceptanceRunResult } from "../src/verify/run.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u4b-red-"));
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

function ac(id: string, command: string): AcceptanceItem {
  return { id, core: true, title: `标题-${id}`, type: "e2e-real", command };
}

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

/** 建两 commit 仓库 + 入账 spec（build 锚 = c2） */
function makeRedPhaseFixture(command: string): void {
  makeGitRepo(cwd, [
    { "seed.txt": "baseline" },
    { "run-tests.sh": '#!/bin/sh\necho "A1 PASS"\n' },
  ]);
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId: "u-1",
    specHash: "0".repeat(64),
    acceptance: [ac("A1", command)],
    contracts: [],
    split: [],
  });
  ledger.append("EvidenceSubmitted", {
    unitId: "u-1",
    runId: "run-1",
    commit: (spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim(),
    paths: [],
    sha256: [],
    exitCode: 0,
  });
}

describe("firstParentOf / judgeRedPhase 纯单元（真实 git 子进程）", () => {
  it("firstParentOf：c2 → c1；初始 commit → noParent", () => {
    const repo = join(tmpRoot, "fp-repo");
    const [c1, c2] = makeGitRepo(repo, [{ "a.txt": "1" }, { "b.txt": "2" }]);
    expect(firstParentOf(repo, c2)).toEqual({ ok: true, commit: c1 });
    const root = firstParentOf(repo, c1);
    expect(root.ok).toBe(false);
    if (!root.ok) {
      expect(root.noParent).toBe(true);
      expect(root.error).toContain("无父 commit");
    }
  });

  it("judgeRedPhase：pass / parseError+exit0 / parseError+exit≠0 / 真 fail 四态", () => {
    const results: AcceptanceRunResult[] = [
      { id: "P1", status: "pass", stdoutPath: "", stderrPath: "", timeout: false, commandExit: 0, parseError: false },
      { id: "P2", status: "fail", stdoutPath: "", stderrPath: "", timeout: false, reason: "无标记行且 exitCode=0", commandExit: 0, parseError: true },
      { id: "P3", status: "fail", stdoutPath: "", stderrPath: "", timeout: false, reason: "产物解析失败", commandExit: 1, parseError: true },
      { id: "P4", status: "fail", stdoutPath: "", stderrPath: "", timeout: false, reason: "执行失败", commandExit: 1, parseError: false },
      { id: "P5", status: "fail", stdoutPath: "", stderrPath: "", timeout: true, reason: "超时", commandExit: null, parseError: false },
    ];
    const byId = new Map(judgeRedPhase(results).map((v) => [v.id, v.discriminative]));
    expect(byId.get("P1")).toBe(false); // 旧树 pass → 无区分力
    expect(byId.get("P2")).toBe(false); // echo ok 假命令 → 无区分力
    expect(byId.get("P3")).toBe(true); // 命令真挂 + 产物无效 → 有区分力
    expect(byId.get("P4")).toBe(true); // 标记 FAIL / 执行失败 → 有区分力
    expect(byId.get("P5")).toBe(true); // 旧树超时挂死 → 有区分力
  });
});

describe("验收5：--red-phase 区分力判定（dispatch 层）", () => {
  it("c1 无脚本 → 命令必挂 → 有区分力 exit 0；不写 VerifyRan；产物落 red-phase 目录", async () => {
    makeRedPhaseFixture("bash run-tests.sh");

    const res = await run(["verify", "--unit", "u-1", "--red-phase"]);
    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("A1 有区分力");
    expect(res.stdout).toMatch(/red-phase unit "u-1"：1\/1 条机器验收/);

    // 红阶段不是验证结论：绝不写 VerifyRan
    expect(ledger.readAll().filter((e) => e.type === "VerifyRan")).toHaveLength(0);

    // 产物落盘留审计（runId 目录以 red-phase- 前缀与常规 verify 区分）
    const unitDir = dirname(evidenceDir(cwHome, cwd, "u-1", "probe"));
    const redPhaseDirs = readdirSync(unitDir).filter((n) => n.startsWith("red-phase-"));
    expect(redPhaseDirs).toHaveLength(1);
    const reportPath = join(unitDir, redPhaseDirs[0] ?? "", "report.json");
    expect(readFileSync(reportPath, "utf-8")).toContain('"A1"');
  });

  it("验收命令 echo ok（两树都过）→ 无区分力 exit 1 且 stderr 列 id + 修测试指引", async () => {
    makeRedPhaseFixture("echo ok");

    const res = await run(["verify", "--unit", "u-1", "--red-phase"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A1");
    expect(res.stderr).toContain("无区分力");
    expect(res.stderr).toContain("修测试而非修 gate");
    expect(ledger.readAll().filter((e) => e.type === "VerifyRan")).toHaveLength(0);
  });
});

describe("验收6：初始 commit（无父）→ exit 2 附说明", () => {
  it("单 commit 仓库的 build 锚 → --red-phase exit 2，stderr 说明无父可回退", async () => {
    makeGitRepo(cwd, [{ "seed.txt": "only" }]);
    ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
    ledger.append("SpecSubmitted", {
      unitId: "u-1",
      specHash: "0".repeat(64),
      acceptance: [ac("A1", "echo ok")],
      contracts: [],
      split: [],
    });
    ledger.append("EvidenceSubmitted", {
      unitId: "u-1",
      runId: "run-1",
      commit: (spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim(),
      paths: [],
      sha256: [],
      exitCode: 0,
    });

    const res = await run(["verify", "--unit", "u-1", "--red-phase"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("无父 commit");
    expect(res.stderr).toContain("初始 commit");
    expect(res.stderr).toContain("恢复动作");
    expect(ledger.readAll().filter((e) => e.type === "VerifyRan")).toHaveLength(0);
  });
});
