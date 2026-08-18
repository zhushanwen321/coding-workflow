/**
 * spec gate 五规则（canon《design-rewrite-architecture.md》§3.3 D3「机器前置规则」；
 * 判定语义与 M0 口径锁定于 docs/rewrite/acceptance/u3-acceptance.md）。
 *
 * ① 验收非空；② core 用例自身 type 必须为 e2e-real/e2e-mock（M0 口径：核心 case
 * 逐条自检，而非集合模糊对应——canon 原文的集合口径无法机器判定，见验收文档）；
 * ③ e2e 用例 command 非空且首 token 在 PATH 可解析；④ e2e-mock 须附非空保真说明；
 * ⑤ 至少一条 unit 级用例；⑥ split 不得自引用（fx-1：终验 leaf-renderer 抄 root
 * 模板未改，split 含自身 → loop 判内部节点 → 等自己 verified → 确定性死锁）；
 * ⑦ 验收 id 字符集（rv-2：与 e2e-sh marker 同源正则，入口拦截非法 id）；
 * ⑧ runner 显式声明时必须在 knownAdapterTypes() 集合内（mx-2：gate 是唯一
 * 入口，verify 侧 adapterTypeFor 不二次校验——非法 runner 靠此处拦截）。
 * 多缺口按规则序号升序全部列出，不短路。
 *
 * 规则③的 PATH 解析是 `which` 等价检查：只验证设计期可得的事实（bin 可解析），
 * 不检查项目内文件（设计期尚不存在）；command 真正跑得通由 verify 期裁决。
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter as pathDelimiter, join } from "node:path";

import type {
  AcceptanceType,
  SpecRulesResult,
  SpecSubmittedPayload,
} from "../events/types.js";
import { ACCEPTANCE_ID_RE } from "../events/types.js";
import { knownAdapterTypes } from "../testrun/registry.js";

/** 规则②③的作用域：e2e 级机器验证（区别于 unit/integration/manual） */
function isE2eType(type: AcceptanceType): boolean {
  return type === "e2e-real" || type === "e2e-mock";
}

/**
 * spec 提交时的机器前置规则（①-⑤ 为 u3 五规则，⑥ 为 fx-1 追加，⑦ 为 rv-2 追加，
 * ⑧ 为 mx-2 追加）。确定性检查（对同一 spec + 同一 PATH 环境结果恒定），不做任何
 * 主观判断——「验收强不强」由独立 reviewer 审，不在本函数职责内。
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

  // ⑦ 验收 id 字符集（rv-2：入口拦截而非追溯清洗——只拦新提交，既有账本 id 全部
  // 合规不受影响）。id 是 e2e-sh 标记行第一列与 nameMatch 比对的锚：gate 不校验时
  // 含空格/中文的 id 能入账，但其 e2e 用例在 verify 期永远匹配不到标记行，报错
  // 误导为「无标记行」。与 e2e-sh MARKER_RE 同源（均派生自 ACCEPTANCE_ID_RE）
  for (const ac of spec.acceptance) {
    if (!ACCEPTANCE_ID_RE.test(ac.id)) {
      failures.push(
        `规则⑦: 验收 id "${ac.id}" 不符字符集约束（须字母数字开头，后续可含 "." "_" "-"，禁空格与中文）。` +
          `id 是 e2e 标记行与名字比对的锚，字符集外 id 的 e2e 用例永远无法匹配。` +
          `恢复动作：修正该 id 后重新提交 spec。`,
      );
    }
  }

  // ⑧ runner 显式声明时必须在已注册适配器集合内（mx-2：唯一入口——verify 侧
  // adapterTypeFor 对 runner 只做确定性查找不校验合法性，绕过 gate 的非法值
  // 会路由不到适配器 fail，错误指向装配而非「runner 写错」，故在此前置拦截）。
  // 大小写敏感：合法值与 registry key 逐字符一致（"pytest" 全小写）。
  // 缺省不校验——走 type 推导路径（回归锁：存量无 runner 的 spec 行为不变）
  const legalRunners = knownAdapterTypes();
  for (const ac of spec.acceptance) {
    if (ac.runner === undefined) {
      continue;
    }
    if (!legalRunners.includes(ac.runner)) {
      failures.push(
        `规则⑧: 验收 ${ac.id} 的 runner "${ac.runner}" 不在合法值集合 [${legalRunners.join("/")}] 内（大小写敏感，须与 registry key 完全一致）。` +
          `恢复动作：改用上述合法值之一，或删除 runner 字段走 type 默认推导（unit/integration→vitest、e2e-real/e2e-mock→e2e-sh）。`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * `which` 等价检查：含路径分隔符时直接验证该文件可执行，否则遍历 PATH
 * 各目录查找可执行文件。目录不通过（实测 macOS `which /private/tmp` 返回
 * not found——目录对 X_OK 恒真，故必须叠加 isFile 检查）；Windows 的
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
    // 目录对 accessSync(X_OK) 恒真（目录天然可遍历），须叠加 isFile 才与 which
    // 行为一致——首 token 是目录（如 /tmp）不是可执行 command
    if (!statSync(candidate).isFile()) {
      return false;
    }
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    // statSync/accessSync 抛错即「非普通文件/不可执行/不存在」，这正是要返回的
    // 结果而非需传播的错误
    return false;
  }
}
