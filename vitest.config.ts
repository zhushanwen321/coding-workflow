import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 排除设计阶段骨架（.xyz-harness/）的 NotImplementedError stub 测试
    exclude: [
      "**/.xyz-harness/**",
      "**/node_modules/**",
      "**/dist/**",
      // 0.x 状态机 e2e 套件——cw 1.0 已切断 0.x cli 入口（见 src/cli.ts main()），
      // 这些测试通过 `cw create/plan/dev/...`（不带 v1 前缀）建数据，入口切断后必然失败。
      // legacy/ 代码保留，待 v1 e2e（tests/v1/*）补齐等价覆盖后整体清理。
      "tests/e2e.test.ts",
      "tests/e2e-assess.test.ts",
      "tests/e2e-clarify.test.ts",
      "tests/e2e-delete-only.test.ts",
      "tests/e2e-gate-fail.test.ts",
      "tests/e2e-init.test.ts",        // E10e/f 调 cw create 测 init 引导；E10a-d 测 init 本身未切断，待拆分
      "tests/e2e-readonly.test.ts",      // setup 经 setupTo* helper 调 0.x create 建数据；只读查询本身未切断，待改 helper 直写 store
      "tests/e2e-replan.test.ts",
      "tests/e2e-retrospect.test.ts",
      "tests/e2e-review-fix.test.ts",
      "tests/e2e-stage-pruning.test.ts",
      "tests/e2e-test-fix.test.ts",
    ],
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
