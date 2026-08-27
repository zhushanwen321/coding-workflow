/**
 * `cw pipeline run` / `cw pipeline status`（design-release-pipeline.md D6/D8，W2）。
 *
 * 职责边界：本层只做参数解析、CW_HOME/项目目录定位与人类可读输出；manifest
 * 校验、投影续接、viaCache、记账全部在 src/pipeline/ 核心库。
 *
 *   - run：`cw pipeline run [--manifest <路径>] [--base <ref>]`（缺省 manifest =
 *     <cwd>/.cw-pipeline.json）。exit 0 全 pass（含跳过）/ 1 有步骤 fail 或
 *     manifest 缺失 / 2 环境错误。
 *   - status：`cw pipeline status [--manifest <路径>] [--json]`。步骤三态清单（✓/✗/pending
 *     + viaCache/耗时标注）；`--json` 直出 PipelineStatusResult 结构体供机器消费方
 *     （D8 命令面声明，形态对齐 gate query 的 --json 先例：缺省人类可读）。
 */
import type { CommandContext } from "../dispatch.js";
import { PipelineEnvironmentError, runPipeline } from "../pipeline/run.js";
import { PipelineManifestError } from "../pipeline/manifest.js";
import { pipelineStatus } from "../pipeline/status.js";
import { getCwHome } from "../store/project.js";
import { stringArg } from "./common.js";

/** 环境错误 exit（对齐 gate.ts / cijudge.ts） */
const ENV_ERROR_EXIT = 2;
/** manifest 缺失/非法的 exit（任务书口径：调用方可与「步骤 fail」区分） */
const MANIFEST_ERROR_EXIT = 1;
/** 缺省 manifest 文件名（项目仓根声明） */
const DEFAULT_MANIFEST = ".cw-pipeline.json";

function manifestPathOf(ctx: CommandContext): string {
  const explicit = stringArg(ctx.argv, "manifest");
  return explicit ?? `${ctx.cwd.replace(/\/$/, "")}/${DEFAULT_MANIFEST}`;
}

export async function handlePipelineRun(ctx: CommandContext): Promise<number> {
  const manifestPath = manifestPathOf(ctx);
  const baseRef = stringArg(ctx.argv, "base");
  try {
    const result = runPipeline({
      cwHome: getCwHome(),
      cwd: ctx.cwd,
      manifestPath,
      ...(baseRef !== undefined ? { baseRef } : {}),
    });
    process.stdout.write(
      `pipeline 完成：${result.ran} 执行 / ${result.skipped} 跳过（投影续接，已 pass 不重做）` +
        `${result.failedStep !== undefined ? `；失败步骤：${result.failedStep}` : ""}\n`,
    );
    return result.exitCode;
  } catch (e) {
    if (e instanceof PipelineManifestError) {
      process.stderr.write(`cw pipeline run: ${e.message}\n`);
      return MANIFEST_ERROR_EXIT;
    }
    if (e instanceof PipelineEnvironmentError) {
      process.stderr.write(`cw pipeline run: ${e.message}\n`);
      return ENV_ERROR_EXIT;
    }
    throw e;
  }
}

export async function handlePipelineStatus(ctx: CommandContext): Promise<number> {
  const manifestPath = manifestPathOf(ctx);
  try {
    const status = pipelineStatus({ cwHome: getCwHome(), cwd: ctx.cwd, manifestPath });
    // D8 [--json]：结构化直出（PipelineStatusResult），机器消费方契约；缺省走人类可读。
    // 形态对齐 gate query：JSON.stringify(status, null, 2) + 尾换行，错误面不产出假 JSON。
    if (ctx.argv["json"] === true) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }
    const lines = status.steps.map((s) => {
      const mark = s.state === "pass" ? "✓" : s.state === "fail" ? "✗" : "pending";
      const via = s.viaCache === true ? "（cache 命中）" : "";
      const dur = s.durationMs !== undefined ? ` ${(s.durationMs / 1000).toFixed(1)}s` : "";
      const seq = s.seq !== undefined ? ` #${s.seq}` : "";
      return `  ${mark} ${s.name}${via}${dur}${seq}`;
    });
    process.stdout.write(
      `pipeline "${status.pipeline}"（manifest ${status.manifestSha256.slice(0, 8)}…）：\n${lines.join("\n")}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof PipelineManifestError) {
      process.stderr.write(`cw pipeline status: ${e.message}\n`);
      return MANIFEST_ERROR_EXIT;
    }
    throw e;
  }
}
