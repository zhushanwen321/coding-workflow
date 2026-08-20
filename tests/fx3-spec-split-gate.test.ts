/**
 * fx-3 单测 R5.1（docs/rewrite/acceptance/fx-3-acceptance.md 回归 1/2）：
 * spec gate 收紧——split 声明的子 unit 必须①已存在于账本②其 parent 指向
 * 提交 unit（防张冠李戴引用别家子）。dispatch 层完整路径 + 真实账本 + tmp
 * 目录，零 mock（u2-evidence 同款基建）。
 *
 *   1. split 声明不存在的 unitId → exit 1，stderr 列缺失 id 与建子命令模板
 *      （先 cw create --id <slug> --brief <文件> --parent <unitId> 再提交）；
 *      子存在但 parent 错配 → 同样拒绝并列出错配清单。均不入账。
 *   2. 阴性对照：子全存在且 parent 正确 → spec 照常过审入账（payload.split 原样）。
 *
 * 修复前行为：split 条目 unitId 不存在 / parent 不指向本 unit 均放行——终验
 * 第 3 次 root spec 声明两个不存在的叶子 unit 入账，分解树永远等不到子节点。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx3-gate-"));
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

/** 过 u3 五规则的合法验收（command 用 node，PATH 必可解析） */
const VALID_ACCEPTANCE = [
  { id: "A1", core: true, title: "核心链路可用", type: "e2e-real", command: "node -v" },
  { id: "A2", core: false, title: "单元行为正确", type: "unit" },
] as const;

/** spec.json 内容：split 由用例注入（fx-3 校验对象） */
function writeSpec(name: string, split: ReadonlyArray<Record<string, unknown>>): string {
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

/** 先经 dispatch 创建 unit（真实前置，非直写账本） */
async function createUnit(unitId: string, parent?: string): Promise<void> {
  const brief = join(cwd, "brief.md");
  writeFileSync(brief, "# 任务书\n");
  const args = ["create", "--id", unitId, "--brief", brief];
  if (parent !== undefined) {
    args.push("--parent", parent);
  }
  const res = await run(args);
  expect(res.code, `前置 create ${unitId} 应成功（stderr: ${res.stderr}）`).toBe(0);
}

// ── 回归 1：split 子缺失 / parent 错配 → 拒绝且不入账 ─────────

describe("fx-3 R5.1 回归1：split 声明的子 unit 校验失败 → exit 1 不入账", () => {
  it("split 声明不存在的 unitId → exit 1，stderr 列缺失 id 与建子命令模板（含 --parent）", async () => {
    await createUnit("root");
    const specPath = writeSpec("spec-missing.json", [
      { unitId: "leaf-a", dependsOn: [] },
      { unitId: "leaf-b", dependsOn: [] },
    ]);

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "root", "--file", specPath]);

    expect(res.code).toBe(1);
    // 错误列出全部缺失 id（修复前：静默放行，分解树永远等不到子）
    expect(res.stderr).toContain("spec.split 声明的子 unit 校验失败");
    expect(res.stderr).toContain("未创建");
    expect(res.stderr).toContain("leaf-a");
    expect(res.stderr).toContain("leaf-b");
    // 恢复动作含建子命令模板（designer 在同一 spawn 内建子后重提的出口）
    expect(res.stderr).toContain("恢复动作：先 cw create --id <slug> --brief <文件> --parent root 创建全部子 unit，再提交 spec。");
    expect(ledger.readAll()).toHaveLength(1); // 仅 UnitCreated，SpecSubmitted 不入账
  });

  it("子存在但 parent 错配（引用别家子）→ exit 1，stderr 列错配清单", async () => {
    await createUnit("root");
    await createUnit("other-root");
    // stray 挂在 other-root 下——root 的 split 引用它是张冠李戴
    await createUnit("stray", "other-root");
    const specPath = writeSpec("spec-mismatch.json", [{ unitId: "stray", dependsOn: [] }]);

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "root", "--file", specPath]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("parent 错配");
    expect(res.stderr).toContain("stray");
    expect(res.stderr).toContain('"root"');
    expect(res.stderr).toContain("恢复动作");
    expect(ledger.readAll()).toHaveLength(3); // 三个 UnitCreated，无 SpecSubmitted
  });
});

// ── 回归 2：阴性对照——子全存在且 parent 正确 → 照常过审入账 ──

describe("fx-3 R5.1 回归2：阴性对照——子已建且 parent 指向本 unit → spec 过审入账", () => {
  it("先建两子（--parent root）再提交含 split 的 spec → exit 0，payload.split 原样", async () => {
    await createUnit("root");
    await createUnit("leaf-a", "root");
    await createUnit("leaf-b", "root");
    const specPath = writeSpec("spec-ok.json", [
      { unitId: "leaf-a", dependsOn: [], files: ["src/a.ts"] },
      { unitId: "leaf-b", dependsOn: ["leaf-a"] },
    ]);

    const res = await run(["evidence", "submit", "--kind", "spec", "--unit", "root", "--file", specPath]);

    expect(res.code).toBe(0);
    const events = ledger.readAll();
    expect(events).toHaveLength(4);
    expect(events[3]?.type).toBe("SpecSubmitted");
    expect(events[3]?.payload).toMatchObject({
      unitId: "root",
      split: [
        { unitId: "leaf-a", dependsOn: [], files: ["src/a.ts"] },
        { unitId: "leaf-b", dependsOn: ["leaf-a"] },
      ],
    });
  });
});
