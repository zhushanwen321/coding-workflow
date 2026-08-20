/**
 * `cw create --id <slug> --brief <path> [--parent <unitId>]`（u2 验收文档锁定的 M0 规格）。
 *
 * 校验序（便宜的先做）：slug 规则 → brief 可读 → 重复 unitId → parent 存在 +
 * 深度上限 + parent 非 closed（fx-7 S-3：closed 父拒绝建子）。
 * 深度限制：M0 上限 2 层（根 + 叶）——--parent 的目标 unit 自身不得再有 parent。
 */
import { deriveStatuses, fold } from "../core/fold.js";
import type { CommandContext } from "../dispatch.js";
import { checkSpecRules } from "../gates/spec-rules.js";
import {
  copyAttachmentToEvidence,
  fail,
  ledgerForCwd,
  readOrErrno,
  resolveAgainstCwd,
  stringArg,
  succeed,
  tryAppend,
  unitCreatedFacts,
} from "./common.js";

/** unit slug 规则（验收文档锁定）：小写字母开头，仅小写字母/数字/连字符 */
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export async function handleCreate(ctx: CommandContext): Promise<number> {
  const unitId = stringArg(ctx.argv, "id");
  if (unitId === undefined) {
    return fail(
      "cw create: 缺少 --id <slug>。恢复动作：cw create --id <slug> --brief <brief 路径> [--parent <unitId>]。",
    );
  }
  if (!SLUG_RE.test(unitId)) {
    return fail(
      `cw create: 非法 unit id "${unitId}"：须匹配 ^[a-z][a-z0-9-]*$（小写字母开头，仅小写字母/数字/连字符）。` +
        "恢复动作：改为合法 slug（如 my-unit-1）后重试。",
    );
  }

  const brief = stringArg(ctx.argv, "brief");
  if (brief === undefined) {
    return fail(
      "cw create: 缺少 --brief <任务书路径>。恢复动作：cw create --id <slug> --brief <brief 路径>。",
    );
  }
  const briefAbs = resolveAgainstCwd(brief);
  const briefRead = readOrErrno(briefAbs);
  if (!briefRead.ok) {
    return fail(
      `cw create: brief 文件不可读（${brief}，按执行目录 "${process.cwd()}" 解析为 ${briefAbs}）：${briefRead.errno}。` +
        "恢复动作：确认路径正确且文件存在可读；brief 内容原样不解析，空文件亦可。",
    );
  }

  const ledger = ledgerForCwd(ctx.cwd);
  const facts = unitCreatedFacts(ledger);
  if (facts.has(unitId)) {
    return fail(
      `cw create: unit "${unitId}" 已存在（账本内已有其 UnitCreated 事件）。` +
        "恢复动作：账本 append-only 不支持重复创建；继续推进该 unit 用 evidence submit / review submit，或换一个新 slug。",
    );
  }

  let parentId: string | null = null;
  const parent = stringArg(ctx.argv, "parent");
  if (parent !== undefined) {
    const parentFact = facts.get(parent);
    if (parentFact === undefined) {
      return fail(
        `cw create: --parent "${parent}" 不存在（账本内无其 UnitCreated 事件）。` +
        `恢复动作：先创建父 unit（cw create --id ${parent} --brief <路径>），或去掉 --parent 创建根 unit。`,
      );
    }
    if (parentFact.parentId !== null) {
      return fail(
        `cw create: 分解深度超限：--parent "${parent}" 自身已是子 unit（其 parent 为 "${parentFact.parentId}"），` +
          "M0 上限 2 层（根 + 叶），不允许三层嵌套。恢复动作：把子 unit 挂到根 unit 下（--parent 指向根）。",
      );
    }
    // closed 不可逆（canon L0）的 create 路径半边（fx-7 S-3）：--parent 指向树感知
    // closed 的 unit 时拒绝——若放行，新子的 UnitCreated 会让 deriveStatusInTree
    // 把根从 closed 拉回 verified（「全部直接子节点 closed」不再成立），历史结论
    // 被一条新事件篡改；与 evidence-submit spec 重提路径的 closed 拒绝同族防线。
    // 其余状态不拦：verified 根补建子 unit 是合法演进（根回到 verified 等新链路）
    const parentStatus = deriveStatuses(fold(ledger.readAll()).units, checkSpecRules).get(parent);
    if (parentStatus === "closed") {
      return fail(
        `cw create: --parent "${parent}" 已 closed（树感知状态，含全部子节点 closed），不可逆——closed 是账本上的最终结论，在其下新建子 unit 会把投影拉回 verified（篡改历史结论）。` +
          `恢复动作：closed 不可逆；如需承接新工作，去掉 --parent 新建根 unit（cw create --id <slug> --brief <brief文件>），或以未 closed 的 unit 为父。`,
      );
    }
    parentId = parent;
  }

  const result = tryAppend(ledger, "UnitCreated", { unitId, parentId, briefRef: brief });
  if (!result.ok) {
    return fail(result.message);
  }
  // fx-4 D4：unit 原始 brief 副本入 evidence——账本 briefRef 是路径引用，文件本体
  // 是 designer 在父 worktree 写的 untracked、随 clean/reclaim 丢失留下死路径
  copyAttachmentToEvidence(ctx.cwd, unitId, briefAbs, briefRead.raw);
  return succeed(
    `unit "${unitId}" 已创建${parentId !== null ? `（parent "${parentId}"）` : "（根）"}，seq ${result.envelope.seq}。`,
  );
}
