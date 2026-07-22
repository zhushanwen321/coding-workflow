#!/usr/bin/env node
/**
 * cli.ts — CW CLI 入口（agent 唯一入口点）。
 *
 * 职责：
 *   - minimist argv 解析
 *   - stdin 读取（Promise 封装，plan/replan 的 planJson 从 stdin 读）
 *   - resolveDbPath（CW_HOME + encodeCwd 从 path-encoding.ts import）
 *   - constructActionDeps（store + git + workspacePath）
 *   - dispatch 调用 + stdout JSON 序列化
 *   - exit code 映射（0=正常, 1=CwError/参数错误, 2=内部异常）
 *   - status / list 只读查询子命令（不经 dispatch，不触发状态变更）
 *
 * 设计原则：
 *   - CLI 是 agent 的唯一导航入口。agent 只需知道 `cw create`，后续全靠返回的 nextAction 推进。
 *   - status/list 是只读快照查询，绕过 dispatch（不触碰状态机、不写 gateHistory）。
 *   - exit code 语义区分：0=程序正常（含 gate fail，结果在 stdout JSON），1=guard/参数错误，
 *     2=未预期的内部异常。agent 按 exit code 判断是否需 retry。
 *
 * 与旧版差异（重构 = 推倒重建）：
 *   - 砍掉 protocol.ts（CwParamsSchema 信封校验层）——本次直接用 actions.ts 的 CwParams 联合类型，
 *     argv 参数按 action 分派构造，不做 typebox schema 统一校验。
 *   - 砍掉 tier/clarify/detail action（mid 专属）。
 *   - resolveDbPath 从 protocol.ts 搬到本文件（protocol.ts 整个烫掉）。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import minimist from "minimist";

import {
  type AbortParams,
  type AssessParams,
  type ClarifyParams,
  type CloseoutParams,
  type ConfirmClarifyParams,
  type CreateParams,
  type CwParams,
  type DevParams,
  type PlanParams,
  type PlanReviewFixParams,
  type PlanReviewParams,
  type ReplanParams,
  type RetrospectParams,
  type ReviewFixParams,
  type ReviewParams,
  type SpecReviewFixParams,
  type SpecReviewParams,
  type TddPlanParams,
  type TestFixParams,
  type TestParams,
} from "./legacy/actions.js";
import { dispatch } from "./legacy/dispatch.js";
import { GitValidator, reviewIssueCheck } from "./legacy/gate.js";
import { runInit } from "./legacy/init.js";
import { encodeCwd } from "./legacy/path-encoding.js";
import { generateReport, genSpecMd, type ReportDocs } from "./legacy/report.js";
import type { TaskShapeId } from "./legacy/shapes/types.js";
import { getSkill, listSkills, SKILL_NAMES } from "./legacy/skills/registry.js";
import type { SkillReadOutput } from "./legacy/skills/types.js";
import { computeStats, computeStatsAll } from "./legacy/stats.js";
import { CwStore } from "./legacy/store.js";
import {
  type Action,
  type ActionDeps,
  type ActionResult,
  CwError,
  type ReviewIssueSubmission,
  type RuntimeEnv,
  type Status,
  type Topic,
} from "./legacy/types.js";

// ── 常量 ─────────────────────────────────────────────────────

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

/** stdin/文件读取的大小上限（MB），防 agent 误传巨型 payload 撑爆内存。 */
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * BYTES_PER_MB;

/** JSON 序列化缩进空格数。 */
const JSON_INDENT = 2;

/** process.argv 中用户参数的起始索引（[0]=node, [1]=脚本路径）。 */
const ARGV_USER_PARAMS_START = 2;

/** 进程退出码：CwError（预期错误）。 */
const EXIT_CW_ERROR = 1;
/** 进程退出码：内部异常（未预期的错误）。 */
const EXIT_INTERNAL_ERROR = 2;

/** 合法 action 白名单（19 个 dispatch action + 5 个只读查询命令）。 */
const VALID_DISPATCH_ACTIONS: Action[] = [
  "create",
  "clarify",
  "confirm_clarify",
  "spec_review",
  "spec_review_fix",
  "plan",
  "plan_review",
  "plan_review_fix",
  "tdd_plan",
  "dev",
  "review",
  "review_fix",
  "test",
  "test_fix",
  "retrospect",
  "closeout",
  "replan",
  "abort",
  "assess",
];

// FR-8: gen-spec 不再是只读查询（有写副作用——记 artifacts.confirmSpec），
// 故从 READONLY_QUERIES 移出，改为与 init 同级的直接处理块（不经 dispatch 状态机）。
const READONLY_QUERIES = new Set(["status", "list", "stats", "report"]);

// ── 跨平台「用系统默认应用打开文件」 ──────────────────────────

/**
 * shouldAutoOpen — 是否自动 open 产出的文件。
 *
 * 优先级：`--no-open` flag > `CW_NO_OPEN` env > 默认 open。
 * 测试与 CI 经 env 关闭，避免弹窗；agent 日常默认 open，需要时用 flag 单次跳过。
 */
function shouldAutoOpen(noOpenFlag: boolean): boolean {
  if (noOpenFlag) return false;
  if (process.env.CW_NO_OPEN === "1") return false;
  return true;
}

/**
 * openInDefaultApp — 用系统默认应用打开文件路径（gen-spec 的 md / report 的 html）。
 *
 * 跨平台命令分派：
 *   - darwin → `open`
 *   - win32  → `cmd /c start "" <path>`（start 是 cmd 内置命令，必须经 shell；
 *              首个空字符串参数是窗口标题占位，避免含空格的路径被当标题吞掉）
 *   - 其他（linux 等）→ `xdg-open`
 *
 * detached + stdio:"ignore" + unref()：子进程与主进程解耦，cw 退出不等待 GUI。
 * 失败静默：open 不了不影响主流程——路径已在 stdout JSON 返回，调用方可手动打开。
 */
function openInDefaultApp(filePath: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", filePath], {
        detached: true,
        shell: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // open 失败不阻断——路径已返回，调用方可手动 open。
  }
}

// ── RuntimeEnv 默认值 + env.json ────────────────────────────

/**
 * 运行环境默认值——开发者的主要使用环境。
 * 命令行 --agent / --llm 或 env.json 可覆盖。
 */
const DEFAULT_AGENT = "Pi";
const DEFAULT_LLM = "GLM-5.2";

/** env.json 文件名（与 _cw.json 同目录）。 */
const ENV_JSON_NAME = "env.json";

// ── resolveDbPath ────────────────────────────────────────────

/**
 * resolveDbPath — 计算 _cw.json 完整路径。
 *
 * 路径规则：`<CW_HOME>/<encoded-cwd>/_cw.json`。
 *   - CW_HOME 默认 `~/.cw/`（与 plan.md「~/.pi/agent/cw/<encoded-cwd>/_cw.json」语义一致，
 *     落地为同级目录，用 .cw 做默认根，可被 CW_HOME env 覆盖）。
 *   - encoded-cwd 由 encodeCwd(workspacePath) 生成，per-cwd 隔离。
 *
 * 失败路径：CW_HOME 非绝对路径 → throw（防 agent 误设相对路径导致 db 散落）。
 */
export function resolveDbPath(workspacePath: string, cwHome?: string): string {
  const home = cwHome ?? join(homedir(), ".cw");
  if (!isAbsolute(home)) {
    throw new CwError(`CW_HOME 必须是绝对路径，当前值: ${home}`);
  }
  const encoded = encodeCwd(workspacePath);
  return join(home, encoded, "_cw.json");
}

/**
 * env.json 路径（与 _cw.json 同目录）。
 *
 * env.json 是 per-cwd 的运行环境配置（agent + llm），用户手动创建/编辑。
 * 不存在时用默认值（Pi / GLM-5.2），不自动创建。
 */
export function resolveEnvJsonPath(workspacePath: string, cwHome?: string): string {
  const home = cwHome ?? join(homedir(), ".cw");
  const encoded = encodeCwd(workspacePath);
  return join(home, encoded, ENV_JSON_NAME);
}

/**
 * getCwVersion — 从 package.json 自动读取 cw-cli 版本号。
 *
 * import.meta.url 在 dist/cli.js 时指向编译后文件，`../package.json` 是 npm 包根。
 * 在 src/cli.ts（vitest）时指向源文件，`../package.json` 是项目根。两种场景都对。
 * 读取失败（文件不存在/JSON 解析失败）返回 "unknown"——不阻断 create。
 */
export function getCwVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * EnvJsonFile — env.json 的结构（agent + llm 两字段，均可选）。
 */
interface EnvJsonFile {
  agent?: string;
  llm?: string;
}

/**
 * resolveRuntimeEnv — 合并三个来源的 agent/llm/cwVersion，构造 RuntimeEnv。
 *
 * 优先级：命令行参数 > env.json > 硬编码默认值（Pi / GLM-5.2）。
 * cwVersion 始终从 package.json 自动读，不受 env.json/命令行影响。
 *
 * env.json 不存在或解析失败 → 静默回退默认值（不报错、不自动创建）。
 * 设计意图：默认值覆盖 99% 场景，切环境时手动写 env.json 或传命令行参数。
 *
 * @param parsed  minimist 解析结果（读 --agent / --llm）
 * @param envJsonPath  env.json 路径（resolveEnvJsonPath 计算）
 */
export function resolveRuntimeEnv(
  parsed: ParsedArgs,
  envJsonPath: string,
): RuntimeEnv {
  // env.json 读取（不存在/解析失败 → 空对象，静默回退）
  const envFile: EnvJsonFile = {};
  if (existsSync(envJsonPath)) {
    try {
      const raw = readFileSync(envJsonPath, "utf8");
      const envParsed = JSON.parse(raw) as EnvJsonFile;
      if (typeof envParsed.agent === "string") envFile.agent = envParsed.agent;
      if (typeof envParsed.llm === "string") envFile.llm = envParsed.llm;
    } catch {
      // env.json 损坏 → 静默回退默认值，不阻断 create
    }
  }

  const agent =
    (typeof parsed.agent === "string" && parsed.agent) ||
    envFile.agent ||
    DEFAULT_AGENT;
  const llm =
    (typeof parsed.llm === "string" && parsed.llm) ||
    envFile.llm ||
    DEFAULT_LLM;

  return { agent, llm, cwVersion: getCwVersion() };
}

// ── stdin / 文件读取 ─────────────────────────────────────────

/**
 * readStdin — 异步读取 stdin 全部内容（Promise 封装）。
 *
 * TTY 模式（交互式终端无 pipe 输入）直接 resolve("")，避免 hang 在 'end' 事件上。
 */
function readStdin(): Promise<string> {
  return new Promise((stringResolve) => {
    if (process.stdin.isTTY) {
      stringResolve("");
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () =>
      stringResolve(Buffer.concat(chunks).toString("utf-8")),
    );
  });
}

/**
 * readJsonPayload — 从 stdin 或 --xxx-file 读取 JSON 对象。
 *
 * 通道优先级：stdin 有内容则用 stdin；否则 fallback 到 file；两者都没有则 throw。
 * 同时提供 stdin + file → throw 冲突（防止 agent 误传两份不一致的输入）。
 *
 * 失败路径：冲突 → throw；文件不存在 → throw；非 JSON → throw；超大 → throw。
 */
function readJsonPayload(
  fileFlag: string | undefined,
  stdinData: string,
  isStdinTTY: boolean,
): unknown {
  const hasStdin = !isStdinTTY && stdinData.trim().length > 0;
  const hasFlag = fileFlag !== undefined;

  if (hasStdin && hasFlag) {
    throw new CwError(
      "同时提供 stdin 数据和 --xxx-file 参数，冲突。请只用一种方式传 JSON。",
    );
  }

  let raw: string;
  if (hasStdin) {
    raw = stdinData;
  } else if (hasFlag) {
    const filePath = resolve(fileFlag as string);
    if (!existsSync(filePath)) {
      throw new CwError(`文件不存在: ${filePath}`);
    }
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new CwError(
        `文件大小 ${(stat.size / BYTES_PER_MB).toFixed(1)}MB 超过限制 ${MAX_FILE_SIZE_BYTES / BYTES_PER_MB}MB`,
      );
    }
    raw = readFileSync(filePath, "utf-8");
  } else {
    throw new CwError("未提供 JSON 输入（stdin 为空且未指定 --xxx-file）");
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CwError(
      `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── argv → CwParams 构造 ────────────────────────────────────

/** minimist 解析结果的结构子集（避免引入 @types/minimist 的 ParsedArgs 宽松 any）。 */
export interface ParsedArgs {
  _: Array<string | number>;
  [key: string]: unknown;
}

/**
 * 同时取 camelCase 和 kebab-case 的 flag 值。
 *
 * minimist 不做 camelCase 转换（与 yargs 不同）：`--retrospect-path` 解析为
 * `parsed["retrospect-path"]` 而非 `parsed.retrospectPath`。用户两种写法都可能用，
 * 都兼容。
 */
function flag(parsed: ParsedArgs, camel: string): string | undefined {
  const kebab = camel.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  const v = parsed[camel] ?? parsed[kebab];
  return typeof v === "string" ? v : undefined;
}

/**
 * 解析 --tasks / --cases / --retrospectPath 等 JSON 字符串参数。
 * 这些参数在 CLI 协议里以 JSON 字符串形式传入（便于 shell 单行调用）。
 */
function parseJsonArg(name: string, value: unknown): unknown {
  if (typeof value !== "string") {
    throw new CwError(`--${name} 需要是 JSON 字符串`);
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new CwError(
      `--${name} JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * buildParams — 按 action 构造 CwParams 联合类型的对应分支。
 *
 * 每个 action 的必填参数缺失 → throw（exit 1，参数错误）。
 *   - plan：planJson 从 stdin 或 --planJsonFile 读
 *   - tdd_plan：testJson 从 stdin 或 --testJsonFile 读
 *   - replan：--plan / --test 二选一或同时提供
 *     （--plan 或无 flag → stdin 读 planJson；--test → --testJsonFile 读 testJson）
 *   - create：runtimeEnv 由 main 在调用前通过 resolveRuntimeEnv 解析后传入
 *
 * @param runtimeEnv  仅 create 用，其他 action 忽略此参数
 */
export function buildParams(
  action: Action,
  parsed: ParsedArgs,
  stdinData: string,
  isStdinTTY: boolean,
  runtimeEnv?: RuntimeEnv,
): CwParams {
  const topicId =
    typeof parsed.topicId === "string" ? parsed.topicId : undefined;
  const workspacePath =
    typeof parsed.workspace === "string" ? parsed.workspace : undefined;

  switch (action) {
    case "create": {
      const slug = typeof parsed.slug === "string" ? parsed.slug : undefined;
      const objective =
        typeof parsed.objective === "string" ? parsed.objective : undefined;
      if (!slug) throw new CwError("create 需要 --slug");
      if (!objective) throw new CwError("create 需要 --objective");
      const params: CreateParams = { action, slug, objective };
      if (workspacePath) params.workspacePath = workspacePath;
      // W1: --taskShape 可选 flag，决定验证策略与审查阶段（默认 full-tdd）。
      // 值校验在 handleCreate（VALID_SHAPES 白名单），CLI 层只做透传。
      const taskShape =
        typeof parsed.taskShape === "string" ? parsed.taskShape : undefined;
      if (taskShape) params.taskShape = taskShape as TaskShapeId;
      if (runtimeEnv) {
        params.agent = runtimeEnv.agent;
        params.llm = runtimeEnv.llm;
        params.cwVersion = runtimeEnv.cwVersion;
      }
      return params;
    }

    case "clarify": {
      if (!topicId) throw new CwError("clarify 需要 --topicId");
      const clarifyJson = readJsonPayload(
        flag(parsed, "clarifyJsonFile"),
        stdinData,
        isStdinTTY,
      );
      const params: ClarifyParams = { action: "clarify", topicId, clarifyJson };
      // FR-2: --replaceSpec flag 触发 spec 替换模式（旧 spec 归档 + 替换为新内容）。
      const replaceReason = flag(parsed, "replaceSpec");
      if (replaceReason !== undefined) {
        params.replaceSpec = replaceReason;
      }
      return params;
    }

    case "confirm_clarify": {
      if (!topicId) throw new CwError("confirm_clarify 需要 --topicId");
      return { action: "confirm_clarify", topicId } as ConfirmClarifyParams;
    }

    case "spec_review": {
      if (!topicId) throw new CwError("spec_review 需要 --topicId");
      const specReviewPath = flag(parsed, "specReviewPath");
      if (!specReviewPath) throw new CwError("spec_review 需要 --specReviewPath");
      const params: SpecReviewParams = {
        action: "spec_review",
        topicId,
        specReviewPath,
      };
      // issues 从 stdin 读（可选，无 stdin 时为空数组 = 无问题）。
      // stdin 有内容时解析为 JSON 数组；非 JSON → throw；逐元素 schema 校验。
      if (!isStdinTTY && stdinData.trim().length > 0) {
        let issuesRaw: unknown;
        try {
          issuesRaw = JSON.parse(stdinData);
        } catch (e) {
          throw new CwError(
            `spec_review issues JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        const check = reviewIssueCheck(issuesRaw);
        if (check.result === "fail") {
          throw new CwError(check.report);
        }
        params.issues = check.parsed! as ReviewIssueSubmission[];
      }
      return params;
    }

    case "spec_review_fix": {
      if (!topicId) throw new CwError("spec_review_fix 需要 --topicId");
      // fixes 从 stdin 读（必须提供，每条含 issueId + commitHash? + resolution）。
      const fixesRaw = readJsonPayload(
        flag(parsed, "fixesJsonFile"),
        stdinData,
        isStdinTTY,
      );
      if (!Array.isArray(fixesRaw)) {
        throw new CwError("spec_review_fix fixes 必须是 JSON 数组（通过 stdin 传入）");
      }
      return {
        action: "spec_review_fix",
        topicId,
        fixes: fixesRaw,
      } as SpecReviewFixParams;
    }

    case "abort": {
      if (!topicId) throw new CwError("abort 需要 --topicId");
      return { action: "abort", topicId } as AbortParams;
    }

    case "plan": {
      if (!topicId) throw new CwError("plan 需要 --topicId");
      const planJson = readJsonPayload(
        flag(parsed, "planJsonFile"),
        stdinData,
        isStdinTTY,
      );
      const params: PlanParams = { action: "plan", topicId, planJson };
      return params;
    }

    case "tdd_plan": {
      if (!topicId) throw new CwError("tdd_plan 需要 --topicId");
      const testJson = readJsonPayload(
        flag(parsed, "testJsonFile"),
        stdinData,
        isStdinTTY,
      );
      const params: TddPlanParams = { action: "tdd_plan", topicId, testJson };
      return params;
    }

    case "replan": {
      if (!topicId) throw new CwError("replan 需要 --topicId");
      // replan 支持 --plan / --test 两种输入（可同时提供，也可用 stdin 默认走 plan）。
      //   - --test flag → 从 --testJsonFile 读 testJson
      //   - --plan flag 或无 flag → 从 stdin 读 planJson（旧行为）
      //   - 同时有 --plan 和 --test → planJson 从 stdin，testJson 从 --testJsonFile
      const hasPlanFlag = parsed.plan === true;
      const hasTestFlag = parsed.test === true;

      const params: ReplanParams = { action: "replan", topicId };

      // testJson：--test flag 触发，从 --testJsonFile 读（不占 stdin，stdin 留给 planJson）。
      if (hasTestFlag) {
        const testFile = flag(parsed, "testJsonFile");
        if (!testFile) {
          throw new CwError("replan --test 需要 --testJsonFile 指定 test.json 路径");
        }
        params.testJson = readJsonPayload(testFile, "", true);
      }

      // planJson：--plan flag 或（无 --test 时）默认从 stdin 读。
      // 有 --test 但无 --plan → 不读 planJson（只改 testCases）。
      // 有 --plan 或（既无 --plan 也无 --test）→ 从 stdin 读 planJson。
      if (hasPlanFlag || !hasTestFlag) {
        params.planJson = readJsonPayload(
          flag(parsed, "planJsonFile"),
          stdinData,
          isStdinTTY,
        );
      }
      return params;
    }

    case "dev": {
      if (!topicId) throw new CwError("dev 需要 --topicId");
      const tasks = parseJsonArg("tasks", parsed.tasks);
      if (!Array.isArray(tasks)) {
        throw new CwError("dev 的 --tasks 需要是 JSON 数组");
      }
      const params: DevParams = {
        action: "dev",
        topicId,
        tasks: tasks as Array<{ waveId: string; commitHash: string }>,
      };
      return params;
    }

    case "test": {
      if (!topicId) throw new CwError("test 需要 --topicId");
      // --cases 可选：full-tdd 仍由 handleTest 的全覆盖校验强制提交；
      // existence / review-only 等无 testCases 的策略 test 阶段不依赖 agent 提交
      // （postDevVerify 自查产物状态），允许省略 --cases。
      let cases: unknown[];
      if (parsed.cases === undefined) {
        cases = [];
      } else {
        const parsed_cases = parseJsonArg("cases", parsed.cases);
        if (!Array.isArray(parsed_cases)) {
          throw new CwError("test 的 --cases 需要是 JSON 数组");
        }
        cases = parsed_cases;
      }
      const params: TestParams = {
        action: "test",
        topicId,
        cases: cases as TestParams["cases"],
      };
      return params;
    }

    case "review": {
      if (!topicId) throw new CwError("review 需要 --topicId");
      const params: ReviewParams = { action: "review", topicId, issues: [] };
      const rp = flag(parsed, "reviewPath");
      if (rp) params.reviewPath = rp;
      // issues 从 stdin 读（可选，无 stdin 时为空数组 = 无问题）。
      // stdin 有内容时解析为 JSON 数组；非 JSON → throw；逐元素 schema 校验。
      if (!isStdinTTY && stdinData.trim().length > 0) {
        let issuesRaw: unknown;
        try {
          issuesRaw = JSON.parse(stdinData);
        } catch (e) {
          throw new CwError(
            `review issues JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        // 逐元素 schema 校验（替代原来只查 Array.isArray 的弱校验，
        // 避免 agent 传 [{"foo":"bar"}] 导致 severity 为 undefined、must-fix 被静默降级）。
        const check = reviewIssueCheck(issuesRaw);
        if (check.result === "fail") {
          throw new CwError(check.report);
        }
        params.issues = check.parsed!;
      }
      return params;
    }

    case "retrospect": {
      if (!topicId) throw new CwError("retrospect 需要 --topicId");
      const params: RetrospectParams = { action: "retrospect", topicId };
      const rp = flag(parsed, "retrospectPath");
      if (rp) params.retrospectPath = rp;
      // retrospectData 从 stdin 读（可选，无 stdin 时跳过）。
      // stdin 有内容时解析为 JSON；非 JSON → throw（exit 1，参数错误）。
      if (!isStdinTTY && stdinData.trim().length > 0) {
        try {
          params.retrospectData = JSON.parse(stdinData);
        } catch (e) {
          throw new CwError(
            `retrospectData JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return params;
    }

    case "closeout": {
      if (!topicId) throw new CwError("closeout 需要 --topicId");
      const params: CloseoutParams = { action: "closeout", topicId };
      return params;
    }

    case "review_fix": {
      if (!topicId) throw new CwError("review_fix 需要 --topicId");
      // fixes 从 stdin 读（必须提供，每条含 issueId + commitHash + resolution）。
      const fixesRaw = readJsonPayload(
        flag(parsed, "fixesFile"),
        stdinData,
        isStdinTTY,
      );
      if (!Array.isArray(fixesRaw)) {
        throw new CwError("review_fix 的 fixes 需要是 JSON 数组");
      }
      const params: ReviewFixParams = {
        action: "review_fix",
        topicId,
        fixes: fixesRaw as ReviewFixParams["fixes"],
      };
      return params;
    }

    case "plan_review": {
      if (!topicId) throw new CwError("plan_review 需要 --topicId");
      const planReviewPath = flag(parsed, "planReviewPath");
      if (!planReviewPath) throw new CwError("plan_review 需要 --planReviewPath");
      const params: PlanReviewParams = {
        action: "plan_review",
        topicId,
        planReviewPath,
      };
      // issues 从 stdin 读（可选，无 stdin 时为空数组 = 无问题）。
      // stdin 有内容时解析为 JSON 数组；非 JSON → throw；逐元素 schema 校验。
      if (!isStdinTTY && stdinData.trim().length > 0) {
        let issuesRaw: unknown;
        try {
          issuesRaw = JSON.parse(stdinData);
        } catch (e) {
          throw new CwError(
            `plan_review issues JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        const check = reviewIssueCheck(issuesRaw);
        if (check.result === "fail") {
          throw new CwError(check.report);
        }
        params.issues = check.parsed! as ReviewIssueSubmission[];
      }
      return params;
    }

    case "plan_review_fix": {
      if (!topicId) throw new CwError("plan_review_fix 需要 --topicId");
      // fixes 从 stdin 读（必须提供，每条含 issueId + commitHash? + resolution）。
      const fixesRaw = readJsonPayload(
        flag(parsed, "fixesJsonFile"),
        stdinData,
        isStdinTTY,
      );
      if (!Array.isArray(fixesRaw)) {
        throw new CwError("plan_review_fix fixes 必须是 JSON 数组（通过 stdin 传入）");
      }
      return {
        action: "plan_review_fix",
        topicId,
        fixes: fixesRaw,
      } as PlanReviewFixParams;
    }

    case "test_fix": {
      if (!topicId) throw new CwError("test_fix 需要 --topicId");
      // fixes 从 stdin 读（必须提供，每条含 caseId + commitHash + resolution）。
      const fixesRaw = readJsonPayload(
        flag(parsed, "fixesFile"),
        stdinData,
        isStdinTTY,
      );
      if (!Array.isArray(fixesRaw)) {
        throw new CwError("test_fix 的 fixes 需要是 JSON 数组");
      }
      const params: TestFixParams = {
        action: "test_fix",
        topicId,
        fixes: fixesRaw as TestFixParams["fixes"],
      };
      return params;
    }

    case "assess": {
      if (!topicId) throw new CwError("assess 需要 --topicId");
      const type = flag(parsed, "type");
      if (!type) throw new CwError("assess 需要 --type（quality/test/stability/defect）");
      const notes = flag(parsed, "notes");
      if (!notes) throw new CwError("assess 需要 --notes（至少一句话）");
      const params: AssessParams = {
        action: "assess",
        topicId,
        type: type as AssessParams["type"],
        notes,
      };
      // score 可选（1-5 整数），handler 内校验范围。
      const scoreRaw = parsed.score;
      if (scoreRaw !== undefined) {
        const score = Number(scoreRaw);
        if (!Number.isInteger(score)) {
          throw new CwError("assess 的 --score 必须是整数");
        }
        params.score = score;
      }
      // defect 可选（JSON 字符串），仅 type=defect 时有意义。
      // 用 flag() 取值：同时兼容 --defect 和 --defect 两种写法（flag 不做 camelCase 转换，defect 无大写，等价）。
      const defectRaw = flag(parsed, "defect");
      if (defectRaw !== undefined) {
        params.defect = parseJsonArg("defect", defectRaw) as AssessParams["defect"];
      }
      return params;
    }

    default: {
      // 穷尽性：Action 联合已全覆盖。default 不可达，兜底防御未来新增 action。
      const _exhaustive: never = action;
      void _exhaustive;
      throw new CwError(`unknown action: ${String(action)}`);
    }
  }
}

// ── ActionDeps 构造 ──────────────────────────────────────────

/**
 * constructActionDeps — 组装 dispatch 所需的依赖注入。
 *
 * store 指向 per-cwd 的 _cw.json（resolveDbPath 计算）。
 * git 绑定 workspacePath（GitValidator 在该路径下跑 git 子命令）。
 */
function constructActionDeps(
  workspacePath: string,
  dbPath: string,
): ActionDeps {
  const store = new CwStore(dbPath);
  const git = new GitValidator(workspacePath);
  return { store, git, workspacePath };
}

// ── status / list 只读查询（不经 dispatch） ──────────────────

/** status 子命令的序列化输出（plan.md §CLI 协议：topicId/status/gatePassed/waves/testCases）。 */
export interface StatusOutput {
  topicId: string;
  status: Status;
  gatePassed: Partial<Record<Action, boolean>>;
  waves: Array<{ id: string; committed: boolean }>;
  testCases: Array<{ id: string; status: string }>;
}

/** list 子命令的单条摘要（精简，不含 waves/testCases 明细）。 */
export interface ListEntry {
  topicId: string;
  slug: string;
  status: Status;
  createdAt: string;
  gatePassed: Partial<Record<Action, boolean>>;
  /** 复盘文档路径（存在时返回，便于检索分析）。 */
  retrospectPath?: string;
  retrospectAt?: string;
  reviewPath?: string;
  reviewAt?: string;
  specReviewPath?: string;
  specReviewAt?: string;
  planReviewPath?: string;
  planReviewAt?: string;
}

/**
 * handleStatus — 查询单个 topic 的进度快照。
 *
 * 数据流：store.loadTopic(topicId) → 存在: 构造 StatusOutput → 不存在: throw（CLI 映射 exit 1）。
 * 纯读查询，不经过 dispatch，不触碰状态机。
 */
export function handleStatus(topicId: string, store: CwStore): StatusOutput {
  const topic = store.loadTopic(topicId);
  if (!topic) {
    throw new CwError(`topic not found: ${topicId}`);
  }
  return topicToStatusOutput(topic);
}

function topicToStatusOutput(topic: Topic): StatusOutput {
  return {
    topicId: topic.topicId,
    status: topic.status,
    gatePassed: topic.gatePassed,
    waves: topic.waves.map((w) => ({ id: w.id, committed: w.committed !== null })),
    testCases: topic.testCases.map((c) => ({ id: c.id, status: c.status })),
  };
}

/**
 * handleList — 列出全部 topic（空库 → []）。
 *
 * 数据流：store.listTopics() → Topic[] → 精简为 ListEntry[] → stdout JSON array。
 * 纯读查询，不经过 dispatch。
 */
export function handleList(store: CwStore): ListEntry[] {
  return store.listTopics().map((t) => ({
    topicId: t.topicId,
    slug: t.slug,
    status: t.status,
    createdAt: t.createdAt,
    gatePassed: t.gatePassed,
    retrospectPath: t.artifacts?.retrospect?.path,
    retrospectAt: t.artifacts?.retrospect?.at,
    reviewPath: t.artifacts?.review?.path,
    reviewAt: t.artifacts?.review?.at,
    specReviewPath: t.artifacts?.specReview?.path,
    specReviewAt: t.artifacts?.specReview?.at,
    planReviewPath: t.artifacts?.planReview?.path,
    planReviewAt: t.artifacts?.planReview?.at,
  }));
}

// ── exit code 映射 ──────────────────────────────────────────

/**
 * mapExitCode — 把错误映射到 exit code。
 *
 * 契约（plan.md Wave 4）：
 *   - exit 0 = 程序正常（gate pass/fail 都是正常返回，结果在 stdout JSON）
 *   - exit 1 = CwError（参数错误 / topic not found / guard 拒绝等预期错误）
 *   - exit 2 = 内部异常（未预期的错误）
 */
export function mapExitCode(err: Error): number {
  return err instanceof CwError ? EXIT_CW_ERROR : EXIT_INTERNAL_ERROR;
}

// ── main ─────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  // argv[0]=node 路径, argv[1]=脚本路径, argv[2] 起才是用户参数
  const parsed = minimist(argv.slice(ARGV_USER_PARAMS_START)) as ParsedArgs;
  const rawAction = parsed._[0];

  if (rawAction === undefined) {
    process.stderr.write("错误：未指定 action。用法：cw <action> [options]\n");
    process.exit(EXIT_CW_ERROR);
  }
  const action = String(rawAction);

  // workspacePath 解析（所有子命令共用）。
  const workspacePath =
    typeof parsed.workspace === "string" ? parsed.workspace : process.cwd();
  const dbPath = resolveDbPath(workspacePath, process.env.CW_HOME);

  // status/list/stats 是只读查询，绕过 dispatch（不触发状态变更、不写 gateHistory）。
  if (READONLY_QUERIES.has(action)) {
    const store = new CwStore(dbPath);

    if (action === "status") {
      const topicId =
        typeof parsed.topicId === "string" ? parsed.topicId : undefined;
      if (!topicId) {
        process.stderr.write("错误：status 需要 --topicId\n");
        process.exit(EXIT_CW_ERROR);
      }
      const output = handleStatus(topicId, store);
      process.stdout.write(JSON.stringify(output, null, JSON_INDENT) + "\n");
      return;
    }

    if (action === "stats") {
      // --all：跨 topic 聚合（走 computeStatsAll，不走 computeStats 单 topic 路径）。
      if (parsed.all === true) {
        const topics = store.listTopics();
        const output = computeStatsAll(topics);
        process.stdout.write(JSON.stringify(output, null, JSON_INDENT) + "\n");
        return;
      }
      const topicId =
        typeof parsed.topicId === "string" ? parsed.topicId : undefined;
      if (!topicId) {
        process.stderr.write("错误：stats 需要 --topicId\n");
        process.exit(EXIT_CW_ERROR);
      }
      const topic = store.loadTopic(topicId);
      if (!topic) {
        process.stderr.write(`错误：topic not found: ${topicId}\n`);
        process.exit(EXIT_CW_ERROR);
      }
      const output = computeStats(topic);
      process.stdout.write(JSON.stringify(output, null, JSON_INDENT) + "\n");
      return;
    }

    if (action === "report") {
      const topicId =
        typeof parsed.topicId === "string" ? parsed.topicId : undefined;
      if (!topicId) {
        process.stderr.write("错误：report 需要 --topicId\n");
        process.exit(EXIT_CW_ERROR);
      }
      const topic = store.loadTopic(topicId);
      if (!topic) {
        process.stderr.write(`错误：topic not found: ${topicId}\n`);
        process.exit(EXIT_CW_ERROR);
      }
      const stats = computeStats(topic);
      // 读 review.md / retrospect.md 文档内容。
      // artifacts 路径可能是相对的（如 .xyz-harness/...），用 workspacePath 解析。
      const resolveArtifact = (p: string | undefined): string | undefined => {
        if (!p) return undefined;
        return isAbsolute(p) ? p : join(workspacePath, p);
      };
      const readDocSafe = (p: string | undefined): string | undefined => {
        if (!p || !existsSync(p)) return undefined;
        try {
          return readFileSync(p, "utf-8");
        } catch {
          return undefined;
        }
      };
      const docs: ReportDocs = {
        reviewDoc: readDocSafe(resolveArtifact(topic.artifacts?.review?.path)),
        retrospectDoc: readDocSafe(resolveArtifact(topic.artifacts?.retrospect?.path)),
        clarifyDocs: Object.fromEntries(
          (topic.clarifyRecords ?? [])
            .filter((cr) => cr.presentationPath)
            .map((cr) => [cr.id, readDocSafe(resolveArtifact(cr.presentationPath))])
            .filter(([, v]) => v !== undefined),
        ),
        adrDocs: Object.fromEntries(
          (topic.adrs ?? [])
            .filter((a) => a.projectPath)
            .map((a) => [a.id, readDocSafe(resolveArtifact(a.projectPath))])
            .filter(([, v]) => v !== undefined),
        ),
      };
      const html = generateReport(topic, stats, docs);
      // 写临时文件，文件名含 topic slug 便于识别。
      const safeSlug = topic.slug.replace(/[^a-zA-Z0-9-]/g, "-");
      const reportPath = join(tmpdir(), `cw-report-${safeSlug}.html`);
      writeFileSync(reportPath, html, "utf-8");
      // 默认用系统默认浏览器打开 HTML 报告；--no-open 或 CW_NO_OPEN=1 跳过。
      if (shouldAutoOpen(parsed.noOpen === true)) openInDefaultApp(reportPath);
      process.stdout.write(
        JSON.stringify({ topicId, reportPath }, null, JSON_INDENT) + "\n",
      );
      return;
    }

    // action === "list"
    const output = handleList(store);
    process.stdout.write(JSON.stringify(output, null, JSON_INDENT) + "\n");
    return;
  }

  // FR-8: gen-spec 不再是只读查询（有写副作用），但也不经 dispatch 状态机
  // （不是 Action 联合成员）。与 init 同级，直接处理。
  if (action === "gen-spec") {
    const topicId =
      typeof parsed.topicId === "string" ? parsed.topicId : undefined;
    if (!topicId) {
      process.stderr.write("错误：gen-spec 需要 --topicId\n");
      process.exit(EXIT_CW_ERROR);
    }
    const store = new CwStore(dbPath);
    const topic = store.loadTopic(topicId);
    if (!topic) {
      process.stderr.write(`错误：topic not found: ${topicId}\n`);
      process.exit(EXIT_CW_ERROR);
    }
    const md = genSpecMd(topic);
    const safeSlug = topic.slug.replace(/[^a-zA-Z0-9-]/g, "-");
    const specPath = join(tmpdir(), `cw-spec-${safeSlug}.md`);
    writeFileSync(specPath, md, "utf-8");
    // FR-8: gen-spec 改为有写副作用——记 artifacts.confirmSpec（confirm gate 校验存在性）。
    store.setArtifacts(topicId, {
      confirmSpec: { path: specPath, at: new Date().toISOString() },
    });
    // 默认用系统默认应用打开 md 给用户确认；--no-open 或 CW_NO_OPEN=1 跳过。
    if (shouldAutoOpen(parsed.noOpen === true)) openInDefaultApp(specPath);
    process.stdout.write(
      JSON.stringify({ topicId, specPath }, null, JSON_INDENT) + "\n",
    );
    return;
  }

  // init 是 topic 之前的基建诊断，不进状态机（无 topic 可 loadTopic）。
  // 与 status/list/stats 同级，在 cli.ts 直接处理，不经 dispatch。
  if (action === "init") {
    const result = runInit(workspacePath);
    process.stdout.write(JSON.stringify(result, null, JSON_INDENT) + "\n");
    return;
  }

  // cw skill —— 只读、不进状态机、不需 topic。
  // 子命令用 parsed._[1]（cw 首个子命令模式）：
  //   cw skill list            → 列出所有 skill（name/summary/trigger）
  //   cw skill                 → 默认等同 list（避免空操作）
  //   cw skill <name>          → 返回该 skill 的完整 body
  if (action === "skill") {
    const sub = parsed._[1];
    if (sub === undefined || sub === "list") {
      const output = { skills: listSkills() };
      process.stdout.write(JSON.stringify(output, null, JSON_INDENT) + "\n");
      return;
    }
    const name = String(sub);
    const skill = getSkill(name);
    if (!skill) {
      process.stderr.write(
        `错误：skill not found: ${name}. Available: ${SKILL_NAMES.join(", ")}\n`,
      );
      process.exit(EXIT_CW_ERROR);
    }
    const output: SkillReadOutput = { name: skill.name, body: skill.body };
    process.stdout.write(JSON.stringify(output, null, JSON_INDENT) + "\n");
    return;
  }

  // dispatch action 合法性校验。
  if (!VALID_DISPATCH_ACTIONS.includes(action as Action)) {
    process.stderr.write(
      `错误：未知 action "${action}"。有效 action: ${[
        ...VALID_DISPATCH_ACTIONS,
        "status",
        "list",
        "stats",
        "init",
      ].join(", ")}\n`,
    );
    process.exit(EXIT_CW_ERROR);
  }

  // 读取 stdin（plan/tdd_plan/replan 从这里读 JSON payload）。
  const stdinData = await readStdin();
  const isStdinTTY = process.stdin.isTTY === true;

  // create 时解析运行环境（agent/llm/cwVersion），其他 action 不需要。
  const runtimeEnv =
    action === "create"
      ? resolveRuntimeEnv(parsed, resolveEnvJsonPath(workspacePath, process.env.CW_HOME))
      : undefined;

  // 构造 CwParams（参数校验在此层完成）。
  const params = buildParams(
    action as Action,
    parsed,
    stdinData,
    isStdinTTY,
    runtimeEnv,
  );

  // 构造 ActionDeps + 调 dispatch。
  const deps = constructActionDeps(workspacePath, dbPath);
  const result: ActionResult = dispatch(params, deps);

  // 序列化 ActionResult → stdout JSON。
  process.stdout.write(JSON.stringify(result, null, JSON_INDENT) + "\n");
}

// ── 顶层 try/catch（稳定性保障） ─────────────────────────────
// 仅当 cli.ts 是进程入口时执行 main()；被测试 import 时不触发（避免 process.exit 污染测试进程）。
//
// 比较 import.meta.url 与 process.argv[1] 前两侧 realpathSync：npm link / npm install -g 场景下
// argv[1] 是 symlink 路径而 import.meta.url 是 realpath（Node ESM 默认 resolve symlink），
// 不 realpath 会导致两者永不相等 → main() 不执行 → cw 命令静默无输出。
const isCliEntry = (() => {
  try {
    if (!process.argv[1]) return false;
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    const entryPath = realpathSync(resolve(process.argv[1]));
    return selfPath === entryPath;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  main(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`错误：${message}\n`);
    const exitCode = err instanceof Error ? mapExitCode(err) : EXIT_INTERNAL_ERROR;
    process.exit(exitCode);
  });
}
