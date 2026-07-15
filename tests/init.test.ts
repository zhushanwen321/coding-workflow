/**
 * init.test.ts — 项目文档基建诊断测试（零 mock，真实 tmp 目录）。
 *
 * 测试约定（与项目一致）：真实 fs 操作，不引入 mock 框架。
 * 每个 test 用独立的 mkdtempSync 目录，afterEach rmSync 清理。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";

// ── 辅助 ─────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cw-init-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** 写实质内容文件（无 ASCII 占位符，避免被判骨架态）。 */
function writeReal(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

// ── A 类：文档存在性 + 骨架态 ────────────────────────────────

describe("runInit — 文档存在性", () => {
  it("空目录 → 全 missing，mainConfig=null，ready=false", () => {
    const result = runInit(testDir);

    expect(result.mainConfig).toBe(null);
    expect(result.ready).toBe(false);
    expect(result.docs.every((d) => d.status === "missing")).toBe(true);
    // 所有 missing 文档都附带骨架字符串
    for (const doc of result.docs) {
      expect(doc.skeleton).toBeTruthy();
      expect(typeof doc.skeleton).toBe("string");
    }
  });

  it("必备三件套齐全（实质内容）→ ready=true", () => {
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n\n这是实质内容，无占位符。");
    writeReal(join(testDir, "README.md"), "# 项目说明\n\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 统一语言\n\n术语表内容。");

    const result = runInit(testDir);

    expect(result.ready).toBe(true);
    expect(result.mainConfig).toBe("AGENTS.md");
    const required = result.docs.filter((d) => d.level === "必备");
    expect(required.every((d) => d.status === "ok")).toBe(true);
    // 已存在文档不附带骨架
    for (const doc of result.docs) {
      if (doc.status !== "missing") {
        expect(doc.skeleton).toBeUndefined();
      }
    }
  });

  it("推荐/可选缺失不阻断 ready（只必备齐全即可）", () => {
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");

    const result = runInit(testDir);

    expect(result.ready).toBe(true);
    const recommended = result.docs.filter((d) => d.level === "推荐");
    expect(recommended.every((d) => d.status === "missing")).toBe(true);
  });

  it("CLAUDE.md 作为主配置（AGENTS.md 缺失时）", () => {
    writeReal(join(testDir, "CLAUDE.md"), "# 项目\n实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");

    const result = runInit(testDir);

    expect(result.mainConfig).toBe("CLAUDE.md");
    expect(result.ready).toBe(true);
  });
});

describe("runInit — 骨架态检测", () => {
  it("含 {{占位符}} 的文档 → status=skeleton", () => {
    writeFileSync(
      join(testDir, "AGENTS.md"),
      "# {{项目名}}\n\n这是骨架，含双花括号占位符。",
      "utf8",
    );
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");

    const result = runInit(testDir);

    const mainConfig = result.docs.find((d) => d.name.startsWith("主配置"));
    expect(mainConfig?.status).toBe("skeleton");
    expect(result.ready).toBe(false); // 骨架态 = 未就绪
  });

  it("含 {snake_case} 占位符的文档 → status=skeleton", () => {
    writeFileSync(
      join(testDir, "AGENTS.md"),
      "# 项目\n\n内容含 {placeholder} 占位符。",
      "utf8",
    );
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");

    const result = runInit(testDir);

    expect(result.docs.find((d) => d.name.startsWith("主配置"))?.status).toBe("skeleton");
  });

  it("含 TODO/FIXME 的文档 → status=skeleton", () => {
    writeFileSync(
      join(testDir, "AGENTS.md"),
      "# 项目\n\n实质内容但含 TODO 待补。",
      "utf8",
    );
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");

    const result = runInit(testDir);

    expect(result.docs.find((d) => d.name.startsWith("主配置"))?.status).toBe("skeleton");
  });

  it("中文占位符不算骨架（只 ASCII 占位符触发）", () => {
    // {主题} 虽是花括号但首字符是中文（非 [a-zA-Z_]），不匹配 PLACEHOLDER_RE
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n\n[from: {主题}] 实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");

    const result = runInit(testDir);

    expect(result.docs.find((d) => d.name.startsWith("主配置"))?.status).toBe("ok");
    expect(result.ready).toBe(true);
  });
});

// ── B 类：回读一致性 ─────────────────────────────────────────

describe("runInit — 回读一致性（ARCHITECTURE.md）", () => {
  it("非骨架 ARCHITECTURE.md 模块名不在源码 → stale", () => {
    writeReal(
      join(testDir, "ARCHITECTURE.md"),
      "# 架构\n\n## 模块划分\n\n| 模块 | 职责 |\n|------|------|\n| FooBar | 做事 |\n| BazQux | 其他 |\n",
    );
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");
    // 无源码 → FooBar/BazQux 必然找不到 → stale
    writeReal(join(testDir, "src.ts"), "// 空源码文件\n");

    const result = runInit(testDir);

    const arch = result.docs.find((d) => d.name.startsWith("ARCHITECTURE"));
    expect(arch?.status).toBe("stale");
    expect(result.ready).toBe(false); // stale 导致 not ready
  });

  it("非骨架 ARCHITECTURE.md 模块名在源码 → ok", () => {
    writeReal(
      join(testDir, "ARCHITECTURE.md"),
      "# 架构\n\n## 模块划分\n\n| 模块 | 职责 |\n|------|------|\n| FooBar | 做事 |\n",
    );
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");
    // 源码含 FooBar → 命中
    writeReal(join(testDir, "src.ts"), "export class FooBar {}\n");

    const result = runInit(testDir);

    const arch = result.docs.find((d) => d.name.startsWith("ARCHITECTURE"));
    expect(arch?.status).toBe("ok");
  });

  it("骨架态 ARCHITECTURE.md 跳过回读（不标 stale）", () => {
    writeFileSync(
      join(testDir, "ARCHITECTURE.md"),
      "# 架构\n\n## 模块划分\n\n| 模块 | 职责 |\n|------|------|\n| {module} | 做事 |\n",
      "utf8",
    );
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");

    const result = runInit(testDir);

    const arch = result.docs.find((d) => d.name.startsWith("ARCHITECTURE"));
    expect(arch?.status).toBe("skeleton"); // 不是 stale
  });
});

describe("runInit — 回读一致性（NFR.md）", () => {
  it("非骨架 NFR.md 验证标识符不在源码 → stale", () => {
    writeReal(
      join(testDir, "NFR.md"),
      [
        "# 工程约束",
        "",
        "## 安全",
        "",
        "### S-1 幂等",
        "",
        "- **验证**：`checkIdempotency` 函数存在",
        "",
      ].join("\n"),
    );
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");
    // 空源码文件——不含 checkIdempotency 标识符
    writeReal(join(testDir, "src.ts"), "export const noop = 1;\n");

    const result = runInit(testDir);

    const nfr = result.docs.find((d) => d.name.startsWith("NFR"));
    expect(nfr?.status).toBe("stale");
  });

  it("非骨架 NFR.md 验证标识符在源码 → ok", () => {
    writeReal(
      join(testDir, "NFR.md"),
      [
        "# 工程约束",
        "",
        "## 安全",
        "",
        "### S-1 幂等",
        "",
        "- **验证**：`checkIdempotency` 函数存在",
        "",
      ].join("\n"),
    );
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");
    writeReal(join(testDir, "src.ts"), "function checkIdempotency() {}\n");

    const result = runInit(testDir);

    const nfr = result.docs.find((d) => d.name.startsWith("NFR"));
    expect(nfr?.status).toBe("ok");
  });

  it("NFR.md 无反引号标识符的验证字段 → ok（无内容可机器验证，不报 stale）", () => {
    writeReal(
      join(testDir, "NFR.md"),
      [
        "# 工程约束",
        "",
        "## 安全",
        "",
        "### S-1 幂等",
        "",
        "- **验证**：手动测试通过",
        "",
      ].join("\n"),
    );
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");

    const result = runInit(testDir);

    const nfr = result.docs.find((d) => d.name.startsWith("NFR"));
    expect(nfr?.status).toBe("ok");
  });
});

// ── C 类：骨架字符串 ─────────────────────────────────────────

describe("runInit — 骨架内容", () => {
  it("missing 文档的 skeleton 含关键章节标题", () => {
    const result = runInit(testDir); // 空目录，全 missing

    const agents = result.docs.find((d) => d.path === "AGENTS.md");
    expect(agents?.skeleton).toContain("# ");
    expect(agents?.skeleton).toContain("## 项目概述");
    expect(agents?.skeleton).toContain("## 技术栈");

    const context = result.docs.find((d) => d.path === "CONTEXT.md");
    expect(context?.skeleton).toContain("## 术语表");

    const arch = result.docs.find((d) => d.path === "ARCHITECTURE.md");
    expect(arch?.skeleton).toContain("## 模块划分");
  });

  it("骨架含 ASCII 占位符（本身是骨架态）", () => {
    const result = runInit(testDir);

    const agents = result.docs.find((d) => d.path === "AGENTS.md");
    // 骨架应含 {项目名} 或类似占位符
    expect(agents?.skeleton).toMatch(/\{[^}]+\}/);
  });
});

// ── docRoot 定位 ─────────────────────────────────────────────

describe("runInit — docRoot 定位", () => {
  it("主配置在项目根 → docRoot=项目根", () => {
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n实质内容。");

    const result = runInit(testDir);

    expect(result.docRoot).toBe(testDir);
  });

  it("无主配置 → docRoot 回退 workspacePath，mainConfig=null", () => {
    const result = runInit(testDir);

    expect(result.docRoot).toBe(testDir);
    expect(result.mainConfig).toBe(null);
  });
});

// ── 综合场景 ─────────────────────────────────────────────────

describe("runInit — 综合场景", () => {
  it("混合状态：必备齐全 + 推荐骨架 + 可选缺失", () => {
    writeReal(join(testDir, "AGENTS.md"), "# 项目\n实质内容。");
    writeReal(join(testDir, "README.md"), "# 说明\n实质内容。");
    writeReal(join(testDir, "CONTEXT.md"), "# 术语\n实质内容。");
    // ARCHITECTURE 骨架态
    writeFileSync(
      join(testDir, "ARCHITECTURE.md"),
      "# 架构\n\n含 {placeholder} 骨架。",
      "utf8",
    );
    // PRODUCT/NFR/TEST-STRATEGY/DESIGN-LOG 缺失

    const result = runInit(testDir);

    // 必备全 ok，无 stale → ready
    expect(result.ready).toBe(true);
    // 架构是骨架态（推荐，不阻断 ready）
    expect(result.docs.find((d) => d.name.startsWith("ARCHITECTURE"))?.status).toBe("skeleton");
    // 推荐的 PRODUCT/NFR 缺失
    expect(result.docs.find((d) => d.name.startsWith("PRODUCT"))?.status).toBe("missing");
    expect(result.docs.find((d) => d.name.startsWith("NFR"))?.status).toBe("missing");
  });
});
