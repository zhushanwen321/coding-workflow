/**
 * GP-1 golden 重放测试：把 fixture 账本复制进 tmp CW_HOME，以子进程跑四只读命令
 * （status / tree / frontier / report），输出与 snapshots/*.txt 逐字节比对。
 *
 * 目的：泛化 EventLedger 域描述符注入后，验证 unit 域行为逐字节不变。
 * 测试规范：零 mock，真实子进程 + tmp 目录。
 *
 * 归一化规则（本测试暂不需要——四只读命令输出不含 tmp 绝对路径）：
 *   若未来快照出现 tmp 路径，需加 replace(tmpDir, "<TMP>") 归一化。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeCwd } from "../src/store/project.js";

// ── 路径常量 ──

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_DIR = join(TEST_DIR, "fixtures", "golden-ledgers", "unit-basic");
const DIST_ROOT = resolve(TEST_DIR, "../dist");
const CLI_PATH = join(DIST_ROOT, "cli.js");
const EVENTS_LOG = join(FIXTURE_DIR, "events.log");

/** dist 缺席时挂起（pretest build 后自动激活） */
const distIt = existsSync(CLI_PATH) ? it : it.todo;

// ── 临时目录（realpathSync 解析 macOS /tmp → /private/tmp）──

const tmpRoot = realpathSync(mkdtemp(join(tmpdir(), "cw-gp1-")));
const cwHome = join(tmpRoot, "home");

function mkdtemp(base: string): string {
  mkdirSync(base, { recursive: true });
  return base;
}

beforeAll(() => {
  // 将 fixture events.log 复制到 tmp CW_HOME 的正确位置
  const encoded = encodeCwd(tmpRoot);
  const ledgerDir = join(cwHome, encoded);
  mkdirSync(ledgerDir, { recursive: true });
  copyFileSync(EVENTS_LOG, join(ledgerDir, "events.log"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── 子进程工具 ──

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[]): CliResult {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: tmpRoot,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
    timeout: 30_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ── 测试 ──

describe("GP-1 golden 重放：unit-basic 账本四只读命令快照比对", () => {
  const snapshot = (name: string): string =>
    readFileSync(join(FIXTURE_DIR, "snapshots", name), "utf-8");

  distIt("status 输出与快照逐字节一致", () => {
    const result = runCli(["status"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(snapshot("status.txt"));
  });

  distIt("tree 输出与快照逐字节一致", () => {
    const result = runCli(["tree"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(snapshot("tree.txt"));
  });

  distIt("frontier --json 输出与快照逐字节一致", () => {
    const result = runCli(["frontier", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(snapshot("frontier.json"));
  });

  distIt("report 输出与快照逐字节一致", () => {
    const result = runCli(["report"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(snapshot("report.txt"));
  });

  // 额外断言：账本含全部六类事件
  it("events.log 含全部六类事件类型", () => {
    const lines = readFileSync(EVENTS_LOG, "utf-8").split("\n").filter((l) => l !== "");
    const events = lines.map((l) => JSON.parse(l) as { type: string });
    const types = new Set(events.map((e) => e.type));
    const expected: readonly string[] = [
      "UnitCreated",
      "SpecSubmitted",
      "VerdictSubmitted",
      "EvidenceSubmitted",
      "VerifyRan",
      "ReflectionRan",
    ];
    for (const t of expected) {
      expect(types, `缺少事件类型 ${t}`).toContain(t);
    }
    expect(events.length).toBe(14);
  });
});
