/**
 * v1 CLI 参数白名单校验单元测试（#5，D-019 合并 #11，W2）。
 *
 * 覆盖：
 *   - T2.1：未知 flag → CwError「unknown flag --x, valid: ...」（exit 1 由 cli.test.ts e2e 验）
 *   - T2.2：每 action 合法 flag 逐一放行 + camel/kebab 双形态（F-1）
 *           + 表⊆代码消费键反向断言（F-2，防白名单漂移）
 *   - T2.3：全局基础集（--unitId/--input/--workspace/--help/-h/--version/--verbose）全放行
 *
 * 零 mock：validateFlags 是纯函数（只读 parsed 键），直接单测。
 */
import { describe, expect, it } from "vitest";

import type { ParsedArgs } from "../src/cli.js";
import {
  FLAG_WHITELIST,
  GLOBAL_FLAGS,
  validateFlags,
} from "../src/cli-params.js";
import { CwError } from "../src/core/errors.js";

/** 构造只含给定 flag 键（值 true）的 parsed，模拟 minimist 输出。 */
function parsedWith(keys: string[]): ParsedArgs {
  const p: ParsedArgs = { _: [] };
  for (const key of keys) p[key] = true;
  return p;
}

/** 捕获 validateFlags 抛出的错误（toThrowError 无法同时断言 message 多处内容）。 */
function catchValidate(action: string, keys: string[]): Error | undefined {
  try {
    validateFlags(action, parsedWith(keys));
    return undefined;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

describe("validateFlags（#5 flag 白名单）", () => {
  it("T2.1: 未知 flag → throw CwError，消息含 flag 名 + 合法 flag 列表", () => {
    const err = catchValidate("clarify", ["unid"]);
    expect(err).toBeInstanceOf(CwError);
    expect(err!.message).toContain("unknown flag --unid");
    // 合法列表含全局基础集（clarify 自身无专属 flag）
    expect(err!.message).toContain("unitId");
    expect(err!.message).toContain("input");
  });

  it("T2.1: 未知 flag 在 readonly action 同样拒绝", () => {
    const err = catchValidate("list", ["bogus"]);
    expect(err).toBeInstanceOf(CwError);
    expect(err!.message).toContain("unknown flag --bogus");
  });

  it("T2.2: 每 action 合法 flag 逐一放行", () => {
    for (const action of Object.keys(FLAG_WHITELIST)) {
      const perAction = [...FLAG_WHITELIST[action]];
      expect(catchValidate(action, perAction), `${action} 专属 flag`).toBeUndefined();
    }
  });

  it("T2.2/F-1: camel 与 kebab 双形态都放行", () => {
    for (const action of Object.keys(FLAG_WHITELIST)) {
      for (const name of FLAG_WHITELIST[action]) {
        const kebab = name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        expect(catchValidate(action, [name]), `${action} --${name}`).toBeUndefined();
        if (kebab !== name) {
          expect(catchValidate(action, [kebab]), `${action} --${kebab}`).toBeUndefined();
        }
      }
    }
  });

  it("T2.3: 全局基础集全放行（每个 action）", () => {
    for (const action of Object.keys(FLAG_WHITELIST)) {
      expect(catchValidate(action, [...GLOBAL_FLAGS]), `${action} 全局集`).toBeUndefined();
    }
  });

  it("minimist 内部键 _（positional）忽略", () => {
    expect(catchValidate("clarify", [])).toBeUndefined();
    const parsed: ParsedArgs = { _: ["clarify", "wave"] };
    expect(() => validateFlags("clarify", parsed)).not.toThrow();
  });

  it("F-2: 白名单表⊇代码消费键反向断言（buildParams/runReadonly 实际消费的 flag 键镜像）", () => {
    // 镜像清单与 buildParams / runReadonly 的 flag()/parsed 消费键一一对应。
    // 新增消费键时必须同步登记白名单，否则此断言红。
    const consumed: Record<string, string[]> = {
      create: ["slug", "objective", "parent", "basedOnParent"],
      plan: ["abandonParentItems"],
      execute: ["commitHash"],
      test: ["testCwd"],
      replan: ["abandonedIds", "note", "abandonParentItems"],
      abort: ["reason"],
      status: ["full"],
      handoff: ["scope"],
      frontier: ["root"],
      list: ["layer", "grep", "cwd", "all", "long", "limit", "offset"],
    };
    for (const [action, keys] of Object.entries(consumed)) {
      const set = FLAG_WHITELIST[action];
      expect(set, `${action} 已登记白名单`).toBeDefined();
      for (const key of keys) {
        expect(set!.has(key), `${action} 白名单缺消费键 ${key}`).toBe(true);
      }
    }
  });
});
