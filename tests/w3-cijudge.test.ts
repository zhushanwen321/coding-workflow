/**
 * W3/T3.1-T3.2：ci-judge flaky 决策树验收（design D7；requirements UC-5 /
 * AC-5.1-5.3；RP-8 dist→src 映射契约；N9 解析失败契约）。
 *
 * 零 mock：真实 tmp git 仓（git init/config/commit/rev-parse/diff 全真实
 * 子进程）；gh 用真实 shell stub 脚本（PATH 外的独立可执行文件，judgeCi 经
 * ghBin 参数直指——脚本记录每次调用、view 分支回放预置日志、rerun 分支
 * exit 0）；tsc 主路径用 symlink 到 cw 仓 node_modules 的真实 typescript，
 * 正则路径 = fixture 无 typescript 依赖（运行时探测失败，D-015 降级）。
 *
 * base 分支时序：fixture 初始 commit 之后才建 stable 分支（branchBase）——
 * 保证 git diff stable..HEAD 只含 PR 变更，fixture 自身文件不污染判定。
 *
 * 用例 → 验收映射：
 *   T3.1-a src-import 触碰闭包 → real-regression（tsc 主路径）   AC-5.1
 *   T3.1-b dist-import 机械映射回 src → 仍 real-regression       AC-5.3 / RP-8
 *   T3.1-c typescript 不可用 → via regex 同结论                   AC-5.3 ①
 *   T3.1-d dist 依赖映射不回 src → 按已触碰（RP-8 宁判回归）      AC-5.3 / RP-8
 *   T3.2-a 未触碰 ∧ 未 rerun → flaky-rerun 恰一次                 AC-5.2
 *   T3.2-b 已 rerun 仍失败 → flaky-escalate 无二次 rerun          AC-5.2
 *   T3.2-c gh 日志解析不出测试文件 → 环境错误含恢复动作（N9）      AC-5.3 / N9
 *   T3.2-d gh 调用失败 → 环境错误含恢复动作                        N9
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildClosure,
  CiJudgeEnvironmentError,
  judgeCi,
} from "../src/gate/ci-judge.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-w3-cijudge-"));
/** cw 仓根（typescript symlink 源） */
const cwRepoRoot = fileURLToPath(new URL("..", import.meta.url));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── git 夹具（对照 tests/rp0-gate-core.test.ts 的 initRepo 模式） ───────────

function gitRun(dir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

interface Repo {
  repoDir: string;
  /** 稳定 base 分支名（git diff prBase..HEAD 的基线锚） */
  baseRef: string;
  /** 在当前 HEAD 建 base 分支（调用时机 = fixture 初始 commit 之后，让 diff 只含 PR 变更） */
  branchBase(): void;
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
  return {
    repoDir,
    baseRef,
    branchBase: () => {
      gitRun(repoDir, ["branch", baseRef]);
    },
    head: () => gitRun(repoDir, ["rev-parse", "HEAD"]),
    commit(path, content): string {
      const abs = join(repoDir, path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
      gitRun(repoDir, ["add", "-A"]);
      gitRun(repoDir, ["commit", "-m", `touch ${path}`]);
      return gitRun(repoDir, ["rev-parse", "HEAD"]);
    },
  };
}

/** fixture 的最小 tsconfig（tsc 主路径 resolveModuleName 的 Node16 解析所需） */
const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: { module: "Node16", moduleResolution: "Node16" },
});

function writeFixtureFile(repoDir: string, rel: string, content: string): void {
  const abs = join(repoDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

/** symlink 真实 typescript 进 fixture（tsc 主路径探测成功；非 mock——真实包） */
function linkTypescript(repoDir: string): void {
  mkdirSync(join(repoDir, "node_modules"), { recursive: true });
  symlinkSync(
    resolve(cwRepoRoot, "node_modules", "typescript"),
    join(repoDir, "node_modules", "typescript"),
    "dir",
  );
}

// ─── gh stub（真实 shell 脚本：记录调用 + view 回放日志 + rerun exit 0） ─────

let stubCounter = 0;

interface GhStub {
  bin: string;
  /** stub 被调用的 argv 行（按调用序） */
  calls(): string[];
}

function makeGhStub(
  dir: string,
  options: { viewOutput?: string; viewExitCode?: number },
): GhStub {
  stubCounter += 1;
  const callLog = join(dir, `gh-stub-${stubCounter}.calls`);
  const bin = join(dir, `gh-stub-${stubCounter}.sh`);
  const lines = [
    "#!/bin/bash",
    `echo "$*" >> ${JSON.stringify(callLog)}`,
    `if [ "$1 $2" = "run view" ]; then`,
  ];
  if (options.viewOutput !== undefined) {
    lines.push("cat <<'CW_GH_EOF'", options.viewOutput, "CW_GH_EOF");
  }
  lines.push(
    `  exit ${options.viewExitCode ?? 0}`,
    "fi",
    'if [ "$1 $2" = "run rerun" ]; then exit 0; fi',
    'echo "gh-stub: unexpected invocation: $*" >&2',
    "exit 1",
  );
  writeFileSync(bin, `${lines.join("\n")}\n`);
  chmodSync(bin, 0o755);
  return {
    bin,
    calls(): string[] {
      if (!existsSync(callLog)) return [];
      return readFileSync(callLog, "utf-8").split("\n").filter((line) => line !== "");
    },
  };
}

/** 常见 gh 失败日志行（vitest/jest 的 `FAIL <path>` 形态，带 job 前缀） */
function failedTestLog(testRelPath: string): string {
  return [
    "job1\t2026-01-01T00:00:00Z\tsetting up",
    `job1\t2026-01-01T00:00:01Z\tFAIL ${testRelPath} > suite > case`,
    `job1\t2026-01-01T00:00:02Z\tError: expected 3 to be 4`,
    "",
  ].join("\n");
}

// ─── T3.1 真回归三形态 + RP-8 不可映射形态 ──────────────────────────────────

describe("W3/T3.1 ci-judge 真回归判定（AC-5.1 / AC-5.3 / RP-8）", () => {
  it("T3.1-a: src-import fixture 改被测模块 → real-regression + 归属证据链（tsc 主路径）", () => {
    const repo = initRepo("t31a-src-import");
    writeFixtureFile(repo.repoDir, "package.json", '{"name":"fixture-t31a","private":true}');
    writeFixtureFile(repo.repoDir, "tsconfig.json", FIXTURE_TSCONFIG);
    writeFixtureFile(
      repo.repoDir,
      "src/math.ts",
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    writeFixtureFile(
      repo.repoDir,
      "tests/math.test.ts",
      'import { add } from "../src/math.js";\n\nif (add(1, 2) !== 3) throw new Error("boom");\n',
    );
    repo.commit("src/bootstrap.txt", "init fixture");
    repo.branchBase();
    linkTypescript(repo.repoDir);
    // PR：改被测模块（闭包成员被触碰）
    repo.commit(
      "src/math.ts",
      "export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n",
    );

    // 闭包主路径：真实 typescript 解析，via = tsc
    const closure = buildClosure("tests/math.test.ts", { cwd: repo.repoDir });
    expect(closure.via).toBe("tsc");
    expect(closure.files).toContain("src/math.ts");
    expect(closure.files).toContain("tests/math.test.ts");
    expect(closure.unmappableDist).toEqual([]);

    const stub = makeGhStub(repo.repoDir, { viewOutput: failedTestLog("tests/math.test.ts") });
    const judgement = judgeCi({
      cwd: repo.repoDir,
      runId: "901",
      prBase: repo.baseRef,
      ghBin: stub.bin,
    });

    expect(judgement.kind).toBe("real-regression");
    if (judgement.kind !== "real-regression") return;
    expect(judgement.touchedFiles).toContain("src/math.ts");
    expect(judgement.affectedTests).toContain("tests/math.test.ts");
    expect(judgement.evidence.some((line) => line.includes("src/math.ts"))).toBe(true);
    expect(judgement.evidence.some((line) => line.includes("../src/math.js"))).toBe(true);
    expect(judgement.rerunExecuted).toBe(false);
    expect(stub.calls().filter((call) => call.startsWith("run rerun"))).toHaveLength(0);
  });

  it("T3.1-b: dist-import fixture 改 src 模块 → 机械映射回 src 仍判 real-regression", () => {
    const repo = initRepo("t31b-dist-import");
    writeFixtureFile(repo.repoDir, "package.json", '{"name":"fixture-t31b","private":true}');
    writeFixtureFile(repo.repoDir, "tsconfig.json", FIXTURE_TSCONFIG);
    writeFixtureFile(
      repo.repoDir,
      "src/math.ts",
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    // 编译产物真实存在（import 解析锚点）；映射目标是 src/math.ts
    writeFixtureFile(
      repo.repoDir,
      "dist/math.js",
      '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n',
    );
    writeFixtureFile(
      repo.repoDir,
      "tests/dist.test.ts",
      'import { add } from "../dist/math.js";\n\nif (add(1, 2) !== 3) throw new Error("boom");\n',
    );
    repo.commit("src/bootstrap.txt", "init fixture");
    repo.branchBase();
    linkTypescript(repo.repoDir);
    // PR：只改 src（GP4 关键发现 2：dist import 属 build 级联，须映射回 src 归属）
    repo.commit(
      "src/math.ts",
      "export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n",
    );

    const closure = buildClosure("tests/dist.test.ts", { cwd: repo.repoDir });
    expect(closure.via).toBe("tsc");
    expect(closure.files).toContain("src/math.ts"); // dist/math.js 已映射为 src/math.ts
    expect(closure.files).not.toContain("dist/math.js");
    expect(closure.unmappableDist).toEqual([]);

    const stub = makeGhStub(repo.repoDir, { viewOutput: failedTestLog("tests/dist.test.ts") });
    const judgement = judgeCi({
      cwd: repo.repoDir,
      runId: "902",
      prBase: repo.baseRef,
      ghBin: stub.bin,
    });

    expect(judgement.kind).toBe("real-regression");
    if (judgement.kind !== "real-regression") return;
    expect(judgement.touchedFiles).toContain("src/math.ts");
    expect(judgement.rerunExecuted).toBe(false);
  });

  it("T3.1-c: fixture 无 typescript（运行时探测失败）→ via regex 同判 real-regression", () => {
    const repo = initRepo("t31c-regex-fallback");
    writeFixtureFile(repo.repoDir, "package.json", '{"name":"fixture-t31c","private":true}');
    writeFixtureFile(repo.repoDir, "tsconfig.json", FIXTURE_TSCONFIG);
    writeFixtureFile(
      repo.repoDir,
      "src/math.ts",
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    writeFixtureFile(
      repo.repoDir,
      "tests/math.test.ts",
      'import { add } from "../src/math.js";\n\nif (add(1, 2) !== 3) throw new Error("boom");\n',
    );
    repo.commit("src/bootstrap.txt", "init fixture");
    repo.branchBase();
    // fixture 不 link typescript：createRequire 探测失败 → D-015 正则兜底
    repo.commit(
      "src/math.ts",
      "export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n",
    );

    const closure = buildClosure("tests/math.test.ts", { cwd: repo.repoDir });
    expect(closure.via).toBe("regex");
    expect(closure.files).toContain("src/math.ts"); // 正则路径 .js 剥后缀试 .ts 同样命中

    const stub = makeGhStub(repo.repoDir, { viewOutput: failedTestLog("tests/math.test.ts") });
    const judgement = judgeCi({
      cwd: repo.repoDir,
      runId: "903",
      prBase: repo.baseRef,
      ghBin: stub.bin,
    });

    expect(judgement.kind).toBe("real-regression");
    if (judgement.kind !== "real-regression") return;
    expect(judgement.touchedFiles).toContain("src/math.ts");
    expect(judgement.rerunExecuted).toBe(false);
  });

  it("T3.1-d: dist 依赖映射不回 src → 按已触碰判 real-regression（RP-8 宁判回归不假 flaky）", () => {
    const repo = initRepo("t31d-unmappable-dist");
    writeFixtureFile(repo.repoDir, "package.json", '{"name":"fixture-t31d","private":true}');
    writeFixtureFile(
      repo.repoDir,
      "src/util.ts",
      "export const util = 1;\n",
    );
    // orphan.js 只有 dist 产物、无 src 源文件 → 机械映射必然失败
    writeFixtureFile(repo.repoDir, "dist/orphan.js", '"use strict";\nmodule.exports = {};\n');
    writeFixtureFile(
      repo.repoDir,
      "tests/orphan.test.ts",
      'import { anything } from "../dist/orphan.js";\n',
    );
    repo.commit("src/bootstrap.txt", "init fixture");
    repo.branchBase();
    // PR 只改闭包外文件（若无 RP-8 契约会误判 flaky）
    repo.commit("docs/readme.md", "# unrelated change\n");

    const closure = buildClosure("tests/orphan.test.ts", { cwd: repo.repoDir });
    expect(closure.unmappableDist).toContain("dist/orphan.js");

    const stub = makeGhStub(repo.repoDir, { viewOutput: failedTestLog("tests/orphan.test.ts") });
    const judgement = judgeCi({
      cwd: repo.repoDir,
      runId: "904",
      prBase: repo.baseRef,
      ghBin: stub.bin,
    });

    expect(judgement.kind).toBe("real-regression");
    if (judgement.kind !== "real-regression") return;
    expect(judgement.touchedFiles).toContain("dist/orphan.js");
    expect(judgement.evidence.some((line) => line.includes("无法映射回 src"))).toBe(true);
    expect(judgement.rerunExecuted).toBe(false);
    expect(stub.calls().filter((call) => call.startsWith("run rerun"))).toHaveLength(0);
  });
});

// ─── T3.2 flaky 三形态（rerun 恰一次 / escalate / N9 环境错误） ──────────────

/** flaky 夹具：失败测试闭包与 PR 变更无交集（PR 只改 docs/） */
function setupFlakyRepo(name: string): Repo {
  const repo = initRepo(name);
  writeFixtureFile(repo.repoDir, "package.json", `{"name":"fixture-${name}","private":true}`);
  writeFixtureFile(repo.repoDir, "tsconfig.json", FIXTURE_TSCONFIG);
  writeFixtureFile(repo.repoDir, "src/util.ts", "export const util = 1;\n");
  writeFixtureFile(
    repo.repoDir,
    "tests/flaky.test.ts",
    'import { util } from "../src/util.js";\n\nif (util !== 1) throw new Error("boom");\n',
  );
  repo.commit("src/bootstrap.txt", "init fixture");
  repo.branchBase();
  repo.commit("docs/readme.md", "# unrelated change\n");
  return repo;
}

describe("W3/T3.2 ci-judge flaky 决策树（AC-5.2 / N9）", () => {
  it("T3.2-a: 闭包与 PR 无交集 ∧ 未 rerun → flaky-rerun 且 rerun 恰一次", () => {
    const repo = setupFlakyRepo("t32a-rerun-once");
    const stub = makeGhStub(repo.repoDir, { viewOutput: failedTestLog("tests/flaky.test.ts") });

    const judgement = judgeCi({
      cwd: repo.repoDir,
      runId: "905",
      prBase: repo.baseRef,
      ghBin: stub.bin,
    });

    expect(judgement.kind).toBe("flaky-rerun");
    expect(judgement.rerunExecuted).toBe(true);
    expect(judgement.affectedTests).toContain("tests/flaky.test.ts");
    expect(judgement.evidence.some((line) => line.includes("run rerun 905 --failed"))).toBe(true);
    const rerunCalls = stub.calls().filter((call) => call.startsWith("run rerun"));
    expect(rerunCalls).toEqual(["run rerun 905 --failed"]); // 恰一次
    expect(stub.calls().filter((call) => call.startsWith("run view"))).toHaveLength(1);
  });

  it("T3.2-b: alreadyRerun=true（二轮仍失败）→ flaky-escalate 出声转人工、不再 rerun", () => {
    const repo = setupFlakyRepo("t32b-escalate");
    const stub = makeGhStub(repo.repoDir, { viewOutput: failedTestLog("tests/flaky.test.ts") });

    const judgement = judgeCi({
      cwd: repo.repoDir,
      runId: "906",
      prBase: repo.baseRef,
      ghBin: stub.bin,
      alreadyRerun: true,
    });

    expect(judgement.kind).toBe("flaky-escalate");
    expect(judgement.rerunExecuted).toBe(false);
    expect(judgement.evidence.some((line) => line.includes("转人工"))).toBe(true);
    expect(stub.calls().filter((call) => call.startsWith("run rerun"))).toHaveLength(0);
  });

  it("T3.2-c: gh 日志解析不出测试文件行 → 环境错误含恢复动作（N9 不误判 flaky/回归）", () => {
    const repo = setupFlakyRepo("t32c-parse-failure");
    const stub = makeGhStub(repo.repoDir, {
      viewOutput: "some random CI noise\nnothing parseable here\nexit code 1\n",
    });

    let thrown: unknown;
    try {
      judgeCi({ cwd: repo.repoDir, runId: "907", prBase: repo.baseRef, ghBin: stub.bin });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CiJudgeEnvironmentError);
    expect((thrown as Error).message).toContain("恢复动作");
    expect((thrown as Error).message).toContain("N9");
    expect(stub.calls().filter((call) => call.startsWith("run rerun"))).toHaveLength(0);
  });

  it("T3.2-d: gh 调用失败（非零退出）→ 环境错误含恢复动作", () => {
    const repo = setupFlakyRepo("t32d-gh-failure");
    const stub = makeGhStub(repo.repoDir, { viewExitCode: 1 });

    let thrown: unknown;
    try {
      judgeCi({ cwd: repo.repoDir, runId: "908", prBase: repo.baseRef, ghBin: stub.bin });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CiJudgeEnvironmentError);
    expect((thrown as Error).message).toContain("恢复动作");
    expect(stub.calls().filter((call) => call.startsWith("run rerun"))).toHaveLength(0);
  });
});
