/**
 * e2e-skill 测试 — `cw skill` 命令机制（plan §3.1）+ diagnosing-bugs 内化（§3.2 标杆）。
 *
 * 两层测试：
 *   层 1：registry 单元测试（照 shapes-types.test.ts）——纯模块 import，无 IO
 *   层 2：e2e 子进程测试（照 e2e-readonly.test.ts）——真实跑 dist/cli.js，零 mock
 *
 * 覆盖：
 *   - cw skill list → 返回所有 skill 的 {name/summary/trigger}（不含 body）
 *   - cw skill（无子命令）→ 默认等同 list
 *   - cw skill diagnosing-bugs → 返回完整 body
 *   - cw skill <未知> → exitCode 1 + stderr 提示可用 skill
 */

import { afterAll, describe, expect, it } from "vitest";

import { getSkill, listSkills, SKILL_NAMES } from "../src/legacy/skills/registry.js";
import type { SkillListOutput, SkillReadOutput } from "../src/legacy/skills/types.js";
import {
  createE2eEnv,
  disposeE2eEnv,
  type E2eEnv,
  parseStdout,
  runCli,
} from "./helpers/e2e.js";

// ── 层 1：registry 单元测试 ─────────────────────────────────

describe("skills/registry（单元）", () => {
  it("SKILL_NAMES 包含 diagnosing-bugs", () => {
    expect(SKILL_NAMES).toContain("diagnosing-bugs");
  });

  it("getSkill('diagnosing-bugs') 返回完整 entry", () => {
    const skill = getSkill("diagnosing-bugs");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("diagnosing-bugs");
    expect(skill!.summary.length).toBeGreaterThan(0);
    expect(skill!.trigger.length).toBeGreaterThan(0);
    expect(skill!.body.length).toBeGreaterThan(100); // body 必须有实质内容
    // body 必须包含 6 个 phase 标题
    for (let i = 1; i <= 6; i++) {
      expect(skill!.body).toContain(`Phase ${i}`);
    }
  });

  it("getSkill 未知 name 返回 null", () => {
    expect(getSkill("nonexistent-skill")).toBeNull();
  });

  it("listSkills 返回所有 skill 且不含 body", () => {
    const list = listSkills();
    expect(list.length).toBe(SKILL_NAMES.length);
    for (const entry of list) {
      expect(entry).not.toHaveProperty("body");
      expect(entry.name).toBeDefined();
      expect(entry.summary).toBeDefined();
      expect(entry.trigger).toBeDefined();
    }
  });
});

// ── 层 2：e2e 子进程测试 ────────────────────────────────────

describe("e2e: cw skill", () => {
  const e: E2eEnv = createE2eEnv();

  afterAll(() => disposeE2eEnv(e));

  it("cw skill list 返回所有 skill 索引", () => {
    const result = runCli(["skill", "list"], e);
    const output = parseStdout(result) as unknown as SkillListOutput;
    expect(output.skills.length).toBeGreaterThan(0);
    const diagnosing = output.skills.find((s) => s.name === "diagnosing-bugs");
    expect(diagnosing).toBeDefined();
    expect(diagnosing!.summary).toBeTruthy();
    expect(diagnosing!.trigger).toBeTruthy();
  });

  it("cw skill（无子命令）默认等同 list", () => {
    const result = runCli(["skill"], e);
    const output = parseStdout(result) as unknown as SkillListOutput;
    expect(output.skills.length).toBeGreaterThan(0);
  });

  it("cw skill diagnosing-bugs 返回完整 body", () => {
    const result = runCli(["skill", "diagnosing-bugs"], e);
    const output = parseStdout(result) as unknown as SkillReadOutput;
    expect(output.name).toBe("diagnosing-bugs");
    expect(output.body).toContain("Phase 1");
    expect(output.body).toContain("Phase 6");
  });

  it("cw skill <未知> exitCode 1 + stderr 提示", () => {
    const result = runCli(["skill", "nonexistent"], e);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("skill not found");
    expect(result.stderr).toContain("diagnosing-bugs"); // 提示可用 skill
  });
});
