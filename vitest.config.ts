import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 排除设计阶段骨架（.xyz-harness/）的 NotImplementedError stub 测试
    exclude: ["**/.xyz-harness/**", "**/node_modules/**", "**/dist/**"],
    include: ["tests/**/*.test.ts"],
    // e2e 测试用 spawnSync 真实子进程跑 dist/cli.js（含 git init / 多次 cw 调用）。
    // spawnSync 同步阻塞 worker 事件循环：默认 threads 池（worker_threads）+ 默认 5s/10s
    // 超时下，多个 e2e 文件并行时会饿死 vitest 的 worker RPC（"Timeout calling onTaskUpdate"）
    // 并触发超时失败。forks 池用独立子进程跑测试，能更好地承载阻塞型 spawnSync 调用；
    // maxForks=2 限制并行度，避免高核机器同时派生过多 node 子进程相互抢占。
    // timeout 提到 30s 留并行负载下的余量。
    pool: "forks",
    poolOptions: { forks: { maxForks: 2 } },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
