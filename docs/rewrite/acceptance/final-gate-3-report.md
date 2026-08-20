# 终验报告（第 3 次）：markdown-reader 全流程 E2E（fx-2 后，真实靶子，无人干预）

- 判定：**FAIL**（runner idle 兜底 exit 1，root 未 closed。流程死在**分解结构建立阶段**：root designer 单 spawn 完成 root spec+review 后，未执行 brief 实施建议的建子步骤——split 声明的两个叶子 unit 从未创建，派发规则对此无任何出口 → 空转 45 分钟。**R4 场景未再现（未触达集成层），fx-2 两修复（R4a 恢复出口 / R4b idle 上限）均无现场验证机会**）
- 新缺陷编号：**R5**（split 声明的子 unit 未创建时，gate 放行 + 派发真空 + 任务书不含建子职责，三层同时缺位）
- 日期：2026-08-16（日志时间戳为 UTC；本地时区 UTC+8）
- 依据：`development-plan-v2.md` §4；fx-2 修复（commit `4a3c7fd`，222 测试绿）后同 brief 同口径重跑；前序报告 `final-gate-report.md`（第 1 次）、`final-gate-2-report.md`（第 2 次）
- 环境隔离：`CW_HOME=/tmp/final-gate-3-home`（保留，账本在
  `/tmp/final-gate-3-home/__Users__zhushanwen__Code__test-repo__recursive-split-e2e/events.log`）；
  PATH 注入重写版 cw（`/tmp/final-gate-3/bin/cw` → `node <repo>/dist/cli.js`，规避全局旧版 1.6.3；构建后 `dist/runner/loop.js` 含 fx-2 标识 `INTEGRATION_MAX_CONSECUTIVE_FAILS` ×5 已核）；
  模型 `CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro`
- 靶子：`/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`（空 git 仓库起步，产物保留）
- brief：`/tmp/final-brief-2.md`（与第 2 次逐字相同，直接复用，保证可比性）
- 执行命令：`cw create --id md-reader --brief /tmp/final-brief-2.md` → `cw run --root md-reader --spawn pi --poll-ms 3000 --max-idle-ms 2700000 --max-concurrency 2`（stdout/stderr 落盘 `/tmp/final-gate-3-runner.log`）
- 人工干预：**0**（连止损 kill 都不需要——本次 idle 兜底自身有效，自然触发 exit 1；对照第 2 次需人工 kill）

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 总时长（runner 启动 → idle 兜底 exit 1） | 19:35:37 → 20:21:06 UTC，约 45.5 分钟 |
| 有效工作期（唯一 spawn 的起止） | 19:35:37 → 19:36:18 UTC，约 41 秒 |
| 其后空转期 | 19:36:18 → 20:21:06 UTC，约 44.8 分钟（零派发、零事件、近零 CPU：运行 25 分钟时 CPU 时间累计 0.98 秒） |
| pi spawn 次数 | 1（designer → md-reader），exit 0 |
| runner 状态机重派 | 0 |
| 账本事件数 | 3（UnitCreated 1 / SpecSubmitted 1 / VerdictSubmitted 1） |
| 靶子 git commit | 0（`spec-root.json` 与 `.cw-spawn/` 均为 untracked） |
| 验收机器验证 | 0/9（无任何 unit 进入 build；root 3 条 ✗，两个叶子从未存在） |
| manual 型验收 | 0（root spec 三条验收 A1 e2e-real / A2 unit / A3 e2e-real，manual=0 达成——但因流程未走远而无意义） |

终验四条通过标准逐条判定：

1. runner exit 0 且 root closed → **✗**（exit 1，root 停在 spec-frozen）
2. 全部验收机器验证、manual=0 → **✗**（manual=0 达成；0/9 验收执行——分解树只有 root 一个节点）
3. 靶子现场验证 → **✗（不适用）**：靶子无产物（0 commit、无 `src/`、无 `package.json`）；install/build/vitest/渲染断言/dev server 检查对象不存在，如实记不适用而非执行无意义命令
4. 账本可 replay → **✓**（3 事件 seq 1-3 连续；`cw status`/`report` 两次读取投影 md5 一致，见 §4）

## 2. 时间线（runner 日志 + 账本，UTC）

```text
19:35:32  seq1   UnitCreated md-reader（人工 cw create）
19:35:37  [runner] 派发 designer → md-reader（首派分支：created && specs===0）
19:35:57  seq2   SpecSubmitted md-reader（A1 core e2e-real / A2 unit / A3 e2e-real；
          契约 C1 signature="export function renderMarkdown(" file=src/renderer.ts；
          split=[leaf-renderer, leaf-app]——两个子 unitId 此时均不存在，gate 放行）
19:35:59  seq3   VerdictSubmitted md-reader spec-review=pass → root spec-frozen
19:36:18  [runner] designer 退出 exit 0。
          stdout 末尾原文（关键证据）：
          「**下一步（按任务书 §2）**：任务书建议 designer 还需为两个叶子 unit 创建
          brief 文件并 cw create：…… **需要继续创建叶子 unit 吗？**」
          ——pi 在 print 模式（-p 非交互）下把 brief 实施建议的建子步骤当作
          需询问用户的决策点，做完 ROLE_TASKS 的 3 步（spec + review，完成标志
          「unit 进入 spec-frozen」已达成）即停问退出，未执行建子。
19:36:18–20:21:06  runner 空转：subtree（按账本 parentId BFS）只含 root；
          root 是 spec-frozen 内部节点（split 非空），派发条件要求
          splitChildrenAllVerified——split 声明的子不存在 = 永不满足；
          无任何分支覆盖「split 子未建」（不派 designer 建子、不告警）；
          账本 totalEvents 停在 3，maxIdleMs=45 分钟自然触发：
          「cw run: root "md-reader" 超过 2700000ms 无账本进展（totalEvents 停在 3，
          被派发 agent 未产出任何事件）。恢复动作：查看 <workdir>/.cw-spawn/ 下各
          agent 的 stdout/stderr 定位卡点，或 cw status 查看现状；排除故障后重新
          运行 cw run --root md-reader 继续（账本即状态，重跑即续）。」exit 1
```

## 3. R5（本次 FAIL 根因）：split 声明的子 unit 未创建——三层同时缺位

### 触发：agent 行为随机性

三次终验使用**逐字相同的 brief**，root designer 均为同模型（mimo-v2.5-pro）同任务书首派：

- 第 1 次（17:19:00/17:19:03）：designer 自觉 `cw create` 两叶后退出；
- 第 2 次（18:43:56 前）：同上，两叶均已建；
- 第 3 次：designer 完成 ROLE_TASKS 的 3 步即停，stdout 末尾向（不存在的）用户提问「需要继续创建叶子 unit 吗？」后退出。

差异不在系统（三次代码不同但派发/任务书对 root designer 首派完全同构），在 pi 的非确定行为：brief 实施建议 §2 的措辞是「任务书**建议** designer 还需……创建」（brief 原文「1. 先为两个叶子各写一份 brief 文件（**建议**放 `.cw-spawn/…`）2. 创建子 unit（**先 create 后提交 root spec，否则 runner 永远等不到子节点**）」）。brief 作者知道这个陷阱并写进了警告文字，但 print 模式下 agent 对「建议」性指令选择停下来问。前两次的「通过」依赖 agent 自觉，不是机制保证。

### 缺位层 1：spec gate 不校验 split 条目存在性

`src/gates/spec-rules.ts` 规则⑥（fx-1 R1）只拒**自引用**（`entry.unitId === spec.unitId`），不查 split 条目的 unitId 是否已存在于账本。本次 seq2 的 split 声明了两个不存在的 unitId，schema 与五+一规则全部放行，spec-review（同一 designer 自审）亦未拦截——与第 1 次 R1 的形态对偶：R1 是「子声明了自己」，R5 是「声明的子不存在」，都属「split 声明与 unit 树的一致性无机器保障」。

### 缺位层 2：派发规则对「split 子未建」无出口

`src/runner/loop.ts` `computeDispatchTargets`：`subtreeUnits` 按账本 parentId BFS，只含已创建 unit；root 走 `spec-frozen` 内部节点分支，其唯一派发条件是 `splitChildrenAllVerified`（split 口径下未创建 = 未 verified = 等待）。两叶子不在 subtree 内，不存在「created && specs===0」的 designer 首派目标。净效果：**全树零派发目标**，且 loop 无告警（fx-1 R1 对自引用至少会记 stderr 警告，「子未建」连警告都没有）。fx-1 R2 第四分支（created+specs>0 补审）、fx-2 R4a 上限出口（集成 fail 计数）均不触达此状态。

### 缺位层 3：系统任务书不承载建子职责

`ROLE_TASKS.designer` 的 3 步止于「spec-review 提交」，完成标志「unit 进入 spec-frozen」——designer **按系统任务书已完成**（本次它确实做完了全部 3 步）。建子要求只存在于 brief 实施建议文字里，`renderBrief` 拼装的派发任务书从未提及「split 声明了子就须建子」。系统的派发机制与 brief 的流程约定职责不对齐：runner 等 split 子 verified，却没有任何机制保证子被创建。

### 后果与恢复路径

账本 append-only + spec-review verdict 不可改 → root 停 spec-frozen 无自然恢复路径（除非外部人工 `cw create` 两叶后重跑 `cw run`——idle 兜底文案的「重跑即续」对本场景有效，前提是人工先补建子）。本次空转 44.8 分钟后被 maxIdleMs 兜底 exit 1，有界、可恢复、文案可操作（指向 `.cw-spawn/` stdout 定位卡点）。

### 缺陷归属与修复方向（长期方案）

| 缺位 | 归属层 | 修复方向 |
|------|--------|----------|
| gate 放行不存在的 split 条目 | `src/gates/spec-rules.ts` 规则⑥ + schema | **推荐（长期方案）**：规则⑥扩展——SpecSubmitted 时 split 条目 unitId 必须已存在于账本且 parentId 指向本 unit（把 brief 文字约定「先 create 后提交 root spec」升级为机器 gate）。提交被拒时错误文案给出建子命令模板，designer 在同一 spawn 内建子后重提，闭环不依赖 runner 改动。错误最早暴露（提交时点）、修复窗口仍在 spawn 内 |
| 派发真空无出口、无告警 | `src/runner/loop.ts` 派发规则 | 备选：spec-frozen 内部节点 + split 子未建 → 派 designer 携「建子」任务书（brief 文件由 designer 裁剪——与 fx-2 R4a 上限出口同构）。作为 gate 前置的纵深第二道防线可同时做；单独做则错误暴露晚（spec 已冻结后才发现） |
| 任务书不含建子职责 | `src/runner/loop.ts` `ROLE_TASKS` / brief canon | 配套：designer 任务书对 split 非空的 unit 增加步骤「为 split 每个条目 `cw create --id <unitId> --parent <本unit> --brief <叶子brief>`（若尚未存在）」，措辞指令化（不用「建议」） |

## 4. 账本 replay（终态投影）

`cw status` / `cw tree` / `cw report`：

```text
md-reader  spec-frozen  specs:1 evidences:0 lastVerify:-

md-reader (spec-frozen)

unit: md-reader (spec-frozen)
  spec: 2113ab79ad82
  acceptance:
    A1 e2e-real [core] ✗
    A2 unit ✗
    A3 e2e-real ✗
  evidences: (无)
  verifyRuns: (无)
```

- 3 事件 seq 1-3 连续；`cw status` 两次读取 md5 一致（`0a72435f…`）、`cw report` 两次一致（`64e0b4d1…`），折叠幂等。
- `spec-root.json`（designer 落盘于靶子根目录，untracked）与账本 seq2 payload 的 specHash 对应，内容与 brief 模板逐字一致（A1/A2/A3、C1 契约、split 两叶）——与第 2 次的 root spec 同构，可比性成立。

## 5. 观察重点判定：R4 再现与 fx-2 现场验证（本次核心观察项，结论=未触达）

任务书要求观察「R4 场景是否再现（契约签名 async 类漂移）及 fx-2 的恢复出口是否现场工作（若再现：应见 2 次集成 fail → designer 漂移处置 → 恢复）」。结论：

- **R4 未再现——因为未触达**：R4 发生在集成层（split 子全 verified 后的契约比对），本次两个叶子从未创建，集成验证从未运行，账本零 VerifyRan。不存在「契约签名漂移」的舞台。
- **fx-2 R4a 恢复出口（集成连续 fail 达 2 次 → 停自动重派 → 派 designer 处置契约漂移）：零现场验证**。修复代码确认在运行的 dist 内（`INTEGRATION_MAX_CONSECUTIVE_FAILS` 在 `dist/runner/loop.js` 出现 5 处），但其触发条件（integrate- 前缀的 fail VerifyRan 连续 2 次）本次不可能满足。fx-2 的有效性以其实验收报告的影子工程红绿为准（fx-2-report.md，4/4 回归红→绿），终验现场仍未证实也未证伪。
- **fx-2 R4b（idle 兜底被审计事件喂失效）：同样未直接验证，但 idle 兜底本身现场工作正常**。本次空转的成因不是「集成上限切断事件流」，而是「根本无事件」——即便在 fx-2 之前的代码上也会同样触发 idle 兜底。可记录的正面观察：45.5 分钟有界退出、exit 1、空转期近零 CPU（对照第 2 次 idle 失效形态：每 ~10 秒一轮完整 clone+install+build 集成重跑、31 轮烧 CPU、45 分钟兜底永不触发）、退出文案含三段恢复动作——「有界空转 + 可恢复」语义现场成立。
- root spec 契约 C1 仍为 `export function renderMarkdown(`（designer 照抄 brief 模板，与第 1、2 次相同）。若 R5 修复后第 4 次重跑走到集成层且 leaf-renderer 再写 async 变体，R4a 场景大概率复现——届时才是 fx-2 恢复出口的真实考验。

## 6. 三次对照

| 指标 | 第 1 次（FAIL） | 第 2 次（FAIL） | 第 3 次（FAIL） |
|------|------|------|------|
| 总时长 | 54.4 分钟（idle 兜底 exit 1） | 16.5 分钟（人工止损 kill；自然形态 = 无限循环） | 45.5 分钟（idle 兜底自然 exit 1） |
| 有效工作期 | 9.3 分钟 | 10.8 分钟 | 41 秒（单 spawn） |
| 空转期形态 | 45 分钟空转（无派发目标） | 6.7 分钟集成重跑烧 CPU（31 轮） | 44.8 分钟空转（零派发、近零 CPU） |
| pi spawn | 4（全 exit 0） | 9（全 exit 0） | 1（exit 0） |
| runner 重派 | 0 | 2 | 0 |
| 账本事件 | 20 | 55（含 31 条集成审计） | 3 |
| 靶子 commit | 4 | 2 | 0 |
| leaf-renderer 终态 | spec-frozen 死锁（R1 自引用） | **closed** | **从未创建**（R5） |
| leaf-app 终态 | created 死区（R2 重提真空） | **closed** | **从未创建**（R5） |
| root 终态 | spec-frozen | spec-frozen（集成契约 fail，R4） | spec-frozen（等不存在的子，R5） |
| 靶子产物现场验证 | 全绿 | 全绿 | 不适用（无产物） |
| 判 FAIL 的卡点层 | 分解树状态机（spec/split 层） | 集成层（契约比对 + 恢复派发 + idle 判定） | 分解结构建立（split 子未建，三层缺位） |
| 人工干预 | 0 | 1（止损 kill） | 0 |

三次 FAIL 的卡点呈「漏斗回退」形态：第 1 次死在两叶的 spec 阶段（R1/R2/R3）；第 2 次两叶首次全部 closed、死在集成收口（R4）；第 3 次死在最上游——分解结构本身未建立（R5，root designer 未建子）。R5 从第 1 天起就存在（三次代码的派发规则均无此分支），前两次未暴露纯靠 agent 自觉建子。**修复顺序上 R5 不受 fx-1/fx-2 影响，也不影响它们——它是一个独立的、更上游的健壮性缺口。**

## 7. 系统行为正面记录（判 FAIL 但这些按设计工作）

- maxIdleMs 兜底：45 分钟无账本进展自然触发 exit 1，stderr 文案三段恢复动作（`.cw-spawn/` stdout 定位 / `cw status` 现状 / `cw run` 重跑即续）——可操作闭环，与第 1 次（有事件后空转）口径一致
- 空转成本：44.8 分钟空转 CPU 累计约 1 秒级（3 秒 poll 空转）——对照第 2 次 idle 失效时的无限集成重跑，「有界空转」的资源形态现场成立
- root spec 质量与门禁：designer 完全按 brief 模板提交（A1/A2/A3 机器型 manual=0、契约 C1 精确、split 两叶含依赖声明），一次过 schema+gate；spec-review/状态跃迁 spec-frozen 均按规格
- pi spawn 形态稳定：`pi --model <model> -p --no-session @<briefPath>`，stdio 落盘 `.cw-spawn/`，exit code 判定正常（1/1 exit 0）
- 账本 replay：3 事件投影幂等（status/report 多次读取 md5 一致），`cw create` 人工入口正常
- 环境隔离：CW_HOME 独立目录、PATH 注入重写版 cw、agent 侧子命令走重写版——三次口径一致，无串扰

## 8. 遗留与建议

1. **R5 修复后须第 4 次重跑本终验**（同 brief、同靶子策略）。推荐修复组合：gate 层「split 条目存在性」校验（§3 表，长期方案，错误最早暴露）+ designer 任务书建子步骤指令化（配套）。fx-2 的 R4a/R4b 现场验证欠账一并结转第 4 次——R5 修复后流程才能走到集成层，fx-2 恢复出口才有被触达的机会。
2. brief（canon 层）措辞：实施建议中流程关键步骤（建子）避免「建议」措辞，且已由 brief 原文承担了一半警告职责（「先 create 后提交 root spec，否则 runner 永远等不到子节点」）——该警告本次被 agent 读到但未执行，证明文字约定对 print 模式 agent 不充分，机器 gate 不可省。
3. 保留产物：靶子 `/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`（0 commit + `spec-root.json` + `.cw-spawn/` 含 designer stdout 提问原文——R5 关键证据）；`/tmp/final-gate-3-home`（账本 3 事件）；`/tmp/final-gate-3-runner.log`；`/tmp/final-gate-3/bin/cw`（PATH 注入）；`/tmp/final-brief-2.md`（三次共用 brief）。第 1、2 次产物按各自报告 §7/§9 仍保留。
