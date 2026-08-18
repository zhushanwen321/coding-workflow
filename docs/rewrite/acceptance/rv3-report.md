# rv-3 验收报告：契约比对强化（文档宿主排除 + 归一化比对）

> verifier 独立验收报告（对抗式，builder 自报不采信，全部实测）。
> 验收基线：commit `90230766ba81633ee83e1e4647a08a32e28b9673`（即验收文档 §5 条款与 §6 命令的唯一权威源）。
> 验收日期：2026-08-18。

## 1. 防篡改检查

| 检查项 | 结果 |
|--------|------|
| `git rev-parse HEAD` | `90230766ba81633ee83e1e4647a08a32e28b9673`（= 基线 commit，builder 改动全部在工作区未提交，符合「builder 不 commit」机制） |
| `git diff 9023076 -- docs/rewrite/acceptance/rv3-acceptance.md` | **空**（无篡改） |
| 验收文档 sha256 | `bf449ea3c581df31125ec777f68013511c3d1292765c9a029cb37f5612ba5863` |
| rv-3 领地内工作区改动 | `src/verify/contract-match.ts`（+103/-?）、`tests/u8-contract-match.test.ts`（hidden.txt→hidden.dat 一处适配）、新建 `tests/rv3-contract-match.test.ts`（未跟踪）——与验收文档 §2 交付物一一对应，无多余文件 |
| 禁改清单核对（§3） | `src/runner/integrate.ts`、`src/verify/{run,checkout,name-match,red-phase}.ts`、`src/core/`、`src/store/`、`src/readonly/`、`docs/`、`archive/`、配置文件均零改动；`matchContracts` 导出签名（`ContractMatchInput`/`ContractMatchResult`）diff 未触碰 |
| 越界改动豁免归因 | 工作区另有 `src/events/types.ts`、`src/gates/spec-rules.ts`、`src/handlers/{evidence-submit,review-submit}.ts`、`src/runner/{loop.ts,spawn/lifecycle.ts}`、`src/testrun/e2e-sh.ts` 改动——全部落在 rv-1（runner）与 rv-2（gates/handlers/events/testrun）并行领地，非 rv-3 所为，按并行规则豁免；未跟踪 `rv4-acceptance.md`/`mx2-acceptance.md`/`design-independent-review.md` 为主 agent 预写，豁免 |

**结论：防篡改通过，无越界。**

## 2. 命令实跑（限定范围）

```
$ npx vitest run tests/rv3-contract-match.test.ts tests/u8-contract-match.test.ts \
    tests/u8-integrate.test.ts tests/u8-e2e.test.ts
 Test Files  4 passed (4)
      Tests  27 passed (27)
   Duration  2.68s

$ npx eslint src/verify/contract-match.ts tests/rv3-contract-match.test.ts
（无输出，exit 0 → PASS）

$ npm run check   # tsc --noEmit
（无输出，exit 0 → PASS；rv-1/rv-2 并行中途态未导致类型检查失败，无需归因）
```

## 3. 条款对照表（验收文档 §5 T1-T8，断言语义逐条审查）

| 条款 | 测试位置 | 断言语义审查 | 判定 |
|------|---------|-------------|------|
| T1 README 作弊封堵 | tests/rv3-contract-match.test.ts:47-71 | README.md 写签名全文+代码不含 → `ok=false`+含恢复动作；对照 `src/foo.ts` → 命中。双向对照，非空洞 | 过 |
| T2 docs/ 目录排除 | :75-87 | 签名只在 `docs/guide.md` → `ok=false` | 过 |
| T3 两态消息区分 | :91-134 | 断言 `toContain("不是契约宿主")` + `not.toContain("不存在")` 措辞互斥；另测了「file 指向 docs/ 且文件不存在」仍是文档宿主态；对照 `src/api.ts` 过。verifier 实测两态互斥四项全 true（见 §4 P7） | 过 |
| T4 归一化命中 | :138-170 | 代码为真换行+缩进多行形态（`calc(\n  a: number,\n  b:…`）、契约单行。verifier 实测旧字节语义 `Buffer.indexOf` 确实 miss（=true）——是「旧语义会 miss」的真实升级锚点，**不是只测多空格**；file 路径与全树路径双覆盖 | 过 |
| T5 严格性不回退 | :174-199 | 大小写（`fooBar(` vs `foobar(`，全树路径）与 token（`sluggify(a,b)` vs `sluggify(a, c,b)`，file 路径）双形态均断言 `ok=false` | 过 |
| T6 空白折叠等价 | :203-215 | 代码 `foo(a,  b)` 双空格 vs 契约单空格 → 命中（旧字节语义同样 miss，实测） | 过 |
| T7 schema 宿主保留 | :219-249 | `.json` 走 file 路径、`.yaml` 走全树路径，均命中，未被文档排除误伤 | 过 |
| T8 既有回归 | :253-305 | file 定位/多契约不短路/空契约 ok/深层 `hidden.dat` 命中/node_modules+二进制跳过；u8 三文件 27 测试全绿（§2 实跑） | 过 |
| u8 适配裁量 | tests/u8-contract-match.test.ts:90-94 | `hidden.txt`→`hidden.dat`：`.txt` 上线文档排除后不再是合法宿主，换 `.dat` 保持「深层目录非文档文件命中」原语义，断言强度不变（仍断 `ok=true`+`failures=[]`），注释说明理由——**是换宿主不是弱化**；diff 仅此一处 hunk，无其他断言改动 | 合规 |

## 4. 行为对抗抽查（真实 tmp 目录树 + esbuild 打包后真实子进程直调 `matchContracts`，18+ 条探针）

| # | 操作 | 预期 | 实际 | 结论 |
|---|------|------|------|------|
| P1a | `README.MD`（大写扩展）含签名，全树搜索 | 不命中（大小写不敏感封堵） | ok=false | 符合 |
| P1b | `readme.md` 含签名，全树 | 不命中 | ok=false | 符合 |
| P1c | `Docs/`（大写目录名）下 guide.ts 含签名，全树 | 目录整棵排除 | ok=false | 符合（收紧方向） |
| P1d | 显式 `file: "Readme.MD"` | 文档宿主 failure 态 | 文档宿主态消息 | 符合 |
| P1e | 显式 `file: "DOCS/spec.md"` | 文档宿主 failure 态 | 文档宿主态消息 | 符合 |
| P2a | 深层 `a/b/c/docs/x.md` 含签名 | 不命中 | ok=false | 符合 |
| P2b | symlink `link.ts`→树内 `src/real.ts`（真文件含签名） | 经真文件命中，symlink 本身跳过 | ok=true | 符合 |
| P2c | symlink `escape.ts`→**树外** secret.ts（唯一签名副本） | 不命中（不 follow symlink，防逃逸） | ok=false | 符合 |
| P2d | 目录 symlink `docslink`→真实 docs 内容目录 | 不入栈，不命中 | ok=false | 符合 |
| P3a | README.md 与 src/api.ts 都含签名，无 file | 经 .ts 命中 | ok=true | 符合 |
| P3b | 签名只在 `notes.md`（非前缀名） | .md 扩展排除 → 不命中 | ok=false | 符合 |
| P4a | 7900B 文本（含签名）+ NUL 在 8000B 嗅探窗口**之后** | 窗口外 NUL 不拦截 → 文本 → 命中 | ok=true | 符合（既有窗口行为，§4 锁定不变；BINARY_SNIFF_BYTES 基线已有） |
| P4b | NUL 与签名都在窗口内 | 二进制跳过 → 不命中 | ok=false | 符合 |
| P4c | 20KB 纯文本、签名在末尾 | 读全文归一化 → 命中 | ok=true | 符合 |
| P5a | 代码 tab 缩进多行 vs 契约单行（空格） | 归一化命中 | ok=true | 符合 |
| P5b | 代码 CRLF（`\r\n`）多行 vs 契约单行 | 归一化命中 | ok=true | 符合 |
| P5c | 契约多行（含 `\n`）vs 代码单行 | 双侧归一化命中 | ok=true | 符合 |
| P6a | 显式 `file: "../escape-host.ts"`（树外文件含签名） | （既有行为探查） | ok=true——**基线既有**：`join(checkoutDir, file)` 无边界检查，rv-3 未引入未恶化；契约 file 来自 root spec 冻结可信层。记录为既有残余面，非本 unit FAIL 项 | 既有面，记录 |
| P6b | `file: "src/sub"`（指向目录） | 「不存在」failure（EISDIR→null） | 不存在态消息 | 符合 |
| P6c | 真实代码文件名 `src/readme-generator.ts` 含签名 | `README*` 前缀字面命中 → 文档宿主排除 | ok=false（file 与全树两路径都被排除） | 误伤边缘，见 §5 裁决 |
| P6d | `NOTES.txt` 全树 / `notes.dat` 全树 | .txt 排除 / .dat 命中 | false / true | 符合 |
| P6e | `config/CHANGELOG-history.yaml` 含签名 | CHANGELOG* 前缀任意扩展 → 排除 | ok=false | 符合（清单字面执行） |
| P6f | 三契约（README.md / docs/g.md / src/nope.ts）混合失败 | 各自独立不短路，两态各自正确 | 3 条 failure 形态逐一正确 | 符合 |
| P7 | 两态消息精确互斥（脚本断言） | doc 态含「不是契约宿主」且不含「不存在」；absent 态反之 | 四项全 true | 符合 |
| P8 | T4/T6 旧字节语义 miss 锚点（`Buffer.indexOf` 直接验证） | 单行签名字节串不在多行/双空格代码中 | miss=true / miss=true | 升级锚点真实 |

## 5. builder 裁量裁决

1. **宿主资格判定大小写不敏感**（contract-match.ts:24-26, 129, 133, 141-142）：验收文档 §4 只锁定了 signature **比对**不折叠大小写，未锁定宿主判定。裁决：**合规且合理**——大小写敏感会让 `README.MD`/`Readme.MD`/`DOCS/` 成为作弊通道（P1a-P1e 实测全部封堵）；不敏感方向的唯一副作用是大小写敏感文件系统上 `Docs/` 目录内代码文件与 `readme-generator.ts` 类前缀碰撞文件被误伤（P1c/P6c），但这是 §4 封闭清单（`README*` 前缀任意扩展 + `docs` 目录名）字面执行的必然结果，且方向 fail-closed（假 fail 可经 spec 修正恢复，不放过作弊）。不引入新作弊面。
2. **matchOne 文档判定先于存在性检查**（contract-match.ts:86-96）：正是 §4「排除的是宿主资格不是文件存在性」的直接实现——指向 README.md 无论文件是否存在都是文档宿主态，与「文件不存在」态措辞互斥（P7 四项实测）。**合规**，两态可区分性正是条款要求本身。

## 6. 既有残余作弊面（非 rv-3 引入，如实记录，不判 FAIL）

- 代码内注释命中（签名写进 .ts 注释仍算命中）——头注释已如实记录，防线 = review + 红阶段（§4 明示）。
- `contract.file` 相对路径 `../` 可逃逸 checkoutDir（P6a）——基线行为，输入来自 spec 冻结可信层；如需收紧属后续 unit 范畴。
- 二进制嗅探仅前 8000 字节（P4a）——基线既有窗口，§4 锁定不变。
- 配对化（consumer 期望 ≡ provider 冻结）归 rv-4——本 unit 范围裁定所限，非遗漏。

## 7. 总结论

**PASS**

- 防篡改通过（验收文档 diff 空，sha256 已记录，无越界改动）。
- §6 三条通过命令全绿（27/27 测试、eslint、tsc）。
- §5 T1-T8 条款断言全部实质（无空洞断言），u8 适配合规。
- 18+ 条对抗探针全部封堵或符合预期，builder 两项裁量均合规合理。
