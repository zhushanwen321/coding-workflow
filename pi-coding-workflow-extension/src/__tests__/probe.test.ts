/**
 * u-i2-b：启动探针三查回归（真实对象：真实 pi RPC 握手子进程 + 真实 tmp agentDir
 * + 真实动态 import——本地 file: 预装 subagent-workflow 2.0.0 后 ② 为真实通过态）。
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkAskUserDeep,
  checkAskUserOnDisk,
  checkCwLib,
  checkSubagentApi,
  resolveAgentDir,
  runProbe,
  subagentInstallGuide,
} from "../probe.js";

const execFileP = promisify(execFile);

// 环境守卫（文件顶层，describe 回调内不可顶层 await）：本用例验证「本地开发态预装含
// createSpawnManager 的副本后默认包可导入」；该 API 未发布 npm，纯 registry 环境（CI）
// 下断言恒 false——跳过而非误报（同 entry.test.ts 守卫裁定）。
const defaultPkgReady = (await checkSubagentApi()).ok;

let dir: string;
let agentDirOk: string;
let agentDirEmpty: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cw-probe-"));
  agentDirOk = join(dir, "agent-ok");
  await mkdir(join(agentDirOk, "extensions", "ask-user"), { recursive: true });
  await writeFile(join(agentDirOk, "extensions", "ask-user", "index.ts"), "export default function (): void {}\n");
  await writeFile(join(agentDirOk, "manifest.json"), JSON.stringify({ manifestVersion: 1, packages: { "ask-user": { version: "0.0.0" } } }));
  agentDirEmpty = join(dir, "agent-empty");
  await mkdir(agentDirEmpty, { recursive: true });
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
});

describe("① ask-user 在场检查", () => {
  it("在场（磁盘：入口 + manifest 登记）→ ok", () => {
    const r = checkAskUserOnDisk(agentDirOk);
    expect(r.ok).toBe(true);
  });

  it("不在场 / 未登记 → fail 且文案含恢复动作", () => {
    expect(checkAskUserOnDisk(agentDirEmpty).ok).toBe(false);
    const partial = join(dir, "agent-partial");
    // 入口在、manifest 缺
    return (async () => {
      await mkdir(join(partial, "extensions", "ask-user"), { recursive: true });
      await writeFile(join(partial, "extensions", "ask-user", "index.ts"), "export default function (): void {}\n");
      const r2 = checkAskUserOnDisk(partial);
      expect(r2.ok).toBe(false);
      expect(r2.detail).toContain("manifest");
    })();
  });

  it("深查：真实 pi RPC 握手 + 扩展注入（真加载链验证；无 pi 则 skip）", async () => {
    let piExists = true;
    try {
      await execFileP("pi", ["--version"]);
    } catch {
      piExists = false;
    }
    if (!piExists) return;
    // 注入的扩展 = 真实可加载的最小 extension（在 ask-user 位置放同形桩——探针只验加载链）
    const r = await checkAskUserDeep({ agentDir: agentDirOk, timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
  });
});

describe("② subagent-workflow 编程 API 探测", () => {
  it.skipIf(!defaultPkgReady)("默认包：file: 预装 2.0.0 后 createSpawnManager 可导入", async () => {
    const r = await checkSubagentApi();
    expect(r.ok).toBe(true);
  }, 30_000);

  it("导入失败 → 拒启指引（§3.1 失败路径原文 + 本地开发态提示）", async () => {
    const r = await checkSubagentApi("no-such-package-cw-test");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(subagentInstallGuide());
  });

  it("指引 env 注入：CW_LOCAL_SUBAGENT_DIR 设定走本地路径形态，缺省不含个人路径", () => {
    const prev = process.env.CW_LOCAL_SUBAGENT_DIR;
    try {
      process.env.CW_LOCAL_SUBAGENT_DIR = "/tmp/fake-subagent-wf";
      const injected = subagentInstallGuide();
      expect(injected).toContain("npm install /tmp/fake-subagent-wf --no-save");
      delete process.env.CW_LOCAL_SUBAGENT_DIR;
      const generic = subagentInstallGuide();
      expect(generic).toContain("CW_LOCAL_SUBAGENT_DIR");
      expect(generic).not.toContain("/Users/");
    } finally {
      if (prev === undefined) delete process.env.CW_LOCAL_SUBAGENT_DIR;
      else process.env.CW_LOCAL_SUBAGENT_DIR = prev;
    }
  });

  it("无编程 API 的版本形态： specifier 命中但缺导出 → fail", async () => {
    // 以本包自身充当「有入口无 createSpawnManager」的真实包
    const r = await checkSubagentApi("@zhushanwen/pi-coding-workflow");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("createSpawnManager");
  });
});

describe("③ cw 引擎库探测", () => {
  it("默认 ./runner 门面：runLoop 可导入（本地 symlink 到仓根 dist）", async () => {
    const r = await checkCwLib();
    expect(r.ok).toBe(true);
  });

  it("失败路径文案", async () => {
    const r = await checkCwLib("no-such-cw-lib");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("不可导入");
  });
});

describe("三查合流（runProbe）", () => {
  it("ask-user 在场 + noClarify → clarify=false 且 reasons 含逃生口", async () => {
    const r = await runProbe({ agentDir: agentDirOk, noClarify: true });
    expect(r.clarify).toBe(false);
    expect(r.reasons.some((x) => x.includes("NO_CLARIFY"))).toBe(true);
  });

  it("ask-user 不在场 → clarify=false（不做半通态）", async () => {
    const r = await runProbe({ agentDir: agentDirEmpty });
    expect(r.clarify).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("agentDir 解析：CW_AGENT_DIR 覆盖优先", () => {
    const prev = process.env.CW_AGENT_DIR;
    process.env.CW_AGENT_DIR = "/tmp/xyz-agent-dir";
    try {
      expect(resolveAgentDir()).toBe("/tmp/xyz-agent-dir");
    } finally {
      if (prev === undefined) delete process.env.CW_AGENT_DIR;
      else process.env.CW_AGENT_DIR = prev;
    }
  });
});
