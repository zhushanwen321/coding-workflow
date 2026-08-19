/**
 * human 适配器（AgentSpawnAdapter 实现）——u6b 验收文档
 * docs/rewrite/acceptance/u6b-acceptance.md 锁定；canon《design-child-spawn.md》§5.1
 * （human 适配器输出形态：打印人肉指令 + 轮询账本视为完成）。
 *
 * 与 u6a lifecycle 的语义差异：human 无子进程——spawn() 的「产物」是指令清单自身
 * （写入 stdoutPath 并同步打印到控制台），wait() 轮询账本把「该 unit 出现 role
 * 对应进展事件」视为完成，kill() = 手动中止（无进程可杀，按四态定义归 CRASH，
 * 不归 TIMEOUT——不污染 runner 的连续超时计数）。
 *
 * 与 src/runner/human-loop.ts（u5b，M0 human 模式，只读 import 禁改）的复用关系
 * （验收文档要求注明差异）：其导出的指令生成入口 buildStepInstruction 是「root
 * 子树状态导航」——按账本投影在 create/spec/build/exec-review 中选最需人工的一步，
 * 目标 unit 与步骤由账本现状决定；本适配器的指令是「派发定点」——unit 与 role 由
 * AgentSpawnRequest 给定，与账本现状无关（spawn 时该 unit 可能尚无任何进展事件）。
 * 输入域不同，既有导出无法直接复用；指令行内容以其模块私有的 specInstruction /
 * buildInstruction / execReviewInstruction 为蓝本写定点变体，差异三点：
 *   1. 入参 SequencedUnitProjection → AgentSpawnRequest（briefPath 由派发方显式
 *      传递，human-loop 从投影取 briefRef）；
 *   2. 去掉「当前 created，尚无 spec」等状态注记（本适配器不读账本状态）；
 *   3. 头部补 cd <workdir> 与每条 cw 命令的内联 CW_PROJECT_DIR="<projectCwd>"
 *      前缀（human-loop 的指令在其自身 cwd 语义下执行；spawn 派发的指令可能在
 *      任意终端执行，工作区与账本锚定都必须显式给出——wt-2 起 workdir 是 unit
 *      worktree，cw 命令不带该前缀会定位到 worktree 编码下的空账本。用内联
 *      前缀而非 export 行：export 一次性设环境依赖 shell 状态，换终端/重开会话
 *      即失效，内联前缀每条命令自证锚定、无状态依赖——D3 口径）。
 * 路径渲染规则：一律双引号包裹（POSIX/macOS 路径含 " 非法，不另设转义）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DiscriminatedEvent, LedgerEvent } from "../../events/types.js";
import { EventLedger } from "../../store/events-log.js";
import { getCwHome, ledgerPath } from "../../store/project.js";
import type {
  AgentRole,
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "./types.js";

/** wait() 轮询间隔上限（验收文档锁定公式 min(1000, timeoutMs/10)） */
const POLL_INTERVAL_CEILING_MS = 1_000;
const POLL_INTERVAL_DIVISOR = 10;

/** 「该 unit 有进展」的账本事件匹配器（入参为判别联合视图，payload 按 type 窄化） */
type ProgressMatcher = (event: DiscriminatedEvent, req: AgentSpawnRequest) => boolean;

/**
 * role → wait() 的完成信号匹配器。完成信号与任务书最后一步对齐（提前 resolve
 * 会让 loop 在任务未完成时重算重派，最后一步永远无人执行）：
 *   - designer：mx-1 后全部任务书的完成信号 = 自己的产出事件——首派 / specFix
 *     修 spec 重提 = SpecSubmitted（过审由独立 reviewer spawn 接手）；补建子
 *     （fx-3 R5.3）= UnitCreated 且 parentId === 本 unit（事件的 unitId 是新建
 *     子、parentId 才指向本 unit——按 parent 维度匹配）。spec-review verdict
 *     一律归 reviewer spawn——designer 遇 VerdictSubmitted 不结算（mx-1：designer
 *     不自审，verdict 不是 designer 任务书的完成信号）。
 *   - developer：任务书共 3 步，最后一步 cw verify 产出 VerifyRan——若按第 2 步
 *     的 EvidenceSubmitted 判完成，第 3 步 verify 无人执行。
 *   - reviewer：任务书唯一产出 = VerdictSubmitted（spec-review 与 exec-review
 *     两形态共用——loop 按 frontier 维度选择任务书，完成信号同类）。
 */
const PROGRESS_MATCHERS: Record<AgentRole, readonly ProgressMatcher[]> = {
  designer: [
    (event, req) => event.type === "SpecSubmitted" && event.payload.unitId === req.unitId,
    (event, req) => event.type === "UnitCreated" && event.payload.parentId === req.unitId,
  ],
  developer: [
    (event, req) => event.type === "VerifyRan" && event.payload.unitId === req.unitId,
  ],
  reviewer: [
    (event, req) => event.type === "VerdictSubmitted" && event.payload.unitId === req.unitId,
  ],
};

/**
 * 信任边界提示（三 role 共用）：mx-1 起 spec-review / exec-review 由独立的
 * reviewer 派发承载（本指令之外会单独打印 reviewer 指令）——你作为 designer /
 * developer 不自审；reviewer 指令的执行者仍是你时，审查责任在人（human 无自动
 * agent，这是 human 模式的固有边界）
 */
function trustBoundaryLine(): string {
  return "[human] 信任边界：review 结论由独立的 reviewer 派发指令提交（mx-1：designer/developer 不自审）——human 无自动 reviewer，执行 reviewer 指令的人自任审查者";
}

/**
 * cw 命令的内联账本锚定前缀（D3）：人的 shell 没有 spawn 注入的 env，每条 cw
 * 命令自带 CW_PROJECT_DIR 前缀——无 shell 状态依赖，换终端/重开会话不失效。
 */
function cwCommand(req: AgentSpawnRequest, args: string): string {
  return `CW_PROJECT_DIR="${req.projectCwd}" cw ${args}`;
}

/** role 定点操作步骤（蓝本与差异见文件头注释；cw 命令一律带内联锚定前缀） */
function roleStepLines(req: AgentSpawnRequest): string[] {
  switch (req.role) {
    case "designer":
      // mx-1：不含任何 review submit 步骤——spec-review 由独立 reviewer spawn
      // 提交（designer 自审是本单元修复的 critical 缺陷，指令区同步删除）
      return [
        "[human]   1. 写 spec.json（字段契约见 src/events/types.ts；验收非空，core 用例须 e2e 级且带可执行 command）",
        `[human]   2. ${cwCommand(req, `evidence submit --kind spec --unit ${req.unitId} --file spec.json`)}`,
        "[human]   （spec 入账即完成——spec-review 由独立 reviewer 在下轮接手，无需自审）",
      ];
    case "developer":
      return [
        "[human]   1. 按 brief 完成实现并 git commit（取 hash：git rev-parse HEAD）",
        `[human]   2. ${cwCommand(req, `evidence submit --kind build --unit ${req.unitId} --commit <hash> --run-id <自拟唯一 runId> --file <产物路径>`)}`,
        `[human]   3. ${cwCommand(req, `verify --unit ${req.unitId}`)}`,
      ];
    case "reviewer":
      return [
        `[human]   1. 审查该 unit 的 spec / 实现 / 证据（可先 ${cwCommand(req, `report --unit ${req.unitId}`)}；spec 原文副本见 evidence 目录 attachments/）`,
        `[human]   2. spec-review 形态（spec 待审）：${cwCommand(req, `review submit --unit ${req.unitId} --verdict-kind spec-review --verdict pass|fail --role reviewer --comment <依据>`)}`,
        "[human]      （fail 时 --comment 逐条列出不合格项与恢复动作——它是 designer 修 spec 任务书的失败事实来源）",
        `[human]   3. exec-review 形态（verified 未 closed）：${cwCommand(req, `review submit --unit ${req.unitId} --verdict-kind exec-review --verdict pass|fail --role reviewer --comment <意见> --evidence-refs <已入账 runId,...>`)}`,
      ];
    default: {
      const _exhaustive: never = req.role;
      throw new Error(`humanAdapter: 未知 role：${String(_exhaustive)}`);
    }
  }
}

/** 指令清单全文：定位（cd/账本锚定/cat）+ role 步骤 + 信任边界 */
function renderInstructionLines(req: AgentSpawnRequest): string[] {
  return [
    `[human] ${req.role} 指令：unit "${req.unitId}"（human 适配器——无自动 agent，由人执行）`,
    `[human]   cd "${req.workdir}"`,
    `[human]   cat "${req.briefPath}"`,
    ...roleStepLines(req),
    trustBoundaryLine(),
  ];
}

/**
 * 读项目账本（wt-2 D3：锚定 req.projectCwd 而非 req.workdir）的全部事件。
 * CW_HOME 优先取 req.env，空串视为未设置——与 getCwHome 的语义一致（env 隔离
 * 不经 process.env，无全局副作用）。workdir 是 unit worktree，其 cwd 编码下的
 * 账本为空——轮询若读它将永远等不到完成信号（wt-2 必改点）。
 * 读取异常（损坏行等持久错误）返回空数组：本轮视为无进展继续轮询，不中止等待；
 * 持续无法读取最终由超时出口收敛（TIMEOUT 可重派）。
 */
function readLedgerEvents(req: AgentSpawnRequest): LedgerEvent[] {
  const envHome = req.env?.CW_HOME;
  const cwHome = envHome !== undefined && envHome !== "" ? envHome : getCwHome();
  const path = ledgerPath(cwHome, req.projectCwd);
  if (!existsSync(path)) {
    return [];
  }
  try {
    return new EventLedger(path).readAll();
  } catch {
    return [];
  }
}

/**
 * 「新」完成信号的判定基线：spawn 时账本内已见的最高事件 seq。append-only
 * 账本的 seq 单调递增，是「spawn 之后新入账」的精确判据（mx-1 前用事件 ts >
 * spawn 起始时刻判定——ms 精度下「同一毫秒内入账的进展事件」被永久排除：
 * reviewer spawn 后人毫秒级响应提交 verdict 时 adapter 永不结算，在 mx-1
 * 派发 gate（同 unit 在飞缓派）下升级为整 unit 永久停摆，实测复现）。
 */
function maxEventSeq(events: readonly LedgerEvent[]): number {
  let max = 0;
  for (const record of events) {
    if (record.seq > max) {
      max = record.seq;
    }
  }
  return max;
}

/** 该 unit 是否已出现 role 对应的「新」完成信号（seq 晚于 spawn 基线才算——旧事件不触发） */
function hasProgressSince(req: AgentSpawnRequest, baselineSeq: number): boolean {
  const matchers = PROGRESS_MATCHERS[req.role];
  return readLedgerEvents(req).some((record) => {
    if (record.seq <= baselineSeq) {
      return false;
    }
    const event = record as DiscriminatedEvent;
    return matchers.some((match) => match(event, req));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const humanAdapter: AgentSpawnAdapter = {
  name: "human",
  async spawn(req: AgentSpawnRequest): Promise<SpawnHandle> {
    const startedAt = Date.now();
    // 完成信号基线 = spawn 时已见的最高事件 seq（旧事件不触发；同毫秒新入账的
    // 事件不再被 ms 粒度误排除——见 maxEventSeq 注释）
    const baselineSeq = maxEventSeq(readLedgerEvents(req));
    // fx-4：产物根 = req.artifactDir（run 级 topic 目录），workdir 不再承载 cw 文件
    const stdoutPath = join(req.artifactDir, `${req.unitId}.${req.role}.stdout`);
    const stderrPath = join(req.artifactDir, `${req.unitId}.${req.role}.stderr`);

    mkdirSync(req.artifactDir, { recursive: true });
    const lines = renderInstructionLines(req);
    // append：同 unit+role 重派不覆盖前次指令（与 u6a lifecycle 的产物约定一致）
    writeFileSync(stdoutPath, `${lines.join("\n")}\n\n`, { flag: "a" });
    // human 无 stderr：空文件占位，保证证据链产物路径完整
    writeFileSync(stderrPath, "", { flag: "a" });
    // 指令的消费端是人：文件落盘之外同步打印到控制台
    process.stdout.write(`${lines.join("\n")}\n`);

    const pollIntervalMs = Math.max(
      1,
      Math.min(POLL_INTERVAL_CEILING_MS, Math.floor(req.timeoutMs / POLL_INTERVAL_DIVISOR)),
    );

    let settled = false;
    let resolveResult!: (result: SpawnResult) => void;
    const resultPromise = new Promise<SpawnResult>((resolve) => {
      resolveResult = resolve;
    });
    let waitPromise: Promise<SpawnResult> | null = null;

    /** 出口唯一收口（幂等：kill / 进展 / 超时竞争时第一个到达者生效） */
    function settle(exitCode: SpawnResult["exitCode"]): void {
      if (settled) {
        return;
      }
      settled = true;
      // human 无子进程，pid 无处可指：-1 = 不适用（与 lifecycle/pi 适配器的占位语义
      // 一致）。不用 process.pid——那是 runner 自身 pid，会把诊断指向 runner 自己
      resolveResult({ exitCode, stdoutPath, stderrPath, pid: -1 });
    }

    // 轮询协程：进展事件 → exitCode 0；到 timeoutMs → TIMEOUT。
    // kill() 抢先 settle 后，循环在下一轮 while 条件检查处退出（「置停止标志」的落点）
    void (async () => {
      while (!settled) {
        if (hasProgressSince(req, baselineSeq)) {
          settle(0);
          return;
        }
        if (Date.now() - startedAt >= req.timeoutMs) {
          settle("TIMEOUT");
          return;
        }
        await sleep(pollIntervalMs);
      }
    })();

    return {
      wait: () => (waitPromise ??= resultPromise),
      // 手动中止：人肉无进程可杀——置停止标志（settled）并立即以 CRASH 收口，
      // wait() 无需等当前轮询 sleep 结束即 resolve
      kill: () => settle("CRASH"),
    };
  },
};
