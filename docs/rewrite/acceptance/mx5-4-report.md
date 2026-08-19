# mx5-4 verifier 报告：builder→developer 机械改名 + mx5-2 R1/R2 覆盖补强

> 独立 verifier 验收报告（与 developer 无关的第三方）。验收对象：commit `e1aa49b`（前置 `d8e5df8`）。
> 基线：`docs/rewrite/acceptance/mx5-4-acceptance.md`（§1-§7 防篡改锁定）。验收日 2026-08-19/20。
> 备注：当前仓库 HEAD 为 `2918f21`（doc-4 基线 commit，仅新增 `docs/rewrite/acceptance/doc-4-acceptance.md` 54 行），
> 系 mx5-4 交付之后另一波次的 commit，不在本验收范围；本报告全部证据取自 `d8e5df8..e1aa49b` 区间，不受其影响。

## 总结论

**PASS（8/8 项全过，findings 3 条均不构成 FAIL 条件）**：除角色词替换与基线明文授权的新增（R1/R2 断言、D4 授权记档、N2 迁移指引文案、§8 status 流转）外，**零语义变化**——37 个可比文件经双重归一化方法逐行比对，不可还原差异行全部落在授权范围内，未发现任何夹带语义变更。

## 逐项判定

### 1. 防篡改链 — PASS

- 基线 §1-§7（第 1-58 行）HEAD 版与 `d8e5df8` 版 shasum 一致：`a5ae644f69c1f2f087e5cab67ef1b66a1f5a702c`（两侧相同）。
- 基线唯一变更 = §8 status 一行（1 行 +/-），基线第 3 行明文「§8 status 由主 agent 流转更新，不属于防篡改范围」——授权范围内。
- `git status` 干净（仅 untracked `.tmp/`）。
- commit 39 文件 = 基线 §2 清单（src 9 + tests 27（含新建）+ 文档 2 = 38）+ 基线自身 status 1 = 39，逐一对照吻合，无清单外文件。

### 2. 禁改独立复核 — PASS

- `git diff d8e5df8..e1aa49b -- src/testrun/ src/verify/ src/gates/ src/core/ src/store/ src/cli.ts src/dispatch.ts` 输出为空；`src/runner/spawn/pi.ts` 不在 commit 文件列表（零 diff）。
- pi.ts 核实：第 95 行 session 命名 `${req.unitId}-${req.role}`、第 105-106 行产物名 `${req.unitId}.${req.role}.stdout/.stderr` 均随 AgentRole 动态拼接；文件内零旧角色词字面量（grep exit 1）——「session 命名随角色自动跟随」主张成立。

### 3. 归一化还原比对（核心）— PASS

对 39 个 commit 文件中的 37 个可比文件（排除新建 `tests/mx5-4-developer-rename.test.ts` 与基线 status 文件）做**双重方法**比对：

- 方法 A（双向归一化）：旧/新两侧把 builder/developer 任意词形（含 Builder/Developer/BUILDER/DEVELOPER）统一为占位符后逐行 diff——可检测除角色词外的一切差异，且对旧文件原生「developer」普通词免疫。
- 方法 B（还原法，任务口径）：新版 developer→builder、Developer→Builder 还原后与旧版逐行 diff。

结果：

| 分类 | 文件数 | 明细 |
|------|--------|------|
| 双方法零差异 | 32 | 含全部 8 个 src 中的 6 个（loop/run/verify/human/spawn-types）+ 24 个测试 + AGENTS.md/CONTEXT.md |
| 仅方法 B 有差异（假差异） | 2 | `src/readonly/frontier.ts`（4 行）、`src/runner/brief.ts`（2 行）——旧文件原生含「developer」普通词（designer-developer 回炉等），被还原法反向替换污染；**方法 A 双向归一化零差异**，raw diff 逐行核对全部为角色词替换（注释 6 处 + ROLE_TASKS Record 键 `builder:`→`developer:` 及调用点 `ROLE_TASKS.builder(`→`ROLE_TASKS.developer(`），无逻辑变更 |
| 有真实差异（全部授权） | 3 | 见下表 |

**不可还原差异行清单（3 文件，共 70 diff 行，逐条判定）**：

| 文件 | 差异行 | 内容 | 判定 |
|------|--------|------|------|
| `src/events/types.ts` | 6 行（新增）+ 1 行（枚举改名） | role 联合类型 `"builder"`→`"developer"`（改名核心）；6 行「mx5-4 改名记档」注释块（触发「不得改名改义」纪律的例外授权说明 + 重放语义核实记述） | **预期**：基线 §2 明文授权「实施时在类型注释补一句授权记档」；6 行超出「一句」幅度已在 §8 备案（自包含且避开旧值字面量——字面量会击穿 N4），注释内容与基线 §3 重放语义条款一致，无代码逻辑变更 |
| `src/handlers/review-submit.ts` | 5 行 | `VERDICT_ROLES` 枚举值改名（核心）；错误文案新增「若你用的是改名前的实现角色旧值（mx5-4 起已拒收），迁移指引：改用 --role developer。」；其余为注释角色词 | **预期**：迁移指引为基线 §3 明文要求（「错误文案含迁移指引（--role developer 指向）」）；文案措辞通用化（不写旧值字面量）是同时满足 N4 零残留的必然选择，§8 已备案 |
| `tests/mx5-2-contract-replan.test.ts` | 59 行 | 新增 import `flakeReviewFacts` + R1-facts/R2-facts 两个 describe（facts 级直断言，基线 §5 授权）+ 3 处角色词跟随（注释 ×2 + `expect(haltRun.err).toContain("停止对该 unit 派发 developer")` 断言值跟随新文案） | **预期**：R1/R2 为基线 §5 明文授权新增；断言值跟随是文案改名的必要同步 |

**零个未授权差异行。** 形态覆盖证明（抽样远超 8 个文件要求，实际全量 37 个）：纯角色词（loop.ts:326-327 `DISPATCH_SHAPE` 的 `role: "builder"` 字面量）、camelCase 复合（u7-e2e.test.ts:617-619 `builderDispatches`→`developerDispatches`）、大写变体（wt5-parallel-contamination.test.ts:343-502 `BuilderDispatchRecord`→`DeveloperDispatchRecord` ×3 处）、ROLE_TASKS Record 键（brief.ts:59/463）、role 联合类型（types.ts:114）、VERDICT_ROLES（review-submit.ts:46）。

### 4. 零残留独立复跑 — PASS（基线口径）/ finding F1（全大写形态残留）

- 基线 N4 严格口径 `grep -rn "builder" src/ tests/ AGENTS.md CONTEXT.md`（区分大小写）：**零命中**（e1aa49b 树与当前 HEAD 树均验证，exit 1）。
- `grep -rn "Builder"`：零命中。`grep -rin "builder"`：**2 处命中**——`tests/u5b-e2e.test.ts:220,222` 的 `BUILDER_IMPL_DISPATCH_LINE` 常量名（值为新角色词 `'派发 developer → unit "impl"'`）。见 F1。
- 清扫边界：`archive/`、`docs/rewrite/`（除基线 §8 status 行）、`.xyz-harness/` 零触碰（diff --name-only 仅基线文件一条）。
- 267 处口径复核：`d8e5df8` 树按行计数（`grep -c` 累加）= **267**，与基线 §2 吻合；逐匹配计数（`grep -o`）= 279（12 行内含多个角色词），基线采用按行口径（见 F3）。

### 5. 验收命令复跑 — PASS

- `npm run check:all`：tsc src + tests 双配置零错误。
- `npm run lint`：eslint src/ tests/ 零输出。
- `npx vitest run tests/mx5-4-developer-rename.test.ts tests/mx5-2-contract-replan.test.ts`：**22/22 通过**（mx5-4 5 用例 + mx5-2 17 用例）。
- 全量 `npm test`：**69 文件 / 534 用例全绿**（136.46s），与 §8 交付声明一致。

### 6. N1-N3 条款审查 — PASS

- **N1**（tests/mx5-4-developer-rename.test.ts:313-422）：真走完整 dispatch 链——`spawn` 子进程 `node dist/cli.js run --root root --spawn human --poll-ms 200`，断言覆盖：派发行「派发 developer → unit "root"」（:341）、brief 文件名 `root.developer.brief.md`（:353）、内容 `# developer 任务书` + `## 你的任务（developer）`（:355-356）、产物 `root.developer.stdout/.stderr` 存在且 stdout 含 `[human] developer 指令`（:361-364）、verified 后转派 reviewer（:386-390）、真实 CLI 代答 exec-review pass（:393-398）、runner exit 0 + 投影 closed（:411,415）、全链 stdout/stderr 零旧角色词（:413-414）。
- **N2**（:185-230）：成对断言——旧值 `--role` → exit 1 + stderr 含 `非法 --role` + 合法值清单含 developer + `--role developer` 迁移指引 + 账本事件数不变（纯拒绝）；对照组同命令 `--role developer` → exit 0 正常入账且 payload.role=developer。「测试内拼装」实现核实：`LEGACY_ROLE = ["buil","der"].join("")`、`LEGACY_ROLE_CAPITALIZED = ["Bui","lder"].join("")`（:77-79），全文件无旧值字面量，N4 扫描不被自我击穿。
- **N3**（:232-285）：双向——直写历史形态账本（`appendRawVerdict` 绕过类型化 append，:169-179，信封字段与 EventLedger.append 逐字段一致）构造旧角色值 verdict：exec-review pass → `closed`（:259，fold 对 exec-review 不比对 role）；spec-review pass → 停 `created`（:282）+ 同账本对照组 reviewer pass → `spec-frozen`（:283）。改名前后重放语义一致得证。

### 7. R1/R2 红性复验 — PASS（双红 + 恢复干净）

- **R1**：临时删 `src/readonly/frontier.ts:467-472`（flakeReviewFacts 的 parseFailed 排除分支）→ rebuild → `npx vitest run -t "R1-facts"` **1 failed**（:395 `expect(...).not.toContain("E1")` 失败，解析失败条目混入 flake 输出）→ `git checkout --` 恢复。
- **R2**：临时删 `src/readonly/frontier.ts:583-587`（specContractFacts 的中间解析成功清零循环）→ rebuild → `-t "R2-facts"` **1 failed**（:415 `mid.streaks.length === 0` 失败，v1 计数未被 v2 清零）→ 恢复。
- 恢复后：`git diff` 空、`git status` 仅 untracked `.tmp/`、R2-facts 复绿——两条断言对各自被测逻辑均有区分力，非恒真测试。

### 8. V4 波后场景（verifier 独立 human spawn 链）— PASS

tmp 目标项目（mktemp + git init 单 commit）+ 隔离 `CW_HOME`/`CW_WORKTREE_HOME` + 直写最小账本（UnitCreated + SpecSubmitted + reviewer spec-review pass）→ `node dist/cli.js run --root root --spawn human --poll-ms 200`：

- 派发行 `[runner] ... 派发 developer → unit "root"`（worktree + brief 路径内联）。
- brief 文件名 `root.developer.brief.md`，标题 `# developer 任务书：unit "root"`，旧角色词零出现。
- topic 目录产物 `root.developer.brief.md` / `root.developer.stdout` / `root.developer.stderr`；stdout 含 `[human] developer 指令：unit "root"`，旧角色词零出现。
- 代答 EvidenceSubmitted + VerifyRan（pass）→ runner 派发 reviewer（`root.reviewer.brief.md`，角色面不受改名影响）。
- 真实 CLI `review submit --verdict-kind exec-review --verdict pass --role reviewer --evidence-refs v4-run` exit 0 → runner 正常退出（成果分支 cw-root/root + 回流指引输出）。
- 最终投影 `cw status`：`root closed`。
- 全链（runner.out/err + topic 全部产物）大小写不敏感旧角色词零出现。tmp 目录已清理（`ls /tmp/cw-mx54-v4-*` no matches）。
- 过程注记：首次尝试因 macOS `/tmp`→`/private/tmp` symlink 导致 encodeCwd 不一致被 runner 拒绝（`--root 不存在`），改用 realpath 后通过——环境问题非交付缺陷。

## Findings（3 条，均不构成 FAIL）

- **F1（minor）全大写旧角色词子串残留 2 处**：`tests/u5b-e2e.test.ts:220,222` 常量名 `BUILDER_IMPL_DISPATCH_LINE`。按基线 N4 字面口径（区分大小写 grep）与 §4 点名的「大写变体 `Builder`」口径均不违规（`grep -rn "Builder"` 零命中），且该常量是测试内部局部标识符、值已更新为新角色词，无语义影响；但 developer §8 自述「grep 零残留含大写变体」与全大写形态实况不符，且 N4 测试的 `LEGACY_ROLE_CAPITALIZED` 只覆盖 `Builder` 不覆盖 `BUILDER`（口径盲点）。建议：下波次将该常量改名（如 `DEVELOPER_IMPL_DISPATCH_LINE`）或在基线明确「全大写标识符名不在清零范围」。
- **F2（minor，判预期）授权记档幅度超基线字面**：types.ts 记档为 6 行注释块，基线 §2 写「补一句」。§8 已备案（自包含 + 避开旧值字面量），内容为重放语义锁定的重述，判定为预期；提示后续基线对授权新增的粒度描述与实施对齐，避免「字面授权 vs 备案偏离」的判定摩擦。
- **F3（info）计数口径未注明**：基线 §2「267 处」为按行计数口径；逐匹配口径为 279。两种口径均确认全量替换（区分大小写零残留），建议后续基线注明计数方法。

## 证据命令索引（verifier 实跑）

```
git diff d8e5df8..e1aa49b -- src/testrun/ src/verify/ src/gates/ src/core/ src/store/ src/cli.ts src/dispatch.ts  # 空
git show d8e5df8:... | sed -n '1,58p' | shasum  # == HEAD 同段（§1-§7 一致）
grep -rn "builder" src/ tests/ AGENTS.md CONTEXT.md  # 零命中
npm run check:all && npm run lint                  # 零错误
npx vitest run tests/mx5-4-developer-rename.test.ts tests/mx5-2-contract-replan.test.ts  # 22/22
npm test                                           # 69 文件 534 用例全绿
# R1/R2 红性：删 frontier.ts:467-472 / :583-587 → 定向测试各 1 failed → 恢复 → diff 干净
# V4：mktemp 项目 + 隔离 CW_HOME + node dist/cli.js run --spawn human → developer 派发/产物/转派/closed + 全链零旧词
```
