/**
 * TestRun 适配器注册表（M0 默认装配）。
 *
 * engine 只 import TestRunAdapter 接口与 AdapterRegistry 类型（依赖方向不破，
 * canon B.2）；具体适配器在调用侧通过本工厂注册。M0 内置 vitest + e2e-sh 两项，
 * key = 适配器 type 字段（"vitest" / "e2e-sh"）；mx-2 扩容 pytest（py 项目）与
 * playwright（ts 侧第二主流 e2e 框架），经 mx-2 验收文档背书追加。
 */
import { e2eShAdapter } from "./e2e-sh.js";
import { playwrightAdapter } from "./playwright.js";
import { pytestAdapter } from "./pytest.js";
import type { AdapterRegistry } from "./types.js";
import { vitestAdapter } from "./vitest.js";

/** 默认注册表：每次调用返回新 Map，调用侧增删不影响其他调用方 */
export function defaultRegistry(): AdapterRegistry {
  return new Map([
    [vitestAdapter.type, vitestAdapter],
    [e2eShAdapter.type, e2eShAdapter],
    [pytestAdapter.type, pytestAdapter],
    [playwrightAdapter.type, playwrightAdapter],
  ]);
}

/**
 * 已注册适配器 type 全集——spec gate 规则⑧的 runner 合法值清单。
 * 从 defaultRegistry 派生（单一事实源）：注册表扩容时合法值集合自动同步，
 * 禁止两处手写清单漂移。
 */
export function knownAdapterTypes(): readonly string[] {
  return [...defaultRegistry().keys()];
}
