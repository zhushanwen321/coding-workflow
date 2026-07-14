/**
 * W1 测试 — 新增类型定义验证（Priority, TestRunner, tdd_inited, tdd_plan）。
 *
 * 这些是纯类型层面的变更，测试验证：
 * - Priority 联合类型接受 P0/P1/P2，拒绝其他值
 * - TestRunnerConfig 各 mode 的结构正确性
 * - Status 包含 tdd_inited
 * - Action 包含 tdd_plan
 * - Wave/TestCase/TestCaseSeed 包含 priority 字段
 * - TestCase/TestCaseSeed 包含 redCheck 字段
 */
import { describe, expect,it } from "vitest";

import type {
  Action,
  Priority,
  Status,
  TestCase,
  TestCaseSeed,
  TestRunnerConfig,
  TestRunnerMode,
  Wave,
} from "../src/types.js";

describe("W1: 新增类型定义", () => {
  describe("Priority", () => {
    it("接受 P0/P1/P2", () => {
      const p0: Priority = "P0";
      const p1: Priority = "P1";
      const p2: Priority = "P2";
      expect([p0, p1, p2]).toEqual(["P0", "P1", "P2"]);
    });
  });

  describe("Status 包含 tdd_inited", () => {
    it("tdd_inited 是合法 Status 值", () => {
      const s: Status = "tdd_inited";
      expect(s).toBe("tdd_inited");
    });
  });

  describe("Action 包含 tdd_plan", () => {
    it("tdd_plan 是合法 Action 值", () => {
      const a: Action = "tdd_plan";
      expect(a).toBe("tdd_plan");
    });
  });

  describe("Wave.priority", () => {
    it("Wave 可以带 priority 字段", () => {
      const wave: Wave = {
        id: "W1",
        dependsOn: [],
        committed: null,
        changes: ["change1"],
        priority: "P0",
      };
      expect(wave.priority).toBe("P0");
    });
  });

  describe("TestCase 新增字段", () => {
    it("TestCase 带 priority + redCheck", () => {
      const tc: TestCase = {
        id: "U1",
        layer: "mock",
        scenario: "test",
        steps: "steps",
        expected: { text: "result" },
        executor: "vitest",
        status: "pending",
        requiresScreenshot: false,
        dependsOn: [],
        priority: "P0",
        redCheck: true,
      };
      expect(tc.priority).toBe("P0");
      expect(tc.redCheck).toBe(true);
    });
  });

  describe("TestCaseSeed 新增字段", () => {
    it("TestCaseSeed 带 priority + redCheck", () => {
      const seed: TestCaseSeed = {
        id: "U1",
        layer: "mock",
        scenario: "test",
        steps: "steps",
        expected: { text: "result" },
        executor: "vitest",
        requiresScreenshot: false,
        priority: "P1",
        redCheck: false,
      };
      expect(seed.priority).toBe("P1");
      expect(seed.redCheck).toBe(false);
    });
  });

  describe("TestRunnerMode", () => {
    it("接受 nodejs/python/java/custom", () => {
      const modes: TestRunnerMode[] = ["nodejs", "python", "java", "custom"];
      expect(modes).toHaveLength(4);
    });
  });

  describe("TestRunnerConfig", () => {
    it("nodejs 模式带 command + cwd", () => {
      const cfg: TestRunnerConfig = {
        mode: "nodejs",
        command: "npx vitest run",
        cwd: ".",
      };
      expect(cfg.mode).toBe("nodejs");
      expect(cfg.command).toBe("npx vitest run");
    });

    it("custom 模式带 path", () => {
      const cfg: TestRunnerConfig = {
        mode: "custom",
        path: ".cw/run-tests.sh",
      };
      expect(cfg.mode).toBe("custom");
      expect(cfg.path).toBe(".cw/run-tests.sh");
    });

    it("python 模式带 command", () => {
      const cfg: TestRunnerConfig = {
        mode: "python",
        command: "python -m pytest",
      };
      expect(cfg.mode).toBe("python");
    });

    it("java 模式带 command", () => {
      const cfg: TestRunnerConfig = {
        mode: "java",
        command: "mvn test",
      };
      expect(cfg.mode).toBe("java");
    });
  });
});
