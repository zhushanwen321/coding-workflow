#!/usr/bin/env node
/**
 * cli.ts — CW CLI 入口（argv 解析 + action→handler 路由 + ActionDeps 构造 + exit code 映射）。
 *
 * 职责：
 *   - argv 解析（minimist）
 *   - action 子命令路由
 *   - 构造 ActionDeps（CwStore / GitValidator / GateRunner）
 *   - 调 dispatch（engine 统一入口）
 *   - 序列化 ActionResult → stdout JSON
 *   - exit code 映射（C-1 分层契约）
 *
 * Level 1 接线：
 *   - main → parseParams → construct ActionDeps → dispatch → stdout JSON
 *   - mapExitCode → GuardError/code 区分 gate fail vs 程序错误
 *   - 顶层 try/catch → stderr + exit code（稳定性保障）
 */

import minimist from "minimist";

import { dispatch, GuardError } from "../engine/dispatch.js";
import { CwStore } from "../engine/store.js";
import { GateRunner, GitValidator } from "../engine/gates.js";
import { parseParams, resolveDbPath } from "./protocol.js";
import type { ActionResult, CwAction } from "../engine/types.js";

// ── exit code 映射（C-1 分层契约） ──────────────────────────

/**
 * mapExitCode — 把 dispatch 结果/错误映射到 exit code。
 *
 * 契约（C-1）：
 *   - exit 0 = 程序正常（gate pass/fail 都是正常返回，结果在 stdout JSON）
 *   - exit 1 = 程序错误（参数校验 / illegal_transition / topic not found）
 *   - exit 2 = 内部异常（未预期的错误）
 */
function mapExitCode(resultOrError: ActionResult | Error): number {
  if (resultOrError instanceof Error) {
    if (resultOrError instanceof GuardError) {
      // illegal_transition / phase_incomplete / cache_inconsistent → exit 1
      return 1;
    }
    // 参数校验 / topic not found / 内部异常 → exit 1
    return 1;
  }
  // ActionResult（含 gatePassed=true 或 false）→ exit 0
  return 0;
}

// ── main ─────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  // 接线：minimist 解析 argv。
  const parsed = minimist(argv.slice(2)); // 跳过 node + cw
  const action = parsed._[0] as string | undefined;

  if (!action) {
    process.stderr.write("错误：未指定 action。用法：cw <action> [options]\n");
    process.exit(1);
  }

  // 验证 action 合法性
  const validActions: CwAction[] = [
    "create", "plan", "clarify", "detail", "dev", "test", "retrospect", "closeout", "replan",
  ];
  if (!validActions.includes(action as CwAction)) {
    process.stderr.write(`错误：未知 action "${action}"。有效 action: ${validActions.join(", ")}\n`);
    process.exit(1);
  }

  // 接线：读取 stdin（异步）
  const stdinData = await readStdin();
  const isStdinTTY = process.stdin.isTTY;

  // 接线：parseParams（protocol.ts 组合入口）
  const params = parseParams(action as CwAction, parsed, stdinData, isStdinTTY);

  // 接线：resolveDbPath + 构造 ActionDeps
  const workspacePath = params.workspacePath ?? process.cwd();
  const dbPath = resolveDbPath(workspacePath, process.env.CW_HOME);
  const store = new CwStore(dbPath);
  const git = new GitValidator(workspacePath);
  const runner = new GateRunner(workspacePath);

  const deps = { store, git, runner, workspacePath };

  // 接线：dispatch（engine 统一入口）
  const result = dispatch(params as Parameters<typeof dispatch>[0], deps);

  // 接线：序列化 ActionResult → stdout JSON
  const output = JSON.stringify(result, null, 2);
  process.stdout.write(output + "\n");

  // exit 0（程序正常，gate 结果在 JSON 中）
  process.exit(0);
}

// ── stdin 读取 ──────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    // 如果 stdin 已经结束（如非 pipe 模式），立即 resolve
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

// ── 顶层 try/catch（稳定性保障：未捕获异常 → stderr + exit 2） ──

main(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`错误：${message}\n`);
  const exitCode = err instanceof Error ? mapExitCode(err) : 2;
  process.exit(exitCode);
});
