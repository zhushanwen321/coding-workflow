/**
 * 名字级比对（canon 子文档 2《design-child-testrun.md》§4；u4b 验收文档锁定签名）。
 *
 * 单验收对单报告：验收 id 作为「名字」出现在 report.cases 中（词边界匹配）且全部
 * pass → pass；命中但任一 fail → fail（reason=「执行失败」）；无命中 → fail
 * （reason=「未出现在产物（用例未运行或标记缺失）」）。
 *
 * 为什么按 name 而非 case.id 匹配：vitest 适配器折叠 cases 时 id 恒为当前验收 id
 * （u5 锁定语义），id 列对该验收无区分度——「测试名不含验收 id → 未出现在产物」
 * 这条判定只能落在 name 上；e2e-sh 的 name 是标记行原文（必含 id），同一规则天然
 * 覆盖两个适配器。词边界（前后非 [A-Za-z0-9-]）防 A1 误命中 "A10"：同 unit 内
 * A1 与 A10 并存是常态，裸子串匹配会把 A10 的通过错记给 A1（漏报方向的保守取舍：
 * 带分隔符的变体形式（如 "x-A1"）不命中，宁可判「未出现在产物」交人工核对）。
 */
import type { AcceptanceItem } from "../events/types.js";
import type { EvidenceReport } from "../testrun/types.js";

export interface NameMatchOutcome {
  pass: boolean;
  reason: string;
}

/** 单验收对单报告的名字级判定（纯函数，无 IO） */
export function nameMatch(acceptance: AcceptanceItem, report: EvidenceReport): NameMatchOutcome {
  const matched = report.cases.filter((c) => nameContainsId(c.name, acceptance.id));
  if (matched.length === 0) {
    return {
      pass: false,
      reason:
        `验收 ${acceptance.id} 未出现在产物（用例未运行或标记缺失）。` +
        "匹配规则：vitest 适配器要求测试的 fullName/describe 以词边界包含验收 id" +
        "（如 describe('${acceptance.id} xxx') 或 it('${acceptance.id} xxx')）；" +
        "e2e-sh 适配器要求脚本输出标记行 '<验收id> PASS|FAIL'。" +
        "修复后重新 cw evidence submit --kind build 再 cw verify。",
    };
  }
  const failed = matched.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    return {
      pass: false,
      reason:
        `验收 ${acceptance.id} 执行失败（${matched.length} 条命中用例中 ${failed.length} 条 fail：` +
        `${failed.map((c) => c.name).join("; ")}）`,
    };
  }
  return {
    pass: true,
    reason: `验收 ${acceptance.id} 命中 ${matched.length} 条用例且全部通过`,
  };
}

/** id 是否以独立标识符形态出现在 name 中（前后不是 [A-Za-z0-9-]，串首/尾视为边界） */
function nameContainsId(name: string, id: string): boolean {
  const pattern = new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(id)}($|[^A-Za-z0-9-])`);
  return pattern.test(name);
}

/** 正则元字符转义（id 是 spec 作者输入，可含 . 等字符） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
