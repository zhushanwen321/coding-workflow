import { dispatch } from "./dispatch.js";
import { getVersion } from "./index.js";

/** node 进程 argv 偏移：argv[0]=node argv[1]=脚本路径，其后才是 CLI 参数 */
const CLI_ARGS_OFFSET = 2;

const HELP = `cw — agent 工作的 CI（重写版）

Usage: cw <command> [options]

Commands (M0 起逐步交付):
  create             创建 unit（写）
  evidence submit    提交 spec / 构建证据（写）
  review submit      提交审查结论（写）
  verify             干净重跑验证（写，u4a）
  run                runner 调度循环入口（M1）
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(CLI_ARGS_OFFSET))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
