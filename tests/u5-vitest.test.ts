/**
 * u5 vitest 适配器单测（docs/rewrite/acceptance/u5-acceptance.md「单测验收」1-4 条）。
 *
 * fixture 全部真实生成（零 mock、禁手写 JSON 凭空造）：
 *   - 通过用例：真实子进程 `npx vitest run tests/smoke.test.ts --reporter=json`
 *     （本仓库真实测试，3 条 smoke），stdout 落 tmp 后交 parse；
 *   - 失败用例：tmp 目录真实构造含失败断言的测试文件，`--root` 指向 tmp 跑真
 *     vitest（cwd 保持仓库根以解析依赖），exitCode=1；
 *   - 非法 JSON：真实跑一次默认 reporter（人类可读输出，天然非 JSON）落盘。
 *
 * 前置：smoke.test.ts 真实子进程执行 dist/cli.js，直接 `npx vitest run tests/u5-*`
 * 不触发 pretest，故 beforeAll 自行确保 dist 存在（缺则 build）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import { vitestAdapter } from "../src/testrun/vitest.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u5-vitest-"));

/** 含一条失败断言 + 一条通过断言的真实测试文件（跑真 vitest 产出失败 JSON） */
const FAIL_TEST_SOURCE = `import { describe, expect, it } from "vitest";

describe("u5 失败 fixture", () => {
  it("故意失败的断言", () => {
    expect(1 + 1).toBe(3);
  });
  it("正常通过的断言", () => {
    expect(1 + 1).toBe(2);
  });
});
`;

function acc(command?: string): AcceptanceItem {
  return { id: "A1", core: false, title: "vitest 适配器 parse 验收", type: "unit", command };
}

/** 真实子进程跑 vitest（cwd = 仓库根，npx 解析到本地 vitest） */
function runVitest(args: readonly string[]): { status: number; stdout: string } {
  const res = spawnSync("npx", ["vitest", "run", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "" };
}

/** stdout 落 tmp 文件（parse 的输入是 cw 捕获的产物文件，不是内存字符串） */
function dumpStdout(name: string, stdout: string): string {
  const path = join(tmpRoot, name);
  writeFileSync(path, stdout);
  return path;
}

beforeAll(() => {
  // smoke.test.ts 的被测对象是 dist/cli.js；直接跑 u5 测试文件时无 pretest 兜底
  if (!existsSync(join(REPO_ROOT, "dist", "cli.js"))) {
    const res = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`预构建 dist/cli.js 失败（smoke fixture 前置）: ${res.stderr}`);
    }
  }
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("vitest 适配器 translate", () => {
  it("验收#4a 已含 --reporter=json 的 command 原样返回（不重复追加）", () => {
    const command = "npx vitest run tests/smoke.test.ts --reporter=json";
    expect(vitestAdapter.translate(acc(command))).toBe(command);
  });

  it("验收#4b 无 command → 默认全量命令（含 --reporter=json）", () => {
    expect(vitestAdapter.translate(acc())).toBe("npx vitest run --reporter=json");
  });

  it("边界：command 缺 --reporter=json → 追加且不动其余部分", () => {
    expect(vitestAdapter.translate(acc("npx vitest run tests/x.test.ts"))).toBe(
      "npx vitest run tests/x.test.ts --reporter=json",
    );
  });
});

describe("vitest 适配器 parse（真实 fixture）", () => {
  it(
    "验收#1 真实跑 tests/smoke.test.ts → cases ≥3 全 pass，exitCode=0，id=验收 id",
    { timeout: 120_000 },
    () => {
      const res = runVitest(["tests/smoke.test.ts", "--reporter=json"]);
      expect(res.status).toBe(0);
      const out = dumpStdout("smoke.json", res.stdout);
      const report = vitestAdapter.parse(out, res.status, acc());
      expect(report.exitCode).toBe(0);
      expect(report.rawPath).toBe(out);
      expect(report.cases.length).toBeGreaterThanOrEqual(3);
      expect(report.cases.every((c) => c.id === "A1")).toBe(true);
      expect(report.cases.every((c) => c.status === "pass")).toBe(true);
    },
  );

  it(
    "验收#2 tmp 真实构造失败断言测试文件 → parse 出 fail case，exitCode=1（矛盾输入以断言为准）",
    { timeout: 120_000 },
    () => {
      writeFileSync(join(tmpRoot, "fail.test.ts"), FAIL_TEST_SOURCE);
      const res = runVitest(["--root", tmpRoot, "--reporter=json"]);
      expect(res.status).toBe(1);
      const out = dumpStdout("fail.json", res.stdout);
      const report = vitestAdapter.parse(out, res.status, acc());
      expect(report.exitCode).toBe(1);
      const failed = report.cases.filter((c) => c.status === "fail");
      const passed = report.cases.filter((c) => c.status === "pass");
      expect(failed).toHaveLength(1);
      expect(failed[0].name).toContain("故意失败的断言");
      expect(passed).toHaveLength(1);
      expect(passed[0].name).toContain("正常通过的断言");

      // 边界（规格「矛盾输入」条）：断言 fail 而 exitCode=0 时 cases 以断言为准。
      // exitCode 是 parse 入参（调用侧透传），产物文件本身仍是真实 vitest 生成
      const contradictory = vitestAdapter.parse(out, 0, acc());
      expect(contradictory.exitCode).toBe(0);
      expect(contradictory.cases.some((c) => c.status === "fail")).toBe(true);
    },
  );

  it(
    "验收#3 默认 reporter 的真实 stdout（非 JSON）→ parse 抛错，不伪造 cases",
    { timeout: 120_000 },
    () => {
      const res = runVitest(["tests/smoke.test.ts"]);
      expect(res.status).toBe(0);
      const out = dumpStdout("human-readable.txt", res.stdout);
      expect(() => vitestAdapter.parse(out, res.status, acc())).toThrow(/不是合法 JSON/);
    },
  );
});
