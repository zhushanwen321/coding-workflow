/**
 * C2 frontier 计算 e2e 测试 — 直接调 computeFrontier（纯函数 + store 接口）。
 *
 * computeFrontier(rootUnitId, store) 两遍扫描算法：
 *   - Pass 1：递归收集整棵子树，过滤终态，算 nextAction。
 *   - Pass 2：算 blocked + dependsOn：
 *       - 类型 A（planning 层 executing）：子层有未终态 → blocked。
 *       - 类型 B（wave 层）：经父 slice 的 split.dependsOn + childDelivery 反查依赖 wave，
 *         依赖 wave 未终态 → blocked。
 *
 * 5 个用例（FTC1-5）覆盖：
 *   - FTC1：类型 A blocked（slice executing + 子层 wave 未终态）
 *   - FTC2a：类型 B blocked（w2 dependsOn w1，w1 未终态）
 *   - FTC2b：类型 B 解除（w1 closed → w2 不 blocked，但 dependsOn 字段仍输出）
 *   - FTC3：root 不存在 → 防御性空 nodes
 *   - FTC4：root 是 wave（叶子）→ 单节点
 *   - FTC5：全终态树 → nodes=[]
 *
 * 约束：零 mock——真实 CwStore（mkdtemp tmp 目录）+ stub CwDeps（外部依赖注入接口），
 * 走 dispatch 真实建 unit + 推进。w1 推到 closed 用 advanceWaveToClosed（走完 wave 9 步，非改 store）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { FrontierNode } from "../src/core/frontier.js";
import { computeFrontier } from "../src/core/frontier.js";
import { dispatch } from "../src/dispatch.js";
import type { CwEnv } from "./helpers/env.js";
import { createCwEnv } from "./helpers/env.js";
import {
  advanceWaveToClosed,
  makeRetrospectDataFromStore,
  makeValidSliceDesignReviewJudgment,
  makeValidSlicePlan,
} from "./helpers/slice-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

/**
 * slice execute 的 dispatch 参数（无 input，handler 忽略；CwParams execute 分支锁 ExecuteInput，故断言）。
 * 复用 slice-dispatch-e2e.test.ts 的同款 helper。
 */
function sliceExecute(unitId: string): Parameters<typeof dispatch>[0] {
  return { action: "execute", unitId, input: {} } as unknown as Parameters<typeof dispatch>[0];
}

/**
 * 建 slice 带 split，走完 design → design-review → execute（拆出 child wave，slice=executing）。
 *
 * 返回 { sliceId, waveIds }（waveIds 按 split 顺序，id 形如 wave:<sliceSlug>::<waveSlug>）。
 *
 * @param sliceSlug  slice slug（决定 slice.id 和 child wave id 前缀）
 * @param split      design input 的 split（每项 { slug, description, dependsOn, inheritedItemIds }）
 */
function setupSliceExecuting(
  sliceSlug: string,
  split: { slug: string; description: string; dependsOn: string[]; inheritedItemIds: string[] }[],
): { sliceId: string; waveIds: string[] } {
  const sliceId = `slice:${sliceSlug}`;
  dispatch(
    { action: "create", input: { slug: sliceSlug, objective: "o", layer: "slice" } },
    env.deps,
  );
  // design 合并原 clarify + plan
  dispatch(
    {
      action: "design",
      unitId: sliceId,
      input: { ...makeValidSlicePlan(), split },
    },
    env.deps,
  );
  dispatch(
    {
      action: "design-review",
      unitId: sliceId,
      input: { designReviewJudgment: makeValidSliceDesignReviewJudgment() },
    },
    env.deps,
  );
  const execute = dispatch(sliceExecute(sliceId), env.deps);
  expect(execute.ok).toBe(true);
  expect(execute.status).toBe("executing");

  // child wave id 形如 wave:<sliceSlug>::<waveSlug>，按 split 顺序（与 executeResult.childUnitIds 一致）。
  const waveIds = split.map((s) => `wave:${sliceSlug}::${s.slug}`);
  // 交叉验证：dispatch 返回的 children.unitId 与我们推算的 id 一致。
  expect(execute.children!.map((c) => c.unitId)).toEqual(waveIds);
  return { sliceId, waveIds };
}

/** 从 nodes 按 unitId 取单个 node（找不到则抛错，断言用）。 */
function findNode(nodes: FrontierNode[], unitId: string): FrontierNode {
  const node = nodes.find((n) => n.unitId === unitId);
  if (node === undefined) {
    throw new Error(`node not found in frontier: ${unitId}; got: ${nodes.map((n) => n.unitId).join(", ")}`);
  }
  return node;
}

// ═══════════════════════════════════════════════════════════════
// FTC1：类型 A blocked（slice executing + 子层 wave 未终态）
// ═══════════════════════════════════════════════════════════════

describe("FTC1：类型 A blocked（planning executing + 子层未终态）", () => {
  it("slice executing + 2 wave created → slice blocked，2 wave 不 blocked（nextAction=design，dependsOn=[]）", () => {
    const { sliceId, waveIds } = setupSliceExecuting("ftc1", [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
      { slug: "w2", description: "wave 2", dependsOn: [], inheritedItemIds: ["DM1"] },
    ]);
    const [w1Id, w2Id] = waveIds;

    const result = computeFrontier(sliceId, env.store);

    // slice 在 nodes：scope=slice, status=executing, blocked=true, blockedReason 含「子层有未终态」
    const sliceNode = findNode(result.nodes, sliceId);
    expect(sliceNode.scope).toBe("slice");
    expect(sliceNode.status).toBe("executing");
    expect(sliceNode.nextAction).toBe("retrospect");
    expect(sliceNode.blocked).toBe(true);
    expect(sliceNode.blockedReason).toMatch(/子层有未终态/);
    // childUnitIds 含 2 个 wave id
    expect(sliceNode.childUnitIds).toEqual([w1Id, w2Id]);

    // w1 / w2 在 nodes：blocked=false, nextAction=design, dependsOn=[]（无依赖）
    const w1Node = findNode(result.nodes, w1Id);
    expect(w1Node.scope).toBe("wave");
    expect(w1Node.status).toBe("created");
    expect(w1Node.nextAction).toBe("design");
    expect(w1Node.blocked).toBe(false);
    expect(w1Node.blockedReason).toBeUndefined();
    expect(w1Node.dependsOn).toEqual([]);
    expect(w1Node.parentUnitId).toBe(sliceId);

    const w2Node = findNode(result.nodes, w2Id);
    expect(w2Node.blocked).toBe(false);
    expect(w2Node.dependsOn).toEqual([]);

    // 总节点数 = 1 slice + 2 wave
    expect(result.nodes).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// FTC2：类型 B blocked（wave dependsOn wave）—— 核心用例（致命缺陷 2 回归保护）
// ═══════════════════════════════════════════════════════════════

describe("FTC2a：类型 B blocked（w2 dependsOn w1，w1 未终态）", () => {
  it("w1 仍在 created → w2 blocked=true，dependsOn=[w1Id]，blockedReason 含「依赖」", () => {
    const { sliceId, waveIds } = setupSliceExecuting("ftc2a", [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
      { slug: "w2", description: "wave 2", dependsOn: ["w1"], inheritedItemIds: ["DM1"] },
    ]);
    const [w1Id, w2Id] = waveIds;

    const result = computeFrontier(sliceId, env.store);

    // w1：无依赖，不 blocked
    const w1Node = findNode(result.nodes, w1Id);
    expect(w1Node.blocked).toBe(false);
    expect(w1Node.dependsOn).toEqual([]);
    expect(w1Node.status).toBe("created");
    expect(w1Node.nextAction).toBe("design");

    // w2：dependsOn w1，w1 未终态 → blocked
    const w2Node = findNode(result.nodes, w2Id);
    expect(w2Node.blocked).toBe(true);
    expect(w2Node.dependsOn).toEqual([w1Id]);
    expect(w2Node.blockedReason).toMatch(/依赖/);
    expect(w2Node.blockedReason).toContain(w1Id);

    // slice 仍 blocked（类型 A：子层有未终态）
    const sliceNode = findNode(result.nodes, sliceId);
    expect(sliceNode.blocked).toBe(true);
  });
});

describe("FTC2b：类型 B 解除（w1 closed → w2 不 blocked，但 dependsOn 仍输出）", () => {
  it("w1 推到 closed（走完 wave 9 步）→ w2 blocked=false，dependsOn=[w1Id] 仍输出，w1 不在 nodes（终态过滤）", () => {
    const { sliceId, waveIds } = setupSliceExecuting("ftc2b", [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
      { slug: "w2", description: "wave 2", dependsOn: ["w1"], inheritedItemIds: ["DM1"] },
    ]);
    const [w1Id, w2Id] = waveIds;

    // 把 w1 走到 closed（走完 wave 8 步：design→design-review→execute→test→exec-review→retrospect→closeout）
    advanceWaveToClosed(env.deps, w1Id);
    expect(env.store.load(w1Id)?.status).toBe("closed");

    const result = computeFrontier(sliceId, env.store);

    // w1 已终态 → 不出现在 nodes
    expect(result.nodes.find((n) => n.unitId === w1Id)).toBeUndefined();

    // w2：依赖 w1 已终态 → 不 blocked；但 dependsOn 字段始终输出（按 split.dependsOn 反查，与终态无关）
    const w2Node = findNode(result.nodes, w2Id);
    expect(w2Node.blocked).toBe(false);
    expect(w2Node.blockedReason).toBeUndefined();
    expect(w2Node.dependsOn).toEqual([w1Id]);

    // slice：w1 已 closed，但 w2 仍 created（未终态）→ slice 仍 blocked（类型 A）
    const sliceNode = findNode(result.nodes, sliceId);
    expect(sliceNode.blocked).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// FTC3：root 不存在 → 防御性空 nodes
// ═══════════════════════════════════════════════════════════════

describe("FTC3：root 不存在 → 防御性空 nodes", () => {
  it("computeFrontier('slice:nonexistent', store) → nodes=[]，rootUnitId 回显", () => {
    const result = computeFrontier("slice:nonexistent", env.store);
    expect(result.rootUnitId).toBe("slice:nonexistent");
    expect(result.nodes).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// FTC3-cli：cli 层 cw frontier --root <不存在> → exit 1 + stderr
// （补 FTC3 未覆盖的 cli 层链路：src/cli.ts runReadonly frontier 分支 throw CwError）
// ═══════════════════════════════════════════════════════════════

// spawn 真实 cw 子进程模式（自包含，同 e2e-handoff.test.ts / cli.test.ts，不跨文件复用 runCwCli）。
const __cliFilename = fileURLToPath(import.meta.url);
const __cliDirname = dirname(__cliFilename);
const CLI_PATH = join(__cliDirname, "..", "dist", "cli.js");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** spawn `node dist/cli.js frontier --root <id>`，返回 exitCode/stdout/stderr。 */
function runFrontierCli(rootUnitId: string, cwHome: string): CliResult {
  const result = spawnSync("node", [CLI_PATH, "frontier", "--root", rootUnitId], {
    env: { ...process.env, CW_HOME: cwHome, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
    cwd: cwHome,
    timeout: 30000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("FTC3-cli：cw frontier --root <不存在> → exit 1 + stderr", () => {
  // 共享一个隔离的 CW_HOME（空 store，保证 rootUnitId 不存在）。
  let cwHome: string;

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`dist/cli.js 不存在，请先 npm run build。路径: ${CLI_PATH}`);
    }
    cwHome = realpathSync(mkdtempSync(join(tmpdir(), "cw-frontier-cli-home-")));
  });

  afterAll(() => {
    rmSync(cwHome, { recursive: true, force: true });
  });

  it("cw frontier --root slice:nonexistent → exit 1 + stderr 含 'unit not found'", () => {
    const result = runFrontierCli("slice:nonexistent", cwHome);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unit not found");
    expect(result.stderr).toContain("slice:nonexistent");
  });
});

// ═══════════════════════════════════════════════════════════════
// FTC4：root 是 wave（叶子）→ 单节点视图
// ═══════════════════════════════════════════════════════════════

describe("FTC4：root 是 wave（叶子）→ 单节点视图", () => {
  it("computeFrontier(waveId, store) → nodes 含该 wave（blocked=false，dependsOn=[]）", () => {
    const { waveIds } = setupSliceExecuting("ftc4", [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
    ]);
    const [w1Id] = waveIds;

    // 以 wave 为根：只收集它自身（wave 是叶子，findChildren 返回空），无依赖。
    const result = computeFrontier(w1Id, env.store);
    expect(result.rootUnitId).toBe(w1Id);
    expect(result.nodes).toHaveLength(1);

    const node = result.nodes[0]!;
    expect(node.unitId).toBe(w1Id);
    expect(node.scope).toBe("wave");
    expect(node.status).toBe("created");
    expect(node.nextAction).toBe("design");
    expect(node.blocked).toBe(false);
    expect(node.dependsOn).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// FTC5：全终态树 → nodes=[]
// ═══════════════════════════════════════════════════════════════

describe("FTC5：全终态树 → nodes=[]", () => {
  it("w1/w2 closed + slice closed → 所有节点终态 → nodes=[]", () => {
    const { sliceId, waveIds } = setupSliceExecuting("ftc5", [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
      { slug: "w2", description: "wave 2", dependsOn: [], inheritedItemIds: ["DM1"] },
    ]);
    const [w1Id, w2Id] = waveIds;

    // 两个 wave 都走到 closed
    advanceWaveToClosed(env.deps, w1Id);
    advanceWaveToClosed(env.deps, w2Id);

    // slice 走到 closed：retrospect → closeout
    dispatch(
      {
        action: "retrospect",
        unitId: sliceId,
        input: { retrospectData: makeRetrospectDataFromStore(env.deps, sliceId) },
      },
      env.deps,
    );
    dispatch({ action: "closeout", unitId: sliceId, input: { artifacts: [] } }, env.deps);
    expect(env.store.load(sliceId)?.status).toBe("closed");

    // 全终态 → frontier 空
    const result = computeFrontier(sliceId, env.store);
    expect(result.nodes).toEqual([]);
  });
});

describe("FTC6：replan 后 frontier 输出 lastStatusHistoryAction（后备检测信号）", () => {
  it("replan 后该节点 lastStatusHistoryAction === 'replan'，其他节点仍是各自 action", () => {
    const { sliceId, waveIds } = setupSliceExecuting("ftc6", [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
      { slug: "w2", description: "wave 2", dependsOn: [], inheritedItemIds: ["DM1"] },
    ]);
    const [w1Id] = waveIds;

    // replan 废弃 IF1 → w1 被 abort（级联），w2 保留
    dispatch(
      { action: "replan", unitId: sliceId, input: { abandonedIds: ["IF1"], note: "方案要改" } },
      env.deps,
    );

    // replan 后 frontier：slice 的 lastStatusHistoryAction='replan'
    const result = computeFrontier(sliceId, env.store);
    const sliceNode = result.nodes.find((n) => n.unitId === sliceId);
    expect(sliceNode).toBeDefined();
    expect(sliceNode!.lastStatusHistoryAction).toBe("replan");

    // w1 被 abort（终态，不在 nodes 里）
    expect(result.nodes.find((n) => n.unitId === w1Id)).toBeUndefined();

    // w2 保留，其 lastStatusHistoryAction 是 'create'（被 execute 创建时的 action）
    const w2Node = result.nodes.find((n) => n.unitId === waveIds[1]);
    expect(w2Node).toBeDefined();
    expect(w2Node!.lastStatusHistoryAction).toBe("create");
  });

  it("未 replan 的节点 lastStatusHistoryAction 反映最近 action（非 'replan'）", () => {
    const { sliceId } = setupSliceExecuting("ftc6b", [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
    ]);

    // 走到 executing，没 replan → lastStatusHistoryAction='execute'
    const result = computeFrontier(sliceId, env.store);
    const sliceNode = result.nodes.find((n) => n.unitId === sliceId);
    expect(sliceNode!.lastStatusHistoryAction).toBe("execute");
  });
});

describe("T3.1：frontier 聚合字段 advanceableCount/blockedCount（#10，W3，AC-4.1）", () => {
  it("blocked 节点计数 = blockedCount，可推进节点计数 = advanceableCount，两者之和 = nodes.length", () => {
    // slice executing + 2 wave：w1 created（可推进）、w2 dependsOn w1（blocked）
    const { sliceId, waveIds } = setupSliceExecuting("ftc-aggr", [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
      { slug: "w2", description: "wave 2", dependsOn: ["w1"], inheritedItemIds: ["DM1"] },
    ]);
    const [w1Id] = waveIds;

    const result = computeFrontier(sliceId, env.store);
    expect(result.nodes.length).toBeGreaterThan(0);

    // 按 nodes 分类计数与聚合字段一致（一次 reduce 的等价断言）
    const expectedAdvanceable = result.nodes.filter((n) => !n.blocked).length;
    const expectedBlocked = result.nodes.filter((n) => n.blocked).length;
    expect(result.advanceableCount).toBe(expectedAdvanceable);
    expect(result.blockedCount).toBe(expectedBlocked);
    expect(result.advanceableCount + result.blockedCount).toBe(result.nodes.length);

    // 具体值：w2 blocked（依赖 w1 未完成）、slice executing 但子层未终态 → blocked、
    // w1 created → 可推进。至少 blockedCount >= 1 且 advanceableCount >= 1
    expect(result.advanceableCount).toBeGreaterThanOrEqual(1);
    expect(result.blockedCount).toBeGreaterThanOrEqual(1);

    // w2 节点的 blocked=true（依赖 w1）
    const w2Node = result.nodes.find((n) => n.unitId === waveIds[1]);
    expect(w2Node!.blocked).toBe(true);
    expect(w1Id).toBeDefined();
  });

  it("全终态树 → nodes=[] 且两个聚合字段均为 0", () => {
    const { sliceId } = setupSliceExecuting("ftc-aggr2", [
      { slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: ["IF1"] },
    ]);
    // 所有 child wave closed + slice closeout（复用 FTC5 模式）
    const waveIds = env.store.findChildren(sliceId).map((c) => c.id);
    for (const wid of waveIds) {
      advanceWaveToClosed(env.deps, wid);
    }
    dispatch(
      {
        action: "retrospect",
        unitId: sliceId,
        input: { retrospectData: makeRetrospectDataFromStore(env.deps, sliceId) },
      },
      env.deps,
    );
    dispatch({ action: "closeout", unitId: sliceId, input: { artifacts: [] } }, env.deps);

    const result = computeFrontier(sliceId, env.store);
    expect(result.nodes).toEqual([]);
    expect(result.advanceableCount).toBe(0);
    expect(result.blockedCount).toBe(0);
  });
});
