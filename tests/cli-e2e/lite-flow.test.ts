/**
 * 完整 lite 流程 e2e — create → plan → dev → test → retrospect → closeout。
 *
 * 验证 CLI 全链跑通：每个 action 经真实子进程调用，状态正确流转。
 * 前置：需先 `npm run build` 生成 dist/cli/cli.js。
 *
 * 覆盖 test-matrix: T1.8（完整 create 流程 e2e 的扩展，覆盖全 lite 生命周期）。
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_PATH = join(process.cwd(), "dist", "cli", "cli.js");

function runCw(
  args: string[],
  env: Record<string, string>,
  stdinData?: string,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: stdinData === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      input: stdinData,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

describe("完整 lite 流程 e2e", () => {
  let cwHome: string;
  let workspace: string;

  beforeEach(() => {
    cwHome = mkdtempSync(join(tmpdir(), "cw-flow-home-"));
    workspace = mkdtempSync(join(tmpdir(), "cw-flow-ws-"));

    // 初始化 git 仓库（dev/test 需要 GitValidator）
    execSync("git init", { cwd: workspace, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: workspace, stdio: "pipe" });
    execSync('git config user.name "test"', { cwd: workspace, stdio: "pipe" });
    // 创建 .gitignore 避免 .xyz-harness 被追踪
    writeFileSync(join(workspace, ".gitignore"), ".xyz-harness\n");
  });

  afterEach(() => {
    try {
      rmSync(cwHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  });

  it("create → plan → dev → test → retrospect → closeout 全链通过", () => {
    const env = { CW_HOME: cwHome };

    // ── Step 1: create ──
    const created = runCw(
      ["create", "--slug", "fullflow", "--tier", "lite", "--objective", "complete lite flow", "--workspace", workspace],
      env,
    );
    expect(created.exitCode).toBe(0);
    const topicId = JSON.parse(created.stdout).topicId;
    expect(topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-fullflow$/);

    // ── Step 2: plan（stdin 传 lite plan.json + topicDir 需有合规 plan.md 过 gate）──
    // 先写合规 plan.md（check_plan.py 结构性校验读取）
    const topicDir = join(workspace, ".xyz-harness", "fullflow");
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(join(topicDir, "plan.md"), [
      "# Plan",
      "## 业务目标",
      "完整 lite 流程验证",
      "",
      "## 技术改动点",
      "- 修改 src/a.ts — 核心逻辑",
      "",
      "## Wave 拆分与依赖",
      "| Wave | 改动文件 | 依赖 | 并行组 | 说明 |",
      "|------|----------|------|--------|------|",
      "| W1 | src/a.ts | W0 | - | 核心实现 |",
      "",
      "## 单测用例清单",
      "| 用例ID | 覆盖改动点 | 输入 | 预期 |",
      "|--------|-----------|------|------|",
      "| U1 | src/a.ts:a | 输入 1 | 返回 1 |",
      "",
      "## E2E 用例清单",
      "| 用例ID | 场景 | 测试层 | 说明 |",
      "|--------|------|--------|------|",
      "| E1 | 基本验证 | mock | 不依赖外部 |",
      "| E2 | 端到端 | real | 走真实进程 |",
      "",
      "## 覆盖率 gate",
      "gate 命令: pnpm vitest run --coverage",
      "阈值: 80%",
      "",
      "## 实现步骤",
      "1. 写单测",
      "2. 实现核心",
    ].join("\n"));

    // 测试用例带 expected（url/text），供 test 阶段 judgeByExpected 重算
    const planJson = JSON.stringify({
      format: "lite",
      objective: "complete lite flow",
      waves: [
        { id: "W1", changes: ["src/a.ts"], dependsOn: [] },
      ],
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "验证基本功能",
          steps: "调用函数 → 检查输出",
          expected: { text: "hello world" },
          executor: "vitest",
          requiresScreenshot: false,
        },
      ],
    });
    const planned = runCw(
      ["plan", "--topicId", topicId, "--workspace", workspace],
      env,
      planJson,
    );
    expect(planned.exitCode).toBe(0);
    const planResult = JSON.parse(planned.stdout);
    expect(planResult.status).toBe("planned");
    expect(planResult.gatePassed.plan).toBe(true);

    // ── Step 3: dev（需要真实 git commit）──
    // 在 workspace 中创建文件并 commit
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;\n");
    execSync("git add -A", { cwd: workspace, stdio: "pipe" });
    execSync('git commit -m "W1 implementation"', { cwd: workspace, stdio: "pipe" });
    const commitHash = execSync("git rev-parse HEAD", { cwd: workspace, encoding: "utf-8" }).trim();

    const devResult = runCw(
      ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash }]), "--workspace", workspace],
      env,
    );
    expect(devResult.exitCode).toBe(0);
    const devJson = JSON.parse(devResult.stdout);
    expect(devJson.gatePassed.dev).toBe(true);
    expect(devJson.nextAction.action).toBe("test");

    // ── Step 4: test（lite: judgeByExpected 重算，actual 匹配 expected）──
    const testResult = runCw(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([
        { caseId: "E1", actual: { text: "hello world" } },
      ]), "--workspace", workspace],
      env,
    );
    expect(testResult.exitCode).toBe(0);
    const testJson = JSON.parse(testResult.stdout);
    expect(testJson.gatePassed.test).toBe(true);
    expect(testJson.nextAction.action).toBe("retrospect");

    // ── Step 5: retrospect（需要 retrospect.md 文件）──
    const retrospectPath = join(topicDir, "retrospect.md");
    writeFileSync(retrospectPath, "# Retrospect\n\nAll good.\n");

    const retroResult = runCw(
      ["retrospect", "--topicId", topicId, "--retrospectPath", retrospectPath, "--workspace", workspace],
      env,
    );
    expect(retroResult.exitCode).toBe(0);
    const retroJson = JSON.parse(retroResult.stdout);
    expect(retroJson.gatePassed.retrospect).toBe(true);
    expect(retroJson.nextAction.action).toBe("closeout");

    // ── Step 6: closeout（终态）──
    // closeout gate (check_closeout.py) 需要归档交付物
    const projectRoot = workspace;
    mkdirSync(join(projectRoot, "docs", "adr"), { recursive: true });
    // ARCHIVED.md — 列出去向文档
    writeFileSync(join(topicDir, "ARCHIVED.md"), [
      "# Archived",
      "",
      "本 topic 沉淀至：PRODUCT.md / NFR.md / ADR。",
    ].join("\n"));
    // closeout-report.md — frontmatter unverified_count=0，文中无 [UNVERIFIED]
    writeFileSync(join(topicDir, "closeout-report.md"), [
      "---",
      "unverified_count: 0",
      "verdict: pass",
      "---",
      "",
      "# Closeout Report",
      "全部约束已验证。",
    ].join("\n"));
    // PRODUCT.md（project_root 下）含溯源
    writeFileSync(join(projectRoot, "PRODUCT.md"), [
      "# Product",
      `[from: fullflow] 搜索能力沉淀`,
    ].join("\n"));
    // NFR.md — 本次 topic 沉淀的约束块含「验证」
    writeFileSync(join(projectRoot, "NFR.md"), [
      "# NFR",
      "",
      `### S-1 延迟 [from: fullflow]`,
      "P50 < 200ms。",
      "验证：基准压测脚本。",
    ].join("\n"));
    // ADR — docs/adr 下，含溯源
    writeFileSync(join(projectRoot, "docs", "adr", "ADR-001.md"), [
      "# ADR-001 选型",
      `[from: fullflow]`,
    ].join("\n"));
    // DESIGN-LOG.md — topic 行标 archived
    writeFileSync(join(projectRoot, "DESIGN-LOG.md"), [
      "# Design Log",
      `- fullflow — status: archived`,
    ].join("\n"));
    // changes/ 应已空

    const closeResult = runCw(
      ["closeout", "--topicId", topicId, "--workspace", workspace],
      env,
    );
    expect(closeResult.exitCode).toBe(0);
    const closeJson = JSON.parse(closeResult.stdout);
    expect(closeJson.status).toBe("closed");
    expect(closeJson.evidence).toBeDefined();
    expect(closeJson.evidence.closedAt).toBeDefined();

    // ── 验证：status 查询反映终态 ──
    const statusResult = runCw(
      ["status", "--topicId", topicId, "--workspace", workspace],
      env,
    );
    expect(statusResult.exitCode).toBe(0);
    const statusJson = JSON.parse(statusResult.stdout);
    expect(statusJson.status).toBe("closed");
  });
});
