/**
 * _helpers.ts — 测试共享 helpers（搬迁自 pi-coding-workflow actions/__tests__/_helpers.ts）。
 *
 * 真实 CwStore（临时 db 文件）+ vi.spyOn 原型方法控制 GateRunner/GitValidator。
 * 不以 .test.ts 结尾，vitest 不会当测试文件跑，仅供 import。
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, vi } from "vitest";

import { GateRunner, GitValidator } from "../../src/engine/gates.js";
import { CwStore } from "../../src/engine/store.js";
import type { ActionDeps } from "../../src/engine/types.js";

// ── 临时目录管理 ─────────────────────────────────────────────

const tmpDirsToClean: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirsToClean.length > 0) {
    const d = tmpDirsToClean.pop();
    try {
      rmSync(d!, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  }
});

/** 建一个临时目录（含 changes/ 子目录），返回绝对路径。 */
export function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-cli-test-"));
  tmpDirsToClean.push(dir);
  mkdirSync(join(dir, "changes"), { recursive: true });
  return dir;
}

/** 用真实 CwStore + 真实 GateRunner/GitValidator 构造 ActionDeps。 */
export function makeDeps(workspacePath: string): { deps: ActionDeps; store: CwStore } {
  const store = new CwStore(join(workspacePath, "_cw.json"));
  const deps: ActionDeps = {
    store,
    git: new GitValidator(workspacePath),
    runner: new GateRunner(workspacePath),
    workspacePath,
  };
  return { deps, store };
}

/** 关掉 store（兜底释放可能残留的文件锁）。 */
export function closeStore(store: CwStore): void {
  store.close();
}
