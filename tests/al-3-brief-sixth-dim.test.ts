/**
 * al-3 B 系：brief 模板防线层——reviewer 清单第六维（验收成本与层级归属）+
 * designer 防下放指引 + 「验收五规则」drift 对齐。条款逐条对应
 * docs/rewrite/acceptance/al-3-acceptance.md §5 B1-B5。
 *
 * 零 mock：真实 EventLedger（隔离 CW_HOME 下的 tmp 账本）+ fold 投影 +
 * writeBriefFile 真实渲染（mx5-3 brief 测试同款形态，直击模板层）。
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { fold } from "../src/core/fold.js";
import type { BriefTarget } from "../src/runner/brief.js";
import { writeBriefFile } from "../src/runner/brief.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-al3-brief-"));
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

/**
 * tmp 目录构造 unit（真实账本 append + 真实 fold——无任何 mock）并渲染指定
 * 维度的任务书。specReviewPending 形态 = created 且有 spec、无 spec-review
 * verdict（mx-1 起审查由独立 reviewer spawn 接手）；specReady 形态 = 无 spec
 * 的首派（root 无子时含 fx-3 R5.2 第 0 步建子指令）。
 */
function renderBrief(
  caseName: string,
  unitId: string,
  target: BriefTarget,
  withSpec: boolean,
): string {
  const repoDir = realpathSync(mkdtempSync(join(tmpRoot, `case-${caseName}`)));
  const briefPath = join(repoDir, "brief.md");
  writeFileSync(briefPath, `# ${caseName} 任务书（al-3 fixture）\n`);
  const ledger = new EventLedger(ledgerPath(cwHome, repoDir));
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: briefPath });
  if (withSpec) {
    ledger.append("SpecSubmitted", {
      unitId,
      specHash: `al3-${caseName}`,
      acceptance: [
        { id: "A1", core: true, title: "应用可运行", type: "e2e-real", command: "node app.js" },
        { id: "A2", core: false, title: "单元级冒烟", type: "unit" },
      ],
      contracts: [],
      split: [],
    });
  }
  const projection = fold(ledger.readAll());
  const unit = projection.units.get(unitId);
  if (unit === undefined) {
    throw new Error(`fixture 前置失败：fold 后应存在 unit ${unitId}`);
  }
  const renderedPath = writeBriefFile(
    join(tmpRoot, `case-${caseName}-art`),
    target,
    unit,
    projection,
    unitId,
    repoDir,
    join(repoDir, `wt-${unitId}`),
  );
  return readFileSync(renderedPath, "utf-8");
}

/** reviewer spec-review 任务书（第六维的被测载体） */
function renderSpecReviewBrief(caseName: string): string {
  return renderBrief(
    caseName,
    "demo",
    { role: "reviewer", unitId: "demo", dimension: "specReviewPending" },
    true,
  );
}

// ================================================================
// B1：reviewer 第六维在场（全文要素：裸命令 / 封装形态追进内容 / must-fix
// 上收 / wrapper 自限建议——al-3 基线 §4.D）
// ================================================================

describe("B1 reviewer 第六维在场", () => {
  it("渲染输出含「验收成本与层级归属」维全文要素：裸命令、封装形态（wrapper 追进内容）、must-fix 上收指引、wrapper 自限建议", () => {
    const content = renderSpecReviewBrief("b1");

    // 维度标题
    expect(content).toContain("⑥ 验收成本与层级归属");
    // 裸命令形态（无文件参数的全量 vitest / 全仓 lint、test script）
    expect(content).toContain("全量回归形态是否出现在叶子 spec 的 unit 层");
    expect(content).toContain("无文件参数的全量 vitest");
    expect(content).toContain("全仓 lint、test script");
    // 封装形态追进内容（gate 规则⑪词法不可见，这里是唯一语义防线）
    expect(content).toContain("封装形态");
    expect(content).toContain("wrapper 脚本或 script 别名");
    expect(content).toContain("须追进脚本/别名内容看实际跑什么");
    expect(content).toContain("唯一语义防线");
    // 双付事实与 must-fix 上收指引
    expect(content).toContain("每轮 fix 全价双付");
    expect(content).toContain("must-fix");
    expect(content).toContain("上收 root spec");
    expect(content).toContain('并标 layer: "topic"');
    expect(content).toContain("加文件参数收窄");
    // wrapper 自限建议
    expect(content).toContain("wrapper 自限建议");
    expect(content).toContain("vitest --max-workers");
    expect(content).toContain("自限并发");
  });
});

// ================================================================
// B2：六维度计数一致（不再写「五维度」）
// ================================================================

describe("B2 六维度计数一致", () => {
  it("输出含「按六维度对抗式核对清单」且不含「五维度」；①-⑥ 六个维度标记全部在场", () => {
    const content = renderSpecReviewBrief("b2");

    expect(content).toContain("按六维度对抗式核对清单");
    expect(content).not.toContain("五维度");
    // 计数与实际维度条数一致：①-⑥ 逐个在场
    for (const marker of ["① ", "② ", "③ ", "④ ", "⑤ ", "⑥ "]) {
      expect(content).toContain(marker);
    }
  });
});

// ================================================================
// B3：designer 防下放指引（designerFirstTasks 第 1 步追加）
// ================================================================

describe("B3 designer 防下放指引", () => {
  it("specReady 首派任务书含「归 root spec 声明并标 layer」与「不得复制回归条目」要素", () => {
    // root 无子形态：同时覆盖 fx-3 R5.2 第 0 步（B5 的零变更锚之一）
    const content = renderBrief(
      "b3",
      "demo",
      { role: "designer", unitId: "demo", dimension: "specReady" },
      false,
    );

    expect(content).toContain("归 root spec 声明并标");
    expect(content).toContain('layer: "topic"');
    expect(content).toContain("由集成阶段统一执行，只在集成跑一次");
    expect(content).toContain("不得复制回归条目");
    expect(content).toContain("叶子重复声明 = 每轮 fix 全价双付");
    // 第 0 步建子指令在场（root 无子首派形态，fx-3 R5.2 既有行为）
    expect(content).toContain("0. 本 unit 是根节点且尚无子 unit——若任务书/brief 含拆分建议：先为每个子执行");
  });

  it("topic 条目指引附标记行契约与规则⑤不豁免（设计 D1a 使用点 / D4 已知边界二）", () => {
    // designer 照「上收 root 标 topic」指引会写裸 `pnpm vitest run`——标记行契约
    // 缺失时集成期才暴露（晚一层）；规则⑤不豁免缺失时 designer 踩连环拒。
    // 两点均要素级断言，不锁全文
    const content = renderBrief(
      "b3b",
      "demo",
      { role: "designer", unitId: "demo", dimension: "specReady" },
      false,
    );

    // 标记行契约（e2e-sh 适配器靠标记行判定，裸命令永不产出 → 恒 fail）
    expect(content).toContain("标记行");
    expect(content).toContain("PASS");
    expect(content).toContain("FAIL");
    expect(content).toContain("wrapper 脚本尾部输出");
    expect(content).toContain("永不产出标记行");
    // 规则⑤不豁免 topic 条目（上收后 root spec 仍须至少一条 unit 级用例）
    expect(content).toContain("不豁免");
    expect(content).toContain('type: "unit"');
  });
});

// ================================================================
// B4：「验收五规则」drift 对齐（brief.ts 全文零命中，改不写死数字形态）
// ================================================================

describe("B4 drift 对齐", () => {
  it("brief.ts 源码全文 grep「验收五规则」零命中；三处均已改为不写死数字的「验收规则（src/gates/spec-rules.ts）」形态", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/runner/brief.ts", import.meta.url)),
      "utf-8",
    );

    // 三处 drift 全部更新（specFixPending 兜底 comment / 修 spec 指令 / designerFirstTasks 第 1 步）
    expect(source).not.toContain("验收五规则");
    expect(source).toContain("验收规则（src/gates/spec-rules.ts）");
    expect(source).toContain("验收规则见 src/gates/spec-rules.ts");
    expect(source).toContain("验收规则，src/gates/spec-rules.ts");
    // 渲染产物同步无数字形态（designer 首派任务书）
    const content = renderBrief(
      "b4",
      "demo",
      { role: "designer", unitId: "demo", dimension: "specReady" },
      false,
    );
    expect(content).toContain("验收规则（src/gates/spec-rules.ts）");
    expect(content).not.toContain("验收五规则");
  });
});

// ================================================================
// B5：既有维度零变更（①-⑤ 维文案与改造前一致——关键词组断言；
// mx5-3 锁定的 designer 第 0 步同样零变更，B3 已锚）
// ================================================================

describe("B5 既有维度零变更", () => {
  it("①-⑤ 维度文案逐行与改造前一致，且⑥插在⑤与语义关之间（既有段落位置不动）", () => {
    const content = renderSpecReviewBrief("b5");

    // ①-⑤ 维度的既有行原文（mx5-3 改造前逐字节，关键词组断言）
    expect(content).toContain(
      "① 验收命令契约逐条核对（cw verify 按适配器解析命令产物——契约错 = 实现再对也恒 fail）：",
    );
    expect(content).toContain("② 覆盖度：brief 的核心风险面是否逐条映射到验收、有无验收真空；e2e 级用例的");
    expect(content).toContain("③ 区分力反例追问（每条验收问两个反例）：无实现时它必然挂吗？换一个实现它还过吗？");
    expect(content).toContain("④ 契约（contracts）一致性：spec 声明的跨 unit 接口与冻结 hash 逐条对照关联 unit 的");
    expect(content).toContain("⑤ 干净 checkout 可执行性：命令用到的依赖是否全在 package.json 声明、命令是否");
    expect(content).toContain("   自带 install（verify 在一次性工作区重跑，没有提交者本机的全局依赖与环境）。");
    // 既有输出分级约定与 pass 逐项显式句零变更（对⑥自然覆盖）
    expect(content).toContain("must-fix（不修不能过）/ suggestion（应修）/ info（仅记录）");
    expect(content).toContain("核过无问题");
    // 语义关段仍在且位置在维度清单末尾（⑥ 插入不改既有段落顺序）
    expect(content).toContain("语义关（canon D3 既有要求）");
    const idx5 = content.indexOf("⑤ ");
    const idx6 = content.indexOf("⑥ ");
    const idxSemantic = content.indexOf("语义关（canon D3 既有要求）");
    expect(idx5).toBeGreaterThanOrEqual(0);
    expect(idx6).toBeGreaterThan(idx5);
    expect(idxSemantic).toBeGreaterThan(idx6);
  });
});
