/**
 * AgentSpawn 缝契约（canon《design-rewrite-architecture.md》附录 B.1 的代码投影，
 * 原始设计见 design-child-spawn.md §7）。
 *
 * 共享契约层，主 agent 维护：已有定义不得改名改义；追加经 owner unit 验收文档背书。
 * u6a（lifecycle 进程管理原语）与 u6b/u6c（human/pi 适配器）并行开发，双方只 import。
 */

export type AgentRole = "designer" | "developer" | "reviewer";

export interface AgentSpawnRequest {
  role: AgentRole;
  /** 产物命名与账本定位 */
  unitId: string;
  /** 独立 worktree 绝对路径 */
  workdir: string;
  /** 项目仓库目录：账本定位与仓库操作的锚点（agent 的 cw 命令经 CW_PROJECT_DIR 锚定此处；与 workdir 分离见设计 D3） */
  projectCwd: string;
  /**
   * spawn 过程产物（brief/stdout/stderr）的落盘目录 = run 级 topic 目录
   * （<CW_HOME>/topic/<encoded-cwd>/<runTs>-<rootId>，fx-4 起 worktree 只承载
   * agent 业务产出与 commit，不再有任何 cw 自身文件）。适配器只在此目录下按
   * <unitId>.<role>.stdout/.stderr 拼自己的文件名（append 语义），不感知 topic
   * 全局布局——目录由 runner 显式传递并创建。
   */
  artifactDir: string;
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
  /** <artifactDir>/<unitId>.<role>.stdout（管道直写落盘，进证据链；append 累积本次 run 的历次输出） */
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

/**
 * 可选交互能力扩展（ph-i1 R1，design-hi-spawn-pi-rpc.md §3.2）：一次性适配器
 * （human/pi）零改动——AgentSpawnAdapter.spawn 返回类型仍是 SpawnHandle，消费方
 * （loop / ph-i2 的 subagent-workflow 后端）用 isInteractiveSpawnHandle 守卫探测；
 * 不支持的适配器被追问 followUp 时给明确错误而非静默。
 */
export interface InteractiveSpawnHandle extends SpawnHandle {
  /** 对同一长驻进程追加输入（反思追问等，上下文全保留） */
  followUp(text: string): Promise<void>;
  /** 等待 agent 流式结束（agent_settled 锚）；超时返回 false */
  waitForIdle(ms: number): Promise<boolean>;
  /** 订阅子进程的 extension_ui_request（穿透转发钩子） */
  onUiRequest(cb: (req: { id: string; method: string }) => void): void;
  /** 优雅收尾（stdin EOF 优雅退出）后返回与 wait() 同构的结算结果 */
  done(): Promise<SpawnResult>;
  /** 握手（get_state）回填的确定性 session 锚 */
  sessionAnchor?: { sessionId: string; sessionFile: string };
}

/** 类型守卫：handle 是否具备交互能力（R1 能力探测显式化的唯一入口） */
export function isInteractiveSpawnHandle(handle: SpawnHandle): handle is InteractiveSpawnHandle {
  const h = handle as Partial<InteractiveSpawnHandle>;
  return (
    typeof h.followUp === "function" &&
    typeof h.waitForIdle === "function" &&
    typeof h.onUiRequest === "function" &&
    typeof h.done === "function"
  );
}
