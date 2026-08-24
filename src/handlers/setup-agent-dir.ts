/**
 * `cw setup-agent-dir`（ph-i0 / design-hi-monorepo-split u-i0-c，决策五 R5）。
 *
 * 薄封装：复用插件包的 installer 核心（bin/install.mjs 的 install 子命令，
 * profile=controlled），建受控 agentDir（extensions/ask-user + manifest.json +
 * 启动探针）。安装核心只有一份，本 handler 不复制实现——通过 node 子进程调用
 * 插件包 bin，包定位顺序：
 *   1. node 模块解析 `@zhushanwen/pi-coding-workflow-extension/package.json`
 *      （workspaces/npm install 后命中根 node_modules 符号链接）
 *   2. 从 cwd 向上找 `pi-coding-workflow-extension/bin/install.mjs`（仓内开发态）
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { CommandContext, CommandHandler } from "../dispatch.js";

const EXT_PACKAGE = "@zhushanwen/pi-coding-workflow-extension";
const INSTALL_BIN = ["pi-coding-workflow-extension", "bin", "install.mjs"];
/** 仓内向上定位的目录层数上限（worktree/嵌套目录场景余量） */
const MAX_UPWARD_LEVELS = 8;
/** 环境错误 exit code（installer 未找到 / 启动失败：未发生任何安装动作） */
const ENV_ERROR_EXIT = 2;
/** installer 子进程超时（安装 npm 依赖 + pi 探针合计上限） */
const INSTALLER_TIMEOUT_MS = 600_000;
const MS_PER_MINUTE = 60_000;

/** 定位插件包 bin（见文件头注释的两级定位链）；找不到返回 undefined */
export function locateInstallerBin(cwd: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve(`${EXT_PACKAGE}/package.json`) as string;
    const bin = path.join(path.dirname(pkgJson), ...INSTALL_BIN);
    if (existsSync(bin)) return bin;
  } catch (err) {
    // 模块解析失败 = 插件包未安装，预期路径，静默降级到仓内定位
    void err;
  }
  let dir = cwd;
  for (let i = 0; i < MAX_UPWARD_LEVELS; i++) {
    const bin = path.join(dir, ...INSTALL_BIN);
    if (existsSync(bin)) return bin;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function strArg(argv: Record<string, unknown>, key: string): string | undefined {
  const v = argv[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export const handleSetupAgentDir: CommandHandler = async (ctx: CommandContext) => {
  const { argv, cwd } = ctx;
  const bin = locateInstallerBin(cwd);
  if (bin === undefined) {
    process.stderr.write(
      `cw setup-agent-dir: 未找到 ${EXT_PACKAGE} 的 installer（${INSTALL_BIN.join("/")}）。\n` +
        "恢复动作：在 cw 仓根执行 npm install（workspaces 会装上插件包），或 npm install -g " +
        `${EXT_PACKAGE} 后重试。\n`,
    );
    return ENV_ERROR_EXIT; // 未发生任何安装动作
  }

  const args = [bin, "install", "--profile", "controlled"];
  const agentDir = strArg(argv, "agent-dir");
  if (agentDir !== undefined) args.push("--agent-dir", agentDir);
  const askUserSource = strArg(argv, "ask-user-source");
  if (askUserSource !== undefined) args.push("--ask-user-source", askUserSource);
  const askUserPath = strArg(argv, "ask-user-path");
  if (askUserPath !== undefined) args.push("--ask-user-path", askUserPath);
  const piBin = strArg(argv, "pi-bin");
  if (piBin !== undefined) args.push("--pi-bin", piBin);
  if (typeof argv["timeout-ms"] === "number") args.push("--timeout-ms", String(argv["timeout-ms"]));
  if (argv["skip-probe"] === true) {
    // 逃生口：无 pi 可用的环境（CI）只建目录不探针
    args.push("--skip-probe");
  }

  const child = spawnSync(process.execPath, args, { stdio: "inherit", timeout: INSTALLER_TIMEOUT_MS });
  if (child.error !== undefined) {
    // spawnSync 超时实测形态 = error.code ETIMEDOUT + status null（非启动失败，单独出声）
    if ((child.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      process.stderr.write(
        `cw setup-agent-dir: installer 子进程超时（上限 ${INSTALLER_TIMEOUT_MS / MS_PER_MINUTE}min），可能已部分安装。\n` +
          "恢复动作：重跑 cw setup-agent-dir（幂等重装）。注意：--timeout-ms 只作用于 installer 内部 npm 超时，调大不能放宽本上限。\n",
      );
    } else {
      process.stderr.write(`cw setup-agent-dir: installer 启动失败：${child.error.message}\n`);
    }
    return ENV_ERROR_EXIT;
  }
  if (child.status === null) {
    // 无 error 但 status 无效（被外部信号终止等）——同样出声，不留静默 exit 2
    process.stderr.write(
      `cw setup-agent-dir: installer 未正常结束（signal=${child.signal ?? "unknown"}），可能已部分安装。\n` +
        "恢复动作：重跑 cw setup-agent-dir（幂等重装）。\n",
    );
    return ENV_ERROR_EXIT;
  }
  return child.status;
};
