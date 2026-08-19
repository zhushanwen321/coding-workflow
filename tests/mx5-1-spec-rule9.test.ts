/**
 * mx5-1 R 系：spec gate 规则⑨（验收命令契约）——dispatch 层完整路径
 * （真实账本 + tmp CW_HOME 隔离，零 mock），用例编号 R1-R8 逐条对应
 * docs/rewrite/acceptance/mx5-1-acceptance.md §5 R 系条款。
 *
 * 提交路径与 u2-evidence 同款：dispatch 直调 `evidence submit --kind spec`
 * （exit 语义 = dispatch 返回码），毒 spec 断言 exit 1 + 文案（验收 id +
 * flag 名 + 恢复动作）+ 不入账；合法对照断言 exit 0 入账。
 * 规则③的 PATH 解析依赖真实环境：正向用 node / echo（PATH 必在），
 * 反向用确定不存在的 no-such-bin-xyz。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch } from "../src/dispatch.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx51-r-"));
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

/** 先经 dispatch 创建 unit（真实前置，非直写账本） */
async function createUnit(unitId: string): Promise<void> {
  const brief = join(cwd, "brief.md");
  writeFileSync(brief, "# 任务书\n");
  const res = await run(["create", "--id", unitId, "--brief", brief]);
  expect(res.code, `前置 create ${unitId} 应成功（stderr: ${res.stderr}）`).toBe(0);
}

/** 写 spec.json 并经 dispatch 提交；返回捕获结果 */
async function submitSpec(unitId: string, acceptance: AcceptanceItem[]): Promise<Captured> {
  await createUnit(unitId);
  const specPath = join(cwd, "spec.json");
  writeFileSync(specPath, JSON.stringify({ acceptance, contracts: [], split: [] }));
  return run(["evidence", "submit", "--kind", "spec", "--unit", unitId, "--file", specPath]);
}

/** e2e-real 条目（规则③正向锚：command 首 token node 在 PATH 必可解析） */
function e2eItem(id: string, command: string, overrides: Partial<AcceptanceItem> = {}): AcceptanceItem {
  return { id, core: true, title: `${id} 核心链路`, type: "e2e-real", command, ...overrides };
}

/** 非 core unit 条目（vitest 型缺省路由；带毒 command 时由规则⑨裁决） */
function unitItem(id: string, command?: string, overrides: Partial<AcceptanceItem> = {}): AcceptanceItem {
  return {
    id,
    core: false,
    title: `${id} 单元行为`,
    type: "unit",
    ...(command === undefined ? {} : { command }),
    ...overrides,
  };
}

/** spec 是否已入账（毒 spec 不入账是 R 系共同前置断言） */
function specBooked(): boolean {
  return ledger.readAll().some((e) => e.type === "SpecSubmitted");
}

describe("R1 vitest 型毒命令拒绝（--reporter=verbose）", () => {
  it("unit 型验收 command 含 --reporter=verbose → exit 1，文案含验收 id、flag 名与恢复动作，不入账", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "npx vitest run --reporter=verbose tests/close.spec.ts"),
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑨");
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("--reporter=verbose");
    expect(res.stderr).toContain("恢复动作");
    expect(res.stderr).toContain("删除该 flag");
    expect(specBooked()).toBe(false);
  });
});

describe("R2 两种 reporter 形式全覆盖", () => {
  it("空格形式 --reporter verbose 同样拒绝", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "npx vitest run --reporter verbose tests/close.spec.ts"),
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("--reporter");
    expect(res.stderr).toContain("值=verbose");
    expect(specBooked()).toBe(false);
  });

  it("--reporter=json（= 形式，值恰为 json）通过——存量夹具 includes 幂等语义", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "npx vitest run --reporter=json tests/close.spec.ts"),
    ]);

    expect(res.code).toBe(0);
    expect(specBooked()).toBe(true);
  });

  it("--reporter json（空格形式，值恰为 json）通过", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "npx vitest run --reporter json tests/close.spec.ts"),
    ]);

    expect(res.code).toBe(0);
    expect(specBooked()).toBe(true);
  });
});

describe("R3 outputFile 禁", () => {
  it("--outputFile=report.json（= 形式）→ exit 1 列缺口", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "npx vitest run --outputFile=report.json tests/a.spec.ts"),
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑨");
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("--outputFile=report.json");
    expect(specBooked()).toBe(false);
  });

  it("--outputFile report.json（空格形式）→ exit 1 列缺口（任何形式都禁）", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "npx vitest run --outputFile report.json tests/a.spec.ts"),
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("--outputFile");
    expect(specBooked()).toBe(false);
  });
});

describe("R4 pytest 合写形态", () => {
  const POISON_FLAGS = ["-q", "--quiet", "-qq", "-vq"] as const;

  for (const flag of POISON_FLAGS) {
    it(`runner=pytest 型含 "${flag}" → exit 1（短选项合写簇逐字符展开命中）`, async () => {
      const res = await submitSpec("u-1", [
        e2eItem("A1", "node -v"),
        unitItem("A2", `pytest tests/unit/ ${flag}`, { runner: "pytest" }),
      ]);

      expect(res.code).toBe(1);
      expect(res.stderr).toContain("规则⑨");
      expect(res.stderr).toContain("A2");
      expect(res.stderr).toContain(flag);
      expect(specBooked()).toBe(false);
    });
  }

  it("裸 pytest 命令（无 -q/--quiet）→ 通过入账", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "pytest tests/unit/ -v --tb=no", { runner: "pytest" }),
    ]);

    expect(res.code).toBe(0);
    expect(specBooked()).toBe(true);
  });
});

describe("R5 e2e-sh / manual 型不设静态规则", () => {
  it("e2e-real 含 --reporter=verbose、manual 含任意毒 flag → 入账不因规则⑨拒绝", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v --reporter=verbose"),
      // manual 型免机器验证，任意 command 形态都不设静态契约规则
      unitItem("A3", "pnpm build --reporter=verbose --outputFile=x.json -q", { type: "manual" }),
      // 规则⑤需要至少一条 unit 级条目（同时充当合规对照形态）
      unitItem("A4", "npx vitest run tests/a.spec.ts"),
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑨");
    expect(specBooked()).toBe(true);
  });
});

describe("R6 路由优先级（runner 显式声明 > type 缺省推导）", () => {
  it("type=unit + runner=pytest 含 -q → 按 pytest 规则查（被拒）；同命令无 runner（vitest 规则）→ 通过", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "pytest tests/unit/ -q", { runner: "pytest" }),
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("-q");
    expect(specBooked()).toBe(false);

    // 同命令去掉 runner：unit 型缺省路由 vitest，-q 不在 vitest 禁令清单 → 通过
    const res2 = await submitSpec("u-2", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "pytest tests/unit/ -q"),
    ]);
    expect(res2.code).toBe(0);
    expect(specBooked()).toBe(true);
  });

  it("缺省推导路由正确：integration→vitest（verbose 被拒）、e2e-real→e2e-sh（-q 不拒）", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "npx vitest run --reporter=verbose tests/a.spec.ts", { type: "integration" }),
    ]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("A2");
    expect(specBooked()).toBe(false);

    // e2e-real 型含 -q：路由 e2e-sh，不设静态规则 → 不因规则⑨拒绝
    const res2 = await submitSpec("u-2", [
      e2eItem("A1", 'echo "A1 PASS" -q'),
      unitItem("A3", "npx vitest run tests/a.spec.ts"),
    ]);
    expect(res2.code).toBe(0);
    expect(specBooked()).toBe(true);
  });
});

describe("R7 多缺口全列不短路", () => {
  it("一条 spec 同时含规则③缺口（A1）+ 规则⑨ verbose 缺口（A2）+ 规则⑨ outputFile 缺口（A5）→ 三缺口全列出且按规则序号升序", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "no-such-bin-xyz foo"),
      unitItem("A2", "npx vitest run --reporter=verbose tests/close.spec.ts"),
      unitItem("A5", "npx vitest run --outputFile=r.json tests/close.spec.ts"),
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("rule③");
    expect(res.stderr).toContain("no-such-bin-xyz");
    expect(res.stderr).toContain("规则⑨");
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("--reporter=verbose");
    expect(res.stderr).toContain("A5");
    expect(res.stderr).toContain("--outputFile=r.json");
    // 规则序号升序：rule③ 在前，规则⑨ 的 A2 与 A5 缺口在后（验收条目序）
    const idx3 = res.stderr.indexOf("rule③");
    const idx9a2 = res.stderr.indexOf("规则⑨: 验收 A2");
    const idx9a5 = res.stderr.indexOf("规则⑨: 验收 A5");
    expect(idx3).toBeGreaterThanOrEqual(0);
    expect(idx9a2).toBeGreaterThan(idx3);
    expect(idx9a5).toBeGreaterThan(idx9a2);
    expect(specBooked()).toBe(false);
  });
});

describe("R8 对照组合法入账", () => {
  it("合规 spec（裸 vitest 命令 + --reporter=json + e2e 带标记行命令）→ exit 0 正常入账", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", 'echo "A1 PASS"'),
      unitItem("A2", "npx vitest run tests/a.spec.ts"),
      unitItem("A3", "npx vitest run --reporter=json tests/b.spec.ts"),
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("已入账");
    expect(specBooked()).toBe(true);
  });
});

// mx5-2 顺带补（基线 §5 R2b）：堵 mx5-1 verifier 红性抽查③暴露的用例缺口——
// 值含 json 子串但非恰 json 的形态必须拒绝（恰 json 白名单是严格相等，非前缀/
// 子串匹配）。只增不改：R2 既有用例零变更。
describe("R2b reporter 值子串形态拒收（json-verbose 含 json 子串非恰 json）", () => {
  it("--reporter=json-verbose（= 形式，值含 json 子串）→ exit 1 列缺口", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "npx vitest run --reporter=json-verbose tests/close.spec.ts"),
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑨");
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("--reporter=json-verbose");
    expect(res.stderr).toContain("值=json-verbose");
    expect(res.stderr).toContain("恢复动作");
    expect(specBooked()).toBe(false);
  });

  it("--reporter json-verbose（空格形式，值含 json 子串）→ 同样拒绝", async () => {
    const res = await submitSpec("u-1", [
      e2eItem("A1", "node -v"),
      unitItem("A2", "npx vitest run --reporter json-verbose tests/close.spec.ts"),
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑨");
    expect(res.stderr).toContain("A2");
    expect(res.stderr).toContain("值=json-verbose");
    expect(specBooked()).toBe(false);
  });
});
