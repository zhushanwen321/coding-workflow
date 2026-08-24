# @zhushanwen/pi-coding-workflow-extension

pi（[@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）扩展：把
coding-workflow（cw）的派发循环以库形态跑在 pi 主会话进程内（ph-i0 骨架期只含哨兵命令
`/cw-ping`，业务功能见 ph-i2）。

## 安装（用户主会话通道）

```bash
npx @zhushanwen/pi-coding-workflow-extension install
# → 装到 ~/.pi/agent/extensions/pi-coding-workflow-extension/（loader 自动发现）
# 重启 pi 会话生效；doctor / uninstall 子命令校验/卸载
```

## 受控 agentDir 通道（cw spawn 用）

```bash
cw setup-agent-dir                       # 默认 ~/.cw/agent-dir（ask-user + manifest.json + 启动探针）
# 等价：node bin/install.mjs install --profile controlled [--agent-dir <dir>]
#      [--ask-user-source npm|path] [--ask-user-path <dir>] [--skip-probe]
```

ask-user 扩展默认从 npm 安装 `@zhushanwen/pi-ask-user`；npm 源不可达时回落
`--ask-user-path <dir>` 本地目录拷贝（stderr 提示）。

## 开发

直发 TS 源码（pi 经 jiti 加载，无构建步骤）。本包是根仓 npm workspaces 成员：

```bash
cd pi-coding-workflow-extension
npm install
npm test        # installer 纯逻辑回归（真实 tmp/tar/npm 子进程，零 mock）
```
