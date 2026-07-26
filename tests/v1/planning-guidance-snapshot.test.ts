/**
 * v1 三层 PlanningUnit guidance 结构快照测试（w3）。
 *
 * 来源：w2 exec-review 的第一条 high followup——w2 把三层 buildXxxNextAction 接入
 * buildNormalGuidance（三段式）、buildXxxFailureNextAction 接入 buildFailureGuidance（四段式），
 * 但既有 482 测试不断言三层 guidance 的段落结构（RK1 只算 mitigated）。w3 补此缺口。
 *
 * 覆盖：
 * - 正常路径三段式（slice/feature/epic × clarify/plan/design-review/retrospect/closeout）
 * - 失败路径四段式（三层 × failureCount 1/2/5 三档递进提示）
 * - schema 层区分（ERR2 降级路径：slice/epic Clarification vs feature FeatureClarification）
 * - ERR4 旧一句话文案残留检查（grep tests/）
 *
 * 零 mock：真实 createSlice/createFeature/createEpic + 真实 appendXxxFailRecord +
 * 真实 buildXxxNextAction/buildXxxFailureNextAction，仅 stub clock/store（复用 v1-env）。
 */
import { describe, expect, it } from "vitest";

import type { Epic,Feature, Slice } from "../../src/core/workunit.js";
import { createEpic,createFeature, createSlice } from "../../src/core/workunit.js";
import {
  appendEpicFailRecord,
  buildEpicFailureNextAction,
  buildEpicNextAction,
  getEpicSchemaText,
} from "../../src/handlers/epic/epic-internal.js";
import {
  appendFeatureFailRecord,
  buildFeatureFailureNextAction,
  buildFeatureNextAction,
  getFeatureSchemaText,
} from "../../src/handlers/feature/feature-internal.js";
import {
  appendSliceFailRecord,
  buildSliceFailureNextAction,
  buildSliceNextAction,
  getSliceSchemaText,
} from "../../src/handlers/slice/slice-internal.js";
import type { PlanningAction } from "../../src/rules/state-machine.js";
import { makeStubDeps } from "./helpers/v1-env.js";

/**
 * 正常路径 guidance 必含的三段段头（buildNormalGuidance §3.4）。
 * 段顺序是 §3.4 文档约定的稳定结构，非实现细节——段序错乱正是该报的 bug。
 */
const NORMAL_SECTIONS = ["## 位置", "## 下一步", "## input schema + 关键约束"] as const;

/**
 * 失败路径 guidance 必含的三段段头（buildFailureGuidance §3.5）。
 * 「## 递进提示」仅 failureCount >= 2 时出现，不在固定段头集合内。
 */
const FAILURE_SECTIONS = ["## 位置", "## 问题", "## 怎么修"] as const;

/** 断言 guidance 含全部指定段头，且段头出现顺序与数组顺序一致（indexOf 严格升序）。 */
function expectSectionsInOrder(guidance: string, sections: readonly string[]): void {
  let lastIndex = -1;
  for (const section of sections) {
    expect(guidance, `guidance 缺段：${section}`).toContain(section);
    const idx = guidance.indexOf(section);
    expect(idx, `段顺序错乱：${section} 应在上一段之后`).toBeGreaterThan(lastIndex);
    lastIndex = idx;
  }
}

/** 构造一个停在 created 状态的 slice（makeSliceUnit 的本地最小版，避免引入 helper 依赖）。 */
function freshSlice(): Slice {
  return createSlice({ slug: "snap-slice", objective: "o", createdAt: "2026-07-22T00:00:00.000Z" });
}
function freshFeature(): Feature {
  return createFeature({ slug: "snap-feature", objective: "o", createdAt: "2026-07-22T00:00:00.000Z" });
}
function freshEpic(): Epic {
  return createEpic({ slug: "snap-epic", objective: "o", createdAt: "2026-07-22T00:00:00.000Z" });
}

/**
 * 构造 appendXxxFailRecord 所需的最小 deps。
 *
 * appendXxxFailRecord 只用到 deps.clock.now()（写 statusHistory.at）和
 * deps.store.save（持久化）。测试只关心 unit 对象被 mutate（statusHistory push），
 * 不关心磁盘持久化，故 save 用 no-op stub。clock 用固定时间戳保证可断言。
 */
function makeDeps() {
  const noopStore = { save: () => {} };
  return makeStubDeps(
    noopStore as unknown as Parameters<typeof makeStubDeps>[0],
    "/tmp/cw-snapshot-test",
  );
}

// ═══════════════════════════════════════════════════════════════
// TC1-3：三层正常路径三段式
// ═══════════════════════════════════════════════════════════════

const PLANNING_ACTIONS_WITH_INPUT: PlanningAction[] = [
  "clarify",
  "plan",
  "design-review",
  "retrospect",
  "closeout",
];

describe("TC1: slice 正常路径三段式 guidance", () => {
  for (const action of PLANNING_ACTIONS_WITH_INPUT) {
    it(`slice ${action} → 三段式 + command + layer=slice + prefix 含 [slice:...]`, () => {
      const unit = freshSlice();
      const nextAction = buildSliceNextAction(unit, action);

      expectSectionsInOrder(nextAction.guidance, NORMAL_SECTIONS);
      // command 出现在 guidance（cw <nextAction> --unitId <id>，closeout 终态为例外）
      if (action === "closeout") {
        expect(nextAction.guidance).toContain("已结束本层流程");
      } else {
        expect(nextAction.guidance).toContain("--unitId slice:snap-slice");
        expect(nextAction.guidance).toContain("命令：cw ");
      }
      // prefix 段含层标识
      expect(nextAction.guidance).toContain("[slice:slice:snap-slice]");
      // unitPath 层正确
      expect(nextAction.unitPath.layer).toBe("slice");
      expect(nextAction.unitPath.unitId).toBe("slice:snap-slice");
    });
  }
});

describe("TC2: feature 正常路径三段式 guidance", () => {
  for (const action of PLANNING_ACTIONS_WITH_INPUT) {
    it(`feature ${action} → 三段式 + command + layer=feature + prefix 含 [feature:...]`, () => {
      const unit = freshFeature();
      const nextAction = buildFeatureNextAction(unit, action);

      expectSectionsInOrder(nextAction.guidance, NORMAL_SECTIONS);
      if (action === "closeout") {
        expect(nextAction.guidance).toContain("已结束本层流程");
      } else {
        expect(nextAction.guidance).toContain("--unitId feature:snap-feature");
        expect(nextAction.guidance).toContain("命令：cw ");
      }
      expect(nextAction.guidance).toContain("[feature:feature:snap-feature]");
      expect(nextAction.unitPath.layer).toBe("feature");
    });
  }
});

describe("TC3: epic 正常路径三段式 guidance", () => {
  for (const action of PLANNING_ACTIONS_WITH_INPUT) {
    it(`epic ${action} → 三段式 + command + layer=epic + prefix 含 [epic:...]`, () => {
      const unit = freshEpic();
      const nextAction = buildEpicNextAction(unit, action);

      expectSectionsInOrder(nextAction.guidance, NORMAL_SECTIONS);
      if (action === "closeout") {
        expect(nextAction.guidance).toContain("已结束本层流程");
      } else {
        expect(nextAction.guidance).toContain("--unitId epic:snap-epic");
        expect(nextAction.guidance).toContain("命令：cw ");
      }
      expect(nextAction.guidance).toContain("[epic:epic:snap-epic]");
      expect(nextAction.unitPath.layer).toBe("epic");
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// TC4：三层失败路径四段式 + problem 原文 + 递进提示三档
// ═══════════════════════════════════════════════════════════════

/**
 * 对某层连续 fail N 次后构建 failure guidance。
 *
 * 每次调 appendXxxFailRecord 追加一条真实 fail 记录（note 含 "gate fail"），
 * deriveFailureCount 从 statusHistory 尾部倒序扫描同 action 连续 fail 记录派生计数。
 */
function buildFailGuidanceForSlice(
  unit: Slice,
  action: PlanningAction,
  problem: string,
  failTimes: number,
): { guidance: string; failureCount: number } {
  const deps = makeDeps();
  for (let i = 0; i < failTimes; i++) {
    appendSliceFailRecord(deps, unit, action, `第${i + 1}次原因`);
  }
  const { nextAction, failureCount } = buildSliceFailureNextAction(unit, action, problem);
  return { guidance: nextAction.guidance, failureCount };
}

describe("TC4: 三层失败路径四段式 guidance", () => {
  it("slice 首次 fail（failureCount=1）→ 四段式含 problem 原文，无「递进提示」段", () => {
    const unit = freshSlice();
    const problem = "testCases 为空，至少需要 1 个";
    const { guidance, failureCount } = buildFailGuidanceForSlice(unit, "design-review", problem, 1);

    expectSectionsInOrder(guidance, FAILURE_SECTIONS);
    // problem 原文真实进入 guidance
    expect(guidance).toContain(problem);
    expect(failureCount).toBe(1);
    // 第 1 次 fail 无递进提示（§5.1）
    expect(guidance).not.toContain("## 递进提示");
  });

  it("slice 连续 fail 2 次（failureCount=2）→ 含「递进提示」段 + 三出口", () => {
    const unit = freshSlice();
    const problem = "plan.split 为空";
    const { guidance, failureCount } = buildFailGuidanceForSlice(unit, "design-review", problem, 2);

    expectSectionsInOrder(guidance, FAILURE_SECTIONS);
    expect(guidance).toContain(problem);
    expect(failureCount).toBe(2);
    // >=2 出现递进提示段 + 三出口（clarify/replan/abort）
    expect(guidance).toContain("## 递进提示");
    expect(guidance).toContain("cw v1 clarify");
    expect(guidance).toContain("replan");
    expect(guidance).toContain("abort");
  });

  it("slice 连续 fail 5 次（failureCount=5）→ 递进提示含「强烈建议 abort」", () => {
    const unit = freshSlice();
    const problem = "DAG 有环";
    const { guidance, failureCount } = buildFailGuidanceForSlice(unit, "design-review", problem, 5);

    expect(guidance).toContain(problem);
    expect(failureCount).toBe(5);
    expect(guidance).toContain("## 递进提示");
    expect(guidance).toContain("强烈建议");
    expect(guidance).toContain("abort");
  });

  it("feature 失败路径 → 四段式 + problem 原文 + prefix 含（未变）标注", () => {
    const deps = makeDeps();
    const unit = freshFeature();
    const problem = "sufficiency.gaps 非空但未在 risk 中体现";
    appendFeatureFailRecord(deps, unit, "design-review", "gap 未覆盖");
    const { nextAction, failureCount } = buildFeatureFailureNextAction(unit, "design-review", problem);

    expectSectionsInOrder(nextAction.guidance, FAILURE_SECTIONS);
    expect(nextAction.guidance).toContain(problem);
    expect(nextAction.guidance).toContain("[feature:feature:snap-feature]");
    // fail 路径 prefix 标注 status 未变
    expect(nextAction.guidance).toContain("未变");
    expect(failureCount).toBe(1);
    expect(nextAction.unitPath.layer).toBe("feature");
  });

  it("epic 失败路径 → 四段式 + problem 原文", () => {
    const deps = makeDeps();
    const unit = freshEpic();
    const problem = "alternatives 为空，必须给出至少一个备选";
    appendEpicFailRecord(deps, unit, "design-review", "alternatives empty");
    const { nextAction, failureCount } = buildEpicFailureNextAction(unit, "design-review", problem);

    expectSectionsInOrder(nextAction.guidance, FAILURE_SECTIONS);
    expect(nextAction.guidance).toContain(problem);
    expect(nextAction.guidance).toContain("[epic:epic:snap-epic]");
    expect(failureCount).toBe(1);
    expect(nextAction.unitPath.layer).toBe("epic");
  });

  it("problem 含特殊字符（中文标点/换行）也原样进入 guidance", () => {
    const unit = freshSlice();
    const problem = "字段【designReviewJudgment.necessity】为空\n请补充必要性说明";
    const { guidance } = buildFailGuidanceForSlice(unit, "retrospect", problem, 1);
    expect(guidance).toContain(problem);
  });
});

// ═══════════════════════════════════════════════════════════════
// TC5：schema 层区分（ERR2 降级路径）
// ═══════════════════════════════════════════════════════════════

describe("TC5: schema 注入按层区分（ERR2 降级路径）", () => {
  it("slice.clarify schema 是裸 Clarification 字段（question/type，无 spec 容器）", () => {
    const text = getSliceSchemaText("clarify");
    expect(text).toContain("question");
    expect(text).toContain("type");
    // slice 是裸 Clarification 数组，不应出现 feature 的 spec 容器
    expect(text).not.toContain("spec");
    expect(text).not.toContain("functionalRequirements");
  });

  it("feature.clarify schema 含 spec 容器（functionalRequirements/acceptanceCriteria 等）", () => {
    const text = getFeatureSchemaText("clarify");
    expect(text).toContain("spec");
    expect(text).toContain("functionalRequirements");
    expect(text).toContain("acceptanceCriteria");
    // feature clarify 产物含嵌套 clarifications 数组
    expect(text).toContain("clarifications");
  });

  it("epic.clarify schema 是裸 Clarification 字段（与 slice 同，无 spec 容器）", () => {
    const text = getEpicSchemaText("clarify");
    expect(text).toContain("question");
    expect(text).toContain("type");
    expect(text).not.toContain("spec");
    expect(text).not.toContain("functionalRequirements");
  });

  it("三层 getSchemaText 对无 schema action 不 throw（降级路径）", () => {
    // execute/replan/abort 无结构化 schema，应返回降级/扁平提示文本而非抛错
    expect(() => getSliceSchemaText("execute")).not.toThrow();
    expect(() => getFeatureSchemaText("replan")).not.toThrow();
    expect(() => getEpicSchemaText("abort")).not.toThrow();
    expect(getSliceSchemaText("execute").length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// TC6：ERR4 旧一句话断言残留检查
// ═══════════════════════════════════════════════════════════════

describe("TC6: ERR4 三层 guidance 产出无旧 W4 一句话占位文案", () => {
  /**
   * w1/w2 删除了三层 buildXxxNextAction/buildXxxFailureNextAction 主体里的旧一句话占位文案
   *（如"本层流程到此停留"、"gate/freeze 失败"、"X 完成，下一步"），改用 buildNormalGuidance/
   * buildFailureGuidance 的结构化段落。此测试防回归：实际产出的 guidance 文本不应再含旧占位。
   *
   * 直接断言 guidance 产出字符串——比 grep 源码更可靠（grep 会误伤注释/测试定义，
   * 且只查源码不保证运行时产出干净）。
   */
  const LEGACY_PHRASES = [
    "本层流程到此停留",
    "gate/freeze 失败",
  ];

  for (const phrase of LEGACY_PHRASES) {
    it(`slice 正常 + 失败 guidance 不含旧占位："${phrase}"`, () => {
      const unit = freshSlice();
      const normal = buildSliceNextAction(unit, "clarify").guidance;
      const deps = makeDeps();
      appendSliceFailRecord(deps, unit, "design-review", "reason");
      const failure = buildSliceFailureNextAction(unit, "design-review", "problem").nextAction.guidance;
      expect(normal, `slice 正常 guidance 含旧占位 "${phrase}"`).not.toContain(phrase);
      expect(failure, `slice 失败 guidance 含旧占位 "${phrase}"`).not.toContain(phrase);
    });

    it(`feature 正常 + 失败 guidance 不含旧占位："${phrase}"`, () => {
      const unit = freshFeature();
      const normal = buildFeatureNextAction(unit, "clarify").guidance;
      const deps = makeDeps();
      appendFeatureFailRecord(deps, unit, "design-review", "reason");
      const failure = buildFeatureFailureNextAction(unit, "design-review", "problem").nextAction.guidance;
      expect(normal).not.toContain(phrase);
      expect(failure).not.toContain(phrase);
    });

    it(`epic 正常 + 失败 guidance 不含旧占位："${phrase}"`, () => {
      const unit = freshEpic();
      const normal = buildEpicNextAction(unit, "clarify").guidance;
      const deps = makeDeps();
      appendEpicFailRecord(deps, unit, "design-review", "reason");
      const failure = buildEpicFailureNextAction(unit, "design-review", "problem").nextAction.guidance;
      expect(normal).not.toContain(phrase);
      expect(failure).not.toContain(phrase);
    });
  }
});
