/**
 * diagnosing-bugs skill —— 硬 bug 诊断 6 阶段方法论。
 *
 * 源：mattpocock skills 的 engineering/diagnosing-bugs/SKILL.md，内化重写为中文，
 * 打包进 dist（agent-agnostic，不依赖本地 skill 文件）。
 *
 * 这是 cw 整合 mattpocock skills 的标杆案例：
 *   - 最纯的方法论 skill（零机制依赖，只输出文本）
 *   - 验证 `cw skill` 命令机制（list + read）可行
 *
 * 不内化（plan §3.2 已确认）：scripts/hitl-loop.template.sh（人类介入模板）——
 * 降级为"需要人类介入时停下问用户"（Phase 1 第 10 项已体现）。
 *
 * hand-off：Phase 6 发现架构问题 → 调 `cw skill improve-codebase-architecture`。
 */

import type { SkillEntry } from "./types.js";

/** 6 阶段方法论 body（模板字符串，避免双引号冲突）。 */
const BODY = `# diagnosing-bugs：6 阶段硬 bug 诊断循环

硬 bug 的诊断纪律。只在显式说明理由时跳过某个阶段。

## 触发场景
- review_fix / test_fix 连续失败 ≥3 次
- 用户报告 hard bug（非 lint 错误、非已知原因快速修复）
- 报告 throwing / failing / 慢（性能回归）

## 核心硬规则
没有 red-capable 命令不许进入 Phase 2。
如果你发现自己还没构造 red-capable 命令就在读代码建理论——停下。
"red-capable 命令" = 一条能针对当前 bug 变红的命令，不是 "runs without erroring"。

## Phase 1 — 建 red-capable feedback loop

"This is the skill. Everything else is mechanical."
目标：构造一个 tight、red-capable 的反馈环——一条能针对当前 bug 变红的命令。
在这里花不成比例的精力。要 aggressive、creative、不放弃。

10 种构造方式（按优先级尝试）：
1. failing test（unit / integration / e2e，任何能到达 bug 的 seam）
2. curl / HTTP 脚本（打运行中的 dev server）
3. CLI + fixture + 快照 diff（输入 fixture，stdout diff 已知正确的快照）
4. headless browser（Playwright / Puppeteer，驱动 UI 并断言 DOM/console/network）
5. replay 捕获的 trace（把真实 network request / payload / event log 落盘，在隔离环境重放）
6. throwaway harness（启动最小子集，mock 掉依赖，一条函数调用走 bug 代码路径）
7. property / fuzz loop（"sometimes wrong output" 类 bug，跑 1000 随机输入找失败模式）
8. bisection harness（bug 出现在两个已知状态之间，自动化 "boot at state X, check, repeat"，让 git bisect run 跑）
9. differential loop（同输入走旧版本 vs 新版本 / 两个配置，diff 输出）
10. HITL bash 脚本（最后手段——人类必须点击时，用结构化脚本驱动他；捕获的输出回流给你）

构造后要 tighten（把 loop 当产品对待）：
- 更快？缓存 setup、跳过无关 init、缩窄 scope
- 信号更锐？断言具体症状而非 "没崩"
- 更确定？pin 时间、seed RNG、隔离文件系统、冻结网络

非确定性 bug：目标不是干净复现，而是提高复现率。
loop 触发 100×、加压、缩窄时间窗、注入 sleep。
"50% flake 可调试，1% 不行——持续提高率直到可调试"。

真的无法构造 loop 时：明确停下，列出已尝试项，向用户要：
(a) 复现环境访问 / (b) 捕获产物（HAR/log/core dump/带时间戳录屏）/ (c) 加临时生产埋点的许可。
没有 loop 不要进入 Phase 2。

完成判据（4 个 checkbox 全过——loop 必须 tight 且 red-capable）：
- [ ] Red-capable——驱动真实 bug 代码路径、断言用户描述的确切症状、能变红也能在修复后变绿
- [ ] Deterministic——每次同样判定（flaky 则 pin 一个高复现率）
- [ ] Fast——秒级，非分钟级
- [ ] Agent-runnable——无人值守能跑

## Phase 2 — 复现 + 最小化

跑 loop 看它变红。确认：
- 复现的是用户描述的失败模式（不是附近的另一个 bug——"wrong bug = wrong fix"）
- 跨多次运行可复现（或非确定 bug 达到足够高的率）
- 捕获了确切症状供后续阶段验证（错误消息 / 错误输出 / 慢的 timing）

最小化：缩到 "还能变红的最小场景"。
一次切一个输入/调用方/配置/数据/步骤，每次切完重跑 loop，只留 load-bearing 的部分。
意义：最小 repro 缩小了 Phase 3 的假设空间（更少 moving parts 可疑），并成为 Phase 5 的干净回归测试。
完成判据：every remaining element is load-bearing——移掉任一个 loop 就变绿。
复现且最小化之前不要进入 Phase 3。

## Phase 3 — 生成 ranked hypotheses

测试前先生成 3-5 个 ranked hypotheses（单假设生成会锚定第一个看似合理的想法）。

每个必须 falsifiable，含明确预测。格式：
"If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

不能陈述预测 = 是个 vibe，丢弃或锐化它。

测试前把 ranked list 给用户看：domain knowledge 能即时重排（"我们刚部署了 #3 的改动"），
或排除已试过的。cheap checkpoint, big time saver。用户 AFK 就按自己的排序继续，不 block。

## Phase 4 — Instrument

每个 probe 映射 Phase 3 的一个具体预测。一次只改一个变量。

工具偏好顺序：
1. debugger / REPL inspection（如果环境支持——一个断点顶十条 log）
2. targeted logs（区分假设的边界处）
3. 禁止 "log everything and grep"。

[DEBUG-xxxx] 前缀约定：每条 debug log 打唯一前缀如 [DEBUG-a4f2]，结尾清理变成一次 grep。
"Untagged logs survive; tagged logs die."

性能分支：性能回归时 log 通常是错的。
先建立 baseline 测量（timing harness / performance.now() / profiler / query plan），再 bisect。
"Measure first, fix second."

## Phase 5 — Fix + 回归测试

写回归测试先于修复——但仅当存在 correct seam。

correct seam = 测试能像 bug 在 call site 发生那样真实复现 bug 模式。
seam 太浅（单 caller 测试但 bug 需多 caller、unit test 无法复现触发链）会带来 false confidence。

"If no correct seam exists, that itself is the finding."——记下它，
代码架构本身阻止了 bug 被 lock down，留给 Phase 6 处理。

有 correct seam 时的 5 步：
1. 把 minimized repro 变成该 seam 上的 failing test
2. 看它失败
3. 应用修复
4. 看它通过
5. 用 Phase 1 loop 跑原始（未最小化）场景再验证

## Phase 6 — Cleanup + post-mortem

声明 done 前的硬 checkbox：
- [ ] 原始 repro 不再复现（重跑 Phase 1 loop）
- [ ] 回归测试通过（或 seam 缺失已文档化）
- [ ] 所有 [DEBUG-...] 埋点已移除（grep 前缀）
- [ ] throwaway 原型已删除或移到明确标记的 debug 位置
- [ ] 正确的那个 hypothesis 写进 commit/PR message（让下一个 debugger 学到）

最后自问："what would have prevented this bug?"——
若答案涉及架构变化（没好的 test seam、调用方纠缠、隐藏耦合），
调 \`cw skill improve-codebase-architecture\` 并附上 specifics。
在修复之后提建议，不是之前——"you have more information now than when you started"。

## 反模式清单（禁止）

- 还没有 red-capable 命令就开始读代码建理论（the exact failure this skill prevents）
- "runs without erroring" 被当成反馈信号——必须能 catch this specific bug
- 30 秒 flaky loop（barely better than no loop）——必须 tighten 到秒级 deterministic
- 非 deterministic bug 放弃（1% 也得持续提率到可调试）
- 无法构造 loop 时偷偷进入 hypothesise
- Phase 3 只生成一个 hypothesis（锚定偏差）
- 不陈述预测的 "vibe" hypothesis
- Phase 4 "log everything and grep"
- 未 tag 的 debug log（会存活下来）
- 性能回归直接靠 log（应该先 baseline + bisect）
- Phase 5 在太浅的 seam 上写回归测试（false confidence）
- 修复前就提架构改造建议（应该在修复后）
`;

/** diagnosing-bugs skill 完整条目。 */
export const DIAGNOSING_BUGS_SKILL: SkillEntry = {
  name: "diagnosing-bugs",
  summary: "6 阶段硬 bug 诊断循环",
  trigger:
    "review_fix / test_fix 连续 fail ≥3 次 / 用户报 hard bug / 报 throw / fail / 慢",
  body: BODY,
};
