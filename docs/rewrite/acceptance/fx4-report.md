# fx-4 验收报告（spawn 产物收口 topic 目录 + worktree 纯化 + 三类原文副本 + 场景 4 反向断言）

> verifier 独立对抗式验收，2026-08-17。基线 commit `0642d15` 的
> `docs/rewrite/acceptance/fx4-acceptance.md`（防篡改对象），设计依据
> `docs/rewrite/design-topic-artifacts.md` v1.1。
> **总结论：PASS**。

## 1. 防篡改

| 检查 | 结果 |
|------|------|
| `git diff 0642d15 -- docs/rewrite/acceptance/fx4-acceptance.md` | 空（0 字节，无篡改） |
| 基线文件 sha256 | `f2b31528a6a14e55b35c26732559f8d699514a2b1bcc5b572c7eb66c356d86b4` |
| 设计文档 sha256（参考记录） | `4a57ec77bace306f8a5a5d08d0b9a2f7c22dbf0e022b17835708f77de7aba1bd`（design-topic-artifacts.md） |
| `git status --porcelain` 改动范围 | src 恰好 9 文件（spawn/types、store/project、runner/loop、spawn/pi、spawn/human、runner/worktree、handlers/common、handlers/evidence-submit、handlers/create）+ tests 16 改 + 1 新（`tests/fx4-topic-artifacts.test.ts`）——与 §2 交付物表逐一对应 |
| 禁改清单（integrate.ts / lifecycle.ts / verify/ / core/ / events/ / cli.ts / readonly/ / docs/ / archive/ / 配置） | 零触碰（`git diff 0642d15 --` 上述路径均为空） |
| `lifecycle.ts` 与基线逐字一致 | `git diff 0642d15 -- src/runner/lifecycle.ts` 0 字节 |
| 既有测试改动纪律 | 抽查 wt1/wt2/wt3：全部为 §6 两类迁移（路径迁移 / 语义反转重写）+ 字面量补字段，断言均为收紧（porcelain 归零）或等强度平移，未发现删测试 / 放宽断言 / 改逻辑 |
| 未跟踪文件 | 仅 `?? tests/fx4-topic-artifacts.test.ts`（无夹带） |

## 2. 通过命令实跑（基线 §7）

```
npm run check:all                                 exit 0（check + check:tests 均过）
npx vitest run tests/fx4-topic-artifacts.test.ts  Test Files 1 passed (1) / Tests 8 passed (8)，Duration 8.88s
npx eslint src/ tests/fx4-topic-artifacts.test.ts exit 0，零输出
npm test                                          Test Files 47 passed (47) / Tests 331 passed (331)，Duration 83.17s（= 323 基线 + 8 新增，与 builder 自报一致）
```

fx4 单跑 8 条（verbose 实跑）：T1 全链 741ms、T2 清理 897ms、T3a append 1051ms、T3b 跨 run 2265ms、T3c 同秒碰撞 194ms、T4 原文副本 305ms、T5 正向 1434ms、T5 反向 771ms——全部真实子进程 / 真实 git（Duration 8.88s 与零 mock 声明相符）。

## 3. 真实性抽查（读 tests/fx4-topic-artifacts.test.ts 代码 + verbose 单跑）

1. **T1 ls-tree 断言为真**：`git ls-tree -r --name-only cw-root/t1`（L333）查的是 runLoop 真实推进产生的 root 分支（builder onSpawn 内 `git rev-parse HEAD` 真实 commit），非 fixture 固定值；且反向断言前提 `treeFiles` 含 `app-t1.txt`（L335，防「树上本来就空导致断言空洞」）。topic 三角色 brief/stdout/stderr 存在性断言（L338-342）+ `req.artifactDir === topic` 契约断言（L344-346）齐全。
2. **T3 碰撞非 mock 时钟**：t3c 用 `topicDir` 直调两次 + 真实 `existsSync` 探测（L473-483），跨秒防抖最多 5 轮重试后断言 `dir2 === dir1 + "-2"`——被测函数真实跑；t3b 跨 run 场景 `sleep(1_100)` 后断言 `dir2 !== dir1` 且同父目录、`basename` 不同、旧目录并存保留（L463-468）。append 断言（L421-424）含两段内容 + 先后顺序。
3. **T4 零增长为列表比对**：spec 侧 `attachmentsOf(...)` 用 `readdirSync` 列表 `toEqual` 全等（L530，单文件精确列表）；build 侧 before/after 列表 `toEqual`（L550）——非只断存在；逐字节断言用 Buffer `equals`（L526/543/560）。
4. **T5 反向双断言为真**：分裂账本目录 `existsSync(join(cwHome, encodeCwd(wtDir)))`（L648）+ stray `UnitCreated` 落分裂账本（L650）+ 项目账本无 stray（L653）三重断言；正向全链为真实 CLI 子进程（`spawnSync(process.execPath, [CLI_PATH, ...])`，cwd=worktree，CW_PROJECT_DIR 注入，L573-579），事件断言读真实账本 `EvidenceSubmitted`（L626-627）。
5. **T2 双断言为真**：porcelain 全空（L392）+ `.cw-spawn` 目录消失（L394）+ tracked 脏改回滚为内容逐字比对（L395）+ 已 commit 产出存在且内容断言（L397-398）。

## 4. 行为对抗抽查（真实子进程 + tmp + CW_HOME/CW_WORKTREE_HOME 隔离，探针在 /tmp 用后已清理）

| # | 探针 | 预期 | 实测 | 结论 |
|---|------|------|------|------|
| 1 | CW_HOME 隔离与真实 home 零污染：全部对抗场景 CW_HOME/CW_WORKTREE_HOME 指向 /tmp 下全新深路径；前后对 `~/.cw` 与 `~/.cw-worktrees` 全量快照比对 | 全部产物（topic/evidence/worktree）落 tmp CW_HOME；真实 home 与本仓库相关条目零新增 | maxdepth-3 快照 md5 前后一致；全量行数 +14 经查全部属并行会话（xyz-agent-workspace feat-plugin-optimize / feat-rename-session-sidebar 的真实 cw 流程产物），验收窗口（23:20 后）`~/.cw`/`~/.cw-worktrees` 中 coding-workflow 相关条目零新增 | PASS |
| 2 | escalation 文案路径真实性：真实 spawnProcess 子进程（`/bin/sh -c "echo esc3-burst-N; sleep 5"` + timeoutMs 400）连续 2 次真实 TIMEOUT | 文案 stdout 路径指向 topic 内产物且该文件真实存在 | escalation exit 1、calls=2；文案中路径与实际产物文件**逐字符相等**且存在；超时 SIGKILL 前第 1 发输出仍在文件；措辞为「本次 run 的历次输出」（旧措辞「历次运行的完整输出」已消失） | PASS |
| 3 | stdout append 极限（意外制造 482 轮重派现场：exitCode 0 但无账本进展的 /bin/sh spawn 在 60s maxIdle 窗口内被密集重派 482 次，每次经真实 lifecycle `openSync("a")` 写一段） | 同一 topic 目录同一 stdout 文件按次累积、顺序不乱 | 文件 481 行 = 1×seg-1 + 480×seg-2，seg-1 在最前（首发行位置正确）；worktree 内零 `.cw-spawn` | PASS |
| 4 | brief 覆盖写极限：同上 482 轮重派后读 brief | 单份（append 会拼接出 482 份任务书） | 标题 `# designer 任务书：unit "…"` 恰 1 次、全文 26 行单份量级；另一 8 轮重派场景 `workdir:` 行恰 1 次 | PASS |
| 5 | attachments 内容寻址真幂等（真实 CLI 子进程 `node dist/cli.js`）：v1 提交 → 篡改为 v2 同 runId 重提 → 改回 v1 同 runId 重提（payload 与首次全同 → DuplicateEvidenceError 幂等分支） | 篡改后新 hash 文件出现；幂等命中 exit 0 且零增长；副本逐字节等于原文 | 三次 exit 全 0；attachments 恰 2 文件 = `sha256(v1).out.txt` + `sha256(v2).out.txt`，内容逐字节等于对应原文；幂等分支输出「已入账（幂等命中）…」 | PASS |
| 6 | worktree 纯净极限：23 行脏现场（tracked 脏改 + 20 个 untracked 文件 + 4 层深嵌套目录树 + `.cw-spawn/x` 与 `.cw-spawn/nested/deeper/y` 双层嵌套）→ `resetWorktree` | porcelain 全空、全部伪造消失（无任何例外条款）、tracked 回滚、已 commit 产出保留 | `porcelain-after === ""`；`.cw-spawn`/`deep`/`junk-*` 全消失；`a.txt` 回滚为 `base\n`；`done.txt` 保留且内容不变 | PASS |
| 7 | 自扩展①CW_HOME 相对路径：`CW_HOME=relative-path` 跑 CLI；②topic 父目录不存在：全部场景 CW_HOME 均为不存在的深层新路径 | ①报错含可操作恢复动作；②runLoop `mkdirSync recursive` 建成 | ①`CW_HOME 必须是绝对路径…恢复动作：改为绝对路径…`；②全部场景 topic 目录在全新 CW_HOME 下正常创建 | PASS |

## 5. builder 4 处披露逐条裁决

1. **`src/handlers/common.ts` 新增 `copyAttachmentToEvidence`**——**合理落点，不越界**。§3 禁改清单未含 common.ts；函数被 evidence-submit.ts（成功 + 幂等两分支）与 create.ts 三处调用，内联将重复三份；common.ts 本就是 handler 公共工具层（sha256Hex/readOrErrno/ledgerForCwd 同居）。实现语义纯：copy 失败不阻断入账、stderr 出声含恢复路径。
2. **迁移计数 91 vs 验收文档 88**——**口径差异，非实质问题**。verifier 实测基线 `0642d15` tests/ 中 `.cw-spawn` 全量出现 93 处/16 文件（git grep 全口径，含注释行）；88/91/93 差异全部来自注释行计入口径。**16 文件数与验收文档完全一致**，两类迁移性质（路径迁移 / 语义反转）分开落实，§6 实质要求满足。
3. **字面量补 `artifactDir` 实际 4 文件 5 处 vs 预估 14 文件**——**成立，无缺口**。实测 `artifactDir:` 赋值恰 4 文件 5 处（u6b×2、u7-loop、u6c、wt2）；其余测试文件的 fake adapter 只消费 `req.artifactDir`（req 由 runLoop 构造）不直构字面量，预估 14 是设计期高估。tsc 强制无缺口的三重验证：①`types.ts` 中 `artifactDir` 必填（无 `?`），`dist/runner/spawn/types.d.ts:24` 同步；②全仓无 `as AgentSpawnRequest` 断言绕过（唯一 `Partial<AgentSpawnRequest>` 是 u6c baseReq helper，defaults 已含 artifactDir）；③`check:all`（含 check:tests）exit 0 = 所有直构点已补。
4. **build 幂等命中（DuplicateEvidenceError → exit 0）分支补 attachments copy**——**合理增强，行为正确**。语义：内容寻址 no-op（同 hash 覆盖同路径），兜住「上次 copy 失败、本次重试补齐」的恢复路径，与 §2「幂等，同内容零增长」一致。对抗探针 #5 实测该分支 exit 0 + attachments 恰 2 文件零增长。注：该分支的 copy 落地无仓库内直接测试断言（T4 的 build 幂等走的是不同 runId 新事件路径），由本报告探针补验——见 §6 minor-3。

## 6. Minor 观察项（不阻断 PASS，留待后续波次）

1. `src/runner/spawn/lifecycle.ts` L43/L103 注释仍写「按 `.cw-spawn/` 约定命名」——禁改文件零改动（合规），但注释口径已过时（产物根现为 topic 目录，命名由适配器拼）。
2. escalation 文案硬编码「跨 run 历史在 `~/.cw/topic/` 下按 runTs 目录可查」——CW_HOME 隔离场景实际为 `<CW_HOME>/topic/`。设计 D6 原文即用 `~/.cw` 表述，跟随设计非 bug；若后续追求精确可改「CW_HOME（默认 ~/.cw）」。
3. build 幂等命中分支的 attachments copy 无直接单测断言（行为经本报告探针 #5 验证正确）。
4. 对抗现场观察：exitCode 0 但无账本进展的 spawn 会被密集重派（60s 窗口实测 482 次，每次覆盖写 brief + append stdout）——u7 既有重派语义，非本波引入，仅记录。

## 7. 总结论

**PASS**。防篡改（基线文档 diff 空、禁改清单零触碰、lifecycle 逐字一致）、四条通过命令全绿（331 = 323 基线 + 8 新增）、T1-T5 五组新测试真实性核验通过（断言数据源为真实账本 / 真实 git / 真实子进程，无空洞断言）、7 条行为对抗抽查全过、4 处披露全部裁决为可接受（其中 2 处为口径 / 预估差，1 处合理落点，1 处合理增强）。fx-4 目标达成：worktree 内不再有任何 cw 自身文件（`add -A` 卷产物 by construction 消失）、spawn 日志按 run 归档永久保留、三类原文副本入 evidence 可重读。
