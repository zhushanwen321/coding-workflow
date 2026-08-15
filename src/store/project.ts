/**
 * 项目存储布局（canon §3.4 数据流：~/.cw/<project>/events.log + evidence/）。
 *
 * 职责：
 *   - CW_HOME 根目录解析（env CW_HOME 覆盖，默认 ~/.cw）
 *   - cwd → 目录名编码（per-cwd 隔离，路径布局 <CW_HOME>/<encoded>/events.log）
 *   - 账本 / 证据产物路径函数
 *
 * 编码规则（参考旧实现 archive/src/store/cw-store.ts 的 encodeCwd）：路径分隔符 `/`
 * （含 Windows `\`）替换为 `__`；在此基础上追加 `.` 也替换——否则 cwd 为 `.` / `..`
 * 这类相对路径会编码为同名特殊目录（join 结果逃逸 CW_HOME），含 `.` 的 cwd 也会
 * 产生形如 `.bare` 的隐藏目录。新账本不迁移旧 store 数据（canon D3），无兼容负担。
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 账本文件名（append-only JSONL） */
const LEDGER_FILE_NAME = "events.log";
/** 证据产物根目录名（账本只记元数据，产物本体落这里） */
const EVIDENCE_DIR_NAME = "evidence";

/**
 * 存储根目录。默认 ~/.cw，CW_HOME 环境变量可覆盖。
 * 覆盖值必须是绝对路径（per-cwd 隔离依赖稳定、唯一的根），否则抛错。
 */
export function getCwHome(): string {
  const override = process.env.CW_HOME;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(
        `CW_HOME 必须是绝对路径，当前值：${override}。恢复动作：改为绝对路径（如 /tmp/cw-test-home），或取消该环境变量使用默认 ~/.cw。`,
      );
    }
    return override;
  }
  return join(homedir(), ".cw");
}

/**
 * 把 cwd 编码为目录名：`/`、`\`、`.` 全部替换为 `__`。
 *
 * 例：`/Users/x/proj` → `__Users__x__proj`；`/Users/x/.bare` → `__Users__x____bare`；
 * `.` → `__`。前导 `__` 保留原前导分隔符的痕迹，编码确定性。
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[\\/.]/g, "__");
}

/** 账本路径：<cwHome>/<encoded-cwd>/events.log */
export function ledgerPath(cwHome: string, cwd: string): string {
  return join(cwHome, encodeCwd(cwd), LEDGER_FILE_NAME);
}

/** 证据产物目录：<cwHome>/<encoded-cwd>/evidence/<unitId>/<runId> */
export function evidenceDir(
  cwHome: string,
  cwd: string,
  unitId: string,
  runId: string,
): string {
  return join(cwHome, encodeCwd(cwd), EVIDENCE_DIR_NAME, unitId, runId);
}
