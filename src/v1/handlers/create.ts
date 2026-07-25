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
配置后 cw 会在指定目录跑测试，解决 monorepo alias 等问题。

## command 强烈建议配置为 wave 范围测试
默认的 \`npx vitest run\` 是**全量回归**——会跑仓库里所有测试文件。cw 的 testsAllPass gate 只认 command 的退出码：只要仓库里**任意**一个预存 flaky/failing test 失败，本 wave 都会被卡住、为它不该负责的问题买单。

**强烈建议**把 command 配成只覆盖本 wave 改动范围的测试文件：

  {
    "testRunner": {
      // 按目录过滤（推荐：本 wave 改动集中在某个模块时）
      "command": "npx vitest run src/__tests__/quota"
    }
  }

或按文件列出：
  {
    "testRunner": {
      "command": "npx vitest run path/to/test-a.test.ts path/to/test-b.test.ts"
    }
  }

权衡：
- 全量测试覆盖面广，但任何预存失败都会阻断本 wave，不适合 wave §5.1「验本次开发的正确性」的定位。
- wave 范围测试精准、gate 更快更稳，但需要 agent 手动指定路径（cw 不会自动识别 wave 范围）。

wave 范围内的测试文件从两处可知：plan 阶段的 WaveTestCase 列表、execute 阶段实际改动的测试文件。`;

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
