/**
 * V1Store — v1 JSON 文件持久化层（单集合扁平存储）。
 *
 * 职责：
 *   - _v1.json 读写（单集合 workUnits，扁平存储 + parentUnitId 外键）
 *   - POSIX 原子写：tmp 文件 → fsync(tmp) → rename → fsync(dir)
 *   - 跨进程文件锁：lockfile + O_EXCL 原子创建 + stale 检测
 *   - 内存事务：fn 在深拷贝副本上操作，正常→原子落盘，异常→丢弃（ROLLBACK）
 *
 * 来源：v5 store 层独立实现。POSIX 原子写 / lockfile 的 Node API 调用方式参考
 * 0.x 的 src/store.ts，但本文件零 0.x 依赖（不 import 任何 src/ 下 0.x 文件），
 * 仅 import src/core 类型 + node:fs / node:path 内置模块。
 *
 * 事务等价性（沿用 POSIX 文件持久化的标准不变式）：
 *   - 原子性：内存深拷贝操作 → temp + fsync + rename 一次性落盘（POSIX rename 原子）
 *   - 隔离性：文件锁串行化 + 内存副本隔离（同事务内 read-after-write 天然一致）
 *   - 持久性：fsync(temp) + fsync(dir) 保证落盘
 *   - 崩溃一致性：任一阶段 crash，磁盘上要么旧文件完整要么新文件完整
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { collectRepoMeta } from "../core/git.js";
import type { V1JsonFile, WorkUnitRecord } from "./schema.js";
import { getV1JsonPath } from "./schema.js";

// ── 常量 ─────────────────────────────────────────────────────

const JSON_INDENT = 2;
/** 文件锁最大重试次数。 */
const LOCK_MAX_RETRIES = 50;
/** 文件锁重试间隔（ms）。 */
const LOCK_RETRY_DELAY_MS = 100;
/** lockfile 被视为 stale 的超时阈值（ms）。 */
const LOCK_STALE_TIMEOUT_MS = 30_000;
/** Atomics.wait 所需的最小 buffer（4 字节 Int32）。 */
const INT32_BYTES = 4;

// ── verbose 日志开关 ─────────────────────────────────────────

/**
 * verbose 模式开关：unlinkLockFile 遇到非 ENOENT 错误时往 stderr 写一行调试线索，
 * 便于排查 stale-lock 抢占异常；默认关闭，避免污染正常输出。
 * 启用方式：`CW_VERBOSE=1` 或 `--verbose`。
 */
function isVerbose(): boolean {
  return (
    process.env["CW_VERBOSE"] === "1" ||
    process.argv.includes("--verbose")
  );
}

function logVerbose(msg: string): void {
  if (isVerbose()) {
    process.stderr.write(`[v1-store] ${msg}\n`);
  }
}

// ── V1Store ──────────────────────────────────────────────────

export class V1Store {
  private readonly dbPath: string;
  private readonly lockPath: string;
  private readonly tmpPath: string;
  /** 构造时传入的 cwd（repoMeta.worktreePath + collectRepoMeta 的 cwd 参数）。 */
  private readonly cwd: string;

  /** 事务内的工作副本（深拷贝自磁盘 snapshot）。事务外为 null。 */
  private fileData: V1JsonFile | null = null;
  private inTransaction = false;
  private lockHeld = false;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.dbPath = getV1JsonPath(cwd);
    this.lockPath = this.dbPath + ".lock";
    this.tmpPath = this.dbPath + ".tmp";
    // 父目录自动创建（全局路径首次使用时目录可能不存在）。
    mkdirSync(dirname(this.dbPath), { recursive: true });
  }

  // ── 文件 IO ────────────────────────────────────────────────

  /**
   * 从磁盘读取 _v1.json。
   *
   * - 文件不存在 → 返回空库（全新安装场景，正常）。
   * - 解析失败 → 抛出错误（包含原文件路径 + 原始错误）。早期版本在这里静默回退空库，
   *   会导致后续 save 在内存里覆盖式写入时把损坏前的数据彻底删空（删库效应）。
   *   现在选择让调用方立即知道文件损坏，避免灾难性数据丢失。
   */
  private loadFileData(): V1JsonFile {
    if (!existsSync(this.dbPath)) {
      return this.emptyFile();
    }
    let data: V1JsonFile;
    try {
      const raw = readFileSync(this.dbPath, "utf-8");
      data = JSON.parse(raw) as V1JsonFile;
    } catch (err) {
      throw new Error(
        `V1Store: failed to parse _v1.json at ${this.dbPath}: ${(err as Error).message}`,
      );
    }
    if (!Array.isArray(data.workUnits)) data.workUnits = [];
    // schema 迁移：旧 store 无 schemaVersion 视为已迁移到 v1（向前兼容）
    if (typeof data.schemaVersion !== "number") data.schemaVersion = 1;
    // repoMeta 缺失留 undefined，首次推进类 save 时回填（不在只读 loadFileData 调 git）
    return data;
  }

  private emptyFile(): V1JsonFile {
    return { schemaVersion: 1, workUnits: [] };
    // repoMeta 首次 save 时由 save() 填充，emptyFile 不调 git
  }

  /**
   * 原子写入磁盘（write tmp → fsync tmp → rename → fsync dir）。
   * 任一阶段 crash，磁盘上要么旧文件完整要么新文件完整。
   */
  private flushToDisk(): void {
    const json = JSON.stringify(this.fileData, null, JSON_INDENT);

    writeFileSync(this.tmpPath, json, "utf-8");

    const tmpFd = openSync(this.tmpPath, "r");
    try {
      fsyncSync(tmpFd);
    } finally {
      closeSync(tmpFd);
    }

    renameSync(this.tmpPath, this.dbPath);

    // fsync 父目录：保证 rename 的目录条目变更也落盘（POSIX 持久性要求）。
    const dirFd = openSync(dirname(this.dbPath), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  // ── 文件锁（跨进程排他） ───────────────────────────────────

  /**
   * 用 O_EXCL 原子创建 lockfile（写入 pid + timestamp）。
   * EEXIST 时检查 stale（pid 已死或超 30s），stale 则重新读取 lockfile 比对内容（pid+timestamp
   * 匹配）后才 unlink 并重试。否则 break 重试（避免抢占其他进程的 fresh lockfile）。
   * 重试上限 LOCK_MAX_RETRIES，间隔 LOCK_RETRY_DELAY_MS。
   *
   * TOCTOU 说明：isStaleLock() 返回 true 到实际 unlink 之间存在窗口；期间其他进程可能
   * 抢先把 stale lockfile unlink 并写入新的 fresh lockfile。如果不做 fingerprint 比对，
   * 本进程会误删别人的新 lockfile，造成锁保护失效。
   */
  private acquireLock(): void {
    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx");
        try {
          writeSync(fd, `${process.pid}\n${Date.now()}\n`);
        } finally {
          closeSync(fd);
        }
        this.lockHeld = true;
        return;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EEXIST") {
          const fingerprint = this.readLockFingerprint();
          if (fingerprint === null) {
            // 读不到 fingerprint（文件被丢/内容不可解析） → lockfile 一定不是其他进程的
            // fresh valid lock：直接 unlink，下一轮 wx 重试。
            this.unlinkLockFile();
            continue;
          }
          if (!this.isStaleLock(fingerprint.pid, fingerprint.ts)) {
            this.sleep(LOCK_RETRY_DELAY_MS);
            continue;
          }
          // stale：二次检查 lockfile fingerprint 与刚才一致才 unlink，
          // 防止 TOCTOU 窗口里其他进程抢先重写。
          const recheck = this.readLockFingerprint();
          if (
            recheck !== null &&
            recheck.pid === fingerprint.pid &&
            recheck.ts === fingerprint.ts
          ) {
            this.unlinkLockFile();
            continue;
          }
          logVerbose(
            `lockfile changed between stale check and unlink (was pid=${fingerprint.pid}@${fingerprint.ts}, now ${recheck === null ? "gone" : `pid=${recheck.pid}@${recheck.ts}`}), skip unlink`,
          );
          continue;
        }
        throw e;
      }
    }
    throw new Error(
      `V1Store: failed to acquire lock after ${LOCK_MAX_RETRIES} retries (${this.lockPath})`,
    );
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    this.unlinkLockFile();
    this.lockHeld = false;
  }

  /**
   * 删除 lockfile，吞掉 ENOENT（可能已被 stale 检测 / 并发进程清理）。
   * 其他错误（如 EACCES / EBUSY / EPERM）在 verbose 模式下写到 stderr，
   * 保留调试线索；非 verbose 模式保持静默（不破坏正常输出流）。
   */
  private unlinkLockFile(): void {
    try {
      unlinkSync(this.lockPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return; // 已不在，正常路径。
      logVerbose(
        `unlinkSync(${this.lockPath}) failed: ${err.code ?? "UNKNOWN"} ${err.message}`,
      );
    }
  }

  /**
   * 读取 lockfile 并解析为 (pid, ts) 指纹。文件不存在或解析失败返回 null
   * （调用方会按 stale 处理）。
   */
  private readLockFingerprint(): { pid: number; ts: number } | null {
    try {
      const content = readFileSync(this.lockPath, "utf-8").trim().split("\n");
      const pid = Number(content[0]);
      const ts = Number(content[1]);
      if (!Number.isFinite(pid) || !Number.isFinite(ts)) return null;
      return { pid, ts };
    } catch {
      return null;
    }
  }

  /**
   * 判断 lockfile 是否 stale：超时（30s）或持有进程已死。
   * 读不到内容（文件损坏/被删）也视为 stale（可安全抢占）。
   *
   * 注意：必须在持有 readLockFingerprint() 返回的 fingerprint 调用，
   * 调用方随后再用同一 fingerprint 二次比对 lockfile 内容，避免 TOCTOU 误删。
   */
  private isStaleLock(pid: number, ts: number): boolean {
    if (Number.isFinite(ts) && Date.now() - ts > LOCK_STALE_TIMEOUT_MS) {
      return true;
    }

    if (Number.isFinite(pid) && pid > 0) {
      return !this.isProcessAlive(pid);
    }
    return true;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      // signal 0 = 不发信号，只检查进程是否存在且有权限 signal。
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private sleep(ms: number): void {
    // Atomics.wait 是 Node 同步 sleep 的标准方式（不阻塞事件循环外的占位）。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, ms);
  }

  // ── 事务 ───────────────────────────────────────────────────

  /**
   * 事务包裹：fn 在内存深拷贝副本上操作，正常→原子落盘，异常→丢弃副本（ROLLBACK）。
   *
   * 不变式：fn 抛异常时，磁盘状态与事务开始前完全一致（fileData 恢复为 snapshot，
   * 不调用 flushToDisk）。
   *
   * 嵌套事务（事务内再调 transaction）：直接在当前副本上执行 fn，不重复加锁/落盘，
   * 由最外层事务统一 flush。保证同事务内多次 save 的原子性。
   */
  transaction<T>(fn: () => T): T {
    // 嵌套：复用外层副本，不重复加锁。
    if (this.inTransaction && this.fileData) {
      return fn();
    }

    this.acquireLock();
    const snapshot = this.loadFileData();
    this.fileData = structuredClone(snapshot);
    this.inTransaction = true;

    try {
      const result = fn();
      this.flushToDisk();
      return result;
    } catch (err) {
      // ROLLBACK：丢弃内存副本，恢复为磁盘 snapshot（未被覆盖，不 flush）。
      this.fileData = snapshot;
      throw err;
    } finally {
      this.inTransaction = false;
      this.fileData = null;
      this.releaseLock();
    }
  }

  /**
   * 返回当前活跃数据：事务内返回内存副本，否则从磁盘加载。
   */
  private getActiveData(): V1JsonFile {
    if (this.inTransaction && this.fileData) {
      return this.fileData;
    }
    return this.loadFileData();
  }

  /**
   * 写操作包裹：若已在事务内则直接执行，否则自动开一个事务。
   * 保证单独调用 save 也有事务语义（原子 + 锁保护）。
   */
  private executeWrite(fn: () => void): void {
    if (this.inTransaction && this.fileData) {
      fn();
      return;
    }
    this.transaction(fn);
  }

  // ── DAO（workUnits 单集合） ───────────────────────────────

  /** 加载单个 WorkUnit（按 id）。不存在返回 null。 */
  load(id: string): WorkUnitRecord | null {
    const data = this.getActiveData();
    const record = data.workUnits.find((u) => u.id === id);
    return record ?? null;
  }

  /** 加载全部 WorkUnit。 */
  loadAll(): WorkUnitRecord[] {
    const data = this.getActiveData();
    return data.workUnits;
  }

  /**
   * 保存（upsert）一个 WorkUnit：已存在（按 id）则整体替换，否则追加。
   */
  save(unit: WorkUnitRecord): void {
    this.executeWrite(() => {
      const data = this.fileData!;
      // 推进类写入刷新 repoMeta（readonly query 不走 save，不会触发）
      data.repoMeta = collectRepoMeta(this.cwd);
      const idx = data.workUnits.findIndex((u) => u.id === unit.id);
      if (idx >= 0) {
        data.workUnits[idx] = unit;
      } else {
        data.workUnits.push(unit);
      }
    });
  }

  /** 查找某父 unit 的所有子 unit（按 parentUnitId 外键）。 */
  findChildren(parentUnitId: string): WorkUnitRecord[] {
    const data = this.getActiveData();
    return data.workUnits.filter((u) => u.parentUnitId === parentUnitId);
  }
}
