/**
 * P1-5/P1-6 回归：pi-1 wait() 真实语义（广播队列——每个 pending waiter 拿同一轮
 * 结果；idle 态无在飞 round 时阻塞到下一轮结算/idle-timeout）下的 followUp 与
 * waitForIdle 行为。真实协议桩形态（手写类，非 mock 框架）。
 *
 * 结论锚点（~/Code/tai-ji-workspace/main/extensions/subagent-workflow）：
 * - spawn-manager.ts:215-232 wait()：closed → 立即返回终态映射；否则 waitNextRound
 * - session-conversation.ts:633-647 waitNextRound：pending waiter 入队
 * - session-conversation.ts:320-324 settleRound：全部 waiter 收同一 result（广播）
 * - session-conversation.ts:618-632 sendFollowUp：round 在飞抛错，idle 态即开新轮
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSubagentBackend, type SmSpawnManager, type SmSubagentHandle, type SmWaitResult } from "../subagent-backend.js";

/**
 * 广播队列桩：对齐 pi-1 真实语义——
 * - wait() 挂起直到下一轮结算；结算时所有 pending waiter 收同一结果（广播）
 * - message() 在 round 在飞时抛错；idle 态调用即「结算上一轮 + 开新轮」（新轮
 *   由测试手动 advance 模拟子进程回复）
 */
class BroadcastHandle implements SmSubagentHandle {
  readonly id: string;
  readonly slug: string;
  messages: string[] = [];
  cancelled = false;
  sessionFile: string | undefined;
  private roundText = "";
  private roundNo = 0;
  private running = false;
  private terminal: { status: "done" | "failed" | "cancelled" } | undefined;
  private waiters = new Set<(r: SmWaitResult) => void>();
  private static seq = 0;

  constructor(slug: string) {
    this.id = `bc-${++BroadcastHandle.seq}`;
    this.slug = slug;
  }

  get settled(): boolean {
    return this.terminal !== undefined || this.cancelled;
  }

  /** 子进程侧推进：当前 round 以 text 结算（或终态收口） */
  advance(text: string, settle?: "done" | "failed" | "cancelled"): void {
    this.roundNo += 1;
    this.roundText = text;
    this.running = false;
    if (settle !== undefined) {
      this.terminal = { status: settle };
    }
    const result: SmWaitResult = {
      status: settle ?? "done",
      text,
      turns: 1,
      round: this.roundNo,
      settled: this.terminal !== undefined,
      ...(this.terminal !== undefined ? { reason: "child-exited" } : {}),
    };
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) w(result);
  }

  async wait(): Promise<SmWaitResult> {
    if (this.terminal !== undefined) {
      return { status: this.terminal.status, text: "", turns: 0, round: this.roundNo, settled: true, reason: "child-exited" };
    }
    if (this.cancelled) {
      return { status: "cancelled", text: "", turns: 0, round: 0, settled: true, reason: "cancelled" };
    }
    return await new Promise<SmWaitResult>((resolve) => {
      this.waiters.add(resolve);
    });
  }

  async message(text: string): Promise<void> {
    if (this.running) {
      throw new Error("round in flight — wait for the current round to settle before sending a follow-up");
    }
    if (this.settled) {
      throw new Error("conversation already closed");
    }
    this.messages.push(text);
    this.roundText = "";
    this.running = true; // 新 round 在飞，测试稍后 advance 模拟回复
  }

  cancel(): void {
    this.cancelled = true;
    const ws = [...this.waiters];
    this.waiters.clear();
    for (const w of ws) {
      w({ status: "cancelled", text: "", turns: 0, round: this.roundNo, settled: true, reason: "cancelled" });
    }
  }
}

class BroadcastManager implements SmSpawnManager {
  handle: BroadcastHandle | undefined;
  start(opts: { slug: string }): Promise<SmSubagentHandle> {
    this.handle = new BroadcastHandle(opts.slug);
    return Promise.resolve(this.handle);
  }
  list(): SmSubagentHandle[] {
    return this.handle !== undefined && !this.handle.settled ? [this.handle] : [];
  }
  onUiRequest(): () => void {
    return () => {};
  }
  onSettled(): () => void {
    return () => {};
  }
}

let dir: string;
let briefPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cw-backend-wait-"));
  briefPath = join(dir, "brief.md");
  await writeFile(briefPath, "# 任务书\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeReq(timeoutMs = 10_000) {
  return {
    role: "designer" as const,
    unitId: "feat-w",
    workdir: dir,
    projectCwd: dir,
    artifactDir: join(dir, "topic"),
    briefPath,
    timeoutMs,
  };
}

describe("P1-5：waitForIdle → followUp 真实序列（idle 态 wait() 阻塞）", () => {
  it("waitForIdle 消费 idle 锚后 followUp 不挂起——直接 message 开新轮", async () => {
    const mgr = new BroadcastManager();
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq());
    // round 1 在飞（brief 已发）：异步推进子进程回复
    setTimeout(() => mgr.handle?.advance("round-1 输出\n"), 50);
    expect(await h.waitForIdle(2_000)).toBe(true);
    // 修复前：followUp 内无条件 await wait()——idle 态广播桩（与 pi-1 同语义）
    // 永不结算 → 本测试超时挂死；修复后短窗耗尽直接 message
    await h.followUp("七问反思");
    expect(mgr.handle?.messages).toEqual(["七问反思"]);
    const stdout = await readFile(join(dir, "topic", "feat-w.designer.stdout"), "utf-8");
    expect(stdout).toContain("round-1 输出\n");
    expect(stdout.match(/round-1 输出/g)).toHaveLength(1); // P1-6：单 waiter 无重复 append
    mgr.handle?.advance("反思回复\n", "done");
    expect((await h.wait()).exitCode).toBe(0);
  }, 8_000);

  it("round 真在飞时 followUp 仍先结算当前 round 再 message（旧语义兼容）", async () => {
    const mgr = new BroadcastManager();
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq());
    // round 1 在飞且在 250ms 窗口内结算——followUp 应先消费再 message
    setTimeout(() => mgr.handle?.advance("在飞 round 文本\n"), 80);
    await h.followUp("追问");
    expect(mgr.handle?.messages).toEqual(["追问"]);
    const stdout = await readFile(join(dir, "topic", "feat-w.designer.stdout"), "utf-8");
    expect(stdout).toContain("在飞 round 文本\n");
    mgr.handle?.advance("回复\n", "done");
    await h.wait();
  }, 8_000);
});

describe("P1-6：waitForIdle 的 wait() 调用数（广播语义下不重复 append）", () => {
  it("长等待期只创建一个 waiter——多轮 tick 不叠加 wait() 调用", async () => {
    const mgr = new BroadcastManager();
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq());
    let waitCalls = 0;
    const orig = mgr.handle!.wait.bind(mgr.handle);
    mgr.handle!.wait = async (): Promise<SmWaitResult> => {
      waitCalls += 1;
      return orig();
    };
    // round 600ms 后才结算——waitForIdle 以 200ms tick 等待，跨 ≥3 个 tick
    setTimeout(() => mgr.handle?.advance("迟到 round\n"), 600);
    expect(await h.waitForIdle(3_000)).toBe(true);
    expect(waitCalls).toBe(1); // 修复前每 tick +1（≥3），广播语义下同轮 text 重复 append
    mgr.handle?.advance("收口\n", "done");
    await h.wait();
  }, 8_000);
});
