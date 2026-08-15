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
 *   3. 头部补 cd <workdir>（human-loop 的指令在其自身 cwd 语义下执行；spawn 派发
 *      的指令可能在任意终端执行，workdir 必须显式给出）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LedgerEvent } from "../../events/types.js";
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

/** role → 视为「该 unit 有进展」的账本事件类型（wait() 的轮询匹配目标） */
const PROGRESS_EVENT: Record<
  AgentRole,
  "SpecSubmitted" | "EvidenceSubmitted" | "VerdictSubmitted"
> = {
  designer: "SpecSubmitted",
  builder: "EvidenceSubmitted",
  reviewer: "VerdictSubmitted",
};

/** 信任边界提示（三 role 共用）：human 无自动 reviewer，执行者自任审查者 */
function trustBoundaryLine(): string {
  return "[human] 信任边界：human 适配器无自动 reviewer——你自任 reviewer（human 模式的审查责任由人承担）";
}

/** role 定点操作步骤（蓝本与差异见文件头注释） */
function roleStepLines(req: AgentSpawnRequest): string[] {
  switch (req.role) {
    case "designer":
      return [
        "[human]   1. 写 spec.json（字段契约见 src/events/types.ts；验收非空，core 用例须 e2e 级且带可执行 command）",
        `[human]   2. cw evidence submit --kind spec --unit ${req.unitId} --file spec.json`,
        `[human]   3. cw review submit --unit ${req.unitId} --verdict-kind spec-review --verdict pass`,
      ];
    case "builder":
      return [
        "[human]   1. 按 brief 完成实现并 git commit（取 hash：git rev-parse HEAD）",
        `[human]   2. cw evidence submit --kind build --unit ${req.unitId} --commit <hash> --run-id <自拟唯一 runId> --file <产物路径>`,
        `[human]   3. cw verify --unit ${req.unitId}`,
      ];
    case "reviewer":
      return [
        `[human]   1. 审查该 unit 的 spec / 实现 / 证据（可先 cw report --unit ${req.unitId}）`,
        `[human]   2. cw review submit --unit ${req.unitId} --verdict-kind <spec-review|exec-review> --verdict <pass|fail>`,
      ];
    default: {
      const _exhaustive: never = req.role;
      throw new Error(`humanAdapter: 未知 role：${String(_exhaustive)}`);
    }
  }
}

/** 指令清单全文：定位（cd/cat）+ role 步骤 + 信任边界 */
function renderInstructionLines(req: AgentSpawnRequest): string[] {
  return [
    `[human] ${req.role} 指令：unit "${req.unitId}"（human 适配器——无自动 agent，由人执行）`,
    `[human]   cd ${req.workdir}`,
    `[human]   cat ${req.briefPath}`,
    ...roleStepLines(req),
    trustBoundaryLine(),
  ];
}

/**
 * 读 workdir 对应账本的全部事件（cwd 推导账本路径）。CW_HOME 优先取 req.env，
 * 空串视为未设置——与 getCwHome 的语义一致（env 隔离不经 process.env，无全局副作用）。
 * 读取异常（损坏行等持久错误）返回空数组：本轮视为无进展继续轮询，不中止等待；
 * 持续无法读取最终由超时出口收敛（TIMEOUT 可重派）。
 */
function readLedgerEvents(req: AgentSpawnRequest): LedgerEvent[] {
  const envHome = req.env?.CW_HOME;
  const cwHome = envHome !== undefined && envHome !== "" ? envHome : getCwHome();
  const path = ledgerPath(cwHome, req.workdir);
  if (!existsSync(path)) {
    return [];
  }
  try {
    return new EventLedger(path).readAll();
  } catch {
    return [];
  }
}

/** 该 unit 是否已出现 role 对应的「新」进展事件（ts 晚于 spawn 起始才算——旧事件不触发） */
function hasProgressSince(req: AgentSpawnRequest, startedAtMs: number): boolean {
  const progressType = PROGRESS_EVENT[req.role];
  return readLedgerEvents(req).some(
    (event) =>
      event.type === progressType &&
      event.payload.unitId === req.unitId &&
      Date.parse(event.ts) > startedAtMs,
  );
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
    const stdoutPath = join(req.workdir, ".cw-spawn", `${req.unitId}.${req.role}.stdout`);
    const stderrPath = join(req.workdir, ".cw-spawn", `${req.unitId}.${req.role}.stderr`);

    mkdirSync(join(req.workdir, ".cw-spawn"), { recursive: true });
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
      resolveResult({ exitCode, stdoutPath, stderrPath, pid: process.pid });
    }

    // 轮询协程：进展事件 → exitCode 0；到 timeoutMs → TIMEOUT。
    // kill() 抢先 settle 后，循环在下一轮 while 条件检查处退出（「置停止标志」的落点）
    void (async () => {
      while (!settled) {
        if (hasProgressSince(req, startedAt)) {
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
