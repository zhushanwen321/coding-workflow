/**
 * protocol.ts — CLI 协议层（CwParamsSchema 信封 + typebox 校验 + stdin/文件读取 + 参数合并）。
 *
 * 职责：
 *   - CwParamsSchema 信封定义（StringEnum → Type.Union，#5 方案A）
 *   - typebox 校验（复用 plan-parser 的业务 schema，#6 方案A）
 *   - stdin / --xxx-file 双通道读取（#4 方案A：stdin 优先，文件 fallback，冲突报错）
 *   - 参数合并（argv + stdin/file JSON → CwParams）
 *   - resolveDbPath（~/.cw/<encoded-cwd>/_cw.json，#3 方案A）
 *   - worktree cwd 防护（.cw-wt/ 检测，C-3）
 *
 * Level 1 接线：
 *   - parseParams → readJsonInput + validateParams
 *   - validateParams → Value.Check(CwParamsSchema)
 *   - resolveDbPath → encodeCwd + .cw-wt/ 检测
 *   - readJsonInput → stdin TTY 检测 + readFileSync fallback
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { encodeCwd } from "../engine/path-encoding.js";
import type { CwAction, Tier } from "../engine/types.js";

// ── 常量 ─────────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// ── CwParamsSchema 信封（StringEnum → Type.Union，#5 方案A） ──

export const CwParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("plan"),
    Type.Literal("clarify"),
    Type.Literal("detail"),
    Type.Literal("dev"),
    Type.Literal("test"),
    Type.Literal("retrospect"),
    Type.Literal("closeout"),
    Type.Literal("replan"),
  ]),
  topicId: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
  tier: Type.Optional(Type.Union([Type.Literal("lite"), Type.Literal("mid")])),
  objective: Type.Optional(Type.String()),
  workspacePath: Type.Optional(Type.String()),
  planJson: Type.Optional(Type.Unknown()),
  clarifyJson: Type.Optional(Type.Unknown()),
  detailJson: Type.Optional(Type.Unknown()),
  tasks: Type.Optional(Type.Array(Type.Object({
    waveId: Type.String(),
    commitHash: Type.String(),
  }))),
  cases: Type.Optional(Type.Array(Type.Object({
    caseId: Type.String(),
    actual: Type.Optional(Type.Object({
      url: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
    })),
    screenshotPath: Type.Optional(Type.String()),
    commitHash: Type.Optional(Type.String()),
    claimedStatus: Type.Optional(Type.Union([Type.Literal("passed"), Type.Literal("failed")])),
  }))),
  retrospectPath: Type.Optional(Type.String()),
});

// ── 类型推导 ─────────────────────────────────────────────────

export type CwParams = {
  action: CwAction;
  topicId?: string;
  slug?: string;
  tier?: Tier;
  objective?: string;
  workspacePath?: string;
  planJson?: unknown;
  clarifyJson?: unknown;
  detailJson?: unknown;
  tasks?: Array<{ waveId: string; commitHash: string }>;
  cases?: Array<{
    caseId: string;
    actual?: { url?: string; text?: string };
    screenshotPath?: string;
    commitHash?: string;
    claimedStatus?: "passed" | "failed";
  }>;
  retrospectPath?: string;
};

// ── resolveDbPath（#3 方案A：~/.cw/<encoded-cwd>/_cw.json） ──

/**
 * resolveDbPath — 计算 _cw.json 完整路径。
 *
 * 规则：
 *   1. CW_HOME env 覆盖根目录（默认 ~/.cw/）
 *   2. workspacePath 编码后作为子目录
 *   3. .cw-wt/ 检测：process.cwd() 含 .cw-wt/ 时拒绝 fallback
 *
 * 失败路径：
 *   - CW_HOME 非绝对路径 → throw
 *   - workspacePath 含 .cw-wt/ 且无显式指定 → throw
 */
export function resolveDbPath(workspacePath: string, cwHome?: string): string {
  // 接线：CW_HOME 默认 ~/.cw/
  const home = cwHome ?? join(homedir(), ".cw");

  // 安全校验：CW_HOME 必须绝对路径
  if (!isAbsolute(home)) {
    throw new Error(`CW_HOME 必须是绝对路径，当前值: ${home}`);
  }

  // .cw-wt/ 检测（C-3 worktree cwd 防护，跨平台：/ 和 \ 分隔符）
  if (workspacePath.includes("/.cw-wt/") || workspacePath.includes("\\.cw-wt\\")) {
    throw new Error(
      `workspacePath 包含 .cw-wt/（worktree 目录），拒绝 fallback。` +
      `请显式指定 --workspace 或 CW_WORKSPACE_ROOT env。`
    );
  }

  const encoded = encodeCwd(workspacePath);
  return join(home, encoded, "_cw.json");
}

// ── stdin/文件读取（#4 方案A） ───────────────────────────────

/**
 * readJsonInput — stdin 优先，文件 fallback，同时存在冲突报错。
 *
 * 接线：检测 stdin TTY → fallback 到文件 → readFileSync + JSON.parse。
 * 失败路径：stdin+flag 冲突 → throw；文件不存在 → throw；非 JSON → throw；超大 → throw。
 */
export function readJsonInput(
  flagValue: string | undefined,
  stdinData: string,
  isStdinTTY: boolean,
): unknown {
  const hasStdin = !isStdinTTY && stdinData.trim().length > 0;
  const hasFlag = flagValue !== undefined;

  // 冲突检测：stdin + flag 同时存在
  if (hasStdin && hasFlag) {
    throw new Error("同时提供 stdin 数据和 --xxx-file 参数，冲突。请只用一种方式传 JSON。");
  }

  let raw: string;

  if (hasStdin) {
    // stdin 主通道
    raw = stdinData;
  } else if (hasFlag) {
    // 文件 fallback
    const filePath = resolve(flagValue!);
    if (!existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(`文件大小 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过限制 ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`);
    }
    raw = readFileSync(filePath, "utf-8");
  } else {
    throw new Error("未提供 JSON 输入（stdin 为空且未指定 --xxx-file）");
  }

  // JSON 解析
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── validateParams（typebox 校验） ──────────────────────────

/**
 * validateParams — typebox CwParamsSchema 校验。
 *
 * 接线：Value.Check(CwParamsSchema, raw)。
 * 失败路径：schema 不匹配 → throw ValidationError（含逐条错误信息）。
 */
export function validateParams(raw: unknown): CwParams {
  if (!Value.Check(CwParamsSchema, raw)) {
    const errors = [...Value.Errors(CwParamsSchema, raw)];
    throw new Error(
      `参数校验失败:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n")}`
    );
  }
  return raw as CwParams;
}

// ── parseParams（组合入口） ─────────────────────────────────

/**
 * parseParams — 从 argv + stdin 构造并校验 CwParams。
 *
 * Level 1 接线：构造 raw → readJsonInput（按需）→ 合并 → validateParams → resolveDbPath。
 */
export function parseParams(
  action: CwAction,
  argv: Record<string, unknown>,
  stdinData: string,
  isStdinTTY: boolean,
): CwParams {
  // 接线：构造 raw 参数对象
  const raw: Record<string, unknown> = { action };

  // 映射 argv 到 CwParams 字段
  if (argv.topicId) raw.topicId = String(argv.topicId);
  if (argv.slug) raw.slug = String(argv.slug);
  if (argv.tier) raw.tier = String(argv.tier);
  if (argv.objective) raw.objective = String(argv.objective);
  if (argv.workspace) raw.workspacePath = String(argv.workspace);
  if (argv.retrospectPath) raw.retrospectPath = String(argv.retrospectPath);

  // 大 JSON 字段：按 action 选择 stdin/文件源
  const jsonFieldMap: Record<string, { flag: string; field: string }> = {
    plan: { flag: "plan-json-file", field: "planJson" },
    clarify: { flag: "clarify-json-file", field: "clarifyJson" },
    detail: { flag: "detail-json-file", field: "detailJson" },
    replan: { flag: "plan-json-file", field: "planJson" },
  };

  const mapping = jsonFieldMap[action];
  if (mapping) {
    const flagValue = argv[mapping.flag] ? String(argv[mapping.flag]) : undefined;
    // 也检查内联 --plan-json 等
    const inlineJson = argv[mapping.field.replace("Json", "-json")] ? String(argv[mapping.field.replace("Json", "-json")]) : undefined;
    const effectiveFlag = flagValue ?? (inlineJson ? undefined : undefined);
    const effectiveStdin = inlineJson ?? stdinData;

    raw[mapping.field] = readJsonInput(effectiveFlag, effectiveStdin, isStdinTTY);
  }

  // tasks / cases（dev/test 的 JSON 数组）
  if (argv.tasks) {
    raw.tasks = typeof argv.tasks === "string" ? JSON.parse(String(argv.tasks)) : argv.tasks;
  }
  if (argv.cases) {
    raw.cases = typeof argv.cases === "string" ? JSON.parse(String(argv.cases)) : argv.cases;
  }

  // 接线：validateParams
  return validateParams(raw);
}

