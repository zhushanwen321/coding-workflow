/**
 * W2 pipeline 域测试（design-release-pipeline.md §4 A4 + AC-4.1/4.2 + N10；
 * execution-plan T2.1/T2.2/viaCache/fail 即停/幂等）。
 *
 * 零 mock：真实 tmp git 仓 + 真实子进程执行步骤命令。
 *
 * T2.1 中断模拟的等价性说明：A4 的「第 3 步执行中 SIGKILL」与「第 3 步 fail
 * 停止 → 修复环境 → 同命令续跑」在投影语义上等价（中断步骤 = 未见 pass 记录
 * → 续跑必须重做；已 pass 步骤靠投影跳过）。fail-then-fix 形态确定性最强，
 * 采为断言形态（SIGKILL 形态受进程时序影响易 flaky）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DuplicatePipelineStepError, gateLedgerDomain } from "../src/gate/domain.js";
import { foldGate } from "../src/gate/fold.js";
import { loadManifest } from "../src/pipeline/manifest.js";
import { PipelineEnvironmentError, runPipeline } from "../src/pipeline/run.js";
import { pipelineStatus } from "../src/pipeline/status.js";
import { EventLedger } from "../src/store/events-log.js";
import { gateLedgerPath } from "../src/store/project.js";

let root: string;
let projDir: string;
let cwHome: string;

function initRepo(name: string): void {
  projDir = join(root, name);
  mkdirSync(projDir, { recursive: true });
  const git = (args: string[]) =>
    spawnSync("git", ["-C", projDir, ...args], { encoding: "utf-8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(projDir, "README.md"), "# t\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
}

function writeManifest(repo: string, steps: unknown[]): string {
  const p = join(repo, ".cw-pipeline.json");
  writeFileSync(p, JSON.stringify({ version: 1, steps }, null, 2));
  return p;
}

function stepEvents(): { pipeline: string; step: string; runId: string; result: string; viaCache?: boolean }[] {
  const events = new EventLedger(gateLedgerPath(cwHome, projDir), gateLedgerDomain).readAll();
  return events
    .map((e) => e as unknown as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === "PipelineStepRan")
    .map((e) => ({
      pipeline: e.payload.pipeline as string,
      step: e.payload.step as string,
      runId: e.payload.runId as string,
      result: e.payload.result as string,
      ...(e.payload.viaCache === true ? { viaCache: true } : {}),
    }));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cw-w2-pipeline-"));
  cwHome = join(root, "cw-home");
  mkdirSync(cwHome, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("w2 T2.1 A4 断点续跑（fail-then-fix 等价形态）", () => {
  it("第 3 步 fail 停止 → 修复环境后同命令续跑：步骤 1/2 零重做、步骤 3 重跑、status 两时点正确", () => {
    initRepo("resume");
    // s3 读 flag.txt（缺 = fail；写 = pass）——不改 manifest，manifestSha256 稳定
    const manifestPath = writeManifest(projDir, [
      { name: "s1", command: ["node", "-e", "console.log('s1')"] },
      { name: "s2", command: ["node", "-e", "console.log('s2')"] },
      { name: "s3", command: ["node", "-e", "require('fs').readFileSync('flag.txt')"] },
    ]);

    // 中断时点 1：s3 fail 即停
    const run1 = runPipeline({ cwHome, cwd: projDir, manifestPath });
    expect(run1.exitCode).toBe(1);
    expect(run1.failedStep).toBe("s3");
    const st1 = pipelineStatus({ cwHome, cwd: projDir, manifestPath });
    expect(st1.steps.map((s) => s.state)).toEqual(["pass", "pass", "fail"]);

    // 修复环境（flag.txt 出现；不碰 manifest → 分组不变）
    writeFileSync(join(projDir, "flag.txt"), "ok");

    // 续跑：s1/s2 靠投影跳过（零重做 = 账本无 s1/s2 新事件），s3 重跑 pass
    const before = stepEvents();
    const run2 = runPipeline({ cwHome, cwd: projDir, manifestPath });
    const after = stepEvents();
    expect(run2.exitCode).toBe(0);
    expect(run2.skipped).toBe(2);
    expect(run2.ran).toBe(1);
    expect(after.length - before.length).toBe(1); // 仅 s3 一条新 PipelineStepRan
    const newEvent = after[after.length - 1] as { step: string; result: string };
    expect(newEvent.step).toBe("s3");
    expect(newEvent.result).toBe("pass");
    // s1/s2 事件数不变（零重做）
    expect(after.filter((e) => e.step === "s1").length).toBe(before.filter((e) => e.step === "s1").length);
    expect(after.filter((e) => e.step === "s2").length).toBe(before.filter((e) => e.step === "s2").length);

    // 中断时点 2：续跑完成 [✓,✓,✓]
    const st2 = pipelineStatus({ cwHome, cwd: projDir, manifestPath });
    expect(st2.steps.map((s) => s.state)).toEqual(["pass", "pass", "pass"]);
  });
});

describe("w2 T2.2 manifest 内容寻址 + 非法输入", () => {
  it("manifest 加步骤 → manifestSha256 变 → 旧 pass 全部重跑（新分组，无假进度）", () => {
    initRepo("readdress");
    const manifestPath = writeManifest(projDir, [
      { name: "a", command: ["node", "-e", "console.log('a')"] },
      { name: "b", command: ["node", "-e", "console.log('b')"] },
      { name: "c", command: ["node", "-e", "console.log('c')"] },
    ]);
    const run1 = runPipeline({ cwHome, cwd: projDir, manifestPath });
    expect(run1.exitCode).toBe(0);
    expect(run1.ran).toBe(3);
    const sha1 = loadManifest(manifestPath).manifestSha256;

    // 加第 4 步 → sha 变 → 全部重跑
    writeManifest(projDir, [
      { name: "a", command: ["node", "-e", "console.log('a')"] },
      { name: "b", command: ["node", "-e", "console.log('b')"] },
      { name: "c", command: ["node", "-e", "console.log('c')"] },
      { name: "d", command: ["node", "-e", "console.log('d')"] },
    ]);
    const sha2 = loadManifest(manifestPath).manifestSha256;
    expect(sha2).not.toBe(sha1);
    const run2 = runPipeline({ cwHome, cwd: projDir, manifestPath });
    expect(run2.exitCode).toBe(0);
    expect(run2.ran).toBe(4); // 旧 3 步全部重跑 + 新 1 步（假进度 = 旧 pass 混入新分组被跳过，此处 4 = 无假进度）
    expect(run2.skipped).toBe(0);
    // 分组隔离：旧分组 3 条 + 新分组 4 条
    const events = new EventLedger(gateLedgerPath(cwHome, projDir), gateLedgerDomain).readAll();
    const proj = foldGate(events);
    expect(proj.latestStepRun.size).toBe(7); // 旧 3 + 新 4 各自成组
  });

  it("坏 JSON / schema 违规 / manifest 不存在 → 报错含恢复动作（N10）", () => {
    initRepo("invalid");
    const bad = join(projDir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(() => loadManifest(bad)).toThrow(/不是合法 JSON/);
    expect(() => loadManifest(bad)).toThrow(/恢复动作/);

    const wrongVer = join(projDir, "ver.json");
    writeFileSync(wrongVer, JSON.stringify({ version: 2, steps: [{ name: "x", command: ["true"] }] }));
    expect(() => loadManifest(wrongVer)).toThrow(/version 必须为 1/);

    const dup = join(projDir, "dup.json");
    writeFileSync(dup, JSON.stringify({ version: 1, steps: [
      { name: "x", command: ["true"] },
      { name: "x", command: ["true"] },
    ] }));
    expect(() => loadManifest(dup)).toThrow(/重复/);

    expect(() => runPipeline({ cwHome, cwd: projDir, manifestPath: join(projDir, "nope.json") })).toThrow(
      /manifest 读取失败/,
    );
    expect(() => pipelineStatus({ cwHome, cwd: projDir, manifestPath: join(projDir, "nope.json") })).toThrow(
      /manifest 不存在/,
    );
  });
});

describe("w2 viaCache（cache 步骤内部走 gate 缓存判定）", () => {
  it("manifest 变更后 scope 未变的 cache 步骤 → viaCache:true + GateCacheHit；无 cache 步骤真实重跑", () => {
    initRepo("viacache");
    mkdirSync(join(projDir, "src"), { recursive: true });
    writeFileSync(join(projDir, "src", "x.ts"), "export const x = 1;\n");
    spawnSync("git", ["-C", projDir, "add", "."]);
    spawnSync("git", ["-C", projDir, "commit", "-m", "src"], { encoding: "utf-8" });

    const mk = (extra: unknown[] = []) =>
      writeManifest(projDir, [
        { name: "cached", command: ["node", "-e", "console.log('c')"], cache: { scope: ["src/"] } },
        { name: "plain", command: ["node", "-e", "console.log('p')"] },
        ...extra,
      ]);
    const manifestPath = mk();

    const run1 = runPipeline({ cwHome, cwd: projDir, manifestPath, baseRef: "HEAD" });
    expect(run1.exitCode).toBe(0);
    expect(run1.ran).toBe(2);
    // run1：cached 步骤真实执行（GateCheckRan）+ plain 直接执行
    const ledger = () => new EventLedger(gateLedgerPath(cwHome, projDir), gateLedgerDomain).readAll();
    const types1 = ledger().map((e) => (e as { type: string }).type);
    expect(types1).toContain("GateCheckRan");
    expect(types1).not.toContain("GateCacheHit");

    // manifest 变（加步骤）→ 新分组重跑；cached 步骤 scope 未变 → gate 缓存命中
    const manifestPath2 = mk([{ name: "extra", command: ["node", "-e", "console.log('e')"] }]);
    const run2 = runPipeline({ cwHome, cwd: projDir, manifestPath: manifestPath2, baseRef: "HEAD" });
    expect(run2.exitCode).toBe(0);
    expect(run2.ran).toBe(3);
    expect(run2.skipped).toBe(0);

    const events2 = ledger();
    const stepRans = events2
      .map((e) => e as unknown as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "PipelineStepRan");
    const cachedRuns = stepRans.filter((e) => e.payload.step === "cached");
    expect(cachedRuns.length).toBe(2); // run1 真实 + run2 命中
    expect(cachedRuns[1]?.payload.viaCache).toBe(true);
    expect(cachedRuns[1]?.payload.durationMs).toBe(0);
    // run2 产生 GateCacheHit（gate-events.log 同账本）
    expect(events2.map((e) => (e as { type: string }).type)).toContain("GateCacheHit");
    // plain 步骤两次都真实（无 viaCache 字段）
    const plainRuns = stepRans.filter((e) => e.payload.step === "plain");
    expect(plainRuns.every((e) => e.payload.viaCache === undefined)).toBe(true);
  });

  it("cache 步骤缺 --base → 环境错误含恢复动作", () => {
    initRepo("nobase");
    const manifestPath = writeManifest(projDir, [
      { name: "c", command: ["node", "-e", "console.log(1)"], cache: { scope: ["src/"] } },
    ]);
    try {
      runPipeline({ cwHome, cwd: projDir, manifestPath });
      expect.unreachable("缺 base 应抛环境错误");
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineEnvironmentError);
      expect((e as Error).message).toContain("--base");
      expect((e as Error).message).toContain("恢复动作");
    }
  });
});

// ── pipeline status --json（D8 契约：design-release-pipeline.md「只读 cw pipeline status [--json]」）──
//
// handler 层 flag 解析无法用直调核心库的形态覆盖，采 CLI 子进程 e2e
// （对照 w1-gate-e2e 的 runCli 模式：真实子进程跑 dist/cli.js 走完整 dispatch 路径）。
// dist 缺席时挂起（pretest build 后自动激活，对照 w1 同款守卫）。

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const distIt = existsSync(CLI_PATH) ? it : it.todo;

function runCli(args: readonly string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
    timeout: 60_000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("w2 pipeline status --json（D8 契约）", () => {
  distIt("--json 输出机器可解析 JSON；缺省人类可读形态不变", () => {
    initRepo("status-json");
    const manifestPath = writeManifest(projDir, [
      { name: "s1", command: ["node", "-e", "console.log('s1')"] },
      { name: "s2", command: ["node", "-e", "process.exit(7)"] }, // fail 即停
      { name: "s3", command: ["node", "-e", "console.log('s3')"] }, // 未执行 → pending
    ]);
    const run = runCli(["pipeline", "run", "--manifest", manifestPath], projDir);
    expect(run.code).toBe(1);

    // --json：机器消费方契约——stdout 必须整体为一个合法 JSON 值
    const res = runCli(["pipeline", "status", "--manifest", manifestPath, "--json"], projDir);
    expect(res.code).toBe(0);
    const parsed: unknown = JSON.parse(res.stdout); // 非法 JSON 在此抛错（人类文本混入即红）
    expect(parsed).toEqual({
      pipeline: ".cw-pipeline",
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      steps: [
        { name: "s1", state: "pass", durationMs: expect.any(Number), seq: expect.any(Number) },
        { name: "s2", state: "fail", durationMs: expect.any(Number), seq: expect.any(Number) },
        { name: "s3", state: "pending" },
      ],
    });

    // 缺省输出逐字形态锁定（M1 验收②：人类可读模式字节不变）
    const human = runCli(["pipeline", "status", "--manifest", manifestPath], projDir);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(
      /^pipeline "\.cw-pipeline"（manifest [0-9a-f]{8}…）：\n  ✓ s1.*\n  ✗ s2.*\n  pending s3\n$/,
    );
  });

  distIt("manifest 缺失 → --json 不产出假 JSON：stderr 报错 exit 1", () => {
    initRepo("status-json-missing");
    const res = runCli(
      ["pipeline", "status", "--manifest", join(projDir, "nope.json"), "--json"],
      projDir,
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("manifest 不存在");
    expect(res.stdout).toBe("");
  });
});

describe("w2 PipelineStepRan 幂等（域描述符兜底）", () => {
  it("同 pipeline+step+runId 重复追加 → DuplicatePipelineStepError，拒绝不写字节", () => {
    initRepo("idem");
    const path = gateLedgerPath(cwHome, projDir);
    const ledger = new EventLedger(path, gateLedgerDomain);
    const payload = {
      pipeline: "idem",
      manifestSha256: "a".repeat(64),
      step: "s1",
      headSha: "b".repeat(40),
      runId: "r1",
      result: "pass" as const,
      durationMs: 5,
    };
    ledger.append("PipelineStepRan", payload);
    const sizeAfterFirst = ledger.readAll().length;
    expect(() => ledger.append("PipelineStepRan", payload)).toThrow(DuplicatePipelineStepError);
    expect(ledger.readAll().length).toBe(sizeAfterFirst); // 拒绝不写字节
  });
});
