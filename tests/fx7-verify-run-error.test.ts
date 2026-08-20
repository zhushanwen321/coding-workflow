/**
 * fx-7 单测：verify 执行引擎两条修复（.review/run-1787182354/aggregated.md
 * MF-1 + S-8；真实子进程 + tmp 目录 + 零 mock，进程内直调 dist）。
 *
 *   MF-1 execBashTree spawn 异步失败不再进程级崩溃：
 *      - 引擎级：cwd 指向不存在目录 → uv_spawn 同步失败（pid undefined，
 *        bashResolvable 预检不覆盖 cwd，真实触发排队中的 'error' 事件）→
 *        结算为 spawn-error；事件循环恢复后审计行落 stderr 产物。无监听器
 *        时本用例进程会被 uncaughtException 打死（node v24 探针实证）——
 *        用例跑绿本身即证明监听存在且错误被接住
 *      - 黑盒：runAcceptances（cw verify 唯一执行路径）下同类失败结算为该条
 *        fail 而非中断/崩溃
 *   S-8 哨兵「创建-写入」空窗口：
 *      - 窗口救回：哨兵先以空内容存在（模拟 bash `>` 刚建文件的瞬间），真实
 *        子进程 20ms 后落笔退出码 → readSentinel 同步调用经短重读取到真值
 *      - 真损坏：内容非数字 → 重读后仍无效返回 undefined（execBashTree 记
 *        审计行后按 -1 结算——该分支无法用真实子进程稳定构造「wrapper 落笔
 *        后再损坏」时序，由引擎级回归用例与代码审查覆盖）
 *   回归：正常路径 exit 码照旧经哨兵传出（done 3）
 *
 * 注意：直接 `npx vitest run tests/fx7-verify-run-error.test.ts` 不触发
 * pretest，需先 `npm run build`（`npm test` 的 pretest 已含）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../dist/events/types.js";
import { execBashTree, readSentinel, runAcceptances } from "../dist/verify/run.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
if (!existsDistRun()) {
  throw new Error("tests/fx7-verify-run-error 需要 dist/（先 npm run build；npm test 的 pretest 已含）");
}

function existsDistRun(): boolean {
  try {
    // 静态导入已发生，这里只做存在性自检给出可操作错误（与 fx6 惯例一致）
    readFileSync(join(REPO_ROOT, "dist", "verify", "run.js"));
    return true;
  } catch {
    return false;
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-fx7-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** bash 单引号包裹（哨兵路径嵌入 command 用） */
function quote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function caseDir(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const env: NodeJS.ProcessEnv = { ...process.env };

// ---- MF-1：spawn 异步失败结算（引擎级） ----

describe("fx-7 MF-1 execBashTree：spawn 异步失败被结算为 spawn-error 而非进程崩溃", () => {
  it("cwd 不存在 → spawn-error + stderr 产物落「bash spawn 异步失败」审计行", async () => {
    const dir = caseDir("mf1-engine");
    const stdoutPath = join(dir, "cmd.stdout");
    const stderrPath = join(dir, "cmd.stderr");
    const sentinelPath = join(dir, "cmd.exit");

    const out = execBashTree("true", join(tmpRoot, "no-such-checkout-dir"), env, stdoutPath, stderrPath, sentinelPath, 3_000);

    // 失败结算走既有 spawn-error 语义（本机 node v24 下 uv_spawn 对无效 cwd
    // 同步失败 → pid undefined；平台若走 fork 路径则哨兵永不落盘 → timeout，
    // 两者都是「优雅结算为失败」，断言取并集外的共同否定项：绝非 done）
    expect(out.kind).not.toBe("done");
    if (out.kind === "spawn-error") {
      expect(out.message).toContain("子进程未启动");
    }

    // 无监听器时走到这里进程已被 uncaughtException 打死（探针实证）；让事件
    // 循环 tick 一次投递排队的 'error' 事件，断言监听器把审计行写进了产物
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(readFileSync(stderrPath, "utf-8")).toContain("bash spawn 异步失败");
  });
});

// ---- MF-1：黑盒整链路（cw verify 唯一执行路径） ----

describe("fx-7 MF-1 runAcceptances：同类 spawn 失败结算为该条 fail 而非中断", () => {
  it("checkoutDir 不存在的 e2e 验收 → status fail，reason 指向 bash 执行失败", async () => {
    const evidenceDir = caseDir("mf1-blackbox");
    const ac: AcceptanceItem = {
      id: "E1",
      core: true,
      title: "spawn 失败路径的 e2e 条目",
      type: "e2e-real",
      command: "node e1.js",
    };

    const outcome = runAcceptances(join(tmpRoot, "no-such-checkout-dir-2"), [ac], evidenceDir);
    const first = outcome.results[0];
    expect(first).toBeDefined();
    expect(first?.status).toBe("fail");
    expect(first?.reason).toContain("无法执行 bash -c");

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(readFileSync(first?.stderrPath ?? "", "utf-8")).toContain("bash spawn 异步失败");
  });
});

// ---- S-8：哨兵「创建-写入」空窗口 ----

describe("fx-7 S-8 readSentinel：空窗口短重读救回，真损坏返回 undefined", () => {
  it("哨兵为空（`>` 已建文件、printf 未落笔的窗口瞬间）→ 重读取得真实子进程落笔的退出码", () => {
    const sentinelPath = join(caseDir("s8-window"), "cmd.exit");
    writeFileSync(sentinelPath, ""); // 窗口瞬间的空哨兵
    // 真实时序：20ms 后另一个 bash 落笔退出码（模拟 wrapper printf 完成写入）
    spawn("bash", ["-c", `sleep 0.02; printf '42\\n' > ${quote(sentinelPath)}`], { stdio: "ignore" });

    // 同步调用撞上窗口：首次解析 NaN → 短重读（50ms）拿到 42，成功命令不再被误记 -1
    expect(readSentinel(sentinelPath)).toBe(42);
  });

  it("哨兵内容非数字（真损坏）→ 重读后仍无效返回 undefined（不再静默 -1）", () => {
    const sentinelPath = join(caseDir("s8-corrupt"), "cmd.exit");
    writeFileSync(sentinelPath, "not-a-number\n");
    expect(readSentinel(sentinelPath)).toBeUndefined();
  });
});

// ---- 回归：正常路径退出码照旧 ----

describe("fx-7 回归：execBashTree 正常路径退出码经哨兵传出", () => {
  it("exit 3 → done exitCode 3（含等待轮询与整组回收）", () => {
    const dir = caseDir("regression-done");
    const out = execBashTree("exit 3", dir, env, join(dir, "r.stdout"), join(dir, "r.stderr"), join(dir, "r.exit"), 15_000);
    expect(out).toEqual({ kind: "done", exitCode: 3 });
  });
});
