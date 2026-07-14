---
name: dev-link
description: >-
  Use when the user says "切换到 npm 正式版", "切换到本地开发版",
  "卸载 link 装正式版", "卸载正式版装 link", "dev-link", or wants to
  toggle the `cw` command between the published npm package and the local
  development symlink. Provides two scripts: use-npm.sh (uninstall local link,
  install published npm version) and use-link.sh (uninstall npm version,
  install local symlink for development).
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

卸载 npm 正式版，`npm link` 本地项目（会先 `npm run build`）。

```bash
bash .agents/skills/dev-link/use-link.sh
```

切换后脚本会打印当前 `cw` 的指向，确认结果。
