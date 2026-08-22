/**
 * al-3 gate 双规则（T / W 系）：规则⑩（fail 级：topic 条目要求 split 非空）+
 * 规则⑪（warning 级：unit 层全量回归形态成本启发式）——条款逐条对应
 * docs/rewrite/acceptance/al-3-acceptance.md §5 T1-T5 / W1-W6。
 *
 * 真实环境零 mock：真实子进程跑 dist/cli.js（完整 dispatch 路径）+ tmp cwd +
 * 隔离 CW_HOME。spec 提交路径不触 git（build 证据才校验 commit），无需 git 仓。
 * 规则③的 PATH 解析依赖真实环境：e2e 条目正向锚用 node（PATH 必在）。
 * 直接 `npx vitest run tests/al-3-gate-rules.test.ts` 不触发 pretest，需先
 * `npm run build`（`npm test` 的 pretest 已含 build）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem, SplitEntry } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), "cw-al3-gate-"));
const cwHome = join(tmpRoot, "cw-home");
mkdirSync(cwHome, { recursive: true });

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 真实子进程跑 dist/cli.js（e2e 形态：完整 dispatch 路径） */
function runCli(
  cwd: string,
  args: readonly string[],
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, CW_HOME: cwHome },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 每用例独立 cwd（= 独立账本）+ 可读 brief 文件（create 前置校验）。
 * 返回物理路径：子进程 process.cwd() 解析符号链接（macOS /var → /private/var），
 * 父进程账本路径计算（encodeCwd）必须用同一物理路径，否则账本「消失」（al-2 同款坑） */
function freshCase(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpRoot, `case-${name}`)));
  writeFileSync(join(dir, "brief.md"), "# 任务书\n");
  return dir;
}

/** 真实前置链建 unit：root 或叶子（--parent 指定时不另建父，调用方自建） */
function createUnit(cwd: string, unitId: string, parent?: string): void {
  const args =
    parent === undefined
      ? ["create", "--id", unitId, "--brief", "brief.md"]
      : ["create", "--id", unitId, "--brief", "brief.md", "--parent", parent];
  const res = runCli(cwd, args);
  expect(res.code, `前置 create ${unitId} 应成功（stderr: ${res.stderr}）`).toBe(0);
}

/** 写 spec.json 并经真实 CLI 提交（gate 双规则的被测入口） */
function submitSpec(
  cwd: string,
  unitId: string,
  acceptance: AcceptanceItem[],
  split: SplitEntry[] = [],
): { code: number; stdout: string; stderr: string } {
  writeFileSync(
    join(cwd, "spec.json"),
    JSON.stringify({ acceptance, contracts: [], split }),
  );
  return runCli(cwd, [
    "evidence",
    "submit",
    "--kind",
    "spec",
    "--unit",
    unitId,
    "--file",
    "spec.json",
  ]);
}

/** 账本内是否存在该 cwd 的 SpecSubmitted（「不入账」的共同断言锚） */
function specBooked(cwd: string): boolean {
  return new EventLedger(ledgerPath(cwHome, cwd))
    .readAll()
    .some((e) => e.type === "SpecSubmitted");
}

/** leaf spec 夹具：root + 叶子（叶子 = split 必空的真实形态） */
function leafFixture(name: string, rootId: string, leafId: string): string {
  const cwd = freshCase(name);
  createUnit(cwd, rootId);
  createUnit(cwd, leafId, rootId);
  return cwd;
}

// ================================================================
// T 系：规则⑩（fail 级——叶子/无子节点 unit 声明 topic = 真空，提交期拒绝）
// ================================================================

describe("T1 叶子 topic 条目拒入账", () => {
  it("叶子 unit（split 空）spec 含 layer: \"topic\" 条目 → exit 1 不入账，stderr 含条目 id / split 为空 / 集成执行点 / 永不被执行 / 两个恢复方向", () => {
    const cwd = leafFixture("t1", "root-1", "leaf-1");
    const res = submitSpec(cwd, "leaf-1", [
      { id: "E7", core: false, title: "全量回归", type: "unit", layer: "topic" },
      { id: "A2", core: false, title: "功能验收", type: "unit" },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑩");
    expect(res.stderr).toContain("E7");
    expect(res.stderr).toContain("split 为空");
    expect(res.stderr).toContain("集成执行点");
    expect(res.stderr).toContain("永不被执行");
    // 两个恢复方向（§4.A 要素锁定）：上收 root spec 标 topic / 去 layer 按 unit 层
    expect(res.stderr).toContain("上收 root spec 并标 layer");
    expect(res.stderr).toContain('去掉 layer 字段按 unit 层声明');
    expect(specBooked(cwd)).toBe(false);
  });

  it("已知边界：无子 root（split 空）声明 topic 同样拒绝——单 unit topic 本就没有集成执行点", () => {
    const cwd = freshCase("t1-boundary");
    createUnit(cwd, "solo-1");
    const res = submitSpec(cwd, "solo-1", [
      { id: "R1", core: false, title: "回归", type: "unit", layer: "topic" },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑩");
    expect(res.stderr).toContain("R1");
    expect(specBooked(cwd)).toBe(false);
  });
});

describe("T2 root topic 条目正常入账", () => {
  it("root（子已 cw create，split 非空指向已建子）spec 含 layer: \"topic\" 条目 → exit 0 入账，无⑩缺口无⑪ warning", () => {
    const cwd = freshCase("t2");
    createUnit(cwd, "root-2");
    createUnit(cwd, "root-2-leaf", "root-2");
    const res = submitSpec(
      cwd,
      "root-2",
      [
        {
          id: "T1",
          core: true,
          title: "全量回归上收集成层",
          type: "e2e-real",
          command: "node -v",
          layer: "topic",
        },
        { id: "A2", core: false, title: "功能验收", type: "unit" },
      ],
      [{ unitId: "root-2-leaf", dependsOn: [] }],
    );

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("已入账");
    expect(res.stderr).not.toContain("规则⑩");
    expect(res.stderr).not.toContain("规则⑪");
    expect(specBooked(cwd)).toBe(true);
  });
});

describe("T3 unit 层条目不受规则⑩", () => {
  it("叶子 spec 混合 layer: \"unit\" 显式声明与缺省 layer → 不触发⑩，正常入账", () => {
    const cwd = leafFixture("t3", "root-3", "leaf-3");
    const res = submitSpec(cwd, "leaf-3", [
      { id: "A1", core: false, title: "显式 unit 层", type: "unit", layer: "unit" },
      { id: "A2", core: false, title: "缺省层（键缺失）", type: "unit" },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑩");
    expect(specBooked(cwd)).toBe(true);
  });
});

describe("T4 多条 topic 缺口全列不短路", () => {
  it("两条 topic 条目 → 缺口逐条列出（两条规则⑩行，各含自己的条目 id）", () => {
    const cwd = leafFixture("t4", "root-4", "leaf-4");
    const res = submitSpec(cwd, "leaf-4", [
      { id: "T1", core: false, title: "回归一", type: "unit", layer: "topic" },
      { id: "T2", core: false, title: "回归二", type: "unit", layer: "topic" },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("T1");
    expect(res.stderr).toContain("T2");
    expect(res.stderr.match(/规则⑩/g)).toHaveLength(2);
    expect(specBooked(cwd)).toBe(false);
  });
});

describe("T5 规则⑩与①-⑨共存全列", () => {
  it("同一 spec 含规则③缺口（e2e 缺 command）与⑩缺口（叶子 topic）→ 两规则缺口同列且按序号升序", () => {
    const cwd = leafFixture("t5", "root-5", "leaf-5");
    const res = submitSpec(cwd, "leaf-5", [
      { id: "A1", core: true, title: "核心链路", type: "e2e-real" },
      { id: "E7", core: false, title: "全量回归", type: "unit", layer: "topic" },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("rule③");
    expect(res.stderr).toContain("A1");
    expect(res.stderr).toContain("规则⑩");
    expect(res.stderr).toContain("E7");
    // 规则序号升序：③ 在前，⑩ 在后
    expect(res.stderr.indexOf("rule③")).toBeGreaterThanOrEqual(0);
    expect(res.stderr.indexOf("规则⑩")).toBeGreaterThan(res.stderr.indexOf("rule③"));
    expect(specBooked(cwd)).toBe(false);
  });
});

// ================================================================
// W 系：规则⑪（warning 级——unit 层全量回归形态，入账继续 + stderr 警告）
// ================================================================

describe("W1 叶子全量形态 warning + 入账继续", () => {
  it("叶子 spec 含 npx vitest run（无位置参数）unit 层条目 → exit 0 入账 + stderr 含规则⑪文案（上收方向 + 收窄方向 + 条目 id）", () => {
    const cwd = leafFixture("w1", "root-w1", "leaf-w1");
    const res = submitSpec(cwd, "leaf-w1", [
      { id: "E7", core: false, title: "全量单测", type: "unit", command: "npx vitest run" },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(specBooked(cwd)).toBe(true);
    expect(res.stderr).toContain("规则⑪");
    expect(res.stderr).toContain("E7");
    expect(res.stderr).toContain("上收 root spec 并标 layer");
    expect(res.stderr).toContain("加文件参数收窄");
    // 已入账事实先行（警告非拒绝的语义锚）
    expect(res.stderr).toContain("已入账");
  });
});

describe("W2 root unit 层全量形态（split 非空文案分流）", () => {
  it("split 非空的 spec 含 npx vitest run unit 层条目 → exit 0 + warning 为「建议显式标 layer: \\\"topic\\\"」形态", () => {
    const cwd = freshCase("w2");
    createUnit(cwd, "root-w2");
    createUnit(cwd, "root-w2-leaf", "root-w2");
    const res = submitSpec(
      cwd,
      "root-w2",
      [{ id: "E7", core: false, title: "全量单测", type: "unit", command: "npx vitest run" }],
      [{ unitId: "root-w2-leaf", dependsOn: [] }],
    );

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(specBooked(cwd)).toBe(true);
    expect(res.stderr).toContain("规则⑪");
    expect(res.stderr).toContain('建议显式标 layer: "topic"');
    // 两种 split 形态文案分流：内部节点形态不给叶子的「加文件参数收窄」建议
    expect(res.stderr).not.toContain("加文件参数收窄");
  });
});

describe("W3 文件参数形态不命中", () => {
  it("npx vitest run tests/foo.test.ts（带位置参数 = 已收窄）→ 无规则⑪输出", () => {
    const cwd = leafFixture("w3", "root-w3", "leaf-w3");
    const res = submitSpec(cwd, "leaf-w3", [
      {
        id: "E7",
        core: false,
        title: "范围收窄的单测",
        type: "unit",
        command: "npx vitest run tests/foo.test.ts",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(specBooked(cwd)).toBe(true);
    expect(res.stderr).not.toContain("规则⑪");
  });
});

describe("W4 wrapper 脚本形态不命中（诚实漏报面锁定）", () => {
  it("bash scripts/regression.sh → 无规则⑪输出（词法不可见，漏报面由 reviewer 第六维兜底——锁定不误报）", () => {
    const cwd = leafFixture("w4", "root-w4", "leaf-w4");
    const res = submitSpec(cwd, "leaf-w4", [
      {
        id: "E7",
        core: false,
        title: "wrapper 回归",
        type: "unit",
        command: "bash scripts/regression.sh",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(specBooked(cwd)).toBe(true);
    expect(res.stderr).not.toContain("规则⑪");
  });
});

describe("W5 全仓 script 形态命中（形态 B）", () => {
  it("pnpm run lint → exit 0 + 规则⑪ warning", () => {
    const cwd = leafFixture("w5a", "root-w5a", "leaf-w5a");
    const res = submitSpec(cwd, "leaf-w5a", [
      { id: "L1", core: false, title: "全仓 lint", type: "unit", command: "pnpm run lint" },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(specBooked(cwd)).toBe(true);
    expect(res.stderr).toContain("规则⑪");
    expect(res.stderr).toContain("L1");
  });

  it("npm test → exit 0 + 规则⑪ warning", () => {
    const cwd = leafFixture("w5b", "root-w5b", "leaf-w5b");
    const res = submitSpec(cwd, "leaf-w5b", [
      { id: "T1", core: false, title: "全仓测试", type: "unit", command: "npm test" },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(specBooked(cwd)).toBe(true);
    expect(res.stderr).toContain("规则⑪");
    expect(res.stderr).toContain("T1");
  });
});

describe("W6 干净路径零污染", () => {
  it("合规 spec（无形态命中）→ exit 0 入账，stderr 为空（结构断言：与改造前输出同形态，无规则⑪痕迹）", () => {
    const cwd = leafFixture("w6", "root-w6", "leaf-w6");
    const res = submitSpec(cwd, "leaf-w6", [
      {
        id: "A1",
        core: true,
        title: "核心链路",
        type: "e2e-real",
        command: "node -v",
      },
      { id: "A2", core: false, title: "功能验收", type: "unit" },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(specBooked(cwd)).toBe(true);
    expect(res.stdout).toContain("已入账");
    // 改造前成功提交的 stderr 恒空（succeed 走 stdout）——逐字节同形态的等价断言
    expect(res.stderr).toBe("");
  });
});
