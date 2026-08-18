/**
 * mx-2 playwright 适配器单测（docs/rewrite/acceptance/mx2-acceptance.md §5 T4-T6）。
 *
 * fixture 全部真实（零 mock）：tmp 建真实 playwright 项目（playwright.config.ts +
 * specs/），node_modules symlink 到本机可解析的 @playwright/test（本仓库
 * node_modules 优先，回退扫描 npx 缓存 ~/.npm/_npx 下的 node_modules——不安装
 * 依赖，复用既有生态），`npx --no-install playwright test --reporter=json` 真实
 * 子进程执行（chromium headless），stdout 落盘后交 parse。
 *
 * 实测口径披露（验收文档 §2 与实测语义的偏差，按实测实现）：
 *   - 文档措辞的 expected/unexpected 是 test 级（tests[].status）词表；逐条
 *     折叠走 results[]，result 级（results[].status）实测词表为 passed/failed/
 *     timedOut/skipped/interrupted——判定语义等价（expected ⟺ 全部 result 通过）；
 *   - test 级无 title 字段（playwright 的 spec.title 即用例标题），name 取
 *     suite 路径 title > spec title 拼接。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import { playwrightAdapter } from "../src/testrun/playwright.js";
import { nameMatch } from "../src/verify/name-match.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx2-playwright-"));

/**
 * 定位可解析 @playwright/test 的 node_modules 目录（不安装依赖——适配器面向
 * 「项目自带 playwright」的既有生态，测试同理复用本机已有安装）：
 * 本仓库 node_modules 优先，回退扫描 npx 缓存。找不到直接抛错（fail 而非
 * skip——mx-2 验收要求真实跑）。
 */
function resolvePlaywrightNodeModules(): string {
  const local = join(REPO_ROOT, "node_modules");
  if (existsSync(join(local, "@playwright", "test"))) {
    return local;
  }
  const npxRoot = join(homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      const candidate = join(npxRoot, entry, "node_modules");
      if (existsSync(join(candidate, "@playwright", "test"))) {
        return candidate;
      }
    }
  }
  throw new Error(
    "mx2-playwright 测试无法定位 @playwright/test（真实跑的前置）。" +
      "恢复动作：在任一目录安装 @playwright/test（如本仓库 npm i -D @playwright/test，" +
      "或跑一次 npx @playwright/test@latest --version 让 npx 缓存持有），再重跑本测试。",
  );
}

const PLAYWRIGHT_CONFIG = `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
`;

/** T4/T5：1 个真实 expect 通过 + 1 个真实 expect 失败，describe 层级进 name */
const MIXED_SPEC = `import { expect, test } from "@playwright/test";

test.describe("mx2 checkout flow", () => {
  test("A4 order renders", async () => {
    expect(1 + 1).toBe(2);
  });
  test("order total broken", async () => {
    expect(1 + 1).toBe(3);
  });
});
`;

/** T6：真实 test.skip() 跳过（skipped→fail 口径的 fixture） */
const SKIP_SPEC = `import { expect, test } from "@playwright/test";

test.describe("mx2 skip guard", () => {
  test("A6 skipped case", async () => {
    test.skip();
    expect(true).toBe(true);
  });
});
`;

function acc(id: string, command?: string): AcceptanceItem {
  return { id, core: false, title: "playwright 适配器验收", type: "e2e-real", command, runner: "playwright" };
}

/** tmp 建真实 playwright 项目（config + 指定 spec），node_modules symlink 到本机安装 */
function makeProject(name: string, specSources: Record<string, string>): string {
  const dir = join(tmpRoot, name);
  const specs = join(dir, "specs");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(specs, { recursive: true });
  writeFileSync(join(dir, "playwright.config.ts"), PLAYWRIGHT_CONFIG);
  for (const [fileName, source] of Object.entries(specSources)) {
    writeFileSync(join(specs, fileName), source);
  }
  symlinkSync(resolvePlaywrightNodeModules(), join(dir, "node_modules"), "dir");
  return dir;
}

/** 真实子进程跑 playwright（cwd = tmp 项目，npx 解析 symlink 内的 .bin） */
function runPlaywright(cwd: string, args: readonly string[]): { out: string; status: number; stderr: string } {
  const res = spawnSync("npx", ["--no-install", "playwright", "test", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 240_000,
  });
  if (res.error !== undefined) {
    throw new Error(`npx playwright test 无法启动（环境前置：本机须有 playwright + chromium）: ${res.error.message}`);
  }
  const out = join(tmpRoot, `stdout-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(out, res.stdout ?? "");
  return { out, status: res.status ?? -1, stderr: res.stderr ?? "" };
}

let playwrightDir: string;

beforeAll(() => {
  // 前置失败即整文件 fail（环境缺失不是 skip 的理由——mx-2 验收要求真实跑）
  playwrightDir = resolvePlaywrightNodeModules();
  expect(existsSync(join(playwrightDir, "@playwright", "test"))).toBe(true);
  // T6 的 vitest JSON fixture 跑 tests/smoke.test.ts，其被测对象是 dist/cli.js；
  // 直接跑本文件不触发 pretest，缺则 build（u5-vitest 同款兜底）
  if (!existsSync(join(REPO_ROOT, "dist", "cli.js"))) {
    const res = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`预构建 dist/cli.js 失败（T6 vitest JSON fixture 前置）: ${res.stderr}`);
    }
  }
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("T5 翻译与名字比对", () => {
  it("translate 幂等：已含 --reporter=json 的 command 原样返回", () => {
    const command = "npx playwright test tests/checkout --reporter=json";
    expect(playwrightAdapter.translate(acc("A5", command))).toBe(command);
  });

  it("缺 flag → 追加且不动其余部分；无 command → 默认全量命令", () => {
    expect(playwrightAdapter.translate(acc("A5", "npx playwright test tests/checkout"))).toBe(
      "npx playwright test tests/checkout --reporter=json",
    );
    expect(playwrightAdapter.translate(acc("A5"))).toBe("npx playwright test --reporter=json");
  });

  it("真实跑含层级的 spec → name 含 describe 与 spec 层级文本，验收 id 在 test title → nameMatch 词边界命中", () => {
    const project = makeProject("t5-naming", { "mixed.spec.ts": MIXED_SPEC });
    const { out, status } = runPlaywright(project, ["--reporter=json"]);
    expect(status).toBe(1); // 1 条真实失败

    const report = playwrightAdapter.parse(out, status, acc("A4"));
    // describe 与 spec 层级文本全部进 name（层级拼接锚）；file 级 suite title
    // （spec 文件名）是路径首段。每条 case 的 name 是自身的层级路径
    expect(report.cases.length).toBe(2);
    for (const c of report.cases) {
      expect(c.name).toContain("mixed.spec.ts");
      expect(c.name).toContain("mx2 checkout flow");
    }
    const names = report.cases.map((c) => c.name).join("\n");
    expect(names).toContain("A4 order renders");
    expect(names).toContain("order total broken");
    expect(report.cases.every((c) => c.id === "A4")).toBe(true);

    // 验收 id 出现在 test title（"A4 order renders" 的空格是词边界）→ 命中且全 pass 判定：
    // 该验收只命中 A4 一条（fail 的另一条 title 不含 A4），pass 成立
    const verdict = nameMatch(acc("A4"), report);
    expect(verdict.pass).toBe(true);
  });
});

describe("T4 真实通过/失败判定（真实 npx playwright test + chromium + tmp 项目）", () => {
  it("1 pass + 1 真实 expect 失败 → cases 判定正确、exitCode 非 0", () => {
    const project = makeProject("t4-mixed", { "mixed.spec.ts": MIXED_SPEC });
    const { out, status } = runPlaywright(project, ["--reporter=json"]);
    expect(status).toBe(1);

    const report = playwrightAdapter.parse(out, status, acc("A4"));
    expect(report.exitCode).toBe(1);
    expect(report.rawPath).toBe(out);
    expect(report.cases).toHaveLength(2);
    const passed = report.cases.filter((c) => c.status === "pass");
    const failed = report.cases.filter((c) => c.status === "fail");
    expect(passed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(passed[0].name).toContain("A4 order renders");
    expect(failed[0].name).toContain("order total broken");
  });
});

describe("T6 形状防线", () => {
  it("喂 {} → parse 抛错不伪造 cases（顶层缺 suites 数组）", () => {
    const out = join(tmpRoot, "t6-empty-object.json");
    writeFileSync(out, "{}");
    expect(() => playwrightAdapter.parse(out, 1, acc("A6"))).toThrow(/顶层缺 suites 数组/);
  });

  it("喂真实 vitest JSON（本仓库真实跑出）→ parse 抛错（vitest 顶层是 testResults，形状不符）", () => {
    const res = spawnSync("npx", ["vitest", "run", "tests/smoke.test.ts", "--reporter=json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(res.status).toBe(0);
    const out = join(tmpRoot, "t6-vitest.json");
    writeFileSync(out, res.stdout ?? "");
    expect(() => playwrightAdapter.parse(out, 0, acc("A6"))).toThrow(/playwright JSON 形状不符.*suites/s);
  });

  it("真实 test.skip() 跳过 → status=fail（M0 不认 skip 口径）", () => {
    const project = makeProject("t6-skip", { "skip.spec.ts": SKIP_SPEC });
    const { out, status } = runPlaywright(project, ["--reporter=json"]);
    expect(status).toBe(0); // 全 skip 的 playwright 进程级 exit 0——条目级如实折 fail

    const report = playwrightAdapter.parse(out, status, acc("A6"));
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0].status).toBe("fail");
    // 口径后果：skip 无法逃逸验收（nameMatch 判 fail）
    expect(nameMatch(acc("A6"), report).pass).toBe(false);
  });

  it("echo ok 类假命令 stdout（exit 0、JSON 零 result）→ 抛错（无区分力防线）", () => {
    const out = join(tmpRoot, "t6-echo.json");
    writeFileSync(out, '{"config":{},"suites":[],"errors":[],"stats":{}}'); // 合法 JSON 零 suites 条目
    expect(() => playwrightAdapter.parse(out, 0, acc("A6"))).toThrow(/零 result 且 exitCode=0/);
  });
});
