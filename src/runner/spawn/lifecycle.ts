/**
 * AgentSpawn 生命周期原语（u6a 验收文档 docs/rewrite/acceptance/u6a-acceptance.md 锁定；
 * canon《design-child-spawn.md》§6.3 runner 侧统一超时 + detached/pgid 树 kill、
 * §7 产物落盘的写入方是 spawn 实现而非 agent——本模块就是那个实现）。
 *
 * 只做进程级语义：真实 OS 子进程 spawn + stdio 管道直写落盘 + 超时整树 kill + 四态退出归因。
 * 命令拼装属适配器（u6b/u6c），worktree 清理属 runner 重派语义（u7）——本模块不做。
 *
 * 平台假设：POSIX（detached + pgid 树 kill 针对 macOS/Linux；Windows detached 语义不同，
 * 不在 u6a 范围）。
 *
 * 两个实测约束（node v24.11.1，2026-08 探针）决定了实现形态：
 *   1. stdio 里传入的 stream 必须已持有 fd（fd:null 直接 ERR_INVALID_ARG_VALUE 同步抛），
 *      而 createWriteStream 惰性 open 是异步的——先 openSync 同步拿 fd 再包流，
 *      spawnProcess 才能保持同步返回 handle；
 *   2. spawn 对不存在的可执行不抛同步错误，而是异步 error 事件（且该路径无 exit 事件），
 *      而契约要求同步抛带可执行名的 Error——故有 execvp 语义的可解析性预检。
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  createWriteStream,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import type { SpawnHandle, SpawnResult } from "./types.js";

export interface SpawnProcessRequest {
  /** 可执行（适配器拼装完成） */
  command: string;
  args: readonly string[];
  /** 工作目录（worktree） */
  cwd: string;
  /** 附加环境变量（合并继承 process.env 后传给子进程） */
  env?: Record<string, string>;
  /** 超时 ms：到点 kill 整个进程组，wait() 归因 TIMEOUT */
  timeoutMs: number;
  /** 落盘路径（调用方 = 适配器，按 .cw-spawn/ 约定命名；dirname 不存在则本模块建） */
  stdoutPath: string;
  stderrPath: string;
}

/** catch 变量按 unknown 处理（strict），不经断言取 errno code */
function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

/** 是否为「存在的可执行普通文件」（statSync 跟随 symlink，与 execvp 解析一致） */
function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile() && accessSync(path, constants.X_OK) === undefined;
  } catch {
    // 不存在 / 不可访问统一视为「找不到」——与 execvp ENOENT 的可感知面一致
    return false;
  }
}

/**
 * 可执行解析预检（ENOENT 同步化）。复刻 execvp 的解析规则：含路径分隔符 → 按原样
 * （相对 cwd）校验；裸名 → 沿「子进程 env」的 PATH 逐段查找（libuv 用子 env 的 PATH
 * 定位可执行）。找不到 → 同步抛带可执行名的 Error，由适配器转 SPAWN_ERROR 语义，
 * 本模块不吞。
 */
function assertExecutableResolvable(
  command: string,
  cwd: string,
  childEnv: NodeJS.ProcessEnv,
): void {
  const notFound = (): Error =>
    new Error(
      `spawnProcess: 可执行 "${command}" 不存在或不可执行（cwd=${cwd}）。` +
        "恢复动作：属 SPAWN_ERROR（配置错误，重试无意义）——修正 command 拼写或 PATH 后重新派发。",
    );

  if (command.includes("/")) {
    const abs = isAbsolute(command) ? command : join(cwd, command);
    if (!isExecutableFile(abs)) {
      throw notFound();
    }
    return;
  }
  const path = childEnv.PATH;
  if (path === undefined) {
    // execvp 无 PATH 时回退系统默认路径（confstr），静态预检无法复刻——放行，
    // 若真失败由异步 error 事件兜底（wait() 归 SPAWN_ERROR，不会挂起）
    return;
  }
  const found = path.split(delimiter).some((dir) => isExecutableFile(join(dir, command)));
  if (!found) {
    throw notFound();
  }
}

export function spawnProcess(req: SpawnProcessRequest): SpawnHandle {
  // 产物目录：只管传入路径自身的 dirname（.cw-spawn/ 的命名约定由调用方负责）
  mkdirSync(dirname(req.stdoutPath), { recursive: true });
  mkdirSync(dirname(req.stderrPath), { recursive: true });

  const childEnv: NodeJS.ProcessEnv =
    req.env === undefined ? process.env : { ...process.env, ...req.env };
  assertExecutableResolvable(req.command, req.cwd, childEnv);

  // stdio 管道直写：子进程 stdout/stderr 直接接到文件 fd——OS 层写入、无用户态缓冲，
  // SIGKILL 后已输出内容仍在文件（产物完整性与进程存活解耦，P6）。
  // append（"a"）满足同路径多次 spawn 不覆盖前次内容。
  const stdoutFd = openSync(req.stdoutPath, "a");
  let stderrFd: number;
  try {
    stderrFd = openSync(req.stderrPath, "a");
  } catch (err) {
    // 第二个 fd 打不开时回收第一个，不留悬空描述符
    closeSync(stdoutFd);
    throw err;
  }
  const stdoutStream = createWriteStream(req.stdoutPath, { fd: stdoutFd });
  const stderrStream = createWriteStream(req.stderrPath, { fd: stderrFd });

  let child: ChildProcess;
  try {
    child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: childEnv,
      stdio: ["ignore", stdoutStream, stderrStream],
      // 进程组隔离：组长 pid === pgid，kill 用 kill(-pgid) 整树终止（含孙进程）
      detached: true,
    });
  } catch (err) {
    stdoutStream.destroy();
    stderrStream.destroy();
    throw err;
  }

  const pgid = child.pid; // detached 组长：pid 即 pgid；异步 spawn 失败时为 undefined

  // P8：wait() resolve 前保证两个流已 close。监听器在构造期挂上——close 若已发生，
  // 事后补挂会永久悬空
  const streamClosed = [stdoutStream, stderrStream].map(
    (stream) =>
      new Promise<void>((resolveClose) => {
        stream.on("close", () => resolveClose());
      }),
  );
  for (const stream of [stdoutStream, stderrStream]) {
    // 流自身故障（磁盘满等）：销毁释放 fd 即恢复动作；子进程随后写入会得 EPIPE/
    // SIGPIPE 自然死亡并走正常 exit 归因，不在此伪造退出状态
    stream.on("error", () => {
      stream.destroy();
    });
  }

  let resolveResult!: (result: SpawnResult) => void;
  const resultPromise = new Promise<SpawnResult>((resolve) => {
    resolveResult = resolve;
  });
  let waitPromise: Promise<SpawnResult> | null = null;
  let settled = false;

  /**
   * TIMEOUT 归因标志：只在本模块发起的「超时」kill 时置位。同为 SIGKILL 死亡，
   * 超时路径归 TIMEOUT、外部信号归 CRASH——退出事件本身无法区分信号来源，归因只能
   * 由 kill 发起方声明。
   * 手动 kill() 不置位：「与超时同路径」指 kill 机制（kill(-pgid, SIGKILL) 整树 +
   * ESRCH 幂等静默），归因上它不是超时，按四态定义的「被信号杀死」归 CRASH——
   * 且不进 loop 的连续 TIMEOUT 计数（runLoop 的 timeoutStreaks 只对 exitCode
   * === "TIMEOUT" 结算累计，连续 2 次且期间无该 unit 账本进展才转人工）。
   */
  let timeoutKillInitiated = false;

  function killTree(): void {
    if (pgid === undefined) {
      return;
    }
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (err) {
      // ESRCH = 进程组已消亡（进程恰好先退 / kill 幂等重入）——静默是幂等语义的一部分
      if (errnoCode(err) !== "ESRCH") {
        throw err;
      }
    }
  }

  const timer = setTimeout(() => {
    timeoutKillInitiated = true;
    killTree();
  }, req.timeoutMs);

  function releaseStreams(): void {
    for (const stream of [stdoutStream, stderrStream]) {
      // 已 destroy 的流 close 已发（gate 已 resolved）；本模块从不向流写数据
      // （数据走子进程→fd 的 OS 管道），end() 只负责关 fd，无用户态缓冲需要 flush
      if (!stream.destroyed) {
        stream.end();
      }
    }
  }

  function settle(result: SpawnResult): void {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    releaseStreams();
    // allSettled：两个 fd 的 close 是独立资源释放（gate 只 resolve 不 reject），
    // 语义为「全部关闭」屏障，与项目「独立数据源用 allSettled」约定一致
    void Promise.allSettled(streamClosed).then(() => {
      resolveResult(result);
    });
  }

  child.on("exit", (code) => {
    settle({
      exitCode: code !== null ? code : timeoutKillInitiated ? "TIMEOUT" : "CRASH",
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
      pid: child.pid ?? -1,
    });
  });
  // 异步 spawn 失败兜底（预检未覆盖的形态，如 PATH 缺失时的 confstr 回退解析失败；
  // 实测该路径无 exit 事件）——wait() 以 SPAWN_ERROR 收场而不是永久挂起
  child.on("error", () => {
    settle({
      exitCode: "SPAWN_ERROR",
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
      // 异步失败时 child.pid 为 undefined——用 -1 占位（此态下 pid 无进程可指）
      pid: child.pid ?? -1,
    });
  });

  let killCalled = false;
  return {
    wait: () => (waitPromise ??= resultPromise),
    kill: () => {
      // 幂等：重复调用无害（二次调用直接返回）
      if (killCalled) {
        return;
      }
      killCalled = true;
      killTree();
    },
  };
}
