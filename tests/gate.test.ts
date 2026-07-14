/**
 * gate 单测（W3 改造后）。
 *
 * - planCheck：只校验 dev-plan（waves 部分），不再校验 testCases。
 *   - 不含 testCases 的 dev-plan 通过
 *   - 含 testCases 的旧格式也通过（向后兼容）
 *   - waves 为空 → fail
 *   - format/schema 等结构错误 → fail
 * - tddPlanCheck：test.json 校验（mock+real 分层强制 + 模糊值检测），从旧 planCheck 搬过来。
 * - redLightCheck：执行测试命令确认红灯（exit ≠ 0）。
 * - runTestRunner：按 TestRunnerConfig 执行测试，返回 stdout/stderr/exitCode。
 * - P1 devCheck：commit 实际改动文件与 plan changes 对比，输出 extraFiles。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync,mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import {
  clarifyCheck,
  devCheck,
  GitValidator,
  planCheck,
  redLightCheck,
  runTestRunner,
  tddPlanCheck,
} from "../src/gate.js";
import { CwError, type Topic } from "../src/types.js";
import { commitFile,setupGitRepo } from "./helpers/git.js";
import { makeValidClarifyJson, makeValidPlanJson as makePlanJson } from "./helpers/plan.js";

// ── test.json helper（与 plan-parser.test.ts 的 makeValidTestJson 结构一致） ──

function makeValidTestJson(): unknown {
  return {
    testCases: [
      {
        id: "E1",
        layer: "mock",
        scenario: "单测场景",
        steps: "执行单测",
        expected: { text: "expected-output" },
        executor: "vitest",
        requiresScreenshot: false,
      },
      {
        id: "E2",
        layer: "real",
        scenario: "集成场景",
        steps: "执行集成测试",
        expected: { text: "real-output" },
        executor: "vitest",
        requiresScreenshot: false,
      },
    ],
  };
}

// ── 测试环境 ────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-gate-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── planCheck（只校验 dev-plan，waves 部分） ────────────────

describe("planCheck（W3 改造后只校验 dev-plan waves）", () => {
  it("不含 testCases 的 dev-plan → gate pass", () => {
    const devPlan = {
      format: "lite",
      objective: "test obj",
      waves: [{ id: "W1", changes: ["change1"], dependsOn: [] }],
    };
    const result = planCheck(devPlan);
    expect(result.result).toBe("pass");
    expect(result.report).toBe("");
  });

  it("含 testCases 的旧格式 plan.json → gate pass（向后兼容）", () => {
    // 旧版 plan.json 同时含 waves + testCases，planCheck 不再校验 testCases 内容。
    const result = planCheck(makePlanJson());
    expect(result.result).toBe("pass");
    expect(result.report).toBe("");
  });

  it("waves 为空数组 → gate fail", () => {
    const devPlan = {
      format: "lite",
      objective: "test obj",
      waves: [],
    };
    const result = planCheck(devPlan);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("waves");
  });

  it("format 非 lite → gate fail（parseDevPlan 抛错被捕获）", () => {
    const devPlan = { format: "wrong", objective: "obj", waves: [{ id: "W1", changes: ["a"], dependsOn: [] }] };
    const result = planCheck(devPlan);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("format");
  });

  it("非 object → gate fail", () => {
    const result = planCheck("not an object");
    expect(result.result).toBe("fail");
  });

  it("旧格式含模糊 expected.text（如 passed）→ planCheck 仍 pass（testCases 不再被校验）", () => {
    // 关键向后兼容断言：即便 testCases 含模糊值，planCheck 也不报错，
    // 因为这些校验已搬到 tddPlanCheck。
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "passed" },
          executor: "agent",
          requiresScreenshot: false,
        },
        {
          id: "E2",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { text: "ok" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("pass");
  });

  it("旧格式只有 mock 层（缺 real）→ planCheck 仍 pass（分层校验已搬到 tddPlanCheck）", () => {
    const planJson = makePlanJson({
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "具体输出" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    });
    const result = planCheck(planJson);
    expect(result.result).toBe("pass");
  });
});

describe("planCheck 范围守门 warning（杠杆 3）", () => {
  it("waves 数量超过阈值 → pass + warning 含 waves 数量", () => {
    const waves = Array.from({ length: 11 }, (_, i) => ({
      id: `W${i + 1}`,
      changes: [`change ${i + 1}`],
      dependsOn: i > 0 ? [`W${i}`] : [],
    }));
    const devPlan = { format: "lite", objective: "big task", waves };
    const result = planCheck(devPlan);
    expect(result.result).toBe("pass");
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("11");
  });

  it("涉及文件数超过阈值 → pass + warning 含文件数", () => {
    const changes = Array.from({ length: 16 }, (_, i) => `修改 src/file${i + 1}.ts`);
    const devPlan = {
      format: "lite",
      objective: "many files",
      waves: [{ id: "W1", changes, dependsOn: [] }],
    };
    const result = planCheck(devPlan);
    expect(result.result).toBe("pass");
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("16");
  });

  it("范围在阈值内 → pass 无 warning", () => {
    const devPlan = {
      format: "lite",
      objective: "small task",
      waves: [{ id: "W1", changes: ["修改 src/a.ts"], dependsOn: [] }],
    };
    const result = planCheck(devPlan);
    expect(result.result).toBe("pass");
    expect(result.warning).toBeUndefined();
  });
});

// ── tddPlanCheck（test.json 校验） ──────────────────────────

describe("tddPlanCheck 对合法 test.json 返回 pass", () => {
  it("mock + real 各≥1 + 无模糊值 → pass，parsed 返回", () => {
    const result = tddPlanCheck(makeValidTestJson());
    expect(result.result).toBe("pass");
    expect(result.report).toBe("");
    expect(result.parsed).toBeDefined();
    expect(result.parsed!.testCases).toHaveLength(2);
  });
});

describe("tddPlanCheck 对空 testCases 返回 fail", () => {
  it("testCases 为空数组 → fail", () => {
    const result = tddPlanCheck({ testCases: [] });
    expect(result.result).toBe("fail");
    expect(result.report).toContain("testCases");
    expect(result.parsed).toBeUndefined();
  });

  it("test.json 缺 testCases 字段（schema 错）→ fail", () => {
    const result = tddPlanCheck({});
    expect(result.result).toBe("fail");
    expect(result.parsed).toBeUndefined();
  });
});

describe("tddPlanCheck 对缺 mock 或 real 层返回 fail", () => {
  it("只有 mock 层 testCase（缺 real 层）→ fail", () => {
    const testJson = {
      testCases: [
        {
          id: "E1",
          layer: "mock",
          scenario: "s",
          steps: "st",
          expected: { text: "具体输出值" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("real");
  });

  it("只有 real 层 testCase（缺 mock 层）→ fail", () => {
    const testJson = {
      testCases: [
        {
          id: "E1",
          layer: "real",
          scenario: "s",
          steps: "st",
          expected: { text: "具体输出值" },
          executor: "agent",
          requiresScreenshot: false,
        },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("mock");
  });
});

describe("tddPlanCheck 对模糊 expected.text 返回 fail", () => {
  it("expected.text='passed' → fail", () => {
    const testJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "passed" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real out" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("E1");
    expect(result.report).toContain("模糊结论词");
  });

  it("expected.text='OK'（大写）→ fail", () => {
    const testJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "OK" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real out" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("E1");
  });

  it("expected.text='success' → fail", () => {
    const testJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "success" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real out" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
  });

  it("expected.text='成功'（中文）→ fail", () => {
    const testJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "成功" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real out" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
  });

  it("多个 testCase 部分模糊 → fail，报告列出所有模糊 id", () => {
    const testJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "s1", steps: "st", expected: { text: "passed" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "mock", scenario: "s2", steps: "st", expected: { text: "返回 { status: 'ok', data: [1,2,3] }" }, executor: "agent", requiresScreenshot: false },
        { id: "E3", layer: "real", scenario: "s3", steps: "st", expected: { text: "success" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("E1");
    expect(result.report).toContain("E3");
    // E2 不是纯 "ok"，不应出现在报告中
    expect(result.report).not.toContain("E2");
  });

  it("expected.text 含 'ok' 但非纯 'ok' → pass", () => {
    const testJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { text: "status is ok, count=42" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real out" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("pass");
  });

  it("expected 只有 url 无 text → pass（不检查 url）", () => {
    const testJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: { url: "http://localhost:3000" }, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real out" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("pass");
  });
});

describe("tddPlanCheck 对 expected 空判据返回 fail（杠杆 2）", () => {
  it("expected.url 和 text 都缺 → fail，报告列出 testCase id", () => {
    const testJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: {}, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: { text: "real out" }, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("E1");
    expect(result.report).toContain("判据");
    // E2 有 text，不应出现在报告中
    expect(result.report).not.toContain("E2");
  });

  it("多个 testCase 空判据 → fail，报告列出所有空判据 id", () => {
    const testJson = {
      testCases: [
        { id: "E1", layer: "mock", scenario: "s", steps: "st", expected: {}, executor: "agent", requiresScreenshot: false },
        { id: "E2", layer: "real", scenario: "s", steps: "st", expected: {}, executor: "agent", requiresScreenshot: false },
      ],
    };
    const result = tddPlanCheck(testJson);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("E1");
    expect(result.report).toContain("E2");
  });
});

// ── redLightCheck（执行测试命令确认红灯） ───────────────────

describe("redLightCheck", () => {
  it("测试命令退出码 1 → redLight=true（红灯确认）", () => {
    // node -e "process.exit(1)" 立即退出 1，模拟测试失败。
    const result = redLightCheck('node -e "process.exit(1)"', tmpDir);
    expect(result.redLight).toBe(true);
    expect(result.reason).toContain("1");
  });

  it("测试命令退出码 0 → redLight=false（非红灯，TDD 违规）", () => {
    // node -e "process.exit(0)" 退出 0，模拟测试通过。
    const result = redLightCheck('node -e "process.exit(0)"', tmpDir);
    expect(result.redLight).toBe(false);
    expect(result.reason).toContain("意外通过");
  });

  it("测试命令非零退出码（如 2）→ redLight=true", () => {
    const result = redLightCheck('node -e "process.exit(2)"', tmpDir);
    expect(result.redLight).toBe(true);
    expect(result.reason).toContain("2");
  });

  it("命令不存在（spawn error）→ redLight=false + reason", () => {
    // 用一个肯定不存在的命令触发 ENOENT。
    const result = redLightCheck("this-command-definitely-not-exist-xyz-123", tmpDir);
    expect(result.redLight).toBe(false);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason.toLowerCase()).toMatch(/spawn|fail|error/);
  });

  // timeout 分支验证：redLightCheck 的 timeout 是硬编码 30s，真等 30s 会让单测变慢，
  // 所以这里用 it.skip 占位 + 注释说明 timeout 分支的正确预期。
  //
  // timeout 时 execFileSync 抛出异常 status=null（非数字）、killed=true、signal=SIGTERM。
  // 修复前：getExitCode 返回 -1，-1 !== 127（非 ENOENT），被误判成 exit≠0 → redLight=true（BUG）。
  // 修复后：catch 先判 isTimeoutKilled(e.killed===true)，timeout → redLight=false + reason 含 "timeout"。
  //
  // 若要实测，取消下面的 .skip 并等 30s（命令 sleep 35 必然触发 30s timeout）：
  it.skip("timeout（命令超过 30s）→ redLight=false + reason 含 timeout（默认跳过：需等 30s）", () => {
    const result = redLightCheck("sleep 35", tmpDir);
    expect(result.redLight).toBe(false);
    expect(result.reason).toContain("timeout");
  });
});

// ── runTestRunner（按 TestRunnerConfig 执行测试） ───────────

describe("runTestRunner", () => {
  it("nodejs 模式执行 command 并返回 exitCode", () => {
    // 用 echo 模拟测试命令：退出 0，stdout 非空。
    const result = runTestRunner(
      { mode: "nodejs", command: 'node -e "console.log(\'test ok\')"' },
      tmpDir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test ok");
  });

  it("测试命令失败（exit ≠ 0）→ 返回非零 exitCode，不抛错", () => {
    const result = runTestRunner(
      { mode: "nodejs", command: 'node -e "process.exit(3)"' },
      tmpDir,
    );
    expect(result.exitCode).toBe(3);
  });

  it("nodejs 模式缺 command → 抛 CwError", () => {
    expect(() =>
      runTestRunner({ mode: "nodejs" }, tmpDir),
    ).toThrow(CwError);
  });

  it("python 模式执行 command（相对 cwd）", () => {
    // 用 node 代替 python（CI 不一定装 python），验证 cwd 相对路径解析。
    mkdirSync(join(tmpDir, "subdir"), { recursive: true });
    const result = runTestRunner(
      { mode: "python", command: 'node -e "console.log(\'from subdir\')"', cwd: "subdir" },
      tmpDir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("from subdir");
  });

  it("custom 模式用 bash path 执行脚本", () => {
    // 写一个 sh 脚本，用 custom 模式跑。
    const scriptPath = join(tmpDir, "run-tests.sh");
    writeFileSync(scriptPath, '#!/bin/bash\necho "custom runner ok"\nexit 0\n');
    const result = runTestRunner(
      { mode: "custom", path: "run-tests.sh" },
      tmpDir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("custom runner ok");
  });

  it("custom 模式缺 path → 抛 CwError", () => {
    expect(() =>
      runTestRunner({ mode: "custom" }, tmpDir),
    ).toThrow(CwError);
  });

  it("命令本身不存在（spawn ENOENT）→ 抛 CwError", () => {
    // bash 不存在的脚本文件 → 抛 CwError（区别于脚本执行失败的 exit≠0）。
    expect(() =>
      runTestRunner(
        { mode: "custom", path: "nonexistent-script-xyz.sh" },
        tmpDir,
      ),
    ).toThrow(CwError);
  });
});

// ── P1: devCheck 文件覆盖校验 ────────────────────────────────

describe("P1: devCheck 文件覆盖校验", () => {
  let initialCommit: string;
  let validator: GitValidator;

  beforeEach(() => {
    initialCommit = setupGitRepo(tmpDir);
    validator = new GitValidator(tmpDir);
  });

  it("commit 改了 plan 外文件 → extraFiles 包含该文件", () => {
    // plan 只提到 src/app.ts，但 commit 实际改了 src/utils.ts
    const commitHash = commitFile(tmpDir, "src/utils.ts", "export const x = 1;", "add utils");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
      clarifyRecords: [],
      adrs: [],
    };

    const result = devCheck(validator, commitHash, "W1", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeDefined();
    expect(result.extraFiles).toContain("src/utils.ts");
  });

  it("commit 改的文件全在 plan 中 → extraFiles 为空或 undefined", () => {
    // plan 提到 src/app.ts，commit 也只改 src/app.ts
    const commitHash = commitFile(tmpDir, "src/app.ts", "export const app = true;", "add app");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
      clarifyRecords: [],
      adrs: [],
    };

    const result = devCheck(validator, commitHash, "W1", topic);
    expect(result.valid).toBe(true);
    // extraFiles 应为 undefined 或空数组
    if (result.extraFiles !== undefined) {
      expect(result.extraFiles).toHaveLength(0);
    }
  });

  it("commit 同时改了 plan 内和 plan 外文件 → extraFiles 只含 plan 外文件", () => {
    // 先创建 src/app.ts（让它被 tracked）
    commitFile(tmpDir, "src/app.ts", "initial", "add app initial");
    // 第二个 commit 同时改 src/app.ts 和 src/extra.ts
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: tmpDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    writeFileSync(join(tmpDir, "src/app.ts"), "export const app = 2;");
    writeFileSync(join(tmpDir, "src/extra.ts"), "export const extra = true;");
    git(["add", "."]);
    git(["commit", "-m", "modify app + add extra"]);
    const commitHash = git(["rev-parse", "HEAD"]);

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
      clarifyRecords: [],
      adrs: [],
    };

    const result = devCheck(validator, commitHash, "W1", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeDefined();
    expect(result.extraFiles).toContain("src/extra.ts");
    // src/app.ts 在 plan 中，不应出现在 extraFiles
    expect(result.extraFiles).not.toContain("src/app.ts");
  });

  it("waveId 不存在于 topic.waves → extraFiles 不设置（跳过校验）", () => {
    const commitHash = commitFile(tmpDir, "src/new.ts", "export const n = 1;", "add new");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
      clarifyRecords: [],
      adrs: [],
    };

    const result = devCheck(validator, commitHash, "W-nonexistent", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeUndefined();
  });

  it("不传 waveId/topic → 跳过文件覆盖校验（向后兼容）", () => {
    const commitHash = commitFile(tmpDir, "src/any.ts", "export const a = 1;", "add any");

    // 不传 waveId 和 topic，模拟旧版调用
    const result = devCheck(validator, commitHash);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeUndefined();
  });

  it("planData 为空（wave.changes 空数组）→ 跳过文件覆盖校验", () => {
    const commitHash = commitFile(tmpDir, "src/app.ts", "export const x = 1;", "add app");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: [], // 空 changes
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
      clarifyRecords: [],
      adrs: [],
    };

    const result = devCheck(validator, commitHash, "W1", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeUndefined();
  });

  it("plan changes 格式含中文动词 → 正确提取文件路径", () => {
    // plan: "创建 src/store.ts 实现数据持久化"
    // commit 改了 src/store.ts 和 src/config.ts
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: tmpDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/store.ts"), "export const store = {};");
    writeFileSync(join(tmpDir, "src/config.ts"), "export const config = {};");
    git(["add", "."]);
    git(["commit", "-m", "add store and config"]);
    const commitHash = git(["rev-parse", "HEAD"]);

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["创建 src/store.ts 实现数据持久化"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
      clarifyRecords: [],
      adrs: [],
    };

    const result = devCheck(validator, commitHash, "W1", topic);
    expect(result.valid).toBe(true);
    expect(result.extraFiles).toBeDefined();
    expect(result.extraFiles).toContain("src/config.ts");
    expect(result.extraFiles).not.toContain("src/store.ts");
  });

  it("commit 校验不通过（不存在的 hash）→ 不触发文件覆盖校验", () => {
    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: null,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
      clarifyRecords: [],
      adrs: [],
    };

    const result = devCheck(validator, "nonexistent000000000000000000000000000000000000", "W1", topic);
    expect(result.valid).toBe(false);
    expect(result.extraFiles).toBeUndefined();
  });

  it("P1 不影响 valid 判定：有 extraFiles 时 valid 仍为 true（宽松模式）", () => {
    const commitHash = commitFile(tmpDir, "src/extra.ts", "export const x = 1;", "add extra");

    const topic: Topic = {
      topicId: "cw-test",
      slug: "test",
      objective: "test",
      workspacePath: tmpDir,
      topicDir: join(tmpDir, ".xyz-harness/test"),
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "developed",
      waves: [
        {
          id: "W1",
          dependsOn: [],
          committed: initialCommit,
          changes: ["修改 src/app.ts 加功能"],
        },
      ],
      testCases: [],
      gateHistory: [],
      gatePassed: {},
      clarifyRecords: [],
      adrs: [],
    };

    const result = devCheck(validator, commitHash, "W1", topic);
    expect(result.valid).toBe(true); // 宽松模式：有 extraFiles 不 fail
    expect(result.extraFiles).toContain("src/extra.ts");
  });
});

// ── clarifyCheck（clarify gate，结构校验 + ADR projectPath 文件存在） ──

describe("clarifyCheck", () => {
  it("合法 clarifyJson（单条，含 kind/assessment/question）→ pass", () => {
    const result = clarifyCheck(makeValidClarifyJson());
    expect(result.result).toBe("pass");
    expect(result.report).toBe("");
    expect(result.parsed).toBeDefined();
    expect(result.parsed).toHaveLength(1);
  });

  it("合法 clarifyJson（批量数组，2 条）→ pass，parsed.length=2", () => {
    const json = [
      { kind: "requirement", topic: "t1", assessment: "a1", question: "q1?" },
      { kind: "technical", topic: "t2", assessment: "a2", question: "q2?" },
    ];
    const result = clarifyCheck(json);
    expect(result.result).toBe("pass");
    expect(result.parsed).toHaveLength(2);
  });

  it("kind 不在 requirement|technical 范围 → fail", () => {
    const json = makeValidClarifyJson({ kind: "other" });
    const result = clarifyCheck(json);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("kind");
    expect(result.parsed).toBeUndefined();
  });

  // assessment 空串被 schema 拒绝（Type.String({ minLength: 1 })）——禁止空问约束
  it("assessment 为空字符串 → fail（schema minLength:1 约束）", () => {
    const json = makeValidClarifyJson({ assessment: "" });
    const result = clarifyCheck(json);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("assessment");
  });

  it("含 adr 且 adr.projectPath 指向真实存在的文件 → pass", () => {
    // 在 tmpDir 写一个真实的 ADR 文件，projectPath 指向它。
    const adrPath = join(tmpDir, "adr.md");
    writeFileSync(adrPath, "# ADR\n");

    const json = makeValidClarifyJson({
      adr: {
        title: "采用 SQLite 存储方案",
        context: "JSON+flock 并发不足",
        decision: "迁移到 better-sqlite3",
        alternatives: ["维持 JSON"],
        consequences: "引入原生依赖但并发更好",
        projectPath: adrPath,
      },
    });
    const result = clarifyCheck(json);
    expect(result.result).toBe("pass");
    expect(result.parsed).toBeDefined();
    expect(result.parsed![0]!.clarifySeed.adr).toBeDefined();
  });

  it("含 adr 但 adr.projectPath 文件不存在 → fail", () => {
    const json = makeValidClarifyJson({
      adr: {
        title: "ADR",
        context: "ctx",
        decision: "dec",
        alternatives: ["alt"],
        consequences: "cons",
        projectPath: join(tmpDir, "nonexistent-adr.md"),
      },
    });
    const result = clarifyCheck(json);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("文件不存在");
    expect(result.parsed).toBeUndefined();
  });

  it("含 adr 但 adr.projectPath 是目录而非文件 → fail", () => {
    // projectPath 指向 tmpDir（目录），ADR 必须是文件而非目录。
    const json = makeValidClarifyJson({
      adr: {
        title: "ADR",
        context: "ctx",
        decision: "dec",
        alternatives: ["alt"],
        consequences: "cons",
        projectPath: tmpDir,
      },
    });
    const result = clarifyCheck(json);
    expect(result.result).toBe("fail");
    expect(result.report).toContain("目录");
  });
});
