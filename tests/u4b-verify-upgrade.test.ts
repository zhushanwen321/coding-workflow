/**
 * u4b 单测：verify 判定升级（u4b 验收文档「单测验收」2/3/4，dispatch 层完整路径，
 * 真实 git 子进程 + tmp 目录 + 隔离 CW_HOME，零 mock）。
 *
 * 覆盖三条升级语义：
 *   - 验收2 e2e-sh 型：标记行 PASS → pass；FAIL → fail（reason=执行失败）；
 *     无标记 + exit 0（echo ok）→ e2e-sh parse 抛错 → 该条 fail（假命令防线）；
 *   - 验收3 vitest 型：tmp git 仓库提交真实测试文件，验收 command 指向本仓库
 *     vitest bin 的绝对路径（干净 checkout 无 node_modules，npx 不可解析——
 *     绝对路径方案已探针验证）。一次 verify 两条验收：测试名含 A1 → pass，
 *     不含 A2 → fail（未出现在产物）；
 *   - 规格「unit command 须 vitest 兼容」：echo 非 JSON → parse 抛错 → fail +
 *     错误信息含恢复方向；验收4 manual / VerifyRan.acceptanceIds 语义不变。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 干净 checkout 无 node_modules，vitest 以绝对路径启动（bin 是 sh wrapper，bash 可直接执行） */
const VITEST_BIN = join(REPO_ROOT, "node_modules", ".bin", "vitest");

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u4b-upgrade-"));
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

function git(dir: string, args: readonly string[]): void {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
}

/** 真实 tmp git 仓库：init + 每次提交写入一批根目录文件；返回各 commit hash（按提交序） */
function makeGitRepo(dir: string, commitsFiles: ReadonlyArray<Record<string, string>>): string[] {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "cw-test@example.com"]);
  git(dir, ["config", "user.name", "cw-test"]);
  const hashes: string[] = [];
  commitsFiles.forEach((files, i) => {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", `commit-${i + 1}`]);
    hashes.push(
      (spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim(),
    );
  });
  return hashes;
}

function ac(
  id: string,
  type: AcceptanceItem["type"],
  extra: Partial<AcceptanceItem> = {},
): AcceptanceItem {
  return { id, core: false, title: `标题-${id}`, type, ...extra };
}

let caseNo = 0;
let cwd: string;
let ledger: EventLedger;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
  ledger = new EventLedger(ledgerPath(cwHome, cwd));
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: readonly string[]): Promise<Captured> {
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
    const code = await dispatch(args, cwd);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** 建 git 仓库 + 入账 UnitCreated / SpecSubmitted / EvidenceSubmitted（commit = HEAD） */
function makeVerifyFixture(acceptance: AcceptanceItem[]): string {
  const [head] = makeGitRepo(cwd, [{ "seed.txt": "seed" }]);
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId: "u-1",
    specHash: "0".repeat(64),
    acceptance,
    contracts: [],
    split: [],
  });
  ledger.append("EvidenceSubmitted", {
    unitId: "u-1",
    runId: "run-1",
    commit: head,
    paths: [],
    sha256: [],
    exitCode: 0,
  });
  return head;
}

interface VerifyRanFact {
  runId: string;
  result: string;
  acceptanceIds: string[];
}

function verifyRans(): VerifyRanFact[] {
  return ledger
    .readAll()
    .filter((e) => e.type === "VerifyRan")
    .map((e) => {
      const p = e.payload as VerifyRanFact;
      return { runId: p.runId, result: p.result, acceptanceIds: p.acceptanceIds };
    });
}

function evidenceBaseOf(runId: string): string {
  return evidenceDir(cwHome, cwd, "u-1", runId);
}

describe("验收2：e2e-sh 型验收的名字级判定（dispatch 层）", () => {
  it("脚本输出 A1 PASS → pass；A2 FAIL → fail 且 stderr reason 含「执行失败」", async () => {
    makeVerifyFixture([
      ac("A1", "e2e-real", { core: true, command: `node -e "console.log('A1 PASS')"` }),
      ac("A2", "e2e-real", { core: true, command: `node -e "console.log('A2 FAIL'); process.exit(1)"` }),
      ac("M1", "manual"),
    ]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("A1 pass");
    expect(res.stdout).toContain("A2 fail");
    expect(res.stdout).toContain("M1 manual");
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("执行失败");
    expect(res.stderr).not.toContain("A1:");

    // 验收4：VerifyRan acceptanceIds = 机器 pass ∪ manual（spec 顺序），fail 不进
    const runs = verifyRans();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("fail");
    expect(runs[0]?.acceptanceIds).toEqual(["A1", "M1"]);

    // 适配器折叠产物落盘留审计（nameMatch 输入可重放）
    const reportPath = join(evidenceBaseOf(runs[0]?.runId ?? ""), "A1.report.json");
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf-8")).toContain('"A1 PASS"');
  });

  it("脚本无标记 + exit 0（echo ok 假命令）→ parse 抛错路径 → 该条 fail，exit 1", async () => {
    makeVerifyFixture([ac("A9", "e2e-real", { core: true, command: "echo ok" })]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("A9 fail");
    expect(res.stderr).toContain("A9");
    expect(res.stderr).toContain("无标记行且 exitCode=0");

    const runs = verifyRans();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("fail");
    expect(runs[0]?.acceptanceIds).toEqual([]);
  });
});

describe("验收3：vitest 型验收（干净 checkout 内真实 vitest 子进程）", () => {
  it(
    "同一 command 两态：测试名含 A1 → pass；测试名不含 A2 → fail（未出现在产物）",
    { timeout: 120_000 },
    async () => {
      makeGitRepo(cwd, [
        {
          "package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
          "tests/acceptances.test.ts":
            'import { describe, expect, it } from "vitest";\n\n' +
            'describe("验收", () => {\n' +
            '  it("A1 真实通过的单测", () => {\n    expect(1 + 1).toBe(2);\n  });\n' +
            '  it("普通业务用例", () => {\n    expect("a".toUpperCase()).toBe("A");\n  });\n' +
            "});\n",
        },
      ]);
      ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
      ledger.append("SpecSubmitted", {
        unitId: "u-1",
        specHash: "0".repeat(64),
        acceptance: [
          // unit 型 command 指向本仓库 vitest bin：干净 checkout 无 node_modules，
          // npx 找不到本地安装会走网络解析（不确定），绝对路径是确定性的
          ac("A1", "unit", { command: `"${VITEST_BIN}" run` }),
          ac("A2", "unit", { command: `"${VITEST_BIN}" run` }),
        ],
        contracts: [],
        split: [],
      });
      ledger.append("EvidenceSubmitted", {
        unitId: "u-1",
        runId: "run-1",
        commit: (spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim(),
        paths: [],
        sha256: [],
        exitCode: 0,
      });

      const res = await run(["verify", "--unit", "u-1"]);
      // A2「未出现在产物」→ 整体 fail（A1 的 pass 事实不受影响）
      expect(res.code, `stderr: ${res.stderr}`).toBe(1);
      expect(res.stdout).toContain("A1 pass");
      expect(res.stdout).toContain("A2 fail");
      expect(res.stderr).toContain("A2");
      expect(res.stderr).toContain("未出现在产物");

      const runs = verifyRans();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.acceptanceIds).toEqual(["A1"]);
    },
  );

  it("unit 型 command 非 vitest 兼容（echo 非 JSON）→ fail 且错误信息说明兼容命令要求", async () => {
    makeVerifyFixture([ac("A3", "unit", { command: "echo no-json" })]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("A3 fail");
    expect(res.stderr).toContain("A3");
    expect(res.stderr).toContain("vitest 兼容命令");
    expect(verifyRans()[0]?.acceptanceIds).toEqual([]);
  });
});

describe("验收4：manual 与 VerifyRan 语义不变", () => {
  it("全 manual + 一条 pass → exit 0，acceptanceIds 含 manual 且顺序与 spec 一致", async () => {
    makeVerifyFixture([
      ac("M1", "manual"),
      ac("A1", "e2e-real", { core: true, command: `node -e "console.log('A1 PASS')"` }),
      ac("M2", "manual"),
    ]);

    const res = await run(["verify", "--unit", "u-1"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("M1 manual");
    expect(res.stdout).toContain("M2 manual");
    expect(res.stdout).toContain("result=pass");

    const runs = verifyRans();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("pass");
    expect(runs[0]?.acceptanceIds).toEqual(["M1", "A1", "M2"]);
  });
});
