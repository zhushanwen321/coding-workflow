/**
 * v1 wave design-review 阶段 gate 纯函数（领域规则，零 IO）。
 *
 * 来源：v5 wave 附录 A §11 line 1227-1239（WAVE_DESIGN_REVIEW_GATES 清单）、
 *      wave §2.7（机器 gate 清单 + 取舍说明）、§3（layerSpecific 非空 gate）。
 *
 * 职责：design-review 阶段对 plan 产物（testCases）+ designReviewJudgment 的机器 gate。
 *      只验结构（非空 / 完整），不验内容质量（内容靠人审）。
 *
 * 不变量：rules 层零 IO。所有 gate 接收已加载的数据（ExecutionUnit / DesignReviewJudgment），
 *      返回统一的 GateResult { passed, report }。
 */
import type { Clarification } from "../../core/clarifications.js";
import type {
  DesignReviewJudgment,
  EpicDesignReviewLayerSpecific,
  FeatureDesignReviewLayerSpecific,
  SliceDesignReviewLayerSpecific,
  WaveDesignReviewLayerSpecific,
} from "../../core/judgments.js";
import type { Split,WaveFile } from "../../core/plan.js";
import type { Epic, ExecutionUnit, Feature, Slice } from "../../core/workunit.js";
import { MAX_EPIC_TO_FEATURE, MAX_FEATURE_TO_SLICE, MAX_SLICE_TO_WAVE } from "./fan-out.js";
import { type GateResult,runGateSafely } from "./types.js";

// 重新导出 GateResult，便于 `import { GateResult } from "./gates/design-review.js"`
export type { GateResult };

// ═══════════════════════════════════════════════════════════════
// 结构完整性 gate（testCases）
// ═══════════════════════════════════════════════════════════════

/**
 * wave §2.7 / 附录 A `test-cases-non-empty` — testCases 至少 1 条。
 *
 * testCases 是 TDD 硬前提（没测试 execute 不了），必须机器验。
 */
export function testCasesNonEmpty(unit: ExecutionUnit): GateResult {
  const count = unit.plan.testCases.length;
  if (count < 1) {
    return {
      passed: false,
      report: "test-cases-non-empty: testCases 为空（TDD 要求至少 1 条测试用例）",
    };
  }
  return {
    passed: true,
    report: `test-cases-non-empty: testCases 有 ${count} 条`,
  };
}

/**
 * wave §2.7 `test-command-non-empty` — plan.testCommand 非空。
 *
 * testCommand 是 test 阶段 testRunner 执行的 shell 命令（per-wave，取代全局 config.testRunner.command）。
 * 仅校验字段非空——不 spawn、不校验文件存在、不解析命令有效性（命令拼错到 test 阶段才暴露）。
 * 与 testCasesNonEmpty 同层（plan 无独立 gate，结构校验全在 design-review）。
 */
export function testCommandNonEmpty(unit: ExecutionUnit): GateResult {
  const cmd = unit.plan.testCommand?.trim() ?? "";
  return cmd === ""
    ? { passed: false, report: "test-command-non-empty: plan.testCommand 为空（plan 阶段必须填本 wave 的测试执行命令）" }
    : { passed: true, report: `test-command-non-empty: testCommand 已配置` };
}

/**
 * wave §2.7 / 附录 A `test-cases-have-expected` — 每个 WaveTestCase.expected 非空。
 *
 * TDD 红灯前提：expected 由 agent 自填，cw 只验填了（不验对错，§5.2）。
 */
export function testCasesHaveExpected(unit: ExecutionUnit): GateResult {
  const empty = unit.plan.testCases.filter((tc) => !tc.expected || tc.expected.trim() === "");
  if (empty.length > 0) {
    return {
      passed: false,
      report: `test-cases-have-expected: ${empty.length} 条 testCases 的 expected 为空（ids: ${empty.map((t) => t.id).join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `test-cases-have-expected: 全部 ${unit.plan.testCases.length} 条 testCases 的 expected 非空`,
  };
}

/**
 * design-v5-wave §3 `wave-layer-specific-non-empty` — wave 的 4 个 layerSpecific 字段非空。
 *
 * 与 slice/feature/epic 的 layerSpecificNonEmpty 同构（machine gate 只验非空，不验内容质量）。
 * 4 个字段都是可选 string：undefined 或 trim 空都算未填。layerSpecific 可能 undefined（空态），需 guard。
 */
export function waveLayerSpecificNonEmpty(
  layerSpecific: WaveDesignReviewLayerSpecific | undefined,
): GateResult {
  if (!layerSpecific) {
    return {
      passed: false,
      report: "wave-layer-specific-non-empty: layerSpecific 缺失",
    };
  }
  const fields: ReadonlyArray<[string, string | undefined]> = [
    ["testCaseCoverageNote", layerSpecific.testCaseCoverageNote],
    ["boundaryConditionNote", layerSpecific.boundaryConditionNote],
    ["mockStrategyNote", layerSpecific.mockStrategyNote],
    ["tddRedReadinessNote", layerSpecific.tddRedReadinessNote],
  ];
  const empty = fields
    .filter(([, v]) => !v || v.trim() === "")
    .map(([k]) => k);
  if (empty.length > 0) {
    return {
      passed: false,
      report: `wave-layer-specific-non-empty: ${empty.length} 个字段为空（${empty.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: "wave-layer-specific-non-empty: 4 个 layerSpecific 字段都非空",
  };
}

/**
 * 跨 wave 文件冲突检查：当前 wave 的 plan.files 与兄弟 wave 的 plan.files path 交集。
 *
 * 来源：design §3.4（recursive 并行模式新增）。
 *
 * 并行 wave execute 场景下，两个 wave 同时改同一文件会产生 git 冲突。
 * 本 gate 在 wave design-review 阶段检查：当前 wave 的 files[].path 与任一兄弟 wave
 * （同 parent）的 files[].path 有交集 → fail。
 *
 * 照 allWavesClosed 模式（retrospect.ts:197）：rules 层零 IO，兄弟 wave 数据由 handler
 * load 后注入（siblingFiles 参数），gate 不查 store。
 *
 * 交集规则：
 * - action="delete" 的文件不参与冲突（删除不冲突——并行删除同一文件罕见且 git 能处理）
 * - 空 selfFiles → pass（wave 无文件声明不冲突）
 * - 冲突时 report 列出所有冲突 path + 对应兄弟 unitId
 *
 * @param selfFiles 当前 wave 的 plan.files（由 handler 从 unit.plan.files 注入）
 * @param siblingFiles 兄弟 wave 的 plan.files（由 handler 从 store.findChildren load 后注入，
 *   每项含 unitId + 该兄弟的 files 数组）
 */
export function noSiblingWaveFileConflict(
  selfFiles: ReadonlyArray<WaveFile>,
  siblingFiles: ReadonlyArray<{ unitId: string; files: ReadonlyArray<WaveFile> }>,
): GateResult {
  // 空 selfFiles → 无可比较的 path，pass（wave 无文件声明不冲突）
  if (selfFiles.length === 0) {
    return {
      passed: true,
      report: "no-sibling-wave-file-conflict: 当前 wave 无 plan.files，不冲突",
    };
  }
  // 收集当前 wave 的 path 集合（action !== "delete" 才参与——删除不冲突）
  const selfPaths = new Set<string>();
  for (const f of selfFiles) {
    if (f.action !== "delete") selfPaths.add(f.path);
  }
  if (selfPaths.size === 0) {
    // selfFiles 全是 delete → 无可冲突 path
    return {
      passed: true,
      report: "no-sibling-wave-file-conflict: 当前 wave plan.files 全为 delete，不冲突",
    };
  }

  // 遍历兄弟，收集冲突 path + 对应兄弟 unitId
  const conflicts: Array<{ path: string; siblingUnitId: string }> = [];
  for (const sibling of siblingFiles) {
    for (const f of sibling.files) {
      if (f.action === "delete") continue; // 兄弟的 delete 也不参与冲突
      if (selfPaths.has(f.path)) {
        conflicts.push({ path: f.path, siblingUnitId: sibling.unitId });
      }
    }
  }

  if (conflicts.length > 0) {
    const lines = conflicts
      .map((c) => `path="${c.path}" 与兄弟 wave ${c.siblingUnitId} 冲突`)
      .join("\n- ");
    return {
      passed: false,
      report:
        `跨 wave 文件冲突: 当前 wave 的 plan.files 与兄弟 wave 存在交集:\n- ${lines}\n` +
        `请调整 plan.files 划分（各 wave 改不同文件），或在 parent slice 的 split 里声明 dependsOn 串行化（串行 wave 不会同时改同一文件）`,
    };
  }

  return {
    passed: true,
    report: `no-sibling-wave-file-conflict: 与 ${siblingFiles.length} 个兄弟 wave 无文件冲突`,
  };
}

// ═══════════════════════════════════════════════════════════════
// wave design-review gate 聚合
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 wave design-review 全部 10 个 gate（wave §11 WAVE_DESIGN_REVIEW_GATES 清单）。
 *
 * 与 slice/feature/epic 聚合函数对称（runSliceDesignReviewGates 等），用 runGateSafely 逐个包裹。
 * 顺序对应原 wave handler 的 inline 数组（design-review.ts:48-57）：
 *   3 个 testCases 结构 gate + 5 个 judgment 非空 gate + 1 个 wave layerSpecific 非空 gate
 *   + 1 个跨 wave 文件冲突 gate（design §3.4 新增）。
 *
 * siblingFiles 由 handler 注入（rules 层零 IO）：handler 从 store.findChildren(parentUnitId)
 * load 兄弟 wave 的 plan.files 后传入。parentUnitId 为空（独子/孤立 wave）时传空数组，
 * gate 自然 pass。
 *
 * 注意：judgment gate（necessity/sufficiency/...）接收的 judgment 参数取自 input（即
 * 待写入的 designReviewJudgment），而非 unit.designReviewJudgment（此时还未写入）。
 * 与原 wave handler inline 调用保持一致：testCases 结构 gate + layerSpecific gate 用 input 数据，
 * judgment gate 用 input.designReviewJudgment。
 *
 * @param unit 待校验的 ExecutionUnit（已含 plan.testCases）
 * @param judgment 待写入的 designReviewJudgment（design-review input）
 * @param layerSpecific judgment.layerSpecific（wave 专属 4 字段）
 * @param siblingFiles 兄弟 wave 的 plan.files（handler 注入，rules 层零 IO）
 */
export function runWaveDesignReviewGates(
  unit: ExecutionUnit,
  judgment: DesignReviewJudgment,
  layerSpecific: WaveDesignReviewLayerSpecific | undefined,
  siblingFiles: ReadonlyArray<{ unitId: string; files: ReadonlyArray<WaveFile> }>,
): GateResult[] {
  return [
    runGateSafely("test-cases-non-empty", testCasesNonEmpty, unit),
    runGateSafely("test-command-non-empty", testCommandNonEmpty, unit),
    runGateSafely("test-cases-have-expected", testCasesHaveExpected, unit),
    runGateSafely("design-review-necessity-non-empty", designReviewNecessityNonEmpty, judgment),
    runGateSafely("design-review-sufficiency-complete", designReviewSufficiencyComplete, judgment),
    runGateSafely("design-review-alternatives-non-empty", designReviewAlternativesNonEmpty, judgment),
    runGateSafely("design-review-tradeoffs-present", designReviewTradeoffsPresent, judgment),
    runGateSafely("design-review-risks-present", designReviewRisksPresent, judgment),
    runGateSafely("wave-layer-specific-non-empty", waveLayerSpecificNonEmpty, layerSpecific),
    runGateSafely("no-sibling-wave-file-conflict", noSiblingWaveFileConflict, unit.plan.files, siblingFiles),
  ];
}

// ═══════════════════════════════════════════════════════════════
// 业务判断非空 gate（designReviewJudgment，model §5.8 通用要求）
// ═══════════════════════════════════════════════════════════════

/**
 * 附录 A `design-review-necessity-non-empty` — designReviewJudgment.necessity 非空。
 *
 * necessity 是「这个 wave 对 slice 的贡献」判断，model §5.8 必填。
 */
export function designReviewNecessityNonEmpty(
  judgment: DesignReviewJudgment,
): GateResult {
  if (!judgment.necessity || judgment.necessity.trim() === "") {
    return {
      passed: false,
      report: "design-review-necessity-non-empty: necessity 为空",
    };
  }
  return {
    passed: true,
    report: "design-review-necessity-non-empty: necessity 非空",
  };
}

/**
 * 附录 A `design-review-sufficiency-complete` — sufficiency 的 gaps/overlaps/meceNote 完整。
 *
 * meceNote 非空是核心（gaps/overlaps 可为空数组，但 MECE 判断说明必须给）。
 */
export function designReviewSufficiencyComplete(
  judgment: DesignReviewJudgment,
): GateResult {
  const s = judgment.sufficiency;
  if (!s) {
    return {
      passed: false,
      report: "design-review-sufficiency-complete: sufficiency 缺失",
    };
  }
  // guard: gaps/overlaps 可能 undefined（replan 等路径绕过 clarify 校验时）。
  // 给可读 fail 而非下面 s.gaps.length 访问 undefined 崩溃。
  if (!Array.isArray(s.gaps) || !Array.isArray(s.overlaps)) {
    return {
      passed: false,
      report: "design-review-sufficiency-complete: sufficiency.gaps 或 overlaps 缺失（应为数组）",
    };
  }
  if (!s.meceNote || s.meceNote.trim() === "") {
    return {
      passed: false,
      report: "design-review-sufficiency-complete: sufficiency.meceNote 为空（MECE 判断说明必填）",
    };
  }
  return {
    passed: true,
    report: `design-review-sufficiency-complete: meceNote 非空（gaps=${s.gaps.length}, overlaps=${s.overlaps.length}）`,
  };
}

/**
 * 附录 A `design-review-alternatives-non-empty` — alternatives 非空。
 *
 * alternatives 是「考虑过的替代方案」判断，model §5.8 必填。
 */
export function designReviewAlternativesNonEmpty(
  judgment: DesignReviewJudgment,
): GateResult {
  if (!judgment.alternatives || judgment.alternatives.trim() === "") {
    return {
      passed: false,
      report: "design-review-alternatives-non-empty: alternatives 为空",
    };
  }
  return {
    passed: true,
    report: "design-review-alternatives-non-empty: alternatives 非空",
  };
}

/**
 * 附录 A `design-review-tradeoffs-present` — tradeoffs 至少 1 条，且每条必须有 id。
 *
 * id 是后续 test/retrospect 阶段引用 tradeoff 的唯一标识（ref 约定：数组元素→元素 id）。
 * 缺 id 会导致 retrospect gate 的 expected 集合混入 undefined，永远无法通过。
 *
 * 简化（按 spec）：tradeoffs 数组非空 + 每条有 id 即可。具体内容由 agent 自负责（machine gate 只验结构，§6.5）。
 */
export function designReviewTradeoffsPresent(
  judgment: DesignReviewJudgment,
): GateResult {
  // guard: tradeoffs 可能 undefined（replan 等路径绕过 clarify 校验时）。
  // 给可读 fail 而非 judgment.tradeoffs.length 访问 undefined 崩溃。
  if (!Array.isArray(judgment.tradeoffs)) {
    return {
      passed: false,
      report: "design-review-tradeoffs-present: tradeoffs 字段缺失（应为数组）",
    };
  }
  if (judgment.tradeoffs.length < 1) {
    return {
      passed: false,
      report: "design-review-tradeoffs-present: tradeoffs 为空（至少 1 条，或显式声明「无」+ 理由）",
    };
  }
  // 验每条 tradeoff 必须有 id（后续 test/retrospect 用 id 做 ref 引用）
  const missingIds = judgment.tradeoffs.filter((t) => !t.id || typeof t.id !== "string" || t.id.trim() === "");
  if (missingIds.length > 0) {
    return {
      passed: false,
      report: `design-review-tradeoffs-present: ${missingIds.length} 条 tradeoff 缺少 id 字段（id 是后续 test/retrospect 引用的唯一标识，必须填）`,
    };
  }
  return {
    passed: true,
    report: `design-review-tradeoffs-present: tradeoffs 有 ${judgment.tradeoffs.length} 条，每条都有 id`,
  };
}

/**
 * 附录 A `design-review-risks-present` — risks 至少 1 条，且每条必须有 id。
 *
 * id 是后续 test/retrospect 阶段引用 risk 的唯一标识（ref 约定：数组元素→元素 id）。
 * 缺 id 会导致 retrospect gate 的 expected 集合混入 undefined，永远无法通过。
 *
 * 简化（按 spec）：risks 数组非空 + 每条有 id 即可（同 tradeoffs 的处理逻辑）。
 */
export function designReviewRisksPresent(
  judgment: DesignReviewJudgment,
): GateResult {
  // guard: risks 可能 undefined（同 tradeoffs）。
  if (!Array.isArray(judgment.risks)) {
    return {
      passed: false,
      report: "design-review-risks-present: risks 字段缺失（应为数组）",
    };
  }
  if (judgment.risks.length < 1) {
    return {
      passed: false,
      report: "design-review-risks-present: risks 为空（至少 1 条，或显式声明「无」+ 理由）",
    };
  }
  // 验每条 risk 必须有 id（后续 test/retrospect 用 id 做 ref 引用）
  const missingIds = judgment.risks.filter((r) => !r.id || typeof r.id !== "string" || r.id.trim() === "");
  if (missingIds.length > 0) {
    return {
      passed: false,
      report: `design-review-risks-present: ${missingIds.length} 条 risk 缺少 id 字段（id 是后续 test/retrospect 引用的唯一标识，必须填）`,
    };
  }
  return {
    passed: true,
    report: `design-review-risks-present: risks 有 ${judgment.risks.length} 条，每条都有 id`,
  };
}

/**
 * design-v5-epic §2.4 `all-decisions-resolved` — 所有 clarifications[].resolution 非空。
 *
 * progressive 完成度判据：resolution 空 = 还没答的 clarification，带它进 design-review
 * 等于带未决决策进审查。机器必须拦（防 agent 跳过 clarification 直接 design-review）。
 *
 * epic/slice/feature 三层共用（feature 的 clarifications 是 FeatureClarification 容器，
 * 调用方取内层 clarifications 数组传入）。
 */
export function allDecisionsResolved(
  clarifications: ReadonlyArray<Clarification>,
): GateResult {
  const unresolved = clarifications.filter(
    (c) => !c.resolution || c.resolution.trim() === "",
  );
  if (unresolved.length > 0) {
    return {
      passed: false,
      report: `all-decisions-resolved: ${unresolved.length} 个 clarification 未解决（ids: ${unresolved.map((c) => c.id).join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: "all-decisions-resolved: 所有 clarification 已解决",
  };
}

/**
 * design-v5-epic §2.4 `inherited-item-ids-valid` — 每个 split.inheritedItemIds 的 id 在当前 unit 可继承条目集里存在。
 *
 * 防笔误/孤儿引用：inheritedItemIds 是 replan 影响面查询的基础（execute 时写入子层 basedOnParent），
 * 引用了不存在的 id 会导致后续 replan 查询失准。validIds 由调用方（各层 runner）构造——
 * 把该层所有合法的「可被 inheritedItemIds 引用的条目 id」收集进 Set。
 */
export function inheritedItemIdsValid(
  splits: ReadonlyArray<Split>,
  validIds: ReadonlySet<string>,
): GateResult {
  const orphans: string[] = [];
  for (const s of splits) {
    for (const id of s.inheritedItemIds ?? []) {
      if (!validIds.has(id)) orphans.push(id);
    }
  }
  if (orphans.length > 0) {
    const unique = [...new Set(orphans)];
    return {
      passed: false,
      report: `inherited-item-ids-valid: split.inheritedItemIds 引用了不存在的 id（orphans: ${unique.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: "inherited-item-ids-valid: split.inheritedItemIds 引用全部有效",
  };
}

/**
 * `inherited-item-ids-declared` — 软 gate：每个 split 都应声明 inheritedItemIds（未声明 → warn）。
 *
 * 与 inheritedItemIdsValid（hard fail，验已声明 id 的有效性）互补：本 gate 只查"有没有声明"。
 * 未声明不构成结构错误（子层 execute 后 basedOnParent 为空，只是 replan 影响面查询会失准），
 * 因此返回 `passed: true` + `severity: "warn"`——现有 `filter(!g.passed)` 聚合点天然排除，零回归；
 * 调用方如需展示 warn，按 `g.severity === "warn"` 收集 report 即可。
 *
 * 照 splitDagValidBySplits 模式：接收 Split[]，不绑定具体层，三个 runner 直接转调。
 */
export function inheritedItemIdsDeclared(splits: ReadonlyArray<Split>): GateResult {
  // 未声明（undefined 或空数组）都算缺声明；slug 缺失的 split 无法定位，一并列出
  const missing = splits.filter(
    (s) => !s.inheritedItemIds || s.inheritedItemIds.length === 0,
  );
  if (missing.length > 0) {
    return {
      passed: true,
      severity: "warn",
      report: `inherited-item-ids-declared: ${missing.length} 个 split 未声明 inheritedItemIds（slugs: ${missing.map((s) => s.slug || "<缺 slug>").join(", ")}）——不阻断，但 replan 影响面查询会失准，建议声明`,
    };
  }
  return {
    passed: true,
    report: `inherited-item-ids-declared: 全部 ${splits.length} 个 split 都声明了 inheritedItemIds`,
  };
}

// ═══════════════════════════════════════════════════════════════
// slice design-review gate（slice 附录 A §11 / slice §5.5）
// ═══════════════════════════════════════════════════════════════
// 来源：design-v5-slice.md §5.5（SLICE_DESIGN_REVIEW_GATES 清单）、§3（layerSpecific 6 字段）。
// 与 wave gate 的差异：
//   - gate 接收 Slice（plan 是 SlicePlan，而非 WavePlan）
//   - 结构完整性验 techChoices / split + split DAG 无环（wave 验 testCases）
//   - 多一条 layer-specific-non-empty（slice 专属 6 字段，wave 无）

/**
 * slice §5.5 / 附录 A `tech-choice-non-empty` — SlicePlan.techChoices 至少 1 条。
 *
 * techChoices 是 slice 技术方案的核心（选型记录），没有选型的 slice 等于没做技术决策。
 */
export function techChoiceNonEmpty(unit: Slice): GateResult {
  const items = unit.plan.techChoices;
  if (items.length < 1) {
    return {
      passed: false,
      report: "tech-choice-non-empty: techChoices 为空（slice 必须有至少 1 条技术选型）",
    };
  }
  // 验每条 techChoice 必须有 id（后续引用的唯一标识）
  const missingIds = items.filter((item) => !item.id || typeof item.id !== "string" || item.id.trim() === "");
  if (missingIds.length > 0) {
    return {
      passed: false,
      report: `tech-choice-non-empty: ${missingIds.length} 条 techChoice 缺少 id 字段（id 是后续引用的唯一标识，必须填）`,
    };
  }
  return {
    passed: true,
    report: `tech-choice-non-empty: techChoices 有 ${items.length} 条，每条都有 id`,
  };
}

/**
 * slice §5.5 / 附录 A `split-non-empty` — SlicePlan.split 至少 1 项。
 *
 * split 描述 slice 如何拆成 wave（无 split = 没法 execute 创建下层 wave）。
 */
export function splitNonEmpty(unit: Slice): GateResult {
  const items = unit.plan.split;
  if (items.length < 1) {
    return {
      passed: false,
      report: "split-non-empty: split 为空（slice 必须拆出至少 1 个 wave）",
    };
  }
  // 验每条 split 必须有 slug（后续引用的唯一标识）
  const missingSlugs = items.filter((item) => !item.slug || typeof item.slug !== "string" || item.slug.trim() === "");
  if (missingSlugs.length > 0) {
    return {
      passed: false,
      report: `split-non-empty: ${missingSlugs.length} 条 split 缺少 slug 字段（slug 是后续引用的唯一标识，必须填）`,
    };
  }
  return {
    passed: true,
    report: `split-non-empty: split 有 ${items.length} 项，每条都有 slug`,
  };
}

/**
 * slice §5.5 / 附录 A `split-dag-valid` — split 的 dependsOn 依赖关系无环（拓扑排序 DFS 判环）。
 *
 * split 项之间通过 dependsOn 声明执行顺序依赖（如 wave-b dependsOn wave-a）。
 * 环意味着无法确定执行顺序，execute 会死锁。机器必须验。
 *
 * 判环算法：对 split 的 slug 集合做 DFS，三色标记法（白/灰/黑），
 * 遇到灰节点（在当前 DFS 路径上）即有环。dependsOn 引用不存在的 slug 忽略（不构成环，
 * 是数据完整性问题，由其他校验/人审覆盖）。
 */
/**
 * split 依赖无环判定的通用实现（接收 Split[]，不绑定具体层）。
 *
 * feature/slice 的 split 都是 Plan 基类的 Split[]（结构同型），判环逻辑通用。
 * 提取为公共纯函数避免 feature/slice 各写一份三色 DFS（复制粘贴是隐患）。
 * 对外不导出——各层 exported gate（splitDagValid / featureSplitDagValid）转调它。
 */
function splitDagValidBySplits(splits: Split[]): GateResult {
  // 过滤无效 slug（agent 可能漏填），报告验证错误
  const invalidSplits = splits.filter((s) => !s.slug || typeof s.slug !== "string" || s.slug.trim() === "");
  if (invalidSplits.length > 0) {
    return {
      passed: false,
      report: `split-dag-valid: ${invalidSplits.length} 条 split 缺少 slug 字段（slug 是判环和后续引用的基础，必须填）`,
    };
  }
  const slugs = new Set(splits.map((s) => s.slug));
  // dependsOn 邻接表：slug → 它依赖的（必须在它之前完成的）slug 列表
  const depsBySlug = new Map<string, string[]>();
  for (const s of splits) {
    depsBySlug.set(
      s.slug,
      (s.dependsOn ?? []).filter((d) => slugs.has(d)),
    );
  }

  // 三色 DFS 判环：COLOR_WHITE=未访问, COLOR_GRAY=访问中（在当前路径）, COLOR_BLACK=已完成
  const COLOR_WHITE = 0;
  const COLOR_GRAY = 1;
  const COLOR_BLACK = 2;
  const color = new Map<string, number>();
  for (const slug of slugs) color.set(slug, COLOR_WHITE);

  let hasCycle = false;
  let cycleSlug = "";
  const visit = (slug: string): void => {
    if (hasCycle) return;
    const c = color.get(slug);
    if (c === COLOR_GRAY) {
      // 回到当前路径上的节点 → 环
      hasCycle = true;
      cycleSlug = slug;
      return;
    }
    if (c === COLOR_BLACK) return; // 已完成，跳过
    color.set(slug, COLOR_GRAY); // 标灰
    for (const dep of depsBySlug.get(slug) ?? []) {
      visit(dep);
      if (hasCycle) return;
    }
    color.set(slug, COLOR_BLACK); // 标黑
  };

  for (const slug of slugs) {
    if (color.get(slug) === COLOR_WHITE) visit(slug);
    if (hasCycle) break;
  }

  if (hasCycle) {
    return {
      passed: false,
      report: `split-dag-valid: split 的 dependsOn 存在环（涉及 slug "${cycleSlug}"，无法确定子层执行顺序）`,
    };
  }
  return {
    passed: true,
    report: `split-dag-valid: split 的 dependsOn 无环（${slugs.size} 个 slug 拓扑有序）`,
  };
}

/**
 * slice §5.5 / 附录 A `split-dag-valid` — SlicePlan.split 的 dependsOn 依赖关系无环。
 *
 * 转调通用判环实现 splitDagValidBySplits（slice/feature 的 split 结构同型，逻辑通用）。
 */
export function splitDagValid(unit: Slice): GateResult {
  return splitDagValidBySplits(unit.plan.split);
}

/**
 * split fan-out 上限的通用实现（接收 Split[] + 层上限，不绑定具体层）。
 *
 * fan-out 定义：某个被继承的 parent 条目 id 被多少个子 split 引用（inheritedItemIds 命中）。
 * 同一条目被过多子层继承时，replan 影响面查询会扇出到大量分支（影响面爆炸），
 * execute 并行度也无法收敛，机器必须限。maxChildren / layerLabel 由各层 wrapper 注入。
 * 照 splitDagValidBySplits 模式：先验 slug 完整性，再统计计数，超限列出明细。
 * 对外不导出——各层 exported gate（splitFanOutLimit / featureSplitFanOutLimit /
 * epicSplitFanOutLimit）转调它。
 */
function splitFanOutLimitBySplits(
  splits: Split[],
  maxChildren: number,
  layerLabel: string,
): GateResult {
  // 过滤无效 slug（agent 可能漏填），报告验证错误
  const invalidSplits = splits.filter((s) => !s.slug || typeof s.slug !== "string" || s.slug.trim() === "");
  if (invalidSplits.length > 0) {
    return {
      passed: false,
      report: `split-fan-out-limit: ${invalidSplits.length} 条 split 缺少 slug 字段（slug 是 fan-out 计数和后续引用的基础，必须填）`,
    };
  }

  // 统计每个 parent 条目 id 被多少 split 继承（fan-out 计数）
  const fanOutByItemId = new Map<string, number>();
  for (const s of splits) {
    for (const id of s.inheritedItemIds ?? []) {
      fanOutByItemId.set(id, (fanOutByItemId.get(id) ?? 0) + 1);
    }
  }
  const overLimit: Array<{ id: string; count: number }> = [];
  for (const [id, count] of fanOutByItemId) {
    if (count > maxChildren) overLimit.push({ id, count });
  }

  if (overLimit.length > 0) {
    const lines = overLimit.map((o) => `"${o.id}" 被 ${o.count} 个 split 继承`).join("; ");
    return {
      passed: false,
      report: `split-fan-out-limit: ${layerLabel} 拆分 fan-out 超上限（每个 parent 条目最多 ${maxChildren} 个子 split）——${lines}。过大的 fan-out 会让 replan 影响面扇出到过多子层，请合并子层或调整 inheritedItemIds 声明`,
    };
  }
  return {
    passed: true,
    report: `split-fan-out-limit: ${layerLabel} 拆分 fan-out 全部在限内（${fanOutByItemId.size} 个被继承条目，上限 ${maxChildren}）`,
  };
}

/**
 * E3 `split-fan-out-limit`（slice 版）— SlicePlan.split 的 fan-out 不超 MAX_SLICE_TO_WAVE。
 *
 * slice 拆 wave：每个被继承的 slice 条目最多被 6 个 wave split 引用。
 */
export function splitFanOutLimit(unit: Slice): GateResult {
  return splitFanOutLimitBySplits(unit.plan.split, MAX_SLICE_TO_WAVE, "slice→wave");
}

/**
 * spec-c §2 — split 内 slug 唯一性校验的通用实现（接收 Split[]，不绑定具体层）。
 *
 * cw store 按 id save 子层 unit，id 由 split.slug 派生；slug 重复会让后建的子层覆盖先建的
 *（store 写覆盖语义），子层交付静默丢失。机器必须显式验（splitDagValid 不查重复，只查环）。
 * 提取为公共纯函数避免 slice/feature/epic 各写一份（照 splitDagValidBySplits 模式）。
 * 对外不导出——各层 exported gate（duplicateSplitSlug / featureDuplicateSplitSlug /
 * epicDuplicateSplitSlug）转调它。
 */
function duplicateSplitSlugBySplits(splits: Split[]): GateResult {
  const slugs = splits.map((s) => s.slug);
  const unique = new Set(slugs);
  if (slugs.length !== unique.size) {
    // 找出所有出现 2 次以上的 slug（去重后展示）
    const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    const dupeList = [...new Set(dupes)].join(", ");
    return {
      passed: false,
      report: `duplicate-split-slug: split 内 slug 必须唯一，重复 slug（${dupeList}）会导致子层 unit id 冲突覆盖（cw store 按 id save）`,
    };
  }
  return {
    passed: true,
    report: `duplicate-split-slug: split 内 slug 全部唯一（${slugs.length} 个）`,
  };
}

/**
 * spec-c §2 / 附录 A `duplicate-split-slug` — SlicePlan.split 内 slug 唯一。
 *
 * 转调通用唯一性实现 duplicateSplitSlugBySplits（slice/feature/epic 的 split 结构同型，逻辑通用）。
 */
export function duplicateSplitSlug(unit: Slice): GateResult {
  return duplicateSplitSlugBySplits(unit.plan.split);
}

/**
 * slice §5.5 / 附录 A `layer-specific-non-empty` — designReviewJudgment.layerSpecific 的 6 个字段都非空。
 *
 * layerSpecific 是 slice 专属的设计审查维度（SliceDesignReviewLayerSpecific 6 字段），
 * 都是人审判断，gate 只验填了（不验内容质量）。layerSpecific 可能 undefined（空态），需 guard。
 */
export function layerSpecificNonEmpty(unit: Slice): GateResult {
  const ls = unit.designReviewJudgment.layerSpecific as
    | SliceDesignReviewLayerSpecific
    | undefined;
  if (!ls) {
    return {
      passed: false,
      report: "layer-specific-non-empty: designReviewJudgment.layerSpecific 缺失（slice 必须填 6 个专属维度）",
    };
  }
  const requiredKeys: ReadonlyArray<keyof SliceDesignReviewLayerSpecific> = [
    "techChoiceRationale",
    "interfaceContractNote",
    "dataModelSoundness",
    "errorCoverage",
    "testabilityNote",
    "crossWaveContractNote",
  ];
  const empty: string[] = [];
  for (const k of requiredKeys) {
    const v = ls[k];
    if (!v || v.trim() === "") {
      empty.push(k);
    }
  }
  if (empty.length > 0) {
    return {
      passed: false,
      report: `layer-specific-non-empty: layerSpecific 以下字段为空（${empty.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `layer-specific-non-empty: layerSpecific 6 个字段都非空`,
  };
}

// ═══════════════════════════════════════════════════════════════
// slice design-review gate 聚合
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 slice design-review 全部 11 个 gate（slice §5.5 SLICE_DESIGN_REVIEW_GATES）。
 *
 * 顺序对应附录清单：结构完整性（3）→ 决策已解决 + inheritedItemIds 有效（2）
 * → 业务判断非空（5，复用 wave 的 judgment gate）→ layerSpecific 非空（1）。
 * 返回全部 GateResult，调用方按 passed 过滤 mustFix。
 *
 * inheritedItemIdsValid 的 validIds：当前 unit 所有可被 inheritedItemIds 引用的条目 id——
 * slice 的 techChoices/interfaces/dataModels/errorSpecs/decisions/clarifications 的 id。
 *
 * @param unit 待校验的 Slice
 */
export function runSliceDesignReviewGates(unit: Slice): GateResult[] {
  const judgment = unit.designReviewJudgment;
  const plan = unit.plan;
  const validIds = new Set<string>();
  for (const tc of plan.techChoices) validIds.add(tc.id);
  for (const it of plan.interfaces) validIds.add(it.id);
  for (const dm of plan.dataModels) validIds.add(dm.id);
  for (const es of plan.errorSpecs) validIds.add(es.id);
  for (const d of plan.decisions) validIds.add(d.id);
  for (const c of unit.clarifications) validIds.add(c.id);
  return [
    runGateSafely("tech-choice-non-empty", techChoiceNonEmpty, unit),
    runGateSafely("split-non-empty", splitNonEmpty, unit),
    runGateSafely("split-dag-valid", splitDagValid, unit),
    runGateSafely("split-fan-out-limit", splitFanOutLimit, unit),
    runGateSafely("duplicate-split-slug", duplicateSplitSlug, unit),
    runGateSafely("all-decisions-resolved", allDecisionsResolved, unit.clarifications),
    runGateSafely("inherited-item-ids-valid", inheritedItemIdsValid, plan.split, validIds),
    runGateSafely("inherited-item-ids-declared", inheritedItemIdsDeclared, plan.split),
    runGateSafely("design-review-necessity-non-empty", designReviewNecessityNonEmpty, judgment),
    runGateSafely("design-review-sufficiency-complete", designReviewSufficiencyComplete, judgment),
    runGateSafely("design-review-alternatives-non-empty", designReviewAlternativesNonEmpty, judgment),
    runGateSafely("design-review-tradeoffs-present", designReviewTradeoffsPresent, judgment),
    runGateSafely("design-review-risks-present", designReviewRisksPresent, judgment),
    runGateSafely("layer-specific-non-empty", layerSpecificNonEmpty, unit),
  ];
}

// ═══════════════════════════════════════════════════════════════
// feature design-review gate（feature §4.3 / feature §4.2）
// ═══════════════════════════════════════════════════════════════
// 来源：design-v5-feature.md §4.3（FEATURE_DESIGN_REVIEW_GATES 清单）、§4.2（layerSpecific 6 字段）。
// 与 slice gate 的差异：
//   - gate 接收 Feature（plan 是 Plan 基类只含 split，feature 不产技术方案）
//   - 结构完整性验 FR-AC 强引用（feature 专属，spec 在 clarifications.spec）+ split 非空/DAG 无环
//   - 不验 slice 专属字段（techChoices/interfaces/dataModels/errorSpecs——feature plan 无这些）
//   - layerSpecific 验 feature 专属 6 字段（FeatureDesignReviewLayerSpecific）

/**
 * feature §4.3 / 附录 A `fr-ac-coverage` — 每个 active FR 的 ac 数组非空且 id 都存在。
 *
 * FR.ac 是强引用 AC id 的数组（model §5.7）。每个 active FR 必须至少引用 1 条 AC
 *（否则该 FR 无验收依据），且引用的 id 必须在 acceptanceCriteria 里存在（指向 active
 * 或 abandoned AC 都算 id 存在——abandoned AC 是 replan 历史，引用残留不破坏结构）。
 */
export function frAcCoverage(unit: Feature): GateResult {
  const spec = unit.clarifications.spec;
  const acIds = new Set(spec.acceptanceCriteria.map((ac) => ac.id));
  const problems: string[] = [];
  for (const fr of spec.functionalRequirements) {
    if (fr.status !== "active") continue;
    // guard: fr.ac 可能 undefined（replan 等路径绕过 clarify 校验时入库的畸形 FR）。
    // 给可读 fail 而非 fr.ac.length 访问 undefined 崩溃——这是原崩溃 bug 的根因点。
    if (!Array.isArray(fr.ac)) {
      problems.push(`${fr.id}（ac 字段缺失，应为引用 AC id 的数组）`);
      continue;
    }
    if (fr.ac.length === 0) {
      problems.push(`${fr.id}（未引用任何 AC）`);
      continue;
    }
    const missing = fr.ac.filter((id) => !acIds.has(id));
    if (missing.length > 0) {
      problems.push(`${fr.id}（引用了不存在的 AC id: ${missing.join(", ")}）`);
    }
  }
  if (problems.length > 0) {
    return {
      passed: false,
      report: `fr-ac-coverage: 以下 active FR 的 ac 数组有问题（${problems.join("; ")}）`,
    };
  }
  return {
    passed: true,
    report: `fr-ac-coverage: 所有 active FR 的 ac 数组非空且 id 存在`,
  };
}

/**
 * feature §4.3 / 附录 A `ac-reachable-from-fr` — 每个 active AC 至少被一个 active FR 引用。
 *
 * 防孤儿 AC：写了验收标准但没有任何 FR 声称由它验收，意味着该 AC 悬空（spec 不自洽）。
 * 反向遍历——收集所有 active FR.ac 引用的 id 集合，active AC 的 id 不在集合里即孤儿。
 */
export function acReachableFromFr(unit: Feature): GateResult {
  const spec = unit.clarifications.spec;
  const referenced = new Set<string>();
  for (const fr of spec.functionalRequirements) {
    if (fr.status !== "active") continue;
    for (const id of fr.ac) referenced.add(id);
  }
  const orphans = spec.acceptanceCriteria
    .filter((ac) => ac.status === "active" && !referenced.has(ac.id))
    .map((ac) => ac.id);
  if (orphans.length > 0) {
    return {
      passed: false,
      report: `ac-reachable-from-fr: 以下 active AC 未被任何 active FR 引用（孤儿 AC: ${orphans.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `ac-reachable-from-fr: 所有 active AC 均被至少一个 active FR 引用`,
  };
}

/**
 * feature §4.3 / 附录 A `ac-non-empty` — acceptanceCriteria 至少 1 条 active。
 *
 * 没有 AC 的 feature 等于没有验收标准，无法判断是否完成。active AC 至少 1 条
 *（abandoned 全废弃的 spec 等同于空 spec，必须 fail）。
 */
export function acNonEmpty(unit: Feature): GateResult {
  const activeCount = unit.clarifications.spec.acceptanceCriteria.filter(
    (ac) => ac.status === "active",
  ).length;
  if (activeCount < 1) {
    return {
      passed: false,
      report: "ac-non-empty: active 的 acceptanceCriteria 为空（至少需要 1 条可验收标准）",
    };
  }
  return {
    passed: true,
    report: `ac-non-empty: active 的 acceptanceCriteria 有 ${activeCount} 条`,
  };
}

/**
 * feature §4.3 / 附录 A `slice-split-non-empty` — Plan.split 至少 1 项（feature 拆 slice 清单）。
 *
 * feature 的 plan 只用 Plan 基类（不产技术方案），split 是 feature 唯一的结构性产出
 *（描述 feature 拆成哪些 slice）。无 split = 没法 execute 启动下层 slice。
 */
export function featureSplitNonEmpty(unit: Feature): GateResult {
  const items = unit.plan.split;
  if (items.length < 1) {
    return {
      passed: false,
      report: "slice-split-non-empty: split 为空（feature 必须拆出至少 1 个 slice）",
    };
  }
  // 验每条 split 必须有 slug（后续引用的唯一标识）
  const missingSlugs = items.filter((item) => !item.slug || typeof item.slug !== "string" || item.slug.trim() === "");
  if (missingSlugs.length > 0) {
    return {
      passed: false,
      report: `slice-split-non-empty: ${missingSlugs.length} 条 split 缺少 slug 字段（slug 是后续引用的唯一标识，必须填）`,
    };
  }
  return {
    passed: true,
    report: `slice-split-non-empty: split 有 ${items.length} 项，每条都有 slug`,
  };
}

/**
 * feature §4.3 / 附录 A `slice-split-dag-valid` — Plan.split 的 dependsOn 无环（转调通用判环）。
 *
 * 与 slice 的 splitDagValid 同源逻辑（Split 结构同型），feature 版仅文案/命名区分层。
 */
export function featureSplitDagValid(unit: Feature): GateResult {
  return splitDagValidBySplits(unit.plan.split);
}

/**
 * E3 `slice-split-fan-out-limit`（feature 版）— Plan.split 的 fan-out 不超 MAX_FEATURE_TO_SLICE。
 *
 * feature 拆 slice：每个被继承的 spec 条目（FR/AC/UC/Decision）最多被 5 个 slice split 引用。
 * 与 slice 的 splitFanOutLimit 同源逻辑（Split 结构同型），feature 版仅文案/命名区分层。
 */
export function featureSplitFanOutLimit(unit: Feature): GateResult {
  return splitFanOutLimitBySplits(unit.plan.split, MAX_FEATURE_TO_SLICE, "feature→slice");
}

/**
 * spec-c §2 / 附录 A `duplicate-split-slug`（feature 版）— Plan.split 内 slug 唯一。
 *
 * 与 slice 的 duplicateSplitSlug 同源逻辑（Split 结构同型），feature 版仅文案/命名区分层。
 */
export function featureDuplicateSplitSlug(unit: Feature): GateResult {
  return duplicateSplitSlugBySplits(unit.plan.split);
}

/**
 * feature §4.2 / 附录 A `layer-specific-non-empty`（feature 版）— designReviewJudgment.layerSpecific 的 6 个字段都非空。
 *
 * layerSpecific 是 feature 专属的设计审查维度（FeatureDesignReviewLayerSpecific 6 字段），
 * 都是人审判断，gate 只验填了（不验内容质量）。layerSpecific 基类类型是
 * Record<string, string> 下界，用 as 断言收窄到 feature 子类型。layerSpecific 可能 undefined（空态），需 guard。
 */
export function featureLayerSpecificNonEmpty(unit: Feature): GateResult {
  const ls = unit.designReviewJudgment.layerSpecific as
    | FeatureDesignReviewLayerSpecific
    | undefined;
  if (!ls) {
    return {
      passed: false,
      report: "layer-specific-non-empty: designReviewJudgment.layerSpecific 缺失（feature 必须填 6 个专属维度）",
    };
  }
  const requiredKeys: ReadonlyArray<keyof FeatureDesignReviewLayerSpecific> = [
    "specMeceNote",
    "sliceSplitRationale",
    "acVerifiabilityNote",
    "consistencyNote",
    "frAcCoverageNote",
    "sliceSpecCoverageNote",
  ];
  const empty: string[] = [];
  for (const k of requiredKeys) {
    const v = ls[k];
    if (!v || v.trim() === "") {
      empty.push(k);
    }
  }
  if (empty.length > 0) {
    return {
      passed: false,
      report: `layer-specific-non-empty: layerSpecific 以下字段为空（${empty.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `layer-specific-non-empty: layerSpecific 6 个字段都非空`,
  };
}

// ═══════════════════════════════════════════════════════════════
// feature design-review gate 聚合
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 feature design-review 全部 13 个 gate（feature §4.3 FEATURE_DESIGN_REVIEW_GATES）。
 *
 * 顺序对应附录清单：FR-AC 强引用（3）→ split 结构完整性（2）→ 决策已解决 + inheritedItemIds 有效（2）
 * → 业务判断非空（5，复用 wave/slice 共用的 judgment gate）→ layerSpecific 非空（1）。
 * 不包含 slice 专属 gate（techChoices/interfaces/dataModels/errorSpecs——feature plan 无这些）。
 * DesignReviewJudgment 所有层同型，judgment gate 直接复用（传 unit.designReviewJudgment）。
 *
 * inheritedItemIdsValid 的 validIds：当前 unit 所有可被 inheritedItemIds 引用的条目 id——
 * feature 的 clarifications[].id + spec 的 FR/AC/UC/Decision id。
 *
 * @param unit 待校验的 Feature
 */
export function runFeatureDesignReviewGates(unit: Feature): GateResult[] {
  const judgment = unit.designReviewJudgment;
  const spec = unit.clarifications.spec;
  const validIds = new Set<string>();
  for (const c of unit.clarifications.clarifications) validIds.add(c.id);
  for (const fr of spec.functionalRequirements) validIds.add(fr.id);
  for (const ac of spec.acceptanceCriteria) validIds.add(ac.id);
  for (const bc of spec.businessCases) validIds.add(bc.id);
  for (const d of spec.decisions) validIds.add(d.id);
  return [
    runGateSafely("fr-ac-coverage", frAcCoverage, unit),
    runGateSafely("ac-reachable-from-fr", acReachableFromFr, unit),
    runGateSafely("ac-non-empty", acNonEmpty, unit),
    runGateSafely("slice-split-non-empty", featureSplitNonEmpty, unit),
    runGateSafely("slice-split-dag-valid", featureSplitDagValid, unit),
    runGateSafely("slice-split-fan-out-limit", featureSplitFanOutLimit, unit),
    runGateSafely("duplicate-split-slug", featureDuplicateSplitSlug, unit),
    runGateSafely("all-decisions-resolved", allDecisionsResolved, unit.clarifications.clarifications),
    runGateSafely("inherited-item-ids-valid", inheritedItemIdsValid, unit.plan.split, validIds),
    runGateSafely("inherited-item-ids-declared", inheritedItemIdsDeclared, unit.plan.split),
    runGateSafely("design-review-necessity-non-empty", designReviewNecessityNonEmpty, judgment),
    runGateSafely("design-review-sufficiency-complete", designReviewSufficiencyComplete, judgment),
    runGateSafely("design-review-alternatives-non-empty", designReviewAlternativesNonEmpty, judgment),
    runGateSafely("design-review-tradeoffs-present", designReviewTradeoffsPresent, judgment),
    runGateSafely("design-review-risks-present", designReviewRisksPresent, judgment),
    runGateSafely("layer-specific-non-empty", featureLayerSpecificNonEmpty, unit),
  ];
}

// ═══════════════════════════════════════════════════════════════
// epic design-review gate（epic §2.4 / epic §3.2）
// ═══════════════════════════════════════════════════════════════
// 来源：design-v5-epic.md §2.4（plan 阶段机器 gate 建议）、§3.2（layerSpecific 5 字段）。
// 与 feature gate 的差异：
//   - gate 接收 Epic（plan 是 Plan 基类只含 split，epic 不产 spec 也不产技术方案）
//   - 结构完整性验 split 非空/DAG 无环（同 feature，转调通用 splitDagValidBySplits）
//   - 不验 FR-AC 强引用（epic 无 spec，不产 FR/AC——这是 epic vs feature 的核心差异）
//   - layerSpecific 验 epic 专属 5 字段（EpicDesignReviewLayerSpecific）

/**
 * epic §2.4 / 附录 A `feature-split-non-empty`（epic 版）— Plan.split 至少 1 项（epic 拆 feature 清单）。
 *
 * 与 feature 的 featureSplitNonEmpty 同源逻辑（Plan 基类只 split），epic 版仅文案/命名区分层。
 * epic 的 split 描述 epic 拆成哪些 feature（无 split = 没法 execute 启动下层 feature）。
 */
export function epicSplitNonEmpty(unit: Epic): GateResult {
  const items = unit.plan.split;
  if (items.length < 1) {
    return {
      passed: false,
      report: "feature-split-non-empty: split 为空（epic 必须拆出至少 1 个 feature）",
    };
  }
  // 验每条 split 必须有 slug（后续引用的唯一标识）
  const missingSlugs = items.filter((item) => !item.slug || typeof item.slug !== "string" || item.slug.trim() === "");
  if (missingSlugs.length > 0) {
    return {
      passed: false,
      report: `feature-split-non-empty: ${missingSlugs.length} 条 split 缺少 slug 字段（slug 是后续引用的唯一标识，必须填）`,
    };
  }
  return {
    passed: true,
    report: `feature-split-non-empty: split 有 ${items.length} 项，每条都有 slug`,
  };
}

/**
 * epic §2.4 / 附录 A `feature-split-dag-valid`（epic 版）— Plan.split 的 dependsOn 无环（转调通用判环）。
 *
 * 与 feature 的 featureSplitDagValid / slice 的 splitDagValid 同源逻辑（Split 结构同型），
 * epic 版仅文案/命名区分层。
 */
export function epicSplitDagValid(unit: Epic): GateResult {
  return splitDagValidBySplits(unit.plan.split);
}

/**
 * E3 `feature-split-fan-out-limit`（epic 版）— Plan.split 的 fan-out 不超 MAX_EPIC_TO_FEATURE。
 *
 * epic 拆 feature：每个被继承的 epic 条目（clarification）最多被 7 个 feature split 引用。
 * 与 slice/feature 的 fan-out gate 同源逻辑（Split 结构同型），epic 版仅文案/命名区分层。
 */
export function epicSplitFanOutLimit(unit: Epic): GateResult {
  return splitFanOutLimitBySplits(unit.plan.split, MAX_EPIC_TO_FEATURE, "epic→feature");
}

/**
 * spec-c §2 / 附录 A `duplicate-split-slug`（epic 版）— Plan.split 内 slug 唯一。
 *
 * 与 slice/feature 的 duplicateSplitSlug 同源逻辑（Split 结构同型），epic 版仅文案/命名区分层。
 */
export function epicDuplicateSplitSlug(unit: Epic): GateResult {
  return duplicateSplitSlugBySplits(unit.plan.split);
}

/**
 * epic §3.2 / 附录 A `layer-specific-non-empty`（epic 版）— designReviewJudgment.layerSpecific 的 5 个字段都非空。
 *
 * layerSpecific 是 epic 专属的设计审查维度（EpicDesignReviewLayerSpecific 5 字段），
 * 都是人审判断，gate 只验填了（不验内容质量）。layerSpecific 基类类型是
 * Record<string, string> 下界，用 as 断言收窄到 epic 子类型。layerSpecific 可能 undefined（空态），需 guard。
 */
export function epicLayerSpecificNonEmpty(unit: Epic): GateResult {
  const ls = unit.designReviewJudgment.layerSpecific as
    | EpicDesignReviewLayerSpecific
    | undefined;
  if (!ls) {
    return {
      passed: false,
      report: "layer-specific-non-empty: designReviewJudgment.layerSpecific 缺失（epic 必须填 5 个专属维度）",
    };
  }
  const requiredKeys: ReadonlyArray<keyof EpicDesignReviewLayerSpecific> = [
    "strategicAlignment",
    "featureSplitRationale",
    "scopeBoundary",
    "priorityRationale",
    "resourceEstimate",
  ];
  const empty: string[] = [];
  for (const k of requiredKeys) {
    const v = ls[k];
    if (!v || v.trim() === "") {
      empty.push(k);
    }
  }
  if (empty.length > 0) {
    return {
      passed: false,
      report: `layer-specific-non-empty: layerSpecific 以下字段为空（${empty.join(", ")}）`,
    };
  }
  return {
    passed: true,
    report: `layer-specific-non-empty: layerSpecific 5 个字段都非空`,
  };
}

// ═══════════════════════════════════════════════════════════════
// epic design-review gate 聚合
// ═══════════════════════════════════════════════════════════════

/**
 * 跑 epic design-review 全部 10 个 gate（epic §2.4 EPIC_DESIGN_REVIEW_GATES）。
 *
 * 顺序对应附录清单：split 结构完整性（2）→ 决策已解决 + inheritedItemIds 有效（2）
 * → 业务判断非空（5，复用 wave/slice/feature 共用的 judgment gate）→ layerSpecific 非空（1）。
 * 不包含 feature 专属的 FR-AC 强引用 gate（frAcCoverage/acReachableFromFr/acNonEmpty——epic 无 spec）。
 * DesignReviewJudgment 所有层同型，judgment gate 直接复用（传 unit.designReviewJudgment）。
 *
 * inheritedItemIdsValid 的 validIds：当前 unit 所有可被 inheritedItemIds 引用的条目 id——
 * epic 无 spec，只有 clarifications[].id。
 *
 * @param unit 待校验的 Epic
 */
export function runEpicDesignReviewGates(unit: Epic): GateResult[] {
  const judgment = unit.designReviewJudgment;
  const validIds = new Set<string>();
  for (const c of unit.clarifications) validIds.add(c.id);
  return [
    runGateSafely("feature-split-non-empty", epicSplitNonEmpty, unit),
    runGateSafely("feature-split-dag-valid", epicSplitDagValid, unit),
    runGateSafely("feature-split-fan-out-limit", epicSplitFanOutLimit, unit),
    runGateSafely("duplicate-split-slug", epicDuplicateSplitSlug, unit),
    runGateSafely("all-decisions-resolved", allDecisionsResolved, unit.clarifications),
    runGateSafely("inherited-item-ids-valid", inheritedItemIdsValid, unit.plan.split, validIds),
    runGateSafely("inherited-item-ids-declared", inheritedItemIdsDeclared, unit.plan.split),
    runGateSafely("design-review-necessity-non-empty", designReviewNecessityNonEmpty, judgment),
    runGateSafely("design-review-sufficiency-complete", designReviewSufficiencyComplete, judgment),
    runGateSafely("design-review-alternatives-non-empty", designReviewAlternativesNonEmpty, judgment),
    runGateSafely("design-review-tradeoffs-present", designReviewTradeoffsPresent, judgment),
    runGateSafely("design-review-risks-present", designReviewRisksPresent, judgment),
    runGateSafely("layer-specific-non-empty", epicLayerSpecificNonEmpty, unit),
  ];
}
