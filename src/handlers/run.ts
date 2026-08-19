/**
 * `cw run --root <unitId> [--spawn human|pi] [--poll-ms <n>] [--max-idle-ms <n>] [--max-concurrency <n>]
 * [--reviewer-model <m>] [--max-spec-rejects <n>]`（u7 验收文档锁定：--spawn 路由到后端无关调度循环
 * src/runner/loop.ts + AgentSpawn 适配器；mx-1 增补 --reviewer-model；mx-4 增补
 * --max-spec-rejects——runner 侧 spec 打回代数转人工预算，只影响本循环判定，
 * 只读命令恒用默认值）。
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
import { SPEC_REVIEW_DEADLOCK_FAILS } from "../readonly/frontier.js";
import { loadLedger } from "../readonly/load.js";
import { runLoop } from "../runner/loop.js";
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
 * 后端名 → 适配器模块说明符（相对本文件，编译后相对 dist/handlers/run.js）。
 * 非字面量说明符：tsc 不解析（模块缺席不阻断编译），见模块头。
 */
const BACKEND_SPECIFIERS: Record<string, string> = {
  human: "../runner/spawn/human.js",
  pi: "../runner/spawn/pi.js",
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

/** 首字母大写（工厂导出名探测用：pi → createPiAdapter） */
function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

/**
 * 解析 --spawn 后端为适配器实例。已知两族导出形态都探测：
 *   - 常量 `<name>Adapter`（u6b 验收文档对 human 的用词 humanAdapter）
 *   - 工厂 `create<Name>Adapter()`（u6c pi.ts 实际形态）
 * 三类失败（未知名 / 模块缺席 / 导出不满足契约）各给可操作错误。
 */
async function resolveSpawnAdapter(name: string): Promise<AdapterOutcome> {
  const known = Object.keys(BACKEND_SPECIFIERS).join("、");
  const specifier = BACKEND_SPECIFIERS[name];
  if (specifier === undefined) {
    return {
      ok: false,
      message:
        `cw run: 未知 --spawn 后端 "${name}"（可选：${known}）。` +
        "恢复动作：用 --spawn human（人肉调度）或 --spawn pi（无头 agent），或省略该参数默认 human。",
    };
  }

  let moduleNamespace: unknown;
  try {
    moduleNamespace = await import(specifier);
  } catch {
    return {
      ok: false,
      message:
        `cw run: --spawn ${name} 后端模块尚未就绪（${specifier} 不在 dist——u6b/u6c 并行开发期可能未合入）。` +
        `恢复动作：确认 src/runner/spawn/${name}.ts 已合入后 npm run build 再试；期间可用已就绪后端（${known}）或按 cw status 手工推进。`,
    };
  }

  const record = moduleNamespace as Record<string, unknown>;
  const direct = record[`${name}Adapter`];
  const factory = record[`create${capitalize(name)}Adapter`];
  const fromFactory =
    typeof factory === "function" ? (factory as () => unknown)() : undefined;
  const candidate = isAgentSpawnAdapter(direct) ? direct : fromFactory;
  if (!isAgentSpawnAdapter(candidate)) {
    return {
      ok: false,
      message:
        `cw run: --spawn ${name} 后端模块已加载，但其导出不满足 AgentSpawnAdapter 契约` +
        `（期望导出 ${name}Adapter 常量或 create${capitalize(name)}Adapter() 工厂，返回值含 name: string 与 spawn()）。` +
        `恢复动作：核对 src/runner/spawn/${name}.ts 的导出与 src/runner/spawn/types.ts 契约。`,
    };
  }
  return { ok: true, adapter: candidate };
}

export async function handleRun(ctx: CommandContext): Promise<number> {
  const rootId = stringArg(ctx.argv, "root");
  if (rootId === undefined) {
    return fail(
      "cw run: 缺少 --root <unitId>。恢复动作：cw run --root <rootUnitId> [--spawn human|pi] " +
        "[--poll-ms <毫秒>] [--max-idle-ms <毫秒>] [--max-concurrency <n>] [--max-spec-rejects <n>]。",
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

  // mx-1：reviewer 异源模型（可选）。flag 优先于进程环境 CW_REVIEWER_MODEL
  //（runLoop 启动时按同一优先级读取）；未配置时 reviewer spawn 回落 builder
  // 同款模型链——结构隔离不依赖模型异源，异源是配置项（设计 D1/D2）
  const reviewerModel = stringArg(ctx.argv, "reviewer-model");
  if (reviewerModel === "") {
    return fail(
      "cw run: --reviewer-model 需要一个模型名参数（如 --reviewer-model provider/model）。" +
        "恢复动作：补上模型名，或去掉该 flag（回退 CW_REVIEWER_MODEL 环境变量 / builder 同款模型）。",
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

  return runLoop({
    rootId,
    adapter: backend.adapter,
    cwd: ctx.cwd,
    pollMs: poll.value,
    maxIdleMs: maxIdle.value,
    maxConcurrency: maxConcurrency.value,
    maxSpecRejects: maxSpecRejects.value,
    ...(reviewerModel !== undefined ? { reviewerModel } : {}),
  });
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
