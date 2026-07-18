/**
 * existence-plan 提示词 — delete-only shape 的 tdd_plan 阶段引导。
 *
 * 触发点：state-machine.ts buildNextAction 的 plan_review pass 出口 + tdd_plan retry 分支，
 * 按 taskShape='delete-only' 分流到本提示词（替代 full-tdd 的 TDD_PLAN_PROMPT）。
 *
 * 交付物：existence.json（artifacts 清单），由 cw tdd_plan 消费。
 * 与 TDD_PLAN_PROMPT 的区别：不写测试代码（无可执行的逻辑验证），改声明「产物存在性契约」——
 *   列出 dev 后哪些文件应存在（present）、哪些应已删除（absent），test 阶段 postDevVerify
 *   跑 existsSync 自动核对。
 *
 * 适用：删除任务（删旧文件即交付）、存在性契约（配置必须生成、旧文件必须清理）。
 */

export const EXISTENCE_PLAN_PROMPT = `
[tdd_plan 阶段] 写 existence.json（产物存在性清单）

本任务是 delete-only shape——通过「删除文件」或「保证文件存在/不存在」完成交付，
没有可执行的测试逻辑可验。本阶段声明产物存在性契约（existence.json），test 阶段
postDevVerify 会跑 existsSync 自动核对每个产物的实际状态。

## 工作流

1. 读 dev-plan.json 的 waves，理解每个 wave 要删/建哪些文件
2. 列出 dev 后应有的产物状态：
   - 删除任务 → 声明 expectedState="absent"（文件应已删除）
   - 新增/保留任务 → 声明 expectedState="present"（文件应存在）
3. 写 existence.json：

    echo '<existenceJson>' | cw tdd_plan --topicId <topicId>

## existence.json 结构

{
  "artifacts": [
    { "path": "src/legacy-feature.ts", "expectedState": "absent" },
    { "path": "docs/migration-done.md", "expectedState": "present" }
  ]
}

## 字段说明

- **artifacts**: 产物清单（至少 1 条）。每条声明一个文件的存在性契约
- **path**: 相对 workspacePath 的文件路径（不可用 .. 或绝对路径逃逸沙箱）
- **expectedState**:
  - \`"absent"\`：dev 后该文件应已删除（删干净即交付）
  - \`"present"\`：dev 后该文件应存在（生成/保留即交付）

## gate 校验

- artifacts 非空（至少 1 条）
- 每个 path 非空字符串 + 在 workspace 沙箱内
- expectedState ∈ {present, absent}（schema 强制）

gate fail 时返回 mustFix，status 不变（plan_reviewed），修后重调 cw(tdd_plan)。

## 与 full-tdd 的区别

| 维度 | full-tdd | delete-only |
|------|----------|-------------|
| dev 前交付物 | test.json（测试代码 + 用例） | existence.json（产物清单） |
| dev 后验证 | 跑测试（judgeByExpected） | existsSync 核对存在性 |
| 红灯校验 | 测试必须先 fail | 无（无可执行测试） |

## 禁止

- [禁止] 写测试代码（删除任务无逻辑可测，验存在性即可）
- [禁止] 声明 dev 无法控制的产物（如系统目录、node_modules 等外部文件）
- [禁止] path 越界（../ 逃逸 / 绝对路径会被沙箱拒绝）

## 完成标志

existence.json 写完且 cw(tdd_plan) gate 通过（status=pre_dev_verified）后，进入 dev 阶段
执行删除/新建，commit 后调 cw(dev)。
`.trim();
