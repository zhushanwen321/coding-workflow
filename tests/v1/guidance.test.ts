/**
 * v1 guidance 层测试（W3-W6 合并）。
 *
 * 覆盖：
 * - schema-injector：解析 WaveTestCase/WaveTask（枚举值 + extends 补字段 + 可选标注 + 注释）
 * - prefix-builder：有/无 parent
 * - failure-hint：failureCount 1/3/5 + deriveFailureCount
 * - cross-layer：有父有兄弟 / 全终态 / 无 parent（用 createV1Env + makeStubDeps 构造 store）
 * - build-guidance：正常三段式 / 异常四段式结构验证
 *
 * 对应 design-v5-cli-and-guidance §3.4-§3.6、§5.1、§7.3、§9。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionUnit } from "../../src/v1/core/workunit.js";
import { createWave } from "../../src/v1/core/workunit.js";
import { buildFailureGuidance, buildNormalGuidance } from "../../src/v1/guidance/build-guidance.js";
import {
  computeCrossLayerAfterCloseout,
  isTerminalStatus,
} from "../../src/v1/guidance/cross-layer.js";
import { buildFailureHint, deriveFailureCount } from "../../src/v1/guidance/failure-hint.js";
import { buildPrefix } from "../../src/v1/guidance/prefix-builder.js";
import { injectSchema } from "../../src/v1/guidance/schema-injector.js";
import {
  WAVE_PLAN_TEMPLATE,
  WAVE_REPLAN_TEMPLATE,
} from "../../src/v1/guidance/templates/wave.js";
import type { WorkUnitRecord } from "../../src/v1/store/schema.js";
import { createV1Env, STUB_NOW, type V1Env } from "./helpers/v1-env.js";

// ═══════════════════════════════════════════════════════════════
// schema-injector
// ═══════════════════════════════════════════════════════════════

describe("schema-injector: WaveTestCase", () => {
  const schema = injectSchema("src/v1/core/plan.ts", "WaveTestCase");

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
  const schema = injectSchema("src/v1/core/plan.ts", "WaveTask");

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
    const schema = injectSchema("src/v1/core/plan.ts", "WaveFile");
    expect(schema).toContain('"action": "create" | "modify" | "delete"');
    expect(schema).toContain('"path": string');
    expect(schema).toContain('"description": string');
  });

  it("WaveContract 含 type 枚举（6 种）", () => {
    const schema = injectSchema("src/v1/core/plan.ts", "WaveContract");
    expect(schema).toContain(
      '"type": "function" | "api" | "class" | "event" | "schema" | "other"',
    );
  });

  it("Split 含可选字段 inheritedItemIds?（标注）", () => {
    const schema = injectSchema("src/v1/core/plan.ts", "Split");
    expect(schema).toContain('"inheritedItemIds（可选）": string[]');
  });

  it("不存在的 interface → 抛错（fail-fast，不静默返回空）", () => {
    expect(() => injectSchema("src/v1/core/plan.ts", "NotExist")).toThrow(
      /not found/,
    );
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
      status: "clarified",
      parentUnitId: "slice:auth-login",
    });
    expect(prefix).toBe(
      "[wave:auth-w1] 状态：clarified｜父单元：slice:auth-login",
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
});

// ═══════════════════════════════════════════════════════════════
// failure-hint
// ═══════════════════════════════════════════════════════════════

describe("failure-hint: buildFailureHint", () => {
  it("failureCount <= 1 → 空字符串（第 1 次只说问题）", () => {
    expect(buildFailureHint(0)).toBe("");
    expect(buildFailureHint(1)).toBe("");
  });

  it("failureCount == 3 → 含三出口（clarify / replan / abort 重选）", () => {
    const hint = buildFailureHint(3);
    expect(hint).toContain("cw clarify");
    expect(hint).toContain("cw replan");
    expect(hint).toContain("cw abort");
    // 第 3 次不含「强烈建议先 abort」。
    expect(hint).not.toContain("强烈建议");
  });

  it("failureCount == 2 / 4 → 同三出口档位（容差，非死边界）", () => {
    for (const count of [2, 4]) {
      const hint = buildFailureHint(count);
      expect(hint).toContain("cw clarify");
      expect(hint).toContain("cw replan");
      expect(hint).not.toContain("强烈建议");
    }
  });

  it("failureCount >= 5 → 加「强烈建议先 cw abort」一句", () => {
    const hint = buildFailureHint(5);
    expect(hint).toContain("强烈建议先 cw abort");
    expect(hint).toContain("5");
    // 第 7 次同样含强烈建议。
    expect(buildFailureHint(7)).toContain("强烈建议");
  });

  it("负数 → 空字符串（防御性）", () => {
    expect(buildFailureHint(-1)).toBe("");
  });
});

describe("failure-hint: deriveFailureCount", () => {
  it("尾部连续 gate fail 记录 → 计数", () => {
    const history = [
      { action: "plan", note: "ok" },
      { action: "plan", note: "gate fail: testCases empty" },
      { action: "plan", note: "gate fail: testCases empty" },
      { action: "plan", note: "gate fail: still empty" },
    ];
    expect(deriveFailureCount(history, "plan")).toBe(3);
  });

  it("遇到非 gate fail 记录即停止（不跨成功记录累计）", () => {
    const history = [
      { action: "plan", note: "gate fail" },
      { action: "plan", note: "ok passed" },
      { action: "plan", note: "gate fail again" },
    ];
    expect(deriveFailureCount(history, "plan")).toBe(1);
  });

  it("空 history → 0", () => {
    expect(deriveFailureCount([], "plan")).toBe(0);
  });

  it("全部 gate fail → 全部计数", () => {
    const history = [
      { action: "plan", note: "gate fail" },
      { action: "plan", note: "gate fail" },
    ];
    expect(deriveFailureCount(history, "plan")).toBe(2);
  });

  it("无 note 的记录视为非 fail（停止）", () => {
    const history = [
      { action: "plan" },
      { action: "plan", note: "gate fail" },
    ];
    expect(deriveFailureCount(history, "plan")).toBe(1);
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
  let env: V1Env;

  beforeEach(() => {
    env = createV1Env();
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
    prefix: "[wave:auth-w1] 状态：clarified｜父单元：slice:auth-login",
    nextAction: "plan",
    command: "cw plan --unitId wave:auth-w1 --input @plan.json",
    schemaText: '{ "testCases": [...] }',
    templateText: WAVE_PLAN_TEMPLATE.constraint,
  });

  it("含「位置」段 + prefix", () => {
    expect(guidance).toContain("## 位置");
    expect(guidance).toContain("[wave:auth-w1] 状态：clarified");
  });

  it("含「下一步」段 + 命令", () => {
    expect(guidance).toContain("## 下一步");
    expect(guidance).toContain("命令：cw plan --unitId wave:auth-w1 --input @plan.json");
    expect(guidance).toContain("plan");
  });

  it("含「input schema + 关键约束」段 + schema + 约束", () => {
    expect(guidance).toContain("## input schema + 关键约束");
    expect(guidance).toContain('{ "testCases": [...] }');
    // plan 阶段的关键约束（§4.1）
    expect(guidance).toContain("关键约束：testCases 不能为空");
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
      nextAction: "clarify",
      command: "cw clarify --unitId wave:x",
      schemaText: "{}",
      templateText: "",
    });
    expect(g).toContain("## input schema + 关键约束");
    expect(g).toContain("{}");
  });
});

describe("build-guidance: buildFailureGuidance（四段式）", () => {
  it("含「位置 / 问题 / 怎么修」段 + failureHint 非空时含「递进提示」", () => {
    const guidance = buildFailureGuidance({
      prefix: "[wave:auth-w1] 状态：planning（未变）",
      problem: "testCases 为空。design-review gate 要求 testCases 至少 1 条。",
      fixCommand: "cw plan --unitId wave:auth-w1 --input @plan.json",
      failureHint: buildFailureHint(3),
    });

    expect(guidance).toContain("## 位置");
    expect(guidance).toContain("## 问题");
    expect(guidance).toContain("testCases 为空");
    expect(guidance).toContain("## 怎么修");
    expect(guidance).toContain("cw plan --unitId wave:auth-w1 --input @plan.json");
    // failureCount=3 → 含递进提示段。
    expect(guidance).toContain("## 递进提示");
    expect(guidance).toContain("cw clarify");
    expect(guidance).toContain("cw replan");
    expect(guidance).toContain("cw abort");
  });

  it("failureHint 为空（第 1 次）→ 省略「递进提示」段", () => {
    const guidance = buildFailureGuidance({
      prefix: "[wave:auth-w1] 状态：planning（未变）",
      problem: "testCases 为空。",
      fixCommand: "cw plan --unitId wave:auth-w1 --input @plan.json",
      failureHint: buildFailureHint(1),
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
      failureHint: buildFailureHint(5),
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
      failureHint: buildFailureHint(5),
    });
    expect(guidance).toContain("强烈建议先 cw abort");
  });
});

// ═══════════════════════════════════════════════════════════════
// templates/wave（关键约束段验证）
// ═══════════════════════════════════════════════════════════════

describe("templates/wave: 关键约束", () => {
  it("plan 模板含冻结契约关键约束（§4.1）", () => {
    expect(WAVE_PLAN_TEMPLATE.constraint).toBe(
      "关键约束：testCases 不能为空；条目一旦 execute 就被冻结，修改只能走 replan。",
    );
    expect(WAVE_PLAN_TEMPLATE.goal).toContain("执行计划");
  });

  it("replan 模板含「重走 design-review」提示（§6.1 / wave §8.3）", () => {
    expect(WAVE_REPLAN_TEMPLATE.constraint).toContain("重新 design-review");
    expect(WAVE_REPLAN_TEMPLATE.constraint).toContain("plan → design-review → execute");
  });
});
