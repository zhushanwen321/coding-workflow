# rv-3 验收标准：契约比对强化（文档宿主排除 + 归一化比对）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：2026-08-18 五角度对抗审查（canon 角度 A-7：canon:501「签名文本 hash / 结构化比对」vs 实现的「文本包含搜索」——把 signature 写进 README 即可过契约比对）。
> 范围裁定：canon 的「consumer 期望 ≡ provider 冻结」配对比对需要契约来源标记（loop.ts 收集点改造），与并行波次 rv-1（loop.ts 领地）冲突，**配对化升级归 rv-4 承载**。本 unit 在 contract-match.ts 自有领地内消灭最大作弊面并提升比对严格性。

## 1. 目标

契约签名的命中宿主限定为代码/配置类文件（文档与 README 不再是合法宿主）；格式化工具导致的空白差异不再造成假 fail；比对语义对同一输入严格确定。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/verify/contract-match.ts` | 修改 | ①**文档宿主排除**：命中判定（显式 file 校验与全树搜索两路）一律排除文档类文件——扩展名 `.md` `.txt` `.rst` `.adoc`、任意扩展的 `README*`/`CONTRIBUTING*`/`CHANGELOG*` 文件名、`docs/` 目录名（全树搜索不入栈；显式 file 指向文档类 → 直接 failure 且消息说明文档不是契约宿主）。`.json`/`.yaml` 等保留（schema 类契约的合法宿主）。②**归一化比对**：`containsText` 升级——文件内容与 signature 双侧归一化（连续空白含换行折叠为单空格）后 indexOf；防格式化/缩进/换行风格差异造成假 fail。③头注释「判定规则」段同步重写。④失败消息保留「契约 id + 期望宿主 + 恢复动作」结构，文档排除的失败形态单独措辞（指明文档文件不是契约宿主，恢复动作指向真实代码文件） |
| `tests/rv3-contract-match.test.ts` | 新建 | §5 条款 |
| `tests/u8-contract.test.ts`（及 u8-e2e 如涉及） | 适配 | 仅因文档排除/归一化需要的断言增量与必要适配；禁改既有断言语义、禁删测试 |

## 3. 禁改清单（违反 = FAIL）

- `src/runner/` 全域（含 loop.ts/integrate.ts——配对化是 rv-4 的事）、`src/verify/{run,checkout,name-match,red-phase}.ts`、`src/gates/`、`src/handlers/`、`src/events/`、`src/core/`、`src/store/`、`src/readonly/`、`src/testrun/`
- `matchContracts` 的导出签名（`ContractMatchInput`/`ContractMatchResult` 接口不变——integrate.ts 调用点零改动）
- `docs/`、`archive/`、配置文件

## 4. 关键口径（锁定）

- **排除的是「宿主资格」不是「文件存在性」**：显式 file 指向 README.md 时不是「文件不存在」失败，而是「文档类文件不是契约宿主」失败——两态消息必须可区分。
- **文档类清单为封闭集合**：`.md` `.txt` `.rst` `.adoc` 扩展 + `README*`/`CONTRIBUTING*`/`CHANGELOG*` 前缀名 + `docs/` 目录。不做「启发式内容判断」。代码内注释命中仍是已知残余作弊面（防线=review+红阶段），头注释如实记录。
- **归一化只折叠空白**：`replace(/\s+/g, " ")` 双侧应用后字节级 indexOf；不做大小写折叠、不做 token 化（`Foo` ≠ `foo` 仍判不命中）。
- **二进制嗅探、符号链接跳过、node_modules/.git 跳过**：既有行为不变。
- **纯函数口径不变**：对同一 (contracts, checkoutDir) 结果恒定，只读文件系统。

## 5. 新增测试条款（tests/rv3-contract-match.test.ts，真实 tmp 目录树，零 mock）

- **T1 README 作弊封堵**：tmp 树中 `README.md` 写入 signature 全文、代码文件不含 → 全树搜索（无 file 契约）**不命中**，failure 消息含恢复动作；对照：把签名放进 `src/foo.ts` → 命中。
- **T2 docs/ 目录排除**：签名只出现在 `docs/guide.md` → 不命中。
- **T3 显式 file 指向文档**：`file: "README.md"` 且 README 含签名 → failure 消息为「文档类文件不是契约宿主」形态（非「文件不存在」形态）；`file: "src/api.ts"` 含签名 → 过。
- **T4 归一化命中**：代码文件中签名为多行形态（换行+缩进，如函数签名跨行）、契约 signature 为单行形态 → 归一化后**命中**；对照旧字节包含语义会 miss（测试注释注明）。
- **T5 严格性不回退**：大小写差异（`fooBar` vs `foobar`）、token 差异（`foo(a,b)` 契约 vs `foo(a, c,b)` 代码）→ 不命中。
- **T6 空白折叠等价**：代码 `foo(a,  b)`（多空格）vs 契约 `foo(a, b)` → 命中。
- **T7 schema 宿主保留**：`.json`/`.yaml` 文件含签名（kind=schema 场景）→ 仍命中（未被文档排除误伤）。
- **T8 既有回归**：u8 契约相关既有测试全绿。

## 6. 通过命令

```
cd <仓库根> && npm run check
npx vitest run tests/rv3-contract-match.test.ts tests/u8-contract.test.ts tests/u8-integrate.test.ts tests/u8-e2e.test.ts
npx eslint src/verify/contract-match.ts tests/rv3-contract-match.test.ts
```
（u8 系具体文件名以仓库实际为准，跑 `npx vitest run tests/u8*.test.ts` 亦可）
