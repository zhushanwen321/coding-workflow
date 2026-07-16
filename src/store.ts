/**
 * CwStore — JSON 文件持久化层（lite 单轨极简版）。
 *
 * 职责：
 *   - JSON 文件读写
 *   - 内存事务：transaction 回调在深拷贝副本上操作，正常→原子落盘，异常→丢弃（ROLLBACK）
 *   - 跨进程文件锁：lockfile + O_EXCL 原子创建
 *   - 4 集合 DAO（topic / wave / test_case / gate_history）
 *
 * 与旧版的差异（重构 = 推倒重建）：
 * - 砍掉 schemaVersion 迁移机制（lite 极简版不演进，字段固定）
 * - 砍掉 tier / planFormat / coverage 字段（lite-only 硬编码，coverage 移入 Evidence）
 * - 砍掉 mid 专属字段：WaveRecord.parallelGroup/issues、TestCaseRecord.assertion/
 *   commitHash/judgedAt/parallelGroup/file/describe、GateHistoryRecord.tier
 * - replan DAO 保留但字段精简（replaceUncommittedWaves/replaceUnpassedTestCases）
 *
 * 事务等价性（保留，未简化）：
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
  Action,
  AdrRecord,
  AdrSeed,
  Artifacts,
  Assessment,
  ClarifyKind,
  ClarifyOption,
  ClarifyRecord,
  ClarifySeed,
  Evidence,
  GateHistoryEntry,
  Priority,
  RetrospectData,
  ReviewDimension,
  ReviewIssue,
  ReviewIssueSubmission,
  RuntimeEnv,
  SpecSection,
  SpecVersion,
  Status,
  TestCase,
  TestCaseSeed,
  TestFixEntry,
  TestRunnerConfig,
  Topic,
  Wave,
  WaveChange,
  WaveSeed,
} from "./types.js";
import { CwError } from "./types.js";

const JSON_INDENT = 2;

// ── 旧格式 changes 迁移 ─────────────────────────────────────

/**
 * 旧格式 changes 路径提取正则——从自然语言描述中尽力提取文件路径。
 * 匹配常见模式："动词 src/path.ts"、"src/path.ts: 描述"、"src/path.ts 描述"。
 * 仅用于旧 _cw.json 读时迁移，新格式（WaveChange[]）不需要此函数。
 */
const LEGACY_PATH_RE =
  /(?:修改|创建|删除|更新|新增|重构|add|modify|create|delete|update|refactor)\s+([\w./-]+(?:\.\w+))|([\w./-]+(?:\.\w+))\s*[:：]/;

/**
 * migrateChanges — 旧格式 changes（string[]）迁移为 WaveChange[]。
 *
 * 新格式（{file, description}[]）原样返回。
 * 旧格式（string[]）每条转成 {file: 尽量提取的路径, description: 原文本}。
 * 提取不出路径时 file 为空字符串（不阻断，复杂度分桶会忽略空 file）。
 */
function migrateChanges(
  changes: WaveChange[] | string[] | undefined,
): WaveChange[] {
  if (!changes || changes.length === 0) return [];
  // 新格式：元素是对象（有 file 字段）
  if (typeof changes[0] === "object") {
    return changes as WaveChange[];
  }
  // 旧格式：元素是 string
  return (changes as unknown as string[]).map((s) => {
    LEGACY_PATH_RE.lastIndex = 0;
    const m = s.match(LEGACY_PATH_RE);
    const file = m?.[1] ?? m?.[2] ?? "";
    return { file, description: s };
  });
}

// ── appendGateHistory 入参（seed，无 id/ts，由 store 填充） ────

/**
 * gate 历史条目 seed。id/ts 由 store.appendGateHistory 自动填充。
 * 砍掉旧版的 tier 字段（GateTier 整个砍掉）。
 */
export interface GateHistorySeed {
  phase: Action;
  action: Action;
  gate: string;
  result: "pass" | "fail";
  report?: string;
  progressive: boolean;
}

// ── JSON 文件结构（4 集合，对应原 4 表） ──────────────────────

interface TopicRecord {
  topicId: string;
  slug: string;
  objective: string;
  workspacePath: string;
  topicDir: string;
  createdAt: string;
  status: Status;
  runtimeEnv?: RuntimeEnv;
  gatePassed: Partial<Record<Action, boolean>>;
  evidence?: Evidence;
  artifacts?: Artifacts;
  retrospectData?: RetrospectData;
  testRunner?: TestRunnerConfig;
  /** review 闭环追踪（可选，向后兼容旧 _cw.json 数据）。 */
  reviewIssues?: ReviewIssue[];
  reviewTurn?: number;
  /** FR-4: spec_review 闭环追踪（可选，向后兼容旧 _cw.json 数据）。 */
  specReviewIssues?: ReviewIssue[];
  specReviewTurn?: number;
  /** FR-5: plan_review 闭环追踪（可选，向后兼容旧 _cw.json 数据）。 */
  planReviewIssues?: ReviewIssue[];
  planReviewTurn?: number;
  /** test 修复审计日志（可选，向后兼容旧 _cw.json 数据）。 */
  testFixLog?: TestFixEntry[];
  testTurn?: number;
  /** post-closeout 评估记录（可选，向后兼容旧 _cw.json 数据）。 */
  assessments?: Assessment[];
  /** clarify 阶段产出的结构化 spec 章节（可选，向后兼容旧 _cw.json 数据）。 */
  specSections?: SpecSection[];
  /** spec 替换时的历史版本快照（可选，向后兼容旧 _cw.json 数据）。 */
  specHistory?: SpecVersion[];
}

interface WaveRecord {
  topicId: string;
  id: string;
  dependsOn: string[];
  committed: string | null;
  changes: WaveChange[];
  priority?: Priority;
  changedFiles?: string[];
}

interface TestCaseRecord {
  topicId: string;
  id: string;
  layer: TestCase["layer"];
  scenario: string;
  steps: string;
  expected: { url?: string; text?: string };
  executor: string;
  status: TestCase["status"];
  actual?: object;
  screenshotPath?: string;
  failureReason?: string;
  requiresScreenshot: boolean;
  dependsOn: string[];
  priority?: Priority;
  redCheck?: boolean;
}

interface GateHistoryRecord {
  id: number;
  topicId: string;
  phase: Action;
  action: Action;
  gate: string;
  result: "pass" | "fail";
  ts: string;
  report?: string;
  progressive: boolean;
}

interface ClarifyStoreRecord {
  topicId: string;
  id: string;
  kind: ClarifyKind;
  topic: string;
  assessment: string;
  question: string;
  options?: ClarifyOption[];
  recommendation?: string;
  presentationPath?: string;
  answer?: string;
  status: "pending" | "resolved" | "skipped";
  resolvedAt?: string;
  adrId?: string;
  createdAt: string;
}

interface AdrStoreRecord {
  topicId: string;
  id: string;
  title: string;
  status: "proposed" | "accepted";
  context: string;
  decision: string;
  alternatives: string[];
  consequences: string;
  clarifyId?: string;
  projectPath?: string;
  createdAt: string;
}

interface CwJsonFile {
  topics: TopicRecord[];
  waves: WaveRecord[];
  testCases: TestCaseRecord[];
  gateHistory: GateHistoryRecord[];
  clarifyRecords: ClarifyStoreRecord[];
  adrs: AdrStoreRecord[];
}

// ── 常量 ─────────────────────────────────────────────────────

const LOCK_MAX_RETRIES = 50;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_STALE_TIMEOUT_MS = 30_000;
const INT32_BYTES = 4;
/** ADR ID 最小宽度（padStart 补零，如 "0001"）。 */
const ADR_ID_WIDTH = 4;

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
   *
   * 砍掉旧版的 schemaVersion 迁移——lite 极简版字段固定，不演进。
   * 缺字段时按默认值兜底（数组不存在则 []），保证健壮性而非版本演进。
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
    if (!Array.isArray(data.topics)) data.topics = [];
    if (!Array.isArray(data.waves)) data.waves = [];
    if (!Array.isArray(data.testCases)) data.testCases = [];
    if (!Array.isArray(data.gateHistory)) data.gateHistory = [];
    if (!Array.isArray(data.clarifyRecords)) data.clarifyRecords = [];
    if (!Array.isArray(data.adrs)) data.adrs = [];
    return data;
  }

  private emptyFile(): CwJsonFile {
    return {
      topics: [],
      waves: [],
      testCases: [],
      gateHistory: [],
      clarifyRecords: [],
      adrs: [],
    };
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

    // fsync 父目录：保证 rename 的目录条目变更也落盘（POSIX 持久性要求）。
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
      // 锁文件可能已被 stale 检测清理，忽略。
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
      // signal 0 = 不发信号，只检查进程是否存在且有权限 signal。
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
    // Atomics.wait 是 Node 同步 sleep 的标准方式（不阻塞事件循环外的占位）。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, ms);
  }

  // ── 事务 ───────────────────────────────────────────────────

  /**
   * 事务包裹：fn 在内存深拷贝副本上操作，正常→原子落盘，异常→丢弃副本（ROLLBACK）。
   *
   * 不变式：fn 抛异常时，磁盘状态与事务开始前完全一致（fileData 恢复为 snapshot，
   * 不调用 flushToDisk）。这是 replan append-only 校验失败时 throw 能安全回滚的基础。
   *
   * 嵌套事务（事务内再调 transaction）：直接在当前副本上执行 fn，不重复加锁/落盘，
   * 由最外层事务统一 flush。保证同事务内多 DAO 操作的原子性。
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
      // ROLLBACK：丢弃内存副本，恢复为磁盘状态。
      // 不 flushToDisk——磁盘上仍是事务前的 snapshot（未被覆盖）。
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
  private getActiveData(): CwJsonFile {
    if (this.inTransaction && this.fileData) {
      return this.fileData;
    }
    return this.loadFileData();
  }

  /**
   * 写操作包裹：若已在事务内则直接执行，否则自动开一个事务。
   * DAO 方法用此包裹，保证单独调用 DAO 也有事务语义。
   */
  private executeWrite(fn: () => void): void {
    if (this.inTransaction && this.fileData) {
      fn();
      return;
    }
    this.transaction(fn);
  }

  // ── topic DAO ──────────────────────────────────────────────

  insertTopic(topic: Topic): void {
    this.executeWrite(() => {
      const exists = this.fileData!.topics.some(
        (t) => t.topicId === topic.topicId,
      );
      if (exists) {
        throw new CwError(
          `UNIQUE constraint failed: topic.topicId '${topic.topicId}'`,
        );
      }
      const record: TopicRecord = {
        topicId: topic.topicId,
        slug: topic.slug,
        objective: topic.objective,
        workspacePath: topic.workspacePath,
        topicDir: topic.topicDir,
        createdAt: topic.createdAt,
        status: topic.status,
        runtimeEnv: topic.runtimeEnv,
        gatePassed: topic.gatePassed,
        evidence: topic.evidence,
        artifacts: topic.artifacts,
        retrospectData: topic.retrospectData,
        testRunner: topic.testRunner,
        reviewIssues: topic.reviewIssues,
        reviewTurn: topic.reviewTurn,
        specReviewIssues: topic.specReviewIssues,
        specReviewTurn: topic.specReviewTurn,
        planReviewIssues: topic.planReviewIssues,
        planReviewTurn: topic.planReviewTurn,
        testFixLog: topic.testFixLog,
        testTurn: topic.testTurn,
        assessments: topic.assessments,
        specSections: topic.specSections,
        specHistory: topic.specHistory,
      };
      this.fileData!.topics.push(record);
    });
  }

  loadTopic(topicId: string): Topic | null {
    const data = this.getActiveData();
    const record = data.topics.find((t) => t.topicId === topicId);
    if (!record) return null;
    const topic = this.assembleTopicFromData(record, topicId, data);
    // [HISTORICAL] FR-1: Artifacts 旧格式迁移（平铺 → 嵌套）。
    if (topic.artifacts) {
      topic.artifacts = this.migrateArtifacts(
        topic.artifacts as unknown as Record<string, unknown>,
      );
    }
    // [HISTORICAL] FR-3: ReviewIssue 旧数据迁移 category→dimension, file→ref。
    if (topic.reviewIssues) {
      for (const issue of topic.reviewIssues) {
        const raw = issue as unknown as Record<string, unknown>;
        if ("category" in raw && !("dimension" in raw)) {
          (issue as { dimension: ReviewDimension }).dimension =
            raw.category as ReviewDimension;
        }
        if ("file" in raw && !("ref" in raw)) {
          (issue as { ref: string }).ref = raw.file as string;
        }
      }
    }
    return topic;
  }

  /**
   * 列出所有 topic（含进度摘要）。CLI status/list 用。
   * 纯读查询，不经过 dispatch，不触发状态变更。
   */
  listTopics(): Topic[] {
    const data = this.getActiveData();
    return data.topics.map((record) =>
      this.assembleTopicFromData(record, record.topicId, data),
    );
  }

  /**
   * 从 CwJsonFile 的各集合按 topicId 过滤 + 组装 Topic。
   * loadTopic / listTopics 共用，避免两处重复过滤逻辑。
   */
  private assembleTopicFromData(
    record: TopicRecord,
    topicId: string,
    data: CwJsonFile,
  ): Topic {
    const waves = data.waves.filter((w) => w.topicId === topicId);
    const testCases = data.testCases.filter((tc) => tc.topicId === topicId);
    const gateHistory = data.gateHistory
      .filter((g) => g.topicId === topicId)
      .sort((a, b) => a.id - b.id);
    const clarifyRecords = data.clarifyRecords.filter(
      (c) => c.topicId === topicId,
    );
    const adrs = data.adrs.filter((a) => a.topicId === topicId);
    return this.assembleTopic(
      record,
      waves,
      testCases,
      gateHistory,
      clarifyRecords,
      adrs,
    );
  }

  /**
   * [HISTORICAL] Artifacts 旧格式迁移：平铺 → 嵌套。
   *
   * FR-1 重构后 Artifacts 从 { reviewPath, reviewAt, retrospectPath, retrospectAt }
   * 改为 { review: {path, at}, retrospect: {path, at} }。
   * 旧 _cw.json 加载时检测平铺字段并迁移。一次性迁移，迁移后写回时已是新格式。
   *
   * 检测逻辑：artifacts 对象上有 reviewPath/reviewAt/retrospectPath/retrospectAt 任一字段
   * → 旧格式。迁移为嵌套后删除平铺字段。
   */
  private migrateArtifacts(
    artifacts: Record<string, unknown> | undefined,
  ): Artifacts | undefined {
    if (!artifacts) return undefined;
    // 已经是新格式（有 review/retrospect/confirmSpec 对象字段）→ 不迁移
    if (
      "review" in artifacts ||
      "retrospect" in artifacts ||
      "confirmSpec" in artifacts
    ) {
      return artifacts as Artifacts;
    }
    // 旧格式：检测平铺字段
    const migrated: Artifacts = {};
    const a = artifacts as Record<string, unknown>;
    if (a.reviewPath || a.reviewAt) {
      migrated.review = {
        path: String(a.reviewPath ?? ""),
        at: String(a.reviewAt ?? ""),
      };
    }
    if (a.retrospectPath || a.retrospectAt) {
      migrated.retrospect = {
        path: String(a.retrospectPath ?? ""),
        at: String(a.retrospectAt ?? ""),
      };
    }
    return Object.keys(migrated).length > 0 ? migrated : undefined;
  }

  private assembleTopic(
    topic: TopicRecord,
    waves: WaveRecord[],
    testCases: TestCaseRecord[],
    gateHistory: GateHistoryRecord[],
    clarifyRecords: ClarifyStoreRecord[],
    adrs: AdrStoreRecord[],
  ): Topic {
    return {
      topicId: topic.topicId,
      slug: topic.slug,
      objective: topic.objective,
      workspacePath: topic.workspacePath,
      topicDir: topic.topicDir ?? "",
      createdAt: topic.createdAt,
      status: topic.status,
      runtimeEnv: topic.runtimeEnv,
      waves: waves.map((w) => this.mapWaveRecord(w)),
      testCases: testCases.map((tc) => this.mapTestCaseRecord(tc)),
      gateHistory: gateHistory.map((g) => this.mapGateHistoryRecord(g)),
      gatePassed: topic.gatePassed ?? {},
      evidence: topic.evidence,
      artifacts: topic.artifacts,
      retrospectData: topic.retrospectData,
      testRunner: topic.testRunner,
      clarifyRecords: clarifyRecords.map((c) => this.mapClarifyRecord(c)),
      adrs: adrs.map((a) => this.mapAdrRecord(a)),
      reviewIssues: topic.reviewIssues ?? [],
      reviewTurn: topic.reviewTurn ?? 0,
      specReviewIssues: topic.specReviewIssues ?? [],
      specReviewTurn: topic.specReviewTurn ?? 0,
      planReviewIssues: topic.planReviewIssues ?? [],
      planReviewTurn: topic.planReviewTurn ?? 0,
      testFixLog: topic.testFixLog ?? [],
      testTurn: topic.testTurn ?? 0,
      assessments: topic.assessments ?? [],
      specSections: topic.specSections ?? [],
      specHistory: topic.specHistory ?? [],
    };
  }

  private mapWaveRecord(r: WaveRecord): Wave {
    return {
      id: r.id,
      dependsOn: r.dependsOn ?? [],
      committed: r.committed ?? null,
      changes: migrateChanges(r.changes),
      priority: r.priority,
      changedFiles: r.changedFiles,
    };
  }

  private mapTestCaseRecord(r: TestCaseRecord): TestCase {
    return {
      id: r.id,
      layer: r.layer,
      scenario: r.scenario,
      steps: r.steps,
      expected: r.expected,
      executor: r.executor,
      status: r.status,
      actual: r.actual,
      screenshotPath: r.screenshotPath,
      failureReason: r.failureReason,
      requiresScreenshot: r.requiresScreenshot === true,
      dependsOn: r.dependsOn ?? [],
      priority: r.priority,
      redCheck: r.redCheck,
    };
  }

  /** WaveSeed → WaveRecord（初始 committed=null）。insertWaves/replaceUncommittedWaves 共用。 */
  private waveSeedToRecord(topicId: string, w: WaveSeed): WaveRecord {
    return {
      topicId,
      id: w.id,
      dependsOn: w.dependsOn,
      committed: null,
      changes: w.changes ?? [],
      priority: w.priority,
    };
  }

  /** TestCaseSeed → TestCaseRecord（初始 status=pending）。insertTestCases/replaceUnpassedTestCases 共用。 */
  private testCaseSeedToRecord(topicId: string, c: TestCaseSeed): TestCaseRecord {
    return {
      topicId,
      id: c.id,
      layer: c.layer,
      scenario: c.scenario,
      steps: c.steps,
      expected: c.expected,
      executor: c.executor,
      status: "pending",
      requiresScreenshot: c.requiresScreenshot === true,
      dependsOn: c.dependsOn ?? [],
      priority: c.priority,
      redCheck: c.redCheck,
    };
  }

  private mapGateHistoryRecord(r: GateHistoryRecord): GateHistoryEntry {
    return {
      id: r.id,
      phase: r.phase,
      action: r.action,
      gate: r.gate,
      result: r.result,
      ts: r.ts,
      report: r.report,
      progressive: r.progressive,
    };
  }

  private mapClarifyRecord(r: ClarifyStoreRecord): ClarifyRecord {
    return {
      id: r.id,
      kind: r.kind,
      topic: r.topic,
      assessment: r.assessment,
      question: r.question,
      options: r.options,
      recommendation: r.recommendation,
      presentationPath: r.presentationPath,
      answer: r.answer,
      status: r.status,
      resolvedAt: r.resolvedAt,
      adrId: r.adrId,
      createdAt: r.createdAt,
    };
  }

  private mapAdrRecord(r: AdrStoreRecord): AdrRecord {
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      context: r.context,
      decision: r.decision,
      alternatives: r.alternatives ?? [],
      consequences: r.consequences,
      clarifyId: r.clarifyId,
      projectPath: r.projectPath,
      createdAt: r.createdAt,
    };
  }

  updateStatus(topicId: string, status: Status): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) topic.status = status;
    });
  }

  updateObjective(topicId: string, objective: string): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      topic.objective = objective;
    });
  }

  updateGatePassed(topicId: string, phase: Action, passed: boolean): void {
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
        topic.evidence = evidence;
      }
    });
  }

  /**
   * 更新 topic 的交付物文档记录（review.md / retrospect.md 路径 + 时间戳）。
   * merge 语义：只更新传入的字段，不覆盖已有字段。
   */
  setArtifacts(topicId: string, patch: Partial<Artifacts>): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) {
        topic.artifacts = { ...topic.artifacts, ...patch };
      }
    });
  }

  /**
   * 写入 retrospect 阶段的结构化数据（retrospectData）。
   * 整体覆盖语义（与 setEvidence 同模式）：retrospectData 是单一结构化对象，整体替换。
   */
  setRetrospectData(topicId: string, data: RetrospectData): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) {
        topic.retrospectData = data;
      }
    });
  }

  /**
   * 写入 topic 的测试执行器配置（testRunner）。
   * tdd_plan 阶段从 test.json 解析后调用，供 test 阶段的 runTestRunner / 红灯校验复用。
   * 整体覆盖语义（与 setArtifacts 的 merge 不同）：testRunner 是单一配置对象，整体替换。
   */
  setTestRunner(topicId: string, config: TestRunnerConfig): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) {
        topic.testRunner = config;
      }
    });
  }

  // ── review / test issue tracking DAO（闭环追踪） ──────────

  /**
   * 追加 review issues（新 turn 发现的，status=open）。
   * id（R1, R2...）在 topic 内按现有 reviewIssues 数量自增分配。
   * foundAtTurn 由调用方传入（对应当前 reviewTurn）。
   */
  appendReviewIssues(
    topicId: string,
    turn: number,
    issues: ReviewIssueSubmission[],
  ): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      const existing = topic.reviewIssues ?? [];
      let nextN = existing.length + 1;
      for (const issue of issues) {
        const record: ReviewIssue = {
          id: `R${nextN}`,
          dimension: issue.dimension,
          severity: issue.severity,
          description: issue.description,
          status: "open",
          foundAtTurn: turn,
          ...(issue.ref ? { ref: issue.ref } : {}),
        };
        existing.push(record);
        nextN++;
      }
      topic.reviewIssues = existing;
    });
  }

  /**
   * 标记 review issue 为 fixed（附修复证据：commitHash + resolution + fixedAtTurn）。
   * issue 不存在时静默忽略（与 updateClarifyRecord 的 find-or-skip 同模式）。
   */
  fixReviewIssue(
    topicId: string,
    issueId: string,
    fix: { commitHash?: string; resolution: string; fixedAtTurn: number },
  ): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic || !topic.reviewIssues) return;
      const issue = topic.reviewIssues.find((i) => i.id === issueId);
      if (!issue) return;
      issue.status = "fixed";
      issue.fix = {
        resolution: fix.resolution,
        fixedAtTurn: fix.fixedAtTurn,
        ...(fix.commitHash ? { commitHash: fix.commitHash } : {}),
      };
    });
  }

  /**
   * 追加 test fix 审计日志条目（每次 test_fix 调用一条）。
   * 与 testCase.status 互补：status 反映当前态，testFixLog 是完整修复轨迹。
   */
  appendTestFix(topicId: string, entry: TestFixEntry): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      const log = topic.testFixLog ?? [];
      log.push(entry);
      topic.testFixLog = log;
    });
  }

  /** review turn 计数器 +1（每次开启新一轮 review 时调用）。 */
  incReviewTurn(topicId: string): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      topic.reviewTurn = (topic.reviewTurn ?? 0) + 1;
    });
  }

  // ── spec_review issue DAO（FR-4，与 review issue DAO 1:1 同构，SR 前缀） ──

  /**
   * 追加 spec_review issue 列表（FR-4 spec_review 阶段 progressive）。
   * id（SR1, SR2...）在 topic 内按现有 specReviewIssues 数量自增分配。
   * foundAtTurn 由调用方传入（对应当前 specReviewTurn）。
   */
  appendSpecReviewIssues(
    topicId: string,
    turn: number,
    issues: ReviewIssueSubmission[],
  ): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      const existing = topic.specReviewIssues ?? [];
      let nextN = existing.length + 1;
      for (const issue of issues) {
        const record: ReviewIssue = {
          id: `SR${nextN}`,
          dimension: issue.dimension,
          severity: issue.severity,
          description: issue.description,
          status: "open",
          foundAtTurn: turn,
          ...(issue.ref ? { ref: issue.ref } : {}),
        };
        existing.push(record);
        nextN++;
      }
      topic.specReviewIssues = existing;
    });
  }

  /**
   * 标记 spec_review issue 为 fixed（FR-4 spec_review_fix）。
   * issue 不存在时静默忽略。commitHash 可选（spec 修复可能走 cw 内部无独立 commit）。
   */
  fixSpecReviewIssue(
    topicId: string,
    issueId: string,
    fix: { commitHash?: string; resolution: string; fixedAtTurn: number },
  ): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic || !topic.specReviewIssues) return;
      const issue = topic.specReviewIssues.find((i) => i.id === issueId);
      if (!issue) return;
      issue.status = "fixed";
      issue.fix = {
        resolution: fix.resolution,
        fixedAtTurn: fix.fixedAtTurn,
        ...(fix.commitHash ? { commitHash: fix.commitHash } : {}),
      };
    });
  }

  /** spec_review turn 计数器 +1（每次开启新一轮 spec_review 时调用）。 */
  incSpecReviewTurn(topicId: string): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      topic.specReviewTurn = (topic.specReviewTurn ?? 0) + 1;
    });
  }

  // ── plan_review issue DAO（FR-5，与 review issue DAO 1:1 同构，PR 前缀） ──

  /**
   * 追加 plan_review issue 列表（FR-5 plan_review 阶段 progressive）。
   * id（PR1, PR2...）在 topic 内按现有 planReviewIssues 数量自增分配。
   * foundAtTurn 由调用方传入（对应当前 planReviewTurn）。
   */
  appendPlanReviewIssues(
    topicId: string,
    turn: number,
    issues: ReviewIssueSubmission[],
  ): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      const existing = topic.planReviewIssues ?? [];
      let nextN = existing.length + 1;
      for (const issue of issues) {
        const record: ReviewIssue = {
          id: `PR${nextN}`,
          dimension: issue.dimension,
          severity: issue.severity,
          description: issue.description,
          status: "open",
          foundAtTurn: turn,
          ...(issue.ref ? { ref: issue.ref } : {}),
        };
        existing.push(record);
        nextN++;
      }
      topic.planReviewIssues = existing;
    });
  }

  /**
   * 标记 plan_review issue 为 fixed（FR-5 plan_review_fix）。
   * issue 不存在时静默忽略。commitHash 可选（plan 修复可能走 cw 内部无独立 commit）。
   */
  fixPlanReviewIssue(
    topicId: string,
    issueId: string,
    fix: { commitHash?: string; resolution: string; fixedAtTurn: number },
  ): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic || !topic.planReviewIssues) return;
      const issue = topic.planReviewIssues.find((i) => i.id === issueId);
      if (!issue) return;
      issue.status = "fixed";
      issue.fix = {
        resolution: fix.resolution,
        fixedAtTurn: fix.fixedAtTurn,
        ...(fix.commitHash ? { commitHash: fix.commitHash } : {}),
      };
    });
  }

  /** plan_review turn 计数器 +1（每次开启新一轮 plan_review 时调用）。 */
  incPlanReviewTurn(topicId: string): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      topic.planReviewTurn = (topic.planReviewTurn ?? 0) + 1;
    });
  }

  /** test turn 计数器 +1（每次开启新一轮 test 时调用）。 */
  incTestTurn(topicId: string): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      topic.testTurn = (topic.testTurn ?? 0) + 1;
    });
  }

  /**
   * replan 时重置 review loop：reviewIssues=[], reviewTurn=0。
   * replan 修改 plan/testCases 后，旧 review 闭环数据失效，需清空重走。
   */
  resetReviewLoop(topicId: string): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      topic.reviewIssues = [];
      topic.reviewTurn = 0;
    });
  }

  /**
   * replan 时重置 test loop：testFixLog=[], testTurn=0。
   * replan 修改 testCases 后，旧 test 修复轨迹失效，需清空重走。
   */
  resetTestLoop(topicId: string): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      topic.testFixLog = [];
      topic.testTurn = 0;
    });
  }

  // ── assessment DAO（post-closeout 评估，progressive） ─────

  /**
   * 追加一条 post-closeout 评估记录。
   * id（AS1, AS2...）在 topic 内按现有 assessments 数量自增分配。
   * assessedAt 自动填充 new Date().toISOString()。
   * 返回分配的 id，供 handler 回显给调用方。
   *
   * 不改变 topic.status（progressive，始终 closed）。
   */
  appendAssessment(
    topicId: string,
    params: Omit<Assessment, "id" | "assessedAt">,
  ): string {
    let assignedId = "";
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      const existing = topic.assessments ?? [];
      const nextN = existing.length + 1;
      assignedId = `AS${nextN}`;
      const record: Assessment = {
        id: assignedId,
        assessedAt: new Date().toISOString(),
        type: params.type,
        score: params.score,
        notes: params.notes,
        defect: params.defect,
      };
      existing.push(record);
      topic.assessments = existing;
    });
    return assignedId;
  }

  // ── wave DAO ───────────────────────────────────────────────

  insertWaves(topicId: string, waves: WaveSeed[]): void {
    this.executeWrite(() => {
      for (const w of waves) {
        this.fileData!.waves.push(this.waveSeedToRecord(topicId, w));
      }
    });
  }

  setWaveCommitted(
    topicId: string,
    waveId: string,
    commitHash: string,
    changedFiles?: string[],
  ): void {
    this.executeWrite(() => {
      const wave = this.fileData!.waves.find(
        (w) => w.topicId === topicId && w.id === waveId,
      );
      if (wave) {
        wave.committed = commitHash;
        if (changedFiles) wave.changedFiles = changedFiles;
      }
    });
  }

  // ── test_case DAO ──────────────────────────────────────────

  insertTestCases(topicId: string, cases: TestCaseSeed[]): void {
    this.executeWrite(() => {
      // upsert 语义：已 passed 的 testCase 保留不动（append-only 保护）；
      // failed/pending 的重置为 pending（清空 actual/failureReason）——重走 tdd_plan 意味着重新开始 TDD 循环。
      // 之前按 id 去重直接跳过会导致旧 failed case 卡死，replan 后重走 tdd_plan 无法重置。
      const existing = this.fileData!.testCases.filter(
        (tc) => tc.topicId === topicId,
      );
      const existingMap = new Map(existing.map((tc) => [tc.id, tc]));
      for (const c of cases) {
        const old = existingMap.get(c.id);
        if (!old) {
          // 新 case：插入。
          this.fileData!.testCases.push(this.testCaseSeedToRecord(topicId, c));
        } else if (old.status !== "passed") {
          // 已存在但非 passed：重置为 pending，清空运行时字段。
          old.status = "pending";
          old.actual = undefined;
          old.screenshotPath = undefined;
          old.failureReason = undefined;
        }
        // passed 的保留不动。
      }
    });
  }

  updateTestCase(
    topicId: string,
    caseId: string,
    patch: Partial<TestCase>,
  ): void {
    this.executeWrite(() => {
      const tc = this.fileData!.testCases.find(
        (c) => c.topicId === topicId && c.id === caseId,
      );
      if (!tc) return;

      if ("status" in patch) tc.status = patch.status as TestCase["status"];
      if ("actual" in patch) tc.actual = patch.actual;
      if ("screenshotPath" in patch) tc.screenshotPath = patch.screenshotPath;
      if ("failureReason" in patch) tc.failureReason = patch.failureReason;
    });
  }

  // ── replan DAO（append-only replan） ───────────────────────

  /**
   * 替换所有未 committed 的 wave（保留已 committed 的）。
   * replan handler 调用：dev 阶段追加新 wave，旧已 committed wave 不动。
   */
  replaceUncommittedWaves(topicId: string, waves: WaveSeed[]): void {
    this.executeWrite(() => {
      const data = this.fileData!;
      data.waves = data.waves.filter(
        (w) => w.topicId !== topicId || w.committed !== null,
      );
      for (const w of waves) {
        data.waves.push(this.waveSeedToRecord(topicId, w));
      }
    });
  }

  /**
   * 替换所有未 passed 的 testCase（保留已 passed 的）。
   * replan handler 调用：追加新 testCase，旧已 passed testCase 不动。
   */
  replaceUnpassedTestCases(topicId: string, cases: TestCaseSeed[]): void {
    this.executeWrite(() => {
      const data = this.fileData!;
      data.testCases = data.testCases.filter(
        (tc) => tc.topicId !== topicId || tc.status === "passed",
      );
      for (const c of cases) {
        data.testCases.push(this.testCaseSeedToRecord(topicId, c));
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

  // ── clarify + adr DAO（progressive，create→plan 之间） ─────

  /**
   * 追加一条 clarify 记录。id 由 cw 在 topic 内自增分配（CL1, CL2...）。
   * 返回分配的 id，供 handler 回填 adrId 关联。
   */
  appendClarifyRecord(topicId: string, seed: ClarifySeed): string {
    let assignedId = "";
    this.executeWrite(() => {
      const data = this.fileData!;
      const existing = data.clarifyRecords.filter(
        (c) => c.topicId === topicId,
      );
      const nextN = existing.length + 1;
      assignedId = `CL${nextN}`;
      const now = new Date().toISOString();
      const status = seed.answer ? "resolved" : "pending";
      const record: ClarifyStoreRecord = {
        topicId,
        id: assignedId,
        kind: seed.kind,
        topic: seed.topic,
        assessment: seed.assessment,
        question: seed.question,
        options: seed.options,
        recommendation: seed.recommendation,
        presentationPath: seed.presentationPath,
        answer: seed.answer,
        status,
        resolvedAt: seed.answer ? now : undefined,
        createdAt: now,
      };
      data.clarifyRecords.push(record);
    });
    return assignedId;
  }

  /**
   * 追加 spec 章节（progressive，与 clarifyRecords 独立）。
   * 参考 appendClarifyRecord 的 append-only 模式：旧 specSections 保留，新章节往后拼。
   */
  appendSpecSections(topicId: string, sections: SpecSection[]): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      const existing = topic.specSections ?? [];
      topic.specSections = [...existing, ...sections];
    });
  }

  /**
   * FR-2: 替换 spec 章节（spec 可修改）。
   *
   * 把当前 specSections 整体快照归档到 specHistory（version 自增），
   * 然后替换 specSections 为新内容。spec 是规划产物（非执行产物），允许修改。
   */
  replaceSpecSections(topicId: string, sections: SpecSection[], reason: string): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (!topic) return;
      const currentSections = topic.specSections ?? [];
      const history = topic.specHistory ?? [];
      const version = history.length + 1;
      const snapshot: SpecVersion = {
        version,
        archivedAt: new Date().toISOString(),
        sections: currentSections,
        reason,
      };
      topic.specHistory = [...history, snapshot];
      topic.specSections = sections;
    });
  }

  /**
   * 追加一条 ADR 记录。id 由 cw 在 topic 内自增分配（0001, 0002...，padStart 4）。
   * 返回分配的 id，供 handler 回填 clarifyRecord.adrId 关联。
   */
  appendAdr(topicId: string, seed: AdrSeed): string {
    let assignedId = "";
    this.executeWrite(() => {
      const data = this.fileData!;
      const existing = data.adrs.filter((a) => a.topicId === topicId);
      const nextN = existing.length + 1;
      assignedId = String(nextN).padStart(ADR_ID_WIDTH, "0");
      const record: AdrStoreRecord = {
        topicId,
        id: assignedId,
        title: seed.title,
        status: seed.status ?? "accepted",
        context: seed.context,
        decision: seed.decision,
        alternatives: seed.alternatives ?? [],
        consequences: seed.consequences,
        clarifyId: undefined,
        projectPath: seed.projectPath,
        createdAt: new Date().toISOString(),
      };
      data.adrs.push(record);
    });
    return assignedId;
  }

  /**
   * 按 topicId + recordId patch clarify 记录的可变字段。
   * 参考 updateTestCase 的逐字段 in 检查模式。
   */
  updateClarifyRecord(
    topicId: string,
    recordId: string,
    patch: Partial<Pick<ClarifyRecord, "answer" | "status" | "resolvedAt" | "adrId">>,
  ): void {
    this.executeWrite(() => {
      const rec = this.fileData!.clarifyRecords.find(
        (c) => c.topicId === topicId && c.id === recordId,
      );
      if (!rec) return;
      if ("answer" in patch) rec.answer = patch.answer;
      if ("status" in patch) rec.status = patch.status as ClarifyRecord["status"];
      if ("resolvedAt" in patch) rec.resolvedAt = patch.resolvedAt;
      if ("adrId" in patch) rec.adrId = patch.adrId;
    });
  }

  // ── lifecycle ──────────────────────────────────────────────

  close(): void {
    // JSON 方案无持久连接。释放可能持有的锁。
    if (this.lockHeld) {
      this.releaseLock();
    }
  }
}
