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
 * 仅 import src/v1/core 类型 + node:fs / node:path 内置模块。
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

// ── V1Store ──────────────────────────────────────────────────

export class V1Store {
  private readonly dbPath: string;
  private readonly lockPath: string;
  private readonly tmpPath: string;

  /** 事务内的工作副本（深拷贝自磁盘 snapshot）。事务外为 null。 */
  private fileData: V1JsonFile | null = null;
  private inTransaction = false;
  private lockHeld = false;

  constructor(cwd: string) {
    this.dbPath = getV1JsonPath(cwd);
    this.lockPath = this.dbPath + ".lock";
    this.tmpPath = this.dbPath + ".tmp";
    // 父目录自动创建（全局路径首次使用时目录可能不存在）。
    mkdirSync(dirname(this.dbPath), { recursive: true });
  }

  // ── 文件 IO ────────────────────────────────────────────────

  /**
   * 从磁盘读取 _v1.json。文件不存在或解析失败时返回空库。
   *
   * 文件损坏兜底回退空库（原子写入正常情况下不会出现半个文件，这里是终极兜底）。
   */
  private loadFileData(): V1JsonFile {
    if (!existsSync(this.dbPath)) {
      return this.emptyFile();
    }
    let data: V1JsonFile;
    try {
      const raw = readFileSync(this.dbPath, "utf-8");
      data = JSON.parse(raw) as V1JsonFile;
    } catch {
      return this.emptyFile();
    }
    if (!Array.isArray(data.workUnits)) data.workUnits = [];
    return data;
  }

  private emptyFile(): V1JsonFile {
    return { workUnits: [] };
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
   * EEXIST 时检查 stale（pid 已死或超 30s），stale 则 break 后重试。
   * 重试上限 LOCK_MAX_RETRIES，间隔 LOCK_RETRY_DELAY_MS。
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
          if (this.isStaleLock()) {
            this.unlinkLockFile();
            continue;
          }
          this.sleep(LOCK_RETRY_DELAY_MS);
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

  /** 删除 lockfile，吞掉 ENOENT（可能已被 stale 检测清理）。 */
  private unlinkLockFile(): void {
    try {
      unlinkSync(this.lockPath);
    } catch (e) {
      void e;
    }
  }

  /**
   * 判断 lockfile 是否 stale：超时（30s）或持有进程已死。
   * 读不到内容（文件损坏/被删）也视为 stale（可安全抢占）。
   */
  private isStaleLock(): boolean {
    try {
      const content = readFileSync(this.lockPath, "utf-8").trim().split("\n");
      const pid = Number(content[0]);
      const ts = Number(content[1]);

      if (Number.isFinite(ts) && Date.now() - ts > LOCK_STALE_TIMEOUT_MS) {
        return true;
      }

      if (Number.isFinite(pid) && pid > 0) {
        return !this.isProcessAlive(pid);
      }
      return true;
    } catch {
      return true;
    }
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
