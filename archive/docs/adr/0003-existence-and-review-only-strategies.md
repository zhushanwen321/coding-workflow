# ADR 0003：existence + review-only 验证策略

## 状态

Accepted（2026-07-18，topic cw-2026-07-18-postdev-extract-and-existence-reviewonly-strategies）

## 背景

Topic 1（TaskShape 打地基）完成了策略接口 + full-tdd 封装，但 postDevVerify 是占位（返回 []），且 handleTddPlan 的 parsed 写入仍硬编码 testCases。非 TDD 任务（纯删除、文档）仍跑不通——existence 需要 postDevVerify 跑文件存在性检查，review-only 需要跳过机器验证。

## 决策

### 1. existence.json 产物清单模型

agent 在 tdd_plan 阶段提交 existence.json（而非 test.json）：
```jsonc
{ "artifacts": [{ "path": "src/old.ts", "expectedState": "absent" }] }
```
dev 阶段执行删除/创建，test 阶段 postDevVerify 检查每个 path 是否符合 expectedState。

### 2. isDevVerified 读缓存不跑 IO

existence 的 isDevVerified 要检查文件存在性，但 computeGatePassed 被 buildNextAction 多处调用会反复 stat。解决：postDevVerify 跑 existsSync 后把结果写入 topic.existenceArtifacts[i].verified，isDevVerified 只读缓存。isDevVerified 保持纯函数（只读 topic），副作用隔离在 postDevVerify（test 阶段调一次）。

### 3. applyPreDevResult 接口方法

VerificationStrategy 加 applyPreDevResult(topicId, store, parsed) 方法，替代 handleTddPlan 硬编码的 insertTestCases。每个策略自己决定 parsed 怎么写入 store（tdd 写 testCases，existence 写 existenceArtifacts，review-only no-op）。

### 4. 不改 TRANSITIONS

delete-only/doc-only 仍走全链（tdd_plan→dev→review→test）。阶段裁剪（跳 spec/plan_review）是步骤 4 的事。ReviewStagePolicy.stages 字段此时只是声明，供步骤 4 用。

### 5. review-only 恒 pass 模型

review-only 策略：preDevCheck 恒 pass（无 payload）、postDevVerify 返回空数组、isDevVerified 恒 true。不靠机器验证判定完成，纯靠 review 人审兜底。适用文档/配置/架构调整。

## 后果

正面：
- 纯删除任务（delete-only）能跑通完整 CW 流程，用文件存在性验证
- 文档任务（doc-only）能跑通，不强制造测试
- postDevVerify 抽取完成，后续新策略（regression 等）可复用

负面：
- existence 的 verified 缓存模式增加状态复杂度（postDevVerify 写，isDevVerified 读，首次 test 前是 undefined）
- guidance 文案分流增加 buildNextAction 分支

## 替代方案

- **git diff 验证模型**（existence 用 git diff 而非 existence.json）：复用 WaveChange 基建但不加新字段，但语义不如产物清单清晰。否决。
- **只做 review-only 不做 existence**：最小范围，但 existence 才是纯删除任务的真痛点。否决。
