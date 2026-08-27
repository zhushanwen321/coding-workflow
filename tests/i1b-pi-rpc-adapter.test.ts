/**
 * i1b 单测（ph-i1 u-i1-b，design-hi-spawn-pi-rpc.md §3.1/§3.2 R1-R3）。
 *
 * 三段（全部真实环境，零 mock 框架）：
 *   A. buildPiRpcCommand 纯函数：R3 spawn args 形态（--mode rpc / designer --extension
 *      ask-user / reviewer 排除 write,edit / --session-dir / --name）
 *   B. 真实 pi 进程（--mode rpc，不依赖 LLM 段）：启动探针拒派（designer 缺 ask-user
 *      扩展 → SPAWN_ERROR + 恢复指引）、get_state 握手 sessionAnchor + 产物锚文件、
 *      kill → TIMEOUT、done() 优雅退出
 *   C. 反思链（loop 接缝）：真实 runLoop + 真实 InteractiveSpawnHandle 测试实现
 *      （真实 node 子进程消费 followUp）→ reflectionPending 派发 → followUp 注入 →
 *      ReflectionRan 入账（round 1 / specHash 锚）→ 下轮派 reviewer
 *
 * pi 二进制缺席时 B 段 skipIf（现象会注明）；LLM 段（prompt 全链）不在本文件
 * 覆盖范围（i1a 已有 + 无凭据时不可测）。
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  askUserEntryPath,
  buildPiRpcCommand,
  createPiRpcAdapter,
  resolveCwAgentDir,
} from "../src/runner/spawn/pi-rpc.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  InteractiveSpawnHandle,
  SpawnHandle,
  SpawnResult,
} from "../src/runner/spawn/types.js";
import { hasRealPi } from "./fixtures/pi-env.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-i1b-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// real-pi 守卫（tests/fixtures/pi-env.ts）：CI 一律 skip（vendored pi 使
// pi --version 守卫失真且 CI 无 ~/.pi 配置）；本地要求 node_modules 外的真实 pi
const hasPi = hasRealPi;

function mkAgentRequest(over: Partial<AgentSpawnRequest> = {}): AgentSpawnRequest {
  const dir = join(tmpRoot, "req-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  const briefPath = join(dir, "brief.md");
  writeFileSync(briefPath, "# i1b 测试任务书\n回复 OK 即可。\n");
  return {
    role: "developer",
    unitId: "u-i1b",
    workdir: dir,
    projectCwd: dir,
    artifactDir: dir,
    briefPath,
    timeoutMs: 30_000,
    ...over,
  };
}

// ---- A. buildPiRpcCommand 纯函数 ----

describe("i1b A：buildPiRpcCommand（R3 spawn args 形态）", () => {
  const req = mkAgentRequest();
  const agentDir = join(tmpRoot, "agentdir-a");

  it("公共形态：--mode rpc --no-extensions --approve --session-dir --name --model", () => {
    const cmd = buildPiRpcCommand(req, agentDir, "openai/gpt-x");
    expect(cmd.command).toBe("pi");
    const joined = cmd.args.join(" ");
    for (const token of ["--mode", "rpc", "--no-extensions", "--approve"]) {
      expect(cmd.args).toContain(token);
    }
    expect(joined).toContain(`--session-dir ${req.artifactDir}`);
    expect(joined).toContain(`--name ${req.unitId}-${req.role}`);
    expect(joined).toContain("--model openai/gpt-x");
  });

  it("designer：注入受控 agentDir 的 ask-user 扩展入口", () => {
    const cmd = buildPiRpcCommand(mkAgentRequest({ role: "designer" }), agentDir, "m");
    expect(cmd.args.join(" ")).toContain(`--extension ${askUserEntryPath(agentDir)}`);
    expect(askUserEntryPath(agentDir)).toBe(join(agentDir, "extensions", "ask-user", "index.ts"));
  });

  it("reviewer：排除 write/edit（只读审查）", () => {
    const cmd = buildPiRpcCommand(mkAgentRequest({ role: "reviewer" }), agentDir, "m");
    expect(cmd.args.join(" ")).toContain("--exclude-tools write,edit");
    expect(cmd.args.join(" ")).not.toContain("--extension");
  });

  it("resolveCwAgentDir：CW_AGENT_DIR 覆盖优先", () => {
    process.env.CW_AGENT_DIR = "/tmp/i1b-override";
    try {
      expect(resolveCwAgentDir()).toBe("/tmp/i1b-override");
    } finally {
      delete process.env.CW_AGENT_DIR;
    }
    expect(resolveCwAgentDir()).toBe(join(process.env.HOME ?? "~", ".cw", "agent-dir"));
  });
});

// ---- B. 真实 pi 进程（不依赖 LLM：get_state / stop / kill） ----

describe.skipIf(!hasPi)("i1b B：pi-rpc 适配器 × 真实 pi 进程", () => {
  it("启动探针拒派：designer 且受控 agentDir 缺 ask-user 扩展 → SPAWN_ERROR + 恢复指引", async () => {
    const emptyAgentDir = join(tmpRoot, "empty-agent-dir");
    mkdirSync(emptyAgentDir, { recursive: true });
    process.env.CW_AGENT_DIR = emptyAgentDir;
    try {
      const req = mkAgentRequest({ role: "designer" });
      const handle = await createPiRpcAdapter().spawn(req);
      const result = await handle.wait();
      expect(result.exitCode).toBe("SPAWN_ERROR");
      const stderr = readFileSync(result.stderrPath, "utf-8");
      expect(stderr).toContain("启动探针拒派");
      expect(stderr).toContain("cw setup-agent-dir");
      // SPAWN_ERROR 句柄无交互能力：followUp 明确报错而非静默
      await expect(
        (handle as InteractiveSpawnHandle).followUp("x"),
      ).rejects.toThrow(/无交互能力/);
    } finally {
      delete process.env.CW_AGENT_DIR;
    }
  });

  it(
    "握手：developer spawn → sessionAnchor 回填 + 产物锚文件落盘 → done() 优雅退出 exit 0",
    async () => {
      const req = mkAgentRequest({ unitId: "u-handshake", role: "developer" });
      const handle = await createPiRpcAdapter().spawn(req);
      const interactive = handle as InteractiveSpawnHandle;
      expect(typeof interactive.followUp).toBe("function");
      expect(interactive.sessionAnchor?.sessionId).toMatch(/.+/);
      expect(interactive.sessionAnchor?.sessionFile ?? "").toContain(req.artifactDir);

      const anchorPath = join(req.artifactDir, "u-handshake.developer.session.json");
      expect(existsSync(anchorPath)).toBe(true);
      const anchor = JSON.parse(readFileSync(anchorPath, "utf-8")) as {
        sessionId: string;
        sessionFile: string;
      };
      expect(anchor.sessionId).toBe(interactive.sessionAnchor?.sessionId);

      // stdout 事件流逐行落盘（JSONL）
      const stdoutPath = join(req.artifactDir, "u-handshake.developer.stdout");
      expect(existsSync(stdoutPath)).toBe(true);

      const result = await interactive.done();
      expect(result.exitCode).toBe(0);
    },
    90_000,
  );

  it(
    "kill：外部显式 kill → wait() 结算 TIMEOUT（可重派语义）",
    async () => {
      const req = mkAgentRequest({ unitId: "u-kill", role: "developer" });
      const handle = await createPiRpcAdapter().spawn(req);
      handle.kill();
      const result = await handle.wait();
      expect(result.exitCode).toBe("TIMEOUT");
    },
    90_000,
  );
});

// ---- B2. 无头穿透：ui_request 自动 cancelled + stderr 告警（真实协议桩，不依赖真 pi） ----

describe("i1b B2：无头穿透 ui_request 自动 cancelled + stderr 告警", () => {
  it(
    "extension_ui_request 到达 → 适配器自动回 cancelled 应答 + stderr 告警行",
    async () => {
      const dir = join(tmpRoot, "b2-" + Math.random().toString(36).slice(2, 8));
      mkdirSync(dir, { recursive: true });
      // 真实 node 协议桩（零 mock 框架，与 i1a 坏行桩同款形态）：应答 get_state，
      // 延迟上抛 extension_ui_request（等适配器握手后注册 onUiRequest 监听），
      // 收到 extension_ui_response 落日志（断言 cancelled 形态）
      const stubLog = join(dir, "stub.log");
      writeFileSync(
        join(dir, "stub.js"),
        [
          "const fs = require('node:fs');",
          "const log = process.env.CW_TEST_STUB_LOG;",
          "const rl = require('node:readline').createInterface({ input: process.stdin });",
          "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
          "let uiSent = false;",
          "rl.on('line', (line) => {",
          "  let m; try { m = JSON.parse(line); } catch { return; }",
          "  if (m.type === 'get_state') {",
          "    send({ type: 'response', id: m.id, command: 'get_state', success: true,",
          "      data: { sessionId: 'stub-i1b', sessionFile: log + '.session', isStreaming: false,",
          "        isCompacting: false, messageCount: 0, pendingMessageCount: 0 } });",
          "    if (!uiSent) {",
          "      uiSent = true;",
          "      setTimeout(() => send({ type: 'extension_ui_request', id: 'ui-1', method: 'ask_user', prompt: 'b2 测试问句' }), 300);",
          "    }",
          "  } else if (m.type === 'extension_ui_response') {",
          "    fs.appendFileSync(log, JSON.stringify(m) + '\\n');",
          "  } else if (m.type === 'prompt' || m.type === 'follow_up' || m.type === 'steer' || m.type === 'abort') {",
          "    send({ type: 'response', id: m.id, command: m.type, success: true });",
          "    send({ type: 'agent_settled' });",
          "  }",
          "});",
          "rl.on('close', () => process.exit(0));",
        ].join("\n"),
      );
      // PATH 前置目录放 `pi` shim（适配器 spawn "pi" 经 PATH 解析命中桩）
      writeFileSync(join(dir, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "stub.js")}" "$@"\n`);
      spawnSync("chmod", ["+x", join(dir, "pi")]);

      const origPath = process.env.PATH;
      process.env.PATH = `${dir}:${origPath ?? ""}`;
      process.env.CW_TEST_STUB_LOG = stubLog;
      // 捕获测试进程 stderr（适配器告警经 process.stderr.write 发出）
      const errChunks: string[] = [];
      const origErr = process.stderr.write;
      process.stderr.write = ((chunk: unknown, cb?: (err?: Error | null) => void) => {
        errChunks.push(String(chunk));
        if (typeof cb === "function") cb();
        return true;
      }) as typeof process.stderr.write;
      try {
        const req = mkAgentRequest({ unitId: "u-b2", role: "developer", artifactDir: dir, workdir: dir, projectCwd: dir });
        const handle = await createPiRpcAdapter().spawn(req);
        const interactive = handle as InteractiveSpawnHandle;
        // 等 ui_request 已被桩发出且适配器应答落桩日志（轮询 ≤5s）
        const deadline = Date.now() + 5_000;
        while (!existsSync(stubLog) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const result = await interactive.done();
        expect(result.exitCode).toBe(0);

        // 断言①：自动应答为 cancelled 形态（无人工通道不悬置）
        expect(existsSync(stubLog)).toBe(true);
        const respLine = readFileSync(stubLog, "utf-8").trim().split("\n")[0] ?? "";
        const resp = JSON.parse(respLine) as { type?: string; id?: string; cancelled?: boolean };
        expect(resp.type).toBe("extension_ui_response");
        expect(resp.id).toBe("ui-1");
        expect(resp.cancelled).toBe(true);

        // 断言②：stderr 有无头穿透告警行
        expect(errChunks.join("")).toContain("无 UI 通道，已取消");
      } finally {
        process.stderr.write = origErr;
        process.env.PATH = origPath;
        delete process.env.CW_TEST_STUB_LOG;
      }
    },
    60_000,
  );
});

// ---- C. 反思链（loop 接缝：真实 runLoop + 真实 InteractiveSpawnHandle 实现） ----

describe("i1b C：reflectionPending → followUp → ReflectionRan 入账最小链", () => {
  const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
  const hasDist = existsSync(join(DIST_ROOT, "runner", "loop.js"));

  /** captureStd：进程内捕获 loop 的 stdout/stderr（透传写回调防 flush 屏障超时） */
  async function captureStd(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
    const errChunks: string[] = [];
    const origErr = process.stderr.write;
    const collector = (chunks: string[]): typeof process.stderr.write =>
      ((chunk: unknown, cb?: (err?: Error | null) => void) => {
        chunks.push(String(chunk));
        if (typeof cb === "function") cb();
        return true;
      }) as typeof process.stderr.write;
    process.stderr.write = collector(errChunks);
    try {
      const code = await fn();
      return { code, err: errChunks.join("") };
    } finally {
      process.stderr.write = origErr;
    }
  }

  /** followUp 消费 worker：真实 node 子进程，stdin 逐行追加到日志文件后保持存活 */
  const followUpWorker = (() => {
    const path = join(tmpRoot, "i1b-followup-worker.cjs");
    writeFileSync(
      path,
      [
        "const fs = require('node:fs');",
        "const logPath = process.argv[2];",
        "let buf = '';",
        "process.stdin.setEncoding('utf-8');",
        "process.stdin.on('data', (d) => {",
        "  buf += d;",
        "  let i;",
        "  while ((i = buf.indexOf('\\n')) >= 0) {",
        "    const line = buf.slice(0, i);",
        "    buf = buf.slice(i + 1);",
        "    fs.appendFileSync(logPath, line + '\\n');",
        "  }",
        "});",
        "process.stdin.on('end', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    return path;
  })();

  function lineCount(path: string): number {
    try {
      return readFileSync(path, "utf-8").split("\n").filter((l) => l.length > 0).length;
    } catch {
      return 0;
    }
  }

  /**
   * 测试专用适配器：designer 派发返回真实子进程背书的 InteractiveSpawnHandle
   * （followUp 写 stdin，waitForIdle 轮询日志行数），spawn 后模拟 designer 向真实
   * 账本提交 spec（此后句柄保持存活——长驻形态）；reviewer 派发同款句柄但挂起
   * 不写账本（断言反思先行、reviewer 后到即可）。
   */
  function makeReflectionAdapter(
    records: { role: string; unitId: string }[],
    projectCwd: string,
    appendSpec: (unitId: string) => void,
  ): { adapter: AgentSpawnAdapter; followUpLog: string } {
    const followUpLog = join(tmpRoot, "i1b-followup.log");
    void projectCwd;
      return {
        followUpLog,
        adapter: {
          name: "i1b-interactive-test",
          spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
            records.push({ role: req.role, unitId: req.unitId });
            if (req.role === "designer") {
              // 模拟 designer agent 在 spawn 内提交 spec（账本推进，句柄存活）
              appendSpec(req.unitId);
            }
            const child = spawn(process.execPath, [followUpWorker, followUpLog], {
              cwd: req.workdir,
              stdio: ["pipe", "inherit", "inherit"],
            });
            const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
              (resolve) => child.on("exit", (code, signal) => resolve({ code, signal })),
            );
            const result = (exitCode: SpawnResult["exitCode"]): SpawnResult => ({
              exitCode,
              stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
              stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
              pid: child.pid ?? -1,
            });
            const exited = async (): Promise<SpawnResult> => {
              const info = await exitPromise;
              return result(info.code !== null ? info.code : "CRASH");
            };
            let sentFollowUps = 0;
            const interactiveHandle: InteractiveSpawnHandle = {
              wait: exited,
              kill: () => {
                child.kill("SIGTERM");
              },
              followUp: async (text: string) => {
                sentFollowUps += 1;
                child.stdin.write(`${text}\n`);
              },
              waitForIdle: async (ms: number) => {
                // brief 阶段（无 followUp 在途）立即 idle；followUp 后轮询日志行到位
                const deadline = Date.now() + ms;
                while (lineCount(followUpLog) < sentFollowUps) {
                  if (Date.now() >= deadline) return false;
                  await new Promise((r) => setTimeout(r, 50));
                }
                return true;
              },
              onUiRequest: () => {},
              done: async () => {
                child.stdin.end();
                return exited();
              },
              sessionAnchor: { sessionId: "i1b-test-session", sessionFile: followUpLog },
            };
            return interactiveHandle;
          },
        },
      };
  }

  it.skipIf(!hasDist)(
    "reflectionPending 派 designer → followUp 注入反思文案 → ReflectionRan（round 1/specHash）→ 下轮派 reviewer",
    async () => {
      const { runLoop } = await import(join(DIST_ROOT, "runner", "loop.js"));
      const { ledgerForCwd } = await import(join(DIST_ROOT, "handlers", "common.js"));
      const { loadLedger } = await import(join(DIST_ROOT, "readonly", "load.js"));
      const { encodeCwd } = await import(join(DIST_ROOT, "store", "project.js"));

      // fixture：真实 git repo + CW_HOME/CW_WORKTREE_HOME 隔离
      const base = join(tmpRoot, "loop-" + Math.random().toString(36).slice(2, 8));
      const repoDir = realpathSync(mkdirSync(base, { recursive: true }) as string);
      const git = (args: readonly string[]): void => {
        const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
        if (res.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${String(res.stderr)}`);
      };
      git(["init"]);
      git(["config", "user.email", "cw-i1b@example.com"]);
      git(["config", "user.name", "cw-i1b"]);
      writeFileSync(join(repoDir, "brief.md"), "# i1b fixture 任务书\n");
      git(["add", "-A"]);
      git(["commit", "-m", "fixture: brief"]);

      const cwHome = join(base, "cw-home");
      process.env.CW_HOME = cwHome;
      process.env.CW_WORKTREE_HOME = join(base, "cw-worktrees");
      const restore = (key: string): void => {
        delete process.env[key];
      };

      const ledger = ledgerForCwd(repoDir);
      ledger.append("UnitCreated", {
        unitId: "r1",
        parentId: null,
        briefRef: join(repoDir, "brief.md"),
      });
      const specHash = "hash-i1b-v1";
      const appendSpec = (unitId: string): void => {
        ledger.append("SpecSubmitted", {
          unitId,
          specHash,
          acceptance: [
            { id: "A1", core: true, title: "验收 A1", type: "e2e-real", command: "node app.js" },
          ],
          contracts: [],
          split: [],
        });
      };

      const records: { role: string; unitId: string }[] = [];
      const { adapter, followUpLog } = makeReflectionAdapter(records, repoDir, appendSpec);
      try {
        const { code } = await captureStd(() =>
          runLoop({
            rootId: "r1",
            adapter,
            cwd: repoDir,
            pollMs: 150,
            maxIdleMs: 2_000,
            maxConcurrency: 2,
            spawnTimeoutMs: 15_000,
          }),
        );
        // reviewer（无账本写入的挂起 spawn）由 maxIdle 收束：exit 1 是本场景预期
        expect(code).toBe(1);

        // 反思链：ReflectionRan 已入账（round 1、specHash 锚、sessionFile 审计锚）
        const unit = loadLedger(repoDir).projection.units.get("r1");
        expect(unit?.reflections).toHaveLength(1);
        const reflection = unit?.reflections[0];
        expect(reflection?.unitId).toBe("r1");
        expect(reflection?.specHash).toBe(specHash);
        expect(reflection?.round).toBe(1);
        expect(reflection?.sessionFile).toBe(followUpLog);

        // followUp 全文真实到达子进程（占位反思文案）
        const log = readFileSync(followUpLog, "utf-8");
        expect(log).toContain("反思");
        expect(log).toContain("TODO(ph-i2)");

        // 派发序：designer（反思）先行，reviewer（spec-review）后到
        expect(records.map((r) => r.role)).toEqual(["designer", "reviewer"]);

        // 锁已释放（runLoop 退出清尾）
        const lockPath = join(cwHome, encodeCwd(repoDir), "runner.lock");
        expect(existsSync(lockPath)).toBe(false);
      } finally {
        restore("CW_HOME");
        restore("CW_WORKTREE_HOME");
      }
    },
    120_000,
  );
});
