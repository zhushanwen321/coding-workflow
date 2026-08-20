/**
 * e2e-sh TestRun 适配器（canon《design-rewrite-architecture.md》附录 B.2；
 * 判定语义锁定于 docs/rewrite/acceptance/u5-acceptance.md「规格锁定 · e2e-sh」）。
 *
 * translate：command 原样返回（e2e 脚本自写标记行，适配器不改写）；缺失抛错——
 * e2e-real 验收的 command 是 spec gate 规则③的必填项，这里不代拟。
 * parse：逐行扫描 `^<id> (PASS|FAIL)$` 标记行 → cases（标记行第一列 = 验收 id
 * 全文，不要求任何前缀；id 可含 `.` `_` `-`——与 spec gate 规则⑦同源字符集；
 * name 记标记行原文）；同一 id 多次出现以最后一次为准。
 * 防伪造语义（验收文档同节）：
 *   - 标记缺失 + exitCode≠0 → 该验收整体 fail（name="no-markers"），不抛错；
 *   - 标记缺失 + exitCode=0 → 抛错（无区分力——echo ok 类假命令在旧树新树都绿，
 *     parse 侧必须拒绝这种「看似成功」的产物）；
 *   - 标记 id 全部与验收 id 不符 → 抛错（脚本输出与当前验收无关）。条目 5/6 的
 *     相容口径：一次运行可输出多条验收的标记（如 A1/A2），但至少一条须命中当前
 *     parse 的验收 id，否则视为张冠李戴。
 */
import { readFileSync } from "node:fs";

import { ACCEPTANCE_ID_RE, type AcceptanceItem } from "../events/types.js";
import type { EvidenceReport, TestRunAdapter } from "./types.js";

/**
 * ACCEPTANCE_ID_RE 的字符集主体（剥去 ^ $ 行锚）。源常量自带行锚，直接嵌入
 * 分组会产出 `^([A-Za-z0-9…$) (PASS|FAIL)$`——内嵌 $ 在非行尾恒不匹配，marker
 * 行全部失配。派生前必须剥锚（rv-2 两路同源：合法 id 集与 spec gate 规则⑦一致，
 * 禁止两处手写正则漂移）。
 */
const ID_CHARSET_SOURCE = ACCEPTANCE_ID_RE.source.replace(/^\^/, "").replace(/\$$/, "");
/**
 * 标记行约定：`<验收id原文> PASS|FAIL`，id 字母数字开头、可含 `.` `_ `-`（第一列 =
 * 验收 id 全文；与 spec gate 规则⑦的 ACCEPTANCE_ID_RE 同源派生，vitest 路径的
 * id 不经标记行，不受此正则约束）
 */
const MARKER_RE = new RegExp(`^(${ID_CHARSET_SOURCE}) (PASS|FAIL)$`);
const NO_MARKERS_NAME = "no-markers";
/**
 * fx-1 R3：marker 约定的显式格式说明，追加在两类 parse 错误的 message 里——
 * 历史教训（final-gate-report.md §5 R3）：约定只在实现里隐含时，终验中 pi 试错
 * 3 轮才悟出；错误信息直接给出约定本身。旧版约定要求 A 前缀（`A<id> PASS`），
 * 审查实测把 agent 引向 `AA1 PASS` 类错误写法（id=A1 时按文案执行产出被拒），
 * 现约定为标记行第一列即验收 id 全文；旧脚本写 `A1 PASS`（id=A1）在新正则下
 * 原样匹配，天然向后兼容。
 */
const MARKER_FORMAT_NOTE =
  "e2e-sh 验收脚本须为每条验收输出标记行 `<验收id原文> PASS` 或 `<验收id原文> FAIL`" +
  "（验收 id + 空格 + 结果），脚本 exit code 须与标记行一致。";

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
  // 折叠 key = 捕获组原文（标记行第一列 = 验收 id 全文，如 "TC1 PASS" → id "TC1"，
  // 与 AcceptanceItem.id 一致——不要求也不剥离任何前缀）
  const markers = new Map<string, { name: string; status: "pass" | "fail" }>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = MARKER_RE.exec(line);
    if (!match) {
      continue;
    }
    markers.set(match[1], { name: line, status: match[2] === "PASS" ? "pass" : "fail" });
  }

  if (markers.size === 0) {
    if (exitCode === 0) {
      throw new Error(
        `e2e-sh 适配器 parse 失败：${stdoutPath} 无标记行且 exitCode=0（无区分力，疑似 echo ok 类假命令）。` +
          `脚本须输出 "<验收id> (PASS|FAIL)" 标记行（期望出现验收 ${acceptance.id} 的标记）。${MARKER_FORMAT_NOTE}`,
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
