/**
 * u5b 单测：human 模式指令生成 + 终止判定（u5b 验收文档「单测验收」3 组）。
 *
 * 分层：指令生成 / 快照行断言测导出的纯函数（投影 → 文本）；终止判定与参数校验
 * 走完整 dispatch 路径（真实 setTimeout 轮询，非 mock 定时器）。
 * fixture 用 EventLedger API 直写（u1b 同款模式，不依赖 CLI 写命令作前置）。
 *
 * 用例编号「验收N」对应 docs/rewrite/acceptance/u5b-acceptance.md「单测验收」第 1/2/3 组。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { fold } from "../src/core/fold.js";
import { dispatch, findCommand } from "../src/dispatch.js";
import type {
  AcceptanceItem,
  SequencedProjection,
  SpecSubmittedPayload,
} from "../src/events/types.js";
import { buildStepInstruction, renderSnapshotLine } from "../src/runner/human-loop.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

// ---- fixture 基建（EventLedger 直写，零 mock） ----

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u5b-loop-"));
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

/** 每个 it 独立 cwd → 独立账本，互不串扰 */
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

/** 走完整 dispatch 路径执行命令，捕获 stdout/stderr 与退出码 */
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

// ---- fixture 事件序列 ----

/** 过 spec gate 五规则的 acceptance（core=e2e-real 带可解析 command + unit 级） */
const STRONG_ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "A1 核心链路真实跑通", type: "e2e-real", command: "node -v" },
  { id: "A2", core: false, title: "A2 单元级", type: "unit" },
];

function strongSpec(unitId: string, split: SpecSubmittedPayload["split"] = []): SpecSubmittedPayload {
  return {
    unitId,
    specHash: `${unitId}-strong-spec-hash`,
    acceptance: [...STRONG_ACCEPTANCE],
    contracts: [],
    split,
  };
}

function appendCreated(unitId: string, parentId: string | null = null): void {
  ledger.append("UnitCreated", { unitId, parentId, briefRef: `brief-${unitId}.md` });
}

/** spec 已提交但未审查（状态仍 created——spec-review 补齐路径的 fixture 起点） */
function appendSpecOnly(unitId: string, split: SpecSubmittedPayload["split"] = [], parentId: string | null = null): void {
  appendCreated(unitId, parentId);
  ledger.append("SpecSubmitted", strongSpec(unitId, split));
}

/** spec-frozen：spec 过 gate + spec-review pass */
function appendFrozen(unitId: string, split: SpecSubmittedPayload["split"] = [], parentId: string | null = null): void {
  appendSpecOnly(unitId, split, parentId);
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "spec-review", verdict: "pass" });
}

/** verified：frozen + build 证据 + pass 的 VerifyRan 覆盖全部验收 id */
function appendVerified(unitId: string, parentId: string | null = null): void {
  appendFrozen(unitId, [], parentId);
  ledger.append("EvidenceSubmitted", {
    unitId,
    runId: `run-${unitId}`,
    commit: "c" + "0".repeat(39),
    paths: ["app.js"],
    sha256: ["d" + "0".repeat(63)],
    exitCode: 0,
  });
  ledger.append("VerifyRan", {
    unitId,
    runId: `verify-${unitId}`,
    reportHash: "rh-" + unitId,
    result: "pass",
    acceptanceIds: STRONG_ACCEPTANCE.map((ac) => ac.id),
  });
}

/** closed：verified + exec-review pass */
function appendClosed(unitId: string, parentId: string | null = null): void {
  appendVerified(unitId, parentId);
  ledger.append("VerdictSubmitted", { unitId, verdictKind: "exec-review", verdict: "pass" });
}

/** 当前账本的折叠投影（纯函数断言的输入） */
function projection(): SequencedProjection {
  return fold(ledger.readAll());
}

// ── 验收1：指令生成（逐状态） ────────────────────────────────

describe("验收1：指令生成（buildStepInstruction 逐状态）", () => {
  it("created 无 spec → spec 指令组：briefRef 路径 + cat/evidence submit/review submit 三条命令 + 信任边界提示", () => {
    appendCreated("u-spec");
    const step = buildStepInstruction(projection(), "u-spec");
    expect(step.kind).toBe("spec");
    expect(step.unitId).toBe("u-spec");
    const text = step.lines.join("\n");
    expect(text).toContain("cat brief-u-spec.md");
    expect(text).toContain("cw evidence submit --kind spec --unit u-spec --file spec.json");
    expect(text).toContain("cw review submit --unit u-spec --verdict-kind spec-review --verdict pass");
    expect(text).toContain("信任边界");
  });

  it("spec-frozen → build 指令组：git commit / evidence submit build / verify 三步", () => {
    appendFrozen("u-build");
    const step = buildStepInstruction(projection(), "u-build");
    expect(step.kind).toBe("build");
    expect(step.unitId).toBe("u-build");
    const text = step.lines.join("\n");
    expect(text).toContain("git commit");
    expect(text).toContain("cw evidence submit --kind build --unit u-build --commit <hash> --run-id <自拟唯一 runId>");
    expect(text).toContain("cw verify --unit u-build");
  });

  it("verified 未 closed → exec-review 指令", () => {
    appendVerified("u-exec");
    const step = buildStepInstruction(projection(), "u-exec");
    expect(step.kind).toBe("exec-review");
    expect(step.unitId).toBe("u-exec");
    const text = step.lines.join("\n");
    expect(text).toContain("cw review submit --unit u-exec --verdict-kind exec-review --verdict pass");
  });

  it("无待办（root closed 且子树全 closed）→ 空指令", () => {
    appendClosed("u-root-done");
    appendClosed("u-leaf-done", "u-root-done");
    const step = buildStepInstruction(projection(), "u-root-done");
    expect(step.kind).toBe("none");
    expect(step.unitId).toBeNull();
    expect(step.lines).toEqual([]);
  });

  it("created 已有 spec（已提交未过审）→ spec-review 补齐指令（闭环：两步操作间不空转）", () => {
    appendSpecOnly("u-review");
    const step = buildStepInstruction(projection(), "u-review");
    expect(step.kind).toBe("spec-review");
    expect(step.unitId).toBe("u-review");
    const text = step.lines.join("\n");
    expect(text).toContain("cw review submit --unit u-review --verdict-kind spec-review --verdict pass");
  });

  it("root 与子 unit 同 spec-frozen → build 目标是子 unit（子的产出是 root 验收的输入）；子 verified 未 closed 时 exec-review 同理子优先", () => {
    appendFrozen("u-root-build");
    appendFrozen("u-leaf-build", [], "u-root-build");
    let step = buildStepInstruction(projection(), "u-root-build");
    expect(step.kind).toBe("build");
    expect(step.unitId).toBe("u-leaf-build");

    // 子 unit 续写 verified 所需事件（不重复 UnitCreated）
    ledger.append("EvidenceSubmitted", {
      unitId: "u-leaf-build",
      runId: "run-leaf",
      commit: "c" + "0".repeat(39),
      paths: ["app.js"],
      sha256: ["d" + "0".repeat(63)],
      exitCode: 0,
    });
    ledger.append("VerifyRan", {
      unitId: "u-leaf-build",
      runId: "verify-leaf",
      reportHash: "rh-leaf",
      result: "pass",
      acceptanceIds: STRONG_ACCEPTANCE.map((ac) => ac.id),
    });
    step = buildStepInstruction(projection(), "u-root-build");
    expect(step.kind).toBe("exec-review");
    expect(step.unitId).toBe("u-leaf-build");
  });
});

// ── 验收2：快照行格式 + split 待 create 提示 ─────────────────

describe("验收2：快照行格式 + split 待 create 提示", () => {
  it("快照行格式：[human] <ISO时间戳> root=<id> 状态=<status> 待人工步骤=<kind|无>", () => {
    expect(renderSnapshotLine("u1", "created", "spec", "2026-08-15T10:00:00.000Z")).toBe(
      "[human] 2026-08-15T10:00:00.000Z root=u1 状态=created 待人工步骤=spec",
    );
    expect(renderSnapshotLine("u1", "closed", "none", "2026-08-15T10:00:00.000Z")).toBe(
      "[human] 2026-08-15T10:00:00.000Z root=u1 状态=closed 待人工步骤=无",
    );
    expect(renderSnapshotLine("u1", "spec-frozen", "build", "2026-08-15T10:00:00.000Z")).toBe(
      "[human] 2026-08-15T10:00:00.000Z root=u1 状态=spec-frozen 待人工步骤=build",
    );
  });

  it("root spec 的 split 声明 2 个未 create 子 unit → create 指令组列出全部待 create 项", () => {
    appendFrozen("u-root", [
      { unitId: "leaf-a", briefRef: "brief-a.md", dependsOn: [] },
      { unitId: "leaf-b", dependsOn: [] },
    ]);
    const step = buildStepInstruction(projection(), "u-root");
    expect(step.kind).toBe("create");
    expect(step.unitId).toBe("u-root");
    const text = step.lines.join("\n");
    expect(text).toContain("2 个尚未创建");
    expect(text).toContain("cw create --id leaf-a --brief brief-a.md --parent u-root");
    expect(text).toContain("cw create --id leaf-b --brief <自建 brief 文件路径> --parent u-root");
  });

  it("split 已全部 create → 不再提示 create，优先级落到首个无 spec 的子 unit", () => {
    appendFrozen("u-root", [{ unitId: "leaf-a", briefRef: "brief-a.md", dependsOn: [] }]);
    appendCreated("leaf-a", "u-root");
    const step = buildStepInstruction(projection(), "u-root");
    expect(step.kind).toBe("spec");
    expect(step.unitId).toBe("leaf-a");
  });
});

// ── 验收3：终止判定（dispatch 层真实循环） ───────────────────

describe("验收3：终止判定（dispatch 真实轮询）", () => {
  it("root closed → 循环首轮即汇总 exit 0：stdout 含各 unit 状态 / verify 结果 / cw report 提示", async () => {
    appendClosed("u-done");
    const res = await run(["run", "--root", "u-done"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("已 closed");
    expect(res.stdout).toMatch(/u-done\s+closed\s+lastVerify:pass/);
    expect(res.stdout).toContain("cw report");
    // u7 起 run 走通用 loop（无 M0 快照行「待人工步骤=」）：以循环启动行验证进入循环
    expect(res.stdout).toContain("[runner] 循环启动：root=u-done");
  });

  it("无进展：--max-idle-ms 100 注入小值 + 无人操作 → exit 1，stderr 含空转提示与恢复动作", async () => {
    appendCreated("u-stall");
    const res = await run(["run", "--root", "u-stall", "--poll-ms", "20", "--max-idle-ms", "100"]);
    expect(res.code).toBe(1);
    // u7 通用 loop 的空转文案（面向 agent 后端）：「无账本进展」（M0 文案为「无进展」）
    expect(res.stderr).toContain("无账本进展");
    expect(res.stderr).toContain("恢复动作");
    // 中断前确实打印过 designer 指令组（humanAdapter 派发定点指令，人在场即可照做）
    expect(res.stdout).toContain("cw evidence submit --kind spec --unit u-stall --file spec.json");
  });
});

// ── 参数校验 + dispatch 注册 ─────────────────────────────────

describe("cw run 参数校验与注册", () => {
  it("缺少 --root → exit 1，stderr 含用法与恢复动作", async () => {
    const res = await run(["run"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--root");
    expect(res.stderr).toContain("恢复动作");
  });

  it("--root 不存在 → exit 1，stderr 含可操作错误（指向 cw status 查证）", async () => {
    const res = await run(["run", "--root", "no-such"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no-such");
    expect(res.stderr).toContain("cw status");
  });

  it("--spawn 未知后端 → exit 1，stderr 提示可选值与恢复动作（u7 起 pi 为合法后端，不再以 pi 为反例）", async () => {
    appendCreated("u-spawn");
    const res = await run(["run", "--root", "u-spawn", "--spawn", "nosuch-backend"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--spawn 后端 "nosuch-backend"');
    expect(res.stderr).toContain("恢复动作");
  });

  it("--spawn human（显式）与缺省同义：通过校验进入循环（以无进展退出验证）", async () => {
    appendCreated("u-spawn2");
    const res = await run(["run", "--root", "u-spawn2", "--spawn", "human", "--poll-ms", "20", "--max-idle-ms", "60"]);
    expect(res.code).toBe(1); // 无进展退出 = 已进入循环（spawn 校验通过）
    expect(res.stderr).toContain("无账本进展");
  });

  it("--poll-ms abc → exit 1，stderr 说明须为正整数", async () => {
    appendCreated("u-flag");
    const res = await run(["run", "--root", "u-flag", "--poll-ms", "abc"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("--poll-ms");
    expect(res.stderr).toContain("正整数");
  });

  it("run 按 findCommand 命中注册（name/handler/summary）", () => {
    const cmd = findCommand(["run"]);
    expect(cmd?.name).toBe("run");
    expect(cmd?.handler).toBeTypeOf("function");
    expect(cmd?.summary ?? "").not.toBe("");
  });
});
