/**
 * ci-judge：CI 失败的归属判定与 flaky 决策树（design-release-pipeline.md
 * §3.3 D7，rp-3/W3；requirements.md UC-5 / AC-5.1-5.3，探针 GP4 已过门）。
 *
 * 决策树（D7）：失败测试文件 + 其 import 闭包 ∩ PR 变更集——
 *   交集非空            → real-regression（归属证据链：测试 → import 链 → 触碰文件）
 *   交集空 ∧ 未 rerun   → flaky-rerun（`gh run rerun <id> --failed` 恰一次）
 *   交集空 ∧ 已 rerun   → flaky-escalate（出声转人工，不自动 rerun 不自动豁免，防 Goodhart）
 *   闭包含不可映射 dist 依赖 → 按 real-regression 处理（RP-8：宁判回归不假 flaky）
 *
 * import 闭包两条路径（AC-5.3，D-015）：
 *   主路径 = typescript API（createSourceFile AST + resolveModuleName；GP4 实测
 *   0.3-4.7ms/文件）。typescript 运行时探测：createRequire(cwd) 加载目标仓的
 *   typescript——cw 仓自身场景 cwd 即本仓（devDependency 必有），目标仓场景
 *   由运行时探测决定；探测不到 → 正则路径兜底（说明符正则 + 相对路径解析 +
 *   tsconfig paths 手工映射）。两路径都做 dist→src 机械映射（GP4 关键发现 2：
 *   `../dist/` import 是 build 级联而非 import 闭包——dist/X.js 机械映射回
 *   src/X.ts 纳入归属；映射不回 = 不可映射，按已触碰）。
 *
 * rerun 无状态设计：judgeCi 不入账、不记忆 rerun 历史——调用方第一次调用
 * （alreadyRerun 缺省 false）判 flaky-rerun 并执行 rerun；rerun 后仍失败由
 * 调用方带 alreadyRerun: true 第二次调用 → flaky-escalate。
 *
 * 环境错误（N9 契约）：gh 不可用 / gh 调用失败 / 日志解析不出失败测试文件 /
 * git ref 不可解析 → 抛 CiJudgeEnvironmentError（消息含恢复动作），绝不静默
 * 降级为 flaky/回归判定——供 CLI 层映射 exit 2。
 */
import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import type * as TsTypes from "typescript";

/** 单步 git/gh 子进程超时（本地 git 毫秒级；上限防远端/挂死） */
const STEP_TIMEOUT_MS = 120_000;
/** gh 日志输出缓冲上限（--log-failed 全量日志，32MB 对齐 wrap.ts 先例） */
const SPAWN_MAX_BUFFER = 33_554_432;
/** 错误消息里输出预览的最大字符数（对齐 events-log.ts 的预览先例） */
const PREVIEW_MAX_CHARS = 400;
/** tsconfig extends 链最大读取深度（正则路径手工合并 paths 的防环上限） */
const MAX_TSCONFIG_EXTENDS_DEPTH = 5;
/** dist 段在 POSIX 化路径中的分隔形式（dist→src 机械映射的锚点） */
const DIST_SEGMENT = "/dist/";
/** 声明文件后缀（dist 产物形态 dist/X.d.ts → src/X.ts） */
const DTS_SUFFIX = ".d.ts";
/** TypeScript 源码后缀（机械映射目标形态之一） */
const TS_SUFFIX = ".ts";
/** TypeScript JSX 源码后缀（机械映射目标形态之二） */
const TSX_SUFFIX = ".tsx";
/** 目录 import 的入口文件名（dist/X/index.js → src/X/index.ts） */
const INDEX_TS = "index.ts";
/** gh 日志中失败测试行（vitest/jest 的 `FAIL <path>` 形态；N9：漂移即解析失败） */
const FAIL_LINE_RE = /\bFAIL\s+([^\s|]+)/g;
/** 测试文件名形态（cw 生态收敛 test/spec 族的 TS/JS 变体） */
const TEST_FILE_NAME_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** import 说明符提取正则族（正则兜底路径；无 g 标志——matchAll 时按源重建） */
const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']([^"']+)["']/,
  /\bimport\s+["']([^"']+)["']/,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/,
];

/** 环境错误（gh/git/解析层故障；handler 用 instanceof 映射 exit 2，N9） */
export class CiJudgeEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiJudgeEnvironmentError";
  }
}

// ─── buildClosure：import 闭包（两条路径共用 BFS + dist→src 映射） ─────────

/** buildClosure 入参 */
export interface BuildClosureOptions {
  /** 目标仓目录（typescript 探测与路径解析基准；judgeCi 内传 git 仓根） */
  cwd: string;
}

/** 依赖解析结果：仓内文件 / 无法映射回 src 的 dist 依赖 */
type DepTarget =
  | { kind: "file"; abs: string }
  | { kind: "dist-unmappable"; abs: string };

/** 直接导入边（evidence 归属链的回溯输入；key = 被导入文件绝对路径） */
export interface ImportEdge {
  fromAbs: string;
  specifier: string;
}

/** buildClosure 公开返回（files 含测试文件自身；路径相对 opts.cwd、POSIX 分隔） */
export interface BuildClosureResult {
  /** import 闭包（dist 依赖已机械映射为对应 src 路径；不含 node_modules） */
  readonly files: readonly string[];
  /** 解析路径：tsc 主 / regex 兜底（AC-5.3 两层降级中的第 ① 层） */
  readonly via: "tsc" | "regex";
  /** 无法映射回 src 的 dist 依赖（非空 → 调用方按已触碰处理，RP-8） */
  readonly unmappableDist: readonly string[];
}

/** buildClosure 内部返回（追加 evidence 回溯所需的导入边表） */
interface ClosureWithEdges extends BuildClosureResult {
  readonly importEdges: ReadonlyMap<string, ImportEdge>;
}

/**
 * 构建测试文件的 import 闭包（相对 opts.cwd 的 POSIX 路径，含测试文件自身）。
 * 主路径 typescript API（运行时探测，D-015），探测不到走正则兜底——两路径
 * 共用 BFS 骨架与 dist→src 机械映射，判定口径一致（AC-5.3）。
 */
export function buildClosure(
  testFile: string,
  opts: BuildClosureOptions,
): BuildClosureResult {
  const full = buildClosureWithEdges(testFile, opts);
  return { files: full.files, via: full.via, unmappableDist: full.unmappableDist };
}

function buildClosureWithEdges(
  testFile: string,
  opts: BuildClosureOptions,
): ClosureWithEdges {
  const startAbs = resolve(opts.cwd, testFile);
  if (!existsSync(startAbs)) {
    throw new Error(
      `buildClosure：测试文件不存在：${startAbs}（testFile=${testFile}，cwd=${opts.cwd}）。` +
        `恢复动作：确认 testFile 相对 opts.cwd 的路径且文件真实存在。`,
    );
  }
  const ts = loadTypescript(opts.cwd);
  const walk =
    ts === undefined
      ? walkViaRegex(startAbs, opts.cwd)
      : walkViaTsc(startAbs, ts, opts.cwd);
  const toRel = (abs: string): string => relative(opts.cwd, abs).split(sep).join("/");
  return {
    files: [...walk.visitedAbs].map(toRel).sort(),
    via: ts === undefined ? "regex" : "tsc",
    unmappableDist: [...walk.unmappableAbs].map(toRel).sort(),
    importEdges: walk.edges,
  };
}

// ─── BFS 骨架（collectSpecifiers / resolveSpecifier 由两条路径分别注入） ───

interface ClosureWalk {
  visitedAbs: ReadonlySet<string>;
  edges: ReadonlyMap<string, ImportEdge>;
  unmappableAbs: ReadonlySet<string>;
}

function walkImportGraph(
  startAbs: string,
  collectSpecifiers: (fileAbs: string) => readonly string[],
  resolveSpecifier: (specifier: string, fromAbs: string) => DepTarget | null,
): ClosureWalk {
  const visited = new Set<string>([startAbs]);
  const edges = new Map<string, ImportEdge>();
  const unmappable = new Set<string>();
  const queue = [startAbs];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    for (const specifier of collectSpecifiers(current)) {
      const target = resolveSpecifier(specifier, current);
      if (target === null) continue;
      if (target.kind === "dist-unmappable") {
        // 映射不回 src：记录不可映射（RP-8 按已触碰），不继续展开该分支
        unmappable.add(target.abs);
        continue;
      }
      if (visited.has(target.abs)) continue;
      visited.add(target.abs);
      edges.set(target.abs, { fromAbs: current, specifier });
      queue.push(target.abs);
    }
  }
  return { visitedAbs: visited, edges, unmappableAbs: unmappable };
}

// ─── typescript 主路径（D-015：运行时探测，本仓 devDependency 场景必然可用） ─

/** 轻量类型守卫：动态 require 回来的模块是否具备本路径所需 API 面 */
function isTypescriptModule(mod: unknown): mod is typeof TsTypes {
  if (typeof mod !== "object" || mod === null) return false;
  const candidate = mod as Record<string, unknown>;
  return (
    typeof candidate.createSourceFile === "function" &&
    typeof candidate.resolveModuleName === "function" &&
    typeof candidate.readConfigFile === "function"
  );
}

/** 运行时探测目标仓的 typescript（D-015）；未安装 = 预期降级路径，返回 undefined */
function loadTypescript(cwd: string): typeof TsTypes | undefined {
  try {
    const requireFromTarget = createRequire(resolve(cwd, "package.json"));
    const mod: unknown = requireFromTarget("typescript");
    return isTypescriptModule(mod) ? mod : undefined;
  } catch (err) {
    // typescript 不在目标仓依赖内（createRequire 抛 MODULE_NOT_FOUND）= D-015
    // 预期形态：走正则兜底，不是故障
    void err;
    return undefined;
  }
}

function walkViaTsc(
  startAbs: string,
  ts: typeof TsTypes,
  cwd: string,
): ClosureWalk {
  const options = loadTscCompilerOptions(ts, cwd);
  return walkImportGraph(
    startAbs,
    (fileAbs) => collectSpecifiersViaAst(ts, fileAbs),
    (specifier, fromAbs) => resolveSpecifierViaTsc(ts, options, specifier, fromAbs),
  );
}

/** 读目标仓 tsconfig 的 compilerOptions（损坏/缺失 → 缺省 Node16，仅损失 paths） */
function loadTscCompilerOptions(
  ts: typeof TsTypes,
  cwd: string,
): TsTypes.CompilerOptions {
  try {
    const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
    if (configPath === undefined) return fallbackCompilerOptions(ts);
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error !== undefined) return fallbackCompilerOptions(ts);
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      dirname(configPath),
    );
    return parsed.options;
  } catch (err) {
    void err; // tsconfig 不可读 = 降级缺省选项（resolveModuleName 仍可工作）
    return fallbackCompilerOptions(ts);
  }
}

function fallbackCompilerOptions(ts: typeof TsTypes): TsTypes.CompilerOptions {
  return { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 };
}

/** AST 提取说明符：import/export-from 声明 + require()/import() 调用 */
function collectSpecifiersViaAst(ts: typeof TsTypes, fileAbs: string): string[] {
  const content = readFileSync(fileAbs, "utf-8");
  const sourceFile = ts.createSourceFile(fileAbs, content, ts.ScriptTarget.ES2022, true);
  const specifiers: string[] = [];
  const visit = (node: TsTypes.Node): void => {
    const specifier = moduleSpecifierOf(ts, node);
    if (specifier !== undefined) specifiers.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(specifiers)];
}

function moduleSpecifierOf(
  ts: typeof TsTypes,
  node: TsTypes.Node,
): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (ts.isCallExpression(node)) {
    const isRequireCall =
      ts.isIdentifier(node.expression) && node.expression.text === "require";
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const argument = node.arguments[0];
    if (
      (isRequireCall || isDynamicImport) &&
      argument !== undefined &&
      ts.isStringLiteral(argument)
    ) {
      return argument.text;
    }
  }
  return undefined;
}

function resolveSpecifierViaTsc(
  ts: typeof TsTypes,
  options: TsTypes.CompilerOptions,
  specifier: string,
  fromAbs: string,
): DepTarget | null {
  if (specifier.startsWith("node:")) return null;
  const resolved = ts.resolveModuleName(specifier, fromAbs, options, ts.sys);
  const resolvedFile = resolved.resolvedModule?.resolvedFileName;
  if (resolvedFile === undefined) return null; // bare 包名 / 说明符不可达
  return categorizeResolved(resolvedFile);
}

// ─── 正则兜底路径（AC-5.3 第 ① 层降级；tsconfig paths 手工映射，GP4 探针同款） ─

function walkViaRegex(startAbs: string, cwd: string): ClosureWalk {
  const paths = loadTsconfigPaths(cwd);
  return walkImportGraph(
    startAbs,
    collectSpecifiersViaRegex,
    (specifier, fromAbs) => resolveSpecifierViaRegex(paths, cwd, specifier, fromAbs),
  );
}

function collectSpecifiersViaRegex(fileAbs: string): string[] {
  const content = readFileSync(fileAbs, "utf-8");
  const specifiers = new Set<string>();
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of content.matchAll(new RegExp(pattern.source, "g"))) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function resolveSpecifierViaRegex(
  paths: ReadonlyMap<string, readonly string[]>,
  cwd: string,
  specifier: string,
  fromAbs: string,
): DepTarget | null {
  if (specifier.startsWith("node:")) return null;
  const candidate = specifier.startsWith(".")
    ? resolveFilePath(resolve(dirname(fromAbs), specifier))
    : resolveBareSpecifierWithPaths(specifier, paths, cwd);
  if (candidate === null) return null;
  return categorizeResolved(candidate);
}

/** 说明符 → 磁盘文件：原样 → 剥扩展试 .ts/.tsx → 目录 index（.js→.ts 惯例） */
function resolveFilePath(candidate: string): string | null {
  const variants = [candidate];
  const ext = extname(candidate);
  if (ext !== "") {
    const withoutExt = candidate.slice(0, -ext.length);
    variants.push(`${withoutExt}${TS_SUFFIX}`, `${withoutExt}${TSX_SUFFIX}`);
  } else {
    variants.push(
      `${candidate}${TS_SUFFIX}`,
      `${candidate}/${INDEX_TS}`,
    );
  }
  for (const variant of variants) {
    if (existsSync(variant)) return variant;
  }
  return null;
}

/** 裸说明符只经 tsconfig paths 映射解析（node_modules 依赖不入闭包） */
function resolveBareSpecifierWithPaths(
  specifier: string,
  paths: ReadonlyMap<string, readonly string[]>,
  cwd: string,
): string | null {
  for (const [pattern, mappings] of paths) {
    const prefix = pattern.replace(/\*$/, "");
    if (!specifier.startsWith(prefix)) continue;
    const suffix = specifier.slice(prefix.length);
    for (const mapping of mappings) {
      const found = resolveFilePath(resolve(cwd, mapping.replace("*", suffix)));
      if (found !== null) return found;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 手工读 tsconfig（含 extends 链）合并 paths；正则兜底路径无 ts API 可借 */
function loadTsconfigPaths(cwd: string): ReadonlyMap<string, readonly string[]> {
  const merged = new Map<string, readonly string[]>();
  const seen = new Set<string>();
  let current = join(cwd, "tsconfig.json");
  for (let depth = 0; depth < MAX_TSCONFIG_EXTENDS_DEPTH && !seen.has(current); depth++) {
    if (!existsSync(current)) break;
    seen.add(current);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(current, "utf-8"));
    } catch (err) {
      void err; // 坏 JSON = 无 paths 可用，静默收敛为空映射（兜底路径不放大故障）
      break;
    }
    if (!isRecord(parsed)) break;
    const compilerOptions = parsed.compilerOptions;
    if (isRecord(compilerOptions) && isRecord(compilerOptions.paths)) {
      for (const [pattern, mapping] of Object.entries(compilerOptions.paths)) {
        if (Array.isArray(mapping)) merged.set(pattern, [...mapping]);
      }
    }
    if (typeof parsed.extends !== "string") break; // 多 extends（数组）非本路径支持面
    current = resolve(dirname(current), parsed.extends);
  }
  return merged;
}

// ─── dist→src 机械映射（RP-8；两路径共用） ─────────────────────────────────

/**
 * dist 依赖归类：路径含 /dist/ 段 → 机械映射回对应 src 文件（dist/X.js →
 * src/X.ts）；映射不回 = 不可映射（调用方按已触碰处理，宁判回归不假 flaky）。
 * 非 dist 路径 → undefined（交由调用方按普通文件入闭包）。
 */
function categorizeResolved(absPath: string): DepTarget | null {
  if (absPath.includes(`node_modules${sep}`)) return null;
  const distMapping = mapDistImportToSrc(absPath);
  if (distMapping !== null) return distMapping;
  if (absPath.endsWith(DTS_SUFFIX)) return null; // 非上下文的仓内声明文件不入闭包
  return { kind: "file", abs: absPath };
}

function mapDistImportToSrc(absPath: string): DepTarget | null {
  const posixPath = absPath.split(sep).join("/");
  const distIndex = posixPath.indexOf(DIST_SEGMENT);
  if (distIndex < 0) return null;
  const repoPrefix = posixPath.slice(0, distIndex);
  const distRest = posixPath.slice(distIndex + DIST_SEGMENT.length);
  for (const candidate of srcCandidatesFor(distRest)) {
    const srcAbs = join(repoPrefix, "src", candidate);
    if (existsSync(srcAbs)) return { kind: "file", abs: srcAbs };
  }
  return { kind: "dist-unmappable", abs: absPath };
}

/** dist 相对片段 → src 候选片段（.d.ts → .ts；.js → .ts/.tsx；目录 → index.ts） */
function srcCandidatesFor(distRest: string): readonly string[] {
  if (distRest.endsWith(DTS_SUFFIX)) {
    return [`${distRest.slice(0, -DTS_SUFFIX.length)}${TS_SUFFIX}`];
  }
  const dot = distRest.lastIndexOf(".");
  if (dot >= 0) {
    const withoutExt = distRest.slice(0, dot);
    return [`${withoutExt}${TS_SUFFIX}`, `${withoutExt}${TSX_SUFFIX}`];
  }
  return [distRest, `${distRest}/${INDEX_TS}`];
}

// ─── judgeCi：决策树主入口 ─────────────────────────────────────────────────

/** judgeCi 入参 */
export interface JudgeCiOptions {
  /** 项目目录（git 仓或其子目录；判定基准 = 解析出的仓根） */
  cwd: string;
  /** 失败 CI run 的 id（gh run view <runId> --log-failed） */
  runId: string;
  /** PR base ref（如 origin/main；git diff prBase..HEAD 的基线） */
  prBase: string;
  /** gh 可执行文件路径（缺省 PATH 上的 gh；测试以真实 shell stub 注入） */
  ghBin?: string;
  /** 调用方声明该 run 已 rerun 过一次（无状态设计：二轮判定由调用方二次传入） */
  alreadyRerun?: boolean;
}

/** flaky 决策树判定结果（kind 三态；rerunExecuted 与 kind 结构性关联） */
export type Judgement =
  | {
      /** 闭包被 PR 触碰（或含不可映射 dist 依赖按已触碰）→ 真回归 */
      kind: "real-regression";
      /** 判定为已触碰的文件（相对仓根；含按 RP-8 处理的不可映射 dist 路径） */
      touchedFiles: readonly string[];
      /** 闭包被触碰（或含不可映射依赖）的失败测试 */
      affectedTests: readonly string[];
      evidence: readonly string[];
      rerunExecuted: false;
    }
  | {
      /** 未触碰 ∧ 未 rerun → 已执行恰一次 rerun */
      kind: "flaky-rerun";
      affectedTests: readonly string[];
      evidence: readonly string[];
      rerunExecuted: true;
    }
  | {
      /** 未触碰 ∧ 已 rerun 仍失败 → 升级转人工（不自动 rerun 不自动豁免） */
      kind: "flaky-escalate";
      affectedTests: readonly string[];
      evidence: readonly string[];
      rerunExecuted: false;
    };

/** 执行 ci-judge 决策树（D7；全流程真实子进程：gh / git；环境错误抛出，N9） */
export function judgeCi(opts: JudgeCiOptions): Judgement {
  const repoRoot = resolveGitRepoRoot(opts.cwd);
  const ghLog = runGhViewFailedLog(opts, repoRoot);
  const failedTests = parseFailedTestFiles(ghLog, repoRoot);
  if (failedTests.length === 0) {
    throw new CiJudgeEnvironmentError(
      `未能从 gh run view ${opts.runId} --log-failed 输出解析出任何失败测试文件` +
        `（输出预览：${preview(ghLog)}）。恢复动作：运行 \`${ghBinOf(opts)} run view ${opts.runId} --log-failed\`` +
        ` 人工核对输出形态；若 GitHub Actions 日志格式漂移，请向 cw 维护者反馈更新解析器` +
        `（N9 契约：解析失败 = 环境错误，不判 flaky/回归）。`,
    );
  }
  const diffFiles = resolvePrChangedFiles(opts, repoRoot);
  const diffSet = new Set(diffFiles);

  const touchedFiles = new Set<string>();
  const affectedTests = new Set<string>();
  const evidence: string[] = [];
  for (const testRel of failedTests) {
    const closure = buildClosureWithEdges(testRel, { cwd: repoRoot });
    for (const distRel of closure.unmappableDist) {
      touchedFiles.add(distRel);
      affectedTests.add(testRel);
      evidence.push(
        `归属证据：${distRel}（失败测试 ${testRel} 的 dist 依赖）无法映射回 src 源文件 → 按已触碰处理` +
          `（RP-8：宁判回归不假 flaky）`,
      );
    }
    const touchedInClosure = closure.files.filter((rel) => diffSet.has(rel));
    if (touchedInClosure.length === 0) continue;
    affectedTests.add(testRel);
    for (const rel of touchedInClosure) {
      touchedFiles.add(rel);
      evidence.push(formatOwnershipChain(rel, testRel, closure.importEdges, repoRoot));
    }
  }
  if (affectedTests.size > 0) {
    return {
      kind: "real-regression",
      touchedFiles: [...touchedFiles].sort(),
      affectedTests: [...affectedTests].sort(),
      evidence,
      rerunExecuted: false,
    };
  }

  const closureSummary =
    `失败测试 import 闭包 ∩ PR 变更集（${opts.prBase}..HEAD）= ∅` +
    `（失败测试 ${failedTests.length} 个，PR 变更 ${diffFiles.length} 个文件）`;
  if (opts.alreadyRerun === true) {
    return {
      kind: "flaky-escalate",
      affectedTests: failedTests,
      evidence: [
        closureSummary,
        `调用方声明本 run 已 rerun 过一次（alreadyRerun）且仍失败 → 升级转人工处置；` +
          `cw 不再自动 rerun、不自动豁免（防 Goodhart，design D7）`,
      ],
      rerunExecuted: false,
    };
  }
  runGhRerunFailed(opts, repoRoot);
  return {
    kind: "flaky-rerun",
    affectedTests: failedTests,
    evidence: [
      closureSummary,
      `已执行一次 rerun：${ghBinOf(opts)} run rerun ${opts.runId} --failed`,
      `若 rerun 后仍失败，请带 alreadyRerun: true 再次调用 judgeCi → 转人工升级`,
    ],
    rerunExecuted: true,
  };
}

/** 归属证据链：测试 →(说明符)…→ 触碰文件（沿 BFS 导入边回溯后正向输出） */
function formatOwnershipChain(
  touchedRel: string,
  testRel: string,
  importEdges: ReadonlyMap<string, ImportEdge>,
  repoRoot: string,
): string {
  const testAbs = resolve(repoRoot, testRel);
  const reversePath = [resolve(repoRoot, touchedRel)];
  const reverseSpecifiers: string[] = [];
  const guard = new Set<string>();
  let cursor = reversePath[0];
  while (cursor !== testAbs && !guard.has(cursor)) {
    const edge = importEdges.get(cursor);
    if (edge === undefined) break;
    guard.add(cursor);
    reverseSpecifiers.push(edge.specifier);
    cursor = edge.fromAbs;
    reversePath.push(cursor);
  }
  const nodes = reversePath.map((abs) => relative(repoRoot, abs).split(sep).join("/")).reverse();
  const specifiers = [...reverseSpecifiers].reverse();
  const chain = nodes
    .map((node, i) => (i < specifiers.length ? `${node} --${specifiers[i]}-->` : node))
    .join(" ");
  return `归属证据：${chain}（PR 触碰 ${touchedRel}；失败测试 ${testRel}）`;
}

// ─── 子进程与解析 helpers（环境错误统一含恢复动作，N9） ─────────────────────

function ghBinOf(opts: JudgeCiOptions): string {
  return opts.ghBin ?? "gh";
}

function describeSpawnFailure(res: SpawnSyncReturns<string>): string {
  if (res.error !== undefined) return `无法启动进程：${res.error.message}`;
  const stderrPreview = preview(res.stderr ?? "");
  return `exit ${res.status}${stderrPreview === "" ? "" : `；stderr：${stderrPreview}`}`;
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= PREVIEW_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, PREVIEW_MAX_CHARS)}…`;
}

function resolveGitRepoRoot(cwd: string): string {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
    timeout: STEP_TIMEOUT_MS,
  });
  if (res.error !== undefined || res.status !== 0) {
    throw new CiJudgeEnvironmentError(
      `无法解析 git 仓根（cwd=${cwd}；${describeSpawnFailure(res)}）。` +
        `恢复动作：确认 cwd 是有效 git 仓（git -C <cwd> rev-parse --show-toplevel 可用）后重试。`,
    );
  }
  return (res.stdout ?? "").trim();
}

function runGhViewFailedLog(opts: JudgeCiOptions, repoRoot: string): string {
  const res = spawnSync(
    ghBinOf(opts),
    ["run", "view", opts.runId, "--log-failed"],
    { cwd: repoRoot, encoding: "utf-8", timeout: STEP_TIMEOUT_MS, maxBuffer: SPAWN_MAX_BUFFER },
  );
  if (res.error !== undefined || res.status !== 0) {
    throw new CiJudgeEnvironmentError(
      `gh run view ${opts.runId} --log-failed 调用失败（${describeSpawnFailure(res)}）。` +
        `恢复动作：运行 \`${ghBinOf(opts)} auth status\` 确认认证、` +
        `\`${ghBinOf(opts)} run view ${opts.runId}\` 确认 run 存在可访问后重试。`,
    );
  }
  return res.stdout ?? "";
}

function runGhRerunFailed(opts: JudgeCiOptions, repoRoot: string): void {
  const res = spawnSync(
    ghBinOf(opts),
    ["run", "rerun", opts.runId, "--failed"],
    { cwd: repoRoot, encoding: "utf-8", timeout: STEP_TIMEOUT_MS },
  );
  if (res.error !== undefined || res.status !== 0) {
    throw new CiJudgeEnvironmentError(
      `flaky-rerun 分支执行 gh run rerun ${opts.runId} --failed 失败（${describeSpawnFailure(res)}）。` +
        `恢复动作：人工运行 \`${ghBinOf(opts)} run rerun ${opts.runId} --failed\`，` +
        `或先 \`${ghBinOf(opts)} run view ${opts.runId}\` 排查 run 状态后重试。`,
    );
  }
}

/** PR 变更集：git diff --name-only（rename 单行的旧/新路径都算触碰） */
function resolvePrChangedFiles(opts: JudgeCiOptions, repoRoot: string): string[] {
  const range = `${opts.prBase}..HEAD`;
  const res = spawnSync("git", ["-C", repoRoot, "diff", "--name-only", range], {
    encoding: "utf-8",
    timeout: STEP_TIMEOUT_MS,
  });
  if (res.error !== undefined || res.status !== 0) {
    throw new CiJudgeEnvironmentError(
      `git diff ${range} 失败（${describeSpawnFailure(res)}）。` +
        `恢复动作：确认 prBase ref「${opts.prBase}」在本地可解析（git fetch 后重试）或改传可解析的 ref/sha。`,
    );
  }
  const files = new Set<string>();
  for (const rawLine of (res.stdout ?? "").split("\n")) {
    for (const part of rawLine.split("\t")) {
      const rel = part.trim();
      if (rel !== "") files.add(rel);
    }
  }
  return [...files].sort();
}

/** 从 gh 日志解析失败测试文件集（相对仓根去重排序；空集 = N9 解析失败） */
function parseFailedTestFiles(log: string, repoRoot: string): string[] {
  const found = new Set<string>();
  for (const match of log.matchAll(FAIL_LINE_RE)) {
    const candidate = match[1];
    if (candidate === undefined || !TEST_FILE_NAME_RE.test(candidate)) continue;
    const abs = resolve(repoRoot, candidate);
    if (!existsSync(abs)) continue; // 日志误匹配/外仓路径：存在性过滤兜底
    found.add(relative(repoRoot, abs).split(sep).join("/"));
  }
  return [...found].sort();
}
