/**
 * TaskShape registry —— id → TaskShape 的映射表 + 查询入口。
 *
 * state-machine / actions 通过 topic.taskShape（TaskShapeId | undefined）调 getShape
 * 拿到完整策略组合（verification + review），再路由到对应方法。undefined 回退到
 * 默认 full-tdd（存量 topic 兼容 + 新建 topic 默认值，AC-2/AC-3）。
 *
 * 新增 shape：在 REGISTRY 加映射，types.ts 的 TaskShapeId 联合同步加字面量。
 */

import type { TaskShape, TaskShapeId } from "./types.js";
import { TddVerificationStrategy } from "./tdd-strategy.js";
import { FullReviewPolicy } from "./full-review-policy.js";

/** full-tdd：全量 TDD 验证 + 全量三阶段 review。 */
const FULL_TDD: TaskShape = {
  id: "full-tdd",
  verification: new TddVerificationStrategy(),
  review: new FullReviewPolicy(),
};

const REGISTRY: Record<TaskShapeId, TaskShape> = {
  "full-tdd": FULL_TDD,
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
