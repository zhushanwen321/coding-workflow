# u2 验收报告：写命令（create / evidence submit / review submit）+ dispatch 填充

> verifier 独立验收报告（对照 `u2-acceptance.md` @ 552ae90）。验收日期：2026-08-15。
> 验收环境 HEAD：`431ced70755d0c1bf982501132cf64469461affa`（431ced7）。

## 总结论：PASS

## 1. 防篡改检查（3/3 通过）

| 项 | 命令 | 结果 |
|----|------|------|
| 验收文档未被篡改 | `git diff 552ae90 -- docs/rewrite/acceptance/u2-acceptance.md` | 空（无输出） |
| 文件 sha256 与基线一致 | `shasum -a 256` 工作区 vs `git show 552ae90:...` | 两侧均为 `4ee6677ecb1088e4cf4f41c68e507b1cea79afa1d4e260fbef4bfb171bff8756` |
| 契约层与已验收 unit 零改动 | `git diff 431ced7 --stat -- src/dispatch.ts src/cli.ts src/events/types.ts src/store/ src/core/ src/gates/` | 空（fe514f4 的 dispatch 修复已含于 431ced7，其后无新改动） |

`git status --short` 分类：

- u2 领地（合规）：`src/handlers/{index.ts(M), common.ts, create.ts, evidence-submit.ts, review-submit.ts, spec-schema.ts}`、`tests/u2-{create,evidence,review,e2e}.test.ts`
- u1b 领地（豁免）：`src/readonly/**`、`tests/u1b-*.test.ts`
- 认知外（非 u2 责任，待主 agent 处置）：`AGENTS.md(M)`、`.$wave-endstate-execution.drawio.bkp`、`wave-endstate-execution.drawio{,.png,.svg}`

无 u2 领地外的意外改动。

## 2. 命令实跑（3/3 通过）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0（src + tests 两轮 tsc 无错误） |
| `npx vitest run tests/u2-create.test.ts tests/u2-evidence.test.ts tests/u2-review.test.ts tests/u2-e2e.test.ts` | exit 0，4 文件 28 tests 全绿（create 9 / evidence 12 / review 6 / e2e 1，1.57s） |
| `npx eslint src/handlers/ tests/u2-create.test.ts tests/u2-evidence.test.ts tests/u2-review.test.ts tests/u2-e2e.test.ts` | exit 0，零输出 |

## 3. 真实性抽查（条款逐条对照，全部真实覆盖）

### 3.1 单测 5 组（验收文档「单测验收」逐条）

1. **create**（tests/u2-create.test.ts）：合法入账+briefRef 原样；重复 slug 拒+账本不变；非法 slug（大写/下划线/数字开头/空串 4 例）拒且 stderr 含 `^[a-z][a-z0-9-]*$`；--parent 不存在拒；三层嵌套拒（根→叶→再叶 exit 1，账本保持 2 条，错误含「深度」「2 层」）；brief 缺失拒。全部真实断言，走完整 dispatch 路径。
2. **evidence spec**（tests/u2-evidence.test.ts）：合法 → specHash 用 `node:crypto` 独立重算比对（不经被测辅助函数）；schema 错（acceptance[0] 缺 id + type 枚举外）→ stderr 含 `/acceptance/0/id` 与 `/acceptance/0/type` 字段路径；gate 不过两形态（空 acceptance → rule①/rule⑤ 原文；core manual → rule② 原文）→ exit 1、账本行数不变、stderr 逐条含 u3 failures 原文。
3. **evidence build**：commit 不存在（40 位格式合法伪造 hash `0123…67`）拒+账本不变；非十六进制格式拒（白名单正则）；产物文件缺失拒；合法 → sha256 独立重算一致、exitCode 0；同 runId 二次提交账本层拒（错误含「幂等」「恢复动作」，透传非改写）。
4. **review**：verdict-kind 枚举外拒；verdict 枚举外拒；--evidence-refs 引用不存在 runId 拒且逐个列出缺失项（run-x、run-y）；合法（含 comment/evidenceRefs）入账 payload 全量 toEqual；无可选字段时 payload 恰不含 comment/evidenceRefs 键（toEqual 精确匹配，非 toMatchObject）。
5. **dispatch 注册**：`findCommand(["create"])` / `(["evidence","submit"])` / `(["review","submit"])` 三命令命中、summary 非空。

### 3.2 E2E（tests/u2-e2e.test.ts，真实子进程 dist/cli.js + tmp git 仓库 + 隔离 CW_HOME）

- 完整序列 create（根）→ create（--parent）→ spec → build（真实 rev-parse HEAD commit + 双产物）→ review，每步 exit 0。
- **事件序列断言为强断言**：`events.map(e => e.type)` `toEqual(["UnitCreated","UnitCreated","SpecSubmitted","EvidenceSubmitted","VerdictSubmitted"])` 全量数组比较 + seq `[1,2,3,4,5]` + 恰 5 条 toHaveLength(5)。非弱断言（contains）。
- **spec gate 失败路径三要素齐全**：exit 1（`expect(bad.code).toBe(1)`）+ 账本行数不变（`countLedgerLines` 1→1）+ stderr 含 u3 原文（`rule①: spec.acceptance 为空（至少需要一条验收用例）`）。
- 事件内容关键事实全量断言：UnitCreated parentId/briefRef、specHash 独立重算、EvidenceSubmitted 的 commit/paths/sha256/exitCode、VerdictSubmitted payload。
- u1b status 未并入 → 按验收文档允许的替代路径用 readAll 直验（测试头注释已声明）。

### 3.3 commit 校验真实性（源码级核验，src/handlers/evidence-submit.ts）

- `COMMIT_HASH_RE = /^[0-9a-f]{6,40}$/`（第 37 行）真实存在，--commit 进命令行前先过白名单（注入防护）。
- `spawnSync("git", ["cat-file", "-e", \`${commit}^{commit}\`], { cwd: ctx.cwd })`（第 150 行）真实调用，`probe.status !== 0` → exit 1。非假实现（存在性检查不可绕过——对抗抽查 C 证实）。
- specHash 取 `sha256Hex(fileRead.raw)`（原始字节，非重新序列化）。

## 4. 行为对抗抽查（7 场景，dist/cli.js 直调，真实 tmp git 仓库 + 双 CW_HOME 隔离）

| # | 场景 | 实测行为 | 判定 |
|---|------|---------|------|
| A | 不同 CW_HOME 下同名 slug | home-a / home-b 各自 create `same-name` 均 exit 0（各自 seq 1，账本互不可见）；同 home 二次 create exit 1 | 符合预期（账本按 CW_HOME+cwd 隔离） |
| B/B' | spec.json 含未知多余字段 | typebox 默认放行（schema 不拒）；通过五规则的带多余字段 spec exit 0 入账——acceptance 条目内多余字段（`mysteryField`）原样保留，顶层多余字段（`topLevelExtra`）不进 payload（SpecSubmitted 只携 acceptance/contracts/split） | 验收文档未禁多余字段，与「acceptance/contracts/split 原样」一致，记录不判 fail |
| C | --commit 传 deadbeef×10（40 位格式合法但不存在） | exit 1，stderr 明示 `git cat-file -e '…^{commit}' 失败` + 恢复动作；账本行数不变 | git cat-file 真实拒绝，存在性检查有效 |
| D | CLI 层三层嵌套（根→叶→再叶） | exit 1，stderr：「分解深度超限…M0 上限 2 层（根 + 叶）」+ 恢复动作 | 与验收条款一致（单测之外 CLI 层复证） |
| E/E' | `--evidence-refs ""` | exit 0 入账，payload 含 `evidenceRefs: []` 空数组键——与省略该参数（无此键）有细微差异 | 验收文档未覆盖此边界，行为记录，不判 fail |
| F | create --parent 指向自身 slug | exit 1「--parent 不存在」（parent 校验先于自身入账，自引用环不可构造） | 行为安全，记录 |
| G | build --file 指向目录 | exit 1，errno `EISDIR` + 恢复动作 | 符合「路径存在可读」要求 |

**行为与验收文档矛盾项：无。**

## 5. 观察与建议（不影响 PASS，交主 agent 备案）

1. `--evidence-refs ""` 产生 `evidenceRefs: []` 空数组键（E'），与省略参数的 payload 形状不一致。M0 无害，后续 unit 若做 verdict 投影需注意空数组与缺键两种形态。
2. tests/u2-review.test.ts 前置种子用账本直写（`commit: "c0ffee"`）而非走 build 链路——文件头注释已声明分工理由（review 语义只关心 runId 存在，git 链路由 u2-evidence.test.ts 覆盖），验收文档第 4 条未要求完整链路，判定可接受。
3. 深度上限实现是「--parent 目标已有 parent 即拒」，只看一层回溯而非任意深图遍历——对 M0 的 2 层上限语义正确（账本不变式保证 parentId 只能指向已存在 unit，环不可构造，F 证实）。

## 6. 结论

防篡改 3/3、命令实跑 3/3、单测条款 5/5、E2E 条款全项、行为对抗 7 场景零矛盾。

**u2 验收：PASS。**
