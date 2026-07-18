/**
 * TaskShape registry —— id → TaskShape 的映射表 + 查询入口。
 *
 * state-machine / actions 通过 topic.taskShape（TaskShapeId | undefined）调 getShape
 * 拿到完整策略组合（verification + review），再路由到对应方法。undefined 回退到
 * 默认 full-tdd（存量 topic 兼容 + 新建 topic 默认值，AC-2/AC-3）。
 *
 * 新增 shape：在 REGISTRY 加映射，types.ts 的 TaskShapeId 联合同步加字面量。
 */

import { DocReviewPolicy } from "./doc-review-policy.js";
import { ExistenceVerificationStrategy } from "./existence-strategy.js";
import { FullReviewPolicy } from "./full-review-policy.js";
import { LeanReviewPolicy } from "./lean-review-policy.js";
import { ReviewOnlyVerificationStrategy } from "./review-only-strategy.js";
import { TddVerificationStrategy } from "./tdd-strategy.js";
import type { TaskShape, TaskShapeId } from "./types.js";

/** full-tdd：全量 TDD 验证 + 全量三阶段 review。 */
const FULL_TDD: TaskShape = {
  id: "full-tdd",
  verification: new TddVerificationStrategy(),
  review: new FullReviewPolicy(),
};

/** delete-only：existence 验证（文件存在性）+ lean review（单阶段 review）。 */
const DELETE_ONLY: TaskShape = {
  id: "delete-only",
  verification: new ExistenceVerificationStrategy(),
  review: new LeanReviewPolicy(),
};

/** doc-only：review-only 验证（恒 pass，无机器校验）+ doc review（单维度）。 */
const DOC_ONLY: TaskShape = {
  id: "doc-only",
  verification: new ReviewOnlyVerificationStrategy(),
  review: new DocReviewPolicy(),
};

/**
 * shape 注册表。三个内置 shape 全部注册——getShape 拿到 id 即返回对应策略组合。
 * 仍保留 Partial + 回退到 FULL_TDD：防御磁盘手写非法 taskShape 值 / 未来扩展时
 * 临时漏注册的场景（降级到 full-tdd 而非崩 Cannot read properties of undefined）。
 */
const REGISTRY: Partial<Record<TaskShapeId, TaskShape>> = {
  "full-tdd": FULL_TDD,
  "delete-only": DELETE_ONLY,
  "doc-only": DOC_ONLY,
};

/**
 * 按 id 解析 TaskShape。undefined 回退默认 full-tdd（存量 topic 无 taskShape 字段时
 * 不报错，AC-3 迁移路径；新建 topic 默认值，AC-2）。
 *
 * 未知 id（磁盘手写非法值 / 未来扩展时 REGISTRY 漏注册）也回退 full-tdd——
 * 防御性降级，避免 `Cannot read properties of undefined` 崩溃。
 */
export function getShape(taskShapeId: TaskShapeId | undefined): TaskShape {
  return REGISTRY[taskShapeId ?? "full-tdd"] ?? FULL_TDD;
}

/**
 * 已注册的合法 TaskShapeId 列表（从 REGISTRY 派生，单一数据源）。
 * handleCreate 的值校验从这里取，避免 actions.ts 硬编码第二份列表导致新增 shape 时漏改。
 */
export const VALID_SHAPE_IDS: TaskShapeId[] = Object.keys(REGISTRY) as TaskShapeId[];
