# 审查设计文档流程

> 引导派 `tech-design-review` subagent 对设计文档做**对抗式审查**，并处理结果。审查标准见 `review/rubric-design-doc.md`，agent 定义见 `agents/tech-design-review.md`。

## Step 1：确认审查对象

从用户处拿到：
- 待审文档路径（单个 .md）
- 报告 output 路径（如 `.review/design-review-<时间戳>.md`，不便写则当前目录）

## Step 2：派 tech-design-review subagent

**路径解析（主 agent 做）**：本 skill 的安装位置 = available_skills 里 `tech-design` 的 `location` 字段（通常 `~/.agents/skills/tech-design`）。据此拼出绝对路径：
- rubric：`<location>/review/rubric-design-doc.md`
- references（按需传给 subagent）：`<location>/references/design-principles.md`、`<location>/references/anti-patterns.md`

派 `tech-design-review` agent（对抗式审查者）。**subagent 独立加载、不在 skill 上下文，task 里所有路径必须用绝对路径**。task 用三段式：

```text
agent: tech-design-review
task:
  背景：对设计文档 <文档绝对路径> 做对抗式审查。该文档是 <一句话说明这是什么设计>。
  目标：
    1. read <rubric 绝对路径> 加载 P0/P1 清单
    2. read <文档绝对路径>
    3. read 目标项目 AGENTS.md / ARCHITECTURE.md（若存在）提取项目特定约定
    4. 逐项审查，找反例和攻击面（对抗式），声称事实错误前必须 read 源码核实
    5. 报告写到 <output 绝对路径>
  验收：
    - 返回 structured-output { report_file, must_fix, suggestion }
    - report_file 指向的文件存在且含 Summary + Findings 表
    - 每个 MUST_FIX 引用了 P0-N 检查项编号 + 文档位置
```

**不要自己审**——审查与写作分离，避免确认偏差。派给独立的对抗式 agent。

## Step 3：接收结果

读 subagent 返回的 structured-output，关注 `must_fix` / `suggestion` 计数。

## Step 4：处理

- **must_fix > 0**：向用户报告问题清单（按 MUST_FIX > SUGGESTION 排序），建议按 review 结果修改文档。**本 flow 不自动改文档**——修改由主 agent（或用户）按 `flow/write.md` 重新走相应步骤
- **must_fix == 0**：审查通过。suggestion 可选修复

## 衔接

修改后若要复审，重新走 Step 2（派 agent 审查新版本）。对抗式审查可能一轮不够——真实案例经 4 轮才收敛，这是正常的。
