/**
 * 跨 cwd 遍历——读取 CW_HOME 下所有 encodedCwd 子目录的 store.json。
 *
 * 只读聚合，不写 store。损坏的 store.json 跳过不抛（ES2）。
 *
 * 调用方：cli.ts 的 `cw list --all` 分支用此函数把 CW_HOME 下全部 cwd 的
 * workUnits 聚合为一组 AnnotatedUnit（带 cwd/repoMeta 标注），交给 renderList
 * 渲染 group header 表格。
 *
 * 设计要点：
 *   - 不 import CwStore（store 的 load/save 带 activeData 切换、事务等写语义，
 *     跨 cwd 聚合只需 JSON.parse，引入 store 会带来不必要的副作用风险）。
 *   - 子目录名是 encodedCwd（encodeCwd: / → __），反解时直接 `__` → `/`。
 *   - 损坏/缺失的 store.json 静默跳过（ES2：单 cwd 损坏不影响其他 cwd 的列表）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CwJsonFile } from "../store/schema.js";
import { decodeCwd } from "../store/schema.js";

/** 单个 cwd 的加载结果。 */
export interface LoadedCwd {
  /** 反解后的 cwd 绝对路径（encodedCwd 的 __ → /）。repoMeta 存在时优先用 worktreePath（更精确）。 */
  cwd: string;
  /** store.json 解析结果。 */
  data: CwJsonFile;
}

/**
 * 遍历 CW_HOME 下所有子目录，各读 store.json。
 *
 * - 子目录名是 encodedCwd（encodeCwd: / → __），反解为 cwd 绝对路径
 * - store.json 不存在 / JSON parse 失败 → 跳过该子目录（不抛，ES2）
 * - 按 data.repoMeta?.recordedAt DESC 排序（无 repoMeta 排最后）
 *
 * @param cwHome CW_HOME 绝对路径
 */
export function loadAllCwdsFromHome(cwHome: string): LoadedCwd[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(cwHome, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // CW_HOME 不存在或无权限
  }

  const results: LoadedCwd[] = [];
  for (const encodedCwd of entries) {
    const storePath = join(cwHome, encodedCwd, "store.json");
    let raw: string;
    try {
      raw = readFileSync(storePath, "utf-8");
    } catch {
      continue; // 文件不存在，跳过
    }
    let data: CwJsonFile;
    try {
      data = JSON.parse(raw) as CwJsonFile;
    } catch {
      continue; // JSON 损坏，跳过（ES2）
    }
    // 反解 cwd：encodedCwd → cwd。repoMeta 存在时优先用 worktreePath（更精确）
    const decoded = decodeCwd(encodedCwd);
    const cwd = data.repoMeta?.worktreePath ?? decoded;
    results.push({ cwd, data });
  }

  // 按 repoMeta.recordedAt DESC（无 repoMeta / 空串排最后）。
  // 空串映射为 "0000"（比任何 ISO 日期 "20xx-..." 都小），降序排时空串自然到最后，
  // 避免 localeCompare 字典序下空串与日期比较的歧义。
  results.sort((a, b) => {
    const ta = a.data.repoMeta?.recordedAt ?? "0000";
    const tb = b.data.repoMeta?.recordedAt ?? "0000";
    return tb.localeCompare(ta);
  });

  return results;
}
