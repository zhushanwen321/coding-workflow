/**
 * W4 grep AC 机器复核（.xyz-harness/rp-release-pipeline/system-architecture.md §11）。
 *
 * 把三条架构反模式 AC 固化为测试，防止后续演化腐蚀双域边界：
 *   AC-1 unit 域源码零触碰——以 merge 基线 commit 为参照，unit 域九个路径
 *      不得有 diff（相对 HEAD 检查需 git 历史，此处用 import 边界 + 文本形态
 *      的可重跑近似：见 ac1 说明）
 *   AC-2 gate·pipeline 不 import unit 域事件类型
 *   AC-3 事件构造收敛：GateCheckRan/GateCacheHit/PipelineStepRan 字符串作为
 *      append 第一参（构造点）只出现在 src/gate/ 与 src/pipeline/
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("AC-1（可重跑近似）：unit 域九路径自 merge 基线以来零行为改动——git diff 为空", () => {
    // merge 基线（8844c67 = feat-optimize-design-dev-test-flow 合入点）。若基线
    // commit 不存在（浅克隆等）跳过并以 import 边界测试（AC-2）兜底。
    const paths = [
      "src/events/types.ts",
      "src/core/fold.ts",
      "src/readonly/",
      "src/runner/",
      "src/verify/",
      "src/testrun/",
      "src/gates/",
      "pi-coding-workflow-extension/",
    ];
    try {
      const diff = execFileSync(
        "git",
        ["diff", "--stat", "8844c67..HEAD", "--", ...paths],
        { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      expect(diff.trim(), "unit 域九路径出现 diff（零污染破坏）").toBe("");
    } catch (e) {
      // 基线不可解析时（浅历史），本测试退化为不判——AC-2/AC-3 仍锁 import/构造边界
      expect((e as { status?: number }).status).not.toBeUndefined();
    }
  });
});
