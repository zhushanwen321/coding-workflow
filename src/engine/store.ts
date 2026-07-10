/**
 * CwStore — JSON 文件持久化层（搬迁自 pi-coding-workflow，零改动 + 新增 listTopics）。
 *
 * 职责：
 *   - JSON 文件读写
 *   - 内存事务：transaction 回调在深拷贝副本上操作，正常→原子落盘，异常→丢弃（ROLLBACK）
 *   - 跨进程文件锁：lockfile + O_EXCL 原子创建
 *   - 4 集合 DAO（topic / wave / test_case / gate_history）
 *   - schema 演进：schemaVersion 字段
 *
 * 事务等价性：
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

import type {
  Actual,
  CwAction,
  CwStatus,
  CwTopic,
  Evidence,
  GateHistoryEntry,
  GateHistorySeed,
  GateTier,
  TestCase,
  TestCaseSeed,
  Tier,
  Wave,
  WaveSeed,
} from "./types.js";

// ── schema 版本（替代 PRAGMA user_version） ──────────────────

export const SCHEMA_VERSION = 4;

const SCHEMA_V = {
  topicDirAdded: 2,
  requiresScreenshotAdded: 3,
  dependsOnAdded: 4,
} as const;

const JSON_INDENT = 2;

// ── JSON 文件结构（4 集合，对应原 4 表） ──────────────────────

interface TopicRecord {
  topicId: string;
  slug: string;
  tier: Tier;
  objective: string;
  workspacePath: string;
  topicDir: string;
  createdAt: string;
  status: CwStatus;
  planFormat?: "lite" | "mid-clarify" | "mid-detail";
  coverage?: number;
  gatePassed: Partial<Record<CwAction, boolean>>;
  evidence?: Evidence;
}

interface WaveRecord {
  topicId: string;
  id: string;
  dependsOn: string[];
  parallelGroup?: string;
  committed: string | null;
  changes: string[];
  issues: string[];
}

interface TestCaseRecord {
  topicId: string;
  id: string;
  layer: TestCase["layer"];
  scenario: string;
  steps: string;
  expected?: { url?: string; text?: string };
  assertion?: string;
  executor: string;
  status: TestCase["status"];
  actual?: Actual;
  screenshotPath?: string;
  commitHash?: string;
  judgedAt?: string;
  failureReason?: string;
  requiresScreenshot?: boolean;
  dependsOn?: string[];
  parallelGroup?: string;
  file?: string;
  describe?: string;
}

interface GateHistoryRecord {
  id: number;
  topicId: string;
  phase: CwAction;
  action: CwAction;
  gate: string;
  tier: GateTier;
  result: "pass" | "fail";
  ts: string;
  report?: string;
  progressive: boolean;
}

interface CwJsonFile {
  schemaVersion: number;
  topics: TopicRecord[];
  waves: WaveRecord[];
  testCases: TestCaseRecord[];
  gateHistory: GateHistoryRecord[];
}

// ── 常量 ─────────────────────────────────────────────────────

const LOCK_MAX_RETRIES = 50;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_STALE_TIMEOUT_MS = 30_000;
const INT32_BYTES = 4;

// ── CwStore ──────────────────────────────────────────────────

export class CwStore {
  private dbPath: string;
  private lockPath: string;
  private fileData: CwJsonFile | null = null;
  private inTransaction = false;
  private lockHeld = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.lockPath = dbPath + ".lock";
    // 父目录自动创建（全局路径首次使用时目录可能不存在）。
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  // ── 文件 IO ────────────────────────────────────────────────

  /**
   * 从磁盘读取 JSON 文件。文件不存在或解析失败时返回空库。
   * 触发 schemaVersion 迁移（补默认值），迁移后落盘。
   */
  private loadFileData(): CwJsonFile {
    if (!existsSync(this.dbPath)) {
      return this.emptyFile();
    }
    let data: CwJsonFile;
    try {
      const raw = readFileSync(this.dbPath, "utf-8");
      data = JSON.parse(raw) as CwJsonFile;
    } catch {
      // 文件损坏 → 回退空库（原子写入正常情况下不会出现半个文件，这里是终极兜底）。
      return this.emptyFile();
    }
    if (typeof data.schemaVersion !== "number") {
      data.schemaVersion = 0;
    }
    if (!Array.isArray(data.topics)) data.topics = [];
    if (!Array.isArray(data.waves)) data.waves = [];
    if (!Array.isArray(data.testCases)) data.testCases = [];
    if (!Array.isArray(data.gateHistory)) data.gateHistory = [];

    if (data.schemaVersion < SCHEMA_VERSION) {
      this.migrate(data);
    }
    return data;
  }

  private emptyFile(): CwJsonFile {
    return {
      schemaVersion: SCHEMA_VERSION,
      topics: [],
      waves: [],
      testCases: [],
      gateHistory: [],
    };
  }

  /**
   * schemaVersion 迁移。JSON 方案字段直接存在领域对象上，旧版本缺字段时补默认值。
   */
  private migrate(data: CwJsonFile): void {
    const from = data.schemaVersion;

    if (data.schemaVersion < SCHEMA_V.topicDirAdded) {
      for (const t of data.topics) {
        if (t.topicDir === undefined) t.topicDir = "";
      }
    }
    if (data.schemaVersion < SCHEMA_V.requiresScreenshotAdded) {
      for (const tc of data.testCases) {
        if (tc.requiresScreenshot === undefined) tc.requiresScreenshot = false;
      }
    }
    if (data.schemaVersion < SCHEMA_V.dependsOnAdded) {
      for (const tc of data.testCases) {
        if (tc.dependsOn === undefined) tc.dependsOn = [];
      }
    }

    data.schemaVersion = SCHEMA_VERSION;
    this.logMigration(from, SCHEMA_VERSION);
  }

  private logMigration(from: number, to: number): void {
    const line = JSON.stringify({
      event: "cw-migration",
      from,
      to,
      ts: new Date().toISOString(),
    });
    process.stderr.write(`${line}\n`);
  }

  /**
   * 原子写入磁盘（write temp → fsync → rename → fsync dir）。
   * 任一阶段 crash，磁盘上要么旧文件完整要么新文件完整。
   */
  private flushToDisk(): void {
    const json = JSON.stringify(this.fileData, null, JSON_INDENT);
    const tmpPath = this.dbPath + ".tmp";

    writeFileSync(tmpPath, json, "utf-8");

    const tmpFd = openSync(tmpPath, "r");
    try {
      fsyncSync(tmpFd);
    } finally {
      closeSync(tmpFd);
    }

    renameSync(tmpPath, this.dbPath);

    const dirFd = openSync(dirname(this.dbPath), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  // ── 文件锁（跨进程排他） ───────────────────────────────────

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
            this.breakStaleLock();
            continue;
          }
          this.sleep(LOCK_RETRY_DELAY_MS);
          continue;
        }
        throw e;
      }
    }
    throw new Error(
      `CwStore: failed to acquire lock after ${LOCK_MAX_RETRIES} retries (${this.lockPath})`,
    );
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    try {
      unlinkSync(this.lockPath);
    } catch (e) {
      void e;
    }
    this.lockHeld = false;
  }

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
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private breakStaleLock(): void {
    try {
      unlinkSync(this.lockPath);
    } catch (e) {
      void e;
    }
  }

  private sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, ms);
  }

  // ── 事务 ───────────────────────────────────────────────────

  /**
   * 事务包裹：fn 在内存深拷贝副本上操作，正常→原子落盘，异常→丢弃副本（ROLLBACK）。
   */
  transaction<T>(fn: () => T): T {
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
      // ROLLBACK：丢弃内存副本，恢复为磁盘状态
      this.fileData = snapshot;
      throw err;
    } finally {
      this.inTransaction = false;
      this.fileData = null;
      this.releaseLock();
    }
  }

  private getActiveData(): CwJsonFile {
    if (this.inTransaction && this.fileData) {
      return this.fileData;
    }
    return this.loadFileData();
  }

  private executeWrite(fn: () => void): void {
    if (this.inTransaction && this.fileData) {
      fn();
      return;
    }
    this.transaction(fn);
  }

  // ── topic DAO ──────────────────────────────────────────────

  insertTopic(topic: CwTopic): void {
    this.executeWrite(() => {
      const exists = this.fileData!.topics.some(
        (t) => t.topicId === topic.topicId,
      );
      if (exists) {
        throw new Error(
          `UNIQUE constraint failed: topic.topicId '${topic.topicId}'`,
        );
      }
      const record: TopicRecord = {
        topicId: topic.topicId,
        slug: topic.slug,
        tier: topic.tier,
        objective: topic.objective,
        workspacePath: topic.workspacePath,
        topicDir: topic.topicDir,
        createdAt: topic.createdAt,
        status: topic.status,
        planFormat: topic.planFormat,
        coverage: topic.coverage,
        gatePassed: topic.gatePassed,
        evidence: topic.evidence,
      };
      this.fileData!.topics.push(record);
    });
  }

  loadTopic(topicId: string): CwTopic | null {
    const data = this.getActiveData();
    const record = data.topics.find((t) => t.topicId === topicId);
    if (!record) return null;
    const waves = data.waves.filter((w) => w.topicId === topicId);
    const testCases = data.testCases.filter((tc) => tc.topicId === topicId);
    const gateHistory = data.gateHistory
      .filter((g) => g.topicId === topicId)
      .sort((a, b) => a.id - b.id);
    return this.assembleTopic(record, waves, testCases, gateHistory);
  }

  /**
   * 列出所有 topic（含进度摘要）。CLI status/list 用（UC-4，#8 方案A）。
   * 纯读查询，不经过 dispatch，不触发状态变更。
   */
  listTopics(): CwTopic[] {
    const data = this.getActiveData();
    return data.topics.map((record) => {
      const waves = data.waves.filter((w) => w.topicId === record.topicId);
      const testCases = data.testCases.filter((tc) => tc.topicId === record.topicId);
      const gateHistory = data.gateHistory
        .filter((g) => g.topicId === record.topicId)
        .sort((a, b) => a.id - b.id);
      return this.assembleTopic(record, waves, testCases, gateHistory);
    });
  }

  private assembleTopic(
    topic: TopicRecord,
    waves: WaveRecord[],
    testCases: TestCaseRecord[],
    gateHistory: GateHistoryRecord[],
  ): CwTopic {
    return {
      schemaVersion: SCHEMA_VERSION,
      topicId: topic.topicId,
      slug: topic.slug,
      tier: topic.tier,
      objective: topic.objective,
      workspacePath: topic.workspacePath,
      topicDir: topic.topicDir ?? "",
      createdAt: topic.createdAt,
      status: topic.status,
      planFormat: topic.planFormat,
      waves: waves.map((w) => this.mapWaveRecord(w)),
      testCases: testCases.map((tc) => this.mapTestCaseRecord(tc)),
      gateHistory: gateHistory.map((g) => this.mapGateHistoryRecord(g)),
      gatePassed: topic.gatePassed ?? {},
      evidence: topic.evidence,
      coverage: topic.coverage,
    };
  }

  private mapWaveRecord(r: WaveRecord): Wave {
    return {
      id: r.id,
      dependsOn: r.dependsOn ?? [],
      parallelGroup: r.parallelGroup,
      committed: r.committed ?? null,
      changes: r.changes ?? [],
      issues: r.issues ?? [],
    };
  }

  private mapTestCaseRecord(r: TestCaseRecord): TestCase {
    return {
      id: r.id,
      layer: r.layer,
      scenario: r.scenario,
      steps: r.steps,
      expected: r.expected,
      assertion: r.assertion,
      executor: r.executor,
      status: r.status,
      actual: r.actual,
      screenshotPath: r.screenshotPath,
      commitHash: r.commitHash,
      judgedAt: r.judgedAt,
      failureReason: r.failureReason,
      requiresScreenshot: r.requiresScreenshot === true,
      dependsOn: r.dependsOn ?? [],
      parallelGroup: r.parallelGroup,
      file: r.file,
      describe: r.describe,
    };
  }

  private mapGateHistoryRecord(r: GateHistoryRecord): GateHistoryEntry {
    return {
      id: r.id,
      phase: r.phase,
      action: r.action,
      gate: r.gate,
      tier: r.tier,
      result: r.result,
      ts: r.ts,
      report: r.report,
      progressive: r.progressive,
    };
  }

  updateStatus(topicId: string, status: CwStatus): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) topic.status = status;
    });
  }

  updateGatePassed(topicId: string, phase: CwAction, passed: boolean): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) {
        topic.gatePassed = { ...topic.gatePassed, [phase]: passed };
      }
    });
  }

  setEvidence(topicId: string, evidence: Evidence): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) {
        topic.coverage = evidence.coverage;
        topic.evidence = evidence;
      }
    });
  }

  // ── wave DAO ───────────────────────────────────────────────

  insertWaves(topicId: string, waves: WaveSeed[]): void {
    this.executeWrite(() => {
      for (const w of waves) {
        const record: WaveRecord = {
          topicId,
          id: w.id,
          dependsOn: w.dependsOn,
          parallelGroup: w.parallelGroup,
          committed: null,
          changes: w.changes ?? [],
          issues: w.issues ?? [],
        };
        this.fileData!.waves.push(record);
      }
    });
  }

  setWaveCommitted(topicId: string, waveId: string, commitHash: string): void {
    this.executeWrite(() => {
      const wave = this.fileData!.waves.find(
        (w) => w.topicId === topicId && w.id === waveId,
      );
      if (wave) wave.committed = commitHash;
    });
  }

  // ── test_case DAO ──────────────────────────────────────────

  insertTestCases(topicId: string, cases: TestCaseSeed[]): void {
    this.executeWrite(() => {
      for (const c of cases) {
        const record: TestCaseRecord = {
          topicId,
          id: c.id,
          layer: c.layer,
          scenario: c.scenario,
          steps: c.steps,
          expected: c.expected,
          assertion: c.assertion,
          executor: c.executor,
          status: "pending",
          requiresScreenshot: c.requiresScreenshot === true,
          dependsOn: c.dependsOn,
          parallelGroup: c.parallelGroup,
          file: c.file,
          describe: c.describe,
        };
        this.fileData!.testCases.push(record);
      }
    });
  }

  updateTestCase(topicId: string, caseId: string, patch: Partial<TestCase>): void {
    this.executeWrite(() => {
      const tc = this.fileData!.testCases.find(
        (c) => c.topicId === topicId && c.id === caseId,
      );
      if (!tc) return;

      if ("status" in patch) tc.status = patch.status as TestCase["status"];
      if ("actual" in patch) tc.actual = patch.actual;
      if ("screenshotPath" in patch) tc.screenshotPath = patch.screenshotPath;
      if ("commitHash" in patch) tc.commitHash = patch.commitHash;
      if ("judgedAt" in patch) tc.judgedAt = patch.judgedAt;
      if ("failureReason" in patch) tc.failureReason = patch.failureReason;
    });
  }

  // ── replan DAO（append-only replan） ───────────────────────

  replaceUncommittedWaves(topicId: string, waves: WaveSeed[]): void {
    this.executeWrite(() => {
      const data = this.fileData!;
      data.waves = data.waves.filter(
        (w) => w.topicId !== topicId || w.committed !== null,
      );
      for (const w of waves) {
        data.waves.push({
          topicId,
          id: w.id,
          dependsOn: w.dependsOn,
          parallelGroup: w.parallelGroup,
          committed: null,
          changes: w.changes ?? [],
          issues: w.issues ?? [],
        });
      }
    });
  }

  replaceUnpassedTestCases(topicId: string, cases: TestCaseSeed[]): void {
    this.executeWrite(() => {
      const data = this.fileData!;
      data.testCases = data.testCases.filter(
        (tc) => tc.topicId !== topicId || tc.status === "passed",
      );
      for (const c of cases) {
        data.testCases.push({
          topicId,
          id: c.id,
          layer: c.layer,
          scenario: c.scenario,
          steps: c.steps,
          expected: c.expected,
          assertion: c.assertion,
          executor: c.executor,
          status: "pending",
          requiresScreenshot: c.requiresScreenshot === true,
          dependsOn: c.dependsOn,
          parallelGroup: c.parallelGroup,
          file: c.file,
          describe: c.describe,
        });
      }
    });
  }

  // ── gate_history DAO ───────────────────────────────────────

  appendGateHistory(topicId: string, entry: GateHistorySeed): void {
    this.executeWrite(() => {
      const data = this.fileData!;
      const maxId = data.gateHistory.reduce((max, g) => Math.max(max, g.id), 0);
      const record: GateHistoryRecord = {
        id: maxId + 1,
        topicId,
        phase: entry.phase,
        action: entry.action,
        gate: entry.gate,
        tier: entry.tier,
        result: entry.result,
        ts: new Date().toISOString(),
        report: entry.report,
        progressive: entry.progressive,
      };
      data.gateHistory.push(record);
    });
  }

  loadGateHistory(topicId: string): GateHistoryEntry[] {
    const data = this.getActiveData();
    return data.gateHistory
      .filter((g) => g.topicId === topicId)
      .sort((a, b) => a.id - b.id)
      .map((g) => this.mapGateHistoryRecord(g));
  }

  // ── lifecycle ──────────────────────────────────────────────

  close(): void {
    // JSON 方案无持久连接。留空保持接口兼容。
    if (this.lockHeld) {
      this.releaseLock();
    }
  }
}
