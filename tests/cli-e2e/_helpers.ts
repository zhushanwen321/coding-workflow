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
import type { ActionDeps, CwTopic } from "../../src/engine/types.js";

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

// ── store 种子（绕过 create，直接构造前置状态） ─────────────

/**
 * 插入一个最小 topic，返回 topicId。
 * topicDir 从 workspacePath + slug 推导（与 create.ts 一致）。
 */
export function seedTopic(
  store: CwStore,
  overrides: Partial<CwTopic> & { topicId: string; slug: string; tier: "lite" | "mid" },
): string {
  const workspacePath = overrides.workspacePath ?? "/tmp/ws";
  const topicDir = overrides.topicDir ?? join(workspacePath, ".xyz-harness", overrides.slug);
  const topic: CwTopic = {
    schemaVersion: 1,
    objective: "test objective",
    workspacePath,
    topicDir,
    createdAt: "2026-07-04T00:00:00.000Z",
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    ...overrides,
  };
  store.transaction(() => store.insertTopic(topic));
  return topic.topicId;
}

// ── verdict 常量（GateRunner.runCheck mock 返回值用） ─────────

export const PASS_CHECK = { passed: true, report: "[plan] machine check: 5/5 passed → PASS" };
export const FAIL_CHECK = {
  passed: false,
  report: "[plan] machine check: 3/5 passed → FAIL",
};

// ── JSON fixtures（合法 lite plan.json 结构） ────────────────

export function makeLitePlan(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "lite",
    objective: "build demo feature",
    waves: [
      { id: "W1", changes: ["src/a.ts"], dependsOn: [] },
      { id: "W2", changes: ["src/b.ts"], dependsOn: ["W1"], parallelGroup: "g1" },
    ],
    testCases: [
      {
        id: "E1",
        layer: "real",
        scenario: "用户登录",
        steps: "打开 /login → 提交",
        expected: { url: "/dashboard", text: "欢迎" },
        executor: "vitest",
        requiresScreenshot: true,
      },
    ],
    ...overrides,
  };
}
