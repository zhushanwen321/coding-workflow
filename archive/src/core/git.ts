/**
 * v1 git 只读操作封装（core 层基础设施，无领域语义）。
 *
 * 来源：design-v5-wave.md §4.4（changedFiles 是客观字段，cw 从 commit 提取，不靠 agent 声明）。
 *
 * 职责：封装只读 git 子进程调用（spawnSync），供 handler 层提取 commit 变更信息。
 *      与 rules/gates/test.ts 的 commitExists（git cat-file）同模式——只读 git，不引入新依赖。
 *
 * 不变量：
 * - 只读：只调用 git 的只读子命令（rev-parse / diff / cat-file），不 mutate 仓库状态
 * - 不抛异常：提取失败（commit 不存在 / 无父提交 / 非 git 仓库）返回空数组 + note，
 *   不阻断 execute。commit 存在性由 test gate commitExists 兜底，execute 阶段提取失败
 *   多为 initial commit / 非 git 仓库等边界，记入 evidence.extractionNote 供人审
 */
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { spawnSync } from "node:child_process";

import type { RepoMeta } from "../store/schema.js";

/** extractChangedFiles 的返回——提取成功时 changedFiles 非空（或空但无 note），失败时带 note。 */
export interface ExtractResult {
  /** 变更文件列表（相对仓库根的路径）。提取失败时为空数组。 */
  changedFiles: string[];
  /** 提取失败时的原因（提取成功时为 undefined）。 */
  note?: string;
}

/**
 * spawnSync 通用配置（所有只读 git 调用共用）。
 *
 * - stdio 显式 `["ignore", "pipe", "pipe"]`：避免父进程的 stdin 被 git 继承导致 hang；
 *   stdout/stderr 走 pipe 由 spawnSync 捕获到结果对象。
 * - encoding: "utf-8"：stdout/stderr 直接是字符串，免去 Buffer.toString。
 * - shell: false：禁用 shell 解释器，避免空格/引号注入。
 * - maxBuffer：Node 默认 1MB 对 git diff 长输出不够（大型 monorepo 变更文件列表可能 >1MB），
 *   拉到 16MB（即 spawnSync 的硬上限），保留完整错误上下文供 evidence.extractionNote 人审。
 */
/** spawnSync maxBuffer 上限（Node 硬上限 16MB）。 */
// eslint-disable-next-line no-magic-numbers -- Node 硬上限，字面量即文档
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** KB→bytes 转换系数（让 maxBuffer / 截断阈值的写法保持 KB 语义）。 */
const BYTES_PER_KB = 1024;
/** 截断为「首一半 + 尾一半」时的除数。 */
const HALF_DIVISOR = 2;
const GIT_SPAWN_OPTS: SpawnSyncOptionsWithStringEncoding = {
  // cwd 不在此设——每个 spawnSync 调用点都必须显式传 cwd（workspacePath），
  // 否则会用进程默认 cwd，导致跨 worktree 场景读错仓库。
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  maxBuffer: MAX_BUFFER_BYTES,
};

/** stderr 截断阈值（2KB）。原代码仅 trim，丢失首尾空白后的多行错误信息；2KB 足够覆盖常见 git 报错。 */
// eslint-disable-next-line no-magic-numbers -- KB 数（按 1024 字节）
const STDERR_CONTEXT_LIMIT = 2 * BYTES_PER_KB;
/** stdout 截断阈值（2KB，失败时 stdout 可能也有内容——如 git diff 异常时的部分输出）。 */
// eslint-disable-next-line no-magic-numbers -- KB 数（按 1024 字节）
const STDOUT_CONTEXT_LIMIT = 2 * BYTES_PER_KB;

/**
 * 把 git 子进程输出裁成「可读摘要」（失败 note 用），保留多行与首尾关键信息。
 *
 * - 整体超过 2KB：保留首 1KB + 「... <N> chars omitted ...」+ 末 1KB（首尾通常含命令+关键错误）
 * - 不足 2KB：直接 trim
 *
 * 注意：trim 仅去首尾空白，保留中间换行（git 错误常多行，含 stack 帧 + 提示）。
 *
 * @param output spawnSync 返回的 stdout/stderr（encoding utf-8 时为 string）
 * @param limit 字节上限
 */
function clipOutput(output: string, limit: number): string {
  const trimmed = output.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  const half = Math.floor(limit / HALF_DIVISOR);
  const omitted = trimmed.length - limit;
  return `${trimmed.slice(0, half)}\n... <${omitted} chars omitted> ...\n${trimmed.slice(-half)}`;
}

/**
 * 把 git 子进程失败结果组装成可读 note（含 stderr 摘要 + stdout 头部）。
 *
 * git diff / rev-parse 失败时 stderr 通常含根本原因，stdout 也可能有部分输出
 * （如 diff 在 binary 文件 / rename 时 stdout 先输出再 abort），两者都要附上方便排错。
 */
function formatFailureNote(command: string, result: { status: number | null; stderr: string; stdout: string }): string {
  const stderrCtx = clipOutput(result.stderr, STDERR_CONTEXT_LIMIT);
  const stdoutCtx = clipOutput(result.stdout, STDOUT_CONTEXT_LIMIT);
  const parts = [
    `${command} 失败 (exit=${result.status ?? "null"})`,
    stderrCtx ? `stderr: ${stderrCtx}` : "stderr: (空)",
  ];
  if (stdoutCtx) {
    parts.push(`stdout: ${stdoutCtx}`);
  }
  return parts.join(" | ");
}

/**
 * 从 commit 提取变更文件列表（相对仓库根的路径）。
 *
 * 机制：`git diff --name-only <parent> <commit>`。先取父 commit（`git rev-parse <commit>^`），
 * 无父提交（initial commit）时 git diff 无法对比，返回空数组 + note。
 *
 * @param workspacePath  仓库工作目录（cwd 绑定到 spawnSync）
 * @param commitHash     目标 commit hash（存在性由调用方/test gate 兜底）
 * @returns 提取结果（成功带 changedFiles，失败带 note），永不抛异常
 */
export function extractChangedFiles(
  workspacePath: string,
  commitHash: string,
): ExtractResult {
  // 先取父 commit（initial commit 无父提交，git rev-parse <commit>^ 失败）
  const parent = spawnSync(
    "git",
    ["rev-parse", `${commitHash}^`],
    { ...GIT_SPAWN_OPTS, cwd: workspacePath },
  );
  if (parent.status !== 0) {
    // 无父提交是预期失败（initial commit / commit 不存在），保留原友好文案；
    // 但附上 stderr/stdout 上下文方便排错（maxBuffer 16MB 保住完整 stderr，不至于「信息丢失」）。
    const friendly = "无父提交（可能是 initial commit 或 commit 不存在），跳过 changedFiles 提取";
    const detail = formatFailureNote(`git rev-parse ${commitHash}^`, {
      status: parent.status,
      stderr: parent.stderr,
      stdout: parent.stdout,
    });
    return { changedFiles: [], note: `${friendly}（${detail}）` };
  }
  const parentHash = parent.stdout.trim();

  const diff = spawnSync(
    "git",
    ["diff", "--name-only", parentHash, commitHash],
    { ...GIT_SPAWN_OPTS, cwd: workspacePath },
  );
  if (diff.status !== 0) {
    return {
      changedFiles: [],
      note: formatFailureNote(
        `git diff --name-only ${parentHash} ${commitHash}`,
        { status: diff.status, stderr: diff.stderr, stdout: diff.stdout },
      ),
    };
  }

  const changedFiles = diff.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { changedFiles };
}

/**
 * 采集 git repo 元信息（remoteUrl/branch/headCommit），用于 store.json 顶层 repoMeta。
 *
 * 与 extractChangedFiles 同风格：spawnSync + GIT_SPAWN_OPTS，失败降级不抛。
 * 每个字段独立采集，单个 git 命令失败不影响其他字段。
 *
 * @param cwd 工作目录绝对路径（直接作为 repoMeta.worktreePath）
 */
export function collectRepoMeta(cwd: string): RepoMeta {
  const runGit = (args: string[]): string => {
    const result = spawnSync("git", args, { ...GIT_SPAWN_OPTS, cwd });
    if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
      return "";
    }
    return result.stdout.trim();
  };

  const remoteUrl = runGit(["remote", "get-url", "origin"]);
  // detached HEAD 时 rev-parse --abbrev-ref HEAD 返回 "HEAD"，保留这个值
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const headCommit = runGit(["rev-parse", "--short", "HEAD"]);

  return {
    remoteUrl,
    branch,
    worktreePath: cwd,
    headCommit,
    recordedAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════
// workspace 探测（store 归一化 + worktree 根解析，ADR-0014）
// ═══════════════════════════════════════════════════════════════

/**
 * 进程内 memoize 缓存：同一 workspacePath 的 common-dir / toplevel 探测结果。
 *
 * 来源：ADR-0014 决策 6。store 归一化下沉到 cw-cli 内部后，单次 cw 写 action 内多次
 * `new CwStore`（getCwJsonPath 探测 common-dir）+ constructCwDeps（探测 toplevel）会
 * 重复 spawn git；进程内一次性 memoize 消除重复开销。
 *
 * 与「跨进程持久缓存」的本质区别（决策 6 允许本 cache 的理由）：进程内同 cwd 不变，
 * 探测结果稳定，不引入失效/一致性运行时断言；进程退出即失效（每次 cw 调用独立 cache）。
 *
 * 两函数共享一份 cache（按 workspacePath 索引），各字段懒填充：detectCommonDir 首次
 * 调用只 probe common-dir（不 probe toplevel），反之亦然——故「两次 detectCommonDir(同 path)」
 * 只 spawn 1 次（TC6）。
 */
interface WorkspaceDetection {
  commonDir?: string;
  toplevel?: string;
}
const detectedWorkspaceCache = new Map<string, WorkspaceDetection>();

/**
 * spawnSync git 只读探测：status===0 且 stdout 非空返回 trim 后字符串，否则返回 null。
 *
 * 与 collectRepoMeta 的 runGit 同判定逻辑（status===0 + 无 error + stdout 是 string），
 * 失败返回 null 由调用方决定 fallback，保持探测与降级职责分离。
 */
function probeGit(workspacePath: string, args: string[]): string | null {
  const result = spawnSync("git", args, { ...GIT_SPAWN_OPTS, cwd: workspacePath });
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
    return null;
  }
  const trimmed = result.stdout.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 探测 git common-dir 绝对路径——store-key 基准（ADR-0014 决策 1/2）。
 *
 * `git rev-parse --path-format=absolute --git-common-dir`：
 *   - 普通 repo（.git 目录）：`<repo>/.git` 绝对路径
 *   - bare repo worktree：`<bare>` 绝对路径（所有 worktree 相同 → store 共享）
 *   - linked worktree：主 repo 的 `.git` 绝对路径（与主 worktree 共享同一 store）
 *
 * `--path-format=absolute` 是硬约束（决策 2）：裸命令在普通 repo 返回相对 `.git`，
 * `encodeCwd('.git')` 无 `/` → 所有普通 repo store 全局撞名 `~/.cw/.git/`；子目录返回
 * `../../.git` → 同 repo 不同深度目录 store 分叉。absolute 在全场景返回稳定绝对路径。
 *
 * 失败（非 git 目录 / git 未装）→ fallback workspacePath（per-cwd 降级，保持现状行为）。
 * 进程内 memoize：同 workspacePath 第二次调用命中 cache，不重复 spawn。
 */
export function detectCommonDir(workspacePath: string): string {
  const entry = detectedWorkspaceCache.get(workspacePath);
  if (entry?.commonDir !== undefined) {
    return entry.commonDir;
  }
  const commonDir =
    probeGit(workspacePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]) ?? workspacePath;
  detectedWorkspaceCache.set(workspacePath, { ...entry, commonDir });
  return commonDir;
}

/**
 * 探测 git worktree 根——workspace 执行位置基准（ADR-0014 决策 3）。
 *
 * `git rev-parse --show-toplevel`：当前工作树根。agent 常在 worktree 子目录调 cw
 * （如 `src/`），cwd ≠ worktree 根；gitValidator/testRunner/fileExists 需绑 worktree 根，
 * 否则 git 校验 / 测试 / 文件定位漂移到子目录。
 *
 * 失败（非 git 目录 / git 未装）→ fallback workspacePath。进程内 memoize。
 */
export function detectWorktreeRoot(workspacePath: string): string {
  const entry = detectedWorkspaceCache.get(workspacePath);
  if (entry?.toplevel !== undefined) {
    return entry.toplevel;
  }
  const toplevel =
    probeGit(workspacePath, ["rev-parse", "--show-toplevel"]) ??
    workspacePath;
  detectedWorkspaceCache.set(workspacePath, { ...entry, toplevel });
  return toplevel;
}

/**
 * 从 commit 提取完整 commit message body。
 *
 * 机制：`git log -1 --format=%B <commitHash>`。与 extractChangedFiles 同风格：
 * spawnSync + GIT_SPAWN_OPTS，失败降级返回 null（不抛异常）。
 *
 * @param workspacePath 仓库工作目录（cwd 绑定到 spawnSync）
 * @param commitHash    目标 commit hash
 * @returns commit message body（string），失败返回 null
 */
export function extractCommitMessage(
  workspacePath: string,
  commitHash: string,
): string | null {
  const result = spawnSync(
    "git",
    ["log", "-1", "--format=%B", commitHash],
    { ...GIT_SPAWN_OPTS, cwd: workspacePath },
  );
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
    return null;
  }
  return result.stdout;
}

/**
 * 从 commit message 解析 `Cw-Abandon:` trailer 标记的 parent 条目 id 列表。
 *
 * 机制：读 commit message body，找 `Cw-Abandon:` 开头的行（git trailer 格式），
 * 提取冒号后的逗号分隔 id 列表。多个 trailer 行取最后一个（git trailer 标准行为）。
 *
 * 用途：wave execute 时解析，存入 wave.abandonedParentItems。
 * slice replan cascade 时，已声明废弃的 parent 条目不触发 abort（computeImpactCascade 例外）。
 *
 * 失败降级：commit 不存在 / 无 trailer / 解析失败 → 返回空数组（不抛异常）。
 * 与 extractChangedFiles / extractCommitMessage 同风格。
 *
 * @param workspacePath 仓库工作目录
 * @param commitHash    目标 commit hash
 * @returns 废弃的 parent 条目 id 列表（如 ["TC3"]），失败/无标记返回 []
 */
export function parseAbandonMarkers(
  workspacePath: string,
  commitHash: string,
): string[] {
  const body = extractCommitMessage(workspacePath, commitHash);
  if (body === null) return [];

  // 找最后一个 Cw-Abandon: trailer 行（git trailer 标准：空行后 key: value）
  const lines = body.split("\n");
  let lastAbandonLine: string | undefined;
  for (const line of lines) {
    if (/^Cw-Abandon:\s*/i.test(line.trim())) {
      lastAbandonLine = line.trim();
    }
  }
  if (!lastAbandonLine) return [];

  // 提取冒号后的 id 列表：split 逗号，trim，过滤空
  const afterColon = lastAbandonLine.replace(/^Cw-Abandon:\s*/i, "");
  return afterColon
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
