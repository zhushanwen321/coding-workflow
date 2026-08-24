/**
 * `cw ci-judge`（design-release-pipeline.md §3.3 D7，W3：CI 失败 flaky/真回归判定）。
 *
 * 职责边界：本层只做参数解析与 Judgement 的 CLI 呈现；import 闭包（tsc 主路径
 * + dist→src 映射 + 正则兜底）、flaky 决策树、gh 集成全部在 src/gate/ci-judge.ts
 * 核心库（D-014/D-015）。
 *
 * exit 语义（W3 接线决策，无设计原文——判定本身成功即 0）：
 *   - 0 = 判定完成（real-regression / flaky-rerun / flaky-escalate 三 kind 都是
 *     有效判定，kind 经 stdout 结构化输出供调用方分支）
 *   - 2 = 环境错误（gh 不可用 / 日志解析失败 / git 失败——CiJudgeEnvironmentError，
 *     N9 契约：绝不静默降级为 flaky/回归判定）
 *
 * 二轮判定无状态设计（核心库契约）：调用方对同一 run 第二次调用时传
 * --already-rerun，决策树进入 flaky-escalate（出声转人工，stderr）。
 */
import type { CommandContext } from "../dispatch.js";
import {
  CiJudgeEnvironmentError,
  judgeCi,
  type Judgement,
} from "../gate/ci-judge.js";
import { fail, stringArg } from "./common.js";

/** 环境错误 exit（对齐 gate.ts 的 ENV_ERROR_EXIT） */
const ENV_ERROR_EXIT = 2;

/** 用法错误（含完整样例作恢复动作） */
function cijudgeUsage(missing: string): string {
  return (
    `cw ci-judge: ${missing}。` +
    "恢复动作：cw ci-judge <run-id> --base <prBase> [--already-rerun]" +
    "（run-id = 失败的 GitHub Actions run；--base = PR 变更集比对基线 ref）。\n"
  );
}

/** Judgement 三态的 stdout 呈现（evidence 逐行，归属证据链 / rerun 动作 / 转人工） */
function renderJudgement(j: Judgement): void {
  for (const line of j.evidence) {
    process.stdout.write(`  - ${line}\n`);
  }
  switch (j.kind) {
    case "real-regression":
      process.stdout.write(
        `[real-regression] 失败测试的 import 闭包被本 PR 触碰（${j.touchedFiles.join(", ")}），不执行 rerun。\n` +
          `归属证据链如上（${j.affectedTests.length} 个受影响测试）。\n`,
      );
      break;
    case "flaky-rerun":
      process.stdout.write(
        `[flaky] 闭包未被触碰且上轮 pass → 已执行 gh run rerun --failed（恰一次）。\n` +
          "若 rerun 后仍失败，携带 --already-rerun 重跑本命令 → 升级转人工。\n",
      );
      break;
    case "flaky-escalate":
      // D7：两轮 flaky 出声转人工，不自动豁免（防 Goodhart）——stderr 强化信号
      process.stderr.write(
        "[escalate] 同一测试两轮 flaky——出声转人工。不自动豁免、不再 rerun；请人工核对测试稳定性（隔离/资源/时间依赖）。\n",
      );
      break;
    default: {
      const _exhaustive: never = j;
      throw new Error(`cw ci-judge: 未知 kind：${String(_exhaustive)}`);
    }
  }
}

export async function handleCiJudge(ctx: CommandContext): Promise<number> {
  // run-id 取位置参数（argv._[0]）；--base 必填（PR 变更集比对基线）
  const positional = ctx.argv._.map((t) => String(t)).filter((t) => t.length > 0);
  const runId = stringArg(ctx.argv, "run-id") ?? positional[0];
  if (runId === undefined || runId.length === 0) {
    return fail(cijudgeUsage("缺少 <run-id>"));
  }
  const prBase = stringArg(ctx.argv, "base");
  if (prBase === undefined) {
    return fail(cijudgeUsage("缺少 --base <prBase>"));
  }
  const alreadyRerun = ctx.argv["already-rerun"] === true;

  let judgement: Judgement;
  try {
    judgement = judgeCi({
      cwd: ctx.cwd,
      runId,
      prBase,
      alreadyRerun,
    });
  } catch (e) {
    if (e instanceof CiJudgeEnvironmentError) {
      // 核心库错误文案自带恢复动作（N9），本层不改写
      process.stderr.write(`cw ci-judge: ${e.message}\n`);
      return ENV_ERROR_EXIT;
    }
    throw e;
  }

  renderJudgement(judgement);
  return 0;
}
