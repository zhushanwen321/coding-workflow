/**
 * e2e-init 测试 — E10（init 基建诊断，子进程层）。
 *
 * 覆盖分支：
 *   E10a: 空 workspace 目录 → ready=false, mainConfig=null
 *   E10b: 补齐必备文档（AGENTS.md/README.md/CONTEXT.md 实质内容）→ ready=true
 *   E10c: 骨架态（含 {{占位符}}）→ 对应 doc status=skeleton
 *
 * init 是 topic 前的只读诊断，不经 dispatch。init.test.ts 是单元层（直接调 runInit）；
 * 本文件是子进程层（跑 `cw init`），验证 CLI 路由 + JSON 序列化。
 *
 * 每个测试用独立临时目录（不 init git，避免 setupGitRepo 的 README.md 干扰诊断）。
 * runCli 的 cwd override 指向测试目录（init 诊断 process.cwd()）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  parseStdout,
  runCli,
} from "./helpers/e2e.js";

let e: E2eEnv;
const tempDirs: string[] = [];

beforeAll(() => {
  // init 不依赖 CW_HOME/git，只取 env 给 PATH；测试目录由各用例自建。
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 建一个空临时目录（不 init git），返回路径。 */
function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-e2e-init-"));
  tempDirs.push(dir);
  return dir;
}

/** 在 dir 下跑 cw init（cwd=dir）。 */
function runInit(dir: string): Record<string, unknown> {
  return parseStdout(runCli(["init"], e, { cwd: dir }));
}

/** 写一个含实质内容的文档（非骨架）。 */
function writeDoc(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

// ── E10a: 空 workspace 目录 ─────────────────────────────────

describe("E10a: 空 workspace 目录 → ready=false, mainConfig=null", () => {
  it("空目录 → 全 missing, ready=false", () => {
    const dir = emptyDir();
    const result = runInit(dir);

    expect(result.ready).toBe(false);
    expect(result.mainConfig).toBeNull();

    const docs = result.docs as Array<Record<string, unknown>>;
    // 至少有必备文档组，状态为 missing
    const statuses = docs.map((d) => d.status);
    expect(statuses).toContain("missing");
    // 无 ok（空目录没文档）
    expect(statuses).not.toContain("ok");
  });
});

// ── E10b: 补齐必备文档 → ready=true ─────────────────────────

describe("E10b: 补齐必备文档 → ready=true", () => {
  it("AGENTS.md + README.md + CONTEXT.md 实质内容 → ready=true", () => {
    const dir = emptyDir();
    writeDoc(dir, "AGENTS.md", "# 项目说明\n\n这是一个真实的项目配置文档。");
    writeDoc(dir, "README.md", "# Project\n\n真实的 README 内容。");
    writeDoc(dir, "CONTEXT.md", "# 上下文\n\n统一语言和核心概念说明。");

    const result = runInit(dir);
    expect(result.ready).toBe(true);
    expect(result.mainConfig).toBe("AGENTS.md");

    const docs = result.docs as Array<Record<string, unknown>>;
    // 必备三件套全 ok
    const requiredDocs = docs.filter((d) => d.level === "必备");
    for (const d of requiredDocs) {
      expect(d.status).toBe("ok");
    }
  });
});

// ── E10c: 骨架态（含占位符）────────────────────────────────

describe("E10c: 含 {{占位符}} 的文档 → status=skeleton", () => {
  it("AGENTS.md 含 {{占位符}} → skeleton, ready=false", () => {
    const dir = emptyDir();
    writeDoc(dir, "AGENTS.md", "# 项目\n\n这是 {{项目名}} 的配置。");
    writeDoc(dir, "README.md", "# Project\n\n真实内容。");
    writeDoc(dir, "CONTEXT.md", "# 上下文\n\n真实说明。");

    const result = runInit(dir);
    // 骨架态 → ready=false（必备未全 ok）
    expect(result.ready).toBe(false);

    const docs = result.docs as Array<Record<string, unknown>>;
    // doc.name 格式 = `${组名}（${级别}）`，主配置组 = "主配置（必备）"
    const mainConfigDoc = docs.find((d) =>
      (d.name as string).startsWith("主配置"),
    );
    expect(mainConfigDoc).toBeDefined();
    expect(mainConfigDoc!.status).toBe("skeleton");
  });
});

// ── E10d: 骨架闭环自洽（init 返回的 skeleton 能真正用于补齐） ──
//
// 这不是重复单元测试——它验证端到端的核心价值链：
// init 返回 skeleton 字符串 → agent 替换占位符 → 写文件 → 重新 init 判 ok。
// 如果 skeleton 内容本身有问题（如含无法匹配的正则、格式错误），这条链会断。

describe("E10d: 骨架闭环 — init 返回的 skeleton 写入后能被重新检测为 ok", () => {
  it("空目录 init → 拿骨架 → 替换占位符写入 → 重新 init 全 ok", () => {
    const dir = emptyDir();

    // 1. init 拿骨架
    const init1 = runInit(dir);
    expect(init1.ready).toBe(false);
    const docs1 = init1.docs as Array<Record<string, unknown>>;
    const missing = docs1.filter(
      (d) => d.status === "missing" && d.level === "必备",
    );
    expect(missing.length).toBe(3); // 主配置/README/CONTEXT

    // 2. 模拟 agent 补齐：骨架的 ASCII 占位符全部替换为实质内容
    for (const doc of missing) {
      const skeleton = doc.skeleton as string;
      // 覆盖所有占位符形态：{{var}} / {snake} / {kebab-case} / TODO / TBD
      const filled = skeleton
        .replace(/\{\{[^}]+\}\}/g, "实质内容")
        .replace(/\{[a-zA-Z_][a-zA-Z0-9_.\-]*\}/g, "实质内容")
        .replace(/\bTODO\b/g, "已完成")
        .replace(/\bTBD\b/g, "已确定");
      writeDoc(dir, doc.path as string, filled);
    }

    // 3. 重新 init：必备应全 ok
    const init2 = runInit(dir);
    expect(init2.ready).toBe(true);
    expect(init2.mainConfig).toBe("AGENTS.md");
    const docs2 = init2.docs as Array<Record<string, unknown>>;
    const required2 = docs2.filter((d) => d.level === "必备");
    expect(required2.every((d) => d.status === "ok")).toBe(true);
    // 已存在文档不附骨架（避免 agent 误覆盖）
    expect(required2.every((d) => d.skeleton === undefined)).toBe(true);
  });
});

// ── E10e: create 引导接线（跨模块真实路径） ───────────────────
//
// handleCreate 调 runInit 后拼 guidance——这是单元测试（直接调 handleCreate
// 不走 CLI）和 runInit 单元测试都覆盖不到的接线。验证两种真实场景：
//   - 空目录 create → guidance 含 init 引导（列出缺失文档，但不阻断建 topic）
//   - 文档就绪 create → guidance 不含 init 引导（直接走原流程）

describe("E10e: create 引导 — 文档未就绪时 guidance 含 init 提示", () => {
  it("空目录 create → guidance 前缀含 init 引导 + 列出缺失必备文档 + 不阻断", () => {
    // 用独立空目录（非 e2e workspaceDir，避免 setupGitRepo 的文件干扰）
    const dir = emptyDir();

    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "e10e-init-guide", "--objective", "测试 create init 引导", "--workspace", dir],
        e,
        { cwd: dir },
      ),
    );
    // create 不阻断——topic 建成功
    expect(createResult.status).toBe("created");
    expect(createResult.topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-e10e-init-guide$/);

    const guidance = (createResult.nextAction as Record<string, unknown>).guidance as string;
    // 引导前缀含 init 提示
    expect(guidance).toContain("项目文档基建未就绪");
    expect(guidance).toContain("cw init");
    // 列出了具体缺失的必备文档
    expect(guidance).toContain("AGENTS.md");
    expect(guidance).toContain("README.md");
    expect(guidance).toContain("CONTEXT.md");
    // 原流程不阻断——topic 已建立的 guidance 仍在
    expect(guidance).toContain("topic 已建立");
  });
});

describe("E10f: create 引导 — 文档就绪时 guidance 不含 init 提示", () => {
  it("必备文档齐全后 create → guidance 直接走原流程", () => {
    const dir = emptyDir();
    writeDoc(dir, "AGENTS.md", "# 项目\n\n实质内容，无占位符。");
    writeDoc(dir, "README.md", "# 项目说明\n\n实质内容。");
    writeDoc(dir, "CONTEXT.md", "# 统一语言\n\n术语表内容。");

    // 确认 init 判 ready（前置条件）
    const initCheck = runInit(dir);
    expect(initCheck.ready).toBe(true);

    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "e10f-no-guide", "--objective", "文档就绪测试", "--workspace", dir],
        e,
        { cwd: dir },
      ),
    );
    const guidance = (createResult.nextAction as Record<string, unknown>).guidance as string;
    // 文档就绪 → 不含 init 引导
    expect(guidance).not.toContain("项目文档基建");
    // 直接走原流程
    expect(guidance).toContain("topic 已建立");
  });
});
