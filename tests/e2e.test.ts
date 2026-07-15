/**
 * e2e 测试 — E1-E4（真实子进程跑 dist/cli.js）。
 *
 * 测试策略：
 *   - 每个测试用 createE2eEnv 产出独立隔离环境（git init tmp + CW_HOME + 初始 commit）
 *   - 用 spawnSync 真实 node 子进程调 dist/cli.js
 *   - 验证全链路：create → plan → tdd_plan → dev → review → test → retrospect → closeout
 *   - 阶段推进逻辑提取到 tests/helpers/e2e.ts（runCli/parseStdout/setupTo* 系列）
 *
 * 其他 action（clarify/review_fix/test_fix/assess/init/stats/gate-fail）
 * 的 E2E 测试见 e2e-*.test.ts 系列（拆分自本文件）。
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  parseStdout,
  retrospectMdPath,
  reviewMdPath,
  runCli,
  setupToClarifyConfirmed,
  setupToTested,
} from "./helpers/e2e.js";
import { makeValidTestJson } from "./helpers/plan.js";

// ── 共享测试环境 ────────────────────────────────────────────

let e: E2eEnv;

beforeAll(() => {
  e = createE2eEnv();
});

afterAll(() => {
  disposeE2eEnv(e);
});

// ── E1: 全链子进程跑通 ──────────────────────────────────────

describe("E1: create→plan→tdd_plan→dev→review→test→retrospect→closeout 全链子进程跑通", () => {
  it("完整流程走通，最终 status=closed, evidence 写入", () => {
    // 1. create
    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "e1-full", "--objective", "E2E 全链测试", "--workspace", e.workspaceDir],
        e,
      ),
    );
    expect(createResult.status).toBe("created");
    expect(createResult.topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-e1-full$/);
    const topicId = createResult.topicId as string;
    const nextAction = createResult.nextAction as Record<string, unknown>;
    // create 后推荐 clarify
    expect(nextAction.action).toBe("clarify");

    // FR-1: plan 前必须 confirm_clarify（状态机 gate）
    setupToClarifyConfirmed(e, "e1-full", topicId);

    // 2. plan（stdin 传 dev-plan.json，只含 waves）
    const planJson = JSON.stringify({
      format: "lite",
      objective: "E2E 全链测试",
      waves: [{ id: "W1", changes: [{ file: "src/app.ts", description: "实现功能" }], dependsOn: [] }],
    });
    const planResult = parseStdout(
      runCli(["plan", "--topicId", topicId], e, { input: planJson }),
    );
    expect(planResult.status).toBe("planned");
    // plan gate 通过 → 进入 tdd_plan 阶段（不再直接到 dev）
    expect((planResult.nextAction as Record<string, unknown>).action).toBe("tdd_plan");
    // plan 通过后 status=planned，replan 作为 alternative 暴露
    const planAlts = (planResult.nextAction as Record<string, unknown>).alternatives as
      | Array<{ action: string }>
      | undefined;
    expect(planAlts).toBeDefined();
    expect(planAlts![0].action).toBe("replan");

    // 2b. tdd_plan（stdin 传 test.json，含 testCases）
    const testJson = JSON.stringify(makeValidTestJson());
    const tddPlanResult = parseStdout(
      runCli(["tdd_plan", "--topicId", topicId], e, { input: testJson }),
    );
    expect(tddPlanResult.status).toBe("tdd_inited");
    expect((tddPlanResult.nextAction as Record<string, unknown>).action).toBe("dev");

    // 3. dev
    const devResult = parseStdout(
      runCli(
        [
          "dev",
          "--topicId",
          topicId,
          "--tasks",
          JSON.stringify([{ waveId: "W1", commitHash: e.commitHash }]),
        ],
        e,
      ),
    );
    expect(devResult.status).toBe("developed");
    expect(devResult.gatePassed).toMatchObject({ dev: true });
    // dev 全 committed 后 nextAction 指向 review（新状态机插在 dev/test 之间）
    expect((devResult.nextAction as Record<string, unknown>).action).toBe("review");

    // 4. review（需 review.md 文件，写到 .xyz-harness/<slug>/changes/review.md）
    const reviewPath = reviewMdPath(e.workspaceDir, "e1-full");
    mkdirSync(join(e.workspaceDir, ".xyz-harness", "e1-full", "changes"), { recursive: true });
    writeFileSync(reviewPath, "# Code Review\n\n审查通过");
    const reviewResult = parseStdout(
      runCli(
        ["review", "--topicId", topicId, "--reviewPath", reviewPath],
        e,
      ),
    );
    expect(reviewResult.status).toBe("reviewed");
    expect(reviewResult.gatePassed).toMatchObject({ review: true });
    expect((reviewResult.nextAction as Record<string, unknown>).action).toBe("test");

    // 5. test
    const testResult = parseStdout(
      runCli(
        [
          "test",
          "--topicId",
          topicId,
          "--cases",
          JSON.stringify([
            { caseId: "E1", actual: { text: "expected-output" } },
            { caseId: "E2", actual: { text: "real-output" } },
          ]),
        ],
        e,
      ),
    );
    expect(testResult.status).toBe("tested");
    expect(testResult.gatePassed).toMatchObject({ test: true });

    // 6. retrospect（需 retrospect.md 文件）
    const retrospectPath = retrospectMdPath(e.workspaceDir, "e1-full");
    mkdirSync(join(e.workspaceDir, ".xyz-harness", "e1-full"), { recursive: true });
    writeFileSync(retrospectPath, "# Retrospect\n\nE2E 复盘内容");
    const retroResult = parseStdout(
      runCli(
        ["retrospect", "--topicId", topicId, "--retrospect-path", retrospectPath],
        e,
        { input: JSON.stringify({ knownRisks: [], processIssues: [] }) },
      ),
    );
    expect(retroResult.status).toBe("retrospected");
    expect((retroResult.nextAction as Record<string, unknown>).action).toBe("closeout");

    // 7. closeout
    const closeoutResult = parseStdout(
      runCli(["closeout", "--topicId", topicId], e),
    );
    expect(closeoutResult.status).toBe("closed");
    expect(closeoutResult.evidence).toBeDefined();
    const evidence = closeoutResult.evidence as Record<string, unknown>;
    expect(evidence.gateHistory).toBeDefined();
    expect((evidence.gateHistory as unknown[]).length).toBeGreaterThan(0);

    // 8. status 查询验证（只读子命令）
    const statusResult = parseStdout(
      runCli(["status", "--topicId", topicId], e),
    );
    expect(statusResult.status).toBe("closed");
  });
});

// ── E2: dev 阶段渐进式提交 ──────────────────────────────────

describe("E2: dev 阶段渐进式提交（progressive）", () => {
  it("多 wave 分多次 cw dev 调用，第二次 dev 不报 illegal_transition", () => {
    // create + plan（2 个 wave）
    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "e2-progressive", "--objective", "渐进式测试", "--workspace", e.workspaceDir],
        e,
      ),
    );
    const topicId = createResult.topicId as string;

    // FR-1: plan 前必须 confirm_clarify
    setupToClarifyConfirmed(e, "e2-progressive", topicId);

    const planJson = JSON.stringify({
      format: "lite",
      objective: "渐进式测试",
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "wave1" }], dependsOn: [] },
        { id: "W2", changes: [{ file: "src/app.ts", description: "wave2" }], dependsOn: ["W1"] },
      ],
    });
    runCli(["plan", "--topicId", topicId], e, { input: planJson });

    // tdd_plan（test.json 含 testCases，推进到 tdd_inited 才能 dev）
    runCli(["tdd_plan", "--topicId", topicId], e, {
      input: JSON.stringify(makeValidTestJson()),
    });

    // 第一次 dev：只提交 W1
    const dev1 = parseStdout(
      runCli(
        ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W1", commitHash: e.commitHash }])],
        e,
      ),
    );
    expect(dev1.status).toBe("developed");
    expect(dev1.gatePassed).toMatchObject({ dev: false }); // W2 还没提交

    // 第二次 dev：提交 W2（progressive，不应报 illegal_transition）
    const dev2 = parseStdout(
      runCli(
        ["dev", "--topicId", topicId, "--tasks", JSON.stringify([{ waveId: "W2", commitHash: e.commitHash }])],
        e,
      ),
    );
    expect(dev2.status).toBe("developed"); // 原地停留
    expect(dev2.gatePassed).toMatchObject({ dev: true }); // 全部 committed
    // dev 全 committed 后 nextAction 指向 review（新状态机插在 dev/test 之间）
    expect((dev2.nextAction as Record<string, unknown>).action).toBe("review");
  });
});

// ── E3: 非法跳步被拒绝 ──────────────────────────────────────

describe("E3: 非法跳步（created 直接到 test）被拒绝", () => {
  it("exit code 非 0 + stderr 含 illegal_transition", () => {
    const createResult = parseStdout(
      runCli(
        ["create", "--slug", "e3-skip", "--objective", "跳步测试", "--workspace", e.workspaceDir],
        e,
      ),
    );
    const topicId = createResult.topicId as string;

    // created 直接到 test（跳过 plan/dev）
    const result = runCli(
      ["test", "--topicId", topicId, "--cases", JSON.stringify([{ caseId: "E1", actual: {} }])],
      e,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("illegal_transition");
  });
});

// ── 补充：list 只读查询 ─────────────────────────────────────

describe("补充: list 只读查询子命令", () => {
  it("list 返回所有 topic 数组", () => {
    const result = parseStdout(runCli(["list"], e));
    expect(Array.isArray(result)).toBe(true);
    // E1-E4 已创建多个 topic，list 应非空
    expect((result as unknown as Record<string, unknown>[]).length).toBeGreaterThan(0);
  });
});

// ── 补充：db 文件确实落盘 ───────────────────────────────────

describe("补充: db 文件落盘验证", () => {
  it("_cw.json 存在于 CW_HOME 下", () => {
    // 编码后的 cwd 目录应存在 _cw.json
    const findDb = (dir: string): string | null => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = findDb(fullPath);
          if (found) return found;
        } else if (entry.name === "_cw.json") {
          return fullPath;
        }
      }
      return null;
    };
    const dbFile = findDb(e.cwHome);
    expect(dbFile).not.toBeNull();
    // 验证是合法 JSON
    const content = readFileSync(dbFile!, "utf8");
    const data = JSON.parse(content) as { topics: unknown[] };
    expect(data.topics.length).toBeGreaterThan(0);
  });
});

// ── [BUG-HUNT] retrospectPath 指向 topicDir 外 → closeout 依赖链 ──
//
// retrospect gate 要求 retrospectPath 指向存在的文件（可任意位置），
// 但 closeout gate 检查 topicDir（.xyz-harness/<slug>/）目录存在。
// 如果 agent 把 retrospect.md 写到 topicDir 外，retrospect pass 但 closeout 可能 fail。

describe("[BUG-HUNT] retrospectPath 指向 topicDir 外 → closeout 依赖链", () => {
  it("retrospect.md 写到 workspace 根（非 topicDir）→ closeout 行为记录", () => {
    const { topicId } = setupToTested(e, "bh-path-drift");

    // retrospect.md 写到 workspace 根（不在 topicDir 内）
    const rootRetroPath = join(e.workspaceDir, "retrospect.md");
    writeFileSync(rootRetroPath, "# 复盘\n\n写在根目录的复盘");

    const retroResult = parseStdout(
      runCli(
        ["retrospect", "--topicId", topicId, "--retrospect-path", rootRetroPath],
        e,
        { input: JSON.stringify({ knownRisks: [], processIssues: [] }) },
      ),
    );
    expect(retroResult.status).toBe("retrospected");

    // closeout 检查 topicDir——如果 topicDir 不存在则 fail
    const closeoutResult = runCli(["closeout", "--topicId", topicId], e);
    if (closeoutResult.exitCode !== 0) {
      // closeout 失败——retrospect 和 closeout 的路径假设不一致
      expect(closeoutResult.stderr).toBeTruthy();
    }
    // 如果 closeout 成功，说明 topicDir 被其他步骤创建了——无 bug
  });
});
