/**
 * CwError — cw 预期错误（参数错误、状态机违规等），映射到 exit code 1。
 *
 * 不抛 CwError 的场景（保持普通 Error → exit 2 内部异常）：
 *   - 事务后 unit 消失（不变式违反，理论上不可能）
 *   - lock 获取失败（基础设施问题）
 */
export class CwError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CwError";
  }
}
