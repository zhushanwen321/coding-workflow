/**
 * u3 表驱动单测：checkSpecRules 五规则。
 * 用例编号「验收#N」逐条对应 docs/rewrite/acceptance/u3-acceptance.md「单测验收」9 条；
 * 「边界#N」锚定实现引入的分支语义（trim 空白、绝对路径 command 解析、core e2e-mock），
 * 保证这些行为有测试锁定而非靠实现巧合。
 *
 * PATH 解析用真实文件系统（零 mock）：正向用 `node`（vitest 自身由 node 运行，
 * 必在 PATH）与 `/bin/echo`（类 Unix 标配，覆盖含路径分隔符分支）；
 * 反向用确定不存在的 `no-such-bin-xyz`。
 */
import { describe, expect, it } from "vitest";

import type { AcceptanceItem, SpecSubmittedPayload } from "../src/events/types.js";
import { checkSpecRules } from "../src/gates/spec-rules.js";

/** 验收用例工厂：默认非 core 的 unit 用例，按需覆写 */
function item(id: string, overrides: Partial<AcceptanceItem> = {}): AcceptanceItem {
  return { id, core: false, title: `${id} 一句话描述`, type: "unit", ...overrides };
}

/** spec payload 工厂：规则只读 acceptance，其余字段给最小合法占位 */
function makeSpec(acceptance: readonly AcceptanceItem[]): SpecSubmittedPayload {
  return {
    unitId: "u3-test",
    specHash: "sha256:placeholder",
    acceptance: [...acceptance],
    contracts: [],
    split: [],
  };
}

/** 提取失败信息的规则编号前缀（如 "rule③"），用于断言多缺口升序全列出 */
function ruleTags(failures: readonly string[]): string[] {
  return failures.map((f) => f.match(/^rule[①②③④⑤]/)?.[0] ?? f);
}

interface RuleCase {
  readonly name: string;
  readonly acceptance: readonly AcceptanceItem[];
  readonly expectOk: boolean;
  /** 每条子串都应出现在 failures 中 */
  readonly mustContain?: readonly string[];
  /** 每条子串都不应出现在任何 failure 中 */
  readonly mustNotContain?: readonly string[];
  /** failures 的规则编号序列（严格相等，锚定「升序 + 不短路」） */
  readonly expectRuleSequence?: readonly string[];
}

const CASES: readonly RuleCase[] = [
  {
    name: "验收#1 合法 spec（core e2e-real 带 command + 非 core unit + e2e-mock 带保真说明）→ ok",
    acceptance: [
      item("A1", { core: true, type: "e2e-real", command: "node -v" }),
      item("A2"),
      item("A3", { type: "e2e-mock", command: "node -v", mockFidelityNote: "stub 外部 API，进程与文件系统真实" }),
    ],
    expectOk: true,
  },
  {
    name: "验收#2 空 acceptance → 拒，failures 含 rule①",
    acceptance: [],
    expectOk: false,
    mustContain: ["rule①"],
    expectRuleSequence: ["rule①", "rule⑤"],
  },
  {
    name: "验收#3 core 用例 type=manual → 拒，failures 含 rule② 与该 id",
    acceptance: [
      item("A1", { core: true, type: "manual" }),
      item("A2"),
    ],
    expectOk: false,
    mustContain: ["rule②", "A1", "manual"],
    mustNotContain: ["rule①", "rule③", "rule④", "rule⑤"],
  },
  {
    name: "验收#4 e2e-real 无 command → 拒，failures 含 rule③ 与该 id",
    acceptance: [
      item("A1", { type: "e2e-real" }),
      item("A2"),
    ],
    expectOk: false,
    mustContain: ["rule③", "A1", "缺可执行 command"],
    mustNotContain: ["rule②", "rule⑤"],
  },
  {
    name: "验收#5 e2e-real command 首 token 不存在（no-such-bin-xyz foo）→ 拒，failures 含 rule③",
    acceptance: [
      item("A1", { type: "e2e-real", command: "no-such-bin-xyz foo" }),
      item("A2"),
    ],
    expectOk: false,
    mustContain: ["rule③", "A1", "no-such-bin-xyz"],
    mustNotContain: ["缺可执行 command"],
  },
  {
    name: "验收#6 e2e-mock 无 mockFidelityNote → 拒，failures 含 rule④ 与该 id",
    acceptance: [
      item("A1", { type: "e2e-mock", command: "node -v" }),
      item("A2"),
    ],
    expectOk: false,
    mustContain: ["rule④", "A1", "mock 保真说明"],
    mustNotContain: ["rule③", "rule⑤"],
  },
  {
    name: "验收#7 无 unit 用例 → 拒，failures 含 rule⑤",
    acceptance: [
      item("A1", { core: true, type: "e2e-real", command: "node -v" }),
      item("A2", { type: "e2e-mock", command: "node -v", mockFidelityNote: "stub 网络，其余真实" }),
    ],
    expectOk: false,
    mustContain: ["rule⑤", "unit"],
    mustNotContain: ["rule①", "rule②", "rule③", "rule④"],
  },
  {
    name: "验收#8 多缺口同时存在（core manual + e2e-real 缺 command + e2e-mock 缺说明 + 无 unit）→ 按规则序号升序全列出",
    acceptance: [
      item("A1", { core: true, type: "manual" }),
      item("A2", { type: "e2e-real" }),
      item("A3", { type: "e2e-mock", command: "node -v" }),
    ],
    expectOk: false,
    mustContain: ["rule②", "rule③", "rule④", "rule⑤"],
    expectRuleSequence: ["rule②", "rule③", "rule④", "rule⑤"],
  },
  {
    name: "验收#9 非 core 的 manual 用例不触发 rule②（manual 保留但核心禁用）",
    acceptance: [
      item("A1", { core: true, type: "e2e-real", command: "node -v" }),
      item("A2", { type: "manual" }),
      item("A3"),
    ],
    expectOk: true,
  },
  {
    name: "边界#1 command 全空白视为缺失 → rule③",
    acceptance: [item("A1", { type: "e2e-real", command: "   " }), item("A2")],
    expectOk: false,
    mustContain: ["rule③", "A1", "缺可执行 command"],
  },
  {
    name: "边界#2 mockFidelityNote 全空白视为缺失 → rule④",
    acceptance: [item("A1", { type: "e2e-mock", command: "node -v", mockFidelityNote: "  " }), item("A2")],
    expectOk: false,
    mustContain: ["rule④", "A1"],
  },
  {
    name: "边界#3 core e2e-mock 带 command 与保真说明 → 合法（core 的 e2e-mock 同样满足 rule②）",
    acceptance: [
      item("A1", { core: true, type: "e2e-mock", command: "node -v", mockFidelityNote: "stub 外部 API，其余真实" }),
      item("A2"),
    ],
    expectOk: true,
  },
  {
    name: "边界#4 command 为绝对路径且可执行 → 合法（which 等价检查含路径分隔符分支）",
    acceptance: [
      item("A1", { core: true, type: "e2e-real", command: "/bin/echo hello" }),
      item("A2"),
    ],
    expectOk: true,
  },
  {
    // 目录对 accessSync(X_OK) 恒真（天然可遍历），实现须叠加 isFile 检查才与
    // `which` 行为一致（实测 macOS which <目录> 返回 not found）
    name: "边界#5 command 首 token 是目录（绝对路径）→ 规则③拒绝",
    acceptance: [
      item("A1", { core: true, type: "e2e-real", command: `${process.cwd()} -foo` }),
      item("A2"),
    ],
    expectOk: false,
    mustContain: ["rule③", "A1", "在 PATH 不可解析"],
    mustNotContain: ["缺可执行 command"],
  },
];

describe("checkSpecRules（u3 spec gate 五规则）", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const result = checkSpecRules(makeSpec(c.acceptance));
      expect(result.ok).toBe(c.expectOk);
      expect(result.failures.length === 0).toBe(c.expectOk);
      for (const sub of c.mustContain ?? []) {
        expect(
          result.failures.some((f) => f.includes(sub)),
          `failures 应包含 "${sub}"，实际: ${JSON.stringify(result.failures)}`,
        ).toBe(true);
      }
      for (const sub of c.mustNotContain ?? []) {
        expect(
          result.failures.some((f) => f.includes(sub)),
          `failures 不应包含 "${sub}"，实际: ${JSON.stringify(result.failures)}`,
        ).toBe(false);
      }
      if (c.expectRuleSequence) {
        expect(ruleTags(result.failures)).toEqual(c.expectRuleSequence);
      }
    });
  }
});
