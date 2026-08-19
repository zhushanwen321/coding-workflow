# mx-4 验收标准：spec 打回代数预算放宽（默认 2 → 10，可配置）

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：用户 2026-08-19 裁决（M4 gate 二跑后）——「根因是 agent 侧 spec 质量（designer 两版都没过审），增加轮数呢？多增加几轮呢？默认支持 10 轮。暂时不允许收官」。实证：m4-gate2-report.md leaf-renderer 被 reviewer 两代全新实质意见打回（v1 验收真空 → v2 e2e 脚本未定义）即触顶转人工——2 代预算对「reviewer 真意见非活锁」的场景过紧，designer 未获充分自愈空间；真活锁场景 10 轮也会烧穿（每轮 ≥2 spawn 成本可控），活锁防护语义保留。

## 1. 目标

specReviewDeadlock 的打回代数阈值从硬编码 2 放宽为默认 10，并开放 `--max-spec-rejects` 运行时配置（只影响 runner 判定；只读命令保持默认语义）。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/readonly/frontier.ts` | 修改 | ①`SPEC_REVIEW_DEADLOCK_FAILS` 值 2 → 10，注释重写（保留 mx-1 MF2 活锁防护语义说明；补放宽依据 = M4 gate 二跑实证 reviewer 两代真意见非活锁被误停；「取 2 而非 3+」旧理由段删除）②`computeFrontier` opts 增 `maxSpecRejects?: number`（缺省回落常量 10；判定处 `>= opts.maxSpecRejects ?? SPEC_REVIEW_DEADLOCK_FAILS`）③模块头 :17 与维度注释 :67 的「≥2」表述同步为「≥ 阈值（默认 10）」 |
| `src/handlers/run.ts` | 修改 | `--max-spec-rejects <n>` 可选 flag：正整数 ≥1 校验（模式对齐 --max-idle-ms 的本地解析，非法值 exit 1 + 可操作文案含合法范围）→ `RunLoopOptions.maxSpecRejects?: number`；帮助文本与用法行同步 |
| `src/runner/loop.ts` | 修改 | RunLoopOptions 类型加 `maxSpecRejects?: number`；`computeFrontier` 调用点传参；specReviewDeadlock escalation 文案若含阈值数值则改为动态值（「已打回 N 代 / 预算 M 代」形态或等价——现有「已打回 N 代」文案保留，补预算上下文） |
| `tests/mx4-reject-budget.test.ts` | 新建 | §5 D 系条款 |
| `tests/mx3-generation-count.test.ts` 等既有迁移 | 迁移 | G2/G3（2 代 deadlock）改用注入小阈值构造（`--max-spec-rejects 2` 或 computeFrontier opts 传 2）——语义测试保留小阈值快速路径，测试名/注释标注 mx4 迁移 |

## 3. 禁改清单（违反 = FAIL）

- `src/verify/`、`src/gates/`、`src/testrun/`、`src/store/`、`src/core/`、`src/runner/{integrate,worktree,human-loop,brief}.ts`、`src/runner/spawn/`（全部，含 pi.ts——session 改动已随 mx-3 交付）、`src/handlers/{create,evidence-submit,review-submit,verify}.ts`、`src/cli.ts`、`src/dispatch.ts`、`docs/`、`archive/`
- **语义锁定**：`specReviewFailCounts` 打回代数语义（同代多 fail 计 1 代、重提不清零、只认 role=reviewer）零变更——本 unit 只动阈值与配置面；flake 连挂 2 次（rv-5）不动；`INTEGRATION_MAX_CONSECUTIVE_FAILS = 1`（rv-4）不动；事件 schema 零变更
- `docs/rewrite/acceptance/` 全部既有文档

## 4. 关键口径（锁定）

- **默认 10 的语义**：同一 unit 累计 10 个打回代数（designer 修出的第 10 版 spec 仍被打回）才判活锁转人工；第 1-9 代打回均走 specFixPending 正常派 designer。
- **配置作用域**：`--max-spec-rejects` 只影响 `cw run` 的 runner 判定（loop 的 computeFrontier 传参）；`cw frontier` / `cw status` 只读命令恒用默认 10——两视图在默认值下一致，flag 调整时只读命令仍显示默认语义（文档口径：转人工预算是运行策略，默认值是投影展示语义）。
- **flag 校验**：正整数 ≥1；`--max-spec-rejects 1` 合法（最严：首代打回即转人工，等价激进模式）；0/负数/非数字 → exit 1 + 可操作文案。
- **escalation 文案**：转人工时的文案使人工能看出「已达预算 M 代」——具体措辞 builder 定，验收只锁「含预算值或代数值」一点。

## 5. 新增测试条款（真实子进程 + tmp + CW_HOME 隔离，零 mock）

### tests/mx4-reject-budget.test.ts
- **D1 默认阈值 10**：直写账本构造 9 代打回（9 轮 SpecSubmitted→fail 各代）→ `cw frontier --json` 无 specReviewDeadlock、有 specFixPending；构造 10 代 → specReviewDeadlock 出现 + escalation 文案含代数/预算。
- **D2 flag 参数化全链**：`cw run --max-spec-rejects 2`（human 模式）下 2 代打回即转人工（复用 mx3 G2 场景形态）；同账本默认配置下不转人工——证明 flag 只作用 runner 侧。
- **D3 flag 校验三态**：`0` / `-1` / `abc` → exit 1 各含可操作文案；`1` 合法。
- **D4 只读默认语义**：`cw frontier`（无 flag 概念）对 5 代打回 unit 显示 specFixPending（默认 10 不误报 deadlock）。
- **D5 常量锚**：`SPEC_REVIEW_DEADLOCK_FAILS` 导出值 = 10（import 断言——配置默认值单一事实源）。

### 既有迁移
- mx3 G2/G3 注入阈值 2 构造（语义回归保持）；测试名/注释标注「mx4 迁移：默认 10，注入 2 快速构造」。

## 6. 通过命令

```
cd <仓库根> && npm run check && npm run check:tests
npx vitest run tests/mx4-reject-budget.test.ts tests/mx3-generation-count.test.ts tests/mx1-independent-review.test.ts tests/u5b-loop.test.ts tests/u7-loop.test.ts
npx eslint src/readonly/frontier.ts src/handlers/run.ts src/runner/loop.ts tests/mx4-*.test.ts
全量 npx vitest run → 全绿
```

## 7. status

pending → building（builder 派发时由主 agent 更新）
