/**
 * v1 wave handler — create action（入口：从无到有创建 ExecutionUnit）。
 *
 * 来源：v5 wave 附录 A §10（编排骨架）、core workunit.createWave 工厂（§1.4 / §5.3）。
 *
 * 职责：调 createWave 工厂初始化全部字段为空态 → save → 返回 status=created。
 * 不跑 gate（create 无 gate，guard 已在 dispatch 层做过）。
 *
 * 不变量：create 不接收已有 unit（它是入口）；产物字段全空态，各后续 handler 逐步填充。
 */
import type { ExecutionUnit } from "../core/workunit.js";
import { createWave } from "../core/workunit.js";
import { buildNextAction, saveUnit } from "./internal.js";
import type { ActionResult, CreateInput,V1Deps } from "./types.js";

/** testRunner 配置提示（create 时提前告知 monorepo 用户）。 */
const TEST_RUNNER_HINT = `

## testRunner 配置（可选）
如果测试目录不在仓库根（如 monorepo 子包），在项目根目录创建 cw.config.json：
  {
    "testRunner": {
      "command": "npx vitest run",  // 可选，默认 npx vitest run
      "cwd": "packages/renderer"    // 相对于项目根目录
    }
  }
或使用 --testCwd 参数临时覆盖（优先级高于 config）：
  cw v1 test --unitId <id> --testCwd packages/renderer
配置后 cw 会在指定目录跑测试，解决 monorepo alias 等问题。`;

/**
 * 执行 create action。
 *
 * @param args create 参数（slug / objective / parentUnitId / basedOnParent）
 * @param deps 依赖注入（store / clock）
 * @returns 操作结果（status=created）
 */
export function handleCreate(
  args: CreateInput,
  deps: V1Deps,
): ActionResult & { unit: ExecutionUnit } {
  const unit = createWave({
    slug: args.slug,
    objective: args.objective,
    parentUnitId: args.parentUnitId,
    basedOnParent: args.basedOnParent,
    createdAt: deps.clock.now(),
  });
  saveUnit(deps, unit);
  const nextAction = buildNextAction(unit, "create");
  // create 时追加 testRunner 配置提示（monorepo 用户提前配置，避免 test 阶段卡住）
  nextAction.guidance += TEST_RUNNER_HINT;
  return {
    unitId: unit.id,
    status: unit.status,
    ok: true,
    unit,
    nextAction,
  };
}
