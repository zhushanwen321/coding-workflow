/**
 * AgentSpawn 缝契约（canon《design-rewrite-architecture.md》附录 B.1 的代码投影，
 * 原始设计见 design-child-spawn.md §7）。
 *
 * 共享契约层，主 agent 维护：已有定义不得改名改义；追加经 owner unit 验收文档背书。
 * u6a（lifecycle 进程管理原语）与 u6b/u6c（human/pi 适配器）并行开发，双方只 import。
 */

export type AgentRole = "designer" | "builder" | "reviewer";

export interface AgentSpawnRequest {
  role: AgentRole;
  /** 产物命名与账本定位 */
  unitId: string;
  /** 独立 worktree 绝对路径 */
  workdir: string;
  /** runner 生成的完整任务书（brief 文件路径，file-based 传递） */
  briefPath: string;
  /** 附加环境变量（如 CW_HOME 隔离） */
  env?: Record<string, string>;
  /** 默认 30min；超时 kill 进程树并返回 TIMEOUT */
  timeoutMs: number;
}

/**
 * 四态退出：exit≠0（agent 自报失败，可重派）| TIMEOUT（超时 kill，可重派）|
 * CRASH（被信号杀死或产物不完整，可重派）| SPAWN_ERROR（起不来——配置错误，不重试）。
 * runner 对四者的语义只有「可否重派」一维，不解读 stderr 内容。
 */
export interface SpawnResult {
  exitCode: number | "TIMEOUT" | "CRASH" | "SPAWN_ERROR";
  /** <workdir>/.cw-spawn/<unitId>.<role>.stdout（管道直写落盘，进证据链） */
  stdoutPath: string;
  stderrPath: string;
  pid: number;
}

export interface AgentSpawnAdapter {
  name: string;
  spawn(req: AgentSpawnRequest): Promise<SpawnHandle>;
}

export interface SpawnHandle {
  wait(): Promise<SpawnResult>;
  kill(): void;
}
