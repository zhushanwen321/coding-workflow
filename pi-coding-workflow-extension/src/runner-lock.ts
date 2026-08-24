/**
 * runner.lock 互斥预检（ph-i2 u-i2-c）。
 *
 * 路径与格式镜像 cw 侧 src/runner/lock.ts（`<CW_HOME>/<encoded-cwd>/runner.lock`，
 * 单行 JSON：pid/form/rootId/startedTs/heartbeatTs）——extension 不改 cw 核心，
 * 故此处是同源镜像（上游变更时同步）。encodeCwd/getCwHome 同理镜像
 * src/store/project.ts。
 *
 * 已知局限（诚实记录）：runLoop 内部自行获锁且 form 恒写 "cli"——extension
 * 形态实际写入的锁文件 form 也是 "cli"（cw 侧无注入口，改它超出本任务文件域）。
 * 本预检的职责 = 在 runLoop 启动前给出 /cw 语境的友好拒启（含 --force 指引）；
 * 陈锁/force 接管语义仍由 runLoop 内部的 acquireRunnerLock 兜底。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface RunnerLockFile {
  pid: number;
  form: "cli" | "extension";
  rootId: string;
  startedTs: string;
  heartbeatTs: string;
}

/** 镜像 cw src/store/project.ts getCwHome（CW_HOME 覆盖须绝对路径） */
export function mirrorGetCwHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CW_HOME;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(`CW_HOME 必须是绝对路径，当前值：${override}`);
    }
    return override;
  }
  return join(homedir(), ".cw");
}

/** 镜像 cw src/store/project.ts encodeCwd：可读前缀 + sha256 前 8 位 */
export function mirrorEncodeCwd(cwd: string): string {
  const readable = cwd.replace(/[\\/.]/g, "__");
  const suffix = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${readable}-${suffix}`;
}

export function mirrorRunnerLockPath(cwHome: string, cwd: string): string {
  return join(cwHome, mirrorEncodeCwd(cwd), "runner.lock");
}

export interface LockPrecheckResult {
  /** true = 无冲突（无锁文件 / 陈锁 / pid 已死），可继续启动 */
  ok: boolean;
  /** 拒启消息（ok=false 时非空，含恢复指引） */
  message?: string;
  detail: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** /cw start 启动前预检：活锁在场 → 拒启（runLoop 内部 acquireRunnerLock 仍是权威） */
export function precheckRunnerLock(opts: { cwHome: string; cwd: string; force?: boolean }): LockPrecheckResult {
  const path = mirrorRunnerLockPath(opts.cwHome, opts.cwd);
  if (!existsSync(path)) return { ok: true, detail: "无锁文件" };
  let parsed: RunnerLockFile | null = null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8").trim());
    if (typeof raw === "object" && raw !== null) {
      const rec = raw as Record<string, unknown>;
      if (typeof rec.pid === "number" && typeof rec.rootId === "string") {
        parsed = {
          pid: rec.pid,
          form: rec.form === "extension" ? "extension" : "cli",
          rootId: rec.rootId,
          startedTs: typeof rec.startedTs === "string" ? rec.startedTs : "",
          heartbeatTs: typeof rec.heartbeatTs === "string" ? rec.heartbeatTs : "",
        };
      }
    }
  } catch {
    parsed = null;
  }
  if (parsed !== null && !opts.force && isProcessAlive(parsed.pid)) {
    return {
      ok: false,
      message:
        `cw run: 已有 ${parsed.form} 形态 runner（pid ${parsed.pid}）在派发本账本；` +
        `确认接管 = /cw start <rootId> --force（等价 cw run --force-dispatch）`,
      detail: `活锁：${path}`,
    };
  }
  return {
    ok: true,
    detail:
      parsed === null
        ? "锁文件不可解析（陈锁），runLoop 启动时会接管并告警"
        : `陈锁（pid ${parsed.pid} 已死），runLoop 启动时会接管并告警`,
  };
}
