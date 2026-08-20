/**
 * u2 E2E（真实子进程跑 dist/cli.js + tmp git 仓库 + 隔离 CW_HOME，零 mock）。
 *
 * 序列对应 docs/rewrite/acceptance/u2-acceptance.md「E2E real 验收」：
 *   create（根）→ [负路径：gate 不过的 spec 提交 → exit 1 且 events.log 行数不变]
 *   → create（--parent）→ evidence submit --kind spec（合法 spec.json）
 *   → evidence submit --kind build（真实 commit + 产物文件）
 *   → review submit --verdict-kind spec-review --verdict pass。
 * 断言每步 exit 0；完成后 events.log 恰含 5 条，类型序 = UnitCreated×2 →
 * SpecSubmitted → EvidenceSubmitted → VerdictSubmitted（u1b status 未并入，按验收
 * 文档允许的替代路径直接 readAll 验证）。
 *
 * 注意：直接 `npx vitest run tests/u2-e2e.test.ts` 不触发 pretest，需先 `npm run build`
 * （`npm test` 的 pretest 已含 build）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u2-e2e-"));
const cwHome = join(tmpRoot, "cw-home");
// 子进程 process.cwd() 返回物理路径（macOS 上 /var 是 /private/var 的符号链接），
// 父进程账本路径计算必须用同一物理路径，否则 encodeCwd 结果不一致、账本"消失"
mkdirSync(join(tmpRoot, "repo"), { recursive: true });
const repoDir = realpathSync(join(tmpRoot, "repo"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function gitRun(args: readonly string[]): void {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
}

/** 真实子进程跑 dist/cli.js；cwd = tmp git 仓库，CW_HOME 隔离（env 显式传入） */
function runCli(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function countLedgerLines(ledgerFile: string): number {
  try {
    return readFileSync(ledgerFile, "utf-8")
      .split("\n")
      .filter((l) => l !== "").length;
  } catch {
    return 0; // 账本尚未创建 = 0 行
  }
}

describe("E2E real：写命令完整序列（dist/cli.js 子进程）", () => {
  it("create×2 → spec → build → review 全链 exit 0；events.log 5 条且类型序正确；负路径 gate 不过账本不变", () => {
    // 真实 git 仓库 + 真实 commit（build 形态的 commit 存在性检查依赖它）
    mkdirSync(repoDir, { recursive: true });
    gitRun(["init"]);
    gitRun(["config", "user.email", "cw-e2e@example.com"]);
    gitRun(["config", "user.name", "cw-e2e"]);
    writeFileSync(join(repoDir, "seed.txt"), "seed\n");
    gitRun(["add", "-A"]);
    gitRun(["commit", "-m", "init"]);
    const head = (spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    // 仓库内 fixture：brief / 合法 spec / gate 必挂 spec（空 acceptance）/ 两个产物
    writeFileSync(join(repoDir, "brief.md"), "# 任务书\n");
    const specFile = join(repoDir, "spec.json");
    writeFileSync(
      specFile,
      JSON.stringify({
        acceptance: [
          { id: "A1", core: true, title: "核心链路", type: "e2e-real", command: "node -v" },
          { id: "A2", core: false, title: "单元行为", type: "unit" },
        ],
        contracts: [],
        split: [],
      }),
    );
    writeFileSync(join(repoDir, "spec-bad.json"), JSON.stringify({ acceptance: [], contracts: [], split: [] }));
    const art1 = join(repoDir, "art1.json");
    const art2 = join(repoDir, "art2.json");
    writeFileSync(art1, '{"artifact":1}');
    writeFileSync(art2, '{"artifact":2}');

    const ledgerFile = ledgerPath(cwHome, repoDir);

    // 1. create 根
    const r1 = runCli(["create", "--id", "u-root", "--brief", "brief.md"]);
    expect(r1.code, `create 根应 exit 0（stderr: ${r1.stderr}）`).toBe(0);
    expect(r1.stdout).toContain("u-root");
    expect(countLedgerLines(ledgerFile)).toBe(1);

    // 负路径：gate 不过的 spec 提交 → exit 1 且 events.log 行数不变、stderr 含 gate 原文
    const bad = runCli(["evidence", "submit", "--kind", "spec", "--unit", "u-root", "--file", "spec-bad.json"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("rule①: spec.acceptance 为空（至少需要一条验收用例）");
    expect(countLedgerLines(ledgerFile)).toBe(1);

    // 2. create 叶（--parent）
    const r2 = runCli(["create", "--id", "u-leaf", "--brief", "brief.md", "--parent", "u-root"]);
    expect(r2.code, `create 叶应 exit 0（stderr: ${r2.stderr}）`).toBe(0);

    // 3. evidence submit --kind spec
    const r3 = runCli(["evidence", "submit", "--kind", "spec", "--unit", "u-leaf", "--file", "spec.json"]);
    expect(r3.code, `spec 提交应 exit 0（stderr: ${r3.stderr}）`).toBe(0);

    // 4. evidence submit --kind build（真实 commit + 两份产物）
    const r4 = runCli([
      "evidence",
      "submit",
      "--kind",
      "build",
      "--unit",
      "u-leaf",
      "--commit",
      head,
      "--run-id",
      "run-1",
      "--file",
      "art1.json",
      "--file",
      "art2.json",
    ]);
    expect(r4.code, `build 提交应 exit 0（stderr: ${r4.stderr}）`).toBe(0);
    expect(r4.stdout).toContain("run-1");

    // 5. review submit（mx3 迁移：spec-review 必带 --role reviewer）
    const r5 = runCli([
      "review",
      "submit",
      "--unit",
      "u-leaf",
      "--verdict-kind",
      "spec-review",
      "--verdict",
      "pass",
      "--role",
      "reviewer",
    ]);
    expect(r5.code, `review 提交应 exit 0（stderr: ${r5.stderr}）`).toBe(0);

    // 完成态：恰 5 条，类型序 = UnitCreated×2 → SpecSubmitted → EvidenceSubmitted → VerdictSubmitted
    const ledger = new EventLedger(ledgerFile);
    const events = ledger.readAll();
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.type)).toEqual([
      "UnitCreated",
      "UnitCreated",
      "SpecSubmitted",
      "EvidenceSubmitted",
      "VerdictSubmitted",
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    // 事件内容关键事实
    expect(events[0]?.payload).toEqual({ unitId: "u-root", parentId: null, briefRef: "brief.md" });
    expect(events[1]?.payload).toEqual({ unitId: "u-leaf", parentId: "u-root", briefRef: "brief.md" });
    const expectedSpecHash = createHash("sha256").update(readFileSync(specFile)).digest("hex");
    expect(events[2]?.payload).toMatchObject({ unitId: "u-leaf", specHash: expectedSpecHash });
    expect(events[3]?.payload).toEqual({
      unitId: "u-leaf",
      runId: "run-1",
      commit: head,
      paths: ["art1.json", "art2.json"],
      sha256: [
        createHash("sha256").update(readFileSync(art1)).digest("hex"),
        createHash("sha256").update(readFileSync(art2)).digest("hex"),
      ],
      exitCode: 0,
    });
    expect(events[4]?.payload).toEqual({
      unitId: "u-leaf",
      verdictKind: "spec-review",
      verdict: "pass",
      role: "reviewer",
    });
  });
});
