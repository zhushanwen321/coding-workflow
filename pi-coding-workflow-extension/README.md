# @zhushanwen/pi-coding-workflow

> npm 包名复用一代 0.4.x（cw 状态机 tool 时代，已退役）；0.5.0 起本包为 cw 2.x 的 pi extension
> （pi-cw-runner）。源码目录仍为仓内 `pi-coding-workflow-extension/`，安装目标目录同名。

pi（[@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）扩展：把
coding-workflow（cw）的派发循环以库形态跑在 pi 主会话进程内（ph-i0 骨架期只含哨兵命令
`/cw-ping`，业务功能见 ph-i2）。

## 安装（用户主会话通道）

```bash
npx @zhushanwen/pi-coding-workflow install
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
cd pi-coding-workflow-extension   # 仓内目录名与 npm 包名解耦（包名见 package.json）
npm install
npm test        # installer 纯逻辑回归（真实 tmp/tar/npm 子进程，零 mock）
```

### 本地开发注意：subagent-workflow 本地副本会污染根 node_modules/.bin/pi

以 `npm install ~/Code/tai-ji-workspace/main/extensions/subagent-workflow --no-save`
装入本地 2.0.0 副本做联调时，npm 会连带提升 pi-coding-agent 依赖到 workspaces
根，并在根 `node_modules/.bin/` 生成同名 `pi` 链接。vitest 会把 `node_modules/.bin`
前置到 PATH，仓内测试 spawn 的 pi 命中此链接而非用户 PATH 的 pi——仅当链接
指向旧谱系（如 `@mariozechner/pi-coding-agent` 0.73.x，现象：真实 pi 后端用例
秒退 exit 1，stderr 含 `No models match pattern`）时才有害；package-lock 同步后
（2026-08-24）链接指向 `@earendil-works/pi-coding-agent@0.84.2`，与用户环境
同版本同行为（tests/i1b 9/9 实测）。版本漂移出问题时：`rm node_modules/.bin/pi`
（根目录 npm install 会重建，需重删）。
发布依赖走 npm 正装（`^2.0.0`）后 CI 的 core job 不装该依赖，无此问题。

### 本地开发注意：npm install 会冲掉插件包测试所需的本地链接

插件包 probe ②③ 探测 `@zhushanwen/pi-subagent-workflow`（含 createSpawnManager
的本地 2.0.x）与 `@zhushanwen/coding-workflow/runner`（根仓 exports 子路径，
npm 上已发的 2.1.0 无此出口）。任何 `npm install`（含 `--no-save`）都会按
package-lock 把这两个位置规整成 registry 实体——probe 拒启、entry /
acceptance-fixes 测试连环挂。恢复（coding-workflow 链接必须**最后**建，
否则被后续 install 冲掉）：

```bash
npm install ~/Code/tai-ji-workspace/main/extensions/subagent-workflow --no-save
rm -rf node_modules/@zhushanwen/coding-workflow
ln -s "$(git rev-parse --show-toplevel)" node_modules/@zhushanwen/coding-workflow
npm run build   # ./runner 子路径解析走根仓 dist 产物
```
