import { getVersion } from "./index.js";

/** node 进程 argv 偏移：argv[0]=node argv[1]=脚本路径，其后才是 CLI 参数 */
const CLI_ARGS_OFFSET = 2;


const HELP = `cw — agent 工作的 CI（重写版）

Usage: cw <command> [options]

Commands (M0 起逐步交付):
  run      runner 调度循环入口（M1）
  verify   干净重跑验证（M0）
  status   查看单元状态（只读）
  frontier 查看就绪集合（只读）
  tree     查看分解树（只读）
  report   汇总报告（只读）

详见 docs/rewrite/。`;

export function main(argv: readonly string[]): number {
  const [cmd] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${getVersion()}\n`);
    return 0;
  }
  process.stderr.write(`未知命令: ${cmd}\n运行 cw --help 查看可用命令。\n`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(CLI_ARGS_OFFSET)));
}
