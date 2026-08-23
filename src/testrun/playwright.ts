/**
 * playwright TestRun 适配器（mx-2 验收文档 §2/§4 锁定）。
 *
 * 零依赖原则（§4）：playwright 原生支持 `--reporter=json`，不注入任何插件。
 * translate：command 缺失 → 默认全量命令；存在 → 确保含 --reporter=json
 * （幂等检查同 vitest 模式）。
 * parse：stdout 文件 → JSON → 递归 suites → specs → tests → tests[].results[]
 * 逐条折叠 cases（每个 result 一条——重试是独立事实，首次 fail + 重试 pass 的
 * flaky 会同时含 fail 与 pass 条，M0 不认 flaky）。
 * status 映射按 result 级实测词表（playwright 1.58 JSON reporter）：`passed` 是
 * 唯一通过态；failed/timedOut/skipped/interrupted/didNotRun 全部映射 fail
 * （skipped→fail 是 M0「不认 skip」口径，与 vitest/pytest 家族统一——防 skip
 * 逃逸验收）。mx-2 验收文档措辞的 expected/unexpected 是 test 级（tests[].status）
 * 词表，result 级（results[].status）实测为 passed/failed/...，两者判定语义
 * 等价（expected ⟺ 全部 result 通过），按 result 级实现以逐条如实折叠。
 * name 取 suite 路径 title > spec title 拼接（playwright 的 spec.title 即测试
 * 用例标题——test 级无 title 字段，tests[] 是同一用例在各 project 的实例），
 * 层级拼接保证验收 id 出现在任一层级文本即被 nameMatch 词边界命中（对齐
 * vitest 的 describe/it fullName 模式）。
 * 防伪造语义（§4「无区分力防线统一」，对齐 e2e-sh/vitest 家族）：
 *   - JSON 非法/形状不符（顶层缺 suites 数组，如 `{}` 或 vitest JSON）→ 抛错，
 *     绝不伪造 cases；
 *   - 零 result 且 exitCode=0 → 抛错（无区分力——echo ok 类假命令）；
 *   - 零 result 且 exitCode≠0 → 单条 fail case（exit≠0 已具区分力，如实 fail
 *     不抛错）。
 */
import { readFileSync } from "node:fs";

import type { AcceptanceItem } from "../events/types.js";
import type { EvidenceReport, TestRunAdapter } from "./types.js";

const JSON_REPORTER_FLAG = "--reporter=json";
const DEFAULT_COMMAND = `npx playwright test ${JSON_REPORTER_FLAG}`;
/** result 级唯一被认可的通过态；failed/timedOut/skipped/interrupted/didNotRun 均映射 fail */
const PASSED = "passed";
/** 零 result + exitCode≠0 时的占位 name（exit≠0 已具区分力，如实折叠为单条 fail） */
const NO_RESULTS_NAME = "no-results";
/** suite 路径与 spec 标题的连接符（">" 非 nameMatch 词字符，天然词边界） */
const NAME_SEPARATOR = " > ";

/** 校验后可直接折叠成 cases 的 result（name 已拼接层级，status 保持原样） */
interface FlattenedResult {
  name: string;
  status: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 运行时形状校验 + 扁平化（unknown → result 列表）。只校验 parse 走过的路径：
 * 顶层须有 suites 数组（vitest JSON 顶层是 testResults、`{` 空对象——形状不符
 * 抛错，不降级伪造）；每个 spec 须有字符串 title；每个 test 须有数组 results；
 * 每条 result 须有字符串 status。suite.title 允许缺省/空串（跳过该层不进 name）。
 */
function flattenResults(raw: unknown, stdoutPath: string): FlattenedResult[] {
  const where = `playwright JSON 形状不符（${stdoutPath}）`;
  if (!isRecord(raw) || !Array.isArray(raw.suites)) {
    throw new Error(
      `${where}: 顶层缺 suites 数组。确认命令含 ${JSON_REPORTER_FLAG}（translate 会自动追加）且产出的是 playwright JSON（vitest JSON 等其他产物会被拒绝）`,
    );
  }
  const flattened: FlattenedResult[] = [];
  walkSuites(raw.suites, [], where, flattened);
  return flattened;
}

function walkSuites(
  suites: unknown[],
  parentTitles: readonly string[],
  where: string,
  flattened: FlattenedResult[],
): void {
  for (const suite of suites) {
    if (!isRecord(suite)) {
      throw new Error(`${where}: suites 条目非对象`);
    }
    // file 级/嵌套 describe 的 suite.title 均进 name（空 title 层跳过，不产出 " > " 空段）
    const titles =
      typeof suite.title === "string" && suite.title.length > 0 ? [...parentTitles, suite.title] : parentTitles;
    if (suite.specs !== undefined) {
      if (!Array.isArray(suite.specs)) {
        throw new Error(`${where}: suite.specs 非数组`);
      }
      for (const spec of suite.specs) {
        if (!isRecord(spec) || typeof spec.title !== "string") {
          throw new Error(`${where}: spec 缺字符串 title`);
        }
        if (spec.tests !== undefined) {
          if (!Array.isArray(spec.tests)) {
            throw new Error(`${where}: spec.tests 非数组`);
          }
          for (const test of spec.tests) {
            if (!isRecord(test) || !Array.isArray(test.results)) {
              throw new Error(`${where}: test 缺 results 数组`);
            }
            for (const result of test.results) {
              if (!isRecord(result) || typeof result.status !== "string") {
                throw new Error(`${where}: result 缺字符串 status`);
              }
              flattened.push({ name: [...titles, spec.title].join(NAME_SEPARATOR), status: result.status });
            }
          }
        }
      }
    }
    if (suite.suites !== undefined) {
      if (!Array.isArray(suite.suites)) {
        throw new Error(`${where}: suite.suites 非数组`);
      }
      walkSuites(suite.suites, titles, where, flattened);
    }
  }
}

/** 验收 → 可执行命令：保证产物是 JSON（parse 的前置契约） */
function translate(acceptance: AcceptanceItem): string {
  if (!acceptance.command) {
    return DEFAULT_COMMAND;
  }
  // includes 而非 token 精确匹配（同 vitest 模式）：--reporter=json,line 等组合形式也视为「已有」
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
      `playwright 适配器 parse 失败：${stdoutPath} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）。` +
        `恢复动作：确认验收 command 是 playwright test 命令（如 npx playwright test，cw 会自动追加 ${JSON_REPORTER_FLAG}），` +
        `或改 runner/type 路由（runner 显式声明 playwright / type 缺省推导见 src/verify/run.ts 的 adapterTypeFor）。`,
    );
  }
  const cases: EvidenceReport["cases"] = flattenResults(raw, stdoutPath).map((r) => ({
    id: acceptance.id,
    name: r.name,
    status: r.status === PASSED ? "pass" : "fail",
  }));

  if (cases.length === 0) {
    if (exitCode === 0) {
      throw new Error(
        `playwright 适配器 parse 失败：${stdoutPath} 零 result 且 exitCode=0（无区分力，疑似 echo ok 类假命令）。` +
          `恢复动作：确认验收 command 真实运行了 playwright 测试（如 npx playwright test），或改 runner/type 路由。`,
      );
    }
    return {
      exitCode,
      cases: [{ id: acceptance.id, name: NO_RESULTS_NAME, status: "fail" }],
      rawPath: stdoutPath,
    };
  }

  // exitCode 透传不改写：用例级事实（cases）与进程级事实（exitCode）由上层各自裁决
  return { exitCode, cases, rawPath: stdoutPath };
}

export const playwrightAdapter: TestRunAdapter = { type: "playwright", translate, parse };
