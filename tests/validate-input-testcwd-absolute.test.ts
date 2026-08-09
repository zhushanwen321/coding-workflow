/**
 * wave2 testCwd 收紧测试：design/replan input 拒绝绝对路径 testCwd（ADR-0014 决策 4）。
 *
 * 覆盖 .cw/store-repo-level-keying-testcwd-reject-absolute/design.json 的 TC1-TC5：
 *   - TC1: design 绝对路径 testCwd → CwError 拒绝
 *   - TC2: design 相对路径 testCwd（packages/auth）→ 通过
 *   - TC3: design 缺省 testCwd → 通过
 *   - TC4: replan 绝对路径 testCwd → CwError 拒绝
 *   - TC5: guidance 文案含禁止绝对路径提示（wave.ts / create.ts 源文件字符串断言，manual）
 *
 * 零 mock：validateInput 纯函数单测（核心 TC1-TC4）+ dispatch 集成走真实 CwStore + tmp 目录
 * （验证校验在 handler mutation 之前抛出，store 无脏写）。
 *
 * 背景：wave1（store 归一化，commit a90e8e8）后 store 跨 worktree 共享，绝对路径 testCwd
 * 在别的 worktree（仓库根路径不同）解析失败。本测试守护 ADR-0014 决策 4 的机器拒绝规则。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CwError } from "../src/core/errors.js";
import { dispatch } from "../src/dispatch.js";
import type { ExecutionUnit } from "../src/core/workunit.js";
import type { DesignInput } from "../src/handlers/types.js";
import { validateInput, type HandlerLayer } from "../src/handlers/validate-input.js";
import { createCwEnv, type CwEnv, makeValidTestCase } from "./helpers/env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAVE_TEMPLATE_SRC = join(__dirname, "..", "src", "guidance", "templates", "wave.ts");
const CREATE_HANDLER_SRC = join(__dirname, "..", "src", "handlers", "create.ts");

/** 合法 design input 基底（testCwd 由各 case 覆盖）。 */
function validDesignBase() {
  return {
    testCases: [makeValidTestCase()],
    tasks: [],
    files: [],
    contracts: [],
    testCommand: "npx vitest run",
  };
}

/** 合法 replan input 基底。 */
function validReplanBase() {
  return { abandonedIds: [], note: "补充 testCwd" };
}

// ── TC1-TC4：validateInput 纯函数（核心机器拒绝规则）──

describe("testCwd 绝对路径拒绝（ADR-0014 决策 4）— validateInput 纯函数", () => {
  it("TC1: design testCwd 绝对路径 → CwError，消息含 input.testCwd 前缀 + 禁止绝对路径 + ADR-0014 + 原值", () => {
    let caught: unknown;
    try {
      validateInput("design", "wave", {
        ...validDesignBase(),
        testCwd: "/abs/path/pkg",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    const msg = (caught as CwError).message;
    expect(msg.startsWith("input.testCwd"), `消息前缀应为 input.testCwd，实际: ${msg}`).toBe(true);
    expect(msg).toContain("禁止绝对路径");
    expect(msg).toContain("/abs/path/pkg");
    expect(msg).toContain("ADR-0014");
  });

  it("TC2: design testCwd 相对路径 packages/auth → 放行", () => {
    expect(() =>
      validateInput("design", "wave", { ...validDesignBase(), testCwd: "packages/auth" }),
    ).not.toThrow();
  });

  it("TC2b: design testCwd ./pkg 与嵌套相对路径 → 放行（不误拦 ./ 前缀与多级相对路径）", () => {
    expect(() =>
      validateInput("design", "wave", { ...validDesignBase(), testCwd: "./pkg" }),
    ).not.toThrow();
    expect(() =>
      validateInput("design", "wave", { ...validDesignBase(), testCwd: "packages/auth/src" }),
    ).not.toThrow();
  });

  it("TC3: design 不传 testCwd（缺省，单包项目）→ 放行", () => {
    expect(() => validateInput("design", "wave", validDesignBase())).not.toThrow();
  });

  it("TC4: replan testCwd 绝对路径 → CwError，文案与 TC1 同源", () => {
    let caught: unknown;
    try {
      validateInput("replan", "wave", { ...validReplanBase(), testCwd: "/abs" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    const msg = (caught as CwError).message;
    expect(msg.startsWith("input.testCwd")).toBe(true);
    expect(msg).toContain("禁止绝对路径");
    expect(msg).toContain("ADR-0014");
  });

  it("TC4b: replan testCwd 相对路径 / 缺省 → 放行", () => {
    expect(() =>
      validateInput("replan", "wave", { ...validReplanBase(), testCwd: "packages/auth" }),
    ).not.toThrow();
    expect(() => validateInput("replan", "wave", validReplanBase())).not.toThrow();
  });

  it("TC4c: replan 四层（wave/slice/feature/epic）绝对 testCwd 都拒绝——共用 ReplanInputSchema", () => {
    const layers: HandlerLayer[] = ["wave", "slice", "feature", "epic"];
    for (const layer of layers) {
      let caught: unknown;
      try {
        validateInput("replan", layer, { ...validReplanBase(), testCwd: "/abs" });
      } catch (e) {
        caught = e;
      }
      expect(caught, `${layer} replan 绝对 testCwd 应抛 CwError`).toBeInstanceOf(CwError);
    }
  });

  it("slice/feature/epic design 不含 testCwd 字段：传 testCwd 由 schema additionalProperties 拒绝（不进 isAbsolute 分支）", () => {
    // 这些层 design schema 无 testCwd 字段，absoluteProperties:false 会先拦——验证 isAbsolute 逻辑不误介入。
    // 传相对 testCwd 同样被 schema 拒（字段未声明），与 isAbsolute 无关。
    expect(() =>
      validateInput("design", "slice", { split: [], testCwd: "packages/auth" }),
    ).toThrowError(CwError);
  });
});

// ── dispatch 集成：校验在 handler mutation 之前抛出，store 无脏写 ──

describe("dispatch 集成：design 绝对 testCwd 在 handler 入口被拒（TC1 端到端）", () => {
  let env: CwEnv;

  beforeEach(() => {
    env = createCwEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("design 绝对 testCwd → CwError，unit 仍 created 空态（plan 未写入）", () => {
    const unitId = dispatch(
      {
        action: "create",
        input: { slug: "abs-test", objective: "abs path guard", layer: "wave" },
      },
      env.deps,
    ).unitId;

    expect(() =>
      dispatch(
        {
          action: "design",
          unitId,
          input: { ...validDesignBase(), testCwd: "/abs" } as unknown as DesignInput,
        },
        env.deps,
      ),
    ).toThrowError(CwError);

    // 校验在 validateInput（handler 首行，mutation 之前）抛出 → store 无 plan 写入，仍是 created 空态。
    const reloaded = env.store.load(unitId) as ExecutionUnit | null;
    expect(reloaded, "unit 应仍存在（create 已落盘）").not.toBeNull();
    expect(reloaded?.status).toBe("created");
    expect(reloaded?.plan.testCases.length ?? 0).toBe(0);
  });
});

// ── TC5：guidance 文案含禁止绝对路径提示（manual，退化为源文件字符串断言）──

describe("TC5: guidance 文案告知禁止绝对路径（wave.ts / create.ts）", () => {
  it("wave.ts 含「禁止绝对路径」提示（design + replan 模板各一处）", () => {
    const src = readFileSync(WAVE_TEMPLATE_SRC, "utf8");
    expect(src).toContain("禁止绝对路径");
    // design 模板与 replan 模板都补了该提示——至少出现 2 次。
    const hits = src.match(/禁止绝对路径/g)?.length ?? 0;
    expect(hits, `wave.ts 应至少 2 处「禁止绝对路径」（design + replan），实际 ${hits}`).toBeGreaterThanOrEqual(2);
  });

  it("create.ts TEST_RUNNER_HINT 含「禁止绝对路径」提示", () => {
    const src = readFileSync(CREATE_HANDLER_SRC, "utf8");
    expect(src).toContain("禁止绝对路径");
  });
});
