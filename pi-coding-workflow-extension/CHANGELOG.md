# Changelog

本包遵循独立发版节奏：`ext-v*` tag 触发 CI 发布（见根 `.github/workflows/release.yml` 的 `publish-extension` job）。

## 0.5.0 (2026-08-25)

首个公开发布版本。npm 包名复用一代 `@zhushanwen/pi-coding-workflow@0.4.x` 的名字——
一代内容（cw 状态机 tool + 18 skills + execute-full-workflow.js workflow 脚本）随本次
发布退役，0.5.0 起本包只承载 cw 2.x 的 pi extension（pi-cw-runner）。仓内源码目录仍为
`pi-coding-workflow-extension/`，安装目标目录同名。

### Added

- `/cw` 命令组：start / status / report / takeover / stop —— 把 `cw run` 派发循环以
  库形态跑进 pi 主会话进程（subagent-workflow SpawnManager 作为 spawn 后端）
- `/cw-ping` 哨兵命令 + 启动探针（cw 引擎与 subagent-workflow 编程 API 探测式动态
  import，缺失拒启 + 恢复指引）
- installer bin（`install` / `doctor` / `uninstall`；`npx @zhushanwen/pi-coding-workflow install`
  装到用户主会话 agentDir，`--agent-dir --profile controlled` 装受控 agentDir）
- `cw setup-agent-dir` 经 spawnSync 复用本包 installer 核心（受控 agentDir 安装准备）

### Notes

- 运行时依赖：全局安装 `@zhushanwen/coding-workflow@2.x`（PATH 上有 `cw`）+
  `@zhushanwen/pi-subagent-workflow` 编程 API（createSpawnManager）
- 一代 0.4.x 用户升级前请知悉：0.5.0 不含旧 tool 与 skills，属破坏性换代（0.x minor 语义）
