# 实施层设计 ph-i0：仓多包化 + 插件包 + 安装通道（design-hi-monorepo-split）

> **当前层 → 下一层**：架构总纲决策层（design-harness-integration.md 的 D12/D9/D1）→ ph-i0 波次的可实施任务（包骨架 / 发版流水线 / 安装器 / 受控 agentDir 的文件级规格）。不设计 extension 内部逻辑（ph-i2 细文档）与 RPC 适配器内部（ph-i1 细文档）。
> **上游决策链**（本文件不自证，引用总纲）：D12 仓结构三项裁决（workspaces 多包 / 包边界只装 extension / 包名 `@zhushanwen/pi-coding-workflow-extension` 首版 0.5.0）、D9 命名共存零动作、D1 运行时收敛（受控 agentDir）、D3 A+B 形态（extension import cw 引擎库 + 复用 pi-subagent-workflow——决定了插件包的运行时依赖面）。
> **证据基础**：仓内实读（package.json / release.yml / scripts/）+ pi 0.84.2 dist 实读（loader.js / pi-scheduler 先例）+ xyz-agent main 仓实读（rpc-client.ts）。文中锚点均带 file:line 或绝对路径。

**一句话结论**：cw 仓保持根包 `@zhushanwen/coding-workflow` 原地不动（src/tests/dist 全不搬），根目录并列新增 `pi-coding-workflow-extension/` 独立 npm 包（直发 TS 源码，pi 经 jiti 加载——pi-scheduler 同款先例），根 package.json 转 npm workspaces 并新增 `./runner` 子路径导出；安装统一走「npm pack tarball → 解包到 `<agentDir>/extensions/` → 包内 `npm install --omit=dev` 装依赖」的 installer bin，两条通道（用户主会话 agentDir 发现式 / 受控 agentDir 显式注入式）同一安装器不同目标目录与包清单；发版改双 tag 协议（`v*` 核心包 / `ext-v*` 插件包）。

## 1. 背景目标

**SCQA**

- **S（情境）**：总纲 D12 已裁决 cw 仓 npm workspaces 多包化，首个 per-agent 插件包 `pi-coding-workflow-extension`（npm 名 `@zhushanwen/pi-coding-workflow-extension`，首版 0.5.0）承载跑在 pi 进程内的 pi-cw-runner extension；D3 A+B 形态确定 extension 运行时依赖 cw 引擎库与 pi-subagent-workflow 编程 API。
- **C（冲突）**：现状是单包仓——根 package.json 即 `@zhushanwen/coding-workflow` 2.1.0（exports 仅 `./`、`./dispatch`），release.yml 单包 publish；插件包没有承载位、没有安装通道（pi extension 的发现规则用户并不了解）、没有发版路径；受控 agentDir（D1）不存在。
- **Q（问题）**：怎么改仓结构，使插件包能独立发版、一条命令装进两类 agentDir 且被 pi loader 真实发现，同时核心包的 CI 与发版零退化？
- **A（答案）**：根包原地保留 + 根级插件包目录收编进 workspaces + 直发 TS + 统一 installer + 双 tag 发版。全部选择沿用仓内或 pi 生态已有先例，无新发明机制。

**系统是什么**（自包含）：cw（`@zhushanwen/coding-workflow`）是 npm 包，`cw` CLI 提供 9 命令面（事件账本 + fold 投影 + runner 派发循环）。pi 是 coding agent harness（npm `@earendil-works/pi-coding-agent` 0.84.2），支持 extension 机制（TS 模块经 jiti 加载，注入工具/命令/UI 钩子）。`pi-cw-runner` 是一个 pi extension：加载进用户主 pi 会话后，把 cw 的派发循环以库形态跑在会话进程内（D3 A+B），把 designer/developer/reviewer 作为 subagent 派出并呈现在现有 subagent 面板。本设计的产物 = 这个 extension 的**包与安装基建**（extension 逻辑本身在 ph-i2）。

**设计目标**（从使用者体验倒推）：

| # | 目标 | 使用者体验 |
|---|------|-----------|
| M1 | 两包独立发版 | 核心包发 `v2.1.1` 与插件包发 `ext-v0.5.0` 互不牵连，各自 tag 触发各自 publish |
| M2 | 一条命令安装 | `npx @zhushanwen/pi-coding-workflow-extension install` 后，下次启动 pi 主会话即加载 extension（loader 自动发现，无需手工配置）；`install --agent-dir <path>` 装进受控 agentDir 供 cw spawn 显式注入 |
| M3 | 核心包零退化 | workspaces 化后 `npm run check:all` / `npm test` / `npm pack --dry-run` 输出语义不变（674 用例照跑） |
| M4 | 受控 agentDir 可重建 | 一条脚本从零重建 `~/.cw/agent-dir/`（装指定清单的扩展 + 启动探针校验），D1 的「环境收敛」落地为可执行物 |

**in-scope**：根 package.json workspaces 化、`pi-coding-workflow-extension/` 包骨架与 package.json 规格、`./runner` 子路径导出占位（实现在 ph-i1/ph-i2，此处只定导出面）、installer bin、受控 agentDir 布局与建立脚本、release.yml 双包改造。
**out-of-scope**：extension 业务逻辑（ph-i2）、RPC 适配器（ph-i1）、pi-1 subagent-workflow 回合（xyz-agent 仓）、xyz-agent renderer 面板（ph-i3）、npm 包内容之外的分发形态（git clone 安装不做）。

## 2. 现状与问题分析

### 2.1 仓现状（实读）

- 根 package.json：`@zhushanwen/coding-workflow` 2.1.0，`"type": "module"`，exports = `{ ".": "./dist/index.js", "./dispatch": "./dist/dispatch.js" }`（**子路径导出已有先例**——加 `./runner` 是既有模式的延伸，非新机制）；files 白名单 `["dist","skills","agents","scripts","README.md","LICENSE"]`；bin `cw`；postinstall 已有 `scripts/install-skill.sh`（**安装钩子先例**——本设计的 installer bin 与其同族但显式触发，见 D3 决策三）。
- `.github/workflows/release.yml`：单包发版——`npm ci → build → test → npm pack --dry-run → npm publish --provenance`，tag `v*` 或 workflow_dispatch（dry-run 输入）触发，Node 20。
- 测试基建：vitest + tsconfig.test.json，`pretest` 自动 build；workspaces 化后 vitest 的根目录解析需回归验证（M3 的风险点）。

### 2.2 pi extension 生态现状（实读，安装通道的机制地基）

**loader 发现规则**（pi 0.84.2 `dist/core/extensions/loader.js:503-508`，三类，作用于 `<agentDir>/extensions/` 目录扫描）：

```
1. 直文件：extensions/*.ts 或 *.js → 直接加载
2. 子目录带 index：extensions/<dir>/index.ts|js → 加载
3. 子目录带 package.json 且含 "pi" 字段 → 按其 pi.extensions 声明加载
```

**真实包形态先例**（pi-scheduler，npm 装于 `~/.xyz-agent/pi/agent/npm/node_modules/@zhushanwen/pi-scheduler/`）：

```json
// package.json 关键字段（实读）
{
  "name": "@zhushanwen/pi-scheduler",
  "type": "module",
  "main": "index.ts",
  "pi": { "extensions": ["./index.ts"], "skills": [] },
  "keywords": ["pi-package"]
}
```

入口约定：`index.ts` 为 `export { default } from './src/index.js'`，src/index.ts 为 `export default function (pi: ExtensionAPI): void`。**直发 TS 源码，无构建步骤，无 dist/**——pi 用 jiti 现场编译加载。npm 线 `@zhushanwen/pi-subagent-workflow` 0.3.1 同形态（src/ 直发）。

**xyz-agent 显式注入先例**（`~/Code/tai-ji-workspace/main/packages/runtime/src/infra/pi/rpc-client.ts:109-142`）：`PI_CODING_AGENT_DIR` 指定受控 agentDir + spawn args `['--mode','rpc','--no-extensions','--approve']` + `--extension <path>` 逐个显式注入 + `--session-dir`——受控通道的注入形态全链有先例代码可抄。

### 2.3 问题清单（现状 → 目标的缺口）

| # | 缺口 | 后果 |
|---|------|------|
| P1 | 插件包无承载位 | ph-i2 的 extension 代码无处放、无版本号、无发版路径 |
| P2 | extension 的 npm 依赖（cw 引擎库 + subagent-workflow）在 agentDir 里无解析位置 | jiti 加载 extension 时 bare import 解析失败——必须由安装器连依赖一起落盘 |
| P3 | 安装无通道 | 用户主会话 agentDir（`~/.pi/agent/extensions/`）手工复制易错且丢依赖；受控 agentDir 不存在 |
| P4 | 发版单包 | 插件包节奏（0.5.x）会绑死核心包节奏（2.x） |

## 3. 解决方案

### 3.1 终态（使用者视角）

**安装与使用旅程**（成功路径）：

```
$ npx @zhushanwen/pi-coding-workflow-extension@latest install
  → 下载 npm tarball → 解包到 ~/.pi/agent/extensions/pi-coding-workflow-extension/
  → 包内 npm install --omit=dev（装 @zhushanwen/coding-workflow + @zhushanwen/pi-subagent-workflow 到包内 node_modules/）
  → 打印：已安装 0.5.0（loader 将自动发现）；重启 pi 会话生效

用户重启 pi（TUI 或 xyz-agent 主会话）
  → extension 加载 → /cw 命令与 frontier widget 出现（业务功能 ph-i2 交付，此处只验加载）
```

**受控 agentDir 旅程**（cw 内部使用）：

```
$ cw setup-agent-dir            # 或 pi-coding-workflow-extension install --agent-dir ~/.cw/agent-dir --profile controlled
  → 建 ~/.cw/agent-dir/extensions/{ask-user,subagent-workflow,...}/（清单见 D5）
  → 启动探针：真实 spawn `pi --mode rpc -p "<探针指令>"`（受控 agentDir env + --extension 注入）校验扩展在场
  → 探针失败 → exit 1 + stderr 恢复指引（缺哪个扩展、重跑哪条命令）
```

**发版旅程**：

```
$ git tag ext-v0.5.0 && git push origin ext-v0.5.0
  → release.yml 的 extension job 触发：install → test（extension 包自身 vitest）→ pack --dry-run → publish
  （核心包 v* tag 与 workflow_dispatch 选包入口照旧，互不干扰）
```

**失败路径（带恢复指引）**：

- 安装时 npm registry 不可达 → installer 报「npm 源不可达：`npm config set registry https://registry.npmmirror.com` 后重试」并 exit 1（不写半截目录：先解包到 `.tmp` 再原子 rename）。
- pi 升级后 loader 不再发现（规则变更）→ 探针命令（installer 自带 `doctor` 子命令：spawn 真实 pi 验证加载）报告「loader 未发现 extension，检查 pi 版本 `<版本>` 的 extensions 目录规则」。

### 3.2 方案对比

**决策一：仓布局——根包原地 + 根级插件包目录 vs 全迁 packages/**

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|--------------|-------------|------|
| **A. 根包原地不动，根级并列 `pi-coding-workflow-extension/`**（本设计） | 高：npm workspaces 官方支持根包与子包并存；cw 核心的 src/tests/dist/git 历史零迁移；per-agent 包天然根级可见（用户点名的目录形态） | 低：根 package.json 加 `workspaces` 与 `./runner` 导出；CI 无需动路径 | npm publish 根包时 workspaces 字段被 npm 自动忽略（需验证 files 白名单不含插件包目录——见 PP1） |
| B. 全迁 `packages/core/` + `packages/pi-extension/` | 中：目录更「标准」，但标准本身无收益 | 高：src/tests 全部搬移，tsconfig/vitest/eslint/release.yml 全链改路径，git 历史断 | 搬移即回归：674 用例的路径引用全查一遍 |

裁决 **A**：B 的唯一收益是目录美学，代价是全仓路径回归——三个月后回看，A 的根级插件包目录同样清晰，且没有为美学付过回归成本。A 的 publish 干净性由 PP1 探针锁死。

**决策二：extension 包产物形态——直发 TS 源码 vs 构建 dist**

| 方案 | 长期 | 短期 | 风险 |
|------|------|------|------|
| **直发 TS**（pi-scheduler / pi-subagent-workflow 同款） | 高：与 pi extension 生态一致；pi 端 jiti 现场编译，无构建产物漂移；开发即产物（改源码重载即生效） | 低：零构建配置 | TS 源码公开（本就 MIT 开源，无碍）；jiti 编译开销一次性 |
| 构建 dist | 低：生态里无此先例；多一条构建链要维护 | 中：tsconfig + build script + files 白名单 | 源码与产物版本漂移风险 |

裁决 **直发 TS**（一致性 > 品味：遵循生态现有约定）。extension 内 import 的 `@zhushanwen/coding-workflow/runner` 是编译后 dist ESM——jiti 加载 TS 入口后由 Node 正常解析 npm 依赖，无冲突。

**决策三：安装器形态——installer bin vs postinstall 自动装 vs 手工文档**

| 方案 | 长期 | 短期 | 风险 |
|------|------|------|------|
| **installer bin（`npx ... install [--agent-dir <path>] [--profile main\|controlled]`）** | 高：显式、幂等、可指定目标与清单；升级 = 重跑（原子替换） | 低：一个 bin 脚本 + 复制 + npm install 调用 | 无 |
| postinstall 自动装进 `~/.pi/agent` | 低：npm 生态公认反模式（全局副作用 + 卸载残留）；且根包 postinstall 已被 install-skill.sh 占用，语义混淆 | 低 | 用户在 CI/容器里 install 时意外写 HOME |
| 手工文档（README 教 tar 解包） | 低：P2 的依赖落盘手工做必错 | 低 | 高 |

裁决 **installer bin**。安装动作规格（两通道共用核心三步）：

```
1. npm pack @zhushanwen/pi-coding-workflow-extension@<ver>（或本包自定位）→ tarball
2. 解包到 <target>/extensions/pi-coding-workflow-extension/.tmp/ → 原子 rename 替换同名目录
   （target = ~/.pi/agent [profile main] 或 --agent-dir 指定值 [profile controlled]）
3. 在该目录内执行 npm install --omit=dev --no-audit --no-fund
   → 依赖落盘 <dir>/node_modules/（Node 从 extension 文件位置向上解析，命中）
```

发现机制两条通道不同：main 通道靠 loader 规则 3（`extensions/<dir>/package.json` 含 `pi` 字段）自动发现；controlled 通道靠 cw spawn 的 `--extension <abs-path>` 显式注入（xyz-agent rpc-client.ts:138-142 同款）——**安装器对两条通道只差 target 目录与包清单，安装核心步骤同一份代码**。

**决策四：发版协议——双 tag vs 单 tag 双发**

| 方案 | 长期 | 短期 | 风险 |
|------|------|------|------|
| **双 tag**：`v*` → 核心包 job；`ext-v*` → 插件包 job；workflow_dispatch 加 package 输入 | 高：两包节奏解耦（M1）；tag 即审计锚（哪个 tag 发了哪个包） | 低：release.yml 加一个 job + 触发规则 | tag 前缀约定要写进 CONTRIBUTING/README |
| 单 tag 双发 | 低：extension 每次跟随核心发版，0.5.x 节奏被 2.x 绑架 | 低 | 无谓发版（核心 patch 也触发 extension 版本） |

裁决 **双 tag**。release.yml 改造：保留现有 steps 为 core job（`if: startsWith(github.ref, 'refs/tags/v') || inputs.package == 'core'`）；新增 extension job（`if: startsWith(github.ref, 'refs/tags/ext-v') || inputs.package == 'extension'`，working-directory: `pi-coding-workflow-extension`，install → vitest → pack --dry-run → publish --provenance）。

**决策五：受控 agentDir 布局与清单**

```
~/.cw/agent-dir/                     # CW_AGENT_DIR 常量（cw 侧定义，D1）
├── extensions/
│   ├── ask-user/                    # 子进程穿透提问（D4）
│   └── subagent-workflow/           # 子进程侧 subagent 能力（如 designer 再派孙进程——首版可不装，清单可配）
├── node_modules/                    # extensions 内包的共享依赖位（npm install 落盘）
└── manifest.json                    # 记录清单版本 + 各包版本（探针比对用，非运行时依赖）
```

清单来源：installer 内置 `--profile controlled` 默认清单（ask-user 起步），后续按 D7 权限需求扩展。**注意**：pi-cw-runner extension 本身不进受控 agentDir——它跑在用户主会话（main 通道），受控 agentDir 只装「子进程需要的扩展」（两者的包清单差异是两通道的本质区别，见 §3.4 数据流）。

### 3.3 关键决策与权衡（汇总）

| # | 决策 | 被否 | 依据 |
|---|------|------|------|
| R1 | 仓布局 = 根包原地 + 根级插件包 | 全迁 packages/* | 决策一 |
| R2 | 直发 TS 源码 | 构建 dist | 决策二（生态一致性） |
| R3 | installer bin 显式安装 | postinstall 自动 / 手工 | 决策三 |
| R4 | 双 tag 发版 | 单 tag 双发 | 决策四 |
| R5 | 受控 agentDir = `~/.cw/agent-dir/` + extensions/ 清单 + manifest | 每次现拼临时目录 | 可重建、可探针、可审计（D1 落地形态） |

**运行时断言与探针**（总纲 HP 体系在本波次的投影）：

| ID | 断言 | 探针 | 状态 |
|----|------|------|------|
| PP1 | 根包 `npm pack --dry-run` 不含 `pi-coding-workflow-extension/`（files 白名单天然排除，workspaces 不污染） | ph-i0 内跑 `npm pack --dry-run` + 输出 grep | ⛔ 实施期首验；失败 → 根包 files 加显式排除项（npm 根包 publish 对子目录的收集行为按 npm@11 实测为准） |
| PP2 | 装入临时 agentDir 后真实 pi 进程发现并加载 extension | `PI_CODING_AGENT_DIR=<tmp> pi -p "list your tools"` 输出含 cw 注入物（ph-i0 骨架期注入一个哨兵命令 `/cw-ping` 验证加载链，业务工具 ph-i2 再上） | ⛔ ph-i0 |
| PP3 | release.yml 两 job 在 dry-run 输入下各自通过 | workflow_dispatch dry-run ×2 | ⛔ ph-i0 |

### 3.4 物理数据流（安装→发现→加载）

```
npm registry
  → installer bin（npx 或 cw setup-agent-dir 调用）
      → tarball 解包 <target>/extensions/pi-coding-workflow-extension/（原子替换）
      → 包内 npm install --omit=dev → node_modules/{@zhushanwen/coding-workflow, @zhushanwen/pi-subagent-workflow, ...}

[main 通道]                          [controlled 通道]
用户启动 pi 主会话                    cw spawn 子进程（ph-i1 适配器）
  → loader 扫 ~/.pi/agent/extensions/   → env PI_CODING_AGENT_DIR=~/.cw/agent-dir
  → 规则 3 命中 package.json "pi" 字段    → args --no-extensions --extension <abs-path>...
  → jiti 加载 index.ts                  → jiti 加载受控清单扩展
  → extension import 的 npm 依赖经
    包内 node_modules 解析（Node 向上查找）
```

## 4. 验收（真实场景，非单测）

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|----------------|------|---------|
| A1（M3） | workspaces 化后核心包零退化 | 改造后跑 `npm run check:all && npm test && npm run lint` | 全绿，用例数与改造前一致（以实跑为准）；`npm pack --dry-run` 文件列表不含插件包目录（PP1） |
| A2（M2） | main 通道端到端安装加载 | 干净的临时 HOME（`HOME=<tmp> npx ... install`）→ `PI_CODING_AGENT_DIR` 指向该 HOME 的 agent 目录跑真实 `pi -p` 探针 | extension 被加载（哨兵命令/工具在输出可见）；重跑 install 幂等（目录替换无残留旧版本）；卸载脚本清干净 |
| A3（M4） | 受控 agentDir 重建 + 探针 | `cw setup-agent-dir --agent-dir <tmp>` | 目录结构符合 §3.5 R5；探针 spawn 真实 pi 校验 ask-user 在场；故意删掉一个扩展后探针 exit 1 且 stderr 给出缺失名与恢复命令 |
| A4（M1） | 双 tag 发版 | push `v*`（fake bump，dry-run 输入）与 `ext-v*` 各跑一次 workflow_dispatch dry-run | core job 只动根包、extension job 只动插件包目录；两者 npm publish 步骤在 dry-run 下正确跳过 |

单元测试（installer 的幂等替换、清单解析）仅作回归辅助。

## 5. 下一层拆分（ph-i0 内 unit 清单）

| unit | 内容 | justification | 验收锚 |
|------|------|---------------|--------|
| u-i0-a | 根 package.json workspaces + `./runner` 导出占位（指向 dist/runner.js，ph-i1 前为空模块）+ PP1 | 结构先行：后续两个 unit 都依赖包位存在 | A1 |
| u-i0-b | `pi-coding-workflow-extension/` 包骨架（package.json/index.ts 哨兵入口/src/）+ installer bin（install/doctor/uninstall）+ A2 | 包骨架与安装器互为验证（装得上=骨架对）；哨兵入口把「加载链通」与「业务逻辑」解耦 | A2、PP2 |
| u-i0-c | 受控 agentDir 建立命令（`cw setup-agent-dir`，复用 installer 核心）+ 清单 + manifest + release.yml 双 job | 依赖 u-i0-b 的安装核心；发版改造独立可验 | A3、A4、PP3 |

**文件改动地图**：

- `package.json`：+`workspaces: ["pi-coding-workflow-extension"]`、exports +`"./runner": "./dist/runner.js"`（占位）
- `pi-coding-workflow-extension/`（新）：`package.json`（name/version 0.5.0/type module/main index.ts/pi.extensions/keywords ["pi-package"]/files ["index.ts","src","bin"]/bin install 脚本）、`index.ts`（哨兵：registerCommand `/cw-ping` + console 锚）、`src/`（骨架）、`bin/install.mjs`（installer：pack→解包→原子替换→npm install→doctor）
- `src/cli.ts` / `src/dispatch.ts`：+`setup-agent-dir` 命令（薄封装调同一安装核心）
- `.github/workflows/release.yml`：+extension job + 触发规则 + dispatch 输入
- `docs/`：README 安装段 + CONTRIBUTING tag 协议一句话

**待验证检查点（诚实标注）**：① PP1 的 workspaces 包污染需实跑确认（npm 对根包 publish 与 workspaces 的交互在不同 npm 版本行为有差异——本仓 packageManager 锁 npm@11.6.2，以实跑为准）；② jiti 对「TS 入口 + ESM npm 依赖」组合的加载在 pi 0.84.2 的实测（PP2 覆盖，pi-scheduler 先例表明可行但依赖树更深一层）；③ 受控 agentDir 清单首版只装 ask-user——designer 子进程是否还需要 subagent-workflow（孙派发场景）在 ph-i2 实战中定，清单机制支持后续加包。
