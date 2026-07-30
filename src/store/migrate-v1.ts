/**
 * 迁移旧 ~/.v1 存储到 ~/.cw（commit e10f05b 改了路径但没搬数据）。
 *
 * 进程级一次性：cli.ts main 入口调一次，不在 CwStore 构造函数里调（有 5 个调用点会重复触发）。
 * 幂等：~/.v1 不存在时秒返回，迁移过的环境零开销。
 */
import { existsSync, readdirSync, readFileSync,renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getCwHome } from "./schema.js";

/** 旧存储根目录（迁移前的 ~/.v1）。 */
function getLegacyV1Home(): string {
  return join(homedir(), ".v1");
}

/** 测试注入用：覆盖默认的 legacyHome / cwHome 解析。 */
export interface MigrateOpts {
  /** 旧 home 覆盖（测试用，生产不传走 homedir()/.v1）。 */
  legacyHome?: string;
  /** 新 home 覆盖（测试用，生产不传走 getCwHome()）。 */
  cwHome?: string;
}

/**
 * 迁移旧 ~/.v1 到 ~/.cw。
 *
 * 合并策略（按 encodedCwd 子目录逐个处理）：
 *   - 仅 ~/.v1 有 → rename 原子搬到 ~/.cw
 *   - 两边都有 → 比 repoMeta.recordedAt：v1 ≥ cw 取 v1 覆盖 cw（cw 版先删再搬）；cw > v1 删 v1
 *
 * 边界处理：
 *   - CW_HOME 被覆盖 → 不迁移（用户自定义路径，自己负责数据位置）
 *   - ~/.v1 不存在 → 秒返回（幂等）
 *   - 子目录无 _v1.json → 跳过（空目录或残留 .tmp/.lock）
 *   - _v1.json 解析失败 → warn 跳过，不删原文件（防数据丢失）
 *   - 全部处理完 ~/.v1 空了 → rmdir 清理
 *   - 任何 IO 异常 → console.warn，不抛（best-effort，不阻断 cw 启动）
 */
export function migrateLegacyV1Home(opts?: MigrateOpts): void {
  // 测试注入：opts 提供时跳过 CW_HOME 检查（测试显式控制两个 home 路径）
  const isTestMode = opts !== undefined;

  // 生产模式：CW_HOME 被覆盖 → 用户显式指定了存储位置，不擅自搬数据
  if (!isTestMode && process.env.CW_HOME !== undefined && process.env.CW_HOME !== "") {
    return;
  }

  const legacyHome = opts?.legacyHome ?? getLegacyV1Home();
  if (!existsSync(legacyHome)) {
    return; // 幂等：已迁移或全新安装
  }

  const cwHome = opts?.cwHome ?? getCwHome(); // 生产模式此时必为默认 ~/.cw

  let entries: string[];
  try {
    entries = readdirSync(legacyHome, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    console.warn(`[migrate-v1] 无法读取 ${legacyHome}，跳过迁移: ${(err as Error).message}`);
    return;
  }

  for (const encodedCwd of entries) {
    const legacyDir = join(legacyHome, encodedCwd);
    const legacyFile = join(legacyDir, "_v1.json");

    // 子目录无 _v1.json → 空目录或残留临时文件（.tmp/.lock），无数据价值，清理掉让 ~/.v1 能 rmdir
    if (!existsSync(legacyFile)) {
      try {
        rmSync(legacyDir, { recursive: true, force: true });
        // eslint-disable-next-line taste/no-silent-catch -- 迁移是 best-effort，IO 失败只记录不阻断 cw 启动
      } catch (err) {
        // best-effort：空目录残留无害，留给最后的非空检测处理
        console.debug(`[migrate-v1] 清理空目录 ${encodedCwd} 失败（忽略）: ${(err as Error).message}`);
      }
      continue;
    }

    const cwDir = join(cwHome, encodedCwd);
    // home 迁移在文件名迁移之前跑，此时 cwHome 里的文件还叫 _v1.json（文件名迁移才改成 store.json）
    const cwFile = join(cwDir, "_v1.json");

    try {
      // 统一校验：先读 legacyFile 解析 recordedAt，解析失败 → 跳过保留原文件（防数据丢失）
      const legacyData = readFileSync(legacyFile, "utf-8");
      const legacyRecordedAt = parseRecordedAt(legacyData, legacyFile);
      // parseRecordedAt 解析失败返回特殊标记，据此跳过
      if (legacyRecordedAt === PARSE_FAILED) {
        continue;
      }

      if (!existsSync(cwFile)) {
        // 仅 ~/.v1 有 → 直接搬整个目录（已校验可解析）
        renameSync(legacyDir, cwDir);
      } else {
        // 两边都有 → 比 recordedAt 决定保留哪份
        const cwRecordedAt = readCwRecordedAt(cwFile);

        if (legacyRecordedAt >= cwRecordedAt) {
          // ~/.v1 更新或相同 → v1 覆盖 cw（先删 cw 旧目录再搬 v1）
          rmSync(cwDir, { recursive: true, force: true });
          renameSync(legacyDir, cwDir);
        } else {
          // ~/.cw 更新 → 删 v1 旧目录
          rmSync(legacyDir, { recursive: true, force: true });
        }
      }
      // eslint-disable-next-line taste/no-silent-catch -- 迁移是 best-effort，IO 失败只 warn 不阻断 cw 启动
    } catch (err) {
      // best-effort：单个目录迁移失败不影响其他目录。原文件保留不丢数据
      console.warn(`[migrate-v1] 迁移 ${encodedCwd} 失败，跳过（原文件保留）: ${(err as Error).message}`);
    }
  }

  // 全部处理完，~/.v1 空了 → rmdir 清理（非空则保留，让用户手动看）
  try {
    const remaining = readdirSync(legacyHome);
    if (remaining.length === 0) {
      rmSync(legacyHome, { recursive: true, force: true });
    }
    // eslint-disable-next-line taste/no-silent-catch -- 迁移是 best-effort，IO 失败只记录不阻断 cw 启动
  } catch (err) {
    // best-effort：~/.v1 残留空目录无害，rmdir 失败不影响功能
    console.debug(`[migrate-v1] rmdir ${legacyHome} 失败（忽略）: ${(err as Error).message}`);
  }
}

/** 解析失败的哨兵值（比任何合法时间戳都大，确保不被当作有效数据搬迁）。 */
const PARSE_FAILED = "\x00PARSE_FAILED";

/**
 * 类型守卫：从已解析的 JSON 值安全读取 repoMeta.recordedAt（string）。
 * 任何结构不符 → 返回 null（调用方按"缺失"处理）。
 */
function safeGetRecordedAt(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const repoMeta = (parsed as Record<string, unknown>).repoMeta;
  if (typeof repoMeta !== "object" || repoMeta === null) return null;
  const recordedAt = (repoMeta as Record<string, unknown>).recordedAt;
  return typeof recordedAt === "string" ? recordedAt : null;
}

/**
 * 从 _v1.json 内容解析 repoMeta.recordedAt。
 * 解析失败返回 PARSE_FAILED 哨兵（调用方据此跳过，保留原文件防数据丢失）。
 * recordedAt 缺失返回空串（合法但视为最旧，不优先覆盖 cw）。
 */
function parseRecordedAt(raw: string, filePath: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return safeGetRecordedAt(parsed) ?? "";
  } catch (err) {
    console.warn(
      `[migrate-v1] 解析 ${filePath} 失败，跳过该目录（原文件保留）: ${(err as Error).message}`,
    );
    return PARSE_FAILED;
  }
}

/** 读 ~/.cw 侧的 recordedAt（解析失败视为最新，不被 v1 覆盖——保护已有数据）。 */
function readCwRecordedAt(cwFile: string): string {
  try {
    const raw = readFileSync(cwFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return safeGetRecordedAt(parsed) ?? "";
  } catch (err) {
    console.warn(
      `[migrate-v1] 解析 ${cwFile} 失败，视为最新不覆盖: ${(err as Error).message}`,
    );
    return "9999"; // 保证 cw 侧解析失败时不被 v1 覆盖
  }
}

// ═══════════════════════════════════════════════════════════════
// 文件名迁移：_v1.json → store.json（~/.cw 内同目录改名）
// ═══════════════════════════════════════════════════════════════

/**
 * 迁移旧文件名 `_v1.json` 到 `store.json`（~/.cw/<cwd>/ 内同目录 rename）。
 *
 * 与 migrateLegacyV1Home 的区别：
 *   - home 迁移是跨目录（~/.v1 → ~/.cw），CW_HOME 被覆盖时不迁
 *   - 文件名迁移是同目录内改名，**无论 CW_HOME 是否覆盖都执行**（用户自定义路径里的旧文件名也得改）
 *
 * 必须在 migrateLegacyV1Home 之后调用（home 迁移先把 ~/.v1/<cwd>/_v1.json 搬到
 * ~/.cw/<cwd>/_v1.json，文件名迁移再 rename 成 store.json）。
 *
 * 合并策略（同目录内 _v1.json 与 store.json 共存时）：
 *   - 仅 _v1.json 有 → rename 成 store.json
 *   - 仅 store.json 有 → 秒过（幂等）
 *   - 两边都有 → 比 repoMeta.recordedAt 取新，弃旧
 *   - _v1.json 解析失败 → 保留原文件不删（防数据丢失）
 *
 * best-effort：IO 异常 console.warn 不抛，不阻断 cw 启动。
 */
export function migrateLegacyV1Filename(opts?: MigrateOpts): void {
  const cwHome = opts?.cwHome ?? getCwHome();

  let entries: string[];
  try {
    entries = readdirSync(cwHome, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    console.warn(`[migrate-filename] 无法读取 ${cwHome}，跳过: ${(err as Error).message}`);
    return;
  }

  for (const encodedCwd of entries) {
    const dir = join(cwHome, encodedCwd);
    const legacyFile = join(dir, "_v1.json");
    const newFile = join(dir, "store.json");

    // 仅 store.json 存在 → 已迁移，秒过（幂等）
    if (!existsSync(legacyFile)) {
      continue;
    }

    try {
      if (!existsSync(newFile)) {
        // 仅 _v1.json 存在 → 直接 rename
        renameSync(legacyFile, newFile);
      } else {
        // 两边都有 → 比 recordedAt 取新弃旧
        const legacyData = readFileSync(legacyFile, "utf-8");
        const legacyRecordedAt = parseRecordedAt(legacyData, legacyFile);
        if (legacyRecordedAt === PARSE_FAILED) {
          continue; // _v1.json 解析失败，保留原文件
        }
        const newRecordedAt = readCwRecordedAt(newFile);
        if (legacyRecordedAt >= newRecordedAt) {
          // _v1.json 更新 → 覆盖 store.json
          rmSync(newFile, { force: true });
          renameSync(legacyFile, newFile);
        } else {
          // store.json 更新 → 删 _v1.json
          rmSync(legacyFile, { force: true });
        }
      }
      // eslint-disable-next-line taste/no-silent-catch -- 迁移是 best-effort，IO 失败只记录不阻断 cw 启动
    } catch (err) {
      console.warn(
        `[migrate-filename] 迁移 ${encodedCwd} 失败，跳过（原文件保留）: ${(err as Error).message}`,
      );
    }
  }
}
