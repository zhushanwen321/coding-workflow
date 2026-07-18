/**
 * ExistenceVerificationStrategy —— delete-only shape 的验证策略实现。
 *
 * 用「产物存在性」替代 TDD 的「测试通过」作为验证手段：tdd_plan 阶段提交 existence.json
 * 声明产物清单（path + expectedState=present/absent），dev 后 postDevVerify 跑 existsSync
 * 核对每个产物的实际状态是否符合声明，验证结果缓存到 existenceArtifacts[].verified。
 *
 * 适用场景：删除任务（删完即交付，无可执行测试）、存在性契约（配置文件必须生成、
 * 旧文件必须删除）。无测试逻辑可验，只验「产物在/不在」。
 *
 * 方法映射（对应原 full-tdd 的 TDD 流程）：
 *   - preDevCheck → parseExistenceJson（schema 校验）+ 业务约束补判（非空 / path 非空 / 沙箱）
 *   - applyPreDevResult → store.setExistenceArtifacts（初始 verified=undefined）
 *   - postDevVerify → existsSync 核对每个 artifact（caseId=artifact.path）
 *   - isDevVerified → 读 existenceArtifacts[].verified 缓存（纯函数，不跑 IO）
 *   - replanGuard → 已 verified 的 artifact 不可改 expectedState（保护已验证契约）
 *
 * 设计要点：
 *   - postDevVerify 是纯查询：只读 topic + existsSync，不写 topic。verified 缓存由
 *     handleTest 事务内调 updateExistenceArtifactVerified 写回（与 tdd 的 updateTestCase 对称）。
 *   - isDevVerified 不跑 IO：信缓存不信文件系统（verified=true 即使文件已被外部改动仍 true）。
 *   - caseId 语义：existence 的「case」即 artifact，caseId=artifact.path（唯一锁定）。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { isPathInsideWorkspace } from "../gate.js";
import { parseExistenceJson } from "../plan-parser.js";
import type { Topic } from "../types.js";
import type {
  ApplyPreDevResultStore,
  ExistenceArtifact,
  GateResult,
  VerificationStrategy,
  VerifyResult,
  Violation,
} from "./types.js";

export class ExistenceVerificationStrategy implements VerificationStrategy {
  readonly id = "existence";
  readonly preDevGateName = "existence-schema";
  readonly postDevGateName = "existence-check";

  preDevCheck(topic: Topic, payload: unknown): GateResult {
    // Step 1: schema 校验（结构）。parseExistenceJson 校验 artifacts 数组 +
    // 每个元素 path(string) + expectedState(present/absent literal)。
    // schema 通过后即保证 expectedState ∈ {present, absent}（非法值如 "maybe" 在此被拒）。
    let parsed: { artifacts: Array<{ path: string; expectedState: "present" | "absent" }> };
    try {
      parsed = parseExistenceJson(payload);
    } catch (e) {
      return {
        result: "fail",
        report: `existence.json schema 校验失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Step 2: 业务约束补判（schema 不覆盖的语义规则）。
    //   - 至少 1 个 artifact（空 artifacts 视为未声明产物 = 无验证目标）
    //   - path 非空字符串（schema 只校验 string 类型，空串能过 schema）
    //   - path 不越出 workspace 沙箱（防 ../ 逃逸，与 script case 的沙箱校验对称）
    if (parsed.artifacts.length === 0) {
      return {
        result: "fail",
        report: "existence.json artifacts 为空：至少需要声明 1 个产物（path + expectedState）。",
      };
    }
    for (const a of parsed.artifacts) {
      if (a.path.length === 0) {
        return {
          result: "fail",
          report: "existence.json artifact.path 为空字符串：每个产物必须声明非空相对路径。",
        };
      }
      if (!isPathInsideWorkspace(a.path, topic.workspacePath)) {
        return {
          result: "fail",
          report: `existence.json artifact.path 越出 workspace 沙箱：${a.path}（须相对 workspacePath，不可用 .. 或绝对路径逃逸）`,
        };
      }
    }

    return {
      result: "pass",
      report: `existence.json 校验通过（${parsed.artifacts.length} 个产物声明）。`,
      parsed: { artifacts: parsed.artifacts },
    };
  }

  applyPreDevResult(
    topicId: string,
    store: ApplyPreDevResultStore,
    parsed: unknown,
  ): void {
    // parsed 形态由 preDevCheck 保证：{ artifacts: [{path, expectedState}] }。
    // 写入 store 时不带 verified（初始未验证——postDevVerify 跑过后由 handleTest 回填）。
    const p = parsed as {
      artifacts: Array<{ path: string; expectedState: "present" | "absent" }>;
    };
    const artifacts: ExistenceArtifact[] = p.artifacts.map((a) => ({
      path: a.path,
      expectedState: a.expectedState,
      // verified 显式 undefined：未跑 postDevVerify。
    }));
    store.setExistenceArtifacts(topicId, artifacts);
  }

  postDevVerify(topic: Topic): VerifyResult[] {
    // 纯查询：遍历 existenceArtifacts，跑 existsSync 核对实际状态。
    // 不写 topic——verified 缓存由 handleTest 事务内调 updateExistenceArtifactVerified 回填。
    // 防御性取值：topic.existenceArtifacts 运行时由 tdd_plan 保证已写入，
    // 但策略可被任意 topic 调用（如 fixture 缺该字段），缺值时按「无产物可验证」返回空数组。
    const artifacts = topic.existenceArtifacts;
    if (!artifacts || artifacts.length === 0) return [];

    const results: VerifyResult[] = [];
    for (const a of artifacts) {
      const absPath = resolve(topic.workspacePath, a.path);
      const exists = existsSync(absPath);
      // passed = 实际状态符合声明（present→应存在，absent→应不存在）
      const passed = exists === (a.expectedState === "present");
      results.push({
        caseId: a.path,
        passed,
        // actual 含 exists + verified：供 handleTest 缓存到 existenceArtifacts[i].verified，
        // 也供 report 渲染观测值。verified 与 passed 同值（通过 = 已验证符合声明）。
        actual: { exists, verified: passed },
        failureReason: passed
          ? undefined
          : a.expectedState === "present"
            ? `产物应存在但缺失：${a.path}（expectedState=present，但 existsSync=false）`
            : `产物应已删除但仍存在：${a.path}（expectedState=absent，但 existsSync=true）`,
      });
    }
    return results;
  }

  isDevVerified(topic: Topic): boolean {
    // 纯缓存读取：信 existenceArtifacts[].verified 不信 IO。
    //   - 无 existenceArtifacts 字段 → false（未声明产物 = 未验证，兼容 tdd_plan 前状态）
    //   - 空数组 → false（未声明产物 = 未验证）
    //   - 任一 verified !== true（含 undefined / false）→ false
    //   - 全 verified === true → true
    const artifacts = topic.existenceArtifacts;
    if (!artifacts || artifacts.length === 0) return false;
    return artifacts.every((a) => a.verified === true);
  }

  replanGuard(oldTopic: Topic, newPayload: unknown): Violation[] {
    // 守卫：已 verified=true 的 artifact 不可改 expectedState（保护已验证的存在性契约）。
    // 例：src/old.ts 声明 absent 且已验证（文件确实删了），replan 时改成 present 会让
    // postDevVerify 在无文件时判 fail——这是「事后篡改契约」，应阻断。
    const verifiedArtifacts =
      oldTopic.existenceArtifacts?.filter((a) => a.verified === true) ?? [];
    if (verifiedArtifacts.length === 0) return [];

    const newArtifacts = extractArtifacts(newPayload);
    // P0: replan payload（dev-plan.json/test.json 格式）不含 artifacts 字段时降级为 no-op。
    // 真实 replan 调用的 planJson（{format,waves,...}）/ testJson（{testCases,...}）都没有 artifacts 键，
    // extractArtifacts 返回空。此时视为"replan 不触碰 existence 契约"——existenceArtifacts 的重建
    // 由 tdd_plan 重跑时的 setExistenceArtifacts 整体覆盖负责（与 m2 注释自洽）。
    // 仅当 payload 显式携带 artifacts 清单（如测试直接传 existence.json 格式）时才做篡改检测。
    if (newArtifacts.length === 0) return [];
    const byPath = new Map(newArtifacts.map((a) => [a.path, a.expectedState]));

    const violations: Violation[] = [];
    for (const old of verifiedArtifacts) {
      const newState = byPath.get(old.path);
      // 已 verified 的 artifact 从清单移除 或 改了 expectedState → 违规。
      // 移除意味着该产物不再受验证（可能被误删而不被发现）。
      if (newState === undefined) {
        violations.push({
          type: "existence_artifact_removed",
          caseId: old.path,
          reason: `已验证的产物从 existence.json 移除：${old.path}（expectedState=${old.expectedState} 已 verified，不可删除声明）`,
        });
      } else if (newState !== old.expectedState) {
        violations.push({
          type: "existence_artifact_state_changed",
          caseId: old.path,
          reason: `已验证产物的 expectedState 被修改：${old.path} ${old.expectedState} → ${newState}（verified 产物不可改契约）`,
        });
      }
    }
    return violations;
  }
}

/** 从 replan newPayload 防御性提取 artifacts 清单（结构不符返回空）。 */
function extractArtifacts(
  payload: unknown,
): Array<{ path: string; expectedState: "present" | "absent" }> {
  if (typeof payload !== "object" || payload === null) return [];
  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj.artifacts)) return [];
  return obj.artifacts.filter(
    (
      a,
    ): a is { path: string; expectedState: "present" | "absent" } =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as { path?: unknown }).path === "string" &&
      (((a as { expectedState?: unknown }).expectedState === "present") ||
        ((a as { expectedState?: unknown }).expectedState === "absent")),
  );
}
