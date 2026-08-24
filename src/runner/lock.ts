/**
 * runner.lock——跨进程派发互斥（ph-i1 u-i1-d，design-hi-spawn-pi-rpc.md §3.2 R5；
 * 总纲 D8 裁决：锁不入账本——易失进程态非事实）。
 *
 * 路径：<CW_HOME>/<encoded-cwd>/runner.lock（与 events.log 同目录）。JSON 单行
 * 原子写（temp + rename）。获取 = exclusive create（O_EXCL）；已存在读锁：
 *   - pid 活着（process.kill(pid,0)）→ 拒启 + stderr 指引 --force-dispatch；
 *   - pid 死（陈锁）/内容损坏 → 覆盖 + stderr 告警已接管。
 * --force-dispatch 强制覆盖。心跳每轮 poll 重写 heartbeatTs（token 不变）；
 * 释放 = 读锁比对属主 token 后 unlink（不匹配 = 已被接管，跳过删除；正常退出/
 * SIGINT/SIGTERM）。崩溃残留走陈锁抢占路径。
 */
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { encodeCwd } from "../store/project.js";

export type RunnerForm = "cli" | "extension";

export interface RunnerLockInfo {
  pid: number;
  form: RunnerForm;
  rootId: string;
  startedTs: string;
  heartbeatTs: string;
  /**
   * 属主 token（pr-cr-fix A1）：获取时生成一次，心跳重写复用，release 比对——
   * 不匹配（锁已被 --force-dispatch 接管）则跳过删除。旧格式锁无此字段（undefined）。
   */
  token?: string;
}

export interface RunnerLock {
  readonly info: RunnerLockInfo;
  readonly path: string;
  /** 每轮 poll 重写 heartbeatTs（单行原子写） */
  heartbeat(): void;
  /** 属主校验通过才 unlink（token 不匹配 = 已被接管，跳过删除并 stderr 出声；幂等） */
  release(): void;
}

export type AcquireRunnerLockResult =
  | { ok: true; lock: RunnerLock; /** 陈锁/force 接管时的 stderr 告警行（无接办为 undefined） */ takeoverWarning?: string }
  | { ok: false; message: string };

/** 锁文件名（与 events.log 同目录，见模块头） */
export const RUNNER_LOCK_FILE = "runner.lock";

export function runnerLockPath(cwHome: string, cwd: string): string {
  return join(cwHome, encodeCwd(cwd), RUNNER_LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 单行 JSON 原子写：temp 文件 + rename（读者要么见旧版要么见完整新版） */
function atomicWriteLock(path: string, info: RunnerLockInfo): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** 读锁内容；不存在 / 损坏 → null（损坏视同陈锁可抢占） */
function readLock(path: string): RunnerLockInfo | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.pid !== "number" || typeof rec.rootId !== "string") return null;
    return {
      pid: rec.pid,
      form: rec.form === "extension" ? "extension" : "cli",
      rootId: rec.rootId,
      startedTs: typeof rec.startedTs === "string" ? rec.startedTs : "",
      heartbeatTs: typeof rec.heartbeatTs === "string" ? rec.heartbeatTs : "",
      token: typeof rec.token === "string" ? rec.token : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 获取派发锁。opts.force = --force-dispatch（跳过存活检查强制覆盖）。
 * 拒启消息含恢复动作（stderr 直接可用）；陈锁/force 接管返回 takeoverWarning。
 */
export function acquireRunnerLock(opts: {
  cwHome: string;
  cwd: string;
  rootId: string;
  form?: RunnerForm;
  force?: boolean;
}): AcquireRunnerLockResult {
  const path = runnerLockPath(opts.cwHome, opts.cwd);
  mkdirSync(dirname(path), { recursive: true });

  const info: RunnerLockInfo = {
    pid: process.pid,
    form: opts.form ?? "cli",
    rootId: opts.rootId,
    startedTs: new Date().toISOString(),
    heartbeatTs: new Date().toISOString(),
    token: randomUUID(),
  };

  let existing: RunnerLockInfo | null = null;
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, `${JSON.stringify(info)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw err;
    existing = readLock(path);
    if (!opts.force && existing !== null && isProcessAlive(existing.pid)) {
      return {
        ok: false,
        message:
          `cw run: 已有 ${existing.form} 形态 runner（pid ${existing.pid}）在派发本账本；确认接管 = cw run --force-dispatch`,
      };
    }
    const detail =
      existing === null
        ? "内容不可解析"
        : `form ${existing.form}，最后心跳 ${existing.heartbeatTs || "未知"}`;
    atomicWriteLock(path, info);
    const lock = makeLock(path, info);
    return {
      ok: true,
      lock,
      takeoverWarning:
        `[runner] 检测到陈锁（${detail}）已接管（${opts.force === true ? "--force-dispatch" : "pid 已死"}）；` +
        `接管完成后再启动他进程`,
    };
  }
  return { ok: true, lock: makeLock(path, info) };
}

function makeLock(path: string, info: RunnerLockInfo): RunnerLock {
  let released = false;
  return {
    path,
    info,
    heartbeat() {
      if (released) return;
      atomicWriteLock(path, { ...info, heartbeatTs: new Date().toISOString() });
    },
    release() {
      if (released) return;
      released = true;
      // 属主校验（pr-cr-fix A1）：token 不匹配 = 锁已被他进程接管，跳过删除。
      // 锁文件已不存在（他人已正常释放）则静默；不可解析（含旧格式无 token）保守跳过。
      let exists = true;
      try {
        accessSync(path);
      } catch {
        exists = false;
      }
      if (!exists) return;
      const current = readLock(path);
      if (current === null || current.token !== info.token) {
        process.stderr.write(
          `[runner] 锁已被他进程接管或不可解析，跳过删除（由现任持有者释放）：${path}\n`,
        );
        return;
      }
      try {
        unlinkSync(path);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw err;
      }
    },
  };
}
