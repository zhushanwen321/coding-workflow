/**
 * u4a E2E（真实子进程跑 dist/cli.js + tmp git 仓库 + 隔离 CW_HOME，零 mock）。
 *
 * 对应 docs/rewrite/acceptance/u4a-acceptance.md「E2E real」三条：
 *   1. 带挂用例的全链 create → spec → build → review → verify：exit 1、VerifyRan
 *      (result=fail) 且 acceptanceIds 含 pass 与 manual、不含 fail；
 *   2. 修好（全过命令重新提交 spec+evidence+review）→ verify exit 0 → cw status
 *      显示 verified——四 unit（u1 账本 / u2 写命令 / u3 gate / u4a verify）端到端
 *      首个全链场景；
 *   3. P2 同 commit 两次 verify → report.json 的 cases 与 exitCode 逐字段全等
 *      （runId/rawPath 目录不同不作比对）。
 *
 * u4b 判定升级适配（验收文档 E2E 条款允许，理由逐条见各 spec 版本注释）：
 *   - e2e 用例的「过/挂」改由标记行 <验收id原文> (PASS|FAIL) 表达（第一列 =
 *     验收 id 全文，不要求任何前缀；exit code 不再是判定输入）；
 *   - unit 型用例 v1 用非 vitest 兼容命令覆盖 parse 抛错路径（原「缺 command」
 *     语义已迁移给 e2e-sh translate 防线），v2/v3 用本仓库 vitest bin 绝对路径
 *     跑真实测试（干净 checkout 无 node_modules，npx 解析不确定）。
 *
 * P7（checkout 干净性）在 verify 结束时已清理临时目录，按验收文档 fallback 转为
 * tests/u4a-verify.test.ts 验收1 的 porcelain 断言，本文件不重复。
 *
 * 注意：直接 `npx vitest run tests/u4a-e2e.test.ts` 不触发 pretest，需先 `npm run build`
 * （`npm test` 的 pretest 已含 build）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { EventLedger } from "../src/store/events-log.js";
import { evidenceDir, ledgerPath } from "../src/store/project.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 干净 checkout 无 node_modules：vitest 以绝对路径启动（u4b 探针已验证可跑） */
const VITEST_BIN = join(REPO_ROOT, "node_modules", ".bin", "vitest");
const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u4a-e2e-"));
const cwHome = join(tmpRoot, "cw-home");
// 子进程 process.cwd() 返回物理路径（macOS 上 /var 是 /private/var 的符号链接），
// 父进程账本/evidence 路径计算必须用同一物理路径，否则 encodeCwd 结果不一致
mkdirSync(join(tmpRoot, "repo"), { recursive: true });
const repoDir = realpathSync(join(tmpRoot, "repo"));
const ledgerFile = ledgerPath(cwHome, repoDir);
const UNIT = "u-chain";

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function gitRun(args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实子进程跑 dist/cli.js；cwd = tmp git 仓库，CW_HOME 隔离（env 显式传入） */
function runCli(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

interface VerifyRanFact {
  runId: string;
  result: string;
  acceptanceIds: string[];
}

function verifyRans(): VerifyRanFact[] {
  return new EventLedger(ledgerFile)
    .readAll()
    .filter((e) => e.type === "VerifyRan" && e.payload.unitId === UNIT)
    .map((e) => {
      const p = e.payload as { runId: string; result: string; acceptanceIds: string[] };
      return { runId: p.runId, result: p.result, acceptanceIds: p.acceptanceIds };
    });
}

interface ReportFact {
  exitCode: number;
  cases: Array<{ id: string; name: string; status: string }>;
}

function reportOf(runId: string): ReportFact {
  return JSON.parse(readFileSync(join(evidenceDir(cwHome, repoDir, UNIT, runId), "report.json"), "utf-8")) as ReportFact;
}

/** 写 spec.json（u4b 适配：v1 含真挂与 vitest 不兼容用例；v2 全过；v3 含 sleep 2 超时用例）并提交为一个新 commit */
function writeSpec(version: 1 | 2 | 3): string {
  const acceptance =
    version === 1
      ? [
          // 标记行 PASS = 过；FAIL + exit 1 = 真挂（u4b：exit code 不再是判定输入）
          { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: `node -e "console.log('A1 PASS')"` },
          {
            id: "A2",
            core: true,
            title: "核心链路挂掉时的表现",
            type: "e2e-real",
            command: `node -e "console.log('A2 FAIL'); process.exit(1)"`,
          },
          { id: "M1", core: false, title: "人工抽检记录", type: "manual" },
          // 原「unit 缺 command」在 u4b 后走 vitest 默认全量命令（不可控），改用
          // 非 vitest 兼容命令锁定「parse 抛错 → fail + 兼容命令提示」路径
          { id: "A3", core: false, title: "单元行为", type: "unit", command: "echo no-json" },
        ]
      : version === 2
        ? [
            { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: `node -e "console.log('A1 PASS')"` },
            { id: "A2", core: true, title: "核心链路挂掉时的表现", type: "e2e-real", command: `node -e "console.log('A2 PASS')"` },
            { id: "M1", core: false, title: "人工抽检记录", type: "manual" },
            // unit 型要过新判定：command 产出 vitest JSON 且测试名含 A3（fixture 随首 commit 提交）
            { id: "A3", core: false, title: "单元行为", type: "unit", command: `"${VITEST_BIN}" run` },
          ]
        : [
            // v3：sleep 2 在默认 10min 下会 pass、在 --timeout-ms 500 下必超时——锁死 CLI flag 真实生效
            { id: "A1", core: true, title: "超时回收链路", type: "e2e-real", command: "sleep 2" },
            // u4b 适配：--timeout-ms 是整轮 verify 的全局超时，真 vitest 启动（秒级）
            // 在 500ms 下必被 kill；改用静态 vitest JSON fixture 命令锁「pass 的条目
            // 进 acceptanceIds」语义。JSON 值内嵌 "--reporter=json" 字符串——translate
            // 的 includes 检查判「已含 flag」不追加（追加会污染 echo 输出破坏 JSON）
            {
              id: "A3",
              core: false,
              title: "单元行为",
              type: "unit",
              command:
                'echo \'{"note":"--reporter=json","numTotalTests":1,' +
                '"testResults":[{"assertionResults":[{"fullName":"A3 单元行为","status":"passed"}]}]}\'',
            },
          ];
  writeFileSync(join(repoDir, "spec.json"), JSON.stringify({ acceptance, contracts: [], split: [] }));
  gitRun(["add", "-A"]);
  gitRun(["commit", "-m", `spec-v${version}`]);
  return gitRun(["rev-parse", "HEAD"]);
}

describe("E2E real：verify 全链（create → spec → build → review → verify → 修好 → verified → P2）", () => {
  it("第一轮：含挂用例与 vitest 不兼容用例 → verify exit 1，VerifyRan(fail) 的 acceptanceIds 含 pass+manual、不含 fail", () => {
    gitRun(["init"]);
    gitRun(["config", "user.email", "cw-e2e@example.com"]);
    gitRun(["config", "user.name", "cw-e2e"]);
    // 首个 commit：任务书 + unit 型用例 vitest 运行所需的最小项目（测试名含 A3，
    // 供 v2/v3 的 A3 判定 pass；无 node_modules，vitest 从本仓库绝对路径启动）
    writeFileSync(join(repoDir, "brief.md"), "# 任务书\n");
    writeFileSync(join(repoDir, "package.json"), '{ "name": "fixture", "private": true, "type": "module" }\n');
    mkdirSync(join(repoDir, "tests"), { recursive: true });
    writeFileSync(
      join(repoDir, "tests", "acceptances.test.ts"),
      'import { describe, expect, it } from "vitest";\n\n' +
        'describe("验收", () => {\n' +
        '  it("A3 单元行为", () => {\n    expect(1 + 1).toBe(2);\n  });\n' +
        "});\n",
    );
    gitRun(["add", "-A"]);
    gitRun(["commit", "-m", "baseline"]);
    const head1 = writeSpec(1);
    expect(head1).toMatch(/^[0-9a-f]{40}$/);

    expect(runCli(["create", "--id", UNIT, "--brief", "brief.md"]).code).toBe(0);
    expect(runCli(["evidence", "submit", "--kind", "spec", "--unit", UNIT, "--file", "spec.json"]).code).toBe(0);
    expect(
      runCli(["evidence", "submit", "--kind", "build", "--unit", UNIT, "--commit", head1, "--run-id", "run-1"]).code,
    ).toBe(0);
    expect(
      runCli(["review", "submit", "--unit", UNIT, "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code,
    ).toBe(0);

    const verify = runCli(["verify", "--unit", UNIT]);
    expect(verify.code, `含挂用例应 exit 1（stderr: ${verify.stderr}）`).toBe(1);
    // stdout 摘要逐条 + 总结（manual 并行显示）
    expect(verify.stdout).toContain("A1 pass");
    expect(verify.stdout).toContain("A2 fail");
    expect(verify.stdout).toContain("M1 manual");
    expect(verify.stdout).toContain("A3 fail");
    expect(verify.stdout).toContain("result=fail");
    // stderr 列失败 id 与原因（A2 标记 FAIL / A3 非 vitest 兼容命令）
    expect(verify.stderr).toContain("A2");
    expect(verify.stderr).toContain("A3");
    expect(verify.stderr).toContain("vitest 兼容命令");

    const runs = verifyRans();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe("fail");
    expect(runs[0]?.acceptanceIds).toEqual(["A1", "M1"]);

    // 产物落盘：report.json + 失败条的 stderr 产物（A3 的 parse 失败原因与恢复提示）
    const report = reportOf(runs[0]?.runId ?? "");
    expect(report.exitCode).toBe(1);
    expect(report.cases.map((c) => [c.id, c.status])).toEqual([
      ["A1", "pass"],
      ["A2", "fail"],
      ["A3", "fail"],
    ]);
    expect(readFileSync(join(evidenceDir(cwHome, repoDir, UNIT, runs[0]?.runId ?? ""), "A3.stderr"), "utf-8")).toContain(
      "vitest 兼容命令",
    );
  });

  it("修好后：重提 spec+build+review → verify exit 0 + VerifyRan(pass)，cw status 显示 verified", () => {
    const head2 = writeSpec(2);
    expect(runCli(["evidence", "submit", "--kind", "spec", "--unit", UNIT, "--file", "spec.json"]).code).toBe(0);
    expect(
      runCli(["evidence", "submit", "--kind", "build", "--unit", UNIT, "--commit", head2, "--run-id", "run-2"]).code,
    ).toBe(0);
    expect(
      runCli(["review", "submit", "--unit", UNIT, "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code,
    ).toBe(0);

    // rv-4 语义迁移：本 fixture 的验收命令是内联恒真形态（不引用实现产物），
    // 红阶段默认执行下无区分力必挂——u4a 的关注点（常规验证链路 + 状态推进）
    // 用 --no-red-phase 逃生口保持原语义；红阶段行为由 rv4/u4b 系测试覆盖
    const verify = runCli(["verify", "--unit", UNIT, "--no-red-phase"]);
    expect(verify.code, `全过应 exit 0（stderr: ${verify.stderr}）`).toBe(0);
    expect(verify.stdout).toContain("result=pass");
    expect(verify.stdout).toContain("M1 manual");

    const runs = verifyRans();
    expect(runs).toHaveLength(2);
    expect(runs[1]?.result).toBe("pass");
    // acceptanceIds = 机器 pass 的 ∪ manual 的，覆盖新 spec 全部验收 id
    expect(runs[1]?.acceptanceIds.sort()).toEqual(["A1", "A2", "A3", "M1"]);

    // 四 unit 端到端：fold + gate 派生出 verified（真实子进程 cw status）
    const status = runCli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(new RegExp(`${UNIT}\\s+verified`));
    expect(status.stdout).toContain("lastVerify:pass");
  });

  it("P2：同 commit 连续两次 verify → report.json 的 cases 与 exitCode 逐字段全等", () => {
    // rv-4 语义迁移：同上——恒真 fixture 用 --no-red-phase 逃生口（P2 锁定的
    // 幂等重跑语义与红阶段无关；redPhase 节的幂等由 rv4 测试覆盖）
    const v1 = runCli(["verify", "--unit", UNIT, "--no-red-phase"]);
    const v2 = runCli(["verify", "--unit", UNIT, "--no-red-phase"]);
    expect(v1.code).toBe(0);
    expect(v2.code).toBe(0);

    const runs = verifyRans();
    expect(runs).toHaveLength(4);
    const [third, fourth] = runs.slice(2);
    expect(third?.runId).not.toBe(fourth?.runId); // runId 唯一性（产物目录天然不同）

    const r1 = reportOf(third?.runId ?? "");
    const r2 = reportOf(fourth?.runId ?? "");
    // P2 锁定比对字段：cases（id/name/status）与 exitCode；runId/rawPath 不比对
    expect(r2.cases).toEqual(r1.cases);
    expect(r2.exitCode).toBe(r1.exitCode);
    expect(r1.exitCode).toBe(0);
  });

  it("--timeout-ms 500 真实子进程：sleep 2 验收 → exit 1 + .timeout 产物标记 + VerifyRan(fail)", () => {
    const head3 = writeSpec(3);
    expect(runCli(["evidence", "submit", "--kind", "spec", "--unit", UNIT, "--file", "spec.json"]).code).toBe(0);
    expect(
      runCli(["evidence", "submit", "--kind", "build", "--unit", UNIT, "--commit", head3, "--run-id", "run-3"]).code,
    ).toBe(0);
    expect(
      runCli(["review", "submit", "--unit", UNIT, "--verdict-kind", "spec-review", "--verdict", "pass", "--role", "reviewer"]).code,
    ).toBe(0);

    // minimist 把 "500" 解析为 number——修复前该值被 stringArg 丢弃、静默回退 600000ms，
    // sleep 2 判 pass（exit 0）；本用例锁定 flag 数字形态真实生效
    const verify = runCli(["verify", "--unit", UNIT, "--timeout-ms", "500"]);
    expect(verify.code, `sleep 2 在 500ms 上限下应超时 fail（stdout: ${verify.stdout}）`).toBe(1);
    expect(verify.stdout).toContain("A1 fail");
    expect(verify.stdout).toContain("result=fail");
    expect(verify.stderr).toContain("超时");

    const runs = verifyRans();
    expect(runs).toHaveLength(5);
    expect(runs[4]?.result).toBe("fail");
    expect(runs[4]?.acceptanceIds).toEqual(["A3"]); // 超时的 A1 不进 acceptanceIds

    const marker = join(evidenceDir(cwHome, repoDir, UNIT, runs[4]?.runId ?? ""), "A1.timeout");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf-8")).toContain("timed out");
  });
});
