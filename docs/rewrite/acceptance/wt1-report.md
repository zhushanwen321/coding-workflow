# wt-1 验收报告：worktree 基建（W1）

> verifier 独立对抗式验收。基线 commit：`c0f9f29`（HEAD 即基线，builder 未 commit，符合机制）。
> 结论：**PASS**（四命令全过、防篡改通过、§6 15 条款全部实证、2 处披露偏差均裁决合理、对抗抽查 9/9）。

## 1. 防篡改

| 项 | 结果 |
|----|------|
| `git diff c0f9f29 -- docs/rewrite/acceptance/wt1-acceptance.md` | 空（未篡改） |
| 验收文档 sha256 | `aa425af6f6921d1620d7059f0b59aa3747ff9c96fa0433975c178ea37d0c2fda` |
| `git status --short` 全貌 | 恰好 4 项：`M src/cli.ts`、`M src/store/project.ts`、`?? src/runner/worktree.ts`、`?? tests/wt1-worktree.test.ts`，无其他改动/未跟踪文件（已知豁免项也未出现） |
| `git diff c0f9f29 --stat` | `src/cli.ts` 3 行（+2/−1：1 import + dispatch 行替换）、`src/store/project.ts` +45 纯追加（0 删除；`isAbsolute`/`homedir` 既有 import 已覆盖，无需改头部）；两个新文件 untracked 不入 stat |

交付面与验收文档 §2 逐文件吻合；§5 禁改清单零违反（src/ 其他文件、tests/ 既有文件、docs/、package.json、eslint/tsconfig 均未动）。

## 2. 命令实跑（验收文档 §7）

| 命令 | 结果 | 输出尾部 |
|------|------|---------|
| `npm run check:all` | exit 0 | `tsc --noEmit` 与 `tsc --noEmit -p tsconfig.test.json` 均无错误输出 |
| `npm run build && npx vitest run tests/wt1-worktree.test.ts` | 15/15 绿 | `Test Files 1 passed (1)` / `Tests 15 passed (15)` |
| `npx eslint src/runner/worktree.ts src/store/project.ts src/cli.ts tests/wt1-worktree.test.ts` | exit 0 零输出 | （无输出） |
| `npm test` | 297/297 绿 | `Test Files 42 passed (42)` / `Tests 297 passed (297)`（282 既有 + 15 新增，与 builder 自报一致） |

## 3. §6 条款对照（测试名 ↔ 条款号，附真实性核验）

| 条款 | 测试 | 真实性核验 |
|------|------|-----------|
| A1 | `A1 getCwWorktreeHome() 无 env 时 = join(homedir(), .cw-worktrees)` | 直调断言 join 结果，真 |
| A2 | `A2 CW_WORKTREE_HOME 绝对路径生效；相对路径抛错且 message 含恢复动作` | 断言 `/CW_WORKTREE_HOME 必须是绝对路径/` 与 `/恢复动作/` 双正则，真 |
| A3 | `A3 worktreePath = join(home, encodeCwd(cwd), unitId)，与 ledgerPath 共享 encoded key` | 额外断言与 `ledgerPath` 第二段（encoded key）相同，真 |
| A4 | `A4 resolveProjectDir：无 env 返回 fallback；绝对路径 env 生效；相对路径抛错；空串视为未设置` | 四分支全覆盖（含空串语义），真 |
| B1 | `B1 add 成功：目录存在，worktree 分支 = cw/<unitId>，主仓库分支指向 baseCommit` | 真跑 `rev-parse --abbrev-ref HEAD` 与主仓库 `rev-parse cw/<unitId>` 比对 baseCommit，真 |
| B2 | `B2 父目录多级缺失时 add 仍成功（recursive mkdir 生效）` | 前置断言 `deep-a` 不存在，真 |
| B3 | `B3 分支已存在时 add 失败：{ok:false}，error 含 already exists 原文与恢复动作` | 断言 `toContain("already exists")`（git 原文经 describeFailure 拼入 error）+ `toContain("恢复动作")`，非只断 ok:false，真 |
| B4 | `B4 非法 unitId（../escape、UPPER、空串）：add 返回 error 且文件系统无新目录` | 三种非法 id 循环拒绝 + 全新父前缀 `wt-b4-should-not-exist` 调用后不存在（连 mkdir 都未执行的零副作用证明），真 |
| B5 | `B5 reset 清 tracked 脏改与 untracked 文件/目录：porcelain 为空` | 真跑 `git status --porcelain`（reset 前断非空、后断空）+ `existsSync` 断 untracked 文件/目录已删，非字符串常量断言，真 |
| B6 | `B6 reset 保留已 commit 产出：文件仍在且 status 干净` | worktree 内真实 commit 后 reset，断文件存在 + porcelain 空，真 |
| B7 | `B7 remove --force 回收含脏文件的 worktree：目录消失且 worktree list 不再列出` | 见 §4 偏差 1 裁决——语义等价成立，真 |
| B8 | `B8 object store 共享（P-wt2）` | hash 取自 worktree 内真实 commit 的 `rev-parse HEAD`，主仓库真跑 `cat-file -t` 断 `commit`，真 |
| B9 | `B9 clone 携带 refs（P-wt3）` | 真跑 `git clone` 子进程（断 status 0）后 clone 内 `cat-file -t` = `commit`，真 |
| C1 | `C1 设 CW_PROJECT_DIR=<项目A> 且 cwd 在另一目录：status 读项目 A 的账本` | spawnSync 真跑 `dist/cli.js`（未绕过 CLI 层）；预置阶段在项目 A 内真跑 `cw create --id u-a`，查询阶段 cwd=别处 + env 指向 A，断 stdout 含 `u-a`、`specs:0` 且不含 `(空账本)`——若接线未生效必读 cwd 空账本而失败，真路由验证，真 |
| C2 | `C2 不设 env 时行为与现状一致：读 cwd 账本，空账本正常退出不报错` | exit 0 + `(空账本)` + stderr 空，真 |

契约层补充核验：`UNIT_ID_RE = /^[a-z][a-z0-9-]*$/` 与 `src/handlers/create.ts:20` 的 `SLUG_RE` 逐字节一致（§3「同规则」达成）；add 失败 error 文案与 §3 第 4 条模板逐字对齐；spawnSync 数组参数不经 shell、单步 timeout 120s（`GIT_STEP_TIMEOUT_MS`）。

## 4. 两处披露偏差裁决

**偏差 1（B7 断言形态）——裁决：合理，语义等价成立。**
实测证据（本机 git 2.52.0，真实 tmp 仓库探针）：
- `git worktree list` 的 worktree 行输出形态为 `<path>  <hash> [cw/<branch>]`——分支名以注释形式出现在该 worktree 行内；
- mkdtemp 返回 `/var/folders/...` 而 git 注册/输出 `/private/var/folders/...`（macOS 符号链接），路径逐字节比对确实会偶发失败（与 `tests/u4a-e2e.test.ts` 注释记录的同款坑）；
- remove 前后对比：before 含 `[cw/u-p6c]` 行，after 该行整行消失（分支名与路径同生同灭）。分支唯一（同名分支不能被两个 worktree checkout），故 `not.toContain("cw/u-b7")` ⟺ 该 worktree 行不在列表中 ⟺「不再列出该路径」。
- 测试还有 `existsSync(wt) === false` 双保险（目录消失），且 remove 失败时 `expect(res).toEqual({ ok: true })` 先挂——不存在「实际未删净但测试绿」的假阴通路。

**偏差 2（B4 附加断言 error 含「非法 unit id」）——裁决：合理加强。**
文档 B4 最低要求是「返回 error 且文件系统无新目录」；测试在满足最低要求（含零副作用证明）之上额外锁定用户可见错误文案。与实现文案一致、与 `create.ts` 的错误文案风格同构，不与任何文档条款冲突。判定为无成本的断言加强，接受。

## 5. 行为对抗抽查（verifier 自建探针，node 直调 dist/ 模块 + tmp + 环境隔离，9/9 PASS）

| # | 场景 | 结果 |
|---|------|------|
| P1 | `addUnitWorktree` 到非 git 仓库目录（repoDir 无 .git） | PASS：`{ok:false}` 未抛裸异常，error 含 git 原文（fatal/not a git repository），worktreeDir 未建成 |
| P2 | baseCommit 为全 f 假 hash | PASS：`{ok:false}`，error 含原文；**无残留目录、无残留分支**（比恢复动作文案暗示的更干净，git worktree add 失败自清理） |
| P3a | `resetWorktree` 指向不存在目录 | PASS：`{ok:false}`，error 含 git 原文与恢复动作，不崩 |
| P3b | `removeWorktree` 指向不存在 worktree（真 repo） | PASS：`{ok:false}`，不崩 |
| P4 | unitId = `a/b`（路径逃逸形态） | PASS：拒绝、零文件系统副作用（全新父前缀不存在）、error 含恢复动作 |
| P5 | CLI 子进程真跑 `dist/cli.js status`，`CW_PROJECT_DIR=relative/dir` | PASS：exit 1，stderr 单行 `CW_PROJECT_DIR 必须是绝对路径，当前值：relative/dir。恢复动作：…`（cli.ts 入口 `.catch` 打印 message，无裸 stack trace）——报错退出且信息可操作，非静默回退 cwd |
| P6a | worktree add 到已存在非空目录 | PASS：`{ok:false}`，原目录内容未被破坏 |
| P6b | 连续两次 remove（第二次目标已不存在） | PASS：第一次 ok，第二次 `{ok:false}` 不崩 |
| P6c | `git worktree list` 输出形态实测（偏差 1 裁决证据） | PASS：见 §4 偏差 1 |

探针 tmp 目录用后已清理，仓库与真实环境零污染（复查 `git status --short` 仍恰好 4 项）。

## 6. 总结论

**PASS。** 防篡改通过（文档 sha256 与基线 diff 为空，改动恰好限定四文件）；§7 四命令全过（297/297 全量绿，零行为变更得证）；§6 全部 15 条款断言语义真实无空洞；2 处披露偏差均裁决合理；verifier 自建 9 条对抗探针全部符合契约（Outcome 模式、错误可操作、无文件系统副作用泄漏）。
