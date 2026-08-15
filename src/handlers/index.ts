import type { CommandEntry } from "../dispatch.js";
import { handleCreate } from "./create.js";
import { handleEvidenceSubmit } from "./evidence-submit.js";
import { handleReviewSubmit } from "./review-submit.js";

/** 写命令域注册表（u2 交付：create / evidence submit / review submit；verify 属 u4a） */
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
];
