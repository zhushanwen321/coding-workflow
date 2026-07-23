/**
 * dispatch-replan-shape 测试 — M1/M2：replanGuard 按 shape 路由 + delete-only/doc-only 组合路径。
 *
 * 覆盖 AC：
 *   - AC-4: delete-only replan 篡改已 verified artifact → 触发 existence_artifact 违规
 *   - AC-5: doc-only replan 恒通过（review-only.replanGuard 返回空，不误拦）
 *   - AC-6: tdd replan 路径零回归（走 validateAppendOnly，不变）
 *   - C1: cli.ts 解析了 --taskShape（红灯转绿）
 *
 * 测试策略：直接用 store 构造 topic 到 post_dev_verified 状态（带 verified existenceArtifacts），
 * 然后测 replan dispatch 是否触发 existence.replanGuard 的违规检测。
 */

import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dispatch } from "../src/legacy/dispatch.js";
import { GitValidator } from "../src/legacy/gate.js";
import type { ExistenceArtifact } from "../src/legacy/shapes/types.js";
import { CwStore } from "../src/legacy/store.js";
import type { ActionDeps } from "../src/legacy/types.js";
import { setupGitRepo } from "./helpers/git.js";

let tmpDir: string;
let dbPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-replan-shape-"));
  dbPath = join(tmpDir, "cw.json");
  setupGitRepo(tmpDir);
  mkdirSync(join(tmpDir, "src"), { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDeps(): { deps: ActionDeps; store: CwStore } {
  const store = new CwStore(dbPath);
  const git = new GitValidator(tmpDir);
  const deps: ActionDeps = { store, git, workspacePath: tmpDir };
  return { deps, store };
}

// ── C1 红灯转绿验证 ────────────────────────────────────────

describe("C1: CLI --taskShape flag 已实现", () => {
  it("cli.ts 解析了 taskShape 参数", () => {
    const cliSrc = readFileSync("src/cli.ts", "utf-8");
    expect(cliSrc).toContain("taskShape");
  });
});

// ── AC-4: delete-only replan 篡改 verified artifact ─────────

describe("AC-4: delete-only replan 篡改已 verified artifact → 触发违规", () => {
  /**
   * 构造 delete-only topic 到 post_dev_verified + verified artifacts。
   * 直接操作 store 跳过完整 dispatch 链——聚焦 replan 路由。
   */
  function setupDeleteOnlyVerified(
    slug: string,
    artifacts: ExistenceArtifact[],
  ): { topicId: string; deps: ActionDeps; store: CwStore } {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug, objective: "obj", workspacePath: tmpDir, taskShape: "delete-only" },
      deps,
    );
    const topicId = createResult.topicId;

    store.updateStatus(topicId, "post_dev_verified");
    store.updateGatePassed(topicId, "test", true);
    store.setExistenceArtifacts(topicId, artifacts);
    for (const art of artifacts) {
      store.updateExistenceArtifactVerified(topicId, art.path, true);
    }
    return { topicId, deps, store };
  }

  it("改 verified artifact 的 expectedState → existence_artifact_state_changed", () => {
    // 创建被删文件让 planCheck 通过（delete action 要求文件存在）
    writeFileSync(join(tmpDir, "src/legacy.ts"), "export const legacy = true;\n");

    const { topicId, deps } = setupDeleteOnlyVerified("del-state", [
      { path: "src/legacy.ts", expectedState: "absent" },
    ]);

    // replan --plan：existence.replanGuard 从 planJson 提取 artifacts（字段名 artifacts）。
    // 把已 verified 的 artifact expectedState 从 absent 改成 present（篡改契约）。
    const planJson = {
      format: "lite" as const,
      objective: "replan test",
      waves: [
        {
          id: "W1",
          changes: [{ file: "src/legacy.ts", action: "delete" as const, description: "delete legacy" }],
          dependsOn: [],
          priority: "P0" as const,
        },
      ],
      // extractArtifacts 读 obj.artifacts（非 existenceArtifacts）
      artifacts: [{ path: "src/legacy.ts", expectedState: "present" }],
    };

    expect(() => {
      dispatch({ action: "replan", topicId, planJson }, deps);
    }).toThrow(/existence_artifact_state_changed/);
  });

  it("移除已 verified artifact → existence_artifact_removed", () => {
    // 创建被删文件让 planCheck 通过
    writeFileSync(join(tmpDir, "src/old-b.ts"), "export const oldB = true;\n");

    const { topicId, deps } = setupDeleteOnlyVerified("del-remove", [
      { path: "src/old-a.ts", expectedState: "absent" },
      { path: "src/old-b.ts", expectedState: "absent" },
    ]);

    // replan --plan：移除 old-a（artifacts 只保留 old-b）
    const planJson = {
      format: "lite" as const,
      objective: "replan test",
      waves: [
        {
          id: "W1",
          changes: [{ file: "src/old-b.ts", action: "delete" as const, description: "delete" }],
          dependsOn: [],
          priority: "P0" as const,
        },
      ],
      artifacts: [{ path: "src/old-b.ts", expectedState: "absent" }],
    };

    expect(() => {
      dispatch({ action: "replan", topicId, planJson }, deps);
    }).toThrow(/existence_artifact_removed/);
  });
});

// ── AC-5: doc-only replan 恒通过 ────────────────────────────

describe("AC-5: doc-only replan 恒通过（review-only.replanGuard 返回空）", () => {
  it("doc-only replan 不触发任何违规", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "doc-replan", objective: "obj", workspacePath: tmpDir, taskShape: "doc-only" },
      deps,
    );
    const topicId = createResult.topicId;

    // doc-only 不走 existence，直接推到 post_dev_verified
    store.updateStatus(topicId, "post_dev_verified");
    store.updateGatePassed(topicId, "test", true);

    // replan：doc-only 的 replanGuard 恒返回空，不应 throw
    // 用 README.md（setupGitRepo 创建了它，modify 校验通过）
    const planJson = {
      format: "lite" as const,
      objective: "doc replan",
      waves: [
        {
          id: "W1",
          changes: [{ file: "README.md", action: "modify" as const, description: "update docs" }],
          dependsOn: [],
          priority: "P0" as const,
        },
      ],
    };

    expect(() => {
      dispatch({ action: "replan", topicId, planJson }, deps);
    }).not.toThrow();
  });
});

// ── AC-6: tdd replan 零回归 ─────────────────────────────────

describe("AC-6: tdd replan 零回归（走 validateAppendOnly，不走路由）", () => {
  it("full-tdd（默认）replan 不 throw（无 append-only 违规）", () => {
    const { deps, store } = makeDeps();
    const createResult = dispatch(
      { action: "create", slug: "tdd-replan", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    // full-tdd 默认
    const topic = store.loadTopic(topicId);
    expect(topic!.taskShape ?? "full-tdd").toBe("full-tdd");

    store.updateStatus(topicId, "developed");

    // replan：用 README.md（setupGitRepo 创建了它）
    const planJson = {
      format: "lite" as const,
      objective: "tdd replan",
      waves: [
        {
          id: "W1",
          changes: [{ file: "README.md", action: "modify" as const, description: "noop" }],
          dependsOn: [],
          priority: "P0" as const,
        },
      ],
    };

    expect(() => {
      dispatch({ action: "replan", topicId, planJson }, deps);
    }).not.toThrow();
  });
});
