/**
 * 共享 plan.json / test.json 测试 helper —— makeValidPlanJson / makeValidTestJson。
 *
 * 从 dispatch.test.ts（makeValidPlanJson）和 gate.test.ts（makePlanJson）提取。
 * 两份实现结构一致（format=lite + waves + mock+real testCases），只是
 * scenario/steps/expected 文本不同——通过 overrides 参数控制。
 *
 * 新流程（W4 起）：
 *   - makeValidPlanJson：dev-plan.json 格式（含 testCases 作为旧格式兼容字段）。
 *     新格式 dev-plan.json 可不含 testCases（用 makeValidDevPlanJson）。
 *   - makeValidDevPlanJson：纯 dev-plan.json（只有 waves，不含 testCases）。
 *   - makeValidTestJson：test.json 格式（testCases + 可选 testRunner）。
 */
export function makeValidPlanJson(
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    format: "lite",
    objective: "test objective",
    waves: [{ id: "W1", changes: ["change1"], dependsOn: [] }],
    testCases: [
      {
        id: "E1",
        layer: "mock",
        scenario: "单测场景",
        steps: "执行单测",
        expected: { text: "expected-output" },
        executor: "vitest",
        requiresScreenshot: false,
      },
      {
        id: "E2",
        layer: "real",
        scenario: "集成场景",
        steps: "执行集成测试",
        expected: { text: "real-output" },
        executor: "vitest",
        requiresScreenshot: false,
      },
    ],
    ...overrides,
  };
}

/**
 * 纯 dev-plan.json（新格式，只含 waves，不含 testCases）。
 * testCases 在 tdd_plan 阶段通过 test.json 单独提交。
 */
export function makeValidDevPlanJson(
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    format: "lite",
    objective: "test objective",
    waves: [{ id: "W1", changes: ["change1"], dependsOn: [] }],
    ...overrides,
  };
}

/**
 * test.json 格式（testCases + 可选 testRunner）。
 * mock + real 分层齐全，expected.text 非模糊值，能过 tddPlanCheck。
 */
export function makeValidTestJson(
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    testCases: [
      {
        id: "E1",
        layer: "mock",
        scenario: "单测场景",
        steps: "执行单测",
        expected: { text: "expected-output" },
        executor: "vitest",
        requiresScreenshot: false,
      },
      {
        id: "E2",
        layer: "real",
        scenario: "集成场景",
        steps: "执行集成测试",
        expected: { text: "real-output" },
        executor: "vitest",
        requiresScreenshot: false,
      },
    ],
    ...overrides,
  };
}

