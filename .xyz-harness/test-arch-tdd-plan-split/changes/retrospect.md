# Retrospect: test-arch-tdd-plan-split

## 做得好的

- **设计先行**：先用多轮讨论 + HTML 可视化确认方案（dev-plan/test.json 拆分、tdd_plan 阶段、priority、回退策略、replan 扩展），再动手编码。避免了一边改一边发现设计问题。
- **subagent 分治**：W3（gate.ts）和 W4+W5+W6（actions+state-machine+cli）用 subagent 处理，主 agent 保持上下文清爽。W7（store）与 W2（parser）并行启动。
- **向后兼容**：旧格式 plan.json 通过 legacyTestCases 兼容，parseLitePlan 作为 deprecated 别名保留。不破坏现有使用方。
- **prompt 完整性**：每个 nextAction 分支都有对应的 prompt（DEV_PLAN_PROMPT/TDD_PLAN_PROMPT/EXECUTE_PROMPT），agent 不会不知道下一步做什么。

## 需改进的

- **红灯校验未接入**：redLightCheck 函数已实现但 handleTddPlan 没调用。原因是 testRunner 的存储链路（Topic → store → handler）还没完全打通。这是 MVP 的合理简化，但应该在下一个 topic 补上。
- **commit 粒度不均**：W4+W5+W6 合并成一个 commit（3 个 Wave 共享），因为三者联动太紧密（改 state-machine 需要同时改 dispatch + cli 才能编译通过）。CW 标记了 extraCommitReuse warning 但不阻断。理想情况应该分 3 个 commit，但需要 stub 代码过渡。
- **外部文件混入 commit**：`git add -A` 意外把 .agents/skills/ 和 .xyz-harness/ 的文件带进了 W4+W5+W6 的 commit。虽然不破坏功能，但 commit 历史不干净。

## 关键学习

- **tdd_plan 的价值**：把测试代码 + expected 从 plan 阶段移到 tdd_plan 阶段，agent 先写测试代码再填 expected。expected 从测试断言取值（如 `.toBe(2)` → `{text:"2"}`），不是猜的。这直接解决了原始 TDD 矛盾。
- **test 失败统一回 dev 的简化**：原方案设计了 rollbackPolicy（按 priority/failedCount 自动路由回退目标），最终简化为统一回 dev + replan 由 agent/用户决定。简单 > 智能。
- **testRunner 配置的前瞻性**：testRunner 支持 nodejs/python/java/custom 四种模式，为多语言项目铺好了路。虽然当前 CW 自身只用 vitest（nodejs 模式），但其他语言项目可以直接用。
