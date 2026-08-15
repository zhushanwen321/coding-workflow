# 终验报告（第 4 次）：markdown-reader 全流程 E2E（fx-3 后，真实靶子，无人干预）

- 判定：**PASS**（runner exit 0，root closed，全树 3 unit closed。四条通过标准全部机器判定达成。fx-3 建子语义现场生效；fx-2 R4a 集成恢复出口**首次现场闭环验证**——R4 契约漂移场景再现并被完整恢复）
- 日期：2026-08-16（日志时间戳为 UTC；本地时区 UTC+8）
- 依据：`development-plan-v2.md` §4；fx-3 修复（commit `8e0bf13`，230 测试绿）后同口径重跑；前序报告 `final-gate-report.md`（第 1 次）、`final-gate-2-report.md`（第 2 次）、`final-gate-3-report.md`（第 3 次）
- 环境隔离：`CW_HOME=/tmp/final-gate-4-home`（保留，账本在
  `/tmp/final-gate-4-home/__Users__zhushanwen__Code__test-repo__recursive-split-e2e/events.log`）；
  PATH 注入重写版 cw（`/tmp/final-gate-4/bin/cw` → `node <repo>/dist/cli.js`）；
  模型 `CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro`
- 靶子：`/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`（空 git 仓库起步，产物保留，6 commit）
- brief：`/tmp/final-brief-4.md` = 第 2/3 次 brief（`/tmp/final-brief-2.md`）逐字 + 仅一处新增（§2 节标题下插入一行）：「**工作流变更**：提交 root spec 前先创建两个叶子 unit（`cw create --id leaf-renderer --brief <占位> --parent md-reader`；同 leaf-app），再提交含 split 的 spec——否则 spec 提交会被拒」；`diff` 核实全文仅此一行差异（与 fx-3 系统口径一致）
- 执行命令：`cw create --id md-reader --brief /tmp/final-brief-4.md` → `cw run --root md-reader --spawn pi --poll-ms 3000 --max-idle-ms 2700000 --max-concurrency 2`（stdout/stderr 落盘 `/tmp/final-gate-4-runner.log`）
- 人工干预：**0**（观察者角色，未改靶子任何文件、未代跑命令、未止损——45 分钟止损上限与同 role 重派 4 次上限均未触达）

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 总时长（runner 首派 → root closed） | 20:44:48 → 21:29:53 UTC，约 45.1 分钟 |
| 有效工作期 | 全程（每时段均有 spawn 在工作；最长单 spawn = leaf-renderer builder #1 的 30 分钟，被 per-spawn 超时机制收口） |
| pi spawn 次数 | 10（4 designer + 3 builder + 3 reviewer）：9 exit 0 + 1 TIMEOUT（重派） |
| runner 状态机重派 | 1（builder→leaf-renderer #2，per-spawn 超时触发；止损线 4 次未触达） |
| 账本事件数 | 27（UnitCreated 3 / SpecSubmitted 4 / VerdictSubmitted 7 / EvidenceSubmitted 5 / VerifyRan 8：叶子 verify 5 + 集成 3） |
| 靶子 git commit | 6（全部由被测系统产出：leaf-app 3 + leaf-renderer 3） |
| 验收机器验证 | 7/7 pass（root 3 + leaf-renderer 2 + leaf-app 2，全树 closed） |
| manual 型验收 | 0（三 spec 共 7 条验收全部 e2e-real/unit 型，manual=0 达成） |
| 集成验证轮次 | 3（fail → fail → **pass**；连续 fail 恰 2 次后停自动重派，与 fx-2 设计上限一致） |

终验四条通过标准逐条判定：

1. runner exit 0 且 root closed → **✓**（`root "md-reader" 已 closed——调度循环结束（exit 0）`；`cw status`/`cw tree` 全树 closed）
2. 全部验收机器验证、manual=0 → **✓**（7/7 验收 ✓，manual=0；root 验收由最终集成 pass run 覆盖 A1/A2/A3）
3. 靶子现场验证 → **✓**（install/build/vitest 3/3/渲染断言 `A1 PASS`/dev server HTTP 200 全绿，见 §6）
4. 账本可 replay → **✓**（27 事件 seq 1-27 连续无断；`cw status`/`report`/`tree` 两次读取 md5 逐项一致；两叶 UnitCreated seq2/seq3 < root SpecSubmitted seq4——fx-3 语义现场证据，见 §3）

## 2. 时间线（runner 日志 + 账本，UTC）

```text
20:44:45  seq1   UnitCreated md-reader（人工 cw create）
20:44:48  [runner] 派发 designer → md-reader
20:45:04  seq2/3 UnitCreated leaf-renderer / leaf-app（root designer 在 spawn 内建两子，
          parent=md-reader——第 0 步任务书 + brief 工作流变更行双引导下执行，无停顿提问）
20:45:06  [runner] 派发 designer → leaf-renderer（max-concurrency=2，与 root designer 并行）
20:45:13  seq4   SpecSubmitted md-reader（A1 e2e-real / A2 unit / A3 e2e-real；
          契约 C1 signature="export function renderMarkdown("；split=[leaf-renderer, leaf-app]）
20:45:16  seq5   spec-review pass → root spec-frozen
20:45:23  root designer 退出 exit 0 → 派发 designer → leaf-app
20:45:56  seq6/7 leaf-app spec（A1/A2）过审
20:46:04  leaf-app designer 退出 → 派发 builder → leaf-app
20:46:32  seq8/9 leaf-renderer spec（A1/A2）过审
20:46:42  leaf-renderer designer 退出 → 派发 builder → leaf-renderer（#1）
20:47:33  seq10  leaf-app build-001（cc65472）
20:47:43  seq11  leaf-app verify fail（covered=[]：e2e 标记/用例名偏差）
20:49:13  seq12  leaf-app build-002（8acc519）
20:49:18  seq13  leaf-app verify pass（covered=[A1,A2]）
20:49:26  leaf-app builder 退出 → 派发 reviewer → leaf-app
20:50:33  seq14  leaf-app exec-review pass → closed（第一个 unit 闭环，6.5 分钟）
20:50:56  leaf-app reviewer 退出
20:46:42–21:16:37  leaf-renderer builder #1 工作期（30 分钟）：实现 shiki 版 renderer、
          20:51 改写 renderer.test.ts、21:16:37 超时前提交 build（6cef802）
21:16:42  [runner] builder leaf-renderer #1 退出 TIMEOUT（per-spawn 30 分钟上限），标记可重派
          → 立即派发 builder → leaf-renderer（#2）
21:16:49  seq16  leaf-renderer verify fail（covered=[]：A1 e2e「no-markers」+ A2 用例名不含 id）
21:21:47  seq17  build lr-build（7117f6d，shiki Node 兼容修复）
21:22:41  seq18  verify fail（covered=[A1]）
21:23:13  seq19  build lr-build-v2（2be20c8，用例 describe 重命名含 A2）
21:24:06  seq20  verify pass（covered=[A1,A2]）
21:24:09  [runner] 集成验证首跑（子树全 verified，不派 agent）→ 契约 C1 未命中 fail
          （实现为 export async function renderMarkdown( —— R4 场景第 2 次再现）
21:25:37  派发 reviewer → leaf-renderer；builder #2 退出 exit 0
21:25:38  集成第 2 跑 fail（连续 fail 计数 = 2）
21:26:35  seq22  leaf-renderer exec-review pass → closed
21:28:48  seq23  集成第 2 次 fail 审计入账 → [runner] 集成连续 fail 达上限（2 次）——
          停止自动重派集成，转派 designer 处置契约漂移（fx-2 R4a 出口）
21:29:17  seq24  designer 重提 root spec（唯一实质差异：C1 签名改为
          "export async function renderMarkdown("——处置路径①）
21:29:18  seq25  spec-review pass（designer 同 spawn 内提交；连续 fail 计数随新 spec 清零）
21:29:19  集成第 3 跑 → pass（契约命中 + 7 条验收全绿）→ seq26 入账
21:29:37  designer 退出 → 派发 reviewer → md-reader
21:29:53  seq27  root exec-review pass → closed → 调度循环结束 exit 0
```

## 3. fx-3 三层现场验证（本次核心观察项 1）

### R5.1（spec gate 校验 split 子存在）：放行路径现场走通，拒绝路径未打靶

- 现场证据：seq2/seq3 两叶 UnitCreated（20:45:04）**早于** seq4 root SpecSubmitted（20:45:13）——「先建子后提 spec」的 children-first 时序在真实账本中成立，gate 在子已建前提下放行 root spec，全程无拒绝记录。
- 未打靶：本次 designer 一次做对，未出现「split 声明不存在的子被拒后在同 spawn 内恢复」的实证；R5.1 拒绝分支的效果以 fx-3 验收报告（commit `8e0bf13`）的影子工程红绿为准。

### R5.2（designer 第 0 步建子任务书）：在场且被执行 ✓

- 首派任务书原文（git `cc65472:.cw-spawn/md-reader.designer.brief.md`，「你的任务（designer）」节）：「0. 本 unit 是根节点且尚无子 unit——若任务书/brief 含拆分建议：先为每个子执行 cw create …（子 brief 可为占位文件），再进入第 1 步（spec.split 声明的子必须已创建，否则提交会被拒）。」
- 执行证据：root designer spawn 内 39 秒建完两子（20:44:48 派发 → 20:45:04 两叶 created），stdout 叙述「leaf-renderer created / leaf-app created」与账本一致；对照第 3 次同场景（无第 0 步任务书，41 秒即停问退出、空转 44.8 分钟）。
- 归因限制：brief 工作流变更行（第 4 次新增）与系统第 0 步任务书同时在场，双保险下无法严格归因单一因素起效（与第 2 次 R3 归因口径同理）。可归因的是**组合效果**：机制（任务书）+ 引导（brief 行）共同保证了 children-first，不再依赖 agent 自觉。

### R5.3（派发兜底：split 子未建 → 派 designer 补建）：未触发（无需兜底）

- 两叶在 root spec 提交前已建，`splitChildrenNotCreated` 恒为空，兜底分支零调用。效果以 fx-3 影子工程（回归 #5）为准。

## 4. fx-2 / fx-1 现场验证（本次核心观察项 2）

### fx-2 R4a（集成 fail 上限 + designer 契约漂移处置）：**首次现场全链闭环验证 ✓**

R4 场景（契约签名 async 变体漂移）在本次真实再现，恢复出口完整工作：

1. **漂移再现**：root spec C1 `export function renderMarkdown(`（designer 照 brief 模板）vs leaf-renderer 实现 `export async function renderMarkdown(`（`src/renderer.ts` L18，shiki 异步 API 的自然写法）——与第 2 次 R4 根因同构。
2. **上限生效**：集成 fail ×2（seq21/seq23，21:24 与 21:25-28）后 runner 输出「集成连续 fail 达上限（2 次）——停止自动重派集成，转派 designer 处置契约漂移」，**恰在第 2 次即停**，对照第 2 次的 31 轮无限重跑（idle 兜底永不触发）。
3. **处置任务书在场且完整**：第 2 次派发的 designer brief 标题即「集成契约漂移处置」，含集成失败事实（机器判定原文 C1 未命中 + 完整报告路径 + 「失败验收：无」）与二选一处置指引（①改契约重新过审、②provider 修复需人工介入）。
4. **designer 正确仲裁**：判定 async 变体属「语义等价但文本不等」→ 走路径①：C1 签名修正为 `export async function renderMarkdown(`，重提 spec（seq24）+ 过审（seq25）。
5. **恢复闭环**：新 spec 过审后集成重跑 pass（seq26，contracts.ok=true + 7 条验收批次全绿）→ root verified → reviewer exec-review pass（seq27）→ closed → runner exit 0。从上限触发（21:28:48）到 root closed（21:29:53）**65 秒**。
6. 附带验证：「连续 fail 计数随新 spec 提交清零」语义现场成立（第 3 跑集成即正常执行且 pass，未被旧计数拦截）。

对照第 2 次同场景（死锁：root 与 closed provider 双双无派发出口 → 无限重跑 → 人工止损 kill）：fx-2 把「死锁 + 无限烧 CPU」变为「2 次封顶 + 65 秒仲裁恢复」。

### fx-2 R4b（idle 兜底不被集成审计事件喂失效）：间接验证

- 上限机制切断了「每 poll 一轮完整集成重跑」的事件流，第 2 次的 idle 失效前提（集成 fail 事件持续刷新 lastProgressAt）不复存在——本次集成 fail 期间共 3 个 VerifyRan 事件，非 31+。
- 直接打靶（长时间集成 fail 下 idle 兜底是否正常计时）未出现——fail 计数 2 次即转处置，未进入长时间空转。R4b 的独立效果仍以 fx-2 影子工程为准，本次无反例。

### fx-1 三修复现场状态

| 修复 | 本次现场状态 |
|------|--------------|
| R1 split 自引用三防线 | 未复现未打靶（designer 提交的 split 无自引用；与第 2 次同口径，以 fx-1 影子工程为准） |
| R2 重提 spec 派发真空 | 未触发：本次唯一的 spec 重提（seq24 root）由 designer 在同一 spawn 内随即提交 review（21:29:17 提交 → 21:29:18 过审），未落入「重提后无人补审」状态；leaf-renderer builder 重提的是 build 证据（幂等 runId），非 spec。第四分支已在第 2 次现场验证 |
| R3 marker 约定 | 变体再现但有界自愈：leaf-renderer verify 两次 fail（seq16 no-markers + seq18 用例名不含验收 id——id 本身均 A 开头，属「标记行缺失/用例名约定」另一变体，非第 1 次的 id 前缀误解），builder #2 单 spawn 内 2 轮修复（7117f6d、2be20c8），无死锁无空转 |

## 5. 账本 replay（终态投影）

`cw status` / `cw tree`：

```text
md-reader  closed  specs:2 evidences:0 lastVerify:pass
leaf-renderer  closed  specs:1 evidences:3 lastVerify:pass
leaf-app  closed  specs:1 evidences:2 lastVerify:pass

md-reader (closed)
  leaf-renderer (closed)
  leaf-app (closed)
```

- 27 事件 seq 1-27 连续无断（脚本核验）；`cw status`/`report`/`tree` 各两次读取 md5 逐项一致（status `b65b4e83…`、report `689ce0a6…`、tree `5db26e31…`），折叠幂等。
- `cw report`：md-reader 2 版 spec（v1 契约 sync 签名 → v2 async 签名，验收/split 不变）、3 次集成 verify（fail/fail/pass，末次覆盖 A1/A2/A3）、1 条 exec-review pass；leaf-renderer 1 spec + 3 build 证据（6cef802 → 7117f6d → 2be20c8）+ 3 次 verify（fail/fail/pass）+ exec-review pass；leaf-app 1 spec + 2 build + verify（fail/pass）+ exec-review pass。全链 commit 与靶子 git log 一一对应。
- 两叶 UnitCreated（seq2/3）< root SpecSubmitted（seq4）：fx-3 children-first 语义的账本现场证据（第 1/2 次该时序为 root spec 在前、建子在后——seq4 早于 seq6/7——三次对照可见工作流语义变化）。

## 6. 靶子现场验证（runner 退出后执行）

| 检查 | 结果 |
|------|------|
| `pnpm install --silent` | exit 0 |
| `pnpm build`（tsc && vite build） | exit 0（dist/：assets + index.html + sample.md；仅 chunk 体积 warning） |
| `npx vitest run` | 1 file / 3 tests 全绿，exit 0 |
| 渲染断言（root A1 同款 `node scripts/check-render.mjs`） | exit 0，输出 `A1 PASS` |
| `pnpm dev` + `curl http://localhost:5173/` | HTTP 200；页面骨架含 `#app` 容器 + `src="/src/main.ts"` 模块入口（curl 只见空壳，渲染为 JS 运行时行为；与第 1 次口径一致） |
| 渲染链路源码断言 | `src/main.ts` L1 `import { renderMarkdown } from './renderer'`、L17 `await renderMarkdown(markdown)`；`src/renderer.ts` L18 `export async function renderMarkdown(markdown: string): Promise<string>`——与 root spec v2 契约逐字一致（v1 契约不命中即 R4a 现场根因） |
| 集成 report 复核 | head=2be20c8；children（leaf-renderer 2be20c8 / leaf-app 8acc519）均 reachable；7 条验收批次全 pass；contracts.ok=true |

git tracked 37 文件：`src/{main,renderer,renderer.test,styles}`、`index.html`、`package.json`、`pnpm-lock.yaml`、`sample.md` + `public/sample.md`、`scripts/check-render.mjs`、`spec{,-root,-leaf-renderer}.json`、vite/vitest/tsconfig 配置、`.gitignore`、`.cw-spawn/` 派发产物。

**产物完整度观察（不判 fail，如实记录）**：本次 `src/main.ts` 为「fetch sample.md → 渲染到 #app」的自动加载形态，无第 1 次的「打开/关闭」按钮（file-input/close-btn）；brief 功能需求 1/3 的按钮交互未在产物中体现。终验通过标准是机器可判的（验收命令/契约/HTTP），且 7 条机器验收 + 2 轮 reviewer exec-review 均 pass——按钮缺失属产物功能完整度问题，未触发任何机器 gate，属 agent 实现自由度范围内的简化。

## 7. 四次对照

| 指标 | 第 1 次（FAIL） | 第 2 次（FAIL） | 第 3 次（FAIL） | **第 4 次（PASS）** |
|------|------|------|------|------|
| 总时长 | 54.4 分钟（idle 兜底 exit 1） | 16.5 分钟（人工止损 kill；自然形态 = 无限循环） | 45.5 分钟（idle 兜底自然 exit 1） | **45.1 分钟（自然完成 exit 0）** |
| 有效工作期 | 9.3 分钟 | 10.8 分钟 | 41 秒（单 spawn） | **45.1 分钟（全程无空转）** |
| pi spawn | 4（全 exit 0） | 9（全 exit 0） | 1（exit 0） | **10（9 exit 0 + 1 TIMEOUT 重派）** |
| runner 重派 | 0 | 2 | 0 | **1（per-spawn 超时重派）** |
| 账本事件 | 20 | 55（含 31 条集成审计） | 3 | **27（含 3 条集成审计）** |
| 靶子 commit | 4 | 2 | 0 | **6** |
| leaf-renderer 终态 | spec-frozen 死锁（R1） | closed | 从未创建（R5） | **closed** |
| leaf-app 终态 | created 死区（R2） | closed | 从未创建（R5） | **closed** |
| root 终态 | spec-frozen | spec-frozen（集成契约 fail，R4） | spec-frozen（等不存在的子，R5） | **closed（集成 pass + exec-review pass）** |
| 验收机器验证 | 3/9 | 6/9 | 0/9 | **7/7** |
| 靶子产物现场验证 | 全绿 | 全绿 | 不适用（无产物） | **全绿** |
| 判 FAIL/PASS 的卡点层 | 分解树状态机 | 集成层恢复缺失 | 分解结构建立缺位 | **无卡点** |
| 人工干预 | 0 | 1（止损 kill） | 0 | **0** |

四次的演进脉络：R1/R2/R3（分解层 agent 犯错 + 状态机死区）→ R4（集成层恢复路径断裂 + idle 失效）→ R5（分解结构建立依赖 agent 自觉）→ 本次全链闭合。每一轮修复都被下一次终验的真实场景重新打靶：fx-1 的 R2 第四分支在第 2 次触发、fx-2 的 R4a 出口与 fx-3 的 children-first 在本次触发——修复不是「绕过当次症状」，后续同族场景再现时均有现场恢复证据。

## 8. 系统行为正面记录（本次按设计工作的机制）

- **fx-2 R4a 集成恢复出口**：2 次封顶 + 处置任务书（机器判定原文内嵌）+ designer 仲裁 + 计数清零 + 65 秒恢复闭环——本次最关键的首次现场验证
- **fx-3 children-first**：第 0 步任务书 + brief 行双引导下 root designer 39 秒建两子，账本时序 seq2/3 < seq4
- **per-spawn 30 分钟超时 + 重派**：leaf-renderer builder #1 长时间工作（shiki Node 兼容反复试）被超时收口，runner 立即重派 #2 接续，builder #2 在新 spawn 内 7.5 分钟完成 2 轮 verify 自愈——单 agent 卡死不再拖垮全局，且未产生重复副作用（#1 的 build 证据入账后 #2 沿用修复路径）
- **builder 会话内 verify 自愈**：leaf-app 2 轮、leaf-renderer builder #2 2 轮，全部依据 verify fail 文案（no-markers / 用例名不含 id）定位修复，无 marker 约定类死循环（第 1 次 R3 的 3 轮试错未再现）
- **max-concurrency=2 并行**：root designer 与 leaf-renderer designer 交叠、leaf-renderer builder 与后续 reviewer/集成交叠，全程无资源空窗
- **集成验证确定性执行**：干净 checkout + children reachable 检查 + 7 条验收批次重跑 + 契约字节比对，3 轮 report 全落盘可查
- **幂等与一次写入**：root 两版 spec 并存折叠（v1/v2）、build 证据 runId 递增、review verdict 一次写入，`status`/`report`/`tree` 多次读取 md5 一致
- **10/10 spawn 形态稳定**：`pi --model … -p --no-session @briefPath`，stdio 落盘 `.cw-spawn/`，退出码判定（含 TIMEOUT 分类）与 stderr 噪音隔离

## 9. 遗留与观察（不阻塞 PASS）

1. **R1（split 自引用）、R5.1 拒绝分支、R5.3 兜底分支、R4b 独立效果**：四次终验均未真实打靶，有效性以各 fx 验收报告的影子工程红绿为准。建议后续终验（如有）保留为观察项，不作为通过标准。
2. **产物功能完整度 vs 机器验收的边界**：按钮交互缺失但全部机器 gate 通过——「验收写什么、机器查什么」决定了产物保证的下限。若需交互形态保证，应在 spec 验收层增加对应机器断言（canon 层决策，非本终验范畴）。
3. **leaf-renderer builder #1 的 30 分钟超时**：根因是 shiki 异步 API 在 Node 侧的兼容试错（其 3 个 commit 的演进可见）。超时重派机制兜住了，但 30 分钟窗口内的工作（含未提交的中间态）依赖 #2 重新完成——本次 #2 从 #1 的 build 证据与工作区残留接续成功；若 #2 选择推倒重来也无机制阻止重复劳动。属效率观察，非正确性问题。
4. **保留产物**：靶子 `/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`（6 commit + .cw-spawn 全程派发产物，含 R4a 处置任务书原文）；`/tmp/final-gate-4-home`（账本 27 事件 + evidence/ 含 3 份集成 report）；`/tmp/final-gate-4-runner.log`（runner 全程日志）；`/tmp/final-gate-4/bin/cw`（PATH 注入）；`/tmp/final-brief-4.md`（第 4 次 brief）；`/tmp/final-gate-4-designer-brief-v1.md`（root designer 首派任务书导出，git cc65472 版本）。第 1-3 次产物按各自报告仍保留。
