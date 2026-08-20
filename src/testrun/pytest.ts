/**
 * pytest TestRun 适配器（mx-2 验收文档 §2/§4 锁定）。
 *
 * 零依赖原则（§4）：translate 只追加 flags，不注入插件——pytest-json-report 等
 * 外部插件不可假定（cw 不引入依赖），`-v` 的文本条目行是零依赖确定性通道。
 * translate：command 缺失 → 默认全量命令；存在 → 确保含 -v --tb=no
 * -p no:cacheprovider（-v 产出 `file.py::test STATUS` 条目行——parse 的解析锚；
 * --tb=no 去 traceback 噪声；-p no:cacheprovider 禁写 .pytest_cache——环境隔离
 * 纪律，验收跑完不污染 checkout 工作区）。
 * parse：逐行匹配条目正则折叠 cases；PASSED→pass，FAILED/ERROR→fail，
 * SKIPPED/XFAIL/XPASS→fail（M0 不认 skip 口径，与 vitest/e2e-sh 家族统一——
 * 防 skip 逃逸验收）。
 * 防伪造语义（§4「无区分力防线统一」，对齐 e2e-sh 家族）：
 *   - 零条目行 + exitCode=0 → 抛错（无区分力——echo ok 类假命令在旧树新树都绿）；
 *   - 零条目行 + exitCode≠0 → 单条 fail case（对齐 e2e-sh「标记缺失 + exit≠0」
 *     的 no-markers 语义：exit≠0 已具区分力，如实 fail 不抛错）。
 */
import { readFileSync } from "node:fs";

import type { AcceptanceItem } from "../events/types.js";
import type { EvidenceReport, TestRunAdapter } from "./types.js";

const VERBOSE_FLAG = "-v";
const TRACEBACK_FLAG = "--tb=no";
const NO_CACHE_FLAG = "-p no:cacheprovider";
/** python3 -m pytest 优于裸 pytest：只要求 python3 可解析 pytest 模块（venv bin 不在 PATH 时裸命令失效） */
const DEFAULT_COMMAND = `python3 -m pytest ${VERBOSE_FLAG} ${TRACEBACK_FLAG} ${NO_CACHE_FLAG}`;

/**
 * 条目行锚：`<file.py>::<test> STATUS[ 尾部]`。实测 pytest 8.3.0 的 -v 输出在
 * STATUS 后带空格 padding + `[NN%]` 进度标记，SKIPPED/XFAIL 可带 `(reason)`
 * 尾注——mx-2 验收文档正则的行尾 $ 锚与实测不符，按实测语义放开尾部
 * （`(?:[ \t].*)?`）。summary 段的 `FAILED file::test - reason` 以状态词开头、
 * `==== 2 passed in 0.1s ====` 统计行以 = 开头，均不匹配行首 `<file.py>::` 锚，
 * 自然忽略（§4「pytest 行格式锚」）。参数化测试的 `test_x[param-1]` 由 \S+ 覆盖。
 */
const ENTRY_RE = /^(\S+\.py)::(\S+) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:[ \t].*)?$/;
/** 唯一被认可的通过态；FAILED/ERROR/SKIPPED/XFAIL/XPASS 全部映射 fail */
const PASSED = "PASSED";
/** 零条目行 + exitCode≠0 时的占位 name（对齐 e2e-sh 的 no-markers 家族语义） */
const NO_RESULTS_NAME = "no-results";

/** 验收 → 可执行命令：保证产物含条目行且不写缓存（parse 的前置契约） */
function translate(acceptance: AcceptanceItem): string {
  if (!acceptance.command) {
    return DEFAULT_COMMAND;
  }
  // includes 而非 token 精确匹配（幂等检查同 vitest 模式）：--verbose 含子串
  // "-v" 视为已有（等价长形式）；只追加缺失的 flag，已全含则原样返回
  const command = acceptance.command;
  const missing = [VERBOSE_FLAG, TRACEBACK_FLAG, NO_CACHE_FLAG].filter((flag) => !command.includes(flag));
  return missing.length === 0 ? command : `${command} ${missing.join(" ")}`;
}

/** cw 捕获的 stdout 文件 + exitCode → EvidenceReport；解析失败抛错 */
function parse(stdoutPath: string, exitCode: number, acceptance: AcceptanceItem): EvidenceReport {
  const stdout = readFileSync(stdoutPath, "utf8");
  const cases: EvidenceReport["cases"] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = ENTRY_RE.exec(line);
    if (!match) {
      continue;
    }
    // name 记条目行原文：含 `file.py::test_name`，验收 id 出现在测试函数名即被
    // nameMatch 词边界命中（与 vitest 的 fullName 模式同构）
    cases.push({
      id: acceptance.id,
      name: line,
      status: match[3] === PASSED ? "pass" : "fail",
    });
  }

  if (cases.length === 0) {
    if (exitCode === 0) {
      throw new Error(
        `pytest 适配器 parse 失败：${stdoutPath} 零条目行且 exitCode=0（无区分力，疑似 echo ok 类假命令）。` +
          `恢复动作：确认验收 command 是 pytest 命令（如 python3 -m pytest，cw 会自动追加 ${VERBOSE_FLAG} ${TRACEBACK_FLAG} ${NO_CACHE_FLAG}），` +
          `或改 runner/type 路由（runner 显式声明 pytest / type 缺省推导见 src/verify/run.ts 的 adapterTypeFor）。`,
      );
    }
    return {
      exitCode,
      cases: [{ id: acceptance.id, name: NO_RESULTS_NAME, status: "fail" }],
      rawPath: stdoutPath,
    };
  }

  // exitCode 透传不改写：条目级事实（cases）与进程级事实（exitCode）由上层各自裁决
  return { exitCode, cases, rawPath: stdoutPath };
}

export const pytestAdapter: TestRunAdapter = { type: "pytest", translate, parse };
