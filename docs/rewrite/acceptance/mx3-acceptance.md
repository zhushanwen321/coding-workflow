# mx-3 验收标准：M4 gate 两缺口修复（spec-review 身份强校验 + deadlock 代数计数）+ spawn session 保留

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：m4-gate-report.md §5.1（builder 重提 spec 后自审 pass 绕过独立审查）+ §5.3（reviewer 单 spawn 内试探性 verdict 耗尽 2 额度误杀 designer）+ §5.5（escalation 消息重复打印）。第一手证据：/tmp/m4-gate-evidence/（账本 seq8 `fail comment:"test" role:"reviewer"` 同代双 fail；seq22 `pass` 无 role——builder 自审）。用户 2026-08-19 确认立项，并追加要求 spawn 保留 pi session（无 session 无法追查 agent 行为链——M4 gate 追查时 reviewer 试探提交在 stdout 零痕迹）。探针已实测（/tmp 清理）：`--session-dir <dir> --name <n>` 使 session JSONL 落指定目录，内含 `toolCall` 事件与命令原文逐字可查。

## 0. 背景与根因（锁定，不可改写）

- **§5.1 现场**：leaf-renderer builder 三轮 verify fail 触发 flake 转人工后，在仍存活的同一 spawn 内重提 spec + 自审提交 spec-review pass（无 role）。三因叠加：①派发 gate 缓派使 reviewer 无法进场（本意防竞态，正确保留）②抢答警告 `specReviewerDispatched` 豁免 = 本 run 派发过该 unit 的 reviewer 即永久豁免，过宽③role 弱声明——review submit 无 role 也入账、fold 不校验身份。结果：该版 spec 未经任何独立审查即冻结。
- **§5.3 现场**：leaf-app reviewer 在单 spawn 内先交试探 verdict（comment="test"，role=reviewer）再交正式 fail，两 fail 同一版 spec、间隔 17 秒无新 SpecSubmitted；deadlock 计数按「fail verdict 总数 ≥2」即触发，designer 从未获修复机会即永久停派。
- **§5.5 现场**：flake escalation 整段消息在日志中连续出现 2 次。

## 1. 目标

spec-review 结论的身份强校验（双层防线）+ deadlock 计数改按 spec 代数（消试探误杀，保留 ping-pong 活锁防护）+ escalation 输出去重 + spawn session 落盘保留（agent 行为链可追查）。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/handlers/review-submit.ts` | 修改 | **入账层强制**：`--verdict-kind spec-review` 时必须携带 `--role reviewer`（缺失或 role≠reviewer → exit 1 拒绝入账 + 可操作文案：指出 spec-review 结论必须由 reviewer 身份提交、补 `--role reviewer` 重试）。exec-review 的 role 保持可选（gate 发现的是 spec-review 绕过，exec-review 前置 verified 机器验证，不扩范围） |
| `src/core/fold.ts` | 修改 | **投影层消费校验（纵深第二层）**：spec-frozen 转换、specFixPending 输入、specReviewDeadlock 计数输入——只消费 `role === "reviewer"` 的 spec-review verdict；role 缺失/其他值的 spec-review verdict 不驱动状态转换（历史事件防御性兼容：入账层已拦新事件，fold 校验兜住任何绕过入账层的路径） |
| `src/readonly/frontier.ts` | 修改 | **deadlock 代数计数**：`specReviewFailCounts` 语义从「fail verdict 总数」改为「**打回代数**」——同一版 spec（同一条 SpecSubmitted 之后）的多条 role=reviewer fail 只计 1 次打回；deadlock = 打回代数 ≥2。specFixPending 谓词同步：最后一条 spec 之后最近一条 role=reviewer spec-review verdict 为 fail 即成立（同代后续 fail 不改变谓词语义） |
| `src/runner/loop.ts` | 修改 | ①**抢答豁免收紧**：`specReviewerDispatched` 豁免从「本 run 派发过即永久豁免」改为「该 verdict 入账轮次该 unit 存在 in-flight reviewer spawn 才豁免」（loop 内存 inFlight 表可查；收紧后 builder in-flight 期间的自审提交会打 stderr 警告——可见性增强，不阻断）②**escalation 输出去重**：flake/deadlock escalation 按签名去重（对齐 fx-2 上限出口的消息去重模式），同签名同轮不重复打印 |
| `src/runner/spawn/pi.ts` | 修改 | **session 落盘**：删 `--no-session`，改为 `--session-dir <req.artifactDir>` + `--name <unitId>-<role>`（session JSONL 随 spawn 产物落 topic 目录，与 brief/stdout/stderr 同处；文件名 `<时间戳>_<uuid>.jsonl` 天然不冲突，同 artifactDir 多次 spawn 各自新文件）。探针已验证：toolCall 事件含命令原文。**注意**：本项是本 unit 对 mx-1「pi.ts 零改动」锁定的显式解除（用户 2026-08-19 追加要求），改动仅限 session 参数行，模型注入链（req.env CW_AGENT_MODEL → --model）零变更 |
| `tests/mx3-role-gate.test.ts` | 新建 | §5 R 系条款 |
| `tests/mx3-generation-count.test.ts` | 新建 | §5 G 系条款 |
| `tests/mx1-*.test.ts` 等既有迁移 | 迁移 | ①全部「合法 reviewer 提交 spec-review」用例补 `--role reviewer`（fold 收紧后无 role 的提交不再驱动状态）②mx1 T2 形态①「不重提的两连 fail 触发 deadlock」断言**反转**为「不 deadlock、specFixPending 派 designer」（语义变化见 §4）③T2 形态②（fail→重提→fail）断言保持 deadlock（两代打回）。迁移处在测试名或注释标注 mx3 语义变化 |

## 3. 禁改清单（违反 = FAIL）

- `src/verify/`、`src/gates/`、`src/testrun/`、`src/store/`、`src/runner/{integrate,worktree,human-loop,brief}.ts`、`src/runner/spawn/`（**例外：pi.ts 仅限 session 参数行改动**，见 §2 交付物——模型注入链 CW_AGENT_MODEL → --model 零变更；types.ts/lifecycle.ts 仍禁）、`src/handlers/{create,evidence-submit,run,verify}.ts`、`src/cli.ts`、`src/dispatch.ts`、`docs/`、`archive/`
- 事件 schema 零变更（role 字段 mx-1 已有，本 unit 只收紧消费侧）
- 派发 gate（同 unit 任意 role in-flight 缓派）语义零变更——§5.1 三因中它是正确防线
- `docs/rewrite/acceptance/` 全部既有文档

## 4. 关键口径（锁定）

- **双层防线的边界如实披露**：入账必填 + fold 只认 reviewer 防的是**无意识自审**（builder/designer 按自己知道的命令形态提交，不带 role）；不防**有意谎报**（提交者显式声明 `--role reviewer` 冒充——role 是自报字段，账本无法验证 spawn 身份）。spawn token 级身份认证列为后续候选（协议改动大，本 unit 不做）；本防线价值 = 堵默认路径 + 谎报者必须在账本留下显式 role=reviewer 声明（事后审计可见、可对照 spawn 记录）。
- **打回代数定义**：一条「打回」= 某条 SpecSubmitted 之后的首条 role=reviewer fail verdict；同一 SpecSubmitted 之后的后续 fail（试探、重复提交）不重复计数。deadlock = 打回代数 ≥2（即 designer 修出的第二版 spec 仍被打回——真 ping-pong）。代数锚点 = SpecSubmitted 事件边界（specHash 变化必然伴随新 SpecSubmitted）。
- **语义变化显式接受**：原「不重提的两连 fail（形态①）」不再 deadlock——按代计数后它只是 1 次打回，specFixPending 正常派 designer，designer 不动时由 idle 出口兜底。原设计把形态①计入 deadlock 是过度保守（对试探性提交零容忍的真实代价）；MF2 教训（重提不清零）由「代数累计」保持：fail→重提→fail = 2 代打回 = deadlock。
- **入账拒绝是纯拒绝不入账**：被拒的 spec-review（缺/错 role）不产生任何事件——提交者按错误文案补 role 重试（reviewer brief 与 human 指令模板已含 --role reviewer，正常链路零影响；u5b「人扮演 reviewer」既有用例迁移补 role）。
- **escalation 去重签名**：消息文本 + unitId 复合签名；去重仅作用输出通道（stderr/summary），escalation 的停止派发语义不变。
- **抢答豁免收紧后**：正常 reviewer spawn 内的提交（in-flight reviewer 存在）豁免不误报；reviewer spawn 已结算后的晚到提交、builder in-flight 期间的自审提交——警告打印（不阻断不入账，审计可见性）。
- **session 保留语义**：session 是 spawn 审计链的一部分（与 brief/stdout/stderr 同级），随 topic 目录持久保留（fx-4 P2 永久保留策略延续）；human 适配器无进程无 session（不适用，N/A）；`--name <unitId>-<role>` 用于 pi session 列表可辨识；session 文件不参与任何 gate 判定（纯审计载体）。

## 5. 新增测试条款（真实子进程 + tmp + CW_HOME 隔离，零 mock）

### tests/mx3-role-gate.test.ts
- **R1 入账强制三态**：spec-review 无 --role → exit 1 + 文案含 `--role reviewer` 与恢复动作；`--role designer` → exit 1；`--role reviewer` → 入账成功 payload.role=reviewer。exec-review 无 role → 仍入账（范围外不收紧）。
- **R2 fold 只认 reviewer**：构造 role=designer 的 spec-review pass 事件直写账本（绕过入账层，验纵深第二层）→ 投影不进 spec-frozen（status 停留 created/spec 提交态）；同账本补 role=reviewer pass → spec-frozen。
- **R3 全链防绕过复现（§5.1 场景重演）**：human E2E——builder 形态提交者带 build 证据后尝试自审 spec-review（不带 role）→ 被拒 exit 1；带 `--role reviewer` 谎报 → 入账但 stderr 出现抢答警告（builder in-flight 期间无 reviewer in-flight，豁免不成立）——断言警告行存在且循环继续。
- **R4 历史兼容锚**：fold 对 role=reviewer 的既有事件行为与 mx-1 基线逐字节等价（mx1 既有测试全绿即证）。

### tests/mx3-generation-count.test.ts
- **G1 同代双 fail 不 deadlock（§5.3 场景重演）**：同版 spec 上两条 role=reviewer fail（模拟试探 + 正式，间隔无新 SpecSubmitted）→ frontier 无 specReviewDeadlock、specFixPending 成立派 designer；无 escalation。
- **G2 跨代双 fail deadlock（ping-pong 保持）**：fail → 新 SpecSubmitted → fail → deadlock 转人工（MF2 教训锁定：重提不清零）。
- **G3 三代收敛上限**：fail → 重提 → fail → 重提 → fail → 第三代打回仍计入（打回代数=3 ≥2，deadlock 不重复 escalation——去重断言并入此处）。
- **G4 escalation 去重**：deadlock 触发轮 stderr 只出现一次完整 escalation 文案（签名去重）；跨 unit 的不同 escalation 各自打印。

### spawn session 保留（并入 mx3-generation-count 或独立块均可，真实 pi 调用）
- **S1 session 落盘**：pi spawn（真实子进程，微任务 brief）完成后 `req.artifactDir` 下存在 `*.jsonl` session 文件，且文件内容含 `toolCall` 事件与 brief 触发的命令原文（逐字可查——M4 gate 追查场景的回归锚）。
- **S2 参数与命名**：spawn 命令行含 `--session-dir <artifactDir>` 与 `--name <unitId>-<role>`，不再含 `--no-session`（u6c 既有命令行断言同步迁移）。
- **S3 多 spawn 不冲突**：同 unit 同 role 两次 spawn（真实或两次 spawn 调用）后 artifactDir 下两个 session 文件并存（时间戳+uuid 命名天然不冲突，无覆盖）。

### 既有迁移（mx1/u5b/u7/fx3 等，跑全量发现全集）
- 合法 reviewer spec-review 提交补 `--role reviewer`（预计 10+ 处）；mx1 T2 形态① 断言反转 + 注记「mx3 语义变化：按打回代数计数」。

## 6. 通过命令

```
cd <仓库根> && npm run check && npm run check:tests
npx vitest run tests/mx3-role-gate.test.ts tests/mx3-generation-count.test.ts tests/mx1-independent-review.test.ts tests/u5b-loop.test.ts tests/u7-loop.test.ts tests/fx3-loop-split-dispatch.test.ts tests/u6c-pi-adapter.test.ts
npx eslint src/handlers/review-submit.ts src/core/fold.ts src/readonly/frontier.ts src/runner/loop.ts src/runner/spawn/pi.ts tests/mx3-*.test.ts
全量 npx vitest run → 全绿
```

## 7. status

pending → building（builder 派发时由主 agent 更新本行为 committed，其余状态字段不动）
