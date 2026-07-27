# ADR 0008: v1 _v1.json 加 schemaVersion + repoMeta

## 状态

Accepted — 2026-07-26

## 背景

cw v1 的状态库 `~/.v1/<encodedCwd>/_v1.json` 顶层只有 `{workUnits: [...]}`。`encodeCwd`
是字面值替换（`/` → `__`），无 git 归一化——同一 repo 的不同 worktree 产生互不可见的 store。

新 agent 接手场景（老 agent API 用完后，新 agent 拿「git repo + 一句主题描述」接手 topic）
需要跨 cwd 遍历所有 store 做模糊定位。但同名 topic 在多个 repo 都存在时，仅靠 slug/objective
无法消歧——需要 git 信息（remoteUrl/branch/worktreePath）辅助识别。

同时，v1 schema 首次变更，缺少版本字段，未来 schema 演进无法区分新旧 store。

## 决策

**给 _v1.json 顶层加 `schemaVersion: number`（初始 = 1）+ `repoMeta?: RepoMeta`（可选）。**

```ts
interface V1JsonFile {
  schemaVersion?: number;   // 缺失/非数字时补 1
  repoMeta?: RepoMeta;      // 缺失时降级，首次推进类 action 时回填
  workUnits: WorkUnitRecord[];
}

interface RepoMeta {
  remoteUrl: string;     // git remote get-url origin，无 origin 时 ""
  branch: string;        // rev-parse --abbrev-ref HEAD，detached 时 "HEAD"
  worktreePath: string;  // create 时的 process.cwd() 绝对路径
  headCommit: string;    // rev-parse --short HEAD，7 位短 hash
  recordedAt: string;    // ISO 时间戳，判断 repoMeta 新鲜度
}
```

### 字段取舍

**存的**：
- `remoteUrl`：识别「同一个 repo」的唯一键，跨 worktree/fork 消歧
- `branch`：接手必须的，agent 要知道在哪个分支跑
- `worktreePath`：告诉 agent「去这个目录才能继续」，比 encodedCwd 目录名可读
- `headCommit`（7 位）：branch 可能被 reset/rebase，commit hash 是兜底定位
- `recordedAt`：判断 repoMeta 新鲜度（30d 前的 branch 字段可能已过期）

**不存的**（每个都想过）：
- `commitMessage` / `author` / `dirty 状态`：与接手无关，agent 自己 `git log` / `git status` 即可
- `多 remote 列表`（upstream + origin）：罕见场景，一个 origin 足够识别同 repo
- `git common dir`：太底层，agent 用不上
- 存每个 unit 内：一个 _v1.json 对应一个 cwd，RepoMeta 一对一，存顶层不冗余 N 份

### 存顶层而非 unit 内

一个 `_v1.json` 对应一个 cwd（per-cwd 隔离），RepoMeta 是一对一关系。存顶层避免 N 个 unit
冗余 N 份相同 RepoMeta。`schemaVersion` 同理是 store 级而非 unit 级。

### 刷新策略

**只在推进类 action 完成后刷新**（11 个 wave action + slice/feature/epic 对应 action）：
`V1Store.save()` 在 `executeWrite` 回调内、mutate workUnits 之前刷新
`data.repoMeta = collectRepoMeta(this.cwd)`。

**readonly query（loadAll/load/findChildren/handoff/list/tree/status）绝不刷新**——它们不走
`save()`，保持只读纯粹，避免查询命令有 git 子进程写副作用。

### 旧 store 降级路径

- `schemaVersion` 缺失 → `loadFileData()` 补为 1（视为已迁移到 v1 schema，向前兼容）
- `repoMeta` 缺失 → 留 `undefined`，**不在 `loadFileData()` 调 git**（只读路径无副作用），首次推进类 `save()` 时回填
- 新建 store（`emptyFile()`）→ 直接带 `schemaVersion: 1`，repoMeta 首次 save 时填

### collectRepoMeta 实现

`src/v1/core/git.ts` 新增 `collectRepoMeta(cwd)`，复用 `GIT_SPAWN_OPTS`（与 `extractChangedFiles`
同风格：`spawnSync` + `shell:false` + `encoding:utf-8` + `maxBuffer:16MB`）。

4 次 spawnSync：`remote get-url origin` / `rev-parse --abbrev-ref HEAD` /
`rev-parse --short HEAD` + `recordedAt = new Date().toISOString()`。

**错误容忍**：每个字段独立采集，单个 git 命令失败返回空字符串，不抛异常（与 git.ts
「只读 + 不抛异常」不变量一致）。非 git 目录 / git 未装 → RepoMeta 全空字符串 + worktreePath。

## 替代方案

考虑过但不选：

1. **改 `encodeCwd` 用 git toplevel 归一化**——破坏性大，所有现存 `_v1.json` 路径失效，老用户
   升级后找不到原 store。本方案保持 cwd 隔离不变，只加读取层聚合。
2. **不版本化直接加 repoMeta**——未来 schema 变更时无法区分新旧 store，迁移困难。
3. **维护 `~/.v1/index.json` 索引文件**——引入索引一致性维护负担，违背「store 唯一真相」原则。
4. **`loadFileData` 立即回填 repoMeta**——loadFileData 是只读路径，不该有 git 子进程副作用。
   选首次推进类 save 时填。

## 后果

**正向**：
- 跨 cwd 接手（list --all）能从 repo/branch/cwd 消歧同名 topic
- schema 演进有了版本化基础（未来 schemaVersion=2 可走迁移分支）
- 旧 store 自动兼容（缺字段降级），无需迁移脚本

**负向**：
- 每次推进类 action 增加 ~50ms（4 次 git 子进程）。CLI 单次调用可忽略
- 旧 store 首次推进前 repoMeta 是 undefined，list --all 时该 cwd group header 显示 (no repo meta)
  （首次推进后即补全）

## 关联

- 决策来源：slice `v1-read-and-resume` clarification C2（存 repoMeta）、C3（刷新策略）
- 前置依赖：Wave B（list --all）需要 repoMeta 做跨 cwd group header 消歧
- 测试：`tests/v1/repo-meta.test.ts`（8 个 case 覆盖 collectRepoMeta + 迁移 + 刷新策略）
