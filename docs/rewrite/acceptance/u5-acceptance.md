# u5 验收标准：TestRun 缝 + vitest / e2e-sh 适配器（纯函数层）

> **锁定文件**：派发基线（已入 git）。builder 与 verifier 禁止修改本文件。
>
> status: pending（pending → building → built → verifying → verified → committed / rejected）

## 目标

交付两个 TestRun 适配器的 translate/parse 纯函数实现与真实 fixture 单测（**不接线 verify——接线属后续 unit，本 unit 不碰 src/verify 与 handlers**）。canon 依据：附录 B.2、子文档 2 §7（vitest JSON reporter 解析非文本正则；e2e-sh 标记行约定 `A<id> PASS/FAIL`）。契约层 `src/testrun/types.ts` 已由主 agent 预建（TestRunAdapter/EvidenceReport/AdapterRegistry）——只 import，禁修改。

## 规格锁定

### vitest 适配器（`src/testrun/vitest.ts`）

- `translate(acceptance)`：acceptance.command 存在 → 确保含 `--reporter=json`（已有则原样，没有则追加）；command 不存在 → 生成 `npx vitest run --reporter=json`（默认全量，M0 口径）。
- `parse(stdoutPath, exitCode, acceptance)`：读 stdoutPath 文件 → JSON.parse（失败抛错，**禁止伪造 cases**）→ 从 `testResults[].assertionResults[]` 折叠 cases：每 assertion `{name（fullName/title 连接）, status}` → 映射 `{id: 验收 id（单一验收对应多断言时 id 相同、name 区分）, name, status: pass|fail}`（skipped/todo → fail，M0 不认 skip）；exitCode 透传；rawPath=stdoutPath。
- vitest JSON 中任一 assertion 非 passed 且 exitCode=0 的矛盾输入：以 assertion status 为准（cases 如实），不掩盖。

### e2e-sh 适配器（`src/testrun/e2e-sh.ts`）

- `translate(acceptance)`：command 原样返回（e2e 脚本自写标记行，translate 不改写）；command 缺失抛错。
- `parse(stdoutPath, exitCode, acceptance)`：逐行扫描 `^A([A-Za-z0-9-]+) (PASS|FAIL)$` 标记行 → cases（id 取自标记、status 映射）；同一 id 多次出现以**最后一次**为准；**标记行缺失且 exitCode≠0** → 该验收整体 fail（id=验收 id, name="no-markers"）；标记缺失且 exitCode=0 → 抛错（无区分力——echo ok 类假命令防线的 parse 侧表达）；标记的 id 与验收 id 不符 → 抛错（报告指明出现的 id 与期望）。

### 注册表（`src/testrun/registry.ts`）

- `defaultRegistry(): AdapterRegistry`：含 vitest + e2e-sh 两项（key = type 字段："vitest"、"e2e-sh"）。

## 交付物

| 文件 | 内容 |
|------|------|
| `src/testrun/vitest.ts` / `e2e-sh.ts` | 两适配器（实现 TestRunAdapter 接口） |
| `src/testrun/registry.ts` | defaultRegistry |
| `tests/u5-vitest.test.ts`、`tests/u5-e2e-sh.test.ts` | 单测（fixture 生成方式见下） |

## 单测验收（fixture 必须真实，禁手写 JSON 凭空造）

1. **vitest fixture 真实生成**：测试内 `spawnSync npx vitest run tests/smoke.test.ts --reporter=json`（本仓库真实测试，3 条 smoke）→ stdout 落 tmp 文件 → parse → cases ≥3 且 status=pass、exitCode=0、id=传入验收 id。
2. vitest 含失败用例：真实构造 tmp 测试文件（一个断言失败）跑 vitest → parse 出 fail case；exitCode=1。
3. vitest stdout 非法 JSON → parse 抛错（不伪造）。
4. translate：已有 --reporter=json 不重复追加；无 command 默认命令含 --reporter=json（断言生成串）。
5. **e2e-sh fixture 真实生成**：tmp 写脚本输出 `A1 PASS`/`A2 FAIL` 两行 + exit 1 → 执行落盘 → parse → cases=[A1 pass, A2 fail]。
6. e2e-sh 标记缺失 + exit 0 → 抛错（无区分力防线）；标记缺失 + exit≠0 → 整体 fail 不抛；标记 id 与验收 id 不符 → 抛错且信息含两边 id。
7. 同 id 重复标记以最后为准（fixture 脚本真实输出重复行）。
8. registry：defaultRegistry 含两 key，type 字段与 key 一致。

## 通过命令

```
npm run check:all
npm test          # 并行期以 u5 自有测试文件全绿为准（vitest fixture 跑真实测试可能秒级，可接受）
npm run lint      # u5 领地零输出
```

## 禁改清单

`src/testrun/types.ts`、`src/dispatch.ts`、`src/cli.ts`（契约层）；`src/verify/**`、`src/handlers/**`、`tests/u4a-*`（u4a 并行领地）；`src/readonly/**`、`tests/u1b-*`（u1b 领地）；已验收 unit 源域（events/store/core/gates）；archive/、docs/rewrite/ 其余、tests/ 既有文件。禁 git 写操作；禁 mock；禁 any。
