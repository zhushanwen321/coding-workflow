/**
 * utils/command.ts 纯函数直接单测。
 *
 * 来源：suggestion #5（aggregated.md round-1）。
 * safeSlugForPath（含 `::`→`-`、非法字符替换、连续 `-` 压缩、首尾 trim、空串兜底 "misc"
 * 等多步正则）与 inputFilePath 是核心路径安全逻辑、边界条件密集，但此前 tests/ 下无任何
 * 直接单元测试，行为仅靠 guidance.test.ts 的 buildFailureHint 间接覆盖，且间接测试不验证
 * `--input` 路径形态。一旦 safeSlugForPath 退化，下游所有 guidance 命令的 `--input` 路径错位。
 *
 * 本文件对三个 export 函数逐断言确切的输入→输出，把路径安全契约用测试固化。
 * 纯字符串处理，零 IO，零 mock。
 *
 * 关键发现（断言依据实际源码行为，而非 review 推测）：
 *   - inputFilePath("", "create") 实际产 `.cw/misc/create.json`，**不是** review 推测的
 *     `.cw/create.json`。因为 safeSlugForPath("") 返回 "misc"（永远不返回空串），
 *     inputFilePath 里的 `safe === ""` 分支是 dead code。测试如实记录真实行为。
 */
import { describe, expect, it } from "vitest";

import {
  buildCommand,
  inputFilePath,
  safeSlugForPath,
} from "../src/utils/command.js";

// ═══════════════════════════════════════════════════════════════
// buildCommand
// ═══════════════════════════════════════════════════════════════

describe("buildCommand", () => {
  it("单 action → `cw <action>`", () => {
    expect(buildCommand("create")).toBe("cw create");
  });

  it("action + 多个非空 arg → 空格拼接", () => {
    expect(buildCommand("design", "auth-w1", "--input", "x.json")).toBe(
      "cw design auth-w1 --input x.json",
    );
  });

  it("空串 arg 被过滤（filter(Boolean)），不产生多余空格", () => {
    expect(buildCommand("design", "auth-w1", "", "--input", "")).toBe(
      "cw design auth-w1 --input",
    );
  });

  it("无 arg → `cw <action>`（尾无多余空格）", () => {
    expect(buildCommand("list")).toBe("cw list");
  });
});

// ═══════════════════════════════════════════════════════════════
// safeSlugForPath
// ═══════════════════════════════════════════════════════════════

describe("safeSlugForPath", () => {
  describe(":: 分隔符（execute 下沉的子 slug）", () => {
    it("execute 下沉子 slug `Auth::W1` → `auth-w1`（:: → -，大写转小写）", () => {
      expect(safeSlugForPath("Auth::W1")).toBe("auth-w1");
    });

    it("多层 `::` 嵌套也收敛（a::b::c → a-b-c）", () => {
      expect(safeSlugForPath("a::b::c")).toBe("a-b-c");
    });
  });

  describe("非法字符替换 + 连续分隔符压缩", () => {
    it("`/` 字符 → `-`（Auth/W1 → auth-w1）", () => {
      expect(safeSlugForPath("Auth/W1")).toBe("auth-w1");
    });

    it("空格 → `-`（Auth W1 → auth-w1）", () => {
      expect(safeSlugForPath("Auth W1")).toBe("auth-w1");
    });

    it("括号等特殊字符 → `-`（Auth::W1 (v2) → auth-w1-v2）", () => {
      expect(safeSlugForPath("Auth::W1 (v2)")).toBe("auth-w1-v2");
    });

    it("连续分隔符压成一个（a---b → a-b）", () => {
      expect(safeSlugForPath("a---b")).toBe("a-b");
    });
  });

  describe("首尾 trim", () => {
    it("首尾 `-` 去掉（--abc-- → abc）", () => {
      expect(safeSlugForPath("--abc--")).toBe("abc");
    });

    it("首尾非法字符 trim 后无残留（!!!abc!!! → abc）", () => {
      expect(safeSlugForPath("!!!abc!!!")).toBe("abc");
    });
  });

  describe("空串兜底", () => {
    it("空串 → misc（避免拼出 `.cw//action.json`）", () => {
      expect(safeSlugForPath("")).toBe("misc");
    });

    it("纯非法字符 → misc（!!! → misc）", () => {
      expect(safeSlugForPath("!!!")).toBe("misc");
    });

    it("纯分隔符 → misc（--- → misc，压缩 + trim 后为空）", () => {
      expect(safeSlugForPath("---")).toBe("misc");
    });

    it("纯空白 → misc", () => {
      expect(safeSlugForPath("   ")).toBe("misc");
    });
  });

  describe("已是合法 slug 的幂等性", () => {
    it("合法 slug `auth-w1` 原样返回", () => {
      expect(safeSlugForPath("auth-w1")).toBe("auth-w1");
    });

    it("对 safeSlugForPath 的输出再跑一次结果不变（幂等）", () => {
      const once = safeSlugForPath("Auth::W1 (v2)");
      expect(safeSlugForPath(once)).toBe(once);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// inputFilePath
// ═══════════════════════════════════════════════════════════════

describe("inputFilePath", () => {
  it("正常 slug + action → `.cw/<safeSlug>/<action>.json`", () => {
    expect(inputFilePath("auth-w1", "design")).toBe(".cw/auth-w1/design.json");
  });

  it("slug 经 safeSlugForPath 规范化（Auth::W1 → auth-w1）后拼路径", () => {
    expect(inputFilePath("Auth::W1", "design")).toBe(".cw/auth-w1/design.json");
  });

  it("纯非法字符 slug → 走 misc 兜底（!!! → .cw/misc/create.json）", () => {
    expect(inputFilePath("!!!", "create")).toBe(".cw/misc/create.json");
  });

  it("空 slug → safeSlugForPath 兜底 misc（非 review 推测的 .cw/create.json）", () => {
    // 实际行为：safeSlugForPath("") === "misc"，永不返回空串，
    // 故 inputFilePath 的 `safe === ""` 分支是 dead code。
    // 此处断言真实行为（.cw/misc/create.json），把契约固化以防未来误改。
    expect(inputFilePath("", "create")).toBe(".cw/misc/create.json");
  });

  it("不同 action 共享同一 slug 目录（design / design-review / execute 同目录）", () => {
    expect(inputFilePath("auth-w1", "design")).toBe(".cw/auth-w1/design.json");
    expect(inputFilePath("auth-w1", "design-review")).toBe(".cw/auth-w1/design-review.json");
    expect(inputFilePath("auth-w1", "execute")).toBe(".cw/auth-w1/execute.json");
  });
});
