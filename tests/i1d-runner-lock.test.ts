/**
 * i1d 单测（ph-i1 u-i1-d，design-hi-spawn-pi-rpc.md §3.2 R5）：runner.lock。
 *
 * 真实锁文件三路径（真实进程 pid 探测，零 mock）：
 *   1. 活锁拒启：锁内 pid 活着（本进程 pid）→ 拒启 + --force-dispatch 指引文案
 *   2. 陈锁抢占：锁内 pid 已死（真实 kill -9 的子进程）→ 覆盖 + 告警
 *   3. force 覆盖：pid 活着但 --force-dispatch → 覆盖 + 告警
 * 另覆盖：心跳重写 / release unlink 幂等 / 损坏锁视同陈锁。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  acquireRunnerLock,
  type RunnerLockInfo,
  runnerLockPath,
} from "../src/runner/lock.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-i1d-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function lockDir(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedLock(cwHome: string, cwd: string, info: Partial<RunnerLockInfo> & { pid: number }): string {
  const path = runnerLockPath(cwHome, cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      pid: info.pid,
      form: info.form ?? "cli",
      rootId: info.rootId ?? "r1",
      startedTs: info.startedTs ?? "2026-08-24T00:00:00.000Z",
      heartbeatTs: info.heartbeatTs ?? "2026-08-24T00:00:01.000Z",
    } satisfies RunnerLockInfo)}\n`,
  );
  return path;
}

/** 起一个真实子进程并 kill -9，返回其（已死）pid */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const pid = child.pid;
  if (pid === undefined) throw new Error("i1d: 测试子进程无 pid");
  await new Promise<void>((resolve) => {
    child.on("spawn", () => {
      process.kill(pid, "SIGKILL");
      resolve();
    });
  });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return pid;
}

describe("i1d：runner.lock 三路径（真实锁文件）", () => {
  it("路径 1——活锁拒启：锁内 pid 活着 → ok:false + 指引 --force-dispatch 文案", () => {
    const cwd = lockDir("live");
    const cwHome = join(tmpRoot, "cw-home-live");
    const path = seedLock(cwHome, cwd, { pid: process.pid, form: "extension" });

    const res = acquireRunnerLock({ cwHome, cwd, rootId: "r2" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("已有 extension 形态 runner（pid " + process.pid + "）在派发本账本");
      expect(res.message).toContain("确认接管 = cw run --force-dispatch");
    }
    // 拒启不覆盖：锁内容仍是原持有者的 pid
    const raw = JSON.parse(readFileSync(path, "utf-8")) as RunnerLockInfo;
    expect(raw.pid).toBe(process.pid);
  });

  it("路径 2——陈锁抢占：锁内 pid 被 kill -9 后 → 覆盖 + 告警（pid 已死）", async () => {
    const cwd = lockDir("stale");
    const cwHome = join(tmpRoot, "cw-home-stale");
    const pid = await deadPid();
    const path = seedLock(cwHome, cwd, { pid, form: "cli", heartbeatTs: "2026-08-24T01:02:03.000Z" });

    const res = acquireRunnerLock({ cwHome, cwd, rootId: "r2" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.takeoverWarning).toBeDefined();
      expect(res.takeoverWarning).toContain("陈锁");
      expect(res.takeoverWarning).toContain("最后心跳 2026-08-24T01:02:03.000Z");
      expect(res.takeoverWarning).toContain("pid 已死");
      expect(res.lock.info.pid).toBe(process.pid);
      // 接管后锁内容已是本进程（release 前读取——release 会 unlink）
      const raw = JSON.parse(readFileSync(path, "utf-8")) as RunnerLockInfo;
      expect(raw.pid).toBe(process.pid);
      res.lock.release();
    }
  });

  it("路径 3——force 覆盖：pid 活着但 force=true → 覆盖 + 告警（--force-dispatch）", () => {
    const cwd = lockDir("force");
    const cwHome = join(tmpRoot, "cw-home-force");
    seedLock(cwHome, cwd, { pid: process.pid, form: "extension" });

    const res = acquireRunnerLock({ cwHome, cwd, rootId: "r2", force: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.takeoverWarning).toContain("--force-dispatch");
      res.lock.release();
    }
  });

  it("损坏锁（非 JSON）视同陈锁：覆盖 + 告警（内容不可解析）", () => {
    const cwd = lockDir("corrupt");
    const cwHome = join(tmpRoot, "cw-home-corrupt");
    const path = runnerLockPath(cwHome, cwd);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{not json at all\n");

    const res = acquireRunnerLock({ cwHome, cwd, rootId: "r2" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.takeoverWarning).toContain("内容不可解析");
      res.lock.release();
    }
  });

  it("无锁目录/无锁文件：直接 O_EXCL 获取，无告警", () => {
    const cwd = lockDir("fresh");
    const cwHome = join(tmpRoot, "cw-home-fresh");
    const res = acquireRunnerLock({ cwHome, cwd, rootId: "r1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.takeoverWarning).toBeUndefined();
      res.lock.release();
    }
  });
});

describe("i1d：锁生命周期（心跳 / 释放）", () => {
  it("heartbeat 重写 heartbeatTs；release unlink；再 release 幂等不抛", async () => {
    const cwd = lockDir("lifecycle");
    const cwHome = join(tmpRoot, "cw-home-lifecycle");
    const res = acquireRunnerLock({ cwHome, cwd, rootId: "r1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { lock } = res;
    const path = runnerLockPath(cwHome, cwd);

    await new Promise((r) => setTimeout(r, 20));
    lock.heartbeat();
    const after = JSON.parse(readFileSync(path, "utf-8")) as RunnerLockInfo;
    expect(after.pid).toBe(process.pid);
    expect(Date.parse(after.heartbeatTs)).toBeGreaterThan(Date.parse(lock.info.startedTs));

    lock.release();
    expect(() => readFileSync(path, "utf-8")).toThrow();
    expect(() => lock.release()).not.toThrow(); // 幂等
    // 心跳在已释放后 no-op（不复活锁文件）
    lock.heartbeat();
    expect(() => readFileSync(path, "utf-8")).toThrow();
  });
});
