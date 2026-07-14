/**
 * 共享 plan.json 测试 helper —— makeValidPlanJson。
 *
 * 从 dispatch.test.ts（makeValidPlanJson）和 gate.test.ts（makePlanJson）提取。
 * 两份实现结构一致（format=lite + waves + mock+real testCases），只是
 * scenario/steps/expected 文本不同——通过 overrides 参数控制。
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
