/**
 * u4b 单测：nameMatch 纯函数（u4b 验收文档「单测验收」1 + 边界）。
 *
 * nameMatch 的输入是数据值（AcceptanceItem / EvidenceReport），fixture 直接构造
 * 对象字面量——这不是 mock（无进程 / 文件系统 / 框架替身），与 u5 适配器测试的
 * 真实子进程 fixture 分层：这里只锁定判定语义本身。
 *
 * case 结构刻意覆盖两个适配器的 name 形态：
 *   - e2e-sh：name 是标记行原文（"A1 PASS"）；
 *   - vitest：name 是断言全名（describe + it 拼接，如 "验收 A1 通过"）。
 */
import { describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import type { EvidenceReport } from "../src/testrun/types.js";
import { nameMatch } from "../src/verify/name-match.js";

function ac(id: string): AcceptanceItem {
  return { id, core: false, title: `标题-${id}`, type: "e2e-real", command: "bash e2e/run.sh" };
}

function report(cases: EvidenceReport["cases"]): EvidenceReport {
  return { exitCode: 0, cases, rawPath: "/tmp/fixture-report.json" };
}

describe("验收1：nameMatch 三态判定", () => {
  it("id 存在且 pass → pass（e2e-sh 标记行 / vitest 全名两种 name 形态）", () => {
    const e2e = nameMatch(ac("A1"), report([{ id: "A1", name: "A1 PASS", status: "pass" }]));
    expect(e2e.pass).toBe(true);

    const vitest = nameMatch(
      ac("A1"),
      report([{ id: "A1", name: "验收 A1 真实通过的单测", status: "pass" }]),
    );
    expect(vitest.pass).toBe(true);
  });

  it("存在但 fail → fail 且 reason 含「执行失败」（列出 fail 用例名）", () => {
    const out = nameMatch(ac("A1"), report([{ id: "A1", name: "A1 FAIL", status: "fail" }]));
    expect(out.pass).toBe(false);
    expect(out.reason).toContain("执行失败");
    expect(out.reason).toContain("A1 FAIL");
  });

  it("缺失 → fail 且 reason 含「未出现在产物」（用例未运行或标记缺失）", () => {
    const out = nameMatch(
      ac("A1"),
      report([
        { id: "A2", name: "A2 PASS", status: "pass" },
        { id: "A3", name: "no-markers", status: "fail" },
      ]),
    );
    expect(out.pass).toBe(false);
    expect(out.reason).toContain("未出现在产物");
    expect(out.reason).toContain("用例未运行或标记缺失");
  });
});

describe("nameMatch 边界（规格未逐条锁定但影响正确性的语义）", () => {
  it("多命中聚合：同 id 多条用例（vitest 多断言折叠），任一 fail → 整体验收 fail", () => {
    const out = nameMatch(
      ac("A1"),
      report([
        { id: "A1", name: "验收 A1 分支一", status: "pass" },
        { id: "A1", name: "验收 A1 分支二", status: "fail" },
      ]),
    );
    expect(out.pass).toBe(false);
    expect(out.reason).toContain("执行失败");
    expect(out.reason).toContain("2 条命中用例中 1 条 fail");
  });

  it("词边界：A1 不命中 \"A10 xxx\"（同 unit 常见 A1/A10 并存，裸子串会把 A10 错记给 A1）", () => {
    const out = nameMatch(ac("A1"), report([{ id: "A1", name: "A10 另一条验收", status: "pass" }]));
    expect(out.pass).toBe(false);
    expect(out.reason).toContain("未出现在产物");
  });

  it("词边界：命中 \"A1: xxx\"、\"行首 A1 收尾\"、含中文邻接的 \"标签A1检测\"", () => {
    for (const name of ["A1: 带冒号场景", "前置说明 A1", "标签A1检测"]) {
      const out = nameMatch(ac("A1"), report([{ id: "A1", name, status: "pass" }]));
      expect(out.pass, `name="${name}" 应命中`).toBe(true);
    }
  });

  it("正则元字符 id（如 \"A1.2\"）不误炸也不误匹配", () => {
    const hit = nameMatch(ac("A1.2"), report([{ id: "A1.2", name: "A1.2 通过", status: "pass" }]));
    expect(hit.pass).toBe(true);

    const miss = nameMatch(ac("A1.2"), report([{ id: "A1", name: "A12 通过", status: "pass" }]));
    expect(miss.pass).toBe(false);
    expect(miss.reason).toContain("未出现在产物");
  });
});
