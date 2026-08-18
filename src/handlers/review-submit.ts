/**
 * `cw review submit --unit <id> --verdict-kind <spec-review|exec-review> --verdict <pass|fail>
 * [--comment <text>] [--evidence-refs <runId,...>]`（u2 验收文档锁定的 M0 规格）。
 *
 * verdict append-only 一次写入不可改；--evidence-refs 的每个 runId 必须已存在于
 * 该 unit 的 EvidenceSubmitted（引用不存在 → 列出缺失项 exit 1）。rv-2 起
 * exec-review 的 --evidence-refs 必填且清洗后 ≥1 条（exec-review pass 是 closed
 * 的最后一块拼图，零证据引用的结论不可入账）；spec-review 维持可选。
 *
 * rv-2 打回期间方案 C 扩展（内部节点形态）：exec-review 可引用的执行证据 =
 * EvidenceSubmitted.runId ∪ VerifyRan.runId——内部节点的「build」是集成
 * （canon D6：集成 = 内部节点的 verify），集成只写 VerifyRan 不写
 * EvidenceSubmitted，「例外面为零」若只认 build runId 则 root 的 exec-review
 * 无任何 runId 可引（wt5 场景 1 实锤）。不区分前缀：verify 重跑的 runId 同样
 * 是执行证据佐证，避免与 integrate- 前缀耦合。
 */
import type { CommandContext } from "../dispatch.js";
import type { DiscriminatedEvent, VerdictSubmittedPayload } from "../events/types.js";
import type { EventLedger } from "../store/events-log.js";
import {
  evidenceRunIds,
  fail,
  ledgerForCwd,
  stringArg,
  succeed,
  tryAppend,
  unitCreatedFacts,
} from "./common.js";

/** 该 unit 已入账的全部 VerifyRan runId（执行证据的内部节点半边，方案 C） */
function verifyRunIds(ledger: EventLedger, unitId: string): Set<string> {
  const runIds = new Set<string>();
  for (const ev of ledger.readAll() as DiscriminatedEvent[]) {
    if (ev.type === "VerifyRan" && ev.payload.unitId === unitId) {
      runIds.add(ev.payload.runId);
    }
  }
  return runIds;
}

/**
 * 已入账 runId 的人可读清单（两类分列）：build = EvidenceSubmitted（叶子形态），
 * verify = VerifyRan（内部节点的集成 / 重跑佐证）。两类皆空时给出先补证据的指引。
 */
function describeRunIds(build: ReadonlySet<string>, verify: ReadonlySet<string>): string {
  const parts: string[] = [];
  if (build.size > 0) {
    parts.push(`build: ${[...build].join(", ")}`);
  }
  if (verify.size > 0) {
    parts.push(`verify/集成: ${[...verify].join(", ")}`);
  }
  return parts.length === 0
    ? "（无，须先提交 build 证据或跑通 verify/集成）"
    : parts.join("；");
}

export async function handleReviewSubmit(ctx: CommandContext): Promise<number> {
  const unitId = stringArg(ctx.argv, "unit");
  if (unitId === undefined) {
    return fail(
      "cw review submit: 缺少 --unit <id>。恢复动作：cw review submit --unit <id> --verdict-kind <spec-review|exec-review> --verdict <pass|fail>。",
    );
  }
  const ledger = ledgerForCwd(ctx.cwd);
  if (!unitCreatedFacts(ledger).has(unitId)) {
    return fail(
      `cw review submit: unit "${unitId}" 不存在（账本内无其 UnitCreated 事件）。` +
        `恢复动作：先创建该 unit（cw create --id ${unitId} --brief <路径>）再提交审查结论。`,
    );
  }

  const verdictKind = stringArg(ctx.argv, "verdict-kind");
  if (verdictKind !== "spec-review" && verdictKind !== "exec-review") {
    return fail(
      `cw review submit: 非法 --verdict-kind "${verdictKind ?? ""}"：合法值 spec-review | exec-review。` +
        "恢复动作：spec 审查（解冻验收）用 --verdict-kind spec-review，执行审查用 --verdict-kind exec-review。",
    );
  }
  const verdict = stringArg(ctx.argv, "verdict");
  if (verdict !== "pass" && verdict !== "fail") {
    return fail(
      `cw review submit: 非法 --verdict "${verdict ?? ""}"：合法值 pass | fail。恢复动作：--verdict pass 或 --verdict fail。`,
    );
  }

  let evidenceRefs: string[] | undefined;
  const refsRaw = stringArg(ctx.argv, "evidence-refs");
  // rv-2：exec-review 的 --evidence-refs 必填（例外面为零）——exec-review pass 是
  // closed 的最后一块拼图，零证据引用的结论会绕过「closed 必须引用真实证据」的
  // 承诺；--evidence-refs "" 空串经既有清洗变空数组，按缺失同等 fail。
  // spec-review 维持可选（解冻验收的审查结论不以 build 证据为前提）
  if (verdictKind === "exec-review" || refsRaw !== undefined) {
    const requested =
      refsRaw
        ?.split(",")
        .map((r) => r.trim())
        .filter((r) => r !== "") ?? [];
    // 执行证据全集（方案 C）：build 证据 ∪ VerifyRan（内部节点的集成只写后者）
    const buildIds = evidenceRunIds(ledger, unitId);
    const verifyIds = verifyRunIds(ledger, unitId);
    const known = new Set<string>([...buildIds, ...verifyIds]);
    if (verdictKind === "exec-review" && requested.length === 0) {
      return fail(
        `cw review submit: exec-review 结论必须携带 --evidence-refs（至少 1 个已入账 runId）——` +
        `exec-review 是 unit 走向 closed 的最后一块拼图，零证据引用的结论不可入账。` +
        `恢复动作：先提交对应证据（cw evidence submit --kind build --unit ${unitId} --run-id <runId> ...），` +
        `再携带 --evidence-refs <runId,...> 重新提交。该 unit 已入账的 runId（执行证据 build 与 verify/集成两类）：${describeRunIds(buildIds, verifyIds)}。`,
      );
    }
    const missing = requested.filter((r) => !known.has(r));
    if (missing.length > 0) {
      return fail(
        `cw review submit: --evidence-refs 引用的 runId 不存在于 unit "${unitId}" 的 EvidenceSubmitted/VerifyRan：${missing.join(", ")}。` +
        `恢复动作：先提交对应证据（cw evidence submit --kind build --unit ${unitId} --run-id <runId> ...）；该 unit 已入账的 runId（执行证据 build 与 verify/集成两类）：${describeRunIds(buildIds, verifyIds)}。`,
      );
    }
    evidenceRefs = requested;
  }

  const comment = stringArg(ctx.argv, "comment");
  const payload: VerdictSubmittedPayload = {
    unitId,
    verdictKind,
    verdict,
    ...(comment !== undefined ? { comment } : {}),
    ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
  };
  const result = tryAppend(ledger, "VerdictSubmitted", payload);
  if (!result.ok) {
    return fail(result.message);
  }
  return succeed(
    `unit "${unitId}" 的 ${verdictKind} 结论已入账（verdict: ${verdict}，seq ${result.envelope.seq}）。`,
  );
}
