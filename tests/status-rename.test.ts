/**
 * status-rename 测试 — 步骤 5：状态重命名红灯校验。
 *
 * 这个测试文件专门为 TDD 红灯而存在：
 *   - 重命名前：pre_dev_verified / post_dev_verified 不在 Status union 里 → TS 编译 fail / 运行时 fail（红灯）
 *   - 重命名后：新名在 union 里 → pass（绿灯）
 *
 * 重命名完成后这个测试保留作为回归——锁住新状态名不被意外改回。
 */

import { describe, expect, it } from "vitest";

import type { Status } from "../src/legacy/types.js";
import { TRANSITIONS } from "../src/legacy/state-machine.js";

describe("步骤 5：状态重命名（tdd_inited→pre_dev_verified, tested→post_dev_verified）", () => {
  it("Status union 含 pre_dev_verified", () => {
    const s: Status = "pre_dev_verified";
    expect(s).toBe("pre_dev_verified");
  });

  it("Status union 含 post_dev_verified", () => {
    const s: Status = "post_dev_verified";
    expect(s).toBe("post_dev_verified");
  });

  it("TRANSITIONS.tdd_plan.nextStatus === pre_dev_verified", () => {
    expect(TRANSITIONS.tdd_plan.nextStatus).toBe("pre_dev_verified");
  });

  it("TRANSITIONS.test.nextStatus === post_dev_verified", () => {
    expect(TRANSITIONS.test.nextStatus).toBe("post_dev_verified");
  });

  it("TRANSITIONS.dev.expectedStatuses 含 pre_dev_verified", () => {
    expect(TRANSITIONS.dev.expectedStatuses).toContain("pre_dev_verified");
  });

  it("TRANSITIONS.retrospect.expectedStatuses 含 post_dev_verified", () => {
    expect(TRANSITIONS.retrospect.expectedStatuses).toContain("post_dev_verified");
  });
});
