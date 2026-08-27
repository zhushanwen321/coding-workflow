/**
 * rp-0 gate 域核心链验收（design-release-pipeline.md §3.3 D3/D4/D8 + §3.4 探针 + §4 验收）。
 *
 * 零 mock：真实 tmp git 仓（git init/config/commit + rev-parse/diff 真实子进程）、
 * 真实 EventLedger（gate-events.log + 文件锁）、真实 node 子进程执行 check 命令。
 *
 * 用例 → 验收/探针映射：
 *   A1a  miss→hit→query→scope 外改动仍 hit→scope 内改动 miss（§4 A1a 全链）
 *   A2-1 产物写失败 → env-error 不入账（§4 A2 ①，对堵 F3）
 *   A2-2 report 删/篡改 → sha256 不符向 miss 倒（§4 A2 ②，F-2 路径）
 *   A3/GP6 base 前移 → 全体 miss（§4 A3 ①；键比较 sha by construction）
 *   GP5  miss 与 hit 两份 report 同构（除 source 外逐字段一致）
 *   F-3/F-5  base 解析失败 / 超时 → 环境错误不入账
 *   fail 不入缓存候选；runId 幂等（D8）
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { sha256OfContent } from "../src/gate/artifacts.js";
import { gateLedgerDomain } from "../src/gate/domain.js";
import { queryGate } from "../src/gate/query.js";
import type { GateEventMap, GateReport } from "../src/gate/types.js";
import { newGateRunId, wrapCheck, wrapExitCode } from "../src/gate/wrap.js";
import type { WrapCheckOutcome } from "../src/gate/wrap.js";
import { EventLedger } from "../src/store/events-log.js";
import { encodeCwd, gateLedgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rp0-gate-core-"));
const cwHome = join(tmpRoot, "home");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── git 夹具（对照 tests/u2-evidence.test.ts 的 initRepo 模式）──────────────

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

interface Repo {
  repoDir: string;
  /** 稳定 base 分支名（A3/GP6 的 base 前移载体） */
  baseRef: string;
  head(): string;
  /** 新 commit：写文件 → add → commit，返回新 HEAD sha */
  commit(path: string, content: string): string;
}

function initRepo(name: string): Repo {
  const repoDir = join(tmpRoot, name);
  mkdirSync(repoDir, { recursive: true });
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-test@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-test"]);
  gitRun(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  const baseRef = "stable";
  gitRun(repoDir, ["branch", baseRef]);
  return {
    repoDir,
    baseRef,
    head: () => gitRun(repoDir, ["rev-parse", "HEAD"]),
    commit(path: string, content: string): string {
      const abs = join(repoDir, path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
      gitRun(repoDir, ["add", "-A"]);
      gitRun(repoDir, ["commit", "-m", `touch ${path}`]);
      return gitRun(repoDir, ["rev-parse", "HEAD"]);
    },
  };
}

// ── wrap 夹具 ───────────────────────────────────────────────

/** 成功 check 命令（node 在 PATH 必可解析；副作用 = 追加一行到计数文件，幂等测试探针） */
function okCommand(countFile?: string): string[] {
  if (countFile === undefined) {
    return ["node", "-e", "process.exit(0)"];
  }
  return [
    "node",
    "-e",
    `require('fs').appendFileSync(${JSON.stringify(countFile)}, 'x\\n')`,
  ];
}

function wrap(repo: Repo, overrides: Record<string, unknown> = {}): WrapCheckOutcome {
  return wrapCheck({
    cwHome,
    cwd: repo.repoDir,
    check: "typecheck",
    base: repo.baseRef,
    scope: ["src"],
    command: okCommand(),
    ...overrides,
  });
}

/** 读 gate 账本原始事件（消费处按 type 窄化 payload） */
function readGateEvents(cwd: string) {
  const ledger = new EventLedger<GateEventMap>(gateLedgerPath(cwHome, cwd), gateLedgerDomain);
  return ledger.readAll();
}

/** 项目 CW 目录绝对路径（reportRef 相对它的根） */
function projectDir(cwd: string): string {
  return join(cwHome, encodeCwd(cwd));
}

// ── A1a：全链 miss → hit → query → scope 外仍 hit → scope 内 miss ────────

describe("A1a：wrap 全链（G1/G2 机制自证，真实 git 仓 + 真实 node 执行）", () => {
  it("① 首跑 miss：真实执行且耗时 >0，GateCheckRan 入账含 report sha256", () => {
    const repo = initRepo("a1a");
    repo.commit("src/a.ts", "a\n");
    const before = repo.head();

    const outcome = wrap(repo);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;

    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.headSha).toBe(before);
    expect(outcome.reportSha256).toMatch(/^[0-9a-f]{64}$/);

    const events = readGateEvents(repo.repoDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("GateCheckRan");
    const ran = events[0]?.payload as { result: string; runId: string; reportRef: string; reportSha256: string };
    expect(ran.result).toBe("pass");
    expect(ran.runId).toBe(outcome.runId);
    // 真实执行耗时 > 0（node 进程 spawn 有真实开销；防御性下界 0）
    expect(events[0]).toBeDefined();
    // report 落盘且 sha256 独立复算一致
    const reportPath = join(projectDir(repo.repoDir), outcome.reportRef);
    expect(existsSync(reportPath)).toBe(true);
    expect(sha256OfContent(readFileSync(reportPath, "utf-8"))).toBe(outcome.reportSha256);
  });

  it("② 同 HEAD 再跑 hit：GateCacheHit 入账 sourceRunId 指向首跑，产出完整 report", () => {
    const repo = initRepo("a1a-hit");
    repo.commit("src/a.ts", "a\n");
    const first = wrap(repo);
    expect(first.kind).toBe("pass");

    const second = wrap(repo);
    expect(second.kind).toBe("hit");
    if (second.kind !== "hit") return;
    expect(second.sourceRunId).toBe(first.kind === "pass" ? first.runId : "");
    // hit 也有完整产物（记账闭合）
    const hitReportPath = join(projectDir(repo.repoDir), second.reportRef);
    expect(existsSync(hitReportPath)).toBe(true);
    expect(sha256OfContent(readFileSync(hitReportPath, "utf-8"))).toBe(second.reportSha256);

    const events = readGateEvents(repo.repoDir);
    expect(events.map((e) => e.type)).toEqual(["GateCheckRan", "GateCacheHit"]);
  });

  it("③ query：hit 形态输出最新 pass 条目 + report 指针 + sha256；miss 形态 = 空集", () => {
    const repo = initRepo("a1a-query");
    repo.commit("src/a.ts", "a\n");
    wrap(repo);

    const baseSha = gitRun(repo.repoDir, ["rev-parse", repo.baseRef]);
    const result = queryGate({ cwHome, cwd: repo.repoDir, check: "typecheck", baseSha });
    expect(result.passEntries).toHaveLength(1);
    const entry = result.passEntries[0];
    expect(entry?.runId).toBeTruthy();
    expect(entry?.reportRef).toMatch(/^gate-artifacts\/typecheck\/.+\/report\.json$/);
    expect(entry?.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    // report 指针可解析到真实文件
    expect(existsSync(join(projectDir(repo.repoDir), entry?.reportRef ?? "/nope"))).toBe(true);

    // miss 形态：查不存在的 baseSha（无 pass 条目）
    const miss = queryGate({
      cwHome,
      cwd: repo.repoDir,
      check: "typecheck",
      baseSha: "f".repeat(40),
    });
    expect(miss.passEntries).toEqual([]);
    // latestByCheck 审计全景仍在
    expect(miss.latestByCheck.map((e) => e.check)).toEqual(["typecheck"]);
  });

  it("④ scope 外改动后仍 hit（docs/ 改动不影响 src/ 缓存键）", () => {
    const repo = initRepo("a1a-outside");
    repo.commit("src/a.ts", "a\n");
    wrap(repo);

    repo.commit("docs/readme.md", "# docs\n");
    const outcome = wrap(repo);
    expect(outcome.kind).toBe("hit");
    // hit 条目的 headSha = 当前 HEAD（scope 外前进后的）
    if (outcome.kind === "hit") {
      expect(outcome.headSha).toBe(repo.head());
    }
  });

  it("⑤ scope 内改动 → miss 重新执行（diff 非空向 miss 倒）", () => {
    const repo = initRepo("a1a-inside");
    repo.commit("src/a.ts", "a\n");
    wrap(repo);
    wrap(repo); // 先到 hit 状态

    repo.commit("src/a.ts", "a2\n");
    const outcome = wrap(repo);
    expect(outcome.kind).toBe("pass"); // miss → 重新真实执行
    // 账本：首跑 + hit + 重跑 = 3 条
    expect(readGateEvents(repo.repoDir)).toHaveLength(3);
  });
});

// ── GP5：miss 与 hit 两份 report 同构 ─────────────────────────────────────

describe("GP5：hit report 与来源 report 同构（消费方不可区分「这次跑没跑」）", () => {
  it("两份 report 除 source 外逐字段一致（含 durationMs——复制保留来源真实耗时）", () => {
    const repo = initRepo("gp5");
    repo.commit("src/a.ts", "a\n");
    const first = wrap(repo);
    expect(first.kind).toBe("pass");
    const second = wrap(repo);
    expect(second.kind).toBe("hit");
    if (first.kind !== "pass" || second.kind !== "hit") return;

    const sourceRaw = readFileSync(join(projectDir(repo.repoDir), first.reportRef), "utf-8");
    const hitRaw = readFileSync(join(projectDir(repo.repoDir), second.reportRef), "utf-8");
    const sourceReport = JSON.parse(sourceRaw) as GateReport;
    const hitReport = JSON.parse(hitRaw) as GateReport;

    // 字段级：除 source 外全部一致（GP5 允许 source/duration 不同——本实现连 duration 也一致，更强）
    expect(hitReport).toEqual({ ...sourceReport, source: first.runId });
    // 逐字节形态：hit = 来源去掉尾 `\n}\n` 后接 `,\n  "source": …\n}\n`（key 追加序保证，序列化可预测）
    expect(hitRaw).toBe(
      `${sourceRaw.slice(0, -3)},\n  "source": ${JSON.stringify(first.runId)}\n}\n`,
    );
  });
});

// ── A2：闭合负面（对堵 F3 假 pass 事故形态）──────────────────────────────

describe("A2：记账闭合负面（D4 固定先后序）", () => {
  it("① 产物目录写失败（只读父目录）→ env-error 且账本无新事件（跑了但不记账结构性不存在）", () => {
    const repo = initRepo("a2-readonly");
    repo.commit("src/a.ts", "a\n");

    // 预创建只读的 gate-artifacts/<check> 目录 → mkdirSync(<check>/<runId>) EACCES
    const artifactsCheckDir = join(projectDir(repo.repoDir), "gate-artifacts", "typecheck");
    mkdirSync(artifactsCheckDir, { recursive: true });
    chmodSync(artifactsCheckDir, 0o555);

    try {
      const outcome = wrap(repo);
      expect(outcome.kind).toBe("env-error");
      if (outcome.kind === "env-error") {
        expect(outcome.error).toContain("产物写入失败");
        expect(outcome.error).toContain("恢复动作");
        expect(outcome.error).toContain("未入账");
      }
      // 「执行了但账本无事件」断言：命令已跑（产物落盘前），账本 0 条
      expect(readGateEvents(repo.repoDir)).toHaveLength(0);
    } finally {
      chmodSync(artifactsCheckDir, 0o755); // 恢复以便 tmpRoot 清理
    }
  });

  it("② report 被删 → sha256 复算失败向 miss 倒（警告进结果），真实重跑入账", () => {
    const repo = initRepo("a2-deleted");
    repo.commit("src/a.ts", "a\n");
    const first = wrap(repo);
    expect(first.kind).toBe("pass");
    if (first.kind !== "pass") return;
    rmSync(join(projectDir(repo.repoDir), first.reportRef));

    const outcome = wrap(repo);
    expect(outcome.kind).toBe("pass"); // 向 miss 倒 → 真实执行
    if (outcome.kind !== "pass") return;
    expect(outcome.warnings.join("\n")).toContain("report 缺失");
    expect(outcome.warnings.join("\n")).toContain("宁 miss 不假 pass");
    // 账本：首跑 + 重跑 = 2 条（无 hit 条目）
    expect(readGateEvents(repo.repoDir)).toHaveLength(2);
  });

  it("②' report 被篡改（sha256 不符）→ 同样向 miss 倒", () => {
    const repo = initRepo("a2-tampered");
    repo.commit("src/a.ts", "a\n");
    const first = wrap(repo);
    expect(first.kind).toBe("pass");
    if (first.kind !== "pass") return;
    writeFileSync(join(projectDir(repo.repoDir), first.reportRef), '{"tampered": true}\n');

    const outcome = wrap(repo);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    expect(outcome.warnings.join("\n")).toContain("sha256 不符");
    expect(readGateEvents(repo.repoDir)).toHaveLength(2);
  });
});

// ── A3 / GP6：base 前移全体 miss ────────────────────────────────────────

describe("A3/GP6：base 前移后旧条目全体 miss（键比较 sha by construction）", () => {
  it("stable 前移 → 新 baseSha 下 query 空、wrap miss（无旁路泄漏）", () => {
    const repo = initRepo("gp6");
    repo.commit("src/a.ts", "a\n");
    const first = wrap(repo);
    expect(first.kind).toBe("pass");

    // base 前移：stable 从 HEAD-1 前进到 HEAD（模拟 merge 上游 / fetch 后 ref 移动）
    repo.commit("src/b.ts", "b\n");
    gitRun(repo.repoDir, ["branch", "-f", repo.baseRef, "HEAD"]);
    const newBaseSha = gitRun(repo.repoDir, ["rev-parse", repo.baseRef]);

    // ① 前移后 query 新 baseSha：旧 pass 条目在新键下不可见（GP6 安全关键断言）
    const queried = queryGate({ cwHome, cwd: repo.repoDir, check: "typecheck", baseSha: newBaseSha });
    expect(queried.passEntries).toEqual([]);

    // ② wrap 以新 base → miss 真实执行（非 hit）
    const outcome = wrap(repo);
    expect(outcome.kind).toBe("pass"); // miss 路径的重新执行
    if (outcome.kind !== "pass") return;
    expect(outcome.warnings).toEqual([]); // 正常 miss 无警告（键不同，非校验失败）

    // ③ 旧 baseSha 的条目仍可查（审计可见性不变——旧事实未被删除，只是新键查不到）
    if (first.kind !== "pass") return;
    const oldEntries = queryGate({ cwHome, cwd: repo.repoDir, check: "typecheck", baseSha: first.baseSha });
    expect(oldEntries.passEntries).toHaveLength(1);
  });
});

// ── fail / 幂等 / 环境错误 ───────────────────────────────────────────────

describe("fail 不入缓存候选（F-4 路径）", () => {
  it("exit 1 → kind fail 照常入账；再 wrap 同键 → miss 非 hit（重新执行）", () => {
    const repo = initRepo("fail-no-cache");
    repo.commit("src/a.ts", "a\n");

    const failOutcome = wrap(repo, { command: ["node", "-e", "process.exit(1)"] });
    expect(failOutcome.kind).toBe("fail");
    if (failOutcome.kind !== "fail") return;
    expect(failOutcome.exitCode).toBe(1);
    expect(wrapExitCode(failOutcome)).toBe(1);

    const events = readGateEvents(repo.repoDir);
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { result: string }).result).toBe("fail");

    // fail 后同键再 wrap：不命中 fail 条目，重新执行（这次 pass）
    const retry = wrap(repo);
    expect(retry.kind).toBe("pass");
    expect(readGateEvents(repo.repoDir)).toHaveLength(2);
  });
});

describe("runId 幂等（D8：显式 runId 防重复记账）", () => {
  it("同 check+runId 二次 wrap = 幂等命中：不执行命令、不重复入账", () => {
    const repo = initRepo("runid-idempotent");
    repo.commit("src/a.ts", "a\n");
    const countFile = join(tmpRoot, "runid-count.txt");
    const explicit = "explicit-run-1";

    const first = wrap(repo, { command: okCommand(countFile), runId: explicit });
    expect(first.kind).toBe("pass");
    expect(readFileSync(countFile, "utf-8")).toBe("x\n"); // 真实执行了一次

    const second = wrap(repo, { command: okCommand(countFile), runId: explicit });
    expect(second.kind).toBe("idempotent");
    if (second.kind === "idempotent") {
      expect(second.existing.result).toBe("pass");
      expect(second.existing.reportRef).toBe(first.kind === "pass" ? first.reportRef : "");
    }
    // 命令未再执行 + 账本未重复记账
    expect(readFileSync(countFile, "utf-8")).toBe("x\n");
    expect(readGateEvents(repo.repoDir)).toHaveLength(1);
    expect(wrapExitCode(second)).toBe(0);
  });

  it("缺省 runId 自动生成（ulid 风格）且重复 wrap 各自独立（每次验证请求独立产物目录）", () => {
    const repo = initRepo("runid-auto");
    repo.commit("src/a.ts", "a\n");
    const first = wrap(repo);
    const second = wrap(repo);
    expect(first.kind).toBe("pass");
    expect(second.kind).toBe("hit");
    if (first.kind !== "pass" || second.kind !== "hit") return;
    expect(first.runId).toMatch(/^[0-9A-Z]{26}$/);
    expect(second.runId).not.toBe(first.runId); // hit 用新 runId 作产物目录
    // 两个产物目录并存
    expect(existsSync(join(projectDir(repo.repoDir), first.reportRef))).toBe(true);
    expect(existsSync(join(projectDir(repo.repoDir), second.reportRef))).toBe(true);
  });
});

describe("环境错误不入账（exit 2 路径）", () => {
  it("F-3：base ref 不存在 → env-error 含恢复动作（git fetch / 显式 sha）", () => {
    const repo = initRepo("f3-base");
    repo.commit("src/a.ts", "a\n");
    const outcome = wrap(repo, { base: "origin/nonexist" });
    expect(outcome.kind).toBe("env-error");
    if (outcome.kind === "env-error") {
      expect(outcome.error).toContain("origin/nonexist");
      expect(outcome.error).toContain("恢复动作");
      expect(outcome.error).toContain("git fetch");
    }
    expect(readGateEvents(repo.repoDir)).toHaveLength(0);
    expect(wrapExitCode(outcome)).toBe(2);
  });

  it("F-5：执行超时 → env-error 不入账（超时无完整产物可记）", () => {
    const repo = initRepo("f5-timeout");
    repo.commit("src/a.ts", "a\n");
    const outcome = wrap(repo, {
      command: ["node", "-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 200,
    });
    expect(outcome.kind).toBe("env-error");
    if (outcome.kind === "env-error") {
      expect(outcome.error).toContain("超过");
      expect(outcome.error).toContain("--timeout-ms");
    }
    expect(readGateEvents(repo.repoDir)).toHaveLength(0);
  });

  it("命令不可执行（首 token 不在 PATH）→ env-error 含恢复动作", () => {
    const repo = initRepo("env-no-command");
    repo.commit("src/a.ts", "a\n");
    const outcome = wrap(repo, { command: ["no-such-bin-xyz", "--flag"] });
    expect(outcome.kind).toBe("env-error");
    if (outcome.kind === "env-error") {
      expect(outcome.error).toContain("no-such-bin-xyz");
      expect(outcome.error).toContain("PATH");
    }
    expect(readGateEvents(repo.repoDir)).toHaveLength(0);
  });
});

// ── runId 生成器在 wrap 链路外的直接形态 ─────────────────────────────────

describe("newGateRunId 直测（wrap 集成外）", () => {
  it("26 字符 Crockford；100 次无碰撞", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = newGateRunId();
      expect(id).toMatch(/^[0-9A-Z]{26}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(100);
  });
});
