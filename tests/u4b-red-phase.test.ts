/**
 * u4b 单测：红阶段 gate（u4b 验收文档「单测验收」5/6，dispatch 层完整路径，
 * 真实 git 子进程 + tmp 目录 + 隔离 CW_HOME，零 mock）。
 *
 * patch 语义（对抗审查修订）：红阶段先把「验收 command 引用的变更文件」（新
 * 测试入口）从 build commit patch 进父树再跑——只回退不 patch 时，恒真测试
 * （无条件 PASS）放进新文件即可让父树命令因文件缺失 fail 被误判有区分力。
 *
 * rv-4 语义迁移：--red-phase 不再是 standalone 模式（旧：只跑红阶段、不写
 * VerifyRan、无父 commit → exit 2），保留为默认红阶段的显式同义——常规干净
 * 重跑 + 红阶段三道 gate 并列，verify 总是入账，无父 commit 合法跳过。
 *   - 验收5a（真测试）c2 新增脚本引用 c2 实现产物 → patch 到 c1 树跑必挂 →
 *     有区分力：常规 pass + 红阶段过 → exit 0，VerifyRan(pass) 入账，红阶段执行
 *     产物仍落 red-phase 前缀目录；
 *   - 验收5b（假命令）echo ok 不引用变更文件 → 无可 patch，两树都过 → 常规
 *     fail（无标记行）+ 红阶段无区分力 → exit 1 且 stderr 列 id，恢复动作指向
 *     「修测试而非修 gate」；
 *   - 验收5c（恒真测试穿透防线）c2 新增无条件 PASS 脚本 + 验收 command 引用
 *     它 → patch 到 c1 树后旧树也绿 → 常规 pass + 红阶段拒绝 → exit 1，stderr
 *     指明「新测试在基线代码树上也通过」；
 *   - 验收6 初始 commit（无父）→ 红阶段合法跳过（redPhase 节 skipped:true），
 *     判定不受影响（rv-4 废除旧 exit 2 语义——单 commit 仓库 verify 必须可用）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";
import {
  changedFilesBetween,
  firstParentOf,
  judgeRedPhase,
  testFilesToPatch,
} from "../src/verify/red-phase.js";
import type { AcceptanceRunResult } from "../src/verify/run.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u4b-red-"));
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
    git(dir, ["commit", "-m", `commit-${i + 1}`]);
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

/** 入账 spec + build 证据（build 锚 = 当前 HEAD，即 makeGitRepo 的最后一个 commit） */
function submitSpecAndBuild(command: string): void {
  ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", {
    unitId: "u-1",
    specHash: "0".repeat(64),
    acceptance: [ac("A1", command)],
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

/**
 * 恒真测试形态：c1 基线无测试文件，c2 新增无条件 `A1 PASS` 的脚本。
 * 旧口径（只回退不 patch）下父树因文件缺失 fail 被误判有区分力——patch 语义
 * 要堵的穿透路径。
 */
function makeTrueTestFixture(command: string): void {
  makeGitRepo(cwd, [
    { "seed.txt": "baseline" },
    { "run-tests.sh": '#!/bin/sh\necho "A1 PASS"\n' },
  ]);
  submitSpecAndBuild(command);
}

/**
 * 真测试形态：c2 同时新增实现产物（impl.txt，不进 command）与引用它的脚本。
 * patch 把 run-tests.sh 带进 c1 树后，impl.txt 仍缺失 → 命令必挂 → 有区分力。
 */
function makeRealTestFixture(command: string): void {
  makeGitRepo(cwd, [
    { "seed.txt": "baseline" },
    {
      "impl.txt": "feature payload\n",
      "run-tests.sh":
        '#!/bin/sh\nif [ ! -f impl.txt ]; then\n  echo "impl.txt missing"\n  exit 1\nfi\necho "A1 PASS"\n',
    },
  ]);
  submitSpecAndBuild(command);
}

describe("firstParentOf / judgeRedPhase 纯单元（真实 git 子进程）", () => {
  it("firstParentOf：c2 → c1；初始 commit → noParent", () => {
    const repo = join(tmpRoot, "fp-repo");
    const [c1, c2] = makeGitRepo(repo, [{ "a.txt": "1" }, { "b.txt": "2" }]);
    expect(firstParentOf(repo, c2)).toEqual({ ok: true, commit: c1 });
    const root = firstParentOf(repo, c1);
    expect(root.ok).toBe(false);
    if (!root.ok) {
      expect(root.noParent).toBe(true);
      expect(root.error).toContain("无父 commit");
    }
  });

  it("judgeRedPhase：pass / parseError+exit0 / parseError+exit≠0 / 真 fail 四态", () => {
    const results: AcceptanceRunResult[] = [
      { id: "P1", status: "pass", stdoutPath: "", stderrPath: "", timeout: false, commandExit: 0, parseError: false },
      { id: "P2", status: "fail", stdoutPath: "", stderrPath: "", timeout: false, reason: "无标记行且 exitCode=0", commandExit: 0, parseError: true },
      { id: "P3", status: "fail", stdoutPath: "", stderrPath: "", timeout: false, reason: "产物解析失败", commandExit: 1, parseError: true },
      { id: "P4", status: "fail", stdoutPath: "", stderrPath: "", timeout: false, reason: "执行失败", commandExit: 1, parseError: false },
      { id: "P5", status: "fail", stdoutPath: "", stderrPath: "", timeout: true, reason: "超时", commandExit: null, parseError: false },
    ];
    const byId = new Map(judgeRedPhase(results).map((v) => [v.id, v.discriminative]));
    expect(byId.get("P1")).toBe(false); // 旧树 pass → 无区分力
    expect(byId.get("P2")).toBe(false); // echo ok 假命令 → 无区分力
    expect(byId.get("P3")).toBe(true); // 命令真挂 + 产物无效 → 有区分力
    expect(byId.get("P4")).toBe(true); // 标记 FAIL / 执行失败 → 有区分力
    expect(byId.get("P5")).toBe(true); // 旧树超时挂死 → 有区分力
  });

  it("judgeRedPhase：patch 树上 pass → 无区分力且 reason 指明恒真测试穿透；未 patch 保持原文案", () => {
    const results: AcceptanceRunResult[] = [
      { id: "P1", status: "pass", stdoutPath: "", stderrPath: "", timeout: false, commandExit: 0, parseError: false },
    ];
    const [patched] = judgeRedPhase(results, { patchedFiles: ["run-tests.sh"] });
    expect(patched?.discriminative).toBe(false);
    expect(patched?.reason).toContain("新测试在基线代码树");
    expect(patched?.reason).toContain("恒真测试");
    const [plain] = judgeRedPhase(results);
    expect(plain?.discriminative).toBe(false);
    expect(plain?.reason).toContain("旧树（父 commit）上即 pass");
  });
});

describe("patch 语义纯单元（真实 git 子进程）", () => {
  it("changedFilesBetween：变更集含新增/修改；删除文件被排除（build commit 中不存在，patch 无从取）", () => {
    const repo = join(tmpRoot, "diff-repo");
    const [c1] = makeGitRepo(repo, [{ "a.txt": "1", "b.txt": "2" }]);
    writeFileSync(join(repo, "a.txt"), "one");
    writeFileSync(join(repo, "c.txt"), "3");
    rmSync(join(repo, "b.txt"));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "commit-2"]);
    const c2 = (spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? "").trim();
    expect(changedFilesBetween(repo, c1, c2)).toEqual({ ok: true, files: ["a.txt", "c.txt"] });
  });

  it("testFilesToPatch：相对路径与 basename 两种形态命中；未被任何 command 引用 → 不 patch", () => {
    const changed = ["tests/a.test.ts", "src/impl.ts", "e2e/run.sh"];
    const acceptance = [
      ac("A1", "npx vitest run tests/a.test.ts"),
      ac("A2", "bash e2e/run.sh"),
      ac("A3", "echo unrelated"),
    ];
    expect(testFilesToPatch(changed, acceptance)).toEqual(["tests/a.test.ts", "e2e/run.sh"]);
  });

  it("testFilesToPatch：command 只写 basename（不带目录）也能命中带路径的变更文件", () => {
    expect(testFilesToPatch(["e2e/run.sh"], [ac("A1", "bash run.sh")])).toEqual(["e2e/run.sh"]);
  });

  it("testFilesToPatch：无 command 的验收（manual/e2e 缺 command）不参与匹配", () => {
    const acceptance: AcceptanceItem[] = [
      { id: "M1", core: false, title: "手测", type: "manual" },
      { id: "E1", core: true, title: "缺 command 的 e2e", type: "e2e-real" },
    ];
    expect(testFilesToPatch(["run.sh"], acceptance)).toEqual([]);
  });
});

describe("验收5：红阶段区分力判定（dispatch 层，含 patch 语义；rv-4 起三道 gate 并列）", () => {
  it("验收5a 真测试：c2 脚本引用 c2 实现产物 → patch 到 c1 树跑必挂 → 常规 pass + 红阶段过 → exit 0；VerifyRan 总是入账；红阶段产物落 red-phase 目录", async () => {
    makeRealTestFixture("bash run-tests.sh");

    // rv-4 语义迁移：--red-phase 是默认红阶段的显式同义（不再是 standalone 模式）
    const res = await run(["verify", "--unit", "u-1", "--red-phase"]);
    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("A1 pass");
    expect(res.stdout).toContain("A1 有区分力");
    expect(res.stdout).toContain("result=pass");

    // rv-4 语义迁移：verify 总是入账（旧「红阶段不写 VerifyRan」废除）
    const verifyRans = ledger.readAll().filter((e) => e.type === "VerifyRan");
    expect(verifyRans).toHaveLength(1);
    expect((verifyRans[0]?.payload as { result: string }).result).toBe("pass");

    // 红阶段执行产物落盘留审计（runId 目录以 red-phase- 前缀与常规 verify 区分）
    const unitDir = dirname(evidenceDir(cwHome, cwd, "u-1", "probe"));
    const redPhaseDirs = readdirSync(unitDir).filter((n) => n.startsWith("red-phase-"));
    expect(redPhaseDirs).toHaveLength(1);
    const reportPath = join(unitDir, redPhaseDirs[0] ?? "", "report.json");
    expect(readFileSync(reportPath, "utf8")).toContain('"A1"');
  });

  it("验收5b 假命令：echo ok 不引用任何变更文件 → 常规 fail（无标记行）+ 红阶段无区分力 → exit 1 且 stderr 列 id + 修测试指引", async () => {
    makeTrueTestFixture("echo ok");

    const res = await run(["verify", "--unit", "u-1", "--red-phase"]);
    expect(res.code).toBe(1);
    // 常规层：无标记行且 exitCode=0（假命令防线）
    expect(res.stderr).toContain("A1");
    expect(res.stderr).toContain("无标记行且 exitCode=0");
    // 红阶段层：两树都过 → 无区分力（rv-4 并列 gate 的红阶段失败区）
    expect(res.stderr).toContain("红阶段");
    expect(res.stderr).toContain("无区分力");
    expect(res.stderr).toContain("恢复动作");
    // rv-4 语义迁移：fail 也入账（打回依据）
    const verifyRans = ledger.readAll().filter((e) => e.type === "VerifyRan");
    expect(verifyRans).toHaveLength(1);
    expect((verifyRans[0]?.payload as { result: string }).result).toBe("fail");
  });

  it("验收5c 恒真测试穿透防线：c2 新增无条件 PASS 脚本 + 验收 command 引用它 → 常规 pass + patch 后旧树也绿 → 拒绝 exit 1，stderr 指明新测试在基线代码树上也通过", async () => {
    makeTrueTestFixture("bash run-tests.sh");

    const res = await run(["verify", "--unit", "u-1", "--red-phase"]);
    expect(res.code, `stdout: ${res.stdout}`).toBe(1);
    // 常规层：恒真脚本在新树也绿（机器判定 pass），fail 只来自红阶段
    expect(res.stdout).toContain("A1 pass");
    expect(res.stderr).toContain("红阶段");
    expect(res.stderr).toContain("A1");
    expect(res.stderr).toContain("无区分力");
    // 恒真穿透的专属拒绝文案（judgeRedPhase 的 patched 语境 reason）
    expect(res.stderr).toContain("新测试在基线代码树");
    expect(res.stderr).toContain("恒真测试");
    expect(res.stderr).toContain("恢复动作");
    // rv-4 语义迁移：红阶段 fail 的 verify 也入账（恒真测试在自动链路上必死）
    const verifyRans = ledger.readAll().filter((e) => e.type === "VerifyRan");
    expect(verifyRans).toHaveLength(1);
    expect((verifyRans[0]?.payload as { result: string }).result).toBe("fail");
  });
});

describe("验收6：初始 commit（无父）→ 红阶段合法跳过（rv-4 废除旧 exit 2 语义）", () => {
  it("单 commit 仓库的 build 锚 → 红阶段 skipped 不影响判定；echo ok 的常规 fail 照常 exit 1 且入账", async () => {
    makeGitRepo(cwd, [{ "seed.txt": "only" }]);
    ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
    ledger.append("SpecSubmitted", {
      unitId: "u-1",
      specHash: "0".repeat(64),
      acceptance: [ac("A1", "echo ok")],
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

    // rv-4 语义迁移：无父 commit 是合法跳过不是失败（旧 standalone → exit 2）；
    // 本 fixture 的验收是 echo ok（常规层假命令 fail）→ exit 1（红阶段 skip
    // 不参与判定，echo ok 的常规失败不被跳过掩盖）
    const res = await run(["verify", "--unit", "u-1", "--red-phase"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A1");
    expect(res.stderr).toContain("无标记行且 exitCode=0");
    // 跳过事实在 stdout 摘要透明呈现（含原因）
    expect(res.stdout).toContain("A1 跳过");
    expect(res.stdout).toContain("无父 commit");
    expect(res.stdout).toContain("红阶段不适用");
    // verify 可用且入账（单 commit 仓库不因红阶段而 exit 2 / 拒绝服务）
    const verifyRans = ledger.readAll().filter((e) => e.type === "VerifyRan");
    expect(verifyRans).toHaveLength(1);
    // report.json 的 redPhase 节记录 skipped 条目（rv4-acceptance §2 结构）
    const runId = (verifyRans[0]?.payload as { runId: string }).runId;
    const report = JSON.parse(
      readFileSync(join(evidenceDir(cwHome, cwd, "u-1", runId), "report.json"), "utf-8"),
    ) as { redPhase: Array<{ id: string; skipped?: boolean; reason: string }> };
    expect(report.redPhase).toEqual([
      {
        id: "A1",
        discriminative: true,
        skipped: true,
        reason: expect.stringContaining("无父 commit"),
      },
    ]);
  });
});
