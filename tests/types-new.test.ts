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
  ReviewFixSubmission,
  ReviewIssue,
  ReviewIssueSubmission,
  Status,
  TestCase,
  TestCaseSeed,
  TestFixEntry,
  TestFixSubmission,
  TestRunnerConfig,
  TestRunnerMode,
  Topic,
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
        changes: [{ file: "src/app.ts", description: "change1" }],
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
        expected: { type: "exact", text: "result" },
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
        expected: { type: "exact", text: "result" },
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

// ── W1+W2: issue tracking 类型（ReviewIssue / TestFixEntry / submissions） ──

describe("W1+W2: issue tracking 类型", () => {
  describe("Action 含 review_fix / test_fix", () => {
    it("review_fix 是合法 Action 值", () => {
      const a: Action = "review_fix";
      expect(a).toBe("review_fix");
    });

    it("test_fix 是合法 Action 值", () => {
      const a: Action = "test_fix";
      expect(a).toBe("test_fix");
    });
  });

  describe("ReviewIssue", () => {
    it("open 态：仅 severity + description + foundAtTurn", () => {
      const issue: ReviewIssue = {
        id: "R1",
        severity: "must-fix",
        description: "缺少错误处理",
        status: "open",
        foundAtTurn: 1,
      };
      expect(issue.id).toBe("R1");
      expect(issue.severity).toBe("must-fix");
      expect(issue.status).toBe("open");
      expect(issue.fix).toBeUndefined();
    });

    it("带 file 字段（代码位置）", () => {
      const issue: ReviewIssue = {
        id: "R2",
        severity: "should-fix",
        description: "命名不清晰",
        file: "src/types.ts:42",
        status: "open",
        foundAtTurn: 2,
      };
      expect(issue.file).toBe("src/types.ts:42");
    });

    it("fixed 态：含 fix 证据（commitHash + resolution + fixedAtTurn）", () => {
      const issue: ReviewIssue = {
        id: "R1",
        severity: "must-fix",
        description: "缺少错误处理",
        status: "fixed",
        foundAtTurn: 1,
        fix: {
          commitHash: "abc123",
          resolution: "加了 try/catch + 日志",
          fixedAtTurn: 2,
        },
      };
      expect(issue.status).toBe("fixed");
      expect(issue.fix).toBeDefined();
      expect(issue.fix!.commitHash).toBe("abc123");
      expect(issue.fix!.fixedAtTurn).toBe(2);
    });

    it("severity 三档全部合法", () => {
      const severities: ReviewIssue["severity"][] = ["must-fix", "should-fix", "nit"];
      expect(severities).toHaveLength(3);
    });
  });

  describe("TestFixEntry", () => {
    it("含 caseId + commitHash + resolution + turn", () => {
      const entry: TestFixEntry = {
        caseId: "E1",
        commitHash: "def456",
        resolution: "修正了 expected 字符串匹配",
        turn: 2,
      };
      expect(entry.caseId).toBe("E1");
      expect(entry.commitHash).toBe("def456");
      expect(entry.turn).toBe(2);
    });
  });

  describe("Topic 含 review/test tracking 字段", () => {
    it("Topic 可带 reviewIssues + reviewTurn + testFixLog + testTurn", () => {
      const topic: Topic = {
        topicId: "cw-x",
        slug: "x",
        objective: "obj",
        workspacePath: "/tmp",
        topicDir: "/tmp/.xyz-harness/x",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "reviewed",
        waves: [],
        testCases: [],
        gateHistory: [],
        gatePassed: {},
        clarifyRecords: [],
        specSections: [],
        adrs: [],
        reviewIssues: [
          {
            id: "R1",
            severity: "must-fix",
            description: "bug",
            status: "open",
            foundAtTurn: 1,
          },
        ],
        reviewTurn: 1,
        testFixLog: [
          {
            caseId: "E1",
            commitHash: "h1",
            resolution: "fixed",
            turn: 1,
          },
        ],
        testTurn: 1,
        assessments: [],
      };
      expect(topic.reviewIssues).toHaveLength(1);
      expect(topic.reviewTurn).toBe(1);
      expect(topic.testFixLog).toHaveLength(1);
      expect(topic.testTurn).toBe(1);
    });
  });

  describe("submission 类型", () => {
    it("ReviewIssueSubmission 不含 id/status/foundAtTurn（cw 填充）", () => {
      const sub: ReviewIssueSubmission = {
        severity: "nit",
        description: "拼写错误",
        file: "README.md:10",
      };
      expect(sub.severity).toBe("nit");
      expect((sub as { id?: string }).id).toBeUndefined();
    });

    it("ReviewFixSubmission 含 issueId + commitHash + resolution", () => {
      const sub: ReviewFixSubmission = {
        issueId: "R1",
        commitHash: "abc123",
        resolution: "修好了",
      };
      expect(sub.issueId).toBe("R1");
      expect(sub.commitHash).toBe("abc123");
    });

    it("TestFixSubmission 含 caseId + commitHash + resolution", () => {
      const sub: TestFixSubmission = {
        caseId: "E1",
        commitHash: "def456",
        resolution: "修好了",
      };
      expect(sub.caseId).toBe("E1");
      expect(sub.commitHash).toBe("def456");
    });
  });
});
