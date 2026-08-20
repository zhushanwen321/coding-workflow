# mx5-5 验收标准：规则⑨完备性收口（终验 S1-S5 修复）

> **本文件是防篡改基线：§1-§7 禁止修改；§8 status 由主 agent 流转更新，不属于防篡改范围。**
> 依据：mx-5 波次终验报告 `mx5-wave-audit-report.md`（commit `afd2fe0`）SUGGESTION S1-S5，用户裁决「全部修复后执行 gate 四跑」。前置：mx-5 五 unit 全 verified（`de3c37d`）。

## 1. 目标

修复终验发现的规则⑨完备性缺口与口径偏差：S2 空格形态漏网（最实质）、S3 pytest 前缀缩写、S1 枚举描述不完整、S4 reviewer 清单口径差、S5 设计文档表述超前。

## 2. 交付物

| 文件 | 动作 | 内容（对应终验编号） |
|------|------|------|
| `src/gates/spec-rules.ts` | 修改 | **S2**：vitest/playwright 型 `--reporter` 只放行**等号形态且值恰为 json**（`--reporter=json`）；空格形态 `--reporter json`（无论值）一律拒绝，缺口文案说明理由（translate 幂等检查只认等号子串，空格形态会被 cw 再追加 reporter 致产物解析恒挂）。**S3**：pytest 型禁令覆盖 `--quiet` 的 argparse 合法前缀缩写（`--q`/`--quie` 等——实现用严格前缀链匹配或等价正则，`--q` 为最短形态；禁误伤其他长选项）。注释「值恰为 json 是 includes 幂等合法形态」同步修正为等号形态口径 |
| `src/events/types.ts` | 修改（仅注释） | **S1**：`parseFailedAcceptanceIds` 注释的「封闭枚举」改准确——`parseError===true` 的实际来源 = 适配器 parse 抛错（vitest/playwright stdout 非法 JSON 或 **JSON 合法但形状不符**；e2e-sh 无标记行且 exit 0 或标记 id 不符）、**零条目且 exit 0 防线**（playwright/pytest）、**translate 抛错**（如 `runner:"e2e-sh"` 显式声明的条目 command 缺省）、路由不到适配器的旁路——采用「非穷举 + 代表形态」表述，注明完整集合以适配器实现为准 |
| `src/runner/brief.ts` | 修改（reviewer 模板区一句） | **S4**：维度①问句补「若验收显式声明 `runner`，按声明适配器核对（与规则⑨同路由）」 |
| `CONTEXT.md` | 修改 | **S1**：解析失败词条的枚举同步改准确（与 types.ts 注释同口径） |
| `docs/rewrite/design-spec-contract-replan.md` | 修改（勘误） | **S2**：D1「值提取兼容 `--reporter=json` 与 `--reporter json` 两种形式」勘误为等号形态唯一放行（附理由）；**S5**：D3 方案表「维度可被账本审计（verdict comment 结构化）」改为「verdict comment 纯文本约定（分级词可 grep，无结构化载体）」 |
| `tests/mx5-1-spec-rule9.test.ts` | 修改 + 增用例 | **R2 反转授权**：原「`--reporter json` 值 json 通过」断言改为拒绝（S2 语义变化的必然迁移，明示授权）；新增：空格形态 verbose 与 json 值均拒（S2）、`--q`/`--quie` 拒且 `--quiet` 全形态拒（S3）、`--query` 类非前缀形态不误伤（S3 防御） |
| `tests/mx5-3-reviewer-brief.test.ts` | 增断言 | **S4**：B 系补一条——渲染输出含 runner 显式声明提示句 |

## 3. 禁改清单（违反 = FAIL）

- `src/testrun/`（全部——S2 的根因在 translate 幂等检查，但四适配器仍禁改：修复走规则⑨收紧侧，不动 translate）、`src/verify/`、`src/handlers/`、`src/core/`、`src/store/`、`src/readonly/`、`src/runner/{loop,integrate,worktree,human-loop}.ts`、`src/runner/spawn/`、`src/cli.ts`、`src/dispatch.ts`
- 规则①-⑧零变更；规则⑨ vitest/playwright 的 `--outputFile` 禁令与 e2e/manual 免查不动；pytest `-q`/短簇禁令不动（只增前缀缩写覆盖）
- `src/events/types.ts` 仅注释可改（类型与字段零变更）
- mx5-2 回炉投影 / mx5-4 改名语义零变更
- `docs/rewrite/acceptance/` 既有文档（本文件 §8 除外）

## 4. 关键口径

- **S2 收紧理由链**（写进缺口文案与设计勘误）：u5 translate 幂等检查 = 命令含 `--reporter=json` 等号子串才不追加（`src/testrun/vitest.ts` includes 检查）；空格形态不含该子串 → cw 追加 `--reporter=json` → 双 reporter → stdout 混合体 → 解析恒挂。放行等号形态是因为它幂等安全且 10 个存量夹具依赖；空格形态拒绝是「拦得住的拦死」。
- **S3 前缀链**：`--quiet` 的 argparse 合法缩写 = `--q`、`--qu`、`--qui`、`--quie`、`--quiet`（严格逐字符前缀，非 startWith 任意词——`--query` 不是 `--quiet` 前缀链成员，不拦）。
- **S1 表述原则**：宁可承认非穷举也不写不完整的封闭清单——「完整集合以四适配器 parse/translate 实现为准，代表形态：…」。

## 5. 测试条款（真实 dispatch / 直写账本，零 mock）

- **C1（S2）**：`--reporter json`（json 值空格形态）→ exit 1 缺口列出；`--reporter=verbose` / `--reporter verbose` → 拒；`--reporter=json` → 通过（幂等安全形态）。
- **C2（S3）**：`--q`、`--quie` → 拒；`--query`（若构造为合法 pytest 无关长选项形态）→ 不因 S3 拒（防御误伤）；`-q`/`-qq` 既有用例保持绿。
- **C3（S4）**：reviewer 任务书渲染含「显式声明 runner…按声明适配器核对」句。
- **C4（回归）**：存量 10 文件 `-- --reporter=json` 夹具零翻红；R 系/P 系/F 系/N 系既有用例除 R2 反转外零变更零红；全量绿。

## 6. 通过命令

```
cd <仓库根> && npm run check:all
npx vitest run tests/mx5-1-spec-rule9.test.ts tests/mx5-3-reviewer-brief.test.ts
npx eslint src/gates/spec-rules.ts src/events/types.ts src/runner/brief.ts
全量 npm test → 全绿
```

## 7. 波后验收（verifier 执行）

C1-C4 独立复跑 + 红性抽查 2 条（①删 S2 空格拒绝分支 → C1 红；②删前缀链匹配 → C2 红）+ 设计文档勘误与实现口径一致核对。

## 8. status

pending → building → **verified**（2026-08-20：verifier 6/6 PASS，报告 mx5-5-report.md——红性 2/2（S2 还原恰 2 红、S3 前缀链还原恰 4 红）、两处偏离均裁定成立（CONTEXT 词条旧文与新实现直接矛盾最小修正；brief 保留句经代码实证双路径封死——新提交入账前 gate、旧冻结 spec 投影重算跌出 spec-frozen 不渲染 brief）、types.ts 逐行确认仅注释。F1 minor 记档：brief「同口径」括注 S2 后不字面精确，下次触碰顺手同步。**S1-S5 全闭环，mx-5 终验遗留清零，gate 四跑前置就绪**）

> 本节（§8 status）由主 agent 流转更新，不属于防篡改范围；§1-§7 禁止修改。
