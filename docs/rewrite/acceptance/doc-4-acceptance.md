# doc-4 验收标准：统一语言六词条 + 规则计数勘误（CONTEXT.md / AGENTS.md）

> **本文件是防篡改基线：§1-§7 禁止修改；§8 status 由主 agent 流转更新，不属于防篡改范围。**
> 依据：`docs/rewrite/design-spec-contract-replan.md` D5（commit `97804d5`）。前置：mx5-1（规则⑨定型）+ mx5-4（developer 改名落地）均 verified——doc-4 词条描述的是最终代码态。

## 1. 目标

mx-5 波次的统一语言回写：CONTEXT.md 增六词条、AGENTS.md 规则计数与核心约定同步勘误——文档描述与 mx5-1～mx5-4 交付的代码实态一致。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `CONTEXT.md` | 修改 | ①六词条（见 §4 定义）②既有 flake 词条升一等并同步「解析失败条目不计入 flake 连挂」的 mx5-2 语义③frontier 维度清单补 specContractBroken / specContractDeadlock（10 维 → 12 维口径同步）④VerifyRan 事件描述补 parseFailedAcceptanceIds 可选字段⑤`--role` 枚举与 spawn 相关描述确认 developer（mx5-4 已改词，doc-4 核一致性） |
| `AGENTS.md` | 修改 | ①「spec gate 八规则」→「九规则」全文勘误 + 规则⑨一句话描述（与 src/gates/spec-rules.ts 实态一致）②runner 循环描述补回炉通道（解析失败连挂 ≥2 → specContractBroken 派 designer；回炉代数 ≥2 → specContractDeadlock 转人工）与 developer 角色③文档索引表补 design-spec-contract-replan.md 行 |

## 3. 禁改清单（违反 = FAIL）

- `src/`、`tests/` 全部（doc-4 是纯文档 unit，零代码改动）
- `docs/rewrite/` 既有文档（除本文件 §8）、`archive/`
- CONTEXT.md / AGENTS.md 中与 mx-5 无关的既有内容零变更（diff 审查：只准增词条/改计数/补描述，不准重排无关段落）

## 4. 六词条定义（锁定措辞要点，具体行文 developer 定，须与代码实态一致）

1. **验收命令契约**：验收 `command` 与 testrun 适配器输出协议的相容性（vitest/playwright：`--reporter` 值若出现必须恰为 `json`、禁 `--outputFile`——cw 自动追加 reporter；pytest：禁 `-q`/`--quiet` 含合写；e2e-sh：须输出 `<验收id> PASS|FAIL` 标记行）。spec gate 规则⑨入账前机器检查；e2e 型静态不可判为诚实边界，由 reviewer 清单 + 回炉通道兜底。
2. **解析失败 vs 断言失败**：解析失败 = 适配器 parse 抛错、无法从产物读出判定的封闭枚举形态（vitest/playwright stdout 非法 JSON；e2e-sh 无标记行且 exit 0、或标记 id 与验收 id 不符——不含无标记且 exit≠0，该形态无法确定性归因 spec，照旧断言失败路径）；断言失败 = 产物合法可解析但 case 判 fail。解析失败是确定性挂，不计入 flake 连挂，经 specContractBroken 回炉通道处置。
3. **打回代数**：spec-review 环的防活锁计数——同一 SpecSubmitted 后的 reviewer fail 只计 1 代，重提不清零，默认预算 10 代转人工（specReviewDeadlock）。
4. **停派**：runner 对某 unit 停止自动派发的状态类（specReviewDeadlock / flakeReview / specContractDeadlock），转人工处置。
5. **flake**：e2e 验收断言失败连挂 ≥2 次触发的随机性疑似判定（rv-5）——升为一等词条；明确「解析失败条目不计入」。
6. **developer**：实现角色（原 builder，2026-08-19 用户拍板改名）；历史账本 role=builder 事件重放语义不变。

另：**回炉**（reheat）与**回炉代数**作为 specContractBroken 通道的伴随词条一并定义（连挂 ≥2 → 新 SpecSubmitted 计 1 代，累计不清零，≥2 代转人工）。

## 5. 验收条款（文档-实现一致性，零 mock）

- **D1-词条在场**：CONTEXT.md 含六词条 + 回炉/回炉代数，每词条有定义与最小例子或机制锚点（源文件路径）。
- **D2-计数勘误**：AGENTS.md 全文无「八规则」残留，规则⑨描述与 spec-rules.ts 实态一致（恰为 json / outputFile / -q 合写 / e2e 无静态规则四要点）。
- **D3-一致性抽查**：词条中的阈值/常量/维度名与代码实态一致（SPEC_CONTRACT_MIN_CONSECUTIVE_FAILS=2 / MAX_GENERATIONS=2、frontier 维度名、VerifyRanPayload 字段名）——逐项 grep 源码核对。
- **D4-无关内容零变更**：git diff 审查 CONTEXT/AGENTS 除授权变更外零无关段落重排。

## 6. 通过命令

```
cd <仓库根> && npm run check:all && npm run lint && npm test（确认文档改动零代码影响，全量绿）
grep -c "八规则" AGENTS.md → 0；六词条 grep 在场
```

## 7. 波后验收（verifier 执行）

文档-实现一致性全项核对（D3 逐项源码 grep）+ 抽 2 词条让未参与本波的人（verifier 自任）仅凭词条回答机制问题（可理解性抽检）。

## 8. status

pending → building → **verified**（2026-08-20：verifier 独立验收 7/7 PASS，报告 doc-4-report.md——D3 一致性 18 项逐项亲测源码零不符（超 8 项下限）；两点裁定均成立（基线冲突处置为唯一解——N4 硬断言与词条字面互斥、§4 锁的是措辞要点非拼写；边缘勘误实质授权——旧句与代码在阈值与计数口径两层失实，不改即 D3 违例）；可理解性抽检两问仅凭词条可答。findings 1 条挂账：AGENTS.md:29 mx-1 段过时描述跨文件不一致，待后续 doc 波次。**mx-5 波次至此五 unit 全 verified 收口**）

> 本节（§8 status）由主 agent 流转更新，不属于防篡改范围；§1-§7 禁止修改。
