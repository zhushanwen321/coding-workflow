/**
 * al-2：AcceptanceItem.layer 层级轴——纯声明模型层（零行为变化）。
 *
 * 条款逐条对应 docs/rewrite/acceptance/al-2-acceptance.md §5（L1-L7）：
 *   L1 schema 合法值入账 / L2 schema 非法值拒 / L3 缺省不写键 /
 *   L4 旧账本重放兼容 / L5 带 layer 账本只读健康 / L6 执行行为不变（D2）/
 *   L7 类型层编译锁定。
 *
 * 真实环境零 mock：真实子进程跑 dist/cli.js（完整 dispatch 路径）+ tmp git 仓库
 * + 隔离 CW_HOME。直接 `npx vitest run tests/al-2-layer-model.test.ts` 不触发
 * pretest，需先 `npm run build`（`npm test` 的 pretest 已含 build）。
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceLayer, SpecSubmittedPayload, VerifyRanPayload } from "../src/events/types.js";
import { validateSpecFile } from "../src/handlers/spec-schema.js";
import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), "cw-al2-"));
const cwHome = join(tmpRoot, "cw-home");
// 子进程 process.cwd() 返回物理路径（macOS 上 /var 是 /private/var 的符号链接），
// 父进程账本路径计算必须用同一物理路径，否则 encodeCwd 结果不一致、账本"消失"
mkdirSync(cwHome, { recursive: true });

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── L7 编译锁定锚（tsc 编译本文件 = 类型漂移哨兵） ──────────────

/** 运行时枚举值集合——须与 AcceptanceLayer 联合双向逐字符一致 */
const LAYER_VALUES = ["unit", "topic"] as const;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;
type ExpectTrue<T extends true> = T;
/**
 * AcceptanceLayer 若增删枚举值，本别名编译失败（npm run check:tests 编译 tests/）
 * ——「枚举独立类型 + schema 与领域类型同源」的测试期哨兵（al-2 验收 §4 形状锁定
 * 第 1/2 点）。运行时侧的同源断言见 L7 用例。
 */
export type AssertLayerEnumExact = ExpectTrue<Equal<(typeof LAYER_VALUES)[number], AcceptanceLayer>>;

// ── 共享夹具（真实 git 仓库 + 真实子进程 CLI） ──────────────────

function git(repoDir: string, args: readonly string[]): void {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
}

/** 真实 tmp git 仓库：init + 单 commit 写入一批文件（无父 commit → verify 红阶段合法跳过）；返回物理路径与 HEAD */
function makeRepo(name: string, files: Record<string, string>): { repoDir: string; head: string } {
  const raw = join(tmpRoot, name);
  mkdirSync(raw, { recursive: true });
  const repoDir = realpathSync(raw);
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.email", "cw-al2@example.com"]);
  git(repoDir, ["config", "user.name", "cw-al2"]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repoDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "seed"]);
  const head = (
    spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ?? ""
  ).trim();
  return { repoDir, head };
}

/** 真实子进程跑 dist/cli.js；cwd = tmp git 仓库，CW_HOME 隔离（env 显式传入） */
function runCli(
  repoDir: string,
  args: readonly string[],
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function ledgerLineCount(repoDir: string): number {
  try {
    return readFileSync(ledgerPath(cwHome, repoDir), "utf-8")
      .split("\n")
      .filter((l) => l !== "").length;
  } catch {
    return 0; // 账本尚未创建 = 0 行
  }
}

/** 账本内最后一条 SpecSubmitted 的 payload（schema 校验通过后按 Static 类型直读入账） */
function lastSpecOf(repoDir: string): SpecSubmittedPayload {
  const events = new EventLedger(ledgerPath(cwHome, repoDir)).readAll();
  const specEvent = [...events].reverse().find((e) => e.type === "SpecSubmitted");
  if (specEvent === undefined) {
    throw new Error("账本内无 SpecSubmitted 事件");
  }
  return specEvent.payload as SpecSubmittedPayload;
}

function verifyRanOf(repoDir: string, unitId: string): VerifyRanPayload[] {
  return new EventLedger(ledgerPath(cwHome, repoDir))
    .readAll()
    .filter((e) => e.type === "VerifyRan")
    .map((e) => e.payload as VerifyRanPayload)
    .filter((p) => p.unitId === unitId);
}

/** status --json 输出的消费侧形状（Map → 数组后的结构化投影） */
interface StatusJsonShape {
  units: Array<{
    unitId: string;
    status: string;
    specs: Array<{ acceptance: Array<Record<string, unknown>> }>;
  }>;
  totalEvents: number;
}

/** 建 unit + 提 spec + spec-review pass（终态 spec-frozen）的最小真实链。
 * splitChildId（可选）：spec 含 layer: "topic" 条目时按规则⑩要求先建子并让
 * spec.split 声明它（al-3 起叶子/无子形态的 topic 条目在 gate 被拒）。 */
function freezeUnit(repoDir: string, unitId: string, specFile: string, splitChildId?: string): void {
  const created = runCli(repoDir, ["create", "--id", unitId, "--brief", "brief.md"]);
  expect(created.code, created.stderr).toBe(0);
  if (splitChildId !== undefined) {
    const child = runCli(repoDir, ["create", "--id", splitChildId, "--brief", "brief.md", "--parent", unitId]);
    expect(child.code, child.stderr).toBe(0);
  }
  const submitted = runCli(repoDir, [
    "evidence",
    "submit",
    "--kind",
    "spec",
    "--unit",
    unitId,
    "--file",
    specFile,
  ]);
  expect(submitted.code, submitted.stderr).toBe(0);
  const reviewed = runCli(repoDir, [
    "review",
    "submit",
    "--unit",
    unitId,
    "--verdict-kind",
    "spec-review",
    "--verdict",
    "pass",
    "--role",
    "reviewer",
  ]);
  expect(reviewed.code, reviewed.stderr).toBe(0);
}

// ── L1：schema 合法值入账 ─────────────────────────────────────

describe("L1：schema 合法值入账", () => {
  it('L1 含 layer: "topic" 与 "unit" 两条验收的合法 spec → exit 0 入账，末事件 acceptance 条目各含 layer 键且值正确', () => {
    const { repoDir } = makeRepo("l1", {
      "brief.md": "# 任务书\n",
      "spec.json": JSON.stringify({
        acceptance: [
          { id: "A1", core: true, title: "核心链路", type: "e2e-real", command: "node -v", layer: "unit" },
          { id: "T1", core: false, title: "回归上收", type: "e2e-real", command: "node -v", layer: "topic" },
          { id: "A2", core: false, title: "单元行为", type: "unit" },
        ],
        contracts: [],
        // al-3 规则⑩：topic 条目要求 split 非空——夹具按 root+子已建形态构造
        //（主 agent 2026-08-22 授权的最小修订，layer 键入账断言语义不变）
        split: [{ unitId: "u-l1-leaf", dependsOn: [] }],
      }),
    });

    expect(runCli(repoDir, ["create", "--id", "u-l1", "--brief", "brief.md"]).code).toBe(0);
    // fx-3 R5.1：split 声明的子必须先 cw create 入账
    expect(
      runCli(repoDir, ["create", "--id", "u-l1-leaf", "--brief", "brief.md", "--parent", "u-l1"]).code,
    ).toBe(0);
    const submit = runCli(repoDir, [
      "evidence",
      "submit",
      "--kind",
      "spec",
      "--unit",
      "u-l1",
      "--file",
      "spec.json",
    ]);
    expect(submit.code, `spec 提交应 exit 0（stderr: ${submit.stderr}）`).toBe(0);

    const spec = lastSpecOf(repoDir);
    const byId = new Map(spec.acceptance.map((ac) => [ac.id, ac]));
    expect(byId.get("A1")?.layer).toBe("unit");
    expect(byId.get("T1")?.layer).toBe("topic");
    // 未声明条目不被注入缺省字面量（缺省靠键缺失表达，L3 的集合内预检）
    expect(Object.hasOwn(byId.get("A2") ?? {}, "layer")).toBe(false);
  });
});

// ── L2：schema 非法值拒 ───────────────────────────────────────

describe("L2：schema 非法值拒", () => {
  it('L2 layer: "root" → exit 1 错误含 /acceptance/0/layer；layer: 123 → exit 1 错误含 /acceptance/1/layer；账本不增', () => {
    const { repoDir } = makeRepo("l2", {
      "brief.md": "# 任务书\n",
      "spec-bad-str.json": JSON.stringify({
        acceptance: [{ id: "A1", core: false, title: "坏层级", type: "unit", layer: "root" }],
        contracts: [],
        split: [],
      }),
      "spec-bad-num.json": JSON.stringify({
        acceptance: [
          { id: "A1", core: false, title: "合法条目", type: "unit" },
          { id: "A2", core: false, title: "数值层级", type: "unit", layer: 123 },
        ],
        contracts: [],
        split: [],
      }),
    });
    expect(runCli(repoDir, ["create", "--id", "u-l2", "--brief", "brief.md"]).code).toBe(0);

    const badStr = runCli(repoDir, [
      "evidence",
      "submit",
      "--kind",
      "spec",
      "--unit",
      "u-l2",
      "--file",
      "spec-bad-str.json",
    ]);
    expect(badStr.code).toBe(1);
    expect(badStr.stderr).toContain("/acceptance/0/layer");

    const badNum = runCli(repoDir, [
      "evidence",
      "submit",
      "--kind",
      "spec",
      "--unit",
      "u-l2",
      "--file",
      "spec-bad-num.json",
    ]);
    expect(badNum.code).toBe(1);
    expect(badNum.stderr).toContain("/acceptance/1/layer");

    // 两次坏提交均不入账：账本仍仅 UnitCreated 一条
    expect(ledgerLineCount(repoDir)).toBe(1);
  });
});

// ── L3：缺省不写键 ────────────────────────────────────────────

describe("L3：缺省不写键", () => {
  it("L3 不带 layer 的既有形态 spec → 入账 payload 的 acceptance 条目无 layer 键（不是 layer: \"unit\" 字面量——缺省语义靠 absence 表达）", () => {
    const { repoDir } = makeRepo("l3", {
      "brief.md": "# 任务书\n",
      "spec.json": JSON.stringify({
        acceptance: [
          { id: "A1", core: true, title: "核心链路", type: "e2e-real", command: "node -v" },
          { id: "A2", core: false, title: "单元行为", type: "unit" },
        ],
        contracts: [],
        split: [],
      }),
    });
    expect(runCli(repoDir, ["create", "--id", "u-l3", "--brief", "brief.md"]).code).toBe(0);
    const submit = runCli(repoDir, [
      "evidence",
      "submit",
      "--kind",
      "spec",
      "--unit",
      "u-l3",
      "--file",
      "spec.json",
    ]);
    expect(submit.code, `spec 提交应 exit 0（stderr: ${submit.stderr}）`).toBe(0);

    const spec = lastSpecOf(repoDir);
    expect(spec.acceptance).toHaveLength(2);
    for (const ac of spec.acceptance) {
      expect(Object.hasOwn(ac, "layer")).toBe(false);
    }
    // 入账序列化形态锁定：原始 JSONL 的 SpecSubmitted 行不含 layer 键
    const specLine = readFileSync(ledgerPath(cwHome, repoDir), "utf-8")
      .split("\n")
      .filter((l) => l !== "")
      .find((l) => l.includes("\"SpecSubmitted\""));
    expect(specLine).toBeDefined();
    expect(specLine).not.toContain("layer");
  });
});

// ── L4：旧账本重放兼容 ────────────────────────────────────────

describe("L4：旧账本重放兼容", () => {
  it("L4 无 layer 字段的真实事件流 → status / status --json / tree / report 关键字段与基线一致、零 layer 泄漏、重放输出逐字节稳定", () => {
    const { repoDir } = makeRepo("l4", {
      "brief.md": "# 任务书\n",
      "spec.json": JSON.stringify({
        acceptance: [
          { id: "A1", core: true, title: "核心链路", type: "e2e-real", command: "node -v" },
          { id: "A2", core: false, title: "单元行为", type: "unit" },
        ],
        contracts: [],
        split: [],
      }),
    });
    freezeUnit(repoDir, "u-l4", "spec.json");

    // 前提：账本是「无 layer 字段」的真实事件流（create → spec → review 共 3 条）
    expect(ledgerLineCount(repoDir)).toBe(3);
    expect(readFileSync(ledgerPath(cwHome, repoDir), "utf-8")).not.toContain("layer");

    // status（人可读）：unit 状态 = spec-frozen（改造前口径，fold 不读 layer）
    const status = runCli(repoDir, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("spec-frozen");

    // status --json：unit 状态 / 验收源数据 / 事件数（结构化全字段中的关键字段）
    const statusJson = runCli(repoDir, ["status", "--json"]);
    expect(statusJson.code).toBe(0);
    const parsed = JSON.parse(statusJson.stdout) as StatusJsonShape;
    expect(parsed.totalEvents).toBe(3);
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]?.unitId).toBe("u-l4");
    expect(parsed.units[0]?.status).toBe("spec-frozen");
    const acceptance = parsed.units[0]?.specs[0]?.acceptance ?? [];
    expect(acceptance).toHaveLength(2);
    for (const ac of acceptance) {
      expect(Object.hasOwn(ac, "layer")).toBe(false);
    }

    // 重放确定性：同一命令重跑输出逐字节一致
    const statusJsonAgain = runCli(repoDir, ["status", "--json"]);
    expect(statusJsonAgain.stdout).toBe(statusJson.stdout);

    // tree：分解树形态不变
    const tree = runCli(repoDir, ["tree"]);
    expect(tree.code).toBe(0);
    expect(tree.stdout).toContain("u-l4 (spec-frozen)");

    // report：验收覆盖标记（未 verify → 全 ✗，改造前口径）
    const report = runCli(repoDir, ["report"]);
    expect(report.code).toBe(0);
    expect(report.stdout).toContain("A1 e2e-real [core] ✗");
    expect(report.stdout).toContain("A2 unit ✗");
  });
});

// ── L5：带 layer 账本只读健康 ─────────────────────────────────

describe("L5：带 layer 账本只读健康", () => {
  it("L5 带 layer 账本跑 status / status --json / tree / report → 正常输出零崩溃，spec-frozen 与改造前同形态，layer 键原样透传", () => {
    const { repoDir } = makeRepo("l5", {
      "brief.md": "# 任务书\n",
      "spec.json": JSON.stringify({
        acceptance: [
          { id: "A1", core: true, title: "核心链路", type: "e2e-real", command: "node -v", layer: "unit" },
          { id: "T1", core: false, title: "回归上收", type: "e2e-real", command: "node -v", layer: "topic" },
          { id: "A2", core: false, title: "单元行为", type: "unit" },
        ],
        contracts: [],
        // al-3 规则⑩：topic 条目要求 split 非空（夹具同步修订，见 L1 注）
        split: [{ unitId: "u-l5-leaf", dependsOn: [] }],
      }),
    });
    freezeUnit(repoDir, "u-l5", "spec.json", "u-l5-leaf");

    // status --json：spec-frozen 状态与 L4 无 layer 账本同形态（fold 不读 layer）。
    // 账本含 split 子 u-l5-leaf（规则⑩要求的 root 形态），按 unitId 定位断言
    const statusJson = runCli(repoDir, ["status", "--json"]);
    expect(statusJson.code).toBe(0);
    const parsed = JSON.parse(statusJson.stdout) as StatusJsonShape;
    const uL5 = parsed.units.find((u) => u.unitId === "u-l5");
    expect(uL5?.status).toBe("spec-frozen");
    // layer 键原样透传（声明在账在，未声明不注入）
    const acceptance = uL5?.specs[0]?.acceptance ?? [];
    expect(acceptance.find((ac) => ac["id"] === "A1")?.["layer"]).toBe("unit");
    expect(acceptance.find((ac) => ac["id"] === "T1")?.["layer"]).toBe("topic");
    expect(Object.hasOwn(acceptance.find((ac) => ac["id"] === "A2") ?? {}, "layer")).toBe(false);

    // 人可读三命令全部 exit 0 零崩溃
    const status = runCli(repoDir, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("spec-frozen");

    const tree = runCli(repoDir, ["tree"]);
    expect(tree.code).toBe(0);
    expect(tree.stdout).toContain("u-l5 (spec-frozen)");

    const report = runCli(repoDir, ["report"]);
    expect(report.code).toBe(0);
    expect(report.stdout).toContain("T1 e2e-real ✗");
  });
});

// ── L6：执行行为不变（D2 结构性验证） ─────────────────────────

describe("L6：执行行为不变（D2 结构性验证）", () => {
  it(
    'L6 含 layer: "topic" 条目的 spec 跑 cw verify → 该条目照常执行（e2e-sh 标记行 pass、产物在场）且与无 layer 同命令 spec 逐结果一致',
    { timeout: 120_000 },
    () => {
      // e2e-sh 适配器契约：command 产物须含标记行 ^<id> (PASS|FAIL)$（设计 D1a 形态一）
      const { repoDir, head } = makeRepo("l6", {
        "brief.md": "# 任务书\n",
        "scripts/a1.sh": 'echo "A1 PASS"\n',
        "scripts/t1.sh": 'echo "T1 PASS"\n',
        "spec-topic.json": JSON.stringify({
          acceptance: [
            // 规则⑤需要一条 type: "unit" 用例；runner 显式声明 e2e-sh 让它走标记行契约
            { id: "A1", core: false, title: "单元行为", type: "unit", runner: "e2e-sh", command: "sh scripts/a1.sh" },
            // al-3 规则⑩：topic 条目要求 split 非空——u-6a 按 root+子已建形态构造
            //（夹具同步修订，主 agent 2026-08-22 授权；手动 cw verify 对内部节点
            //  照常全价执行 topic 条目，设计 D2 的既有语义，L6 验证点不变）
            { id: "T1", core: false, title: "topic 回归", type: "e2e-real", command: "sh scripts/t1.sh", layer: "topic" },
          ],
          contracts: [],
          split: [{ unitId: "u-6a-leaf", dependsOn: [] }],
        }),
        "spec-plain.json": JSON.stringify({
          acceptance: [
            { id: "A1", core: false, title: "单元行为", type: "unit", runner: "e2e-sh", command: "sh scripts/a1.sh" },
            { id: "T1", core: false, title: "topic 回归", type: "e2e-real", command: "sh scripts/t1.sh" },
          ],
          contracts: [],
          split: [],
        }),
      });

      // 两个同命令 spec 的 unit：spec 层差异 = T1 条目带不带 layer；u-6a 因规则⑩
      // 须为 root（split 子先入账，fx-3 R5.1），u-6b 保持叶子（无 topic 条目不受影响）
      for (const unitId of ["u-6a", "u-6b"]) {
        expect(runCli(repoDir, ["create", "--id", unitId, "--brief", "brief.md"]).code).toBe(0);
      }
      expect(runCli(repoDir, ["create", "--id", "u-6a-leaf", "--brief", "brief.md", "--parent", "u-6a"]).code).toBe(0);
      const specFiles: Array<[string, string]> = [
        ["u-6a", "spec-topic.json"],
        ["u-6b", "spec-plain.json"],
      ];
      for (const [unitId, specFile] of specFiles) {
        const submitted = runCli(repoDir, [
          "evidence",
          "submit",
          "--kind",
          "spec",
          "--unit",
          unitId,
          "--file",
          specFile,
        ]);
        expect(submitted.code, submitted.stderr).toBe(0);
        const built = runCli(repoDir, [
          "evidence",
          "submit",
          "--kind",
          "build",
          "--unit",
          unitId,
          "--commit",
          head,
          "--run-id",
          `build-${unitId}`,
        ]);
        expect(built.code, built.stderr).toBe(0);
      }

      // verify（build commit 为仓库首提交 → 红阶段合法跳过，不引入红阶段差异）
      const verifyA = runCli(repoDir, ["verify", "--unit", "u-6a"]);
      const verifyB = runCli(repoDir, ["verify", "--unit", "u-6b"]);

      // 逐结果一致：两份 stdout 的逐验收判定行完全相同（该字段不改变任何执行器行为）
      const verdictLinesOf = (out: string): string[] =>
        out.split("\n").filter((l) => /^(A1|T1) (pass|fail|manual)$/.test(l));
      expect(verifyA.code, verifyA.stderr).toBe(0);
      expect(verifyB.code, verifyB.stderr).toBe(0);
      expect(verifyA.stdout).toContain("result=pass");
      expect(verifyB.stdout).toContain("result=pass");
      expect(verdictLinesOf(verifyA.stdout)).toEqual(["A1 pass", "T1 pass"]);
      expect(verdictLinesOf(verifyB.stdout)).toEqual(verdictLinesOf(verifyA.stdout));

      // 入账逐结果一致：result 与 acceptanceIds（topic 条目照常执行并进 pass 集）
      const ranA = verifyRanOf(repoDir, "u-6a");
      const ranB = verifyRanOf(repoDir, "u-6b");
      expect(ranA).toHaveLength(1);
      expect(ranB).toHaveLength(1);
      expect(ranA[0]?.result).toBe("pass");
      expect(ranA[0]?.acceptanceIds).toEqual(["A1", "T1"]);
      expect(ranB[0]?.result).toBe(ranA[0]?.result);
      expect(ranB[0]?.acceptanceIds).toEqual(ranA[0]?.acceptanceIds);

      // topic 条目执行产物在场且含标记行（「照常执行」的产物级实证）
      const t1StdoutPath = join(
        evidenceDir(cwHome, repoDir, "u-6a", ranA[0]?.runId ?? ""),
        "T1.stdout",
      );
      expect(readFileSync(t1StdoutPath, "utf-8")).toContain("T1 PASS");
    },
  );
});

// ── L7：类型层编译锁定 ────────────────────────────────────────

/** 构造只含一条带任意 layer 值条目的 spec 数据（L7 的 schema 同源探针） */
function specFileWithLayer(layer: unknown): unknown {
  return {
    acceptance: [{ id: "A1", core: false, title: "探针", type: "unit", layer }],
    contracts: [],
    split: [],
  };
}

describe("L7：类型层编译锁定", () => {
  it("L7 AcceptanceLayer 联合恰为 unit|topic（编译期 Equal 断言随本文件被 check:tests 编译）；schema Union Literals 与类型常量同源（运行时逐值探针）", () => {
    // 编译期：文件顶部的 AssertLayerEnumExact 在 AcceptanceLayer 增删枚举值时编译失败
    // 运行时：每个合法值过 schema、联合外值被拒——schema literals 与类型常量同源
    for (const v of LAYER_VALUES) {
      const validation = validateSpecFile(specFileWithLayer(v));
      expect(validation.ok, `layer=${v} 应通过 schema`).toBe(true);
    }
    expect(validateSpecFile(specFileWithLayer("root")).ok).toBe(false);
    expect(validateSpecFile(specFileWithLayer(123)).ok).toBe(false);
  });
});
