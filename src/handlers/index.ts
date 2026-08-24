import type { CommandEntry } from "../dispatch.js";
import { handleCreate } from "./create.js";
import { handleEvidenceSubmit } from "./evidence-submit.js";
import { handleCiJudge } from "./cijudge.js";
import { handleGateQuery, handleGateStats, handleGateWrap } from "./gate.js";
import { handleReviewSubmit } from "./review-submit.js";
import { handleRun } from "./run.js";
import { handleSetupAgentDir } from "./setup-agent-dir.js";
import { handleVerify } from "./verify.js";

/** 写命令域注册表（u2 交付：create / evidence submit / review submit；verify 属 u4a；run 属 u5b） */
export const commands: CommandEntry[] = [
  {
    name: "create",
    handler: handleCreate,
    summary: "创建 unit（--id slug + --brief 任务书路径，可选 --parent 挂到已有根 unit）",
  },
  {
    name: "evidence submit",
    handler: handleEvidenceSubmit,
    summary: "提交证据（--kind spec 附 spec.json；--kind build 附 commit/runId/产物路径）",
  },
  {
    name: "review submit",
    handler: handleReviewSubmit,
    summary: "提交审查结论（--verdict-kind spec-review|exec-review × --verdict pass|fail）",
  },
  {
    name: "run",
    handler: handleRun,
    summary:
      "runner 调度循环（--root <id>，M0 仅 human 后端：打印每步人该执行的指令，轮询账本推进至 root closed）",
  },
  {
    name: "verify",
    handler: handleVerify,
    summary: "干净重跑验证（--unit <id> [--timeout-ms <n>]，checkout 冻结 commit 重跑验收）",
  },
  {
    name: "setup-agent-dir",
    handler: handleSetupAgentDir,
    summary:
      "建受控 agentDir（默认 ~/.cw/agent-dir，--agent-dir 覆盖；装 ask-user 扩展 + manifest + 启动探针）",
  },
  {
    name: "gate wrap",
    handler: handleGateWrap,
    summary:
      "gate check 包装执行（--check 名 --base ref [--scope 路径...] [--run-id id] [--timeout-ms n] -- 命令；命中跳过重跑，exit 0/1/2 三态）",
  },
  {
    name: "gate query",
    handler: handleGateQuery,
    summary: "查 gate 缓存 pass 条目（[--check 名] [--base ref] [--json]，只读）",
  },
  {
    name: "gate stats",
    handler: handleGateStats,
    summary: "gate check 计时聚合（真实执行耗时分组，只读；空账本输出空形态）",
  },
  {
    name: "ci-judge",
    handler: handleCiJudge,
    summary:
      "CI 失败判定（<run-id> --base <prBase> [--already-rerun]：import 闭包归属 → flaky rerun 恰一次 / 真回归证据链 / 两轮 flaky 转人工）",
  },
];
