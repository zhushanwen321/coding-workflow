import { describe, expect, it } from "vitest";

import { type CommandEntry,matchByPrefix } from "../src/dispatch.js";

/** 自建命令表测匹配语义——契约层测试不依赖各域（可能并行开发中的）注册表 */
const TABLE: CommandEntry[] = [
  { name: "status", handler: async () => 0, summary: "" },
  { name: "evidence submit", handler: async () => 0, summary: "" },
  { name: "review submit", handler: async () => 0, summary: "" },
  { name: "evidence", handler: async () => 0, summary: "" },
];

describe("dispatch 契约层命令匹配（token 前缀，flag 不参与）", () => {
  it("无参命令名直接命中", () => {
    expect(matchByPrefix(TABLE, ["status"])?.name).toBe("status");
  });

  it("带 flag 仍命中：status --json → status", () => {
    expect(matchByPrefix(TABLE, ["status", "--json"])?.name).toBe("status");
  });

  it("子命令前缀命中：evidence submit --kind spec → evidence submit", () => {
    expect(matchByPrefix(TABLE, ["evidence", "submit", "--kind", "spec"])?.name).toBe(
      "evidence submit",
    );
  });

  it("多 token 名优先于单 token 前缀（表序内先长后短由调用方保证；此处验证 find 语义不误配）", () => {
    // 长名在前的表：evidence submit 应优先于 evidence
    const longestFirst = [...TABLE].sort(
      (a, b) => b.name.split(" ").length - a.name.split(" ").length,
    );
    expect(matchByPrefix(longestFirst, ["evidence", "submit"])?.name).toBe("evidence submit");
  });

  it("flag 值不误配命令名：status --unit create → status（而非其他）", () => {
    expect(matchByPrefix(TABLE, ["status", "--unit", "create"])?.name).toBe("status");
  });

  it("未知命令与空参数返回 undefined", () => {
    expect(matchByPrefix(TABLE, ["no-such-thing"])).toBeUndefined();
    expect(matchByPrefix(TABLE, [])).toBeUndefined();
  });
});
