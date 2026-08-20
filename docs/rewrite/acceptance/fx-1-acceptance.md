# fx-1 验收标准：终验死锁三根因修复

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending
>
> 依据：`final-gate-report.md` §5 根因分析（R1/R2/R3）。修复对象为已验收 unit 的缺陷（跨 u3/u4a/u7/u5 领地）——本 unit 是缺陷修复 unit，授权触碰列明的具体文件。

## R1：split 自引用死锁（spec gate + loop 双防线）

1. `src/gates/spec-rules.ts` 追加规则⑥：`spec.split` 中任一条目 `unitId === spec.unitId` → 拒（failures 含「规则⑥: split 自引用 <id>」+ 恢复动作「拆分子节点不得包含自身；叶子 unit 的 split 应为空」）。
2. `src/handlers/evidence-submit.ts`（spec 形态校验链）：追加叶子校验——查账本该 unit 的 UnitCreated.parentId 非空（叶子）且 spec.split 非空 → 拒（错误含「叶子 unit（深度上限 2）不得声明 split」）。
3. `src/runner/loop.ts` 内部节点判定防御：`split` 含自身 unitId → 不按内部节点处理（记 stderr 一行警告），按叶子语义参与派发。
4. 回归测试 ≥3：规则⑥自引用拒（gate 级）；叶子带 split 拒（handler 级，真实账本）；loop 防御（split 含自身的 unit 正常派发不死锁）。

## R2：重提 spec 落派发真空（文案 + 派发双修复）

1. `src/handlers/verify.ts` 失败恢复文案修正：当前「修复后重新提交 spec + build 证据并重审，再 cw verify」→ 改为「修复代码并 git commit 后，仅重新 `cw evidence submit --kind build --unit <id> --commit <hash> --run-id <新id>` 再 `cw verify`；spec 冻结不动（改验收走重新 spec 是另一路径，需重新过审）」。
2. `src/runner/loop.ts` 派发规则补第四分支：unit 状态 created 且 specs>0 且最后一条 SpecSubmitted 之后无 verdictKind=spec-review 且 verdict=pass 的 VerdictSubmitted → **派 designer**（brief 注明「spec 已提交待审——请审查该 spec 并执行 cw review submit --verdict-kind spec-review --verdict pass|fail」）。
3. 回归测试 ≥2：重提 spec 后 loop 派 designer 补审（真实账本 fixture：spec×2 + 无过审 → 断言 designer spawn）；文案断言（verify 失败 stderr 含新文案、不含「重新提交 spec + build 证据」旧误导语）。

## R3：marker 约定显式化

1. `src/testrun/e2e-sh.ts` parse 失败的错误信息追加格式说明：「e2e-sh 验收脚本须输出标记行 `A<验收id> PASS` 或 `A<验收id> FAIL`（A 前缀 + 验收 id + 空格 + 结果），脚本 exit code 与标记行一致」——落在无标记/格式不符两类错误的 message 里。
2. 回归测试 ≥1：无标记 + exit 0 的错误信息含该格式说明全文。

## 通过命令

`npm run check:all` / `npm test` 全量全绿（208 + 新增回归）/ `npm run lint` 零输出。

## 禁改清单

除上述列明文件（spec-rules.ts / evidence-submit.ts / loop.ts / verify.ts / e2e-sh.ts）与新增测试文件（tests/fx1-*.test.ts）外，其余一切禁改；上述文件的改动必须最小化（只加修复点，不动既有行为——各 unit 既有测试不得回退）。禁 git 写操作；禁 mock；禁 any。

## 修复后

verifier 验收通过 → commit → **同 brief 重跑终验**（新终验 executor，靶子重置为空 git 仓库）。
