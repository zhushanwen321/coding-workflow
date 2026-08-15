/**
 * fx-1 R3 回归（docs/rewrite/acceptance/fx-1-acceptance.md R3）：e2e-sh marker
 * 约定显式化——parse 两类错误的 message 追加格式说明全文。
 *
 * 根因（final-gate-report.md §5 R3）：「验收 id 须 A 开头」的折叠约定只在适配器
 * 实现里隐含（标记 "L2 PASS" 折叠 key "AL2" 与验收 id "L2" 永不相等），终验中
 * pi 试错 3 轮才悟出；错误信息直接给出约定本身。
 *
 * 真实环境零 mock：tmp 写真实 sh 脚本，chmod 后真实子进程执行，stdout 落盘再
 * 交 parse（u5 同款 fixture 形态）。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import { e2eShAdapter } from "../src/testrun/e2e-sh.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx1-r3-"));
let scriptSeq = 0;

/** 验收文档锁定的格式说明全文（fx-1 R3 追加到两类 parse 错误的 message 里） */
const MARKER_FORMAT_NOTE =
  "e2e-sh 验收脚本须输出标记行 `A<验收id> PASS` 或 `A<验收id> FAIL`" +
  "（A 前缀 + 验收 id + 空格 + 结果），脚本 exit code 与标记行一致。";

function acc(id: string): AcceptanceItem {
  return { id, core: true, title: "fx1 R3 marker 格式说明", type: "e2e-real", command: "bash e2e/run.sh" };
}

/** tmp 写真实脚本并执行（stdout 落盘），返回产物路径与真实 exitCode */
function runScript(body: string): { out: string; status: number } {
  const script = join(tmpRoot, `case-${scriptSeq++}.sh`);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  const res = spawnSync(script, { encoding: "utf8", cwd: tmpRoot });
  const out = `${script}.out`;
  writeFileSync(out, res.stdout ?? "");
  return { out, status: res.status ?? -1 };
}

/** 执行 parse 并捕获抛出的 message（不吞其他异常形态） */
function parseErrorMessage(out: string, status: number, acceptance: AcceptanceItem): string {
  try {
    e2eShAdapter.parse(out, status, acceptance);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("parse 未抛错（fixture 断言前置失败：应抛错）");
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("fx-1 R3：e2e-sh parse 错误信息含 marker 格式说明全文", () => {
  it("无标记 + exit 0 → 抛错，message 含格式说明全文（验收文档指定场景）", () => {
    const { out, status } = runScript('echo "all good"\nexit 0');
    expect(status).toBe(0);
    const message = parseErrorMessage(out, status, acc("A1"));
    expect(message).toContain("无标记行且 exitCode=0"); // 既有语义不回退
    expect(message).toContain(MARKER_FORMAT_NOTE); // 格式说明全文
  });

  it("标记 id 与验收 id 不符 → 抛错，message 同样含格式说明全文", () => {
    const { out, status } = runScript('echo "A9 PASS"\nexit 0');
    expect(status).toBe(0);
    const message = parseErrorMessage(out, status, acc("A1"));
    expect(message).toContain("A9");
    expect(message).toContain(MARKER_FORMAT_NOTE);
  });
});
