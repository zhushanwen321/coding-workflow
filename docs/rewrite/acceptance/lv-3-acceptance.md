# lv-3 验收标准：e2e-sh 崩溃形态改道契约失败 + spec-review 历史注入与代数中间档

> 设计依据：`M6 自治运行活性与契约防护设计`（`.tmp/design-autonomy-liveness.md`）§3.3 D4/D5 / §4 S3/S4 / §5 波次 lv-3。
> **builder 与 verifier 禁止修改本文件**（防篡改锚点，基线已先行入 git）。
> 前置：lv-2 已合入（escalations.ts 的 announceManualEscalations 已扩 buildDrift 参数——本波在其交付后的实态签名上追加，实施时先读该函数当前态对齐参数序与注释风格）。

## 1. 目标

两个正交补强（回溯 G2/G3）：

1. **契约路由**（D4）：e2e-sh 适配器「零标记行 + exitCode≠0」从 no-markers fail（测试红 → fix 循环 / flake 通道）改道**解析失败抛错**（→ specContractBroken 回炉 designer 修 spec）——脚本崩溃/环境断链（u6 A12/A13 实证形态：exit 1 无标记）不再混入「随机性 or 真 bug」的错误二选一；「有 FAIL 标记的真测试红」分类不变。依据 = 同适配器内「有标记但 id 不符」早已走解析失败（`e2e-sh.ts:89-96`），本改是把最后一个异类分支对齐到同族通道。
2. **收敛辅助**（D5）：reviewer 任务书注入「审查上下文」段（当前代数 + 最近 3 代 fail comment 摘要 + 不重打回指引，复用 `specReviewFailComments`）；打回代数 ≥3 起逐代一声中间档 stderr 提示（不进停派 map、不改变行为）。

## 2. 交付物（文件级）

| 文件 | 变更 |
|------|------|
| `src/testrun/e2e-sh.ts` | `markers.size === 0` 分支：exitCode≠0 改抛错（仅此分支；exitCode=0 抛错不变；「有标记 id 不符」分支不动）+ 模块头防伪造语义注释同步 |
| `docs/rewrite/acceptance/u5-acceptance.md` | 规格锁定段两处同步（parse 语义行 + 验收条目 6）——**强制连带**（D4 明示，否则实现与锁定基线漂移） |
| `tests/`（既有，扫描定位） | no-markers + exit≠0 形态的既有断言同波次更新（§5 授权条款，逐处列入汇报） |
| `src/runner/brief.ts` | ① `specReviewReviewerTasks` 头部「审查上下文」段（签名加历史参数）② 第五维文案点名路径逃逸兜底句 |
| `src/runner/loop.ts` | `writeBriefFile` 调用处传历史（`specReviewFailComments(events, unitId)`）+ dedup 构造处加 `specProgress` 字段 |
| `src/runner/escalations.ts` | 中间档出声（代数 ≥3 且 < 预算逐代一声，dedup 完整文本比较）+ 阈值常量 |
| `CONTEXT.md` | 「解析失败」相关词条若含 no-markers 旧语义则同步（全文搜 `no-markers` 定位） |
| `tests/lv3-e2e-contract-route.test.ts` | 新增（E 系） |
| `tests/lv3-review-context.test.ts` | 新增（R 系） |

## 3. 禁改清单（违反 = FAIL）

- `src/` 其余文件（尤其 `src/gates/spec-rules.ts`、`src/readonly/frontier.ts`、`src/handlers/`——已验收领地；发现缺陷上报不擅改）
- `docs/rewrite/acceptance/` 其余基线、`docs/rewrite/ledger.md`
- `tests/` 既有文件——**唯一例外** = 断言「no-markers + exit≠0 → fail case」形态的测试更新为新语义（§5 授权；任何其他翻红修实现不改测试）
- vitest 适配器 parse（`src/testrun/vitest.ts`）——设计 D4 明确不动
- flake 通道语义、`SPEC_CONTRACT_*` 阈值、`maxSpecRejects` 缺省值

## 4. 实现形状（锁定）

### A. e2e-sh parse 改道（`markers.size === 0` 分支内）

```ts
if (markers.size === 0) {
  if (exitCode === 0) { /* 既有抛错不变（无区分力） */ }
  // 新：exitCode !== 0 → 抛错（解析失败类），不再返回 no-markers fail case
  throw new Error(
    `e2e-sh 适配器 parse 失败：${stdoutPath} 无标记行且 exitCode=${exitCode}` +
    `——脚本未按 e2e-sh 契约跑到输出点（exit code 与标记行须一致），疑似脚本崩溃/环境断链` +
    `（stdout 首行：${首行摘要}）。期望出现验收 ${acceptance.id} 的标记。${MARKER_FORMAT_NOTE}`
  );
}
```

- 首行摘要 = stdout 首个非空行 trim 后截 200 字符（超出加 `…`）；无任何非空行给 `（stdout 为空）`。
- `NO_MARKERS_NAME` 常量与 no-markers fail case 产出路径**删除**（无消费方后死代码不留）；模块头「防伪造语义」注释第 5 条同步为新语义（标记缺失无论 exit code 均抛错：0 = 无区分力、≠0 = 未跑到输出点/疑似崩溃断链）。
- 上层零改动：parse 抛错 → verify 既有捕获 → `parseFailedAcceptanceIds` + `<id>.report.json` 顶层 `{parseError, reason}` → 连挂 2 → `specContractBroken` 回炉任务书内嵌 reason 原文（含 stdout 首行）——**既有通道零新增文案**（设计 D4）。

### B. u5-acceptance.md 同步（强制连带，两处）

1. 「规格锁定」节 parse 语义行：**标记缺失且 exitCode≠0** 的归宿从「该验收整体 fail（name="no-markers"）」改为「抛错（解析失败类——脚本未按契约跑到输出点，疑似崩溃/环境断链，连挂 2 走 specContractBroken 回炉）」；标记缺失且 exitCode=0 抛错语义不变；标记 id 不符语义不变。
2. 验收条目 6 同步改写（与上同口径），并追加一句「真测试红的正道形态 = 有 FAIL 标记 + exit≠0，不受改道影响」。

### C. 既有测试机械适配（授权条款）

扫描 `grep -rn "no-markers\|NO_MARKERS" tests/`：断言「无标记 + exit≠0 → fail case（name 含 no-markers）」的用例更新为断言 parse 抛错（message 含 exit code 与 stdout 首行）；「无标记 + exit=0 → 抛错」「有标记 id 不符 → 抛错」的既有断言**不动**。逐处列入汇报。e2e 级测试（真实脚本产出 no-markers 形态驱动的连挂/停派断言）改为驱动 parse 抛错后的 parseFailedAcceptanceIds 形态，语义对齐 rv-5「解析失败不进 flake 输入」的既有口径。

### D. reviewer 审查上下文段（brief.ts）

- `specReviewReviewerTasks(unit, projectCwd)` 签名加第三参 `failHistory: readonly string[]`（调用侧 = renderBrief 透传；renderBrief/writeBriefFile 加可选参 `specReviewFailHistory?: readonly string[]`；loop.ts:1321 调用处传 `specReviewFailComments(events, target.unitId)`——接口锚定：历史重建需要原始事件流，投影无跨类型顺序，loop 侧算好传入，渲染层保持纯函数）。
- 段落形态（历史 ≥1 代时插入在「## 你的任务（reviewer：spec-review）」标题与「你是独立 reviewer」句之后、第 1 步之前；0 代历史不输出本段）：

```
## 审查上下文（第 <N> 代）
本 spec 已被打回 <N-1> 代。历代意见摘要（全文见账本 verdict）：
  - 第 1 代：<该代 comment 全文>
  - 第 2 代：<…>
  - 第 3 代：<…>
（超 3 代时：只列最近 3 代，头部补一行「共 <N-1> 代，以下为最近 3 代」）
审查指引：前代意见已修复的不重复打回（除非修复引入回归）；聚焦本轮增量。
```

  N = 当前代数 = failHistory.length + 1（本代是第 N 代审查）；截最近 3 代（设计 D5：防任务书膨胀）。每代摘要 = 该代首条 fail comment 全文（`specReviewFailComments` 本就取每代首条——口径天然对齐）。
- 渲染层唯一（`writeBriefFile` 单调用点 loop.ts:1321，print/spawn 共用），双形态天然生效——基线记档此实态。

### E. 第五维点名路径逃逸（brief.ts，D6）

第五维「干净 checkout 可执行性」文案末追加一句：`命令不得引用检出树外的绝对路径/工作区路径（绝对 cd、~ 起始路径、.cw-worktrees——gate 规则⑫词法漏报面在此语义兜底：引号包裹/动态构造/相对上跳/自定义工作区名词法拦不住）。`

### F. 代数中间档出声（escalations.ts）

- 常量 `SPEC_REVIEW_PROGRESS_NOTICE_MIN = 3`（escalations.ts，注释注明与历史截断 3 同源校准）。
- `announceManualEscalations` 内（lv-2 交付后的实态签名上追加，不新增函数参数——`specFails` map 已含代数）：`3 ≤ failCount < maxSpecRejects` 的 subtree 内 unit → 输出一行：

```
cw run: unit "<id>" 的 spec-review 已打回 <failCount> 代（预算 <maxSpecRejects>）——若往返持续，可提前人工介入：cw run --root <rootId> --spawn human
```

- dedup：新 `specProgress: Map<string, string>` 字段（loop 侧 dedup 构造处同步加），**完整文本比较**（代数进文本必然逐代不同——新代意见是新事实，与 spec 维度「各代意见不同是有意重出」哲学一致，不做签名压缩；3 ≤ 代数 < 预算区间内同代数不重出）。不进停派 map、不改变任何派发行为。
- 与既有 specReviewDeadlock 出声的关系：达预算后走既有完整转人工文案（dedup.spec），中间档不再出（区间上界互斥）。

## 5. 新增测试条款（零 mock；e2e 走 `node dist/cli.js` 完整 dispatch + tmp git 仓 + 独立 CW_HOME）

### tests/lv3-e2e-contract-route.test.ts（E 系）

- **E1**（S3-a，127 形态）fixture 脚本未提交（bash exit 127 无输出）→ verify 后 `parseFailedAcceptanceIds` 含该条目、`<id>.report.json` 顶层 `{parseError, reason}` 且 reason 含 `exitCode=127`。
- **E2**（S3-b，断链形态）脚本已提交但内部调用不存在的 pnpm script（exit 1 + stdout 有构建报错首行）→ 同 E1 归类解析失败，reason 含 `疑似脚本崩溃/环境断链` 与 stdout 首行摘要原文。
- **E3**（S3-c 对照组）脚本正常完成输出 `<id> FAIL` 标记 + exit 1 → **不进** parseFailedAcceptanceIds、case status=fail（真测试红分类不变，走 developer fix 循环）。
- **E4**（回炉链）E2 形态连挂 2 次 → `cw frontier` 出现 `specContractBroken` 组；真实 loop（--spawn human）派发的 designer 回炉任务书内嵌 reason 原文（含 stdout 首行）。
- **E5**（通道排他）E2 形态连挂 2 次的 unit **不进** flakeReview 组（解析失败不进 flake 输入——rv-5 既有口径回归）。
- **E6**（exit=0 不变）`echo ok` 类零标记 + exit 0 → 抛错语义回归（无区分力防线不变，message 含既有文案）。
- **E7**（首行摘要截断）stdout 首行 >200 字符 → reason 含截断 `…`；stdout 全空 → `（stdout 为空）`。

### tests/lv3-review-context.test.ts（R 系）

- **R1**（S4-②）构造打回 3 代后第 4 代 reviewer 任务书（真实 loop 派发或直接 writeBriefFile+实参）含「审查上下文（第 4 代）」段 + 最近 3 代意见全文 + 不重打回指引句。
- **R2**（截断）构造打回 5 代 → 第 6 代任务书含「共 5 代，以下为最近 3 代」且只列 3 代。
- **R3**（S4-①回归）第 2 代 designer 修 spec 任务书含最新意见全文（既有行为不变）。
- **R4**（S4-③）真实 loop 打回第 3/4/5 代各出声一次中间档（同代数不重复、新代数重出）；文本含代数与预算值与 `--spawn human` 介入命令。
- **R5**（S4-④回归）10 代停派行为与既有 specReviewDeadlock 完全一致（完整转人工文案 + 停派；中间档不再出）。
- **R6**（第五维点名）reviewer 任务书第五维文案含路径逃逸兜底句（规则⑫提及）。
- **R7**（0 代首审）无打回历史的 reviewer 任务书**不含**「审查上下文」段（首审零噪音）。

## 6. 通过命令

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-test-split
npm run check:all
npx vitest run tests/lv3-e2e-contract-route.test.ts tests/lv3-review-context.test.ts tests/u5-vitest.test.ts tests/rv5-flake-escalation.test.ts tests/mx5-2-contract-replan.test.ts
npm run lint
npm test   # 全量必须全绿
```

## 7. 波后验收（verifier 执行，真实场景）

1. **S3 真跑**（设计 §4 全场景）：三条目 fixture（127 / 断链 exit 1 / FAIL 标记对照）两次 verify + 一轮 `cw run --spawn human`——a/b 归解析失败、c 走 fix 循环、回炉任务书含 stdout 原文。
2. **S4 真跑**：脚本扮演 reviewer 打回 5 代——④ 代任务书审查上下文、③ 3/4/5 代逐代出声、⑤ 10 代停派回归。
3. **机械适配审计**：no-markers 既有断言逐处 diff 复核「最小必要无掩盖回归」（al-3 先例口径）。
4. **文档一致性**：u5-acceptance 两处 + CONTEXT 词条（若涉）与实现语义零漂移。

## 8. status

| 字段 | 值 |
|------|-----|
| status | pending → building → built → verifying → verified → committed |
| 验收基线 commit | 本文件入 git 时的 commit |
