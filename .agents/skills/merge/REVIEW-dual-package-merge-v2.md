# 复审报告：DESIGN-dual-package-merge.md（v2）

> 审查对象：`.agents/skills/merge/DESIGN-dual-package-merge.md`（v2 修正版）
> 审查依据：`tech-design` skill `review/rubric-design-doc.md`（P0/P1 清单）
> 审查方式：文档全文 + 交叉 read 事实源（release.yml / merge SKILL.md / 双包 package.json / vitest.config / tsconfig / 远程 tag / CI run 日志 / npm registry）+ 1 组运行时探针复证
> 结论：**7 个上轮 must-fix 全部实质修复（无文字修补），但复审期间现实已变——出现 3 个新的 must-fix**（核心事实前提过时 + 两个验收场景不安全），修完可实施。

## Summary

3 must-fix, 4 suggestions.

## 本轮新增证据（与 v2 写作时不同的现实）

1. **远程已存在 `ext-v0.5.0` tag**（lightweight，指向 PR #24 merge commit `516ae12a`，2026-08-25）。
2. **`ext-v*` tag 路径已被真实走过 3 次且全部失败**：`gh run list` 显示 2026-08-25 三次 `Release ext-v0.5.0 push` run（32809161391 / 32808646068 / 32808200571）全 failure。失败点在最后一步：`npm error 404 Not Found - PUT .../@zhushanwen%2fpi-coding-workflow`——install / test / pack 全过，**卡在 npm publish 404**（NPM_TOKEN 对该包无写权限的典型形态）。
3. **插件包 0.5.0 从未发布上 npm**：registry 上 `@zhushanwen/pi-coding-workflow` 最新版本 = 0.4.1（versions 数组尾），CI 404 报文本身也确认 "0.5.0 is not in this registry"。即「当前发布全靠 workflow_dispatch 手动触发」不成立——dispatch 也没发出去过。
4. 探针复证（npm 11.6.2，与 packageManager 钉版一致）：workspace 子包内 `npm version patch --no-git-tag-version` → 根 lock `packages["<子包>"].version` 0.5.0→0.5.1 自动同步，根 `npm ci` exit=0；**根包** `npm version` 同样同步 lock（`version` 与 `packages[""].version` 同步 1.0.0→1.0.1）。
5. release.yml publish 条件 read 复核：`github.event_name != 'workflow_dispatch' || !inputs.dry-run`——**tag 触发时 publish 恒运行，dry-run 输入不参与**。

## 上轮 7 must-fix 逐项判定

### #1 决策树死分支（§3.1）——已修复（逻辑层）

四分支 if/elif/elif/else 互斥可达：`ext/ + src/` 混合变更现命中分支 3（分支 1 因「只涉及」不命中、分支 2 因含 ext 不命中），双 bump 路径可达，v1 的静默漏 bump 消除。「核心包资产」清单扩展（tests/、根 package.json、tsconfig、.github/、vitest/eslint 配置）回应了 v1 次级缺陷。残留见 SUGGESTION #1。

### #2 阶段 1 覆盖面（§3.7）——已修复

- 插件包确有 `typecheck: tsc --noEmit` / `test: vitest run` scripts（read `pi-coding-workflow-extension/package.json` 证实）。
- 根四命令确不含插件目录：vitest include=`tests/**/*.test.ts`、tsconfig(.test).json include=src+tests、lint=`eslint src/ tests/`（read 证实）——v2 的「不含」陈述准确。
- 扩展命令路径 `$WS_ROOT/$FEATURE_DIR/pi-coding-workflow-extension` 与 SKILL.md 阶段 1 变量约定一致。残留见 SUGGESTION #3。

### #3 CHANGELOG --match（§3.4）——已修复

`--match 'v*'` / `--match 'ext-v*'` 已加；glob 锚定 tag 名开头，`v*` 不匹配 `ext-v*`（上轮探针 2 已证，模式语义复核无异议）。附带：「插件首 tag 空 RANGE」场景已自然消解——远程现有 ext-v0.5.0，下次生成 PREV_TAG=ext-v0.5.0（文档基于过时前提但结论无碍，归入新问题 1）。

### #4 双 tag 并发竞态（§3.5）——已修复（机制层）

read release.yml 证实 if 隔离正确：推 `v*` 只跑 publish-core（extension job if=false skipped），推 `ext-v*` 只跑 publish-extension——两段式 + 「CI 成功 + `npm view` 可见」门在机制上保证核心先于插件、消除 registry 可见性竞态。禁 `--tags`、单 commit 双 tag 同 commit 自洽。但按当前 npm 404 现状，第二段必失败——见 MUST_FIX #1 的前置条件。

### #5 回滚不完备（§3.6）——已修复

只删 tag 不 reset、共享 commit 处置语义明确（保留 + 接受跳号）、双包 unpublish 补齐、72h 窗口说明正确。两处措辞/边界瑕疵见 SUGGESTION #4。

### #6 npm version lock 同步（§3.2）——已修复（探针复证），但修正文本引入一处自相矛盾（SUGGESTION #2）

探针复证通过（见证据 4）；与全局「禁止 npm version」规则的冲突已表面化并给出论证。但例外声明「仅限 workspace 子包内……不推广到根包」与 §3.2 自己的核心包流程矛盾（见 SUGGESTION #2）。

### #7 无验收章节（§4）——已补，结构达标，但 A1 方式二 / A3 有 must-fix 级问题

A1-A4 回溯 §1 目标成立（首跑链路 / 顺序 / 回滚 / 质量门），A4 真实可跑（scripts 存在），A2 与真实首发合一，投入与改动匹配（P0-13/15 通过）。A1 方式一（dispatch dry-run）正确：publish 步条件 read 证实 dispatch + dry-run=true 时跳过。**A1 方式二与 A3 不安全**，见 MUST_FIX #2 / #3。

## 新问题（本轮 must-fix）

### MUST_FIX #1：核心事实前提全部过时，且掩盖一个未解的发布阻塞（§1 / §2 / §4-A1）

- §1 / §2 三连断言与现状冲突：①「远程零 `ext-v*` tag」——假（已有 ext-v0.5.0）；②「tag 触发路径从未被真实走通」——假（走过 3 次，全败于 publish 404）；③「当前发布全靠 workflow_dispatch 手动触发」——无证据且 0.5.0 从未上 registry（最新 0.4.1）。
- 当前仓库处于**半发布态**：package.json / CHANGELOG / 远程 tag 均已宣告 0.5.0，npm 无此版本。
- 后果（P0-4 / P0-10 / P0-11 / P0-18）：真实问题比「无自动化」严重——是「发不出去」（NPM_TOKEN 对 `@zhushanwen/pi-coding-workflow` 无写权限）。§3.5 第二段按现状必失败；A1「首跑有风险」预设失效（不是没走过，是走过且红）；文档对该已知失败无任何处置指引。
- 修复方向：§1/§2 重写为实况（含三次失败 run 引用与 404 根因）；把「修复 NPM_TOKEN 对插件包的写权限」列为实施前置条件；处置当前半发布态（权限修复后重推 ext-v0.5.0 即完成补发，或按 §3.6 删 tag 走 0.5.1）。

### MUST_FIX #2：A1 方式二的双重事实错误 + 真实发布风险（§4-A1）

- 「（dry-run 输入跳过 publish）」为假：tag 触发 `event_name=push`，publish 条件 `push != workflow_dispatch` 恒真——**tag push 无法携带 inputs，dry-run 对 tag 路径无效**（read release.yml 证实）。
- 「npm publish 因版本已存在而失败」前提为假：0.5.0 不在 registry，当前失败是 404 权限错而非版本冲突。**一旦权限修复，此"演练"会真的把 0.5.0 发布上去**（`npm publish` 用 package.json 版本，不看 tag 后缀 `-dry`）。
- 修复方向：删除方式二，或改为明确陈述「tag 触发必跑 publish、当前必 404、权限修复后等同真实发布」并按真实发布管理；A1 只保留方式一。

### MUST_FIX #3：A3 回滚演练会真实触发两条发布流水线（§4-A3）

- `v-test-rollback-1` / `ext-v-test-rollback-1` 命中 `on.push.tags` 的 `v*` / `ext-v*` glob（read 证实），tag 事件 publish 恒运行：core 侧全量构建+测试（历史 run ~4min）后 publish 2.2.0 已存在→红；ext 侧 publish 0.5.0→当前 404→红（权限修复后则**真的发布 0.5.0**）。
- 更危险的中间态：若在「版本已 bump、tag 未推」的真实发布窗口内跑演练 = 意外真实发布双包。
- 演练目的（删一 tag 不影响另一 tag）不需要 CI 触发。修复方向：改用不命中 glob 的 tag 名（如 `drill/v-1` / `drill/ext-v-1`）验证 tag 增删隔离，流程其余不变。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §1/§2/§4-A1 | P0-4/10/11/18 | 核心事实前提过时：远程已有 ext-v0.5.0、tag 路径走过 3 次全败于 npm publish 404、0.5.0 从未上 registry；真实阻塞（token 写权限）未列为前置条件 | 重写 §1/§2 为实况；token 权限列为前置；处置半发布态 |
| MUST_FIX | §4-A1 方式二 | P0-11/14 | tag 触发时 dry-run 输入不参与、publish 恒运行（read release.yml 证实）；「版本已存在」前提为假，权限修复后此"演练"会真实发布 0.5.0 | 删除方式二或如实陈述其等于真实发布 |
| MUST_FIX | §4-A3 | P0-13/14 | 演练 tag 命中 v*/ext-v* glob，真实触发两条发布流水线（publish 恒运行）：红 run + 特定时序下意外真实发布 | 改用不命中 glob 的 drill tag 名 |
| SUGGESTION | §3.1 | P0-10 降级 P1 | 「只涉及」语义把「核心资产 + README/docs」等常见混合推入 else，else 标签「纯文档/非代码变更」失真（变更可含 src/ 代码）；兜底指引仍在故非静默漏 bump | 单包分支改「涉及 X 且不涉及另一包」语义，else 仅收「两者都不涉及」 |
| SUGGESTION | §3.2 | P1-8 | 例外声明「仅限 workspace 子包、不推广到根包」与 §3.2 自己的核心包流程矛盾（核心 bump 就在根包跑 npm version）；探针证实根包用法 lock 同步同为期望行为 | 例外范围改为「本仓 workspace 内（根包与成员包）的 --no-git-tag-version 用法」 |
| SUGGESTION | §3.7 阶段 1 扩展 | P1-3 | 插件 typecheck/test 依赖 workspace 根 node_modules 的 hoist（typescript/vitest hoist 自根），worktree 未 install 时直接挂 | 扩展块注明前置「worktree 已在根跑过 npm install」 |
| SUGGESTION | §3.6 | P1-8 | 场景 A「核心包失败→插件包 tag 保留」与两段式时序不符（核心失败时 ext tag 尚未推）；no-reset 会留幽灵 CHANGELOG 条目（记录从未发布的版本） | 措辞改为「本地 ext tag 保留待第二段」；§3.6 注明 CHANGELOG 幽灵条目为接受代价 |

INFO：A2 / §3.5 的 `gh run watch --workflow=release.yml`（无 run-id）在多 run 并存时有盯错 run 的歧义——§5 风险表已自覆盖，建议验收命令直接用 run-id 形态保持一致。

## 最终判断

**7 个上轮 must-fix 全部实质修复**——决策树互斥可达、阶段 1 扩展命令与事实吻合、--match 就位、两段式在 CI 契约上真序、回滚语义自洽、npm version 冲突以探针落定、验收章节结构达标。修复质量是逻辑级的，不是文字修补。

**但复审不能放行**：文档写作后的现实变化（ext tag 路径三次实测失败于 npm 404、0.5.0 从未上 registry）使 §1/§2 事实底盘过时，并直接导致两个验收场景（A1 方式二、A3）不安全或不可按写执行。3 个新 must-fix 修复成本低（改事实陈述 + 收敛验收命令 + 列 token 前置），但有一个是**设计文档之外的现实阻塞**：不先修复 NPM_TOKEN 对插件包的写权限，任何验收都无法全绿。

修完 3 项后可实施。
