/**
 * `cw run --root <unitId> [--spawn human] [--poll-ms <n>] [--max-idle-ms <n>]`
 * （u5b 验收文档锁定的 M0 规格）。
 *
 * 参数解析 + root 存在性前置校验后调 human-loop 循环主体（纯读账本 + 打印指令 +
 * 轮询；全部写操作由人照指令调 CLI 完成）。--spawn 缺省即 human（M0 唯一后端）。
 */
import type { CommandContext } from "../dispatch.js";
import { loadLedger } from "../readonly/load.js";
import { runHumanLoop } from "../runner/human-loop.js";
import { fail, stringArg } from "./common.js";

/** 轮询间隔默认值（验收文档循环逻辑 5：--poll-ms 默认 5000） */
export const DEFAULT_POLL_MS = 5_000;
/** 无进展空闲上限默认值（验收文档循环逻辑 6：--max-idle-ms 默认 30min） */
export const DEFAULT_MAX_IDLE_MS = 1_800_000;
/** M0 唯一 spawn 后端（验收文档：非 human 值 exit 1 提示 M0 仅支持 human） */
const M0_SPAWN_BACKEND = "human";

export async function handleRun(ctx: CommandContext): Promise<number> {
  const rootId = stringArg(ctx.argv, "root");
  if (rootId === undefined) {
    return fail(
      "cw run: 缺少 --root <unitId>。恢复动作：cw run --root <rootUnitId> [--spawn human] [--poll-ms <毫秒>] [--max-idle-ms <毫秒>]。",
    );
  }

  const spawnBackend = stringArg(ctx.argv, "spawn") ?? M0_SPAWN_BACKEND;
  if (spawnBackend !== M0_SPAWN_BACKEND) {
    return fail(
      `cw run: 非法 --spawn "${spawnBackend}"：M0 仅支持 human（人肉调度：打印每步指令，人执行后账本推进）。` +
        "恢复动作：用 --spawn human 或省略该参数。",
    );
  }

  const poll = parseMsFlag(ctx.argv["poll-ms"], "--poll-ms", DEFAULT_POLL_MS);
  if (!poll.ok) {
    return fail(poll.error);
  }
  const maxIdle = parseMsFlag(ctx.argv["max-idle-ms"], "--max-idle-ms", DEFAULT_MAX_IDLE_MS);
  if (!maxIdle.ok) {
    return fail(maxIdle.error);
  }

  const { projection } = loadLedger(ctx.cwd);
  if (!projection.units.has(rootId)) {
    return fail(
      `cw run: --root "${rootId}" 不存在（账本内无其 UnitCreated 事件）。` +
        `恢复动作：运行 cw status 查看全部 unit 确认 id，或 cw create --id ${rootId} --brief <路径> 创建。`,
    );
  }

  return runHumanLoop({ cwd: ctx.cwd, rootId, pollMs: poll.value, maxIdleMs: maxIdle.value });
}

/**
 * 毫秒类数值 flag 解析（与 verify.ts 的 --timeout-ms 同一套口径，common.ts 属
 * u2 已验收领地不为 run 扩接口）：number（minimist 数字形态）直接用；纯数字
 * string 转 number；未提供用默认；其余（裸 flag 的 boolean true、非数字、≤0）
 * 报错——静默回退默认值会把显式输入变成 5s/30min 挂死，比报错更糟。
 */
function parseMsFlag(
  raw: unknown,
  flag: string,
  fallback: number,
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
  if (Number.isFinite(value) && value > 0) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error:
      `cw run: 非法 ${flag} "${String(raw)}"：须为正整数（毫秒）。` +
      `恢复动作：如 ${flag} 5000；省略则用默认 ${fallback}ms。`,
  };
}
