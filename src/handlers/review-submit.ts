/**
 * `cw review submit --unit <id> --verdict-kind <spec-review|exec-review> --verdict <pass|fail>
 * [--comment <text>] [--evidence-refs <runId,...>]`（u2 验收文档锁定的 M0 规格）。
 *
 * verdict append-only 一次写入不可改；--evidence-refs 的每个 runId 必须已存在于
 * 该 unit 的 EvidenceSubmitted（引用不存在 → 列出缺失项 exit 1）。
 */
import type { CommandContext } from "../dispatch.js";
import type { VerdictSubmittedPayload } from "../events/types.js";
import {
  evidenceRunIds,
  fail,
  ledgerForCwd,
  stringArg,
  succeed,
  tryAppend,
  unitCreatedFacts,
} from "./common.js";

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
  if (refsRaw !== undefined) {
    const requested = refsRaw
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r !== "");
    const known = evidenceRunIds(ledger, unitId);
    const missing = requested.filter((r) => !known.has(r));
    if (missing.length > 0) {
      const knownList = [...known].join(", ");
      return fail(
        `cw review submit: --evidence-refs 引用的 runId 不存在于 unit "${unitId}" 的 EvidenceSubmitted：${missing.join(", ")}。` +
        `恢复动作：先提交对应证据（cw evidence submit --kind build --unit ${unitId} --run-id <runId> ...）；该 unit 已入账的 runId：${knownList === "" ? "（无）" : knownList}。`,
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
