# u4a 验收报告：干净重跑 + cw verify

> verifier 独立验收报告（对抗式）。验收基线：commit `115e52c` 的
> `docs/rewrite/acceptance/u4a-acceptance.md`（锁定文件，本报告未改动它）。
> 验收执行时 HEAD：`22e0ffe0598500fffb7088784983595444d22c19`（u5 交付 commit，
> 在基线之后由主 agent 提交）。验收日期：2026-08-15。

## 总结论：FAIL（1 条 major 缺陷；其余全部条款 PASS）

`cw verify --unit <id> [--timeout-ms <n>]` 的 `--timeout-ms` flag 在 CLI 层
**对一切合法数字值静默失效**（实测 `--timeout-ms 500` 无法把 sleep 2 的用例判
超时，回退默认 10 分钟），违反验收文档「M0 命令规格（锁定）」第 3 条
「timeout 默认 10min（--timeout-ms 覆盖，超时 kill 且该条 fail）」。按
「与验收文档矛盾 = fail」口径判 FAIL。缺陷详情见 §5 对抗抽查 C。

## 1. 防篡改

| 检查 | 结果 |
|------|------|
| `git diff 115e52c -- docs/rewrite/acceptance/u4a-acceptance.md` | 空 |
| 验收文档 sha256（工作区 vs 115e52c blob） | 双方均为 `2fc107f95a9261104fb467d49fd82bb21254728afc8167651104940fae730904`，一致 |
| 契约层 diff（dispatch/cli/events/store/core/gates/readonly/handlers 既有文件） | 全部为空 |
| `src/testrun/` diff | 非空：`e2e-sh.ts/registry.ts/vitest.ts` 共 +199 行——全部是 u5 交付物（commit `22e0ffe`），契约层 `types.ts` 本身零改动，非 u4a 篡改 |
| `src/handlers/index.ts` diff | 仅追加：`import { handleVerify }` + verify 注册项（1 个 CommandEntry），符合「只增注册」约束 |
| `git status --short` | `M AGENTS.md`（认知外）、`M src/handlers/index.ts`（上述合法追加）、`?? src/verify/`、`?? src/handlers/verify.ts`、`?? tests/u4a-verify.test.ts`、`?? tests/u4a-e2e.test.ts`、`?? wave-endstate-execution.drawio*`（认知外）。无越界文件 |

## 2. 通过命令实跑

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0 |
| `npm test` | **17 文件 / 123 测试全部通过**（Duration 10.19s），与预期 123 一致；其中 u4a 领地 12 个（u4a-verify 9 + u4a-e2e 3） |
| `npm run lint` | exit 0，零输出 |

## 3. 真实性抽查（测试源码 vs 验收文档条款）

| 验收文档条款 | 测试证据（文件:行） | 结论 |
|------|------|------|
| 单测1 checkout 检出内容一致 + porcelain 空 | tests/u4a-verify.test.ts:70-90（2 commits 真仓库，b.txt 不存在断言 + porcelain 空） | PASS |
| 单测2 不存在 commit → error 不抛 | tests/u4a-verify.test.ts:94-102 | PASS |
| 单测3 三态 + 产物落盘 | tests/u4a-verify.test.ts:107-146（真过/exit 3 真挂/500ms+sleep 2 超时；`.timeout` 标记文件内容断言、挂的 stderr 含 "boom"） | PASS |
| 单测4 缺 command | tests/u4a-verify.test.ts:150-159（断言含「验收 X9 缺 command」且 stderr 产物落盘） | PASS |
| 单测5 exit 三态 | tests/u4a-verify.test.ts:251-322（0/1+stderr 列 id/缺 spec 2 无入账/缺 build 2 无入账/unit 不存在 2/缺 --unit 1） | PASS |
| E2E 全链 fail 场景 acceptanceIds 语义 | tests/u4a-e2e.test.ts:143 `expect(runs[0]?.acceptanceIds).toEqual(["A1", "M1"])` —— **确切集合断言**（A1=机器 pass、M1=manual、A2/A3=fail 均不在内，spec 含 4 条），非仅长度/存在性；单测侧 :295 同样 `toEqual(["A1","M1"])` | PASS |
| E2E 修好 → verified | tests/u4a-e2e.test.ts:158-184（真实子进程 `cw status` 断言 `verified` + `lastVerify:pass`） | PASS |
| P2 同 commit 重跑一致性 | tests/u4a-e2e.test.ts:186-203：`expect(r2.cases).toEqual(r1.cases)` 逐字段深比较（id/name/status）+ `exitCode` 相等 + runId 不同——非仅 result 字符串 | PASS |
| P7 porcelain 干净性自证 | src/verify/checkout.ts:42-58 源码真实存在 porcelain 非空即 error 的检查；E2E 因临时目录已清理按验收文档 fallback 转 u4a-verify.test.ts:82-86 断言（验收文档明示允许该 fallback） | PASS |
| exit 2 不入账（源码路径） | src/handlers/verify.ts 全部 6 个 exit 2 出口（:58 unit 不存在、:75 缺 spec、:81 缺 build、:89 checkout 失败、:101 执行框架异常、:126 append 失败）均先于 `tryAppend`（:124）return，无任何 append 调用 | PASS |
| 超时路径（库层） | src/verify/run.ts:112-126（ETIMEDOUT 判定 + `.timeout` 标记 + stderr 记 timeout）；单测验收3 真实用例 | PASS（但 CLI flag 层失效，见 §5-C） |

## 4. 行为对抗抽查（真实子进程 `node dist/cli.js` + tmp git 仓库 + 隔离 CW_HOME）

### A. `echo ok`（exit 0、无产物语义）作为 e2e-real 验收命令 → 判 pass

实测：stdout `A1 pass`、result=pass、exit 0、acceptanceIds 含该 id。
按验收文档锁定的 M0 简化口径（exit code 判定，适配器 parse 接线属 u4b），
此为**符合文档的预期行为**，不判缺陷。如实记录，供 u4b 收紧时回归。

### B. verified 后重复 verify → 幂等重跑 + 审计追加入账

实测：同 unit 连续两次 verify，均 exit 0；events.log 追加 2 条 VerifyRan
（runId `verify-0c4fcc41…` / `verify-b5e7ee32…`，reportHash 不同，
acceptanceIds 均为 `["A1","U1","M1"]`）；`cw status` 显示
`adv1 verified specs:1 evidences:1 lastVerify:pass`。符合审计语义。PASS。

### C. `--timeout-ms 500` + 验收命令 `sleep 2` → **超时未生效，判 pass（缺陷）**

实测输出：`S1 pass`、`result=pass`、exit 0，无 `.timeout` 标记文件，
sleep 2 完整跑完（总耗时 >2s）。同一命令在 runAcceptances 库层直测
（单测验收3，500ms 上限）正确判 timeout fail——缺陷只在 CLI flag 传递层。

根因（verifier 定位，三段证据链）：

1. minimist 探针：`minimist(['--timeout-ms','500'])` → `argv["timeout-ms"]`
   值为 `500`，`typeof === "number"`（minimist 默认把数字型 flag 值转 number，
   `--timeout-ms=300` 同样）。纯数字字符串无任何输入形式保持 string。
2. `src/handlers/common.ts:38-44` `stringArg` 仅 `typeof value === "string"`
   才返回，number 值 → `undefined`。
3. `src/handlers/verify.ts:51` `parseTimeoutMs(stringArg(ctx.argv, "timeout-ms"))`
   收到 `undefined` → 走缺省分支返回 `DEFAULT_TIMEOUT_MS`（600000ms），
   用户显式传入的 500 被静默丢弃，无任何警告。

推论：CLI 层该 flag **不存在任何有效传值形式**——数字值被静默忽略，
字符串值（唯一能进 parseTimeoutMs 的形态）全被 `/^\d+$/` 拒绝
（实测 `--timeout-ms abc` → exit 1 报非法，反证数字路径完全绕过解析）。
违反「M0 命令规格（锁定）」第 3 条。**severity: major。**

测试盲区说明：验收文档「单测验收」与「E2E real」清单均未包含
--timeout-ms 经 dispatch 层传递的条目（单测3 直测 runAcceptances 形参），
故 12 个 u4a 测试全绿但缺陷存活。修复时建议补一条 dispatch 层
`--timeout-ms` 数值传递的回归测试。

### D. 缺 spec（仅 build 证据）→ exit 2 且不入账

实测：exit 2，stderr 含可操作恢复动作；events.log 中该 unit 无任何
VerifyRan 记录。PASS。

## 5. 条款对照汇总

| 验收文档章节 | 状态 |
|------|------|
| 交付物清单（checkout.ts/run.ts/verify.ts/index.ts 注册/两测试文件） | PASS（全部交付，index.ts 仅追加） |
| M0 规格 §1 前置（unit 存在/spec/build 缺失 = exit 2） | PASS |
| M0 规格 §2 cleanCheckout + porcelain 自证 | PASS |
| M0 规格 §3 逐条执行 + 缺 command fail | PASS（库层） |
| M0 规格 §3 timeout 覆盖（--timeout-ms） | **FAIL（§5-C：CLI 层静默失效）** |
| M0 规格 §4 manual 并入 acceptanceIds | PASS |
| M0 规格 §5 产物落盘（stdout/stderr/.timeout/report.json） | PASS |
| M0 规格 §6 exit 三态 | PASS |
| M0 规格 §7 VerifyRan 入账语义（pass/fail 均入，exit 2 不入） | PASS |
| M0 规格 §8 stdout 人可读摘要 | PASS（实测逐条 `<id> <pass|fail|manual>` + 总结行） |
| P2 同 commit 重跑一致性 | PASS |
| P7 checkout 干净性 | PASS（fallback 形态，文档明示允许） |
| 单测验收 1-5 | PASS |
| E2E real 3 条 | PASS |
| 通过命令（check:all / test / lint） | PASS |
| 禁改清单 | PASS（无越界改动；u5 文件属其自有交付） |

## 6. 结论

单条 major 缺陷（`--timeout-ms` CLI 层失效，§5-C）与锁定命令规格矛盾，
按验收口径判 **FAIL**，打回 builder 修复。其余全部验收条款（防篡改、
通过命令、单测 5 组、E2E 3 条、acceptanceIds/exit 三态/P2/P7 语义）
实测通过。修复面集中在 `src/handlers/verify.ts:51` 的 flag 读取
（兼容 minimist number 形态），并建议补 dispatch 层数值传递回归测试。

---

## 复审附录（2026-08-15，针对性复审）

**复审总结论：PASS——首验 FAIL 1 major 已修复并复审通过。** 本附录针对
首验 §5-C 缺陷（`--timeout-ms` CLI 层无有效传值形式）的 builder 修复做
针对性复审；首验其余条款已 PASS，不重复全量验收。首验正文（上文）原样
保留，总结论以上一行复审结论为准。

### A. 修复证实（代码层）

`src/handlers/verify.ts`（untracked 新文件，属 u4a 领地）：

- 调用点 :51 改为 `parseTimeoutMs(ctx.argv["timeout-ms"])`——直接取
  minimist 原始值，不再经 `stringArg`（number 形态不再被丢弃）。
- 本地 `parseTimeoutMs` :159-178 分支矩阵与修复声明逐条一致：
  undefined → 默认 600000；number（有限且 >0）→ 直接用；string 匹配
  `/^\d+$/` 且 >0 → `Number()`；其余（裸 flag 的 boolean true、非数字
  string、0、负数）→ `{ok:false}` → 走 `fail()`（common.ts :62-65，
  exit 1），**无静默回退路径**。
- `src/handlers/common.ts` 零改动（不在 `git status` 变更列表）；
  tracked 变更仅 `src/handlers/index.ts`（verify 注册，首验已确认）与
  `docs/rewrite/ledger.md`（u4a 状态记录）；认知外文件仍为 AGENTS.md /
  drawio 系列，未触碰。

### B. 红性验证（新测试有效性证明）

1. 临时把 `parseTimeoutMs` 整体替换为无条件
   `return { ok: true, value: DEFAULT_TIMEOUT_MS }`（精确复现首验缺陷
   语义：值被丢弃、静默回退默认），`npm run build` 后跑两测试文件：
   **3 failed | 12 passed**——恰好 3 个新增测试全红
   （dispatch 层 number 传递、非法值 abc/0 报错、e2e 真实子进程超时），
   其余 12 个首验既有测试不受影响。缺陷被新测试有效捕获，非恒真。
2. 从字节级备份还原修复代码（还原后 sha256
   `d9462fc6…40987` 与复审前基线完全一致），重新 build 后
   **15/15 复绿**。临时改动零残留。

### C. 命令实跑

| 命令 | 结果 |
|------|------|
| `npx vitest run tests/u4a-verify.test.ts tests/u4a-e2e.test.ts` | 2 文件 15 测试全绿（首验 12 + 新增 3） |
| `npm test` | 17 文件 / 126 测试全绿（首验 123 + 新增 3） |
| `npm run check:all` | exit 0 |
| `npm run lint` | exit 0，零输出 |

### D. 行为对抗（真实子进程 `node dist/cli.js` + tmp git 仓库 + 隔离 CW_HOME）

| 输入 | 实测 | 判定 |
|------|------|------|
| `--timeout-ms abc` | exit 1，stderr：`非法 --timeout-ms "abc"…恢复动作：如 --timeout-ms 300000；省略则用默认 600000ms` | PASS（含合法形式与恢复动作） |
| `--timeout-ms`（裸 flag，minimist 解析为 boolean true） | exit 1，stderr 报 `非法 --timeout-ms "true"`，不静默回退 | PASS |
| `--timeout-ms=-5` | exit 1，同上报错形式 | PASS |
| `--timeout-ms=300000`（合法值对照组） | verify 正常执行，A1 pass、result=pass、exit 0 | PASS（证明数字路径真通，非一刀切拒绝） |

另：e2e 新增测试（u4a-e2e.test.ts :211-237）实锤复现首验 §5-C 场景——
`--timeout-ms 500` + sleep 2 验收 → exit 1 + `.timeout` 标记落盘 +
VerifyRan(result=fail) + acceptanceIds 不含超时条目（`["A3"]`）。

### E. 复审约束遵守

除本附录外零文件修改；红性验证临时改动已完全还原（见 B-2 指纹一致）；
全程无 git 写操作（无 add/commit/checkout/restore）。
