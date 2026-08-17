# fx-4 验收标准：spawn 产物收口 topic 目录

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：`docs/rewrite/design-topic-artifacts.md` v1.1（P1-P4 用户拍板 + 对抗审查修复版）。
> 定位：单波承载（P4）——spawn 产物迁 `~/.cw/topic/<encoded-cwd>/<runTs>-<rootId>[-N]/`，worktree 纯化（删 `-e` 补偿），三类原文副本入 evidence，场景 4 反向断言补齐，worktree.ts 头注释 v2 旧口径修正。

## 1. 目标

worktree 内只剩 agent 业务产出与 commit（fx-4 by construction 消失）；spawn 日志按 run 归档永久保留；审计自包含（spec/build/brief 原文可从 evidence 重读）。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/runner/spawn/types.ts` | +字段 | `AgentSpawnRequest.artifactDir: string`（必填）；`SpawnResult` 注释同步（产物在 topic） |
| `src/store/project.ts` | +函数 | `topicDir(cwHome, projectCwd, rootId): string`——`<cwHome>/topic/<encodeCwd(projectCwd)>/<runTs>-<rootId>`，**runTs 秒级 + existsSync 探测冲突时 `-2`/`-3` 递增后缀**（设计 D1） |
| `src/runner/loop.ts` | 修改 | runLoop 启动建 topic 目录一次（全 run 复用）；writeBriefFile 落盘迁 `<topicDir>/<unitId>.<role>.brief.md`（覆盖写不变）；派发点 spawn req 传 `artifactDir = topicDir`；escalation/idle 文案路径跟随 + 「历次运行的完整输出」改「本次 run 的历次输出」（设计 D6 措辞） |
| `src/runner/spawn/pi.ts` | 修改 | artifactPaths 从 `req.workdir/.cw-spawn/` 改 `req.artifactDir/`（文件名 `<unitId>.<role>.stdout/.stderr` 不变） |
| `src/runner/spawn/human.ts` | 修改 | 同上产物改源；指令落盘/占位 stderr 同迁 |
| `src/runner/worktree.ts` | 修改 | `resetWorktree` 的 clean 改裸 `clean -fd`（删 `-e .cw-spawn` 与相关文案）；**头注释 v2 旧口径修正**（「unitId 唯一性只在 root 子树内」→ 账本级唯一 + ref 树隔离 + 归属排查，对齐 design-worktree-isolation.md v3 D2） |
| `src/handlers/evidence-submit.ts` | 修改 | submitSpec 与 submitBuild 的 `--file` 均新增原文 copy：`evidence/<unitId>/attachments/<sha256(内容)>.<原文件名>`（幂等，同内容零增长） |
| `src/handlers/create.ts` | 修改 | brief 原文 copy 同布局 `attachments/<sha256>.<原文件名>` |
| `tests/fx4-topic-artifacts.test.ts` | 新建 | §5 条款 |
| `tests/` 既有 | 迁移 | §6 两类迁移（路径迁移 / 语义反转重写）+ 字面量补字段 |

## 3. 禁改清单（违反 = FAIL）

- `src/runner/integrate.ts`、`src/runner/spawn/lifecycle.ts`（只管传入路径，零改动）、`src/verify/`、`src/core/`、`src/events/`、`src/cli.ts`、`src/readonly/`
- 账本 schema/事件类型零变更；`evidence/<unitId>/<runId>/` 既有布局不变（attachments 为纯增量）
- `docs/`、`archive/`、配置；既有测试改动仅限 §6 两类迁移 + 补字段，禁改逻辑/删测试/放宽断言

## 4. 关键口径（锁定）

- **topic 目录 run 级唯一**：runLoop 启动创建一次；同 run 内所有派发（含重派、换角色）共用；同秒重跑递增后缀；跨 run（≥1 秒）自然新目录。
- **brief 覆盖写、stdout/stderr append**（设计 D2：brief 内容随投影变，append 会拼接多版本任务书；lifecycle `openSync("a")`/human `flag:"a"` 不变）。
- **artifactDir 传递**：runner 显式传，适配器只拼文件名——适配器不感知 topic 布局。
- **worktree 内不再有 `.cw-spawn`**：agent 自建的 `.cw-spawn` 是普通 untracked，被 clean 是正确语义。

## 5. 新增测试条款（tests/fx4-topic-artifacts.test.ts，真实子进程 + tmp + CW_HOME 隔离，零 mock）

- **T1 产出纯净（场景 1）**：human/fake 全链跑至 unit closed → agent 的 evidence commit 树不含任何 `.cw-spawn` 路径（`git ls-tree -r --name-only <commit>` 断言）；worktree 内不存在 `.cw-spawn` 目录；brief/stdout/stderr 全在 topic 目录且文件名形态 `<unitId>.<role>.*`。
- **T2 清理极简（场景 2）**：worktree 预置 tracked 脏 + untracked + 手工伪造 `.cw-spawn/x` → 重派 → porcelain 全空（伪造目录一并被清，无任何例外条款）；已 commit 产出保留。
- **T3 归档与碰撞（场景 3）**：同 run 重派两次 → 同一 stdout 文件含两段内容（append）；退出后间隔 ≥1s 再跑 → 新 topic 目录（runTs 不同）；同秒重跑（测试内直接两次调用 topicDir 或两次快速 runLoop）→ `-2` 后缀目录出现、零静默混卷。
- **T4 原文副本（场景 3）**：spec 提交、build --file 提交、cw create --brief 三类 → `evidence/<unitId>/attachments/<sha256>.<原文件名>` 存在且逐字节等于原文；同内容重复提交不新增文件（幂等）。
- **T5 human 接管 + 反向断言（场景 4）**：人按指引 cat topic 内 brief、cd worktree 改码 commit、内联前缀提交 → 事件写项目账本、循环推进；反向：**故意不带前缀**跑 `cw create`（写命令）→ `~/.cw/` 出现 `<encoded-worktree>` 分裂空账本目录（补齐 design-worktree-isolation.md §4 场景 4 承诺、wt-2 未执行的断言）。

## 6. 既有测试迁移（两类分开，实测口径）

- **路径迁移**：`.cw-spawn` 断言目标从 worktree 路径换 topic 路径（`CW_HOME` 隔离下断言 `<cwHome>/topic/<encoded>/…`）——88 处代码引用/16 文件（wt2×18、wt1×10、wt3×9、wt4、u7 系、fx 系等）；其中断言「项目 cwd 无 .cw-spawn」的升级为「worktree 内无 .cw-spawn」。
- **语义反转重写**：wt1 B5 与 wt3 的「`.cw-spawn` 保留断言」（`-e .cw-spawn` 时代）→ 重写为「伪造 `.cw-spawn` 被清、topic 产物不在 worktree 所以无东西可保护」。
- **字面量补字段**：14 个测试文件手写 `AgentSpawnRequest` 处补 `artifactDir`（值 = 测试 tmp 下的 topic 路径；TS 编译强制全量覆盖）。

## 7. 通过命令（自验全过才算完成）

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/feat-optimize-parallel-wave
npm run check:all                                    # exit 0
npx vitest run tests/fx4-topic-artifacts.test.ts     # 全绿
npx eslint src/ tests/fx4-topic-artifacts.test.ts    # 零输出
npm test                                             # 全量绿（323 基线 + 新增，本波不留红）
```

## 8. status 字段

全部通过 → 汇报文件清单 + 各命令输出尾部 + §5 条款对照 + §6 迁移清单（文件 × 类别 × 处数）；未达成如实说明；实现与本文档冲突时披露冲突点与处理理由。
