/**
 * CwError — cw 预期错误（参数错误、状态机违规等），映射到 exit code 1。
 *
 * 不抛 CwError 的场景（保持普通 Error → exit 2 内部异常）：
 *   - 事务后 unit 消失（不变式违反，理论上不可能）
 *   - lock 获取失败（基础设施问题）
 *
 * 历史：原定义在 src/legacy/types.ts:970，v1 清理 0.x 时搬到 v1/core/errors.ts，
 * 解除 v1→legacy 的唯一耦合点。Wave 2 目录重组后位于 src/core/errors.ts。
 */
export class CwError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CwError";
  }
}
