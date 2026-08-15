/**
 * EventLedger — append-only JSONL 事件账本（canon §3.3 D2 / §3.4 数据流 / 附录 B.3 锁语义）。
 *
 * 职责：
 *   - append：文件锁短事务内「读末 seq → seq+1 → 追加 JSONL 行 + fsync」
 *   - readAll / readUnit：全量 / 单 unit 读取（逐行解析，损坏行抛带恢复动作的错误）
 *   - 跨进程文件锁：lockfile + O_EXCL 原子创建 + stale 检测（30s 阈值 + pid 指纹
 *     二次比对防 TOCTOU 误删）+ 有界重试（总上限 10s，超时抛错）
 *
 * 锁语义沿用旧实现 archive/src/store/cw-store.ts（附录 B.3 已核实的机制），
 * 按验收文档 u1 调整重试上界：从「50 次 × 100ms」改为「总时长 10s」。
 *
 * 写入校验（锁内、追加前；拒绝 = 抛错，账本保持不变）：
 *   - 孤儿事件拒绝：unit 必须已有 UnitCreated（UnitCreated 自身除外）
 *   - EvidenceSubmitted 幂等：同 unitId+runId 已入账则拒绝重复记账
 *   - UnitCreated 幂等：同 unitId 只能创建一次
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type {
  DiscriminatedEvent,
  EventEnvelope,
  EventPayloadMap,
  EventType,
  EvidenceSubmittedPayload,
  LedgerEvent,
} from "../events/types.js";

/** lockfile 被视为 stale 的时间阈值（ms） */
const LOCK_STALE_TIMEOUT_MS = 30_000;
/** 获取锁的总时长上限（ms），超时抛错（不无限重试） */
const LOCK_TOTAL_TIMEOUT_MS = 10_000;
/** 锁重试间隔（ms） */
const LOCK_RETRY_DELAY_MS = 100;
/** Atomics.wait 所需的最小 buffer（4 字节 Int32） */
const INT32_BYTES = 4;
/** 首条事件 seq（账本内单调递增起点） */
const FIRST_SEQ = 1;

export class EventLedger {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private lockHeld = false;

  constructor(ledgerPath: string) {
    this.ledgerPath = ledgerPath;
    this.lockPath = `${ledgerPath}.lock`;
    // 父目录自动创建（CW_HOME 下项目目录首次使用时不存在）
    mkdirSync(dirname(ledgerPath), { recursive: true });
  }

  // ── 写入 ────────────────────────────────────────────────────

  /**
   * 追加一条事件（文件锁短事务：读末 seq → 校验 → seq+1 追加 JSONL + fsync）。
   *
   * 拒绝时抛带恢复动作的 Error，账本不变：
   *   - 孤儿事件 / 重复 UnitCreated / 重复 EvidenceSubmitted（见类头校验清单）
   *   - 账本存在损坏行（读取阶段即抛）
   */
  append<K extends EventType>(type: K, payload: EventPayloadMap[K]): EventEnvelope<K> {
    this.acquireLock();
    try {
      const events = this.readAll();
      this.validateAppend(type, payload, events);
      const seq = events.length === 0 ? FIRST_SEQ : events[events.length - 1].seq + 1;
      const envelope: EventEnvelope<K> = { seq, ts: new Date().toISOString(), type, payload };
      this.appendLine(envelope);
      return envelope;
    } finally {
      this.releaseLock();
    }
  }

  /** 锁内追加前校验；违反不变式抛错（不写任何字节）。 */
  private validateAppend(
    type: EventType,
    payload: EventPayloadMap[EventType],
    events: readonly LedgerEvent[],
  ): void {
    // 宽泛的泛型信封无法按 type 窄化 payload，判别联合视图处理（见 types.ts）
    const prior = events as DiscriminatedEvent[];
    const unitCreated = prior.some(
      (e) => e.type === "UnitCreated" && e.payload.unitId === payload.unitId,
    );

    if (type === "UnitCreated") {
      if (unitCreated) {
        throw new Error(
          `EventLedger: 拒绝追加 UnitCreated：unit "${payload.unitId}" 已创建。恢复动作：账本 append-only 不支持重复创建；如需重新开始请使用新 unitId，查现有 unit 用 readUnit("${payload.unitId}")。`,
        );
      }
      return;
    }
    if (!unitCreated) {
      throw new Error(
        `EventLedger: 拒绝追加 ${type}：unit "${payload.unitId}" 不存在（账本中无其 UnitCreated 事件）。恢复动作：先对该 unit 追加 UnitCreated（cw create），再提交本事件。`,
      );
    }
    if (type === "EvidenceSubmitted") {
      // 参数是宽 union，此分支按类型收窄到 EvidenceSubmittedPayload
      const runId = (payload as EvidenceSubmittedPayload).runId;
      const duplicated = prior.some(
        (e) =>
          e.type === "EvidenceSubmitted" &&
          e.payload.unitId === payload.unitId &&
          e.payload.runId === runId,
      );
      if (duplicated) {
        throw new Error(
          `EventLedger: 拒绝重复提交 EvidenceSubmitted：unit "${payload.unitId}" + runId "${runId}" 已入账（幂等键防重复记账）。恢复动作：确认已入账可 readUnit("${payload.unitId}")；重跑请使用新 runId 提交。`,
        );
      }
    }
  }

  /** 以追加模式写入一行 JSON + fsync；文件首次创建时补 fsync 父目录（POSIX 持久性）。 */
  private appendLine(envelope: LedgerEvent): void {
    const existed = existsSync(this.ledgerPath);
    const fd = openSync(this.ledgerPath, "a");
    try {
      writeSync(fd, `${JSON.stringify(envelope)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!existed) {
      this.fsyncDir();
    }
  }

  private fsyncDir(): void {
    const dirFd = openSync(dirname(this.ledgerPath), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  // ── 读取 ────────────────────────────────────────────────────

  /**
   * 读取全部事件（按账本顺序）。
   * 账本文件不存在 → 空数组（全新项目，正常）；存在损坏行 → 抛带行号与恢复动作的错误。
   */
  readAll(): LedgerEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.ledgerPath, "utf-8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const lines = raw.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop(); // 末行换行收尾产生的空元素
    }
    const events: LedgerEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i] as string) as LedgerEvent);
      } catch (err) {
        throw new Error(
          `EventLedger: 账本第 ${i + 1} 行不是合法 JSON（${this.ledgerPath}）：${(err as Error).message}。恢复动作：并发写已被文件锁串行化，损坏通常来自外部编辑；备份后检查该行，从损坏行起截断恢复（截断前确认无并发写入者）。`,
        );
      }
    }
    return events;
  }

  /** 读取单个 unit 的全部事件（按账本顺序）。 */
  readUnit(unitId: string): LedgerEvent[] {
    return this.readAll().filter((e) => e.payload.unitId === unitId);
  }

  // ── 跨进程文件锁 ────────────────────────────────────────────

  /**
   * 获取锁：O_EXCL 原子创建 lockfile（写入 pid + 时间戳指纹），总时长上限 10s。
   * EEXIST 时做 stale 判定（超 30s 或持锁进程已死）；stale 抢占前二次读取指纹比对
   * （pid + ts 均一致才 unlink），防止 TOCTOU 窗口里误删其他进程刚写入的新 lockfile。
   */
  private acquireLock(): void {
    const deadline = Date.now() + LOCK_TOTAL_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      if (this.tryAcquireLockOnce()) {
        return;
      }
      this.sleep(LOCK_RETRY_DELAY_MS);
    }
    throw new Error(
      `EventLedger: 10s 内未获得账本锁（${this.lockPath}）。恢复动作：lockfile 内容为「pid + 写入时间戳」——若该 pid 进程已死或时间戳早于 30s 前，可删除此 lockfile 后重试；否则等持锁进程完成后再试。`,
    );
  }

  /** 单次获取尝试：成功返回 true；lockfile 被占则按 stale 规则处理后返回 false。 */
  private tryAcquireLockOnce(): boolean {
    try {
      const fd = openSync(this.lockPath, "wx");
      try {
        writeSync(fd, `${process.pid}\n${Date.now()}\n`);
      } finally {
        closeSync(fd);
      }
      this.lockHeld = true;
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw err;
      }
    }

    const fingerprint = this.readLockFingerprint();
    if (fingerprint === null) {
      // 读不到指纹（文件损坏 / 已被并发清理）→ 不是有效 fresh lock，清掉重试
      this.unlinkLockFile();
      return false;
    }
    if (!this.isStaleLock(fingerprint.pid, fingerprint.ts)) {
      return false; // fresh：等持有者释放
    }
    // stale 二次确认：检查与 unlink 之间其他进程可能已抢先重写 lockfile
    const recheck = this.readLockFingerprint();
    if (recheck !== null && recheck.pid === fingerprint.pid && recheck.ts === fingerprint.ts) {
      this.unlinkLockFile();
    }
    return false;
  }

  private releaseLock(): void {
    if (!this.lockHeld) {
      return;
    }
    this.lockHeld = false;
    this.unlinkLockFile();
  }

  /** 删除 lockfile；ENOENT（已被清理）静默通过，其余错误上抛——锁清理失败必须可见。 */
  private unlinkLockFile(): void {
    try {
      unlinkSync(this.lockPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }

  /** 读取 lockfile 指纹（pid + 写入时间戳）；不存在或不可解析返回 null。 */
  private readLockFingerprint(): { pid: number; ts: number } | null {
    try {
      const content = readFileSync(this.lockPath, "utf-8").trim().split("\n");
      const pid = Number(content[0]);
      const ts = Number(content[1]);
      if (!Number.isFinite(pid) || !Number.isFinite(ts)) {
        return null;
      }
      return { pid, ts };
    } catch {
      // 文件不存在 / 读取失败都视为无有效指纹（调用方按可抢占处理）
      return null;
    }
  }

  /** stale 判定：超 30s，或持有进程已死（pid 指纹不可用时也视为 stale）。 */
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
      // signal 0 = 只探测进程存在性与信号权限，不发信号
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Atomics.wait：Node 同步 sleep 的标准方式（不占 CPU 轮询）。 */
  private sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, ms);
  }
}
