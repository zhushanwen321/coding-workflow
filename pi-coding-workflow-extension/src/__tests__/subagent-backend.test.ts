/**
 * u-i2-b：subagent-backend 状态机回归（真实协议桩形态——手写最小 SubagentHandle/
 * SpawnManager 真实类驱动 backend 的 wait/followUp/done/kill 状态机，非 mock 框架）。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSubagentBackend, type SmSpawnManager, type SmSubagentHandle, type SmUiRequestEvent, type SmWaitResult } from "../subagent-backend.js";

/** 一轮脚本：text + 可选终态 */
interface RoundScript {
  text: string;
  settle?: "done" | "failed" | "cancelled";
  error?: string;
}

/** 真实协议桩句柄：round 队列 + 偏离⑥语义（round 在飞时 message 抛错） */
class StubHandle implements SmSubagentHandle {
  readonly id: string;
  readonly slug: string;
  rounds: RoundScript[] = [];
  messages: string[] = [];
  cancelled = false;
  sessionFile: string | undefined;
  private terminal: { status: "done" | "failed" | "cancelled"; reason?: string } | undefined;
  private roundSeq = 0;
  private static seq = 0;

  constructor(slug: string, rounds: RoundScript[], sessionFile?: string) {
    this.id = `sa-stub-${++StubHandle.seq}`;
    this.slug = slug;
    this.rounds = [...rounds];
    this.sessionFile = sessionFile;
  }

  get settled(): boolean {
    return this.cancelled || this.terminal !== undefined;
  }

  async wait(): Promise<SmWaitResult> {
    if (this.terminal !== undefined) {
      return { status: this.terminal.status, text: "", turns: 0, round: 0, settled: true, ...(this.terminal.reason !== undefined ? { reason: this.terminal.reason } : {}) };
    }
    if (this.cancelled) {
      this.terminal = { status: "cancelled", reason: "cancelled" };
      return { status: "cancelled", text: "", turns: 0, round: 0, settled: true, reason: "cancelled" };
    }
    const r = this.rounds.shift();
    if (r === undefined) {
      // 模拟长 round：永不结算（直到 message/cancel 推进）
      return await new Promise<SmWaitResult>(() => {});
    }
    this.roundSeq += 1;
    if (r.settle !== undefined) {
      this.terminal = { status: r.settle };
      return { status: r.settle, text: r.text, turns: 1, round: this.roundSeq, settled: true, ...(r.error !== undefined ? { error: r.error } : {}), reason: "child-exited" };
    }
    return { status: "done", text: r.text, turns: 1, round: this.roundSeq, settled: false, ...(r.error !== undefined ? { error: r.error } : {}) };
  }

  async message(text: string): Promise<void> {
    if (this.rounds.length > 0) {
      throw new Error("round in progress（偏离⑥：round 进行中 message 抛错）");
    }
    if (this.settled) {
      throw new Error("会话已终态，不可 message");
    }
    this.messages.push(text);
    this.rounds.push({ text: `[round-reply] ${text}` });
  }

  cancel(): void {
    this.cancelled = true;
  }
}

/** 真实协议桩 SpawnManager */
class StubManager implements SmSpawnManager {
  starts: Array<Record<string, unknown>> = [];
  handles: StubHandle[] = [];
  script: RoundScript[] = [];
  sessionFile?: string;
  private uiListeners = new Set<(ev: SmUiRequestEvent) => void>();

  start(opts: Parameters<SmSpawnManager["start"]>[0]): Promise<StubHandle> {
    this.starts.push({ ...opts });
    const h = new StubHandle(opts.slug, this.script, this.sessionFile);
    this.handles.push(h);
    return Promise.resolve(h);
  }

  list(): StubHandle[] {
    return this.handles.filter((h) => !h.settled);
  }

  emitUiRequest(ev: SmUiRequestEvent): void {
    for (const cb of this.uiListeners) cb(ev);
  }

  onUiRequest(cb: (ev: SmUiRequestEvent) => void): () => void {
    this.uiListeners.add(cb);
    return () => this.uiListeners.delete(cb);
  }

  onSettled(cb: (ev: SmWaitResult & { handleId: string }) => void): () => void {
    // 桩不触发 settled 事件（backend 不消费它——waitForIdle 走轮询）
    void cb;
    return () => {};
  }
}

let dir: string;
let briefPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cw-subagent-backend-"));
  briefPath = join(dir, "brief.md");
  await writeFile(briefPath, "# 任务书\n交付 spec。\n");
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
});

function makeReq(role: "designer" | "developer" | "reviewer" = "designer", timeoutMs = 10_000) {
  return {
    role,
    unitId: "feat-x",
    workdir: dir,
    projectCwd: dir,
    artifactDir: join(dir, "topic"),
    briefPath,
    timeoutMs,
  };
}

describe("spawn → wait 四态映射", () => {
  it("status=done → exitCode 0，轮文本 append 落 .stdout", async () => {
    const mgr = new StubManager();
    mgr.script = [{ text: "round-1\n" }, { text: "round-2\n", settle: "done" }];
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq());
    const r = await h.wait();
    expect(r.exitCode).toBe(0);
    expect(r.stdoutPath).toContain("feat-x.designer.stdout");
    const stdout = await readFile(r.stdoutPath, "utf-8");
    expect(stdout).toBe("round-1\nround-2\n");
  });

  it("status=failed → exitCode 1（可重派）", async () => {
    const mgr = new StubManager();
    mgr.script = [{ text: "", settle: "failed", error: "agent 自报失败" }];
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq());
    const r = await h.wait();
    expect(r.exitCode).toBe(1);
  });

  it("kill() 后 wait → CRASH；done() 后 wait → 0（偏离②：区分靠自记账）", async () => {
    const mgrA = new StubManager();
    mgrA.script = []; // 长挂 round：只被 kill 推进
    const a = createSubagentBackend(mgrA);
    const ha = await a.adapter.spawn(makeReq());
    ha.kill();
    expect((await ha.wait()).exitCode).toBe("CRASH");

    const mgrB = new StubManager();
    mgrB.script = [];
    const b = createSubagentBackend(mgrB);
    const hb = await b.adapter.spawn(makeReq());
    const rb = await hb.done();
    expect(rb.exitCode).toBe(0);
  });

  it("超时（timeoutMs 到点）→ TIMEOUT + cancel", async () => {
    const mgr = new StubManager();
    mgr.script = []; // 挂死
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq("developer", 80));
    const r = await h.wait();
    expect(r.exitCode).toBe("TIMEOUT");
    expect(mgr.handles[0].cancelled).toBe(true);
  });
});

describe("followUp 时序（偏离⑥：先结算当前 round 再 message）", () => {
  it("round 在飞时 followUp 不直抛——先 wait 消费再 message", async () => {
    const mgr = new StubManager();
    mgr.script = [{ text: "brief 阶段输出\n" }];
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq());
    await h.followUp("七问反思");
    const stub = mgr.handles[0];
    expect(stub.messages).toEqual(["七问反思"]);
    // 时序证据：初始 round 文本在 message 之前已被消费落盘
    const stdout = await readFile(join(dir, "topic", "feat-x.designer.stdout"), "utf-8");
    expect(stdout).toContain("brief 阶段输出");
    expect(stub.messages.length).toBe(1);
  });

  it("会话终态后 followUp 拒绝", async () => {
    const mgr = new StubManager();
    mgr.script = [{ text: "", settle: "done" }];
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq("designer", 5000));
    await h.wait();
    await expect(h.followUp("追问")).rejects.toThrow("终态");
  });
});

describe("角色策略与句柄能力", () => {
  it("reviewer：excludeTools 排 write/edit + 人设注入；designer 无 excludeTools", async () => {
    const mgr = new StubManager();
    mgr.script = [{ text: "", settle: "done" }];
    const backend = createSubagentBackend(mgr);
    await backend.adapter.spawn(makeReq("reviewer"));
    expect((mgr.starts[0].excludeTools as string[]).sort()).toEqual(["edit", "write"]);
    expect((mgr.starts[0].appendSystemPrompt as string[])[0]).toContain("reviewer");

    const mgr2 = new StubManager();
    mgr2.script = [{ text: "", settle: "done" }];
    const b2 = createSubagentBackend(mgr2);
    await b2.adapter.spawn(makeReq("designer"));
    expect(mgr2.starts[0].excludeTools).toBeUndefined();
    expect(mgr2.starts[0].task).toContain("任务书");
    expect(mgr2.starts[0].slug).toBe("feat-x-designer");
  });

  it("onUiRequest 透传且按 handleId 过滤；sessionAnchor 延迟取 getter 值", async () => {
    const mgr = new StubManager();
    mgr.script = [{ text: "", settle: "done" }];
    mgr.sessionFile = "/tmp/sessions/s1.jsonl";
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq());
    const seen: Array<{ id: string; method: string }> = [];
    h.onUiRequest((req) => seen.push(req));
    mgr.emitUiRequest({ handleId: mgr.handles[0].id, id: "u1", request: { method: "ask_user" } });
    mgr.emitUiRequest({ handleId: "别的句柄", id: "u2", request: { method: "ask_user" } });
    expect(seen).toEqual([{ id: "u1", method: "ask_user" }]);
    expect(h.sessionAnchor).toEqual({ sessionId: mgr.handles[0].id, sessionFile: "/tmp/sessions/s1.jsonl" });
  });

  it("waitForIdle：round 结算内返回 true，超时 false", async () => {
    const mgr = new StubManager();
    mgr.script = [{ text: "流式中\n" }]; // 一轮后挂（idle）
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn(makeReq());
    expect(await h.waitForIdle(2000)).toBe(true);
    const mgr2 = new StubManager();
    mgr2.script = [];
    const b2 = createSubagentBackend(mgr2);
    const h2 = await b2.adapter.spawn(makeReq("designer", 10_000));
    expect(await h2.waitForIdle(100)).toBe(false);
  });

  it("brief 缺失 → SPAWN_ERROR 句柄（wait 立即结算）", async () => {
    const mgr = new StubManager();
    const backend = createSubagentBackend(mgr);
    const h = await backend.adapter.spawn({ ...makeReq(), briefPath: join(dir, "不存在.md") });
    expect((await h.wait()).exitCode).toBe("SPAWN_ERROR");
  });

  it("cancelAll/liveHandles 收口：结算后出清单", async () => {
    const mgr = new StubManager();
    mgr.script = [];
    const backend = createSubagentBackend(mgr);
    const h1 = await backend.adapter.spawn(makeReq());
    expect(backend.liveHandles()).toHaveLength(1);
    backend.cancelAll();
    expect(mgr.handles[0].cancelled).toBe(true);
    await h1.wait(); // cancelled → CRASH 结算 → 出清单
    expect(backend.liveHandles()).toHaveLength(0);
  });
});
