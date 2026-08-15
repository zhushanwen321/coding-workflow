# fx-2 验收标准：集成层死锁 R4 修复（恢复出口 + 重派上限）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending
>
> 依据：`final-gate-2-report.md` §4（R4a 恢复路径断裂 / R4b idle 兜底失效双根因）。修复对象限 loop.ts 与 integrate.ts 的恢复路径段。

## R4a：集成 fail 的恢复出口（派 designer 处置契约漂移）

1. `src/runner/loop.ts`：集成失败重派上限——同一内部节点的集成连续 fail（以该 unit 连续 result=fail 的 VerifyRan 计数，任何 pass/新 spec 提交清零）达 **2 次** → 不再自动重派集成，改**派 designer**，brief 内容：
   - 集成契约比对失败的契约清单（id + signature + 期望 file）与失败验收 id
   - 处置指引二选一：① 实现与契约语义等价但文本不等（如 async 差异）→ 修正 spec 的契约签名后重新 `cw evidence submit --kind spec` + `cw review submit --verdict-kind spec-review`（走既有重新过审链，fx-1 R2 第四分支已打通）② 契约本身正确而实现跑偏 → 说明需 provider 修复（提示人工介入；closed 的 provider 无自动回退通道——这是已知边界，如实写在 brief）。
2. `src/runner/integrate.ts` 失败汇总信息（failures 与 report）追加恢复路径说明：同上二选一文案。
3. designer 处置后（重新 spec 过审 → root 回 spec-frozen）→ 集成按正常路径重跑（连续 fail 计数已清零）。

## R4b：idle 兜底恢复生效

- 重派上限生效后：集成不再无限写审计 VerifyRan；若 designer 也未推进（无人应答 brief），账本无新事件 → maxIdleMs 正常触发 exit 1（回归到「有界空转」语义）。
- 验收口径：构造集成确定性 fail 场景（契约必然不匹配），设小 maxIdleMs——上限前允许 ≤2 次集成尝试 + 1 次 designer 派发，随后无进展 → runner 在 maxIdleMs 内退出 exit 1（不得无限循环）。

## 交付物与回归测试

- 修改：`src/runner/loop.ts`（上限 + designer 出口）、`src/runner/integrate.ts`（失败文案）
- `tests/fx2-integration-recovery.test.ts` ≥4 条：
  1. 集成 fail 1 次 → 重派集成（既有行为不回退）
  2. 连续 fail 2 次 → 不再派集成、派 designer 且 brief 含契约清单与两条处置路径
  3. designer 重提 spec 过审后 → 集成重跑且计数清零（fixture：契约修正后 pass → root closed 全链）
  4. 上限后无人推进 → maxIdleMs 内 exit 1（不无限循环；真实计时可用小值如 3000ms）
- 既有 218 测试全绿（u8 集成测试若因文案/上限需断言适配，逐条列理由仅限直接受影响断言）。

## 通过命令

`npm run check:all` / `npm test` 全量全绿 / `npm run lint` 零输出。

## 禁改清单

除 loop.ts、integrate.ts、tests/fx2-*、tests/u8-*（受影响断言适配）外一切禁改；最小化改动，既有行为（含 fx-1 全部修复）不得回退。禁 git 写操作；禁 mock；禁 any。

## 修复后

verifier 验收 → commit → 靶子重置 → 终验第 3 次（同 brief）。
