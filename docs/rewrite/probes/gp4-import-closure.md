# GP4 探针：测试文件 → import 闭包依赖图分析

> 探针日期：2026-08-24
> 目标：验证 design-release-pipeline.md D7（ci-judge 归属分析）所需的「失败测试文件 + 其 import 闭包」TS 依赖图构建可行性
> 仓库：cw 仓（`coding-workflow-workspace/feat-release-pipeline`），91 个测试文件，TypeScript 5.9.3

## 结论

**推荐路径 A（tsc API）进生产，路径 B（正则）作降级兜底。** 三条路径均可行，但 tsc API 在闭包精度上优于正则（正则无法区分 `../src/` vs `../dist/` import 的不同含义），且零额外依赖。madge 因 npm 临时拉取延迟不适合 CI 热路径。

**ci-judge 判定「PR 触碰了失败测试的 import 闭包」可行**——单文件闭包构建 0.3-4.7ms，全量 91 文件预估 <500ms，远低于 CI 预算。

## 实测数据

### 样本文件（8 个，覆盖不同 import 复杂度）

| 测试文件 | tsc 闭包 | regex 闭包 | madge 闭包 | tsc 耗时 | regex 耗时 |
|---------|---------|-----------|-----------|---------|-----------|
| al-1-nice.test.ts | 12 (src:11) | 12 | 12 | 1.8ms | 1.0ms |
| dispatch.test.ts | 41 (src:40) | 41 | 41 | 4.7ms | 2.7ms |
| u2-create.test.ts | 41 (src:40) | 41 | 41 | 4.0ms | 2.6ms |
| wt5-parallel-contamination.test.ts | 1 (src:0) | 27 (src:0) | — | 0.5ms | 1.7ms |
| fx1-loop-dispatch.test.ts | 1 (src:0) | 27 (src:0) | — | 0.3ms | 1.8ms |
| u4a-verify.test.ts | 41 (src:40) | 41 | — | 4.4ms | 2.8ms |
| gp1-golden-replay.test.ts | 2 (src:1) | 2 | — | 0.4ms | 0.1ms |
| mx5-4-developer-rename.test.ts | 41 (src:40) | 41 | — | 3.7ms | 2.7ms |

**tsc createProgram 初始化**：328ms（146 入口：91 测试 + 55 src），一次性成本，后续每个文件 <5ms。

### 差异分析

**tsc vs regex 一致性**：8 个样本中 6 个完全一致，2 个有差异。

差异文件：`wt5-parallel-contamination.test.ts` 和 `fx1-loop-dispatch.test.ts`。

原因：这两个文件 import `../dist/`（编译产物）而非 `../src/`（源码）。正则路径将 `dist/` 下的 26 个 `.js` 文件也纳入闭包，tsc 路径（基于 `tsconfig.test.json` 的 `include: ["src/**/*.ts", "tests/**/*.ts"]`）不包含 `dist/` 目录，因此只返回文件自身。

**tsc 路径的「1 文件」结果是正确的语义**——这些测试通过 `dist/` 运行时产物验证，它们的「被测模块」是 `dist/` 而非 `src/`。ci-judge 场景下，触碰 `src/` 某文件 → 需要 rebuild `dist/` → 影响这些测试——但这是 build 依赖而非 import 闭包。正则路径多出的 26 个 `dist/` 文件是冗余信号。

### 别名路径

cw 仓 tsconfig 无 `paths` 别名。xyz-agent 仓（renderer 包）有 `@/*` 和 `@xyz-agent/shared` 别名，tsc API 的 `ts.resolveModuleName` 原生支持解析，正则路径需手工实现 `paths` 映射。

## 三路径对比

| 维度 | A: tsc API | B: 正则 + resolve | C: madge |
|------|-----------|------------------|----------|
| 额外依赖 | 无（ts 是 devDep） | 无 | npx 临时拉取 |
| 闭包精度 | **高**（ts.resolveModuleName 原生解析 .js→.ts、paths 别名、node_modules 过滤） | 中（需手工实现 .js→.ts 映射和 paths 解析，无法区分 src/dist import 语义） | 高（与 tsc 一致） |
| 单文件耗时 | 0.3-4.7ms | 0.1-2.8ms | 0.0ms（BFS）+ npx 初始化 |
| 初始化成本 | 328ms（createProgram） | 0 | ~1.2s（npx madge 首次） |
| tsconfig paths | 原生支持 | 需手工映射 | 原生支持 |
| 跨包 import | 需将目标包纳入 program | 需手工 resolve | 全量扫描 |
| 实现复杂度 | 中（~50 行 AST 遍历 + resolveModuleName） | 低（~30 行正则 + 路径解析） | 低（调 CLI） |
| 适用场景 | CI 热路径，需精确闭包 | 降级兜底，快速原型 | 本地调试 |

## 关键发现

1. **ESM `.js` 后缀惯例**：cw 仓 import 用 `../src/foo.js`（ESM 规范），实际源文件是 `foo.ts`。tsc 的 `ts.resolveModuleName` 原生处理此映射；正则路径需先剥 `.js` 再试 `.ts`。

2. **`../dist/` vs `../src/` import 分叉**：91 个测试中约 20+ 个 import `dist/`（e2e 级测试验证编译产物）。ci-judge 需区分这两种 import：
   - `../src/` import → 直接源码依赖，PR 改了 src/X.ts → 闭包含 X.ts 的测试
   - `../dist/` import → 运行时依赖，PR 改了 src/X.ts → rebuild → 影响 dist/X.js 的测试（build 级联，非 import 闭包）

3. **闭包大小分布**：大多数测试闭包 2-41 文件（src 级），少数 e2e 测试闭包仅 1 文件（自身）。闭包大的测试通常是 import 了 `dispatch.ts`（入口文件，扇出到几乎所有 handler）。

4. **性能预算充裕**：全量 91 文件闭包预估 <500ms（tsc），远低于 CI 步骤预算。

## 建议

| 决策点 | 建议 |
|--------|------|
| 主路径 | **tsc API**（路径 A）：精度最高，零额外依赖，ts.resolveModuleName 原生处理所有边界 |
| 降级 | **正则 + resolve**（路径 B）：tsc 不可用时（如 typescript 未安装）降级，接受 dist/src 语义模糊 |
| ci-judge 判定 | 可行。PR diff 的文件集合 ∩ 失败测试的 import 闭包 ≠ ∅ → 该测试可能被 PR 影响 |
| rp-3 降级 | **不需降级**。tsc API 路径通过探针验证，性能和精度均满足要求 |
| paths 别名 | tsc 原生支持；正则路径需补充 paths 映射逻辑（~20 行额外代码） |
| 跨包 import | 当前 cw 仓无跨包 import（单包结构）。monorepo 场景需将相关包纳入 program |

## 复跑

```bash
bash docs/rewrite/probes/gp4-import-closure.sh
```

产物输出到 stdout，脚本自包含（不改仓库文件、不装依赖）。
