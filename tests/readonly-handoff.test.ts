/**
 * renderHandoff 单元测试（TC1-TC4）。
 *
 * renderHandoff 是纯函数（接 WorkUnitRecord，不读 fs），直接 import 传工厂产出的 unit。
 * 不走真实 store / 不走子进程——store 层和 cli 层有独立测试。
 *
 * 覆盖：
 *   TC1: wave 空态（刚 create）—— 目标段 + 下一步 design guidance + 提示尚未实现
 *   TC2: wave 中间态（design-reviewed）—— design-review 决策 + buildNextAction(execute) guidance + plan.files
 *   TC3: wave 终态（closed/aborted）—— 无下一步段 + 历史完整
 *   TC4: planning 三层空态（slice/feature/epic）—— 不 crash + 按 scope 收窄渲染
 */
import { describe, expect, it } from "vitest";

import { createEpic, createFeature, createSlice, createWave } from "../src/core/workunit.js";
import { renderHandoff } from "../src/readonly/render.js";
import type { WorkUnitRecord } from "../src/store/schema.js";

/** 把强类型 unit 当 WorkUnitRecord 传（兼容：core unit 是 store record 的超集）。 */
function asRecord(unit: unknown): WorkUnitRecord {
  return unit as WorkUnitRecord;
}

// ── TC1: wave 空态 ──────────────────────────────────────────

describe("TC1: renderHandoff 空态 wave（刚 create）", () => {
  const unit = asRecord(
    createWave({ slug: "auth-w1", objective: "实现登录" }),
  );
  const out = renderHandoff(unit);

  it("标题含 unitId 和 status", () => {
    expect(out).toContain("# Handoff: wave:auth-w1 [created]");
  });

  it("目标段含 objective", () => {
    expect(out).toContain("## 目标");
    expect(out).toContain("实现登录");
  });

  it("下一步段指向 design（明确命令 + buildNextAction 阶段 guidance）", () => {
    expect(out).toContain("## 当前位置与下一步");
    expect(out).toContain("状态：created");
    // 明确的执行命令
    expect(out).toContain("下一步执行：cw design --unitId wave:auth-w1");
    // buildNextAction(unit, "design") 生成的阶段 guidance（含 schema + 约束）
    expect(out).toContain("阶段提示");
    expect(out).toContain("input schema");
  });

  it("空产物段：涉及文件提示尚未实现", () => {
    expect(out).toContain("（尚未进入实现阶段，无文件/契约）");
  });

  it("历史段含 create 一条", () => {
    expect(out).toContain("## 历史与变更");
    expect(out).toContain("create → created");
  });

  it("已定决策段省略（clarifications 空）", () => {
    expect(out).not.toContain("## 已定决策");
  });
});

// ── TC2: wave 中间态（design-reviewed）──────────────────────

describe("TC2: renderHandoff 走到 design-reviewed 的 wave", () => {
  const base = createWave({ slug: "feat-w1", objective: "加导出功能" });
  // 手工构造中间态：status + clarifications（带 resolution）+ plan（files/contracts）+ design-review 判定
  const unit = asRecord({
    ...base,
    status: "design-reviewed",
    statusHistory: [
      ...base.statusHistory,
      { at: "2026-07-24T10:00:00.000Z", action: "design", to: "designing" },
      { at: "2026-07-24T11:00:00.000Z", action: "design", to: "designing" },
      { at: "2026-07-24T12:00:00.000Z", action: "design-review", to: "design-reviewed" },
    ],
    clarifications: [
      { id: "C1", status: "active", question: "导出格式?", resolution: "CSV 优先", type: "grilling" as const },
    ],
    plan: {
      ...base.plan,
      files: [
        { id: "F1", status: "active", path: "src/export.ts", action: "create", description: "导出入口" },
      ],
      contracts: [
        { id: "K1", status: "active", name: "exportData", type: "function", definition: "(rows) => Blob" },
      ],
      tasks: [
        { id: "T1", status: "active", type: "impl", files: ["src/export.ts"], steps: ["写函数", "接线"] },
      ],
    },
    designReviewJudgment: {
      necessity: "需要导出",
      sufficiency: { gaps: [], overlaps: [], meceNote: "覆盖全" },
      alternatives: "考虑过 JSON，选 CSV 因兼容性",
      tradeoffs: [
        { id: "TO1", decision: "CSV not JSON", reason: "兼容", cost: "无嵌套" },
      ],
      risks: [
        { id: "R1", item: "大文件 OOM", severity: "medium", mitigation: "流式" },
      ],
    },
  });
  const out = renderHandoff(unit);

  it("已定决策段含 design 问答", () => {
    expect(out).toContain("## 已定决策");
    expect(out).toContain("[design C1]");
    expect(out).toContain("导出格式?");
    expect(out).toContain("CSV 优先");
  });

  it("已定决策段含 design-review 的 alternatives/tradeoff/risk", () => {
    expect(out).toContain("[review]");
    expect(out).toContain("CSV not JSON");
    expect(out).toContain("[tradeoff TO1]");
    expect(out).toContain("[risk R1/medium]");
  });

  it("下一步段明确指向 execute 命令 + buildNextAction(execute) 阶段 guidance", () => {
    expect(out).toContain("状态：design-reviewed");
    expect(out).toContain("下一步执行：cw execute --unitId wave:feat-w1");
    expect(out).toContain("阶段提示");
  });

  it("涉及文件段列出 files/contracts/tasks", () => {
    expect(out).toContain("## 涉及文件与契约");
    expect(out).toContain("src/export.ts");
    expect(out).toContain("[create]");
    expect(out).toContain("exportData:");
    expect(out).toContain("[impl]");
  });

  it("历史段含完整流转", () => {
    expect(out).toContain("create → created");
    expect(out).toContain("design-review → design-reviewed");
  });
});

// ── TC2b: wave executing 状态→test（原 bug 回归：曾错写成 execute）──

describe("TC2b: renderHandoff wave executing 下一步是 test", () => {
  it("wave executing → cw test（不是 execute）", () => {
    const unit = asRecord({
      ...createWave({ slug: "exec-w1", objective: "执行中" }),
      status: "executing",
      // design-review 已过，进入 executing（execute 完成）
      designReviewJudgment: { alternatives: [], tradeoffs: [], risks: [] },
    });
    const out = renderHandoff(unit);
    expect(out).toContain("状态：executing");
    // 关键回归：executing 状态的下一步是 test（execute 已完成），原 bug 错写成 execute
    expect(out).toContain("下一步执行：cw test --unitId wave:exec-w1");
    expect(out).not.toContain("下一步执行：cw execute");
  });
});

// ── TC3: wave 终态（closed / aborted）───────────────────────

describe("TC3: renderHandoff 终态 wave", () => {
  it("closed 不输出下一步段", () => {
    const unit = asRecord({
      ...createWave({ slug: "done-w1", objective: "完成" }),
      status: "closed",
    });
    const out = renderHandoff(unit);
    expect(out).toContain("状态：closed");
    expect(out).toContain("终态");
    // 不应出现「下一步执行」（终态跳过）
    expect(out).not.toContain("下一步执行");
  });

  it("aborted 不输出下一步段，含终态标注", () => {
    const unit = asRecord({
      ...createWave({ slug: "kill-w1", objective: "废弃" }),
      status: "aborted",
      statusHistory: [
        { at: "2026-07-24T10:00:00.000Z", action: "create", to: "created" },
        { at: "2026-07-24T11:00:00.000Z", action: "abort", to: "aborted", note: "需求取消" },
      ],
    });
    const out = renderHandoff(unit);
    expect(out).toContain("状态：aborted");
    expect(out).toContain("终态");
    expect(out).not.toContain("下一步执行");
    // abort 的 note 在历史段
    expect(out).toContain("abort → aborted");
    expect(out).toContain("需求取消");
  });
});

// ── TC4: planning 三层输出真实 guidance（不再降级）──────────

describe("TC4: renderHandoff planning 层（slice/feature/epic）", () => {
  it("slice created：输出真实 guidance（调 buildSliceNextAction）", () => {
    const unit = asRecord(createSlice({ slug: "tech-s1", objective: "技术方案" }));
    const out = renderHandoff(unit);
    expect(out).toContain("# Handoff: slice:tech-s1 [created]");
    expect(out).toContain("技术方案");
    expect(out).toContain("create → created");
    // planning 层现在输出真实 guidance，不再是降级提示
    expect(out).not.toContain("handler 暂未实现");
    expect(out).toContain("下一步执行：cw design --unitId slice:tech-s1");
    expect(out).toContain("阶段提示（含 input schema + 关键约束）");
    // slice guidance 应含 planning 特有内容（design 阶段的 clarifications/split 约束提示）
    expect(out).toContain("clarifications");
  });

  it("slice executing：下一步是 retrospect（planning 无 test/exec-review）", () => {
    const unit = asRecord({
      ...createSlice({ slug: "exec-s1", objective: "执行中" }),
      status: "executing",
    });
    const out = renderHandoff(unit);
    // 关键：planning 的 executing → retrospect，不是 wave 的 executing → test
    expect(out).toContain("下一步执行：cw retrospect --unitId slice:exec-s1");
    expect(out).not.toContain("cw test");
  });

  it("feature 空态：不 crash + clarifications 容器对象不报错 + 输出 guidance", () => {
    const unit = asRecord(createFeature({ slug: "req-f1", objective: "需求规格" }));
    const out = renderHandoff(unit);
    expect(out).toContain("# Handoff: feature:req-f1 [created]");
    expect(out).toContain("需求规格");
    // feature 的 clarifications 是 {clarifications:[], spec:{...}} 容器，不应 crash
    expect(out).toContain("## 当前位置与下一步");
    expect(out).toContain("下一步执行：cw design --unitId feature:req-f1");
  });

  it("epic 空态：不 crash + 有目标 + 输出 guidance", () => {
    const unit = asRecord(createEpic({ slug: "big-e1", objective: "战略目标" }));
    const out = renderHandoff(unit);
    expect(out).toContain("# Handoff: epic:big-e1 [created]");
    expect(out).toContain("战略目标");
    expect(out).toContain("下一步执行：cw design --unitId epic:big-e1");
  });
});
