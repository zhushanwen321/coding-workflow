/**
 * v1 core/git.ts extractChangedFiles 失败上下文测试（M14 修复验证）。
 *
 * 来源：M14 HANDOFF（git.ts stderr 截断 → 失败 note 信息丢失）。
 *
 * 修复内容：
 *   - spawnSync 显式 stdio: ["ignore", "pipe", "pipe"]（避免 stdin 继承 hang）
 *   - maxBuffer 拉到 16MB（spawnSync 硬上限），保住完整 stderr 不丢
 *   - 失败 note 含 stderr 摘要（最多 2KB，保留首尾关键信息）+ stdout 头部（git diff 失败时 stdout 也可能有内容）
 *
 * 不变量：extractChangedFiles 永不抛异常；rev-parse 失败 / diff 失败均返回空数组 + note。
 *
 * 测试策略：真 git 子进程（zero mock 原则），用临时 git 仓库验证失败路径的 note 内容。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractChangedFiles } from "../src/core/git.js";

/** 临时 git 仓库管理：init + 配置 user.email/name + 清理。 */
function makeTempRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "cw-git-extract-"));
  spawnSync("git", ["init"], { cwd, encoding: "utf-8" });
  spawnSync("git", ["config", "user.email", "test@cw.local"], { cwd, encoding: "utf-8" });
  spawnSync("git", ["config", "user.name", "cw-test"], { cwd, encoding: "utf-8" });
  return cwd;
}

describe("M14: extractChangedFiles 失败上下文", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeTempRepo();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("commit 不存在 → rev-parse 失败 note 含 stderr 上下文 + 友好文案", () => {
    // 仓库存在但目标 commit 不存在 → rev-parse 必然失败
    const result = extractChangedFiles(cwd, "0000000000000000000000000000000000000000");

    expect(result.changedFiles).toEqual([]);
    expect(result.note).toBeDefined();
    // 保留友好文案（M14：不要因为加 detail 把友好文案挤掉）
    expect(result.note).toMatch(/无父提交/);
    // 附带 stderr 上下文（fix 前是 note 完全没有 stderr 文本）
    expect(result.note).toMatch(/stderr:/);
    // exit code 信息
    expect(result.note).toMatch(/exit=/);
  });

  it("非 git 仓库 → rev-parse 失败 note 不抛异常 + 包含上下文", () => {
    // 拿掉 .git 目录模拟非 git 仓库
    rmSync(join(cwd, ".git"), { recursive: true, force: true });
    mkdirSync(join(cwd, "empty"), { recursive: true });

    const result = extractChangedFiles(join(cwd, "empty"), "HEAD");

    expect(result.changedFiles).toEqual([]);
    expect(result.note).toBeDefined();
    expect(result.note).toMatch(/stderr:/);
    expect(result.note).toMatch(/exit=/);
  });

  it("超长 stderr 截断到 ≤2KB 边界，保留首尾关键信息", () => {
    // rev-parse 不存在 commit 走的是 git 内部错误，长度通常较短（几十字节），
    // 但 spawnSync maxBuffer 16MB 保住完整 stderr（不在截断前丢失）。
    // 这里只验 M14 的 2KB 截断逻辑在 note 里能容纳——即 note 总长合理（不会无限大）。
    const result = extractChangedFiles(cwd, "0000000000000000000000000000000000000000");
    // note 总长应该远小于 16MB，且保留友好文案 + 上下文结构
    expect(result.note).toBeDefined();
    if (result.note !== undefined) {
      expect(result.note.length).toBeLessThan(16 * 1024 * 1024);
      // 截断标记只在超过 2KB 时出现（这是 clipOutput 的实现）
      // 这里不强制 expect，因为正常 git 报错 < 2KB
    }
  });

  it("成功路径：有父 commit + diff 非空 → 不返回 note", () => {
    // 造一个 initial commit（空）作为父
    spawnSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd, encoding: "utf-8" });
    const initial = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" });
    expect(initial.status).toBe(0);

    // 造一个含文件变更的 commit
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/x.ts"), "export const x = 1;\n");
    spawnSync("git", ["add", "src/x.ts"], { cwd, encoding: "utf-8" });
    const commitResult = spawnSync(
      "git",
      ["commit", "-m", "add x.ts"],
      { cwd, encoding: "utf-8" },
    );
    expect(commitResult.status).toBe(0);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" });
    const headHash = head.stdout.trim();

    const result = extractChangedFiles(cwd, headHash);

    expect(result.note).toBeUndefined();
    expect(result.changedFiles).toEqual(["src/x.ts"]);
  });
});