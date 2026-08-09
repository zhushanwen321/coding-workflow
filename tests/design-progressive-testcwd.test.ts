/**
 * progressive design 的 per-wave testCwd 保留回归测试（MF-1）。
 *
 * 背景：design handler 对 unit.plan 做整体替换。progressive 重做 design（design-review
 * 失败后回到 design）时，agent 重提的 input 常不带 testCwd。整体替换会把首次写入的
 * unit.plan.testCwd 覆盖为 undefined → testRunner.run 回退 workspacePath（cli.ts falsy 回退）
 * → monorepo 测试在仓库根跑 → gate 误报失败。
 *
 * 修复：design 对 testCwd 采用「omit 即保留」语义（input.testCwd ?? unit.plan.testCwd），
 * 与 replan 旁路的条件赋值（replan.ts if input.testCwd !== undefined）对齐。
 *
 * 本测试直接调 handleDesign（单元级，不走 CLI 子进程），锁定：
 *   1. 第二次 design 不带 testCwd → unit.plan.testCwd 保留首次值（核心回归保护）
 *   2. 第二次 design 带新 testCwd → 覆盖首次值（显式覆盖语义不变）
 *   3. 首次 design 不带 testCwd → unit.plan.testCwd 仍为 undefined（对照，单次 design 行为不变）
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionUnit } from "../src/core/workunit.js";
import { handleDesign } from "../src/handlers/design.js";
import type { WorkUnitRecord } from "../src/store/schema.js";
import {
  createCwEnv,
  type CwEnv,
  makeValidContract,
  makeValidFile,
  makeValidTask,
  makeValidTestCase,
  makeWaveUnit,
} from "./helpers/env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

/** 从 store 读最新 unit（WorkUnitRecord 索引签名透传 plan，双重断言回到 ExecutionUnit 取 typed WavePlan）。 */
function loadUnit(id: string): ExecutionUnit {
  const r = env.deps.store.load(id);
  return r as unknown as ExecutionUnit;
}

describe("progressive design 的 per-wave testCwd 保留（MF-1）", () => {
  it("第二次 design 不带 testCwd → unit.plan.testCwd 保留首次值", () => {
    const w = makeWaveUnit("tcwd-retain");
    env.deps.store.save(w as unknown as WorkUnitRecord);

    // 第一次 design：带 testCwd（monorepo 子包目录）
    handleDesign(
      w,
      {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
        testCwd: "packages/auth",
      },
      env.deps,
    );
    expect(loadUnit(w.id).plan.testCwd).toBe("packages/auth");

    // 第二次 design（progressive，from=designing 合法）：不带 testCwd
    handleDesign(
      loadUnit(w.id),
      {
        testCases: [makeValidTestCase("TC1"), makeValidTestCase("TC2")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
        // 故意不带 testCwd：验证「omit 即保留」语义
      },
      env.deps,
    );
    // 核心断言：testCwd 不被覆盖为 undefined，保留首次值
    expect(loadUnit(w.id).plan.testCwd).toBe("packages/auth");
  });

  it("第二次 design 带新 testCwd → 覆盖首次值（显式覆盖语义不变）", () => {
    const w = makeWaveUnit("tcwd-override");
    env.deps.store.save(w as unknown as WorkUnitRecord);

    handleDesign(
      w,
      {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
        testCwd: "packages/auth",
      },
      env.deps,
    );

    handleDesign(
      loadUnit(w.id),
      {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
        testCwd: "packages/renderer",
      },
      env.deps,
    );

    expect(loadUnit(w.id).plan.testCwd).toBe("packages/renderer");
  });

  it("首次 design 不带 testCwd → unit.plan.testCwd 仍为 undefined（对照）", () => {
    const w = makeWaveUnit("tcwd-default");
    env.deps.store.save(w as unknown as WorkUnitRecord);

    handleDesign(
      w,
      {
        testCases: [makeValidTestCase("TC1")],
        tasks: [makeValidTask("TK1")],
        files: [makeValidFile("F1")],
        contracts: [makeValidContract("C1")],
        testCommand: "npx vitest run",
        // 单包项目不填 testCwd
      },
      env.deps,
    );

    expect(loadUnit(w.id).plan.testCwd).toBeUndefined();
  });
});
