/**
 * installer/core.mjs 的最小类型声明（probe.ts 复用 probeLoadRpc 握手逻辑所需；
 * 实现在 core.mjs，本文件只声明消费面）。
 */

export function probeLoadRpc(opts: {
  piBin?: string;
  agentDir: string;
  extensions: string[];
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
}): Promise<{ ok: boolean; output: string }>;
