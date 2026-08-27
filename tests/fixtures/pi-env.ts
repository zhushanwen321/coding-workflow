import { spawnSync } from "node:child_process";

/**
 * real-pi 测试用例的统一三态守卫（2026-08-24 v2.2.0 release CI 失败收敛）：
 *
 * 1. **CI 环境一律 skip**：release.yml 的 `npm test` 在 CI 跑，而 workspace 依赖
 *    `@earendil-works/pi-coding-agent` 会在 `node_modules/.bin/` 提供 vendored `pi`
 *    bin——vitest 运行时 PATH 含该目录，`which pi` / `pi --version` 守卫全部失真；
 *    且 CI 无 `~/.pi` 配置与凭据，real 用例必然失败。CI 判定用 `process.env.CI`。
 * 2. **本地要求真实 pi**：PATH 上的 pi 必须位于 node_modules 之外（vendored 副本
 *    不算真实 pi——无宿主配置无法完成握手/模型调用）。
 * 3. **LLM 链再叠加显式 opt-in**：`CW_TEST_PI_LLM=1` 才跑真实模型调用（i1a 实测
 *    教训：凭据按选中 model 匹配而非按存在性，静态检测必误判）。
 *
 * 用例分档（AGENTS.md「零 mock 框架」约定下）：
 * - 纯单测 / node 协议桩：无守卫，CI 可跑
 * - real-pi 不依赖 LLM（握手 / 生命周期 / rpc 协议）：守卫 `hasRealPi`
 * - real-pi + LLM（真实模型调用）：守卫 `hasRealPiLlm`
 */

export function resolveRealPi(): string | null {
  if (process.env.CI) return null;
  const res = spawnSync("which", ["pi"], { encoding: "utf-8" });
  if (res.status !== 0) return null;
  const path = res.stdout.trim().split("\n")[0];
  if (!path || path.includes("/node_modules/")) return null;
  return path;
}

export const hasRealPi: boolean = resolveRealPi() !== null;

export const hasRealPiLlm: boolean =
  hasRealPi && process.env.CW_TEST_PI_LLM === "1";
