/**
 * v1 guidance — subagent 委派建议（guidance 第 4 段「## subagent 调度」的内容源）。
 *
 * 来源：subagent-guidance 重构方案（feat-subagent-guidance 分支）。
 *
 * 职责：按 layer × action 给出 subagent 委派建议（强制/建议/禁止三档），生成纯文本
 *      喂给 buildNormalGuidance 的 commonGuidance 参数。与 wave/planning 模板的 constraint 解耦——
 *      constraint 只放阶段专属约束，subagent 调度集中在本模块。
 *
 * 核心判据——输入自包含性：subagent 能否仅凭 cw guidance + store 状态 reconstruct 出全部所需上下文
 *      （不依赖主 agent 的对话历史/推理轨迹）？能→隔离是净收益；不能→净损失。
 *
 * 由此衍生三档（"强制"= 措辞强度的硬建议，cw 无法技术阻止 agent 自行决策）：
 *   - mandatory（强制委派）：收益结构性稳定，跨情境跨任务规模都成立（密度极高 / 质量收益）
 *   - optional（按需委派）：收益随规模/压力波动，agent 据情境判断
 *   - forbidden（不建议委派）：输入非自包含，subagent 拿不到所需上下文（编排性质 / 过程依赖）
 *
 * 三个"不委派"根因（稳定性不同，分开标注便于未来演进时判断）：
 *   - 编排性质（planning execute）：做不做/怎么衔接的决策，主 agent 不可卸载——永远稳定
 *   - 过程依赖（retrospect）：输入含只有主 agent 才有的执行轨迹——随 store 演进可能松动
 *   - （整层下放：粒度违规，由全局 AGENTS.md 约束，不在单 action 分级表内）
 */

// recursive 模式的续 turn 指导（被 steer 唤醒后做什么）在阶段模板的 dispatchGuidance 字段，
// 本模块直接 import 模板表查（guidance 层内部引用，无循环依赖——模板不反向 import 本模块）。
import { PLANNING_STAGE_TEMPLATES } from "./templates/planning/index.js";
import { WAVE_STAGE_TEMPLATES } from "./templates/wave.js";

/** 委派方向（forbidden 时可为空字符串）。 */
type Direction = "代码探索" | "代码实现" | "测试执行" | "代码审查" | "综合" | "";

/** 委派档位。 */
type Level = "mandatory" | "optional" | "forbidden";

/** 分级表条目。 */
interface Rule {
  /** 档位。 */
  level: Level;
  /** 委派方向（forbidden 时为空）。 */
  direction: Direction;
  /** 为什么是这个档位（一句话根因）。 */
  reason: string;
  /**
   * 派发指导工厂（recursive 模式渲染；serial 模式不渲染，保持现状）：按 child 层返回
   * 派哪个 agent 模板 + 子 task 内容。planning execute 按 child 层参数化（MF-1）。
   *
   * G1：从"是否委派+理由"升级到"派谁 + task 模板"——recursive 模式下主 agent 派完 subagent
   * 就空闲等唤醒，不再自己串行推进，故派发指令要落到具体的 agent 模板和 task 内容。
   */
  dispatch?: (childLayer?: ChildLayer) => {
    /** 派哪个 agent 模板（如 wave-agent / planning-agent / review-agent）。 */
    agent: string;
    /** 子 task 内容模板（可含 <unitId> 等占位符，由调用方按需替换）。 */
    taskTemplate: string;
  };
}

/**
 * wave 层分级表。
 *
 * wave 是写代码/跑测试的执行层，execute 是上下文最密集的环节（强制委派·实现方向）；
 * design-review / exec-review 审查主 agent 刚产出的产物，隔离可避免确认偏差（强制委派·审查方向）；
 * retrospect 递归模式下由独立 agent 读 cw handoff + 本层 session 做复盘（按需委派·综合方向）。
 */
const WAVE_RULES: Readonly<Record<string, Rule>> = {
  design: {
    level: "optional",
    direction: "代码探索",
    reason: "design 需扫代码库定技术方案，规模大时委派可释放主 agent 上下文",
  },
  "design-review": {
    level: "mandatory",
    direction: "代码审查",
    reason: "审查主 agent 刚做的 design 产出，隔离后的 subagent 更客观，避免确认偏差",
  },
  execute: {
    level: "mandatory",
    direction: "代码实现",
    reason: "execute 是写代码/改文件，上下文密度结构性最高，委派收益最大",
  },
  test: {
    level: "optional",
    direction: "测试执行",
    reason: "test 跑测试看结果，规模大时委派可释放主 agent 上下文",
  },
  "exec-review": {
    level: "mandatory",
    direction: "代码审查",
    reason: "审查主 agent 刚写的代码，隔离后的 subagent 更客观，避免确认偏差",
  },
  retrospect: {
    level: "optional",
    direction: "综合",
    reason: "复盘本 wave 执行过程与经验，输入含执行轨迹，规模大时可委派（交接 cw handoff + 本层 session）",
  },
  closeout: {
    level: "optional",
    direction: "综合",
    reason: "closeout 是聚合已有产物的收尾动作，主 agent 有全程跟踪时自己做信息更全",
  },
  replan: {
    level: "optional",
    direction: "代码探索",
    reason: "replan 需重新评估方案，规模大时委派可释放主 agent 上下文",
  },
};

/**
 * planning 层（slice/feature/epic）分级表。
 *
 * planning 是下沉导航层。planning execute 是拆分+创建子 unit+下沉的编排决策，主 agent 不可卸载（禁止）；
 * planning design-review 审查刚做的 Split 设计，确认偏差风险与 wave 一致（强制委派·审查方向）；
 * planning retrospect 可委派，agent 读 cw handoff + 子层 session 做复盘（按需委派·综合方向）。
 */
const PLANNING_RULES: Readonly<Record<string, Rule>> = {
  design: {
    level: "optional",
    direction: "代码探索",
    reason: "design 需扫代码库定 Split + 技术方案，规模大时委派可释放主 agent 上下文",
  },
  "design-review": {
    level: "mandatory",
    direction: "代码审查",
    reason: "审查主 agent 刚做的 Split 设计，隔离后的 subagent 更客观，避免确认偏差",
  },
  execute: {
    level: "forbidden",
    direction: "",
    reason: "planning execute 是拆分+创建子 unit+下沉的编排决策，主 agent 不可卸载",
    // G1 + G5 + MF-1：recursive 模式 execute 后主 agent 不自己 descend，改为派 N 个子层 agent
    // 并行推进子层 + 空闲等 steer 唤醒（v4 多 agent 编排）。派发按 child 层区分（见
    // resolvePlanningExecuteDispatch）：slice→child wave→wave-agent（wave 全流程含 test/exec-review）；
    // feature→child slice→planning-agent；epic→child feature→planning-agent（planning 流程不含 test/exec-review）。
    dispatch: resolvePlanningExecuteDispatch,
  },
  retrospect: {
    level: "optional",
    direction: "综合",
    reason: "复盘本层执行过程，agent 读 cw handoff + 子层 session 可重建上下文",
  },
  closeout: {
    level: "optional",
    direction: "综合",
    reason: "closeout 是聚合已有产物的收尾动作，主 agent 有全程跟踪时自己做信息更全",
  },
};

/**
 * planning execute 的 task 模板（child=wave）：wave 全流程（含 test/exec-review）。
 * wave 是执行层，跑完 design → design-review → execute → test → exec-review → retrospect → closeout。
 */
const WAVE_CHILD_DISPATCH_TASK =
  "推进 child <unitId>：读 cw handoff --unitId <unitId> 获取目标与合同，然后按 guidance 依次走 cw design → design-review → execute → test → exec-review → retrospect → closeout，每步提交后调 cw 拿下一步 guidance；全部完成即结束，不要处理兄弟或父单元。";

/**
 * planning execute 的 task 模板（child=slice/feature）：planning 流程（不含 test/exec-review）。
 * slice/feature 是 PlanningUnit，只走 design → design-review → execute → retrospect → closeout。
 */
const PLANNING_CHILD_DISPATCH_TASK =
  "推进 child <unitId>：读 cw handoff --unitId <unitId> 获取目标与合同，然后按 guidance 依次走 cw design → design-review → execute → retrospect → closeout，每步提交后调 cw 拿下一步 guidance；全部完成即结束，不要处理兄弟或父单元。";

/**
 * 解析 planning execute 的派发指导（按 child 层参数化，MF-1）。
 *
 * - child=wave（slice execute）→ wave-agent + wave 全流程（含 test/exec-review）
 * - child=slice（feature execute）/ child=feature（epic execute）→ planning-agent + planning 流程
 * - childLayer 缺省 → 默认 wave（向后兼容：serial 模式不渲染派发段，故缺省无影响）
 */
function resolvePlanningExecuteDispatch(childLayer?: ChildLayer): {
  agent: string;
  taskTemplate: string;
} {
  switch (childLayer) {
    case "slice":
    case "feature":
      return { agent: "planning-agent", taskTemplate: PLANNING_CHILD_DISPATCH_TASK };
    case "wave":
      return { agent: "wave-agent", taskTemplate: WAVE_CHILD_DISPATCH_TASK };
    default:
      // childLayer 缺省：默认 wave（仅 slice execute 的 child 是 wave）
      return { agent: "wave-agent", taskTemplate: WAVE_CHILD_DISPATCH_TASK };
  }
}

/** layer 参数合法值（对应 cw 的四层 unit）。 */
export type GuidanceLayer = "wave" | "planning";

/**
 * planning execute 派发的子层（recursive 模式）。决定派哪个 agent + task 流程（MF-1）：
 * - "wave"（slice execute 的 child）→ wave-agent + wave 全流程（含 test/exec-review）
 * - "slice"（feature execute 的 child）/ "feature"（epic execute 的 child）
 *   → planning-agent + planning 流程（不含 test/exec-review，PlanningUnit 无此 action）
 */
export type ChildLayer = "wave" | "slice" | "feature";

/** buildSubagentGuidance 可选参数。 */
export interface BuildSubagentGuidanceOpts {
  /**
   * 编排模式（G5）："recursive" 时追加派发指导段（Rule.dispatch）+ 续 turn 指导段
   * （模板 dispatchGuidance）。缺省/"serial" 时输出与现状完全一致（不新增派发噪音）。
   */
  orchestration?: "serial" | "recursive";
  /**
   * planning execute 派发的子层（MF-1）：仅 layer="planning" + action="execute" + recursive
   * 时读取，决定派 wave-agent 还是 planning-agent。planning 三层 handler 各自传入对应 child 层。
   */
  childLayer?: ChildLayer;
}

/**
 * 按 layer + action 生成 subagent 调度引导文本（填 buildNormalGuidance 的 commonGuidance）。
 *
 * 查表命中 → 按档位渲染（mandatory/optional 末尾追加嵌套决策树，forbidden 不追加）。
 * 查表未命中（如 create/abort 等无模板 action）→ 返回空字符串，buildNormalGuidance 省略第 4 段。
 *
 * recursive 模式（G1 + G5）：在现状文本后追加两段——
 *   - 【派发】Rule.dispatch（派哪个 agent 模板 + 子 task 内容），仅规则声明了 dispatch 时输出
 *   - 【续 turn】模板的 dispatchGuidance（被 steer 唤醒后做什么），仅模板声明时输出
 * serial 模式：与现状逐字一致（不新增派发噪音）。
 *
 * @param layer "wave" 或 "planning"（slice/feature/epic 共用 planning）
 * @param action action 名（如 "execute" / "retrospect"）
 * @param opts 可选（orchestration 模式）
 * @returns subagent 调度段文本；无规则时返回 ""
 */
export function buildSubagentGuidance(
  layer: GuidanceLayer,
  action: string,
  opts?: BuildSubagentGuidanceOpts,
): string {
  const rules = layer === "wave" ? WAVE_RULES : PLANNING_RULES;
  const rule = rules[action];
  if (!rule) {
    return "";
  }

  let text: string;
  switch (rule.level) {
    case "mandatory":
      text = [
        `【建议委派】${rule.reason}。`,
        `建议派专门做${rule.direction}方向的 subagent 隔离上下文——此收益结构性稳定，不随任务规模改变。`,
      ].join("\n");
      break;
    case "optional":
      text = [
        `【按需委派】${rule.reason}。`,
        `规模较大或上下文占用明显时，考虑派专门做${rule.direction}方向的 subagent 隔离上下文；任务较小时主 agent 自行处理即可。`,
      ].join("\n");
      break;
    case "forbidden":
      text = [
        `【不建议委派】${rule.reason}。`,
        "请主 agent 自行完成。",
      ].join("\n");
      break;
    // 穷尽性检查：新增档位时这里会编译报错。
    default: {
      const _exhaustive: never = rule.level;
      return _exhaustive;
    }
  }

  // serial（缺省）：输出与现状完全一致（G5 验收：serial 不新增派发噪音）。
  if (opts?.orchestration !== "recursive") {
    return text;
  }

  // recursive 模式：追加派发指导段 + 续 turn 指导段。
  const recursiveSections: string[] = [text];
  if (rule.dispatch !== undefined) {
    const dispatchSpec = rule.dispatch(opts?.childLayer);
    recursiveSections.push(
      `【派发】派 ${dispatchSpec.agent}：${dispatchSpec.taskTemplate}`,
    );
  }
  // 续 turn 指导（被 steer 唤醒后做什么）在阶段模板的 dispatchGuidance 字段（G1 §9），
  // 单源在模板——规则只负责「派谁 + task 内容」，模板负责「派完之后怎么办」。
  const template = layer === "wave" ? WAVE_STAGE_TEMPLATES[action] : PLANNING_STAGE_TEMPLATES[action];
  const continuation = template?.dispatchGuidance;
  if (continuation !== undefined && continuation !== "") {
    recursiveSections.push(`【续 turn】${continuation}`);
  }

  return recursiveSections.join("\n");
}
