/**
 * u1b E2E（真实子进程，零 mock）：真实 node 子进程跑 dist/cli.js 的四个只读命令，
 * 对 EventLedger 直写构造的两状态账本断言 exit 0 + 输出内容。
 *
 * fixture（不依赖 u2 的 CLI 写命令——并行保护）：
 *   - root：仅 UnitCreated → created
 *   - leaf：root 之子；spec（过五规则）+ spec-review pass + evidence + verify pass
 *     （acceptanceIds 只覆盖 A1 未覆盖 A2 → 状态停在 spec-frozen，验收文档指定构造）
 *
 * 空账本目录：四命令全部 exit 0、输出 (空账本)、stderr 干净（不抛栈）、
 * 且不创建账本文件（只读命令零副作用）。
 * flag 端到端：status --unit 详情 / --json 结构化 / frontier --json / report --unit
 * 限定 / 不存在 unitId exit 1（命令规格锁定的完整 flag 面）。
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

// 注意：fileURLToPath(new URL("..", …)) 的结果带尾斜杠，再套 dirname 会多退一级，
// 故先取本文件所在目录再上一级
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TESTS_DIR, "..");
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

// realpathSync：macOS tmpdir 是 /var → /private/var symlink，fixture 直写与子进程
// process.cwd() 必须看到同一路径，否则 encodeCwd 编码出两个不同账本目录
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cw-u1b-e2e-")));
const cwHome = join(tmpRoot, "home");
const projDir = join(tmpRoot, "proj");
const emptyProjDir = join(tmpRoot, "empty-proj");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 真实子进程跑 dist/cli.js（CW_HOME 隔离到 tmp；始终 resolve 供断言） */
function runCli(args: readonly string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, CW_HOME: cwHome },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: `spawn error: ${err.message}` });
    });
  });
}

beforeAll(() => {
  // e2e 直跑（不经 npm test 的 pretest）也保证 dist 新鲜
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });

  mkdirSync(projDir, { recursive: true });
  mkdirSync(emptyProjDir, { recursive: true });
  const ledger = new EventLedger(ledgerPath(cwHome, projDir));

  ledger.append("UnitCreated", {
    unitId: "root",
    parentId: null,
    briefRef: "briefs/root.md",
  });
  ledger.append("UnitCreated", {
    unitId: "leaf",
    parentId: "root",
    briefRef: "briefs/leaf.md",
  });
  ledger.append("SpecSubmitted", {
    unitId: "leaf",
    specHash: "leaf-spec-hash-000000000000000000000000000000",
    acceptance: [
      { id: "A1", core: true, title: "A1 核心链路", type: "e2e-real", command: "node -v" },
      { id: "A2", core: false, title: "A2 单元级", type: "unit" },
    ],
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", {
    unitId: "leaf",
    verdictKind: "spec-review",
    verdict: "pass",
  });
  ledger.append("EvidenceSubmitted", {
    unitId: "leaf",
    runId: "run-leaf-1",
    commit: "c0ffee0000000000000000000000000000000000",
    paths: ["report.json", "stdout.txt"],
    sha256: [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    exitCode: 0,
  });
  // 只覆盖 A1 未覆盖 A2 → leaf 停在 spec-frozen（验收文档指定的两状态 fixture）
  ledger.append("VerifyRan", {
    unitId: "leaf",
    runId: "vr-leaf-1",
    reportHash: "rh-leaf-1",
    result: "pass",
    acceptanceIds: ["A1"],
  });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("E2E real：两状态账本（root=created / leaf=spec-frozen）", () => {
  it("status：exit 0，每 unit 一行含 unitId/状态/specs/evidences/lastVerify", async () => {
    const r = await runCli(["status"], projDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("root  created  specs:0 evidences:0 lastVerify:-");
    expect(r.stdout).toContain("leaf  spec-frozen  specs:1 evidences:1 lastVerify:pass");
  });

  it("frontier：exit 0，specReady 含 root、buildReady 含 leaf", async () => {
    const r = await runCli(["frontier"], projDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("specReady:");
    expect(r.stdout).toContain("buildReady:");
    expect(r.stdout.split("\n")).toContain("  root");
    expect(r.stdout.split("\n")).toContain("  leaf");
  });

  it("tree：exit 0，root 根层、leaf 缩进一层，节点含状态字", async () => {
    const r = await runCli(["tree"], projDir);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("root (created)");
    expect(r.stdout.split("\n")).toContain("  leaf (spec-frozen)");
  });

  it("report：exit 0，两 unit 证据链齐全（spec hash/覆盖标记/evidence/verify）", async () => {
    const r = await runCli(["report"], projDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("unit: root (created)");
    expect(r.stdout).toContain("unit: leaf (spec-frozen)");
    expect(r.stdout).toContain("spec: leaf-spec-ha"); // spec hash 前 12 位
    expect(r.stdout).toContain("A1 e2e-real [core] ✓");
    expect(r.stdout).toContain("A2 unit ✗");
    expect(r.stdout).toContain("runId=run-leaf-1 commit=c0ffee");
    expect(r.stdout).toContain("report.json sha256=aa"); // 文件 sha256 前 12 位
    expect(r.stdout).toContain("runId=vr-leaf-1 result=pass acceptance=A1");
  });
});

describe("E2E real：flag 端到端（--unit / --json）", () => {
  it("status --unit：exit 0，详情含 briefRef / spec hash / verdict / evidence / verify", async () => {
    const r = await runCli(["status", "--unit", "leaf"], projDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("unit: leaf");
    expect(r.stdout).toContain("status: spec-frozen");
    expect(r.stdout).toContain("briefRef: briefs/leaf.md");
    expect(r.stdout).toContain("leaf-spec-ha"); // spec hash 前 12 位
    expect(r.stdout).toContain("- spec-review pass");
    expect(r.stdout).toContain("runId=run-leaf-1 commit=c0ffee");
    expect(r.stdout).toContain("acceptance=A1");
  });

  it("status --json / frontier --json：exit 0，stdout 可 JSON.parse 且字段对得上", async () => {
    const s = await runCli(["status", "--json"], projDir);
    expect(s.code).toBe(0);
    const parsed = JSON.parse(s.stdout) as {
      units: Array<{ unitId: string; status: string }>;
      totalEvents: number;
      note: string;
    };
    expect(parsed.totalEvents).toBe(6);
    expect(parsed.units.map((u) => u.unitId)).toEqual(["root", "leaf"]);
    expect(parsed.units[1]?.status).toBe("spec-frozen");
    expect(parsed.note).toContain("Map");

    const f = await runCli(["frontier", "--json"], projDir);
    expect(f.code).toBe(0);
    // 全维度（与 runner 派发同口径）：本账本 root 待 spec、leaf 待 build，其余组空
    // （rv-5 起含 flakeReview 维度——e2e 连挂转人工组）
    expect(JSON.parse(f.stdout)).toEqual({
      specReady: ["root"],
      reReview: [],
      missingChildren: [],
      integrationDrift: [],
      integrationReady: [],
      flakeReview: [],
      buildReady: ["leaf"],
      execReviewReady: [],
    });
  });

  it("report --unit：exit 0 仅输出该 unit；status --unit 不存在：exit 1 且 stderr 可操作", async () => {
    const r = await runCli(["report", "--unit", "leaf"], projDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("unit: leaf (spec-frozen)");
    expect(r.stdout).not.toContain("unit: root (created)");

    const miss = await runCli(["status", "--unit", "no-such-unit"], projDir);
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain("不存在");
    expect(miss.stderr).toContain("cw status");
  });
});

describe("E2E real：空账本目录", () => {
  it("四命令全部 exit 0、输出 (空账本)、stderr 干净不抛栈、不创建账本文件", async () => {
    for (const cmd of ["status", "frontier", "tree", "report"] as const) {
      const r = await runCli([cmd], emptyProjDir);
      expect(r.code, `${cmd} exit code（stderr: ${r.stderr}）`).toBe(0);
      expect(r.stdout, `${cmd} stdout`).toContain("(空账本)");
      expect(r.stderr, `${cmd} stderr 应为空（不抛栈）`).toBe("");
    }
    // 只读零副作用：空账本项目目录下不产生任何账本文件
    expect(existsSync(ledgerPath(cwHome, emptyProjDir))).toBe(false);
  });

  it("空账本 --json：status / frontier 输出结构化空形态（机器消费方可解析，非纯文本）", async () => {
    const s = await runCli(["status", "--json"], emptyProjDir);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.stdout)).toEqual(
      expect.objectContaining({ units: [], totalEvents: 0 }),
    );

    const f = await runCli(["frontier", "--json"], emptyProjDir);
    expect(f.code).toBe(0);
    expect(JSON.parse(f.stdout)).toEqual({
      specReady: [],
      reReview: [],
      missingChildren: [],
      integrationDrift: [],
      integrationReady: [],
      flakeReview: [],
      buildReady: [],
      execReviewReady: [],
    });
  });
});
