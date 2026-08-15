# 终验报告：markdown-reader 全流程 E2E（真实靶子，无人干预）

- 判定：**FAIL**（runner exit 1，root 未 closed；两个状态机级缺陷导致三 unit 确定性死锁）
- 日期：2026-08-15（日志时间戳为 UTC；本地时区 UTC+8）
- 依据：`development-plan-v2.md` §4
- 环境隔离：`CW_HOME=/tmp/final-gate-home`（保留，账本在
  `/tmp/final-gate-home/__Users__zhushanwen__Code__test-repo__recursive-split-e2e/events.log`）；
  PATH 注入重写版 `cw`（`/tmp/final-gate/bin/cw` → `node <repo>/dist/cli.js`，规避全局旧版 1.6.3）；
  模型 `CW_AGENT_MODEL=xiaomi-token-plan-cn/mimo-v2.5-pro`
- 靶子：`/Users/zhushanwen/Code/test-repo/recursive-split-e2e/`（空 git 仓库起步，产物保留）
- brief：`/tmp/final-brief.md` = `test-brief.md` canon 原文 + 「实施建议」节（拆 2 叶 / root spec 精确模板 / package.json 骨架 / 验收脚本模板 / cw 命令速查 / 机器 gate 硬约束清单）
- 执行命令：
  - `cw create --id md-reader --brief /tmp/final-brief.md`
  - `cw run --root md-reader --spawn pi --poll-ms 3000 --max-idle-ms 2700000 --max-concurrency 2`（stdout/stderr 落盘 `/tmp/final-gate-runner.log`）

## 1. 结论与关键数字

| 指标 | 值 |
|------|-----|
| 总时长（runner 启动 → idle 超时退出） | 17:17:40 → 18:12:00 UTC，约 54.4 分钟 |
| 有效工作期（首个派发 → 末个 agent 退出） | 17:17:40 → 17:26:56 UTC，约 9.3 分钟 |
| pi spawn 次数 | 4（3 designer + 1 builder），全部 exit 0 |
| runner 重派次数 | 0（builder 内部 4 轮 build→verify 自愈发生在同一 spawn 内） |
| 账本事件数 | 20（UnitCreated 3 / SpecSubmitted 5 / VerdictSubmitted 4 / EvidenceSubmitted 4 / VerifyRan 4） |
| 靶子 git commit | 4（全部由被测系统产出） |
| 验收机器验证 | leaf-app 3/3 pass；md-reader 0/3；leaf-renderer 0/3 |
| manual 型验收 | 0（三个 spec 共 9 条验收，manual=0 达成） |
| 人工干预 | 0（观察者角色，未改靶子任何文件、未代跑命令） |

终验四条通过标准逐条判定：

1. runner exit 0 且 root closed → **✗**（exit 1，root 停在 spec-frozen）
2. 全部验收机器验证、manual=0 → **✗**（manual=0 达成；leaf-app 3/3 ✓，root 与 leaf-renderer 因死锁从未进入 build 阶段）
3. 靶子现场验证 → **✓**（详见 §4，install/build/vitest/dev server/渲染断言全绿——产物本身合格，卡住的是流程状态机）
4. 账本可 replay → **✓**（20 事件完整有序，`cw status/report/tree` 投影一致；见 §3）

## 2. 时间线（runner 日志 + 账本，UTC）

```text
17:17:34  seq1   UnitCreated md-reader（人工 cw create）
17:17:40  [runner] 派发 designer → md-reader
17:18:09  seq2   SpecSubmitted md-reader（A1 core e2e-real / A2 unit / A3 e2e-real；split=[leaf-renderer, leaf-app]；契约 C1 signature="export function renderMarkdown(" file=src/renderer.ts）
17:18:16  seq3   VerdictSubmitted md-reader spec-review=pass   → root spec-frozen
17:19:00  seq4   UnitCreated leaf-renderer（designer 依 brief 建叶）
17:19:03  seq5   UnitCreated leaf-app
17:19:42  seq6   SpecSubmitted leaf-renderer（ids=A1/A2/A3，split=[leaf-renderer] ← 抄 root 模板未改，自引用）
17:19:44  seq7   VerdictSubmitted leaf-renderer spec-review=pass → spec-frozen（内部节点分支）
17:20:36  seq8   SpecSubmitted leaf-app（ids=L2/L3/L4，split=[]）
17:20:39  seq9   VerdictSubmitted leaf-app spec-review=pass     → spec-frozen
17:20:39  [runner] 派发 builder → leaf-app（唯一 builder）
17:22:50  seq10  EvidenceSubmitted leaf-app commit=798cea5b runId=leaf-app-001
17:22:58  seq11  VerifyRan fail（covered=[]：marker 格式理解偏差，pi 把 "A<id>" 当 SOH 控制字符）
17:24:20  seq12  EvidenceSubmitted commit=e81a95bc runId=leaf-app-002
17:24:23  seq13  SpecSubmitted ids=L2/L3/L4（builder 重提 spec；此后无人再提交 spec-review）
17:24:31  seq14  VerifyRan fail（covered=[L4]）
17:24:59  seq15  SpecSubmitted ids=L2/L3/L4（再重提）
17:25:10  seq17  VerifyRan fail（covered=[L4]：标记行 "L2 PASS" 折叠 key="AL2" 与验收 id "L2" 不符——id 须 A 开头）
17:26:07  seq18  SpecSubmitted ids=AL2/AL3/AL4（第 3 次重提，id 改 A 前缀）
17:26:13  seq20  VerifyRan pass（covered=[AL2,AL3,AL4]）        → 机器证据链闭合
17:26:56  [runner] builder leaf-app 退出 exit 0
17:26:56–18:12:00  runner 空转（无派发目标），maxIdleMs 兜底触发：
         cw run: root "md-reader" 超过 2700000ms 无账本进展（totalEvents 停在 20）……exit 1
```

leaf-renderer designer（17:19:01 派发）与 leaf-app designer（17:19:33 派发）各一次 spawn、exit 0；builder 只 spawn 1 次，4 轮 build→verify 自愈全部在该 pi 会话内完成。

## 3. 账本 replay（终态投影）

`cw status`：

```text
md-reader  spec-frozen  specs:1 evidences:0 lastVerify:-
leaf-renderer  spec-frozen  specs:1 evidences:0 lastVerify:-
leaf-app  created  specs:4 evidences:4 lastVerify:pass
```

`cw tree`：

```text
md-reader (spec-frozen)
  leaf-renderer (spec-frozen)
  leaf-app (created)
```

`cw report` 要点：leaf-app 的 AL2/AL3/AL4 三条验收 ✓（最后 pass run `verify-3789775a` 覆盖全部）；4 次 verifyRuns 依次 fail/fail/fail/pass，4 条 build 证据 commit 链与靶子 git log 一一对应（798cea5b → e5c00215）。md-reader 与 leaf-renderer 的验收全部 ✗（从未 build）。事件链折叠幂等：`cw status`/`cw report`/`cw tree` 多次读取投影一致。

## 4. 靶子现场验证（runner 退出后执行）

| 检查 | 结果 |
|------|------|
| `pnpm install --silent` | exit 0 |
| `pnpm build`（tsc && vite build） | exit 0（dist/ + dist-site/ 产出；仅 chunk 体积 warning） |
| `npx vitest run` | 2 files / 9 tests 全绿，exit 0 |
| `pnpm dev` + `curl http://localhost:5173/` | HTTP 200；页面骨架含 file-input / close-btn / `#content` 容器 / `main.ts` 模块入口（curl 只见空壳，渲染为 JS 运行时行为） |
| 渲染链路源码断言 | `src/main.ts` L1 `import { renderMarkdown } from './renderer'`、L17 `content.innerHTML = await renderMarkdown(text)`；`src/renderer.ts` markdown-it + shiki `createHighlighter` 惰性单例，含 `export function renderMarkdown(`（root 契约 C1 成立） |
| node 渲染断言（root A1 同款命令） | `node scripts/check-render.mjs` exit 0：h1 / code block / list / link / paragraph 五项 PASS |

git tracked 文件 29 个：`src/{main,renderer,styles}`、`index.html`、`package.json`、`pnpm-lock.yaml`、`sample.md`、`scripts/check-render.mjs`、`spec.json`、`tests/`（2 文件）、vite/vitest/tsconfig 配置、`.gitignore`（node_modules/dist 已忽略）、`.cw-spawn/` 产物（brief + stdout/stderr，被 builder 一并提交）。

## 5. 根因分析（按致命度排序）

### R1（致命）：spec gate 不校验 split 条目 → leaf-renderer 自引用死锁

leaf-renderer designer 抄用 brief 里 root spec 模板，`split=["leaf-renderer"]` 自引用（seq6）。`checkSpecRules` 五规则只查 acceptance/contracts 维度，split 条目的存在性、自引用、与 parentId 树的一致性、叶子 split 应为空——全部无校验，schema 与 gate 双双放行，spec-review（同一 designer 自审）也未拦截。

后果链：`computeDispatchTargets` 把 splitOf 非空的 unit 判为内部节点 → `splitChildrenAllVerified` 等待「split 声明的子 unit」verified → 子 = 它自己，状态 spec-frozen ≠ verified/closed → 永不满足 → 该 unit 永远无派发目标。账本 append-only + verdict 不可改 → 无自然恢复路径。

### R2（致命）：builder 重提 spec 后无 re-review 派发路径 → leaf-app 死区

leaf-app builder 为修 marker 格式先后重提 3 次 spec（seq13/15/18）。`deriveStatus` 语义「重提 spec = 打回重审，旧 pass verdict 不计数」→ 状态回到 `created`（specs>0）。而派发规则三分支均不覆盖 `created + specs.length > 0`：

- designer 仅 `created && specs.length === 0`
- builder 仅 `spec-frozen`
- reviewer 仅 `verified`

loop.ts 注释对这一状态的处理是「等 spec-review 事件；designer 半途退出则空转，由 maxIdleMs 兜底」——但本例中该状态由 **builder** 进入（不是 designer 半途退出），且没有任何 role 会被派去补 spec-review：builder 的 ROLE_TASKS 无「重提 spec 后重新过审」步骤，designer 不再被派。矛盾的是，`cw verify` 失败时的恢复动作文案（verify.ts）明说「修复后重新提交 spec + build 证据并重审，再 cw verify」——builder 照做即落入死区。verify 机器判定本身是 pass 的（seq20），但状态机不认这个 pass（新 spec 未过审，`verified` 判定被跳过）。

### R3（放大器，非直接死因）：e2e-sh marker 的 id 约定对 agent 不醒目

`MARKER_RE = ^A([A-Za-z0-9-]+) (PASS|FAIL)$` 折叠 key 为 `"A" + captured`，要求**验收 id 必须以 A 开头**才能命中（id="L2" 与标记 "L2 PASS" 折叠出的 "AL2" 永不相等）。该约定只在适配器实现里隐含，gate 错误文案（「标记 id 与验收 id 不符——出现 [AL2]，期望 L2」）已给出事实但 pi 仍试错了 3 轮才自行悟出（最终改 id 为 AL2/AL3/AL4 绕开）。另一个理解偏差：pi 曾把 `A<id>` 的 A 当 ASCII SOH 控制字符（commit 9e3f85b 修复）。brief 的 root 模板 id 天然 A 开头（A1/A2/A3）所以 root 无此问题；叶子建议模板未明示「id 必须 A 开头」。

### 缺陷归属与修复方向

| 缺陷 | 归属层 | 修复方向（长期方案） |
|------|--------|----------------------|
| R1 split 无校验 | `src/gates/spec-rules.ts`（+ schema） | 五规则扩第⑥条：split 条目 unitId 须已存在（或声明为待建）、不得自引用、不得引用祖先；叶子（无子声明意图）split 须为空或与 parentId 子集一致 |
| R2 重提 spec 死区 | `src/runner/loop.ts` 派发规则 与 `ROLE_TASKS.builder` | 二选一：派发规则补「created + specs>0 → designer（仅补 spec-review）」；或 builder 任务书加「重提 spec 后必须随即提交 spec-review pass」。前者状态机自洽（不依赖 agent 记性），推荐 |
| R3 marker id 约定 | `src/testrun/e2e-sh.ts` 错误文案 / brief | 适配器 fail 文案直接给出映射规则（「标记折叠 id = A + 标记列文本，验收 id 须以 A 开头或与标记列完全一致」）；或 normalize 掉 A 前缀差（语义变化，需 canon 决策） |

## 6. 系统行为正面记录（判 FAIL 但这些按设计工作）

- 6/6 pi 调用形态稳定：`pi --model <model> -p --no-session @<briefPath>`，stdio 落盘 `.cw-spawn/`，exit code 判定与 stderr 噪音隔离均符合 M1 实测口径
- builder 单 spawn 内 4 轮 build→verify 自愈：verify fail → 修 commit → 重提 build 证据（runId 递增，幂等 gate 正确放行）→ 最终 pass，无人工介入
- verify 干净 checkout 隔离：每轮 verify 在全新 clone 重跑 `pnpm install && build/test`，验收命令自足性经受住 4 轮真实验证
- spec gate 五规则、schema 校验、幂等拒绝、review verdict 一次写入：全部按规格拒绝/放行（root spec 一次过审；leaf-app 3 次重提均过 schema+gate——合法行为，死因在 R2）
- maxIdleMs 兜底：45 分钟无进展 exit 1，stderr 文案含定位指引（.cw-spawn 产物路径、cw status、重跑即续）——按设计触发
- root spec 质量：designer 完全按 brief 模板提交（A1 core e2e-real / A2 unit / A3 e2e-real、契约 C1 精确、split 两叶、manual=0），一次过 schema + 五规则

## 7. 遗留与建议

1. **R1/R2 修复后必须重跑本终验**（同 brief、同靶子策略）：本报告的 FAIL 是流程状态机的 FAIL，不是产物质量的 FAIL——leaf-app 的产物现场验证全绿，说明「agent 写代码 + 机器 verify」链路本身可用，卡点集中在分解树状态机。
2. R3 建议在终验 brief 模板层先行缓解：叶子建议模板直接给 `AL1` 等 A 开头 id 示例（本次 root 模板 A1/A2/A3 即此思路的受益者）。
3. 靶子 `/Users/zhushanwen/Code/test-repo/recursive-split-e2e/` 保留（含 4 commit + .cw-spawn 产物），供人工核查；`/tmp/final-gate-home`（账本+evidence）、`/tmp/final-gate-runner.log`（runner 全程日志）、`/tmp/final-brief.md`（brief 原文）保留至人工核查后可清理。
