/**
 * 通用调度循环（u7 验收文档 docs/rewrite/acceptance/u7-acceptance.md 锁定；
 * canon《design-rewrite-architecture.md》§3.3 D4「runner 无智能无状态：状态全在
 * 账本」、§3.4 组件分层「调度循环 = frontier → 全量批次 spawn → 等退出 → 证据
 * 回收 → 重算」）。
 *
 * 对 M0 human-loop（u5b）的泛化：后端无关——不感知适配器类型（human / pi /
 * 测试专用一视同仁，差异被 AgentSpawn 契约隔离在 types.ts）。循环自身只读账本
 * 投影 + 生成 brief + 派发 + 等待，绝不写任何账本事件；全部状态推进由被派发
 * agent（经适配器起的真实进程）完成——账本即状态，Ctrl-C 中断重跑即续。
 *
 * 派发对象规则（每轮对投影重算，子树 BFS 序）：
 *   - created 且无 spec                    → designer（一次完成 spec 提交 + spec-review）
 *   - spec-frozen 且（无子 ∨ 子全部 closed）→ builder（rootLast 语义：子的产出是
 *     root 验收的输入，root 的 build 等子树收尾——与 human-loop rootLast 同源）
 *   - verified 且未 closed                  → reviewer（exec-review）
 *   - spec 已提交未过审 → 不重复派 designer（等 spec-review 事件；designer 半途
 *     退出则空转，由 maxIdleMs 兜底 exit 1）
 *
 * 等待期间零锁（canon D4：等待 spawn 期间持锁会饿死子进程的账本写入）。
 * 失败语义只看四态退出（types.ts）：exit≠0 / TIMEOUT / CRASH 可重派（下轮重算
 * 自然再次进入派发集合）；SPAWN_ERROR 配置错误不重试，kill 全部 in-flight 后
 * exit 1。
 *
 * M1 简化（验收文档锁定）：workdir = cwd 本身（无独立 worktree，M2 集成时升级）；
 * 循环不处理 split 子 unit 的创建（fixture / designer 侧预置，create 派发属 M2）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SequencedProjection, SequencedUnitProjection } from "../events/types.js";
import { loadLedger, unitStatus } from "../readonly/load.js";
import type {
  AgentRole,
  AgentSpawnAdapter,
  SpawnHandle,
  SpawnResult,
} from "./spawn/types.js";

/** 账本轮询间隔默认值（--poll-ms；验收文档：默认 1000） */
export const DEFAULT_LOOP_POLL_MS = 1_000;
/** 无账本进展上限默认值（--max-idle-ms；验收文档：默认 30min） */
export const DEFAULT_LOOP_MAX_IDLE_MS = 1_800_000;
/** 同批 in-flight spawn 上限默认值（--max-concurrency；验收文档：默认 3） */
export const DEFAULT_LOOP_MAX_CONCURRENCY = 3;
/** 单次 agent spawn 超时（验收文档循环逻辑 3：timeoutMs 固定 30min） */
const AGENT_SPAWN_TIMEOUT_MS = 1_800_000;

export interface RunLoopOptions {
  rootId: string;
  adapter: AgentSpawnAdapter;
  cwd: string;
  pollMs?: number;
  maxIdleMs?: number;
  maxConcurrency?: number;
}

/** in-flight 派发（同 unitId 不同 role 可并存——canon「每单元最多 1 builder + 1 reviewer」） */
interface InFlightSpawn {
  role: AgentRole;
  unitId: string;
  handle: SpawnHandle;
}

interface DispatchTarget {
  role: AgentRole;
  unitId: string;
}

/** race 的产出：任一 spawn 退出时携带其 flight 与四态结果；poll 到点为 null */
interface FinishedWatch {
  flight: InFlightSpawn;
  result: SpawnResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emit(lines: readonly string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function emitErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * root 子树的 unit 列表（BFS 序 = root 先、子按账本创建序）。实现与 human-loop
 * 的同名私有函数一致（泛化期两处并存，human-loop 退役后单一化）。
 */
function subtreeUnits(
  projection: SequencedProjection,
  rootId: string,
): SequencedUnitProjection[] {
  const childrenOf = new Map<string, string[]>();
  for (const unit of projection.units.values()) {
    if (unit.parentId !== null) {
      const siblings = childrenOf.get(unit.parentId) ?? [];
      siblings.push(unit.unitId);
      childrenOf.set(unit.parentId, siblings);
    }
  }
  const units: SequencedUnitProjection[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const unit = projection.units.get(current);
    if (unit === undefined) break; // 不可达：BFS 只入账内 id
    units.push(unit);
    queue.push(...(childrenOf.get(current) ?? []));
  }
  return units;
}

/** builder 的 rootLast 等待条件：该 unit 的全部子 unit（按账本 parentId）已 closed */
function childrenAllClosed(
  subtree: readonly SequencedUnitProjection[],
  unit: SequencedUnitProjection,
): boolean {
  return subtree.every(
    (candidate) => candidate.parentId !== unit.unitId || unitStatus(candidate) === "closed",
  );
}

/** 派发对象集合（纯函数；规则见模块头）。in-flight 的同 (unitId, role) 不重复派。 */
function computeDispatchTargets(
  projection: SequencedProjection,
  rootId: string,
  inFlight: readonly InFlightSpawn[],
): DispatchTarget[] {
  const subtree = subtreeUnits(projection, rootId);
  const targets: DispatchTarget[] = [];
  for (const unit of subtree) {
    const status = unitStatus(unit);
    let role: AgentRole | undefined;
    if (status === "created" && unit.specs.length === 0) {
      role = "designer";
    } else if (status === "spec-frozen" && childrenAllClosed(subtree, unit)) {
      role = "builder";
    } else if (status === "verified") {
      role = "reviewer";
    }
    if (role === undefined) {
      continue;
    }
    const alreadyInFlight = inFlight.some(
      (flight) => flight.unitId === unit.unitId && flight.role === role,
    );
    if (alreadyInFlight) {
      continue;
    }
    targets.push({ role, unitId: unit.unitId });
  }
  return targets;
}

// ---- brief 生成（循环六步之 2：unit 上下文 + role 任务书模板，file-based 传递） ----

const ROLE_TASKS: Record<AgentRole, (unitId: string) => string> = {
  designer: (unitId) => [
    "## 你的任务（designer）",
    `1. 撰写该 unit 的 spec.json。验收五规则（src/gates/spec-rules.ts）：验收非空；`,
    "   核心 case 的 type 须为 e2e-real / e2e-mock 且带可执行 command；含 mock 须附",
    "   mock 保真度说明；至少一条 unit 级用例。",
    `2. 提交 spec：cw evidence submit --kind spec --unit ${unitId} --file spec.json`,
    `3. 提交 spec 审查：cw review submit --unit ${unitId} --verdict-kind spec-review --verdict pass`,
    "完成标志：unit 进入 spec-frozen（cw status 可查）。",
  ].join("\n"),
  builder: (unitId) => [
    "## 你的任务（builder）",
    "1. 在 workdir 实现该 unit 冻结验收要求的目标并 git commit（取 hash：git rev-parse HEAD）。",
    `2. 提交 build 证据：cw evidence submit --kind build --unit ${unitId} --commit <hash> --run-id <自拟唯一 runId> [--file <产物路径>...]`,
    `3. 触发干净重跑验证：cw verify --unit ${unitId}`,
    "完成标志：unit 进入 verified。",
  ].join("\n"),
  reviewer: (unitId) => [
    "## 你的任务（reviewer）",
    `对该 unit 提交 exec-review 结论（审查依据：cw report --unit ${unitId} 的证据链与 verify 结果）：`,
    `cw review submit --unit ${unitId} --verdict-kind exec-review --verdict pass|fail [--comment <意见>]`,
    "完成标志：verdict 为 pass 时 unit 进入 closed。",
  ].join("\n"),
};

function renderBrief(unit: SequencedUnitProjection, role: AgentRole, cwd: string): string {
  let briefContent: string;
  try {
    briefContent = readFileSync(unit.briefRef, "utf-8");
  } catch {
    briefContent = `(原始任务书文件不可读：${unit.briefRef})`;
  }
  return [
    `# ${role} 任务书：unit "${unit.unitId}"`,
    "",
    "## Unit 上下文",
    `- unitId: ${unit.unitId}`,
    `- parentId: ${unit.parentId ?? "（根节点）"}`,
    `- 当前状态: ${unitStatus(unit)}`,
    `- 原始任务书: ${unit.briefRef}`,
    "",
    "### 原始任务书内容",
    briefContent,
    "",
    ROLE_TASKS[role](unit.unitId),
    "",
    "## 环境约定",
    `- workdir: ${cwd}（M1 简化 = 仓库本身，无独立 worktree）`,
    "- 账本命令：在 workdir 下执行 cw …（状态推进全部经账本命令入账）",
    "",
  ].join("\n");
}

/** brief 落盘到 <workdir>/.cw-spawn/<unitId>.<role>.brief.md（验收文档循环逻辑 2） */
function writeBriefFile(
  cwd: string,
  target: DispatchTarget,
  unit: SequencedUnitProjection,
): string {
  const path = join(cwd, ".cw-spawn", `${target.unitId}.${target.role}.brief.md`);
  mkdirSync(join(cwd, ".cw-spawn"), { recursive: true });
  writeFileSync(path, renderBrief(unit, target.role, cwd));
  return path;
}

// ---- 终止与汇总 ----

/**
 * 兜底回收（root closed / 空转超时 / SPAWN_ERROR 三个出口共用）：best-effort——
 * 逐个 kill、单个失败记录后继续。kill 目标常为「已自然退出但 race 未结算」的
 * flight，macOS 对已退出进程组的 kill(-pgid) 返回 EPERM（而非 ESRCH），而
 * lifecycle.killTree 只豁免 ESRCH——清理失败炸掉正常退出流程比残留一个已死
 * 进程的 kill 企图更糟（进程已死则无需清理；真残留由其自身 timeout 兜底）。
 * 与 killTree 的「确保死」是两层语义：那边是 u6a 的进程级强杀，这里只需尽力回收。
 */
function killAll(inFlight: readonly InFlightSpawn[]): void {
  for (const flight of inFlight) {
    try {
      flight.handle.kill();
    } catch (err) {
      process.stderr.write(
        `[runner] 兜底 kill 失败（${flight.role} unit "${flight.unitId}"）：` +
          `${err instanceof Error ? err.message : String(err)}——目标进程多半已退出，忽略。\n`,
      );
    }
  }
}

/** root closed 的汇总（验收文档循环逻辑 5：每 unit 状态行） */
function emitSummary(projection: SequencedProjection, rootId: string): void {
  const units = subtreeUnits(projection, rootId);
  const rows = units.map((unit) => {
    const lastVerify =
      unit.verifyRuns.length > 0 ? unit.verifyRuns[unit.verifyRuns.length - 1].result : "-";
    return `[runner]   ${unit.unitId}  ${unitStatus(unit)}  lastVerify:${lastVerify}`;
  });
  emit([
    `[runner] root "${rootId}" 已 closed——调度循环结束（exit 0）。汇总（root 子树 ${units.length} 个 unit）：`,
    ...rows,
    `[runner] 证据链详情：cw report（全量）或 cw report --unit ${rootId}`,
  ]);
}

function idleFailureMessage(rootId: string, maxIdleMs: number, totalEvents: number): string {
  return (
    `cw run: root "${rootId}" 超过 ${maxIdleMs}ms 无账本进展（totalEvents 停在 ${totalEvents}，` +
    "被派发 agent 未产出任何事件）。恢复动作：查看 <workdir>/.cw-spawn/ 下各 agent 的 " +
    `stdout / stderr 定位卡点，或 cw status 查看现状；排除故障后重新运行 cw run --root ${rootId} 继续（账本即状态，重跑即续）。`
  );
}

function spawnErrorMessage(rootId: string, unitId: string, role: AgentRole): string {
  return (
    `cw run: unit "${unitId}" 的 ${role} 派发返回 SPAWN_ERROR（agent 起不来——配置错误，重试无意义）。` +
    "恢复动作：核对适配器配置（可执行是否存在 / 模型可用），修正后重新运行 " +
    `cw run --root ${rootId} 继续（已完成的事件不丢失）。`
  );
}

function describeExit(exitCode: SpawnResult["exitCode"]): string {
  if (exitCode === 0) {
    return "exit 0";
  }
  if (exitCode === "SPAWN_ERROR") {
    return "SPAWN_ERROR";
  }
  const retryable = exitCode === "TIMEOUT" || exitCode === "CRASH" ? "，可重派" : "";
  return `${String(exitCode)}${retryable}`;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `runLoop: 非法参数 ${name}=${value}：须为正数。恢复动作：检查 cw run 的对应 flag（--poll-ms / --max-idle-ms / --max-concurrency）取值。`,
    );
  }
}

/**
 * 通用调度循环：root closed → 汇总返回 0；无进展超 maxIdleMs → stderr + 返回 1；
 * SPAWN_ERROR（配置错误）→ kill 全部 in-flight + stderr + 返回 1。
 * root 不在账本 → 抛可操作错误（调用方负责转 exit 1）。
 */
export async function runLoop(opts: RunLoopOptions): Promise<number> {
  const pollMs = opts.pollMs ?? DEFAULT_LOOP_POLL_MS;
  const maxIdleMs = opts.maxIdleMs ?? DEFAULT_LOOP_MAX_IDLE_MS;
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_LOOP_MAX_CONCURRENCY;
  assertPositive("pollMs", pollMs);
  assertPositive("maxIdleMs", maxIdleMs);
  assertPositive("maxConcurrency", maxConcurrency);

  const initial = loadLedger(opts.cwd);
  if (!initial.projection.units.has(opts.rootId)) {
    throw new Error(
      `runLoop: root "${opts.rootId}" 不存在（账本内无其 UnitCreated 事件）。` +
        `恢复动作：运行 cw status 查看全部 unit 确认 id，或 cw create --id ${opts.rootId} --brief <路径> 创建。`,
    );
  }

  emit([
    `[runner] 循环启动：root=${opts.rootId} adapter=${opts.adapter.name} ` +
      `poll=${pollMs}ms max-idle=${maxIdleMs}ms max-concurrency=${maxConcurrency}`,
  ]);

  const inFlight: InFlightSpawn[] = [];
  let lastTotalEvents = initial.projection.totalEvents;
  let lastProgressAt = Date.now();

  while (true) {
    // 每轮重读投影（子进程 agent 与本循环并发写账本，投影必须重新装载）
    const { projection } = loadLedger(opts.cwd);
    const root = projection.units.get(opts.rootId);
    if (root === undefined) {
      // append-only 账本里 UnitCreated 不会消失；走到这里说明账本被外部改动
      emitErr(
        `cw run: root "${opts.rootId}" 在循环中途从账本消失（账本被外部改动？）。` +
          "恢复动作：cw status 查看现存 unit 后重新运行 cw run --root <id>。",
      );
      killAll(inFlight);
      return 1;
    }
    if (unitStatus(root) === "closed") {
      // 正常路径 in-flight 已空；外部（如人工）直接推 closed 时的兜底回收
      killAll(inFlight);
      emitSummary(projection, opts.rootId);
      return 0;
    }

    // 派发（六步之 1-3）：frontier 重算 → brief 落盘 → spawn，同批 ≤ maxConcurrency
    for (const target of computeDispatchTargets(projection, opts.rootId, inFlight)) {
      if (inFlight.length >= maxConcurrency) {
        break;
      }
      const unit = projection.units.get(target.unitId);
      if (unit === undefined) {
        continue; // 不可达（target 来自同一投影）
      }
      const briefPath = writeBriefFile(opts.cwd, target, unit);
      const handle = await opts.adapter.spawn({
        role: target.role,
        unitId: target.unitId,
        workdir: opts.cwd,
        briefPath,
        timeoutMs: AGENT_SPAWN_TIMEOUT_MS,
      });
      inFlight.push({ role: target.role, unitId: target.unitId, handle });
      emit([
        `[runner] ${new Date().toISOString()} 派发 ${target.role} → unit "${target.unitId}"（brief: ${briefPath}）`,
      ]);
    }

    // 等待（六步之 4）：任一 spawn 退出或 poll 到点，先到者唤醒重算
    const finished = await Promise.race<FinishedWatch | null>([
      ...inFlight.map(async (flight) => ({ flight, result: await flight.handle.wait() })),
      sleep(pollMs).then(() => null),
    ]);

    if (finished !== null) {
      inFlight.splice(inFlight.indexOf(finished.flight), 1);
      emit([
        `[runner] ${new Date().toISOString()} ${finished.flight.role} unit "${finished.flight.unitId}" 退出 ${describeExit(finished.result.exitCode)}`,
      ]);
      if (finished.result.exitCode === "SPAWN_ERROR") {
        emitErr(spawnErrorMessage(opts.rootId, finished.flight.unitId, finished.flight.role));
        killAll(inFlight);
        return 1;
      }
    }

    // 进展检查（六步之 5 的空转出口）：任一账本事件推进即视为有进展
    const totalEvents = loadLedger(opts.cwd).projection.totalEvents;
    if (totalEvents !== lastTotalEvents) {
      lastTotalEvents = totalEvents;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= maxIdleMs) {
      emitErr(idleFailureMessage(opts.rootId, maxIdleMs, totalEvents));
      killAll(inFlight);
      return 1;
    }
  }
}
