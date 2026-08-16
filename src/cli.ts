#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { dispatch } from "./dispatch.js";
import { getVersion } from "./index.js";

/** node 进程 argv 偏移：argv[0]=node argv[1]=脚本路径，其后才是 CLI 参数 */
const CLI_ARGS_OFFSET = 2;

const HELP = `cw — agent 工作的 CI（重写版）

Usage: cw <command> [options]

Commands:
  create             创建 unit（写）
  evidence submit    提交 spec / 构建证据（写）
  review submit      提交审查结论（写）
  verify             干净重跑验证（写）
  run                runner 调度循环入口
  status             查看单元状态（只读）
  frontier           查看就绪集合（只读）
  tree               查看分解树（只读）
  report             汇总报告（只读）

详见 docs/rewrite/。`;

export async function main(argv: readonly string[]): Promise<number> {
  const [cmd] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${getVersion()}\n`);
    return 0;
  }
  const status = await dispatch(argv, process.cwd());
  if (status === -1) {
    process.stderr.write(`未知命令: ${cmd}\n运行 cw --help 查看可用命令。\n`);
    return 1;
  }
  return status;
}

/**
 * main 是否由本文件直接执行（node dist/cli.js / npm bin symlink / 含空格路径调起）。
 *
 * 判据 = 本模块文件路径与 argv[1] 的 realpath 逐字节相等：
 *   - npm bin 是 symlink 时 import.meta.url 已解析为 realpath，而 argv[1] 仍是
 *     symlink 路径——两侧都归一到 realpath 才相等；
 *   - 路径含空格等字符时 import.meta.url 是 URL 编码形态，fileURLToPath 归一后
 *     才能与文件系统路径比较。
 * argv[1] 缺失（node -e / REPL）或不可 realpath（指向不存在的路径）时安全短路，
 * 不视为直跑（main 不自执行，模块仅被 import）。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(CLI_ARGS_OFFSET))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
