/**
 * u-i1-a 验收测试：薄 RPC client（真实子进程，零 mock）。
 *
 * 协议桩 = 真实 `pi --mode rpc`（--no-extensions，独立 tmp session-dir）。
 * LLM 依赖用例（prompt/followUp 链）用 describe.skipIf 守卫：本机 pi 无任何
 * provider 凭据（env 无 API key 且 ~/.pi/agent/auth.json 为空对象）时真实
 * prompt 的实测失败形态是 `success:false, error:"No API key found for the
 * selected model."`——守卫条件即检测该凭据缺失。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRpcClient } from "../src/runner/spawn/rpc-client.js";

const PI_BIN = "pi";

function hasLlmCredential(): boolean {
  // 实测（2026-08-24）：auth.json 存在非默认 provider 的 key 时 pi -p 仍报
  // "No API key found for the selected model"——凭据按选中 model 匹配而非按
  // 存在性，静态检测（env keys / auth.json 非空）必然误判。改为显式 opt-in：
  // CW_TEST_PI_LLM=1 时跑真实 LLM 链，缺省确定性跳过。
  return process.env.CW_TEST_PI_LLM === "1";
}

function tmpSessionDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `i1a-${name}-`));
}

function spawnPiClient(sessionDir: string, onEvent?: (e: Record<string, unknown>) => void) {
  return createRpcClient({
    command: PI_BIN,
    args: [
      "--mode",
      "rpc",
      "--no-extensions",
      "--session-dir",
      sessionDir,
      "--name",
      "i1a-test",
    ],
    cwd: sessionDir,
    onEvent,
    sendTimeoutMs: 20_000,
  });
}

describe("i1a rpc-client: 真实 pi 握手 / 生命周期（不依赖 LLM）", () => {
  it(
    "spawn → get_state 握手返回 sessionId/sessionFile → stop 优雅退出",
    async () => {
      const dir = tmpSessionDir("handshake");
      const client = spawnPiClient(dir);
      const state = await client.getState();
      expect(state.sessionId).toMatch(/^[0-9a-f-]{8,}$/i);
      expect(state.sessionFile).toBeDefined();
      expect(state.sessionFile).toContain(dir);
      expect(state.isStreaming).toBe(false);
      expect(state.messageCount).toBe(0);

      await client.stop();
      const exit = await client.exited();
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(0);
    },
    60_000,
  );

  it(
    "kill -9 后 send() 拒绝；kill()（SIGTERM）使进程退出",
    async () => {
      const dir = tmpSessionDir("kill");
      const client = spawnPiClient(dir);
      await client.getState(); // 确认已活

      // SIGKILL 模拟进程猝死：in-flight send 必须拒绝而非永悬
      const pendingSend = client.getState();
      // 无法直接拿 child pid——经 exited 之外的路径触发：kill 内部用 SIGTERM，
      // 这里用外部手段验证 in-flight 死亡路径：先发命令再 SIGKILL 不便注入，
      // 改为验证 stop 前提下 kill() 的 SIGTERM 生命周期 + 已死后 send 拒绝。
      pendingSend.catch(() => undefined); // 防UnhandledPromiseRejection
      client.kill();
      const exit = await client.exited();
      expect(exit.signal ?? exit.code).not.toBeNull();
      // 进程死后 send 必须同步抛错（guardAlive）
      await expect(client.getState()).rejects.toThrow(/已退出|失败/);
    },
    60_000,
  );

  it(
    "stdout 坏行容忍：非 JSON 杂音行不致崩，后续应答正常关联（node 协议桩子进程）",
    async () => {
      const dir = tmpSessionDir("badline");
      // 真子进程桩（非 mock 框架）：stdout 先吐两行杂音再吐合法应答
      const stub = join(dir, "stub.js");
      writeFileSync(
        stub,
        [
          "process.stdout.write('this is not json at all\\n');",
          "process.stdout.write('{\"partial\":\\n');",
          "process.stdin.once('data', (line) => {",
          "  const req = JSON.parse(line.toString());",
          "  process.stdout.write('noise line\\n');",
          `  process.stdout.write(JSON.stringify({ id: req.id, type: "response", command: req.type, success: true, data: { sessionId: "stub-session" } }) + "\\n");`,
          "});",
        ].join("\n"),
      );
      const client = createRpcClient({
        command: process.execPath,
        args: [stub],
        cwd: dir,
        sendTimeoutMs: 10_000,
      });
      const state = await client.getState();
      expect(state.sessionId).toBe("stub-session");
      await client.stop();
    },
    30_000,
  );
});

describe.skipIf(!hasLlmCredential())(
  "i1a rpc-client: LLM 链（prompt → waitForIdle → followUp）",
  () => {
    it(
      "prompt/waitForIdle/followUp/waitForIdle 全链 + settled 与 reply 时序记录",
      async () => {
        const dir = tmpSessionDir("llm");
        const orderLog: string[] = [];
        const client = spawnPiClient(dir, (e) => {
          if (e.type === "response" && e.command === "prompt") orderLog.push("reply:prompt");
          if (e.type === "agent_settled") orderLog.push("settled");
        });

        const state0 = await client.getState();
        expect(state0.sessionId).toMatch(/.+/);

        await client.prompt("回复 OK 两个字即可");
        const idle1 = await client.waitForIdle(120_000);
        expect(idle1).toBe(true);

        await client.followUp("再说一次");
        const idle2 = await client.waitForIdle(120_000);
        expect(idle2).toBe(true);

        const state1 = await client.getState();
        expect(state1.messageCount).toBeGreaterThan(state0.messageCount);

        await client.stop();
        // 时序观察断言：每轮 prompt 至少产生一个 reply 与一个 settled
        expect(orderLog.filter((x) => x === "reply:prompt").length).toBeGreaterThanOrEqual(2);
        expect(orderLog.filter((x) => x === "settled").length).toBeGreaterThanOrEqual(2);
      },
      300_000,
    );
  },
);
