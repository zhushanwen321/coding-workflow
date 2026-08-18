/**
 * human 模式调度循环（u5b 验收文档锁定；canon 子文档 1《design-child-spawn.md》
 * §5.1 human 适配器输出形态、§2 目标 3「human 降级：验证价值 100% 保留」）。
 *
 * 职责边界：只读账本 + 打印指令 + 轮询——绝不写账本。human 模式的全部状态推进
 * 由人按打印的指令手工调 CLI 写命令完成（账本即状态：Ctrl-C 中断无残留，重跑
 * `cw run --root <id>` 从账本现状继续）。
 *
 * 指令生成全部为纯函数（投影 → 指令文本数组）；循环体只做「装载 → 打印 → 等待」。
 * 单测对纯函数逐状态断言（tests/u5b-loop.test.ts），E2E 用真实子进程走全链
 * （tests/u5b-e2e.test.ts）。
 *
 * 与 u5b 验收文档的一处显式偏差（冲突表面化）：文档 spec 指令组的 review 命令带
 * `--evidence-refs <specRunId>`，但 u2 实现里 spec 提交（SpecSubmitted）不产生
 * runId——runId 只存在于 build 证据（EvidenceSubmitted），而 review submit 校验
 * evidence-refs 引用的 runId 必须已在该 unit 的 EvidenceSubmitted 中，照文档原样
 * 执行会被拒。故本指令组的 spec-review 命令不带 --evidence-refs（该 flag 可选），
 * 与 u2 真实行为一致。
 *
 * mx-1 后本循环的 spec-review / exec-review 指令由人扮演 reviewer 角色执行
 * （语义上不是 designer 自审——pi 模式下同结论由独立 reviewer spawn 提交），
 * 指令统一带 `--role reviewer` 自报，账本 verdict 的 role 字段可审计。
 */
import type {
  SequencedProjection,
  SequencedUnitProjection,
  SplitEntry,
  UnitStatus,
} from "../events/types.js";
import { loadLedger, unitStatus } from "../readonly/load.js";

/** 循环识别的待人工步骤类型；none = 无（root 已 closed 或子树无待办） */
export type StepKind = "create" | "spec" | "spec-review" | "build" | "exec-review" | "none";

export interface StepInstruction {
  kind: StepKind;
  /** 指令组的目标 unit（create = split 挂靠的 root；none = 无目标） */
  unitId: string | null;
  /** 指令文本行（每行自带 [human] 前缀；none 时为空数组） */
  lines: string[];
}

/** 取投影中的 unit；不在投影中属调用方契约违反（run 已前置校验 root），抛错而非静默 */
function mustGetUnit(projection: SequencedProjection, unitId: string): SequencedUnitProjection {
  const unit = projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`human-loop: unit "${unitId}" 不在投影中（调用方须先校验 root 存在）。`);
  }
  return unit;
}

/**
 * root 子树的 unitId 集合（含 root 自身；BFS 序 = root 先、子按账本创建序）。
 * 实现按 parentId 逐层向下收集，不限两层——M0 深度上限由 create 命令把关，
 * 循环导航对已入账的任意形态子树给出正确顺序。
 */
function subtreeUnitIds(projection: SequencedProjection, rootId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const unit of projection.units.values()) {
    if (unit.parentId !== null) {
      const siblings = childrenOf.get(unit.parentId) ?? [];
      siblings.push(unit.unitId);
      childrenOf.set(unit.parentId, siblings);
    }
  }
  const ids: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    ids.push(current);
    queue.push(...(childrenOf.get(current) ?? []));
  }
  return ids;
}

/** root 当前生效 spec 的 split 中尚未 create 的子 unit 条目（验收文档循环逻辑 7） */
function pendingSplitEntries(projection: SequencedProjection, rootId: string): SplitEntry[] {
  const root = mustGetUnit(projection, rootId);
  if (root.specs.length === 0) {
    return [];
  }
  const split = root.specs[root.specs.length - 1].split;
  return split.filter((entry) => !projection.units.has(entry.unitId));
}

// ---- 指令组渲染（纯函数；验收文档循环逻辑 1/2/3/7 锁定内容） ----

const SPEC_SKELETON =
  '{"acceptance":[{"id":"A1","core":true,"title":"一句话","type":"e2e-real","command":"<可执行命令>"},' +
  '{"id":"A2","core":false,"title":"单元级","type":"unit"}],"contracts":[],"split":[]}';

function specInstruction(unit: SequencedUnitProjection): StepInstruction {
  return {
    kind: "spec",
    unitId: unit.unitId,
    lines: [
      `[human] 待人工步骤：为 unit "${unit.unitId}" 提交 spec（当前 created，尚无 spec）`,
      `[human]   1. 读任务书：cat ${unit.briefRef}`,
      "[human]   2. 写 spec.json，字段骨架（类型契约见 src/events/types.ts）：",
      `[human]      ${SPEC_SKELETON}`,
      "[human]      规则：验收非空；core 用例 type 须 e2e-real/e2e-mock 且带可执行 command；至少一条 unit 级用例",
      `[human]   3. cw evidence submit --kind spec --unit ${unit.unitId} --file spec.json`,
      `[human]   4. cw review submit --unit ${unit.unitId} --verdict-kind spec-review --verdict pass --role reviewer`,
      "[human]   （human 模式无自动 reviewer：你扮演 reviewer——这是信任边界；spec 入账与审查通过后 unit 进入 spec-frozen）",
    ],
  };
}

function specReviewInstruction(unit: SequencedUnitProjection): StepInstruction {
  return {
    kind: "spec-review",
    unitId: unit.unitId,
    lines: [
      `[human] 待人工步骤：为 unit "${unit.unitId}" 补 spec-review（spec 已提交，状态仍 created——尚未通过 spec 审查）`,
      `[human]   cw review submit --unit ${unit.unitId} --verdict-kind spec-review --verdict pass --role reviewer`,
      `[human]   （若 spec 需要修改：改 spec.json 后重新 cw evidence submit --kind spec --unit ${unit.unitId} --file spec.json，再审查）`,
    ],
  };
}

function buildInstruction(unit: SequencedUnitProjection): StepInstruction {
  return {
    kind: "build",
    unitId: unit.unitId,
    lines: [
      `[human] 待人工步骤：为 unit "${unit.unitId}" 实现并提交 build 证据（当前 spec-frozen）`,
      "[human]   1. 在仓库完成实现并 git commit（取 hash：git rev-parse HEAD）",
      `[human]   2. cw evidence submit --kind build --unit ${unit.unitId} --commit <hash> --run-id <自拟唯一 runId>`,
      `[human]   3. cw verify --unit ${unit.unitId}`,
    ],
  };
}

function execReviewInstruction(unit: SequencedUnitProjection): StepInstruction {
  return {
    kind: "exec-review",
    unitId: unit.unitId,
    lines: [
      `[human] 待人工步骤：为 unit "${unit.unitId}" 提交 exec-review（当前 verified）`,
      // rv-2 起 exec-review 必填 --evidence-refs（≥1 个已入账 runId；可用 runId 见
      // cw report --unit 的输出）——mx-1 随本单元补齐此命令模板，照抄执行不再被
      // refs 校验卡住
      `[human]   cw review submit --unit ${unit.unitId} --verdict-kind exec-review --verdict pass --role reviewer --evidence-refs <已入账 runId,...>`,
    ],
  };
}

function createInstruction(rootId: string, pending: readonly SplitEntry[]): StepInstruction {
  return {
    kind: "create",
    unitId: rootId,
    lines: [
      `[human] 待人工步骤：root "${rootId}" 的 spec 声明了 ${pending.length} 个尚未创建的子 unit——先创建它们：`,
      ...pending.map(
        (entry) =>
          `[human]   cw create --id ${entry.unitId} --brief ${entry.briefRef ?? "<自建 brief 文件路径>"} --parent ${rootId}`,
      ),
    ],
  };
}

/** build/exec-review 目标排序：root 排其子 unit 之后（子的产出是 root 验收的输入，收尾步骤子优先） */
function rootLast(subtree: readonly SequencedUnitProjection[], rootId: string): SequencedUnitProjection[] {
  const root = subtree.find((unit) => unit.unitId === rootId);
  const rest = subtree.filter((unit) => unit.unitId !== rootId);
  return root === undefined ? rest : [...rest, root];
}

/**
 * 找 root 子树内最需人工的一步（纯函数）。优先级 = 验收文档循环逻辑的步骤序：
 * split 待 create（步骤 7，文档限定「步骤 1 前」）→ spec（1）→ build（2）→
 * exec-review（3)；「created 且已有 spec」（spec 已提交未过审）以 spec-review
 * 补齐指令闭环——否则人在 evidence submit 与 review submit 两步之间停下时，
 * 循环会对着仍为 created 的 unit 空转到 max-idle，与 human 降级语义矛盾。
 *
 * 同步骤下多 unit 待办时的目标选择：
 *   - spec / spec-review 按创建序（root 先——root 的 spec 声明 split，是子 unit
 *     存在的前提）；
 *   - build / exec-review 按 unit 生命周期收尾（rootLast 序，步骤由该 unit 自身
 *     状态决定）：子 unit 未走完四态前不推进 root——子的产出是 root 验收的输入，
 *     全局「先全部 build 再全部 exec-review」会让 root 在子未 closed 时就 verify。
 */
export function buildStepInstruction(
  projection: SequencedProjection,
  rootId: string,
): StepInstruction {
  mustGetUnit(projection, rootId);
  const subtree = subtreeUnitIds(projection, rootId)
    .map((id) => mustGetUnit(projection, id));

  const pending = pendingSplitEntries(projection, rootId);
  if (pending.length > 0) {
    return createInstruction(rootId, pending);
  }

  const noSpec = subtree.find((unit) => unit.specs.length === 0);
  if (noSpec !== undefined) {
    return specInstruction(noSpec);
  }

  const awaitingReview = subtree.find((unit) => unitStatus(unit) === "created");
  if (awaitingReview !== undefined) {
    return specReviewInstruction(awaitingReview);
  }

  for (const unit of rootLast(subtree, rootId)) {
    const status = unitStatus(unit);
    if (status === "spec-frozen") {
      return buildInstruction(unit);
    }
    if (status === "verified") {
      return execReviewInstruction(unit);
    }
  }

  return { kind: "none", unitId: null, lines: [] };
}

/** 快照行（验收文档循环逻辑 4 锁定格式；none 显示为「无」） */
export function renderSnapshotLine(
  rootId: string,
  rootStatus: UnitStatus,
  kind: StepKind,
  ts: string,
): string {
  const stepText = kind === "none" ? "无" : kind;
  return `[human] ${ts} root=${rootId} 状态=${rootStatus} 待人工步骤=${stepText}`;
}

/** root closed 的汇总行（验收文档循环逻辑 6：各 unit 状态 + verify 结果 + cw report 提示） */
export function renderSummaryLines(projection: SequencedProjection, rootId: string): string[] {
  const ids = subtreeUnitIds(projection, rootId);
  const rows = ids.map((id) => {
    const unit = mustGetUnit(projection, id);
    const lastVerify =
      unit.verifyRuns.length > 0 ? unit.verifyRuns[unit.verifyRuns.length - 1].result : "-";
    return `[human]   ${id}  ${unitStatus(unit)}  lastVerify:${lastVerify}`;
  });
  return [
    `[human] root "${rootId}" 已 closed——human 循环结束（exit 0）。汇总（root 子树 ${ids.length} 个 unit）：`,
    ...rows,
    `[human] 证据链详情：cw report（全量）或 cw report --unit ${rootId}`,
  ];
}

// ---- 循环主体（只读账本 + 打印 + 轮询；唯一的写操作是人照指令调 CLI） ----

export interface HumanLoopOptions {
  /** 账本定位的工作目录（CLI 语义：cwd 是权威工作目录） */
  cwd: string;
  rootId: string;
  /** 轮询间隔 ms（--poll-ms，默认由 run.ts 给 5000） */
  pollMs: number;
  /** 账本无变化的空闲上限 ms（--max-idle-ms，默认由 run.ts 给 30min） */
  maxIdleMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emit(lines: readonly string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** 无进展终止的错误信息（exit 1；含恢复动作，规则：错误指向下一步） */
function idleFailureMessage(rootId: string, maxIdleMs: number, totalEvents: number): string {
  return (
    `cw run: root "${rootId}" 超过 ${maxIdleMs}ms 无进展（无人按指令操作，账本 totalEvents 停在 ${totalEvents}）。` +
    `恢复动作：按上方最后打印的指令组手工执行，或先 cw status 查看现状；操作完成后重新运行 cw run --root ${rootId} 继续。`
  );
}

/**
 * human 调度循环：每轮装载账本 → 打印快照行 + 指令组 → 等 poll → 检查进展。
 * 终止三出口：root closed → 汇总 exit 0；超 max-idle 无进展 → exit 1；
 * Ctrl-C 进程终止（账本即状态，无内存态残留，重跑即续）。
 */
export async function runHumanLoop(opts: HumanLoopOptions): Promise<number> {
  process.stdout.write(
    `[human] 循环启动：root=${opts.rootId} poll=${opts.pollMs}ms max-idle=${opts.maxIdleMs}ms（Ctrl-C 随时中断，重跑即续）\n`,
  );
  let lastTotalEvents = -1;
  let lastProgressAt = Date.now();
  while (true) {
    const { projection } = loadLedger(opts.cwd);
    const root = projection.units.get(opts.rootId);
    if (root === undefined) {
      // append-only 账本里 UnitCreated 不会消失；走到这里说明账本被外部改动
      process.stderr.write(
        `cw run: root "${opts.rootId}" 在循环中途从账本消失（账本被外部改动？）。` +
          `恢复动作：cw status 查看现存 unit 后重新运行 cw run --root <id>。\n`,
      );
      return 1;
    }

    const rootStatus = unitStatus(root);
    const ts = new Date().toISOString();
    if (rootStatus === "closed") {
      emit([renderSnapshotLine(opts.rootId, rootStatus, "none", ts)]);
      emit(renderSummaryLines(projection, opts.rootId));
      return 0;
    }

    const step = buildStepInstruction(projection, opts.rootId);
    emit([renderSnapshotLine(opts.rootId, rootStatus, step.kind, ts)]);
    if (step.lines.length > 0) {
      emit(step.lines);
    }

    await sleep(opts.pollMs);

    const totalEvents = loadLedger(opts.cwd).projection.totalEvents;
    if (totalEvents !== lastTotalEvents) {
      lastTotalEvents = totalEvents;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= opts.maxIdleMs) {
      process.stderr.write(`${idleFailureMessage(opts.rootId, opts.maxIdleMs, totalEvents)}\n`);
      return 1;
    }
  }
}
