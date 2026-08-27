/**
 * pipeline 状态查询（design-release-pipeline.md D6/D8，W2）——`cw pipeline status`
 * 的核心库：manifest 步骤清单 × fold 投影 → 每步 pass✓/fail✗/pending 三态。
 *
 * 与 run.ts 共享 manifest 加载（manifestSha256 分组口径一致：manifest 变更后
 * 旧记录自然不参与投影）。
 */
import { foldGate, pipelineStepKey } from "../gate/fold.js";
import { EventLedger } from "../store/events-log.js";
import { existsSync } from "node:fs";
import { gateLedgerPath } from "../store/project.js";
import { gateLedgerDomain } from "../gate/domain.js";
import { loadManifest, pipelineIdOf } from "./manifest.js";
import { PipelineManifestError } from "./manifest.js";

export interface StepStatus {
  name: string;
  state: "pass" | "fail" | "pending";
  /** 最近一次该步骤执行的 viaCache 标注（pending 时无） */
  viaCache?: boolean;
  /** 最近一次该步骤执行耗时（ms；pending 时无） */
  durationMs?: number;
  /** 最近一次入账 seq（pending 时无；审计定位用） */
  seq?: number;
}

export interface PipelineStatusResult {
  pipeline: string;
  manifestSha256: string;
  steps: StepStatus[];
}

export function pipelineStatus(opts: {
  cwHome: string;
  cwd: string;
  manifestPath: string;
}): PipelineStatusResult {
  if (!existsSync(opts.manifestPath)) {
    throw new PipelineManifestError(`pipeline manifest 不存在（"${opts.manifestPath}"）。`);
  }
  const { manifest, manifestSha256 } = loadManifest(opts.manifestPath);
  const pipeline = pipelineIdOf(opts.manifestPath);

  const ledgerPath = gateLedgerPath(opts.cwHome, opts.cwd);
  const events = existsSync(ledgerPath) ? new EventLedger(ledgerPath, gateLedgerDomain).readAll() : [];
  const projection = foldGate(events);

  const steps: StepStatus[] = manifest.steps.map((step) => {
    const key = pipelineStepKey(pipeline, manifestSha256, step.name);
    const latest = projection.latestStepRun.get(key);
    if (latest === undefined) {
      return { name: step.name, state: "pending" as const };
    }
    return {
      name: step.name,
      state: latest.payload.result,
      ...(latest.payload.viaCache === true ? { viaCache: true } : {}),
      ...(latest.payload.durationMs !== undefined ? { durationMs: latest.payload.durationMs } : {}),
      seq: latest.seq,
    };
  });
  return { pipeline, manifestSha256, steps };
}
