/**
 * `cw frontier [--json]`：就绪集合视图；同时是 runner 派发就绪判定的单一出处。
 *
 * 全维度口径（fx1/fx2/fx3 修复前只有 specReady/buildReady 两维，且与 loop 自带的
 * 派发计算分叉——frontier 报 buildReady 的内部节点（spec-frozen 缺子）实际会被
 * loop 派 designer 补建子，A4「零上下文接手」场景输出与真实派发行为不一致。现
 * 派发就绪计算收口于此，loop 的 computeDispatchTargets 与本命令消费同一结果）：
 *   - specReady：created 且无 spec——待 designer 撰写 spec（首派）
 *   - reReview：created 且有 spec，但最后一条 SpecSubmitted 之后无 spec-review
 *     pass——待 designer 补审（fx-1 R2 第四分支）
 *   - missingChildren：spec-frozen 内部节点（split 非空非自引用）且 split 声明的
 *     子有未创建者——待 designer 补建子（fx-3 R5.3）
 *   - integrationDrift：spec-frozen 内部节点、子全 verified、集成连续 fail 达上限
 *     ——待 designer 处置契约漂移（fx-2 R4a）
 *   - integrationReady：spec-frozen 内部节点、子全 verified、未达 fail 上限——
 *     可执行集成（u8：不派 agent，loop 直接跑 runIntegrationVerify）
 *   - buildReady：spec-frozen 叶子（split 空 ∨ 自引用按叶子语义）且子全部
 *     closed（rootLast）——待 builder
 *   - execReviewReady：verified 且未 closed——待 reviewer（exec-review）
 * closed 的 unit 与「等待子树推进」的 unit 不在任何组（已越过 / 尚未到达本
 * frontier 推进点）。弱 spec（gate 红）停在 created 且已有过审记录的 unit 亦无组：
 * 机器派发对它无出口（重派 designer 只会重提交-重审-仍弱循环），需人工修 spec。
 *
 * 状态口径用 unitStatus（单 unit 语义）：树感知 deriveStatuses 只会把 closed 拉回
 * verified（core/fold.ts deriveStatusInTree），对上表全部维度的判定输入无影响，
 * closed 本身不入组。spec gate 经 load.ts 注入真实 checkSpecRules。
 */
import { existsSync } from "node:fs";

import { fold } from "../core/fold.js";
import type { CommandContext } from "../dispatch.js";
import type {
  DiscriminatedEvent,
  LedgerEvent,
  SequencedProjection,
  SequencedUnitProjection,
  SplitEntry,
} from "../events/types.js";
import { EventLedger } from "../store/events-log.js";
import { getCwHome, ledgerPath } from "../store/project.js";
import { EMPTY_LEDGER_HINT, unitStatus } from "./load.js";

/** frontier 全维度分组（维度语义见模块头；组内序 = 投影插入序 = 账本创建序） */
export interface FrontierGroups {
  specReady: string[];
  reReview: string[];
  missingChildren: string[];
  integrationDrift: string[];
  integrationReady: string[];
  buildReady: string[];
  execReviewReady: string[];
}

/** 组的展示序 = 生命周期推进序（spec → 审 → 子 → 集成 → build → 收尾审查） */
const GROUP_ORDER: ReadonlyArray<keyof FrontierGroups> = [
  "specReady",
  "reReview",
  "missingChildren",
  "integrationDrift",
  "integrationReady",
  "buildReady",
  "execReviewReady",
];

/**
 * 同一内部节点集成的连续 fail 重派上限（fx-2 R4a，验收文档锁定 2 次）：达到后
 * 不再自动重派集成（fail 的 VerifyRan 审计事件每轮喂活 idle 判定 = R4b 无限
 * 循环），改派 designer 处置契约漂移。loop 的 designer 处置任务书
 * （integrationDriftTasks）与派发日志引用同一常量。
 */
export const INTEGRATION_MAX_CONSECUTIVE_FAILS = 2;

// ---- 判定辅助（loop 的派发分支与 computeFrontier 共用；从 loop.ts 收口至此） ----

/** 内部节点判定锚点 = 最后一条冻结 spec 的 split（canon D1：层级是数据不是代码） */
export function splitOf(
  unit: SequencedUnitProjection,
): SplitEntry[] {
  return unit.specs[unit.specs.length - 1]?.split ?? [];
}

/** split 自引用判定（fx-1 R1）：任一条目 unitId === 自身 unitId */
export function splitSelfReferences(unit: SequencedUnitProjection): boolean {
  return splitOf(unit).some((entry) => entry.unitId === unit.unitId);
}

/**
 * 内部节点的集成等待条件（u8 rootLast 升级）：split 声明的全部子 unit 已 verified
 * （closed 蕴含 verified，同样放行——证据链已闭合）。子以 split 为权威集合而非
 * 账本 parentId：split 声明了但子尚未创建时，parentId 集合的「部分子全 verified」
 * 会放行一次缺子集成（静默漏掉一个子树），split 口径下未创建 = 未 verified = 等待。
 */
export function splitChildrenAllVerified(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
): boolean {
  return splitOf(unit).every((entry) => {
    const child = projection.units.get(entry.unitId);
    if (child === undefined) {
      return false;
    }
    const status = unitStatus(child);
    return status === "verified" || status === "closed";
  });
}

/**
 * split 声明但尚未 created 的子 unitId 清单（fx-3 R5.3 派发兜底的判定输入）。
 * 与 splitChildrenAllVerified 同口径以 split 为权威集合（非账本 parentId）。
 */
export function splitChildrenNotCreated(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
): string[] {
  return splitOf(unit)
    .filter((entry) => !projection.units.has(entry.unitId))
    .map((entry) => entry.unitId);
}

/**
 * 最后一条 SpecSubmitted 之后是否存在 spec-review pass verdict。与 deriveStatus
 * 的「之后存在」语义同口径（fold.ts 禁改，此处按 SequencedUnitProjection 的顺序
 * 锚点重算）——fx-1 R2 第四分支的判定输入：重提 spec = 打回重审，旧 pass 不计数。
 */
function hasSpecReviewPassAfterLastSpec(unit: SequencedUnitProjection): boolean {
  const lastSpecSeq = unit.lastSpecSeq;
  if (lastSpecSeq === null) {
    return false;
  }
  return unit.verdicts.some(
    (verdict, i) =>
      unit.verdictSeqs[i] > lastSpecSeq &&
      verdict.verdictKind === "spec-review" &&
      verdict.verdict === "pass",
  );
}

/**
 * builder 的 rootLast 等待条件（叶子路径）：该 unit 的全部子 unit（按账本
 * parentId）已 closed。全投影口径与 loop 时代的「root 子树内遍历」等价——
 * 子树内 unit 的子（parentId 边）必然仍在子树内（BFS 收集性质）。
 */
function childrenAllClosed(
  projection: SequencedProjection,
  unit: SequencedUnitProjection,
): boolean {
  return [...projection.units.values()].every(
    (candidate) =>
      candidate.parentId !== unit.unitId || unitStatus(candidate) === "closed",
  );
}

/**
 * 各 unit 的连续 VerifyRan fail 计数（fx-2 R4a 重派上限的判定输入）：自该 unit
 * 上一条 SpecSubmitted / result=pass 的 VerifyRan 之后连续 fail 的次数（任何
 * pass / 新 spec 提交清零——验收文档锁定的口径）。SpecSubmitted 与 VerifyRan
 * 的相对顺序在 fold 投影里已丢失（平行数组），须从原始事件流重放；调用方 =
 * computeFrontier（integrationDrift 维度判定）与 loop（每轮重读账本后计算）。
 */
export function consecutiveIntegrationFails(
  events: readonly LedgerEvent[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of events) {
    const event = record as DiscriminatedEvent;
    if (event.type === "SpecSubmitted") {
      counts.set(event.payload.unitId, 0);
    } else if (event.type === "VerifyRan") {
      const previous = counts.get(event.payload.unitId) ?? 0;
      counts.set(
        event.payload.unitId,
        event.payload.result === "fail" ? previous + 1 : 0,
      );
    }
  }
  return counts;
}

/**
 * 就绪集合计算（纯函数，维度语义见模块头）。consecutiveIntegrationFails 省略时
 * 上限判定退化为「无 fail 记录」——仅供无账本上下文的纯函数调用；命令与 loop
 * 消费时必须传入真实计数，否则 integrationDrift / integrationReady 判定分叉。
 */
export function computeFrontier(
  projection: SequencedProjection,
  opts?: {
    consecutiveIntegrationFails?: ReadonlyMap<string, number>;
  },
): FrontierGroups {
  const groups: FrontierGroups = {
    specReady: [],
    reReview: [],
    missingChildren: [],
    integrationDrift: [],
    integrationReady: [],
    buildReady: [],
    execReviewReady: [],
  };
  const fails = opts?.consecutiveIntegrationFails;
  for (const unit of projection.units.values()) {
    const status = unitStatus(unit);
    if (status === "created") {
      if (unit.specs.length === 0) {
        groups.specReady.push(unit.unitId);
      } else if (!hasSpecReviewPassAfterLastSpec(unit)) {
        groups.reReview.push(unit.unitId);
      }
      // 已过审但 gate 红（弱 spec 停 created）：无组（模块头口径）
    } else if (status === "spec-frozen") {
      const selfReferencing = splitSelfReferences(unit);
      if (!selfReferencing && splitOf(unit).length > 0) {
        if (splitChildrenNotCreated(projection, unit).length > 0) {
          groups.missingChildren.push(unit.unitId);
        } else if (splitChildrenAllVerified(projection, unit)) {
          if ((fails?.get(unit.unitId) ?? 0) >= INTEGRATION_MAX_CONSECUTIVE_FAILS) {
            groups.integrationDrift.push(unit.unitId);
          } else {
            groups.integrationReady.push(unit.unitId);
          }
        }
        // 子已建未全 verified：等待子树推进，无组
      } else if (childrenAllClosed(projection, unit)) {
        // 叶子（split 空 ∨ 自引用按叶子语义，fx-1 R1）：rootLast 等待条件
        groups.buildReady.push(unit.unitId);
      }
    } else if (status === "verified") {
      groups.execReviewReady.push(unit.unitId);
    }
    // closed：已越过全部推进点，无组
  }
  return groups;
}

/** 分组文本视图（纯函数）：空组显示 (无) 保持分组标题恒在 */
export function renderFrontier(groups: FrontierGroups): string {
  const groupLines = (ids: readonly string[]): string =>
    ids.length === 0 ? "  (无)" : ids.map((id) => `  ${id}`).join("\n");
  return `${GROUP_ORDER.map((key) => `${key}:\n${groupLines(groups[key])}`).join("\n")}\n`;
}

/** --json 缩进宽度（2 空格，与文本视图缩进一致） */
const JSON_INDENT = 2;

export async function frontierHandler(ctx: CommandContext): Promise<number> {
  // 直接读原始事件流（loadLedger 只回投影；integrationDrift 维度需要事件重放的
  // 连续 fail 计数）。existsSync 前置探测保持只读保证（不构造 EventLedger 建目录）
  const path = ledgerPath(getCwHome(), ctx.cwd);
  const events = existsSync(path) ? new EventLedger(path).readAll() : [];
  const projection = fold(events);
  const groups = computeFrontier(projection, {
    consecutiveIntegrationFails: consecutiveIntegrationFails(events),
  });

  if (ctx.argv.json === true) {
    process.stdout.write(`${JSON.stringify(groups, null, JSON_INDENT)}\n`);
    return 0;
  }
  if (projection.units.size === 0) {
    process.stdout.write(EMPTY_LEDGER_HINT);
    return 0;
  }
  process.stdout.write(renderFrontier(groups));
  return 0;
}
