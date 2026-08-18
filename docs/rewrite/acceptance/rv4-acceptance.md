# rv-4 验收标准：红阶段默认接线 + 集成失败处置改进 + 契约配对化

> **本文件是防篡改基线：builder 与 verifier 禁止修改。**
> 依据：2026-08-18 五角度对抗审查（canon A-2/D5「三道 gate」、testrun D5「echo ok 防线依赖红阶段但红阶段无强制编排」、spawn A3「drift 任务书不含冲突事实 + 重试销毁人工 WIP」、canon A-7 残余「≡ 冻结配对比对」）+ 用户裁决（红阶段接进自动链路）。
> 依赖：rv-1（loop.ts）、rv-3（contract-match.ts 算法基线）committed 后派发。

## 1. 目标

`cw verify` 默认执行三道 gate（红阶段不再 opt-in），恒真测试在自动链路上必死；集成首次 fail 即转结构化处置（事实完整 + 人工窗口不被销毁）；契约比对升级为「consumer 期望 ≡ provider 冻结」配对语义（canon D6 原义）。

## 2. 交付物

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/handlers/verify.ts` | 修改 | ①红阶段默认执行：`--no-red-phase` 关闭；`--red-phase` 保留为显式同义（幂等，两者都出现以 --no-red-phase 为准）②执行时点：干净重跑 + 名字比对之后，红阶段 fail → verify 整体 fail（三道 gate 并列语义）③红阶段逐条结果并入 report.json 的 `redPhase` 节（结构：`[{id, discriminative, skipped?, reason}]`）；VerifyRan payload schema 不变（reportHash 已覆盖报告内容）④无父 commit（build commit 为仓库首提交）→ 该验收红阶段 skip（`skipped: true` + 原因「无父 commit，红阶段不适用」），不影响判定；manual 型验收不跑红阶段⑤`--red-phase` 旧行为「standalone 红阶段模式不写 VerifyRan」废除——统一为新语义（verify 总是入账）⑥帮助文案/usage 同步 |
| `src/verify/red-phase.ts` | 修改 | 仅限「从 standalone 模式到 verify 内嵌」需要的接口适配（如导出逐条判定入口供 verify.ts 组合）；patch 语义、四态判定、D 过滤逻辑零变更 |
| `src/runner/loop.ts` | 修改 | ①builder 任务书（designerFirstTasks 对应的 builder 步骤区）verify 步骤措辞补「cw verify 默认含红阶段检查（新测试在旧代码树必须 fail，恒真测试会被拒）」②`INTEGRATION_MAX_CONSECUTIVE_FAILS` 语义从 2 改 1（常量在 frontier.ts）③integrationDriftTasks 提取 merge 冲突事实（见 integrate.ts 交付）④collectIntegrationContracts 返回值改带 owner（见契约配对） |
| `src/readonly/frontier.ts` | 修改 | `INTEGRATION_MAX_CONSECUTIVE_FAILS = 1`：集成首次 fail 即进入 drift（停自动重试、派 designer 处置）；连续计数语义（事件流重放、逐 unit）不变，仅上限值改 |
| `src/runner/integrate.ts` | 修改 | ①integrate-report 结构化 `mergeFailures: string[]`（步骤 0 merge 失败明细独立成节——merge 冲突与可达性/验收/契约失败分类，不再混在通用 failures 里丢失结构）②mergeChildrenIntoRoot 的失败文本推入 mergeFailures（含冲突子 unitId 与 root worktree 路径）③matchContracts 调用点组装配对输入（owner 标记 + frozenByUnit）④恢复指引文案与 MAX=1 语义对齐（首 fail 即转处置，指引不再说「下轮自动重试」） |
| `src/verify/contract-match.ts` | 修改 | ①`ContractMatchInput` 扩展：`contracts: Array<{ contract: Contract; ownerUnitId: string }>`（带 owner 全量保留——废除同 id root 优先去重丢弃）+ `frozenByUnit: ReadonlyMap<string, readonly Contract[]>`（各 unit 冻结 spec 的契约集）②配对比对（第一道）：对每条契约 C——`C.provider` 非空且 ≠ ownerUnitId 时，在 frozenByUnit[C.provider] 中找同 id 条目 PC：无 → fail「契约无 provider 声明」；有 → 归一化全等比对（trim + 空白折叠）C.signature ≡ PC.signature，不等 → fail「契约漂移」（消息含两侧归一化文本）；`C.provider` 为空或 = ownerUnitId（self-provider，root 集成契约形态）→ 跳过配对③树内验证（第二道）：rv-3 的文档排除 + 归一化语义不变，同 id 多 owner 版本任一命中即过④rv-3 的文档宿主排除/归一化/二进制嗅探行为零回退 |
| `tests/rv4-redphase-default.test.ts` | 新建 | §5 T1-T3 |
| `tests/rv4-integration-disposal.test.ts` | 新建 | §5 T4-T6 |
| `tests/rv4-contract-pairing.test.ts` | 新建 | §5 T7-T9 |
| `tests/u4b-red-phase.test.ts`、`tests/u8*.test.ts`、`tests/fx2*.test.ts` 等既有 | 适配 | 红阶段默认语义、MAX=1、契约输入结构的必要迁移；禁改断言语义内核、禁删测试（语义反转处重写并在测试注释标注迁移依据） |

## 3. 禁改清单（违反 = FAIL）

- `src/runner/spawn/`（rv-1 领地）、`src/runner/worktree.ts`、`src/gates/spec-rules.ts`、`src/handlers/{review-submit,evidence-submit,create,run}.ts`、`src/events/types.ts`（事件 schema 零变更）、`src/core/fold.ts`（投影语义零变更——MAX=1 只改常量不改 fold）、`src/testrun/`、`src/store/`、`src/verify/{run,checkout,name-match}.ts`
- 红阶段 patch 语义（red-phase.ts 的 D 过滤、quotePath 处理、四态判定）零变更
- `docs/`、`archive/`、配置文件

## 4. 关键口径（锁定）

- **红阶段每次 verify 都跑**（不做「仅 spec 冻结后首跑」优化）：verify 幂等语义下每次产物链自包含（每份 VerifyRan 的 report 都有 redPhase 节）；成本代价（每验收多一轮旧树跑）接受，`--no-red-phase` 是逃生口。
- **集成 verify（integrate.ts 验收重跑）不跑红阶段**：红阶段是 unit 层 gate（测试 vs 自己的实现），集成是全量重跑语义，无红阶段对象。
- **MAX=1 的语义**：集成 fail 是确定性失败（冲突/契约不匹配/验收红），不存在「重试一次就好」的瞬时态；首次 fail 即转 drift 派 designer 处置，人工窗口（按指引在 root worktree 解冲突）期间 loop 不再触发集成、不 reset root worktree。fx-2 时代 MAX=2 的「第二次重试」语义作废。
- **配对比对是第一道、树内验证是第二道**：两道独立，任一 fail 即契约 fail。配对消灭「consumer 记错版本/ provider 从未承诺」；树内消灭「provider 冻结了但代码没落实」。
- **同 id 冲突显性化**：废除「同 id root 优先去重」——全量带 owner 保留后，root 与 child 同 id 不同签名的冲突由配对/树内组合判定暴露（如 root 版 provider 指向 child，与 child 冻结版配对比对）。
- **无父 commit 是合法跳过不是失败**：单 commit 仓库/首提交场景 verify 必须可用。
- **旧 `--red-phase` standalone 语义废除是行为变更**：u4b 既有断言按新语义迁移（原「standalone 不入账」断言改判新行为），迁移处测试注释标注「rv-4 语义迁移」。

## 5. 新增测试条款（三个新文件，真实子进程 + tmp + CW_HOME 隔离，零 mock）

### tests/rv4-redphase-default.test.ts
- **T1 恒真测试必死（核心场景）**：构造 spec（验收 command 为 `node -e "console.log('<id> PASS')"` 型恒真脚本）+ builder commit（测试脚本与实现同 commit）→ `cw verify --unit`（无任何 flag）→ exit 1，report.json 含 redPhase 节且该 id `discriminative: false`，fail 原因含恒真说明；同场景 `--no-red-phase` → exit 0（逃生口有效）。
- **T2 正常测试通过**：真实现 + 真测试（测试依赖实现、旧树必挂）→ 默认 verify → exit 0，redPhase 节 `discriminative: true` 逐条存在。
- **T3 无父 commit 跳过**：单 commit 仓库（root unit 首提交即 build commit）→ verify 可用，redPhase 节该验收 `skipped: true` + 原因，判定不受影响。

### tests/rv4-integration-disposal.test.ts
- **T4 首 fail 即 drift（MAX=1）**：双子树集成场景构造契约漂移（consumer 与 provider 冻结签名不一致）→ 首次集成 fail 后下轮 loop 派 designer 处置（integrationDrift 形态），**不再出现第二次自动集成 VerifyRan**；frontier `--json` 可见 drift 状态。
- **T5 merge 冲突事实入任务书**：构造 merge 冲突（双子改同一行）→ 集成 fail 的 integrate-report.json 含 `mergeFailures` 节（含冲突子 unitId 与 root worktree 路径）；drift designer 任务书（writeBriefFile 产物）含该冲突事实原文（不再退化为「契约比对无失败项」）。
- **T6 人工窗口不被销毁**：T5 场景 drift 派发后，在 root worktree 制造未提交的人工解冲突 WIP（改文件不 commit）→ loop 继续 poll ≥3 轮 → root worktree 的 WIP 原样保留（无 reset/clean 触碰）——「按指引解冲突」期间现场安全。
- 
### tests/rv4-contract-pairing.test.ts
- **T7 漂移拦截（核心）**：consumer 契约 signature 与 provider 冻结版一字之差（或空白差异之外的 token 差异）→ 配对 fail，消息含两侧归一化文本；树内恰好都有命中也 fail（第一道独立）。
- **T8 无 provider 声明拦截**：consumer 契约的 provider=某 unitId，该 unit 冻结 spec 从未声明此 id → fail「契约无 provider 声明」。
- **T9 一致通过 + self-provider 跳过**：consumer ≡ provider 冻结（含空白风格差异——归一化等价）→ 配对过 + 树内命中 → pass；root 自声明契约（provider=root 自身）→ 跳过配对、树内命中 → pass。

## 6. 通过命令

```
cd <仓库根> && npm run check
npx vitest run tests/rv4-redphase-default.test.ts tests/rv4-integration-disposal.test.ts tests/rv4-contract-pairing.test.ts tests/u4b*.test.ts tests/u8*.test.ts tests/fx2*.test.ts tests/fx3*.test.ts
npx eslint src/handlers/verify.ts src/verify/red-phase.ts src/verify/contract-match.ts src/runner/loop.ts src/runner/integrate.ts src/readonly/frontier.ts tests/rv4-*.test.ts
```
