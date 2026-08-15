/**
 * spec gate 五规则（canon《design-rewrite-architecture.md》§3.3 D3「机器前置规则」；
 * 判定语义与 M0 口径锁定于 docs/rewrite/acceptance/u3-acceptance.md）。
 *
 * ① 验收非空；② core 用例自身 type 必须为 e2e-real/e2e-mock（M0 口径：核心 case
 * 逐条自检，而非集合模糊对应——canon 原文的集合口径无法机器判定，见验收文档）；
 * ③ e2e 用例 command 非空且首 token 在 PATH 可解析；④ e2e-mock 须附非空保真说明；
 * ⑤ 至少一条 unit 级用例；⑥ split 不得自引用（fx-1：终验 leaf-renderer 抄 root
 * 模板未改，split 含自身 → loop 判内部节点 → 等自己 verified → 确定性死锁）。
 * 多缺口按规则序号升序全部列出，不短路。
 *
 * 规则③的 PATH 解析是 `which` 等价检查：只验证设计期可得的事实（bin 可解析），
 * 不检查项目内文件（设计期尚不存在）；command 真正跑得通由 verify 期裁决。
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter as pathDelimiter, join } from "node:path";

import type {
  AcceptanceType,
  SpecRulesResult,
  SpecSubmittedPayload,
} from "../events/types.js";

/** 规则②③的作用域：e2e 级机器验证（区别于 unit/integration/manual） */
function isE2eType(type: AcceptanceType): boolean {
  return type === "e2e-real" || type === "e2e-mock";
}

/**
 * spec 提交时的机器前置规则（①-⑤ 为 u3 五规则，⑥ 为 fx-1 追加）。确定性检查（对
 * 同一 spec + 同一 PATH 环境结果恒定），不做任何主观判断——「验收强不强」由独立
 * reviewer 审，不在本函数职责内。
 */
export function checkSpecRules(spec: SpecSubmittedPayload): SpecRulesResult {
  const failures: string[] = [];

  // ① 验收非空
  if (spec.acceptance.length === 0) {
    failures.push("rule①: spec.acceptance 为空（至少需要一条验收用例）");
  }

  // ② core 用例自身必须是 e2e 级机器验证（M0 口径，逐条自检）
  for (const ac of spec.acceptance) {
    if (ac.core && !isE2eType(ac.type)) {
      failures.push(
        `rule②: ${ac.id} (${ac.type}) 是核心 case 但 type 非 e2e 级` +
          "（core 用例自身 type 须为 e2e-real 或 e2e-mock，口径见 docs/rewrite/acceptance/u3-acceptance.md）",
      );
    }
  }

  // ③ e2e 用例必须有可执行 command（非空 + 首 token 在 PATH 可解析）
  for (const ac of spec.acceptance) {
    if (!isE2eType(ac.type)) continue;
    const command = ac.command?.trim() ?? "";
    if (command === "") {
      failures.push(`rule③: ${ac.id} (${ac.type}) 缺可执行 command`);
      continue;
    }
    const firstToken = command.split(/\s+/)[0];
    if (!isResolvableOnPath(firstToken)) {
      failures.push(
        `rule③: ${ac.id} (${ac.type}) command 首 token "${firstToken}" 在 PATH 不可解析` +
          "（检查拼写、安装对应工具，或改用绝对路径）",
      );
    }
  }

  // ④ e2e-mock 必须附保真说明
  for (const ac of spec.acceptance) {
    if (ac.type !== "e2e-mock") continue;
    if ((ac.mockFidelityNote ?? "").trim() === "") {
      failures.push(
        `rule④: ${ac.id} (e2e-mock) 缺 mock 保真说明（mockFidelityNote 须为非空字符串，说明 mock 了什么、保真到什么程度）`,
      );
    }
  }

  // ⑤ 至少一条 unit 级用例
  if (!spec.acceptance.some((ac) => ac.type === "unit")) {
    failures.push("rule⑤: spec 无任何 unit 级用例");
  }

  // ⑥ split 不得自引用（fx-1 R1 第一道防线：gate 在提交时拒，账本 fold 同注入此
  // 函数——自引用 spec 无法达到 spec-frozen，loop 的内部节点等待不会发生）
  if (spec.split.some((entry) => entry.unitId === spec.unitId)) {
    failures.push(
      `规则⑥: split 自引用 ${spec.unitId}（拆分子节点不得包含自身；叶子 unit 的 split 应为空）。` +
        `恢复动作：从 spec.split 移除 "${spec.unitId}" 条目（叶子 unit 置空数组）后重新提交。`,
    );
  }

  return { ok: failures.length === 0, failures };
}

/**
 * `which` 等价检查：含路径分隔符时直接验证该文件可执行，否则遍历 PATH
 * 各目录查找可执行文件。目录也会通过（与 which 行为一致）；Windows 的
 * PATHEXT 扩展查找不支持（本项目运行环境为类 Unix）。
 */
function isResolvableOnPath(bin: string): boolean {
  if (bin.includes("/")) {
    return isExecutable(bin);
  }
  const pathDirs = (process.env.PATH ?? "").split(pathDelimiter);
  return pathDirs.some((dir) => dir !== "" && isExecutable(join(dir, bin)));
}

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    // accessSync 抛错即「不可执行/不存在」，这正是要返回的结果而非需传播的错误
    return false;
  }
}
