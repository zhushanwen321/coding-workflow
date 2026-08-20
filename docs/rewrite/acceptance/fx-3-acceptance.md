# fx-3 验收标准：分解结构建立缺位 R5 修复（gate 收紧 + 任务书指令化 + 派发兜底）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending
>
> 依据：`final-gate-3-report.md` §根因（R5 三层缺位）。工作流语义变更：**designer 先建子、后提 spec**（split 声明的子必须已存在，spec 提交时强制校验）。

## R5.1：spec gate 收紧（handler 层，错误最早暴露）

`src/handlers/evidence-submit.ts` spec 形态校验链追加：`spec.split` 非空时，每个条目的 unitId 必须——① 已存在于账本（UnitCreated）② 其 `parentId === spec.unitId`（防张冠李戴引用别家子）。违反 → exit 1，错误含缺失/错配清单与恢复动作（「先 `cw create --id <slug> --brief <文件> --parent <unitId>` 创建全部子 unit，再提交 spec」）。

## R5.2：designer 任务书建子指令化（loop.ts）

`renderBrief` 的 designer 任务步骤追加第 0 步（条件：该 unit 是 root 且账本中无任何 `parentId === unitId` 的子）：「0. 本 unit 是根节点且尚无子 unit——若任务书/brief 含拆分建议：先为每个子执行 `cw create --id <slug> --brief <子brief文件> --parent <unitId>`（子 brief 可为占位文件），再进入第 1 步」。既有三步（写 spec → evidence submit → review submit）不变。

## R5.3：派发兜底出口（loop.ts，处理历史/旁路数据）

`computeDispatchTargets` 追加分支：unit 状态 spec-frozen 且其最后 spec 的 `split` 声明的 unitId 有未 created 者 → **派 designer**，brief 内容：「spec 声明了 N 个子 unit 但 M 个未创建——请先创建缺失子：`cw create --id <slug> --brief <文件> --parent <unitId>`（清单逐个列出）」。该分支优先于内部节点集成等待分支（子不齐不集成，fx-1 已有 split 权威集合判定——本分支在其之前拦截）。

## 回归测试（tests/fx3-*.test.ts，≥5 条）

1. R5.1：split 声明不存在 unitId → spec 提交 exit 1 且错误列出缺失 id 与恢复动作；子存在但 parent 错配 → 拒。
2. R5.1 阴性对照：子全存在且 parent 正确 → spec 照常过审入账。
3. R5.2：root 无子时 designer brief 含第 0 步建子指令（含 cw create 模板）；root 已有子 → 不含第 0 步。
4. R5.3：spec-frozen + split 子未建 → 派 designer（brief 含缺失清单）；测试进程补 create 后 → 转正常集成等待。
5. 全链：fixture 模拟第 3 次终验现场（root spec-frozen、split 两子未建、零派发目标）→ runLoop 派 designer 建子 → 后续正常推进到全树 closed（测试适配器扮演，真实账本）。

## 通过命令

`npm run check:all` / `npm test` 全量全绿（222 + 新增）/ `npm run lint` 零输出。

## 禁改清单

除 `src/handlers/evidence-submit.ts`、`src/runner/loop.ts`、`tests/fx3-*` 新文件外一切禁改；fx-1/fx-2 全部修复行为不得回退（fx1/fx2 既有测试全绿为准）；u2/u7/u8 既有测试若因语义收紧需断言适配，逐条列理由仅限直接受影响断言。禁 git 写操作；禁 mock；禁 any。

## 修复后

verifier 验收 → commit → 靶子重置 → 终验第 4 次（同 brief）。
