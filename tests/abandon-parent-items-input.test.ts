/**
 * ADR-0010 跨层跨时机 abandon parent items 声明通道测试。
 *
 * 覆盖核心契约：design/replan input 的 abandonParentItems 字段被正确 append-only 合并到
 * unit.abandonedParentItems（model §5.6.6）。
 *
 * 四部分：
 * 1. mergeAbandonParentItems 纯函数（单元）：空 input / 单 id / 多 id / 去重 / undefined 安全
 * 2. design handler 集成：slice design（PlanningUnit 代表）+ wave design 通过 input 写入
 * 3. replan handler 集成：slice replan + wave replan 通过 input 写入
 * 4. execute handler trailer 集成：wave execute 解析 commit message 的 Cw-Abandon trailer →
 *    mergeAbandonParentItems 写入 unit.abandonedParentItems（顺便通道，ADR-0010）
 *
 * trailer 的纯函数解析（extractCommitMessage / parseAbandonMarkers）由 parse-abandon-markers.test.ts
 * 覆盖；本文件 Part 4 覆盖 execute handler 端到端集成（trailer → handler → store 落盘）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPrefix } from "../src/guidance/index.js";
import { handleDesign } from "../src/handlers/design.js";
import { handleExecute } from "../src/handlers/execute.js";
import { mergeAbandonParentItems, STATUS_DISPLAY } from "../src/handlers/internal.js";
import { handleReplan } from "../src/handlers/replan.js";
import { handleDesignSlice } from "../src/handlers/slice/design.js";
import { handleReplanSlice } from "../src/handlers/slice/replan.js";
import type { WorkUnitRecord } from "../src/store/schema.js";
import { createCwEnv, type CwEnv,makeValidContract, makeValidFile, makeValidTask, makeValidTestCase, makeWaveUnit } from "./helpers/env.js";
import {
  makeValidSlicePlan,
  setupToSliceDesignReviewed,
} from "./helpers/slice-env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

// ═══════════════════════════════════════════════════════════════
// Part 1: mergeAbandonParentItems 纯函数
// ═══════════════════════════════════════════════════════════════

describe("mergeAbandonParentItems 纯函数", () => {
  it("input 无 abandonParentItems → no-op（unit 不变）", () => {
    const unit: { abandonedParentItems?: string[] } = { abandonedParentItems: ["TC1"] };
    mergeAbandonParentItems(unit, {});
    expect(unit.abandonedParentItems).toEqual(["TC1"]);
  });

  it("input.abandonParentItems = [] → no-op（空数组不触发合并）", () => {
    const unit: { abandonedParentItems?: string[] } = { abandonedParentItems: ["TC1"] };
    mergeAbandonParentItems(unit, { abandonParentItems: [] });
    expect(unit.abandonedParentItems).toEqual(["TC1"]);
  });

  it("input.abandonParentItems = ['TC2'] → 追加到现有 ['TC1']", () => {
    const unit: { abandonedParentItems?: string[] } = { abandonedParentItems: ["TC1"] };
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC2"] });
    expect(unit.abandonedParentItems).toEqual(["TC1", "TC2"]);
  });

  it("重复 id 去重（input 含已有 id）", () => {
    const unit: { abandonedParentItems?: string[] } = { abandonedParentItems: ["TC1"] };
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC1", "TC2"] });
    expect(unit.abandonedParentItems).toEqual(["TC1", "TC2"]);
  });

  it("unit.abandonedParentItems 初始 undefined → 首次写入", () => {
    const unit: { abandonedParentItems?: string[] } = {};
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC1", "TC2"] });
    expect(unit.abandonedParentItems).toEqual(["TC1", "TC2"]);
  });

  it("多次调用累积合并（append-only 语义）", () => {
    const unit: { abandonedParentItems?: string[] } = {};
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC1"] });
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC2"] });
    mergeAbandonParentItems(unit, { abandonParentItems: ["TC3", "TC1"] });
    expect(unit.abandonedParentItems).toEqual(["TC1", "TC2", "TC3"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 2: design handler 集成
// ═══════════════════════════════════════════════════════════════

describe("design handler 通过 input 写入 abandonedParentItems", () => {
  it("slice design input 带 abandonParentItems → unit.abandonedParentItems 被写入", () => {
    const slice = setupToSliceDesignReviewed(env.deps);
    // 先 design-review 通过后回 designing 才能 design progressive（slice design from 含 design-reviewed）
    const designInput = {
      ...makeValidSlicePlan(),
      abandonParentItems: ["FR1", "AC2"],
    };

    handleDesignSlice(slice, designInput, env.deps);

    const reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR1", "AC2"]);
  });

  it("wave design input 带 abandonParentItems → unit.abandonedParentItems 被写入", () => {
    // wave design 需要一个 ExecutionUnit，直接用 helper 构造后 save
    const w = makeWaveUnit("test-wave");
    w.status = "designing";
    env.deps.store.save(w as unknown as WorkUnitRecord);

    handleDesign(
      w,
      {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        abandonParentItems: ["TC-slice-1"],
        testCommand: "npx vitest run",
      },
      env.deps,
    );

    const reloaded = env.deps.store.load(w.id);
    expect(reloaded?.abandonedParentItems).toEqual(["TC-slice-1"]);
  });

  it("slice design 不带 abandonParentItems → unit.abandonedParentItems 保持 [] （工厂初始化值）", () => {
    const slice = setupToSliceDesignReviewed(env.deps);
    const designInput = makeValidSlicePlan();

    handleDesignSlice(slice, designInput, env.deps);

    const reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual([]);
  });

  it("多次 design progressive → abandonParentItems append-only 累积", () => {
    const slice = setupToSliceDesignReviewed(env.deps);

    // 第一次 design 声明脱离 FR1
    handleDesignSlice(
      slice,
      { ...makeValidSlicePlan(), abandonParentItems: ["FR1"] },
      env.deps,
    );
    let reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR1"]);

    // 第二次 design progressive 再声明脱离 AC2 + FR1（去重）
    const reloadedSlice = env.deps.store.load(slice.id) as unknown as Parameters<typeof handleDesignSlice>[0];
    handleDesignSlice(
      reloadedSlice,
      { ...makeValidSlicePlan(), abandonParentItems: ["AC2", "FR1"] },
      env.deps,
    );
    reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR1", "AC2"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 3: replan handler 集成
// ═══════════════════════════════════════════════════════════════

describe("replan handler 通过 input 写入 abandonedParentItems", () => {
  it("slice replan input 带 abandonParentItems → unit.abandonedParentItems 被写入", () => {
    const slice = setupToSliceDesignReviewed(env.deps);

    handleReplanSlice(
      slice,
      {
        abandonedIds: ["TC1"],
        note: "测试 replan 声明脱离",
        abandonParentItems: ["FR-parent-1"],
      },
      env.deps,
    );

    const reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR-parent-1"]);
  });

  it("wave replan input 带 abandonParentItems → unit.abandonedParentItems 被写入", () => {
    const w = makeWaveUnit("test-wave");
    w.status = "design-reviewed";
    // wave replan 需要 plan 有条目可废弃
    w.plan = {
      split: [],
      testCases: [{ ...makeValidTestCase("TC1"), status: "active" as const }],
      tasks: [],
      files: [],
      contracts: [],
    };
    env.deps.store.save(w as unknown as WorkUnitRecord);

    handleReplan(
      w,
      {
        abandonedIds: ["TC1"],
        note: "测试 wave replan 声明脱离",
        abandonParentItems: ["TC-slice-if1"],
      },
      env.deps,
    );

    const reloaded = env.deps.store.load(w.id);
    expect(reloaded?.abandonedParentItems).toEqual(["TC-slice-if1"]);
  });

  it("slice replan 不带 abandonParentItems → unit.abandonedParentItems 保持原值（不被清空）", () => {
    const slice = setupToSliceDesignReviewed(env.deps);
    // 预先有值（模拟之前 design 阶段已声明）
    slice.abandonedParentItems = ["FR1"];
    env.deps.store.save(slice as unknown as WorkUnitRecord);

    handleReplanSlice(
      slice,
      { abandonedIds: ["TC1"], note: "无 abandonParentItems 的 replan" },
      env.deps,
    );

    const reloaded = env.deps.store.load(slice.id);
    expect(reloaded?.abandonedParentItems).toEqual(["FR1"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 4: execute handler trailer 集成
// ═══════════════════════════════════════════════════════════════
//
// wave execute handler 的「顺便通道」（ADR-0010）：从 commit message 解析 Cw-Abandon trailer
// → parseAbandonMarkers → mergeAbandonParentItems 写入 wave.abandonedParentItems。
// parse-abandon-markers.test.ts 覆盖了纯函数解析；这里覆盖 handler 端到端（trailer → handler → store）。

/**
 * 在 env.cwd 造一个 git 仓库 + 含指定 commit message 的 commit，返回 commit hash。
 *
 * 与 env.ts 的 commitWithFiles 区别：后者 message 固定为 "add <files>"，
 * 本 helper 允许自定义 message（用于塞 Cw-Abandon trailer）。
 *
 * @param env    createCwEnv() 产出的环境（cwd = git 仓库工作目录 = deps.workspacePath）
 * @param relPath 本次 commit 新增的文件相对路径（需有文件改动才能 commit）
 * @param content 文件内容
 * @param commitMessage commit message（可含多行 + trailer）
 */
function commitWithMessage(
  env: CwEnv,
  relPath: string,
  content: string,
  commitMessage: string,
): string {
  const cwd = env.cwd;
  // 首次调用初始化仓库
  const isRepo =
    spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf-8" }).status === 0;
  if (!isRepo) {
    spawnSync("git", ["init"], { cwd, encoding: "utf-8" });
    spawnSync("git", ["config", "user.email", "test@cw.local"], { cwd, encoding: "utf-8" });
    spawnSync("git", ["config", "user.name", "cw-test"], { cwd, encoding: "utf-8" });
    // 造一个空的 initial commit 作为父提交（extractChangedFiles 需要 <commit>^ 存在）
    spawnSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd, encoding: "utf-8" });
  }
  const abs = join(cwd, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  spawnSync("git", ["add", relPath], { cwd, encoding: "utf-8" });
  spawnSync("git", ["commit", "-m", commitMessage], { cwd, encoding: "utf-8" });
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" });
  return r.stdout.trim();
}

describe("handleExecute trailer 解析集成（顺便通道）", () => {
  it("commit message 含 Cw-Abandon: TC3 → wave.abandonedParentItems 含 TC3", () => {
    // 1. 造 tmp git repo + 含 trailer 的 commit
    const commitHash = commitWithMessage(
      env,
      "src/feature.ts",
      "export const x = 1;",
      "feat: implement fetch\n\nCw-Abandon: TC3",
    );

    // 2. 建一个 design-reviewed 状态的 wave（execute.from = ["design-reviewed"]）
    const wave = makeWaveUnit("exec-trailer-wave");
    wave.status = "design-reviewed";
    env.deps.store.save(wave as unknown as WorkUnitRecord);

    // 前置：wave.abandonedParentItems 初始空
    expect(
      env.deps.store.load(wave.id)?.abandonedParentItems ?? [],
    ).toEqual([]);

    // 3. 调 handleExecute 传 commitHash（真实 handler：extractChangedFiles + parseAbandonMarkers + mergeAbandonParentItems）
    handleExecute(wave, { commitHash }, env.deps);

    // 4. 断言：trailer 被解析并写入 wave.abandonedParentItems
    const reloaded = env.deps.store.load(wave.id);
    expect(reloaded?.abandonedParentItems).toEqual(["TC3"]);
    // execute 成功推进到 executing
    expect((reloaded as unknown as { status: string }).status).toBe("executing");
  });

  it("commit message 无 Cw-Abandon trailer → wave.abandonedParentItems 保持空", () => {
    const commitHash = commitWithMessage(
      env,
      "src/other.ts",
      "export const y = 2;",
      "feat: regular commit, no abandon marker",
    );

    const wave = makeWaveUnit("exec-no-trailer-wave");
    wave.status = "design-reviewed";
    env.deps.store.save(wave as unknown as WorkUnitRecord);

    handleExecute(wave, { commitHash }, env.deps);

    const reloaded = env.deps.store.load(wave.id);
    expect(reloaded?.abandonedParentItems).toEqual([]);
  });

  it("多个 trailer id（逗号分隔）→ 全部写入并去重", () => {
    const commitHash = commitWithMessage(
      env,
      "src/multi.ts",
      "export const z = 3;",
      "feat: multi abandon\n\nCw-Abandon: TC3, TC5",
    );

    const wave = makeWaveUnit("exec-multi-trailer-wave");
    wave.status = "design-reviewed";
    // 预先有 TC3（验证 append-only 去重，不重复）
    wave.abandonedParentItems = ["TC3"];
    env.deps.store.save(wave as unknown as WorkUnitRecord);

    handleExecute(wave, { commitHash }, env.deps);

    const reloaded = env.deps.store.load(wave.id);
    // TC3 去重 + TC5 新增
    expect(reloaded?.abandonedParentItems).toEqual(["TC3", "TC5"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 5（W3 #12）：wave replan guidance prefix 与 buildPrefix 一致（T3.7）
// ═══════════════════════════════════════════════════════════════

describe("wave replan guidance prefix（#12，T3.7）", () => {
  it("replan 后 guidance prefix 与 buildPrefix 输出一致（STATUS_DISPLAY 中文 + 父单元段）", () => {
    const w = makeWaveUnit("test-wave");
    w.status = "design-reviewed";
    // wave replan 需要 plan 有条目可废弃
    w.plan = {
      split: [],
      testCases: [{ ...makeValidTestCase("TC1"), status: "active" as const }],
      tasks: [],
      files: [],
      contracts: [],
    };
    env.deps.store.save(w as unknown as WorkUnitRecord);

    const result = handleReplan(
      w,
      { abandonedIds: ["TC1"], note: "测试 replan prefix" },
      env.deps,
    );
    const guidance = result.nextAction!.guidance;

    // 与 buildPrefix 输出逐字一致（含 STATUS_DISPLAY 中文映射 + 父单元段）
    const expected = buildPrefix({
      layer: "wave",
      unitId: w.id,
      status: `${STATUS_DISPLAY[w.status]}（replan 后原地）`,
      parentUnitId: w.parentUnitId,
    });
    expect(guidance).toContain(expected);

    // 具体形态：不再是手写内联 [wave:<slug>]（无中文映射、无父单元段）
    expect(guidance).toContain("[wave:test-wave] 状态：已过设计审查（replan 后原地）｜父单元：slice:test-slice");
    // 无旧内联形态残留（英文 status + 无父单元段）
    expect(guidance).not.toContain("[wave:test-wave] 状态：design-reviewed（replan 后原地）");
  });
});
