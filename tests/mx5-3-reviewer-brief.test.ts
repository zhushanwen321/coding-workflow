/**
 * mx5-3 单测：reviewer spec-review 任务书对抗式改版（mx5-3-acceptance §5 B1-B4）。
 * 零 mock：真实 EventLedger（隔离 CW_HOME 下的 tmp 账本）+ fold 投影 +
 * writeBriefFile 真实渲染（runner 派发全链回归由 mx-1 / fx 套件承担，此处直击
 * 模板层）。
 *
 *   B1 清单在场：真实投影输入（unit / integration / e2e-real 三型验收的
 *      spec-frozen unit）渲染 reviewer spec-review 任务书 → 输出含五维度标题
 *      与关键句 + 输出分级约定（must-fix / suggestion / info + pass 逐项显式）
 *   B2 契约口径与规则⑨一致：清单文本含「恰为 json」，且不含「无 --reporter」
 *      漂移口径（规则⑨允许 --reporter=json，禁的是其他 reporter 值）
 *   B3 其余模板零变更：designer（specReady / specFixPending / missingChildren /
 *      integrationDrift 四形态）+ build（builder）+ exec-review（reviewer）渲染
 *      输出与改动前逐字节一致——嵌入式渲染快照生成自 mx5-3 改动前源码；
 *      B3 fixture 输入全为常量合成路径（briefRef 刻意不存在，走「不可读」
 *      兜底分支），渲染输出不含任何环境相关字节，跨机逐字节可复现
 *   B4 e2e 型追问句在场：渲染含 e2e-real 验收的 unit → 输出含「标记行」追问句式
 *      （「stdout 从哪产出」——三跑 A3 裸 build 命令形态的针对性反制）
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { fold } from "../src/core/fold.js";
import type { AcceptanceItem, Contract, SplitEntry } from "../src/events/types.js";
import { unitStatus } from "../src/readonly/load.js";
import { type BriefTarget, writeBriefFile } from "../src/runner/brief.js";
import { EventLedger } from "../src/store/events-log.js";
import { attachmentsDir, ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx53-3-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
process.env.CW_HOME = cwHome;

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ================================================================
// B1 / B2 / B4 共用：真实投影输入渲染 reviewer spec-review 任务书
// ================================================================

/**
 * tmp 目录构造 spec-frozen unit（验收含 unit / integration / e2e-real 三型）
 * 并渲染 specReviewPending 形态的 reviewer 任务书。账本走真实 append（文件锁
 * 短事务 + fsync），投影走真实 fold——无任何 mock。
 */
function renderSpecReviewBrief(caseName: string): { content: string; attachDir: string } {
  const repoDir = realpathSync(mkdtempSync(join(tmpRoot, `case-${caseName}`)));
  const briefPath = join(repoDir, "brief.md");
  writeFileSync(briefPath, `# ${caseName} 任务书（mx5-3 fixture）\n`);
  const ledger = new EventLedger(ledgerPath(cwHome, repoDir));
  ledger.append("UnitCreated", { unitId: "demo", parentId: null, briefRef: briefPath });
  ledger.append("SpecSubmitted", {
    unitId: "demo",
    specHash: `mx53-${caseName}`,
    acceptance: [
      { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
      { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
      { id: "A3", core: false, title: "集成冒烟", type: "integration" },
    ],
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", {
    unitId: "demo",
    verdictKind: "spec-review",
    verdict: "pass",
    role: "reviewer",
  });
  const projection = fold(ledger.readAll());
  const unit = projection.units.get("demo");
  if (unit === undefined) {
    throw new Error("fixture 前置失败：fold 后应存在 unit demo");
  }
  // 状态锚：三型验收过真实 spec gate，pass verdict 后 unit 处于 spec-frozen
  expect(unitStatus(unit)).toBe("spec-frozen");
  const renderedPath = writeBriefFile(
    join(tmpRoot, `case-${caseName}-art`),
    { role: "reviewer", unitId: "demo", dimension: "specReviewPending" },
    unit,
    projection,
    "demo",
    repoDir,
    join(repoDir, "wt-demo"),
  );
  return {
    content: readFileSync(renderedPath, "utf-8"),
    attachDir: attachmentsDir(cwHome, repoDir, "demo"),
  };
}

describe("mx5-3 B1 清单在场：五维度对抗式核对 + 输出分级约定", () => {
  it("渲染输出含五维度标题、关键句与 must-fix / suggestion / info 分级 + pass 逐项显式", () => {
    const { content, attachDir } = renderSpecReviewBrief("b1");

    // mx-1 既有行为不回归：attachments 绝对路径与提交命令形态
    expect(content).toContain(attachDir);
    expect(content).toContain("--verdict-kind spec-review");
    expect(content).toContain("--role reviewer");

    // 五维度标题（基线 §4：维度与核对点语义锁定）
    expect(content).toContain("验收命令契约逐条核对");
    expect(content).toContain("覆盖度");
    expect(content).toContain("区分力反例追问");
    expect(content).toContain("契约（contracts）一致性");
    expect(content).toContain("干净 checkout 可执行性");

    // 关键句：契约细目（install --silent / package.json / 自带 install）
    expect(content).toContain("--silent");
    expect(content).toContain("package.json");
    // 关键句：区分力反例追问原文（基线 §4 ③）
    expect(content).toContain("无实现时它必然挂吗？换一个实现它还过吗？");

    // 输出分级格式约定：三级 + pass 时逐项显式「核过无问题」（禁含糊放行）
    expect(content).toContain("must-fix");
    expect(content).toContain("suggestion");
    expect(content).toContain("info");
    expect(content).toContain("核过无问题");
  });
});

describe("mx5-3 B2 契约口径与规则⑨一致", () => {
  it("清单文本含「恰为 json」，不含「无 --reporter」漂移口径", () => {
    const { content } = renderSpecReviewBrief("b2");
    // 规则⑨允许 --reporter=json（存量夹具幂等语义），禁的是其他 reporter 值——
    // 口径必须写「恰为 json」而非「不得带 --reporter」
    expect(content).toContain("恰为 json");
    expect(content).not.toContain("无 --reporter");
  });
});

describe("mx5-3 B4 e2e 型追问句在场", () => {
  it("渲染含 e2e-real 验收的 unit → 输出含「stdout 从哪产出」标记行追问句式", () => {
    const { content } = renderSpecReviewBrief("b4");
    expect(content).toContain("stdout 从哪产出");
    expect(content).toContain("标记行");
    expect(content).toContain("`<验收id> PASS`");
  });
});

// ================================================================
// B3：其余模板（designer 四形态 / build / exec-review）逐字节不变
// ================================================================

type B3CaseName =
  | "designer-spec-ready"
  | "designer-spec-fix"
  | "designer-missing-children"
  | "designer-integration-drift"
  | "builder-build-ready"
  | "reviewer-exec-review";

// ---- B3 fixture 常量：全合成路径（与真实 tmp 无关）——渲染输出不含环境字节 ----
const B3_CWD = "/cw-mx53-b3/project";
const B3_ROOT_ID = "mx53-root";
const B3_WORKDIR = "/cw-mx53-b3/worktrees/mx53-root";
/** 刻意不存在：renderBrief 的 briefRef 读取走「不可读」兜底分支，输出确定性 */
const B3_BRIEF_REF = "/cw-mx53-b3/project/brief.md";
const B3_COMMIT = "c" + "0".repeat(39);
const B3_ACCEPTANCE: AcceptanceItem[] = [
  { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
  { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
];
const B3_SPLIT: SplitEntry[] = [
  { unitId: "mx53-child-a", dependsOn: [], files: ["src/a.ts"] },
  { unitId: "mx53-child-b", dependsOn: ["mx53-child-a"], files: ["src/b.ts"] },
];
const B3_CONTRACTS: Contract[] = [
  {
    id: "C1",
    kind: "api",
    provider: "mx53-root",
    consumer: "mx53-child-a",
    signature: "doWork(input: string): number",
    file: "src/api.ts",
  },
];
const B3_FAIL_COMMENT = "不合格项：A1 命令未产出标记行；恢复动作：命令追加标记行输出后重提";

interface B3Case {
  name: B3CaseName;
  target: BriefTarget;
  build: (ledger: EventLedger) => void;
}

/** 与快照生成时（mx5-3 改动前源码）逐字节同源的 fixture：常量与事件序列不改 */
const B3_CASES: readonly B3Case[] = [
  {
    name: "designer-spec-ready",
    target: { role: "designer", unitId: "mx53-root", dimension: "specReady" },
    build(ledger) {
      ledger.append("UnitCreated", { unitId: "mx53-root", parentId: null, briefRef: B3_BRIEF_REF });
    },
  },
  {
    name: "designer-spec-fix",
    target: { role: "designer", unitId: "mx53-root", dimension: "specFixPending" },
    build(ledger) {
      ledger.append("UnitCreated", { unitId: "mx53-root", parentId: null, briefRef: B3_BRIEF_REF });
      ledger.append("SpecSubmitted", {
        unitId: "mx53-root",
        specHash: "mx53-h1",
        acceptance: B3_ACCEPTANCE,
        contracts: [],
        split: [],
      });
      ledger.append("VerdictSubmitted", {
        unitId: "mx53-root",
        verdictKind: "spec-review",
        verdict: "fail",
        comment: B3_FAIL_COMMENT,
        role: "reviewer",
      });
    },
  },
  {
    name: "designer-missing-children",
    target: { role: "designer", unitId: "mx53-root", dimension: "missingChildren" },
    build(ledger) {
      ledger.append("UnitCreated", { unitId: "mx53-root", parentId: null, briefRef: B3_BRIEF_REF });
      ledger.append("SpecSubmitted", {
        unitId: "mx53-root",
        specHash: "mx53-h1",
        acceptance: B3_ACCEPTANCE,
        contracts: [],
        split: B3_SPLIT,
      });
      ledger.append("VerdictSubmitted", {
        unitId: "mx53-root",
        verdictKind: "spec-review",
        verdict: "pass",
        role: "reviewer",
      });
      ledger.append("UnitCreated", {
        unitId: "mx53-child-a",
        parentId: "mx53-root",
        briefRef: B3_BRIEF_REF,
      });
    },
  },
  {
    name: "designer-integration-drift",
    target: { role: "designer", unitId: "mx53-root", dimension: "integrationDrift" },
    build(ledger) {
      ledger.append("UnitCreated", { unitId: "mx53-root", parentId: null, briefRef: B3_BRIEF_REF });
      ledger.append("SpecSubmitted", {
        unitId: "mx53-root",
        specHash: "mx53-h1",
        acceptance: B3_ACCEPTANCE,
        contracts: B3_CONTRACTS,
        split: [B3_SPLIT[0]!],
      });
      ledger.append("VerdictSubmitted", {
        unitId: "mx53-root",
        verdictKind: "spec-review",
        verdict: "pass",
        role: "reviewer",
      });
      ledger.append("VerifyRan", {
        unitId: "mx53-root",
        runId: "integrate-run-1",
        reportHash: "irh-1",
        result: "fail",
        acceptanceIds: [],
      });
    },
  },
  {
    name: "builder-build-ready",
    target: { role: "builder", unitId: "mx53-leaf", dimension: "buildReady" },
    build(ledger) {
      ledger.append("UnitCreated", { unitId: "mx53-root", parentId: null, briefRef: B3_BRIEF_REF });
      ledger.append("UnitCreated", {
        unitId: "mx53-leaf",
        parentId: "mx53-root",
        briefRef: B3_BRIEF_REF,
      });
      ledger.append("SpecSubmitted", {
        unitId: "mx53-leaf",
        specHash: "mx53-h1",
        acceptance: B3_ACCEPTANCE,
        contracts: [],
        split: [],
      });
      ledger.append("VerdictSubmitted", {
        unitId: "mx53-leaf",
        verdictKind: "spec-review",
        verdict: "pass",
        role: "reviewer",
      });
    },
  },
  {
    name: "reviewer-exec-review",
    target: { role: "reviewer", unitId: "mx53-leaf", dimension: "execReviewReady" },
    build(ledger) {
      ledger.append("UnitCreated", { unitId: "mx53-root", parentId: null, briefRef: B3_BRIEF_REF });
      ledger.append("UnitCreated", {
        unitId: "mx53-leaf",
        parentId: "mx53-root",
        briefRef: B3_BRIEF_REF,
      });
      ledger.append("SpecSubmitted", {
        unitId: "mx53-leaf",
        specHash: "mx53-h1",
        acceptance: B3_ACCEPTANCE,
        contracts: [],
        split: [],
      });
      ledger.append("VerdictSubmitted", {
        unitId: "mx53-leaf",
        verdictKind: "spec-review",
        verdict: "pass",
        role: "reviewer",
      });
      ledger.append("EvidenceSubmitted", {
        unitId: "mx53-leaf",
        runId: "run-b1",
        commit: B3_COMMIT,
        paths: [],
        sha256: [],
        exitCode: 0,
      });
      ledger.append("VerifyRan", {
        unitId: "mx53-leaf",
        runId: "run-b1",
        reportHash: "rh-1",
        result: "pass",
        acceptanceIds: ["A1", "A2"],
      });
    },
  },
];

/**
 * 改动前（mx5-3 之前）源码的渲染快照——生成方式：对 pre-change dist 以与
 * B3_CASES 逐字节同源的 fixture 真实渲染 writeBriefFile 后捕获。任何 designer
 * / build / exec-review 模板或共享 scaffold 的字节级改动都会在此翻红。
 */
const B3_SNAPSHOTS: Record<B3CaseName, string> = {
  "designer-spec-ready": `# designer 任务书：unit "mx53-root"

## Unit 上下文
- unitId: mx53-root
- parentId: （根节点）
- 当前状态: created
- 原始任务书: /cw-mx53-b3/project/brief.md

### 原始任务书内容
(原始任务书文件不可读：/cw-mx53-b3/project/brief.md)

## 你的任务（designer）
0. 本 unit 是根节点且尚无子 unit——若任务书/brief 含拆分建议：先为每个子执行
   cw create --id <slug> --brief <子brief文件> --parent mx53-root（子 brief 可为占位文件），
   再进入第 1 步（spec.split 声明的子必须已创建，否则提交会被拒）。
1. 撰写该 unit 的 spec.json。验收五规则（src/gates/spec-rules.ts）：验收非空；
   核心 case 的 type 须为 e2e-real / e2e-mock 且带可执行 command；含 mock 须附
   mock 保真度说明；至少一条 unit 级用例。
2. 提交 spec：cw evidence submit --kind spec --unit mx53-root --file spec.json
完成标志：spec 已提交入账（spec-review 由独立 reviewer 在下一轮接手，无需自审）。

## 环境约定
- workdir: /cw-mx53-b3/worktrees/mx53-root（unit 专属 git worktree，分支 cw-root/mx53-root）
- 账本命令：直接在 workdir 下执行 cw …（CW_PROJECT_DIR 已注入 env，自动锚定项目账本 /cw-mx53-b3/project）
`,
  "designer-spec-fix": `# designer 任务书：unit "mx53-root"

## Unit 上下文
- unitId: mx53-root
- parentId: （根节点）
- 当前状态: created
- 原始任务书: /cw-mx53-b3/project/brief.md

### 原始任务书内容
(原始任务书文件不可读：/cw-mx53-b3/project/brief.md)

## 你的任务（designer：按 spec-review 打回意见修 spec）

unit "mx53-root" 的 spec 被独立 reviewer 判 fail——请按以下失败事实修正 spec 后重提：

### reviewer 打回意见（fail verdict comment 全文）
不合格项：A1 命令未产出标记行；恢复动作：命令追加标记行输出后重提

### 修 spec 指令
1. 按上述意见修正 spec.json（验收五规则见 src/gates/spec-rules.ts）。
2. 重提：cw evidence submit --kind spec --unit mx53-root --file spec.json
3. 重提后 unit 自动回流 spec-review 待审队列——由独立 reviewer 再审，你无需（也不得）
   自行提交 review 结论；reviewer 再 fail 将累计打回计数（同一 unit 累计 2 次 fail 转人工）。
完成标志：修正后的 spec 已提交入账（审查结论由 reviewer 给出）。

## 环境约定
- workdir: /cw-mx53-b3/worktrees/mx53-root（unit 专属 git worktree，分支 cw-root/mx53-root）
- 账本命令：直接在 workdir 下执行 cw …（CW_PROJECT_DIR 已注入 env，自动锚定项目账本 /cw-mx53-b3/project）
`,
  "designer-missing-children": `# designer 任务书：unit "mx53-root"

## Unit 上下文
- unitId: mx53-root
- parentId: （根节点）
- 当前状态: spec-frozen
- 原始任务书: /cw-mx53-b3/project/brief.md

### 原始任务书内容
(原始任务书文件不可读：/cw-mx53-b3/project/brief.md)

## 你的任务（designer：补建 split 子 unit）

unit "mx53-root" 的冻结 spec 声明了 2 个子 unit 但 1 个未创建
（子不齐则集成永不发生，分解树无法建立）——请先创建缺失子：
  cw create --id mx53-child-b --brief <文件> --parent mx53-root

子 brief 可为占位文件；建完即完成本任务书，无需改动本 unit 的冻结 spec。
完成标志：cw status 中上述子 unit 均为 created。

## 环境约定
- workdir: /cw-mx53-b3/worktrees/mx53-root（unit 专属 git worktree，分支 cw-root/mx53-root）
- 账本命令：直接在 workdir 下执行 cw …（CW_PROJECT_DIR 已注入 env，自动锚定项目账本 /cw-mx53-b3/project）
`,
  "designer-integration-drift": `# designer 任务书：unit "mx53-root"

## Unit 上下文
- unitId: mx53-root
- parentId: （根节点）
- 当前状态: spec-frozen
- 原始任务书: /cw-mx53-b3/project/brief.md

### 原始任务书内容
(原始任务书文件不可读：/cw-mx53-b3/project/brief.md)

## 你的任务（designer：集成契约漂移处置）

unit "mx53-root" 的集成已连续 fail 1 次（重派上限），
runner 已停止自动重派集成——契约漂移/merge 冲突的处置需要语义判断，由你按下述指引处置。

### 集成失败事实（最近一次集成报告）
- 最近一次集成报告不可读——失败明细见 cw report --unit mx53-root；当前冻结 spec 的契约全集：
  - C1: signature "doWork(input: string): number" 期望文件 src/api.ts

### 处置指引（二选一）
集成失败恢复路径（二选一）：
① 实现与契约语义等价但文本不等（如 async 修饰差异）→ 修正 spec 的契约签名后重新提交：
   cw evidence submit --kind spec --unit mx53-root --file spec.json
   （mx-1：spec 提交后由 loop 自动派发独立 reviewer 执行 spec-review——你无需
   也不得自行提交 review 结论；reviewer 过审后集成按正常路径重跑，fail 计数随
   新 spec 提交清零——rv-4 起集成首次 fail 即转 designer 处置，处置完成前不再自动重试集成）
② 契约本身正确而实现跑偏 → 需 provider 修复——closed 的 provider 无自动回退通道
   （状态机不重开 closed unit，已知边界），需人工介入，不要试图绕过状态机改实现。

## 环境约定
- workdir: /cw-mx53-b3/worktrees/mx53-root（unit 专属 git worktree，分支 cw-root/mx53-root）
- 账本命令：直接在 workdir 下执行 cw …（CW_PROJECT_DIR 已注入 env，自动锚定项目账本 /cw-mx53-b3/project）
`,
  "builder-build-ready": `# builder 任务书：unit "mx53-leaf"

## Unit 上下文
- unitId: mx53-leaf
- parentId: mx53-root
- 当前状态: spec-frozen
- 原始任务书: /cw-mx53-b3/project/brief.md

### 原始任务书内容
(原始任务书文件不可读：/cw-mx53-b3/project/brief.md)

## 你的任务（builder）
1. 在 workdir 实现该 unit 冻结验收要求的目标并 git commit（取 hash：git rev-parse HEAD）。
2. 提交 build 证据：cw evidence submit --kind build --unit mx53-leaf --commit <hash> --run-id <自拟唯一 runId> [--file <产物路径>...]
3. 触发干净重跑验证：cw verify --unit mx53-leaf（默认含红阶段检查——新测试在旧代码树必须 fail，恒真测试会被拒）。
完成标志：unit 进入 verified。

## 环境约定
- workdir: /cw-mx53-b3/worktrees/mx53-root（unit 专属 git worktree，分支 cw/mx53-root/mx53-leaf）
- 账本命令：直接在 workdir 下执行 cw …（CW_PROJECT_DIR 已注入 env，自动锚定项目账本 /cw-mx53-b3/project）
`,
  "reviewer-exec-review": `# reviewer 任务书：unit "mx53-leaf"

## Unit 上下文
- unitId: mx53-leaf
- parentId: mx53-root
- 当前状态: verified
- 原始任务书: /cw-mx53-b3/project/brief.md

### 原始任务书内容
(原始任务书文件不可读：/cw-mx53-b3/project/brief.md)

## 你的任务（reviewer：exec-review）
对该 unit 提交 exec-review 结论（审查依据：cw report --unit mx53-leaf 的证据链与 verify 结果）：
cw review submit --unit mx53-leaf --verdict-kind exec-review --verdict pass|fail --role reviewer --comment <意见> --evidence-refs <已入账 runId,...>
说明：--evidence-refs 是 exec-review 的必填项（rv-2：结论必须引用至少 1 个已入账的
build / verify runId——可用 runId 见 cw report --unit 的输出）；fail 时 --comment 逐条列出不合格项与恢复动作。
完成标志：verdict 为 pass 时 unit 进入 closed。

## 环境约定
- workdir: /cw-mx53-b3/worktrees/mx53-root（unit 专属 git worktree，分支 cw/mx53-root/mx53-leaf）
- 账本命令：直接在 workdir 下执行 cw …（CW_PROJECT_DIR 已注入 env，自动锚定项目账本 /cw-mx53-b3/project）
`,
};

function renderB3Case(b3Case: B3Case): string {
  const ledger = new EventLedger(ledgerPath(cwHome, `${B3_CWD}/case-${b3Case.name}`));
  b3Case.build(ledger);
  const projection = fold(ledger.readAll());
  const unit = projection.units.get(b3Case.target.unitId);
  if (unit === undefined) {
    throw new Error(`B3 fixture 前置失败：fold 后应存在 unit ${b3Case.target.unitId}`);
  }
  const renderedPath = writeBriefFile(
    join(tmpRoot, `b3-${b3Case.name}-art`),
    b3Case.target,
    unit,
    projection,
    B3_ROOT_ID,
    B3_CWD,
    B3_WORKDIR,
  );
  return readFileSync(renderedPath, "utf-8");
}

describe("mx5-3 B3 其余模板零变更", () => {
  for (const b3Case of B3_CASES) {
    it(`${b3Case.name} 渲染输出与改动前逐字节一致`, () => {
      expect(renderB3Case(b3Case)).toBe(B3_SNAPSHOTS[b3Case.name]);
    });
  }
});
