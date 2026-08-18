/**
 * rv-2 engine 小修包验收测试（docs/rewrite/acceptance/rv2-acceptance.md §5 T1-T7）。
 *
 * 覆盖六项修复的条款测试 + 回归锚：
 *   T1 规则⑦：spec.acceptance[].id 字符集入口拦截（checkSpecRules 直调）
 *   T2 marker 同源：e2e-sh MARKER_RE 由 ACCEPTANCE_ID_RE 派生，与 gate 两路一致
 *   T3 exec-review 必填 --evidence-refs（dispatch 层完整路径）
 *   T4 closed unit 拒绝文案不含 replan、指向 cw create（dispatch 层）
 *   T5 parse 失败条目 <id>.report.json 落盘 { parseError, commandExit, reason }
 *   T6 子目录 verify：cleanCheckout 以 git rev-parse --show-toplevel 解析仓库根
 *   T7 回归锚：marker 字符集扩展是旧合法集的超集（旧脚本零改动向后兼容）
 *
 * 真实环境零 mock：dispatch 完整路径 + 真实 EventLedger + tmp 目录 + 真实 git
 * 子进程 + 真实 sh 脚本执行（u2-review / u4a / u5-e2e-sh 同款基建风格）。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import { ACCEPTANCE_ID_RE, type AcceptanceItem, type SpecSubmittedPayload } from "../src/events/types.js";
import { checkSpecRules } from "../src/gates/spec-rules.js";
import { loadLedger, treeStatuses } from "../src/readonly/load.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";
import { e2eShAdapter } from "../src/testrun/e2e-sh.js";
import { runAcceptances } from "../src/verify/run.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rv2-"));
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

async function run(args: readonly string[], workdir = cwd): Promise<Captured> {
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
    const code = await dispatch(args, workdir);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ── 共享 fixture ─────────────────────────────────────────────

/** 真实 tmp git 仓库：init + 逐次提交一批根目录文件；返回各 commit hash（u4a 同款） */
function makeGitRepo(dir: string, commitsFiles: ReadonlyArray<Record<string, string>>): string[] {
  mkdirSync(dir, { recursive: true });
  const gitArgs = (args: readonly string[]): readonly string[] => ["-C", dir, ...args];
  const expect0 = (args: readonly string[], what: string): void => {
    const res = spawnSync("git", gitArgs(args), { encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`git ${what} 失败: ${res.stderr}`);
    }
  };
  expect0(["init"], "init");
  expect0(["config", "user.email", "cw-test@example.com"], "config email");
  expect0(["config", "user.name", "cw-test"], "config name");
  const hashes: string[] = [];
  commitsFiles.forEach((files, i) => {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    expect0(["add", "-A"], `add #${i + 1}`);
    expect0(["commit", "-m", `commit-${i + 1}`], `commit #${i + 1}`);
    hashes.push(
      (spawnSync("git", gitArgs(["rev-parse", "HEAD"]), { encoding: "utf-8" }).stdout ?? "").trim(),
    );
  });
  return hashes;
}

/** 过全部规则的合法 spec（A1 core e2e-real 走 node，PATH 必可解析；A2 unit） */
function legalSpec(unitId: string): SpecSubmittedPayload {
  return {
    unitId,
    specHash: "0".repeat(64),
    acceptance: [
      { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: "node -v" },
      { id: "A2", core: false, title: "单元行为正确", type: "unit" },
    ],
    contracts: [],
    split: [],
  };
}

/** 直写账本构造 verified unit（spec-review pass + build 证据 + pass VerifyRan） */
function seedVerifiedUnit(unitId: string, runIds: readonly string[]): void {
  const spec = legalSpec(unitId);
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: "brief.md" });
  ledger.append("SpecSubmitted", spec);
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
  for (const runId of runIds) {
    ledger.append("EvidenceSubmitted", {
      unitId,
      runId,
      commit: "f".repeat(40),
      paths: [],
      sha256: [],
      exitCode: 0,
    });
  }
  ledger.append("VerifyRan", {
    unitId,
    runId: "verify-seed",
    reportHash: "r".repeat(64),
    result: "pass",
    acceptanceIds: spec.acceptance.map((ac) => ac.id),
  });
}

/** 直写账本构造 closed unit（verified + exec-review pass；fold 不校验 refs） */
function seedClosedUnit(unitId: string): void {
  seedVerifiedUnit(unitId, ["run-1"]);
  ledger.append("VerdictSubmitted", {
    unitId,
    verdictKind: "exec-review",
    verdict: "pass",
    evidenceRefs: ["run-1"],
  });
}

function treeStatusOf(unitId: string): string {
  const status = treeStatuses(loadLedger(cwd).projection).get(unitId);
  if (status === undefined) {
    throw new Error(`fixture 破损：unit "${unitId}" 不在树感知状态集合中`);
  }
  return status;
}

/** u3 同款：非 core 的 unit 用例工厂（规则①-⑥不触发，只剩规则⑦可判） */
function unitItem(id: string): AcceptanceItem {
  return { id, core: false, title: `${id} 描述`, type: "unit" };
}

function makeSpec(acceptance: readonly AcceptanceItem[]): SpecSubmittedPayload {
  return { unitId: "rv2-t1", specHash: "0".repeat(64), acceptance: [...acceptance], contracts: [], split: [] };
}

/** u5 同款：tmp 写真实 sh 脚本执行（stdout 落盘）——返回产物路径与真实 exitCode */
const scriptTmp = join(tmpRoot, "scripts");
let scriptSeq = 0;

function runScript(body: string): { out: string; status: number } {
  mkdirSync(scriptTmp, { recursive: true });
  const script = join(scriptTmp, `rv2-${scriptSeq++}.sh`);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  const res = spawnSync(script, { encoding: "utf8", cwd: scriptTmp });
  const out = `${script}.out`;
  writeFileSync(out, res.stdout ?? "");
  return { out, status: res.status ?? -1 };
}

function e2eAcc(id: string): AcceptanceItem {
  return { id, core: true, title: "rv2 marker 验收", type: "e2e-real", command: "bash e2e/run.sh" };
}

// ── T1 规则⑦：id 字符集入口拦截 ──────────────────────────────

describe("T1 规则⑦：spec 验收 id 字符集入口拦截（checkSpecRules）", () => {
  it("非法 id（空格/中文/. 开头）逐条拒绝，消息含 id 原文 + 字符集说明 + 恢复动作", () => {
    const result = checkSpecRules(
      makeSpec([unitItem("TC 1"), unitItem("中文用例"), unitItem(".开头"), unitItem("A_1")]),
    );
    expect(result.ok).toBe(false);
    const rule7 = result.failures.filter((f) => f.includes("规则⑦"));
    expect(rule7).toHaveLength(3);
    for (const id of ["TC 1", "中文用例", ".开头"]) {
      expect(rule7.some((f) => f.includes(`"${id}"`)), `规则⑦消息应含 id 原文 "${id}"`).toBe(true);
    }
    // 字符集说明（字母数字开头，可含 . _ -）与恢复动作（改 id 后重新提交）
    for (const f of rule7) {
      expect(f).toContain("字母数字开头");
      expect(f).toContain(".");
      expect(f).toContain("重新提交");
    }
  });

  it("合法 id（A_1 / TC.1 / a-b）全部通过规则⑦（不影响其余规则判定）", () => {
    const result = checkSpecRules(makeSpec([unitItem("A_1"), unitItem("TC.1"), unitItem("a-b")]));
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("规则⑦与其他规则缺口按序共存（非法 id 不遮蔽 rule②的 core manual 缺口）", () => {
    const result = checkSpecRules(
      makeSpec([unitItem("TC 1"), { ...unitItem("B1"), core: true, type: "manual" }]),
    );
    expect(result.ok).toBe(false);
    // 规则①-⑤前缀为 "rule②"（u3 既有形态），规则⑥⑦为中文前缀（fx-1 起的形态）
    expect(result.failures.some((f) => f.includes("rule②"))).toBe(true);
    expect(result.failures.some((f) => f.includes("规则⑦"))).toBe(true);
  });
});

// ── T2 marker 同源扩展 + 两路一致 ────────────────────────────

describe("T2 e2e-sh marker 同源扩展（id 可含 . _ -，与 ACCEPTANCE_ID_RE 派生）", () => {
  it("脚本输出 `TC.1 PASS` → parse 折叠 TC.1 pass", () => {
    const { out, status } = runScript('echo "TC.1 PASS"\nexit 0');
    expect(status).toBe(0);
    const report = e2eShAdapter.parse(out, status, e2eAcc("TC.1"));
    expect(report.cases).toEqual([{ id: "TC.1", name: "TC.1 PASS", status: "pass" }]);
  });

  it("脚本输出 `a_2 FAIL` → parse 折叠 a_2 fail（exit code 透传）", () => {
    const { out, status } = runScript('echo "a_2 FAIL"\nexit 1');
    expect(status).toBe(1);
    const report = e2eShAdapter.parse(out, status, e2eAcc("a_2"));
    expect(report.cases).toEqual([{ id: "a_2", name: "a_2 FAIL", status: "fail" }]);
    expect(report.exitCode).toBe(1);
  });

  it("含空格 id 的行 `TC 1 PASS` 不被 marker 命中 → 沿用无标记行防线（exit 0 抛无区分力）", () => {
    const { out, status } = runScript('echo "TC 1 PASS"\nexit 0');
    expect(status).toBe(0);
    expect(() => e2eShAdapter.parse(out, status, e2eAcc("TC 1"))).toThrow(/无标记行/);
  });

  it("两路同源对照：同一 id 集上 ACCEPTANCE_ID_RE ⟺ gate 规则⑦ ⟺ marker 识别，三路结论一致", () => {
    const corpus: ReadonlyArray<{ id: string; legal: boolean }> = [
      { id: "A1", legal: true },
      { id: "TC.1", legal: true },
      { id: "a_2", legal: true },
      { id: "a-b", legal: true },
      { id: "TC 1", legal: false },
      { id: "中文用例", legal: false },
      { id: ".开头", legal: false },
      { id: "_x", legal: false },
    ];
    for (const { id, legal } of corpus) {
      // 路 1：共享常量
      expect(ACCEPTANCE_ID_RE.test(id), `ACCEPTANCE_ID_RE("${id}")`).toBe(legal);
      // 路 2：gate 规则⑦（spec 只含此 id 的 unit 条目，规则①-⑥不触发）
      const rule7 = checkSpecRules(makeSpec([unitItem(id)])).failures.filter((f) => f.includes("规则⑦"));
      expect(rule7.length === 0, `gate 规则⑦("${id}")`).toBe(legal);
      // 路 3：marker 识别（真实脚本输出 `<id> PASS` + exit 0：识别 ⟺ parse 成功；
      //       不识别 → 无标记行 + exitCode 0 → 抛无区分力防线）
      const { out, status } = runScript(`echo "${id} PASS"\nexit 0`);
      const recognized = (() => {
        try {
          e2eShAdapter.parse(out, status, e2eAcc(id));
          return true;
        } catch {
          return false;
        }
      })();
      expect(recognized, `marker 识别("${id}")`).toBe(legal);
    }
  });
});

// ── T3 exec-review 必填 --evidence-refs ──────────────────────

describe("T3 exec-review 必填 --evidence-refs（dispatch 层完整路径）", () => {
  it("前置自证：种子事件折叠后 unit 为 verified", () => {
    seedVerifiedUnit("u-1", ["run-1", "run-2"]);
    expect(treeStatusOf("u-1")).toBe("verified");
  });

  it("exec-review 无 refs → exit 1，stderr 含已入账 runId 清单与恢复动作，不入账", async () => {
    seedVerifiedUnit("u-1", ["run-1", "run-2"]);
    const eventsBefore = ledger.readAll().length;
    const res = await run(["review", "submit", "--unit", "u-1", "--verdict-kind", "exec-review", "--verdict", "pass"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--evidence-refs");
    expect(res.stderr).toContain("run-1");
    expect(res.stderr).toContain("run-2");
    expect(res.stderr).toContain("cw evidence submit --kind build");
    expect(res.stderr).toContain("恢复动作");
    expect(ledger.readAll()).toHaveLength(eventsBefore);
    expect(treeStatusOf("u-1")).toBe("verified");
  });

  it("exec-review `--evidence-refs \"\"`（空串清洗后为空）→ 等价缺失，同 fail", async () => {
    seedVerifiedUnit("u-1", ["run-1"]);
    const res = await run([
      "review", "submit", "--unit", "u-1", "--verdict-kind", "exec-review",
      "--verdict", "pass", "--evidence-refs", "",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--evidence-refs");
    expect(res.stderr).toContain("run-1");
  });

  it("exec-review 带真实 runId → 入账成功，fold 后 closed", async () => {
    seedVerifiedUnit("u-1", ["run-1", "run-2"]);
    const res = await run([
      "review", "submit", "--unit", "u-1", "--verdict-kind", "exec-review",
      "--verdict", "pass", "--evidence-refs", "run-1",
    ]);
    expect(res.code).toBe(0);
    const events = ledger.readAll();
    const last = events[events.length - 1];
    expect(last?.type).toBe("VerdictSubmitted");
    expect(last?.payload).toMatchObject({ verdictKind: "exec-review", evidenceRefs: ["run-1"] });
    expect(treeStatusOf("u-1")).toBe("closed");
  });

  it("exec-review 带不存在 runId → 既有存在性校验 fail 不回归（exit 1，stderr 列缺失项）", async () => {
    seedVerifiedUnit("u-1", ["run-1"]);
    const res = await run([
      "review", "submit", "--unit", "u-1", "--verdict-kind", "exec-review",
      "--verdict", "pass", "--evidence-refs", "run-x,run-1",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("run-x");
    expect(res.stderr).toContain("run-1");
    expect(ledger.readAll().filter((e) => e.type === "VerdictSubmitted" && e.payload.unitId === "u-1" && (e.payload as { verdictKind?: string }).verdictKind === "exec-review")).toHaveLength(0);
  });

  it("spec-review 无 refs 维持可选 → exit 0（不回归）", async () => {
    seedVerifiedUnit("u-1", ["run-1"]);
    const res = await run(["review", "submit", "--unit", "u-1", "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]);
    expect(res.code).toBe(0);
  });
});

// ── T3b（rv-2 打回方案 C 裁决）：内部节点的执行证据 = VerifyRan ──

describe("T3b 方案 C：内部节点形态（有 VerifyRan、无 EvidenceSubmitted）的 exec-review 证据引用", () => {
  it("exec-review 引用该 unit 的 VerifyRan runId → 通过入账，fold 后 closed（内部节点的 build = 集成，集成只写 VerifyRan）", async () => {
    // 内部节点形态：0 条 EvidenceSubmitted，执行证据只有集成 VerifyRan（verify-seed）
    seedVerifiedUnit("u-root", []);
    expect(treeStatusOf("u-root")).toBe("verified");

    const res = await run([
      "review", "submit", "--unit", "u-root", "--verdict-kind", "exec-review",
      "--verdict", "pass", "--evidence-refs", "verify-seed",
    ]);
    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(treeStatusOf("u-root")).toBe("closed");
  });

  it("内部节点形态无 refs → fail，已入账 runId 清单含 verify/集成类 runId（清单两类分列）", async () => {
    seedVerifiedUnit("u-root", []);
    const res = await run(["review", "submit", "--unit", "u-root", "--verdict-kind", "exec-review", "--verdict", "pass"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("verify/集成: verify-seed");
    expect(res.stderr).toContain("恢复动作");
  });

  it("两类并存（build 证据 + VerifyRan）时清单同时列出 build: 与 verify/集成: 两类", async () => {
    seedVerifiedUnit("u-leaf", ["run-1"]);
    const res = await run(["review", "submit", "--unit", "u-leaf", "--verdict-kind", "exec-review", "--verdict", "pass"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("build: run-1");
    expect(res.stderr).toContain("verify/集成: verify-seed");
  });

  it("内部节点形态引用不存在的 runId → 存在性校验对扩展集不回归（exit 1 列缺失项）", async () => {
    seedVerifiedUnit("u-root", []);
    const res = await run([
      "review", "submit", "--unit", "u-root", "--verdict-kind", "exec-review",
      "--verdict", "pass", "--evidence-refs", "run-ghost",
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("run-ghost");
    expect(res.stderr).toContain("verify-seed");
  });
});

// ── T4 closed 拒绝文案不含 replan ────────────────────────────

describe("T4 closed unit 重提 spec 的拒绝文案（dispatch 层）", () => {
  it("closed unit 重提 spec → exit 1，消息不含 replan、含 cw create 恢复路径与不可逆说明", async () => {
    seedClosedUnit("u-1");
    const specPath = join(cwd, "spec-v2.json");
    writeFileSync(specPath, JSON.stringify({
      acceptance: legalSpec("u-1").acceptance,
      contracts: [],
      split: [],
    }));

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "u-1", "--file", specPath]);
    expect(res.code).toBe(1);
    expect(res.stderr).not.toContain("replan");
    expect(res.stderr).toContain("cw create");
    expect(res.stderr).toContain("不可逆");
    expect(res.stderr).toContain("恢复动作");
    expect(treeStatusOf("u-1")).toBe("closed");
  });
});

// ── T5 parse 失败条目 report.json 落盘 ───────────────────────

describe("T5 parse 失败条目 <id>.report.json 落盘（runAcceptances 直调）", () => {
  it("unit 型非 JSON 输出走 vitest 路由 → report.json 落 { parseError: true, commandExit: 真实 exit, reason }；同 run 正常条目不受影响", () => {
    const checkoutDir = mkdtempSync(join(tmpRoot, "t5-co"));
    const evidenceBase = mkdtempSync(join(tmpRoot, "t5-ev"));
    const outcome = runAcceptances(
      checkoutDir,
      [
        // command 自带 --reporter=json（vitest translate 的 includes 命中不追加），
        // stdout 非 JSON → vitest parse 抛错；两种真实 exit code 验证落盘值非硬编码
        { id: "P1", core: false, title: "非 JSON 产物（exit 0）", type: "unit", command: "echo not-json --reporter=json" },
        { id: "P2", core: false, title: "非 JSON 产物（exit 3）", type: "unit", command: "echo not-json --reporter=json; exit 3" },
        { id: "P3", core: true, title: "正常 e2e 条目", type: "e2e-real", command: 'echo "P3 PASS"' },
      ],
      evidenceBase,
      10_000,
    );

    // 判定语义不变：parse 失败条目 fail + parseError true，不中断其余验收
    const [p1, p2, p3] = outcome.results;
    expect(p1?.status).toBe("fail");
    expect(p1?.parseError).toBe(true);
    expect(p1?.commandExit).toBe(0);
    expect(p2?.status).toBe("fail");
    expect(p2?.parseError).toBe(true);
    expect(p2?.commandExit).toBe(3);
    expect(p3?.status).toBe("pass");
    expect(p3?.parseError).toBe(false);

    // rv-2 审计增量：parse 失败条目的最小 JSON 落盘（同目录同命名规则）
    const p1Report = JSON.parse(readFileSync(join(evidenceBase, "P1.report.json"), "utf-8")) as {
      parseError: boolean;
      commandExit: number;
      reason: string;
    };
    expect(p1Report.parseError).toBe(true);
    expect(p1Report.commandExit).toBe(0);
    expect(p1Report.reason).toContain("P1");
    expect(p1Report.reason).toContain("解析失败");

    const p2Report = JSON.parse(readFileSync(join(evidenceBase, "P2.report.json"), "utf-8")) as {
      parseError: boolean;
      commandExit: number;
      reason: string;
    };
    expect(p2Report.parseError).toBe(true);
    expect(p2Report.commandExit).toBe(3);
    expect(p2Report.reason).toContain("解析失败");

    // 同 run 正常条目 report.json 仍是 EvidenceReport（无 parseError 键）
    const p3Report = JSON.parse(readFileSync(join(evidenceBase, "P3.report.json"), "utf-8")) as Record<string, unknown> & {
      cases: Array<{ id: string; status: string }>;
    };
    expect("parseError" in p3Report).toBe(false);
    expect(p3Report.cases).toEqual([{ id: "P3", name: "P3 PASS", status: "pass" }]);
  });
});

// ── T6 子目录 verify 的仓库根解析 ────────────────────────────

describe("T6 cleanCheckout 仓库根解析（dispatch 层 verify 完整链）", () => {
  /** 直写账本种子（unit u-1：spec + build 证据），账本 key 锚定传入的 cwd */
  function seedVerifyFixture(workdir: string, commit: string): void {
    mkdirSync(workdir, { recursive: true });
    const l = new EventLedger(ledgerPath(cwHome, workdir));
    l.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
    l.append("SpecSubmitted", {
      unitId: "u-1",
      specHash: "0".repeat(64),
      acceptance: [
        { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: 'echo "A1 PASS"' },
        // unit 条目 command 自带 --reporter=json 且用 node 产出合规 vitest JSON
        //（u5b-e2e 同款手法：checkout 临时目录无 node_modules，不能真跑 vitest）
        {
          id: "A2", core: false, title: "单元冒烟", type: "unit",
          command: "node -e \"console.log(JSON.stringify({testResults:[{assertionResults:[{fullName:'A2 unit smoke',status:'passed'}]}]}))\" -- --reporter=json",
        },
      ],
      contracts: [],
      split: [],
    });
    l.append("EvidenceSubmitted", {
      unitId: "u-1", runId: "run-1", commit, paths: [], sha256: [], exitCode: 0,
    });
  }

  it("从仓库子目录运行 verify → 仓库根解析成功，clone 干净工作区，全链 pass（不再误报 clone 失败）", async () => {
    const repo = join(tmpRoot, "t6-repo");
    const [head] = makeGitRepo(repo, [{ "seed.txt": "seed" }]);
    const sub = join(repo, "pkg", "deep");
    seedVerifyFixture(sub, head);

    const res = await run(["verify", "--unit", "u-1"], sub);
    expect(res.code, `子目录 verify 应 exit 0（stdout: ${res.stdout}，stderr: ${res.stderr}）`).toBe(0);
    expect(res.stdout).toContain("result=pass");
    const runs = new EventLedger(ledgerPath(cwHome, sub)).readAll().filter((e) => e.type === "VerifyRan");
    expect(runs).toHaveLength(1);
    expect((runs[0]?.payload as { result?: string }).result).toBe("pass");
  });

  it("在非 git 目录运行 verify → 环境错误 exit 2，报错含恢复动作（仓库根 / .git 检查指引）", async () => {
    const plain = join(tmpRoot, "t6-not-git");
    seedVerifyFixture(plain, "f".repeat(40));

    const res = await run(["verify", "--unit", "u-1"], plain);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("恢复动作");
    expect(res.stderr).toContain("仓库根");
    expect(res.stderr).toContain(".git");
    // 验证未发生：无 VerifyRan 入账
    expect(new EventLedger(ledgerPath(cwHome, plain)).readAll().filter((e) => e.type === "VerifyRan")).toHaveLength(0);
  });
});

// ── T7 回归锚：marker 扩展是旧合法集的超集 ───────────────────

describe("T7 回归锚：marker 字符集扩展向后兼容 + 既有套件回归", () => {
  it("旧正则 [A-Za-z0-9-]+ 可识别的 marker 行（A1/TC1/a-b/X9）在新正则下全部仍识别（旧 e2e 脚本零改动）", () => {
    for (const id of ["A1", "TC1", "a-b", "X9"]) {
      const { out, status } = runScript(`echo "${id} PASS"\nexit 0`);
      expect(status).toBe(0);
      const report = e2eShAdapter.parse(out, status, e2eAcc(id));
      expect(report.cases, `旧合法形态 "${id} PASS" 应原样识别`).toEqual([
        { id, name: `${id} PASS`, status: "pass" },
      ]);
    }
  });

  it("规则⑦不拦截既有合法 id 形态（u2/u3/u4a/u5 套件 fixture 全部 id 过 gate，回归由 §6 vitest 命令覆盖）", () => {
    const legacyIds = ["A1", "A2", "A3", "M1", "U1", "U9", "AA1", "AB1", "AR1", "R1", "U2", "TC1"];
    const result = checkSpecRules(makeSpec(legacyIds.map(unitItem)));
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("parse 失败落盘不改变判定语义：stderr 仍追加判定原因（既有 fail + reason 行为）", () => {
    const checkoutDir = mkdtempSync(join(tmpRoot, "t7-co"));
    const evidenceBase = mkdtempSync(join(tmpRoot, "t7-ev"));
    const outcome = runAcceptances(
      checkoutDir,
      [{ id: "E1", core: false, title: "非 JSON", type: "unit", command: "echo no-json --reporter=json" }],
      evidenceBase,
      10_000,
    );
    const r = outcome.results[0];
    expect(r?.status).toBe("fail");
    expect(r?.reason).toContain("解析失败");
    expect(readFileSync(r?.stderrPath ?? "", "utf-8")).toContain("解析失败");
    // report.json 是审计增量，不是判定输入：总报告 exitCode 与 cases 判定照旧
    expect(outcome.report.exitCode).toBe(1);
    expect(outcome.report.cases).toEqual([{ id: "E1", name: "非 JSON", status: "fail" }]);
  });
});
