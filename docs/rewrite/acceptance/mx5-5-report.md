# mx5-5 verifier 报告：规则⑨完备性收口（终验 S1-S5 修复）

> 独立 verifier 验收报告（与 developer 无关的第三方）。验收对象：commit `6aeb255`（前置基线 commit `c36cad2`）。
> 基线：`docs/rewrite/acceptance/mx5-5-acceptance.md`（§1-§7 防篡改锁定）。验收日 2026-08-20。

## 总结论

**PASS（6/6 验收项全过；两处偏离备案均裁定成立；findings 1 条 minor（不构成 FAIL 条件））**。
S2 空格形态拒绝、S3 前缀缩写链的语义、文案、测试覆盖、红性均经独立复验成立；禁改面零触碰；types.ts 变更逐行确认仅注释。

## 逐项判定

### 1. 防篡改 + 禁改 — PASS

- 基线 `mx5-5-acceptance.md` 在 `c36cad2..6aeb255` 区间的唯一变更 = §8 status 一行（+1/-1），基线第 3 行明文「§8 status 由主 agent 流转更新，不属于防篡改范围」；**§1-§7 零改动**。工作区当前副本与 6aeb255 版一致（`git status` 对该文件干净）。
- `git diff c36cad2..6aeb255 -- src/testrun/ src/verify/ src/handlers/ src/core/ src/store/ src/readonly/ src/runner/loop.ts src/runner/spawn/ src/cli.ts src/dispatch.ts` 输出 **0 行**——§3 禁改清单全过（含 `runner/{integrate,worktree,human-loop}.ts`：不在 commit 文件列表，零 diff；mx5-2 回炉投影在 `src/core`/`src/readonly`，mx5-4 改名语义零变更随之成立）。
- `src/events/types.ts` diff 逐行核对：全部变更落在 `parseFailedAcceptanceIds` 字段的 JSDoc 注释块内，字段名、类型签名（`parseFailedAcceptanceIds?: string[]`）、所在 interface 零变化——「仅注释」成立。
- commit 8 文件 = 基线 §2 授权 7 文件（spec-rules / types / brief / CONTEXT.md / design 勘误 / 两测试文件）+ 基线自身 §8 行；+172/-36 − §8 的 +1/-1 = §8 备案的「7 授权文件 +171/-35」，账目吻合，无清单外文件。

### 2. 条款复跑 — PASS

| 命令 | 结果 |
|------|------|
| `npm run check:all` | tsc src + tests 两轮全过，零错误 |
| `npx vitest run tests/mx5-1-spec-rule9.test.ts tests/mx5-3-reviewer-brief.test.ts` | 2 文件 36 用例全绿（恢复后复跑再确认一次 36 绿） |
| 全量 `npm test` | **69 文件 543 用例全绿**（exit 0，136s），与 §8 备案数字一致 |
| `npx eslint src/gates/spec-rules.ts src/events/types.ts src/runner/brief.ts`（§6 第 3 条） | 零告警（exit 0） |

### 3. S2/S3 语义审查 — PASS

- **S2 空格形态拒绝覆盖完备**：`jsonProductContract` 的 `token === "--reporter"` 分支改为无条件 `spaceReporterGap`——下一 token `undefined` 或 `-` 开头 → 文案「（空格形态，取值缺失）」；否则「（空格形态，值=<next>）」。**取值缺失与任意取值两形态均拒**，不存在按值放行的残留路径。等号形态分支不变（非 json 值照拒、`--reporter=json` 放行）。
- **S3 前缀链恰五成员**：`QUIET_LONG_PREFIX_RE = /^--q(?:u(?:i(?:e(?:t)?)?)?)?$/` 逐组展开 = `--q`/`--qu`/`--qui`/`--quie`/`--quiet` 恰五形态。心算核对不命中：`--query`（q→u→e 匹配后余 `ry` 不满足 `$`）、`--quietly`（匹配 `--quiet` 后余 `ly`）、`--qf`（q 后 `f` 不在链上）——无误伤。旧行为 `token === "--quiet"` 精确匹配对 `--q`（双横线单字符，不满足 `SHORT_OPTION_CLUSTER_RE`）确实漏网，S3 修复针对真实缺口。
- **缺口文案**：`spaceReporterGap` 的 fact 含完整理由链（空格形态不含 translate 幂等检查认定的等号子串 → cw 再追加 → 双 reporter → stdout 混合体 → 解析恒挂），recovery 指向可执行动作（改用 `--reporter=json` 或删除该 flag）——R2 反转用例对 `空格形态`/`值=json`/`--reporter=json`/`恢复动作` 四关键词的 stderr 断言实证在场。
- **规则①-⑧零变更**：spec-rules.ts 的 diff hunk 仅覆盖 `jsonProductContract` / 新增 `spaceReporterGap` / 新增 `QUIET_LONG_PREFIX_RE` / `noQuietContract`（含注释与条件行）；`--outputFile` 禁令与 e2e/manual 免查在 hunk 上下文中原样保留。

### 4. 两处偏离独立裁定 — 均成立（详见下节）

### 5. 红性复验 — PASS（2/2，改动已恢复，工作区干净）

| 红性探针 | 改动 | 结果 |
|------|------|------|
| ① 空格形态回到按值放行（删除 `spaceReporterGap` 分支，还原旧「取值缺失拒 / 非 json 拒 / json 放行」逻辑） | 临时改 `src/gates/spec-rules.ts` | **恰 2 红**：R2 反转用例 + C1 playwright 空格 json 值用例（json 值空格形态被放行）；「取值缺失」用例保持绿（旧逻辑本就拒）——红在 S2 语义变化的确切位置 |
| ② `QUIET_LONG_PREFIX_RE` 换回精确匹配 `/^--quiet$/` | 临时改 `src/gates/spec-rules.ts` | **恰 4 红**：`--q`/`--qu`/`--qui`/`--quie`；`--quiet` 与 `--query` 防御用例保持绿——与 §8 自验「S3 4 红」吻合 |

两次探针后均 `git checkout -- src/gates/spec-rules.ts` 恢复；终态 `git diff --stat` 为空，工作区仅存认知外 untracked `.tmp/`（verifier 未触碰）。恢复后 36 用例复跑全绿。

### 6. 设计文档勘误一致 — PASS

- **D1**：原文「值提取兼容 `--reporter=json` 与 `--reporter json` 两种形式」勘误为「等号形态唯一放行 + 空格一律拒」，附完整理由链与「**mx5-5 S2 勘误**：原文是设计缺口，空格形态 json 值曾据此放行并在 verify 期确定性恒挂，靠 D2 回炉兜底违背 G1」勘误记号——记号在场、口径与实现一致。D1 下方 bullet「取值必须恰为 json」与勘误后表头（形态约束）互补不矛盾。
- **D3**：方案表「维度可被账本审计（verdict comment 结构化）」改为「verdict comment 纯文本约定——分级词可 grep，无结构化载体」并附「mx5-5 S5 勘误：原『结构化』表述超前」记号——措辞已按 S5 修正。

## 两处偏离独立裁定

### 偏离①：CONTEXT.md 规则⑨词条两条 bullet 口径同步 — **裁定成立（接受）**

- **是否未授权**：是。基线 §2 对 CONTEXT.md 只授权 S1 项（解析失败词条），规则⑨词条两条 bullet 不在授权列——偏离定性正确，备案程序合规。
- **旧文是否与新实现直接矛盾**：是。旧 vitest bullet「值若出现必须恰为 json（`--reporter=json` 与 `--reporter json` 两种形式都查）」在旧实现下语义 = 空格形态 json 值放行；S2 后该形态被一律拒绝——按旧词条行事的读者会写出 `--reporter json` 并意外被 gate 拒，词条构成 actively misleading。旧 pytest bullet 枚举仅 `-q`/`--quiet`，S3 后 `--q` 等前缀缩写亦拒——枚举不完整（覆盖口径差）。
- **修正是否最小**：是。两条 bullet 各一行原地重写，理由链措辞与基线 §4 一致，`--outputFile` 子句等其余内容未动；CONTEXT.md 另一 hunk 为授权的 S1 项，两处边界清晰。
- 独立结论：**一致性必要修正，最小幅度，接受备案，不构成 FAIL**。

### 偏离②：brief.ts 既有「恰为 json」句未扩等号口径 — **裁定成立（接受，附 1 条 minor 措辞 finding）**

- **gate 时机推演（两条路径均封死空格形态进入 reviewer brief）**：
  1. **新提交**：`src/handlers/evidence-submit.ts:137` 在 SpecSubmitted 入账前调 `checkSpecRules`，规则⑨缺口 → exit 1 不入账 → 空格形态 spec 根本到不了 frozen。
  2. **存量冻结 spec（旧规则下冻结、含空格形态）**：`spec-frozen` 的判定是「最后一条 spec 过 specGate」（`src/core/fold.ts` deriveStatus），而 specGate 经 `src/readonly/load.ts` 注入的是**当前实现**——投影时用新规则重算，旧含空格形态的 spec 会跌出 spec-frozen，到不了 `specReviewPending` 维度，reviewer brief 不渲染。
- **结论**：reviewer 清单（`specReviewReviewerTasks`，brief.ts:105-107）的可达输入中 `--reporter` 只可能是 `--reporter=json` 或缺失，「值若出现必须恰为 json」对可达输入恒真——保留论证成立。回炉指引区（brief.ts:284-287）「删除冲突 flag」+「改后重提会重新过全部 gate」与新规则自洽。
- **残余（minor，见 findings）**：句内括注「（与 spec gate 规则⑨同口径）」在 S2 后不再是字面精确——gate 口径严格更窄（等号形态唯一）。规范内容仍是 gate 的必要条件子集，reviewer 照此核对不会错放任何 gate 会拒的形态，无行为风险。

## Findings

| # | 等级 | 位置 | 问题 | 影响 |
|---|------|------|------|------|
| F1 | minor | `src/runner/brief.ts:105-107` | 保留的「恰为 json」句内括注「（与 spec gate 规则⑨同口径）」措辞不再字面精确（gate 口径 S2 后严格更窄：等号形态唯一放行）；偏离②备案仅论证了规范内容对可达输入成立，未同步该自称口径的括注 | 无行为风险（可达输入恒真 + gate 双路径前置过滤已核实）；建议下次触碰 brief.ts 时顺手同步一句措辞，非本次 FAIL 条件 |

## 总结论依据链

1. 禁改面零触碰（0 行 diff）+ 基线 §1-§7 零改动 + types.ts 仅注释（逐行核对）。
2. 全部通过命令绿：check:all / 36 用例 / 全量 69 文件 543 / eslint。
3. S2/S3 语义、五成员前缀链、缺口文案理由链与恢复动作均独立核verify。
4. 红性 2/2 复现（2 红 + 4 红，位置精确），改动已恢复、工作区干净。
5. 两处偏离备案独立裁定均成立；设计文档 D1/D3 勘误与实现一致且记号在场。
6. 唯一 finding 为 F1（minor 措辞），不构成基线任何 FAIL 条件。

**mx5-5 验收：PASS。**
