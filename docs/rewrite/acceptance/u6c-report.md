# u6c 验收报告：pi 适配器（真实 harness 第一个接入）

> verifier 独立验收报告（对抗式）。验收标准：`docs/rewrite/acceptance/u6c-acceptance.md`（锁定文件）。
>
> **总结论：PASS** —— 全部条款通过、防篡改通过、4 条行为对抗与验收文档零矛盾、两项裁量判定合理。

## 基线与防篡改

| 项 | 值 | 结论 |
|----|----|------|
| 基线 commit | `9c6af0122adb8bfc4dc0f1c1fb565dd8fbd80010`（`9c6af01`） | — |
| 验收文档 sha256（基线版 `git show 9c6af01:...`） | `594bf27a5dfd0be754527d87c1bff558f8d6535adb936bc4641efa785aa095ef` | — |
| 验收文档 sha256（工作区版） | `594bf27a5dfd0be754527d87c1bff558f8d6535adb936bc4641efa785aa095ef` | 一致，无篡改 |
| `git diff 9c6af01 -- docs/rewrite/acceptance/u6c-acceptance.md` | 空输出 | 无篡改 |
| `git diff 9c6af01 --stat -- src/ tests/` | 空输出（无已跟踪源/测试文件改动） | 已验收源域零触碰 |
| u6c 领地 git status | 仅 2 个新文件：`src/runner/spawn/pi.ts`、`tests/u6c-pi-adapter.test.ts`（untracked） | 符合交付物清单 |

工作区其余 untracked/modified（`src/runner/spawn/human.ts`、`tests/u6b-human-adapter.test.ts`、drawio 产物、`AGENTS.md`）属 u6b 并行开发与协调者领域，非 u6c 交付物，内容与 u6c 无关（u6c 两文件不 import human.ts）。

## 命令实跑

| 命令 | 结果 | 备注 |
|------|------|------|
| `npx vitest run tests/u6c-pi-adapter.test.ts` | **9 passed (9)**，Duration 6.93s | 真实 E2E 条 6561ms，stdout 摘录 `"可用"`（brief 要求的两字），未 skip |
| `npx eslint src/runner/spawn/pi.ts tests/u6c-pi-adapter.test.ts` | 零输出，exit 0 | — |
| `npm run check:all`（tsc src + tests 双工程） | exit 0 | u6b/u7 并行中途态未引入类型错误，无需归因豁免 |

## 条款对照（验收文档「单测验收」4 组）

1. **buildPiCommand**：`tests/u6c-pi-adapter.test.ts` L62-103。
   - 默认模型断言用 `toEqual` 深比较完整锁定 `{command:"pi", args:["--model", DEFAULT, "-p","--no-session","@<briefPath>"]}`——真锁定了 `--model <值>` 形态与 `@<briefPath>` 完整位置参数，非「只断言子串 pi」。
   - 三级优先级各一断言（L72-87），且每级同时设了低级别干扰值：优1 同时设 req.env=`req-env/model` + process.env=`proc-env/model` 才断 `opt/model` 胜；优2 设 process.env 才断 `req-env/model` 胜——锁的是优先级**序**而非仅存在性。
   - `@file` 形态断言含排除项：`not.toContain("<")`、`not.toContain("$(cat")`，并含 `-p`/`--no-session`。
   - extraArgs 断言 `slice(-2)` 锁尾部追加。
2. **env 合并**：L107-135，真实 sh 子进程观测（PATH 前置探测脚本打印 env 变量），断言 exitCode=0、stdout 内容含透传值、产物路径精确匹配 `<workdir>/.cw-spawn/<unitId>.<role>.stdout/.stderr`。零 mock。
3. **真实 E2E**：L138-174，`which pi` 探测决定 skip 与否（本地 pi 可用 → 真实跑未 skip）；真实网络模型调用，exit 0 + stdout 非空；testTimeout 放宽 120s（timeoutMs 压 110s 在其内，卡死走 TIMEOUT 归因而非 vitest 硬超时）。
4. **SPAWN_ERROR 转译**：L176-195，PATH 隔离（`PATH=/nonexistent-path-u6c`）下完整返回值断言：`exitCode==="SPAWN_ERROR"` + `pid===-1` + 两个产物路径——强于验收条款（条款只要求 exitCode 不挂死）。

规格其余项：`name:"pi"`（pi.ts L91）；spawn 经 `lifecycle.spawnProcess`（L100）；timeoutMs 只透传不另设缺省（L107，types.ts 必填 30min 由调用方给）；env 合并归 lifecycle（lifecycle.ts L107-108 `{...process.env, ...req.env}` req.env 覆盖子集，适配器只透传）——逐条对上。

## 裁量评判

1. **追加导出 `resolvePiModel` 纯函数（验收文档锁定签名仅 createPiAdapter/buildPiCommand 两项）**：**合理**。锁定的两参 `buildPiCommand(req, model)` 中 model 是入参，三级取值逻辑若内联在 createPiAdapter 里则单元级不可测（必须起进程走全链路）。抽出为纯函数是标准可测性重构；`createPiAdapter` 内部单点调用它（pi.ts L97），无双轨漂移。verifier 对抗探针（见下）在纯函数级与全链路级同时验证了行为一致。
2. **`buildPiCommand` 第三参 `extraArgs` 带默认值 `[]`**：**合理**。验收文档正文要求「`pi --model <model> -p --no-session @<briefPath>` + opts.extraArgs」而锁定签名只有两参，两者本身矛盾——extraArgs 在两参签名中没有位置。默认参是最小消解方式，两参调用形态不变（测试 L66 两参调用实证通过）。

## 行为对抗抽查（4 条，真实子进程，探针走完整 createPiAdapter.spawn 链路；探针为 /tmp 临时脚本未入 repo、已清理）

| # | 对抗场景 | 观测结果 | 判定 |
|---|---------|---------|------|
| A1 | `process.env.CW_AGENT_MODEL=proc/loser` 与 `req.env.CW_AGENT_MODEL=req/winner` 同设不同值，探测脚本回显收到的完整命令行 | 命令行 `--model req/winner`，`ENVMODEL:req/winner` | req.env 胜，全链路（非仅纯函数级）✓ |
| A2 | `createPiAdapter({extraArgs:["--probe-flag","xyz"]})` | 命令行尾部出现 `--probe-flag xyz`；同时无两级 env 覆盖时 `--model proc/loser`（第三级 process.env 胜默认） | extraArgs 真实透传 ✓ + 第三级佐证 ✓ |
| A2b | `createPiAdapter({model:"opt/fixed"})` + req.env `req/loser` + process.env `proc/loser` | 命令行 `--model opt/fixed` | 第一级 opts.model 胜两级 env ✓ |
| A3 | 真实 pi 调用换 brief 内容「请只输出 PASS」 | 5903ms，exitCode=0，stdout=`"PASS\n"`（与单测的「可用」不同输出） | 真实调用非缓存/固定输出 ✓ |
| A4 | `env.PATH=/nonexistent-u6c-verify` | wait() **1ms** 秒回 `{exitCode:"SPAWN_ERROR", pid:-1}` | 不挂死、完整四态出口 ✓ |

与验收文档矛盾项：**无**。

## minor 观察（不阻断 PASS，供后续 unit 参考）

1. `src/runner/spawn/pi.ts` L111-128 catch 块吞掉 lifecycle 预检错误的具体信息（哪个可执行、恢复建议），SPAWN_ERROR 返回值不带 detail；且预检抛出早于产物文件创建（lifecycle.ts L109 早于 L114 openSync），该态返回的 stdout/stderr 路径实际不存在（单测组3 用 `existsSync` 防御，说明作者知情）。契约未规定 SPAWN_ERROR 态产物文件必须存在，不算违约；若后续 runner 需要诊断信息，可考虑在该态写入 stderr 文件。
2. `resolvePiModel` 用 `!== undefined` 判空：显式空串（`opts.model=""` 或 `CW_AGENT_MODEL=""`）会原样透传为 `--model ""`，由 pi 报错暴露。语义上属「显式配置错误直接暴露」，是边界选择而非缺陷。

## 结论

**PASS**。u6c 交付物（`src/runner/spawn/pi.ts` + `tests/u6c-pi-adapter.test.ts`）满足验收文档全部条款：防篡改通过、9/9 测试全绿（含真实 pi E2E 未 skip）、lint/check:all 干净、4 条行为对抗零矛盾、两项裁量（resolvePiModel 导出、extraArgs 默认参）判定合理。
