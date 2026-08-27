/**
 * `cw review submit --unit <id> --verdict-kind <spec-review|exec-review> --verdict <pass|fail>
 * [--comment <text>] [--evidence-refs <runId,...>] [--role <reviewer|designer|developer|human>]`
 * （u2 验收文档锁定的 M0 规格；mx-1 增补可选 --role 自报字段）。
 *
 * mx-3 起 spec-review 的 --role 收紧为必填且必须 reviewer（缺/错 → exit 1 纯拒绝，
 * 见 handleReviewSubmit 内注释）；exec-review 的 role 保持可选。
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

/** --role 的合法值集（mx-1：提交者自报身份的枚举域，对齐 VerdictSubmittedPayload.role；mx5-4 起实现角色只收 developer，改名前旧值拒收） */
const VERDICT_ROLES = ["reviewer", "designer", "developer", "human"] as const;

/** 自报 role 的枚举判定（类型守卫：payload 的 role 字段收窄到字面量联合） */
function isVerdictRole(
  value: string,
): value is NonNullable<VerdictSubmittedPayload["role"]> {
  return (VERDICT_ROLES as readonly string[]).includes(value);
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

/**
 * unit 存在性守卫（从 handleReviewSubmit 提出——Gate-1.5 度量门禁降复杂度，
 * 文案逐字节保留）。
 */
function unknownUnitError(ledger: EventLedger, unitId: string): string | null {
  if (unitCreatedFacts(ledger).has(unitId)) {
    return null;
  }
  return (
    `cw review submit: unit "${unitId}" 不存在（账本内无其 UnitCreated 事件）。` +
    `恢复动作：先创建该 unit（cw create --id ${unitId} --brief <路径>）再提交审查结论。`
  );
}

/** verdictKind 枚举谓词（类型守卫：true 分支收窄到枚举，与 payload 目标类型由编译器强制同步） */
function isVerdictKind(value: string | undefined): value is "spec-review" | "exec-review" {
  return value === "spec-review" || value === "exec-review";
}

/** verdictKind 非法时的错误文案（仅消费谓词 false 分支；文案逐字节保留） */
function invalidVerdictKindMessage(verdictKind: string | undefined): string {
  return (
    `cw review submit: 非法 --verdict-kind "${verdictKind ?? ""}"：合法值 spec-review | exec-review。` +
    "恢复动作：spec 审查（解冻验收）用 --verdict-kind spec-review，执行审查用 --verdict-kind exec-review。"
  );
}

/** verdict 枚举谓词（同 isVerdictKind：收窄即校验，消除裸 as） */
function isVerdict(value: string | undefined): value is "pass" | "fail" {
  return value === "pass" || value === "fail";
}

/** verdict 非法时的错误文案（仅消费谓词 false 分支；文案逐字节保留） */
function invalidVerdictMessage(verdict: string | undefined): string {
  return (
    `cw review submit: 非法 --verdict "${verdict ?? ""}"：合法值 pass | fail。恢复动作：--verdict pass 或 --verdict fail。`
  );
}

/**
 * rv-2 evidence-refs 解析与存在性校验（rv-2：exec-review 的 --evidence-refs
 * 必填（例外面为零）——exec-review pass 是 closed 的最后一块拼图，零证据引用的
 * 结论会绕过「closed 必须引用真实证据」的承诺；--evidence-refs "" 空串经既有
 * 清洗变空数组，按缺失同等 fail。spec-review 维持可选（解冻验收的审查结论
 * 不以 build 证据为前提）。从主流程提出以收敛圈复杂度（Gate-1.5），文案
 * 与判定语义零变化。
 */
function resolveEvidenceRefs(
  ledger: EventLedger,
  unitId: string,
  verdictKind: "spec-review" | "exec-review",
  refsRaw: string | undefined,
): { refs?: string[]; error?: string } {
  if (verdictKind !== "exec-review" && refsRaw === undefined) {
    return {};
  }
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
    return {
      error:
        `cw review submit: exec-review 结论必须携带 --evidence-refs（至少 1 个已入账 runId）——` +
        `exec-review 是 unit 走向 closed 的最后一块拼图，零证据引用的结论不可入账。` +
        `恢复动作：先提交对应证据（cw evidence submit --kind build --unit ${unitId} --run-id <runId> ...），` +
        `再携带 --evidence-refs <runId,...> 重新提交。该 unit 已入账的 runId（执行证据 build 与 verify/集成两类）：${describeRunIds(buildIds, verifyIds)}。`,
    };
  }
  const missing = requested.filter((r) => !known.has(r));
  if (missing.length > 0) {
    return {
      error:
        `cw review submit: --evidence-refs 引用的 runId 不存在于 unit "${unitId}" 的 EvidenceSubmitted/VerifyRan：${missing.join(", ")}。` +
        `恢复动作：先提交对应证据（cw evidence submit --kind build --unit ${unitId} --run-id <runId> ...）；该 unit 已入账的 runId（执行证据 build 与 verify/集成两类）：${describeRunIds(buildIds, verifyIds)}。`,
    };
  }
  return { refs: requested };
}

/**
 * mx-3：spec-review 结论的身份强校验（入账层，双层防线第一层——M4 gate §5.1
 * developer 自审 pass 绕过独立审查的现场）。缺/错 role 一律纯拒绝（不产生任何
 * 事件），提交者按文案补 role 重试；reviewer brief 与 human 指令模板均已含
 * --role reviewer，正常链路零影响。防的是无意识自审（developer/designer 按自己
 * 知道的命令形态提交，不带 role）；不防有意谎报——role 是自报字段可伪造，但
 * 谎报者必须在账本留下显式 role=reviewer 声明（事后审计可对照 spawn 记录）。
 * exec-review 不收紧：其前置 verified 由机器验证把关，M4 gate 发现的绕过路径
 * 只有 spec-review。文案逐字节保留（Gate-1.5 重构搬移）。
 */
function specReviewRoleError(
  unitId: string,
  verdictKind: "spec-review" | "exec-review",
  role: string | undefined,
  verdict: "pass" | "fail",
): string | null {
  if (!(verdictKind === "spec-review" && role !== "reviewer")) {
    return null;
  }
  const roleDesc =
    role === undefined ? "未携带 --role" : `携带的是 --role "${role}"`;
  return (
    `cw review submit: spec-review 结论必须由 reviewer 身份提交（当前${roleDesc}）——` +
    "spec-review 是 spec 冻结的唯一闸门，非 reviewer 身份（designer 自审 / developer 越权）的结论不可入账。" +
    `恢复动作：补 --role reviewer 重试——cw review submit --unit ${unitId} --verdict-kind spec-review --verdict ${verdict} --role reviewer` +
    "（若你确非该 unit 的独立 reviewer，请勿提交，交由 runner 派发的 reviewer spawn 处理）。"
  );
}

/**
 * fb-1：spec-review verdict 幂等守卫谓词（设计 D8——观察文档 C3「同 specHash 双
 * verdict 时序赌博」）。谓词是**位置语义**而非字面 specHash 比对：①
 * VerdictSubmittedPayload 无 specHash 字段（schema 变更才能携带，见下残余面记档），
 * 只能以「该 unit 最后一条 SpecSubmitted 之后是否已存在 role=reviewer 的
 * spec-review verdict」锚定同代；② 与 fold 的冻结语义同构（fold.ts「最后一条
 * spec 之后存在 reviewer 的 pass 即冻结」），对齐只认 role=reviewer——非
 * reviewer 的 spec-review verdict（历史账本/直写残留）不驱动冻结也不挡后继真实
 * 审查。守卫只挡**同代重复**；跨代迟到 verdict 残余面（在飞 reviewer 对旧 spec
 * 迟交 pass，落在最后 spec 之后、可冻结未经审的新 spec）位置谓词拦不住——彻底
 * 关闭需 verdict 携带 specHash 比对（schema 变更 + reviewer 任务书传递，本波不做，
 * 真实案例出现时再评估）。行为变更记档：reviewer 同代改判（fail 后不打回重提、
 * 直接补一条 pass——或反之）的旧路径被本守卫关闭；正路 = fail → designer 重提新
 * spec 走新代。exec-review 不设此守卫：多轮 fail → 修复 → 再审是合法流程，其
 * verdict 锚 evidenceRefs（每次指向新的执行证据），语义上本就允许连续多条。
 * 插入位在 mx-3 role 强校验之后：能走到这里的 spec-review 提交必有 role=reviewer，
 * 谓词无需再判本次提交身份。返回拒收文案；null = 允许入账。
 */
function specReviewDuplicateError(
  ledger: EventLedger,
  unitId: string,
  verdictKind: "spec-review" | "exec-review",
): string | null {
  if (verdictKind !== "spec-review") {
    return null;
  }
  const unitEvents = ledger.readUnit(unitId) as DiscriminatedEvent[];
  let lastSpecSeq = 0; // seq 从 1 起；0 = 该 unit 无 spec（此时任何 reviewer 结论都算「已审」，保守拒收）
  for (const ev of unitEvents) {
    if (ev.type === "SpecSubmitted" && ev.seq > lastSpecSeq) {
      lastSpecSeq = ev.seq; // append-only + 单调 seq：最后出现的即最大
    }
  }
  const alreadyReviewed = unitEvents.some(
    (ev) =>
      ev.type === "VerdictSubmitted" &&
      ev.seq > lastSpecSeq &&
      ev.payload.verdictKind === "spec-review" &&
      ev.payload.role === "reviewer",
  );
  if (!alreadyReviewed) {
    return null;
  }
  return (
    `cw review submit: 该 spec 已有生效审查结论（unit "${unitId}" 当前 spec 代已有 reviewer 结论入账）——` +
    `同代重复/改判的 spec-review verdict 不再入账，审计链保持单一生效结论。` +
    `如需重审，由 designer 重提 spec 产生新 specHash 走新代：` +
    `cw evidence submit --kind spec --unit ${unitId} --file spec.json。`
  );
}

export async function handleReviewSubmit(ctx: CommandContext): Promise<number> {
  const unitId = stringArg(ctx.argv, "unit");
  if (unitId === undefined) {
    return fail(
      "cw review submit: 缺少 --unit <id>。恢复动作：cw review submit --unit <id> --verdict-kind <spec-review|exec-review> --verdict <pass|fail>。",
    );
  }
  const ledger = ledgerForCwd(ctx.cwd);
  const unitError = unknownUnitError(ledger, unitId);
  if (unitError !== null) {
    return fail(unitError);
  }
  const verdictKindRaw = stringArg(ctx.argv, "verdict-kind");
  if (!isVerdictKind(verdictKindRaw)) {
    return fail(invalidVerdictKindMessage(verdictKindRaw));
  }
  // 谓词 true 分支已收窄——直接赋值给目标类型，无裸 as（守卫值域 ≡ 类型枚举由编译器保证）
  const verdictKind: "spec-review" | "exec-review" = verdictKindRaw;
  const verdictRaw = stringArg(ctx.argv, "verdict");
  if (!isVerdict(verdictRaw)) {
    return fail(invalidVerdictMessage(verdictRaw));
  }
  const verdict: "pass" | "fail" = verdictRaw;
  const resolvedRefs = resolveEvidenceRefs(ledger, unitId, verdictKind, stringArg(ctx.argv, "evidence-refs"));
  if (resolvedRefs.error !== undefined) {
    return fail(resolvedRefs.error);
  }
  const evidenceRefs = resolvedRefs.refs;
  const comment = stringArg(ctx.argv, "comment");
  // mx-1：--role 可选自报字段（弱声明——只记录不信任，审计载体非信任边界）。
  // 枚举校验只拦手滑（拼错/大小写），不提供任何授权语义；缺省不入 payload。
  // 不抽函数：isVerdictRole 是类型守卫，此处的条件流承担 role → 枚举的收窄
  const role = stringArg(ctx.argv, "role");
  if (role !== undefined && !isVerdictRole(role)) {
    return fail(
      `cw review submit: 非法 --role "${role}"：合法值 ${VERDICT_ROLES.join(" | ")}。` +
        "恢复动作：按你的实际身份选（reviewer=独立审查者 / designer / developer / human=人工），" +
        "或去掉 --role（自报字段可选，缺省不入账）。若你用的是改名前的实现角色旧值（mx5-4 起" +
        "已拒收），迁移指引：改用 --role developer。",
    );
  }
  const roleCheckError = specReviewRoleError(unitId, verdictKind, role, verdict);
  if (roleCheckError !== null) {
    return fail(roleCheckError);
  }
  const duplicateError = specReviewDuplicateError(ledger, unitId, verdictKind);
  if (duplicateError !== null) {
    return fail(duplicateError);
  }
  const payload: VerdictSubmittedPayload = {
    unitId,
    verdictKind,
    verdict,
    ...(comment !== undefined ? { comment } : {}),
    ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
    ...(role !== undefined ? { role } : {}),
  };
  const result = tryAppend(ledger, "VerdictSubmitted", payload);
  if (!result.ok) {
    return fail(result.message);
  }
  return succeed(
    `unit "${unitId}" 的 ${verdictKind} 结论已入账（verdict: ${verdict}，seq ${result.envelope.seq}）。`,
  );
}
