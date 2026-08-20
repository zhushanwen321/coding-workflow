/**
 * EventLedger — append-only JSONL 事件账本（canon §3.3 D2 / §3.4 数据流 / 附录 B.3 锁语义）。
 *
 * 职责：
 *   - append：文件锁短事务内「读末 seq → seq+1 → 追加 JSONL 行 + fsync」
 *   - readAll / readUnit：全量 / 单 unit 读取（逐行解析，JSON 语法 + 信封形状
 *     校验，损坏行抛带行号与恢复动作的错误——fx-7 S-1 收口读层，fold/handler
 *     的裸读崩溃面即闭合）
 *   - 跨进程文件锁：lockfile + O_EXCL 原子创建 + stale 检测（30s 阈值 + pid 指纹
 *     二次比对防 TOCTOU 误删）+ 有界重试（总上限 10s，超时抛错；可注入缩短，
 *     测试专用）。空窗口语义（u1 备案承诺）：openSync(wx) 成功到 writeSync 指纹
 *     之间他进程读到空文件时，不 unlink（会误删刚创建的锁），等待重试直至指纹
 *     可读或超时报环境错误（错误信息给出删除该 lockfile 的具体命令）。
 *
 * 锁语义沿用旧实现 archive/src/store/cw-store.ts（附录 B.3 已核实的机制），
 * 按验收文档 u1 调整重试上界：从「50 次 × 100ms」改为「总时长 10s」。
 *
 * 写入校验（锁内、追加前；拒绝 = 抛错，账本保持不变）：
 *   - 孤儿事件拒绝：unit 必须已有 UnitCreated（UnitCreated 自身除外）
 *   - EvidenceSubmitted 幂等：同 unitId+runId 已入账则拒绝重复记账，抛
 *     DuplicateEvidenceError（可区分拒绝——上层据此把「重试同一提交」转幂等成功）
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
/** ms → s 报错文案的换算因子 */
const MS_PER_SECOND = 1_000;
/** Atomics.wait 所需的最小 buffer（4 字节 Int32） */
const INT32_BYTES = 4;
/** 首条事件 seq（账本内单调递增起点） */
const FIRST_SEQ = 1;

/** 五类事件 type 的运行时枚举集（types.ts EventType 的投影，信封校验单一出处） */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "UnitCreated",
  "SpecSubmitted",
  "VerdictSubmitted",
  "EvidenceSubmitted",
  "VerifyRan",
]);

/** 报错里的字段值预览上限（防损坏行携带巨型值撑爆错误信息） */
const PREVIEW_MAX_CHARS = 100;

/** 错误信息里的值预览：JSON 形态，超长截断 */
function preview(value: unknown): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > PREVIEW_MAX_CHARS ? `${s.slice(0, PREVIEW_MAX_CHARS)}…` : s;
}

/**
 * 信封形状最小校验（fx-7 S-1）：JSON 语法合法 ≠ 形状合法——events.log 是外部
 * 可编辑输入，「JSON 合法而形状损坏」此前以裸 TypeError 崩在消费方（fold 的
 * e.payload.unitId / append 的末行 seq+1 / frontier 的 Date.parse(event.ts)），
 * 违背本模块「损坏行抛带恢复动作错误」的承诺。
 *
 * 边界（对齐 types.ts，刻意最小）：信封层 type ∈ 五类枚举 / seq 正整数 / ts
 * 字符串 + 五类 payload 共有的 unitId 字符串。分事件类型的字段级 schema 属
 * 过重校验，语义层继续由既有防线（孤儿 / 重复 UnitCreated / 幂等键）覆盖。
 * 返回 undefined = 通过；否则返回缺口描述（调用方拼进行号报错）。
 */
function envelopeShapeError(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `行是 ${preview(parsed)}（应为事件对象）`;
  }
  const env = parsed as Record<string, unknown>;
  if (typeof env.type !== "string" || !KNOWN_EVENT_TYPES.has(env.type)) {
    return `type=${preview(env.type)} 不在五类事件枚举（UnitCreated/SpecSubmitted/VerdictSubmitted/EvidenceSubmitted/VerifyRan）内`;
  }
  if (typeof env.seq !== "number" || !Number.isInteger(env.seq) || env.seq < 1) {
    return `seq=${preview(env.seq)} 非正整数（信封承诺：账本内从 1 起单调递增）`;
  }
  if (typeof env.ts !== "string") {
    return `ts=${preview(env.ts)} 非字符串（ISO 8601 时间戳）`;
  }
  const payload = env.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return `payload=${preview(payload)} 非对象`;
  }
  const unitId = (payload as Record<string, unknown>).unitId;
  if (typeof unitId !== "string") {
    return `payload.unitId=${preview(unitId)} 非字符串（五类事件 payload 的共有锚字段）`;
  }
  return undefined;
}

/**
 * EvidenceSubmitted 幂等命中（同 unitId+runId 已入账）的可区分拒绝。
 *
 * 消费方区分处置：handler 层据此把「重试同一提交」转为幂等成功（exit 0 + 提示，
 * 不 append——账本本就无重复记账）；其他消费方仍可当普通 Error 透传（消息自带
 * 恢复动作）。
 */
export class DuplicateEvidenceError extends Error {
  readonly unitId: string;
  readonly runId: string;

  constructor(unitId: string, runId: string) {
    super(
      `EventLedger: 拒绝重复提交 EvidenceSubmitted：unit "${unitId}" + runId "${runId}" 已入账（幂等键防重复记账）。恢复动作：确认已入账可 readUnit("${unitId}")；重跑请使用新 runId 提交。`,
    );
    this.name = "DuplicateEvidenceError";
    this.unitId = unitId;
    this.runId = runId;
  }
}

/** lockfile 指纹读取结果的三态 */
type LockFingerprint =
  | { kind: "valid"; pid: number; ts: number }
  /** 文件存在但读不出有效指纹（空文件 / NaN）——「创建-写入指纹」空窗口或残留 */
  | { kind: "empty" }
  /** 文件不存在（已被释放 / 并发清理） */
  | { kind: "missing" };

export class EventLedger {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly lockTotalTimeoutMs: number;
  private lockHeld = false;
  /** 本次 acquireLock 是否见过「空指纹」lockfile（超时报错按此分流恢复动作） */
  private sawEmptyFingerprint = false;

  constructor(ledgerPath: string, options?: { lockTotalTimeoutMs?: number }) {
    this.ledgerPath = ledgerPath;
    this.lockPath = `${ledgerPath}.lock`;
    this.lockTotalTimeoutMs = options?.lockTotalTimeoutMs ?? LOCK_TOTAL_TIMEOUT_MS;
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
        throw new DuplicateEvidenceError(payload.unitId, runId);
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
   * 账本文件不存在 → 空数组（全新项目，正常）；存在损坏行（JSON 语法非法或
   * 信封形状损坏，见 envelopeShapeError）→ 抛带行号与恢复动作的错误。
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i] as string);
      } catch (err) {
        throw new Error(
          `EventLedger: 账本第 ${i + 1} 行不是合法 JSON（${this.ledgerPath}）：${(err as Error).message}。恢复动作：并发写已被文件锁串行化，损坏通常来自外部编辑；备份后检查该行，从损坏行起截断恢复（截断前确认无并发写入者）。`,
        );
      }
      const shapeError = envelopeShapeError(parsed);
      if (shapeError !== undefined) {
        throw new Error(
          `EventLedger: 账本第 ${i + 1} 行不是合法事件信封（${this.ledgerPath}）：${shapeError}。恢复动作：并发写已被文件锁串行化，损坏通常来自外部编辑；备份后检查该行，从损坏行起截断恢复（截断前确认无并发写入者）。`,
        );
      }
      events.push(parsed as LedgerEvent);
    }
    return events;
  }

  /** 读取单个 unit 的全部事件（按账本顺序）。 */
  readUnit(unitId: string): LedgerEvent[] {
    return this.readAll().filter((e) => e.payload.unitId === unitId);
  }

  // ── 跨进程文件锁 ────────────────────────────────────────────

  /**
   * 获取锁：O_EXCL 原子创建 lockfile（写入 pid + 时间戳指纹），总时长有上限，
   * 超时抛错。EEXIST 时做 stale 判定（超 30s 或持锁进程已死）；stale 抢占前二次
   * 读取指纹比对（pid + ts 均一致才 unlink），防止 TOCTOU 窗口里误删其他进程刚
   * 写入的新 lockfile。指纹为空（文件存在但不可解析）时等待而非 unlink——那是
   * 「创建-写入指纹」空窗口里其他进程刚建的锁，误删会导致双写。
   */
  private acquireLock(): void {
    const timeoutSec = Math.round(this.lockTotalTimeoutMs / MS_PER_SECOND);
    this.sawEmptyFingerprint = false;
    const deadline = Date.now() + this.lockTotalTimeoutMs;
    while (Date.now() <= deadline) {
      if (this.tryAcquireLockOnce()) {
        return;
      }
      this.sleep(LOCK_RETRY_DELAY_MS);
    }
    if (this.sawEmptyFingerprint) {
      throw new Error(
        `EventLedger: 账本锁文件存在但 ${timeoutSec}s 内始终读不出有效指纹（${this.lockPath}）——` +
          "疑似「创建后未写入指纹」的残留或内容被外部损坏，本实现不自动清理此类锁。恢复动作：确认没有 cw 进程在写账本后，" +
          `删除该 lockfile 重试：rm "${this.lockPath}"。`,
      );
    }
    throw new Error(
      `EventLedger: ${timeoutSec}s 内未获得账本锁（${this.lockPath}）。恢复动作：lockfile 内容为「pid + 写入时间戳」——` +
        "若该 pid 进程已死或时间戳早于 30s 前，可删除此 lockfile 后重试；否则等持锁进程完成后再试。",
    );
  }

  /** 单次获取尝试：成功返回 true；lockfile 被占则按 stale / 空指纹规则处理后返回 false。 */
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
    if (fingerprint.kind === "empty") {
      // 「创建-写入指纹」空窗口（u1 备案承诺的兑现）：openSync(wx) 成功后、
      // writeSync 指纹前，他进程读到的是空文件 → Number("") = NaN。这不是有效
      // fresh lock 也不是 stale——unlink 会误删刚创建的锁（双写窗口），只能
      // 等持有者把指纹写完（重试计入 acquireLock 的总预算，超时报环境错误）
      this.sawEmptyFingerprint = true;
      return false;
    }
    if (fingerprint.kind === "missing") {
      // 文件已被释放 / 并发清理 → 直接重试（下一轮尝试创建）
      return false;
    }
    if (!this.isStaleLock(fingerprint.pid, fingerprint.ts)) {
      return false; // fresh：等持有者释放
    }
    // stale 二次确认：检查与 unlink 之间其他进程可能已抢先重写 lockfile
    const recheck = this.readLockFingerprint();
    if (
      recheck.kind === "valid" &&
      recheck.pid === fingerprint.pid &&
      recheck.ts === fingerprint.ts
    ) {
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

  /**
   * 读取 lockfile 指纹（pid + 写入时间戳）。三态：valid（可解析）/ empty（文件
   * 存在但内容无效——空窗口或残留损坏）/ missing（文件不存在或读取失败）。读取
   * 失败（非 ENOENT 的 IO 错）与不存在同归 missing：原实现即如此（调用方按可
   * 抢占重试，unlink 失败会上抛可见）。
   */
  private readLockFingerprint(): LockFingerprint {
    let content: string;
    try {
      content = readFileSync(this.lockPath, "utf-8");
    } catch {
      return { kind: "missing" };
    }
    const lines = content.trim().split("\n");
    const pid = Number(lines[0]);
    const ts = Number(lines[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ts)) {
      return { kind: "empty" };
    }
    return { kind: "valid", pid, ts };
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
