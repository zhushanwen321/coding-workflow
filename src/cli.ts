#!/usr/bin/env node
/**
 * cli.ts — CW CLI 入口（agent 唯一入口点）。
 *
 * 命令形态：`cw <action> [layer] [options]`（Wave 3 起去掉 v1 前缀）。
 * 0.x（legacy/ 状态机）已整体删除，v1 前缀也已切断——main 里 ALL_ACTIONS.has(action)
 * 为假一律报「未知 action」并提示改用 `cw <action>`。
 *
 * 职责：
 *   - minimist argv 解析
 *   - stdin 读取（Promise 封装，推进 action 的 input JSON 从 stdin 读）
 *   - runWithAction：argv → V1Params 构造（buildParams）→ V1Deps 装配（constructV1Deps）
 *     → v1Dispatch 调用 + stdout JSON 序列化
 *   - runReadonly：tree/status/list/handoff 只读查询（不经 dispatch、不写 store）
 *   - exit code 映射（0=正常, 1=CwError/V1Error/参数错误, 2=内部异常）
 *
 * 设计原则：
 *   - CLI 是 agent 的唯一导航入口。agent 只需知道 `cw create`，后续全靠返回的 guidance 推进。
 *   - status/list/tree/handoff 是只读快照查询，绕过 dispatch（不触碰状态机、不写 store）。
 *   - exit code 语义区分：0=程序正常（含 gate fail，结果在 stdout JSON），1=guard/参数错误，
 *     2=未预期的内部异常。agent 按 exit code 判断是否需 retry。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import minimist from "minimist";

import { CwError } from "./core/errors.js";
import type { TestRunResult } from "./core/evidence.js";
import type { ExecutionUnit } from "./core/workunit.js";
import type {
  AbortInput,
  ActionResult as V1ActionResult,
  ClarifyInput,
  CloseoutInput,
  CreateInput,
  DesignReviewInput,
  ExecReviewInput,
  ExecuteInput,
  PlanInput,
  ReplanInput,
  RetrospectInput,
  TestInput,
  V1Deps,
} from "./handlers/index.js";
import {
  dispatch as v1Dispatch,
  getUnitScope,
  renderHandoff,
  renderList,
  renderStatus,
  renderTree,
  V1Error,
  type V1Params,
  V1Store,
} from "./index.js";
import {
  type AnnotatedUnit,
  loadAllCwdsFromHome,
} from "./readonly/index.js";
import { getV1Home } from "./store/schema.js";
import { buildCommand } from "./utils/command.js";
import { parseFailedTestNames, parseVitestCounts } from "./utils/parse-vitest-output.js";

// ── 常量 ─────────────────────────────────────────────────────

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

/** stdin/文件读取的大小上限（MB），防 agent 误传巨型 payload 撑爆内存。 */
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * BYTES_PER_MB;

/** JSON 序列化缩进空格数。 */
const JSON_INDENT = 2;

/** v1 list 默认每页条数（与 render.ts DEFAULT_LIMIT 一致）。 */
const V1_LIST_DEFAULT_LIMIT = 10;

/** process.argv 中用户参数的起始索引（[0]=node, [1]=脚本路径）。 */
const ARGV_USER_PARAMS_START = 2;

/** 进程退出码：CwError（预期错误）。 */
const EXIT_CW_ERROR = 1;
/** 进程退出码：内部异常（未预期的错误）。 */
const EXIT_INTERNAL_ERROR = 2;

// ── 命令常量 ──────────────────────────────────────────────
//
// cw 命令形态：`cw <action> [layer] --flags`，走 src/dispatch.ts。
// 0.x（legacy/）已删除，v1 前缀已去掉（Wave 3）——action 直接跟在 cw 后。
//
// create 需要 layer 参数（wave/slice/feature/epic），其他 action 靠 --unitId 路由。

/** create 接受的层（wave/slice/feature/epic 四层均已实现，dispatch 按 input.layer 路由）。 */
const CREATE_LAYERS = new Set(["wave", "slice", "feature", "epic"]);

/**
 * create 缺 layer 时返回的选层 guidance（强制拦截点）。
 *
 * 内容复用 skill/cw-cli 已沉淀的选层决策框架（commit d27e79a）：规模×性质表 +
 * 层级关系树 + 反模式 + 命令示例。agent 必经 create 入口，layer 缺失时在这里被
 * 引导选层，避免凭直觉选错层级导致拆解结构畸形（如 slice 维度任务误建多个碎 slice）。
 *
 * 抽成常量 + 纯函数包装，便于单元测试断言内容（含四层名/规模表/反模式标记）。
 */
const LAYER_PROMPT_GUIDANCE = `## 下一步：选择 layer

cw create 需要指定 layer。按「规模 × 性质」判断（先看规模）：

| 规模 | layer | 理由 |
|------|-------|------|
| 1 个 wave 能搞定（单文件/几个函数/明确 bug） | wave | 无需 plan 设计，直接施工 |
| 多个 wave，但共享一套技术方案 | slice | plan 设计接口/数据模型，execute 自动拆 wave |
| 需求模糊，需规格化后才能拆技术方案 | feature | 先出 FR/AC/UC，execute 拆多个 slice |
| 多个独立功能方向、需战略级拆解 | epic | execute 拆多个 feature |

层级关系：epic → feature → slice → wave（上层 execute 自动创建下层子 unit，guidance 引导 descend）。
选 1 个上层即可，下层会自动拆解，不要手动建多个同级。

反模式：单个 slice 维度的任务，不要为每个 wave 手动建 slice——建 1 个 slice，execute 时自动拆 wave。

命令（选好 layer 后重调）：
  cw create <layer> --slug <slug> --objective "<一句话目标>" [--parent <parentId>]
`;

/**
 * 构造 create 缺 layer 时的选层 guidance（纯函数，供单元测试）。
 *
 * 单独成函数而非直接用常量：未来若需根据 parent scope 裁剪可选 layer（如挂在 slice
 * 下只该选 wave），可在此扩展参数，调用方无需改动。
 */
export function buildLayerPromptGuidance(): string {
  return LAYER_PROMPT_GUIDANCE;
}

/**
 * 推进 action（create 之外）。
 * 这些 action 靠 --unitId 路由，input 通过 --input / stdin 传 JSON。
 */
const ADVANCE_ACTIONS = new Set([
  "clarify",
  "plan",
  "design-review",
  "execute",
  "test",
  "exec-review",
  "retrospect",
  "closeout",
  "replan",
  "abort",
]);

/** 合法 action 总集（create + 10 个推进 action）。 */
const VALID_ACTIONS = new Set(["create", ...ADVANCE_ACTIONS]);

/** 只读查询命令（tree/status/list/handoff）——不经 dispatch、不写 store。 */
const READONLY_QUERIES = new Set(["tree", "status", "list", "handoff"]);

/** 全部合法 action（推进 + 只读），main 用此判断是否走 action 路由。 */
const ALL_ACTIONS = new Set([...VALID_ACTIONS, ...READONLY_QUERIES]);

// ── verbose / debug 日志 ─────────────────────────────────────

/** 进程级 verbose 开关（由 main 解析 --verbose / CW_DEBUG 后设置）。 */
let cwVerbose = false;

/** 当 CW_DEBUG=1 或 --verbose 时启用 verbose 日志。 */
function isVerbose(parsed: ParsedArgs): boolean {
  return process.env.CW_DEBUG === "1" || parsed.verbose === true;
}

/** verbose 模式下向 stderr 写调试日志（不污染 stdout JSON）。 */
function debugLog(...args: unknown[]): void {
  if (!cwVerbose) return;
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  process.stderr.write(`[cw:debug] ${message}\n`);
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

// ── 共享 argv 解析工具（v1 用：ParsedArgs / flag / parseJsonArg） ────

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

// ── 命令辅助（参数构造 / deps 装配 / 子命令分发） ─────────
//
// 与 0.x 完全独立：独立的 params 联合（V1Params）、独立的 deps 接口（V1Deps）、
// 独立的 dispatch（src/dispatch.ts）、独立的 store（_v1.json，路径由 getV1JsonPath 算）。
// 本节三个纯函数把 argv → V1Params、构造 V1Deps、跑 dispatch 并打印结果。
// main 里 `ALL_ACTIONS.has(action)` 为真时整体路由到 runWithAction。

/**
 * readInput — 读取推进 action 的 input payload。
 *
 * 通道（与 0.x 的 readJsonPayload 类似但用 `--input` flag）：
 *   - `--input @file.json` → 读文件内容 JSON.parse
 *   - `--input -` 或无 --input → 从 stdin 读
 *
 * stdin 为空且未指定 file → throw（exit 1）。超大文件 → throw。
 *
 * @returns 解析后的 input 对象（调用方按 action cast 成对应 Input 类型）
 */
function readInput(
  inputFlag: string | undefined,
  stdinData: string,
  isStdinTTY: boolean,
): unknown {
  // --input @file.json（@ 前缀可选，是「从文件读」的约定标记）/ --input <相对|绝对路径>
  // --input - 表示从 stdin 读。
  if (inputFlag !== undefined && inputFlag !== "-") {
    // 去掉开头的 @ 前缀（设计文档的 --input @file.json 约定，@ 纯标记，非路径一部分）。
    const flagged = inputFlag.startsWith("@")
      ? inputFlag.slice(1)
      : inputFlag;
    const filePath = resolve(flagged);
    if (!existsSync(filePath)) {
      throw new CwError(`--input 文件不存在: ${filePath}`);
    }
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new CwError(
        `--input 文件大小 ${(stat.size / BYTES_PER_MB).toFixed(1)}MB 超过限制 ${MAX_FILE_SIZE_BYTES / BYTES_PER_MB}MB`,
      );
    }
    const raw = readFileSync(filePath, "utf-8");
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new CwError(
        `--input JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // stdin：非 TTY 且有内容
  const hasStdin = !isStdinTTY && stdinData.trim().length > 0;
  if (!hasStdin) {
    throw new CwError(
      "推进 action 需要 --input @file.json 或 stdin 传 JSON（stdin 为空）",
    );
  }
  try {
    return JSON.parse(stdinData);
  } catch (e) {
    throw new CwError(
      `stdin JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * buildParams — 把子命令的 flags 构造成 V1Params 联合。
 *
 *   - create：layer 必填（wave/slice/feature/epic 四层均已实现）+ --slug + --objective
 *     必填，可选 --parent（parentUnitId）/ --basedOnParent（JSON 数组字符串）。
 *     注意：layer 完全缺失（undefined）已在 runWithAction 早返回选层 guidance，不进入此函数；
 *     此处只处理 layer 已给定（合法或非法字符串）的情况。dispatch 按 layer 路由
 *     （wave → handleCreate，slice → handleCreateSlice，feature → handleCreateFeature，
 *     epic → handleCreateEpic）。
 *   - 推进 action：--unitId 必填；--commitHash 仅 wave execute 用（slice/PlanningUnit
 *     execute 不接收 input，input 传空对象，dispatchSlice 忽略）；其余靠 --input/stdin。
 *   - replan/abort 的 input 也可用专门的 flag 构造（--abandonedIds/--note/--reason），
 *     作为 --input/stdin 的便捷替代。
 *
 * @param action  action 名（create/clarify/.../abort）
 * @param layer     仅 create 用（argv[3]）
 * @param parsed    minimist 解析结果
 * @param stdinData 已读 stdin
 * @param isStdinTTY stdin 是否 TTY
 * @param scope     unit 的 scope（wave/slice/feature/epic），仅 execute 用以区分参数构造；
 *                  unit 不存在时 null（execute 会走 unit_not_found 错误路径）
 */
function buildParams(
  action: string,
  layer: string | undefined,
  parsed: ParsedArgs,
  stdinData: string,
  isStdinTTY: boolean,
  scope: string | null,
): V1Params {
  if (action === "create") {
    if (layer === undefined) {
      throw new CwError(
        `create 需要指定 layer（${[...CREATE_LAYERS].join("/")}）`,
      );
    }
    if (!CREATE_LAYERS.has(layer)) {
      throw new CwError(
        `create 的 layer "${layer}" 非法，合法值: ${[...CREATE_LAYERS].join("/")}）`,
      );
    }
    // CREATE_LAYERS 已保证 layer ∈ {wave,slice,feature,epic}（上方 has() 校验通过），
    // 四层均已实现。dispatch 按 input.layer 路由到对应 handler。
    // 此处防御性判断保留：即便未来 CREATE_LAYERS 与路由不一致也能 fail-fast。
    if (layer !== "wave" && layer !== "slice" && layer !== "feature" && layer !== "epic") {
      throw new CwError(
        `create ${layer} 尚未实现，当前支持 wave/slice/feature/epic 层`,
      );
    }
    const slug = typeof parsed.slug === "string" ? parsed.slug : undefined;
    const objective =
      typeof parsed.objective === "string" ? parsed.objective : undefined;
    if (!slug) throw new CwError("create 需要 --slug");
    if (!objective) throw new CwError("create 需要 --objective");
    const input: CreateInput = { slug, objective, layer };
    const parent = flag(parsed, "parent");
    if (parent !== undefined) input.parentUnitId = parent;
    const basedOnParentRaw = flag(parsed, "basedOnParent");
    if (basedOnParentRaw !== undefined) {
      input.basedOnParent = parseJsonArg(
        "basedOnParent",
        basedOnParentRaw,
      ) as string[];
    }
    return { action: "create", input };
  }

  // 推进 action：--unitId 必填
  const unitId = flag(parsed, "unitId");
  if (!unitId) throw new CwError(`${action} 需要 --unitId`);

  switch (action) {
    case "clarify":
      return {
        action: "clarify",
        unitId,
        input: readInput(
          flag(parsed, "input"),
          stdinData,
          isStdinTTY,
        ) as ClarifyInput,
      };
    case "plan":
      return {
        action: "plan",
        unitId,
        input: readInput(flag(parsed, "input"), stdinData, isStdinTTY) as PlanInput,
      };
    case "design-review":
      return {
        action: "design-review",
        unitId,
        input: readInput(
          flag(parsed, "input"),
          stdinData,
          isStdinTTY,
        ) as DesignReviewInput,
      };
    case "execute": {
      // execute 按 scope 区分参数构造：
      // - wave（ExecutionUnit）：需 --commitHash（记录代码提交）+ 可选 --input/stdin（带 changedFiles）。
      // - slice 及其他 PlanningUnit（feature/epic）：不接收 input（dispatchSlice 里 handleExecuteSlice
      //   忽略 params.input，按 plan.split 自动创建 child wave），input 传空对象。
      //   V1Params 联合的 execute 分支类型是 ExecuteInput（commitHash 必填），slice 场景无 commitHash，
      //   显式断言绕过类型检查（与 slice-dispatch-e2e.test.ts 的 input:{} + as unknown 同语义）。
      if (scope === "slice" || scope === "feature" || scope === "epic") {
        return {
          action: "execute",
          unitId,
          // eslint-disable-next-line taste/no-unsafe-cast
          input: {} as unknown as ExecuteInput,
        };
      }
      // wave（含 unit 不存在 / scope=null 的兼容路径，后续 dispatch 抛 unit_not_found）
      const commitHash = flag(parsed, "commitHash");
      if (!commitHash) throw new CwError("execute 需要 --commitHash");
      const input: ExecuteInput = { commitHash };
      // execute 允许 --input 传 { changedFiles: [...] }，非 TTY stdin 有内容时也接受
      const hasStdin = !isStdinTTY && stdinData.trim().length > 0;
      const inputFlag = flag(parsed, "input");
      if (inputFlag !== undefined || hasStdin) {
        const extra = readInput(inputFlag, stdinData, isStdinTTY) as Record<
          string,
          unknown
        >;
        if (Array.isArray(extra.changedFiles)) {
          input.changedFiles = extra.changedFiles as string[];
        }
      }
      return { action: "execute", unitId, input };
    }
    case "test":
      return {
        action: "test",
        unitId,
        input: readInput(flag(parsed, "input"), stdinData, isStdinTTY) as TestInput,
      };
    case "exec-review":
      return {
        action: "exec-review",
        unitId,
        input: readInput(
          flag(parsed, "input"),
          stdinData,
          isStdinTTY,
        ) as ExecReviewInput,
      };
    case "retrospect":
      return {
        action: "retrospect",
        unitId,
        input: readInput(
          flag(parsed, "input"),
          stdinData,
          isStdinTTY,
        ) as RetrospectInput,
      };
    case "closeout":
      return {
        action: "closeout",
        unitId,
        input: readInput(
          flag(parsed, "input"),
          stdinData,
          isStdinTTY,
        ) as CloseoutInput,
      };
    case "replan": {
      // replan 优先用 --abandonedIds + --note；缺省从 --input/stdin 读
      const abandonedIdsRaw = flag(parsed, "abandonedIds");
      const note = flag(parsed, "note");
      if (abandonedIdsRaw !== undefined && note !== undefined) {
        const input: ReplanInput = {
          abandonedIds: parseJsonArg("abandonedIds", abandonedIdsRaw) as string[],
          note,
        };
        return { action: "replan", unitId, input };
      }
      return {
        action: "replan",
        unitId,
        input: readInput(flag(parsed, "input"), stdinData, isStdinTTY) as ReplanInput,
      };
    }
    case "abort": {
      // abort 可选 --reason，或从 --input/stdin 读 { reason }
      const reason = flag(parsed, "reason");
      if (reason !== undefined) {
        const input: AbortInput = { reason };
        return { action: "abort", unitId, input };
      }
      const hasStdin = !isStdinTTY && stdinData.trim().length > 0;
      const inputFlag = flag(parsed, "input");
      if (inputFlag !== undefined || hasStdin) {
        const extra = readInput(inputFlag, stdinData, isStdinTTY) as Record<
          string,
          unknown
        >;
        const input: AbortInput = {};
        if (typeof extra.reason === "string") input.reason = extra.reason;
        return { action: "abort", unitId, input };
      }
      // abort 无 input 也合法（reason 可选）
      return { action: "abort", unitId, input: {} };
    }
    default: {
      // 上层已校验 VALID_ACTIONS，此处不可达（action 是 string，无法穷尽校验）。
      throw new CwError(`unknown action: ${action}`);
    }
  }
}

/** cw.config.json 的结构（仅支持 testRunner 配置）。 */
interface CwConfig {
  testRunner?: {
    command?: string;
    cwd?: string;
  };
}

/**
 * loadCwConfig — 读取项目根目录的 cw.config.json。
 *
 * 文件不存在返回 undefined（静默 fallback）。
 * JSON 解析失败打印警告返回 undefined（不阻塞 CLI）。
 */
function loadCwConfig(workspacePath: string): CwConfig | undefined {
  const configPath = resolve(workspacePath, "cw.config.json");
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const config: CwConfig = {};
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.testRunner === "object" && obj.testRunner !== null) {
      const tr = obj.testRunner as Record<string, unknown>;
      config.testRunner = {};
      if (typeof tr.command === "string") config.testRunner.command = tr.command;
      if (typeof tr.cwd === "string") config.testRunner.cwd = tr.cwd;
    }
    return config;
  } catch (err) {
    console.error(`loadCwConfig: cw.config.json at ${configPath} unreadable, ignoring`, err);
    return undefined;
  }
}

/**
 * constructV1Deps — 组装 v1 dispatch 所需的 V1Deps。
 *
 *   - store：V1Store，绑定 cwd（getV1JsonPath 用 V1_HOME + encodeCwd(cwd) 定位 _v1.json）
 *   - gitValidator：用 git cat-file 验 commit hash 真实存在（绑定 workspacePath）
 *   - testRunner：跑测试子进程，聚合 exit code + stdout 解析 passed/failed
 *   - fileExists：fs.existsSync（artifacts[].ref drift 检查）
 *   - clock：new Date().toISOString()
 *
 * testRunner 配置优先级：CLI --testCwd > cw.config.json > 默认 workspacePath。
 * 命令默认 `npx vitest run`，可通过 cw.config.json 的 testRunner.command 覆盖。
 */
function constructV1Deps(workspacePath: string, testCwd?: string): V1Deps {
  debugLog("constructV1Deps workspacePath", workspacePath, "testCwd", testCwd);
  const store = new V1Store(workspacePath);
  const gitValidator = {
    exists: (hash: string): boolean => {
      // 与 0.x GitValidator 同语义：git cat-file -e <hash>^{commit} 成功即存在。
      // ENOENT（git 未装）抛错；其他失败（非 repo / hash 不存在）视为 false。
      try {
        const r = spawnSync("git", ["cat-file", "-e", `${hash}^{commit}`], {
          cwd: workspacePath,
          encoding: "utf8",
          stdio: "ignore",
        });
        return r.status === 0;
      } catch (e) {
        if (isENOENT(e)) throw e;
        return false;
      }
    },
  };
  // testRunner 配置优先级：CLI --testCwd > cw.config.json > 默认 workspacePath
  const config = loadCwConfig(workspacePath);
  const resolvedTestCwd = testCwd
    ?? config?.testRunner?.cwd
    ?? undefined;
  const runnerCwd = resolvedTestCwd
    ? (isAbsolute(resolvedTestCwd) ? resolvedTestCwd : resolve(workspacePath, resolvedTestCwd))
    : workspacePath;
  const runnerCommand = config?.testRunner?.command ?? "npx vitest run";
  const [runnerCmd, ...runnerArgs] = runnerCommand.split(/\s+/);
  debugLog("constructV1Deps runnerCwd", runnerCwd, "runnerCommand", runnerCommand);

  const testRunner = {
    run: (unit: ExecutionUnit): TestRunResult => {
      debugLog("testRunner.run unit", unit.id, "cwd", runnerCwd);
      // 在 runnerCwd 下跑测试命令；exit 0 视为通过。
      // 用 spawnSync 同步阻塞，超时 120s（防 agent 误配死循环测试卡死 CLI）。
      const r = spawnSync(runnerCmd, runnerArgs, {
        cwd: runnerCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
      });
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      const passed = r.status === 0;
      // 解析逻辑 extract 到纯函数（src/utils/parse-vitest-output.ts）以便直接单测。
      // [HISTORICAL] 计数解析的历史 bug 见该纯函数 JSDoc（取最后一个 match 拿 Tests 行用例数）。
      const { passedCount, failedCount } = parseVitestCounts(out);
      const failedTests = parseFailedTestNames(out);
      void unit; // testRunner 接口要求传 unit，当前实现不依赖 unit 内容。
      return { passed, passedCount, failedCount, failedTests };
    },
  };
  const fileExists = {
    exists: (ref: string): boolean => {
      // ref 可能是绝对路径 / 相对路径 / URL。本地路径用 existsSync，URL 一律视为存在（不阻塞 closeout）。
      if (/^https?:\/\//i.test(ref)) return true;
      return existsSync(isAbsolute(ref) ? ref : resolve(workspacePath, ref));
    },
  };
  const clock = { now: (): string => new Date().toISOString() };
  return { store, gitValidator, testRunner, fileExists, workspacePath, clock };
}

/** spawn 抛 ENOENT（git/npx 未安装）判定——基础设施异常，应抛出而非静默吞。 */
function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    String((e as { code: unknown }).code) === "ENOENT"
  );
}

/**
 * runWithAction — 子命令整体处理（main 里 ALL_ACTIONS.has(action) 时调用）。
 *
 * 流程：
 *   1. argv 解析：action 由 main 传入（argv[2]），layer = argv[3]（仅 create）
 *   2. action 合法性校验（VALID_ACTIONS）
 *   3. create 之外读 stdin（--input / stdin 传 JSON）
 *   4. buildParams 构造 V1Params（参数校验在此层）
 *   5. constructV1Deps（store + git + testRunner + fileExists + clock）
 *   6. v1Dispatch + 序列化 ActionResult → stdout
 *
 * 错误语义：V1Error / CwError → stderr + exit 1；其他 → exit 2（由 main 的 catch 兜）。
 *
 * @param argv  完整 process.argv
 * @param workspacePath  当前工作目录（store/git/testRunner 都绑它）
 * @param action  argv[2] 的 action 名（main 已校验 ∈ ALL_ACTIONS）
 */
async function runWithAction(
  argv: string[],
  workspacePath: string,
  action: string,
): Promise<void> {
  // argv 位置语义：[0]=node, [1]=脚本, [2]=action, [3]=layer（仅 create），[4+]=flags。
  // flags 用 minimist 解析（从 ARGV_USER_PARAMS_START 起切，让 --xxx 被正确识别；
  // 位置参数 action/layer 落入 _）。
  const parsed = minimist(argv.slice(ARGV_USER_PARAMS_START)) as ParsedArgs;
  // 直接从原始 argv 取 layer（minimist 的 _ 里也有，但原始 argv 更直观、不被 flag 解析干扰）。
  const layer = argv[ARGV_USER_PARAMS_START + 1];

  debugLog("runWithAction action", action, "layer", layer);

  // ── readonly 查询分支（tree/status/list/handoff）──
  // 不经 dispatch、不写 store、不读 stdin。只 new V1Store 读数据 + render + console.log + 早返回。
  if (READONLY_QUERIES.has(action)) {
    await runReadonly(action, parsed, workspacePath);
    return;
  }

  // 防御性 dead code：main() 已用 ALL_ACTIONS（= VALID_ACTIONS ∪ READONLY_QUERIES）把关，
  // 且上方 READONLY_QUERIES 分支已早返回，正常流程到不了这里。
  // 保留以防未来新增 readonly query 时漏改 main 的 dispatch / 上方早返回。
  if (!VALID_ACTIONS.has(action)) {
    debugLog("runWithAction unknown action", action);
    process.stderr.write(
      `错误：未知 action "${action}"。合法: ${[...VALID_ACTIONS].join(", ")}\n`,
    );
    process.exit(EXIT_CW_ERROR);
  }

  // create 缺 layer → 返回选层 guidance + exit 0（强制拦截点，不进 dispatch）。
  // 与 readonly 查询分支同类：CLI 参数层早返回，不写 store。agent 必经 create 入口，
  // layer 缺失时被引导选层，避免凭直觉选错层级。
  //
  // 「缺失」的两种形态都走 guidance：
  //   1. layer === undefined：cw create --slug x（create 后直接跟 flag）
  //   2. layer 以 '-' 开头：argv[3] 被误占为 flag（如 cw create --slug x），
  //      argv 位置解析拿到 "--slug"。两者都是 agent 省略了 layer。
  // 非法 layer 字符串（如 'bogus'，不以 '-' 开头但不在四层中）不在此分支，
  // 仍由 buildParams 抛 CwError（exit 1）——那是真错误而非缺失。
  if (action === "create" && (layer === undefined || layer.startsWith("-"))) {
    debugLog("runWithAction create missing layer");
    process.stdout.write(buildLayerPromptGuidance());
    return;
  }

  // 推进 action 读 stdin（create 不读 stdin）。
  const stdinData = action === "create" ? "" : await readStdin();
  const isStdinTTY = process.stdin.isTTY === true;
  debugLog("runWithAction stdin length", stdinData.length, "isTTY", isStdinTTY);

  // 构造 V1Params（参数校验在此层完成，缺失必填 → throw CwError → main catch → exit 1）。
  // 非 create action 先读 unit scope（wave 需 --commitHash，slice 不需要）。
  // store 用与 constructV1Deps 相同的 V1Store 实例化（绑 workspacePath，读 _v1.json）。
  const scope =
    action === "create" ? null : getUnitScope(new V1Store(workspacePath), flag(parsed, "unitId") ?? "");
  const params = buildParams(
    action,
    layer,
    parsed,
    stdinData,
    isStdinTTY,
    scope,
  );
  debugLog("runWithAction params", params);

  // 构造 V1Deps + 调 v1Dispatch。
  const testCwd = flag(parsed, "testCwd");
  const deps = constructV1Deps(workspacePath, testCwd);
  debugLog("runWithAction deps constructed");
  const result: V1ActionResult = v1Dispatch(params, deps);
  debugLog("runWithAction dispatch result", result);

  // 序列化 ActionResult → stdout JSON。
  process.stdout.write(JSON.stringify(result, null, JSON_INDENT) + "\n");
}

// ── 只读查询（tree/status/list/handoff） ──────────────────────────

/**
 * runReadonly — 只读查询命令处理（tree/status/list/handoff）。
 *
 * 与 advance action 的根本区别：
 *   - 不调 dispatch、不写 store、不 append statusHistory
 *   - 只 new V1Store 读 _v1.json + 调 render 函数 + console.log
 *   - 参数错误（如 status/handoff 缺 --unitId、tree/status 指定不存在的 unit）→ throw CwError → main catch → exit 1
 *
 * 输出是纯文本（tree/列表/handoff）或 JSON（status），不走 ActionResult 序列化。
 */
async function runReadonly(
  action: string,
  parsed: ParsedArgs,
  workspacePath: string,
): Promise<void> {
  const store = new V1Store(workspacePath);

  if (action === "tree") {
    // --unitId 可选；缺省取第一个无 parentUnitId 的 root unit。
    const unitId = flag(parsed, "unitId");
    const rootUnitId = unitId ?? findFirstRootUnitId(store);
    if (rootUnitId === null) {
      // 库为空且未显式指定 --unitId：提示而非输出 "unit not found"。
      process.stdout.write("(no units in store)\n");
      return;
    }
    process.stdout.write(renderTree(rootUnitId, store));
    return;
  }

  if (action === "status") {
    const unitId = flag(parsed, "unitId");
    if (!unitId) {
      throw new CwError("status 需要 --unitId");
    }
    const unit = store.load(unitId);
    if (unit === null) {
      throw new CwError(`unit not found: ${unitId}`);
    }
    process.stdout.write(renderStatus(unit));
    return;
  }

  if (action === "handoff") {
    // handoff：以某 unit 为焦点的叙述性交接摘要（含下一步 guidance）。
    // 与 status 同样需要 --unitId + load + not found 判定，但输出是五段式纯文本。
    // --scope 控制上下文范围：self=仅焦点（默认）；upstream=父链+焦点；full=父链+焦点+子树。
    const unitId = flag(parsed, "unitId");
    if (!unitId) {
      throw new CwError("handoff 需要 --unitId");
    }
    const unit = store.load(unitId);
    if (unit === null) {
      throw new CwError(`unit not found: ${unitId}`);
    }
    const scope = flag(parsed, "scope") ?? "self";
    if (scope !== "self" && scope !== "upstream" && scope !== "full") {
      throw new CwError(`--scope 必须是 self/upstream/full，当前值: ${scope}`);
    }
    process.stdout.write(renderHandoff(unit, store, scope));
    return;
  }

  // action === "list"
  const layer = flag(parsed, "layer");
  const grep = flag(parsed, "grep");
  const cwdFlag = flag(parsed, "cwd");
  const isAll = parsed.all === true;
  const isLong = parsed.long === true;
  // limit/offset 是 number 类型，不能用 flag() helper（它只返回 string，会过滤掉 number）。
  // minimist 把 --limit 2 解析成 {limit: 2}（number），直接读 parsed 字段。
  const rawLimit = typeof parsed.limit === "number" ? parsed.limit : Number(parsed.limit);
  const rawOffset = typeof parsed.offset === "number" ? parsed.offset : Number(parsed.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : V1_LIST_DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  // M4：--cwd 必须是绝对路径（V1Store 按 encodeCwd(cwd) 落盘，相对路径会与实际 cwd 错位）
  if (cwdFlag !== undefined && !isAbsolute(cwdFlag)) {
    throw new CwError(`--cwd 需要绝对路径，当前值: ${cwdFlag}`);
  }

  // ES3：--all 与 --cwd 互斥（--all 跨 cwd 遍历，--cwd 锁定单 cwd，语义冲突）
  if (isAll && cwdFlag !== undefined) {
    throw new CwError("--all and --cwd are mutually exclusive");
  }

  if (isAll) {
    // 跨 cwd 模式：loadAllCwdsFromHome + 注入 cwd/repoMeta 到 AnnotatedUnit
    const v1Home = getV1Home();
    const loaded = loadAllCwdsFromHome(v1Home);
    const annotated: AnnotatedUnit[] = [];
    for (const { cwd, data } of loaded) {
      for (const unit of data.workUnits) {
        annotated.push({ unit, cwd, repoMeta: data.repoMeta });
      }
    }
    process.stdout.write(renderList(annotated, { limit, offset, all: true, layer, grep, verbose: isLong }));
    return;
  }

  // 单 cwd 模式：--cwd 覆盖默认 workspacePath（不指定时复用上方已构造的 store，避免重复 new）
  const singleStore = cwdFlag ? new V1Store(cwdFlag) : store;
  const units = singleStore.loadAll();
  const annotated = units.map((unit) => ({ unit }));
  process.stdout.write(renderList(annotated, { limit, offset, layer, grep, verbose: isLong }));
}

/**
 * 找第一个 root unit（parentUnitId 为空/undefined 的 unit）。
 *
 * tree 缺省根的解析规则：顶层 unit 通常无 parent。多个 root 时取 store 里的第一个
 *（loadAll 的顺序即 _v1.json 里 workUnits 数组顺序，创建先后序）。
 * 无任何 unit 时返回 null。
 */
function findFirstRootUnitId(store: V1Store): string | null {
  const units = store.loadAll();
  const root = units.find((u) => u.parentUnitId === undefined || u.parentUnitId === "");
  return root?.id ?? null;
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
  // CwError（0.x 预期错误）+ V1Error（v1 guard fail / unit not found）都映射 exit 1。
  return err instanceof CwError || err instanceof V1Error
    ? EXIT_CW_ERROR
    : EXIT_INTERNAL_ERROR;
}

/**
 * 格式化顶层 catch 的错误输出。
 *
 * 契约：
 *   - 非 Error 值 → exit 2，输出 String(err)
 *   - CwError / V1Error（exit 1）→ 只输出友好 message，不暴露堆栈
 *   - 其他内部异常（exit 2）→ 输出 message + 完整 stack trace
 *
 * 与 mapExitCode 分离：render 负责 stderr 文案，mapExitCode 负责 exit code 映射。
 */
export function renderCliError(err: unknown): {
  exitCode: number;
  stderr: string;
} {
  if (!(err instanceof Error)) {
    return {
      exitCode: EXIT_INTERNAL_ERROR,
      stderr: `错误：${String(err)}\n`,
    };
  }

  const exitCode = mapExitCode(err);
  const lines: string[] = [`错误：${err.message}`];
  if (exitCode === EXIT_INTERNAL_ERROR) {
    lines.push(`堆栈：${err.stack ?? "(无堆栈)"}`);
  }
  return { exitCode, stderr: lines.join("\n") + "\n" };
}

// ── main ─────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  // argv[0]=node 路径, argv[1]=脚本路径, argv[2] 起才是用户参数
  const parsed = minimist(argv.slice(ARGV_USER_PARAMS_START)) as ParsedArgs;
  cwVerbose = isVerbose(parsed);
  debugLog("verbose mode enabled");
  const rawAction = parsed._[0];

  if (rawAction === undefined) {
    process.stderr.write("错误：未指定 action。用法：cw <action> [options]\n");
    process.exit(EXIT_CW_ERROR);
  }
  const action = String(rawAction);

  // workspacePath 解析（所有子命令共用）。
  const workspacePath =
    typeof parsed.workspace === "string" ? parsed.workspace : process.cwd();

  // ── 命令分支（`cw <action> ...`）──
  // cw 唯一入口：所有命令都走 `cw <action>`（Wave 3 起去掉 v1 前缀）。
  // ALL_ACTIONS = VALID_ACTIONS ∪ READONLY_QUERIES（create/推进 + tree/status/list/handoff）。
  if (ALL_ACTIONS.has(action)) {
    await runWithAction(argv, workspacePath, action);
    return;
  }

  // 未识别的 action 一律拒绝（含旧的 `v1` 前缀——Wave 3 起彻底切断，不再做向后兼容）。
  process.stderr.write(
    `错误：未知 action "${action}"。请改用：${buildCommand("<action>", "[layer]", "[options]")}\n` +
      `（合法 action: ${[...ALL_ACTIONS].join(", ")}）\n`,
  );
  process.exit(EXIT_CW_ERROR);
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
    debugLog("main catch", err);
    const { exitCode, stderr } = renderCliError(err);
    process.stderr.write(stderr);
    process.exit(exitCode);
  });
}
