/**
 * lv-3 R 系：reviewer 任务书「审查上下文」段 + spec-review 代数中间档出声
 * （docs/rewrite/acceptance/lv-3-acceptance.md §5 R1-R7；设计《自治运行活性与
 * 契约防护》§3.3 D5 / §4 S4）。零 mock：R1-R3 / R6 / R7 = 真实账本（隔离
 * CW_HOME 的 tmp 目录）直写打回代 + writeBriefFile 直渲染（mx5-2 F 系同款）；
 * R4 / R5 = runLoop 进程内直调（u7b stepped adapter 同款——spawn 时同步副作用
 * 写账本 + wait() 按脚本返回；真实 git repo + 真实账本）。
 *
 * 注意：R4 / R5 从 dist 导入 runLoop（loop 系测试约定）——直接
 * `npx vitest run tests/lv3-review-context.test.ts` 不触发 pretest，需先
 * `npm run build`（`npm test` 的 pretest 已含）。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

// loop 系测试约定：runLoop 从 dist 导入（pretest build；直跑需先 npm run build）
import { runLoop } from "../dist/runner/loop.js";
import type {
  AgentSpawnAdapter,
  AgentSpawnRequest,
  SpawnHandle,
  SpawnResult,
} from "../dist/runner/spawn/types.js";
import { fold } from "../src/core/fold.js";
import type { AcceptanceItem } from "../src/events/types.js";
import { specReviewFailComments } from "../src/readonly/frontier.js";
import type { BriefTarget } from "../src/runner/brief.js";
import { writeBriefFile } from "../src/runner/brief.js";
import { EventLedger } from "../src/store/events-log.js";
import { ledgerPath } from "../src/store/project.js";

const LOOP_DIST = fileURLToPath(new URL("../dist/runner/loop.js", import.meta.url));
const SPAWN_TYPES_DIST = fileURLToPath(new URL("../dist/runner/spawn/types.js", import.meta.url));
if (!existsSync(LOOP_DIST) || !existsSync(SPAWN_TYPES_DIST)) {
  throw new Error("tests/lv3-review-context 需要 dist/runner/{loop,spawn/types}.js（先 npm run build；npm test 的 pretest 已含）");
}

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-lv3r-"));
const cwHome = join(tmpRoot, "home");
const originalCwHome = process.env.CW_HOME;
// loop 系用例的 worktree 根隔离（mx5-2 同款）
const WT_HOME = join(tmpRoot, "cw-worktrees");
process.env.CW_WORKTREE_HOME = WT_HOME;

afterAll(() => {
  if (originalCwHome === undefined) {
    delete process.env.CW_HOME;
  } else {
    process.env.CW_HOME = originalCwHome;
  }
  delete process.env.CW_WORKTREE_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

let caseNo = 0;
let cwd: string;
let ledger: EventLedger;

beforeEach(() => {
  process.env.CW_HOME = cwHome;
  caseNo += 1;
  cwd = join(tmpRoot, `case-${caseNo}`);
  ledger = new EventLedger(ledgerPath(cwHome, cwd));
});

// ---- 账本构造（直写——渲染层只消费事件字段，与 mx5-2 F 系同款） ----

/** 过 gate 形态的验收集（command 首 token 在 PATH；命令文本不真实执行） */
function contractAcceptance(): AcceptanceItem[] {
  return [
    { id: "E1", core: true, title: "应用可运行", type: "e2e-real", command: "node e1.js" },
    { id: "U1", core: false, title: "单元冒烟", type: "unit", command: "node u1check.js" },
  ];
}

function appendUnit(unitId: string): void {
  ledger.append("UnitCreated", { unitId, parentId: null, briefRef: "brief.md" });
}

/** 一代打回 = 新 SpecSubmitted + 该 spec 后首条 role=reviewer fail verdict */
function appendRejectedSpec(unitId: string, specNo: number, comment: string): void {
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: `${unitId}-spec-${specNo}`,
    acceptance: contractAcceptance(),
    contracts: [],
    split: [],
  });
  ledger.append("VerdictSubmitted", {
    unitId,
    verdictKind: "spec-review",
    verdict: "fail",
    comment,
    role: "reviewer",
  });
}

/** 待审 spec（specReviewPending 真实态：最后 spec 后无任何 spec-review verdict） */
function appendPendingSpec(unitId: string, specNo: number): void {
  ledger.append("SpecSubmitted", {
    unitId,
    specHash: `${unitId}-spec-${specNo}`,
    acceptance: contractAcceptance(),
    contracts: [],
    split: [],
  });
}

/**
 * 直渲染任务书（R1-R3 / R6 / R7）：真实账本 fold 投影 + writeBriefFile 实参。
 * reviewer 形态的 failHistory 从原始事件流重建（接口锚定：loop 侧算好传入，
 * 渲染层纯函数——与 loop.ts 单调用点同一取数口径）。
 */
function renderBriefOf(target: BriefTarget, specReviewFailHistory?: readonly string[]): string {
  const events = ledger.readAll();
  const projection = fold(events);
  const unit = projection.units.get(target.unitId);
  if (unit === undefined) {
    throw new Error("fixture 断言前置失败：fold 后应存在目标 unit");
  }
  const path = writeBriefFile(
    join(tmpRoot, `art-r-${caseNo}`),
    target,
    unit,
    projection,
    target.unitId,
    cwd,
    join(tmpRoot, "wt-r"),
    specReviewFailHistory,
  );
  return readFileSync(path, "utf-8");
}

/** reviewer 任务书（specReviewPending 形态）——历史实参按生产口径取数 */
function renderReviewerBrief(): string {
  return renderBriefOf(
    { role: "reviewer", unitId: "u-1", dimension: "specReviewPending" },
    specReviewFailComments(ledger.readAll(), "u-1"),
  );
}

// ================================================================
// R1 / R2：审查上下文段（第 4 代 / 截断）
// ================================================================

describe("R1 打回 3 代后的第 4 代 reviewer 任务书含审查上下文段", () => {
  it("含「审查上下文（第 4 代）」+ 最近 3 代意见全文 + 不重打回指引句（未超 3 代无「共 N 代」头行）", () => {
    appendUnit("u-1");
    appendRejectedSpec("u-1", 1, "第 1 代意见：验收覆盖缺生命周期分支");
    appendRejectedSpec("u-1", 2, "第 2 代意见：A3 命令形态与适配器契约不符");
    appendRejectedSpec("u-1", 3, "第 3 代意见：断言指向实现细节而非行为");
    appendPendingSpec("u-1", 4); // 第 4 代被审的 spec（待审态）

    const content = renderReviewerBrief();
    expect(content).toContain("## 审查上下文（第 4 代）");
    expect(content).toContain("本 spec 已被打回 3 代。历代意见摘要（全文见账本 verdict）：");
    expect(content).toContain("- 第 1 代：第 1 代意见：验收覆盖缺生命周期分支");
    expect(content).toContain("- 第 2 代：第 2 代意见：A3 命令形态与适配器契约不符");
    expect(content).toContain("- 第 3 代：第 3 代意见：断言指向实现细节而非行为");
    expect(content).toContain("审查指引：前代意见已修复的不重复打回（除非修复引入回归）；聚焦本轮增量。");
    // 未超 3 代：无截断头行
    expect(content).not.toContain("共 3 代");
  });
});

describe("R2 截断：打回 5 代 → 第 6 代任务书只列最近 3 代", () => {
  it("含「共 5 代，以下为最近 3 代」头行 + 第 3/4/5 代全文；第 1/2 代意见不在场", () => {
    appendUnit("u-1");
    for (let g = 1; g <= 5; g += 1) {
      appendRejectedSpec("u-1", g, `第 ${g} 代独有意见全文 ${"内".repeat(g)}`);
    }
    appendPendingSpec("u-1", 6);

    const content = renderReviewerBrief();
    expect(content).toContain("## 审查上下文（第 6 代）");
    expect(content).toContain("共 5 代，以下为最近 3 代：");
    expect(content).toContain("- 第 3 代：第 3 代独有意见全文 内内内");
    expect(content).toContain("- 第 4 代：第 4 代独有意见全文 内内内内");
    expect(content).toContain("- 第 5 代：第 5 代独有意见全文 内内内内内");
    // 只列 3 代：被截掉的第 1/2 代意见全文不在场
    expect(content).not.toContain("第 1 代独有意见全文");
    expect(content).not.toContain("第 2 代独有意见全文");
    expect(content).not.toContain("- 第 1 代：");
    expect(content).not.toContain("- 第 2 代：");
  });
});

describe("R3 回归：第 2 代 designer 修 spec 任务书含最新意见全文（既有行为不变）", () => {
  it("specFixPending 形态任务书内嵌最新一代 fail comment 全文（mx-1 MF1 既有形态）", () => {
    appendUnit("u-1");
    appendRejectedSpec("u-1", 1, "首代意见：验收真空");
    appendRejectedSpec("u-1", 2, "最新代意见全文：A3 需补反例追问");

    const content = renderBriefOf({ role: "designer", unitId: "u-1", dimension: "specFixPending" });
    expect(content).toContain("### reviewer 打回意见（fail verdict comment 全文）");
    expect(content).toContain("最新代意见全文：A3 需补反例追问");
    expect(content).toContain("按 spec-review 打回意见修 spec");
  });
});

// ================================================================
// R6 / R7：第五维兜底句 + 0 代首审（同用无打回历史 fixture）
// ================================================================

describe("R6 第五维点名路径逃逸兜底", () => {
  it("reviewer 任务书第五维文案含「不得引用检出树外路径」兜底句（规则⑫提及）", () => {
    appendUnit("u-1");
    appendPendingSpec("u-1", 1);

    const content = renderReviewerBrief();
    expect(content).toContain("⑤ 干净 checkout 可执行性");
    expect(content).toContain("命令不得引用检出树外的绝对路径/工作区路径（绝对 cd、~ 起始路径、.cw-worktrees");
    expect(content).toContain("规则⑫");
  });
});

describe("R7 0 代首审零噪音", () => {
  it("无打回历史的 reviewer 任务书不含「审查上下文」段", () => {
    appendUnit("u-1");
    appendPendingSpec("u-1", 1);

    const content = renderReviewerBrief();
    expect(content).toContain("## 你的任务（reviewer：spec-review）");
    expect(content).not.toContain("审查上下文");
    expect(content).not.toContain("本 spec 已被打回");
  });
});

// ================================================================
// R4 / R5：runLoop 进程内直调（u7b stepped adapter 同款）
// ================================================================

function gitRun(repoDir: string, args: readonly string[]): string {
  const res = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", timeout: 30_000 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

/** 真实 tmp git 仓库（单 commit——loop 的 HEAD 快照与 worktree 基底） */
function makeRepo(name: string): string {
  const base = join(tmpRoot, name);
  mkdirSync(base, { recursive: true });
  const repoDir = realpathSync(base);
  gitRun(repoDir, ["init"]);
  gitRun(repoDir, ["config", "user.email", "cw-lv3r@example.com"]);
  gitRun(repoDir, ["config", "user.name", "cw-lv3r"]);
  writeFileSync(join(repoDir, "brief.md"), "# lv-3 R 系 loop fixture 任务书\n");
  gitRun(repoDir, ["add", "-A"]);
  gitRun(repoDir, ["commit", "-m", "fixture: brief"]);
  return repoDir;
}

/** 捕获 runLoop 的 stdout/stderr（进程内直调；透传 write 回调防 flush 屏障拖慢） */
async function captureStd(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const collector = (chunks: string[]): typeof process.stdout.write =>
    ((chunk: unknown, cb?: (err?: Error | null) => void) => {
      chunks.push(String(chunk));
      if (typeof cb === "function") {
        cb();
      }
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = collector(outChunks);
  process.stderr.write = collector(errChunks);
  try {
    const code = await fn();
    return { code, out: outChunks.join(""), err: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function handleOf(req: AgentSpawnRequest, exitCode: SpawnResult["exitCode"]): SpawnHandle {
  return {
    wait: async () => ({
      exitCode,
      stdoutPath: join(req.artifactDir, `${req.unitId}.${req.role}.stdout`),
      stderrPath: join(req.artifactDir, `${req.unitId}.${req.role}.stderr`),
      pid: -1,
    }),
    kill: () => {},
  };
}

describe("R4 中间档逐代出声（真实 loop）", () => {
  it("第 3/4/5 代各出声一次（同代数不重复、新代数重出）；文本含代数与预算值与 --spawn human 介入命令", async () => {
    const repoDir = makeRepo("r4-progress");
    const ledgerR4 = new EventLedger(ledgerPath(cwHome, repoDir));
    ledgerR4.append("UnitCreated", { unitId: "rprog", parentId: null, briefRef: "brief.md" });
    // 初始 3 代打回（loop 轮 1 即满足中间档阈值 ≥3）
    for (let g = 1; g <= 3; g += 1) {
      ledgerR4.append("SpecSubmitted", {
        unitId: "rprog",
        specHash: `s${g}`,
        acceptance: contractAcceptance(),
        contracts: [],
        split: [],
      });
      ledgerR4.append("VerdictSubmitted", {
        unitId: "rprog",
        verdictKind: "spec-review",
        verdict: "fail",
        comment: `第 ${g} 代打回意见`,
        role: "reviewer",
      });
    }
    // stepped adapter：designer spawn 时同步推进代数（3→4→5），第 3 次派发让
    // 第 6 代 spec 过审 → unit 离开 created 态，后续无新事件由 idle 收束退出
    let spawnCount = 0;
    const calls: AgentSpawnRequest[] = [];
    const adapter: AgentSpawnAdapter = {
      name: "lv3-progress",
      spawn: async (req) => {
        calls.push(req);
        spawnCount += 1;
        if (spawnCount === 1 || spawnCount === 2) {
          const g = spawnCount + 3;
          ledgerR4.append("SpecSubmitted", {
            unitId: "rprog",
            specHash: `s${g}`,
            acceptance: contractAcceptance(),
            contracts: [],
            split: [],
          });
          ledgerR4.append("VerdictSubmitted", {
            unitId: "rprog",
            verdictKind: "spec-review",
            verdict: "fail",
            comment: `第 ${g} 代打回意见`,
            role: "reviewer",
          });
        } else if (spawnCount === 3) {
          ledgerR4.append("SpecSubmitted", {
            unitId: "rprog",
            specHash: "s6",
            acceptance: contractAcceptance(),
            contracts: [],
            split: [],
          });
          ledgerR4.append("VerdictSubmitted", { unitId: "rprog", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
        }
        return handleOf(req, 0);
      },
    };

    const result = await captureStd(() =>
      runLoop({ rootId: "rprog", adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 2_000 }),
    );
    // 第 3/4/5 代逐代出声（代数进文本必然逐代不同；fail 历史 ≥3 起）
    // unit 名级全串（提示锚定具体 unit，escalations 文案锁定）
    expect(result.err).toContain('unit "rprog" 的 spec-review 已打回 3 代（预算 10）');
    expect(result.err).toContain("已打回 3 代（预算 10）");
    expect(result.err).toContain("已打回 4 代（预算 10）");
    expect(result.err).toContain("已打回 5 代（预算 10）");
    expect(result.err).toContain("cw run --root rprog --spawn human");
    // 同代数不重复：每条恰一次（新代数重出是设计行为，同代数重出是噪音）
    expect(result.err.split("已打回 3 代（预算 10）").length - 1).toBe(1);
    expect(result.err.split("已打回 4 代（预算 10）").length - 1).toBe(1);
    expect(result.err.split("已打回 5 代（预算 10）").length - 1).toBe(1);
    // 中间档不改变行为：specFixPending 照常派 designer（3 次）+ 过审后 developer 推进
    expect(calls.filter((c) => c.role === "designer").length).toBe(3);
    expect(calls.some((c) => c.role === "developer")).toBe(true);
  }, 30_000);
});

describe("R4b 阈值下界静默（真实 loop）", () => {
  it("第 1/2 代打回时点零提示（D5「≥3 起逐代出声」的下界蕴含）；同 loop 推进至 3 代起出声（对照锚，排除捕获假阴性）", async () => {
    const repoDir = makeRepo("r4b-silent");
    const ledgerR4b = new EventLedger(ledgerPath(cwHome, repoDir));
    ledgerR4b.append("UnitCreated", { unitId: "rsilent", parentId: null, briefRef: "brief.md" });
    // 初始仅 1 代打回（loop 轮 1 的时点——低于阈值 3，应零提示）
    ledgerR4b.append("SpecSubmitted", {
      unitId: "rsilent",
      specHash: "s1",
      acceptance: contractAcceptance(),
      contracts: [],
      split: [],
    });
    ledgerR4b.append("VerdictSubmitted", {
      unitId: "rsilent",
      verdictKind: "spec-review",
      verdict: "fail",
      comment: "第 1 代打回意见",
      role: "reviewer",
    });
    // stepped adapter：designer spawn 时同步推进代数 1→2→3（R4 同款形态），
    // 第 3 次派发让 spec 过审 → unit 离开 created 态，后续无新事件由 idle 收束退出
    let spawnCount = 0;
    const adapter: AgentSpawnAdapter = {
      name: "lv3-silent",
      spawn: async (req) => {
        spawnCount += 1;
        if (spawnCount === 1 || spawnCount === 2) {
          const g = spawnCount + 1;
          ledgerR4b.append("SpecSubmitted", {
            unitId: "rsilent",
            specHash: `s${g}`,
            acceptance: contractAcceptance(),
            contracts: [],
            split: [],
          });
          ledgerR4b.append("VerdictSubmitted", {
            unitId: "rsilent",
            verdictKind: "spec-review",
            verdict: "fail",
            comment: `第 ${g} 代打回意见`,
            role: "reviewer",
          });
        } else if (spawnCount === 3) {
          ledgerR4b.append("SpecSubmitted", {
            unitId: "rsilent",
            specHash: "s4",
            acceptance: contractAcceptance(),
            contracts: [],
            split: [],
          });
          ledgerR4b.append("VerdictSubmitted", { unitId: "rsilent", verdictKind: "spec-review", verdict: "pass", role: "reviewer" });
        }
        return handleOf(req, 0);
      },
    };

    const result = await captureStd(() =>
      runLoop({ rootId: "rsilent", adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 2_000 }),
    );
    // 1/2 代时点零提示（阈值下界：低于 3 代不进中间档、也不达停派预算）
    expect(result.err).not.toContain("已打回 1 代（预算 10）");
    expect(result.err).not.toContain("已打回 2 代（预算 10）");
    // 对照锚：同一 loop 内推进到 3 代起出声——静默是阈值语义而非捕获假阴性
    expect(result.err).toContain("已打回 3 代（预算 10）");
    // 静默不改变派发行为：1/2 代时点 specFixPending 照常派 designer（≥3 次）
    expect(spawnCount).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

describe("R5 达预算停派回归（10 代与既有 specReviewDeadlock 完全一致）", () => {  it("10 代打回 → 零派发 + 完整转人工文案；中间档不再出（区间上界互斥）", async () => {
    const repoDir = makeRepo("r5-deadlock");
    const ledgerR5 = new EventLedger(ledgerPath(cwHome, repoDir));
    ledgerR5.append("UnitCreated", { unitId: "rlock", parentId: null, briefRef: "brief.md" });
    for (let g = 1; g <= 10; g += 1) {
      ledgerR5.append("SpecSubmitted", {
        unitId: "rlock",
        specHash: `s${g}`,
        acceptance: contractAcceptance(),
        contracts: [],
        split: [],
      });
      ledgerR5.append("VerdictSubmitted", {
        unitId: "rlock",
        verdictKind: "spec-review",
        verdict: "fail",
        comment: `第 ${g} 代打回意见`,
        role: "reviewer",
      });
    }
    const calls: AgentSpawnRequest[] = [];
    const adapter: AgentSpawnAdapter = {
      name: "lv3-deadlock",
      spawn: async (req) => {
        calls.push(req); // 若误派发会被记录（断言零派发）
        return handleOf(req, 0);
      },
    };

    const result = await captureStd(() =>
      runLoop({ rootId: "rlock", adapter, cwd: repoDir, pollMs: 30, maxIdleMs: 1_500 }),
    );
    // 停派行为与既有 specReviewDeadlock 完全一致：零派发
    expect(calls.length).toBe(0);
    // 完整转人工文案（既有 deadlock 出口：代数 + 预算 + 各代意见 + 处置动作）
    expect(result.err).toContain("spec-review 已打回 10 代（已达打回代数预算 10 代");
    expect(result.err).toContain("停止对该 unit 派发");
    expect(result.err).toContain("转人工处置");
    expect(result.err).toContain("第 10 代打回的意见");
    // 中间档不再出（区间互斥：达预算后走 deadlock 文案，无「可提前介入」提示）
    expect(result.err).not.toContain("可提前人工介入");
    expect(result.err).not.toContain("已打回 10 代（预算 10）");
  }, 30_000);
});
