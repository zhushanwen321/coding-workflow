/**
 * TestRun 适配器注册表（M0 默认装配）。
 *
 * engine 只 import TestRunAdapter 接口与 AdapterRegistry 类型（依赖方向不破，
 * canon B.2）；具体适配器在调用侧通过本工厂注册。M0 内置 vitest + e2e-sh 两项，
 * key = 适配器 type 字段（"vitest" / "e2e-sh"），后续多语言适配器（pytest 等）
 * 经各自验收文档背书后在此追加。
 */
import { e2eShAdapter } from "./e2e-sh.js";
import type { AdapterRegistry } from "./types.js";
import { vitestAdapter } from "./vitest.js";

/** 默认注册表：每次调用返回新 Map，调用侧增删不影响其他调用方 */
export function defaultRegistry(): AdapterRegistry {
  return new Map([
    [vitestAdapter.type, vitestAdapter],
    [e2eShAdapter.type, e2eShAdapter],
  ]);
}
