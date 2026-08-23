# lv-1 验收报告：gate 规则⑫（路径逃逸词法拦截，fail 级）

> verifier 对抗式独立验收。基线：`docs/rewrite/acceptance/lv-1-acceptance.md`（commit `b18a6a5`）。
> 验收时 HEAD = `1f8b455`（lv-3 基线 commit，非工作区改动）。verifier 未修改任何代码/测试/基线文档。

## 总结论：PASS

## 1. 防篡改

| 项 | 结果 |
|----|------|
| `git diff b18a6a5 -- docs/rewrite/acceptance/lv-1-acceptance.md` | 空（与基线逐字节一致） |
| sha256 | `11480f9cd39c8f776a9b69514fea0159d17fac1dcba7495dca8bc5b86cc519fd` |
| `git rev-parse HEAD`（验收时） | `1f8b455` |

`git status --short` 全量扫描（10 项）逐条归因，**零越界**：

| 文件 | 归因 |
|------|------|
| `src/gates/spec-rules.ts` | lv-1 交付（5 hunks：模块头注释 / 函数头注释计数 / ⑫判定块 / DIRECTORY_FLAG_TOKENS 常量块——①-⑪逻辑零变更，al-3 回归 13 用例绿佐证） |
| `tests/lv1-path-escape.test.ts` | lv-1 交付（新增） |
| `docs/rewrite/acceptance/u3-acceptance.md` | lv-1 交付（§4.F 第 1 处：引言句 + 表⑫行） |
| `CONTEXT.md` | lv-1 交付（恰 4 hunks = §4.F 第 2/3/4 处；lv-2 段落改动尚未发生，无混入） |
| `AGENTS.md` | lv-1 交付（恰 1 hunk = §4.F 第 5 处 spec gate 行） |
| `src/readonly/frontier.ts` / `src/runner/loop.ts` / `src/runner/escalations.ts` / `src/handlers/run.ts` / `tests/u1b-e2e.test.ts` | lv-2 豁免清单内（对方领地） |
| `docs/rewrite/acceptance/lv-3-acceptance.md`（+143 行，出现在 `git diff b18a6a5` 但不在 git status） | commit `1f8b455` 已入 git 的 lv-3 基线，主 agent 产物，非 builder 改动 |

## 2. 命令实跑

| 命令 | 结果 | 归因 |
|------|------|------|
| `npm run build` | exit 0 | dist 为本次验收自建（含规则⑫，`dist/gates/spec-rules.js` 实核） |
| `npx vitest run tests/lv1-path-escape.test.ts tests/al-3-gate-rules.test.ts` | 2 文件 31 用例全绿 | — |
| `npx vitest run tests/al-3-gate-rules.test.ts tests/mx5-3-reviewer-brief.test.ts` | 2 文件 23 用例全绿 | 任务书写 `mx5-3-gate-input.test.ts` 不存在，实名 `mx5-3-reviewer-brief.test.ts` |
| `npx eslint src/gates/spec-rules.ts tests/lv1-path-escape.test.ts` | 零输出 exit 0 | — |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 | — |
| `npm run check:tests` | exit 0 | — |
| `npm test`（全量） | 80 文件 636 用例全绿（174s） | lv-2 领地亦绿，无需豁免归因 |
| `npm run lint`（全量） | 0 error + 1 warning：`src/runner/loop.ts:1044` `runLoopMain` 308 行超 300 上限 | lv-2 领地中途态，豁免归因，不算 lv-1 失败 |

## 3. T1-T12 条款对照（`tests/lv1-path-escape.test.ts` 实跑全绿）

| 条款 | 断言要点 | 结果 |
|------|---------|------|
| T1（S2-a） | `cd /Users/x/.cw-worktrees/u1 && pnpm test` exit 1 不入账；`规则⑫`×2（双判据全列）；文案含 `.cw-worktrees` / `相对路径` / `提交进仓库` | PASS |
| T2（S2-b） | `cd ~/project` 拒；命中片段含 `cd ~/project`；单条 failure | PASS |
| T3（S2-c） | `--root /Users/x/wt`（纯词法族）拒 1 条；`--root …/.cw-worktrees/u1` 拒 2 条（子串+族） | PASS |
| T4（S2-d） | `cd packages/app && …` exit 0 入账 | PASS |
| T5（S2-e） | `vitest --root md-reader run` exit 0 入账（相对值放行） | PASS |
| T6（S2-f） | `bash scripts/regression.sh` exit 0 入账 | PASS |
| T7 | manual 型 `cd /abs/path` 放行 | PASS |
| T8 | `cd "/abs/path"` / `cd '/abs/path'` 均拒（单/双引号各剥一层） | PASS |
| T9 | `-C` / `--dir` / `--prefix` 各跟 `/abs` 逐条拒；`grep -C 2` 放行 | PASS |
| T10 | gate 函数级 `failures`=1 条⑫ + `warnings`=1 条⑪ + `ok=false`；CLI 层 exit 1 + stderr 含⑫不含⑪ | PASS |
| T11 | e2e-real `git -C /abs/wt status` exit 1 + ⑫唯一 failure（③零干扰）+ 账本无 SpecSubmitted | PASS |
| T12 | unit / integration / e2e-real 型各含逃逸均拒 | PASS |

## 4. 真实性抽查（防空洞断言）

1. **T11 账本断言真读 events.log**：是。`tests/lv1-path-escape.test.ts:89-93` `specBooked()` = `new EventLedger(ledgerPath(cwHome, cwd)).readAll().some(e => e.type === "SpecSubmitted")`；`ledgerPath`（`src/store/project.ts:64`）= `join(cwHome, encodeCwd(cwd), "events.log")`，`readAll` 逐行解析。`freshCase` 用 `realpathSync` 对齐子进程物理 cwd（/var → /private/var 坑），账本路径计算真实命中——非只看 exit code。
2. **T5 与 T3 同一 gate 入口**：是。两者同走 `submitSpec()` → `runCli()` → `spawnSync(node, [dist/cli.js, "evidence","submit",…])` 完整 dispatch，唯一变量是 command 字符串。
3. **T10 双数组分别断言**：是。`gate.failures` 断言 `toHaveLength(1)` 且 `[0]` 含⑫；`gate.warnings` 断言 `toHaveLength(1)` 且 `[0]` 含⑪；另有 CLI 层负向锚（stderr 含⑫、`not.toContain("规则⑪")`）。非笼统 truthy。
4. **stripPairedQuotes 边界**：代码证明成立——`MIN_QUOTED_TOKEN_LENGTH=2` 短 token 原样；首字符为 `'`/`"` 且**尾字符与首字符相同**才剥（不成对原样返回）；`token.slice(1, -1)` 单次调用 = 只剥一层（双层 `""/abs""` 剥后仍带引号不拦）。T8 覆盖成对剥正向；「不成对不剥 / 只剥一层」无负向测试锚——见观察项 O2。

## 5. 行为对抗抽查（8 条，真实子进程 `node dist/cli.js` + tmp + 独立 CW_HOME `/tmp/cw-lv1-adv/cw-home`；每 case 独立 mktemp cwd（realpath）+ 独立账本 + grep events.log 核入账）

| # | 场景 | 预期（按基线字面） | 实测 | 判定 |
|---|------|------------------|------|------|
| A1 | `cd /abs&&pnpm test`（`&&` 无空格紧凑） | tokenize 后 `/abs&&pnpm` 以 / 开头 → 拦 | exit 1，1 条⑫，命中片段 `"cd /abs&&pnpm"`，不入账 | 符合——非漏报，词法族 token 化天然覆盖紧凑形态 |
| A2 | `bash -c 'ls .cw-worktrees'`（子串在引号内脚本参数位置） | 判据一无位置语义 → 拦 | exit 1，1 条⑫（`".cw-worktrees"`），不入账 | 符合基线「command 原文含子串」口径 |
| A3a | manual 型 + command 为空串 | tokenize 空 → 跳过放行 | exit 0，入账 | 符合 |
| A3b | unit 型 + 无 command 键（字段缺失） | `command ?? ""` → 空 → 放行 | exit 0，入账 | 符合 |
| A4a | e2e-real `cd /usr/bin/git status`（cd 后 token 是 PATH 可解析绝对路径形态） | ⑫拦；③首 token `cd` 可解析不干扰 | exit 1，唯一 failure = ⑫（`"cd /usr/bin/git"`），无③输出 | 符合——⑫与③不互扰 |
| A4b | e2e-real `/usr/bin/git -C /abs/wt status`（首 token 绝对路径形态） | ③含路径分隔符直接验可执行 → 过；⑫拦 `-C /abs/wt` | exit 1，唯一 failure = ⑫（`"-C /abs/wt"`） | 符合 |
| A5 | `"cd" /abs && pnpm test`（族 token 带引号） | 族成员须裸 token → 漏报放行（基线 D 明列） | exit 0，入账 | 符合 D 漏报面声明 |
| A6 | `vitest --root=/abs/wt run`（等号合写） | token `--root=/abs/wt` ≠ `--root` → 按字面漏报 | exit 0，入账 | 符合字面；但 D 清单未列此形态——观察项 O1 |
| A7 | `cd ../.. && pnpm test`（相对上跳） | D 明列漏报 → 放行 | exit 0，入账 | 符合 |
| A8 | 双条目 E1 `cd /abs1` + E2 `git -C /abs2` | exit 1 + 两条⑫各含自身 id | exit 1，2 条⑫（E1/E2 各一），不入账 | 符合多缺口全列 |

## 6. 文档一致性（§4.F 五处）

| 处 | 要求 | 实况 | 结果 |
|----|------|------|------|
| 1 | u3 表追加⑫行（对齐⑪行列形态：级别/两判据/族枚举/manual 豁免/漏报面/恢复方向） | 已追加，列要素齐全 | PASS |
| 2 | CONTEXT L35 十一→十二 | 已改 | PASS |
| 3 | CONTEXT 词条标题十二 + 段内⑪后追加⑫句（判据+fail 级+漏报面第五维兜底） | 已改，三要素齐 | PASS |
| 4 | CONTEXT 命令表 `evidence submit` 行计数十二 | 已改 | PASS |
| 5 | AGENTS spec gate 行十二 + ⑫ 短句（一条内判据+fail 级） | 已改 | PASS |

⑫ 内容与实现判据零漂移：词法族五枚 `cd` / `-C` / `--dir` / `--prefix` / `--root` 逐字符一致（`DIRECTORY_FLAG_TOKENS` 单一事实源，注释含「后续按真实逃逸案例增补，禁止散落多个函数」）；剥引号口径一致；manual 豁免 / tokenize 空跳过口径与规则⑨一致；一条 command 双判据出两条 failure（`pathEscapeGaps` 不短路）；fail 级（failures.push）；文案五要素（⑫ + 条目 id + 命中片段 + 失败事实 + 恢复动作）与 §4.C 模板一致；⑫位置在⑪后、return 前。

## 7. 误杀复扫

- `grep -rn "\.cw-worktrees\|cd /\|cd ~" tests/`（排除 lv1 测试自身）：仅 `tests/wt1-worktree.test.ts:87,89` 命中——是 `getCwWorktreeHome()` 返回值的函数级断言，**不入 spec command 字段**，不构成误杀。任务书提及的 `tests/u5-vitest.test.ts` 与 `tests/al-4-e2e-layer.test.ts` 边界核实：前者 command 均为 `npx vitest run … --reporter=json` 形态无命中；后者 `WT_HOME = join(tmpRoot, "cw-worktrees")` **无前导点**（子串判定不命中）且为测试自身 env 不入 command，`VITEST_BIN` 绝对路径处于首 token 位置（前 token 非族成员）不拦。builder「0 命中（spec 命令字段口径）」结论成立。
- 全量 `npm test` 80 文件 636 用例零翻红——既有测试因⑫误杀翻红 = 0（实锤）。

## 8. 观察项（不阻塞 PASS，供主 agent / 后续波次裁决）

- **O1**（基线设计边界，非实现漂移）：等号合写 flag 形态 `--root=/abs/wt`、紧凑无空格 `cd/abs`（族 token 粘连）按字面判定集漏报；基线 §4.D 漏报面清单未列。实现忠实于基线字面（token 严格相等匹配）。建议按 `DIRECTORY_FLAG_TOKENS` 注释的增补机制补等号合写形态或在 D 清单明列。
- **O2**（minor）：`stripPairedQuotes` 的负向边界（不成对不剥、只剥一层）无测试锚——代码逻辑正确但缺回归保护。
- **O3**（记录）：任务书回归命令所写 `tests/mx5-3-gate-input.test.ts` 不存在，实际回归用 `tests/mx5-3-reviewer-brief.test.ts`（23 用例绿）。
