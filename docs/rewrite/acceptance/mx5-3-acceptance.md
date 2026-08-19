# mx5-3 验收标准：reviewer 任务书对抗式改版（spec-review 模板）

> **本文件是防篡改基线：developer 与 verifier 禁止修改。**
> 依据：`docs/rewrite/design-spec-contract-replan.md` D3（commit `97804d5`）。M4 gate 三跑实证（现场三/四）：reviewer pass 意见写「A3 区分力较弱……不构成阻塞，pass」而其 session 全程 0 次接触任务书 §6 机器 gate 硬约束清单；约束传导链（m4-brief §6 → root 子任务书）丢掉恰好被违反的 2 条——清单进机制生成的任务书模板，不再依赖人（或 root designer）转述。清单维度依据 ~/Code 五项目对抗审查 skill 调研共性（契约一致性 4/4 项目共有）。

## 1. 目标

`src/runner/brief.ts` 的 **spec-review reviewer 任务书模板**新增对抗式审查清单（5 维度逐条核对 + 反例追问句式）与输出分级格式约定。其余模板（designer / build / exec-review）**逐字节不动**。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/runner/brief.ts` | 修改 | 仅 reviewer spec-review 模板区：新增 §5 清单五维度 + 输出分级格式约定（§4 口径）。模板函数签名不变（输入仍为既有投影参数，清单内容为静态文本 + 既有字段的逐条引用） |
| `tests/mx5-3-reviewer-brief.test.ts` | 新建 | §5 条款 |

## 3. 禁改清单（违反 = FAIL）

- brief.ts 内：designer 模板、build（developer/builder）模板、exec-review 模板、回炉相关（mx5-2 领地，本波不存在）零变更；模板函数签名与既有导出零变更
- `src/` 其余全部（spec-rules / events / handlers / frontier / loop / spawn 等均为本波其他 unit 领地）
- `docs/rewrite/acceptance/` 全部既有文档、`docs/rewrite/design-spec-contract-replan.md`
- 既有测试零修改（若既有 brief 测试断言了模板全文快照导致必然红，允许**最小**调整该断言并在交付说明列出——除此之外零动）

## 4. 清单口径（锁定，出处设计文档 D3）

任务书新增的核对清单五维度（措辞 developer 可润色，维度与核对点语义锁定）：

1. **验收命令契约逐条核对**：unit/integration 型逐条问「命令是否 vitest 兼容（`--reporter` 值若出现必须恰为 `json`——与 spec gate 规则⑨同口径；install 带 `--silent`）」；e2e 型逐条问「stdout 从哪产出 `<验收id> PASS` 标记行？命令里指得出来吗？」
2. **覆盖度**：brief 逐条映射到验收（既有要求，保留）
3. **区分力反例追问**：每条验收问「无实现时它必然挂吗？换一个实现它还过吗？」
4. **契约（contracts）一致性**：跨 unit 接口与冻结 hash 对照（既有，强化措辞）
5. **干净 checkout 可执行性**：依赖是否全在 package.json、命令是否自带 install

输出格式约定写进任务书：问题按 **must-fix / suggestion / info** 三级列出；verdict 为 pass 时须对每条核对项**显式**说明「核过无问题」（禁止含糊放行——三跑「不构成阻塞，pass」形态的针对性反制）。

## 5. 新增测试条款（零 mock，真实渲染）

### tests/mx5-3-reviewer-brief.test.ts

- **B1 清单在场**：以真实投影输入（tmp 目录构造含 unit/integration/e2e-real 三型验收的 spec-frozen unit）渲染 reviewer spec-review 任务书 → 输出含五维度标题/关键句（契约核对、覆盖度、区分力追问、契约一致、干净 checkout 可执行性）与输出分级约定（must-fix / suggestion / info + pass 逐项显式）。
- **B2 契约口径与规则⑨一致**：清单文本含「恰为 json」表述（不写「无 --reporter」——规则⑨允许 `--reporter=json`，口径漂移 = FAIL）。
- **B3 其余模板零变更**：designer / build / exec-review 模板渲染输出与改动前逐字节一致（git stash 对比或渲染快照断言）。
- **B4 e2e 型追问句在场**：渲染含 e2e-real 验收的 unit → 输出含「标记行」追问句式（「stdout 从哪产出」或等义表述）。

## 6. 通过命令

```
cd <仓库根> && npm run check:all
npx vitest run tests/mx5-3-reviewer-brief.test.ts
npx eslint src/runner/brief.ts tests/mx5-3-reviewer-brief.test.ts
全量 npm test → 全绿
```

## 7. 波后验收（verifier 执行，V3 场景）

用改版任务书重放三跑 leaf-app v3 同款冻结 spec 给真实 pi reviewer spawn（3 次独立 spawn）→ ≥2 次 verdict 为 fail 且 comment 提及 A3 标记行问题（对照三跑 pass 反例）；输出含分级清单。

## 8. status

pending → building → **verified**（2026-08-19：verifier 独立验收 6/6 PASS，报告 mx5-3-report.md——B3 分段 hash 独立复核、红性 2/2 真红、V3 真实 pi spawn ×3 全部 fail 且 2 次将 A3 列 must-fix（对照三跑 seq19 pass 反例改版有效）；findings 3 条均不阻塞，spawn 产物 /tmp/cw-mx53-v3/ 留档）

> 本节（§8 status）由主 agent 流转更新，不属于防篡改范围；§1-§7 禁止修改。
