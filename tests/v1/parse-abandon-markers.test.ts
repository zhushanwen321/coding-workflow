/**
 * parseAbandonMarkers + extractCommitMessage 测试。
 *
 * 真实 git 子进程（tmp 目录 + git init + commit）。
 * 覆盖 TC1-TC4：单 id / 多 id / 无 trailer / commit 不存在。
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  extractCommitMessage,
  parseAbandonMarkers,
} from "../../src/core/git.js";

let repoDir: string;
let commitHash: string;
let commitHashMulti: string;
let commitHashNoTrailer: string;

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8" }).trim();
}

beforeAll(() => {
  repoDir = join(tmpdir(), `cw-abandon-test-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init");
  git(repoDir, "config user.email test@test.com");
  git(repoDir, "config user.name test");

  // commit 1: 含 Cw-Abandon: TC3
  writeFileSync(join(repoDir, "a.txt"), "a");
  git(repoDir, "add a.txt");
  git(repoDir, 'commit -m "feat: implement fetch\n\nCw-Abandon: TC3"');
  commitHash = git(repoDir, "rev-parse HEAD");

  // commit 2: 含 Cw-Abandon: TC3, TC5（多个 id）
  writeFileSync(join(repoDir, "b.txt"), "b");
  git(repoDir, "add b.txt");
  git(repoDir, 'commit -m "feat: more changes\n\nCw-Abandon: TC3, TC5"');
  commitHashMulti = git(repoDir, "rev-parse HEAD");

  // commit 3: 无 trailer
  writeFileSync(join(repoDir, "c.txt"), "c");
  git(repoDir, "add c.txt");
  git(repoDir, 'commit -m "feat: no abandon marker"');
  commitHashNoTrailer = git(repoDir, "rev-parse HEAD");
});

afterAll(() => {
  execSync(`rm -rf "${repoDir}"`, { encoding: "utf-8" });
});

// ═══════════════════════════════════════════════════════════════
// extractCommitMessage
// ═══════════════════════════════════════════════════════════════

describe("extractCommitMessage", () => {
  it("正常 commit → 返回 message body", () => {
    const msg = extractCommitMessage(repoDir, commitHash);
    expect(msg).toContain("Cw-Abandon: TC3");
    expect(msg).toContain("feat: implement fetch");
  });

  it("commit 不存在 → 返回 null", () => {
    const msg = extractCommitMessage(repoDir, "deadbeef00000000000000000000000000000000");
    expect(msg).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// parseAbandonMarkers
// ═══════════════════════════════════════════════════════════════

describe("parseAbandonMarkers", () => {
  it("TC1: 单个 id → ['TC3']", () => {
    const ids = parseAbandonMarkers(repoDir, commitHash);
    expect(ids).toEqual(["TC3"]);
  });

  it("TC2: 多个 id（逗号分隔）→ ['TC3', 'TC5']", () => {
    const ids = parseAbandonMarkers(repoDir, commitHashMulti);
    expect(ids).toEqual(["TC3", "TC5"]);
  });

  it("TC3: 无 trailer → []", () => {
    const ids = parseAbandonMarkers(repoDir, commitHashNoTrailer);
    expect(ids).toEqual([]);
  });

  it("TC4: commit 不存在 → []", () => {
    const ids = parseAbandonMarkers(repoDir, "deadbeef00000000000000000000000000000000");
    expect(ids).toEqual([]);
  });

  it("多个 Cw-Abandon: 行 → 取最后一个", () => {
    // 创建一个含两个 trailer 行的 commit
    writeFileSync(join(repoDir, "d.txt"), "d");
    git(repoDir, "add d.txt");
    git(repoDir, 'commit -m "feat: multi trailer\n\nCw-Abandon: TC1\nCw-Abandon: TC7, TC8"');
    const hash = git(repoDir, "rev-parse HEAD");
    const ids = parseAbandonMarkers(repoDir, hash);
    expect(ids).toEqual(["TC7", "TC8"]);
  });

  it("大小写不敏感：cw-abandon 也匹配（i flag）", () => {
    writeFileSync(join(repoDir, "e.txt"), "e");
    git(repoDir, "add e.txt");
    git(repoDir, 'commit -m "feat: lowercase\n\ncw-abandon: TC1"');
    const hash = git(repoDir, "rev-parse HEAD");
    const ids = parseAbandonMarkers(repoDir, hash);
    // 正则含 i flag，cw-abandon 也匹配
    expect(ids).toEqual(["TC1"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 工厂初始化
// ═══════════════════════════════════════════════════════════════

describe("工厂初始化 abandonedParentItems", () => {
  it("TC5: createWave → abandonedParentItems = []", async () => {
    const { createWave } = await import("../../src/core/workunit.js");
    const wave = createWave({ slug: "test-w1", objective: "test" });
    expect(wave.abandonedParentItems).toEqual([]);
  });

  it("TC6: createSlice → abandonedParentItems = []", async () => {
    const { createSlice } = await import("../../src/core/workunit.js");
    const slice = createSlice({ slug: "test-s1", objective: "test" });
    expect(slice.abandonedParentItems).toEqual([]);
  });
});
