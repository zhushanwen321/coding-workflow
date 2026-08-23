/**
 * lv-1 规则⑫（验收 command 路径逃逸词法拦截，fail 级）——条款逐条对应
 * docs/rewrite/acceptance/lv-1-acceptance.md §5 T1-T12（设计 §4 S2 六形态）。
 *
 * 真实环境零 mock：真实子进程跑 dist/cli.js（完整 dispatch 路径）+ tmp cwd +
 * 隔离 CW_HOME（对齐 tests/al-3-gate-rules.test.ts 范式）。spec 提交路径不触
 * git（build 证据才校验 commit），无需 git 仓。规则③的 PATH 解析依赖真实环境：
 * e2e 条目正向锚用 git / node（PATH 必在）。T10 的 warnings 结构断言走 gate
 * 函数级直接调用（CLI 拒收路径只打印 failures 不打印 warnings——warnings 唯一
 * 消费方是入账成功后的 stderr 打印）。
 * 直接 `npx vitest run tests/lv1-path-escape.test.ts` 不触发 pretest，需先
 * `npm run build`（`npm test` 的 pretest 已含 build）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import { checkSpecRules } from "../src/gates/spec-rules.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), "cw-lv1-gate-"));
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
 * 父进程账本路径计算（encodeCwd）必须用同一物理路径，否则账本「消失」（al-3 同款坑） */
function freshCase(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpRoot, `case-${name}`)));
  writeFileSync(join(dir, "brief.md"), "# 任务书\n");
  return dir;
}

/** 单 unit case（⑫与 layer/split 无正交关系，solo unit 足够且最小） */
function soloCase(name: string, unitId: string): string {
  const cwd = freshCase(name);
  const res = runCli(cwd, ["create", "--id", unitId, "--brief", "brief.md"]);
  expect(res.code, `前置 create ${unitId} 应成功（stderr: ${res.stderr}）`).toBe(0);
  return cwd;
}

/** 写 spec.json 并经真实 CLI 提交（规则⑫的被测入口） */
function submitSpec(
  cwd: string,
  unitId: string,
  acceptance: AcceptanceItem[],
): { code: number; stdout: string; stderr: string } {
  writeFileSync(
    join(cwd, "spec.json"),
    JSON.stringify({ acceptance, contracts: [], split: [] }),
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

/** 规则⑤满足锚：非 unit 型主条目的 spec 需补一条 unit 条目 */
const unitAnchor = (id: string): AcceptanceItem => ({
  id,
  core: false,
  title: "单元行为锚（满足规则⑤）",
  type: "unit",
});

// ================================================================
// T1-T12：规则⑫（fail 级——路径逃逸词法拦截，逃逸使 verify 语义失效）
// ================================================================

describe("T1 cd 绝对路径 + .cw-worktrees 双判据拒入账（S2-a）", () => {
  it("cd /Users/x/.cw-worktrees/u1 && pnpm test → exit 1 不入账，两条 failure 均列，文案含 .cw-worktrees 与相对路径恢复方向", () => {
    const cwd = soloCase("t1", "solo-1");
    const res = submitSpec(cwd, "solo-1", [
      {
        id: "E1",
        core: false,
        title: "绝对路径 cd 逃逸",
        type: "unit",
        command: "cd /Users/x/.cw-worktrees/u1 && pnpm test",
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).toContain("E1");
    expect(res.stderr).toContain(".cw-worktrees");
    // 语义解释段（为什么逃逸使 verify 失效：干净 checkout 判据锚，spec-rules 文案锁定）
    expect(res.stderr).toContain("verify 在干净 checkout 执行");
    // 恢复方向（§4.C 文案要素锁定）：相对路径改写 + 引用物须提交进仓
    expect(res.stderr).toContain("相对路径");
    expect(res.stderr).toContain("提交进仓库");
    // 双判据命中（子串 + cd 词法族）→ 两条 failure 均列（多缺口全列不短路）
    expect(res.stderr.match(/规则⑫/g)).toHaveLength(2);
    expect(specBooked(cwd)).toBe(false);
  });
});

describe("T2 cd ~ home 路径拒入账（S2-b）", () => {
  it("cd ~/project && pnpm test → exit 1 不入账（~ 开头绝对值），命中片段含族 token 与值", () => {
    const cwd = soloCase("t2", "solo-2");
    const res = submitSpec(cwd, "solo-2", [
      {
        id: "E1",
        core: false,
        title: "home 路径逃逸",
        type: "unit",
        command: "cd ~/project && pnpm test",
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    // 命中片段 = "<族token> <绝对路径token>"（词法族判据，非 .cw-worktrees 子串）
    expect(res.stderr).toContain("cd ~/project");
    expect(res.stderr.match(/规则⑫/g)).toHaveLength(1);
    expect(specBooked(cwd)).toBe(false);
  });
});

describe("T3 --root 词法族绝对值双形态（S2-c）", () => {
  it("vitest --root /Users/x/wt run（纯词法族绝对值，不含 .cw-worktrees）→ 拒，单条 failure", () => {
    const cwd = soloCase("t3a", "solo-3a");
    const res = submitSpec(cwd, "solo-3a", [
      {
        id: "E1",
        core: false,
        title: "vitest --root 绝对值",
        type: "unit",
        command: "vitest --root /Users/x/wt run",
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).toContain("--root /Users/x/wt");
    expect(res.stderr.match(/规则⑫/g)).toHaveLength(1);
    expect(specBooked(cwd)).toBe(false);
  });

  it("vitest --root /Users/x/.cw-worktrees/u1 run → 拒，子串 + 词法族两条 failure 均列", () => {
    const cwd = soloCase("t3b", "solo-3b");
    const res = submitSpec(cwd, "solo-3b", [
      {
        id: "E1",
        core: false,
        title: "vitest --root 工作区绝对值",
        type: "unit",
        command: "vitest --root /Users/x/.cw-worktrees/u1 run",
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).toContain(".cw-worktrees");
    expect(res.stderr.match(/规则⑫/g)).toHaveLength(2);
    expect(specBooked(cwd)).toBe(false);
  });
});

describe("T4 相对路径 cd 放行（S2-d 零误杀）", () => {
  it("cd packages/app && vitest run app.test.ts → exit 0 入账，无规则⑫", () => {
    const cwd = soloCase("t4", "solo-4");
    const res = submitSpec(cwd, "solo-4", [
      {
        id: "E1",
        core: false,
        title: "相对路径 cd",
        type: "unit",
        command: "cd packages/app && vitest run app.test.ts",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });
});

describe("T5 相对 --root 值放行（S2-e 零误杀专证）", () => {
  it("vitest --root md-reader run → exit 0 入账——词法族只拦绝对值", () => {
    const cwd = soloCase("t5", "solo-5");
    const res = submitSpec(cwd, "solo-5", [
      {
        id: "E1",
        core: false,
        title: "相对 --root 值",
        type: "unit",
        command: "vitest --root md-reader run",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });
});

describe("T6 wrapper 脚本形态放行（S2-f 零误杀）", () => {
  it("bash scripts/regression.sh → exit 0 入账（wrapper 形态不枚举，词法不可见）", () => {
    const cwd = soloCase("t6", "solo-6");
    const res = submitSpec(cwd, "solo-6", [
      {
        id: "E1",
        core: false,
        title: "wrapper 回归",
        type: "unit",
        command: "bash scripts/regression.sh",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });
});

describe("T7 manual 型豁免", () => {
  it("manual 型条目 command 含 cd /abs/path → 放行（manual 不执行命令，同规则③作用域先例）", () => {
    const cwd = soloCase("t7", "solo-7");
    const res = submitSpec(cwd, "solo-7", [
      {
        id: "M1",
        core: false,
        title: "手工验收",
        type: "manual",
        command: "cd /abs/path && echo done",
      },
      unitAnchor("A2"),
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });
});

describe("T8 剥引号", () => {
  it('cd "/abs/path" && pnpm test → 拒（双引号剥一层后以 / 开头）', () => {
    const cwd = soloCase("t8a", "solo-8a");
    const res = submitSpec(cwd, "solo-8a", [
      {
        id: "E1",
        core: false,
        title: "双引号绝对路径",
        type: "unit",
        command: 'cd "/abs/path" && pnpm test',
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).toContain('cd "/abs/path"');
    expect(specBooked(cwd)).toBe(false);
  });

  it("cd '/abs/path' && pnpm test → 拒（单引号剥一层后以 / 开头）", () => {
    const cwd = soloCase("t8b", "solo-8b");
    const res = submitSpec(cwd, "solo-8b", [
      {
        id: "E1",
        core: false,
        title: "单引号绝对路径",
        type: "unit",
        command: "cd '/abs/path' && pnpm test",
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).toContain("cd '/abs/path'");
    expect(specBooked(cwd)).toBe(false);
  });
});

describe("T9 词法族逐成员与数值后随零误杀", () => {
  it("-C / --dir / --prefix 各跟 /abs 值 → 逐条拒（git -C 由 -C 成员覆盖）", () => {
    const cases: ReadonlyArray<{ name: string; command: string }> = [
      { name: "C", command: "git -C /abs/wt status" },
      { name: "dir", command: "pnpm --dir /abs/x test" },
      { name: "prefix", command: "npm --prefix /abs/x test" },
    ];
    for (const { name, command } of cases) {
      const slug = `solo-9-${name.toLowerCase()}`;
      const cwd = soloCase(`t9-${name}`, slug);
      const res = submitSpec(cwd, slug, [
        {
          id: "E1",
          core: false,
          title: `词法族 ${name} 绝对值`,
          type: "unit",
          command,
        },
      ]);

      expect(res.code, `command "${command}" 应被拒`).toBe(1);
      expect(res.stderr).toContain("规则⑫");
      expect(specBooked(cwd)).toBe(false);
    }
  });

  it("grep -C 2 package.json → 放行（数值后随不误拦——族成员要求后随绝对路径 token）", () => {
    const cwd = soloCase("t9-num", "solo-9num");
    const res = submitSpec(cwd, "solo-9num", [
      {
        id: "E1",
        core: false,
        title: "grep 上下文数值",
        type: "unit",
        command: "grep -C 2 package.json",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });
});

describe("T10 ⑪warning 与 ⑫fail 共存（多缺口与回归）", () => {
  const escapeCommand =
    "npx vitest run --config=/abs/.cw-worktrees/u1/vitest.config.ts";

  it("gate 函数级：同 command 命中⑪形态 A（等号 flag 不算位置参数）与⑫子串 → failures 只含⑫、warnings 只含⑪、ok=false", () => {
    const gate = checkSpecRules({
      unitId: "solo-10",
      specHash: "0".repeat(64),
      acceptance: [
        {
          id: "E1",
          core: false,
          title: "全量回归 + 工作区逃逸",
          type: "unit",
          command: escapeCommand,
        },
      ],
      contracts: [],
      split: [],
    });

    // ok 判定只看 failures（既有语义不变）：⑫ fail 生效
    expect(gate.ok).toBe(false);
    // failures 含⑫且仅含⑫（该 spec 无其他规则缺口——⑫不产生①-⑪的额外输出）
    expect(gate.failures).toHaveLength(1);
    expect(gate.failures[0]).toContain("规则⑫");
    // warnings 含⑪（⑪ warning 路径零变化：命中入账继续的语义锚在函数层不受⑫影响）
    expect(gate.warnings ?? []).toHaveLength(1);
    expect(gate.warnings?.[0]).toContain("规则⑪");
  });

  it("CLI 入账路径：同 spec 提交 → exit 1 不入账，stderr 含⑫ failures 且不含⑪ warning（拒收路径只打 failures）", () => {
    const cwd = soloCase("t10", "solo-10cli");
    const res = submitSpec(cwd, "solo-10cli", [
      {
        id: "E1",
        core: false,
        title: "全量回归 + 工作区逃逸",
        type: "unit",
        command: escapeCommand,
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).not.toContain("规则⑪");
    expect(specBooked(cwd)).toBe(false);
  });
});

describe("T11 e2e 入账拦截（真实 CLI 完整路径）", () => {
  it("e2e-real 条目 git -C /abs/wt status → exit 1 + stderr 含⑫文案与条目 id + 账本无新 SpecSubmitted", () => {
    const cwd = soloCase("t11", "solo-11");
    const res = submitSpec(cwd, "solo-11", [
      {
        id: "E1",
        core: false,
        title: "e2e 逃逸",
        type: "e2e-real",
        command: "git -C /abs/wt status",
      },
      unitAnchor("A2"),
    ]);

    expect(res.code).toBe(1);
    // 规则③零干扰（git 在 PATH 可解析）：唯一 failure 是⑫
    expect(res.stderr).not.toContain("rule③");
    expect(res.stderr.match(/规则⑫/g)).toHaveLength(1);
    expect(res.stderr).toContain("E1");
    expect(specBooked(cwd)).toBe(false);
  });
});

describe("T12 多类型作用域（全部非 manual 型）", () => {
  const cases: ReadonlyArray<{ typeLabel: string; item: AcceptanceItem }> = [
    {
      typeLabel: "unit",
      item: {
        id: "E1",
        core: false,
        title: "unit 型逃逸",
        type: "unit",
        command: "cd /abs && echo done",
      },
    },
    {
      typeLabel: "integration",
      item: {
        id: "I1",
        core: false,
        title: "integration 型逃逸",
        type: "integration",
        command: "cd /abs && echo done",
      },
    },
    {
      typeLabel: "e2e-real",
      item: {
        id: "R1",
        core: false,
        title: "e2e-real 型逃逸",
        type: "e2e-real",
        command: "git -C /abs/wt status",
      },
    },
  ];

  for (const { typeLabel, item } of cases) {
    it(`${typeLabel} 型条目含逃逸 command → 拒`, () => {
      const cwd = soloCase(`t12-${typeLabel}`, `solo-12-${typeLabel}`);
      const res = submitSpec(cwd, `solo-12-${typeLabel}`, [
        item,
        unitAnchor("A9"),
      ]);

      expect(res.code, `${typeLabel} 型应被拒`).toBe(1);
      expect(res.stderr).toContain("规则⑫");
      expect(specBooked(cwd)).toBe(false);
    });
  }
});

// ================================================================
// T13：-C 紧贴绝对路径形态（git 短选项 -C<path> 合法写法——F2 修复前 token
// 既不等于 -C 也不独立成绝对路径 token，严格相等匹配盖不住，设计 D3「git -C
// 由 -C 成员覆盖」在紧贴形态下失效）+ 引号含空白绝对路径的记档漏报锁定
// ================================================================

describe("T13 -C 紧贴绝对路径拦截与零误杀", () => {
  it("git -C/abs/wt status → 拒（命中片段为紧贴 token 原文），单条 failure", () => {
    const cwd = soloCase("t13a", "solo-13a");
    const res = submitSpec(cwd, "solo-13a", [
      {
        id: "E1",
        core: false,
        title: "git -C 紧贴绝对路径",
        type: "unit",
        command: "git -C/abs/wt status",
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).toContain("E1");
    // 命中片段 = 紧贴 token 原文（非分离形态的 "-C /abs/wt"）
    expect(res.stderr).toContain("-C/abs/wt");
    expect(res.stderr.match(/规则⑫/g)).toHaveLength(1);
    expect(specBooked(cwd)).toBe(false);
  });

  it("git -C~/wt status → 拒（~ 紧贴形态与 / 同判）", () => {
    const cwd = soloCase("t13b", "solo-13b");
    const res = submitSpec(cwd, "solo-13b", [
      {
        id: "E1",
        core: false,
        title: "git -C 紧贴 home 路径",
        type: "unit",
        command: "git -C~/wt status",
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).toContain("-C~/wt");
    expect(specBooked(cwd)).toBe(false);
  });

  it("grep -C2 pattern file（紧贴数值上下文）→ 放行——紧贴判定只认 / 与 ~ 前缀值", () => {
    const cwd = soloCase("t13c", "solo-13c");
    const res = submitSpec(cwd, "solo-13c", [
      {
        id: "E1",
        core: false,
        title: "grep 紧贴数值上下文",
        type: "unit",
        command: "grep -C2 pattern file",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });

  it('cd "/abs path"（引号包裹含空白绝对路径）→ 当前放行——记档漏报面的行为锁定', () => {
    const cwd = soloCase("t13d", "solo-13d");
    const res = submitSpec(cwd, "solo-13d", [
      {
        id: "E1",
        core: false,
        title: "含空白引号绝对路径",
        type: "unit",
        command: 'cd "/abs path" && pnpm test',
      },
    ]);

    // tokenize 按空白切分："/abs 与 path" 两 token 引号均不成对、剥引号剥不掉
    // → 漏报放行。这是规则⑫注释记档的诚实漏报面（reviewer 第五维语义审兜底）
    // ——本用例锁定当前词法行为；若未来升级拦截，须连注释漏报面清单一起改
    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });
});

// ================================================================
// T14：长 flag 等号紧贴绝对路径形态（--root=/abs——token 整体既不等于裸
// --root（分离分支盖不住），也非 -C 紧贴形态；等号后值剥引号判定）
// ================================================================

describe("T14 长目录 flag 等号紧贴形态拦截与零误杀", () => {
  it("vitest --root=/abs/wt run → 拒（命中片段为等号 token 原文），单条 failure", () => {
    const cwd = soloCase("t14a", "solo-14a");
    const res = submitSpec(cwd, "solo-14a", [
      {
        id: "E1",
        core: false,
        title: "vitest --root 等号紧贴绝对值",
        type: "unit",
        command: "vitest --root=/abs/wt run",
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).toContain("E1");
    expect(res.stderr).toContain("--root=/abs/wt");
    expect(res.stderr.match(/规则⑫/g)).toHaveLength(1);
    expect(specBooked(cwd)).toBe(false);
  });

  it('pnpm --dir="~/x" test → 拒（整 token 引号包裹，等号后值剥引号后以 ~ 开头）', () => {
    const cwd = soloCase("t14b", "solo-14b");
    const res = submitSpec(cwd, "solo-14b", [
      {
        id: "E1",
        core: false,
        title: "pnpm --dir 引号等号 home 值",
        type: "unit",
        command: 'pnpm --dir="~/x" test',
      },
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("规则⑫");
    expect(res.stderr).toContain('--dir="~/x"');
    expect(specBooked(cwd)).toBe(false);
  });

  it("npm --prefix=relative/path test → 放行（等号后相对路径不在拦截面）", () => {
    const cwd = soloCase("t14c", "solo-14c");
    const res = submitSpec(cwd, "solo-14c", [
      {
        id: "E1",
        core: false,
        title: "npm --prefix 等号相对值",
        type: "unit",
        command: "npm --prefix=relative/path test",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });

  it("vitest --root= run（空值）→ 放行（无路径部分，逃逸面为零）", () => {
    const cwd = soloCase("t14d", "solo-14d");
    const res = submitSpec(cwd, "solo-14d", [
      {
        id: "E1",
        core: false,
        title: "vitest --root 等号空值",
        type: "unit",
        command: "vitest --root= run",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });

  it("grep --root=2 pattern file（非路径数值值）→ 放行（等号判定只认 / 与 ~ 前缀值）", () => {
    const cwd = soloCase("t14e", "solo-14e");
    const res = submitSpec(cwd, "solo-14e", [
      {
        id: "E1",
        core: false,
        title: "grep 等号数值值",
        type: "unit",
        command: "grep --root=2 pattern file",
      },
    ]);

    expect(res.code, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stderr).not.toContain("规则⑫");
    expect(specBooked(cwd)).toBe(true);
  });
});
