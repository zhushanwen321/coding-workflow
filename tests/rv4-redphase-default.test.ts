/**
 * rv4 单测：红阶段默认接线（docs/rewrite/acceptance/rv4-acceptance.md §5 T1-T3，
 * dispatch 层完整路径，真实 git 子进程 + tmp 目录 + 隔离 CW_HOME，零 mock）。
 *
 * 红阶段 rv-4 起是 verify 默认的第三道 gate（--no-red-phase 逃生口；--red-phase
 * 保留为显式同义）：恒真测试在自动链路上必死。
 *   T1 恒真测试必死（核心）：内联恒真脚本 → 默认 verify exit 1，report.json
 *      redPhase 节该 id discriminative:false，fail 原因含恒真说明；--no-red-phase
 *      → exit 0（逃生口有效）
 *   T2 正常测试通过：真实现 + 真测试（旧树必挂）→ 默认 exit 0，redPhase 节
 *      discriminative:true 逐条存在；--red-phase 显式同义且 verify 总是入账
 *   T3 无父 commit 跳过：单 commit 仓库 → verify 可用，redPhase 节 skipped:true
 *      + 原因，判定不受影响
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rv4-red-"));
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
      writeFileSync(join(dir, name), content);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", `-m`, `commit-${i + 1}`]);
    hashes.push(
      (spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim(),
    );
  });
  return hashes;
}

function ac(id: string, command: string): AcceptanceItem {
  return { id, core: true, title: `标题-${id}`, type: "e2e-real", command };
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

/** 入账 spec + build 证据（build 锚 = 当前 HEAD） */
function submitSpecAndBuild(acceptance: AcceptanceItem[]): void {
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
    commit: (spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim(),
    paths: [],
    sha256: [],
    exitCode: 0,
  });
}

/** 最后一条 VerifyRan 的 runId（无则抛——断言前置失败） */
function lastVerifyRunId(): string {
  const runs = ledger
    .readAll()
    .filter((e) => e.type === "VerifyRan")
    .map((e) => e.payload as { runId: string });
  const last = runs[runs.length - 1];
  if (last === undefined) {
    throw new Error("fixture 断言前置失败：账本内无 VerifyRan");
  }
  return last.runId;
}

/** 读取 verify runId 目录的 report.json 的 redPhase 节（rv-4 并入的结构） */
function readRedPhase(runId: string): Array<{
  id: string;
  discriminative: boolean;
  skipped?: boolean;
  reason: string;
}> {
  const raw = JSON.parse(
    readFileSync(join(evidenceDir(cwHome, cwd, "u-1", runId), "report.json"), "utf-8"),
  ) as { redPhase?: Array<{ id: string; discriminative: boolean; skipped?: boolean; reason: string }> };
  return raw.redPhase ?? [];
}

// ================================================================
// T1：恒真测试必死（核心场景）
// ================================================================

describe("T1 恒真测试必死：内联恒真脚本 → 默认 verify exit 1；--no-red-phase → exit 0", () => {
  // 两 commit：c1 基线、c2 携带实现产物（恒真 command 不引用它 → patch 无从带）
  function makeAlwaysGreenFixture(): void {
    makeGitRepo(cwd, [
      { "seed.txt": "baseline" },
      { "impl.txt": "feature payload\n" },
    ]);
    submitSpecAndBuild([ac("A1", `node -e "console.log('A1 PASS')"`)]); // 旧树同样通过的恒真脚本
  }

  it("默认（无任何 flag）→ exit 1，redPhase 节 A1 discriminative:false，stderr 含恒真说明", async () => {
    makeAlwaysGreenFixture();

    const res = await run(["verify", "--unit", "u-1"]);

    // 常规判定 A1 pass（新树绿），红阶段无区分力（旧树也绿）→ 三道 gate 并列 fail
    expect(res.code, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(1);
    expect(res.stdout).toContain("A1 pass");
    // fail 也入账（rv-4：verify 总是入账，红阶段 fail 是打回依据）
    const runs = ledger.readAll().filter((e) => e.type === "VerifyRan");
    expect(runs).toHaveLength(1);

    const redPhase = readRedPhase(lastVerifyRunId());
    expect(redPhase).toHaveLength(1);
    expect(redPhase[0]).toMatchObject({ id: "A1", discriminative: false });
    expect(redPhase[0]?.reason).toContain("无区分力");

    // 恒真说明：stderr 的红阶段失败区指明恒真测试防线（新测试在旧代码树必须 fail）
    expect(res.stderr).toContain("红阶段");
    expect(res.stderr).toContain("A1");
    expect(res.stderr).toContain("恒真测试");
    expect(res.stderr).toContain("无区分力");
    expect(res.stderr).toContain("恢复动作");
  });

  it("同场景 --no-red-phase → exit 0（逃生口有效），redPhase 节为空数组", async () => {
    makeAlwaysGreenFixture();

    const res = await run(["verify", "--unit", "u-1", "--no-red-phase"]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("result=pass");
    const runs = ledger.readAll().filter((e) => e.type === "VerifyRan");
    expect(runs).toHaveLength(1);
    expect((runs[0]?.payload as { result: string }).result).toBe("pass");
    expect(readRedPhase(lastVerifyRunId())).toEqual([]);
  });
});

// ================================================================
// T2：正常测试通过（真实现 + 真测试，旧树必挂）
// ================================================================

describe("T2 正常测试通过：默认 verify exit 0，redPhase 节 discriminative:true 逐条存在", () => {
  function makeRealTestFixture(): void {
    // c2 同时新增实现产物（impl.txt，不进 command）与引用它的脚本：patch 把
    // run-tests.sh / check-impl.js 带进 c1 树后 impl.txt 仍缺失 → 旧树必挂 →
    // 有区分力。注意 command 里不能出现 "impl.txt" 字样——patch 语义会把
    // 「command 引用的变更文件」带进父树，实现文件被点名也会被带进去（判定
    // 更严），真测试的引用要走中间脚本间接化
    makeGitRepo(cwd, [
      { "seed.txt": "baseline" },
      {
        "impl.txt": "feature payload\n",
        "run-tests.sh":
          '#!/bin/sh\nif [ ! -f impl.txt ]; then\n  echo "impl.txt missing"\n  exit 1\nfi\necho "A1 PASS"\n',
        "check-impl.js":
          "// T2 fixture：A2 真测试（引用实现产物，旧树因实现缺失必挂）\n" +
          "const fs = require('fs');\n" +
          "if (!fs.existsSync('impl.txt')) process.exit(1);\n" +
          "console.log('A2 PASS');\n",
      },
    ]);
    submitSpecAndBuild([
      ac("A1", "bash run-tests.sh"),
      ac("A2", "node check-impl.js"),
    ]);
  }

  it("默认（无任何 flag）→ exit 0，redPhase 节逐条 discriminative:true，stdout 逐条「有区分力」", async () => {
    makeRealTestFixture();

    const res = await run(["verify", "--unit", "u-1"]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("result=pass");
    expect(res.stdout).toContain("A1 有区分力");
    expect(res.stdout).toContain("A2 有区分力");

    const redPhase = readRedPhase(lastVerifyRunId());
    expect(redPhase.map((e) => [e.id, e.discriminative])).toEqual([
      ["A1", true],
      ["A2", true],
    ]);
  });

  it("--red-phase 显式同义（幂等）：与默认行为一致，verify 总是入账（rv-4 废除旧 standalone 不入账语义）", async () => {
    makeRealTestFixture();

    const res = await run(["verify", "--unit", "u-1", "--red-phase"]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    // 旧 standalone 语义「红阶段不写 VerifyRan」废除——rv-4 统一为 verify 总是入账
    const runs = ledger.readAll().filter((e) => e.type === "VerifyRan");
    expect(runs).toHaveLength(1);
    expect((runs[0]?.payload as { result: string }).result).toBe("pass");
    const redPhase = readRedPhase(lastVerifyRunId());
    expect(redPhase.map((e) => e.discriminative)).toEqual([true, true]);
  });
});

// ================================================================
// T3：无父 commit 合法跳过
// ================================================================

describe("T3 无父 commit 跳过：单 commit 仓库 → verify 可用，判定不受影响", () => {
  it("build commit 即仓库首提交 → exit 0，redPhase 节 skipped:true + 原因含「无父 commit」", async () => {
    makeGitRepo(cwd, [{ "seed.txt": "only" }]);
    submitSpecAndBuild([ac("A1", `node -e "console.log('A1 PASS')"`)]);

    const res = await run(["verify", "--unit", "u-1"]);

    // 单 commit 仓库 verify 必须可用（rv4-acceptance §4：合法跳过不是失败）
    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("result=pass");

    const redPhase = readRedPhase(lastVerifyRunId());
    expect(redPhase).toHaveLength(1);
    expect(redPhase[0]).toMatchObject({ id: "A1", skipped: true, discriminative: true });
    expect(redPhase[0]?.reason).toContain("无父 commit");
    expect(redPhase[0]?.reason).toContain("红阶段不适用");
    // stdout 摘要透明呈现跳过事实
    expect(res.stdout).toContain("A1 跳过");
  });
});
