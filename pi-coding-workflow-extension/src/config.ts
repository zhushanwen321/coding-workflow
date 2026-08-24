/**
 * 配置面（ph-i2 u-i2-c，design-hi-cw-runner-extension §3.2 R5 最小集）。
 *
 * 优先级：env CW_RUNNER_* > 默认值（无配置文件——首版减法）。读取点在 /cw start
 * 启动时一次定格（与 cw 侧 CW_HOME 等环境语义一致，运行中改 env 不生效）。
 * /cw status 显示当前生效值。
 */

export interface RunnerConfig {
  /** 并发派发上限，默认 2（D11 主会话形态默认，比无头 3 保守） */
  maxConcurrency: number;
  /** 置 1 强制全链自声明（探针失败外的手动逃生口） */
  noClarify: boolean;
  /** 轮询间隔 ms，默认沿用 loop 的 5000 */
  pollMs: number;
}

/** env 解析（非法值 → 默认 + 附 warning，不炸启动） */
export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig & { warnings: string[] } {
  const warnings: string[] = [];
  const parsePositive = (raw: string | undefined, name: string, def: number): number => {
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      warnings.push(`CW_RUNNER_${name} 非法值 "${raw}"（须正整数），回落默认 ${def}`);
      return def;
    }
    return n;
  };
  return {
    maxConcurrency: parsePositive(env.CW_RUNNER_MAX_CONCURRENCY, "MAX_CONCURRENCY", 2),
    noClarify: env.CW_RUNNER_NO_CLARIFY === "1",
    pollMs: parsePositive(env.CW_RUNNER_POLL_MS, "POLL_MS", 5000),
    warnings,
  };
}
