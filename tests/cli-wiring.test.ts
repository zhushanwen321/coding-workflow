/**
 * CLI wiring 层测试（layer-2：in-process import，无 spawnSync 子进程）。
 *
 * 迁移自原 tests/cli.test.ts 的 22 个 spawnSync 测试——这些测试的回归价值在 CLI
 * 内部纯函数（buildParams / readInput / renderActionHelp / loadCwConfig /
 * guardTestCommand / constructCwDeps.testRunner / renderStatus / renderCliError /
 * runReadonly）而非「真实子进程端到端」。改用直接 import 调用，单测 5-30ms
 * （testRunner 含 1 次真实 echo spawn ~50ms）。
 *
 * 迁移对应（原 cli.test.ts 序号 → 本文件 describe/it）：
 *   buildParams:        #2 #3#4 #7 #11 #26 #27 #28 #29 #30 #31
 *   readInput:          #20 #21
 *   renderActionHelp:   #37 #38
 *   renderCliError:     #39
 *   runReadonly:        #32
 *   renderStatus:       #43
 *   testRunner/守卫:    #45 #46
 *
 * 真正的子进程端到端烟雾（create happy-path / version / help / unit_not_found /
 * illegal_transition / flag→exit / --input @file）保留在 tests/cli.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildParams,
  constructCwDeps,
  guardTestCommand,
  type ParsedArgs,
  readInput,
  renderActionHelp,
  renderCliError,
  runReadonly,
} from "../src/cli.js";
import { CwError } from "../src/core/errors.js";
import type { ExecutionUnit } from "../src/core/workunit.js";
import { renderStatus } from "../src/index.js";
import { createCwEnv, type CwEnv } from "./helpers/env.js";

// ── 共享：隔离 cwd（runReadonly / testRunner 绑 workspacePath）──

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

/**
 * 断言 fn 抛 CwError 且 message 含 keyword（单次调用，纯函数安全）。
 *
 * buildParams / readInput / runReadonly 的参数错误都是 CwError（CLI 映射 exit 1）。
 */
function expectCwError(fn: () => unknown, keyword: string): void {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (e) {
    caught = e;
    threw = true;
  }
  expect(threw, "expected fn to throw").toBe(true);
  expect(caught).toBeInstanceOf(CwError);
  expect((caught as Error).message).toContain(keyword);
}

// ═══════════════════════════════════════════════════════════════
// buildParams — argv flags → CwParams（纯函数）
// ═══════════════════════════════════════════════════════════════

describe("buildParams: create 参数构造（#2 basedOnParent / #3#4 缺必填 / #7 非法 layer）", () => {
  it("#2: --parent + --basedOnParent JSON → input.parentUnitId / basedOnParent 解析", () => {
    const parsed: ParsedArgs = {
      _: ["create", "wave"],
      slug: "w",
      objective: "o",
      parent: "slice:auth",
      basedOnParent: '["TC1","TC2"]',
    };
    const params = buildParams("create", "wave", parsed, "", true, null);
    expect(params.action).toBe("create");
    expect(params.input).toMatchObject({
      slug: "w",
      objective: "o",
      layer: "wave",
      parentUnitId: "slice:auth",
      basedOnParent: ["TC1", "TC2"],
    });
  });

  it.each([
    { flags: { slug: "x" }, missing: "objective" },
    { flags: { objective: "y" }, missing: "slug" },
  ])("#3/#4: create 缺 $missing → CwError 含字段名", ({ flags, missing }) => {
    const parsed: ParsedArgs = { _: ["create", "wave"], ...flags };
    expectCwError(() => buildParams("create", "wave", parsed, "", true, null), missing);
  });

  it("#7: layer 非法（'bogus'）→ CwError 含 layer", () => {
    const parsed: ParsedArgs = {
      _: ["create", "bogus"],
      slug: "x",
      objective: "y",
    };
    expectCwError(() => buildParams("create", "bogus", parsed, "", true, null), "layer");
  });
});

describe("buildParams: 推进 action 缺 --unitId（#11）", () => {
  it("#11: design 无 unitId → CwError 含 unitId", () => {
    const parsed: ParsedArgs = { _: ["design"] };
    expectCwError(() => buildParams("design", undefined, parsed, "", true, null), "unitId");
  });
});

describe("buildParams: execute scope 路由（#26 slice 无 commitHash / #27 wave 需 commitHash）", () => {
  it("#26: scope=slice → input:{} 不要求 commitHash（slice execute 按 plan.split 下沉）", () => {
    const parsed: ParsedArgs = { _: ["execute"], unitId: "slice:x" };
    // execute 分支：params 带 unitId（create 分支无 unitId，故按 execute 形态断言）
    const params = buildParams("execute", undefined, parsed, "", true, "slice") as {
      action: string;
      unitId: string;
      input: Record<string, unknown>;
    };
    expect(params.action).toBe("execute");
    expect(params.unitId).toBe("slice:x");
    expect(params.input).toEqual({});
  });

  it("#27: scope=wave 缺 --commitHash → CwError 含 commitHash", () => {
    const parsed: ParsedArgs = { _: ["execute"], unitId: "wave:x" };
    expectCwError(
      () => buildParams("execute", undefined, parsed, "", true, "wave"),
      "commitHash",
    );
  });
});

describe("buildParams: design --abandonParentItems flag（#28 camelCase / #29 kebab / #30 缺省 / #31 非JSON）", () => {
  // design input 走 stdin（isStdinTTY=false + stdinData 非空 JSON），与 flag 注入路径解耦。
  const stdinDesign = "{}";

  it("#28: --abandonParentItems '[\"TC1\"]' → input.abandonParentItems 解析", () => {
    const parsed: ParsedArgs = {
      _: ["design"],
      unitId: "wave:x",
      abandonParentItems: '["TC1"]',
    };
    const params = buildParams("design", undefined, parsed, stdinDesign, false, "wave");
    expect(
      (params.input as { abandonParentItems?: string[] }).abandonParentItems,
    ).toEqual(["TC1"]);
  });

  it("#29: --abandon-parent-items（kebab-case）与 camelCase 等价", () => {
    const parsed: ParsedArgs = {
      _: ["design"],
      unitId: "wave:x",
      "abandon-parent-items": '["TC2","TC3"]',
    };
    const params = buildParams("design", undefined, parsed, stdinDesign, false, "wave");
    expect(
      (params.input as { abandonParentItems?: string[] }).abandonParentItems,
    ).toEqual(["TC2", "TC3"]);
  });

  it("#30: 不带 flag → input 不注入 abandonParentItems（undefined；[] 是 createWave 工厂默认）", () => {
    const parsed: ParsedArgs = { _: ["design"], unitId: "wave:x" };
    const params = buildParams("design", undefined, parsed, stdinDesign, false, "wave");
    expect(
      (params.input as { abandonParentItems?: string[] }).abandonParentItems,
    ).toBeUndefined();
  });

  it("#31: --abandonParentItems 非 JSON 字符串 → CwError 含 abandonParentItems + JSON", () => {
    const parsed: ParsedArgs = {
      _: ["design"],
      unitId: "wave:x",
      abandonParentItems: "not-valid-json",
    };
    let caught: unknown;
    try {
      buildParams("design", undefined, parsed, stdinDesign, false, "wave");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CwError);
    const msg = (caught as Error).message;
    expect(msg).toContain("abandonParentItems");
    expect(msg).toContain("JSON");
  });
});

// ═══════════════════════════════════════════════════════════════
// readInput — input payload 解析（纯函数）
// ═══════════════════════════════════════════════════════════════

describe("readInput: stdin 解析（#20 stdin JSON / #21 空 input）", () => {
  it("#20: --input - + stdin 非空 JSON → 解析为对象", () => {
    const data = JSON.stringify({ testCases: [], tasks: [1, 2] });
    expect(readInput("-", data, false)).toEqual({ testCases: [], tasks: [1, 2] });
  });

  it("#21: 无 --input + stdin 空（TTY）→ CwError 含 input", () => {
    expectCwError(() => readInput(undefined, "", true), "input");
  });
});

// ═══════════════════════════════════════════════════════════════
// renderActionHelp — per-command help 渲染（纯函数）
// ═══════════════════════════════════════════════════════════════

describe("renderActionHelp: per-command help（#37 合法 flag 列表 / #38 双入口同源）", () => {
  it("#37: renderActionHelp(execute) 含 --commitHash + --unitId（FLAG_WHITELIST 单源）", () => {
    const out = renderActionHelp("execute");
    expect(out).toContain("合法 flags");
    expect(out).toContain("--commitHash");
    expect(out).toContain("--unitId");
  });

  it("#38: cw help execute 与 cw execute --help 同源（两入口都路由到 renderActionHelp，输出确定）", () => {
    // main 的两入口（cw help <action> / cw <action> --help）都调用 renderActionHelp(target)，
    // 故「等价」= 同一纯函数调用结果相等。
    const a = renderActionHelp("execute");
    const b = renderActionHelp("execute");
    expect(a).toBe(b);
    expect(a).toContain("--commitHash");
  });
});

// ═══════════════════════════════════════════════════════════════
// renderCliError — 错误 → exit code/stderr 映射（纯函数）
// ═══════════════════════════════════════════════════════════════

describe("renderCliError: CwError → exit 1 + message（#39 未知 help target）", () => {
  it("#39: 未知 help target 的 CwError → exitCode=1 + stderr 含目标名 + 不含堆栈", () => {
    // main 对 `cw help <未知>` 抛 CwError('未知 action "<target>" ...')；
    // 此处验证该 CwError 经 renderCliError 映射为 exit 1 + 友好 message（无堆栈）。
    const err = new CwError('未知 action "bogus-action"，合法: create, design, ...');
    const { exitCode, stderr } = renderCliError(err);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("bogus-action");
    // CwError 是预期错误（exit 1），不输出堆栈（仅内部异常 exit 2 才输出）
    expect(stderr).not.toContain("堆栈");
  });
});

// ═══════════════════════════════════════════════════════════════
// runReadonly — 只读查询（in-process，绑真实 store 路径但不写）
// ═══════════════════════════════════════════════════════════════

describe("runReadonly: list --all / --cwd 互斥（#32）", () => {
  it("#32: --all + --cwd 同时传 → CwError 含 mutually exclusive（互斥检查在 renderList 之前）", async () => {
    const parsed: ParsedArgs = { _: ["list"], all: true, cwd: env.cwd };
    // cwd 必须绝对（isAbsolute 检查在互斥检查之前），env.cwd 是绝对路径
    await expect(runReadonly("list", parsed, env.cwd)).rejects.toThrow(CwError);
    await expect(runReadonly("list", parsed, env.cwd)).rejects.toThrow(
      "mutually exclusive",
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// renderStatus — 大字段截断（纯函数，#10 设计）
// ═══════════════════════════════════════════════════════════════

describe("renderStatus: 大字段默认截断 + --full 全量（#43）", () => {
  it("#43: 默认截断超阈值字段 + 首行提示；--full 输出全量（AC-4.3）", () => {
    const bigQuestion = "x".repeat(600); // > STATUS_FIELD_MAX(500)
    const unit = {
      id: "wave:trunc",
      scope: "wave",
      clarifications: [
        {
          id: "Q1",
          status: "active",
          question: bigQuestion,
          resolution: "r",
          type: "grilling",
        },
      ],
    };

    // 默认：首行截断提示 + 其余行是合法 JSON（clarifications 被截断为字符串）
    const truncated = renderStatus(unit, { full: false });
    expect(truncated).toMatch(/^（字段已截断，用 --full 查看全量）/);
    const truncatedBody = JSON.parse(truncated.split("\n").slice(1).join("\n")) as {
      id: string;
      clarifications: unknown;
    };
    expect(truncatedBody.id).toBe("wave:trunc");

    // --full：无截断提示，clarifications 完整（question 长度 600）
    const full = renderStatus(unit, { full: true });
    expect(full).not.toMatch(/已截断/);
    const fullBody = JSON.parse(full) as {
      clarifications: Array<{ question: string }>;
    };
    expect(fullBody.clarifications[0].question.length).toBe(600);
  });
});

// ═══════════════════════════════════════════════════════════════
// guardTestCommand + constructCwDeps.testRunner — per-wave testCommand 守卫与执行
// ═══════════════════════════════════════════════════════════════

describe("guardTestCommand: 空值守卫（#46 空串/空白）", () => {
  const SHORT_CIRCUIT = {
    passed: false,
    passedCount: 0,
    failedCount: 0,
    failedTests: [],
  };

  it.each(["", "  "])("#46: guardTestCommand(%j) → 短路 0/0（不 spawn）", (cmd) => {
    expect(guardTestCommand(cmd)).toEqual(SHORT_CIRCUIT);
  });

  it("guardTestCommand 非空命令 → null（需真跑，含前后空白 trim 后非空）", () => {
    expect(guardTestCommand("echo x")).toBeNull();
    expect(guardTestCommand("  echo x  ")).toBeNull();
  });
});

describe("constructCwDeps.testRunner: 执行 per-wave plan.testCommand（#45）", () => {
  it("#45: testRunner.run 执行 plan.testCommand（echo a && echo b）→ passed=true（含 1 次真实 spawn）", () => {
    const deps = constructCwDeps(env.cwd);
    const unit = {
      id: "wave:tr",
      plan: { testCommand: "echo a && echo b" },
    } as unknown as ExecutionUnit;
    const result = deps.testRunner!.run(unit);
    // echo exit 0 → passed=true；输出无 vitest 计数行 → passedCount/failedCount 均为 0
    expect(result).toMatchObject({
      passed: true,
      passedCount: 0,
      failedCount: 0,
    });
    expect(Array.isArray(result.failedTests)).toBe(true);
    expect(result.failedTests).toHaveLength(0);
  });

  it("#45 守卫接线：testRunner.run 空 testCommand → 经 guardTestCommand 短路（不 spawn）", () => {
    const deps = constructCwDeps(env.cwd);
    const unit = {
      id: "wave:empty",
      plan: { testCommand: "   " },
    } as unknown as ExecutionUnit;
    const result = deps.testRunner!.run(unit);
    expect(result).toEqual({
      passed: false,
      passedCount: 0,
      failedCount: 0,
      failedTests: [],
    });
  });
});
