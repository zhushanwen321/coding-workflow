/**
 * mx-2 runner 显式声明路由单测（docs/rewrite/acceptance/mx2-acceptance.md §5 T7-T9）。
 *
 * T7 显式优先：runner 覆盖 type 默认推导（审查 D1 的核心缺陷修复）；
 * T8 推导兜底回归：无 runner 的 type 推导行为与现状逐字节一致（回归锁）；
 * T9 规则⑧：非法 runner 在 spec 提交时被 gate 拦（消息含合法值清单 + 恢复动作），
 * 合法值通过——对齐 rv-2 T1 的 checkSpecRules 直调范式。
 */
import { describe, expect, it } from "vitest";

import type { AcceptanceItem, SpecSubmittedPayload } from "../src/events/types.js";
import { checkSpecRules } from "../src/gates/spec-rules.js";
import { AcceptanceItemSchema, validateSpecFile } from "../src/handlers/spec-schema.js";
import { defaultRegistry, knownAdapterTypes } from "../src/testrun/registry.js";
import { adapterTypeFor } from "../src/verify/run.js";

/** 非 core 的 unit 条目工厂：规则①-⑦全不触发（id 合法、type=unit、split 空），只剩规则⑧可判 */
function unitItem(id: string, runner?: string): AcceptanceItem {
  return { id, core: false, title: `${id} 验收`, type: "unit", runner };
}

function makeSpec(acceptance: AcceptanceItem[]): SpecSubmittedPayload {
  return { unitId: "mx2-routing", specHash: "deadbeef", acceptance, contracts: [], split: [] };
}

describe("T7 显式优先（runner 覆盖 type 默认推导）", () => {
  it('type=unit + runner=pytest → 路由 pytest（不再强制 vitest——审查 D1 核心缺陷修复）', () => {
    expect(adapterTypeFor("unit", "pytest")).toBe("pytest");
  });

  it('type=e2e-real + runner=playwright → 路由 playwright（不再强制 e2e-sh）', () => {
    expect(adapterTypeFor("e2e-real", "playwright")).toBe("playwright");
  });

  it("路由结果在 defaultRegistry 全部可解析（确定性查找闭环：显式值 → 适配器实例）", () => {
    const registry = defaultRegistry();
    for (const runner of knownAdapterTypes()) {
      const routed = adapterTypeFor("unit", runner);
      expect(registry.get(routed)?.type).toBe(runner);
    }
    expect(registry.get(adapterTypeFor("unit", "pytest"))?.type).toBe("pytest");
    expect(registry.get(adapterTypeFor("e2e-real", "playwright"))?.type).toBe("playwright");
  });

  it("e2e 型验收也可显式声明 pytest（runner 是唯一显式通道，不限定 type 组合）", () => {
    expect(adapterTypeFor("e2e-mock", "pytest")).toBe("pytest");
    expect(adapterTypeFor("integration", "playwright")).toBe("playwright");
  });
});

describe("T8 推导兜底回归（无 runner 字段的行为与现状逐字节一致）", () => {
  it("unit → vitest、integration → vitest（逐 case 断言）", () => {
    expect(adapterTypeFor("unit")).toBe("vitest");
    expect(adapterTypeFor("integration")).toBe("vitest");
  });

  it("e2e-real → e2e-sh、e2e-mock → e2e-sh（逐 case 断言）", () => {
    expect(adapterTypeFor("e2e-real")).toBe("e2e-sh");
    expect(adapterTypeFor("e2e-mock")).toBe("e2e-sh");
  });

  it("manual → manual（runAcceptances 已跳过，漏跳由「路由不到适配器」分支显性暴露）", () => {
    expect(adapterTypeFor("manual")).toBe("manual");
    expect(defaultRegistry().has("manual")).toBe(false);
  });

  it("runner=undefined 与 runner 省略等价；空串按未声明处理（推导兜底）", () => {
    expect(adapterTypeFor("unit", undefined)).toBe("vitest");
    expect(adapterTypeFor("e2e-real", "")).toBe("e2e-sh");
  });
});

describe("T9 规则⑧（runner 合法值 gate，spec 提交时拦）", () => {
  it('runner="jest" → spec 提交被拒，消息含合法值清单与恢复动作', () => {
    const result = checkSpecRules(makeSpec([unitItem("A1", "jest")]));
    expect(result.ok).toBe(false);
    const rule8 = result.failures.filter((f) => f.includes("规则⑧"));
    expect(rule8).toHaveLength(1);
    // 合法值清单（registry 全集）与恢复动作都在消息里
    expect(rule8[0]).toContain("vitest/e2e-sh/pytest/playwright");
    expect(rule8[0]).toContain("恢复动作");
    expect(rule8[0]).toContain('"jest"');
    expect(rule8[0]).toContain("A1");
  });

  it('runner="pytest" 合法通过（规则⑧不触发，其余规则也不触发 → ok）', () => {
    const result = checkSpecRules(makeSpec([unitItem("A1", "pytest")]));
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('runner="playwright" / "vitest" / "e2e-sh" 全部合法（与 knownAdapterTypes 全集一致）', () => {
    for (const runner of knownAdapterTypes()) {
      const result = checkSpecRules(makeSpec([unitItem("A1", runner)]));
      expect(result.failures.some((f) => f.includes("规则⑧")), `runner=${runner}`).toBe(false);
    }
  });

  it("大小写敏感：Pytest / PYTEST 均被拒（合法值须与 registry key 逐字符一致）", () => {
    for (const bad of ["Pytest", "PYTEST", "Playwright", "Vitest"]) {
      const result = checkSpecRules(makeSpec([unitItem("A1", bad)]));
      expect(result.failures.some((f) => f.includes("规则⑧")), `runner=${bad}`).toBe(true);
    }
  });

  it("缺省不校验（无 runner 字段走推导路径——回归锁：存量 spec 不因规则⑧新增而 fail）", () => {
    const result = checkSpecRules(makeSpec([unitItem("A1")]));
    expect(result.failures.some((f) => f.includes("规则⑧"))).toBe(false);
  });

  it("typebox schema 同步：runner 可选字符串通过、非字符串类型被拒（与领域类型同枚举校验链）", () => {
    const base = { id: "A1", core: false, title: "t", type: "unit" };
    expect(
      validateSpecFile({ acceptance: [{ ...base, runner: "pytest" }], contracts: [], split: [] }).ok,
    ).toBe(true);
    expect(validateSpecFile({ acceptance: [base], contracts: [], split: [] }).ok).toBe(true);
    const bad = validateSpecFile({ acceptance: [{ ...base, runner: 123 }], contracts: [], split: [] });
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.includes("/acceptance/0/runner"))).toBe(true);
    // schema 只是形状校验：runner 的合法值枚举由规则⑧裁决（gate 是唯一入口）
    expect(AcceptanceItemSchema).toBeDefined();
  });
});
