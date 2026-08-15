# u1b 验收报告：只读命令（status / frontier / tree / report）

> verifier 独立验收报告（对抗式）。验收基线：`docs/rewrite/acceptance/u1b-acceptance.md`（commit `552ae90`）。
> 机制依据：`docs/rewrite/orchestration.md`（verifier 不修代码、不改验收文档、禁 git 写操作）。

## 总结论：PASS

## 1. 防篡改核对

| 检查项 | 命令 | 结果 |
|--------|------|------|
| 验收文档零篡改 | `git diff 552ae90 -- docs/rewrite/acceptance/u1b-acceptance.md` | 空输出（零改动） |
| 验收文档 sha256 | `shasum -a 256 docs/rewrite/acceptance/u1b-acceptance.md` | `23ce2763e0ce6e181b7aa1a95bd4cab9a48e9c87b0d12d9adf69935de1017ae1` |
| 核对时 HEAD | `git rev-parse HEAD` | `431ced70755d0c1bf982501132cf64469461affa` |
| 契约层/已验收 unit 领地 | `git diff 431ced7 --stat -- src/dispatch.ts src/cli.ts src/events/types.ts src/store/ src/core/ src/gates/ src/handlers/` | 仅 `src/handlers/index.ts`（+21/-2）出现——**u2 领地，任务约定豁免**；dispatch / cli / events/types / store / core / gates 均未出现在改动列表，零改动 |

协调者合规变更确认：`fe514f4 fix(dispatch): token-prefix command matching so flags resolve correctly`（dispatch token 前缀匹配 + tests/dispatch.test.ts），为任务声明的协调者领地合规变更，不算篡改；此后（431ced7）dispatch 无进一步改动。

`git status --short` 甄别：

- u1b 领地（本次验收对象）：`src/readonly/index.ts`（M）、`src/readonly/{frontier,load,report,status,tree}.ts`（新增）、`tests/u1b-{status-frontier,tree-report,e2e}.test.ts`（新增）——与验收文档交付物清单一一对应（单测合并为 2 文件，符合「或合并为 ≤2 文件」）。
- u2 领地豁免：`src/handlers/*`、`tests/u2-*.test.ts`、`docs/rewrite/acceptance/u2-report.md`（另一 verifier 并行验收中）。
- 认知外/已知豁免：`AGENTS.md`（M）、`wave-endstate-execution*` drawio 系列文件。

## 2. 命令实跑（verifier 本人调用）

| 命令 | 结果 |
|------|------|
| `npm run check:all` | exit 0 |
| `npx vitest run tests/u1b-status-frontier.test.ts tests/u1b-tree-report.test.ts tests/u1b-e2e.test.ts` | 3 files / 22 tests 全绿，exit 0 |
| `npx eslint src/readonly/ tests/u1b-status-frontier.test.ts tests/u1b-tree-report.test.ts tests/u1b-e2e.test.ts` | 零输出，exit 0 |
| `npx vitest run`（全量回归，验收文档「通过命令」npm test 条款） | 13 files / 97 tests 全绿，exit 0（含 u1 / u3 / dispatch 契约 / u2 领地） |
| `npm run lint`（全量，验收文档「通过命令」条款） | exit 0 |

## 3. 真实性抽查（对照验收文档「单测验收 4 组 + E2E」逐项读源码核验）

### 3.1 只读性——真实断言，非空验证

- 单测 3 处 dispatch 前后对比事件流：`tests/u1b-status-frontier.test.ts:221,234`、`tests/u1b-tree-report.test.ts:103,184`（`expect(ledger.readAll()).toEqual(before)`）。
- 空账本不建文件断言：`tests/u1b-status-frontier.test.ts:240`、`tests/u1b-tree-report.test.ts:107,188`（`existsSync(ledgerPath(...)) === false`）。
- E2E 子进程级零副作用：`tests/u1b-e2e.test.ts:219`。
- 源码侧根因：`src/readonly/load.ts:33` 用 `existsSync` 前置探测，账本不存在时不构造 `EventLedger`（其构造函数会 `mkdirSync` 父目录），见 T3 对抗实证。

### 3.2 frontier 的 specGate 真用 checkSpecRules——真接线，非 stub

- `src/readonly/load.ts:20` `import { checkSpecRules } from "../gates/spec-rules.js"`（u3 已验收实现，git 确认 gates/ 自 431ced7 零改动）。
- `src/readonly/load.ts:40` `deriveStatus(unit, checkSpecRules)`——四命令（status/frontier/tree/report）状态列全部经同一注入点（`unitStatus`），无任何本地重实现或 stub。测试链路（computeFrontier / renderStatusList / renderTree / renderReportUnit → unitStatus）无法绕过该注入。

### 3.3 弱 spec + 审查 pass 停在 created（投影语义核心场景）——真实覆盖

`tests/u1b-status-frontier.test.ts:272-286`：acceptance 为空的弱 spec（触发 checkSpecRules rule①）+ `spec-review pass` → 断言 `w-weak  created  specs:1`、`specReady` 含 w-weak、`buildReady` 不含。注释明确「审查通过也无效：gate 挂在 spec 本身」。对抗抽查 T1e 在 tree 渲染路径复证（弱 spec 节点仍 `created`）。

### 3.4 空账本四命令——真子进程断言 exit 0 且不抛栈

`tests/u1b-e2e.test.ts:210-221`：真实 spawn `dist/cli.js`（CW_HOME 隔离 tmp），四命令逐一断言 `code === 0`、stdout 含 `(空账本)`、`stderr === ""`（不抛栈）、不创建账本文件。

### 3.5 其余单测验收条款

- 验收#1 status：多 unit 行格式、--unit 详情（briefRef / spec hash 前 12 位 / verdict 全列 / evidence runId / verify 覆盖 id）、不存在 unitId exit 1（含 --unit 缺值 exit 1）、--json 可 JSON.parse 且字段对得上（note 注明 Map → 数组形状）——`tests/u1b-status-frontier.test.ts:99-241` 全覆盖。
- 验收#2 frontier：三态账本 specReady 恰含 created、buildReady 恰含 spec-frozen、verified 不入组——`tests/u1b-status-frontier.test.ts:247-270`（精确 `toEqual`）。
- 验收#3 tree：三层含孤儿、乱序 append 验证渲染不依赖账本顺序、孤儿标 `!?` 且孤儿可再做父（孤儿子树挂其下）——`tests/u1b-tree-report.test.ts:76-95`（整树逐行精确 `toEqual`）。
- 验收#4 report：完整链 unit 覆盖标记 A1 ✓ / A2 ✗、spec/evidence/verifyRuns 齐全——`tests/u1b-tree-report.test.ts:114-151`。
- E2E 条款（两状态 fixture 用 EventLedger 直写、不依赖 u2 CLI 写命令——并行保护）：`tests/u1b-e2e.test.ts:70-122` beforeAll 直写构造，符合验收文档指定构造（leaf 只覆盖 A1 → 停 spec-frozen）。

## 4. 行为对抗抽查（真实子进程 + tmp + CW_HOME 隔离，零 mock，17/17 PASS）

| # | 对抗点 | 结果 |
|---|--------|------|
| T1a-e | 4 层深树 + 6 节点乱序 append + 双树 + 孤儿链：缩进逐层 +2 空格；兄弟顺序 = 账本 UnitCreated 顺序；孤儿 `!?` 且其子挂其下；弱 spec 节点在 tree 中仍 created | 5/5 PASS |
| T2a-d | report：零 VerifyRan 的 unit 全部 ✗；VerifyRan result=fail 覆盖 A1 不算覆盖（4✗/0✓）；--unit 限定排除他 unit | 4/4 PASS |
| T3 | 全新 CW_HOME（目录不存在）+ 空账本项目：四命令 exit 0、stdout 恰为 `(空账本)\n`、stderr 空，执行后 CW_HOME 目录仍不存在——零目录副作用（load.ts existsSync 前置探测的实证） | 5/5 PASS |
| T4 | --json 空账本一致性探针（见 §5 观察 O-1） | INFO（不影响判定） |
| T5a-c | `--unit=u5` 等号形式 exit 0 命中详情；status --json 字段齐全（units 数组元素含 unitId/status/specs/verdicts/evidences/verifyRuns，status 派生值 spec-frozen 正确）；四命令循环 3 轮共 12 次调用后事件数不变 | 3/3 PASS |

与验收文档矛盾项：无。

## 5. 观察项（不构成 fail，供主 agent 裁决）

**O-1（minor，跨命令不一致）**：空账本 + `--json` 时两命令行为相反——`status --json` 输出纯文本 `(空账本)\n`（JSON.parse 会 throw，机器消费者破坏）；`frontier --json` 输出空结构 `{"specReady": [], "buildReady": []}`。验收文档内部两条款在此场景冲突（M0 通用条款「账本不存在时输出(空账本)类提示」 vs 「--json 输出结构化 JSON」），builder 在两命令上做了相反裁决。status 的做法字面满足通用条款，frontier 的做法对 JSON 消费者更合理，均不违反锁定条款；建议后续统一（倾向 --json 模式恒输出结构化空形态）。

## 6. 结论

- 防篡改：验收文档零改动（sha256 见 §1）；u1b 领地外仅 u2 豁免项与认知外文件。
- 命令实跑：check:all / u1b vitest 22 绿 / eslint 零输出 / 全量 97 绿 / 全量 lint 绿。
- 真实性：验收文档单测 4 组 + E2E 条款全部有真实断言承载（只读性有前后对比实证、specGate 真接线 checkSpecRules、弱 spec 核心场景真实覆盖、空账本真子进程断言）。
- 对抗抽查：17/17 PASS，未发现与验收文档矛盾的行为。

**u1b 验收通过（PASS）**，附观察项 O-1 供主 agent 裁决。
