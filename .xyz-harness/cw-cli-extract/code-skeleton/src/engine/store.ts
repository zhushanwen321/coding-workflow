/**
 * CwStore — JSON 文件持久化层（骨架 stub）。
 *
 * 职责：JSON 文件读写 + 内存事务 + 跨进程文件锁 + 4 集合 DAO。
 * 接口不变式：全部 public 方法签名与 pi 扩展一致，上层零改动。
 *
 * Level 1 接线：constructor 初始化 dbPath/lockPath + mkdirSync。
 * 公开方法签名完整，方法体 throw NotImplementedError（叶子逻辑：序列化/锁/迁移留 Wave 实现）。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  CwTopic,
  GateHistorySeed,
  TestCase,
  TestCaseSeed,
  WaveSeed,
} from "./types.js";

// ── schema 版本 ─────────────────────────────────────────────

export const SCHEMA_VERSION = 4;

// ── CwStore ──────────────────────────────────────────────────

export class CwStore {

  /** 持久化文件路径（构造时设置，供 validateDbPath 等方法使用）。 */
  private readonly _dbPath: string;

  constructor(dbPath: string) {
    // 接线：初始化路径 + 自动创建父目录 + 路径安全性校验。
    this._dbPath = dbPath; void this._dbPath; // 抑制未使用警告，Wave 实现时读取
    this.validateDbPath(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  /** 校验 dbPath 安全性（绝对路径、禁 ..、禁 .cw-wt/ 内）。Wave 落地时填。 */
  validateDbPath(_dbPath: string): void {
    // 接线：resolve() → 检查绝对 → 检查 ".." 段 → 检查 .cw-wt/ 嵌套。
    // 对应 T7.4（CW_HOME 路径穿越）+ T7.5（.cw-wt/ 检测）。
    throw new Error("NotImplementedError: validateDbPath — resolve + 绝对路径校验 + .cw-wt/ 检测");
  }

  // ── 公开查询方法 ────────────────────────────────────────────

  /** 按 topicId 加载 topic（含 waves/testCases/gateHistory 拼装）。 */
  loadTopic(_topicId: string): CwTopic | null {
    // 叶子逻辑：读 JSON → filter by topicId → 拼装 CwTopic。
    // 接线：readFileSync(this.dbPath) → JSON.parse → filter topics/waves/testCases/gateHistory。
    throw new Error("NotImplementedError: loadTopic — JSON 读取 + 拼装逻辑");
  }

  /** 列出所有 topic（含进度摘要）。 */
  listTopics(): CwTopic[] {
    // 叶子逻辑：读 JSON → map topics → 拼装。
    throw new Error("NotImplementedError: listTopics");
  }

  // ── 公开写入方法 ────────────────────────────────────────────

  /** 插入新 topic（PRIMARY KEY 冲突时 throw）。 */
  insertTopic(_topic: CwTopic): void {
    // 叶子逻辑：读 JSON → check duplicate → push → 原子写。
    // 失败路径：slug 重复 → throw Error("PRIMARY KEY violation: {topicId}")
    throw new Error("NotImplementedError: insertTopic");
  }

  /** 更新 topic 记录（status/planFormat/coverage/evidence 等字段）。 */
  updateTopic(_topicId: string, _patch: Partial<CwTopic>): void {
    throw new Error("NotImplementedError: updateTopic");
  }

  /** 批量插入 wave 记录。 */
  setWaves(_topicId: string, _waves: WaveSeed[]): void {
    throw new Error("NotImplementedError: setWaves");
  }

  /** 追加 wave 记录（replan append-only）。 */
  appendWaves(_topicId: string, _waves: WaveSeed[]): void {
    throw new Error("NotImplementedError: appendWaves");
  }

  /** 设置单个 wave 的 committed 状态。 */
  setWaveCommitted(_topicId: string, _waveId: string, _commitHash: string): void {
    throw new Error("NotImplementedError: setWaveCommitted");
  }

  /** 批量插入 testCase 记录。 */
  setTestCases(_topicId: string, _testCases: TestCaseSeed[]): void {
    throw new Error("NotImplementedError: setTestCases");
  }

  /** 追加 testCase 记录（replan append-only）。 */
  appendTestCases(_topicId: string, _testCases: TestCaseSeed[]): void {
    throw new Error("NotImplementedError: appendTestCases");
  }

  /** 更新单个 testCase 状态/actual/screenshotPath/commitHash 等。 */
  updateTestCase(
    _topicId: string,
    _caseId: string,
    _patch: Partial<Pick<TestCase, "status" | "actual" | "screenshotPath" | "commitHash" | "judgedAt" | "failureReason">>,
  ): void {
    throw new Error("NotImplementedError: updateTestCase");
  }

  /** 追加 gateHistory 记录。 */
  appendGateHistory(_topicId: string, _seed: GateHistorySeed): void {
    throw new Error("NotImplementedError: appendGateHistory");
  }

  // ── 事务 ──────────────────────────────────────────────────

  /**
   * 内存事务：回调在深拷贝副本上操作，正常→原子落盘，异常→丢弃（ROLLBACK）。
   *
   * 接线：loadFileData → 深拷贝 → fn() → 原子写（temp+fsync+rename）。
   * 失败路径：fn throw → 丢弃副本，不写盘。
   */
  transaction(fn: () => void): void {
    // 接线：this.inTransaction = true → loadFileData → 深拷贝 → fn → 原子写。
    // Level 1 透传到 fn，内部叶子逻辑（深拷贝/原子写）留 Wave。
    // this._inTransaction = true;
    try {
      fn();
      // 叶子：原子落盘 temp+fsync+rename
    } catch (e) {
      // ROLLBACK：丢弃内存副本
      throw e;
    } finally {
      // this._inTransaction = false;
    }
  }
}
