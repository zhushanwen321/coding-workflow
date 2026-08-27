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

import type {
  AcceptanceItem,
  SpecSubmittedPayload,
  SplitEntry,
} from "../src/events/types.js";
import { checkSpecRules } from "../src/gates/spec-rules.js";

/** 验收用例工厂：默认非 core 的 unit 用例，按需覆写 */
function item(id: string, overrides: Partial<AcceptanceItem> = {}): AcceptanceItem {
  return { id, core: false, title: `${id} 一句话描述`, type: "unit", ...overrides };
}

/** spec payload 工厂：规则只读 acceptance 与 split（⑩⑬ 作用域输入），其余字段给最小合法占位 */
function makeSpec(
  acceptance: readonly AcceptanceItem[],
  split: readonly SplitEntry[] = [],
): SpecSubmittedPayload {
  return {
    unitId: "u3-test",
    specHash: "sha256:placeholder",
    acceptance: [...acceptance],
    contracts: [],
    split: [...split],
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

// ── fa-1（M7 设计《无区分力验收设防与挂法归因》D2/D7，验收基线 V1/V9 的函数级投影）：
// 规则⑬ unit 层纯 typecheck 形态拦截（fail/warning 双档）与规则⑭ e2e 型缺省
// runner 与 vitest/pytest 调用的隐式错配 warning。夹具沿用 item/makeSpec 工厂，
// 均含一条默认 unit 条目（A2）过规则⑤，避免⑤噪声混入断言 ──

describe("规则⑬ unit 层 typecheck 形态拦截（fa-1）", () => {
  it("⑬-1 unit 层 npx tsc --noEmit → 拒，failures 含规则⑬与两条恢复路径", () => {
    const result = checkSpecRules(
      makeSpec([item("A1", { command: "npx tsc --noEmit" }), item("A2")]),
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    const hit = result.failures.find((f) => f.includes("规则⑬"));
    expect(hit).toBeDefined();
    expect(hit).toContain("断言具体产物");
    expect(hit).toContain('layer: "topic"');
  });

  it("⑬-2 unit 层 npm run typecheck → ok=true，warnings 含规则⑬（script 名族 warning 档，不与规则⑪共存）", () => {
    const result = checkSpecRules(
      makeSpec([item("A1", { command: "npm run typecheck" }), item("A2")]),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings ?? []).toHaveLength(1);
    const hit = result.warnings?.[0];
    expect(hit).toContain("规则⑬");
    // warning 档文案要素：script 体歧义点名 + 内联展开恢复动作
    expect(hit).toContain("词法层不可见");
    expect(hit).toContain("内联");
  });

  it("⑬-3 unit 层 npx tsc --noEmit && npx vitest run tests/x.test.ts → 复合命令放行（零⑬输出）", () => {
    const result = checkSpecRules(
      makeSpec([
        item("A1", { command: "npx tsc --noEmit && npx vitest run tests/x.test.ts" }),
        item("A2"),
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.failures.some((f) => f.includes("规则⑬"))).toBe(false);
    expect((result.warnings ?? []).some((w) => w.includes("规则⑬"))).toBe(false);
  });

  it("⑬-4 layer: \"topic\" + split 非空的 typecheck 条目 → 零⑬输出（topic 豁免，root typecheck 链是集成层合法形态）", () => {
    const result = checkSpecRules(
      makeSpec(
        [item("A1", { layer: "topic", command: "npx tsc --noEmit" }), item("A2")],
        [{ unitId: "child-a", dependsOn: [] }],
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.failures.some((f) => f.includes("规则⑬"))).toBe(false);
    expect((result.warnings ?? []).some((w) => w.includes("规则⑬"))).toBe(false);
  });

  it("⑬-5 unit 层真测试命令 npx vitest run tests/a.test.ts → 零⑬输出", () => {
    const result = checkSpecRules(
      makeSpec([item("A1", { command: "npx vitest run tests/a.test.ts" }), item("A2")]),
    );
    expect(result.ok).toBe(true);
    expect(result.failures.some((f) => f.includes("规则⑬"))).toBe(false);
    expect((result.warnings ?? []).some((w) => w.includes("规则⑬"))).toBe(false);
  });

  it("⑬-6 多缺口并列：⑬ fail 与规则③缺口共存 → failures 全列不短路且升序", () => {
    const result = checkSpecRules(
      makeSpec([
        item("A1", { command: "npx tsc --noEmit" }),
        item("A2", { type: "e2e-real" }), // 规则③：e2e-real 缺可执行 command
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("rule③"))).toBe(true);
    expect(result.failures.some((f) => f.includes("规则⑬"))).toBe(true);
    const idx3 = result.failures.findIndex((f) => f.includes("rule③"));
    const idx13 = result.failures.findIndex((f) => f.includes("规则⑬"));
    expect(idx3).toBeLessThan(idx13);
  });

  it("⑬-7 边界锁定：pnpm typecheck / yarn typecheck（省略 run）命中 warning 档", () => {
    for (const command of ["pnpm typecheck", "yarn typecheck"]) {
      const result = checkSpecRules(makeSpec([item("A1", { command }), item("A2")]));
      expect(result.ok, command).toBe(true);
      expect((result.warnings ?? []).some((w) => w.includes("规则⑬")), command).toBe(
        true,
      );
    }
  });

  it("⑬-8 边界锁定：npm exec tsc --noEmit 不在前缀枚举内 → 零⑬输出（诚实边界，同规则⑪不猜 wrapper）", () => {
    const result = checkSpecRules(
      makeSpec([item("A1", { command: "npm exec tsc --noEmit" }), item("A2")]),
    );
    expect(result.ok).toBe(true);
    expect(result.failures.some((f) => f.includes("规则⑬"))).toBe(false);
    expect((result.warnings ?? []).some((w) => w.includes("规则⑬"))).toBe(false);
  });
});

describe("规则⑭ e2e 型缺省 runner 与 vitest/pytest 调用错配 warning（fa-1）", () => {
  it("⑭-1 e2e-real + npx vitest run tests/x.test.ts + 无 runner → ok=true，warnings 含规则⑭与两条恢复动作", () => {
    const result = checkSpecRules(
      makeSpec([
        item("A1", {
          core: true,
          type: "e2e-real",
          command: "npx vitest run tests/x.test.ts",
        }),
        item("A2"),
      ]),
    );
    expect(result.ok).toBe(true);
    const hit = (result.warnings ?? []).find((w) => w.includes("规则⑭"));
    expect(hit).toBeDefined();
    expect(hit).toContain('"runner": "vitest"');
    expect(hit).toContain('"unit" 或 "integration"');
    // 事实段：错配后果（e2e-sh 路由找标记行，解析必挂）
    expect(hit).toContain("e2e-sh");
    expect(hit).toContain("verify 必挂");
  });

  it("⑭-2 e2e-real + bash scripts/check.sh + 无 runner → 零⑭输出（合法缺省 e2e-sh 对照）", () => {
    const result = checkSpecRules(
      makeSpec([
        item("A1", { core: true, type: "e2e-real", command: "bash scripts/check.sh" }),
        item("A2"),
      ]),
    );
    expect(result.ok).toBe(true);
    expect((result.warnings ?? []).some((w) => w.includes("规则⑭"))).toBe(false);
  });

  it("⑭-3 同⑭-1 但显式 runner: \"vitest\" → 零⑭输出（显式声明不查，合法性归规则⑧）", () => {
    const result = checkSpecRules(
      makeSpec([
        item("A1", {
          core: true,
          type: "e2e-real",
          command: "npx vitest run tests/x.test.ts",
          runner: "vitest",
        }),
        item("A2"),
      ]),
    );
    expect(result.ok).toBe(true);
    expect((result.warnings ?? []).some((w) => w.includes("规则⑭"))).toBe(false);
  });
});
