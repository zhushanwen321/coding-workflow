---
verdict: pass
phase: closeout
---

# Closeout Report — cw-cli-extract

## 目标

将 pi coding-workflow extension 的核心 engine 抽离为独立 npm 包 `@zhushanwen/coding-workflow` + CLI 子进程入口（bin=cw），使任何能调子进程的 coding agent 都能驱动 CW 状态机。

## 交付物

### 源码（28 文件）
- `src/cli/cli.ts` — CLI 入口（argv 解析 + action 路由 + exit code 分层）
- `src/cli/protocol.ts` — CwParamsSchema 信封 + typebox 校验 + stdin/文件读取
- `src/engine/state-machine.ts` — 状态机 guard + nextAction 构建
- `src/engine/store.ts` — JSON 文件持久化 + 内存事务
- `src/engine/gates.ts` — GateRunner + GitValidator
- `src/engine/plan-parser.ts` — lite/mid plan JSON 解析
- `src/engine/dispatch.ts` — action 分派入口
- `src/engine/types.ts` — 类型定义
- `src/engine/path-encoding.ts` — cwd 编码
- `src/engine/actions/{create,plan,dev,test,replan,retrospect,closeout}.ts` — 7 个 action handler
- `src/engine/checks/*.ts` — 8 个 machine check 脚本

### 测试（13 文件，184 tests）
- `tests/engine/` — state-machine(69) + store(16) + gates(21) + plan-parser(21) + types(8)
- `tests/cli-e2e/` — create(6) + plan(5) + dev(6) + replan(4) + status-list(7) + nfr(10) + e2e(10) + lite-flow(1)

### 配置
- `package.json` — bin=cw, name=@zhushanwen/coding-workflow
- `tsconfig.json` — ES2022 + NodeNext
- `vitest.config.ts` — 排除 .xyz-harness 骨架测试
- `scripts/verify-anti-patterns.sh` — 7 项反模式验收

## 验证结果

| 检查项 | 结果 |
|--------|------|
| `npx tsc --noEmit` | ✅ 通过 |
| `npx vitest run` | ✅ 184/184 passed |
| `bash scripts/verify-anti-patterns.sh` | ✅ 7/7 全绿 |
| CW dev gate | ✅ 7/7 waves committed |
| CW test gate | ✅ 39/39 testCase passed |
| CW retrospect gate | ✅ 通过 |
