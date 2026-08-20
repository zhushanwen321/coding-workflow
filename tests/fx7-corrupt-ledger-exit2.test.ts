/**
 * fx-7（pr-cr-fix 阶段 3a）回归：损坏账本的错误契约链（S-1 + S-2 同组联合）。
 *
 * S-1（src/store/events-log.ts）：readAll 此前只校验 JSON 语法，「JSON 合法而
 * 信封形状损坏」（type 非五类枚举 / seq 非正整数 / payload.unitId 非字符串等）
 * 以裸 TypeError 崩在消费方（fold 的 e.payload.unitId 等），违背模块自己
 * 「损坏行抛带恢复动作错误」的承诺。修复 = 读层单点收口最小信封校验，损坏行
 * 抛带行号 + 恢复动作的可操作错误。
 *
 * S-2（src/cli.ts）：顶层 catch-all 此前把未预期异常一律 exit 1，谎称「有 fail
 * 且已入账」——穿透 verify 已文档化的「环境错误 exit 2 不入账」契约。修复 =
 * 未预期异常映射 exit 2；预期错误仍走 handler 返回值出口（正常 0 / fail 1）。
 *
 * 联合语义（验收锚）：损坏账本 → 读层可操作错误（行号 + 恢复动作）→ CLI
 * exit 2 + stderr 带恢复动作。零 mock 真实环境：真实 EventLedger 锁事务写合法
 * 前置 + appendFileSync 模拟外部编辑 + 真实子进程跑 dist/cli.js 走完整
 * dispatch → main → catch-all 路径。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

// 先取本文件所在目录再上一级（fileURLToPath(new URL("..")) 带尾斜杠，套 dirname 会多退一级）
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TESTS_DIR, "..");
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

// realpathSync 归一（macOS /var → /private/var）：父进程写账本与子进程 process.cwd()
// 必须逐字节同路径，否则 encodeCwd 后指向两个不同账本目录（cli-bin.test.ts 同防）
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "cw-fx7-exit2-")));
/** 子进程 CLI 的 CW_HOME（父进程 env 不动，无需 restore） */
const cwHome = join(tmpRoot, "home");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 损坏行其余字段保持合法的 ISO 时间戳（隔离被测缺口） */
const TS = "2026-08-19T00:00:00.000Z";

// ── S-1 单元级：readAll 信封形状校验 ───────────────────────────

describe("S-1：readAll 信封形状校验（JSON 合法 ≠ 形状合法）", () => {
  /** 第 1 行用真实锁事务写合法 UnitCreated，第 2 行 appendFileSync 模拟外部编辑损坏 */
  function corruptLedger(name: string, corruptLine: string): EventLedger {
    const path = join(tmpRoot, name, "events.log");
    const ledger = new EventLedger(path);
    ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
    appendFileSync(path, `${corruptLine}\n`);
    return ledger;
  }

  it("正向锚：合法信封（五类事件）照常读出，校验不误伤", () => {
    const path = join(tmpRoot, "valid", "events.log");
    const ledger = new EventLedger(path);
    ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
    ledger.append("EvidenceSubmitted", {
      unitId: "u-1", runId: "run-1", commit: "c0", paths: [], sha256: [], exitCode: 0,
    });
    const events = ledger.readAll();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["UnitCreated", "EvidenceSubmitted"]);
  });

  it("type 非五类枚举 → 报带行号错误，指出枚举集", () => {
    const ledger = corruptLedger(
      "type-unknown",
      `{"seq":2,"ts":"${TS}","type":"HackedEvent","payload":{"unitId":"u-1"}}`,
    );
    expect(() => ledger.readAll()).toThrow(/第 2 行不是合法事件信封/);
    expect(() => ledger.readAll()).toThrow(/HackedEvent/);
    expect(() => ledger.readAll()).toThrow(/恢复动作/);
  });

  it("缺 seq → 报带行号错误，指出 seq 缺口", () => {
    const ledger = corruptLedger(
      "seq-missing",
      `{"ts":"${TS}","type":"UnitCreated","payload":{"unitId":"u-1","parentId":null,"briefRef":"b.md"}}`,
    );
    expect(() => ledger.readAll()).toThrow(/第 2 行不是合法事件信封/);
    expect(() => ledger.readAll()).toThrow(/seq=undefined 非正整数/);
  });

  it("seq 为字符串（JSON 合法但非数值）→ 同样被拦", () => {
    const ledger = corruptLedger(
      "seq-string",
      `{"seq":"2","ts":"${TS}","type":"UnitCreated","payload":{"unitId":"u-1"}}`,
    );
    expect(() => ledger.readAll()).toThrow(/seq="2" 非正整数/);
  });

  it("ts 非字符串 → 报带行号错误（frontier 的 Date.parse 消费锚）", () => {
    const ledger = corruptLedger(
      "ts-number",
      `{"seq":2,"ts":123,"type":"UnitCreated","payload":{"unitId":"u-1"}}`,
    );
    expect(() => ledger.readAll()).toThrow(/第 2 行不是合法事件信封/);
    expect(() => ledger.readAll()).toThrow(/ts=123 非字符串/);
  });

  it("payload 非对象（缺 payload / 值为字符串）→ 报带行号错误", () => {
    const missing = corruptLedger(
      "payload-missing",
      `{"seq":2,"ts":"${TS}","type":"UnitCreated"}`,
    );
    expect(() => missing.readAll()).toThrow(/payload=undefined 非对象/);

    const strPayload = corruptLedger(
      "payload-string",
      `{"seq":2,"ts":"${TS}","type":"UnitCreated","payload":"u-1"}`,
    );
    expect(() => strPayload.readAll()).toThrow(/payload="u-1" 非对象/);
  });

  it("payload.unitId 缺失 → 报带行号错误（fold 裸读崩溃点的收口锚）", () => {
    const ledger = corruptLedger(
      "unitid-missing",
      `{"seq":2,"ts":"${TS}","type":"UnitCreated","payload":{"parentId":null,"briefRef":"b.md"}}`,
    );
    expect(() => ledger.readAll()).toThrow(/第 2 行不是合法事件信封/);
    expect(() => ledger.readAll()).toThrow(/payload\.unitId=undefined 非字符串/);
    expect(() => ledger.readAll()).toThrow(/恢复动作/);
  });

  it("顶层非对象（数组 / 字符串）→ 报带行号错误", () => {
    const arr = corruptLedger("top-array", `[1,2,3]`);
    expect(() => arr.readAll()).toThrow(/第 2 行不是合法事件信封/);
    expect(() => arr.readAll()).toThrow(/应为事件对象/);

    const str = corruptLedger("top-string", `"not-an-event"`);
    expect(() => str.readAll()).toThrow(/应为事件对象/);
  });

  it("错误信息含账本路径与截断恢复指引（对齐模块既有文案风格）", () => {
    const path = join(tmpRoot, "msg-style", "events.log");
    const ledger = new EventLedger(path);
    ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
    appendFileSync(path, `{"seq":2,"ts":"${TS}","type":"HackedEvent","payload":{"unitId":"u-1"}}\n`);
    expect(() => ledger.readAll()).toThrow(path);
    expect(() => ledger.readAll()).toThrow(/备份后检查该行，从损坏行起截断恢复/);
  });
});

// ── S-1 + S-2 联合 CLI 级：真实子进程完整路径 ───────────────────

describe("S-1 + S-2 联合：损坏账本下 CLI exit 2（真实子进程）", () => {
  beforeAll(() => {
    // 单文件直跑不经 npm test 的 pretest，自行保证 dist 新鲜（cli-bin.test.ts 同模式）
    const res = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, encoding: "utf-8" });
    if (res.status !== 0) {
      throw new Error(`npm run build 失败: ${res.stderr}`);
    }
  });

  /** 每场景独立项目目录（账本按 cwd 隔离） */
  function projectDir(name: string): string {
    const dir = join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 第 1 行真实锁事务写合法事件，第 2 行模拟外部编辑写入损坏行 */
  function appendCorruptLine(cwd: string, corruptLine: string): void {
    const path = ledgerPath(cwHome, cwd);
    const ledger = new EventLedger(path);
    ledger.append("UnitCreated", { unitId: "u-1", parentId: null, briefRef: "brief.md" });
    appendFileSync(path, `${corruptLine}\n`);
  }

  function runCli(
    args: readonly string[],
    cwd: string,
  ): { code: number; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, CW_HOME: cwHome },
    });
    return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  it("形状损坏行下 cw status → exit 2，stderr 带行号 + 恢复动作 + exit 语义说明", () => {
    const cwd = projectDir("cli-status-shape");
    appendCorruptLine(cwd, `{"seq":2,"ts":"${TS}","type":"HackedEvent","payload":{"unitId":"u-1"}}`);
    const r = runCli(["status"], cwd);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("账本第 2 行不是合法事件信封");
    expect(r.stderr).toContain("恢复动作");
    // S-2 catch-all 的 exit 语义说明（区分 exit 1「有 fail 已入账」）
    expect(r.stderr).toContain("未预期异常");
    expect(r.stderr).toContain("exit 2");
  });

  it("形状损坏行下 cw verify → exit 2（账本装载穿透点，旧缺陷 exit 1 谎称 fail 已入账）", () => {
    const cwd = projectDir("cli-verify-shape");
    appendCorruptLine(cwd, `{"seq":2,"ts":"${TS}","type":"UnitCreated","payload":{"parentId":null,"briefRef":"b.md"}}`);
    // 穿透点在账本装载（unitCreatedFacts/readUnit → readAll），早于 git checkout，无需 git 仓库
    const r = runCli(["verify", "--unit", "u-1"], cwd);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("账本第 2 行不是合法事件信封");
    expect(r.stderr).toContain("payload.unitId=undefined");
    expect(r.stderr).toContain("恢复动作");
  });

  it("JSON 语法损坏行下 cw status → exit 2（原 exit 1 的语义升级同样成立）", () => {
    const cwd = projectDir("cli-status-json");
    appendCorruptLine(cwd, `{"seq":2,"ts":"${TS}" "type":"UnitCreated"`);
    const r = runCli(["status"], cwd);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("账本第 2 行不是合法 JSON");
    expect(r.stderr).toContain("恢复动作");
  });

  it("回归锚：预期错误路径 exit 语义不变（--help → 0；verify 缺 --unit → 1）", () => {
    const cwd = projectDir("cli-regression");
    appendCorruptLine(cwd, `{"seq":2,"ts":"${TS}","type":"HackedEvent","payload":{"unitId":"u-1"}}`);

    const help = runCli(["--help"], cwd);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: cw <command>");

    // 参数校验在账本装载之前（handleVerify 首步 fail），坏账本下仍走预期错误出口 exit 1
    const noUnit = runCli(["verify"], cwd);
    expect(noUnit.code).toBe(1);
    expect(noUnit.stderr).toContain("缺少 --unit");
  });
});
