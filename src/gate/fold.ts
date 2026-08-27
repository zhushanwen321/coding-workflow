/**
 * gate 域 fold 投影（design-release-pipeline.md §3.3 D5，rp-0）。
 *
 * 纯函数：输入 GateEvent[]（账本顺序），输出三组投影；同一事件数组折叠两次
 * 结果 deep-equal（replay 幂等，与 unit 域 fold 同哲学——状态不存储只计算）。
 *
 *   1. latestPassByKey：缓存键 (check, baseSha, scope) → 最新 pass 的
 *      GateCheckRan（hit 判定的唯一输入；fail 不进——「fail 永不入缓存候选」
 *      在投影层结构性成立，wrap 只消费此投影，无旁路）。
 *   2. latestByCheck：check → 最新事件（两类皆可，query/status 展示用）。
 *   3. durationStats：check → 真实执行的 durationMs 聚合（stats 输入；
 *      GateCacheHit 无 durationMs 字段，天然只统计真实执行）。
 *
 * 「最新」的口径 = 入账序（seq）最后一条：同键下 seq 递增时 headSha 通常
 * 单调前进（D3 文字「headSha 最新」的正常流形态）；异常流（reset 回退后重跑）
 * 按入账序取最新一次执行的事实——投影不解析 git 历史，确定性优先。
 *
 * 未知事件 type 抛错（对照 unit 域 fold 的 default 分支）：账本 append 侧
 * 已被域封闭集拦截，fold 再见到即事件流被外部改动，静默跳过会把损坏伪装成
 * 正常投影。
 */
import type {
  GateCheckRanPayload,
  GateDiscriminatedEvent,
  GateEvent,
} from "./types.js";

/** 缓存键分隔符（\0 不出现在合法 check/scope/baseSha 字符中，防拼接歧义） */
const KEY_SEPARATOR = "\u0000";

/**
 * 缓存键 = (check, baseSha, scope) 三元组的字符串化。scope 用 JSON 编码参与
 * （join(",") 有歧义：[] 与 [""] 同串、含逗号前缀互撞）；声明原序参与——顺序
 * 不同 = 不同键（调用方声明什么就是什么，顺序漂移宁可 miss 不假 pass，D3
 * 保守方向的同款取舍）。
 */
export function gateCacheKey(check: string, baseSha: string, scope: readonly string[]): string {
  return [check, baseSha, JSON.stringify(scope)].join(KEY_SEPARATOR);
}

/** latestPassByKey 的值：最新 pass 条目（payload 的 result 恒 "pass"）+ 顺序锚 */
export interface GatePassCandidate {
  seq: number;
  ts: string;
  payload: GateCheckRanPayload;
}

/** per check 的真实执行耗时聚合（stats 输入） */
export interface GateDurationStats {
  /** 真实执行（GateCheckRan）的 durationMs 总和；命中（GateCacheHit）不计 */
  totalMs: number;
  /** 真实执行次数 */
  runs: number;
}

/** latestStepRun 的值：最新一次步骤执行事实 + 顺序锚（pipeline status / run 续接投影输入） */
export interface GateStepRun {
  seq: number;
  ts: string;
  payload: import("./types.js").PipelineStepRanPayload;
}

/**
 * 步骤分组键 = (pipeline, manifestSha256, step) 三元组字符串化——
 * manifest 内容寻址（D6）：manifest 变更 → manifestSha256 变 → 新分组，
 * 旧步骤记录自然不参与投影（与 gateCacheKey 同哲学，防假进度）。
 */
export function pipelineStepKey(
  pipeline: string,
  manifestSha256: string,
  step: string,
): string {
  return [pipeline, manifestSha256, step].join("\u0000");
}

/** gate 域账本投影（foldGate 的输出） */
export interface GateProjection {
  /** (check, baseSha, scope) → 最新 pass GateCheckRan（hit 判定输入） */
  readonly latestPassByKey: ReadonlyMap<string, GatePassCandidate>;
  /** check → 最新事件（按 seq；GateCheckRan | GateCacheHit，query/status 展示） */
  readonly latestByCheck: ReadonlyMap<string, GateDiscriminatedEvent>;
  /** check → durationMs 聚合（stats 输入） */
  readonly durationStats: ReadonlyMap<string, GateDurationStats>;
  /** (pipeline, manifestSha256, step) → 最新 PipelineStepRan（status 展示 + run 即 resume 的续接投影） */
  readonly latestStepRun: ReadonlyMap<string, GateStepRun>;
  readonly totalEvents: number;
}

/** 折叠 gate 账本事件为投影（纯函数；见模块头对三组投影的语义约定）。 */
export function foldGate(events: readonly GateEvent[]): GateProjection {
  const latestPassByKey = new Map<string, GatePassCandidate>();
  const latestByCheck = new Map<string, GateDiscriminatedEvent>();
  const durationStats = new Map<string, GateDurationStats>();
  const latestStepRun = new Map<string, GateStepRun>();
  for (const record of events) {
    // 宽泛的泛型信封 type 与 payload 不联动，判别联合视图才能按 type 窄化
    const event = record as GateDiscriminatedEvent;
    // latestByCheck 只收 check 类事件（step 类事件无 check 字段，误收会写入
    // undefined 键污染 query/status 展示）——in 守卫让 TS 按属性窄化 union
    if ("check" in event.payload) {
      const known = latestByCheck.get(event.payload.check);
      if (known === undefined || known.seq < event.seq) {
        latestByCheck.set(event.payload.check, event);
      }
    }
    switch (event.type) {
      case "GateCheckRan": {
        const key = gateCacheKey(
          event.payload.check,
          event.payload.baseSha,
          event.payload.scope,
        );
        // 最新 pass：fail 不进（缓存候选结构性排除）；同键后入账覆盖先入账
        if (event.payload.result === "pass") {
          const existing = latestPassByKey.get(key);
          if (existing === undefined || existing.seq < event.seq) {
            latestPassByKey.set(key, { seq: event.seq, ts: event.ts, payload: event.payload });
          }
        }
        const stats = durationStats.get(event.payload.check) ?? { totalMs: 0, runs: 0 };
        stats.totalMs += event.payload.durationMs;
        stats.runs += 1;
        durationStats.set(event.payload.check, stats);
        break;
      }
      case "GateCacheHit":
        // 命中复用无新执行事实：不进 pass 投影（它复用的来源条目已在）、不进
        // duration 聚合（无 durationMs 字段）；只刷新 latestByCheck（上方已做）
        break;
      case "PipelineStepRan": {
        // 步骤事实：按 (pipeline, manifestSha256, step) 分组取最新（status 展示
        // + run 即 resume 续接投影）；不入 check 类三投影（无 check 锚）
        const key = pipelineStepKey(
          event.payload.pipeline,
          event.payload.manifestSha256,
          event.payload.step,
        );
        const existing = latestStepRun.get(key);
        if (existing === undefined || existing.seq < event.seq) {
          latestStepRun.set(key, { seq: event.seq, ts: event.ts, payload: event.payload });
        }
        break;
      }
      default: {
        const _exhaustive: never = event;
        throw new Error(
          `foldGate: 未知事件类型：${String(_exhaustive)}。gate 账本 append 侧已按域封闭集拦截；出现未知 type 即事件流被外部改动，请核对 gate-events.log。`,
        );
      }
    }
  }
  return { latestPassByKey, latestByCheck, durationStats, latestStepRun, totalEvents: events.length };
}
