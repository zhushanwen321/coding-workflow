---
name: dev-link
description: >-
  Use when the user says "切换到 npm 正式版", "切换到本地开发版",
  "卸载 link 装正式版", "卸载正式版装 link", "dev-link", or wants to
  toggle the `cw` command between the published npm package and the local
  development symlink. Provides two scripts: use-npm.sh (uninstall local link,
  install published npm version) and use-link.sh (uninstall npm version,
  link the local project and install skill/agent symlinks for development).
---

# dev-link（cw 安装切换器）

切换 `cw` 命令在两种安装之间：

| 模式 | `cw` 指向 | 用途 |
|------|----------|------|
| npm 正式版 | npm registry 的发布包 | 测试发布版本、验证用户实际体验 |
| 本地 link | 本项目 `dist/cli.js` | 开发调试，改完即生效 |

## 两个脚本

### `use-npm.sh` — 切换到 npm 正式版

卸载本地 symlink，安装 npm 正式版。

```bash
bash .agents/skills/dev-link/use-npm.sh           # 默认 latest
bash .agents/skills/dev-link/use-npm.sh 0.0.1     # 指定版本
```

### `use-link.sh` — 切换到本地开发版

卸载 npm 正式版，`npm link` 本地项目（会先 `npm run build`），然后执行 `scripts/install-skill.sh`，把包内 skills/agents 以 symlink 安装到全局目录（skills → `~/.agents/skills` + `~/.claude/skills`；agents → `~/.agents/agents` + `~/.pi/agent/agents` + `~/.claude/agents`）。

```bash
bash .agents/skills/dev-link/use-link.sh
```

切换后：cw 在当前 PATH 时打印其指向，确认结果；cw 不在 PATH 时（如新装 bin 未进入当前 shell），stdout 仍报成功、stderr 出警告并附 `npm ls -g @zhushanwen/coding-workflow` 验证指引，脚本 exit 0（安装本身已完成，不以 PATH 缺失伪装失败）。

## 多 worktree 场景

`install-skill.sh` 带 skip-protection：受管路径上「指向别处的有效 symlink」不覆盖，warning + 跳过（`warning: skip symlink pointing elsewhere`）。由此：

- **多仓 / 多 worktree 都跑过 `use-link.sh` 时**，skills/agents symlink 继续指向最早那次安装的 repo——`use-link.sh` 实际只保证 `cw` 切到本 repo，不切换 skills 归属。该 warning 直呼 `use-link.sh` 时可见；经 `use-npm.sh`（postinstall 路径）时会被 npm 吞掉，不易察觉。
- **要把 skills 归属切到某个 repo**：先删掉旧 link（`rm ~/.agents/skills/<name>` 等）再跑该 repo 的 `use-link.sh`，或直接在该 repo 重跑 `use-link.sh`（npm link 部分会切换，skills 部分受 skip-protection 保护需按前述手动处理）。

### `use-npm.sh` 的收敛行为

`use-npm.sh` 在 `npm install -g` 成功后，会把本包受管路径上 dev link 时代残留的 symlink 重建为 npm 包指向（skill/agent 清单从 npm 包内动态枚举）：

- 悬空 symlink（本地 worktree 已清理的化石）→ 重建为 npm 指向；
- 指向本包任一 checkout（判定：目标所属 `package.json` name 为本包名，覆盖任意 worktree）→ 重建为 npm 指向；
- 已指向 npm 包 → 保持；
- 其他有效 link（用户自有同名 skill 等）与实体文件 → 不覆盖，warning 出声。

处理完逐条打印每个 symlink 的最终指向。
