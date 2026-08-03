/**
 * v1 guidance planning 静态方法论模板 + 三层 ACTION_SCHEMA 基建测试（w1）。
 *
 * 覆盖：
 * - PLANNING_STAGE_TEMPLATES：6 个 key 存在且 goal/constraint 非空
 * - 三层 ACTION_SCHEMA（slice/feature/epic）：关键条目 sourceFilePath/interfaceName 按 IF5 正确
 * - 三层 getSchemaText：对 PlanningUnit input action 不 throw，返回非空字符串
 *
 * 对应 wave topic wave:planning-guidance-templates::planning-templates-and-infra（w1 纯新增基建）。
 */
import { describe, expect, it } from "vitest";

import {
  PLANNING_ACTION_TO_NEXT,
  PLANNING_STAGE_TEMPLATES,
  PLANNING_STATUS_DISPLAY,
} from "../src/guidance/index.js";
import { EPIC_ACTION_SCHEMA, getEpicSchemaText } from "../src/handlers/epic/epic-internal.js";
import {
  FEATURE_ACTION_SCHEMA,
  getFeatureSchemaText,
} from "../src/handlers/feature/feature-internal.js";
import {
  getSliceSchemaText,
  SLICE_ACTION_SCHEMA,
} from "../src/handlers/slice/slice-internal.js";

const PLANNING_ACTIONS = [
  "clarify",
  "plan",
  "design-review",
  "execute",
  "retrospect",
  "closeout",
] as const;

describe("PLANNING_STAGE_TEMPLATES", () => {
  it("6 个 PlanningAction 名为 key，模板齐全", () => {
    for (const action of PLANNING_ACTIONS) {
      expect(PLANNING_STAGE_TEMPLATES[action], `missing key: ${action}`).toBeDefined();
    }
    expect(Object.keys(PLANNING_STAGE_TEMPLATES)).toHaveLength(PLANNING_ACTIONS.length);
  });

  it("每个模板 goal 和 constraint 都是非空字符串", () => {
    for (const action of PLANNING_ACTIONS) {
      const tpl = PLANNING_STAGE_TEMPLATES[action];
      expect(typeof tpl.goal).toBe("string");
      expect(tpl.goal.length).toBeGreaterThan(0);
      expect(typeof tpl.constraint).toBe("string");
      expect(tpl.constraint.length).toBeGreaterThan(0);
    }
  });

  it("plan 模板含 replan 告知（§6 第 1 层）", () => {
    expect(PLANNING_STAGE_TEMPLATES.plan.constraint).toContain("replan");
  });
});

describe("PLANNING_STATUS_DISPLAY / PLANNING_ACTION_TO_NEXT 公共表", () => {
  it("PLANNING_STATUS_DISPLAY 覆盖 8 个 PlanningStatus", () => {
    const statuses = [
      "created",
      "clarifying",
      "planning",
      "design-reviewed",
      "executing",
      "retrospected",
      "closed",
      "aborted",
    ];
    for (const s of statuses) {
      expect(PLANNING_STATUS_DISPLAY[s as keyof typeof PLANNING_STATUS_DISPLAY]).toBeTruthy();
    }
  });

  it("PLANNING_ACTION_TO_NEXT 主链推进正确", () => {
    expect(PLANNING_ACTION_TO_NEXT.clarify).toBe("plan");
    expect(PLANNING_ACTION_TO_NEXT.plan).toBe("design-review");
    expect(PLANNING_ACTION_TO_NEXT["design-review"]).toBe("execute");
    expect(PLANNING_ACTION_TO_NEXT.retrospect).toBe("closeout");
    expect(PLANNING_ACTION_TO_NEXT.execute).toBeUndefined();
    expect(PLANNING_ACTION_TO_NEXT.closeout).toBeUndefined();
    expect(PLANNING_ACTION_TO_NEXT.replan).toBe("plan");
  });
});

describe("slice ACTION_SCHEMA（IF5 映射）", () => {
  it("clarify → ClarifyInput@handlers/types.ts（外层 Input，含包裹 key）", () => {
    expect(SLICE_ACTION_SCHEMA.clarify).toEqual({
      sourceFilePath: "src/handlers/types.ts",
      interfaceName: "ClarifyInput",
    });
  });

  it("plan → PlanSliceInput@plan.ts", () => {
    expect(SLICE_ACTION_SCHEMA.plan).toEqual({
      sourceFilePath: "src/core/plan.ts",
      interfaceName: "PlanSliceInput",
    });
  });

  it("design-review/retrospect/closeout 指向外层 Input 接口（handlers/types.ts）", () => {
    expect(SLICE_ACTION_SCHEMA["design-review"]?.sourceFilePath).toBe("src/handlers/types.ts");
    expect(SLICE_ACTION_SCHEMA["design-review"]?.interfaceName).toBe("DesignReviewInput");
    expect(SLICE_ACTION_SCHEMA.retrospect?.interfaceName).toBe("RetrospectSliceInput");
    expect(SLICE_ACTION_SCHEMA.closeout?.sourceFilePath).toBe("src/handlers/types.ts");
  });

  it("create/execute/replan/abort 无结构化 schema（undefined）", () => {
    expect(SLICE_ACTION_SCHEMA.create).toBeUndefined();
    expect(SLICE_ACTION_SCHEMA.execute).toBeUndefined();
    expect(SLICE_ACTION_SCHEMA.replan).toBeUndefined();
    expect(SLICE_ACTION_SCHEMA.abort).toBeUndefined();
  });
});

describe("feature ACTION_SCHEMA（IF5 映射）", () => {
  it("clarify → FeatureClarifyInput@handlers/types.ts（容器型，含 clarifications+spec）", () => {
    expect(FEATURE_ACTION_SCHEMA.clarify).toEqual({
      sourceFilePath: "src/handlers/types.ts",
      interfaceName: "FeatureClarifyInput",
    });
  });

  it("plan → PlanFeatureInput@plan.ts", () => {
    expect(FEATURE_ACTION_SCHEMA.plan).toEqual({
      sourceFilePath: "src/core/plan.ts",
      interfaceName: "PlanFeatureInput",
    });
  });

  it("design-review/retrospect/closeout 指向外层 Input 接口", () => {
    expect(FEATURE_ACTION_SCHEMA["design-review"]).toEqual(SLICE_ACTION_SCHEMA["design-review"]);
    expect(FEATURE_ACTION_SCHEMA.retrospect?.interfaceName).toBe("RetrospectFeatureInput");
    expect(FEATURE_ACTION_SCHEMA.closeout).toEqual(SLICE_ACTION_SCHEMA.closeout);
  });
});

describe("epic ACTION_SCHEMA（IF5 映射）", () => {
  it("clarify → ClarifyInput@handlers/types.ts（与 slice 同，裸数组）", () => {
    expect(EPIC_ACTION_SCHEMA.clarify).toEqual({
      sourceFilePath: "src/handlers/types.ts",
      interfaceName: "ClarifyInput",
    });
  });

  it("plan → PlanEpicInput@plan.ts（与 feature 同，Plan 基类只 split）", () => {
    expect(EPIC_ACTION_SCHEMA.plan).toEqual({
      sourceFilePath: "src/core/plan.ts",
      interfaceName: "PlanEpicInput",
    });
  });
});

describe("getSchemaText 三层不 throw", () => {
  it("slice getSchemaText 对 input action 返回非空字符串", () => {
    const actions = ["clarify", "plan", "design-review", "retrospect", "closeout"];
    for (const a of actions) {
      const text = getSliceSchemaText(a);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("feature getSchemaText 对 input action 返回非空字符串", () => {
    const actions = ["clarify", "plan", "design-review", "retrospect", "closeout"];
    for (const a of actions) {
      const text = getFeatureSchemaText(a);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("epic getSchemaText 对 input action 返回非空字符串", () => {
    const actions = ["clarify", "plan", "design-review", "retrospect", "closeout"];
    for (const a of actions) {
      const text = getEpicSchemaText(a);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("无 schema 的 action 返回降级/扁平提示文本（不 throw）", () => {
    expect(() => getSliceSchemaText("execute")).not.toThrow();
    expect(() => getFeatureSchemaText("replan")).not.toThrow();
    expect(() => getEpicSchemaText("abort")).not.toThrow();
  });
});
