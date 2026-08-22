# lv-1 验收标准：gate 规则⑫（路径逃逸词法拦截，fail 级）

> 设计依据：`.tmp/design-acceptance-layering.md` 无关；本波依据 `M6 自治运行活性与契约防护设计`（`.tmp/design-autonomy-liveness.md`）§3.3 D3 / §4 S2 / §5 波次 lv-1。
> **builder 与 verifier 禁止修改本文件**（防篡改锚点，基线已先行入 git）。

## 1. 目标

补 spec gate 的路径逃逸防线（回溯设计 G2）：验收 command 引用检出树外的绝对路径 / `.cw-worktrees` 工作区，会让 verify 结果绑定执行瞬间的工作区状态而非账本 commit——语义失效，提交期拒入账（fail 级，同规则⑩「真空声明」哲学）。触发案例：agent-managed-session u1 的 `cd <开发worktree绝对路径>` 打回 7 轮假循环（设计 §2.1）。

## 2. 交付物（文件级）

| 文件 | 变更 |
|------|------|
| `src/gates/spec-rules.ts` | 规则⑫ 纯函数判定 + 词法族枚举单一事实源 + 诚实漏报面注释 |
| `docs/rewrite/acceptance/u3-acceptance.md` | 规则表追加⑫行（fail 级判据 + 漏报面） |
| `CONTEXT.md` | 仅「spec gate 规则」相关四处（§4.F 精确锁定） |
| `AGENTS.md` | 仅 spec gate 行（十一规则 → 十二规则 + ⑫ 短句） |
| `tests/lv1-path-escape.test.ts` | 新增（零 mock，真实 CLI 子进程） |

## 3. 禁改清单（违反 = FAIL）

- `src/` 其余一切文件——尤其 `src/readonly/frontier.ts`、`src/runner/`（loop/escalations/brief/spawn）、`src/handlers/`、`src/testrun/e2e-sh.ts`（lv-2 / lv-3 领地，本波并行/后续开发）
- `tests/` 既有文件（预期零翻红：设计预扫 spec 命令字段全域 0 命中。若全量跑发现既有测试因⑫翻红 = 误杀面实锤，**如实记录并停下上报**，不得擅自改测试绕过）
- `docs/rewrite/acceptance/` 其余基线文件、`docs/rewrite/ledger.md`
- CONTEXT.md / AGENTS.md 中 §4.F 列出的四处之外的任何段落（lv-2 将并行改动同文件的其余段落——runner 循环行 / 环境变量表 / run 命令表，那是对方领地）

## 4. 实现形状（锁定）

### A. 判定集（两条判据，fail 级，纯词法不执行命令）

作用于**全部非 manual 型条目**（unit / integration / e2e-real / e2e-mock；manual 不执行命令豁免——同规则③作用域先例逻辑）；command 缺失或 tokenize 后为空则跳过（同规则⑨先例）。tokenize 口径与规则⑨一致：`(ac.command ?? "").trim().split(/\s+/).filter(t => t !== "")`。

1. **子串判定**：command 原文含 `.cw-worktrees` 子串（cw 专属工作区目录名，验收命令零合法引用面）。
2. **词法族判定**：某 token 命中目录选择词法族，且其**下一个 token 剥引号后以 `/` 或 `~` 开头** → 拦截。词法族 = `cd`、`-C`、`--dir`、`--prefix`、`--root`（`git -C` 由 `-C` 成员覆盖；判定要求后随绝对路径 token，`grep -C 2` 类数值后随不误拦）。剥引号 = 去除成对首尾单/双引号一层（`"/abs/path"`、`'/abs/path'` 均拦）；族成员本身必须是裸 token（`'cd'` 带引号前缀不匹配——诚实漏报面）。

### B. 词法族单一事实源

族枚举组织为模块内常量（如 `DIRECTORY_FLAG_TOKENS`），与 `ADAPTER_FLAG_CONTRACTS` 同型「单一事实源、可扩展枚举」风格，注释注明「后续按真实逃逸案例增补，禁止散落多个函数」。两判据共用一个返回缺口列表的内部函数（对齐 `jsonProductContract` 返回 `FlagGap[]` 的形态可自定，但**一条 command 命中两判据（如 `cd /x/.cw-worktrees/y`）出两条 failure**——多缺口全列不短路，对齐模块头既有约定）。

### C. 文案要素（每条 failure）

规则编号⑫ + 条目 id + 命中片段 + 失败事实 + 恢复动作，形态对齐规则⑥⑦⑧（编号 + 事实 + 恢复动作闭环）：

```
规则⑫: 验收 <id> 的 command 含路径逃逸（<命中片段：".cw-worktrees" 或 "<族token> <绝对路径token>" >）
——verify 在干净 checkout 执行（cwd = 检出树根），绝对路径 cd / .cw-worktrees 引用会让结果绑定
执行瞬间的工作区状态而非账本 commit。恢复动作：改用相对路径（cd packages/app && …）或
git -C <相对路径>；引用的脚本/文件必须提交进仓库（干净 checkout 只含账本 commit 的内容）。
```

### D. 诚实漏报面（写进规则注释，不静默）

`cd ../..` 类相对上跳（不以 / 或 ~ 开头）；`bash -c 'cd /abs && …'` 类引号包裹关键词（`'cd` 非裸 token）；`$(echo cd) /abs` 类动态构造与 env 拼接；`CW_WORKTREE_HOME` 自定义非默认工作区名（子串检查只盖默认 `.cw-worktrees`）。以上由 reviewer 第五维语义审兜底（lv-3 将在第五维文案点名路径逃逸，与本注释呼应）。

### E. 与既有规则的共存

- 规则⑫ 追加在⑪之后、return 之前（序号顺延）；①-⑪ 零变更（含 warning 路径）。
- 同一 command 可同时命中⑪（warning）与⑫（fail）：failures 含⑫条目、warnings 含⑪条目，`ok` 判定只看 failures（既有语义不变）。
- 作用域不含 `layer` 维度（topic/unit 层条目同等受检——逃逸面与层级正交）。

### F. 文档同步（精确四处 + 一行）

1. `docs/rewrite/acceptance/u3-acceptance.md` 规则表追加⑫行（表格列形态对齐⑪行）：fail 级、两条判据、词法族枚举、manual 豁免、诚实漏报面、恢复方向。
2. `CONTEXT.md` L35 附近「spec gate 十一规则」→「十二规则」。
3. `CONTEXT.md`「### spec gate 十一规则」词条标题改十二，段内⑪句后追加⑫一句（判据 + fail 级 + 漏报面由 reviewer 第五维兜）。
4. `CONTEXT.md` 命令表中 `evidence submit … 提交 spec（过十一规则 …）`行的计数改十二。
5. `AGENTS.md` spec gate 行：「十一规则」→「十二规则」，⑪ 句后追加⑫ 短句（一条内说完判据 + fail 级）。

## 5. 新增测试条款（`tests/lv1-path-escape.test.ts`，零 mock；e2e 条款走 `node dist/cli.js` 完整 dispatch 路径 + tmp git 仓 + 独立 CW_HOME）

T 系（gate 函数级，经真实 CLI 入账路径或直接调 checkSpecRules 的既有测试形态，对齐 `tests/al-3-gate-rules.test.ts` 范式）：

- **T1**（S2-a）`cd /Users/x/.cw-worktrees/u1 && pnpm test` → gate 拒，failure 文案含「.cw-worktrees」与「相对路径」恢复方向；该形态双判据命中时 failure 两条均列。
- **T2**（S2-b）`cd ~/project && pnpm test` → 拒（`~` 开头）。
- **T3**（S2-c 双形态）`vitest --root /Users/x/wt run`（不含 .cw-worktrees，纯词法族绝对值）→ 拒；`vitest --root /Users/x/.cw-worktrees/u1 run` → 拒。
- **T4**（S2-d 零误杀）`cd packages/app && vitest run app.test.ts` → 放行。
- **T5**（S2-e 零误杀专证）`vitest --root md-reader run`（相对 --root 值）→ 放行——词法族只拦绝对值。
- **T6**（S2-f 零误杀）`bash scripts/regression.sh` → 放行（wrapper 形态不枚举）。
- **T7**（manual 豁免）manual 型条目 command 含 `cd /abs/path` → 放行。
- **T8**（剥引号）`cd "/abs/path" && pnpm test` 与 `cd '/abs/path' && pnpm test` → 拒。
- **T9**（词法族逐成员）`-C` / `--dir` / `--prefix` 各跟 `/abs` 值的 command → 逐条拒；`grep -C 2 package.json`（数值后随）→ 放行。
- **T10**（多缺口与共存）一条 command 同时含⑪形态 A（无文件参数 `npx vitest run`）与⑫形态（`cd /abs`）→ failures 含⑫、warnings 含⑪、ok=false；既有①-⑪ 断言零变化（同文件回归）。
- **T11**（e2e 入账拦截）真实 `node dist/cli.js evidence submit --kind spec` 提交含逃逸 command 的 spec → exit 1 + stderr 含⑫文案 + 账本无新 SpecSubmitted 事件（不入账）。
- **T12**（多类型作用域）unit / integration / e2e-real 型条目各含逃逸 command → 均拒（作用域 = 全部非 manual）。

## 6. 通过命令

```bash
cd /Users/zhushanwen/Code/coding-workflow-workspace/fix-cw-test-split
npm run check:all
npx vitest run tests/lv1-path-escape.test.ts tests/al-3-gate-rules.test.ts tests/u2-acceptance.test.ts 2>/dev/null || npx vitest run tests/lv1-path-escape.test.ts tests/al-3-gate-rules.test.ts
npm run lint
# 全量（并行期若 lv-2 中途态挂，记录归因不算失败；串行后必须全绿）
npm test
```

## 7. 波后验收（verifier 执行，真实场景）

1. **S2 六形态真跑**（设计 §4）：tmp git 仓逐条提交 a-f 六种 spec，核对 a/b/c exit 1 不入账 + stderr 含改写方向、d/e/f 正常入账。
2. **误杀复扫**：`grep -rn "\.cw-worktrees\|cd /\|cd ~" tests/ docs/rewrite/acceptance/`（spec 命令字段口径）复核零命中（cw CLI 自身 `--root <rootId>` 为 unit id 语义不算），全量测试实跑零翻红。
3. **文档一致性**：§4.F 五处逐一比对——计数「十二」、⑫ 内容与实现判据一致。

## 8. status

| 字段 | 值 |
|------|-----|
| status | pending → building → built → verifying → verified → committed |
| 验收基线 commit | 本文件入 git 时的 commit |
