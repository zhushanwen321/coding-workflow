/**
 * W4 grep AC 机器复核（.xyz-harness/rp-release-pipeline/system-architecture.md §11）。
 *
 * 把三条架构反模式 AC 固化为测试，防止后续演化腐蚀双域边界：
 *   AC-1 双域边界锁（适用域门控）——当且仅当本分支触碰了 gate·pipeline 域
 *      源码（边界敏感波次），unit 域九个路径必须零 diff；unit 域波次对本域
 *      的本职演化不在锁的适用域内（跳过出声），由全局静态的 AC-2/AC-3 兜底
 *   AC-2 gate·pipeline 不 import unit 域事件类型
 *   AC-3 事件构造收敛：GateCheckRan/GateCacheHit/PipelineStepRan 字符串作为
 *      append 第一参（构造点）只出现在 src/gate/ 与 src/pipeline/
 *
 * AC-1 门控判定抽为纯函数（tests/fixtures/w4-ac1.ts），由
 * tests/w4-ac1-classify.test.ts 机器复核。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyBranch } from "./fixtures/w4-ac1.js";

const ROOT = join(import.meta.dirname, "..");

/** 递归收集 src/ 下 .ts 文件（相对路径） */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("w4 T4.1 grep AC 机器复核", () => {
  it("AC-2：gate·pipeline 域不 import unit 域事件类型（src/events/types）", () => {
    const offenders: string[] = [];
    for (const dir of ["src/gate", "src/pipeline"]) {
      for (const file of tsFiles(join(ROOT, dir))) {
        const content = readFileSync(file, "utf-8");
        if (content.includes('from "../events/types') || content.includes('from "../../events/types')) {
          offenders.push(file);
        }
      }
    }
    expect(offenders, `域间 import 腐蚀：${offenders.join(", ")}`).toEqual([]);
  });

  it("AC-3：三类 gate 事件构造（ledger.append 调用点）收敛在 gate/pipeline 核心域", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(join(ROOT, "src"))) {
      const rel = file.slice(ROOT.length + 1);
      if (rel.startsWith("src/gate/") || rel.startsWith("src/pipeline/")) {
        continue;
      }
      const content = readFileSync(file, "utf-8");
      // 构造形态 = append 第一参字符串字面量（handlers 层的输出文案/类型定义引用不算构造）
      if (/\.append\(\s*"(GateCheckRan|GateCacheHit|PipelineStepRan)"/.test(content)) {
        offenders.push(rel);
      }
    }
    expect(offenders, `事件构造泄漏出域：${offenders.join(", ")}`).toEqual([]);
  });

  it("AC-1（可重跑近似）：边界敏感波次内 unit 域九路径零行为改动——git diff 为空", () => {
    // 适用域门控：AC-1 锁的是「gate·pipeline 波次不得顺手改 unit 域」。分叉点
    // 动态解析（merge-base HEAD origin/main）后取本分支自己的全量改动清单：
    // 清单含 src/gate|pipeline → 边界敏感波次，强制 unit 域零 diff；
    // 否则（unit 域 / 文档 / 测试等波次）触碰 unit 域属本职而非越界，不适用
    // 即跳过出声。若无此门控，任何触碰 unit 域的开发分支都会让本锁常态红、
    // 合回 main 又自愈——信号价值归零（狼来了）。静态边界由 AC-2/AC-3 全局兜底。
    // 门控纯判定见 fixtures/w4-ac1.ts（tests/w4-ac1-classify.test.ts 复核）。
    let verdict: ReturnType<typeof classifyBranch> | null = null;
    try {
      const forkPoint = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
        cwd: ROOT,
        encoding: "utf-8",
      }).trim();
      const changedFiles = execFileSync("git", ["diff", "--name-only", `${forkPoint}..HEAD`], {
        cwd: ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      verdict = classifyBranch(changedFiles);
    } catch (e) {
      // 只允许 git 进程正常失败（浅历史/无 origin/main ref）；spawn 级异常等其它错误
      // status 缺失 → 此处 fail 出声。
      expect((e as { status?: number }).status, `git 异常退出异常: ${String(e)}`).toBeDefined();
      return;
    }
    if (!verdict.applies) {
      console.log(
        `[w4] AC-1 跳过：本分支未触碰 gate·pipeline 域，非双域边界锁适用波次（AC-2/AC-3 静态边界照常生效）`,
      );
      return;
    }
    expect(
      verdict.offenders,
      `gate·pipeline 边界敏感波次触碰了 unit 域九路径（零污染破坏）：${verdict.offenders.join(", ")}`,
    ).toEqual([]);
  });
});
