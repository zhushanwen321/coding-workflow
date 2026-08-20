/**
 * mx-1 单测：reviewer 异源模型链（mx1-acceptance §5 T7-T8）。真实 runLoop 直调
 * + 测试专用记录适配器（spawn 时同步按 role 推进账本，u7b stepped 同款）+ dist
 * 的 resolvePiModel / buildPiCommand 纯函数（命令行拼装的唯一出处），真实 git
 * 子进程 + tmp 目录 + 隔离 CW_HOME，零 mock。
 *
 *   T7 三级链：CW_REVIEWER_MODEL 进程环境 → reviewer spawn 的 pi 命令行含对应
 *      --model；--reviewer-model flag 优先于环境；都未设 → reviewer 与 designer
 *      spawn 命令行同 model（对照断言）
 *   T8 pi.ts 零改动（mx3 迁移：锁定显式解除——仅限 session 参数行）：diff
 *      不得触及模型注入链（resolvePiModel / DEFAULT_PI_MODEL）；session 落盘
 *      参数（--session-dir/--name）是 mx3 对该锁定的唯一合法放开面
 *
 * 注意：直调 runLoop 依赖 dist（先 npm run build；npm test 的 pretest 已含）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../dist/events/types.js";
import { ledgerForCwd } from "../dist/handlers/common.js";
import { runLoop } from "../dist/runner/loop.js";
import { buildPiCommand, resolvePiModel } from "../dist/runner/spawn/pi.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";

const DIST_ROOT = fileURLToPath(new URL("../dist", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
for (const required of [join(DIST_ROOT, "runner", "loop.js"), join(DIST_ROOT, "runner", "spawn", "pi.js")]) {
  if (!existsSync(required)) {
    throw new Error(`tests/mx1-model-chain 需要 ${required}（先 npm run build；npm test 的 pretest 已含）`);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx1-model-"));
process.env.CW_HOME = join(tmpRoot, "cw-home");
process.env.CW_WORKTREE_HOME = join(tmpRoot, "cw-worktrees");
const originalReviewerModelEnv = process.env.CW_REVIEWER_MODEL;
const originalAgentModelEnv = process.env.CW_AGENT_MODEL;

afterAll(() => {
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
  if (originalReviewerModelEnv === undefined) {
    delete process.env.CW_REVIEWER_MODEL;
  } else {
    process.env.CW_REVIEWER_MODEL = originalReviewerModelEnv;
  }
  if (originalAgentModelEnv === undefined) {
    delete process.env.CW_AGENT_MODEL;
  } else {
    process.env.CW_AGENT_MODEL = originalAgentModelEnv;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 独立 repo：init + 一个真实 commit（HEAD 快照前提）+ root unit */
function makeRepo(name: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-mx1m@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-mx1m"]);
  writeFileSync(join(repoDir, "brief.md"), "# mx1 模型链 fixture\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  ledgerForCwd(repoDir).append("UnitCreated", {
    unitId: "root",
    parentId: null,
    briefRef: join(repoDir, "brief.md"),
  });
  return repoDir;
}

/**
 * stepped 记录适配器：spawn 时同步按 role 推进账本（designer → 仅 spec（mx-1
 * 不自审）；reviewer → 按 unit 现状出 spec-review / exec-review；developer →
 * evidence + VerifyRan），记录全部 req——重点断言 reviewer role 的 req.env
 * （loop 的 CW_AGENT_MODEL 注入点）。
 */
function makeSteppedAdapter(): { adapter: AgentSpawnAdapter; calls(): readonly AgentSpawnRequest[] } {
  const requests: AgentSpawnRequest[] = [];
  const advance = (req: AgentSpawnRequest): void => {
    const ledger = ledgerForCwd(req.projectCwd);
    if (req.role === "designer") {
      const spec = { acceptance: ACCEPTANCE, contracts: [], split: [] };
      ledger.append("SpecSubmitted", {
        unitId: req.unitId,
        specHash: sha(JSON.stringify(spec)),
        acceptance: [...ACCEPTANCE],
        contracts: [],
        split: [],
      });
      return;
    }
    if (req.role === "developer") {
      const runId = `run-${req.unitId}-${Date.now()}`;
      ledger.append("EvidenceSubmitted", {
        unitId: req.unitId,
        runId,
        commit: gitRun(req.projectCwd, ["rev-parse", "HEAD"]),
        paths: ["app.js"],
        sha256: [sha("app.js")],
        exitCode: 0,
      });
      ledger.append("VerifyRan", {
        unitId: req.unitId,
        runId,
        reportHash: sha(`evidence-report:${runId}`),
        result: "pass",
        acceptanceIds: ACCEPTANCE.map((a) => a.id),
      });
      return;
    }
    // reviewer：按 unit 现状二选一（已 verify → exec-review；否则 spec-review）
    //（进程内同步推进，无中间态竞态）
    const verified = ledgerForCwd(req.projectCwd).readAll().some(
      (ev) => ev.type === "VerifyRan" && ev.payload.unitId === req.unitId,
    );
    ledger.append("VerdictSubmitted", {
      unitId: req.unitId,
      verdictKind: verified ? "exec-review" : "spec-review",
      verdict: "pass",
      role: "reviewer",
    });
  };
  return {
    adapter: {
      name: "mx1-model-stepped",
      spawn: async (req: AgentSpawnRequest): Promise<SpawnHandle> => {
        requests.push(req);
        advance(req);
        return {
          wait: () =>
            Promise.resolve({
              exitCode: 0,
              stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
              stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
              pid: -1,
            } satisfies SpawnResult),
          kill: () => {},
        };
      },
    },
    calls: () => requests,
  };
}

/** 跑一遍单 unit 全链（designer → reviewer(spec) → developer → reviewer(exec)），返回全部 spawn req */
async function runFullChain(repoDir: string, reviewerModel?: string): Promise<readonly AgentSpawnRequest[]> {
  const script = makeSteppedAdapter();
  const code = await runLoop({
    rootId: "root",
    adapter: script.adapter,
    cwd: repoDir,
    pollMs: 30,
    maxIdleMs: 30_000,
    ...(reviewerModel !== undefined ? { reviewerModel } : {}),
  });
  expect(code).toBe(0);
  const roles = script.calls().map((r) => r.role);
  expect(roles).toEqual(["designer", "reviewer", "developer", "reviewer"]);
  return script.calls();
}

/** req → pi 实际命令行的 --model（resolvePiModel + buildPiCommand 是拼装唯一出处） */
function piModelOf(req: AgentSpawnRequest): string {
  const model = resolvePiModel(undefined, req);
  const args = buildPiCommand(req, model).args;
  const idx = args.indexOf("--model");
  if (idx < 0 || args[idx + 1] === undefined) {
    throw new Error("pi 命令行缺 --model（断言前置失败）");
  }
  expect(args[idx + 1]).toBe(model);
  return model;
}

describe("mx-1 T7 reviewer 异源模型三级链（flag > CW_REVIEWER_MODEL > 回落 developer 同款）", () => {
  it("CW_REVIEWER_MODEL 进程环境 → reviewer spawn 的 req.env 注入对应模型，pi 命令行含 --model；designer 不受影响", async () => {
    const envModel = "deepseek/reviewer-env-model";
    process.env.CW_REVIEWER_MODEL = envModel;
    delete process.env.CW_AGENT_MODEL;
    try {
      const repoDir = makeRepo("t7-env");
      const calls = await runFullChain(repoDir);
      const [designer, specReviewer, , execReviewer] = calls;
      // 注入点 = reviewer role 的 req.env.CW_AGENT_MODEL（loop 组装，pi 零改动）
      expect(specReviewer?.env?.CW_AGENT_MODEL).toBe(envModel);
      expect(execReviewer?.env?.CW_AGENT_MODEL).toBe(envModel);
      // pi 命令行（resolvePiModel 的 req.env 级 > 默认链）真实生效
      expect(piModelOf(specReviewer!)).toBe(envModel);
      expect(piModelOf(execReviewer!)).toBe(envModel);
      // designer 不受影响：无注入（回落其自身链）
      expect(designer?.env?.CW_AGENT_MODEL).toBeUndefined();
    } finally {
      delete process.env.CW_REVIEWER_MODEL;
    }
  }, 30_000);

  it("--reviewer-model flag 优先于 CW_REVIEWER_MODEL 环境（flag 值进 req.env 与命令行）", async () => {
    process.env.CW_REVIEWER_MODEL = "env/should-lose";
    delete process.env.CW_AGENT_MODEL;
    try {
      const repoDir = makeRepo("t7-flag-wins");
      const flagModel = "kimi/flag-priority-model";
      const calls = await runFullChain(repoDir, flagModel);
      const specReviewer = calls[1];
      expect(specReviewer?.env?.CW_AGENT_MODEL).toBe(flagModel);
      expect(piModelOf(specReviewer!)).toBe(flagModel);
    } finally {
      delete process.env.CW_REVIEWER_MODEL;
    }
  }, 30_000);

  it("都未设 → reviewer 与 designer 的 req 均无 CW_AGENT_MODEL 注入，pi 命令行同 model（对照断言）", async () => {
    delete process.env.CW_REVIEWER_MODEL;
    delete process.env.CW_AGENT_MODEL;
    const repoDir = makeRepo("t7-default-same");
    const calls = await runFullChain(repoDir);
    const [designer, specReviewer, developer, execReviewer] = calls;
    for (const req of [designer, specReviewer, developer, execReviewer]) {
      expect(req?.env?.CW_AGENT_MODEL, "未配置时不得注入（reviewer 回落 developer 同款链）").toBeUndefined();
    }
    const designerModel = piModelOf(designer!);
    expect(piModelOf(specReviewer!)).toBe(designerModel);
    expect(piModelOf(developer!)).toBe(designerModel);
    expect(piModelOf(execReviewer!)).toBe(designerModel);
  }, 30_000);
});

// ================================================================
// T8：pi.ts 模型注入链零改动（mx3 迁移：原「pi.ts 零改动」锁定由 mx3 显式解除
// ——仅放开 session 参数行，见 mx3-acceptance §2/§3；模型注入链仍锁定）
// ================================================================

describe("mx-1 T8 pi.ts 模型注入链零改动（mx3 迁移：session 参数行显式放开）", () => {
  it("diff（若非空）仅涉及 session 落盘参数；不得触及 resolvePiModel / DEFAULT_PI_MODEL", () => {
    const res = spawnSync(
      "git",
      ["diff", "HEAD", "--", "src/runner/spawn/pi.ts"],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: 30_000 },
    );
    expect(res.status, `git diff 应成功（stderr: ${res.stderr}）`).toBe(0);
    const diff = res.stdout ?? "";
    // 交付时点（工作区含 mx3 改动）：diff 应体现 session 参数迁移；提交后时点：
    // diff 为空——两种时点都是合法形态（锚的是「模型链不动」，不是「文件不动」）。
    // fx-7 解锁面（pr-cr-fix S-6）：catch 块保留 SPAWN_ERROR 原始错误消息（append
    // 进 stderrPath）——不触及模型注入链
    expect(
      diff === "" || diff.includes("--session-dir") || diff.includes("[pi-adapter] spawn 同步失败"),
      "pi.ts 的改动只允许 session 参数行（mx3 解锁面）或 fx-7 SPAWN_ERROR 错误保留行；出现其他改动须核对 mx3-acceptance §3",
    ).toBe(true);
    // 模型注入链四级链（resolvePiModel 及其缺省模型）零变更——mx-1 锁定的存续部分
    expect(diff).not.toMatch(/^[-+].*(resolvePiModel|DEFAULT_PI_MODEL)/m);
  });
});
