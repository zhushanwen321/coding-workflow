/**
 * `cw evidence submit`（u2 验收文档锁定的 M0 规格，--kind 区分两种形态）。
 *
 * spec 形态：`--kind spec --unit <id> --file <spec.json>`
 *   校验链 unit 存在 → typebox schema → checkSpecRules（u3）→ 叶子 unit 不得声明
 *   split（fx-1 R1 handler 级防线）→ 全过才 append
 *   SpecSubmitted{specHash = sha256(spec.json 原始字节), acceptance/contracts/split 原样}。
 *   gate 不过不入账（账本只记被接受的进展），stderr 逐条打印 u3 failures 原文。
 *
 * build 形态：`--kind build --unit <id> --commit <hash> --run-id <runId> [--file <path>]...`
 *   unit 存在 → commit 在 cwd git 仓库真实存在 → 每个 --file 存在可读并计算 sha256 →
 *   append EvidenceSubmitted{exitCode: 0}。同 unitId+runId 幂等拒绝由账本层（u1）承担，
 *   handler 透传错误。
 */
import { spawnSync } from "node:child_process";

import type { CommandContext } from "../dispatch.js";
import type {
  EvidenceSubmittedPayload,
  SpecSubmittedPayload,
} from "../events/types.js";
import { checkSpecRules } from "../gates/spec-rules.js";
import {
  fail,
  ledgerForCwd,
  readOrErrno,
  resolveAgainstCwd,
  sha256Hex,
  stringArg,
  stringArrayArg,
  succeed,
  tryAppend,
  unitCreatedFacts,
} from "./common.js";
import { type SpecFile, validateSpecFile } from "./spec-schema.js";

/** git commit hash 白名单：进命令行前先过此校验（注入安全，spawnSync 本身无 shell） */
const COMMIT_HASH_RE = /^[0-9a-f]{6,40}$/;

export async function handleEvidenceSubmit(ctx: CommandContext): Promise<number> {
  const kind = stringArg(ctx.argv, "kind");
  if (kind === undefined) {
    return fail(
      "cw evidence submit: 缺少 --kind <spec|build>。恢复动作：spec 形态用 --kind spec --unit <id> --file <spec.json>；build 形态用 --kind build --unit <id> --commit <hash> --run-id <runId> [--file <路径>]...。",
    );
  }
  if (kind !== "spec" && kind !== "build") {
    return fail(
      `cw evidence submit: 非法 --kind "${kind}"：合法值 spec | build。恢复动作：提交 spec.json 用 --kind spec，提交构建产物用 --kind build。`,
    );
  }

  const unitId = stringArg(ctx.argv, "unit");
  if (unitId === undefined) {
    return fail("cw evidence submit: 缺少 --unit <id>。恢复动作：加 --unit <unitId> 指定目标 unit。");
  }
  const ledger = ledgerForCwd(ctx.cwd);
  const createdFacts = unitCreatedFacts(ledger);
  if (!createdFacts.has(unitId)) {
    return fail(
      `cw evidence submit: unit "${unitId}" 不存在（账本内无其 UnitCreated 事件）。` +
        `恢复动作：先创建该 unit（cw create --id ${unitId} --brief <路径>）再提交证据。`,
    );
  }
  return kind === "spec"
    ? submitSpec(ctx, ledger, unitId, createdFacts.get(unitId)?.parentId ?? null)
    : submitBuild(ctx, ledger, unitId);
}

function submitSpec(
  ctx: CommandContext,
  ledger: ReturnType<typeof ledgerForCwd>,
  unitId: string,
  parentId: string | null,
): number {
  const file = stringArg(ctx.argv, "file");
  if (file === undefined) {
    return fail(
      "cw evidence submit --kind spec: 缺少 --file <spec.json>。恢复动作：加 --file 指向 spec.json（结构 { acceptance, contracts, split }）。",
    );
  }
  const fileAbs = resolveAgainstCwd(ctx.cwd, file);
  const fileRead = readOrErrno(fileAbs);
  if (!fileRead.ok) {
    return fail(
      `cw evidence submit --kind spec: spec 文件不可读（${file}，按 cwd "${ctx.cwd}" 解析为 ${fileAbs}）：${fileRead.errno}。恢复动作：确认路径正确且文件存在可读。`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileRead.raw.toString("utf-8"));
  } catch (e) {
    return fail(
      `cw evidence submit --kind spec: spec 文件不是合法 JSON（${file}）：${e instanceof Error ? e.message : String(e)}。恢复动作：修正为合法 JSON 后重试。`,
    );
  }

  const validation = validateSpecFile(parsed);
  if (!validation.ok) {
    return fail(
      [
        `cw evidence submit --kind spec: spec 文件 schema 校验失败（${file}），具体字段错误：`,
        ...validation.errors.map((e) => `  ${e}`),
        "恢复动作：按上述字段路径修正 spec.json（类型契约见 src/events/types.ts 的 AcceptanceItem/Contract/SplitEntry）。",
      ].join("\n"),
    );
  }
  // validateSpecFile 已做运行时判定，此处窄化读取是受守卫的类型收窄
  const spec: SpecFile = parsed as SpecFile;

  const payload: SpecSubmittedPayload = {
    unitId,
    specHash: sha256Hex(fileRead.raw),
    acceptance: spec.acceptance,
    contracts: spec.contracts,
    split: spec.split,
  };

  const gate = checkSpecRules(payload);
  if (!gate.ok) {
    return fail(
      [
        `cw evidence submit --kind spec: spec gate 未通过（unit "${unitId}"），不入账：`,
        ...gate.failures.map((f) => `  ${f}`),
        "恢复动作：修复上述缺口后重新提交；规则口径见 docs/rewrite/acceptance/u3-acceptance.md。",
      ].join("\n"),
    );
  }

  // fx-1 R1 handler 级防线：叶子 unit（parentId 非空，M0 深度上限 2 无更深分解）
  // 不得声明 split——终验中叶子 designer 抄 root spec 模板未改 split 是死锁直接诱因；
  // gate 规则⑥拦自引用，这里拦叶子的一切 split 声明（含引用其他 unit 的伪内部节点）
  if (parentId !== null && spec.split.length > 0) {
    return fail(
      `cw evidence submit --kind spec: 叶子 unit（深度上限 2）不得声明 split` +
        `（unit "${unitId}" 是 "${parentId}" 的子 unit，spec.split 却声明了 ${spec.split.length} 个条目：` +
        `${spec.split.map((entry) => entry.unitId).join(", ")}）。` +
        "恢复动作：拆分子节点是根 unit spec 的职责，叶子 unit 的 spec.split 应为空数组；修正后重新提交。",
    );
  }

  const result = tryAppend(ledger, "SpecSubmitted", payload);
  if (!result.ok) {
    return fail(result.message);
  }
  return succeed(
    `unit "${unitId}" 的 spec 已入账（specHash ${payload.specHash}，seq ${result.envelope.seq}）。`,
  );
}

function submitBuild(ctx: CommandContext, ledger: ReturnType<typeof ledgerForCwd>, unitId: string): number {
  const commit = stringArg(ctx.argv, "commit");
  if (commit === undefined) {
    return fail(
      "cw evidence submit --kind build: 缺少 --commit <hash>。恢复动作：加 --commit 指向产物对应的 git commit（git rev-parse HEAD 获取）。",
    );
  }
  if (!COMMIT_HASH_RE.test(commit)) {
    return fail(
      `cw evidence submit --kind build: 非法 commit hash "${commit}"：须匹配 ^[0-9a-f]{6,40}$（十六进制缩写或全 hash）。恢复动作：用 git rev-parse HEAD 获取真实 hash 后重试。`,
    );
  }
  const runId = stringArg(ctx.argv, "run-id");
  if (runId === undefined) {
    return fail(
      "cw evidence submit --kind build: 缺少 --run-id <runId>。恢复动作：加 --run-id（幂等键，同 unit 重跑须换新 runId）。",
    );
  }

  // 注入安全：commit 已过十六进制白名单才进 argv；spawnSync 不经 shell，无拼接注入面
  const probe = spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: ctx.cwd });
  if (probe.error !== undefined) {
    return fail(
      `cw evidence submit --kind build: 无法执行 git（${probe.error.message}）。恢复动作：确认环境安装 git，且 cwd "${ctx.cwd}" 可访问。`,
    );
  }
  if (probe.status !== 0) {
    return fail(
      `cw evidence submit --kind build: commit ${commit} 在 cwd "${ctx.cwd}" 的 git 仓库中不存在（git cat-file -e '${commit}^{commit}' 失败）。` +
        "恢复动作：用 git rev-parse HEAD 确认真实 hash 后重试。",
    );
  }

  const files = stringArrayArg(ctx.argv, "file");
  const hashes: string[] = [];
  for (const p of files) {
    const fileRead = readOrErrno(resolveAgainstCwd(ctx.cwd, p));
    if (!fileRead.ok) {
      return fail(
        `cw evidence submit --kind build: 产物文件不可读（${p}，按 cwd "${ctx.cwd}" 解析）：${fileRead.errno}。恢复动作：确认路径存在可读后重试。`,
      );
    }
    hashes.push(sha256Hex(fileRead.raw));
  }

  const payload: EvidenceSubmittedPayload = {
    unitId,
    runId,
    commit,
    paths: files,
    sha256: hashes,
    exitCode: 0,
  };
  const result = tryAppend(ledger, "EvidenceSubmitted", payload);
  if (!result.ok) {
    return fail(result.message);
  }
  return succeed(
    `unit "${unitId}" 的 build 证据已入账（runId ${runId}，产物 ${files.length} 个，seq ${result.envelope.seq}）。`,
  );
}
