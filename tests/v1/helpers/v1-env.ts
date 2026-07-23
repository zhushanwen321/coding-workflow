/**
 * v1 测试基建 — 隔离环境 + stub V1Deps + wave unit 工厂 + 合法产物工厂。
 *
 * 零 mock 框架：
 *   - V1Store 用 mkdtemp 临时目录 + V1_HOME 环境变量隔离（真实文件 IO，不用 InMemoryStore）
 *   - V1Deps 是手写 stub 对象（gitValidator/testRunner/fileExists/clock 是外部依赖注入接口，
 *     不是 v1 内部代码——spec 明确允许 stub）
 *
 * 每个 createV1Env() 产出独立隔离的环境，cleanup() 清理临时目录 + 还原 V1_HOME。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestRunResult } from "../../../src/v1/core/evidence.js";
import type {
  DesignReviewJudgment,
  ExecReviewJudgment,
  RetrospectData,
  TestJudgment,
} from "../../../src/v1/core/judgments.js";
import type {
  WaveContract,
  WaveFile,
  WaveTask,
  WaveTestCase,
} from "../../../src/v1/core/plan.js";
import type {
  ExecutionUnit,
} from "../../../src/v1/core/workunit.js";
import { createWave } from "../../../src/v1/core/workunit.js";
import type { V1Deps } from "../../../src/v1/handlers/types.js";
import { V1Store } from "../../../src/v1/store/v1-store.js";

/** stub clock 固定返回的 ISO 时间（确定性测试）。 */
export const STUB_NOW = "2026-07-22T00:00:00.000Z";

/** V1Env：一次隔离测试环境的全部句柄。 */
export interface V1Env {
  cwd: string;
  v1Home: string;
  store: V1Store;
  deps: V1Deps;
  /** 清理临时目录 + 还原 V1_HOME。 */
  cleanup: () => void;
}

/**
 * 创建独立隔离的 v1 测试环境。
 *
 * - mkdtemp 临时目录作为 cwd（也作为 V1_HOME）
 * - 设置 process.env.V1_HOME 指向临时目录（getV1JsonPath 读它做 per-cwd 隔离）
 * - 构造真实 V1Store（走真实文件 IO）
 * - 构造 stub V1Deps（gitValidator/testRunner/fileExists 始终成功，clock 固定时间）
 *
 * 注意：V1_HOME 是进程级环境变量，并行测试会互相干扰。本 helper 通过 beforeEach
 * 串行创建 + cleanup 还原避免泄漏（vitest 默认测试文件内 it 串行）。
 */
export function createV1Env(): V1Env {
  const root = mkdtempSync(join(tmpdir(), "cw-v1-test-"));
  const cwd = join(root, "cwd");
  const v1Home = join(root, "v1home");
  mkdtempSync(v1Home); // 占位目录，V1Store 会 mkdirSync

  const prevV1Home = process.env.V1_HOME;
  process.env.V1_HOME = v1Home;

  const store = new V1Store(cwd);
  const deps = makeStubDeps(store);

  const cleanup = (): void => {
    if (prevV1Home === undefined) {
      delete process.env.V1_HOME;
    } else {
      process.env.V1_HOME = prevV1Home;
    }
    rmSync(root, { recursive: true, force: true });
  };

  return { cwd, v1Home, store, deps, cleanup };
}

/**
 * 构造 stub V1Deps（手写对象，非 mock 框架）。
 *
 * - gitValidator.exists：始终 true（测试不依赖真实 git）
 * - testRunner.run：返回固定 passed 结果
 * - fileExists.exists：始终 true（closeout drift 检查）
 * - clock.now：返回固定 ISO 时间
 */
export function makeStubDeps(store: V1Store): V1Deps {
  return {
    store,
    gitValidator: { exists: (_hash: string) => true },
    testRunner: {
      run: (_unit: ExecutionUnit): TestRunResult => ({
        passed: true,
        passedCount: 1,
        failedCount: 0,
      }),
    },
    fileExists: { exists: (_ref: string) => true },
    clock: { now: () => STUB_NOW },
  };
}

/**
 * 构造一个 wave unit（用于测试，初始 status=created）。
 */
export function makeWaveUnit(
  slug: string,
  basedOnParent: string[] = [],
): ExecutionUnit {
  return createWave({
    slug,
    objective: `objective for ${slug}`,
    parentUnitId: "slice:test-slice",
    basedOnParent,
    createdAt: STUB_NOW,
  });
}

// ═══════════════════════════════════════════════════════════════
// 合法产物工厂（构造能通过 gate 的 input，e2e / evidence 测试复用）
// ═══════════════════════════════════════════════════════════════

/** 合法的 WaveTestCase（expected 非空，过 design-review gate）。 */
export function makeValidTestCase(id = "TC1"): WaveTestCase {
  return {
    id,
    status: "active",
    name: `test case ${id}`,
    scenario: "happy path",
    input: "given x",
    expected: "returns y",
    type: "unit",
  };
}

/** 合法的 WaveTask。 */
export function makeValidTask(id = "TK1"): WaveTask {
  return {
    id,
    status: "active",
    type: "impl",
    files: ["src/foo.ts"],
    steps: ["write foo"],
  };
}

/** 合法的 WaveFile。 */
export function makeValidFile(id = "F1"): WaveFile {
  return {
    id,
    status: "active",
    path: "src/foo.ts",
    action: "create",
    description: "foo module",
  };
}

/** 合法的 WaveContract。 */
export function makeValidContract(id = "C1"): WaveContract {
  return {
    id,
    status: "active",
    name: "foo",
    type: "function",
    definition: "function foo(): void",
  };
}

/**
 * 合法的 DesignReviewJudgment（过 5 个 judgment gate）。
 * 含 1 个 tradeoff（id="TF1"）+ 1 个 risk（id="RK1"），便于 test/retrospect 覆盖引用。
 */
export function makeValidDesignReviewJudgment(): DesignReviewJudgment {
  return {
    necessity: "this wave delivers the core auth flow",
    sufficiency: {
      gaps: [],
      overlaps: [],
      meceNote: "MECE: covers login + token refresh, no overlap",
    },
    alternatives: "considered session-based auth, rejected for scaling",
    tradeoffs: [
      { id: "TF1", decision: "JWT over session", reason: "stateless", cost: "harder to revoke" },
    ],
    risks: [
      { id: "RK1", item: "token leak", severity: "medium", mitigation: "short TTL" },
    ],
  };
}

/**
 * 合法的 TestJudgment（对照 makeValidDesignReviewJudgment，过 test gate 的引用一致性）。
 * 覆盖 TF1 / RK1 引用。
 */
export function makeValidTestJudgment(): TestJudgment {
  return {
    necessityMet: "yes, core flow verified",
    sufficiencyMet: {
      gapsConfirmed: [],
      gapsNewlyFound: [],
      overlapsConfirmed: [],
    },
    alternativesReconsidered: "session auth still worse at scale",
    tradeoffCostRealized: [
      { tradeoffRef: "TF1", costRealized: true, note: "revocation via blacklist added" },
    ],
    riskOutcome: [
      { riskRef: "RK1", outcome: "mitigated", note: "TTL=15min" },
    ],
  };
}

/** 合法的 ExecReviewJudgment（overallVerdict=pass，过 4 个 gate）。 */
export function makeValidExecReviewJudgment(): ExecReviewJudgment {
  return {
    readability: { score: 4 },
    architecture: { score: 4 },
    overallVerdict: "pass",
  };
}

/** 合法的 ExecReviewJudgment（needs-followup + 带 followupActions，过 gate）。 */
export function makeNeedsFollowupExecReviewJudgment(): ExecReviewJudgment {
  return {
    readability: { score: 3 },
    architecture: { score: 3 },
    overallVerdict: "needs-followup",
    followupActions: [
      {
        description: "extract token service",
        priority: "medium",
        targetScope: "current-wave-replan",
      },
    ],
  };
}

/**
 * 合法的 RetrospectData（过 2 个 gate）。
 * reviewedItems 覆盖 necessity/sufficiency/alternatives + TF1/RK1。
 */
export function makeValidRetrospectData(): RetrospectData {
  return {
    reviewedItems: [
      { itemId: "necessity", outcome: "fulfilled" },
      { itemId: "sufficiency", outcome: "fulfilled" },
      { itemId: "alternatives", outcome: "fulfilled" },
      { itemId: "TF1", outcome: "fulfilled" },
      { itemId: "RK1", outcome: "fulfilled", note: "TTL=15min" },
    ],
    lessonsLearned: "TDD red-green flow caught an edge case in token refresh",
  };
}
