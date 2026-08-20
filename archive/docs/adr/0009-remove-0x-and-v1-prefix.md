# ADR 0009: 彻底清理 0.x + 重组 src/v1 到根级 + 去掉 cw v1 前缀

## 状态

Accepted — 2026-07-26

**取代 ADR 0007 的「src/v1/ 隔离层」决策**（0007 的隔离目标在 0.x 删除后失去存在理由，详见「关联」）。

## 背景

cw 1.0 起，0.x 编码命令（`cw create`、`cw plan` 等）已在 `cli.ts` 被拦截停用，但仓库里仍残留三类
历史代码与一层冗余的隔离抽象：

1. **0.x 残骸**：`src/legacy/`（14845 行旧实现）+ `src/engine/`（1637 行死代码，被 legacy 引用但
   无活路径调用）+ `tests/` 根级 0.x 测试 + `skill/cw-cli-archive`（旧版 skill 文档）。这些在
   0.x 命令被拦截后不再被任何活路径触达，是纯粹的维护负担和阅读噪音。
2. **`src/v1/` 隔离层失去存在理由**：ADR 0007 决定新建 `src/v1/` 五层架构（core/rules/store/
   handlers/dispatch）与 0.x **四重隔离**（存储/代码/测试/CLI）。该隔离的前提是「0.x 代码仍在
   仓库里、必须与 v1 并存」。一旦 0.x 删除，隔离层就成了空转的目录嵌套——v1 不再需要「与谁
   隔离」。
3. **`cw v1` 命令前缀冗余**：`v1` 前缀当初是为了与 0.x `cw create`（单层 topic 模型）区分而加。
   0.x 删除后，`cw create` 不再有歧义，前缀纯属冗余，徒增用户/agent 输入成本。
4. **`package.json` exports 滞后**：`exports` 字段仍指向 `dist/legacy/`（0.x API），与新代码布局
   不符。

## 决策

**一次彻底重构：删 0.x + 扁平化 src + 去前缀 + 修 exports + 解耦错误类型。**

1. **删除 0.x 残骸**：移除 `src/legacy/` + `src/engine/` + `tests/` 根级 0.x 测试 +
   `skill/cw-cli-archive`。0.x 命令早已在 `cli.ts` 拦截，删除不影响任何活路径。
2. **扁平化 src**：`src/v1/*` 全部上移到 `src/`（`src/v1/core` → `src/core`，依此类推），去掉
   一层空转的隔离目录。所有 import 路径相应更新。
3. **去掉 `cw v1` 前缀**：`cw v1 create` → `cw create`，所有 action 同理（`cw v1 clarify` →
   `cw clarify` 等）。新建 `buildCommand` helper 作为命令构造的单一来源，避免前缀散落多处。
4. **修 `package.json` exports**：指向 `dist` 根级（扁平化后的产物），不再指向 `dist/legacy/`。
5. **`CwError` 解耦**：从 `legacy/types.ts` 搬到 `core/errors.ts`，摆脱对已删除的 legacy 层的依赖，
   让错误类型归属到内聚的 core 层。

## 替代方案

考虑过但不选：

1. **保留 `v1` 前缀、只删 legacy**——被否决。0.x 删除后前缀失去区分对象，纯属冗余；用户明确要求
   去掉前缀，让命令回归简洁形态。
2. **`v1` 前缀做兼容性保留（`cw v1` 仍工作）**——被否决。保留双入口等于永远背着历史包袱，与
   「彻底切断 0.x、重构干净」的目标相悖；breaking change 是这次重构的预期代价。
3. **按职责重新分层（`src/domain` + `src/app` + ...）**——被否决。用户选择「全部上移」而非重新
   设计分层：保留 0007 既定的 core/rules/store/handlers/dispatch 五层命名，仅去掉外层 `v1/`
   嵌套，避免引入新的架构争议。
4. **把 `CwError` 放根级 `src/errors.ts`**——被否决。错误类型与 core 领域模型紧密相关，放 `core/`
   更内聚；根级 `src/errors.ts` 会成为无所不装的杂物抽屉。

## 后果

**正向**：

- 代码量降约 37000 行（14845 legacy + 1637 engine + 关联测试 + archive skill），仓库瘦身显著。
- `src` 扁平化，目录嵌套减一层，import 路径更短，导航更直接。
- 命令回归简洁形态（`cw create` / `cw clarify` / ...），用户与 agent 输入成本降低。
- `buildCommand` helper 成为命令构造单一来源，未来若再需要前缀/后缀只需改一处。
- `CwError` 解耦后 core 层自洽，不再 import 已删的 legacy。

**负向**：

- **breaking change**：旧 `cw v1 xxx` 命令失效（用户须改用 `cw xxx`）；`package.json` exports
  路径变更（下游若 import 内部路径需同步改）。
- 旧 handoff 产物（`.xyz-harness/<slug>/`）里记录的 `cw v1` 命令引用变成历史快照，文字过时——
  这些是已落盘的历史记录，**不改写**，本文档说明前缀变更即可。

## 关联

- **取代 ADR 0007 的「src/v1/ 隔离层」决策**：0007 的隔离目标（与 0.x 四重隔离）在 0.x 删除时
  即告达成，隔离层失去存在理由。本 ADR 把 `src/v1/` 上移为 `src/`，是 0007 决策的自然终结，
  不是对 0007 架构原则（core/rules/store/handlers/dispatch 五层、领域模型直写、数据与规则分离）
  的否定——这些原则全部保留，只是不再多一层 `v1/` 目录包裹。
- **补充 ADR 0008**：0008 引入的 `schemaVersion` + `repoMeta` 机制不受影响，仅实现路径从
  `src/v1/core/git.ts` → `src/core/git.ts`、`src/v1/store/v1-store.ts` → `src/store/v1-store.ts`
  平移。`_v1.json` 文件名、`V1Store` 类型名、`V1_HOME` 环境变量名是实际标识符，与命令前缀无关，
  本次重构**不改**。

---

> **更新注（2026-07，后续版本）**：本文档为历史决策记录，正文（含「不改 `_v1.json` 文件名」
> 的当时结论）保持原样。该文件名已于后续版本改为 `store.json`（与 `CwStore` 类名自洽），
> 与命令前缀无关，故单独在此说明，不回溯改写历史决策正文。
