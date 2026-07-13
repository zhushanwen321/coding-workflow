/**
 * mapExitCode 单测 — 验证 typed CwError 判定（W4 引入）。
 *
 * 替换了旧的 18 条字符串前缀匹配。现在 mapExitCode 只判 instanceof CwError。
 * GuardError extends CwError，所以 guard 拒绝也走 exit 1。
 */
import { describe, it, expect } from "vitest";
import { mapExitCode } from "../src/cli.js";
import { CwError } from "../src/types.js";
import { GuardError } from "../src/dispatch.js";

describe("mapExitCode (W4 typed error)", () => {
  it("CwError → exit 1", () => {
    expect(mapExitCode(new CwError("topic not found: xxx"))).toBe(1);
    expect(mapExitCode(new CwError("create 需要 --slug"))).toBe(1);
    expect(mapExitCode(new CwError("任意预期错误消息"))).toBe(1);
  });

  it("GuardError (extends CwError) → exit 1", () => {
    const err = new GuardError("illegal_transition", "跳过了 review");
    expect(mapExitCode(err)).toBe(1);
    expect(err instanceof CwError).toBe(true);
  });

  it("普通 Error → exit 2（内部异常）", () => {
    expect(mapExitCode(new Error("topic not found after plan: xxx"))).toBe(2);
    expect(mapExitCode(new Error("任何未预期错误"))).toBe(2);
  });

  it("措辞自由变化不影响 exit code（消除字符串前缀脆弱性）", () => {
    // 旧实现里这些措辞必须精确匹配 startsWith/includes，改一个字就滑到 exit 2。
    // 现在只要抛的是 CwError，措辞怎么写都是 exit 1。
    expect(mapExitCode(new CwError("找不到 topic"))).toBe(1);
    expect(mapExitCode(new CwError("参数缺失：slug 为空"))).toBe(1);
  });
});
