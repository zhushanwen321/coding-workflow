/**
 * u6c pi 适配器单测（docs/rewrite/acceptance/u6c-acceptance.md 单测验收 4 组）。
 *
 * 零 mock：全部真实 OS 子进程 + 真实 fs + tmp 目录（afterAll 清理）。探针落点：
 *   - 组2（env 合并）：适配器命令锁定裸名 "pi" → 以 PATH 前置的真实 sh 探测脚本
 *     观测 req.env 透传（真实子进程，非 mock 框架；真实 pi 调用在组3）；
 *   - 组3（真实微调用 E2E）：真实 pi + 真实网络模型调用（mimo-v2.5-pro 已实测可用）。
 *     本地扩展可能向 stderr 写噪音——判定只看 exitCode + stdout（验收实测事实）；
 *   - 组4（SPAWN_ERROR）：PATH 隔离触发 lifecycle ENOENT 同步预检 → 适配器转译，
 *     wait() 秒回不挂死（挂死会撞默认 testTimeout）。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { buildPiCommand, createPiAdapter, resolvePiModel } from "../src/runner/spawn/pi.js";
import type { AgentSpawnRequest } from "../src/runner/spawn/types.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u6c-pi-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const DEFAULT_MODEL = "xiaomi-token-plan-cn/mimo-v2.5-pro";

/** 最小合法请求 fixture；timeoutMs 用 30min 语义缺省值（适配器只透传不起进程） */
function baseReq(overrides?: Partial<AgentSpawnRequest>): AgentSpawnRequest {
  const workdir = join(tmpRoot, "base-work");
  return {
    role: "builder",
    unitId: "u6c-unit",
    workdir,
    briefPath: join(workdir, "brief.md"),
    timeoutMs: 1_800_000,
    ...overrides,
  };
}

describe("u6c pi 适配器：buildPiCommand 命令拼装与模型三级优先级", () => {
  // 三级优先级测试要显式操纵 process.env.CW_AGENT_MODEL，用例后恢复原值
  const savedModelEnv = process.env.CW_AGENT_MODEL;

  afterEach(() => {
    if (savedModelEnv === undefined) {
      delete process.env.CW_AGENT_MODEL;
    } else {
      process.env.CW_AGENT_MODEL = savedModelEnv;
    }
  });

  it("默认模型 = mimo-v2.5-pro（三级取值全空）", () => {
    delete process.env.CW_AGENT_MODEL;
    const req = baseReq();
    expect(resolvePiModel(undefined, req)).toBe(DEFAULT_MODEL);
    expect(buildPiCommand(req, DEFAULT_MODEL)).toEqual({
      command: "pi",
      args: ["--model", DEFAULT_MODEL, "-p", "--no-session", `@${req.briefPath}`],
    });
  });

  it("优先级1：opts.model 覆盖 req.env.CW_AGENT_MODEL 与 process.env.CW_AGENT_MODEL", () => {
    process.env.CW_AGENT_MODEL = "proc-env/model";
    const req = baseReq({ env: { CW_AGENT_MODEL: "req-env/model" } });
    expect(resolvePiModel({ model: "opt/model" }, req)).toBe("opt/model");
  });

  it("优先级2：req.env.CW_AGENT_MODEL 覆盖 process.env.CW_AGENT_MODEL", () => {
    process.env.CW_AGENT_MODEL = "proc-env/model";
    const req = baseReq({ env: { CW_AGENT_MODEL: "req-env/model" } });
    expect(resolvePiModel(undefined, req)).toBe("req-env/model");
  });

  it("优先级3：process.env.CW_AGENT_MODEL 覆盖默认模型", () => {
    process.env.CW_AGENT_MODEL = "proc-env/model";
    expect(resolvePiModel(undefined, baseReq())).toBe("proc-env/model");
  });

  it("brief 以 @file 位置参数传递（非 stdin 重定向、非 $(cat) 展开）", () => {
    const req = baseReq();
    const { args } = buildPiCommand(req, DEFAULT_MODEL);
    expect(args).toContain(`@${req.briefPath}`);
    const joined = args.join(" ");
    expect(joined).not.toContain("$(cat");
    expect(joined).not.toContain("<");
    expect(args).toContain("-p");
    expect(args).toContain("--no-session");
  });

  it("opts.extraArgs 追加到命令尾部", () => {
    const { args } = buildPiCommand(baseReq(), DEFAULT_MODEL, ["--plugin", "probe"]);
    expect(args.slice(-2)).toEqual(["--plugin", "probe"]);
  });
});

describe("u6c pi 适配器：env 合并透传（真实子进程观测）", () => {
  it("req.env 变量出现在子进程 env；产物落 <workdir>/.cw-spawn/<unitId>.<role>.*", async () => {
    const workdir = join(tmpRoot, "env-merge-work");
    const briefPath = join(workdir, "brief.md");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(briefPath, "env merge probe brief");
    // 探测脚本：适配器命令锁定裸名 "pi"，PATH 前置本目录使解析命中探测脚本——
    // 真实 sh 子进程（与真实 pi 的差异只在被测面：本组测 env 透传，非模型调用）
    const binDir = join(tmpRoot, "env-probe-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "pi"),
      '#!/bin/sh\necho "CW_U6C_PROBE=$CW_U6C_PROBE"\n',
      { mode: 0o755 },
    );
    const req = baseReq({
      role: "reviewer",
      unitId: "u6c-env",
      workdir,
      briefPath,
      timeoutMs: 30_000,
      env: { CW_U6C_PROBE: "transferred", PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });
    const handle = await createPiAdapter().spawn(req);
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdoutPath).toBe(join(workdir, ".cw-spawn", "u6c-env.reviewer.stdout"));
    expect(result.stderrPath).toBe(join(workdir, ".cw-spawn", "u6c-env.reviewer.stderr"));
    expect(readFileSync(result.stdoutPath, "utf8")).toContain("CW_U6C_PROBE=transferred");
  });
});

describe("u6c pi 适配器：真实 pi 微调用 E2E", () => {
  // 跳过条件（验收文档）：环境无 pi 时 skip 并 warn，保证 CI 可重复；本地 pi 可用则真实跑
  const piResolvable = spawnSync("which", ["pi"], { encoding: "utf8" }).status === 0;
  const itRealPi = piResolvable ? it : it.skip;

  if (!piResolvable) {
    console.warn("u6c: PATH 上无 pi，真实 E2E 条跳过（本地 pi 可用环境不 skip）");
  }

  itRealPi(
    "真实 spawn：brief「请只输出两个字：可用」→ exit 0 + stdout 含模型回复",
    async () => {
      const workdir = join(tmpRoot, "e2e-real-pi");
      const briefPath = join(workdir, "brief.md");
      mkdirSync(workdir, { recursive: true });
      writeFileSync(briefPath, "请只输出两个字：可用");
      const req = baseReq({
        role: "builder",
        unitId: "u6c-real",
        workdir,
        briefPath,
        // PI_OFFLINE=1 减少启动期网络操作（实测可用）；timeoutMs 压在 testTimeout 内，
        // 卡死时以 TIMEOUT 归因失败（可诊断）而不是 vitest 硬超时
        env: { PI_OFFLINE: "1" },
        timeoutMs: 110_000,
      });
      const handle = await createPiAdapter().spawn(req);
      const result = await handle.wait();
      // stderr 可能有本地扩展噪音，判定只看 exitCode + stdout（验收实测事实）
      expect(result.exitCode).toBe(0);
      const stdout = existsSync(result.stdoutPath) ? readFileSync(result.stdoutPath, "utf8") : "";
      expect(stdout.trim().length).toBeGreaterThan(0);
      console.log("u6c 真实 E2E stdout 摘录:", JSON.stringify(stdout.trim()));
    },
    120_000,
  );
});

describe("u6c pi 适配器：SPAWN_ERROR 转译", () => {
  it("PATH 隔离（env.PATH=/nonexistent）→ lifecycle 预检同步抛 → wait() 返回 SPAWN_ERROR 不挂死", async () => {
    const workdir = join(tmpRoot, "spawn-error-work");
    const briefPath = join(workdir, "brief.md");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(briefPath, "spawn error probe brief");
    const req = baseReq({
      workdir,
      briefPath,
      timeoutMs: 5_000,
      env: { PATH: "/nonexistent-path-u6c" },
    });
    const handle = await createPiAdapter().spawn(req);
    const result = await handle.wait();
    expect(result.exitCode).toBe("SPAWN_ERROR");
    expect(result.pid).toBe(-1);
    expect(result.stdoutPath).toBe(join(workdir, ".cw-spawn", "u6c-unit.builder.stdout"));
    expect(result.stderrPath).toBe(join(workdir, ".cw-spawn", "u6c-unit.builder.stderr"));
  });
});
