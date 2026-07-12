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
 *   - exit code 映射（0=正常, 1=GuardError/参数错误, 2=内部异常）
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

import minimist from "minimist";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dispatch, GuardError } from "./dispatch.js";
import { GitValidator } from "./gate.js";
import { encodeCwd } from "./path-encoding.js";
import { CwStore } from "./store.js";
import {
  type Action,
  type ActionDeps,
  type ActionResult,
  type Status,
  type Topic,
} from "./types.js";
import {
  type CwParams,
  type CloseoutParams,
  type CreateParams,
  type DevParams,
  type PlanParams,
  type ReplanParams,
  type RetrospectParams,
  type ReviewParams,
  type TestParams,
} from "./actions.js";

// ── 常量 ─────────────────────────────────────────────────────

/** stdin/文件读取的大小上限（10MB），防 agent 误传巨型 payload 撑爆内存。 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** 合法 action 白名单（7 个 dispatch action + 2 个只读查询命令）。 */
const VALID_DISPATCH_ACTIONS: Action[] = [
  "create",
  "plan",
  "dev",
  "review",
  "test",
  "retrospect",
  "closeout",
  "replan",
];

const READONLY_QUERIES = new Set(["status", "list"]);

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
    throw new Error(`CW_HOME 必须是绝对路径，当前值: ${home}`);
  }
  const encoded = encodeCwd(workspacePath);
  return join(home, encoded, "_cw.json");
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
    throw new Error(
      "同时提供 stdin 数据和 --xxx-file 参数，冲突。请只用一种方式传 JSON。",
    );
  }

  let raw: string;
  if (hasStdin) {
    raw = stdinData;
  } else if (hasFlag) {
    const filePath = resolve(fileFlag as string);
    if (!existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `文件大小 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过限制 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
      );
    }
    raw = readFileSync(filePath, "utf-8");
  } else {
    throw new Error("未提供 JSON 输入（stdin 为空且未指定 --xxx-file）");
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── argv → CwParams 构造 ────────────────────────────────────

/** minimist 解析结果的结构子集（避免引入 @types/minimist 的 ParsedArgs 宽松 any）。 */
interface ParsedArgs {
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
    throw new Error(`--${name} 需要是 JSON 字符串`);
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new Error(
      `--${name} JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * buildParams — 按 action 构造 CwParams 联合类型的对应分支。
 *
 * 每个 action 的必填参数缺失 → throw（exit 1，参数错误）。
 * plan/replan 的 planJson 支持双通道（stdin 优先，--planJson-file fallback）。
 */
function buildParams(
  action: Action,
  parsed: ParsedArgs,
  stdinData: string,
  isStdinTTY: boolean,
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
      if (!slug) throw new Error("create 需要 --slug");
      if (!objective) throw new Error("create 需要 --objective");
      const params: CreateParams = { action, slug, objective };
      if (workspacePath) params.workspacePath = workspacePath;
      return params;
    }

    case "plan":
    case "replan": {
      if (!topicId) throw new Error(`${action} 需要 --topicId`);
      const planJson = readJsonPayload(
        flag(parsed, "planJsonFile"),
        stdinData,
        isStdinTTY,
      );
      if (action === "plan") {
        const params: PlanParams = { action: "plan", topicId, planJson };
        return params;
      }
      const params: ReplanParams = {
        action: "replan",
        topicId,
        planJson,
      };
      return params;
    }

    case "dev": {
      if (!topicId) throw new Error("dev 需要 --topicId");
      const tasks = parseJsonArg("tasks", parsed.tasks);
      if (!Array.isArray(tasks)) {
        throw new Error("dev 的 --tasks 需要是 JSON 数组");
      }
      const params: DevParams = {
        action: "dev",
        topicId,
        tasks: tasks as Array<{ waveId: string; commitHash: string }>,
      };
      return params;
    }

    case "test": {
      if (!topicId) throw new Error("test 需要 --topicId");
      const cases = parseJsonArg("cases", parsed.cases);
      if (!Array.isArray(cases)) {
        throw new Error("test 的 --cases 需要是 JSON 数组");
      }
      const params: TestParams = {
        action: "test",
        topicId,
        cases: cases as TestParams["cases"],
      };
      return params;
    }

    case "review": {
      if (!topicId) throw new Error("review 需要 --topicId");
      const params: ReviewParams = { action: "review", topicId };
      const rp = flag(parsed, "reviewPath");
      if (rp) params.reviewPath = rp;
      return params;
    }

    case "retrospect": {
      if (!topicId) throw new Error("retrospect 需要 --topicId");
      const params: RetrospectParams = { action: "retrospect", topicId };
      const rp = flag(parsed, "retrospectPath");
      if (rp) params.retrospectPath = rp;
      return params;
    }

    case "closeout": {
      if (!topicId) throw new Error("closeout 需要 --topicId");
      const params: CloseoutParams = { action: "closeout", topicId };
      return params;
    }

    default: {
      // 穷尽性：Action 联合已全覆盖。default 不可达，兜底防御未来新增 action。
      const _exhaustive: never = action;
      void _exhaustive;
      throw new Error(`unknown action: ${String(action)}`);
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
    throw new Error(`topic not found: ${topicId}`);
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
    retrospectPath: t.artifacts?.retrospectPath,
    retrospectAt: t.artifacts?.retrospectAt,
    reviewPath: t.artifacts?.reviewPath,
    reviewAt: t.artifacts?.reviewAt,
  }));
}

// ── exit code 映射 ──────────────────────────────────────────

/**
 * mapExitCode — 把错误映射到 exit code。
 *
 * 契约（plan.md Wave 4）：
 *   - exit 0 = 程序正常（gate pass/fail 都是正常返回，结果在 stdout JSON）
 *   - exit 1 = GuardError / 参数错误 / topic not found
 *   - exit 2 = 内部异常（未预期的错误）
 *
 * GuardError 明确 exit 1（guard 拒绝是业务预期路径，不是 bug）。
 */
function mapExitCode(err: Error): number {
  if (err instanceof GuardError) {
    // illegal_transition → exit 1（guard 拒绝，agent 按 nextAction retry）。
    return 1;
  }
  // 参数错误 / topic not found / append-only 违规 / JSON 解析失败 → exit 1（预期错误）。
  // 用消息前缀判定预期错误：这些是 agent 可修正的输入/状态问题，非内部 bug。
  const msg = err.message;
  if (
    msg.startsWith("topic not found") ||
    msg.startsWith("create 需要") ||
    msg.startsWith("plan 需要") ||
    msg.startsWith("replan 需要") ||
    msg.startsWith("dev 需要") ||
    msg.startsWith("test 需要") ||
    msg.startsWith("retrospect 需要") ||
    msg.startsWith("review 需要") ||
    msg.startsWith("closeout 需要") ||
    msg.startsWith("case not found") ||
    msg.startsWith("replan append-only") ||
    msg.includes("需要 --") ||
    msg.includes("JSON 解析失败") ||
    msg.includes("需要是 JSON") ||
    msg.startsWith("未提供 JSON 输入") ||
    msg.startsWith("同时提供 stdin") ||
    msg.startsWith("文件不存在") ||
    msg.startsWith("文件大小") ||
    msg.startsWith("未知 action") ||
    msg.startsWith("CW_HOME")
  ) {
    return 1;
  }
  // 其他未预期错误 → exit 2（内部异常）。
  return 2;
}

// ── main ─────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const parsed = minimist(argv.slice(2)) as ParsedArgs;
  const rawAction = parsed._[0];

  if (rawAction === undefined) {
    process.stderr.write("错误：未指定 action。用法：cw <action> [options]\n");
    process.exit(1);
  }
  const action = String(rawAction);

  // workspacePath 解析（所有子命令共用）。
  const workspacePath =
    typeof parsed.workspace === "string" ? parsed.workspace : process.cwd();
  const dbPath = resolveDbPath(workspacePath, process.env.CW_HOME);

  // status/list 是只读查询，绕过 dispatch（不触发状态变更、不写 gateHistory）。
  if (READONLY_QUERIES.has(action)) {
    const store = new CwStore(dbPath);

    if (action === "status") {
      const topicId =
        typeof parsed.topicId === "string" ? parsed.topicId : undefined;
      if (!topicId) {
        process.stderr.write("错误：status 需要 --topicId\n");
        process.exit(1);
      }
      const output = handleStatus(topicId, store);
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
      return;
    }

    // action === "list"
    const output = handleList(store);
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  // dispatch action 合法性校验。
  if (!VALID_DISPATCH_ACTIONS.includes(action as Action)) {
    process.stderr.write(
      `错误：未知 action "${action}"。有效 action: ${[
        ...VALID_DISPATCH_ACTIONS,
        "status",
        "list",
      ].join(", ")}\n`,
    );
    process.exit(1);
  }

  // 读取 stdin（plan/replan 从这里读 planJson）。
  const stdinData = await readStdin();
  const isStdinTTY = process.stdin.isTTY === true;

  // 构造 CwParams（参数校验在此层完成）。
  const params = buildParams(
    action as Action,
    parsed,
    stdinData,
    isStdinTTY,
  );

  // 构造 ActionDeps + 调 dispatch。
  const deps = constructActionDeps(workspacePath, dbPath);
  const result: ActionResult = dispatch(params, deps);

  // 序列化 ActionResult → stdout JSON。
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
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
    const exitCode = err instanceof Error ? mapExitCode(err) : 2;
    process.exit(exitCode);
  });
}
