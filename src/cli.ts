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
 *   - runWithAction：argv → CwParams 构造（buildParams）→ CwDeps 装配（constructCwDeps）
 *     → v1Dispatch 调用 + stdout JSON 序列化
 *   - runReadonly：tree/status/list/handoff 只读查询（不经 dispatch、不写 store）
 *   - exit code 映射（0=正常, 1=CwError/CwEngineError/参数错误, 2=内部异常）
 *
 * 设计原则：
 *   - CLI 是 agent 的唯一导航入口。agent 只需知道 `cw create`，后续全靠返回的 guidance 推进。
 *   - status/list/tree/handoff 是只读快照查询，绕过 dispatch（不触碰状态机、不写 store）。
 *   - exit code 语义区分：0=程序正常（含 gate fail，结果在 stdout JSON），1=guard/参数错误，
 *     2=未预期的内部异常。agent 按 exit code 判断是否需 retry。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import minimist from "minimist";

import {
  FLAG_WHITELIST,
  GLOBAL_FLAGS,
  validateFlags,
} from "./cli-params.js";
import { CwError } from "./core/errors.js";
import type { TestRunResult } from "./core/evidence.js";
import { computeFrontier } from "./core/frontier.js";
import { detectWorktreeRoot } from "./core/git.js";
import type { ExecutionUnit } from "./core/workunit.js";
import type {
  AbortInput,
  ActionResult as CwActionResult,
  CloseoutInput,
  CreateInput,
  CwDeps,
  DesignInput,
  DesignReviewInput,
  ExecReviewInput,
  ExecuteInput,
  ReplanInput,
  RetrospectInput,
  TestInput,
} from "./handlers/index.js";
import {
  CwEngineError,
  type CwParams,
  CwStore,
  dispatch as v1Dispatch,
  getUnitScope,
  renderFrontier,
  renderHandoff,
  renderList,
  renderStatus,
  renderTree,
} from "./index.js";
import {
  type AnnotatedUnit,
  loadAllCwdsFromHome,
} from "./readonly/index.js";
import { encodeCwd, getCwHome, getCwJsonPath } from "./store/schema.js";
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

/** v1 list 默认每页条数（与 render.ts DEFAULT_LIMIT 一致，AXI-2 #10：10 → 20）。 */
const CW_LIST_DEFAULT_LIMIT = 20;

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
| 1 个 wave 能搞定（单文件/几个函数/明确 bug） | wave | 无需 design 设计，直接施工 |
| 多个 wave，但共享一套技术方案 | slice | design 设计接口/数据模型，execute 自动拆 wave |
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
  "design",
  "design-review",
  "execute",
  "test",
  "exec-review",
  "retrospect",
  "closeout",
  "replan",
  "abort",
]);

/** 合法 action 总集（create + 9 个推进 action）。 */
const VALID_ACTIONS = new Set(["create", ...ADVANCE_ACTIONS]);

/** 只读查询命令（tree/status/list/handoff/frontier）——不经 dispatch、不写 store。 */
const READONLY_QUERIES = new Set(["tree", "status", "list", "handoff", "frontier"]);

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
// 与 0.x 完全独立：独立的 params 联合（CwParams）、独立的 deps 接口（CwDeps）、
// 独立的 dispatch（src/dispatch.ts）、独立的 store（store.json，路径由 getCwJsonPath 算）。
// 本节三个纯函数把 argv → CwParams、构造 CwDeps、跑 dispatch 并打印结果。
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
export function readInput(
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
 * buildParams — 把子命令的 flags 构造成 CwParams 联合。
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
 * @param action  action 名（create/design/.../abort）
 * @param layer     仅 create 用（argv[3]）
 * @param parsed    minimist 解析结果
 * @param stdinData 已读 stdin
 * @param isStdinTTY stdin 是否 TTY
 * @param scope     unit 的 scope（wave/slice/feature/epic），仅 execute 用以区分参数构造；
 *                  unit 不存在时 null（execute 会走 unit_not_found 错误路径）
 */
export function buildParams(
  action: string,
  layer: string | undefined,
  parsed: ParsedArgs,
  stdinData: string,
  isStdinTTY: boolean,
  scope: string | null,
): CwParams {
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
    case "design": {
      // design input 类型因 scope 而异（DesignInput / DesignSliceInput / DesignFeatureInput），
      // 但都 extends AbandonParentItemsInput（ADR-0010），故 --abandonParentItems flag 统一注入。
      const input = readInput(flag(parsed, "input"), stdinData, isStdinTTY) as DesignInput;
      const abandonParentItemsRaw = flag(parsed, "abandonParentItems");
      if (abandonParentItemsRaw !== undefined) {
        input.abandonParentItems = parseJsonArg(
          "abandonParentItems",
          abandonParentItemsRaw,
        ) as string[];
      }
      return { action: "design", unitId, input };
    }
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
      // - wave（ExecutionUnit）：需 --commitHash（记录代码提交）。
      // - slice 及其他 PlanningUnit（feature/epic）：不接收 input（dispatchSlice 里 handleExecuteSlice
      //   忽略 params.input，按 plan.split 自动创建 child wave），input 传空对象。
      //   CwParams 联合的 execute 分支类型是 ExecuteInput（commitHash 必填），slice 场景无 commitHash，
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
      // --abandonParentItems 两条路径都支持（ADR-0010 跨层跨时机声明通道）
      const abandonedIdsRaw = flag(parsed, "abandonedIds");
      const note = flag(parsed, "note");
      const abandonParentItemsRaw = flag(parsed, "abandonParentItems");
      if (abandonedIdsRaw !== undefined && note !== undefined) {
        const input: ReplanInput = {
          abandonedIds: parseJsonArg("abandonedIds", abandonedIdsRaw) as string[],
          note,
        };
        if (abandonParentItemsRaw !== undefined) {
          input.abandonParentItems = parseJsonArg(
            "abandonParentItems",
            abandonParentItemsRaw,
          ) as string[];
        }
        return { action: "replan", unitId, input };
      }
      const input = readInput(flag(parsed, "input"), stdinData, isStdinTTY) as ReplanInput;
      if (abandonParentItemsRaw !== undefined) {
        input.abandonParentItems = parseJsonArg(
          "abandonParentItems",
          abandonParentItemsRaw,
        ) as string[];
      }
      return { action: "replan", unitId, input };
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

/**
 * readCliVersion — 读 package.json 的 version 字段。
 *
 * 路径解析：import.meta.url 在 dist/cli.js 或 src/cli.ts，dirname 后 ../package.json
 * 都指向包根的 package.json（dist 和 src 的上一级都是项目根）。
 * 失败（文件缺失/解析失败）返回 "unknown"——version 不该 crash CLI。
 */
export function readCliVersion(): string {
  try {
    const packageJsonPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as unknown;
    const version =
      typeof pkg === "object" && pkg !== null
        ? (pkg as Record<string, unknown>).version
        : undefined;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * renderHelp — 返回 help 文本（面向人读，分组手写保证格式稳定）。
 *
 * 触发场景：`cw help` / `cw --help` / `cw -h` / `cw`（无参）。
 * action 列表分组与 ALL_ACTIONS = VALID_ACTIONS ∪ READONLY_QUERIES 对齐，
 * help/version 单列一组（它们不进 dispatch、不写 store）。
 */
export function renderHelp(): string {
  return `cw — Agent-agnostic 编码流程编排 CLI

用法：
  cw <action> [layer] [options]
  cw <readonly-query> [options]

工作流 action（推进编码流程，经 dispatch + store）：
  create <layer>          建 topic（layer: wave | slice | feature | epic）
  design                  编写执行计划
  design-review           设计审查
  execute                 执行（wave 写代码 / planning 按 split 下沉）
  test                    测试验收
  exec-review             执行审查
  retrospect              复盘
  closeout                冻结交付
  replan                  重规划（废弃条目 + 重建）
  abort                   放弃 topic

只读查询（不经 dispatch、不写 store）：
  list                    列出 unit（定位 topic，新 agent 接手第一步）
  tree                    父子树结构
  status                  单 unit 完整 JSON
  handoff                 交接摘要（五段式 markdown）
  frontier                非终态节点 + 可推进性

其他：
  help                    显示本帮助
  version                 显示版本号

常用 flags：
  --unitId <id>           指定 unit（大多数 action 需要）
  --input <file|->        input JSON（文件路径或 - 读 stdin）
  --commitHash <sha>      execute 关联的 commit（wave 层）
  --workspace <path>      指定工作目录（默认 cwd）

完整文档：见 SKILL.md（cw-cli skill）。首次使用：cw create <layer>。
`;
}

/**
 * renderActionHelp — per-command help（#11 并入 #5）：显示该 action 的合法 flag 列表。
 *
 * 触发场景：`cw help <action>` 与 `cw <action> --help` 双入口（main 的 help 分支判定）。
 * flag 列表来自 FLAG_WHITELIST + GLOBAL_FLAGS（单源，不另维护文案），camel 形态展示。
 */
export function renderActionHelp(action: string): string {
  const names = [...new Set([...GLOBAL_FLAGS, ...(FLAG_WHITELIST[action] ?? [])])].sort();
  const lines = names
    .map((name) => `  ${name.length === 1 ? `-${name}` : `--${name}`}`)
    .join("\n");
  return `cw ${action} — 参数帮助

用法：
  cw ${action} [options]

合法 flags（全局共享 + 本 action 专属）：
${lines}
`;
}

/**
 * guardTestCommand — per-wave testCommand 空值守卫（纯函数，供 layer-1 单测）。
 *
 * testCommand 为空（空串 / 纯空白）时返回短路结果 {passed:false, 0/0 计数}，
 * 调用方据此跳过 spawn。否则返回 null 表示需真跑。
 *
 * 抽离自 constructCwDeps 的 testRunner.run 守卫逻辑：防 spawnSync('   ', {shell:true})
 * 跑空命令 exit 0 假通过。与 design-review gate testCommandNonEmpty 判空一致（trim）。
 * 抽成纯函数便于 layer-1 单测直接断言。
 */
export function guardTestCommand(cmd: string): TestRunResult | null {
  const trimmed = cmd.trim();
  if (trimmed === "") {
    return { passed: false, passedCount: 0, failedCount: 0, failedTests: [] };
  }
  return null;
}

/**
 * constructCwDeps — 组装 dispatch 所需的 CwDeps。
 *
 *   - store：CwStore，绑定 cwd（getCwJsonPath 内部 detectCommonDir 归一化到 repo 级 common-dir，CW_HOME + encodeCwd(common-dir) 定位 store.json；ADR-0014）
 *   - gitValidator：用 git cat-file 验 commit hash 真实存在（绑定 workspacePath）
 *   - testRunner：跑测试子进程，聚合 exit code + stdout 解析 passed/failed
 *   - fileExists：fs.existsSync（artifacts[].ref drift 检查）
 *   - clock：new Date().toISOString()
 *
 * testRunner cwd：per-wave unit.plan.testCwd（design/replan 阶段填，缺省 workspacePath）。
 * 执行命令：per-wave unit.plan.testCommand（shell 串）。
 */
export function constructCwDeps(workspacePath: string): CwDeps {
  debugLog("constructCwDeps workspacePath", workspacePath);
  // store 仍绑 workspacePath：CwStore 构造内部经 getCwJsonPath → detectCommonDir 归一化到
  // repo 级 common-dir（ADR-0014 决策 1），bare/linked worktree 自动共享同一 store。
  const store = new CwStore(workspacePath);
  // workspace（执行位置）= worktree 根（ADR-0014 决策 3/5），与 store-key（common-dir）解耦：
  // gitValidator/testRunner/fileExists 绑 worktree 根（被测代码所在工作树），不绑子目录 cwd。
  // agent 在 worktree 子目录调 cw 时，cwd≠worktree 根；探测 show-toplevel 拿到正确根。
  // 非 git 目录探测失败 → fallback workspacePath（与原行为一致）。
  const worktreeRoot = detectWorktreeRoot(workspacePath);
  const gitValidator = {
    exists: (hash: string): boolean => {
      // 与 0.x GitValidator 同语义：git cat-file -e <hash>^{commit} 成功即存在。
      // ENOENT（git 未装）抛错；其他失败（非 repo / hash 不存在）视为 false。
      try {
        const r = spawnSync("git", ["cat-file", "-e", `${hash}^{commit}`], {
          cwd: worktreeRoot,
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
  const testRunner = {
    run: (unit: ExecutionUnit): TestRunResult => {
      // per-wave testCwd：缺省 = worktreeRoot（单包项目）；monorepo 多包项目在 design/replan 阶段填子包目录。
      // 相对 testCwd 解析基准 = worktreeRoot（相对仓库根，跨 worktree 自动正确）；绝对路径保持原样。
      const resolvedCwd = unit.plan.testCwd
        ? (isAbsolute(unit.plan.testCwd) ? unit.plan.testCwd : resolve(worktreeRoot, unit.plan.testCwd))
        : worktreeRoot;
      debugLog("testRunner.run unit", unit.id, "cwd", resolvedCwd);
      // per-wave 守卫：testCommand 空（含纯空白）短路，不 spawn（逻辑见 guardTestCommand）。
      const guard = guardTestCommand(unit.plan.testCommand);
      if (guard !== null) return guard;
      // 守卫通过 → testCommand 非空（trim 后有内容），spawn 执行。
      // shell:true 支持完整 shell 串（cd <dir> && ...、pnpm test、自定义脚本），最大框架灵活性。
      // 超时 120s（防 agent 误配死循环测试卡死 CLI）。
      const r = spawnSync(unit.plan.testCommand!.trim(), {
        cwd: resolvedCwd,
        shell: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
      });
      const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      const passed = r.status === 0;
      const { passedCount, failedCount } = parseVitestCounts(out);
      const failedTests = parseFailedTestNames(out);
      return { passed, passedCount, failedCount, failedTests };
    },
  };
  const fileExists = {
    exists: (ref: string): boolean => {
      // ref 可能是绝对路径 / 相对路径 / URL。本地路径用 existsSync，URL 一律视为存在（不阻塞 closeout）。
      // 相对路径 resolve 基准 = worktreeRoot（代码工作目录根）。
      if (/^https?:\/\//i.test(ref)) return true;
      return existsSync(isAbsolute(ref) ? ref : resolve(worktreeRoot, ref));
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
 *   4. buildParams 构造 CwParams（参数校验在此层）
 *   5. constructCwDeps（store + git + testRunner + fileExists + clock）
 *   6. v1Dispatch + 序列化 ActionResult → stdout
 *
 * 错误语义：CwEngineError / CwError → stderr + exit 1；其他 → exit 2（由 main 的 catch 兜）。
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
  // 不经 dispatch、不写 store、不读 stdin。只 new CwStore 读数据 + render + console.log + 早返回。
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

  // flag 白名单校验（#5）：在 create 缺 layer 早返回分支之前——缺 layer + 拼错 flag 时
  // unknown flag 不被吞（K-7）。readonly action 已在 runReadonly 内校验（早返回，不经过这里）。
  validateFlags(action, parsed);

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

  // 构造 CwParams（参数校验在此层完成，缺失必填 → throw CwError → main catch → exit 1）。
  // 非 create action 先读 unit scope（wave 需 --commitHash，slice 不需要）。
  // store 用与 constructCwDeps 相同的 CwStore 实例化（绑 workspacePath，读 store.json）。
  const scope =
    action === "create" ? null : getUnitScope(new CwStore(workspacePath), flag(parsed, "unitId") ?? "");
  const params = buildParams(
    action,
    layer,
    parsed,
    stdinData,
    isStdinTTY,
    scope,
  );
  debugLog("runWithAction params", params);

  // 构造 CwDeps + 调 v1Dispatch。
  const deps = constructCwDeps(workspacePath);
  debugLog("runWithAction deps constructed");
  const result: CwActionResult = v1Dispatch(params, deps);
  debugLog("runWithAction dispatch result", result);

  // 序列化 ActionResult → stdout JSON。
  process.stdout.write(JSON.stringify(result, null, JSON_INDENT) + "\n");
}

// ── 只读查询（tree/status/list/handoff） ──────────────────────────

/**
 * runReadonly — 只读查询命令处理（tree/status/list/handoff/frontier）。
 *
 * 与 advance action 的根本区别：
 *   - 不调 dispatch、不写 store、不 append statusHistory
 *   - 只 new CwStore 读 store.json + 调 render 函数 + console.log
 *   - 参数错误（如 status/handoff 缺 --unitId、tree/status 指定不存在的 unit）→ throw CwError → main catch → exit 1
 *
 * 输出是纯文本（tree/列表/handoff）或 JSON（status），不走 ActionResult 序列化。
 */
export async function runReadonly(
  action: string,
  parsed: ParsedArgs,
  workspacePath: string,
): Promise<void> {
  const store = new CwStore(workspacePath);

  // flag 白名单校验（#5）：readonly 各 action 分支先校验（未知 flag → CwError exit 1）。
  // 校验点统一放入口（action 已定，白名单按 action 取），分支内不再重复。
  validateFlags(action, parsed);

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
    // #10：--full 透传（默认大字段截断，--full 全量）。flag 已登记进 #5 白名单 status 集合。
    process.stdout.write(renderStatus(unit, { full: parsed.full === true }));
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

  if (action === "frontier") {
    // frontier：以某 unit 为根的 frontier 视图（非终态节点 + blocked 判定）。
    // 与 status 同样需要 load + not found 判定，但输出是聚合后的 JSON。
    // --root 指定根 unit id（必填）。
    const rootUnitId = flag(parsed, "root");
    if (!rootUnitId) {
      throw new CwError("frontier 需要 --root");
    }
    const unit = store.load(rootUnitId);
    if (unit === null) {
      throw new CwError(`unit not found: ${rootUnitId}`);
    }
    const result = computeFrontier(rootUnitId, store);
    process.stdout.write(renderFrontier(result));
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
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : CW_LIST_DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  // M4：--cwd 必须是绝对路径（detectCommonDir 需绝对路径做 git probe；归一化后按 encodeCwd(common-dir) 落盘，相对路径 probe 错位）
  if (cwdFlag !== undefined && !isAbsolute(cwdFlag)) {
    throw new CwError(`--cwd 需要绝对路径，当前值: ${cwdFlag}`);
  }

  // ES3：--all 与 --cwd 互斥（--all 跨 cwd 遍历，--cwd 锁定单 cwd，语义冲突）
  if (isAll && cwdFlag !== undefined) {
    throw new CwError("--all and --cwd are mutually exclusive");
  }

  if (isAll) {
    // 跨 cwd 模式：loadAllCwdsFromHome + 注入 cwd/repoMeta 到 AnnotatedUnit
    const cwHome = getCwHome();
    const loaded = loadAllCwdsFromHome(cwHome);
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
  const singleStore = cwdFlag ? new CwStore(cwdFlag) : store;
  const units = singleStore.loadAll();
  const annotated = units.map((unit) => ({ unit }));
  process.stdout.write(renderList(annotated, { limit, offset, layer, grep, verbose: isLong }));
}

/**
 * 找第一个 root unit（parentUnitId 为空/undefined 的 unit）。
 *
 * tree 缺省根的解析规则：顶层 unit 通常无 parent。多个 root 时取 store 里的第一个
 *（loadAll 的顺序即 store.json 里 workUnits 数组顺序，创建先后序）。
 * 无任何 unit 时返回 null。
 */
function findFirstRootUnitId(store: CwStore): string | null {
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
  // CwError（0.x 预期错误）+ CwEngineError（v1 guard fail / unit not found）都映射 exit 1。
  return err instanceof CwError || err instanceof CwEngineError
    ? EXIT_CW_ERROR
    : EXIT_INTERNAL_ERROR;
}

/**
 * 格式化顶层 catch 的错误输出。
 *
 * 契约：
 *   - 非 Error 值 → exit 2，输出 String(err)
 *   - CwError / CwEngineError（exit 1）→ 只输出友好 message，不暴露堆栈
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

// ── 启动弃用 warning（ADR-0014 决策 9 配套） ────────────────

/**
 * 启动弃用 warning（ADR-0014 决策 9 配套）。
 *
 * v2 起 store 改 repo 级（git-common-dir 键控，见 getCwJsonPath），不迁移升级前的
 * 旧 per-cwd store（ADR-0014 决策 9）。本函数在 cw 启动时检测旧 store 是否残留，
 * 残留则一次性提示用户存量任务需重建或手动捞，并写 marker 文件去重（每个 cwd
 * 只 warn 一次）。
 *
 * 检测路径用 workspacePath 直接 encode（升级前的旧 per-cwd 布局），**不**走
 * detectCommonDir 归一化——归一化后路径指向新 repo 级 store，而这里检测的是升级前的
 * 旧布局。
 *
 * 纯检测 + IO，不抛错：弃用提示不阻断 cw 运行，文件操作异常一律吞掉（marker 写失败
 * 最坏导致下次启动重复 warning，可接受）。marker 命名 `.deprecation-warned-<encoded>`
 * （`.` 前缀仅隐藏文件约定）；marker 不会被 readonly 的 store 扫描读取——
 * `loadAllCwdsFromHome`（cross-cwd.ts）用 `isDirectory()` 过滤子目录，普通文件天然排除。
 */
export function warnDeprecatedStore(workspacePath: string): void {
  try {
    const cwHome = getCwHome();
    const encoded = encodeCwd(workspacePath);
    // 旧 per-cwd store 路径（升级前布局：cwd 直接 encode，不经 detectCommonDir 归一化）。
    const oldStorePath = join(cwHome, encoded, "store.json");
    // 非 git 目录：detectCommonDir fallback 回 workspacePath，当前活跃 store 路径
    // （getCwJsonPath）与 oldStorePath 重合——此时 oldStorePath 就是当前 store 而非
    // 弃用残留，跳过避免误报（ADR-0014：非 git per-cwd 是明确保留的支持模式）。
    if (oldStorePath === getCwJsonPath(workspacePath)) {
      return;
    }
    if (!existsSync(oldStorePath)) {
      return;
    }
    const markerPath = join(cwHome, `.deprecation-warned-${encoded}`);
    if (existsSync(markerPath)) {
      return;
    }
    process.stderr.write(
      `[cw] v2 起 store 改 repo 级（git-common-dir 键控），旧 per-cwd store 已弃用；存量任务需重建或手动从 ${oldStorePath} 捞。新任务自动走 repo 级 store。\n`,
    );
    try {
      writeFileSync(markerPath, "");
      // eslint-disable-next-line taste/no-silent-catch -- best-effort：marker 写失败最坏重复 warning，不阻断 cw
    } catch {
      // marker 写失败不阻断——最坏下次启动重复 warning。
    }
    // eslint-disable-next-line taste/no-silent-catch -- best-effort：弃用提示不阻断 cw 运行，异常一律吞
  } catch {
    // 检测/编码异常不阻断 cw 运行（弃用提示是 best-effort）。
  }
}

// ── main ─────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  // argv[0]=node 路径, argv[1]=脚本路径, argv[2] 起才是用户参数
  const parsed = minimist(argv.slice(ARGV_USER_PARAMS_START)) as ParsedArgs;
  cwVerbose = isVerbose(parsed);
  debugLog("verbose mode enabled");
  const rawAction = parsed._[0];

  // help / --help / -h / 无参：显示 help（Unix 惯例：显示用法不是错误）。
  // 放在迁移逻辑之前——help/version 不碰 store。`--help` 等 flag 会让 parsed._ 为空，
  // 所以放在无参分支之前判定（否则 --help 会被当成无参走 help，没问题；但 --version 会被
  // 当成无参而显示 help，故 version flag 必须在此分支之前判）。
  if (parsed.version === true || parsed.v === true) {
    process.stdout.write(`cw ${readCliVersion()}\n`);
    return;
  }
  if (
    rawAction === undefined ||
    rawAction === "help" ||
    parsed.help === true ||
    parsed.h === true
  ) {
    // per-command help 双入口（#11 并入 #5）：
    //   1. `cw <action> --help`：rawAction 是合法 action 且带 --help/-h
    //   2. `cw help <action>`：rawAction === "help"，parsed._[1] 是目标 action
    // 目标 ∈ ALL_ACTIONS → 渲染该 action 的合法 flag 列表；`cw help <未知>` → CwError exit 1。
    const target =
      rawAction === "help"
        ? String(parsed._[1] ?? "")
        : rawAction !== undefined
          ? String(rawAction)
          : "";
    if (target !== "" && ALL_ACTIONS.has(target)) {
      process.stdout.write(renderActionHelp(target));
      return;
    }
    if (
      rawAction === "help" &&
      target !== "" &&
      target !== "help" &&
      target !== "version"
    ) {
      // `cw help <未知>`（help/version 是命令不是 action，放行到全局 help）
      // 合法列表 = ALL_ACTIONS + help/version，与下方「未知 action」分支一致
      throw new CwError(`未知 action "${target}"，合法: ${[...ALL_ACTIONS, "help", "version"].join(", ")}`);
    }
    process.stdout.write(renderHelp());
    return;
  }
  // version 作为 action（cw version）。
  if (rawAction === "version") {
    process.stdout.write(`cw ${readCliVersion()}\n`);
    return;
  }
  const action = String(rawAction);

  // workspacePath 解析（所有子命令共用）。
  const workspacePath =
    typeof parsed.workspace === "string" ? parsed.workspace : process.cwd();

  // ── 命令分支（`cw <action> ...`）──
  // cw 唯一入口：所有命令都走 `cw <action>`（Wave 3 起去掉 v1 前缀）。
  // ALL_ACTIONS = VALID_ACTIONS ∪ READONLY_QUERIES（create/推进 + tree/status/list/handoff）。
  if (ALL_ACTIONS.has(action)) {
    // 启动弃用 warning：在 dispatch/只读查询前、workspacePath 解析后检测旧 per-cwd
    // store 残留。best-effort，不阻断后续流程（warnDeprecatedStore 内部吞所有异常）。
    warnDeprecatedStore(workspacePath);
    await runWithAction(argv, workspacePath, action);
    return;
  }

  // 未识别的 action 一律拒绝（含旧的 `v1` 前缀——Wave 3 起彻底切断，不再做向后兼容）。
  // 合法列表 = ALL_ACTIONS（dispatch/只读）+ help/version（独立入口，不进 ALL_ACTIONS）。
  process.stderr.write(
    `错误：未知 action "${action}"。请改用：${buildCommand("<action>", "[layer]", "[options]")}\n` +
      `（合法 action: ${[...ALL_ACTIONS, "help", "version"].join(", ")}）\n`,
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
