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
import { WAVE_STATUS_TO_ACTION } from "../core/status.js";
import type { ExecutionUnit } from "../core/workunit.js";
import { createWave } from "../core/workunit.js";
import type { WaveAction } from "../rules/state-machine.js";
import {
  buildCreateIdempotentResult,
  buildNextAction,
  buildWaveCurrentActionGuidance,
  isCreateEmptyState,
  saveUnit,
} from "./internal.js";
import type { ActionResult, CreateInput,CwDeps } from "./types.js";

/** testCommand 提示（create 时告知 design 阶段要填 per-wave 测试命令）。 */
const TEST_RUNNER_HINT = `

## design 阶段必须填 testCommand
本 wave 的测试执行命令（testCommand）在 **design 阶段**填写——一个完整 shell 命令，能启动本 wave 的测试（如 \`npx vitest run src/quota/__tests__/index.test.ts\`）。

**不要跑全量回归**：只限定本 wave 改动相关的最小测试文件集合。test 阶段 cw 执行你填的 testCommand，gate 只认命令退出码——跑全量会被仓库里任意预存 flaky/failing test 卡住，为不该负责的问题买单。

测试文件此时可不存在（execute 阶段才创建，TDD），但路径要按项目测试约定先定好。`;

/**
 * 执行 create action。
 *
 * @param args create 参数（slug / objective / parentUnitId / basedOnParent）
 * @param deps 依赖注入（store / clock）
 * @returns 操作结果（status=created）
 */
export function handleCreate(
  args: CreateInput,
  deps: CwDeps,
): ActionResult & { unit: ExecutionUnit } {
  // #2 create 幂等预检（D-002）：按 layer 定界（id=`wave:<slug>`），save 之前 load。
  // slug 已存在且非 created 空态 → no-op 返回 existing（不覆盖、不 save）。
  const existing = deps.store.load(`wave:${args.slug}`);
  if (existing !== null && !isCreateEmptyState(existing)) {
    const status = typeof existing.status === "string" ? existing.status : "created";
    const currentAction = WAVE_STATUS_TO_ACTION[status];
    const currentGuidance =
      currentAction !== undefined
        ? buildWaveCurrentActionGuidance(
            // eslint-disable-next-line taste/no-unsafe-cast -- 只读 id/status/parentUnitId/slug（CurrentActionGuidance 仅用这 4 字段），record 是具名 unit 超集
            existing as unknown as ExecutionUnit,
            currentAction as WaveAction,
          )
        : "";
    return {
      ...buildCreateIdempotentResult({
        existing,
        layer: "wave",
        currentAction,
        currentGuidance,
      }),
      // eslint-disable-next-line taste/no-unsafe-cast -- 同上：existing 字段透传存储，断言安全
      unit: existing as unknown as ExecutionUnit,
    };
  }

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
