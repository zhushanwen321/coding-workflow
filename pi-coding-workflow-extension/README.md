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

### 本地开发注意：subagent-workflow 本地副本会污染根 node_modules/.bin/pi

以 `npm install ~/Code/tai-ji-workspace/main/extensions/subagent-workflow --no-save`
装入本地 2.0.0 副本做联调时，npm 会连带提升其依赖 `@mariozechner/pi-coding-agent`
到 workspaces 根，并在根 `node_modules/.bin/` 生成同名 `pi` 链接（0.73.x）。vitest
会把 `node_modules/.bin` 前置到 PATH，导致仓内测试 spawn 到错误版本的 pi（现象：
真实 pi 后端用例秒退 exit 1，stderr 含 `No models match pattern`）。

修复：`rm node_modules/.bin/pi`（下次在根目录跑 npm install 会重建，需重删）。
发布依赖走 npm 正装（`^2.0.0`）后 CI 的 core job 不装该依赖，无此问题。
