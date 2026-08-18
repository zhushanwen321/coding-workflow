/**
 * u5 e2e-sh 适配器单测（docs/rewrite/acceptance/u5-acceptance.md「单测验收」5-8 条）。
 *
 * fixture 全部真实生成（零 mock）：tmp 写真实 sh 脚本（自写 `<验收id> PASS/FAIL`
 * 标记行 + exit code），chmod 后真实子进程执行，stdout 落盘再交 parse——
 * 与 e2e-real 验收脚本的最终形态一致。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import { e2eShAdapter } from "../src/testrun/e2e-sh.js";
import { defaultRegistry } from "../src/testrun/registry.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u5-e2e-sh-"));
/** 每个用例一个独立脚本文件名，避免相互覆盖 */
let scriptSeq = 0;

function acc(id: string, command?: string): AcceptanceItem {
  return { id, core: true, title: "e2e-sh 适配器 parse 验收", type: "e2e-real", command };
}

/** tmp 写真实脚本并执行（stdout 落盘）——返回产物文件路径与真实 exitCode */
function runScript(body: string): { out: string; status: number } {
  const script = join(tmpRoot, `case-${scriptSeq++}.sh`);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  const res = spawnSync(script, { encoding: "utf8", cwd: tmpRoot });
  const out = `${script}.out`;
  writeFileSync(out, res.stdout ?? "");
  return { out, status: res.status ?? -1 };
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("e2e-sh 适配器 translate", () => {
  it("command 原样返回（适配器不改写 e2e 脚本）", () => {
    expect(e2eShAdapter.translate(acc("A1", "bash e2e/report-cli.sh"))).toBe("bash e2e/report-cli.sh");
  });

  it("command 缺失 → 抛错且指向补救动作", () => {
    expect(() => e2eShAdapter.translate(acc("A1"))).toThrow(/command 缺失/);
  });
});

describe("e2e-sh 适配器 parse（真实脚本 fixture）", () => {
  it("验收#5 真实脚本输出 A1 PASS / A2 FAIL 两行 + exit 1 → cases 如实折叠", () => {
    const { out, status } = runScript('echo "A1 PASS"\necho "A2 FAIL"\nexit 1');
    expect(status).toBe(1);
    const report = e2eShAdapter.parse(out, status, acc("A1"));
    expect(report.exitCode).toBe(1);
    expect(report.rawPath).toBe(out);
    expect(report.cases).toEqual([
      { id: "A1", name: "A1 PASS", status: "pass" },
      { id: "A2", name: "A2 FAIL", status: "fail" },
    ]);
  });

  it("marker 新约定：验收 id 不以 A 开头（TC1）→ 标记行 `TC1 PASS` 正常通过（id 全文 = 第一列）", () => {
    const { out, status } = runScript('echo "TC1 PASS"\nexit 0');
    expect(status).toBe(0);
    const report = e2eShAdapter.parse(out, status, acc("TC1"));
    expect(report.cases).toEqual([{ id: "TC1", name: "TC1 PASS", status: "pass" }]);
  });

  it("marker 新约定：id=A1 时旧文案形态 `AA1 PASS` 被拒（标记 id 须与验收 id 完全一致，无前缀拼接）", () => {
    const { out, status } = runScript('echo "AA1 PASS"\nexit 0');
    expect(status).toBe(0);
    expect(() => e2eShAdapter.parse(out, status, acc("A1"))).toThrow(/AA1.*A1|A1.*AA1/);
  });

  it("验收#6a 标记缺失 + exit 0 → 抛错（无区分力防线）", () => {
    const { out, status } = runScript('echo "all good"\nexit 0');
    expect(status).toBe(0);
    expect(() => e2eShAdapter.parse(out, status, acc("A1"))).toThrow(/无标记行且 exitCode=0/);
  });

  it("验收#6b 标记缺失 + exit≠0 → 整体 fail（id=验收 id，name=no-markers），不抛错", () => {
    const { out, status } = runScript('echo "boom"\nexit 1');
    expect(status).toBe(1);
    const report = e2eShAdapter.parse(out, status, acc("A1"));
    expect(report.cases).toEqual([{ id: "A1", name: "no-markers", status: "fail" }]);
  });

  it("验收#6c 标记 id 与验收 id 不符 → 抛错且信息含两边 id", () => {
    const { out, status } = runScript('echo "A9 PASS"\nexit 0');
    expect(status).toBe(0);
    expect(() => e2eShAdapter.parse(out, status, acc("A1"))).toThrow(/A9.*A1|A1.*A9/);
  });

  it("验收#7 同 id 重复标记以最后一次为准（真实输出重复行）", () => {
    const { out, status } = runScript('echo "A1 PASS"\necho "A1 FAIL"\nexit 1');
    expect(status).toBe(1);
    const report = e2eShAdapter.parse(out, status, acc("A1"));
    expect(report.cases).toEqual([{ id: "A1", name: "A1 FAIL", status: "fail" }]);
  });
});

describe("u5 注册表", () => {
  it("验收#8 defaultRegistry 含 vitest + e2e-sh 两项，type 与 key 一致（mx-2 扩容后另含 pytest/playwright）", () => {
    const registry = defaultRegistry();
    // mx-2 registry 扩容适配：2 → 4（pytest/playwright 经 mx-2 验收文档背书追加）
    expect(registry.size).toBe(4);
    expect(registry.has("vitest")).toBe(true);
    expect(registry.has("e2e-sh")).toBe(true);
    expect(registry.get("vitest")?.type).toBe("vitest");
    expect(registry.get("e2e-sh")?.type).toBe("e2e-sh");
    // mx-2 扩容增量（验收文档 §2「路由断言增量」）
    expect(registry.has("pytest")).toBe(true);
    expect(registry.get("pytest")?.type).toBe("pytest");
    expect(registry.has("playwright")).toBe(true);
    expect(registry.get("playwright")?.type).toBe("playwright");
  });
});
