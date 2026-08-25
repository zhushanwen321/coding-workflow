# 对抗式审查报告：DESIGN-dual-package-merge.md

> 审查对象：`.agents/skills/merge/DESIGN-dual-package-merge.md`（merge skill 双包发版扩展设计）
> 审查依据：`tech-design` skill `review/rubric-design-doc.md`（P0/P1 清单）
> 审查方式：文档全文 + 交叉 read 事实源（release.yml / merge SKILL.md / merge-helpers.sh / 根与插件包 package.json / vitest.config / tsconfig / package-lock / git tag 远程现状）+ 3 组运行时探针
> 结论：**需修改**（框架方向成立，但存在 2 处"实施即翻车"级缺陷 + 5 处必须收敛的设计缺口）

## Summary

7 must-fix, 7 suggestions.

## 证据基础

事实核查（read 源码）：

| 文档声明 | 核查结果 |
|---------|---------|
| §2 release.yml 双 job 就绪（v\*/ext-v\*） | 属实（read `.github/workflows/release.yml`，if 条件正确隔离两 job） |
| §2 插件包 version=0.5.0、CHANGELOG 已有 0.5.0 记录 | 属实 |
| §2 merge-helpers.sh 与包数无关、无需改 | 属实（selfcheck/root/resolve-main/sync-main 均为路径/worktree 逻辑） |
| §3.2 插件包依赖 `@zhushanwen/coding-workflow: ^2.2.0` | 属实 |
| §3.7 "阶段 1 不变（本地验证已覆盖全量）" | **不属实**（见 MUST_FIX #3） |
| §4-3 "lock 文件需要 npm install 同步" | **不属实**（见 MUST_FIX #7，探针反驳） |

运行时探针（均在干净 fixture 上实测，npm 11.6.2 与项目 packageManager 钉版一致）：

1. **npm version × workspace lock**：在 workspace 子包内跑 `npm version patch --no-git-tag-version`，根 package-lock 的 `packages["<子包>"].version` **自动同步** 1.0.0 → 1.0.1，随后根 `npm ci` exit=0。
2. **git describe × 双 tag 交错**：commit A(tag v1.0.0) → commit B(tag ext-v0.5.0) → commit C 后，`git describe --tags --abbrev=0 HEAD`（现有 CHANGELOG 脚本原样用法）返回 **ext-v0.5.0**；加 `--match 'v*'` 才返回 v1.0.0。
3. **阶段 1 覆盖面**：根 `vitest.config.ts` include=`tests/**/*.test.ts`；根 tsconfig / tsconfig.test.json include=`src/**`+`tests/**`；lint=`eslint src/ tests/`——三条命令**均不含** `pi-coding-workflow-extension/`（插件包自有 vitest.config.ts + src/\_\_tests\_\_/ + typecheck script）。

另核查 git tag 远程现状：**远程不存在任何 `ext-v*` tag**（插件包 0.5.0 应为 workflow_dispatch 手动发布）——即 `ext-v*` tag 触发路径从未被真实走通。

## 逐节审查

### §1 问题 —— 通过（弱）

问题定义忠于目标（插件包发版全靠手工、merge skill 无此能力）。弱项：用方案语言描述问题（"需要独立版本管理、tag 协议"——tag 协议已存在，缺的是 skill 能力）；无一个真实手工操作出错/耗时的例子佐证痛感。P1 级。

### §2 现状 —— 问题（1 处事实 + 1 处遗漏）

- 现状表 5 行中 4 行属实；"merge-helpers.sh 无需改"经 read 证实。
- 遗漏关键事实：远程零 `ext-v*` tag，tag 触发路径未验证过（见 SUGGESTION #5）。

### §3.1 变更检测 —— 问题（MUST_FIX #2）

决策树**死分支**：变更同时涉及 `pi-coding-workflow-extension/` 与 `src/` 时，分支 1（"只涉及"）不命中、分支 2（"涉及 src/"，无"只"字）命中 → 走"只 bump 核心包"，分支 3"同时涉及两者"**永远不可达**。双包混合变更会静默跳过插件包 bump——这恰是 §5 风险表第一条"agent 忘记 bump 插件包"要防的事故，被自己的检测逻辑制造出来。

次级缺陷：以 `src/` 代理"核心包变更"不成立——核心包资产还包括根 `tests/`（SKILL.md 3.2 明确"测试补充→patch"）、根 package.json、tsconfig、`.github/`（发布行为本身）。这些全落入 else"纯文档/配置"分支。

### §3.2 / §3.3 版本 bump 与 tag 协议 —— 通过（1 处边界建议）

双包独立版本、`ext-v<version>` 格式、npm version 命令路径均与现状吻合。"^2.2.0 是 semver range，patch bump 不需同步"属实，但"版本独立管理，不联动"的全面断言在**核心包 major bump 时失效**（range 断裂，插件包用户解析不到新核心），见 SUGGESTION #2。

### §3.4 CHANGELOG —— 问题（MUST_FIX #4）

"复用现有 git log --grep 脚本"的断言被探针 2 反驳：现有脚本 `PREV_TAG=$(git describe --tags --abbrev=0 HEAD^)` **不带 `--match`**，双 tag 交错后生成核心包 CHANGELOG 时会拿到 `ext-v*` 作为 base，range 计算错误（漏掉或多算一个窗口）。脚本必须按包加 `--match 'v*'` / `--match 'ext-v*'`。另：插件包**首个** `ext-v*` tag 时 HEAD^ 无可达 ext tag → PREV_TAG 空 → RANGE=HEAD 只含 bump commit → CHANGELOG 几乎为空，需要显式 base 处理（现有 CHANGELOG 已记到 0.5.0，可作 base）。

"全量记录不过滤路径"的简化方案本身：决策合理（有理由、有后期演进路径），通过。

### §3.5 commit + tag + push —— 问题（MUST_FIX #5 + 3 条建议）

- **设计自相矛盾 + 并发竞态**：§3.1 说"先核心后插件，因为插件包依赖核心包"，§3.5 却把两个 tag 一次 `git push --tags` 推出 → GitHub 为每个 tag 起独立 workflow run，**两个 job 并发**，"先核心"的意图没有任何机制保证。且 publish-extension 的 `npm install` 从 registry 解析 `^2.2.0` 核心包，与 publish-core 的 `npm publish` 存在 registry 可见性竞态：插件包的测试与发布基于的核心版本不确定（旧版或新版）——非确定性发布。若插件包源码用到了新核心的 API，还可能出现测试偶发失败（解析到未更新的旧核心）。
- `--tags` 推全量本地 tag：回滚后遗留的本地 tag 会被重推、误触发发布流水线（在 npm publish 处因版本已存在而失败），见 SUGGESTION #1。
- commit 策略三处不一致（§3.3 断言"一次 commit" vs §3.5"分两个或合并为一个" vs §4-2 待决），见 SUGGESTION #3。

### §3.6 回滚 —— 问题（MUST_FIX #6）

- "沿用现有阶段 4.5 回滚逻辑"未审该逻辑与新前提的相互作用：场景 A 含 `git reset --hard HEAD~1`，双包**同 commit 双 tag**时回滚单包会 reset 掉共享 bump commit（内含另一包已成功发布的版本变更）。§3.6 只写"删 tag"，共享 commit 的处置语义未定义（reset？保留？下一次 re-bump 如何与之共存）。
- 场景 B（npm unpublish + 72 小时窗口）完全未扩展到插件包。
- "删 ext-v\* 不影响 v\*"在 tag 层面成立，但对应用户"插件包发布失败"时插件包版本已写入远程 main 的 package.json——后续重 bump 的版本推演（跳号）未说明。

### §3.7 SKILL.md 改动范围 —— 问题（MUST_FIX #3）

"阶段 1 不变（本地验证已覆盖全量）"**事实错误**（探针 3）：根 check:all / lint / test / build 四条命令均不含插件包。后果：插件包的类型/测试错误只能在 tag push 之后的 publish-extension CI 里暴露——那是回滚地界，直接违背本 skill 自己的设计原则"本地验证是合并前唯一的质量门"。阶段 1 必须扩展（至少：ext 目录 typecheck + test）。"阶段 4 不变"同受双 run 并发影响（见 SUGGESTION #6）。

### §4 待决事项 —— 问题（MUST_FIX #7 + SUGGESTION #3）

待决 #3 的事实前提错误（探针 1 反驳"lock 需要 npm install 同步"——npm 11 下 `npm version` 自动同步根 lock），且该决策未落定即推进到实施层；同时全文未表面化与全局 AGENTS.md「禁止 `npm version`」规则的冲突（该禁令的理由"会同步改写 package-lock.json"在本项目 workspace 场景恰是**期望行为**，冲突应显式论证并记录，而非默认沿用）。

### §5 风险 —— 建议（缓解措施错位）

- "agent 忘记 bump 插件包"的缓解是"检查插件包目录是否有未提交变更"——PR 合并后插件包目录**没有**未提交变更，检测不到遗忘。正确检测：比较上次 `ext-v*` tag 以来是否有触及插件包路径的 commits（这也正是 §3.1 检测树该产出而因死分支产不出的信息）。
- "ext-v tag 打错版本"的缓解是 `npm pack --dry-run`——pack 验证的是**内容**不是版本号，验不出 tag 字符串与 package.json version 不一致。正确缓解：push 前断言 `test "ext-v$(node -p "require('./pi-coding-workflow-extension/package.json').version")" = "$TAG"`。
- "版本冲突不可能，包名不同"——真问题不是重名而是 semver range 断裂（见 SUGGESTION #2），风险条目本身瞄错了靶。

### 验收章节 —— 缺失（MUST_FIX #1）

全文无验收章节（§4 是待决事项、§5 是风险）。按 rubric P0-13/14/15：无 testable 验收 = 设计未就绪。且现成验收工具未被利用：release.yml 的 `workflow_dispatch` 自带 `dry-run` 输入（只构建+测试不发布）与 `package` 选择，恰好覆盖"双 tag 发布路径首次真实走通"的验证需求；本地 `npm pack --dry-run` 双包内容断言（核心包含 PP1 锚：不得含 `pi-coding-workflow-extension/`）也可作为门。验收至少应含：a) dry-run 走通 publish-extension 全链路（tag 路径首跑）；b) 双包并发场景核心→插件顺序验证或竞态声明；c) 回滚演练（单包回滚不动另一包）；d) 插件包本地质量门存在性验证。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | 全文 | P0-13/14/15 | 无验收章节，无 testable 场景；现成 dry-run 工具未利用 | 补验收章节：workflow_dispatch dry-run 走通 ext 发布链路、双 tag 顺序/竞态验证、单包回滚演练、插件包本地质量门 |
| MUST_FIX | §3.1 | P0-10 | 决策树死分支：混合变更（ext/ + src/）走"只 bump 核心包"，"同时涉及两者"分支不可达——目标问题（插件包版本停滞）被方案自身制造 | 重写为四分支互斥形态（只A / 只B / 两者 / 其他），并修正"核心包=src/"的过窄代理（tests/、根 package.json、CI 均属核心资产） |
| MUST_FIX | §3.7 | P0-11/16 | "阶段 1 已覆盖全量"事实错误：根 check:all/lint/test 均不含插件包（read vitest.config/tsconfig/scripts 证实），插件错误只能在 post-tag 的 CI 暴露 | 阶段 1 扩展：变更涉及插件包时跑 `pi-coding-workflow-extension/` 的 typecheck + test |
| MUST_FIX | §3.4 | P0-11 | "复用现有 CHANGELOG 脚本"不成立：`git describe --tags --abbrev=0` 不带 `--match` 在双 tag 交错下返回错误 base（探针证实）；插件首 tag 的空 RANGE 未处理 | 脚本按包加 `--match 'v*'`/`--match 'ext-v*'`；首 tag 显式 base（CHANGELOG 已有 0.5.0） |
| MUST_FIX | §3.5 | P0-12/16 | 双 tag 一次 push → 两 workflow 并发，§3.1"先核心后插件"无机制保证；插件 CI 从 registry 解析核心包存在版本竞态，发布非确定 | 二选一并写明：a) 推 v\* → 等核心发布验证成功 → 再推 ext-v\*（真顺序）；b) 接受竞态，删掉"先核心后插件"的理由声明并记录已知风险 |
| MUST_FIX | §3.6 | P0-12/18 | 回滚不完备：场景 A 的 `git reset --hard HEAD~1` 在双 tag 同 commit 下会 reset 掉含另一包版本变更的共享 commit；场景 B（unpublish）未扩展到插件包；重 bump 跳号语义未定义 | 定义单包回滚时共享 commit 的处置（建议：只删 tag 不 reset，接受版本跳号）；补插件包 unpublish 场景 |
| MUST_FIX | §4-3 | P0-11 | 待决#3 基于错误事实（探针：npm 11 下 npm version 自动同步根 lock，npm ci 通过）；且未表面化与全局 AGENTS.md「禁止 npm version」的规则冲突 | 以探针证据落定决策（记录 npm 11.6.2 前提）；显式论证为何本场景 npm version 可用（lock 改写恰为期望行为）并回写规则冲突说明 |
| SUGGESTION | §3.5 | P1-8/对抗 | `--tags` 推全量本地 tag，陈旧 tag 会被重推误触发流水线 | 改为只推本次新建的显式 tag（`git push origin HEAD:refs/heads/main v2.2.1 ext-v0.5.1`） |
| SUGGESTION | §3.3 | P0-11 降级 P1-8 | "版本独立管理，不联动"在核心包 major bump 时失效（^2.2.0 range 断裂） | 补边界声明：核心 major 前置检查插件包依赖 range 并同步更新 |
| SUGGESTION | §3.3/§3.5/§4-2 | P1-9 | commit 策略三处表述不一致（断言单 commit / 分或合 / 待决） | 收敛为一处明确决策（建议单 commit，与双 tag 同 commit 的 tag 设计自洽） |
| SUGGESTION | §5 | P0-10 降级 P1 | 两处缓解措施与风险错位："忘记 bump"用未提交变更检测（PR 合并后必为空）、"tag 版本打错"用 pack 内容验证（验不出版本） | 检测改为"上次 ext tag 以来 ext 路径 commits"；版本一致性改为 push 前断言 tag 字符串 = ext-v + package.json version |
| SUGGESTION | §2 | P1-3 | 未披露"远程零 ext-v\* tag、tag 触发路径从未走通"这一现状 | 现状表补一行，并将首跑验证列入验收 |
| SUGGESTION | §3.7 阶段 4 | P1-8 | "阶段 4 不变"不准确：双 run 并发时 `gh run watch`（无 run-id）只盯一个 run | 改为按 run-id 分别 watch 或 `gh run list` 轮询双 run |
| SUGGESTION | §3.1/§3.5 | P1-4 | 核心编排决策（双 tag 编排/推送顺序）无 alternatives 记录 | 补一段"考虑过但没选"：单 push 竞态 vs 顺序两段 push vs 仅 workflow_dispatch 手动发布 |

## 通过项（被证据说服的部分）

- §3.1"不搞自动检测，显式指定"的**原则**：理由充分（路径映射不精确、语义无法从 diff 推断），是减法而非加机制（P1-6 通过）。
- §3.2/§3.3 双包独立版本、tag 命名、npm version 命令形态与 release.yml 现状吻合（read 证实 if 条件正确隔离，`v*` glob 不会误匹配 `ext-v*`）。
- §2 "merge-helpers.sh 无需改"：read 证实四子命令均为路径/worktree 逻辑，与包数无关。
- §3.4 全量记录的简化取舍：有理由、有演进路径。
- 双包 tag 同 commit 的 tag 设计本身（修复 §3.6 回滚语义后成立）。

## 总体判断：需修改

框架方向正确（显式检测优于自动检测、tag 协议与 CI 现状吻合、改动范围表清晰），无需重做。但 7 个 must-fix 中 #2（死分支导致混合变更漏 bump 插件包）、#3（插件包质量门缺位）、#4（CHANGELOG range 必错）属"实施即翻车"级——任何一个都足以让首次双包发布以回滚收场。修改后建议复审一轮，重点复核：决策树互斥性、阶段 1 扩展命令、CHANGELOG 脚本 --match、推送顺序决策。
