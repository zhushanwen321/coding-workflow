/**
 * 红阶段 gate（canon §3.3 D5 三道 gate 之一；u4b 验收文档锁定语义）。
 *
 * 红阶段 = 测试区分力检查：把 build evidence 的 commit 回退到第一父（实现前的
 * 基线树）重跑同一套验收，逐条期望 fail——旧树 fail 才证明验收真的在检测实现，
 * 而非 `echo ok` 类恒绿假命令。它不是验证结论，不写 VerifyRan，产物落 red-phase
 * 专属目录留审计（由 handler 负责）。
 *
 * 本模块只做两件可单测的纯判定：
 *   - firstParentOf：git rev-list --parents 解析第一父（`commit^` 语义），初始
 *     commit 无父时返回 noParent（调用方走 exit 2 环境错误路径）；
 *   - judgeRedPhase：逐条判定有/无区分力。
 */
import { spawnSync } from "node:child_process";

import type { AcceptanceRunResult } from "./run.js";

/** 单步 git 操作超时（本地 rev-list 毫秒级；上限仅防外部仓库挂死 runner） */
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

export interface RedPhaseVerdict {
  id: string;
  discriminative: boolean;
  reason: string;
}

/**
 * 逐条判定红阶段区分力（输入是父 commit 树上的执行结果）：
 *   - 旧树 pass → 无区分力（验收对新实现没有检测力）；
 *   - 适配器 translate/parse 抛错且命令效果上成功（未执行或 exit 0）→ 无区分力
 *     （echo ok 类假命令防线：命令没挂，只是产物里没有可判定的用例事实）；
 *   - 其余 fail（命令挂 / 文件缺失 / 测试失败 / 超时 / 用例标记 FAIL / 未出现在
 *     产物）→ 有区分力。
 */
export function judgeRedPhase(results: readonly AcceptanceRunResult[]): RedPhaseVerdict[] {
  return results.map((r) => {
    if (r.status === "pass") {
      return {
        id: r.id,
        discriminative: false,
        reason: "旧树（父 commit）上即 pass——验收对新实现无区分力",
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
