/**
 * buildParams 单测 — 参数校验的各 action 分支。
 *
 * buildParams 从 module-private export 后可单测。
 * 测试策略：构造 ParsedArgs 对象（模拟 minimist 输出），验证各 case 的参数校验。
 */
import { describe, it, expect } from "vitest";

import { buildParams } from "../src/cli.js";
import type { ParsedArgs } from "../src/cli.js";
import { CwError } from "../src/types.js";

// 构造空 ParsedArgs（模拟 minimist 无 flag 输出）
function makeParsed(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return { _: [], ...overrides };
}

describe("buildParams — create action", () => {
  it("缺 --slug → throw CwError", () => {
    expect(() =>
      buildParams("create", makeParsed({ objective: "x" }), "", true),
    ).toThrow(CwError);
  });

  it("缺 --objective → throw CwError", () => {
    expect(() =>
      buildParams("create", makeParsed({ slug: "x" }), "", true),
    ).toThrow(CwError);
  });

  it("正常 create → 返回 CreateParams", () => {
    const p = buildParams(
      "create",
      makeParsed({ slug: "feat", objective: "do x" }),
      "",
      true,
    );
    expect(p.action).toBe("create");
    expect(p).toMatchObject({ slug: "feat", objective: "do x" });
  });
});

describe("buildParams — plan/replan action", () => {
  it("plan 缺 --topicId → throw CwError", () => {
    expect(() => buildParams("plan", makeParsed(), "", true)).toThrow(
      CwError,
    );
  });

  it("plan 从 stdin 读 planJson", () => {
    const p = buildParams(
      "plan",
      makeParsed({ topicId: "cw-1" }),
      '{"format":"lite"}',
      false,
    );
    expect(p.action).toBe("plan");
  });
});

describe("buildParams — dev/test action", () => {
  it("dev 缺 --topicId → throw CwError", () => {
    expect(() =>
      buildParams("dev", makeParsed({ tasks: "[]" }), "", true),
    ).toThrow(CwError);
  });

  it("dev --tasks 非数组 → throw CwError", () => {
    expect(() =>
      buildParams(
        "dev",
        makeParsed({ topicId: "cw-1", tasks: '"not-array"' }),
        "",
        true,
      ),
    ).toThrow(CwError);
  });

  it("test --cases 非数组 → throw CwError", () => {
    expect(() =>
      buildParams(
        "test",
        makeParsed({ topicId: "cw-1", cases: '"not-array"' }),
        "",
        true,
      ),
    ).toThrow(CwError);
  });
});

describe("buildParams — review/retrospect/closeout action", () => {
  it("review 缺 --topicId → throw CwError", () => {
    expect(() => buildParams("review", makeParsed(), "", true)).toThrow(
      CwError,
    );
  });

  it("retrospect 缺 --topicId → throw CwError", () => {
    expect(() =>
      buildParams("retrospect", makeParsed(), "", true),
    ).toThrow(CwError);
  });

  it("closeout 正常（只需 --topicId）", () => {
    const p = buildParams(
      "closeout",
      makeParsed({ topicId: "cw-1" }),
      "",
      true,
    );
    expect(p.action).toBe("closeout");
  });
});

describe("buildParams — reviewPath/retrospectPath 可选参数", () => {
  it("review 带 --reviewPath → 写入 params", () => {
    const p = buildParams(
      "review",
      makeParsed({ topicId: "cw-1", reviewPath: "/tmp/review.md" }),
      "",
      true,
    );
    expect(p).toMatchObject({ reviewPath: "/tmp/review.md" });
  });

  it("review 带 kebab-case --review-path → 也生效", () => {
    const p = buildParams(
      "review",
      makeParsed({ topicId: "cw-1", "review-path": "/tmp/r.md" }),
      "",
      true,
    );
    expect(p).toMatchObject({ reviewPath: "/tmp/r.md" });
  });
});
