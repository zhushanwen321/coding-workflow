/**
 * AC-1 适用域门控分类器的机器复核（判定函数本体在 tests/fixtures/w4-ac1.ts）。
 *
 * 为什么给测试基础设施写测试：门控若静默失灵（路径前缀笔误致恒跳过、目录/
 * 文件匹配语义混淆），tests/w4-grep-ac.test.ts 的 AC-1 将不再对边界敏感波次
 * 报警——锁失效恰是不可见的。此处把分类语义钉死。
 */
import { describe, expect, it } from "vitest";

import { classifyBranch, isGatePipelinePath, isUnitLockedPath } from "./fixtures/w4-ac1.js";

describe("w4 AC-1 适用域门控分类器", () => {
  it("gate·pipeline 波次触发锁：合规改动 offenders 为空，越界 unit 改动被点名", () => {
    const compliant = classifyBranch(["src/gate/cache-key.ts", "src/pipeline/run.ts", "AGENTS.md"]);
    expect(compliant.applies).toBe(true);
    expect(compliant.offenders).toEqual([]);

    const violating = classifyBranch(["src/pipeline/run.ts", "src/verify/run.ts", "src/core/fold.ts"]);
    expect(violating.applies).toBe(true);
    expect(violating.offenders).toEqual(["src/verify/run.ts", "src/core/fold.ts"]);
  });

  it("非 gate·pipeline 波次不触发锁：unit 域本职演化不适用，纯文档/测试同样不适用", () => {
    expect(classifyBranch(["src/events/types.ts", "src/runner/loop.ts"]).applies).toBe(false);
    expect(classifyBranch(["tests/w4-grep-ac.test.ts"]).applies).toBe(false);
  });

  it("目录前缀按目录语义匹配：同名更长子路径不误伤", () => {
    expect(isUnitLockedPath("src/runner/worktree.ts")).toBe(true);
    expect(isUnitLockedPath("src/runner-extra/x.ts")).toBe(false);
    expect(isGatePipelinePath("src/gate/x.ts")).toBe(true);
    // unit 域 spec 规则目录 src/gates/ ≠ gate 域 src/gate/——同名陷阱必须区分
    expect(isGatePipelinePath("src/gates/spec-rules.ts")).toBe(false);
    expect(isGatePipelinePath("src/pipeline-extra/x.ts")).toBe(false);
  });

  it("单文件项精确匹配：子串路径不算命中", () => {
    expect(isUnitLockedPath("src/events/types.ts")).toBe(true);
    expect(isUnitLockedPath("src/events/types-util.ts")).toBe(false);
    // 不在九路径保护清单内的共享账本心不构成违规
    expect(isUnitLockedPath("src/store/events-log.ts")).toBe(false);
    expect(isUnitLockedPath("pi-coding-workflow-extension/src/a.ts")).toBe(true);
  });
});
