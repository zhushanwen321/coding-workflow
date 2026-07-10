import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 排除设计阶段骨架（.xyz-harness/）的 NotImplementedError stub 测试
    exclude: ["**/.xyz-harness/**", "**/node_modules/**", "**/dist/**"],
    include: ["tests/**/*.test.ts"],
  },
});
