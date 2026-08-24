/**
 * `cw run --root <unitId> [--spawn human|pi|pi-rpc] [--poll-ms <n>] [--max-idle-ms <n>] [--max-concurrency <n>]
 * [--reviewer-model <m>] [--max-spec-rejects <n>] [--max-build-attempts <n>] [--spawn-timeout-ms <毫秒>]`
 * （u7 验收文档锁定：--spawn 路由到后端无关调度循环
 * src/runner/loop.ts + AgentSpawn 适配器；mx-1 增补 --reviewer-model；mx-4 增补
 * --max-spec-rejects——runner 侧 spec 打回代数转人工预算，只影响本循环判定，
 * 只读命令恒用默认值；lv-2 增补 --max-build-attempts（buildDrift 停派预算）
 * 与 --spawn-timeout-ms（单次 spawn 超时，env CW_SPAWN_TIMEOUT_MS 同链）；
 * ph-i1 增补 --spawn pi-rpc（长驻 RPC 适配器）与 --force-dispatch（跨进程派发锁
 * runner.lock 的显式接管通道，u-i1-d））。
 *
 * M1 起 --spawn 缺省 human 的语义 = 循环 + humanAdapter（u6b）；M0 的 human-loop.ts
 * 直连路径退役（文件与导出保留兼容既有单测，本文件不再调用）。
 *
 * 适配器模块经动态 import（await import）接入：u6b（human）/ u6c（pi）并行开发期
 * 模块可能尚未合入 dist——说明符走变量使 tsc 不做存在性检查（保证本文件独立可编译
 * 可测），运行时 import 失败转为可操作错误（exit 1）而非 crash；模块合入后同一路径
 * 自然生效，无需改代码。
 */
import type { CommandContext } from "../dispatch.js";
import {
  BUILD_DRIFT_MAX_ATTEMPTS,
  SPEC_REVIEW_DEADLOCK_FAILS,
} from "../readonly/frontier.js";
import { loadLedger } from "../readonly/load.js";
import { AGENT_SPAWN_TIMEOUT_MS, runLoop } from "../runner/loop.js";
import type { AgentSpawnAdapter } from "../runner/spawn/types.js";
import { fail, stringArg } from "./common.js";

/** 轮询间隔默认值（CLI 层缺省；runLoop 自身缺省 1000，直调时更密） */
export const DEFAULT_POLL_MS = 5_000;
/** 无进展空闲上限默认值（--max-idle-ms 默认 30min） */
export const DEFAULT_MAX_IDLE_MS = 1_800_000;
/** 同批 in-flight spawn 上限默认值（--max-concurrency 默认 3） */
export const DEFAULT_MAX_CONCURRENCY = 3;
/** --spawn 缺省值（M0→M1 语义连续：human 后端） */
const DEFAULT_SPAWN_BACKEND = "human";

/**
 * 后端名 → 适配器模块显式注册表（ph-i1 R2：命名探测的 capitalize 拼接对带连字符
 * 名（pi-rpc）产出非法标识符，改显式声明导出名）。说明符相对本文件（编译后相对
 * dist/handlers/run.js），非字面量说明符：tsc 不解析（模块缺席不阻断编译），见模块头。
 */
const BACKEND_SPECIFIERS: Record<string, { specifier: string; factory: string }> = {
  human: { specifier: "../runner/spawn/human.js", factory: "humanAdapter" },
  pi: { specifier: "../runner/spawn/pi.js", factory: "createPiAdapter" },
  "pi-rpc": { specifier: "../runner/spawn/pi-rpc.js", factory: "createPiRpcAdapter" },
};

type AdapterOutcome =
  | { ok: true; adapter: AgentSpawnAdapter }
  | { ok: false; message: string };

/** 运行时契约守卫（动态 import 的模块无编译期类型，导入结果按 unknown 收窄） */
function isAgentSpawnAdapter(value: unknown): value is AgentSpawnAdapter {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.spawn === "function";
}

/**
 * 解析 --spawn 后端为适配器实例。ph-i1 R2 起导出名来自显式注册表（factory 字段，
 * 常量形态 humanAdapter 与工厂形态 createPiAdapter/createPiRpcAdapter 都支持：
 * 值是适配器直接用，是函数则调用后校验）。三类失败（未知名 / 模块缺席 / 导出
 * 不满足契约）各给可操作错误。
 */
async function resolveSpawnAdapter(name: string): Promise<AdapterOutcome> {
  const known = Object.keys(BACKEND_SPECIFIERS).join("、");
  const entry = BACKEND_SPECIFIERS[name];
  if (entry === undefined) {
    return {
      ok: false,
      message:
        `cw run: 未知 --spawn 后端 "${name}"（可选：${known}）。` +
        "恢复动作：用 --spawn human（人肉调度）、--spawn pi（无头一次性）或 --spawn pi-rpc（无头长驻 RPC），或省略该参数默认 human。",
    };
  }

  let moduleNamespace: unknown;
  try {
    moduleNamespace = await import(entry.specifier);
  } catch {
    return {
      ok: false,
      message:
        `cw run: --spawn ${name} 后端模块尚未就绪（${entry.specifier} 不在 dist——并行开发期可能未合入）。` +
        `恢复动作：确认 src/runner/spawn/${name}.ts 已合入后 npm run build 再试；期间可用已就绪后端（${known}）或按 cw status 手工推进。`,
    };
  }

  const record = moduleNamespace as Record<string, unknown>;
  const direct = record[entry.factory];
  const fromFactory =
    typeof direct === "function" && !isAgentSpawnAdapter(direct)
      ? (direct as () => unknown)()
      : undefined;
  const candidate = isAgentSpawnAdapter(direct) ? direct : fromFactory;
  if (!isAgentSpawnAdapter(candidate)) {
    return {
      ok: false,
      message:
        `cw run: --spawn ${name} 后端模块已加载，但其导出 ${entry.factory} 不满足 AgentSpawnAdapter 契约` +
        `（期望适配器常量或工厂，返回值含 name: string 与 spawn()）。` +
        `恢复动作：核对 src/runner/spawn/${name}.ts 的导出与 src/runner/spawn/types.ts 契约。`,
    };
  }
  return { ok: true, adapter: candidate };
}

/** `cw run --help` 的 flag 总览（单一事实源为本 handler 的解析分支；ph-i1 增补 pi-rpc/force-dispatch） */
const RUN_USAGE = [
  "cw run — runner 调度循环",
  "",
  "用法：cw run --root <unitId> [flags]",
  "",
  "Flags:",
  "  --spawn <backend>            spawn 后端：human（缺省）| pi（无头一次性）| pi-rpc（无头长驻 RPC，反思 followUp）",
  "  --force-dispatch             接管在派的跨进程 runner（覆盖 runner.lock；确认另一 runner 已死/该停时用）",
  "  --poll-ms <毫秒>             账本轮询间隔（缺省 5000）",
  "  --max-idle-ms <毫秒>         无账本进展上限（缺省 1800000）",
  "  --max-concurrency <n>        同批 in-flight spawn 上限（缺省 3）",
  "  --reviewer-model <model>     reviewer 异源模型（优先于 CW_REVIEWER_MODEL）",
  "  --max-spec-rejects <n>       spec 打回代数转人工预算（缺省 10）",
  "  --max-build-attempts <n>     buildDrift 停派预算（缺省 5）",
  "  --spawn-timeout-ms <毫秒>    单次 spawn 超时（缺省 1800000；env CW_SPAWN_TIMEOUT_MS 同链）",
].join("\n");

export async function handleRun(ctx: CommandContext): Promise<number> {
  if (ctx.argv.help === true) {
    process.stdout.write(`${RUN_USAGE}\n`);
    return 0;
  }
  const rootId = stringArg(ctx.argv, "root");
  if (rootId === undefined) {
    return fail(
      "cw run: 缺少 --root <unitId>。恢复动作：cw run --root <rootUnitId> [--spawn human|pi] " +
        "[--poll-ms <毫秒>] [--max-idle-ms <毫秒>] [--max-concurrency <n>] [--max-spec-rejects <n>] " +
        "[--max-build-attempts <n>] [--spawn-timeout-ms <毫秒>]。",
    );
  }

  const spawnBackend = stringArg(ctx.argv, "spawn") ?? DEFAULT_SPAWN_BACKEND;
  const poll = parsePositiveIntFlag(ctx.argv["poll-ms"], "--poll-ms", DEFAULT_POLL_MS, "毫秒");
  if (!poll.ok) {
    return fail(poll.error);
  }
  const maxIdle = parsePositiveIntFlag(
    ctx.argv["max-idle-ms"],
    "--max-idle-ms",
    DEFAULT_MAX_IDLE_MS,
    "毫秒",
  );
  if (!maxIdle.ok) {
    return fail(maxIdle.error);
  }
  const maxConcurrency = parsePositiveIntFlag(
    ctx.argv["max-concurrency"],
    "--max-concurrency",
    DEFAULT_MAX_CONCURRENCY,
    "个并发",
  );
  if (!maxConcurrency.ok) {
    return fail(maxConcurrency.error);
  }
  // mx-4：spec 打回代数转人工预算（runner 判定输入；默认值单一事实源 =
  // frontier.ts 的 SPEC_REVIEW_DEADLOCK_FAILS）。只影响本循环，只读命令恒用默认
  const maxSpecRejects = parsePositiveIntFlag(
    ctx.argv["max-spec-rejects"],
    "--max-spec-rejects",
    SPEC_REVIEW_DEADLOCK_FAILS,
    "代",
  );
  if (!maxSpecRejects.ok) {
    return fail(maxSpecRejects.error);
  }
  // lv-2：buildDrift 停派预算（默认值单一事实源 = frontier.ts 的
  // BUILD_DRIFT_MAX_ATTEMPTS）。只影响本循环的派发判定，只读命令恒用默认
  const maxBuildAttempts = parsePositiveIntFlag(
    ctx.argv["max-build-attempts"],
    "--max-build-attempts",
    BUILD_DRIFT_MAX_ATTEMPTS,
    "次",
  );
  if (!maxBuildAttempts.ok) {
    return fail(maxBuildAttempts.error);
  }
  // lv-2：单次 spawn 超时可调入口。env 合流在本层（与 CW_REVIEWER_MODEL 在
  // loop 层合流不同）——差异理由：数字校验与 exit 1 可操作错误天然属 CLI 层
  //（loop 是库化函数，非法值只能 throw 栈而非可操作输出）。优先级：
  // --spawn-timeout-ms flag > CW_SPAWN_TIMEOUT_MS > 缺省常量
  const spawnTimeoutFallback = spawnTimeoutEnvFallback();
  if (!spawnTimeoutFallback.ok) {
    return fail(spawnTimeoutFallback.error);
  }
  const spawnTimeoutMs = parsePositiveIntFlag(
    ctx.argv["spawn-timeout-ms"],
    "--spawn-timeout-ms",
    spawnTimeoutFallback.value,
    "毫秒",
  );
  if (!spawnTimeoutMs.ok) {
    return fail(spawnTimeoutMs.error);
  }

  // mx-1：reviewer 异源模型（可选）。flag 优先于进程环境 CW_REVIEWER_MODEL
  //（runLoop 启动时按同一优先级读取）；未配置时 reviewer spawn 回落 developer
  // 同款模型链——结构隔离不依赖模型异源，异源是配置项（设计 D1/D2）
  const reviewerModel = stringArg(ctx.argv, "reviewer-model");
  if (reviewerModel === "") {
    return fail(
      "cw run: --reviewer-model 需要一个模型名参数（如 --reviewer-model provider/model）。" +
        "恢复动作：补上模型名，或去掉该 flag（回退 CW_REVIEWER_MODEL 环境变量 / developer 同款模型）。",
    );
  }

  // root 前置校验（runLoop 直调路径也会校验并抛错；CLI 层先转 exit 1 的可操作输出）
  const { projection } = loadLedger(ctx.cwd);
  if (!projection.units.has(rootId)) {
    return fail(
      `cw run: --root "${rootId}" 不存在（账本内无其 UnitCreated 事件）。` +
        `恢复动作：运行 cw status 查看全部 unit 确认 id，或 cw create --id ${rootId} --brief <路径> 创建。`,
    );
  }

  const backend = await resolveSpawnAdapter(spawnBackend);
  if (!backend.ok) {
    return fail(backend.message);
  }

  // u-i1-d：--force-dispatch（跨进程派发锁的显式接管通道；R5）
  const forceDispatch = ctx.argv["force-dispatch"] === true;

  return runLoop({
    rootId,
    adapter: backend.adapter,
    cwd: ctx.cwd,
    pollMs: poll.value,
    maxIdleMs: maxIdle.value,
    maxConcurrency: maxConcurrency.value,
    maxSpecRejects: maxSpecRejects.value,
    maxBuildAttempts: maxBuildAttempts.value,
    spawnTimeoutMs: spawnTimeoutMs.value,
    forceDispatch,
    ...(reviewerModel !== undefined ? { reviewerModel } : {}),
  });
}

/**
 * CW_SPAWN_TIMEOUT_MS env 的合法化回落（lv-2）：未设置 = 缺省常量；已设置但
 * 非 `/^\d+$/ 或 ≤0 = 可操作 fail（含原文与合法形态——错误指向恢复动作）。
 * 读取点在 handleRun 启动时一次定格（与 CW_REVIEWER_MODEL 语义一致，运行中改
 * env 不生效）。
 */
function spawnTimeoutEnvFallback(): { ok: true; value: number } | { ok: false; error: string } {
  const raw = process.env.CW_SPAWN_TIMEOUT_MS;
  if (raw === undefined || raw === "") {
    return { ok: true, value: AGENT_SPAWN_TIMEOUT_MS };
  }
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    return {
      ok: false,
      error:
        `cw run: 非法 CW_SPAWN_TIMEOUT_MS "${raw}"：须为正整数（毫秒）。` +
        `恢复动作：如 CW_SPAWN_TIMEOUT_MS=3600000；或改用 --spawn-timeout-ms <毫秒>（flag 优先于本变量）；` +
        `清掉该变量则回默认 ${AGENT_SPAWN_TIMEOUT_MS}ms。`,
    };
  }
  return { ok: true, value: Number(raw) };
}

/**
 * 正整数数值 flag 解析（与 verify.ts 的 --timeout-ms 同一套口径，common.ts 属 u2
 * 已验收领地不为 run 扩接口）：number（minimist 数字形态）直接用；纯数字 string 转
 * number；未提供用默认；其余（裸 flag 的 boolean true、非数字、≤0、非整数量级——
 * 0.5/2.5 等 minimist 数值强转形态绕过字符串正则，mx4 打回 F2 收口）报错——静默
 * 回退默认值会把显式输入变成 5s/30min 挂死，比报错更糟。1e2 类科学计数法强转后
 * 为整数值（100）保留合法：拒绝的是非整数量级，不是书写形态（--max-idle-ms
 * 共用本解析器，正小数毫秒同口径拒绝——与「正整数」文案一致，u4a 口径顺带收口）。
 */
function parsePositiveIntFlag(
  raw: unknown,
  flag: string,
  fallback: number,
  unit: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: fallback };
  }
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (Number.isInteger(value) && value > 0) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error:
      `cw run: 非法 ${flag} "${String(raw)}"：须为正整数（${unit}）。` +
      `恢复动作：如 ${flag} ${unit === "毫秒" ? "5000" : "3"}；省略则用默认 ${fallback}。`,
  };
}
