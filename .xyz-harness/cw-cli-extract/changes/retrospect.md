---
verdict: pass
phase: retrospect
---

# 复盘 — cw-cli-extract

## 执行摘要

将 pi coding-workflow extension 的核心 engine 抽离为独立 npm 包 `@zhushanwen/coding-workflow` + CLI 入口（bin=cw）。
7 Waves 全部 committed，39 test cases 全部 passed（184/184 vitest 测试通过）。

## 做得好的

- **engine 零改动搬迁成功**：核心层（state-machine/store/gates/plan-parser/dispatch/actions）零 pi 依赖，直接复用
- **CLI 适配层设计正确**：子命令风格 + stdin/--xxx-file 大 JSON + exit code 分层契约（gate fail=0, illegal_transition≥1）
- **TDD 流程有效**：每个 wave 先写失败测试 → 实现 → 通过
- **反模式验收 7/7 全绿**：无 pi 依赖、无 copy-paste、无单实现 adapter、StringEnum 已替换、exit code 分层已实现

## 出过的问题

### 1. Workflow 聚合 merge 冲突（根因）
- **现象**：W3/W5 并行 wave 各自从 main（只有 LICENSE+README）创建 worktree，每个都从零重建整个 engine，与 W1/W2 冲突
- **根因**：execute-full-workflow 的每个 wave 从 BASE_REF 创建分支，并行 wave 之间没有代码共享
- **修复**：手动选 W7（最完整实现，包含所有 7 个 actions + 8 个 checks）作为聚合分支

### 2. commitHash 提交错误（认知失误）
- **现象**：第一次 cw(test) 全部 39 case failed
- **根因**：提交了不存在的 full hash（`01e48820...` vs 实际 `01e4882ff...`）；第二次 26 个 case 用了错误的 JSON key（`claimHash` vs `commitHash`）
- **修复**：用 `git rev-parse HEAD` 取正确 hash，逐批重提交

### 3. multi-workspace cwd 陷阱（CLAUDE.md [HISTORICAL]）
- **现象**：连续 11+ 次发 `npm install` 漏 `cd main` 前缀
- **根因**：cwd 不跨 bash 调用持久，workspace 根 vs main/ 子目录
- **修复**：用 `git -C <path>` / `npm --prefix <path>` / `(cd <path> && cmd)` 三种绝对路径模式

## 验证证据

- `npx vitest run`: 13 test files, 184 tests passed, 0 failed
- `bash scripts/verify-anti-patterns.sh`: 7/7 全绿
- `npx tsc --noEmit`: 无错误
- CW test gate: 39/39 testCase passed, status=tested
