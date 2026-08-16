/**
 * 内部节点集成验证（canon《design-rewrite-architecture.md》§3.3 D6「集成 = 内部
 * 节点的 verify」；u8 验收文档 docs/rewrite/acceptance/u8-acceptance.md 规格锁定 2）。
 *
 * 叶子的 verify = 干净重跑自己的验收；内部节点的 verify = 子树集成：
 *   0. merge 汇聚（wt-4 J1/D6）——ensure root worktree，逐子把 cw/<rootId>/<unitId>
 *      merge --no-edit 进 root 分支 cw-root/<rootId>（已达则跳过，幂等；冲突
 *      abort 清现场收 failures 后继续）；
 *   1. commit 可达性——每个子 build commit 在 root 分支可达（wt-4 J2 三处 HEAD
 *      锚定之一：可达性判定对 root 分支 ref，与项目 cwd HEAD 解耦）；
 *   2. 干净 checkout——root 分支 HEAD（集成时刻的最终树，子产出已并入）到一次性
 *      工作区（复用 u4a cleanCheckout 语义，checkout 目标传解析后 hash）；
 *   3. 受影响验收重跑——M2 保守口径：全部子节点验收 ∪ root 自身验收，逐 unit 批次
 *      复用 runAcceptances（适配器路由 + nameMatch 判定原样生效，不另造执行路径）。
 *      诚实标注：这是「全量重跑」保守版（漏跑率 0，代价多跑）；「变更文件→验收
 *      覆盖」的精准选择策略留待真实集成案例校准（canon §5 待验证检查点）。
 *      逐 unit 分批而非合并成一个列表：跨 unit 的验收 id 允许重名（id 仅 unit 内
 *      唯一），合并会让同名产物文件互相覆盖（run.ts 的 fileStem 落盘以 id 命名）；
 *      分批各得独立子目录，语义也回归「子验收在子树里各自成立」。
 *   4. 契约比对——matchContracts 在 checkout 树上执行（§1.3 机器验「契约配对」）。
 *   5. 汇总——全部通过 ok=true；产物落 evidence/<rootId>/integrate-<runId>/
 *      （逐 unit 子目录逐验收产物 + integrate-report.json）。
 *
 * 失败语义：所有可检出问题（commit 不可达 / checkout 失败 / 验收红 / 契约漂移 /
 * 子无冻结 spec）都收进 failures 返回（不抛错、不短路——每多检出一项，下轮修复
 * 就少一次盲跑）；调用方（loop）据此写 fail 的 VerifyRan 留审计并重派。子节点验收
 * 从账本读取（children 参数只带 commit；acceptance 是 spec 冻结事实，账本是唯一
 * 权威源）。本函数不写任何账本事件——事件写入是调用方的编排职责。
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AcceptanceItem, Contract } from "../events/types.js";
import { loadLedger } from "../readonly/load.js";
import { evidenceDir, getCwHome, getCwWorktreeHome, worktreePath } from "../store/project.js";
import { cleanCheckout, cleanupCheckout } from "../verify/checkout.js";
import { type ContractMatchResult, matchContracts } from "../verify/contract-match.js";
import { type AcceptanceRunResult, runAcceptances, type RunOutcome } from "../verify/run.js";
import { ensureUnitWorktree, unitBranchName } from "./worktree.js";

/** 单步 git 操作超时（与 checkout.ts 同口径：本地操作毫秒级，上限防挂死） */
const GIT_STEP_TIMEOUT_MS = 120_000;
/** 集成总报告文件名（evidence/<rootId>/integrate-<runId>/ 下） */
const REPORT_FILE_NAME = "integrate-report.json";
const REPORT_INDENT = 2;

export interface IntegrateResult {
  ok: boolean;
  failures: string[];
  runId: string;
  reportPath: string;
}

/** 子 commit 可达性（报告的字段名与验收文档一致） */
interface ChildReachability {
  unitId: string;
  commit: string;
  reachable: boolean;
}

/** 单 unit 批次的验收结果（失败原因透传 runAcceptances 的 nameMatch 语义） */
interface AcceptanceBatchResult {
  unitId: string;
  results: Array<{ id: string; status: "pass" | "fail"; reason?: string }>;
}

/** integrate-report.json 的结构（报告落盘 = 审计事实，字段名即对外契约） */
export interface IntegrateReport {
  kind: "integrate";
  rootId: string;
  runId: string;
  /** root 分支 cw-root/<rootId> 的 HEAD（wt-4 J2：集成锚点，非项目 cwd HEAD） */
  head: string;
  children: ChildReachability[];
  acceptanceBatches: AcceptanceBatchResult[];
  contracts: ContractMatchResult;
  ok: boolean;
  failures: string[];
}

/** 待执行的验收批次：子节点（账本读取）在前、root 自身（入参直传）在后 */
interface PendingBatch {
  unitId: string;
  acceptance: AcceptanceItem[];
}

export async function runIntegrationVerify(opts: {
  cwd: string;
  rootId: string;
  children: readonly { unitId: string; commit: string }[];
  rootAcceptance: AcceptanceItem[];
  contracts: Contract[];
  /** 省略 = 逐条按验收 type 分档（透传 runAcceptances 的可选语义）；显式值统一覆盖全部批次 */
  timeoutMs?: number;
}): Promise<IntegrateResult> {
  const runId = `integrate-${randomUUID()}`;
  const evidenceBase = evidenceDir(getCwHome(), opts.cwd, opts.rootId, runId);
  mkdirSync(evidenceBase, { recursive: true });
  const reportPath = join(evidenceBase, REPORT_FILE_NAME);

  const failures: string[] = [];
  const childrenReachability: ChildReachability[] = [];

  // 步骤 0：merge 汇聚（wt-4 J1/D6）——子产出经显式 merge 汇入 root 分支
  // cw-root/<rootId>，集成语义从「隐式共享项目 HEAD」升级为「只信 root 分支」。
  // 内聚在本函数而非 loop：merge 失败也要落一份 integrate-report.json（VerifyRan
  // 的 reportHash 必填约束才有文件可指），复用既有连续失败上限通道
  const rootBranch = unitBranchName(opts.rootId, opts.rootId);
  const rootWorktreeDir = worktreePath(getCwWorktreeHome(), opts.cwd, opts.rootId);
  const base = revParseHead(opts.cwd);
  if (base === null) {
    failures.push(
      `无法解析项目 HEAD（仓库 "${opts.cwd}"）：merge 汇聚缺 base commit。` +
        "恢复动作：确认 cwd 是目标 git 仓库且有提交（git rev-parse HEAD 应输出 hash）后重试。",
    );
  } else {
    const ensured = ensureUnitWorktree(opts.cwd, rootWorktreeDir, opts.rootId, opts.rootId, base);
    if (!ensured.ok) {
      failures.push(`root worktree 就绪失败（unit "${opts.rootId}"）：${ensured.error}`);
    } else {
      mergeChildrenIntoRoot(opts, rootWorktreeDir, rootBranch, failures);
    }
  }

  // 步骤 1：子 commit 可达性（wt-4 J2：锚 root 分支引用——子 commit 只在 root
  // 分支可达，对项目 cwd HEAD（用户自己的分支）永不可达，锚错则可达性检查全灭）
  const head = revParseRef(opts.cwd, rootBranch);
  for (const child of opts.children) {
    const reachable = head !== null && isAncestorOf(opts.cwd, child.commit, rootBranch);
    childrenReachability.push({ unitId: child.unitId, commit: child.commit, reachable });
    if (!reachable) {
      failures.push(
        `子节点 ${child.unitId} 的 build commit ${child.commit} 在 root 分支 ${rootBranch} 不可达（集成树未包含其产出）。` +
          `恢复动作：在 root worktree（cd "${rootWorktreeDir}"）merge 该子分支，或在其 unit 重新提交 build 证据，` +
          `使 ${rootBranch} 包含其产出后集成重试。`,
      );
    }
  }

  // 子验收批次装载（账本最后一条 spec 的冻结验收；无 spec 的子报失败跳过该批）
  const batches: PendingBatch[] = [];
  const childSpecAcceptance = childAcceptanceFromLedger(opts.cwd, opts.children, failures);
  batches.push(...childSpecAcceptance);
  batches.push({ unitId: opts.rootId, acceptance: [...opts.rootAcceptance] });

  const batchesReport: AcceptanceBatchResult[] = [];
  let contracts: ContractMatchResult = { ok: true, failures: [] };

  // 步骤 2：干净 checkout（root 分支 HEAD = 集成时刻最终树；J2：传解析后 hash——
  // 分支名在 clone 内不存在，clone 只携带 remote-tracking refs）
  let checkout: { ok: true; dir: string } | { ok: false; error: string } | null = null;
  if (head === null) {
    failures.push(
      `无法解析 root 分支 ${rootBranch}（仓库 "${opts.cwd}"）：集成验证的检出锚点缺失。` +
        `恢复动作：git -C "${opts.cwd}" branch ${rootBranch} <commit> 重建集成锚点分支后集成重试。`,
    );
  } else {
    checkout = cleanCheckout(opts.cwd, head);
    if (!checkout.ok) {
      failures.push(
        `干净 checkout 失败（${rootBranch} HEAD ${head}，仓库 "${opts.cwd}"）：${checkout.error}。` +
          "恢复动作：确认 cwd 是目标 git 仓库、root 分支提交完整（git -C <cwd> status）后集成重试。",
      );
    }
  }

  if (checkout !== null && checkout.ok) {
    try {
      // 步骤 3：受影响验收重跑（逐 unit 批次，产物落 evidence 下各 unit 子目录）
      for (const batch of batches) {
        const batchDir = join(evidenceBase, fileStem(batch.unitId));
        let outcome: RunOutcome;
        try {
          outcome = runAcceptances(checkout.dir, batch.acceptance, batchDir, opts.timeoutMs);
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          failures.push(
            `验收执行框架失败（unit ${batch.unitId}，产物目录 ${batchDir}）：${detail}。` +
              "恢复动作：检查磁盘权限与 evidence 目录可写性后集成重试。",
          );
          batchesReport.push({ unitId: batch.unitId, results: [] });
          continue;
        }
        batchesReport.push({ unitId: batch.unitId, results: outcome.results.map(trimResult) });
        for (const r of outcome.results) {
          if (r.status === "fail") {
            failures.push(`验收 ${r.id}（unit ${batch.unitId}）fail：${r.reason ?? "未知原因"}`);
          }
        }
      }

      // 步骤 4：契约比对（跨节点承诺配对）
      contracts = matchContracts({ contracts: opts.contracts, checkoutDir: checkout.dir });
      failures.push(...contracts.failures);
    } finally {
      cleanupCheckout(checkout.dir);
    }
  } else {
    // checkout 缺位时批次结果留空记录（哪些批次本应跑、因环境问题未跑，报告可见）
    batchesReport.push(...batches.map((b) => ({ unitId: b.unitId, results: [] })));
  }

  // 步骤 5：汇总 + 报告落盘（fx-2 R4a：失败汇总追加二选一恢复路径说明——契约
  // 漂移的归属判断与 loop 派 designer 处置任务书同口径，单一出处）
  const ok = failures.length === 0;
  if (!ok) {
    failures.push(integrationRecoveryGuidance(opts.rootId));
  }
  const report: IntegrateReport = {
    kind: "integrate",
    rootId: opts.rootId,
    runId,
    head: head ?? "",
    children: childrenReachability,
    acceptanceBatches: batchesReport,
    contracts,
    ok,
    failures,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, REPORT_INDENT)}\n`, "utf-8");
  return { ok, failures, runId, reportPath };
}

/**
 * 集成失败的恢复路径说明（fx-2 R4a，验收文档 fx-2-acceptance.md 锁定的二选一
 * 文案）：① 契约与实现语义等价但文本不等 → 修 spec 走重新过审链（fx-1 R2 第
 * 四分支已打通补审出口）；② 契约正确而实现跑偏 → 需 provider 修复，但 closed
 * 的 provider 无自动回退通道（状态机不重开 closed unit——已知边界，如实告知需
 * 人工介入）。loop 的 designer 处置任务书（integrationDriftTasks）引用同一出处。
 */
export function integrationRecoveryGuidance(unitId: string): string {
  return [
    "集成失败恢复路径（二选一）：",
    "① 实现与契约语义等价但文本不等（如 async 修饰差异）→ 修正 spec 的契约签名后重新提交并过审：",
    `   cw evidence submit --kind spec --unit ${unitId} --file spec.json`,
    `   cw review submit --unit ${unitId} --verdict-kind spec-review --verdict pass`,
    "   （走既有重新过审链：过审后集成按正常路径重跑，连续 fail 计数随新 spec 提交清零）",
    "② 契约本身正确而实现跑偏 → 需 provider 修复——closed 的 provider 无自动回退通道",
    "   （状态机不重开 closed unit，已知边界），需人工介入，不要试图绕过状态机改实现。",
  ].join("\n");
}

/**
 * 读取已落盘的集成报告（fx-2：loop 达到重派上限后派 designer 的处置任务书需要
 * 最近一次失败事实——契约清单与失败验收 id）。不可读 / 形状不符返回 null（调用
 * 方兜底降级，不炸循环）。
 */
export function readIntegrateReport(
  cwd: string,
  rootId: string,
  runId: string,
): { report: IntegrateReport; reportPath: string } | null {
  const reportPath = join(evidenceDir(getCwHome(), cwd, rootId, runId), REPORT_FILE_NAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf-8"));
  } catch {
    return null;
  }
  return isIntegrateReport(parsed) ? { report: parsed, reportPath } : null;
}

/** JSON.parse 产物的形状守卫（unknown → IntegrateReport；只校验消费端触及的字段） */
function isIntegrateReport(value: unknown): value is IntegrateReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const contracts = v.contracts as Record<string, unknown> | undefined;
  return (
    v.kind === "integrate" &&
    typeof v.rootId === "string" &&
    Array.isArray(v.children) &&
    Array.isArray(v.acceptanceBatches) &&
    v.acceptanceBatches.every(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        typeof (b as Record<string, unknown>).unitId === "string" &&
        Array.isArray((b as Record<string, unknown>).results),
    ) &&
    typeof contracts === "object" &&
    contracts !== null &&
    Array.isArray(contracts.failures) &&
    typeof v.ok === "boolean" &&
    Array.isArray(v.failures)
  );
}

/** 从账本读取各子的最后一条冻结 spec 验收；无 spec 的子计 failure 并跳过该批 */
function childAcceptanceFromLedger(
  cwd: string,
  children: readonly { unitId: string; commit: string }[],
  failures: string[],
): PendingBatch[] {
  const { projection } = loadLedger(cwd);
  const batches: PendingBatch[] = [];
  for (const child of children) {
    const unit = projection.units.get(child.unitId);
    const lastSpec = unit?.specs[unit.specs.length - 1];
    if (lastSpec === undefined) {
      failures.push(
        `子节点 ${child.unitId} 账本内无冻结 spec，其验收无从重跑。` +
          "恢复动作：为该 unit 提交 spec 并过 spec-review（cw evidence submit --kind spec）后集成重试。",
      );
      continue;
    }
    batches.push({ unitId: child.unitId, acceptance: lastSpec.acceptance });
  }
  return batches;
}

/** AcceptanceRunResult → 报告精简条目（stdout/stderr 路径留在产物目录可按 id 定位） */
function trimResult(r: AcceptanceRunResult): { id: string; status: "pass" | "fail"; reason?: string } {
  return r.status === "pass" ? { id: r.id, status: r.status } : { id: r.id, status: r.status, reason: r.reason };
}

/** unitId → 产物子目录名（与 verify/run.ts 的 fileStem 同规则：路径字符替换防逃逸） */
function fileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function revParseHead(cwd: string): string | null {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  if (res.error !== undefined || res.status !== 0) {
    return null;
  }
  return (res.stdout ?? "").trim();
}

/** 解析 ref（root 分支等）指向的 commit hash；失败 = 集成锚点缺失（J2） */
function revParseRef(cwd: string, ref: string): string | null {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", ref], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  if (res.error !== undefined || res.status !== 0) {
    return null;
  }
  return (res.stdout ?? "").trim();
}

/** commit 是否经 ref 可达（merge-base --is-ancestor；自含 commit 即 ref HEAD 也算可达） */
function isAncestorOf(cwd: string, commit: string, ref: string): boolean {
  const res = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", commit, ref], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  return res.error === undefined && res.status === 0;
}

/** 分支 ref 是否存在（--quiet 静默不存在时的 fatal 输出） */
function branchRefExists(cwd: string, branch: string): boolean {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", branch], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  return res.error === undefined && res.status === 0;
}

/**
 * 跑一条 git 命令：成功返回 null，失败返回人可读原因（error message / exit code + stderr）。
 * 分支名经 unitBranchName 双空间拼接（slug 白名单），spawnSync 不经 shell，无注入面。
 */
function gitStep(cwd: string, args: readonly string[]): string | null {
  const res = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  if (res.error === undefined && res.status === 0) {
    return null;
  }
  if (res.error !== undefined) {
    return res.error.message;
  }
  const errText = (res.stderr ?? "").trim();
  return `exit ${res.status ?? "null"}${errText === "" ? "" : ` — ${errText}`}`;
}

/**
 * 步骤 0 的逐子汇聚（J1）：已达则跳过（幂等重跑天然成立——集成 pass 后子分支已
 * 删，可达性对 root 分支成立，不会再次触 merge）；否则在 root worktree 执行
 * merge --no-edit，成功后 best-effort 静默删子分支（P-wt5：commit 经 root 分支
 * 可达，GC 安全）；冲突则 merge --abort 清现场 + 收 failure（含 root worktree
 * 路径与 CW_PROJECT_DIR 内联前缀的恢复指引——与 human 指引口径一致）。
 */
function mergeChildrenIntoRoot(
  opts: { cwd: string; rootId: string; children: readonly { unitId: string; commit: string }[] },
  rootWorktreeDir: string,
  rootBranch: string,
  failures: string[],
): void {
  for (const child of opts.children) {
    if (isAncestorOf(opts.cwd, child.commit, rootBranch)) {
      continue;
    }
    const childBranch = unitBranchName(opts.rootId, child.unitId);
    if (!branchRefExists(opts.cwd, childBranch)) {
      failures.push(
        `子节点 ${child.unitId} 的 build commit ${child.commit} 不在 root 分支 ${rootBranch} 可达，` +
          `且子分支 ${childBranch} 不存在——产出无处可汇聚。恢复动作：git -C "${opts.cwd}" branch ${childBranch} ${child.commit} ` +
          `重建子分支后集成重试（若子产出已失效，在其 unit 重新提交 build 证据）。`,
      );
      continue;
    }
    const mergeErr = gitStep(rootWorktreeDir, ["merge", "--no-edit", childBranch]);
    if (mergeErr === null) {
      // best-effort 静默：子 commit 已 merge 进 root 分支，分支删除失败（如被
      // 其他 worktree 占用）不构成集成失败，残留分支无害
      gitStep(opts.cwd, ["branch", "-D", childBranch]);
      continue;
    }
    // 清冲突现场（best-effort：merge 未真正启动时 abort 报错，忽略）
    gitStep(rootWorktreeDir, ["merge", "--abort"]);
    failures.push(
      `子 ${child.unitId} merge 冲突（${rootBranch} ← ${childBranch}）：${mergeErr}。` +
        `恢复动作：cd "${rootWorktreeDir}" 人工解决冲突后 git commit，再以 ` +
        `CW_PROJECT_DIR="${opts.cwd}" cw evidence submit --kind build --unit ${opts.rootId} ` +
        `--commit <hash> --run-id <runId> 提交推进，集成将按新证据重试。`,
    );
  }
}
