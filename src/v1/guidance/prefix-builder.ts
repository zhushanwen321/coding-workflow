/**
 * v1 guidance — 位置前缀构建器（纯函数，零 IO）。
 *
 * 来源：v5 cli-and-guidance §3.4「位置」段 + §4.x 各示例的前缀格式。
 *
 * 职责：把「layer / unitId / status / parentUnitId」渲染成 guidance 文本里的
 *      一行位置前缀（agent 读它能立即知道自己在树里哪层、状态如何）。
 *
 * 不变量：纯函数。不查 store、不读文件、不依赖时间。所有信息由调用方传入。
 *      prefix 由 prefix-builder 算，跨层导航由 cross-layer 算（查 store），职责分离见 §7.4。
 */
// ═══════════════════════════════════════════════════════════════
// buildPrefix
// ═══════════════════════════════════════════════════════════════

/** buildPrefix 入参。layer 四选一；parentUnitId 无则省略「父单元」段（孤立单元，§1.3）。 */
export interface BuildPrefixArgs {
  /** WorkUnit 层（epic / feature / slice / wave）。 */
  layer: "epic" | "feature" | "slice" | "wave";
  /** WorkUnit id（如 "wave:auth-w1"）。 */
  unitId: string;
  /** 当前 status（中文展示）。 */
  status: string;
  /** 父单元 id（无 parent 的孤立单元不传）。 */
  parentUnitId?: string;
}

/**
 * 构建位置前缀。
 *
 * 格式（§4.x）：
 *   有 parent：`[layer:unitId] 状态：status｜父单元：parentUnitId`
 *   无 parent：`[layer:unitId] 状态：status`（孤立终点，§1.3）
 *
 * 「｜」是全角分隔符，区分「状态」段与「父单元」段（与 §4 示例一致）。
 */
export function buildPrefix(args: BuildPrefixArgs): string {
  const { layer, unitId, status, parentUnitId } = args;
  const head = `[${layer}:${unitId}] 状态：${status}`;
  if (parentUnitId === undefined || parentUnitId === "") {
    return head;
  }
  return `${head}｜父单元：${parentUnitId}`;
}
