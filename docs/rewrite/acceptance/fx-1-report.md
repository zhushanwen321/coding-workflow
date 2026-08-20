# fx-1 验收报告：终验死锁三根因修复（R1/R2/R3）

> verifier 独立验收报告。验收基线：commit `99f5fca` 的 `docs/rewrite/acceptance/fx-1-acceptance.md`。
>
> **总结论：PASS**（验收文档全部条目证实；红绿声明经基线影子工程独立复现；4 条行为对抗抽查全过；2 项观察不构成失败，见 §6）。

## 1. 防篡改核验

| 检查 | 结果 |
|------|------|
| `git diff 99f5fca -- docs/rewrite/acceptance/fx-1-acceptance.md` | 空（无篡改） |
| 工作区文件 sha256 | `d63a910584434dc6f1b1974c760846f933baa03b1259297f9ebeddaa3ac47ade` |
| `git show 99f5fca:<file>` sha256 | `d63a910584434dc6f1b1974c760846f933baa03b1259297f9ebeddaa3ac47ade`（一致） |

### diff 边界（`git diff 99f5fca --stat`）

修改 5 个授权对象文件 + 1 个认知外文件；新增 4 个授权测试文件 + 认知外未跟踪产物：

- 授权：`src/gates/spec-rules.ts`(+18/-2)、`src/handlers/evidence-submit.ts`(+29/-3)、`src/runner/loop.ts`(+76/-6)、`src/handlers/verify.ts`(+4/-2)、`src/testrun/e2e-sh.ts`(+11/-2)、`tests/fx1-{r1-split-selfref,r2-verify-message,r3-marker-format,loop-dispatch}.test.ts`（4 新文件）
- 认知外（非 builder 产物，不阻断）：`AGENTS.md` 一行（e2e 测试基建描述措辞更新，非 fx-1 内容）；未跟踪 `wave-endstate-execution.*` / `.$wave-endstate-execution.drawio.bkp`（diagram 产物）
- 其余零改动 ✅

## 2. 通过命令实跑（工作区当前状态）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0 |
| `npm test` | **218/218 全绿**（35 个测试文件；= 基线 208 + fx-1 新增 10） |
| `npm run lint` | 零输出，exit 0 |
| `npx vitest run tests/fx1-r1-split-selfref.test.ts tests/fx1-loop-dispatch.test.ts tests/fx1-r2-verify-message.test.ts tests/fx1-r3-marker-format.test.ts` × 2 遍 | 两遍均 10/10 全绿 |

### 红绿声明独立复现（基线影子工程）

方法：`git archive 99f5fca` 导出至 `/tmp/fx1-baseline` → 拷入 4 个 fx1 测试文件 → 软链 node_modules → `npm run build`（exit 0）→ 跑同 4 个测试文件。

结果：**8 failed / 2 passed**，与 builder 声明「8/10 变红、2 为刻意阴性对照」完全一致：

- 变红 8：规则⑥自引用拒、fold 集成（自引用+pass 仍 created）、叶子 split 拒、R1.3 loop、R2.2 loop、R2.1 verify 文案、R3 两条
- 阴性对照 2（修复前后均绿）：非自引用 split 不误伤（gate 级）；根 unit split 放行 + 叶子空 split 放行（handler 级）

## 3. 修复点逐项对照

### R1：split 自引用三防线 — 全部证实

- **R1.1 规则⑥**（`src/gates/spec-rules.ts:84-90`）：`spec.split.some(entry => entry.unitId === spec.unitId)` → 拒。failure 文案含锁定原文「规则⑥: split 自引用 <id>」「拆分子节点不得包含自身」「叶子 unit 的 split 应为空」+ 恢复动作（移除条目/置空数组后重提）。CLI 实跑 exit 1、文案全文命中。
- **R1.2 handler 叶子校验**（`src/handlers/evidence-submit.ts:130-140`）：parentId 经 `unitCreatedFacts` 账本事实取（不新增依赖），非空（叶子）且 split 非空 → 拒，含「叶子 unit（深度上限 2）不得声明 split」。CLI 实跑：叶子引用其他 unit 的非自引用 split 同样被拦（exit 1）——语义为「拦叶子的一切 split 声明」，与验收文档 R1.2 一致；根 unit 同形态放行（exit 0，不误伤）。
- **R1.3 loop 防御**（`src/runner/loop.ts:180-183, 226-245`）：`splitSelfReferences` 判定；自引用 → stderr 警告 + 按叶子语义参与派发（不作为内部节点等子树）。
- **可达性披露证实**：`src/readonly/load.ts:39-40` 的 `unitStatus` 注入真实 `checkSpecRules`（含规则⑥）→ 旁路写入的自引用 spec 在 fold 重放时 `specGate(spec).ok=false` → 派生状态恒为 created → loop 的 spec-frozen 分支内的防御代码在新 gate 下经真实 fold **不可达**，确系纵深防御，与 builder 披露一致。loop 级测试实际验证的路径是「规则⑥停 created → R2 第四分支派 designer 修正 → 全链 closed」（终态契约），其「修复前 idle exit 1」经基线影子工程复现（R1.3/R2.2 两测试在基线下均 failed）。
- **fold 集成测试**（`tests/fx1-r1-split-selfref.test.ts:73-87`）：自引用 spec + 事后 spec-review pass → `unitStatus` 仍 created——死锁入口状态（spec-frozen 内部节点）不可达的真证明。

### R2：重提 spec 派发真空 — 全部证实

- **R2.1 verify 文案**（`src/handlers/verify.ts:165-167`）：旧语「修复后重新提交 spec + build 证据并重审」已移除；新文案含「修复代码并 git commit 后」「仅重新 cw evidence submit --kind build …再 cw verify」「spec 冻结不动（改验收走重新 spec 是另一路径，需重新过审）」。CLI 子进程级实跑：exit 1，新文案 grep 命中，旧语 grep 0 命中。
- **R2.2 第四分支**（`src/runner/loop.ts:190-201, 217-224`）：`created && specs>0 && !hasSpecReviewPassAfterLastSpec` → 派 designer。口径比对：`hasSpecReviewPassAfterLastSpec`（loop.ts L195-200）与 `deriveStatus` 的 spec-frozen 判定（`src/core/fold.ts` L100-104）**逐字同口径**——同 `lastSpecSeq` 锚点、同 `verdictSeqs[i] > lastSpecSeq`、同 `spec-review`+`pass`、同 `some`。无第二套时间语义。
- **补审任务书防同态循环**（`src/runner/loop.ts:424-430, 441-444`）：`reReviewTasks` 全文只含「审查该 spec 并执行 cw review submit…」「勿重新提交 spec」，不含「撰写 spec」、不含 `cw evidence submit --kind spec` 指令；`renderBrief` 以 `role==="designer" && unit.specs.length > 0` 区分首分支（specs===0）与第四分支任务书，与 `computeDispatchTargets` 同一投影判定。CLI/loop 级 brief 落盘实测：补审语命中、重提指令 0 命中。

### R3：marker 约定显式化 — 全部证实

- `src/testrun/e2e-sh.ts:28-30` 定义 `MARKER_FORMAT_NOTE`（与验收文档锁定全文逐字一致），追加在两类 parse 错误（无标记且 exit 0；标记 id 与验收 id 不符）message 末尾。diff 核对：既有错误文本原样保留（仅补句号衔接），无其他行为变更。
- CLI 级实跑（e2e-real 指向无标记输出脚本）：verify exit 1，stderr 含 NOTE 全文。

### 五文件最小化

逐文件 diff 审查：改动均为修复点本体 + 相关注释（规则⑥背景、第四分支注释、R2/R3 根因注释）；`loop.ts` 删除的旧行为注释（「spec 已提交未过审 → 不重复派 designer…maxIdleMs 兜底」）正是被第四分支替代的旧行为描述，无既有行为回退（基线 208 测试全绿佐证）。

## 4. 行为对抗抽查（4 条，真实 CLI/loop + tmp + 隔离 CW_HOME）

1. **R2 时序变体（fail 后重提）**：真实账本构造 `spec1 → spec-review fail → spec2`（无过审）→ fold 判 created（旧 fail 不计数）→ 真实 `runLoop`（真实 node 子进程 worker）首派 designer → 补审 pass → builder → reviewer → 全链收敛 **closed**、loop exit 0。designer brief 含补审任务书、不含「撰写该 unit 的 spec.json」、不含 `cw evidence submit --kind spec`。✅
2. **R2 文案 CLI 子进程级**：真实 git repo + 账本（A2 真挂）→ `node dist/cli.js verify` exit 1；stderr 新文案两段均命中 1 次；旧误导语「重新提交 spec + build 证据」grep 0 命中。✅
3. **R1 不误伤 + 双防线 CLI 级**：根 unit split 引用其他 unit → exit 0（合法拆分照常过）；根 unit split 含自身 → exit 1 + 规则⑥文案全文；叶子 unit split 引用其他 unit（非自引用）→ exit 1 + 叶子防线文案。✅
4. **R3 CLI 级**：e2e-real 脚本输出无标记行且 exit 0 → verify exit 1，stderr 含 MARKER_FORMAT_NOTE 全文（逐字节 grep 命中）。✅

与验收文档无任何矛盾。

## 5. builder 五项声明逐项证实

| # | 声明 | 结论 |
|---|------|------|
| 1 | R1 三防线（规则⑥自引用拒+恢复动作 / 叶子 split 拒经 unitCreatedFacts / loop 防御含 stderr 警告与叶子语义） | 证实（CLI 实跑 + 源码） |
| 2 | R2 新文案旧语移除 + 第四分支同口径 + 补审任务书不含「撰写 spec」 | 证实（fold.ts 逐字比对 + brief 落盘实测） |
| 3 | R3 常量追加两类 parse 错误末尾、既有文本原样 | 证实（diff + CLI 实跑） |
| 4 | 10 条回归（5+2+1+2），8/10 变红、2 阴性对照 | 证实（基线影子工程独立复现 8 failed / 2 passed） |
| 5 | R1.3 防御分支新 gate 下不可达（纵深防御）；loop 测试验证终态契约；修复前 idle exit 1 | 证实（load.ts 接线核查 + 基线复现两 loop 测试 failed） |

## 6. 观察项（不构成 FAIL，供后续 unit 参考）

- **O1（已知边界，超出 fx-1 范围）**：账本中已存在「自引用 spec 且其后已有 spec-review pass」的旧坏账（规则⑥生效前过审的），新 gate 下 fold 判 created 且 `hasSpecReviewPassAfterLastSpec=true` → loop 无分支覆盖 → idle exit 1。仅「旁路写入 + 规则升级」叠加时出现；终验靶子重置为空仓库后不再发生。
- **O2（设计张力，产品语义选择）**：最后一条 spec 之后只有 fail verdict（未重提）时，第四分支持续重派 designer 补审（fail 不产生状态跃迁），直到 pass 或 idle。符合验收文档字面（「无 pass → 派 designer」），与「gate 熔断不阻断」哲学一致；但 `reReviewTasks` 无「重写 spec」出口，spec 实质不合格时会循环补审。
- **O3（认知外改动披露）**：`AGENTS.md` 一行措辞更新与 `wave-endstate-execution.*` 未跟踪产物非 builder 交付物，请主 agent 按防护规则 0 处置。

## 7. 结论

**PASS**。R1/R2/R3 全部修复点按验收文档证实，改动最小化，10 条回归真实有效（基线复现 8 红 2 绿），全量 218 绿，4 条对抗抽查无矛盾。建议：流转 verified → commit → 同 brief 重跑终验。
