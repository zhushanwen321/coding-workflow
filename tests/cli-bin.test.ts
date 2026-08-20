/**
 * bin 形态 e2e（真实子进程，零 mock）：shebang 与入口判断的回归锁。
 *
 * 其余 e2e 全部以 `node dist/cli.js` 直跑，npm 全局安装后的 bin 形态（shell 直接
 * execve 脚本、npm bin 是 symlink、安装路径含空格）在此零覆盖——shebang 缺失
 * 问题即由此存活。本文件以「不带 node 前缀、直接执行脚本文件」的形态跑三个场景：
 *   1. chmod +x 后直接执行 dist/cli.js（shebang 生效；缺失时 execve 报 ENOEXEC）；
 *   2. 经 symlink 执行（npm bin 形态：argv[1] 是 symlink 路径，import.meta.url
 *      是 realpath——入口判断必须两侧归一才自执行 main）；
 *   3. dist 拷贝到含空格路径的目录执行（import.meta.url 的 URL 编码形态 vs 文件
 *      系统路径，逐字节比较须先 fileURLToPath 归一）。
 *
 * 三场景共用断言：exit 0 且 stdout 非空（--version 有输出 = main 确实自执行；
 * 入口判断失效时模块静默加载、进程 exit 0 但零输出，仅断 exit code 抓不住）。
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getVersion } from "../src/index.js";

// 先取本文件所在目录再上一级（fileURLToPath(new URL("..")) 带尾斜杠，套 dirname 会多退一级）
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TESTS_DIR, "..");
const DIST_DIR = join(REPO_ROOT, "dist");
const CLI_PATH = join(DIST_DIR, "cli.js");

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cw-cli-bin-")));

interface BinResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 不带 node 前缀直接执行脚本（kernel 经 shebang 找解释器）；始终 resolve 供断言 */
function execBin(binPath: string, args: readonly string[], cwd: string): Promise<BinResult> {
  return new Promise((resolve) => {
    const child = spawn(binPath, [...args], { cwd });
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
      // shebang 缺失时此处触发（ENOEXEC：非二进制且无可执行头）
      resolve({ code: -1, stdout, stderr: `spawn error: ${err.message}` });
    });
  });
}

beforeAll(() => {
  // e2e 直跑（不经 npm test 的 pretest）也保证 dist 新鲜；chmod 必须在 build 之后
  // （tsc 重写 dist/cli.js 会重置可执行位）
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  chmodSync(CLI_PATH, 0o755);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("bin 形态（真实子进程直接执行脚本文件）", () => {
  it("dist/cli.js 首行是 node shebang（bin 可执行的前提）", () => {
    const firstLine = readFileSync(CLI_PATH, "utf8").split("\n")[0] ?? "";
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("场景①：chmod +x 后直接执行（无 node 前缀）→ main 自执行，exit 0 有输出", async () => {
    const r = await execBin(CLI_PATH, ["--version"], tmpRoot);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(getVersion());
  });

  it("场景②：经 symlink 执行（npm bin 形态）→ 入口判断两侧 realpath 归一，main 自执行", async () => {
    const binDir = join(tmpRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const linkPath = join(binDir, "cw");
    symlinkSync(CLI_PATH, linkPath);

    const r = await execBin(linkPath, ["--version"], tmpRoot);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    // 入口判断失效时：模块静默加载、exit 0 但零输出——非空输出才证明 main 自执行
    expect(r.stdout.trim()).toBe(getVersion());
  });

  it("场景③：dist 拷贝到含空格路径的目录执行 → fileURLToPath 归一后入口判断仍成立", async () => {
    const spacedDir = join(tmpRoot, "dir with spaces");
    const spacedDist = join(spacedDir, "dist");
    mkdirSync(spacedDir, { recursive: true });
    // cli.js 以相对路径 import 同目录模块（dispatch.js 等），须整目录拷贝；
    // dist 内有外部依赖（@sinclair/typebox / minimist），node_modules 查找从脚本
    // 所在目录向上走——补 symlink 指回仓库；--version 还从 dist 上一级读
    // package.json（src/index.ts 的 getVersion）——按 npm 安装布局一并拷贝
    symlinkSync(join(REPO_ROOT, "node_modules"), join(spacedDir, "node_modules"));
    copyFileSync(join(REPO_ROOT, "package.json"), join(spacedDir, "package.json"));
    cpSync(DIST_DIR, spacedDist, { recursive: true });

    const r = await execBin(join(spacedDist, "cli.js"), ["--version"], spacedDir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(getVersion());
  });
});
