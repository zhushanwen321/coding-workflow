# mx5-3 verifier 验收报告：reviewer 任务书对抗式改版

> 独立 verifier 验收（与 developer 无关的第三方）。基线：`docs/rewrite/acceptance/mx5-3-acceptance.md`（防篡改 hash 锚定见验收项 1）。交付 commit：`9fd2c87`。验收日期：2026-08-19。机器证据产物根：`/tmp/cw-mx53-v3/`（渲染脚本 / prompt / 3 次 spawn stdout+stderr）。

## 总结论

**PASS（6/6 验收项全过，V3 波后复测 3/3 fail 判定达标）**

| 验收项 | 判定 |
|--------|------|
| 1 防篡改链 | PASS |
| 2 验收命令复跑 | PASS |
| 3 清单口径代码审查 | PASS |
| 4 B3 独立复核 | PASS |
| 5 红性抽查（2 条） | PASS |
| 6 V3 波后场景（3 次真实 pi spawn） | PASS（3 fail / 3 spawn，≥2 达标） |

findings：3 条（均不阻塞，见文末）。

---

## 1. 防篡改链 — PASS

- 基线文档 hash：`shasum -a 256 docs/rewrite/acceptance/mx5-3-acceptance.md` =
  `95d4f4d423691b9432ee2a547ac1512deca9e060a5473e4851721ef94d9e0dec`（§1-§7 清单口径未动；commit 9fd2c87 对该文件的唯一改动是 §8 status 行流转，原行文本即注明「developer 派发时由主 agent 更新」，属基线自身设计的流转记录，非篡改）。
- `git status`：仅 `?? .tmp/` 与 `?? docs/rewrite/acceptance/mx5-1-report.md`（并行 unit mx5-1 的 verifier 产物，untracked，非本 unit 改动）；tracked 区零脏。
- `git show 9fd2c87 -- src/runner/brief.ts`：全文仅两个 hunk（`@@ -66,10 +66,16 @@` JSDoc 区 + `@@ -82,13 +88,30 @@` 函数体区），均在 `specReviewReviewerTasks` 函数及其 JSDoc 内。逐函数对照（函数定位 grep + 分段 hash，见验收项 4）：designer 四形态（specFixPending / designerFirst / missingChildren / integrationDrift）、build（ROLE_TASKS.builder）、exec-review（ROLE_TASKS.reviewer）模板函数零改动。文件级 stat：brief.ts +32/-9，与基线 §8 status 声明一致。
- commit 其余触及：`tests/mx5-3-reviewer-brief.test.ts`（新建 533 行）+ 基线 §8 status 行。`src/` 其余文件零触及，既有测试零修改。

## 2. 验收命令复跑 — PASS

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0（check + check:tests 两段 tsc 均无错） |
| `npx vitest run tests/mx5-3-reviewer-brief.test.ts` | 9 passed / 9（B1×1 + B2×1 + B4×1 + B3×6） |
| `npx eslint src/runner/brief.ts tests/mx5-3-reviewer-brief.test.ts` | exit 0，零告警 |
| `npm test`（全量） | **67 files / 510 tests 全绿**（Duration 130.86s） |

## 3. 清单口径代码审查 — PASS

基线 §4 五维度逐条对照 `src/runner/brief.ts`（specReviewReviewerTasks，行 91-114）：

| 基线 §4 维度 | 实现锚点 | 判定 |
|------|------|------|
| ① 验收命令契约逐条核对（unit/integration：--reporter 若出现必须恰为 json + install 带 --silent；e2e：stdout 从哪产出 `<验收id> PASS` 标记行） | 行 93-99；`grep '恰为 json'` → 行 95 唯一命中；`grep '无 --reporter'` → **零命中**（exit 1，无禁令式口径漂移）；e2e 追问句在行 97；`--silent` 在行 96 | 过 |
| ② 覆盖度（brief 逐条映射 + 验收真空） | 行 100-101 | 过 |
| ③ 区分力反例追问（无实现必挂？换实现还过？） | 行 102-103，两句原文在场 | 过 |
| ④ 契约一致性（跨 unit 接口与冻结 hash 对照） | 行 104-105 | 过 |
| ⑤ 干净 checkout 可执行性（package.json / 自带 install） | 行 106-107 | 过 |
| 输出分级 must-fix / suggestion / info + pass 逐项显式「核过无问题」+ 禁「不构成阻塞，pass」式含糊放行 | 行 110-114（三级清单行 112；逐项显式行 113；含糊放行反制行 114 原文引用三跑形态） | 过 |

## 4. B3 独立复核 — PASS（不采信 developer 快照方法）

方法：`git show 9fd2c87^:src/runner/brief.ts > /tmp/brief-before.ts` 与当前工作区版本做全文 diff + 分段 hash（改动前后两版行数 337 → 360）。

- 全文 diff 共 46 行输出，全部落在两个区间（before 69-95 ↔ after 69-120），即 `specReviewReviewerTasks` 的 JSDoc 与函数体——与 `git show` 两 hunk 完全一致，无第三处改动。
- 分段 hash：
  - 前 66 行（文件头/imports/类型/**ROLE_TASKS = build + exec-review 模板**）：`fef7cebc…141f` 两版一致。
  - 尾部 before 98-337 ↔ after 121-360（**specFixPendingTasks / designerFirstTasks / missingChildrenTasks / integrationDriftTasks / renderBrief / writeBriefFile**）：`34525385…ac25e` 两版一致。
- 结论：除 spec-review reviewer 模板函数 + 其 JSDoc 外，其余模板函数体逐字节一致（B3 独立佐证，与测试内嵌快照互为印证）。

## 5. 红性抽查 — PASS（2 条，均闭环恢复）

| # | 篡改注入 | 定向测试结果 | 恢复 |
|---|---------|-------------|------|
| 1 | 删除 brief.ts 行 97（e2e 标记行追问句 `stdout 从哪产出 …`） | `vitest -t "B4"` → **1 failed**（断言 `toContain("stdout 从哪产出")` 红在第 144 行） | `git checkout -- src/runner/brief.ts` → `git diff` 零输出，行 97 恢复 |
| 2 | 行 95「恰为 json」→「无 --reporter」 | `vitest -t "B2"` → **1 failed**（断言 `toContain("恰为 json")` 红在第 136 行，`not.toContain("无 --reporter")` 同红） | 同上 → `git diff` 零输出 |

恢复后 `src/runner/brief.ts` hash = `a90ad74a86cb63486e57cda3e495b696191fdf5af4a7584e676cced18dfaa32a`，与 commit 9fd2c87 版本逐字节一致；验收结束时 `git diff` 仍干净。

## 6. V3 波后场景（基线 §7）— PASS（3/3 fail，≥2 达标）

**场景复刻**：`npm run build` 后以 node 直调 dist 模块（`/tmp/cw-mx53-v3/render-brief.mjs`：真实 EventLedger append + fold 投影，零 mock），以三跑 leaf-app **v3 冻结 spec 原文**（`.xyz-harness/m4-gate3-evidence/.../50eb84d0….spec.json`，specHash 与账本 seq18 一致）+ 现场渲染参数（unitId=leaf-app / parentId=md-reader / briefRef `.cw-spawn/leaf-app.brief.md` 不可读兜底 / workdir 分支 `cw/md-reader/leaf-app`，对照三跑 `leaf-app.reviewer.brief.md` 头部逐字段复刻）渲染改版任务书，spec 原文副本同步落 attachDir（内容寻址文件名同三跑）。spawn prompt = 渲染任务书 + spec 原文全文 + **中性**输出指引（明确「不执行 cw 命令、直接文本给出 verdict + comment」，不暗示任何结论倾向）。

**spawn 形态**：`pi --model xiaomi-token-plan-cn/mimo-v2.5-pro -p --session-dir <每次独立> --name leaf-app-reviewer-v3-<N> @/tmp/cw-mx53-v3/prompt.md`（参照 `src/runner/spawn/pi.ts` buildPiCommand；macOS 无 GNU timeout，用 `perl -e 'alarm 300; exec @ARGV'` 等价实现 300s 超时）。三次均为独立进程、独立 session-dir；stderr 仅本地扩展噪音（statusline env var / pi-rename-session，与 pi.ts 注释记载一致，不影响判定）。

**判定口径**（任务锁定）：≥2 次 verdict=fail 且输出命中「标记行 / marker / A3 / 无标记」任一；含 must-fix/suggestion/info 分级痕迹。

### 逐次记录（stdout 留档 /tmp/cw-mx53-v3/spawn-{1,2,3}.stdout）

| # | exit | verdict | A3 标记行问题 | 分级痕迹 | 关键摘录 |
|---|------|---------|--------------|----------|----------|
| 1 | 0 | **fail** | 强命中：must-fix-2 专列 A3 | must-fix×4 / suggestion×2 / info×2 + 五维度汇总表 | 「must-fix-2 [① 验收命令契约] **A3 — 同样缺失 `<验收id> PASS` 标记行**。A3 的 command 是 `pnpm install --silent && pnpm build`…不产出任何 `A3 PASS` 标记行」；恢复动作 `&& echo "A3 PASS"` |
| 2 | 0 | **fail** | 强命中：A3 单列 must-fix | must-fix×5 / suggestion×1 / info 若干 + 逐维度「核过无问题」显式 | 「**A3 (e2e-real)**：`pnpm install --silent && pnpm build` — [must-fix] **e2e-real 型验收缺失 `A3 PASS` 标记行。裸 `pnpm build` 命令即使 exit 0 也永不产出标记行，属结构性不可通过**」；问题汇总表列 must-fix A3 行 |
| 3 | 0 | **fail** | 弱命中：「A3」与「标记行」均在场但未合为一项 | must-fix×3 / suggestion×3 / info×1 + 六行核对明细表 | must-fix #3 就 A1 追问「若依赖 `<验收id> PASS` 标记行：脚本必须输出 "A1 PASS"（spec 完全未提及）」；A3 被定性为 suggestion「[A3] 区分力弱…不构成阻塞但建议加强」——但整体 verdict 仍 fail（fail 依据为 A2/A4/A5 `--reporter=verbose` 违反规则⑨等 must-fix） |

**对照三跑反例**（`events-final-full.log` seq19，旧版任务书）：「A3 区分力较弱（仅 build exit 0）和 A5 mock 边界说明可补充，但**不构成阻塞。pass**」。改版任务书下 3 次独立 spawn：**3/3 verdict=fail**，其中 2 次把 A3 的标记行缺失明确列为 must-fix（含「结构性不可通过」定性），1 次弱命中（关键词在场、A3 降为 suggestion 但 verdict 仍 fail）。V3 判定 **PASS**。

## findings（均不阻塞）

1. **[minor] spawn-3 对 A3 的抓取深度有随机性**：它对 A3 沿用了三跑同款「区分力弱」定性（降为 suggestion），未把「A3 裸 build 无标记行」单列为打回理由（该意识被用在了 A1 上）。模板对「A3 形态」的传导在该次表现为部分生效——总体 verdict 仍 fail 且判定口径命中，但说明单次 spawn 的结论强度有波动，波后验收设 3 次取 ≥2 的口径是必要的。
2. **[minor] B2 负向断言只字面锁定「无 --reporter」短语**：`not.toContain("无 --reporter")` 抓不到「不得带 --reporter」等变体表述；但正向 `toContain("恰为 json")` 保证任何口径漂移使该句消失/改写都会红（红性抽查 #2 已实证），实际防线成立。
3. **[info] commit 9fd2c87 触及基线文档 §8 status 行**：属基线自带的状态流转记录（原行明示由流转更新），§1-§7 hash 锚定未动，不构成禁改清单违反；记此备查。

## status

verifier 验收完成：PASS（2026-08-19，机器证据 /tmp/cw-mx53-v3/ + 本报告；verifier 不 commit）
