/**
 * `cw evidence submit`（u2 验收文档锁定的 M0 规格，--kind 区分两种形态）。
 *
 * spec 形态：`--kind spec --unit <id> --file <spec.json>`
 *   校验链 unit 存在 → typebox schema → checkSpecRules（u3）→ 叶子 unit 不得声明
 *   split（fx-1 R1 handler 级防线）→ split 条目须已建且 parent 指向本 unit
 *   （fx-3 R5.1：先建子后提 spec）→ 全过才 append
 *   SpecSubmitted{specHash = sha256(spec.json 原始字节), acceptance/contracts/split 原样}。
 *   gate 不过不入账（账本只记被接受的进展），stderr 逐条打印 u3 failures 原文。
 *
 * build 形态：`--kind build --unit <id> --commit <hash> --run-id <runId> [--file <path>]...`
 *   unit 存在 → commit 在 cwd git 仓库真实存在 → 每个 --file 存在可读并计算 sha256 →
 *   append EvidenceSubmitted{exitCode: 0}。同 unitId+runId 重复提交 = 幂等命中
 *   （canon「幂等（同 runId 重复提交不重复记账）」）：账本层抛 DuplicateEvidenceError
 *   区分于其他拒绝，handler 转幂等成功（exit 0 + 提示，不 append）。
 */
import { spawnSync } from "node:child_process";

import { deriveStatuses, fold } from "../core/fold.js";
import type { CommandContext } from "../dispatch.js";
import type {
  EvidenceSubmittedPayload,
  SpecSubmittedPayload,
} from "../events/types.js";
import { checkSpecRules } from "../gates/spec-rules.js";
import { DuplicateEvidenceError } from "../store/events-log.js";
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
  type UnitCreatedFact,
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
    ? submitSpec(ctx, ledger, unitId, createdFacts.get(unitId)?.parentId ?? null, createdFacts)
    : submitBuild(ctx, ledger, unitId);
}

function submitSpec(
  ctx: CommandContext,
  ledger: ReturnType<typeof ledgerForCwd>,
  unitId: string,
  parentId: string | null,
  createdFacts: Map<string, UnitCreatedFact>,
): number {
  // closed 不可逆（canon L0）的命令面半边：树感知状态为 closed 的 unit 拒绝新
  // spec。append-only 账本无法撤销事件，若放行，重提 spec 会把投影拉回 created
  // ——历史结论被一条新事件篡改。时序半边在 fold（deriveStatus 的 seq 收紧）
  const status = deriveStatuses(fold(ledger.readAll()).units, checkSpecRules).get(unitId);
  if (status === "closed") {
    return fail(
      `cw evidence submit --kind spec: unit "${unitId}" 已 closed（树感知状态，含全部子节点 closed），不可逆——closed 是账本上的最终结论，重提 spec 会把投影拉回 created（篡改历史结论）。` +
        "恢复动作：如需变更请新建 unit（cw create --id <slug> --brief <brief文件> --parent <父unitId>），或在父级 unit replan。",
    );
  }

  const file = stringArg(ctx.argv, "file");
  if (file === undefined) {
    return fail(
      "cw evidence submit --kind spec: 缺少 --file <spec.json>。恢复动作：加 --file 指向 spec.json（结构 { acceptance, contracts, split }）。",
    );
  }
  const fileAbs = resolveAgainstCwd(file);
  const fileRead = readOrErrno(fileAbs);
  if (!fileRead.ok) {
    return fail(
      `cw evidence submit --kind spec: spec 文件不可读（${file}，按执行目录 "${process.cwd()}" 解析为 ${fileAbs}）：${fileRead.errno}。恢复动作：确认路径正确且文件存在可读。`,
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

  // fx-3 R5.1 handler 级防线：split 声明的子 unit 必须①已存在于账本②其 parent
  // 指向本 unit。工作流语义变更（designer 先建子、后提 spec）——文字约定
  // （brief 里的「先 create 后提交」警告）对 print 模式 agent 不充分（终验第 3 次
  // 现场：designer 把建子当决策点停下询问），升级为机器 gate 让错误在提交时点
  // 最早暴露，修复窗口仍在同一 spawn 内（错误文案给出建子命令模板，建完重提）
  if (spec.split.length > 0) {
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const entry of spec.split) {
      const fact = createdFacts.get(entry.unitId);
      if (fact === undefined) {
        missing.push(entry.unitId);
      } else if (fact.parentId !== unitId) {
        mismatched.push(entry.unitId);
      }
    }
    if (missing.length > 0 || mismatched.length > 0) {
      const details: string[] = [];
      if (missing.length > 0) {
        details.push(`  - 未创建（账本内无其 UnitCreated 事件）：${missing.join("、")}`);
      }
      if (mismatched.length > 0) {
        details.push(
          `  - parent 错配（其 parent 不是 "${unitId}"，不得引用别家子）：${mismatched.join("、")}`,
        );
      }
      return fail(
        [
          `cw evidence submit --kind spec: spec.split 声明的子 unit 校验失败（unit "${unitId}"），不入账：`,
          ...details,
          `恢复动作：先 cw create --id <slug> --brief <文件> --parent ${unitId} 创建全部子 unit，再提交 spec。`,
        ].join("\n"),
      );
    }
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
    const fileRead = readOrErrno(resolveAgainstCwd(p));
    if (!fileRead.ok) {
      return fail(
        `cw evidence submit --kind build: 产物文件不可读（${p}，按执行目录 "${process.cwd()}" 解析）：${fileRead.errno}。恢复动作：确认路径存在可读后重试。`,
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
  // 直接 append（不走 tryAppend）：幂等命中须与「其他账本拒绝」区分——
  // DuplicateEvidenceError 转 exit 0 幂等成功，重试方收到的是确认而非错误
  try {
    const envelope = ledger.append("EvidenceSubmitted", payload);
    return succeed(
      `unit "${unitId}" 的 build 证据已入账（runId ${runId}，产物 ${files.length} 个，seq ${envelope.seq}）。`,
    );
  } catch (e) {
    if (e instanceof DuplicateEvidenceError) {
      return succeed(
        `已入账（幂等命中）：unit "${unitId}" + runId "${runId}" 的 build 证据此前已入账，本次未重复记账。` +
          `核对：cw status --unit ${unitId}（evidences 列表）。`,
      );
    }
    return fail(e instanceof Error ? e.message : String(e));
  }
}
