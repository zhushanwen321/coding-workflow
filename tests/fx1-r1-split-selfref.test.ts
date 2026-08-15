/**
 * fx-1 R1 回归（docs/rewrite/acceptance/fx-1-acceptance.md R1）：split 自引用死锁的
 * gate 级 + handler 级防线。根因见 final-gate-report.md §5 R1——终验 leaf-renderer
 * designer 抄 root spec 模板未改，split 含自身 → loop 判内部节点 → 等自己 verified
 * → 确定性死锁。
 *
 * 三层防线中本文件覆盖前两层（loop 级防御见 tests/fx1-loop-dispatch.test.ts）：
 *   1. gate 级：checkSpecRules 规则⑥拒自引用；非自引用 split 不误伤。
 *   2. fold 集成：gate 注入 deriveStatus——自引用 spec 即使事后有 spec-review pass
 *      也到不了 spec-frozen（死锁的入口状态不可达）。
 *   3. handler 级：叶子 unit（parentId 非空）提交非空 split → dispatch 全链路拒、
 *      不入账；根 unit 同形态放行（既有行为不变）。
 *
 * 真实环境零 mock：dispatch 直调 + 真实账本（tmp CW_HOME 隔离）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem, SpecSubmittedPayload, SplitEntry } from "../src/events/types.js";
import { checkSpecRules } from "../src/gates/spec-rules.js";
import { loadLedger, unitStatus } from "../src/readonly/load.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

// ── gate 级（纯函数直调） ─────────────────────────────────────

/** 过五规则的合法验收（command 用 node，PATH 必可解析） */
const VALID_ACCEPTANCE: readonly AcceptanceItem[] = [
  { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: "node -v" },
  { id: "A2", core: false, title: "单元行为正确", type: "unit" },
];

function makeSpec(split: readonly SplitEntry[], unitId = "fx1-unit"): SpecSubmittedPayload {
  return {
    unitId,
    specHash: "0".repeat(64),
    acceptance: [...VALID_ACCEPTANCE],
    contracts: [],
    split: [...split],
  };
}

describe("fx-1 R1.1 gate 级：checkSpecRules 规则⑥（split 自引用拒）", () => {
  it("split 含 unitId === spec.unitId 的条目 → 拒，failures 含「规则⑥: split 自引用 <id>」与恢复动作原文", () => {
    const result = checkSpecRules(makeSpec([{ unitId: "fx1-unit", dependsOn: [] }]));
    expect(result.ok).toBe(false);
    // 验收文档锁定文案：failures 含「规则⑥: split 自引用 <id>」+ 恢复动作
    expect(result.failures).toHaveLength(1); // 验收本身合法，仅规则⑥触发（不与其他缺口混淆）
    expect(result.failures[0]).toContain("规则⑥: split 自引用 fx1-unit");
    expect(result.failures[0]).toContain("拆分子节点不得包含自身");
    expect(result.failures[0]).toContain("叶子 unit 的 split 应为空");
  });

  it("split 引用其他 unit（非自引用）→ 不触发规则⑥（合法分解声明不误伤）", () => {
    const result = checkSpecRules(
      makeSpec([
        { unitId: "child-a", dependsOn: [] },
        { unitId: "child-b", dependsOn: ["child-a"] },
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});

// ── fold 集成（gate 注入 deriveStatus：自引用 spec 到不了 spec-frozen） ──
// 使用下方 beforeEach 的 cwd + cw-home 基建（loadLedger 按当前 CW_HOME 定位账本）

describe("fx-1 R1.1 fold 集成：自引用 spec 无法达到 spec-frozen", () => {
  it("自引用 spec + 事后 spec-review pass → unitStatus 仍 created（死锁入口状态不可达）", () => {
    const ledger = new EventLedger(ledgerPath(cwHome, cwd));
    ledger.append("UnitCreated", { unitId: "leaf-renderer", parentId: "md-reader", briefRef: "brief.md" });
    // 终验 seq6/seq7 同款形状：自引用 spec + spec-review pass（旁路写入的坏账本）
    ledger.append("SpecSubmitted", makeSpec([{ unitId: "leaf-renderer", dependsOn: [] }], "leaf-renderer"));
    ledger.append("VerdictSubmitted", { unitId: "leaf-renderer", verdictKind: "spec-review", verdict: "pass" });

    const unit = loadLedger(cwd).projection.units.get("leaf-renderer");
    expect(unit).toBeDefined();
    // 修复前：gate 无规则⑥ → spec-frozen → loop 按内部节点等「自己 verified」死锁。
    // 修复后：gate 拒 → 状态停在 created，配合第四分支可派 designer 处置
    expect(unitStatus(unit!)).toBe("created");
  });
});

// ── handler 级（dispatch 层完整路径，真实账本） ───────────────

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx1-r1-handler-"));
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

async function run(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

/** 经 dispatch 建 root + leaf（leaf 的 parentId 非空 = 深度上限 2 的叶子） */
async function createRootAndLeaf(): Promise<void> {
  const brief = join(cwd, "brief.md");
  writeFileSync(brief, "# fx1 fixture 任务书\n");
  const root = await run(["create", "--id", "root", "--brief", brief]);
  expect(root.code, `前置 create root 失败：${root.stderr}`).toBe(0);
  const leaf = await run(["create", "--id", "leaf", "--parent", "root", "--brief", brief]);
  expect(leaf.code, `前置 create leaf 失败：${leaf.stderr}`).toBe(0);
}

/** 写 spec.json：合法验收 + 指定 split（split 条目刻意非自引用——隔离规则⑥，单测叶子防线本身） */
function writeSpecFile(name: string, split: readonly SplitEntry[]): string {
  const path = join(cwd, name);
  writeFileSync(
    path,
    JSON.stringify({
      acceptance: VALID_ACCEPTANCE,
      contracts: [],
      split,
    }),
  );
  return path;
}

describe("fx-1 R1.2 handler 级：叶子 unit（深度上限 2）不得声明 split", () => {
  it("叶子（parentId 非空）提交非空 split → exit 1，stderr 含锁定文案，不入账", async () => {
    await createRootAndLeaf();
    const specPath = writeSpecFile("spec-leaf-split.json", [{ unitId: "sub-unit", dependsOn: [] }]);

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "leaf", "--file", specPath]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("叶子 unit（深度上限 2）不得声明 split");
    expect(res.stderr).toContain('unit "leaf" 是 "root" 的子 unit');
    expect(res.stderr).toContain("恢复动作");
    // 不入账：账本仍只有两条 UnitCreated
    const events = ledger.readAll();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "UnitCreated")).toBe(true);
  });

  it("根 unit（parentId 空）同形态 split 放行、叶子 split 空放行（既有行为不变）", async () => {
    await createRootAndLeaf();
    // fx-3 R5.1 断言适配：split 条目 sub-unit 须先创建且 parent 指向 root
    //（先建子后提 spec 的语义收紧）——放行语义本身不变：根 unit 不被叶子防线误伤
    const brief = join(cwd, "brief.md");
    const sub = await run(["create", "--id", "sub-unit", "--parent", "root", "--brief", brief]);
    expect(sub.code, `前置 create sub-unit 失败：${sub.stderr}`).toBe(0);
    const specPath = writeSpecFile("spec-root-split.json", [{ unitId: "sub-unit", dependsOn: [] }]);

    const root = await run(["evidence", "submit", "--kind", "spec", "--unit", "root", "--file", specPath]);
    expect(root.code).toBe(0); // 拆分子节点是根 unit spec 的职责——不误伤

    const emptyPath = writeSpecFile("spec-leaf-empty.json", []);
    const leaf = await run(["evidence", "submit", "--kind", "spec", "--unit", "leaf", "--file", emptyPath]);
    expect(leaf.code).toBe(0);
    expect(ledger.readAll().filter((e) => e.type === "SpecSubmitted")).toHaveLength(2);
  });
});
