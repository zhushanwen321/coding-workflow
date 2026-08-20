/**
 * 启动弃用 warning 测试（TC1-TC4，ADR-0014 决策 9 配套）。
 *
 * 验证 warnDeprecatedStore：
 *   TC1: 旧 per-cwd store 存在 + 无 marker → stderr 弃用提示 + 建 marker（unit, git 目录）
 *   TC2: marker 已存在 → 不重复 warning（unit，去重, git 目录）
 *   TC3: 无旧 store → 静默，不建 marker（unit）
 *   TC4: cw 命令子进程 stderr 含 warning + 第二次跨进程去重（e2e, git 目录）
 *   TC5: 非 git 目录 + 当前活跃 store 存在 → 不误报（unit，修复非 git 误报核心保障）
 *
 * 零 mock 框架：CW_HOME 用 tmp 目录隔离（真实文件 IO），stderr 用手写 spy（包装
 * process.stderr.write 捕获输出）。CW_HOME 是进程级环境变量，靠 vitest 文件内
 * it 串行 + beforeEach/afterEach 还原避免并行泄漏（同 env.ts 约定）。
 *
 * TC4 需先 npm run build（dist/cli.js 存在）。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { warnDeprecatedStore } from "../src/cli.js";
import { encodeCwd } from "../src/store/schema.js";

// ── e2e 路径常量 ────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");

// ── 手写 stderr spy（零 mock 框架）──────────────────────────

interface StderrSpy {
  /** 捕获到的 stderr 写入内容。 */
  captured: string;
  /** 还原原始 process.stderr.write。 */
  restore: () => void;
}

/**
 * 包装 process.stderr.write，捕获写入到 captured，restore() 还原。
 *
 * 同 env.ts makeStubDeps 的手写 stub 风格——不用 mock 框架。process.stderr.write 是
 * 全局，靠 vitest 文件内 it 串行 + 成对 restore 保证不泄漏。
 */
function captureStderr(): StderrSpy {
  const orig = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    get captured(): string {
      return captured;
    },
    restore: (): void => {
      process.stderr.write = orig;
    },
  };
}

// ── 隔离 CW_HOME 工厂（unit 测试用）────────────────────────

interface IsolatedEnv {
  cwHome: string;
  cwd: string;
  /** 清理临时目录。 */
  cleanup: () => void;
}

/** 造一个隔离 CW_HOME + cwd，cleanup() 删除临时目录。 */
function makeIsolatedEnv(): IsolatedEnv {
  const root = mkdtempSync(join(tmpdir(), "cw-deprec-"));
  const cwHome = join(root, "cwHome");
  const cwd = join(root, "cwd");
  mkdirSync(cwHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return {
    cwHome,
    cwd,
    cleanup: (): void => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * 造一个隔离 CW_HOME + cwd（git repo），cleanup() 删除临时目录。
 *
 * git init 后 detectCommonDir(cwd) 返回 <cwd>/.git（≠ cwd），getCwJsonPath(cwd) =
 * encodeCwd(<cwd>/.git) ≠ oldStorePath=encodeCwd(cwd)，旧 per-cwd 残留检测生效。
 * 与 makeIsolatedEnv（非 git）互补：TC1/TC2/TC4 验证「升级前 per-cwd 残留」warn 路径。
 */
function makeIsolatedGitEnv(): IsolatedEnv {
  const env = makeIsolatedEnv();
  // -q 静默 init 输出；测试不 commit，无需 user config
  spawnSync("git", ["init", "-q"], { cwd: env.cwd, encoding: "utf-8" });
  return env;
}

/** 在 cwHome 下造旧 per-cwd store（旧编码 = workspacePath 直接 encode），返回旧 store 路径。 */
function seedOldStore(cwHome: string, workspacePath: string): string {
  const dir = join(cwHome, encodeCwd(workspacePath));
  mkdirSync(dir, { recursive: true });
  const storePath = join(dir, "store.json");
  writeFileSync(storePath, "{}", "utf-8");
  return storePath;
}

/** 返回给定 workspacePath 的 marker 路径（与 warnDeprecatedStore 命名约定一致）。 */
function markerPath(cwHome: string, workspacePath: string): string {
  return join(cwHome, `.deprecation-warned-${encodeCwd(workspacePath)}`);
}

// ── CW_HOME 进程级环境变量串行管理 ─────────────────────────

let prevCwHome: string | undefined;

beforeEach(() => {
  prevCwHome = process.env.CW_HOME;
});

afterEach(() => {
  if (prevCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = prevCwHome;
  }
});

// ═══════════════════════════════════════════════════════════════
// TC1: 旧 per-cwd store 存在 → 首次 warning + 建 marker
// ═══════════════════════════════════════════════════════════════

describe("TC1: 旧 per-cwd store 存在 → 首次打弃用 warning", () => {
  it("旧 store 存在 + 无 marker → stderr 弃用提示 + marker 创建", () => {
    const env = makeIsolatedGitEnv();
    try {
      process.env.CW_HOME = env.cwHome;
      const oldStorePath = seedOldStore(env.cwHome, env.cwd);
      const marker = markerPath(env.cwHome, env.cwd);
      expect(existsSync(marker)).toBe(false);

      const spy = captureStderr();
      warnDeprecatedStore(env.cwd);
      spy.restore();

      // stderr 含弃用提示 + 旧 store 路径（指引手动捞）
      expect(spy.captured).toContain("已弃用");
      expect(spy.captured).toContain(oldStorePath);
      // marker 被创建（去重凭证）
      expect(existsSync(marker)).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// TC2: marker 存在 → 不重复 warning（去重）
// ═══════════════════════════════════════════════════════════════

describe("TC2: marker 已存在 → 不重复 warning", () => {
  it("marker 预建 → 调用不打 warning", () => {
    const env = makeIsolatedGitEnv();
    try {
      process.env.CW_HOME = env.cwHome;
      seedOldStore(env.cwHome, env.cwd);
      // 预建 marker（模拟已 warn 过）
      writeFileSync(markerPath(env.cwHome, env.cwd), "", "utf-8");

      const spy = captureStderr();
      warnDeprecatedStore(env.cwd);
      spy.restore();

      expect(spy.captured).toBe("");
    } finally {
      env.cleanup();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// TC3: 无旧 store → 静默
// ═══════════════════════════════════════════════════════════════

describe("TC3: 无旧 store → 静默", () => {
  it("CW_HOME 无旧 store → 无 warning + 不建 marker", () => {
    const env = makeIsolatedEnv();
    try {
      process.env.CW_HOME = env.cwHome;
      const marker = markerPath(env.cwHome, env.cwd);

      const spy = captureStderr();
      warnDeprecatedStore(env.cwd);
      spy.restore();

      expect(spy.captured).toBe("");
      expect(existsSync(marker)).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// TC4: cw 命令触发 warning（e2e 子进程）
// ═══════════════════════════════════════════════════════════════

describe("TC4: cw 命令子进程触发弃用 warning（e2e）", () => {
  it("首次 cw list stderr 含 warning；第二次跨进程去重无 warning", () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `dist/cli.js 不存在，请先 npm run build。路径: ${CLI_PATH}`,
      );
    }
    const workspaceDir = realpathSync(
      mkdtempSync(join(tmpdir(), "cw-deprec-ws-")),
    );
    // git repo：使 detectCommonDir(workspaceDir) ≠ workspaceDir，旧布局检测生效
    spawnSync("git", ["init", "-q"], { cwd: workspaceDir, encoding: "utf-8" });
    const cwHome = realpathSync(
      mkdtempSync(join(tmpdir(), "cw-deprec-home-")),
    );
    const mergedEnv = { ...process.env, CW_HOME: cwHome };
    try {
      // 建旧 per-cwd store（旧编码 = workspaceDir 直接 encode）
      seedOldStore(cwHome, workspaceDir);

      // 第一次：cw list 触发 warning（warnDeprecatedStore 在 dispatch 前打）
      const first = spawnSync("node", [CLI_PATH, "list"], {
        env: mergedEnv as NodeJS.ProcessEnv,
        encoding: "utf-8",
        cwd: workspaceDir,
        timeout: 30000,
      });
      expect(first.status).toBe(0);
      expect(first.stderr).toContain("已弃用");
      expect(first.stderr).toContain(
        join(cwHome, encodeCwd(workspaceDir), "store.json"),
      );
      // marker 在跨进程间持久化（去重凭证已落盘）
      expect(existsSync(markerPath(cwHome, workspaceDir))).toBe(true);

      // 第二次：marker 已建 → 跨进程去重，无 warning
      const second = spawnSync("node", [CLI_PATH, "list"], {
        env: mergedEnv as NodeJS.ProcessEnv,
        encoding: "utf-8",
        cwd: workspaceDir,
        timeout: 30000,
      });
      expect(second.status).toBe(0);
      expect(second.stderr).not.toContain("已弃用");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(cwHome, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// TC5: 非 git 目录 + 当前活跃 store 存在 → 不误报（修复非 git 误报核心保障）
// ═══════════════════════════════════════════════════════════════

describe("TC5: 非 git 目录 + 当前活跃 store 存在 → 不误报弃用", () => {
  it("非 git cwd：oldStorePath === 当前活跃 store 路径 → 静默 + 不建 marker", () => {
    const env = makeIsolatedEnv();
    try {
      process.env.CW_HOME = env.cwHome;
      // 非 git：seedOldStore 造的路径与 getCwJsonPath 重合（detectCommonDir 回退到 cwd）
      seedOldStore(env.cwHome, env.cwd);
      const marker = markerPath(env.cwHome, env.cwd);

      const spy = captureStderr();
      warnDeprecatedStore(env.cwd);
      spy.restore();

      // 不误报：stderr 空 + 不建 marker（#1 修复核心）
      expect(spy.captured).toBe("");
      expect(existsSync(marker)).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});
