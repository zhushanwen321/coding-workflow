/**
 * pipeline manifest 加载与校验（design-release-pipeline.md §3.3 D6，W2）。
 *
 * 项目侧声明 `.cw-pipeline.json`（流程定义是项目资产随仓版本化，cw 只管执行
 * 与记账）；manifestSha256 = 文件字节级哈希，入每条 PipelineStepRan——fold 按
 * (pipeline, manifestSha256, step) 分组取最新，manifest 变更 → 新分组，旧记录
 * 自然不参与投影（内容寻址，防假进度）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** manifest schema v1（演进预留：真实步骤形态超出覆盖时按加法升 version） */
export interface PipelineManifest {
  version: 1;
  steps: PipelineStep[];
}

export interface PipelineStep {
  /** 步骤名（同 manifest 内唯一；PipelineStepRan 分组键成员） */
  name: string;
  /** 被执行的命令（argv 形态，不经 shell） */
  command: string[];
  /** 缓存声明：带此声明的步骤内部走 gate 缓存判定（命中 → viaCache） */
  cache?: { scope: string[] };
  /** 执行超时上限（ms；缺省 30min） */
  timeoutMs?: number;
}

export interface LoadedManifest {
  manifest: PipelineManifest;
  manifestSha256: string;
}

/** manifest 相关环境错误（不存在/非法/schema 不符）：不入账，CLI 映射 exit 1/2 */
export class PipelineManifestError extends Error {
  constructor(message: string) {
    super(`${message} 恢复动作：检查 .cw-pipeline.json（schema：{ "version": 1, "steps": [{ "name": "...", "command": ["..."], "cache": { "scope": ["..."] }, "timeoutMs": 60000 }] }），修正后重跑 cw pipeline run。`);
    this.name = "PipelineManifestError";
  }
}

/**
 * 读 + 解析 + 校验 manifest 并计算 manifestSha256。
 * 校验规则：version===1；steps 非空数组；每步 name 非空且唯一、command 非空
 * string[]；cache.scope 非空 string[]；timeoutMs 正数。坏 JSON / 任一违规 →
 * PipelineManifestError（消息自带恢复动作）。
 */
export function loadManifest(path: string): LoadedManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new PipelineManifestError(
      `pipeline manifest 读取失败（"${path}"）：${e instanceof Error ? e.message : String(e)}。`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PipelineManifestError(
      `pipeline manifest 不是合法 JSON（"${path}"）：${e instanceof Error ? e.message : String(e)}。`,
    );
  }
  const manifest = validateManifest(parsed);
  return { manifest, manifestSha256: sha256(raw) };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function validateManifest(parsed: unknown): PipelineManifest {
  if (typeof parsed !== "object" || parsed === null) {
    throw new PipelineManifestError("manifest 根必须是对象。");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new PipelineManifestError(`manifest version 必须为 1（当前：${String(obj.version)}）。`);
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new PipelineManifestError("manifest steps 必须为非空数组。");
  }
  const names = new Set<string>();
  for (const [i, step] of (obj.steps as unknown[]).entries()) {
    if (typeof step !== "object" || step === null) {
      throw new PipelineManifestError(`steps[${i}] 必须为对象。`);
    }
    const s = step as Record<string, unknown>;
    if (typeof s.name !== "string" || s.name.trim().length === 0) {
      throw new PipelineManifestError(`steps[${i}].name 必须为非空字符串。`);
    }
    if (names.has(s.name)) {
      throw new PipelineManifestError(`步骤名 "${s.name}" 重复（steps 内必须唯一）。`);
    }
    names.add(s.name);
    if (
      !Array.isArray(s.command) ||
      s.command.length === 0 ||
      s.command.some((c) => typeof c !== "string" || c.length === 0)
    ) {
      throw new PipelineManifestError(`步骤 "${s.name}" 的 command 必须为非空字符串数组。`);
    }
    if (s.cache !== undefined) {
      const cache = s.cache as Record<string, unknown>;
      if (
        !Array.isArray(cache.scope) ||
        cache.scope.length === 0 ||
        cache.scope.some((p) => typeof p !== "string" || p.length === 0)
      ) {
        throw new PipelineManifestError(`步骤 "${s.name}" 的 cache.scope 必须为非空字符串数组。`);
      }
    }
    if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== "number" || s.timeoutMs <= 0)) {
      throw new PipelineManifestError(`步骤 "${s.name}" 的 timeoutMs 必须为正数。`);
    }
  }
  return parsed as PipelineManifest;
}

/** pipeline 身份 = manifest 文件名去扩展名（稳定；同名 manifest 不同目录由 CW_HOME per-cwd 隔离兜底） */
export function pipelineIdOf(manifestPath: string): string {
  const base = manifestPath.split("/").pop() ?? manifestPath;
  return base.replace(/\.json$/, "");
}
