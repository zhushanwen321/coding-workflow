/**
 * installer 核心（design-hi-monorepo-split 决策三/五）。
 *
 * 两通道共用同一份安装核心，只差 target 目录与包清单：
 *   - profile main：target = <home>/.pi/agent，只装本插件包（loader 自动发现）
 *   - profile controlled：target = --agent-dir（默认 <home>/.cw/agent-dir），
 *     装 ask-user 等子进程侧扩展 + manifest.json（cw spawn 用 --extension 显式注入）
 *
 * 三步规格：npm pack → 解包 .tmp → 原子 rename → 包内 npm install --omit=dev。
 * 本文件是纯 ESM（.mjs 直发，pi/cw 两侧均以子进程 `node bin/install.mjs` 调用，
 * 不参与 TS 构建）。
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const EXT_DIR_NAME = "pi-coding-workflow-extension";
export const ASK_USER_NPM_SPEC = "@zhushanwen/pi-ask-user";
export const ASK_USER_DIR_NAME = "ask-user";
/** 受控 agentDir 清单版本（探针比对用，结构变更时递增） */
export const MANIFEST_VERSION = 1;

export const DEFAULT_CONTROLLED_DIR = path.join(".cw", "agent-dir");

/** usage 文本（bin/install.mjs 与 cw setup-agent-dir 的恢复指引共用） */
export const USAGE = `pi-cw-install — coding-workflow extension installer

Usage:
  pi-cw-install install [--agent-dir <dir>] [--profile main|controlled]
                        [--ask-user-source npm|path] [--ask-user-path <dir>]
                        [--pi-bin <bin>] [--timeout-ms <n>]
  pi-cw-install doctor  [--agent-dir <dir>] [--profile main|controlled]
                        [--pi-bin <bin>] [--timeout-ms <n>]
  pi-cw-install uninstall [--agent-dir <dir>] [--profile main|controlled]

Options:
  --profile main        安装到 <home>/.pi/agent（loader 自动发现；默认）
  --profile controlled  安装到受控 agentDir（默认 <home>/.cw/agent-dir，装 ask-user + manifest + 启动探针）
  --ask-user-source     ask-user 来源：npm（默认，装 @zhushanwen/pi-ask-user）| path（本地目录拷贝）
  --ask-user-path       --ask-user-source path 时的源目录（含 package.json）；
                        npm 来源失败时也作回落（stderr 提示）
  --pi-bin              探针用的 pi 可执行文件（默认 PATH 上的 pi）
  --timeout-ms          探针超时（默认 120000）`;

/** 极简 argv 解析（installer 无运行时依赖，不引 minimist） */
export function parseArgs(argv) {
  const out = { _: [], agentDir: undefined, profile: "main", askUserSource: undefined, askUserPath: undefined, piBin: "pi", timeoutMs: 120_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent-dir") out.agentDir = argv[++i];
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--ask-user-source") out.askUserSource = argv[++i];
    else if (a === "--ask-user-path") out.askUserPath = argv[++i];
    else if (a === "--pi-bin") out.piBin = argv[++i];
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--skip-probe") out.skipProbe = true;
    else out._.push(a);
  }
  const command = out._[0];
  if (out.profile !== "main" && out.profile !== "controlled") {
    throw new Error(`未知 --profile: ${out.profile}（合法值 main|controlled）`);
  }
  if (out.askUserSource !== undefined && out.askUserSource !== "npm" && out.askUserSource !== "path") {
    throw new Error(`未知 --ask-user-source: ${out.askUserSource}（合法值 npm|path）`);
  }
  return { ...out, command };
}

/** 解析 target agentDir：显式 --agent-dir 优先，否则按 profile 取默认 */
export function resolveTargetDir(opts, home) {
  if (opts.agentDir !== undefined) return path.resolve(opts.agentDir);
  return opts.profile === "controlled"
    ? path.join(home, DEFAULT_CONTROLLED_DIR)
    : path.join(home, ".pi", "agent");
}

async function run(cmd, args, opts = {}) {
  return execFileP(cmd, args, { timeout: opts.timeoutMs ?? 120_000, cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * `npm pack` 到临时目录，返回 tarball 路径。
 * spec 省略时在 pkgDir 内打包本地包（自定位安装）。
 */
export async function packToTmp({ pkgDir, spec, tmpDir }) {
  const dir = tmpDir ?? (await mkdtemp(path.join(tmpdir(), "pi-cw-pack-")));
  const args = ["pack", ...(spec !== undefined ? [spec] : []), "--json", "--pack-destination", dir];
  if (pkgDir !== undefined) args.push("--ignore-scripts");
  const { stdout } = await run("npm", args, { cwd: pkgDir ?? process.cwd() });
  const entries = JSON.parse(stdout);
  const filename = entries[entries.length - 1].filename;
  return { tarball: path.join(dir, filename), tmpDir: dir };
}

/** 解 tarball（npm tarball 顶层为 package/）到 dest（dest 需已存在或可创建） */
export async function extractTarball(tarball, dest) {
  await mkdir(dest, { recursive: true });
  // 系统 tar（macOS/Linux 自带）；--strip-components=1 去掉顶层 package/
  await run("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
  return dest;
}

/**
 * 原子替换目录：dest 存在时先 rm 再 rename（rename 同卷原子；跨卷回落 rm+cp）。
 * 幂等：重复调用结果一致，无旧版本残留。
 */
export async function atomicReplaceDir(srcDir, destDir) {
  const parent = path.dirname(destDir);
  await mkdir(parent, { recursive: true });
  try {
    await rename(srcDir, destDir);
  } catch (err) {
    // dest 已存在（rename 不覆盖非空目录）或跨卷
    await rm(destDir, { recursive: true, force: true });
    try {
      await rename(srcDir, destDir);
    } catch {
      await mkdir(path.dirname(destDir), { recursive: true });
      await run("cp", ["-R", srcDir, destDir]);
      await rm(srcDir, { recursive: true, force: true });
    }
  }
  return destDir;
}

/** 目录拷贝（跳过 node_modules / .git / .tmp*；npm 装失败回落本地来源用） */
export async function copyDirFiltered(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".tmp")) continue;
    const from = path.join(srcDir, e.name);
    const to = path.join(destDir, e.name);
    if (e.isDirectory()) await copyDirFiltered(from, to);
    else await run("cp", [from, to]);
  }
  return destDir;
}

/** 包内 npm install --omit=dev（依赖落盘 <dir>/node_modules/，jiti/Node 向上解析命中） */
export async function npmInstallOmitDev(dir, opts = {}) {
  await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: dir,
    timeoutMs: opts.timeoutMs,
  });
}

/** 读包目录的 package.json（name/version；缺失或非法 JSON 抛错） */
export async function readPkgVersion(dir) {
  const raw = await readFile(path.join(dir, "package.json"), "utf8");
  const pkg = JSON.parse(raw);
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
    throw new Error(`package.json 缺 name/version: ${dir}`);
  }
  return { name: pkg.name, version: pkg.version };
}

/** manifest.json 生成/合并（受控 agentDir 探针比对用，非运行时依赖） */
export async function writeManifest(agentDir, packages) {
  await mkdir(agentDir, { recursive: true });
  const file = path.join(agentDir, "manifest.json");
  let prev = {};
  try {
    prev = JSON.parse(await readFile(file, "utf8"));
  } catch {
    /* 首次建立 */
  }
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    packages: { ...(prev.packages ?? {}), ...packages },
  };
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * 启动探针：spawn 真实 pi，env 注入 PI_CODING_AGENT_DIR，--no-extensions 后
 * 逐个 --extension 显式注入受控清单（cw spawn 同款注入形态）。
 * 通过标准 = 合并输出（stdout+stderr）含 anchor。
 *
 * 主路径依赖 LLM 应答产出锚串；无凭据环境（输出含 "No API key"）自动降级为
 * RPC 握手探针（probeLoadRpc）：加载链确定性验证，不验 LLM 侧行为。
 */
export async function probeLoad({ piBin = "pi", agentDir, extensions, anchor, prompt, timeoutMs = 120_000, extraEnv = {} }) {
  // 显式注入清单非空时才关自动发现（受控通道形态）；main 通道靠 loader 自动发现，不能加。
  const args = extensions.length > 0 ? ["--no-extensions"] : [];
  for (const ext of extensions) args.push("--extension", ext);
  args.push("--no-session", "-p", prompt);
  let result;
  try {
    // stdin 必须断开：pi -p 在非 TTY 下会等 stdin EOF，管道悬置导致探针挂到超时
    const { stdout, stderr } = await execFileP(piBin, args, {
      timeout: timeoutMs,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${stdout}\n${stderr}`;
    result = { ok: output.includes(anchor), output };
  } catch (err) {
    const e = err;
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`;
    result = { ok: false, output };
  }
  if (result.ok) return result;
  // 主探针失败（实测无凭据环境 execFile 下 pi 被 SIGTERM、stderr 丢失，锚串与
  // No API key 均不可见）→ 无条件降级 RPC 握手探针：确定性验证加载链，无论
  // 失败形态如何都成立。真加载失败（--extension 路径缺失/不可加载）时 RPC
  // 探针同样失败（stderr 含 "Failed to load extension"），不会误判通过。
  const fallback = await probeLoadRpc({ piBin, agentDir, extensions, timeoutMs, extraEnv });
  return {
    ok: fallback.ok,
    output: `${result.output}\n[probe fallback: -p anchor miss -> rpc handshake]\n${fallback.output}`,
  };
}

/**
 * 无 LLM 降级探针：pi --mode rpc 握手。
 * 通过标准 = get_state reply success:true 且 stderr 无 "Failed to load extension"
 * （实测 0.84.2：--extension 路径缺失/不可加载时 pi 在 stderr 打该错误并退出）。
 * 局限（诚实边界）：验证扩展加载链，不验证工具注册后的 LLM 侧行为。
 */
export async function probeLoadRpc({ piBin = "pi", agentDir, extensions, timeoutMs = 30_000, extraEnv = {} }) {
  const args = ["--mode", "rpc"];
  if (extensions.length > 0) args.push("--no-extensions");
  for (const ext of extensions) args.push("--extension", ext);
  return await new Promise((resolve) => {
    const child = spawn(piBin, args, {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (ok, note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve({ ok, output: `${note}\nstdout:${out}\nstderr-head:${err.slice(0, 2000)}` });
    };
    const timer = setTimeout(() => finish(false, "rpc handshake timeout"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      // 第一条 reply 即握手成功锚（get_state）
      if (out.includes('"command":"get_state","success":true')) {
        const loadErr = /Failed to load extension/.test(err);
        finish(!loadErr, loadErr ? "extension load error in stderr" : "get_state ok, no extension load error");
      }
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
      if (/Failed to load extension/.test(err)) finish(false, "extension load error in stderr");
    });
    child.on("error", (e) => finish(false, `spawn error: ${e.message}`));
    child.on("close", (code) => {
      if (!settled) finish(false, `pi exited before handshake (code=${code})`);
    });
    child.stdin.write(JSON.stringify({ type: "get_state", id: 1 }) + "\n");
  });
}

/**
 * 安装本插件包（main 通道核心三步）。
 * selfDir = 本包所在目录（bin/install.mjs 向上定位；cw setup-agent-dir 传入）。
 */
export async function installSelfPackage({ selfDir, targetDir, timeoutMs }) {
  const { tarball, tmpDir } = await packToTmp({ pkgDir: selfDir });
  try {
    const staged = await extractTarball(tarball, path.join(tmpDir, "unpacked"));
    const dest = path.join(targetDir, "extensions", EXT_DIR_NAME);
    await atomicReplaceDir(staged, dest);
    await npmInstallOmitDev(dest, { timeoutMs });
    return dest;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 安装 ask-user 到受控 agentDir。
 * 来源优先级：--ask-user-source path → 本地拷贝；npm（默认）→ pack 失败回落
 * --ask-user-path（stderr 提示）；两者皆不可用 → 抛错（附恢复指引）。
 */
export async function installAskUser({ targetDir, askUserSource, askUserPath, warn, timeoutMs }) {
  const dest = path.join(targetDir, "extensions", ASK_USER_DIR_NAME);
  if (askUserSource === "path") {
    if (askUserPath === undefined) throw new Error("--ask-user-source path 需要 --ask-user-path <dir>");
    return installFromLocalDir(askUserPath, dest, timeoutMs);
  }
  // 默认 npm 来源
  try {
    const { tarball, tmpDir } = await packToTmp({ spec: ASK_USER_NPM_SPEC });
    try {
      const staged = await extractTarball(tarball, path.join(tmpDir, "unpacked"));
      await atomicReplaceDir(staged, dest);
      await npmInstallOmitDev(dest, { timeoutMs });
      return dest;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    if (askUserPath !== undefined) {
      warn?.(`npm 源安装 ${ASK_USER_NPM_SPEC} 失败（${err.message}），回落本地目录拷贝: ${askUserPath}`);
      return installFromLocalDir(askUserPath, dest, timeoutMs);
    }
    throw new Error(
      `npm 源安装 ${ASK_USER_NPM_SPEC} 失败（${err.message}）。` +
        `恢复动作：检查网络/registry 后重试，或用 --ask-user-source path --ask-user-path <dir> 从本地源码安装`,
    );
  }
}

async function installFromLocalDir(srcDir, dest, timeoutMs) {
  const srcStat = await stat(path.join(srcDir, "package.json")).catch(() => null);
  if (srcStat === null) throw new Error(`ask-user 源目录缺 package.json: ${srcDir}`);
  const staged = path.join(path.dirname(dest), `.tmp-${ASK_USER_DIR_NAME}-${process.pid}`);
  await rm(staged, { recursive: true, force: true });
  await copyDirFiltered(srcDir, staged);
  await atomicReplaceDir(staged, dest);
  await npmInstallOmitDev(dest, { timeoutMs });
  return dest;
}

export const PROBE_PROMPT_MAIN = "Run the /cw-ping command and repeat its full output message verbatim.";
export const PROBE_ANCHOR_MAIN = "cw-extension-alive";
export const PROBE_PROMPT_CONTROLLED = "List the exact names of all your available tools, one per line, nothing else.";
export const PROBE_ANCHOR_CONTROLLED = "ask_user";
