/**
 * u4b E2E（真实子进程跑 dist/cli.js + tmp git 仓库 + 隔离 CW_HOME，零 mock）。
 *
 * 对应 docs/rewrite/acceptance/u4b-acceptance.md「E2E real」两条：
 *   1. 全链 create → spec（e2e-sh 型验收 + 真实脚本文件随 build commit 提交；
 *      unit 型验收 command 指向本仓库 vitest bin，测试文件同样随 c2 引入）→
 *      build → review → verify → exit 0 且 VerifyRan 入账；再 verify --red-phase →
 *      exit 0（红阶段 patch 语义把脚本/测试带进父树，真测试在基线树上因实现
 *      产物缺失而挂 = 有区分力；fixture 须写真测试——旧恒真形态会被正确拒绝）；
 *   2. 假命令防线全链：e2e 验收 command=echo ok → 常规 verify 的 parse 抛错路径 →
 *      exit 1；--red-phase 同样 exit 1（无区分力）。
 *
 * 注意：直接 `npx vitest run tests/u4b-e2e.test.ts` 不触发 pretest，需先 `npm run build`
 * （beforeAll 有 dist 缺失兜底）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 干净 checkout 无 node_modules：vitest 以绝对路径启动（探针已验证可跑） */
const VITEST_BIN = join(REPO_ROOT, "node_modules", ".bin", "vitest");

// 子进程 process.cwd() 返回物理路径（macOS 上 /var 是 /private/var 的符号链接），
// 父进程读账本用的 cwd 必须同一物理路径，否则 encodeCwd 不一致、读到空账本
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cw-u4b-e2e-")));
const cwHome = join(tmpRoot, "cw-home");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    const res = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`预构建 dist/cli.js 失败: ${res.stderr}`);
    }
  }
});

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实子进程跑 dist/cli.js；cwd = 指定 tmp git 仓库，CW_HOME 隔离（env 显式传入） */
function runCli(
  cwd: string,
  args: readonly string[],
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 建 tmp git 仓库并按批提交；返回各 commit hash（按提交序） */
function makeGitRepo(dir: string, commitsFiles: ReadonlyArray<Record<string, string>>): string[] {
  mkdirSync(dir, { recursive: true });
  gitRun(dir, ["init"]);
  gitRun(dir, ["config", "user.email", "cw-e2e@example.com"]);
  gitRun(dir, ["config", "user.name", "cw-e2e"]);
  const hashes: string[] = [];
  commitsFiles.forEach((files, i) => {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    gitRun(dir, ["add", "-A"]);
    gitRun(dir, ["commit", "-m", `commit-${i + 1}`]);
    hashes.push(gitRun(dir, ["rev-parse", "HEAD"]));
  });
  return hashes;
}

function writeSpecFile(dir: string, acceptance: unknown[]): string {
  const spec = { acceptance, contracts: [], split: [] };
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-m", "spec"]);
  return gitRun(dir, ["rev-parse", "HEAD"]);
}

function verifyRans(dir: string, unitId: string): Array<{ result: string; acceptanceIds: string[] }> {
  return new EventLedger(ledgerPath(cwHome, dir))
    .readAll()
    .filter((e) => e.type === "VerifyRan" && e.payload.unitId === unitId)
    .map((e) => {
      const p = e.payload as { result: string; acceptanceIds: string[] };
      return { result: p.result, acceptanceIds: p.acceptanceIds };
    });
}

describe("E2E 1：适配器判定全链（create → spec → build → review → verify → --red-phase）", () => {
  it(
    "常规 verify exit 0 + VerifyRan 入账；--red-phase exit 0（真测试 patch 到父树后因实现缺失而挂）",
    { timeout: 180_000 },
    () => {
      const repo = join(tmpRoot, "repo-full");
      const UNIT = "u-full";
      // c1：实现前基线（无实现产物、无 e2e 脚本、无测试文件）；c2：实现产物
      // impl.js + 引用它的真测试（e2e 脚本 grep 实现内容、vitest 断言实现行为）。
      // 红阶段会把 e2e/run.sh patch 进父树（command 引用它），真测试在 c1 树上
      // 因 impl.js 缺失而挂 → 有区分力。build 锚必须是 c2 而非「spec.json 单独
      // commit」——红阶段回退的是 build 锚的父，spec 若自成 commit 会让父树仍含
      // 实现产物，红阶段全数误判无区分力
      const [, implCommit] = makeGitRepo(repo, [
        {
          "brief.md": "# 任务书\n",
          "package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
        },
        {
          "impl.js": "export function add(a, b) {\n  return a + b;\n}\n",
          "e2e/run.sh":
            '#!/bin/sh\n' +
            'if grep -q "return a + b" impl.js; then\n' +
            '  echo "A1 PASS"\n' +
            '  echo "A2 PASS"\n' +
            "else\n" +
            '  echo "A1 FAIL"\n' +
            '  echo "A2 FAIL"\n' +
            "  exit 1\n" +
            "fi\n",
          "tests/acceptances.test.ts":
            'import { describe, expect, it } from "vitest";\n\n' +
            'import { add } from "../impl.js";\n\n' +
            'describe("验收", () => {\n' +
            '  it("A3 单元行为", () => {\n    expect(add(1, 1)).toBe(2);\n  });\n' +
            "});\n",
        },
      ]);
      // spec.json 只落工作区供 evidence submit 读取（验收真值在账本，无需随 git 提交）
      writeFileSync(
        join(repo, "spec.json"),
        JSON.stringify({
          acceptance: [
            {
              id: "A1",
              core: true,
              title: "核心链路可用",
              type: "e2e-real",
              command: "bash e2e/run.sh",
            },
            {
              id: "A2",
              core: true,
              title: "核心链路第二场景",
              type: "e2e-real",
              command: "bash e2e/run.sh",
            },
            {
              id: "A3",
              core: false,
              title: "单元行为",
              type: "unit",
              command: `"${VITEST_BIN}" run`,
            },
            { id: "M1", core: false, title: "人工抽检记录", type: "manual" },
          ],
          contracts: [],
          split: [],
        }),
      );

      expect(runCli(repo, ["create", "--id", UNIT, "--brief", "brief.md"]).code).toBe(0);
      expect(
        runCli(repo, ["evidence", "submit", "--kind", "spec", "--unit", UNIT, "--file", "spec.json"]).code,
        "spec gate 应放行（core 均 e2e 级、command 可解析、含 unit 级用例）",
      ).toBe(0);
      expect(
        runCli(repo, [
          "evidence",
          "submit",
          "--kind",
          "build",
          "--unit",
          UNIT,
          "--commit",
          implCommit,
          "--run-id",
          "run-1",
        ]).code,
      ).toBe(0);
      expect(
        runCli(repo, ["review", "submit", "--unit", UNIT, "--verdict-kind", "spec-review", "--verdict", "pass"]).code,
      ).toBe(0);

      // 常规 verify：e2e 标记行 + vitest 测试名（A3）双路由判定全 pass
      const verify = runCli(repo, ["verify", "--unit", UNIT]);
      expect(verify.code, `全过应 exit 0（stdout: ${verify.stdout}\nstderr: ${verify.stderr}）`).toBe(0);
      expect(verify.stdout).toContain("A1 pass");
      expect(verify.stdout).toContain("A2 pass");
      expect(verify.stdout).toContain("A3 pass");
      expect(verify.stdout).toContain("M1 manual");
      expect(verify.stdout).toContain("result=pass");

      const runs = verifyRans(repo, UNIT);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.result).toBe("pass");
      expect(runs[0]?.acceptanceIds).toEqual(["A1", "A2", "A3", "M1"]);

      // 红阶段：A1/A2 的 e2e/run.sh 被 patch 进父树（command 引用它），真测试
      // 因 c1 无 impl.js 而挂；A3 的 vitest 全量跑不引用具体测试文件（无可 patch），
      // c1 无 tests/ → no test files → exit 1——三条机器验收都有区分力
      const red = runCli(repo, ["verify", "--unit", UNIT, "--red-phase"]);
      expect(red.code, `红阶段应 exit 0（stdout: ${red.stdout}\nstderr: ${red.stderr}）`).toBe(0);
      expect(red.stdout).toContain("A1 有区分力");
      expect(red.stdout).toContain("A2 有区分力");
      expect(red.stdout).toContain("A3 有区分力");
      // 红阶段不写 VerifyRan（它不是验证结论）
      expect(verifyRans(repo, UNIT)).toHaveLength(1);
    },
  );
});

describe("E2E 2：假命令防线全链（command=echo ok）", () => {
  it("常规 verify 走 parse 抛错路径 → exit 1；--red-phase 无区分力 → exit 1", { timeout: 120_000 }, () => {
    const repo = join(tmpRoot, "repo-fake");
    const UNIT = "u-fake";
    makeGitRepo(repo, [{ "brief.md": "# 任务书\n" }]);
    const specCommit = writeSpecFile(repo, [
      { id: "A1", core: true, title: "假命令防线", type: "e2e-real", command: "echo ok" },
      { id: "U1", core: false, title: "单元行为", type: "unit", command: "echo no-json" },
    ]);

    expect(runCli(repo, ["create", "--id", UNIT, "--brief", "brief.md"]).code).toBe(0);
    expect(
      runCli(repo, ["evidence", "submit", "--kind", "spec", "--unit", UNIT, "--file", "spec.json"]).code,
    ).toBe(0);
    expect(
      runCli(repo, [
        "evidence",
        "submit",
        "--kind",
        "build",
        "--unit",
        UNIT,
        "--commit",
        specCommit,
        "--run-id",
        "run-1",
      ]).code,
    ).toBe(0);

    const verify = runCli(repo, ["verify", "--unit", UNIT]);
    expect(verify.code, `parse 抛错应 exit 1（stdout: ${verify.stdout}\nstderr: ${verify.stderr}）`).toBe(1);
    expect(verify.stdout).toContain("A1 fail");
    expect(verify.stderr).toContain("无标记行且 exitCode=0");
    expect(verify.stderr).toContain("vitest 兼容命令");

    const runs = verifyRans(repo, UNIT);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("fail");
    expect(runs[0]?.acceptanceIds).toEqual([]);

    // 红阶段：echo ok 在父 commit（brief-only）上也过 → 无区分力
    const red = runCli(repo, ["verify", "--unit", UNIT, "--red-phase"]);
    expect(red.code).toBe(1);
    expect(red.stderr).toContain("A1");
    expect(red.stderr).toContain("无区分力");
    expect(red.stderr).toContain("修测试而非修 gate");
    // 红阶段不写 VerifyRan
    expect(verifyRans(repo, UNIT)).toHaveLength(1);
  });
});
