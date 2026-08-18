/**
 * u8 单测：内部节点集成验证 runIntegrationVerify
 * （docs/rewrite/acceptance/u8-acceptance.md「单测验收」第 2 组，4 条）。
 *
 * 直调 src（dispatch 无关的库函数层）：真实 git 子进程 + 真实账本（子验收从账本
 * 读取是规格的一部分）+ tmp 目录 + 隔离 CW_HOME，零 mock。验收命令用 e2e-sh
 * 标记行语义（`echo "Axx PASS|FAIL"`），适配器路由与 nameMatch 判定走真实链路。
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
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { evidenceDir } from "../dist/store/project.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { ledgerForCwd } from "../src/handlers/common.js";
import { type IntegrateResult, runIntegrationVerify } from "../src/runner/integrate.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u8-int-"));
const cwHome = join(tmpRoot, "cw-home");
process.env.CW_HOME = cwHome;
// wt-4 迁移：runIntegrationVerify 步骤 0 会建 root worktree，隔离 worktree 根
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.CW_HOME;
  delete process.env.CW_WORKTREE_HOME;
});

function git(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实 tmp git 仓库；commitsFiles 逐次提交，返回各 commit hash（按提交序） */
function makeRepo(name: string, commitsFiles: ReadonlyArray<Record<string, string>>): { repoDir: string; hashes: string[] } {
  const repoDir = join(tmpRoot, name);
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.email", "cw-u8@example.com"]);
  git(repoDir, ["config", "user.name", "cw-u8"]);
  const hashes: string[] = [];
  commitsFiles.forEach((files, i) => {
    for (const [name_, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repoDir, name_)), { recursive: true });
      writeFileSync(join(repoDir, name_), content);
    }
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", `commit-${i + 1}`]);
    hashes.push(git(repoDir, ["rev-parse", "HEAD"]));
  });
  return { repoDir, hashes };
}

const CAP_SIG = "export function capitalize(";

const PASS_LEAF_ACCEPTANCE: AcceptanceItem[] = [
  { id: "AA1", core: true, title: "leaf 冒烟", type: "e2e-real", command: 'echo "AA1 PASS"' },
];
const ROOT_ACCEPTANCE: AcceptanceItem[] = [
  { id: "AR1", core: true, title: "root 集成冒烟", type: "e2e-real", command: 'echo "AR1 PASS"' },
];

interface ReportShape {
  kind: string;
  rootId: string;
  runId: string;
  head: string;
  children: Array<{ unitId: string; commit: string; reachable: boolean }>;
  mergeFailures: string[];
  acceptanceBatches: Array<{
    unitId: string;
    results: Array<{ id: string; status: string; reason?: string }>;
  }>;
  contracts: { ok: boolean; failures: string[] };
  ok: boolean;
  failures: string[];
}

function readReport(result: IntegrateResult): ReportShape {
  return JSON.parse(readFileSync(result.reportPath, "utf-8")) as ReportShape;
}

/** 预置账本：leaf unit（UnitCreated + 冻结 spec 的验收即子验收来源） */
function seedLeafSpec(repoDir: string, acceptance: AcceptanceItem[]): void {
  const ledger = ledgerForCwd(repoDir);
  ledger.append("UnitCreated", { unitId: "leaf", parentId: "root", briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId: "leaf",
    specHash: "hash-fixture",
    acceptance,
    contracts: [],
    split: [],
  });
}

/**
 * rv-4 语义迁移：契约输入结构改带 owner（OwnedContract[]）。本文件的契约
 * provider="leaf" 与 owner 同值（self-provider 形态）→ 配对第一道跳过，树内
 * 验证语义与迁移前一致；配对道的行为由 tests/rv4-contract-pairing.test.ts 与
 * tests/rv4-integration-disposal.test.ts 覆盖。
 */
async function integrate(
  repoDir: string,
  opts: Partial<Parameters<typeof runIntegrationVerify>[0]> = {},
): Promise<IntegrateResult> {
  return runIntegrationVerify({
    cwd: repoDir,
    rootId: "root",
    children: [{ unitId: "leaf", commit: git(repoDir, ["rev-parse", "HEAD"]) }],
    rootAcceptance: ROOT_ACCEPTANCE,
    contracts: [
      {
        contract: {
          id: "C1",
          kind: "function",
          provider: "leaf",
          consumer: "root",
          signature: CAP_SIG,
          file: "src/capitalize.js",
        },
        ownerUnitId: "leaf",
      },
    ],
    timeoutMs: 15_000,
    ...opts,
  });
}

// ── 验收1：commit 不可达 → failure 附恢复动作 ─────────────────

describe("验收1：子 build commit 在 HEAD 不可达 → failure 附恢复动作", () => {
  it("bogus commit → ok=false，failure 含 unitId、commit 与 merge 恢复动作，报告 reachable=false", async () => {
    const { repoDir } = makeRepo("unreachable", [{ "src/capitalize.js": `${CAP_SIG}s) { return s; }\n` }]);
    seedLeafSpec(repoDir, PASS_LEAF_ACCEPTANCE);
    const bogus = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    const result = await integrate(repoDir, { children: [{ unitId: "leaf", commit: bogus }] });

    expect(result.ok).toBe(false);
    const joined = result.failures.join("\n");
    expect(joined).toContain("不可达");
    expect(joined).toContain("leaf");
    expect(joined).toContain(bogus);
    expect(joined).toContain("恢复动作");
    const report = readReport(result);
    expect(report.children[0]).toMatchObject({ unitId: "leaf", commit: bogus, reachable: false });
  }, 30_000);
});

// ── 验收2：全绿 → ok=true + 报告落盘（JSON 结构断言） ──────────

describe("验收2：全部可达 + 验收全绿 + 契约全中 → ok=true + 报告落盘", () => {
  it("报告 JSON 结构完整：children/acceptanceBatches/contracts/ok；逐验收产物落盘", async () => {
    const { repoDir, hashes } = makeRepo("all-green", [
      { "src/capitalize.js": `// util\n${CAP_SIG}s) {\n  return s.toUpperCase();\n}\n` },
    ]);
    seedLeafSpec(repoDir, PASS_LEAF_ACCEPTANCE);
    const head = hashes[hashes.length - 1] ?? "";

    const result = await integrate(repoDir, { children: [{ unitId: "leaf", commit: head }] });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);

    // 报告路径 = evidence/<rootId>/integrate-<runId>/integrate-report.json（产物布局锁定）
    expect(result.runId).toMatch(/^integrate-/);
    const expectedDir = evidenceDir(cwHome, repoDir, "root", result.runId);
    expect(result.reportPath).toBe(join(expectedDir, "integrate-report.json"));
    expect(existsSync(expectedDir)).toBe(true);

    const report = readReport(result);
    expect(report.kind).toBe("integrate");
    expect(report.rootId).toBe("root");
    expect(report.runId).toBe(result.runId);
    expect(report.head).toBe(head);
    expect(report.children).toEqual([{ unitId: "leaf", commit: head, reachable: true }]);
    // rv-4：报告结构化的 mergeFailures 节（本场景无 merge 失败 → 空清单）
    expect(report.mergeFailures).toEqual([]);
    expect(report.acceptanceBatches).toEqual([
      { unitId: "leaf", results: [{ id: "AA1", status: "pass" }] },
      { unitId: "root", results: [{ id: "AR1", status: "pass" }] },
    ]);
    expect(report.contracts).toEqual({ ok: true, failures: [] });
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);

    // 逐验收产物：子/root 各自子目录内有 stdout 与批次 report.json
    expect(existsSync(join(expectedDir, "leaf", "AA1.stdout"))).toBe(true);
    expect(existsSync(join(expectedDir, "leaf", "report.json"))).toBe(true);
    expect(existsSync(join(expectedDir, "root", "AR1.stdout"))).toBe(true);
  }, 30_000);
});

// ── 验收3：任一子验收红 → ok=false 且报告指明红项 ──────────────

describe("验收3：子验收红 → ok=false 且报告指明红项", () => {
  it("AA1 输出 FAIL 标记 → failures 指明验收 id 与 unit，报告该条 status=fail", async () => {
    const { repoDir } = makeRepo("red-acceptance", [{ "src/capitalize.js": `${CAP_SIG}s) { return s; }\n` }]);
    seedLeafSpec(repoDir, [
      { id: "AA1", core: true, title: "leaf 冒烟", type: "e2e-real", command: 'echo "AA1 FAIL"; exit 1' },
    ]);

    const result = await integrate(repoDir);

    expect(result.ok).toBe(false);
    const joined = result.failures.join("\n");
    expect(joined).toContain("AA1");
    expect(joined).toContain("leaf");
    const report = readReport(result);
    const leafBatch = report.acceptanceBatches.find((b) => b.unitId === "leaf");
    expect(leafBatch?.results).toEqual([
      { id: "AA1", status: "fail", reason: expect.stringContaining("执行失败") },
    ]);
    // 红项只红子批次：root 自身验收照常判定（报告不含 root 红项）
    const rootBatch = report.acceptanceBatches.find((b) => b.unitId === "root");
    expect(rootBatch?.results).toEqual([{ id: "AR1", status: "pass" }]);
  }, 30_000);
});

// ── 验收4：契约漂移（signature 改一字）→ ok=false 指明契约 id ──

describe("验收4：契约漂移 → ok=false 指明契约 id", () => {
  it("signature 改一字（capitalize → capitalise）→ 契约比对失败，报告 contracts.failures 含 C1", async () => {
    const { repoDir } = makeRepo("drift", [{ "src/capitalize.js": `${CAP_SIG}s) { return s; }\n` }]);
    seedLeafSpec(repoDir, PASS_LEAF_ACCEPTANCE);

    const result = await integrate(repoDir, {
      contracts: [
        {
          contract: {
            id: "C1",
            kind: "function",
            provider: "leaf",
            consumer: "root",
            signature: "export function capitalise(",
            file: "src/capitalize.js",
          },
          ownerUnitId: "leaf",
        },
      ],
    });

    expect(result.ok).toBe(false);
    const joined = result.failures.join("\n");
    expect(joined).toContain("C1");
    expect(joined).toContain("src/capitalize.js");
    const report = readReport(result);
    expect(report.contracts.ok).toBe(false);
    expect(report.contracts.failures[0]).toContain("C1");
    // 漂移只挂契约：验收批次本身全绿（红项定位精确，不误伤）
    expect(report.acceptanceBatches.every((b) => b.results.every((r) => r.status === "pass"))).toBe(true);
  }, 30_000);
});
