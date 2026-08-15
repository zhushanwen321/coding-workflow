/**
 * open.ts — 跨平台用系统默认应用打开文件（cw report --open 用）。
 *
 * 与 command.ts 同目录约定：单一职责的纯工具函数。
 * detached + unref 让 GUI 进程独立于 CLI 生命周期，CLI 不阻塞等待。
 * 失败吞异常不 throw（reportPath 已由 cli stdout JSON 输出，用户可手动 open）。
 */
import { spawn } from "node:child_process";

/**
 * 用系统默认应用打开文件（Windows=start / macOS=open / Linux=xdg-open）。
 *
 * 设计为「尽力而为」：spawn 失败（如无 xdg-open）只吞不 throw，因为 reportPath
 * 已由 cli 层写入 stdout，用户可手动打开。detached+unref 确保打开的应用不阻塞 CLI。
 */
export function openInDefaultApp(filePath: string): void {
  const cmd =
    process.platform === "win32"
      ? "start"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  try {
    const child = spawn(cmd, [filePath], { detached: true, stdio: "ignore" });
    // spawn 的 ENOENT（命令不存在）是异步 'error' 事件，try/catch 抓不到，必须 listener 吞，
    // 否则无 GUI 环境（CI/无 xdg-open）触发 uncaughtException。
    child.on("error", () => {});
    child.unref();
  } catch {
    // 吞同步错误（EINVAL 等）：reportPath 已 stdout 输出，用户可手动 open
  }
}
