/**
 * u2 单测：cw evidence submit（dispatch 层完整路径，真实账本 + tmp 目录 + 真实 git 子进程，零 mock）。
 *
 * 用例编号「验收N」逐条对应 docs/rewrite/acceptance/u2-acceptance.md「单测验收」：
 * 本文件覆盖第 2 条（spec 形态）与第 3 条（build 形态）。
 * build 形态用真实 git 仓库 + 真实 commit（git init / rev-parse HEAD），
 * specHash/sha256 断言用 node:crypto 独立重算（不经被测代码的辅助函数）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u2-evidence-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

let caseNo = 0;
let cwd: string;
let ledger: EventLedger;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
  mkdirSync(cwd, { recursive: true });
  ledger = new EventLedger(ledgerPath(cwHome, cwd));
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: readonly string[], workDir?: string): Promise<Captured> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof origOut;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof origErr;
  try {
    const code = await dispatch(args, workDir ?? cwd);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function sha256Of(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** 过 u3 五规则的合法 spec fixture（command 用 node，PATH 必可解析） */
function validSpecJson(): string {
  return JSON.stringify({
    acceptance: [
      { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: "node -v" },
      { id: "A2", core: false, title: "单元行为正确", type: "unit" },
    ],
    contracts: [
      { id: "C1", kind: "api", provider: "u-1", consumer: "u-2", signature: "GET /api/x" },
    ],
    split: [{ unitId: "u-1a", dependsOn: [], files: ["src/a.ts"] }],
  });
}

/** 先经 dispatch 创建 unit（真实前置，非直写账本） */
async function createUnit(unitId: string): Promise<void> {
  const brief = join(cwd, "brief.md");
  writeFileSync(brief, "# 任务书\n");
  const res = await run(["create", "--id", unitId, "--brief", brief]);
  expect(res.code, `前置 create ${unitId} 应成功（stderr: ${res.stderr}）`).toBe(0);
}

function gitRun(dir: string, args: readonly string[]): void {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
}

/** 真实 git 仓库（含一个真实 commit），返回 HEAD 全 hash */
function initRepo(name: string): { repoDir: string; head: string } {
  const repoDir = join(tmpRoot, name);
  mkdirSync(repoDir, { recursive: true });
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-test@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-test"]);
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "init"]);
  const res = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git rev-parse HEAD 失败: ${res.stderr}`);
  }
  return { repoDir, head: (res.stdout ?? "").trim() };
}

// ── 验收2：spec 形态 ─────────────────────────────────────────

describe("验收2：evidence submit --kind spec（dispatch 层）", () => {
  it("合法 spec → SpecSubmitted 入账，specHash 等于 spec.json 原始字节的 sha256，acceptance/contracts/split 原样", async () => {
    await createUnit("u-1");
    const specPath = join(cwd, "spec.json");
    writeFileSync(specPath, validSpecJson());

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "u-1", "--file", specPath]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("u-1");

    const events = ledger.readAll();
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe("SpecSubmitted");
    const expectedHash = createHash("sha256").update(readFileSync(specPath)).digest("hex");
    expect(events[1]?.payload).toEqual({
      unitId: "u-1",
      specHash: expectedHash,
      acceptance: [
        { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: "node -v" },
        { id: "A2", core: false, title: "单元行为正确", type: "unit" },
      ],
      contracts: [{ id: "C1", kind: "api", provider: "u-1", consumer: "u-2", signature: "GET /api/x" }],
      split: [{ unitId: "u-1a", dependsOn: [], files: ["src/a.ts"] }],
    });
  });

  it("schema 类型错（acceptance 缺 id、type 枚举外）→ exit 1，stderr 列出具体字段", async () => {
    await createUnit("u-1");
    const specPath = join(cwd, "spec-bad-schema.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        acceptance: [{ core: true, title: "缺 id 且 type 越界", type: "bogus" }],
        contracts: [],
        split: [],
      }),
    );

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "u-1", "--file", specPath]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("/acceptance/0/id");
    expect(res.stderr).toContain("/acceptance/0/type");
    expect(ledger.readAll()).toHaveLength(1); // 不入账
  });

  it("gate 不过（空 acceptance）→ exit 1、不入账、stderr 含 u3 failures 原文（rule①/rule⑤）", async () => {
    await createUnit("u-1");
    const specPath = join(cwd, "spec-empty.json");
    writeFileSync(specPath, JSON.stringify({ acceptance: [], contracts: [], split: [] }));

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "u-1", "--file", specPath]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("rule①: spec.acceptance 为空（至少需要一条验收用例）");
    expect(res.stderr).toContain("rule⑤: spec 无任何 unit 级用例");
    expect(ledger.readAll()).toHaveLength(1);
  });

  it("gate 不过（core manual）→ exit 1、不入账、stderr 含 rule② 原文", async () => {
    await createUnit("u-1");
    const specPath = join(cwd, "spec-core-manual.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        acceptance: [
          { id: "A1", core: true, title: "手测核心", type: "manual" },
          { id: "A2", core: false, title: "单元", type: "unit" },
        ],
        contracts: [],
        split: [],
      }),
    );

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "u-1", "--file", specPath]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("rule②: A1 (manual) 是核心 case 但 type 非 e2e 级");
    expect(ledger.readAll()).toHaveLength(1);
  });

  it("unit 不存在 → exit 1（校验链第一环），错误含恢复动作", async () => {
    const specPath = join(cwd, "spec.json");
    writeFileSync(specPath, validSpecJson());
    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "no-such", "--file", specPath]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no-such");
    expect(res.stderr).toContain("恢复动作");
    expect(ledger.readAll()).toHaveLength(0);
  });

  it("spec 文件不是合法 JSON / 文件缺失 → exit 1，stderr 含恢复动作", async () => {
    await createUnit("u-1");
    const badJson = join(cwd, "not-json.spec");
    writeFileSync(badJson, "{ not json");
    const res1 = await run(["evidence", "submit", "--kind", "spec", "--unit", "u-1", "--file", badJson]);
    expect(res1.code).toBe(1);
    expect(res1.stderr).toContain("合法 JSON");

    const res2 = await run([
      "evidence",
      "submit",
      "--kind",
      "spec",
      "--unit",
      "u-1",
      "--file",
      join(cwd, "no-such-spec.json"),
    ]);
    expect(res2.code).toBe(1);
    expect(res2.stderr).toContain("不可读");
    expect(res2.stderr).toContain("恢复动作");
  });

  it("--kind 枚举外 → exit 1，列出合法值", async () => {
    await createUnit("u-1");
    const res = await run(["evidence", "submit", "--kind", "report", "--unit", "u-1"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("spec | build");
  });
});

// ── 验收3：build 形态 ────────────────────────────────────────

describe("验收3：evidence submit --kind build（dispatch 层，真实 git 仓库）", () => {
  it("commit 不存在 → exit 1，stderr 含恢复动作；账本不变", async () => {
    const { repoDir } = initRepo("repo-missing-commit");
    const brief = join(repoDir, "brief.md");
    writeFileSync(brief, "# 任务书\n");
    await run(["create", "--id", "u-1", "--brief", brief], repoDir);
    const repoLedger = new EventLedger(ledgerPath(cwHome, repoDir));

    // 格式合法但仓库中不存在的对象 hash（40 位十六进制）
    const fake = "0123456789abcdef0123456789abcdef01234567";
    const res = await run(
      ["evidence", "submit", "--kind", "build", "--unit", "u-1", "--commit", fake, "--run-id", "run-1"],
      repoDir,
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("不存在");
    expect(res.stderr).toContain("恢复动作");
    expect(repoLedger.readAll()).toHaveLength(1);
  });

  it("commit hash 格式非法（非十六进制）→ exit 1（进命令行前的白名单校验）", async () => {
    const { repoDir } = initRepo("repo-bad-hash");
    const brief = join(repoDir, "brief.md");
    writeFileSync(brief, "# 任务书\n");
    await run(["create", "--id", "u-1", "--brief", brief], repoDir);

    const res = await run(
      ["evidence", "submit", "--kind", "build", "--unit", "u-1", "--commit", "ZZZ123", "--run-id", "run-1"],
      repoDir,
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("^[0-9a-f]{6,40}$");
  });

  it("产物文件缺失 → exit 1，stderr 含恢复动作", async () => {
    const { repoDir, head } = initRepo("repo-missing-file");
    const brief = join(repoDir, "brief.md");
    writeFileSync(brief, "# 任务书\n");
    await run(["create", "--id", "u-1", "--brief", brief], repoDir);

    const res = await run(
      [
        "evidence",
        "submit",
        "--kind",
        "build",
        "--unit",
        "u-1",
        "--commit",
        head,
        "--run-id",
        "run-1",
        "--file",
        join(repoDir, "no-such-artifact.json"),
      ],
      repoDir,
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("不可读");
    expect(res.stderr).toContain("恢复动作");
  });

  it("合法 → EvidenceSubmitted 入账，sha256 与实际文件一致，exitCode 0", async () => {
    const { repoDir, head } = initRepo("repo-ok");
    const brief = join(repoDir, "brief.md");
    writeFileSync(brief, "# 任务书\n");
    await run(["create", "--id", "u-1", "--brief", brief], repoDir);
    const art1 = join(repoDir, "art1.json");
    const art2 = join(repoDir, "art2.json");
    writeFileSync(art1, '{"a":1}');
    writeFileSync(art2, '{"b":2}');

    const res = await run(
      [
        "evidence",
        "submit",
        "--kind",
        "build",
        "--unit",
        "u-1",
        "--commit",
        head,
        "--run-id",
        "run-1",
        "--file",
        art1,
        "--file",
        art2,
      ],
      repoDir,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("u-1");
    expect(res.stdout).toContain("run-1");
    expect(res.stdout).toContain("2");

    const repoLedger = new EventLedger(ledgerPath(cwHome, repoDir));
    const events = repoLedger.readAll();
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe("EvidenceSubmitted");
    expect(events[1]?.payload).toEqual({
      unitId: "u-1",
      runId: "run-1",
      commit: head,
      paths: [art1, art2],
      sha256: [sha256Of(art1), sha256Of(art2)],
      exitCode: 0,
    });
  });

  it("同 runId 二次提交被账本层拒（错误透传），账本不变", async () => {
    const { repoDir, head } = initRepo("repo-idem");
    const brief = join(repoDir, "brief.md");
    writeFileSync(brief, "# 任务书\n");
    await run(["create", "--id", "u-1", "--brief", brief], repoDir);

    const args = [
      "evidence",
      "submit",
      "--kind",
      "build",
      "--unit",
      "u-1",
      "--commit",
      head,
      "--run-id",
      "run-1",
    ] as const;
    expect((await run([...args], repoDir)).code).toBe(0);
    const res = await run([...args], repoDir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("run-1");
    expect(res.stderr).toContain("幂等");
    expect(res.stderr).toContain("恢复动作");

    const repoLedger = new EventLedger(ledgerPath(cwHome, repoDir));
    expect(repoLedger.readAll()).toHaveLength(2);
  });
});
