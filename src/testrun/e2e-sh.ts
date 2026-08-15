/**
 * e2e-sh TestRun 适配器（canon《design-rewrite-architecture.md》附录 B.2；
 * 判定语义锁定于 docs/rewrite/acceptance/u5-acceptance.md「规格锁定 · e2e-sh」）。
 *
 * translate：command 原样返回（e2e 脚本自写标记行，适配器不改写）；缺失抛错——
 * e2e-real 验收的 command 是 spec gate 规则③的必填项，这里不代拟。
 * parse：逐行扫描 `^A<id> (PASS|FAIL)$` 标记行 → cases（id 取自标记，name 记标记行
 * 原文）；同一 id 多次出现以最后一次为准。防伪造语义（验收文档同节）：
 *   - 标记缺失 + exitCode≠0 → 该验收整体 fail（name="no-markers"），不抛错；
 *   - 标记缺失 + exitCode=0 → 抛错（无区分力——echo ok 类假命令在旧树新树都绿，
 *     parse 侧必须拒绝这种「看似成功」的产物）；
 *   - 标记 id 全部与验收 id 不符 → 抛错（脚本输出与当前验收无关）。条目 5/6 的
 *     相容口径：一次运行可输出多条验收的标记（如 A1/A2），但至少一条须命中当前
 *     parse 的验收 id，否则视为张冠李戴。
 */
import { readFileSync } from "node:fs";

import type { AcceptanceItem } from "../events/types.js";
import type { EvidenceReport, TestRunAdapter } from "./types.js";

/** 标记行约定（验收文档锁定原文）：^A<id> PASS|FAIL，id 为字母数字连字符 */
const MARKER_RE = /^A([A-Za-z0-9-]+) (PASS|FAIL)$/;
const NO_MARKERS_NAME = "no-markers";
/**
 * fx-1 R3：marker 约定的显式格式说明，追加在两类 parse 错误的 message 里——
 * 「A 前缀」只在适配器实现里隐含（折叠 key = "A" + 标记列文本，验收 id 须 A 开头
 * 或与标记列完全一致），终验中 pi 试错 3 轮才悟出；错误信息直接给出约定本身。
 */
const MARKER_FORMAT_NOTE =
  "e2e-sh 验收脚本须输出标记行 `A<验收id> PASS` 或 `A<验收id> FAIL`（A 前缀 + 验收 id + 空格 + 结果），脚本 exit code 与标记行一致。";

/** 验收 → 可执行命令：原样返回；缺失抛错（e2e-sh 不自造命令） */
function translate(acceptance: AcceptanceItem): string {
  if (!acceptance.command) {
    throw new Error(
      `e2e-sh 适配器无法 translate 验收 ${acceptance.id}：command 缺失。` +
        "e2e 脚本由验收自带（自写 A<id> PASS/FAIL 标记行 + exit code），适配器不改写也不代拟",
    );
  }
  return acceptance.command;
}

/** cw 捕获的 stdout 文件 + exitCode → EvidenceReport；解析失败抛错 */
function parse(stdoutPath: string, exitCode: number, acceptance: AcceptanceItem): EvidenceReport {
  const stdout = readFileSync(stdoutPath, "utf8");
  // Map 的后写覆盖 = 「同一 id 多次出现以最后一次为准」；value 保留标记行原文作 name。
  // id 拼回 "A" 前缀：正则按验收文档锁定原文（A 为字面量锚），完整 id 是第一列
  // 全文（如 "A1 PASS" → id "A1"，与 AcceptanceItem.id 的 "A1" 惯例一致）
  const markers = new Map<string, { name: string; status: "pass" | "fail" }>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = MARKER_RE.exec(line);
    if (!match) {
      continue;
    }
    markers.set(`A${match[1]}`, { name: line, status: match[2] === "PASS" ? "pass" : "fail" });
  }

  if (markers.size === 0) {
    if (exitCode === 0) {
      throw new Error(
        `e2e-sh 适配器 parse 失败：${stdoutPath} 无标记行且 exitCode=0（无区分力，疑似 echo ok 类假命令）。` +
          `脚本须输出 "^A<id> (PASS|FAIL)" 标记行（期望出现验收 ${acceptance.id} 的标记）。${MARKER_FORMAT_NOTE}`,
      );
    }
    return {
      exitCode,
      cases: [{ id: acceptance.id, name: NO_MARKERS_NAME, status: "fail" }],
      rawPath: stdoutPath,
    };
  }

  if (!markers.has(acceptance.id)) {
    const seen = [...markers.keys()].join(", ");
    throw new Error(
      `e2e-sh 适配器 parse 失败：${stdoutPath} 标记 id 与验收 id 不符——出现 [${seen}]，期望 ${acceptance.id}。` +
        `核对脚本标记的验收 id 与当前 verify 的验收条目。${MARKER_FORMAT_NOTE}`,
    );
  }

  const cases: EvidenceReport["cases"] = [...markers.entries()].map(([id, marker]) => ({
    id,
    name: marker.name,
    status: marker.status,
  }));
  // exitCode 透传：标记行（用例级事实）与 exit code（脚本级事实）由上层各自裁决
  return { exitCode, cases, rawPath: stdoutPath };
}

export const e2eShAdapter: TestRunAdapter = { type: "e2e-sh", translate, parse };
