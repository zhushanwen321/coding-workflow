/**
 * u2 单测：cw create（dispatch 层完整路径，真实账本 + tmp 目录，零 mock）。
 *
 * 用例编号「验收N」逐条对应 docs/rewrite/acceptance/u2-acceptance.md「单测验收」：
 * 本文件覆盖第 1 条（create 全部行为）与第 5 条（dispatch 注册）。
 * stderr 断言通过临时替换 process.stderr.write 捕获（观察输出，非 mock 系统）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dispatch, findCommand } from "../src/dispatch.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u2-create-"));
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

function writeBrief(): string {
  const brief = join(cwd, "brief.md");
  writeFileSync(brief, "# 任务书\n");
  return brief;
}

// ── 验收1：cw create ─────────────────────────────────────────

describe("验收1：cw create（dispatch 层）", () => {
  it("合法 → UnitCreated 入账、briefRef 原样、parentId null；stdout 一行确认含 unitId", async () => {
    const brief = writeBrief();
    const res = await run(["create", "--id", "u-root", "--brief", brief]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim().split("\n")).toHaveLength(1);
    expect(res.stdout).toContain("u-root");

    const events = ledger.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("UnitCreated");
    expect(events[0]?.payload).toEqual({ unitId: "u-root", parentId: null, briefRef: brief });
  });

  it("--parent 挂到已有根 unit → parentId 正确入账", async () => {
    const brief = writeBrief();
    expect((await run(["create", "--id", "u-root", "--brief", brief])).code).toBe(0);
    const res = await run(["create", "--id", "u-leaf", "--brief", brief, "--parent", "u-root"]);
    expect(res.code).toBe(0);

    const events = ledger.readAll();
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toEqual({ unitId: "u-leaf", parentId: "u-root", briefRef: brief });
  });

  it("重复 slug → exit 1、stderr 含恢复动作；账本不变", async () => {
    const brief = writeBrief();
    await run(["create", "--id", "u-dup", "--brief", brief]);
    const res = await run(["create", "--id", "u-dup", "--brief", brief]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("u-dup");
    expect(res.stderr).toContain("已存在");
    expect(res.stderr).toContain("恢复动作");
    expect(ledger.readAll()).toHaveLength(1);
  });

  it("非法 slug（大写/下划线/空）→ exit 1，stderr 含规则 ^[a-z][a-z0-9-]*$", async () => {
    const brief = writeBrief();
    for (const bad of ["My-Unit", "my_unit", "1abc", ""]) {
      const res = await run(["create", "--id", bad, "--brief", brief]);
      expect(res.code, `slug "${bad}" 应被拒`).toBe(1);
      expect(res.stderr, `slug "${bad}" 错误信息应含规则`).toContain("^[a-z][a-z0-9-]*$");
    }
    expect(ledger.readAll()).toHaveLength(0);
  });

  it("--parent 不存在 → exit 1、stderr 含恢复动作", async () => {
    const brief = writeBrief();
    const res = await run(["create", "--id", "u-1", "--brief", brief, "--parent", "no-such"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no-such");
    expect(res.stderr).toContain("不存在");
    expect(res.stderr).toContain("恢复动作");
    expect(ledger.readAll()).toHaveLength(0);
  });

  it("三层嵌套（根→叶→再叶）→ exit 1，stderr 说明深度上限 2 层", async () => {
    const brief = writeBrief();
    await run(["create", "--id", "u-root", "--brief", brief]);
    expect((await run(["create", "--id", "u-leaf", "--brief", brief, "--parent", "u-root"])).code).toBe(0);
    const res = await run(["create", "--id", "u-leaf2", "--brief", brief, "--parent", "u-leaf"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("深度");
    expect(res.stderr).toContain("2 层");
    expect(ledger.readAll()).toHaveLength(2);
  });

  it("brief 文件缺失 → exit 1、stderr 含恢复动作", async () => {
    const res = await run(["create", "--id", "u-1", "--brief", join(cwd, "no-such-brief.md")]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("不可读");
    expect(res.stderr).toContain("恢复动作");
    expect(ledger.readAll()).toHaveLength(0);
  });

  it("缺少必填参数（--id / --brief）→ exit 1、stderr 含恢复动作", async () => {
    const brief = writeBrief();
    const noId = await run(["create", "--brief", brief]);
    expect(noId.code).toBe(1);
    expect(noId.stderr).toContain("--id");
    expect(noId.stderr).toContain("恢复动作");

    const noBrief = await run(["create", "--id", "u-1"]);
    expect(noBrief.code).toBe(1);
    expect(noBrief.stderr).toContain("--brief");
    expect(noBrief.stderr).toContain("恢复动作");
  });
});

// ── 验收5：dispatch 注册 ─────────────────────────────────────

describe("验收5：dispatch 注册（三个写命令可被 findCommand 命中）", () => {
  it("create / evidence submit / review submit 按名字命中（含空格子命令形式），summary 非空", () => {
    const create = findCommand(["create"]);
    expect(create?.name).toBe("create");
    expect(create?.handler).toBeTypeOf("function");
    expect(create?.summary ?? "").not.toBe("");

    const evidence = findCommand(["evidence", "submit"]);
    expect(evidence?.name).toBe("evidence submit");
    expect(evidence?.handler).toBeTypeOf("function");
    expect(evidence?.summary ?? "").not.toBe("");

    const review = findCommand(["review", "submit"]);
    expect(review?.name).toBe("review submit");
    expect(review?.handler).toBeTypeOf("function");
    expect(review?.summary ?? "").not.toBe("");
  });
});
