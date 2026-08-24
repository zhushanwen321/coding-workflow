import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    root: __dirname,
    // subagent-workflow 2.0.0 入口是 .ts（jiti 运行态约定）：Node/vitest 外置
    // node_modules 时不做 type-stripping，须 inline 让 vite 转换（探测式动态
    // import 的 ② 查真实通过态依赖此配置）
    server: {
      deps: {
        inline: [/@zhushanwen[\\/]pi-subagent-workflow/],
      },
    },
  },
});
