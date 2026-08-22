# u3 验收标准：spec gate 五规则

> **锁定文件**：本文档是派发基线（已入 git）。builder 与 verifier 均禁止修改本文件；主 agent 流转状态只改本行下方 status 字段与 ledger。
>
> status: pending（pending → building → built → verifying → verified → committed / rejected）

## 目标

交付 spec 提交时的机器前置五规则（确定性纯函数）。canon 依据：`design-rewrite-architecture.md` §3.3 D3「机器前置规则」；父文档（增量版）`design-parent-architecture.md` §6.5 D5。

## 交付物

| 文件 | 内容 |
|------|------|
| `src/gates/spec-rules.ts` | `checkSpecRules(spec: SpecSubmittedPayload): SpecRulesResult`（类型 import 自 `src/events/types.ts`，含 SpecRulesResult 定义——已存在，禁止改动） |
| `tests/u3-spec-rules.test.ts` | 表驱动单测（见下） |

## 五规则（判定语义，验收逐条对应用例）

| # | 规则 | 判定 |
|---|------|------|
| ① | 验收非空 | `spec.acceptance.length > 0` |
| ② | 核心 case 必须有 e2e 级机器验证 | 对每个 `core: true` 的用例：至少存在一条 `type ∈ {e2e-real, e2e-mock}` 且 `type ≠ manual` 的用例与之对应（实现口径：core 用例自身必须满足 `type ∈ {e2e-real, e2e-mock}`） |
| ③ | e2e 用例必须有可执行 command | 每条 `type ∈ {e2e-real, e2e-mock}`：`command` 非空字符串，且 command 首个 token 在 PATH 可解析（`which` 等价检查；不检查项目内文件——设计期尚不存在，真正执行在 verify 期） |
| ④ | mock 必须附保真说明 | 每条 `type = e2e-mock`：`mockFidelityNote` 非空 |
| ⑤ | 至少一条 unit 级用例 | 存在 `type = "unit"` 的用例 |

规则②实现口径说明：canon 原文「每个核心 case 至少一条 type∈{e2e-real,e2e-mock}」——一个 unit 的核心 case 集合整体需含 e2e 级验证。为可机器判定且不过度设计，M0 口径定为：**每条 core 用例自身 type 必须是 e2e-real 或 e2e-mock**（核心 case 逐条自检，而非集合模糊对应）。此口径写死，后续如需放宽走 spec 变更。

## 规则口径追加（后续波次授权追加；本节由 al-3 基线 D8 同步）

u3 只交付①-⑤；⑥-⑨由 fx-1 / rv-2 / mx-2 / mx5-1 各自基线追加（口径出处 = 各自验收文档）。al-3（《验收分层与成本治理》设计 D4/D5，详见 `docs/rewrite/acceptance/al-3-acceptance.md`）追加两条：

| # | 规则 | 级别 | 判定 |
|---|------|------|------|
| ⑩ | topic 层条目要求 split 非空 | fail | `spec.acceptance` 存在 `layer === "topic"` 条目而 `spec.split.length === 0` → 逐条目列缺口（多缺口全列不短路）。语义闭环：split 非空 ⟺ 有子节点 ⟺ 有集成执行点 ⟺ topic 条目会被执行；split 空声明 topic = 条目永无执行点的真空，提交期拒绝。已知边界：单 unit topic（root 无子、split 空）同样拒绝——它本就没有集成执行点。错误文案含两个恢复方向（上收 root spec 标 topic / 去 layer 按 unit 层声明） |
| ⑪ | unit 层全量回归形态成本启发式 | warning | `layer` 未声明或 `"unit"` 的条目，command 空白切分 token 纯词法命中全量回归形态（不执行命令）→ 入账继续（ok 判定只看 failures 不变）+ `SpecRulesResult.warnings` 交 `evidence submit` stderr 逐条打印。形态 A：`[npx/pnpm/yarn/bun/bunx 可选前缀] vitest run` 且 run 后无位置参数（后续 token 全 `-` 开头或无）；形态 B：首 token `npm/pnpm/yarn/bun`，允许 `run` 中缀，script 名恰为 `test`/`lint` 且其后无位置参数。wrapper 脚本 / script 别名封装 / `make test` 显式不枚举（诚实漏报面，reviewer 任务书第六维语义审兜底）；warning 级理由：静态形态判定有误杀面，硬拒会逼出 wrapper 规避动作 |

⑩⑪ warning/缺口文案要素、多缺口排序（规则序号升序）与既有①-⑤ 错误信息要求同源：每条含规则编号 + 具体条目 id（当适用）+ 恢复方向。

## 错误信息要求（可操作）

`failures` 每条必须包含：规则编号 + 具体 acceptance id（当适用）+ 缺什么。示例：`"rule③: A2 (e2e-real) 缺可执行 command"`、`"rule⑤: spec 无任何 unit 级用例"`。禁止只输出「校验失败」。

## 单测验收（表驱动，每规则正反例）

1. 合法 spec（含 core e2e-real 带 command + 非 core unit 用例 + e2e-mock 带保真说明）→ ok=true, failures=[]。
2. 空 acceptance → 拒，failures 含 rule①。
3. core 用例 type=manual → 拒，failures 含 rule② 与该 id。
4. e2e-real 无 command → 拒，failures 含 rule③ 与该 id。
5. e2e-real 的 command 首 token 不存在（如 `no-such-bin-xyz foo`）→ 拒，failures 含 rule③。
6. e2e-mock 无 mockFidelityNote → 拒，failures 含 rule④ 与该 id。
7. 无 unit 用例 → 拒，failures 含 rule⑤。
8. 多缺口同时存在 → failures 按规则序号升序全部列出（不短路）。
9. 非 core 的 manual 用例不触发规则②（manual 保留但核心禁用）。

## 通过命令（verifier 逐条实跑）

```
npm run check:all
npm test
npm run lint
```

## 禁改清单

- `src/events/types.ts`（只许 import，禁止任何修改——与 u1 并行，该文件归 u1 owner）。
- 本验收文档、`docs/rewrite/` 其他文件、`archive/`、`tests/smoke.test.ts`、`src/cli.ts`、`src/index.ts`。
- 禁止 git 写操作；禁止 mock 框架。
- 不接入 cli/账本流程（接线在后续 unit；本 unit 只交付纯函数 + 单测）。
