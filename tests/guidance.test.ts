/**
 * v1 guidance 层测试（W3-W6 合并）。
 *
 * 覆盖：
 * - schema-injector：解析 WaveTestCase/WaveTask（枚举值 + extends 补字段 + 可选标注 + 注释）
 * - prefix-builder：有/无 parent
 * - failure-hint：failureCount 1/3/5 + deriveFailureCount
 * - cross-layer：有父有兄弟 / 全终态 / 无 parent（用 createCwEnv + makeStubDeps 构造 store）
 * - build-guidance：正常三段式 / 异常四段式结构验证
 *
 * 对应 design-v5-cli-and-guidance §3.4-§3.6、§5.1、§7.3、§9。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionUnit } from "../src/core/workunit.js";
import { createWave } from "../src/core/workunit.js";
import { buildFailureGuidance, buildNormalGuidance } from "../src/guidance/build-guidance.js";
import {
  computeCrossLayerAfterCloseout,
  isTerminalStatus,
} from "../src/guidance/cross-layer.js";
import { buildFailureHint, deriveFailureCount } from "../src/guidance/failure-hint.js";
import { buildPrefix } from "../src/guidance/prefix-builder.js";
import { buildSchemaGenFile,injectSchema } from "../src/guidance/schema-injector.js";
import {
  WAVE_DESIGN_TEMPLATE,
  WAVE_REPLAN_TEMPLATE,
} from "../src/guidance/templates/wave.js";
import type { WorkUnitRecord } from "../src/store/schema.js";
import { createCwEnv, type CwEnv,STUB_NOW } from "./helpers/env.js";

// ═══════════════════════════════════════════════════════════════
// schema-injector
// ═══════════════════════════════════════════════════════════════

describe("schema-injector: WaveTestCase", () => {
  const schema = injectSchema("src/core/plan.ts", "WaveTestCase");

  it("含 type 联合枚举值（4 种 test 类型）", () => {
    expect(schema).toContain(
      '"type": "unit" | "integration" | "e2e" | "manual"',
    );
  });

  it("extends WorkUnitItem → 自动补 id + status 字段", () => {
    expect(schema).toContain('"id": string');
    expect(schema).toContain('"status": "active" | "abandoned"');
  });

  it("含所有自有字段（name/scenario/input/expected）", () => {
    expect(schema).toContain('"name": string');
    expect(schema).toContain('"scenario": string');
    expect(schema).toContain('"input": string');
    expect(schema).toContain('"expected": string');
  });

  it("字段上的 JSDoc 注释附在后面（id/status 有注释）", () => {
    // id 字段的 JSDoc「条目唯一标识」应作为行内注释附上。
    expect(schema).toContain("条目唯一标识");
  });

  it("渲染为 markdown schema block（{ 开头 } 结尾）", () => {
    expect(schema.startsWith("{")).toBe(true);
    expect(schema.trim().endsWith("}")).toBe(true);
  });
});

describe("schema-injector: WaveTask", () => {
  const schema = injectSchema("src/core/plan.ts", "WaveTask");

  it("含 type 联合枚举值（6 种 task 类型）", () => {
    expect(schema).toContain(
      '"type": "impl" | "refactor" | "test" | "fix" | "doc" | "other"',
    );
  });

  it("extends WorkUnitItem → 自动补 id + status", () => {
    expect(schema).toContain('"id": string');
    expect(schema).toContain('"status": "active" | "abandoned"');
  });

  it("可选字段 dependsOn? → 标注（可选）", () => {
    expect(schema).toContain('"dependsOn（可选）": string[]');
  });

  it("数组类型字段保留 string[] 形态", () => {
    expect(schema).toContain('"files": string[]');
    expect(schema).toContain('"steps": string[]');
  });
});

describe("schema-injector: 其他 interface", () => {
  it("WaveFile 含 action 枚举（3 种）", () => {
    const schema = injectSchema("src/core/plan.ts", "WaveFile");
    expect(schema).toContain('"action": "create" | "modify" | "delete"');
    expect(schema).toContain('"path": string');
    expect(schema).toContain('"description": string');
  });

  it("WaveContract 含 type 枚举（6 种）", () => {
    const schema = injectSchema("src/core/plan.ts", "WaveContract");
    expect(schema).toContain(
      '"type": "function" | "api" | "class" | "event" | "schema" | "other"',
    );
  });

  it("Split 含可选字段 inheritedItemIds?（标注）", () => {
    const schema = injectSchema("src/core/plan.ts", "Split");
    expect(schema).toContain('"inheritedItemIds（可选）": string[]');
  });

  it("不存在的 interface → 抛错（fail-fast，不静默返回空）", () => {
    expect(() => injectSchema("src/core/plan.ts", "NotExist")).toThrow(
      /not found/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// schema-injector: 跨文件 resolve（A1 — 缺口 1 修复）
// 映射外层 Input 接口后，字段类型（如 DesignReviewJudgment）在另一个文件，
// injectSchema 需跨文件解析 import 并内联展开。
// ═══════════════════════════════════════════════════════════════

describe("schema-injector: 跨文件 resolve（外层 Input 接口）", () => {
  it("DesignReviewInput 含外层包裹 key + 内联展开 DesignReviewJudgment 字段", () => {
    const schema = injectSchema("src/handlers/types.ts", "DesignReviewInput");
    // 外层包裹 key
    expect(schema).toContain('"designReviewJudgment"');
    // 跨文件内联展开（DesignReviewJudgment 在 core/judgments.ts）
    expect(schema).toContain('"necessity"');
    expect(schema).toContain('"sufficiency"');
    expect(schema).toContain('"tradeoffs"');
    expect(schema).toContain('"risks"');
    // 嵌套展开（sufficiency 内的 gaps/overlaps/meceNote）
    expect(schema).toContain('"gaps"');
    expect(schema).toContain('"meceNote"');
  });

  it("DesignInput 含外层 clarifications 包裹 + 内联展开 Clarification 字段", () => {
    const schema = injectSchema("src/core/plan.ts", "DesignInput");
    expect(schema).toContain("clarifications（可选）");
    // Clarification 在 core/clarifications.ts，跨文件展开
    expect(schema).toContain('"question"');
    expect(schema).toContain('"type": "research" | "grilling"');
  });

  it("CloseoutInput 含外层 summary/artifacts 包裹 + 内联展开 ArtifactRef", () => {
    const schema = injectSchema("src/handlers/types.ts", "CloseoutInput");
    expect(schema).toContain('"summary');
    expect(schema).toContain('"artifacts');
    // ArtifactRef 在 core/evidence.ts，跨文件展开
    expect(schema).toContain('"kind"');
    expect(schema).toContain('"ref"');
  });

  it("type alias 穿透：RetrospectEpicInput = RetrospectSliceInput → 含 retrospectData", () => {
    // RetrospectEpicInput 是 type alias（handlers/types.ts），应穿透到 RetrospectSliceInput
    const schema = injectSchema("src/handlers/types.ts", "RetrospectEpicInput");
    expect(schema).toContain('"retrospectData"');
    // PlanningRetrospectData 在 core/judgments.ts，跨文件展开
    expect(schema).toContain('"reviewedItems"');
    expect(schema).toContain('"lessonsLearned"');
  });

  it("TestInput 含外层 testJudgment 包裹 + 内联展开 TestJudgment 字段", () => {
    const schema = injectSchema("src/handlers/types.ts", "TestInput");
    expect(schema).toContain('"testJudgment"');
    expect(schema).toContain('"necessityMet"');
    expect(schema).toContain('"tradeoffCostRealized"');
  });
});

// ═══════════════════════════════════════════════════════════════
// prefix-builder
// ═══════════════════════════════════════════════════════════════

describe("prefix-builder", () => {
  it("有 parent → [layer:unitId] 状态：status｜父单元：parentUnitId", () => {
    const prefix = buildPrefix({
      layer: "wave",
      unitId: "auth-w1",
      status: "designing",
      parentUnitId: "slice:auth-login",
    });
    expect(prefix).toBe(
      "[wave:auth-w1] 状态：designing｜父单元：slice:auth-login",
    );
  });

  it("无 parent → 不含「父单元」段（孤立终点，§1.3）", () => {
    const prefix = buildPrefix({
      layer: "wave",
      unitId: "solo-w1",
      status: "created",
    });
    expect(prefix).toBe("[wave:solo-w1] 状态：created");
    expect(prefix).not.toContain("父单元");
  });

  it("空字符串 parentUnitId 视同无 parent", () => {
    const prefix = buildPrefix({
      layer: "slice",
      unitId: "s1",
      status: "executing",
      parentUnitId: "",
    });
    expect(prefix).toBe("[slice:s1] 状态：executing");
  });

  it("四层 layer 都支持", () => {
    for (const layer of ["epic", "feature", "slice", "wave"] as const) {
      const prefix = buildPrefix({
        layer,
        unitId: "x",
        status: "created",
        parentUnitId: "epic:p",
      });
      expect(prefix).toContain(`[${layer}:x]`);
    }
  });

  // T2.10（#9 prefix 双 layer 修复）：unit.id 自带 scope 前缀（如 "wave:auth"）时，
  // 渲染层剥离 <layer>: 前缀，产出 [wave:auth] 而非 [wave:wave:auth]（AC-4.5）。
  it("unitId 自带 <layer>: 前缀 → 剥离（[wave:auth] 非 [wave:wave:auth]，T2.10）", () => {
    const prefix = buildPrefix({
      layer: "wave",
      unitId: "wave:auth",
      status: "designing",
    });
    expect(prefix).toBe("[wave:auth] 状态：designing");
    expect(prefix).not.toContain("[wave:wave:auth]");
  });

  it("嵌套重复前缀循环剥离（wave:wave:auth → wave:auth）", () => {
    const prefix = buildPrefix({
      layer: "wave",
      unitId: "wave:wave:auth",
      status: "created",
    });
    expect(prefix).toBe("[wave:auth] 状态：created");
  });

  it("非本 layer 的前缀不剥离（只剥 <layer>: 自身前缀）", () => {
    const prefix = buildPrefix({
      layer: "slice",
      unitId: "wave:w1",
      status: "created",
    });
    expect(prefix).toBe("[slice:wave:w1] 状态：created");
  });

  it("带 parent 时剥离后仍含「父单元」段", () => {
    const prefix = buildPrefix({
      layer: "wave",
      unitId: "wave:auth",
      status: "designing",
      parentUnitId: "slice:auth-login",
    });
    expect(prefix).toBe("[wave:auth] 状态：designing｜父单元：slice:auth-login");
  });
});

// ═══════════════════════════════════════════════════════════════
// failure-hint
// ═══════════════════════════════════════════════════════════════

describe("failure-hint: buildFailureHint", () => {
  it("failureCount <= 1 → 空字符串（第 1 次只说问题）", () => {
    expect(buildFailureHint(0, "wave:x", "design", "x")).toBe("");
    expect(buildFailureHint(1, "wave:x", "design", "x")).toBe("");
  });

  it("failureCount == 3，design 类 → 含三出口（design / replan / abort 重选）", () => {
    const hint = buildFailureHint(3, "wave:x", "design", "x");
    expect(hint).toContain("cw design");
    expect(hint).toContain("cw replan");
    expect(hint).toContain("cw abort");
    // 第 3 次不含「强烈建议先 abort」。
    expect(hint).not.toContain("强烈建议");
  });

  it("failureCount == 2 / 4 → 同三出口档位（容差，非死边界）", () => {
    for (const count of [2, 4]) {
      const hint = buildFailureHint(count, "wave:x", "design", "x");
      expect(hint).toContain("cw design");
      expect(hint).toContain("cw replan");
      expect(hint).not.toContain("强烈建议");
    }
  });

  it("failureCount >= 5 → 加「强烈建议先 cw abort」一句", () => {
    const hint = buildFailureHint(5, "wave:x", "design", "x");
    expect(hint).toContain("强烈建议先 cw abort");
    expect(hint).toContain("5");
    // 第 7 次同样含强烈建议。
    expect(buildFailureHint(7, "wave:x", "design", "x")).toContain("强烈建议");
  });

  it("负数 → 空字符串（防御性）", () => {
    expect(buildFailureHint(-1, "wave:x", "design", "x")).toBe("");
  });

  it("命令嵌入真实 unitId，无占位（agent 可直接复制）", () => {
    const hint = buildFailureHint(3, "wave:auth-w1", "design", "auth-w1");
    expect(hint).toContain("--unitId wave:auth-w1");
    expect(hint).not.toContain("<unitId>");
    // 命令不带 v1 前缀（Wave 3 起切断）。
    expect(hint).toContain("cw design");
    expect(hint).toContain("cw replan");
    expect(hint).toContain("cw abort");
  });
});

// ═══════════════════════════════════════════════════════════════
// failure-hint: action-aware 出口（M10）
// ═══════════════════════════════════════════════════════════════

describe("failure-hint: action-aware 出口 (M10)", () => {
  it("design 类失败 → 标准三出口（design / replan / abort 重选）", () => {
    const hint = buildFailureHint(3, "wave:p1", "design", "p1");
    expect(hint).toContain("cw design");
    expect(hint).toContain("cw replan");
    expect(hint).toContain("cw abort");
  });

  it("design-review / execute / test / exec-review / retrospect / closeout 类失败 → 同 design 三出口", () => {
    for (const action of ["design-review", "execute", "test", "exec-review", "retrospect", "closeout"] as const) {
      const hint = buildFailureHint(3, "wave:x", action, "x");
      expect(hint).toContain("cw design");
      expect(hint).toContain("cw replan");
      expect(hint).toContain("cw abort");
    }
  });

  it("replan 类失败 → 不再建议 replan（已是修复手段本身），建议 abort 跳出重建", () => {
    const hint = buildFailureHint(3, "wave:r1", "replan", "r1");
    // replan 阶段连续失败说明这条路不通，不该再让用户重试 replan。
    expect(hint).not.toContain("cw replan");
    expect(hint).toContain("cw abort");
  });

  it("abort 类失败 → 提示确认状态已转 aborted，流程结束", () => {
    const hint = buildFailureHint(3, "wave:a1", "abort", "a1");
    expect(hint).toContain("aborted");
  });

  it("create 类失败 → 建议重试或换更高层创建", () => {
    const hint = buildFailureHint(3, "wave:c1", "create", "");
    expect(hint).toContain("cw create");
  });
});

describe("failure-hint: deriveFailureCount", () => {
  it("尾部连续 gate fail 记录 → 计数", () => {
    const history = [
      { action: "design", note: "ok" },
      { action: "design", note: "gate fail: testCases empty" },
      { action: "design", note: "gate fail: testCases empty" },
      { action: "design", note: "gate fail: still empty" },
    ];
    expect(deriveFailureCount(history, "design")).toBe(3);
  });

  it("遇到非 gate fail 记录即停止（不跨成功记录累计）", () => {
    const history = [
      { action: "design", note: "gate fail" },
      { action: "design", note: "ok passed" },
      { action: "design", note: "gate fail again" },
    ];
    expect(deriveFailureCount(history, "design")).toBe(1);
  });

  it("空 history → 0", () => {
    expect(deriveFailureCount([], "design")).toBe(0);
  });

  it("全部 gate fail → 全部计数", () => {
    const history = [
      { action: "design", note: "gate fail" },
      { action: "design", note: "gate fail" },
    ];
    expect(deriveFailureCount(history, "design")).toBe(2);
  });

  it("无 note 的记录视为非 fail（停止）", () => {
    const history = [
      { action: "design" },
      { action: "design", note: "gate fail" },
    ];
    expect(deriveFailureCount(history, "design")).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// cross-layer
// ═══════════════════════════════════════════════════════════════

describe("cross-layer: isTerminalStatus", () => {
  it("closed / aborted → 终态", () => {
    expect(isTerminalStatus("closed")).toBe(true);
    expect(isTerminalStatus("aborted")).toBe(true);
  });

  it("非终态 status → false", () => {
    expect(isTerminalStatus("created")).toBe(false);
    expect(isTerminalStatus("executing")).toBe(false);
    expect(isTerminalStatus("retrospected")).toBe(false);
  });
});

describe("cross-layer: computeCrossLayerAfterCloseout", () => {
  let env: CwEnv;

  beforeEach(() => {
    env = createCwEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  /** 构造一个指定 status 的 wave record 并 save 到 store。 */
  function saveWaveWithStatus(id: string, status: string, parentUnitId?: string): void {
    const unit = createWave({
      slug: id.replace("wave:", ""),
      objective: `o-${id}`,
      parentUnitId,
      createdAt: STUB_NOW,
    }) as ExecutionUnit;
    // 改 status + 补一条 statusHistory（模拟流转到该状态）。
    unit.status = status as ExecutionUnit["status"];
    unit.statusHistory.push({ at: STUB_NOW, action: "test-action", to: status as ExecutionUnit["status"] });
    env.store.save(unit as unknown as WorkUnitRecord);
  }

  it("无 parent → 返回 undefined（孤立终点，流程结束）", () => {
    saveWaveWithStatus("wave:solo", "closed");
    const result = computeCrossLayerAfterCloseout({
      store: env.store,
      unitId: "wave:solo",
      // 无 parentUnitId
    });
    expect(result).toBeUndefined();
  });

  it("空字符串 parentUnitId 视同无 parent → undefined", () => {
    saveWaveWithStatus("wave:solo2", "closed");
    const result = computeCrossLayerAfterCloseout({
      store: env.store,
      unitId: "wave:solo2",
      parentUnitId: "",
    });
    expect(result).toBeUndefined();
  });

  it("有父有未终态兄弟 → sibling 横向（指向第一个非终态兄弟）", () => {
    const parent = "slice:p1";
    // 当前刚 closeout 的（自身）
    saveWaveWithStatus("wave:w1", "closed", parent);
    // 兄弟：一个已 aborted（跳过），一个未终态（目标），一个已 closed（跳过）
    saveWaveWithStatus("wave:w2", "aborted", parent);
    saveWaveWithStatus("wave:w3", "tested", parent);
    saveWaveWithStatus("wave:w4", "closed", parent);

    const result = computeCrossLayerAfterCloseout({
      store: env.store,
      unitId: "wave:w1",
      parentUnitId: parent,
    });
    expect(result?.kind).toBe("sibling");
    expect(result?.targetUnitId).toBe("wave:w3");
    expect(result?.reason).toContain("wave:w3");
  });

  it("有父全兄弟终态 → ascend 回父单元 retrospect", () => {
    const parent = "slice:p2";
    saveWaveWithStatus("wave:a1", "closed", parent);
    saveWaveWithStatus("wave:a2", "closed", parent);
    saveWaveWithStatus("wave:a3", "aborted", parent);

    const result = computeCrossLayerAfterCloseout({
      store: env.store,
      unitId: "wave:a1",
      parentUnitId: parent,
    });
    expect(result?.kind).toBe("ascend");
    expect(result?.targetUnitId).toBe(parent);
    expect(result?.reason).toContain(parent);
  });

  it("父单元无其他子单元（仅自身）→ ascend 回父单元", () => {
    const parent = "slice:p3";
    saveWaveWithStatus("wave:only", "closed", parent);

    const result = computeCrossLayerAfterCloseout({
      store: env.store,
      unitId: "wave:only",
      parentUnitId: parent,
    });
    // 自身 closeout 后无兄弟 → 全终态 → ascend。
    expect(result?.kind).toBe("ascend");
    expect(result?.targetUnitId).toBe(parent);
  });

  it("aborted 兄弟被跳过（不计为待办）", () => {
    const parent = "slice:p4";
    saveWaveWithStatus("wave:c1", "closed", parent);
    // 唯一兄弟是 aborted → 应跳过 → 视为全终态 → ascend。
    saveWaveWithStatus("wave:c2", "aborted", parent);

    const result = computeCrossLayerAfterCloseout({
      store: env.store,
      unitId: "wave:c1",
      parentUnitId: parent,
    });
    expect(result?.kind).toBe("ascend");
  });
});

// ═══════════════════════════════════════════════════════════════
// build-guidance
// ═══════════════════════════════════════════════════════════════

describe("build-guidance: buildNormalGuidance（三段式）", () => {
  const guidance = buildNormalGuidance({
    prefix: "[wave:auth-w1] 状态：designing｜父单元：slice:auth-login",
    nextAction: "design",
    goal: WAVE_DESIGN_TEMPLATE.goal,
    command: "cw design --unitId wave:auth-w1 --input .cw/auth-w1/design.json",
    schemaText: '{ "testCases": [...] }',
    templateText: WAVE_DESIGN_TEMPLATE.constraint,
  });

  it("含「位置」段 + prefix", () => {
    expect(guidance).toContain("## 位置");
    expect(guidance).toContain("[wave:auth-w1] 状态：designing");
  });

  it("含「下一步」段 + 命令", () => {
    expect(guidance).toContain("## 下一步");
    expect(guidance).toContain("命令：cw design --unitId wave:auth-w1 --input .cw/auth-w1/design.json");
    expect(guidance).toContain("design");
  });

  it("含「input schema + 关键约束」段 + schema + 约束", () => {
    expect(guidance).toContain("## input schema + 关键约束");
    expect(guidance).toContain('{ "testCases": [...] }');
    // design 阶段的关键约束（§4.1）
    expect(guidance).toContain("testCases 不能为空");
    expect(guidance).toContain("冻结");
  });

  it("三段顺序：位置 → 下一步 → schema", () => {
    const posIdx = guidance.indexOf("## 位置");
    const nextIdx = guidance.indexOf("## 下一步");
    const schemaIdx = guidance.indexOf("## input schema");
    expect(posIdx).toBeLessThan(nextIdx);
    expect(nextIdx).toBeLessThan(schemaIdx);
  });

  it("templateText 为空时不输出空约束段", () => {
    const g = buildNormalGuidance({
      prefix: "[wave:x] 状态：s",
      nextAction: "design",
      goal: "澄清需求边界 + 编写执行计划",
      command: "cw design --unitId wave:x",
      schemaText: "{}",
      templateText: "",
    });
    expect(g).toContain("## input schema + 关键约束");
    expect(g).toContain("{}");
  });

  it("schemaText 为空时不渲染 schema block（#1 终态守卫）", () => {
    const g = buildNormalGuidance({
      prefix: "[wave:x] 状态：closed",
      nextAction: "closeout",
      goal: "（closeout 阶段）",
      command: "（当前 closeout 已结束本层流程，无下一步命令）",
      schemaText: "",
      templateText: "",
    });
    expect(g).not.toContain("## input schema + 关键约束");
  });
});

// ═══════════════════════════════════════════════════════════════
// buildSchemaGenFile（T1.5，AC-1.3）：22 keys + 每 key 含外层包裹
// ═══════════════════════════════════════════════════════════════

describe("build-guidance: buildSchemaGenFile（#1，T1.5）", () => {
  it("返回 18 个 ${scope}:${action} keys，每 key 的 schemaText 含外层包裹", () => {
    const gen = buildSchemaGenFile();
    const keys = Object.keys(gen);
    // wave 6（design/design-review/test/exec-review/retrospect/closeout）
    // + slice/feature/epic 各 4（design/design-review/retrospect/closeout）= 18
    expect(keys.length).toBe(18);
    for (const key of keys) {
      expect(key).toMatch(/^(wave|slice|feature|epic):[a-z-]+$/);
      const text = gen[key].schemaText;
      // 每 key schema 含外层包裹（injectSchema 输出 { ... } 结构）
      expect(text.trim().startsWith("{"), `${key} 缺外层 {`).toBe(true);
      expect(text.trim().endsWith("}"), `${key} 缺外层 }`).toBe(true);
    }
    // 四层覆盖抽查：wave:design / slice:design / feature:retrospect / epic:closeout
    expect(gen["wave:design"]).toBeDefined();
    expect(gen["slice:design"]).toBeDefined();
    expect(gen["feature:retrospect"]).toBeDefined();
    expect(gen["epic:closeout"]).toBeDefined();
  });
});

describe("build-guidance: buildFailureGuidance（四段式）", () => {
  it("含「位置 / 问题 / 怎么修」段 + failureHint 非空时含「递进提示」", () => {
    const guidance = buildFailureGuidance({
      prefix: "[wave:auth-w1] 状态：designing（未变）",
      problem: "testCases 为空。design-review gate 要求 testCases 至少 1 条。",
      fixCommand: "cw design --unitId wave:auth-w1 --input .cw/auth-w1/design.json",
      failureHint: buildFailureHint(3, "wave:auth-w1", "design", "auth-w1"),
    });

    expect(guidance).toContain("## 位置");
    expect(guidance).toContain("## 问题");
    expect(guidance).toContain("testCases 为空");
    expect(guidance).toContain("## 怎么修");
    expect(guidance).toContain("cw design --unitId wave:auth-w1 --input .cw/auth-w1/design.json");
    // failureCount=3 → 含递进提示段。
    expect(guidance).toContain("## 递进提示");
    expect(guidance).toContain("cw design");
    expect(guidance).toContain("cw replan");
    expect(guidance).toContain("cw abort");
  });

  it("failureHint 为空（第 1 次）→ 省略「递进提示」段", () => {
    const guidance = buildFailureGuidance({
      prefix: "[wave:auth-w1] 状态：designing（未变）",
      problem: "testCases 为空。",
      fixCommand: "cw design --unitId wave:auth-w1 --input .cw/auth-w1/design.json",
      failureHint: buildFailureHint(1, "wave:auth-w1", "design", "auth-w1"),
    });

    expect(guidance).toContain("## 位置");
    expect(guidance).toContain("## 问题");
    expect(guidance).toContain("## 怎么修");
    expect(guidance).not.toContain("## 递进提示");
  });

  it("段顺序：位置 → 问题 → 怎么修 →（递进提示）", () => {
    const guidance = buildFailureGuidance({
      prefix: "[wave:x] 状态：s",
      problem: "p",
      fixCommand: "cmd",
      failureHint: buildFailureHint(5, "wave:x", "design", "x"),
    });
    const posIdx = guidance.indexOf("## 位置");
    const problemIdx = guidance.indexOf("## 问题");
    const fixIdx = guidance.indexOf("## 怎么修");
    const hintIdx = guidance.indexOf("## 递进提示");
    expect(posIdx).toBeLessThan(problemIdx);
    expect(problemIdx).toBeLessThan(fixIdx);
    expect(fixIdx).toBeLessThan(hintIdx);
  });

  it("failureCount=5 → 递进提示含「强烈建议先 cw abort」", () => {
    const guidance = buildFailureGuidance({
      prefix: "[wave:x] 状态：s",
      problem: "p",
      fixCommand: "cmd",
      failureHint: buildFailureHint(5, "wave:x", "design", "x"),
    });
    expect(guidance).toContain("强烈建议先 cw abort");
  });
});

// ═══════════════════════════════════════════════════════════════
// templates/wave（关键约束段验证）
// ═══════════════════════════════════════════════════════════════

describe("templates/wave: 关键约束", () => {
  it("design 模板含冻结契约关键约束（§4.1）", () => {
    // constraint 只保留纯阶段约束——subagent 调度提示已抽离到 subagent-guidance.ts
    // （由 buildNextAction 经 buildSubagentGuidance 生成，渲染为 guidance 第 4 段）。
    expect(WAVE_DESIGN_TEMPLATE.constraint).toContain("testCases 不能为空");
    expect(WAVE_DESIGN_TEMPLATE.constraint).toContain("冻结");
    expect(WAVE_DESIGN_TEMPLATE.constraint).toContain("replan");
    // 验证 subagent 文案已从 constraint 剥离干净
    expect(WAVE_DESIGN_TEMPLATE.constraint).not.toContain("subagent");
    expect(WAVE_DESIGN_TEMPLATE.goal).toContain("执行计划");
  });

  it("design 模板含 abandonParentItems 提示（ADR-0010 补充，schema 缺口修复）", () => {
    // design 阶段也告知 abandonParentItems 选项——设计阶段发现 parent 条目不适用就该声明，
    // 不必等到 execute。CLI 用法 + append-only 性质必须在 constraint 里点明。
    expect(WAVE_DESIGN_TEMPLATE.constraint).toContain("abandonParentItems");
    expect(WAVE_DESIGN_TEMPLATE.constraint).toContain("--abandonParentItems");
    expect(WAVE_DESIGN_TEMPLATE.constraint).toContain("append-only");
  });

  it("replan 模板含「重走 design-review」提示（§6.1 / wave §8.3）", () => {
    expect(WAVE_REPLAN_TEMPLATE.constraint).toContain("重新 design-review");
    expect(WAVE_REPLAN_TEMPLATE.constraint).toContain("design → design-review → execute");
    // replan constraint 也不应含 subagent 文案
    expect(WAVE_REPLAN_TEMPLATE.constraint).not.toContain("subagent");
  });

  it("design 模板含 testCommand 必填约束（per-wave testCommand 改造 §4.4）", () => {
    expect(WAVE_DESIGN_TEMPLATE.constraint).toContain("testCommand 必须填");
    expect(WAVE_DESIGN_TEMPLATE.constraint).toContain("严禁跑全量");
    expect(WAVE_DESIGN_TEMPLATE.constraint).toContain("npx vitest run");
  });

  it("replan 模板含纯 testCommand 补充旁路提示（§4.6）", () => {
    expect(WAVE_REPLAN_TEMPLATE.constraint).toContain("纯 testCommand 补充");
    expect(WAVE_REPLAN_TEMPLATE.constraint).toContain("跳过「重做 design-review」");
  });
});
