/**
 * TestRun 缝契约（canon《design-rewrite-architecture.md》附录 B.2 的代码投影）。
 *
 * 共享契约层，主 agent 维护：已有定义不得改名改义，追加经 owner unit 验收文档背书。
 * u4a（verify 执行框架）与 u5（适配器实现）并行开发，双方只 import 不修改本文件。
 */

import type { AcceptanceItem } from "../events/types.js";

/** 一次运行产物的统一结构——名字级比对的输入（canon B.2 EvidenceReport） */
export interface EvidenceReport {
  exitCode: number;
  cases: Array<{ id: string; name: string; status: "pass" | "fail" }>;
  /** 原始产物路径（hash 入账对象） */
  rawPath: string;
}

/**
 * 测试执行适配器：验收 → 可执行命令；产物 → EvidenceReport。
 * engine 只 import 本接口；具体适配器（vitest / e2e-sh）在调用侧注册。
 */
export interface TestRunAdapter {
  /** 适配器类型标识（如 'vitest' | 'e2e-sh'） */
  type: string;
  /** 验收 → 可执行命令（在干净 checkout 的 cwd 下执行） */
  translate(acceptance: AcceptanceItem): string;
  /** cw 自己捕获的产物（stdoutPath + exitCode）→ EvidenceReport；解析失败必须抛错而非伪造 cases */
  parse(stdoutPath: string, exitCode: number, acceptance: AcceptanceItem): EvidenceReport;
}

/** 适配器注册表（调用侧装配；M0 以 type 字符串精确查找） */
export type AdapterRegistry = Map<string, TestRunAdapter>;
