/**
 * u1 单测：EventLedger 账本 + project 路径布局（真实 fs / tmp 目录 / 真实子进程取死 pid，零 mock）。
 *
 * 对应验收文档「单测验收」第 6-8 条；另含路径布局、空账本、readUnit、
 * 重复 UnitCreated、损坏行报错的行为锁定。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { SpecSubmittedPayload } from "../src/events/types.js";
import { EventLedger } from "../src/store/events-log.js";
import { encodeCwd, evidenceDir, getCwHome, ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u1-ledger-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function newLedger(name: string): { ledger: EventLedger; path: string } {
  const path = join(tmpRoot, name, "events.log");
  return { ledger: new EventLedger(path), path };
}

function unitCreatedPayload(unitId: string) {
  return { unitId, parentId: null, briefRef: "docs/brief.md" };
}

function specPayload(unitId: string): SpecSubmittedPayload {
  return {
    unitId,
    specHash: "h1",
    acceptance: [
      { id: "A1", core: true, title: "验收 A1", type: "e2e-real", command: "npm test" },
    ],
    contracts: [],
    split: [],
  };
}

function evidencePayload(unitId: string, runId: string) {
  return {
    unitId,
    runId,
    commit: "c0ffee",
    paths: ["report.json"],
    sha256: ["deadbeef"],
    exitCode: 0,
  };
}

// ── project：CW_HOME 与路径布局 ───────────────────────────────

describe("project：CW_HOME 解析与路径布局", () => {
  const originalCwHome = process.env.CW_HOME;

  afterEach(() => {
    if (originalCwHome === undefined) {
      delete process.env.CW_HOME;
    } else {
      process.env.CW_HOME = originalCwHome;
    }
  });

  it("默认 CW_HOME = ~/.cw；绝对路径覆盖生效", () => {
    delete process.env.CW_HOME;
    expect(getCwHome()).toBe(join(homedir(), ".cw"));

    process.env.CW_HOME = "/tmp/cw-test-home";
    expect(getCwHome()).toBe("/tmp/cw-test-home");
  });

  it("CW_HOME 相对路径抛错，错误含恢复动作", () => {
    process.env.CW_HOME = "relative/home";
    expect(() => getCwHome()).toThrow(/绝对路径/);
  });

  function sha8(cwd: string): string {
    return createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  }

  it("encodeCwd：可读前缀 + sha256 防碰撞后缀（`/` `\\` `.` → `__`，异 cwd 必异）", () => {
    // 可读前缀保留原路径形状（`.` / `..` 的特殊目录名防护同旧规则）
    expect(encodeCwd("/Users/x/proj")).toBe(`__Users__x__proj-${sha8("/Users/x/proj")}`);
    expect(encodeCwd("/Users/x/.bare")).toBe(`__Users__x____bare-${sha8("/Users/x/.bare")}`);
    expect(encodeCwd(".")).toBe(`__-${sha8(".")}`);
    expect(encodeCwd("..")).toBe(`____-${sha8("..")}`);
    // 碰撞对（旧编码多对一映射的实害样本）：编码后必不同
    expect(encodeCwd("/a/b")).not.toBe(encodeCwd("/a.b"));
    expect(encodeCwd("/x.y/z")).not.toBe(encodeCwd("/x__y/z"));
    expect(encodeCwd("/a/b\\c")).not.toBe(encodeCwd("/a.b.c"));
    // 同 cwd 编码稳定（确定性）
    expect(encodeCwd("/Users/x/proj")).toBe(encodeCwd("/Users/x/proj"));
  });

  it("ledgerPath / evidenceDir 落在 <home>/<encoded>/ 下", () => {
    const home = "/tmp/cw-home";
    expect(ledgerPath(home, "/Users/x/proj")).toBe(
      join(home, `__Users__x__proj-${sha8("/Users/x/proj")}`, "events.log"),
    );
    expect(evidenceDir(home, "/Users/x/proj", "u-1", "run-1")).toBe(
      join(home, `__Users__x__proj-${sha8("/Users/x/proj")}`, "evidence", "u-1", "run-1"),
    );
  });
});

// ── EventLedger（验收 6-8） ───────────────────────────────────

describe("EventLedger 账本（验收 6-8）", () => {
  it("验收6：append 后 readAll 首尾 seq 连续、JSON 可解析；同 unitId+runId 二次 EvidenceSubmitted 被拒且账本不变", () => {
    const { ledger, path } = newLedger("basic");
    ledger.append("UnitCreated", unitCreatedPayload("u-1"));
    ledger.append("SpecSubmitted", specPayload("u-1"));
    const appended = ledger.append("EvidenceSubmitted", evidencePayload("u-1", "run-1"));
    expect(appended.seq).toBe(3);

    const events = ledger.readAll();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0]?.type).toBe("UnitCreated");
    expect(events[2]?.type).toBe("EvidenceSubmitted");

    // 原始 JSONL 每行可解析（信封四字段齐全）
    const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { seq: number; ts: string; type: string };
      expect(parsed.seq).toBeGreaterThan(0);
      expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed.type).toBeTruthy();
    }

    // 幂等拒绝：同 unitId+runId 二次提交被拒，账本字节不变
    const before = readFileSync(path, "utf-8");
    expect(() => ledger.append("EvidenceSubmitted", evidencePayload("u-1", "run-1"))).toThrow(
      /run-1/,
    );
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(ledger.readAll()).toHaveLength(3);
  });

  it("验收7：对不存在 unit 的 SpecSubmitted 被拒（孤儿防护），错误指向恢复动作", () => {
    const { ledger } = newLedger("orphan");
    expect(() => ledger.append("SpecSubmitted", specPayload("u-ghost"))).toThrow(/u-ghost/);
    expect(() => ledger.append("SpecSubmitted", specPayload("u-ghost"))).toThrow(/UnitCreated/);
    expect(ledger.readAll()).toEqual([]);
  });

  it("验收8：锁文件 stale（手工写未来时间戳 + 死 pid）时能夺取锁继续写", () => {
    const { ledger, path } = newLedger("stale");

    // 真实死 pid：spawnSync 一个立即退出的子进程（已 reap，pid 不再有存活进程）
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(exited.status).toBe(0);
    expect(exited.pid).toBeDefined();
    const deadPid = exited.pid as number;

    // 手工写 lockfile：未来时间戳（年龄检查永不超时）→ 只能靠死 pid 判 stale
    const lockPath = `${path}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${deadPid}\n${Date.now() + 60_000}\n`);
    expect(existsSync(lockPath)).toBe(true);

    const appended = ledger.append("UnitCreated", unitCreatedPayload("u-1"));
    expect(appended.seq).toBe(1);
    expect(ledger.readAll()).toHaveLength(1);
    // 正常路径下锁已释放
    expect(existsSync(lockPath)).toBe(false);
  });

  it("锁文件存在但指纹为空（「创建-写入指纹」空窗口 / 残留）→ 等待而非删除，超时报含 rm 的环境错误", () => {
    const { ledger, path } = newLedger("empty-fingerprint");

    // 手工创建空 lockfile：模拟他进程 openSync(wx) 成功后、writeSync 指纹前的
    // 空窗口被冻结（真实窗口毫秒级自愈；此处用永久空文件验证「绝不 unlink」）
    const lockPath = `${path}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "");
    expect(existsSync(lockPath)).toBe(true);

    // 另一账本实例（短锁超时，测试专用注入）尝试写入：不得清锁成功——旧实现
    // 读到空指纹 → null → unlink 误删，正是本用例防的回归
    // rp-0 D2 泛化后构造签名 = (ledgerPath, domain?, options?)——options 移至第三位，
    // 此处 domain 缺省 unit 域（与泛化前行为一致），仅注入短锁超时
    const victim = new EventLedger(path, undefined, { lockTotalTimeoutMs: 300 });
    expect(() => victim.append("UnitCreated", unitCreatedPayload("u-1"))).toThrow(/读不出有效指纹/);
    expect(() => victim.append("UnitCreated", unitCreatedPayload("u-1"))).toThrow(/rm "/);
    // 锁文件未被误删（等待重试而非清锁），账本也未被写入
    expect(existsSync(lockPath)).toBe(true);
    expect(ledger.readAll()).toEqual([]);

    // 恢复动作闭环：删除 lockfile 后写入成功（错误信息里的 rm 命令真实有效）
    rmSync(lockPath);
    const appended = ledger.append("UnitCreated", unitCreatedPayload("u-1"));
    expect(appended.seq).toBe(1);
  });
});

// ── EventLedger 行为锁定 ──────────────────────────────────────

describe("EventLedger 行为锁定", () => {
  it("账本文件不存在时 readAll 返回空数组（全新项目）", () => {
    const { ledger } = newLedger("empty");
    expect(ledger.readAll()).toEqual([]);
  });

  it("readUnit 只返回该 unit 的事件，按账本顺序", () => {
    const { ledger } = newLedger("read-unit");
    ledger.append("UnitCreated", unitCreatedPayload("u-a"));
    ledger.append("UnitCreated", unitCreatedPayload("u-b"));
    ledger.append("SpecSubmitted", specPayload("u-a"));
    ledger.append("SpecSubmitted", specPayload("u-b"));

    const eventsOfA = ledger.readUnit("u-a");
    expect(eventsOfA.map((e) => e.seq)).toEqual([1, 3]);
    expect(ledger.readUnit("u-none")).toEqual([]);
  });

  it("重复 UnitCreated 被拒（同 unitId 只能 create 一次）", () => {
    const { ledger } = newLedger("dup-create");
    ledger.append("UnitCreated", unitCreatedPayload("u-1"));
    expect(() => ledger.append("UnitCreated", unitCreatedPayload("u-1"))).toThrow(/已创建/);
    expect(ledger.readAll()).toHaveLength(1);
  });

  it("孤儿防护同样适用于 VerdictSubmitted / EvidenceSubmitted / VerifyRan", () => {
    const { ledger } = newLedger("orphan-kinds");
    expect(() =>
      ledger.append("VerdictSubmitted", {
        unitId: "u-ghost",
        verdictKind: "spec-review",
        verdict: "pass",
      }),
    ).toThrow(/UnitCreated/);
    expect(() =>
      ledger.append("EvidenceSubmitted", evidencePayload("u-ghost", "run-1")),
    ).toThrow(/UnitCreated/);
    expect(() =>
      ledger.append("VerifyRan", {
        unitId: "u-ghost",
        runId: "run-1",
        reportHash: "rh",
        result: "pass",
        acceptanceIds: ["A1"],
      }),
    ).toThrow(/UnitCreated/);
  });

  it("损坏行抛可操作错误（含行号与恢复动作）", () => {
    const { ledger, path } = newLedger("corrupt");
    ledger.append("UnitCreated", unitCreatedPayload("u-1"));
    writeFileSync(path, `${readFileSync(path, "utf-8")}{broken\n`, "utf-8");
    expect(() => ledger.readAll()).toThrow(/第 2 行/);
    expect(() => ledger.readAll()).toThrow(/截断/);
  });
});
