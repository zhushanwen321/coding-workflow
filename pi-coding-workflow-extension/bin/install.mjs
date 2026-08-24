#!/usr/bin/env node
/**
 * installer bin（design-hi-monorepo-split 决策三）。
 *
 * 子命令：install / doctor / uninstall。用法细节见 core.mjs 的 USAGE。
 * 本文件是薄壳：解析 argv → 调 src/installer/core.mjs → 按 profile 汇报。
 * cw 的 `setup-agent-dir` 命令以子进程复用本入口（同一份安装核心）。
 */

import { homedir } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  ASK_USER_DIR_NAME,
  EXT_DIR_NAME,
  PROBE_ANCHOR_CONTROLLED,
  PROBE_ANCHOR_MAIN,
  PROBE_PROMPT_CONTROLLED,
  PROBE_PROMPT_MAIN,
  USAGE,
  installAskUser,
  installSelfPackage,
  parseArgs,
  probeLoad,
  readPkgVersion,
  resolveTargetDir,
  writeManifest,
} from "../src/installer/core.mjs";

const warn = (msg) => process.stderr.write(`${msg}\n`);

function selfDir() {
  // bin/install.mjs → 包根
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function cmdInstall(opts) {
  const targetDir = resolveTargetDir(opts, homedir());
  process.stdout.write(`安装目标 agentDir: ${targetDir}（profile=${opts.profile}）\n`);

  if (opts.profile === "main") {
    const dest = await installSelfPackage({ selfDir: selfDir(), targetDir, timeoutMs: opts.timeoutMs });
    const { version } = await readPkgVersion(dest);
    process.stdout.write(`已安装 ${version} → ${dest}\n`);
    process.stdout.write(`loader 将自动发现（${EXT_DIR_NAME}/package.json 含 "pi" 字段）；重启 pi 会话生效。\n`);
    return 0;
  }

  // controlled：受控 agentDir 只装「子进程需要的扩展」，本插件包不进清单（D5）
  const extDir = await installAskUser({
    targetDir,
    askUserSource: opts.askUserSource,
    askUserPath: opts.askUserPath,
    warn,
    timeoutMs: opts.timeoutMs,
  });
  const { name, version } = await readPkgVersion(extDir);
  const manifest = await writeManifest(targetDir, { [name]: version });
  process.stdout.write(`已安装 ${name}@${version} → ${extDir}\n`);
  process.stdout.write(`manifest: ${JSON.stringify(manifest.packages)}\n`);

  // 启动探针：真实 spawn pi（受控 agentDir env + --extension 显式注入）；--skip-probe 逃生口（无 pi 环境 CI 用）
  if (opts.skipProbe === true) {
    process.stdout.write("已跳过启动探针（--skip-probe）。\n");
    return 0;
  }
  process.stdout.write("启动探针：spawn 真实 pi 校验扩展在场…\n");
  const probe = await probeLoad({
    piBin: opts.piBin,
    agentDir: targetDir,
    extensions: [path.join(extDir, "index.ts")],
    anchor: PROBE_ANCHOR_CONTROLLED,
    prompt: PROBE_PROMPT_CONTROLLED,
    timeoutMs: opts.timeoutMs,
  });
  if (!probe.ok) {
    process.stderr.write(
      `探针失败：pi 输出未包含锚串 "${PROBE_ANCHOR_CONTROLLED}"（ask-user 未被加载）。\n` +
        `恢复动作：确认 pi 可用（${opts.piBin} --version）与版本兼容后重跑 ` +
        `pi-cw-install install --agent-dir ${targetDir} --profile controlled\n` +
        `--- pi 输出摘要 ---\n${probe.output.slice(0, 2000)}\n`,
    );
    return 1;
  }
  process.stdout.write(`探针通过（输出含 "${PROBE_ANCHOR_CONTROLLED}"）。\n`);
  return 0;
}

async function cmdDoctor(opts) {
  const targetDir = resolveTargetDir(opts, homedir());
  const probe =
    opts.profile === "main"
      ? await probeLoad({
          piBin: opts.piBin,
          agentDir: targetDir,
          extensions: [],
          anchor: PROBE_ANCHOR_MAIN,
          prompt: PROBE_PROMPT_MAIN,
          timeoutMs: opts.timeoutMs,
        })
      : await probeLoad({
          piBin: opts.piBin,
          agentDir: targetDir,
          extensions: [path.join(targetDir, "extensions", ASK_USER_DIR_NAME, "index.ts")],
          anchor: PROBE_ANCHOR_CONTROLLED,
          prompt: PROBE_PROMPT_CONTROLLED,
          timeoutMs: opts.timeoutMs,
        });
  if (!probe.ok) {
    const anchor = opts.profile === "main" ? PROBE_ANCHOR_MAIN : PROBE_ANCHOR_CONTROLLED;
    process.stderr.write(
      `doctor：pi 输出未包含锚串 "${anchor}"——loader 未发现/未加载目标扩展。` +
        `检查 pi 版本的 extensions 目录规则与 ${targetDir}/extensions/ 内容。\n` +
        `--- pi 输出摘要 ---\n${probe.output.slice(0, 2000)}\n`,
    );
    return 1;
  }
  process.stdout.write("doctor：探针通过，扩展加载正常。\n");
  return 0;
}

async function cmdUninstall(opts) {
  const targetDir = resolveTargetDir(opts, homedir());
  const dirs =
    opts.profile === "main"
      ? [path.join(targetDir, "extensions", EXT_DIR_NAME)]
      : [path.join(targetDir, "extensions", ASK_USER_DIR_NAME)];
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
    process.stdout.write(`已移除 ${dir}\n`);
  }
  return 0;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "install") process.exit(await cmdInstall(opts));
  else if (opts.command === "doctor") process.exit(await cmdDoctor(opts));
  else if (opts.command === "uninstall") process.exit(await cmdUninstall(opts));
  else {
    process.stderr.write(`${USAGE}\n`);
    process.exit(opts.command === "help" || opts.command === "--help" ? 0 : 1);
  }
} catch (err) {
  process.stderr.write(`pi-cw-install: ${err.message}\n恢复指引见 --help。\n`);
  process.exit(1);
}
