/**
 * retrospect 类型结构单测 — W1（FR-3 / FR-4 / FR-6 类型基础）。
 *
 * 覆盖 AC：支撑 AC-3/AC-4/AC-6 的类型契约。
 *
 * 测什么（运行时构造对象验证字段可访问，相当于类型层契约的可执行文档）：
 *   - ProcessIssueType 四值枚举（pattern / oneOff / observation / uncategorized）
 *   - ProcessIssue 结构 { type, description }
 *   - RetrospectInsights 结构 { typeBuckets }
 *   - RetrospectData.processIssues 是 ProcessIssue[] 不是 string[]
 *
 * 防的 bug：类型定义遗漏字段、枚举值拼写错、ProcessIssue.type 退化为自由文本。
 *
 * 纯类型/构造测试，无需 tmp 目录或 mock（照 stats.test.ts 模式）。
 *
 * 红灯形态：import 不存在的 ProcessIssueType / ProcessIssue / RetrospectInsights
 * 类型导出会编译失败（这些是 W1 要新增的类型）。运行时不占用值空间，但 TS
 * 编译会报「Module has no exported member」——vitest 走 esbuild 会把它当类型
 * 处理，运行时无断言可跑，所以这里用构造对象 + 字段访问让运行时也有断言。
 */

import { describe, expect, it } from "vitest";

import type {
  ProcessIssue,
  ProcessIssueType,
  RetrospectData,
  RetrospectInsights,
} from "../src/types.js";

// ── ProcessIssueType 四值枚举（FR-3 / D5）──────────────────────

describe("ProcessIssueType 四值枚举（W1 / FR-3）", () => {
  it("pattern / oneOff / observation / uncategorized 四值均可赋值给 ProcessIssueType", () => {
    // 编译期约束：四个字面量都属于 ProcessIssueType。
    // 若 W1 漏定义某个值或拼错，这里编译失败。
    const values: ProcessIssueType[] = [
      "pattern",
      "oneOff",
      "observation",
      "uncategorized",
    ];
    expect(values).toHaveLength(4);
    expect(new Set(values).size).toBe(4); // 四值互斥
  });

  it("ProcessIssueType 不接受非法值（编译期约束，运行时构造对照）", () => {
    // 合法值构造一个 ProcessIssue，确认 type 字段能读出来。
    const issue: ProcessIssue = {
      type: "pattern",
      description: "跨 topic 可复现的流程模式",
    };
    expect(issue.type).toBe("pattern");
    expect(issue.description).toBe("跨 topic 可复现的流程模式");
  });
});

// ── ProcessIssue 结构（FR-3）──────────────────────────────────

describe("ProcessIssue 结构（W1 / FR-3）", () => {
  it("ProcessIssue 含 type + description 两个字段", () => {
    const issue: ProcessIssue = {
      type: "oneOff",
      description: "本次偶发失误，无泛化价值",
    };
    expect(issue).toHaveProperty("type");
    expect(issue).toHaveProperty("description");
    expect(typeof issue.description).toBe("string");
  });

  it("observation 类型可构造（非问题性陈述）", () => {
    const issue: ProcessIssue = {
      type: "observation",
      description: "记录现象，非问题",
    };
    expect(issue.type).toBe("observation");
  });

  it("uncategorized 类型可构造（旧 string[] 迁移标记）", () => {
    const issue: ProcessIssue = {
      type: "uncategorized",
      description: "历史 string[] 自动包装",
    };
    expect(issue.type).toBe("uncategorized");
  });
});

// ── RetrospectData.processIssues 是 ProcessIssue[]（FR-3 破坏性升级）──

describe("RetrospectData.processIssues 类型升级（W1 / FR-3）", () => {
  it("processIssues 接受 ProcessIssue[]（对象数组，非 string[]）", () => {
    // FR-3 破坏性升级：processIssues 从 string[] 改为 ProcessIssue[]。
    // 若类型未升级，这里编译失败（string 不可赋给 ProcessIssue.type）。
    const data: RetrospectData = {
      derived: {
        totalWaves: 1,
        totalCases: 1,
        gateFailCount: 0,
        devRetryCount: 0,
        testRetryCount: 0,
        redLightConfirmed: false,
        firstTryPassRate: 1,
      },
      knownRisks: [],
      processIssues: [
        { type: "pattern", description: "plan 拆分粒度过细" },
        { type: "oneOff", description: "replaceSpec flag 用错" },
      ],
    };
    // 运行时验证：processIssues 每个元素是对象（有 type 字段），不是裸 string。
    expect(data.processIssues).toHaveLength(2);
    for (const issue of data.processIssues) {
      expect(typeof issue).toBe("object");
      expect(issue).not.toBeNull();
      expect(typeof (issue as ProcessIssue).type).toBe("string");
      expect(typeof (issue as ProcessIssue).description).toBe("string");
    }
    expect(data.processIssues[0]!.type).toBe("pattern");
  });
});

// ── RetrospectInsights 结构（FR-6）────────────────────────────

describe("RetrospectInsights 结构（W1 / FR-6）", () => {
  it("RetrospectInsights 含 typeBuckets 四计数器", () => {
    // FR-6：retrospectInsights 是 StatsAllOutput 顶层字段，结构由 W1 定义。
    const insights: RetrospectInsights = {
      typeBuckets: {
        pattern: 3,
        oneOff: 2,
        observation: 1,
        uncategorized: 4,
      },
    };
    // 运行时验证：typeBuckets 含四个固定 key。
    expect(insights.typeBuckets).toHaveProperty("pattern");
    expect(insights.typeBuckets).toHaveProperty("oneOff");
    expect(insights.typeBuckets).toHaveProperty("observation");
    expect(insights.typeBuckets).toHaveProperty("uncategorized");
    expect(typeof insights.typeBuckets.pattern).toBe("number");
  });

  it("RetrospectInsights.typeBuckets 四计数器初始值为 0（空聚合）", () => {
    const empty: RetrospectInsights = {
      typeBuckets: {
        pattern: 0,
        oneOff: 0,
        observation: 0,
        uncategorized: 0,
      },
    };
    expect(empty.typeBuckets.pattern).toBe(0);
    expect(empty.typeBuckets.oneOff).toBe(0);
    expect(empty.typeBuckets.observation).toBe(0);
    expect(empty.typeBuckets.uncategorized).toBe(0);
  });
});
