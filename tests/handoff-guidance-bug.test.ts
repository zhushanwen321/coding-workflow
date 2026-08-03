/**
 * Bug 1 + Bug 2 回归测试（handoff guidance）。
 *
 * Bug 1：cw handoff 的内层 guidance command 曾用 nextAction（错误），外层用当前 action（正确），
 *        自相矛盾。修复后四层 handoff 的「外层 下一步执行」与「内层 命令」都用当前 action。
 * Bug 2：planning 三层（slice/feature/epic）schema 提取在打包环境失败（兜底文本）。
 *        修复后 schemas.gen.json 覆盖四层 + get*SchemaText 缓存优先 + 路径修复。
 *
 * 测试策略（dispatch 层，方式 A）：
 *   - 真实 store + dispatch 建真实 unit（零 mock）。
 *   - 调 renderHandoff（纯函数）拿输出文本，grep 断言「外层 command」与「内层 guidance command」一致。
 *   - 外层：renderNextStepSection 的「下一步执行：cw <action> --unitId <id>」。
 *   - 内层：guidance 段的「命令：cw <action> --unitId <id> --input ...」。
 *
 * Bug 2 复现说明：测试在项目根跑（src 存在），readSchemaText 命中 schemas.gen.json 缓存（dist/guidance/
 *   schemas.gen.json 已存在），故能验证缓存产物含四层条目且非兜底文本。若 dist 不存在则降级 injectSchema
 *   实时解析（src 存在，亦非兜底）。无论哪条路径，handoff 输出都应含真实 schema 字段、不含兜底提示文本。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import { getSchemaGenFilePath } from "../src/guidance/schema-injector.js";
import { getEpicSchemaText } from "../src/handlers/epic/epic-internal.js";
import { getFeatureSchemaText } from "../src/handlers/feature/feature-internal.js";
import { getSliceSchemaText } from "../src/handlers/slice/slice-internal.js";
import { renderHandoff } from "../src/readonly/render.js";
import type { CwEnv } from "./helpers/env.js";
import { createCwEnv, makeValidContract, makeValidFile, makeValidTask, makeValidTestCase } from "./helpers/env.js";
let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

/**
 * 断言 handoff 输出的「外层 command」与「内层 guidance command」都用同一个 action（Bug 1 核心）。
 *
 * 外层：「下一步执行：cw <action> --unitId <id>」（renderNextStepSection，无 --input）。
 * 内层：「命令：cw <action> --unitId <id>」（guidance 段，buildNormalGuidance，带 --input 或无）。
 *
 * 同时断言内层不含「命令：cw <wrongAction>」（Bug 1：曾用 nextAction 导致内层跑在下一步）。
 *
 * @param output   renderHandoff 输出
 * @param unitId   焦点 unit id
 * @param action   期望两层一致的 action（如 "clarify" / "plan"）
 * @param wrongAction  Bug 1 曾误用的 nextAction（如 created→clarify 的 nextAction 是 "plan"）
 */
function expectBothCommandsUseAction(
  output: string,
  unitId: string,
  action: string,
  wrongAction: string,
): void {
  // 外层 command（renderNextStepSection，无 --input）
  expect(output).toContain(`下一步执行：cw ${action} --unitId ${unitId}`);
  // 内层 guidance command（buildNormalGuidance 的「命令：」行）
  expect(output).toContain(`命令：cw ${action} --unitId ${unitId}`);
  // Bug 1 核心：内层不应出现 nextAction 的 command（曾自相矛盾）
  expect(output).not.toContain(`命令：cw ${wrongAction} --unitId ${unitId}`);
}

// ═══════════════════════════════════════════════════════════════
// Bug 1：四层 created 状态 handoff，外层与内层 command 都是 cw clarify（不是 cw plan）
// ═══════════════════════════════════════════════════════════════

describe("Bug 1: 四层 created handoff 外层与内层 command 一致（都用当前 action=clarify）", () => {
  it("wave created: 外层「下一步执行」与内层「命令」都是 cw clarify（不是 cw plan）", () => {
    dispatch(
      { action: "create", input: { slug: "bug1-wave", objective: "wave obj" } },
      env.deps,
    );
    const unitId = "wave:bug1-wave";
    const output = renderHandoff(env.store.load(unitId)!, env.store, "self");

    // created 状态当前 action=clarify，nextAction（Bug 1 曾误用的）也是 clarify（wave clarify 完成后还是 clarify），
    // 故此处 wrongAction 用 "plan" 验证内层不窜到下一个实质阶段。
    expectBothCommandsUseAction(output, unitId, "clarify", "plan");
  });

  it("slice created: 外层与内层 command 都是 cw clarify（不是 cw plan）", () => {
    dispatch(
      { action: "create", input: { slug: "bug1-slice", objective: "slice obj", layer: "slice" } },
      env.deps,
    );
    const unitId = "slice:bug1-slice";
    const output = renderHandoff(env.store.load(unitId)!, env.store, "self");

    // planning 层 created→clarify，nextAction=clarify（仍可追加），但若 Bug 1 复现内层会跳到 nextAction 链下游。
    // wrongAction 用 "plan" 锁定内层不窜到 plan 阶段。
    expectBothCommandsUseAction(output, unitId, "clarify", "plan");
  });

  it("feature created: 外层与内层 command 都是 cw clarify（不是 cw plan）", () => {
    dispatch(
      { action: "create", input: { slug: "bug1-feat", objective: "feat obj", layer: "feature" } },
      env.deps,
    );
    const unitId = "feature:bug1-feat";
    const output = renderHandoff(env.store.load(unitId)!, env.store, "self");

    expectBothCommandsUseAction(output, unitId, "clarify", "plan");
  });

  it("epic created: 外层与内层 command 都是 cw clarify（不是 cw plan）", () => {
    dispatch(
      { action: "create", input: { slug: "bug1-epic", objective: "epic obj", layer: "epic" } },
      env.deps,
    );
    const unitId = "epic:bug1-epic";
    const output = renderHandoff(env.store.load(unitId)!, env.store, "self");

    expectBothCommandsUseAction(output, unitId, "clarify", "plan");
  });
});

// ═══════════════════════════════════════════════════════════════
// Bug 1 续：中间状态（planning）handoff，外层与内层都是 cw plan
// ═══════════════════════════════════════════════════════════════

describe("Bug 1: wave planning handoff 外层与内层 command 都是 cw plan", () => {
  it("wave 走到 planning（create→clarify→plan）后 handoff，两层 command 一致", () => {
    const unitId = "wave:bug1-wplan";
    dispatch(
      { action: "create", input: { slug: "bug1-wplan", objective: "wave obj" } },
      env.deps,
    );
    dispatch(
      { action: "clarify", unitId, input: { clarifications: [] } },
      env.deps,
    );
    dispatch(
      {
        action: "plan",
        unitId,
        input: {
          testCases: [makeValidTestCase("TC1")],
          tasks: [makeValidTask("TK1")],
          files: [makeValidFile("F1")],
          contracts: [makeValidContract("C1")],
        },
      },
      env.deps,
    );
    const unit = env.store.load(unitId)!;
    expect(unit.status).toBe("planning");

    const output = renderHandoff(unit, env.store, "self");
    // planning 状态当前 action=plan，nextAction（Bug 1 曾误用的）=design-review
    expectBothCommandsUseAction(output, unitId, "plan", "design-review");
  });

  it("slice 走到 planning（create→clarify→plan）后 handoff，两层 command 都是 cw plan", () => {
    const unitId = "slice:bug1-splan";
    dispatch(
      { action: "create", input: { slug: "bug1-splan", objective: "slice obj", layer: "slice" } },
      env.deps,
    );
    dispatch(
      { action: "clarify", unitId, input: { clarifications: [] } },
      env.deps,
    );
    dispatch(
      {
        action: "plan",
        unitId,
        input: {
          split: [{ slug: "w1", description: "wave 1", dependsOn: [], inheritedItemIds: [] }],
          techChoices: [], interfaces: [], dataModels: [], errorSpecs: [],
        },
      },
      env.deps,
    );
    const unit = env.store.load(unitId)!;
    expect(unit.status).toBe("planning");

    const output = renderHandoff(unit, env.store, "self");
    // planning 当前 action=plan，nextAction=design-review
    expectBothCommandsUseAction(output, unitId, "plan", "design-review");
  });
});

// ═══════════════════════════════════════════════════════════════
// Bug 2：planning 三层 schema 提取成功（非兜底文本）
// ═══════════════════════════════════════════════════════════════

describe("Bug 2: handoff schema 显示真实结构（非兜底文本「无法从 ... 提取」）", () => {
  it("slice created handoff: schema 含 Clarification 字段（question），不含兜底文本", () => {
    dispatch(
      { action: "create", input: { slug: "bug2-slice", objective: "slice obj", layer: "slice" } },
      env.deps,
    );
    const output = renderHandoff(env.store.load("slice:bug2-slice")!, env.store, "self");

    // Clarification schema 字段（id/question/resolution/type）
    expect(output).toContain("question");
    expect(output).toContain("type");
    // Bug 2 兜底文本（readSchemaText 降级路径）
    expect(output).not.toContain("无法从");
    expect(output).not.toContain("提取");
    expect(output).not.toContain("schema，请检查源文件");
  });

  it("feature created handoff: schema 含 FeatureClarification 容器（spec/functionalRequirements）", () => {
    dispatch(
      { action: "create", input: { slug: "bug2-feat", objective: "feat obj", layer: "feature" } },
      env.deps,
    );
    const output = renderHandoff(env.store.load("feature:bug2-feat")!, env.store, "self");

    // FeatureClarification 容器字段
    expect(output).toContain("spec");
    expect(output).toContain("functionalRequirements");
    expect(output).toContain("acceptanceCriteria");
    // Bug 2 兜底文本
    expect(output).not.toContain("无法从");
  });

  it("epic created handoff: schema 含 Clarification 字段（question），不含兜底文本", () => {
    dispatch(
      { action: "create", input: { slug: "bug2-epic", objective: "epic obj", layer: "epic" } },
      env.deps,
    );
    const output = renderHandoff(env.store.load("epic:bug2-epic")!, env.store, "self");

    expect(output).toContain("question");
    expect(output).not.toContain("无法从");
  });

  it("wave created handoff: schema 含 Clarification 字段（question），不含兜底文本", () => {
    dispatch(
      { action: "create", input: { slug: "bug2-wave", objective: "wave obj" } },
      env.deps,
    );
    const output = renderHandoff(env.store.load("wave:bug2-wave")!, env.store, "self");

    expect(output).toContain("question");
    expect(output).not.toContain("无法从");
  });
});

// ═══════════════════════════════════════════════════════════════
// Bug 2 续：schemas.gen.json 缓存产物覆盖四层 + readSchemaText 缓存命中逻辑
//
// 这组测试直接验证 Bug 2 的修复产物（缓存文件 + get*SchemaText），
// 不依赖 handoff 渲染路径（renderHandoff 内部已调 get*SchemaText，上面已覆盖）。
// ═══════════════════════════════════════════════════════════════

describe("Bug 2: schemas.gen.json 缓存产物覆盖四层 + get*SchemaText 缓存命中", () => {
  // getSchemaGenFilePath 用 import.meta.url 取 schema-injector 自身所在目录再拼 schemas.gen.json。
  // 测试在 src/ 下跑 → 解析到 src/guidance/schemas.gen.json；打包态在 dist/ 下跑 → dist/guidance/。
  // 两种环境下文件未必存在（src/guidance/ 无此文件，dist/guidance/ 有 build 产物），故内容断言按存在性跳过。
  const genPath = getSchemaGenFilePath();
  const hasGenFile = existsSync(genPath);

  it.skipIf(!hasGenFile)("schemas.gen.json 含四层 clarify 条目（wave/slice/feature/epic）", () => {
    const genFile = JSON.parse(readFileSync(genPath, "utf-8")) as Record<
      string,
      { schemaText: string } | undefined
    >;
    // 四层 clarify 缓存 key（Bug 2 修复前 planning 三层缺失）
    expect(genFile["wave:clarify"]?.schemaText).toContain("question");
    expect(genFile["slice:clarify"]?.schemaText).toContain("question");
    expect(genFile["feature:clarify"]?.schemaText).toContain("functionalRequirements");
    expect(genFile["epic:clarify"]?.schemaText).toContain("question");
    // 缓存产物不应是兜底文本（Bug 2 修复前 planning 层降级兜底）
    for (const key of ["wave:clarify", "slice:clarify", "feature:clarify", "epic:clarify"]) {
      expect(genFile[key]?.schemaText).not.toContain("无法从");
    }
  });

  it("slice getSliceSchemaText(clarify) 返回真实 schema（含 question，非兜底）", () => {
    const text = getSliceSchemaText("clarify");
    expect(text).toContain("question");
    expect(text).not.toContain("无法从");
  });

  it("feature getFeatureSchemaText(clarify) 返回 FeatureClarification 容器结构", () => {
    const text = getFeatureSchemaText("clarify");
    expect(text).toContain("spec");
    expect(text).toContain("functionalRequirements");
    expect(text).not.toContain("无法从");
  });

  it("epic getEpicSchemaText(clarify) 返回真实 schema（含 question，非兜底）", () => {
    const text = getEpicSchemaText("clarify");
    expect(text).toContain("question");
    expect(text).not.toContain("无法从");
  });

  it("getSchemaGenFilePath 解析到 guidance/ 目录下的 schemas.gen.json（Bug 2 路径修复：相对自身模块）", () => {
    // Bug 2 路径修复核心：getSchemaGenFilePath 用 dirname(import.meta.url) 取 schema-injector
    // 自身所在目录（src/guidance 或 dist/guidance），而非旧实现「向上两层到项目根再拼 dist/guidance」。
    // 旧路径在打包态（schema-injector.js 在 dist/guidance/）会错误指向 项目根/dist/guidance（不存在）。
    //
    // 测试态（src/）：解析到 <projectRoot>/src/guidance/schemas.gen.json。
    const genDir = dirname(genPath);
    expect(genDir.endsWith("guidance")).toBe(true);
    expect(genPath.endsWith("schemas.gen.json")).toBe(true);
    // 测试态 import.meta.url 解析到 src/guidance/schema-injector.ts，故路径含 src/guidance 段。
    expect(genPath).toContain("src/guidance/schemas.gen.json");
  });

  // ── 直接验证 Bug 2 build 产物（dist/guidance/schemas.gen.json）──
  // 测试态 getSchemaGenFilePath 解析到 src/guidance/（无文件），但 build 产物在 dist/guidance/。
  // 此处绕过 getSchemaGenFilePath，直接读项目根的 dist 缓存，验证 Bug 2 修复（四层覆盖 + 非兜底）。
  // 需先 npm run build 生成产物；未 build 时跳过（不阻断测试，因上面 get*SchemaText 已覆盖降级路径）。
  const distGenPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "guidance", "schemas.gen.json");
  const hasDistGen = existsSync(distGenPath);

  it.skipIf(!hasDistGen)("dist/guidance/schemas.gen.json build 产物含四层 clarify 条目（非兜底）", () => {
    const genFile = JSON.parse(readFileSync(distGenPath, "utf-8")) as Record<
      string,
      { schemaText: string } | undefined
    >;
    // Bug 2 修复前 planning 三层（slice/feature/epic）缺失或降级兜底
    expect(genFile["wave:clarify"]?.schemaText).toContain("question");
    expect(genFile["slice:clarify"]?.schemaText).toContain("question");
    expect(genFile["feature:clarify"]?.schemaText).toContain("functionalRequirements");
    expect(genFile["epic:clarify"]?.schemaText).toContain("question");
    // 全部四层都非兜底文本
    for (const key of ["wave:clarify", "slice:clarify", "feature:clarify", "epic:clarify"]) {
      expect(genFile[key]?.schemaText).not.toContain("无法从");
    }
    // 同步验证 plan 层（planning 三层是 Bug 2 重点）
    expect(genFile["slice:plan"]?.schemaText).toBeDefined();
    expect(genFile["feature:plan"]?.schemaText).toBeDefined();
    expect(genFile["epic:plan"]?.schemaText).toBeDefined();
  });
});
