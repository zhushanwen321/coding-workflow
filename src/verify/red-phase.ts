/**
 * 红阶段 gate（canon §3.3 D5 三道 gate 之一；u4b 验收文档锁定语义，rv-4 起由
 * verify handler 默认接线执行——不再是 opt-in 的 standalone 模式）。
 *
 * 红阶段 = 测试区分力检查：把 build evidence 的 commit 回退到第一父（实现前的
 * 基线树）重跑同一套验收，逐条期望 fail——旧树 fail 才证明验收真的在检测实现，
 * 而非 `echo ok` 类恒绿假命令。设计语义是「新测试 patch 到旧代码树必挂」：
 * 只回退不 patch 时，恒真测试（如 `expect(true).toBe(true)`）放进新文件即可
 * 让父树命令因文件缺失 fail，被误判有区分力（对抗审查实测的穿透路径）——
 * 因此先把「验收 command 引用的变更文件」patch 进父树再跑。
 *
 * 本模块只做可单测的纯判定/git 步骤（入账与 report.json 的 redPhase 节组装由
 * handler 负责；红阶段执行产物落 red-phase- 前缀 runId 目录留审计）：
 *   - firstParentOf：git rev-list --parents 解析第一父（`commit^` 语义），初始
 *     commit 无父时返回 noParent（rv-4 起调用方走「合法跳过」路径——单 commit
 *     仓库 verify 必须可用，见 verify.ts executeRedPhase）；
 *   - changedFilesBetween / testFilesToPatch / patchAcceptanceFiles：patch 语义
 *     三步（变更集 → 验收引用文件 → checkout 进父树），在一次性 checkout 工作区
 *     内执行，不触碰原仓库；
 *   - judgeRedPhase：逐条判定有/无区分力。rv-5：nondeterministic 声明条目跳过
 *     判定（随机用例在旧树的 pass/fail 无区分力语义）——跳过条目 discriminative
 *     恒 true、不参与整体 fail 判定，reason 注明跳过原因（报告侧显性）。
 */
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

import type { AcceptanceItem } from "../events/types.js";
import type { AcceptanceRunResult } from "./run.js";

/** 单步 git 操作超时（本地 rev-list/diff/checkout 毫秒级；上限仅防外部仓库挂死 runner） */
const GIT_STEP_TIMEOUT_MS = 120_000;

export type FirstParentOutcome =
  | { ok: true; commit: string }
  | { ok: false; noParent: boolean; error: string };

/**
 * 解析 commit 的第一父（`commit^`）。
 * 用 rev-list --parents 而非 rev-parse `<commit>^`：后者对「无父」和「commit 不存在」
 * 输出同一种失败，无法区分两种调用方语义（exit 2 的附说明 vs 环境错误）。
 */
export function firstParentOf(repoDir: string, commit: string): FirstParentOutcome {
  const res = spawnSync("git", ["rev-list", "--parents", "-n", "1", commit], {
    cwd: repoDir,
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  if (res.error !== undefined || res.status !== 0) {
    const detail =
      res.error !== undefined
        ? res.error.message
        : `exit ${res.status ?? "null"}${res.stderr?.trim() === "" ? "" : ` — ${res.stderr?.trim()}`}`;
    return { ok: false, noParent: false, error: `git rev-list --parents ${commit} 失败：${detail}` };
  }
  const hashes = (res.stdout ?? "").trim().split(/\s+/);
  // 输出形如 "<commit> <parent1> [<parent2>...]"，第一父即 parent1（`commit^` 语义）；
  // 初始 commit 输出只有自身一个 hash（无父）
  const [, firstParent] = hashes;
  if (firstParent === undefined) {
    return {
      ok: false,
      noParent: true,
      error: `commit ${commit} 无父 commit（初始 commit），红阶段无「实现前」基线树可回退`,
    };
  }
  return { ok: true, commit: firstParent };
}

export type ChangedFilesOutcome =
  | { ok: true; files: string[] }
  | { ok: false; error: string };

/**
 * 两 commit 间的变更文件集（仓库相对路径，无前导 ./）。
 * --diff-filter=ACMRT 排除 D（被删文件在 build commit 中不存在，patch 无从取）；
 * core.quotePath=false 保持非 ASCII 路径原样输出（默认会对齐 C 转义加引号，
 * 与后续 checkout pathspec 对不上）。
 */
export function changedFilesBetween(
  repoDir: string,
  parentCommit: string,
  buildCommit: string,
): ChangedFilesOutcome {
  const res = spawnSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=ACMRT", parentCommit, buildCommit],
    { cwd: repoDir, encoding: "utf-8", timeout: GIT_STEP_TIMEOUT_MS },
  );
  if (res.error !== undefined || res.status !== 0) {
    const detail =
      res.error !== undefined
        ? res.error.message
        : `exit ${res.status ?? "null"}${res.stderr?.trim() === "" ? "" : ` — ${res.stderr?.trim()}`}`;
    return { ok: false, error: `git diff --name-only ${parentCommit} ${buildCommit} 失败：${detail}` };
  }
  const files = (res.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { ok: true, files };
}

/**
 * 变更文件集中被任一验收 command 引用的文件（通常就是新增/修改的测试入口）。
 * 匹配两种形态：仓库相对路径（`tests/a.test.ts`）与 basename（`a.test.ts`）——
 * command 常写相对路径，也可能只写文件名。启发式只用于「带哪些文件进父树」，
 * 带多了（如 command 恰好引用了实现文件）只会让判定更严，不会漏判。
 */
export function testFilesToPatch(
  changedFiles: readonly string[],
  acceptance: readonly AcceptanceItem[],
): string[] {
  const commands = acceptance
    .map((ac) => ac.command ?? "")
    .filter((command) => command !== "");
  return changedFiles.filter((file) =>
    commands.some((command) => command.includes(file) || command.includes(basename(file))),
  );
}

export type PatchOutcome =
  | { ok: true; files: string[] }
  | { ok: false; error: string };

/**
 * patch 语义的 handler 单入口：算变更集 → 挑验收引用文件 → `git checkout
 * <buildCommit> -- <files>` 带进父树工作区（wsDir 是一次性 checkout 工作区，
 * 在其内改动是安全操作，不触碰原仓库）。files 为空 = 无可 patch（调用方保留
 * 父树原样跑的现状口径）。
 */
export function patchAcceptanceFilesForRedPhase(
  wsDir: string,
  parentCommit: string,
  buildCommit: string,
  acceptance: readonly AcceptanceItem[],
): PatchOutcome {
  const changed = changedFilesBetween(wsDir, parentCommit, buildCommit);
  if (!changed.ok) {
    return { ok: false, error: changed.error };
  }
  const files = testFilesToPatch(changed.files, acceptance);
  if (files.length === 0) {
    return { ok: true, files: [] };
  }
  const res = spawnSync("git", ["-C", wsDir, "checkout", buildCommit, "--", ...files], {
    cwd: wsDir,
    encoding: "utf-8",
    timeout: GIT_STEP_TIMEOUT_MS,
  });
  if (res.error !== undefined || res.status !== 0) {
    const detail =
      res.error !== undefined
        ? res.error.message
        : `exit ${res.status ?? "null"}${res.stderr?.trim() === "" ? "" : ` — ${res.stderr?.trim()}`}`;
    return { ok: false, error: `git checkout ${buildCommit} -- ${files.join(" ")} 失败：${detail}` };
  }
  return { ok: true, files };
}

export interface RedPhaseVerdict {
  id: string;
  discriminative: boolean;
  reason: string;
}

/** judgeRedPhase 的语境：patch 进父树的验收引用文件（影响「pass」的拒绝文案） */
export interface RedPhaseContext {
  /** 非空 = 判定树是「基线代码 + 新测试 patch」组合，而非父 commit 原样树 */
  patchedFiles?: readonly string[];
}

/**
 * 逐条判定红阶段区分力（输入是父 commit 树——必要时已 patch 新测试——上的
 * 执行结果）：
 *   - nondeterministic 声明条目 → 跳过判定（rv-5：随机用例在旧树的 pass/fail
 *     本身无区分力语义——随机挂与随机过都不证明验收强弱；跳过条目
 *     discriminative 恒 true 且不参与整体 fail 判定，reason 注明跳过原因）；
 *   - patch 树上 pass → 无区分力（新测试在基线代码树上也通过 = 恒真测试穿透，
 *     正是 patch 语义要堵的作弊路径：新建文件让父树命令因文件缺失而 fail）；
 *   - 未 patch 的旧树 pass → 无区分力（验收对新实现没有检测力）；
 *   - 适配器 translate/parse 抛错且命令效果上成功（未执行或 exit 0）→ 无区分力
 *     （echo ok 类假命令防线：命令没挂，只是产物里没有可判定的用例事实）；
 *   - 其余 fail（命令挂 / 文件缺失 / 测试失败 / 超时 / 用例标记 FAIL / 未出现在
 *     产物）→ 有区分力。
 */
export function judgeRedPhase(
  results: readonly AcceptanceRunResult[],
  ctx?: RedPhaseContext,
): RedPhaseVerdict[] {
  const patched = (ctx?.patchedFiles?.length ?? 0) > 0;
  return results.map((r) => {
    if (r.nameSkipped === "nondeterministic") {
      return {
        id: r.id,
        discriminative: true,
        reason:
          `跳过（nondeterministic 声明）：随机用例在旧树的 pass/fail 无区分力语义，` +
          `验收 ${r.id} 不参与红阶段判定（执行产物照常落盘 red-phase- 目录留审计）。`,
      };
    }
    if (r.status === "pass") {
      return {
        id: r.id,
        discriminative: false,
        reason: patched
          ? "测试无区分力：新测试在基线代码树（父 commit + patch 后的测试文件）上也通过——疑似恒真测试。" +
            "恢复动作：加强验收断言（assert 实现产物的具体特征，而非仅 assert 存在）；" +
            "或把 type 改为 e2e-real/e2e-mock 走适配器路由（标记行 + exit code 天然有区分力）；修测试而非新建文件绕过。"
          : "旧树（父 commit）上即 pass——验收对新实现无区分力。" +
            "恢复动作：加强验收断言让它在无实现时 fail；或把 type 改为 e2e-real/e2e-mock。",
      };
    }
    if (r.parseError && (r.commandExit === null || r.commandExit === 0)) {
      return {
        id: r.id,
        discriminative: false,
        reason: r.reason ?? "适配器无法产出有效产物且命令未失败——echo ok 类假命令",
      };
    }
    return { id: r.id, discriminative: true, reason: r.reason ?? "旧树上失败" };
  });
}
