# 终验报告（第 2 次）：markdown-reader 全流程 E2E（fx-1 后，真实靶子，无人干预）

- 判定：**FAIL**（runner 被止损 kill，root 未 closed。fx-1 三修复中 R2 现场触发并成功恢复、R3 零试错、R1 未复现；但集成契约阶段暴露新死锁 **R4**：契约 fail 恢复路径断裂 + maxIdleMs 兜底被集成审计事件喂失效）
- 日期：2026-08-16（日志时间戳为 UTC；本地时区 UTC+8）
- 依据：`development-plan-v2.md` §4；fx-1 修复（commit `c699786`，218 测试绿）后同 brief 同口径重跑；第 1 次报告 `docs/rewrite/acceptance/final-gate-report.md`
- 环境隔离：`CW_HOME=/tmp/final-gate-2-home`（保留，账本在
  `/tmp/final-gate-2-home/__Users__zhushanwen__Code__test-repo__recursive-split-e2e/events.log`）；
  PATH 注入重写版 cw（`/tmp/final-gate-2/bin/cw` → `node <repo>/dist/cli.js`，1.6.4）；
  模型 `CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro`
- 靶子：`/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`（空 git 仓库起步，产物保留）
- brief：`/tmp/final-brief-2.md` = 第 1 次 brief 逐字 + 仅实施建议 §6 第 1 条改为 marker 约定全文（与 fx-1 后 `e2e-sh.ts` 的 `MARKER_FORMAT_NOTE` 同口径：`A<验收id> PASS|FAIL`、A 前缀、id 须 A 开头）；`diff` 核实全文仅此一行差异
- 执行命令：`cw create --id md-reader --brief /tmp/final-brief-2.md` → `cw run --root md-reader --spawn pi --poll-ms 3000 --max-idle-ms 2700000 --max-concurrency 2`（stdout/stderr 落盘 `/tmp/final-gate-2-runner.log`）

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 总时长（runner 启动 → 止损 kill） | 18:43:11 → 18:59:43 UTC，约 16.5 分钟 |
| 有效工作期（首个派发 → 末个 agent 退出） | 18:43:11 → 18:53:57 UTC，约 10.8 分钟 |
| 其后纯集成 fail 空转期 | 18:53:01 → 18:59:43 UTC，约 6.7 分钟（31 轮集成重跑） |
| pi spawn 次数 | 9（3 designer 首派 + 2 builder 首派 + 1 builder 重派 + 1 designer 补审 + 2 reviewer），全部 exit 0 |
| runner 状态机重派 | 2（builder→leaf-renderer 第 2 次；designer→leaf-renderer 补审 = fx-1 R2 第四分支） |
| 账本事件数 | 55（UnitCreated 3 / SpecSubmitted 4 / VerdictSubmitted 7 / EvidenceSubmitted 4 / VerifyRan 37——其中 31 条为集成 fail 审计） |
| 靶子 git commit | 2（7790d8e leaf-renderer、9e66ced leaf-app，全部由被测系统产出） |
| 验收机器验证 | leaf-renderer 3/3 pass（closed）；leaf-app 3/3 pass（closed）；root 0/3（集成契约 fail，但集成 report 内 root 验收实跑 3/3 pass） |
| manual 型验收 | 0（三 spec 共 9 条验收全部 e2e-real/unit 型，manual=0 达成） |
| 人工干预 | 0（观察者角色，未改靶子任何文件、未代跑命令）；唯一人工动作 = 止损 kill（见 §4，理由：死锁确定性确认 + idle 兜底失效 + 每轮集成完整重跑 9 条验收烧 CPU 无信息增量；未及 60 分钟止损上限） |

终验四条通过标准逐条判定：

1. runner exit 0 且 root closed → **✗**（runner 被止损 kill；root 停在 spec-frozen，lastVerify=fail）
2. 全部验收机器验证、manual=0 → **✗**（manual=0 达成；两叶 6/6 ✓ closed；root 因集成契约 C1 fail 从未 verified——尽管集成 report 中 root 验收 A1/A2/A3 实跑 3/3 pass）
3. 靶子现场验证 → **✓**（install/build/vitest 7/7/渲染断言 A1 PASS 全绿，见 §6；本产物为纯 tsc 构建、无 vite，第 1 次的 dev server HTTP 检查不适用于本形态，已如实跳过）
4. 账本可 replay → **✓**（55 事件 seq 1-55 连续；`cw status`/`tree`/`report` 多次读取投影 md5 一致；见 §5）

## 2. 时间线（runner 日志 + 账本，UTC）

```text
18:43:11  [runner] 派发 designer → md-reader（人工 cw create seq1 在 18:42:5x）
18:43:56  seq4/5  root spec 提交+过审 → 派发 designer → leaf-renderer（split=[leaf-renderer, leaf-app]，无自引用；契约 C1 signature="export function renderMarkdown(" file=src/renderer.ts）
18:44:09  designer md-reader 退出 → 派发 designer → leaf-app
18:45:01  seq6/7  leaf-renderer spec（AL1/AL2 e2e-real + AL3 unit，split 为空）过审 → 派发 builder → leaf-renderer
18:45:06  seq8/9  leaf-app spec（A1/A2/A3，与 root 同 id 空间）过审 → 派发 builder → leaf-app
18:48:07  seq12/13 leaf-app build + verify pass → 派发 reviewer → leaf-app
18:49:05  seq15  leaf-app exec-review pass → closed（第一个 unit 闭环）
18:49:09  builder leaf-renderer 退出（会话内 3 次 verify fail，均为 AL3）→ 重派 builder → leaf-renderer（#2）
18:52:12  seq19  builder #2 重提 spec（唯一差异：AL3 命令 vitest --reporter=verbose|grep 改为 --reporter=json）
18:52:13  [runner] 派发 designer → leaf-renderer（fx-1 R2 第四分支：created + specs>0 + 末 spec 后无 pass verdict → 补审）
18:52:17  seq20  build-lr-003（commit 9e66ced）
18:52:33  seq21  verify pass（AL1/AL2/AL3 全绿——机器证据链闭合）
18:53:00  seq22  补审 spec-review pass → leaf-renderer verified → 18:53:01 集成验证首跑
18:53:01  seq24  集成 fail：契约 C1 未命中（见 §4）
18:53:14  seq23  补审 designer 第二条 spec-review pass 后退出
18:53:23  派发 reviewer → leaf-renderer（verified 分支）
18:53:57  seq28  leaf-renderer exec-review pass（comment 明确认可 "(string) => Promise<string>" 接口）→ closed
18:53:01–18:59:43  runner 每轮 poll 重跑集成（约 10 秒/轮，共 31 轮），每轮 9 条验收全 pass + 契约 C1 fail，
          VerifyRan fail 审计事件持续入账（seq24→55），无任何 agent 派发目标（两叶均 closed）；
          18:59:43 观察者止损 kill（maxIdleMs 45 分钟永不触发，原因见 R4b）
```

## 3. fx-1 三修复现场验证（本次核心观察项）

### R2（重提 spec 派发真空）：现场触发，修复有效 ✓

完整复现第 1 次的触发场景并成功恢复：

- 触发：leaf-renderer builder 第 2 会话内 4 次 verify fail（根因 AL3 的 vitest JSON parse，与 marker 无关）后，于 18:52:12 重提 spec（seq19，合法路径——验收命令本身有错需修）。此时状态 = created + specs>0 + 末 spec 后无 pass verdict，第 1 次在此死区（45 分钟空转 idle exit 1）。
- 恢复：runner 在 **1 秒内**（18:52:13）派 designer 携补审 brief（落盘 `.cw-spawn/leaf-renderer.designer.brief.md`；fx-1 验收确认该任务书不含「撰写 spec」指令）；18:53:00 补审 pass（seq22）→ 状态跃迁 verified（seq20 build + seq21 verify pass 已在账）→ 18:53:23 派 reviewer → 18:53:57 closed。从重提 spec 到 closed 全程 105 秒。
- 对照第 1 次同场景：死锁 45 分钟 + idle 兜底 exit 1 + unit 永停 created。
- 附带验证：verify 失败恢复新文案（fx-1 R2.1）在场——builder 收到的是「修代码 + 重提 build 证据，spec 冻结不动；改验收走重新 spec 是另一路径需重新过审」，builder 选择了后者（命令确实要改），第四分支接住。

### R3（marker 格式约定）：未复现，零试错 ✓

- leaf-renderer designer 首版 spec 即用 A 开头 id（AL1/AL2/AL3），e2e 命令自带 `AL1 PASS`/`AL2 PASS` 标记行。
- 5 次 verify 中 AL1/AL2 标记行每轮全命中（`evidence/leaf-renderer/verify-*/AL1.stdout` 逐轮核实）；4 次 fail 的根因全部是 AL3 的 vitest JSON parse（spec 首版命令 `vitest --reporter=verbose 2>&1 | grep -E ...` 的管道破坏 JSON 输出），与 marker 无关。
- 对照第 1 次：builder 对 marker 约定试错 3 轮（SOH 控制字符误解 / L 前缀 id 不命中）。本次 brief marker 行（与系统 `MARKER_FORMAT_NOTE` 同口径）+ 系统错误文案双保险下零试错。无法严格归因是 brief 行还是系统文案起效（agent 未踩坑故错误文案未被触发），但 R3 修复目标（约定醒目化）达成。

### R1（split 自引用三防线）：未复现（未被打靶，非拦截实证）

- leaf-renderer designer 本次提交的 spec split 为空（叶子语义正确），账本无任何自引用提交痕迹（被拒提交不入账本；agent stdout 亦无规则⑥拦截记录）。
- 结论：R1 缺陷未复现；三防线（规则⑥ / 叶子 split 拒 / loop 防御）未被现场打靶，效果=未观察到，以 fx-1 验收报告的影子工程红绿为准。

## 4. R4（本次 FAIL 根因）：集成契约 fail 死锁 + idle 兜底失效

### 现象

两叶 closed、root spec-frozen 停终态；runner 每 ~10 秒重跑一轮集成（干净 checkout、可达性检查、9 条验收全 pass、契约比对 C1 fail），fail VerifyRan 审计事件每轮 +1，永不停止、永不超时、无 agent 派发。

### R4a：契约 fail 的恢复路径在状态机中不存在

- 契约事实：root spec 契约 C1 `signature="export function renderMarkdown("`（brief 模板原文，designer 照抄）；leaf-renderer builder 实现为 `export async function renderMarkdown(`（`src/renderer.ts` L136；shiki highlighter 异步初始化使 async 是自然写法，第 1 次 builder 恰好写了非 async 版故契约成立）。async 插在 export 与 function 之间，字节级包含比对不命中。
- 集成时序：集成在「split 子全 verified」后触发（u8 派发时机）；leaf-renderer verified（18:53:00）→ 集成首跑 fail（18:53:01）与 reviewer 派发（18:53:23）并发；reviewer 只审 unit 自身（其 comment 认可 async 接口签名），exec-review pass → closed（18:53:57）。
- 断裂点：集成 fail 的恢复文案给出两条路径——「让 provider 在 src/renderer.ts 落实签名后重新提交 build/verify」（provider 已 closed，closed 无任何派发分支，builder 仅派 spec-frozen）与「改契约走重新 spec 冻结 + review」（root 是 spec-frozen，designer 仅派 created 形态，root 的集成 VerifyRan fail 不改变其派生状态）。两条路径均无派发出口，root 与 provider 同时无目标 → 死锁。
- 深层结构：契约比对只发生在集成时点（子树收口后），而 provider 的关闭（exec-review）与集成的失败在时间上交叠，先关门的 unit 无法再为契约返工。

### R4b：maxIdleMs 兜底被集成审计事件喂失效

`src/runner/loop.ts` L662-671：idle 判定基准是 totalEvents 是否推进，「任一账本事件推进即视为有进展」。集成 fail 明确设计为「写 fail VerifyRan 留审计，下轮重派重试」（L381）→ 每 poll 轮（3 秒）集成都产生新事件 → lastProgressAt 持续刷新 → 45 分钟 maxIdleMs **永不触发**。后果：死锁从「45 分钟后 exit 1 的有界空转」恶化为「无限循环烧 CPU」（每轮完整重跑 9 条验收 = clone + pnpm install + build + test，本次实测约 10 秒/轮，31 轮写入 31 个 integrate-report 目录）。

### 缺陷归属与修复方向（长期方案）

| 缺陷 | 归属层 | 修复方向 |
|------|--------|----------|
| R4a 契约 fail 无恢复派发 | `src/runner/loop.ts` 派发规则 + 集成/审查时序 | 任选其一或组合：(1) 集成 fail 时冻结 provider 的 exec-review 派发（reviewer 必须看到集成状态再放行关闭）；(2) 集成契约比对前置到 provider verify 时点（叶子 verify 即校验所属契约，fail 早、修复窗口仍在 spec-frozen）；(3) 给 closed provider 增加契约修复重开路径（语义变化，需 canon 决策） |
| R4b idle 被审计事件喂活 | `src/runner/loop.ts` 进展判定 | idle 判定排除「集成重试产生的 VerifyRan」（按 unitId+kind 过滤）；或集成连续 fail N 次后停止自动重试、显式 fail-fast exit（带定位指引），与「gate 熔断不阻断」哲学对齐需 canon 决策 |
| 契约签名字节匹配对 async 变体零容忍 | 产品语义（u8 锁定），非 bug | 字节级包含比对本身按规格工作；可考虑在 spec gate 或 brief 模板层提示契约签名字符串的书写约束（如建议写 `renderMarkdown(` 核心片段而非含修饰关键字的完整声明），属 canon 层优化项 |

## 5. 账本 replay（终态投影）

`cw status` / `cw tree`：

```text
md-reader  spec-frozen  specs:1 evidences:0 lastVerify:fail
leaf-renderer  closed  specs:2 evidences:3 lastVerify:pass
leaf-app  closed  specs:1 evidences:1 lastVerify:pass

md-reader (spec-frozen)
  leaf-renderer (closed)
  leaf-app (closed)
```

- 55 事件 seq 1-55 连续无断（脚本核验）；`cw status` 两次读取投影 md5 一致（8ecd2f2f…），折叠幂等。
- `cw report`：leaf-renderer 两版 spec（验收 id 相同，AL3 命令 vitest reporter 修正）、3 条 build 证据（7790d8e → 9e66ced）、5 次 verify（fail×4 → pass×1）、2 条 spec-review pass + 1 条 exec-review pass；leaf-app 1/1/1/pass 全链；root 仅 1 spec + 31 条集成 fail VerifyRan。
- leaf-app 的验收 id（A1/A2/A3）与 root 同空间——cw 按 unit 折叠验收，无冲突。

## 6. 靶子现场验证（runner 退出后执行）

| 检查 | 结果 |
|------|------|
| `pnpm install --silent` | exit 0 |
| `pnpm build`（纯 `tsc`，builder 自选形态；无 vite） | exit 0（dist/ 产出 renderer.js/main.js/测试与 .d.ts） |
| `npx vitest run` | 2 files / 7 tests 全绿，exit 0 |
| 渲染断言（root A1 同款 `node scripts/check-render.mjs`） | exit 0，输出 `A1 PASS` |
| 渲染链路源码断言 | `src/main.ts` L1 `import { renderMarkdown } from './renderer.js'`、L19 `await renderMarkdown(currentContent)`；`src/renderer.ts` L136 `export async function renderMarkdown(markdown: string): Promise<string>`——**功能契约成立（import+调用），字节契约不成立（async 使 C1 签名串不命中，即 R4a 根因现场）** |
| dev server HTTP | 不适用（本产物无 vite/dev script；root spec 验收亦不含此项） |

git tracked 产物：`src/{main,renderer,main.test,renderer.test,styles}`、`index.html`、`package.json`、`pnpm-lock.yaml`、`sample.md`、`scripts/check-render.mjs`、`spec.json` ×2、`.cw-spawn/`、`.gitignore`。

## 7. 与第 1 次对照

| 指标 | 第 1 次（FAIL） | 第 2 次（FAIL） |
|------|------|------|
| 总时长 | 54.4 分钟（idle 兜底 exit 1） | 16.5 分钟（止损 kill；自然形态 = 无限循环） |
| 有效工作期 | 9.3 分钟 | 10.8 分钟（多完成 2 个 reviewer + 1 补审） |
| pi spawn | 4 | 9（全部 exit 0） |
| runner 重派 | 0 | 2（builder #2 + designer 补审） |
| 账本事件 | 20 | 55（含 31 条集成审计） |
| leaf-renderer 终态 | spec-frozen 死锁（R1） | **closed**（R1 未复现） |
| leaf-app 终态 | created 死区（R2） | **closed**（R2 复现场景被第四分支成功恢复） |
| root 终态 | spec-frozen（等自引用子树） | spec-frozen（集成契约 fail，R4） |
| 靶子 commit | 4 | 2 |
| 靶子产物现场验证 | 全绿 | 全绿 |
| 判 FAIL 的卡点层 | 分解树状态机（spec/split 层） | 集成层（契约比对 + 恢复派发 + idle 判定） |

结论：fx-1 把死锁从「分解层」推到了「集成层」——两叶首次全部走到 closed，机器证据链全部闭合；卡点由 agent 犯错（R1 抄模板/R3 marker 误解）转为系统自身恢复机制缺失（R4）。R4 在第 1 次未被观察到仅因 R1 拦在更早阶段。

## 8. 系统行为正面记录（判 FAIL 但这些按设计工作）

- fx-1 R2 第四分支：真实触发、1 秒内派发、补审 brief 无重写指令、恢复全程 105 秒（对照第 1 次 45 分钟死锁）
- builder 两会话内 5 轮 verify 自愈（含 1 次 spec 重提决策）：verify fail 文案可操作（JSON parse 错误直接指出 `--reporter=json` 修复方向），builder 按指引修正后一次通过
- verify 干净 checkout 隔离：每轮全新 clone 重跑，验收命令自足性经受 5+31 轮真实验证；集成 report 结构完整（head/children reachable/9 acceptance/contracts）
- 集成验证的确定性执行：不派 agent、同步完成、fail 留审计、report 落盘可查——除 R4b 的 idle 交互外机制本身按设计
- 6/9 spawn 形态稳定（`pi --model … -p --no-session @brief`），stdio 落盘 `.cw-spawn/`，退出码判定与 stderr 噪音隔离
- spec gate/schema/幂等拒绝/契约冻结语义全部按规格工作；reviewer 的 exec-review 质量合格（comment 含接口语义判断）

## 9. 遗留与建议

1. **R4a/R4b 修复后须第 3 次重跑本终验**（同 brief、同靶子策略）。R4b（idle 失效）为最高优先级——它把一切未预期终态从「有界空转」恶化为「无限烧 CPU」，且与 R4a 独立存在（任何集成 fail 都会触发，即便 R4a 修复后仍有其他 fail 可能）。
2. R2 第四分支已现场验证有效；R1 三防线未被真实打靶，建议第 3 次终验保留观察项（不作通过标准）。
3. brief 模板（canon 层）可考虑：契约 signature 建议写不含修饰关键字的核心片段（如 `function renderMarkdown(`），降低 async/非 async 合法变体的字节匹配脆弱性——产品语义决策，非必改。
4. 保留产物：靶子 `/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`（2 commit + .cw-spawn）；`/tmp/final-gate-2-home`（账本 55 事件 + evidence）；`/tmp/final-gate-2-runner.log`；`/tmp/final-brief-2.md`。第 1 次的 `/tmp/final-gate-home` 等产物仍保留（该次报告 §7）。
