/**
 * plan gate 文件存在性校验 — TDD 红灯测试（topicId: cw-2026-07-17-plan-file-existence-gate）。
 *
 * 验证 13 AC：planCheck 加文件存在性校验 + WaveChange 加 action 字段。
 *
 * 红灯原因（当前实现缺什么）：
 *   - WaveChange 无 action 字段（src/types.ts:193），DevPlanSchema 不认 action（src/plan-parser.ts:47）
 *   - planCheck 只有 2 参（src/gate.ts:195），无 workspacePath，无 existsSync 存在性校验
 *   - handleReplan 不调 planCheck（src/actions.ts:2467）
 *   - migrateChanges 不补默认 action（src/store.ts:91）
 *
 * W1（types+schema+74 fixture 加 action）+ W2（planCheck 第3参+存在性校验+handlePlan 接线）
 * + W3（handleReplan 调 planCheck + migrateChanges 补默认 modify）实现后，本测试转绿。
 *
 * 类型断言说明：
 *   - WaveChange.action 字段 W1 后才存在于类型定义。vitest 用 esbuild 转译不 typecheck，
 *     所以 fixture 直接写字面量 `{file, action, description}` 运行时能透传。
 *   - planCheck 第3参 workspacePath W2 后已加入签名，直接 planCheck(plan, undefined, workspace) 调用。
 *
 * 测试规范（AGENTS.md）：
 *   - 零 mock 框架：真实 fs（mkdtempSync/writeFileSync/mkdirSync）+ 真实 dispatch + 真实 git
 *   - 禁 any：用 unknown 双断言或 2 参调用
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/legacy/dispatch.js";
import { GitValidator, planCheck } from "../src/legacy/gate.js";
import { CwStore } from "../src/legacy/store.js";
import type { ActionDeps } from "../src/legacy/types.js";
import { commitFile,setupGitRepo } from "./helpers/git.js";

// ── fixture 构造（changes 带 action——W1 起 action 是 WaveChange 必填字段） ──

type Action = "create" | "modify" | "delete";

/** 构造一条带 action 的 change（action 自 W1 起为 WaveChange 必填字段，字面量直接被类型认）。 */
function ch(file: string, action: Action, description = "change"): {
  file: string;
  action: Action;
  description: string;
} {
  return { file, action, description };
}

/** 构造 dev-plan（单 wave W1）。 */
function plan(changes: ReturnType<typeof ch>[]): {
  format: "lite";
  objective: string;
  waves: Array<{ id: string; changes: ReturnType<typeof ch>[]; dependsOn: string[] }>;
} {
  return {
    format: "lite",
    objective: "existence-gate-test",
    waves: [{ id: "W1", changes, dependsOn: [] }],
  };
}

// ── 测试环境 ────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cw-plan-exist-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════
// AC-1/2/3/4: 按 action 校验存在性
// ════════════════════════════════════════════════════════════════

describe("AC-1/2/3/4: planCheck 按 action 校验文件存在性", () => {
  it("AC-1 modify 的 file 不存在 → fail，report 含文件名", () => {
    // 建一个存在的文件，ghost 不存在。modify ghost 应 fail。
    writeFileSync(join(tmpDir, "exists.txt"), "x");
    const r = planCheck(
      plan([ch("exists.txt", "modify"), ch("ghost.ts", "modify")]),
      undefined,
      tmpDir,
    );
    expect(r.result).toBe("fail");
    expect(r.report).toContain("ghost.ts");
  });

  it("AC-2 delete 的 file 不存在 → fail", () => {
    const r = planCheck(plan([ch("ghost.ts", "delete")]), undefined, tmpDir);
    expect(r.result).toBe("fail");
  });

  it("AC-3 create 的 file 已存在 → fail，report 含文件名", () => {
    writeFileSync(join(tmpDir, "exists.txt"), "x");
    const r = planCheck(plan([ch("exists.txt", "create")]), undefined, tmpDir);
    expect(r.result).toBe("fail");
    expect(r.report).toContain("exists.txt");
  });

  it("AC-4 全合法（modify 存在 + create 不存在）→ pass", () => {
    writeFileSync(join(tmpDir, "modify.txt"), "x");
    const r = planCheck(
      plan([ch("modify.txt", "modify"), ch("new.ts", "create")]),
      undefined,
      tmpDir,
    );
    expect(r.result).toBe("pass");
  });

  it("AC-4 delete 存在的文件 → pass", () => {
    writeFileSync(join(tmpDir, "to-delete.txt"), "x");
    const r = planCheck(plan([ch("to-delete.txt", "delete")]), undefined, tmpDir);
    expect(r.result).toBe("pass");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-3.4/AC-3.6/AC-8: 边界（create 命中目录 / .. 越界 action 无关）
// ════════════════════════════════════════════════════════════════

describe("AC-3.4/AC-3.6/AC-8: 边界与越界", () => {
  it("AC-3.4 create 命中已存在目录 → fail（目录算已存在）", () => {
    mkdirSync(join(tmpDir, "subdir"));
    const r = planCheck(plan([ch("subdir", "create")]), undefined, tmpDir);
    expect(r.result).toBe("fail");
  });

  it("AC-3.6/AC-8 file 含 .. 越界 + action=modify → fail（无论 action 都 fail）", () => {
    // 关键：越界拒绝必须 action 无关。modify 若按"存在性"逻辑会因 ../../etc/passwd 不存在
    // 而 fail（巧合通过），但 AC-3.6 要求的是 pathResolve 越界前置过滤。
    // 即便 ../../etc/passwd 真实存在（如 /etc/passwd），越界也要 fail。
    const r = planCheck(plan([ch("../../etc/passwd", "modify")]), undefined, tmpDir);
    expect(r.result).toBe("fail");
  });

  it("AC-3.6/AC-8 file 含 .. 越界 + action=create → fail（无论 action 都 fail）", () => {
    // 反向锚定：create 若按"存在性"逻辑会因 ../../etc/passwd 不存在而 pass（巧合通过），
    // AC-3.6 要求越界无论 action 都 fail。这条测试防 create 漏过越界检查。
    const r = planCheck(plan([ch("../../etc/passwd", "create")]), undefined, tmpDir);
    expect(r.result).toBe("fail");
  });

  it("AC-3.6/AC-8 file 含 .. 越界 + action=delete → fail（无论 action 都 fail）", () => {
    const r = planCheck(plan([ch("../../etc/passwd", "delete")]), undefined, tmpDir);
    expect(r.result).toBe("fail");
  });

  it("AC-8 非顶层 .. 越界（foo/../../../etc/passwd）→ fail（必须 resolve 而非 startsWith）", () => {
    // 字符串 startsWith('..') 抓不到 "foo/../../etc"。必须 path.resolve 后再判前缀。
    const r = planCheck(
      plan([ch("foo/../../../etc/passwd", "modify")]),
      undefined,
      tmpDir,
    );
    expect(r.result).toBe("fail");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-5/AC-1.2: action 缺失 / 非法值 schema 拒
// ════════════════════════════════════════════════════════════════

describe("AC-5/AC-1.2: action 字段 schema 校验", () => {
  it("AC-5 change 缺 action 字段 → schema 拒（planCheck fail，report 含 schema 错）", () => {
    // 旧格式 change 只有 {file, description}，W1 schema 加 action 必填后应被拒。
    const oldPlan = {
      format: "lite",
      objective: "old format",
      waves: [
        { id: "W1", changes: [{ file: "src/app.ts", description: "change1" }], dependsOn: [] },
      ],
    };
    const r = planCheck(oldPlan, undefined, tmpDir);
    expect(r.result).toBe("fail");
    // schema 错误消息应含 action 或 changes 字段路径。
    expect(r.report.toLowerCase()).toMatch(/action|changes/);
  });

  it("AC-1.2 action 大写 'MODIFY' → schema 拒（literal union 大小写敏感）", () => {
    // typebox Type.Union([Literal('create'),Literal('modify'),Literal('delete')])
    // 对 'MODIFY' 应拒绝（literal 精确匹配）。
    const badPlan = {
      format: "lite",
      objective: "bad action",
      waves: [
        {
          id: "W1",
          changes: [{ file: "src/app.ts", action: "MODIFY", description: "x" }],
          dependsOn: [],
        },
      ],
    };
    const r = planCheck(badPlan, undefined, tmpDir);
    expect(r.result).toBe("fail");
  });

  it("AC-1.2 action 非法值 'update' → schema 拒", () => {
    const badPlan = {
      format: "lite",
      objective: "bad action",
      waves: [
        {
          id: "W1",
          changes: [{ file: "src/app.ts", action: "update", description: "x" }],
          dependsOn: [],
        },
      ],
    };
    const r = planCheck(badPlan, undefined, tmpDir);
    expect(r.result).toBe("fail");
  });

  it("AC-1.2 合法 action 小写 'modify' → schema 通过（不因 schema 拒）", () => {
    // 反面回归：合法小写 action 不应被 schema 拒。文件不存在会因存在性 fail，
    // 但 report 应点出"不存在"而非 schema 错——这条区分 schema 通过 vs 存在性 fail。
    writeFileSync(join(tmpDir, "real.ts"), "x");
    const r = planCheck(plan([ch("real.ts", "modify")]), undefined, tmpDir);
    expect(r.result).toBe("pass");
  });
});

// ════════════════════════════════════════════════════════════════
// AC-6: replan 含幽灵文件 → throw（FR-4/FR-4a）
// ════════════════════════════════════════════════════════════════

describe("AC-6: replan 新增 wave 含幽灵文件 → throw 含文件名", () => {
  // 通用：把 topic 推进到 developed（W1 committed），用于测 replan 新增 wave。
  function setupDevTopicWithW1(): { topicId: string; deps: ActionDeps; store: CwStore } {
    const dbPath = join(tmpDir, "cw.json");
    const store = new CwStore(dbPath);
    const git = new GitValidator(tmpDir);
    const deps: ActionDeps = { store, git, workspacePath: tmpDir };
    const initialCommit = setupGitRepo(tmpDir);

    const createResult = dispatch(
      { action: "create", slug: "replan-exist", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    // confirm_clarify gate
    store.updateStatus(topicId, "clarify_confirmed");
    store.updateGatePassed(topicId, "confirm_clarify", true);
    // spec_review gate
    store.updateStatus(topicId, "spec_reviewed");
    store.updateGatePassed(topicId, "spec_review", true);

    // plan：W1 含一个真实存在的文件（commit 后落地）。
    commitFile(tmpDir, "src/app.ts", "export const app = 1;", "add app");
    const w1Plan = {
      format: "lite",
      objective: "obj",
      waves: [
        {
          id: "W1",
          changes: [{ file: "src/app.ts", action: "modify", description: "改 app" }],
          dependsOn: [],
        },
      ],
    };
    dispatch({ action: "plan", topicId, planJson: w1Plan }, deps);
    // plan_review gate
    store.updateStatus(topicId, "plan_reviewed");
    store.updateGatePassed(topicId, "plan_review", true);
    // tdd_plan gate
    store.insertTestCases(topicId, [
      {
        id: "E1",
        layer: "mock",
        scenario: "s",
        steps: "st",
        expected: { type: "exact", text: "expected-output" },
        executor: "vitest",
        requiresScreenshot: false,
      },
      {
        id: "E2",
        layer: "real",
        scenario: "s",
        steps: "st",
        expected: { type: "exact", text: "real-output" },
        executor: "vitest",
        requiresScreenshot: false,
      },
    ]);
    store.updateStatus(topicId, "pre_dev_verified");
    store.updateGatePassed(topicId, "tdd_plan", true);

    // dev：commit W1（用初始 commit 即可，文件已存在）。
    dispatch(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: initialCommit }] },
      deps,
    );

    return { topicId, deps, store };
  }

  it("replan 追加 W2（modify 幽灵文件 ghost.ts）→ throw 含 ghost.ts", () => {
    const { topicId, deps } = setupDevTopicWithW1();
    // W2 是新增未 committed wave，modify 一个不存在的 ghost.ts → 应被 planCheck 拦。
    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [
        {
          id: "W1",
          changes: [{ file: "src/app.ts", action: "modify", description: "改 app" }],
          dependsOn: [],
        },
        {
          id: "W2",
          changes: [{ file: "ghost.ts", action: "modify", description: "改 ghost" }],
          dependsOn: ["W1"],
        },
      ],
    };
    expect(() => dispatch({ action: "replan", topicId, planJson: newPlan }, deps)).toThrow(
      /ghost\.ts/,
    );
  });

  it("replan 追加 W2（全合法：modify 存在 + create 不存在）→ 不 throw", () => {
    const { topicId, deps } = setupDevTopicWithW1();
    const newPlan = {
      format: "lite",
      objective: "obj",
      waves: [
        {
          id: "W1",
          changes: [{ file: "src/app.ts", action: "modify", description: "改 app" }],
          dependsOn: [],
        },
        {
          id: "W2",
          changes: [
            { file: "src/app.ts", action: "modify", description: "再改 app" },
            { file: "src/new.ts", action: "create", description: "新建 new" },
          ],
          dependsOn: ["W1"],
        },
      ],
    };
    expect(() => dispatch({ action: "replan", topicId, planJson: newPlan }, deps)).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// AC-7: 存量 committed wave 缺 action 经 migrateChanges 补 modify，validateAppendOnly 不误判
// ════════════════════════════════════════════════════════════════

describe("AC-7: 存量 committed wave（旧格式无 action）经 migrateChanges 补默认 modify，不被 append-only 误判", () => {
  // 这组测试用 raw-JSON-write 模式直接操纵 _cw.json（照 store.test.ts:1176-1206 的 Artifacts
  // 迁移测试写法），绕过 plan gate（plan gate 会因 W1 schema action 必填而拒绝旧格式 plan），
  // 把一个真实的旧格式 committed wave 植入 store。这样 migrateChanges 对象分支才被真正触发，
  // 而非空洞通过（旧版测试 dispatch({action:"plan", oldFormatPlan}) 在 plan gate 就 fail，
  // topic.waves 始终空，.not.toThrow() 空洞通过，掩盖了 R1 键序 bug）。
  //
  // 复用模式：新建 topic → 直接改磁盘 _cw.json 写入旧格式 committed wave → 新 CwStore 实例 reload。

  /** 把 topic 的 waves 改成旧格式 committed wave（changes 无 action 字段），写回磁盘。 */
  function writeLegacyCommittedWave(
    dbPath: string,
    topicId: string,
    initialCommit: string,
  ): void {
    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      waves: Array<Record<string, unknown>>;
    };
    // 直接在顶层 waves 数组 push 一条旧格式 committed wave。
    // changes 写成 {file, description}（无 action），模拟 pre-W1 存量数据。
    // committed 设为 initialCommit，模拟已落地 wave。
    raw.waves.push({
      topicId,
      id: "W1",
      dependsOn: [],
      committed: initialCommit,
      changes: [{ file: "src/app.ts", description: "改 app" }],
    });
    writeFileSync(dbPath, JSON.stringify(raw));
  }

  it("migrateChanges 对象分支：缺 action 补 modify 且键序 file→action→description（R1/R5）", () => {
    const dbPath = join(tmpDir, "cw.json");
    const store = new CwStore(dbPath);
    const git = new GitValidator(tmpDir);
    const deps: ActionDeps = { store, git, workspacePath: tmpDir };
    const initialCommit = setupGitRepo(tmpDir);

    const createResult = dispatch(
      { action: "create", slug: "mig-test-keys", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    writeLegacyCommittedWave(dbPath, topicId, initialCommit);

    // 新实例 reload（绕过内存缓存，强制从磁盘读旧格式）。
    const reloaded = new CwStore(dbPath);
    const topic = reloaded.loadTopic(topicId);
    expect(topic).not.toBeNull();
    expect(topic!.waves).toHaveLength(1);
    const wave = topic!.waves[0]!;
    expect(wave.committed).toBe(initialCommit);

    // R1 核心：migrateChanges 补的 action 值是 modify。
    const change = wave.changes[0]!;
    expect(change.action).toBe("modify");
    expect(change.file).toBe("src/app.ts");
    expect(change.description).toBe("改 app");

    // R1 核心：键序必须是 file→action→description（与 WaveChange 接口、DevPlanSchema 一致）。
    // spread {...c, action} 会得到 file→description→action（键序错）。
    expect(Object.keys(change)).toEqual(["file", "action", "description"]);

    // R1 核心：经 migrate 后的 stringify 必须与新格式 plan 的 stringify 相等
    // （validateAppendOnly 用 JSON.stringify 比对，键序敏感）。
    const newPlanChange = { file: "src/app.ts", action: "modify", description: "改 app" };
    expect(JSON.stringify(change)).toBe(JSON.stringify(newPlanChange));
  });

  it("migrateChanges 对象分支：有 action 原样保留且键序稳定（R5）", () => {
    const dbPath = join(tmpDir, "cw.json");
    const store = new CwStore(dbPath);
    const git = new GitValidator(tmpDir);
    const deps: ActionDeps = { store, git, workspacePath: tmpDir };
    const initialCommit = setupGitRepo(tmpDir);

    const createResult = dispatch(
      { action: "create", slug: "mig-test-keep", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;

    // 这条 wave 的 changes 已带 action:'create'，migrateChanges 应原样保留（不覆盖成 modify）。
    const raw = JSON.parse(readFileSync(dbPath, "utf-8")) as {
      waves: Array<Record<string, unknown>>;
    };
    raw.waves.push({
      topicId,
      id: "W1",
      dependsOn: [],
      committed: initialCommit,
      // 注意：磁盘上故意写成 file→description→action 顺序，验证 migrate 输出键序被规范化。
      changes: [{ file: "src/app.ts", description: "新建 app", action: "create" }],
    });
    writeFileSync(dbPath, JSON.stringify(raw));

    const reloaded = new CwStore(dbPath);
    const topic = reloaded.loadTopic(topicId);
    const change = topic!.waves[0]!.changes[0]!;
    // action 原样保留（create），不被覆盖成 modify。
    expect(change.action).toBe("create");
    // 键序被规范化为 file→action→description。
    expect(Object.keys(change)).toEqual(["file", "action", "description"]);
  });

  it("replan 保留旧格式 committed wave → validateAppendOnly 不报 wave_modified_committed（R1 端到端）", () => {
    // 端到端：旧 topic 的 committed wave 在 store 里是旧格式（无 action）。
    // migrateChanges 读时补 action:'modify' + 规范键序。replan 时新 plan 的 W1 也是 modify，
    // 两侧 stringify 相等 → validateAppendOnly 不误判 wave_modified_committed。
    //
    // 关键：若 migrateChanges 补的不是 modify，或键序错（spread {...c, action}），
    // JSON.stringify 会 differ → 误报 wave_modified_committed。本测试锚定补 modify + 键序的契约。
    const dbPath = join(tmpDir, "cw.json");
    const store = new CwStore(dbPath);
    const git = new GitValidator(tmpDir);
    const deps: ActionDeps = { store, git, workspacePath: tmpDir };
    const initialCommit = setupGitRepo(tmpDir);

    const createResult = dispatch(
      { action: "create", slug: "mig-test-replan", objective: "obj", workspacePath: tmpDir },
      deps,
    );
    const topicId = createResult.topicId;
    // 推到 replan 前置状态（replan 要求 status >= plan_reviewed）。
    store.updateStatus(topicId, "spec_reviewed");
    store.updateGatePassed(topicId, "spec_review", true);
    store.updateStatus(topicId, "plan_reviewed");
    store.updateGatePassed(topicId, "plan_review", true);

    writeLegacyCommittedWave(dbPath, topicId, initialCommit);

    // 确认 committed wave 在 commit 落地的文件存在（src/app.ts 被 setupGitRepo 外的 commitFile 落地）。
    // 实际上 initialCommit 是 README，这里 committed wave 只用于 append-only 比对，
    // 不走 planCheck 存在性校验（uncommittedNew 才走）。补一个真实文件落地避免干扰。
    commitFile(tmpDir, "src/app.ts", "export const app = 1;", "add app");

    // 新 plan：W1 显式 modify（与新格式对齐），与旧 wave（经 migrate 补 modify）对称。
    const newPlan = {
      format: "lite" as const,
      objective: "obj",
      waves: [
        {
          id: "W1",
          changes: [{ file: "src/app.ts", action: "modify" as const, description: "改 app" }],
          dependsOn: [],
        },
      ],
    };
    // 重新构造 deps 用 reloaded store（确保读到注入的旧 wave）。
    const reloadedStore = new CwStore(dbPath);
    const reloadedDeps: ActionDeps = {
      store: reloadedStore,
      git,
      workspacePath: tmpDir,
    };
    expect(() =>
      dispatch({ action: "replan", topicId, planJson: newPlan }, reloadedDeps),
    ).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════
// AC-9/AC-9a: 74 处 fixture 加 action 后全量绿（默认 create 契合虚构路径）
// ════════════════════════════════════════════════════════════════

describe("AC-9/AC-9a: fixture 默认 create 契合虚构路径（迁移后全量绿）", () => {
  it("AC-9a helpers/plan.ts makeValidDevPlanJson 加 action:'create' 后 planCheck 对虚构 src/app.ts pass（create 不要求存在）", async () => {
    // helpers/plan.ts 是 74 处 fixture 的集中 helper（被 dispatch/gate/state-machine 等多测试 import）。
    // W1 迁移后 makeValidDevPlanJson 的 changes 应带 action:'create'（FR-1a：默认 create）。
    // 这里动态 import 拿到迁移后的 helper，验证其产出的 plan 能过 planCheck（create 对虚构路径合法）。
    //
    // 红灯原因：W1 之前 helper 不带 action → planCheck（W2 后）会因 schema 缺 action fail。
    // W1+W2 后 helper 带 action:'create' → schema 通过 + create 对虚构 src/app.ts 不存在合法 → pass。
    const helper = await import("./helpers/plan.js");
    const devPlan = helper.makeValidDevPlanJson();
    const r = planCheck(devPlan, undefined, tmpDir);
    expect(r.result).toBe("pass");
  });

  it("AC-9a create 对虚构路径合法（src/app.ts 不存在 → create pass）", () => {
    // FR-1a 核心契约：fixture 默认 create，因为 74 处 fixture 的 file 多是虚构路径（src/app.ts 等），
    // create 要求文件不存在正好合法。若默认 modify，绝大多数 fixture 会因文件不存在 fail。
    const r = planCheck(plan([ch("src/app.ts", "create")]), undefined, tmpDir);
    expect(r.result).toBe("pass");
  });
});

// ════════════════════════════════════════════════════════════════
// 补充：planCheck 无 workspacePath 时用 process.cwd() 默认值（W2 契约）
// ════════════════════════════════════════════════════════════════

describe("planCheck workspacePath 默认 process.cwd()（W2 第3参省略时）", () => {
  it("省略 workspacePath → 用 process.cwd() 做存在性校验", () => {
    // W2 契约：workspacePath 省略时默认 process.cwd()。
    // 这条测试锚定"省略时用 cwd"——src/legacy/gate.ts 文件在 cwd 下存在（相对 repo 根），
    // modify src/legacy/gate.ts 应 pass；modify 一个肯定不存在的虚构路径应 fail。
    const r = planCheck(
      plan([ch("src/legacy/gate.ts", "modify")]),
      undefined,
      // 显式传 undefined 触发默认值 process.cwd()（W2 第3参默认值契约）。
      undefined,
    );
    // src/legacy/gate.ts 在 repo 根（process.cwd()）下存在 → modify pass。
    expect(r.result).toBe("pass");
  });
});
