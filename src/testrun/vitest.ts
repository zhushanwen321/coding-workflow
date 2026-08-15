/**
 * vitest TestRun 适配器（canon《design-rewrite-architecture.md》附录 B.2；
 * 判定语义锁定于 docs/rewrite/acceptance/u5-acceptance.md「规格锁定 · vitest」）。
 *
 * translate：command 缺失 → 默认全量命令；存在 → 确保含 --reporter=json
 * （parse 只消费 JSON reporter 产物，默认 reporter 的人类可读输出无法折叠 cases）。
 * parse：stdout 文件 → JSON → testResults[].assertionResults[] 折叠 cases；
 * 单一验收对应多断言时 id 恒为验收 id、name 取断言 fullName（缺时退 title）。
 * skipped/todo 映射 fail（M0 不认 skip）；断言非 passed 而 exitCode=0 的矛盾输入
 * 以断言 status 为准（cases 如实，不掩盖）；JSON 非法/形状不符抛错，绝不伪造 cases。
 */
import { readFileSync } from "node:fs";

import type { AcceptanceItem } from "../events/types.js";
import type { EvidenceReport, TestRunAdapter } from "./types.js";

const JSON_REPORTER_FLAG = "--reporter=json";
const DEFAULT_COMMAND = "npx vitest run --reporter=json";
/** vitest JSON reporter 中唯一被认可的通过态；failed/skipped/todo 均映射 fail */
const PASSED = "passed";

/** 校验后可直接折叠成 cases 的断言（name 已择定 fullName/title，status 保持原样） */
interface FlattenedAssertion {
  name: string;
  status: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 运行时形状校验 + 扁平化（unknown → 断言列表）。只校验 parse 走过的路径：
 * testResults / assertionResults 必须是数组、每条断言必须有字符串 status 与
 * 可用的 name 来源（fullName 优先，缺时退 title）。形状不符抛错，不降级伪造。
 */
function flattenAssertions(raw: unknown, stdoutPath: string): FlattenedAssertion[] {
  const where = `vitest JSON 形状不符（${stdoutPath}）`;
  if (!isRecord(raw) || !Array.isArray(raw.testResults)) {
    throw new Error(`${where}: 顶层缺 testResults 数组。确认命令含 --reporter=json（translate 会自动追加）`);
  }
  const flattened: FlattenedAssertion[] = [];
  for (const suite of raw.testResults) {
    if (!isRecord(suite) || !Array.isArray(suite.assertionResults)) {
      throw new Error(`${where}: testResults 条目缺 assertionResults 数组`);
    }
    for (const assertion of suite.assertionResults) {
      if (!isRecord(assertion) || typeof assertion.status !== "string") {
        throw new Error(`${where}: assertionResults 条目缺字符串 status`);
      }
      // fullName 本身即 describe/it 链接，是首选 name；缺时退 title
      const fullName = assertion.fullName;
      const title = assertion.title;
      if (typeof fullName === "string" && fullName.length > 0) {
        flattened.push({ name: fullName, status: assertion.status });
      } else if (typeof title === "string") {
        flattened.push({ name: title, status: assertion.status });
      } else {
        throw new Error(`${where}: assertionResults 条目缺 fullName/title 可用作 name`);
      }
    }
  }
  return flattened;
}

/** 验收 → 可执行命令：保证产物是 JSON（parse 的前置契约） */
function translate(acceptance: AcceptanceItem): string {
  if (!acceptance.command) {
    return DEFAULT_COMMAND;
  }
  // includes 而非 token 精确匹配：--reporter=json,verbose 等组合形式也视为「已有」
  if (acceptance.command.includes(JSON_REPORTER_FLAG)) {
    return acceptance.command;
  }
  return `${acceptance.command} ${JSON_REPORTER_FLAG}`;
}

/** cw 捕获的 stdout 文件 + exitCode → EvidenceReport；解析失败抛错 */
function parse(stdoutPath: string, exitCode: number, acceptance: AcceptanceItem): EvidenceReport {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(stdoutPath, "utf8"));
  } catch (error) {
    throw new Error(
      `vitest 适配器 parse 失败：${stdoutPath} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）。` +
        `确认命令含 --reporter=json（translate 会自动追加）；默认 reporter 的人类可读输出无法折叠 cases`,
    );
  }
  const cases: EvidenceReport["cases"] = flattenAssertions(raw, stdoutPath).map((a) => ({
    id: acceptance.id,
    name: a.name,
    status: a.status === PASSED ? "pass" : "fail",
  }));
  // exitCode 透传不改写：断言级事实（cases）与进程级事实（exitCode）由上层各自裁决
  return { exitCode, cases, rawPath: stdoutPath };
}

export const vitestAdapter: TestRunAdapter = { type: "vitest", translate, parse };
