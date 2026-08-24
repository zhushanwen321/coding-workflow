/**
 * gate 域事件代数（design-release-pipeline.md §3.3 D1/D5，rp-0）。
 *
 * 封闭两类事件（PipelineStepRan 属 rp-2，本波不预留空类型——加法纪律：未来
 * 增补只许 append-only 加法 + 缺省重放兼容）：
 *   - GateCheckRan：一次 check 的真实执行事实（miss 路径产生；fail 也入账仅
 *     审计，永不作命中候选）
 *   - GateCacheHit：一次缓存命中事实（hit 路径产生；无 runId 幂等键——命中
 *     复用不是新执行事实，可独立存在）
 *
 * 与 unit 域（src/events/types.ts）的结构性差异：无 unitId 锚（本域锚 =
 * payload.check）、无生命周期状态机（缓存条目没有 created→closed，只有
 * 「此内容验过没有」的事实）。两域不共享任何 payload 类型。
 */
import type { DomainEnvelope, DomainEvent } from "../store/ledger-domain.js";

/** check 执行结果：pass = 命中判定可用的唯一值（fail 只审计不复用） */
export type GateResult = "pass" | "fail";

/**
 * GateCheckRan 载荷（D5 表格逐字段对照）。
 * 幂等键 = check + runId（域描述符 validateAppend 兜底，wrap 层提前友好检查）。
 */
export interface GateCheckRanPayload {
  /** 锚：check 的命名身份（如 "typecheck"） */
  check: string;
  /** base 比对基线解析后的 sha（缓存键维度；ref 字符串只作审计展示） */
  baseSha: string;
  /** 调用方传入的 base 原文（ref 或 sha，审计展示用） */
  baseRef: string;
  /** check 输入文件集声明（路径前缀列表；缺省空数组 = 仓根） */
  scope: string[];
  /** 执行瞬间 HEAD 的 sha */
  headSha: string;
  /** 被执行的命令（argv 形态，不经 shell） */
  command: string[];
  /** 本产物 runId（产物目录名 = gate-artifacts/<check>/<runId>/） */
  runId: string;
  /** pass / fail（fail 入账不进 pass 投影） */
  result: GateResult;
  /** 命令退出码（result 的原始依据） */
  exitCode: number;
  /** 真实执行耗时（ms；miss 路径才有，hit 事件无此字段） */
  durationMs: number;
  /** report.json 相对项目 CW 目录的路径（gate-artifacts/<check>/<runId>/report.json） */
  reportRef: string;
  /** report.json 内容的 sha256（命中路径复算校验的锚——不符向 miss 倒） */
  reportSha256: string;
}

/** GateCacheHit 载荷（D5 表格逐字段对照；无 runId/durationMs——无真实执行） */
export interface GateCacheHitPayload {
  check: string;
  baseSha: string;
  baseRef: string;
  scope: string[];
  headSha: string;
  /** 命中来源（被复用的那条 GateCheckRan 的 runId，审计链） */
  sourceRunId: string;
  reportRef: string;
  reportSha256: string;
}

/** gate 域事件 type 封闭集 */
export type GateEventType = "GateCheckRan" | "GateCacheHit";

/** gate 域 payload 映射表（EventLedger<GateEventMap> 的泛型参数） */
export type GateEventMap = {
  GateCheckRan: GateCheckRanPayload;
  GateCacheHit: GateCacheHitPayload;
};

/** gate 域账本一行的运行时形状（DomainEvent 的域特化） */
export type GateEvent = DomainEvent<GateEventMap>;

/** append 的返回值形状（窄化信封） */
export type GateAppendEnvelope<K extends GateEventType> = DomainEnvelope<
  GateEventMap,
  K
>;

/**
 * 事件信封的判别联合视图（对照 unit 域 DiscriminatedEvent）：type 与 payload
 * 联动，fold 的 switch 窄化依赖它——宽泛的泛型信封做不到。仅类型层视图，
 * 账本 JSONL 序列化格式不变。
 */
export type GateDiscriminatedEvent = {
  [K in GateEventType]: {
    seq: number;
    ts: string;
    type: K;
    payload: GateEventMap[K];
  };
}[GateEventType];

/**
 * report.json 的结构（D4 记账闭合：miss 与 hit 两路径同构产出，schema 单一
 * 出处 = 本模块 + artifacts.ts 的落盘实现）。
 *
 * hit 路径 = 来源 report 全字段原样复制 + source 标注追加（GP5：两份 report
 * 除 source 外逐字段一致——durationMs 也保留来源值，消费方读到的是「此内容
 * 验证时的真实耗时」，与 query 展示口径一致；hit 的 wrap 自身耗时只进 stdout
 * 不进 report）。
 */
export interface GateReport {
  check: string;
  /** 产生本 report 事实的 runId（hit 复制时保留来源值——report 描述的是来源那次执行的事实） */
  runId: string;
  baseSha: string;
  baseRef: string;
  scope: string[];
  headSha: string;
  command: string[];
  result: GateResult;
  exitCode: number;
  durationMs: number;
  /** hit 路径专有：被复用的来源 runId（miss report 无此键） */
  source?: string;
}
