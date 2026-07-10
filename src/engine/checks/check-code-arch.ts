/**
 * full-code-arch（⑤代码架构）硬规则机器验证 — 含 P1 骨架反模式检查。
 *
 * 移植自 skills/full-code-arch/scripts/check_code_arch.py。
 * 入参：topicDir（含 code-architecture.md + changes/review-code-arch.md）。
 *
 * 检查项：
 *   ①结构性：交付物存在 / verdict:pass / 关键章节 / 无占位符 / review-code-arch APPROVED
 *   ②测试矩阵：来源 B（NFR 风险→用例映射）+ 来源 A 表含「测试层」列（mock/real）
 *   ③骨架反模式（P1，code-skeleton/ 存在时）：
 *     - 占位符/类型逃逸（TODO/any/@ts-ignore/type:ignore/nolint 等）
 *     - god object（每文件 LOC ≤ 600）
 *     - 类型/编译检查（tsc/mypy/cargo/go/javac，按扩展名选）
 *     - ②§11 grep pattern（架构层级穿透/依赖方向，从 system-architecture.md 提）
 *     - 调用链接线密度（Level 1：整骨架无注入依赖接线 → 退化回 Level 0）
 *     - orphan 方法（§3 签名表每方法在骨架有定义）
 *
 * 关键移植决策：
 *   - grep 子进程 → 内存扫描（searchInSources：iterSourceFiles + readText + RegExp）
 *     理由：跨平台不依赖系统 grep；iterSourceFiles 已跳 node_modules/dist/.git。
 *   - 类型检查器子进程保留（execFileSync），与 GitValidator 同模式（只读检查）。
 *     命令不存在（ENOENT）→ SKIP；非零退出 → FAIL。
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  checkFileExists,
  checkFrontmatterVerdict,
  checkNoPlaceholders,
  type CheckOutput,
  CheckReport,
  checkRequiredSections,
  checkReviewVerdict,
  countLines,
  extractSection,
  iterSourceFiles,
  readText,
} from "./shared.js";

const DELIVERABLE = "code-architecture.md";
const SKELETON_DIR = "code-skeleton";
const GOD_OBJECT_THRESHOLD = 600; // 骨架阶段阈值（实现期回到 400）

/** 报错清单截断（避免单条报错过长淹没输出）。 */
const ERR_LIST_MAX = 5;
/** 行预览截断长度（报错时展示行前缀）。 */
const LINE_PREVIEW_LEN = 40;
/** 错误消息截断（skip 用短、fail 用长）。 */
const ERR_MSG_SHORT = 60;
const ERR_MSG_LONG = 120;
/** 表格 cell 最小数量（| 首尾分割后至少 2 cell）。 */
const MIN_TABLE_CELLS = 2;
/** 标识符最小长度（过滤单字符噪音）。 */
const MIN_IDENT_LEN = 2;
/** grep pattern 最小长度（太短误报多）。 */
const MIN_PATTERN_LEN = 2;

// 骨架源文件扩展名——比 shared 默认多 .go / .java，让多语言项目可检
const SKEL_EXTS = [".ts", ".tsx", ".py", ".rs", ".js", ".jsx", ".go", ".java"];

// 多语言占位符逃逸模式（③a）：叶子逻辑方法体应抛 not-implemented 异常，
// 而非用语言特定的「跳过类型检查」逃逸。
const PLACEHOLDER_PATTERNS: Array<[string, string, string]> = [
  // [label, 正则源, flags]
  ["TODO 占位", "\\bTODO\\b", ""],
  ["eslint-disable", "eslint-disable", ""],
  ["TS any 类型", ":\\s*any\\b|as\\s+any\\b", ""],
  ["ts-ignore", "@ts-ignore|@ts-nocheck", ""],
  ["Python type: ignore", "#\\s*type:\\s*ignore", ""],
  ["Go //nolint", "//nolint", ""],
  ["Rust #[allow]", "#\\[allow\\(", ""],
];

// 多语言「调用注入依赖」接线模式（③e）：
//   class 风格 this./self./receiver.   +   Vue composable 命名调用（XxxApi.foo()）
const WIRING_PATTERN_SRC =
  "\\b(this|self|s|rcv|receiver)\\.\\w+\\s*\\(" +
  "|\\b\\w+(Api|Store|Registry|Service|Repo|Client|recents|store|commandStore|fileSearchStore)\\.\\w+\\s*\\(";

interface SearchHit {
  file: string;
  line: string;
  lineNum: number;
}

export function runCheckCodeArch(topicDir: string): CheckOutput {
  const report = new CheckReport("code-arch");
  const mdPath = join(topicDir, DELIVERABLE);
  const skeletonPath = join(topicDir, SKELETON_DIR);

  // ① 结构性
  if (!checkFileExists(report, `${DELIVERABLE} 存在`, mdPath)) {
    return report.toOutput({ writeReport: true, topicDir });
  }
  checkFrontmatterVerdict(report, mdPath, "pass");
  checkRequiredSections(report, mdPath, "关键章节", [
    "工程目录",
    "API\\s*契约|签名",
    "时序图|代码链路",
    "测试矩阵|Test Matrix",
  ]);
  checkNoPlaceholders(report, "无占位符", mdPath);
  checkReviewVerdict(report, topicDir, "code-arch", "APPROVED");

  // ② 测试矩阵：来源 B（NFR 风险→用例映射）
  const testMatrix = extractSection(mdPath, "测试矩阵|Test Matrix");
  checkTestMatrix(report, testMatrix);

  // ③ 骨架反模式检查（P1）——code-skeleton/ 存在时才跑
  if (!isDir(skeletonPath)) {
    report.addSkip("骨架检查", `无 ${SKELETON_DIR}/ 目录（可能未到 Step 7）`);
  } else {
    checkSkeleton(report, skeletonPath, topicDir, mdPath);
  }

  return report.toOutput({ writeReport: true, topicDir });
}

/** ② 测试矩阵：来源 B + 来源 A 测试层列。 */
function checkTestMatrix(report: CheckReport, testMatrix: string): void {
  if (!testMatrix) {
    report.addFail("测试矩阵", "无「测试矩阵」章节（MANDATORY）");
    return;
  }

  // 来源 B（NFR 风险→用例映射）
  if (testMatrix.includes("来源 B") || testMatrix.includes("NFR 风险") || testMatrix.includes("NFR风险")) {
    report.addPass("test-matrix 来源 B", "含 NFR 风险→用例映射表");
    // 来源 B 每行映射到用例 ID（T{N}.{M}）
    const nfrRows = testMatrix
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("|") && !l.includes("----") && (l.includes("代码测试") || l.includes("NFR")));
    const rowsWithoutId = nfrRows
      .filter((row) => !/T\d+\.\d+/.test(row))
      .map((row) => row.trim().slice(0, LINE_PREVIEW_LEN));
    if (rowsWithoutId.length > 0) {
      report.addFail(
        "来源 B 用例 ID 映射",
        `${rowsWithoutId.length} 行 NFR 映射缺用例 ID: ${JSON.stringify(rowsWithoutId.slice(0, MIN_TABLE_CELLS))}`,
      );
    } else {
      report.addPass("来源 B 用例 ID 映射", "来源 B 行均映射到用例 ID");
    }
  } else {
    report.addFail("test-matrix 来源 B", "测试矩阵缺「来源 B（NFR 风险→用例映射表）」");
  }

  // 来源 A 测试层（mock/real）
  if (testMatrix.includes("来源 A") || testMatrix.includes("功能用例")) {
    if (testMatrix.includes("测试层")) {
      report.addPass("来源 A 测试层", "来源 A 表含「测试层」列（mock/real）");
    } else {
      report.addFail(
        "来源 A 测试层",
        "来源 A 表缺「测试层」列——每条功能用例须标 mock/real（见 deliverable-template §6）",
      );
    }
  }
}

// ── ③ 骨架反模式检查 ──────────────────────────────────────────

function checkSkeleton(
  report: CheckReport,
  skeletonPath: string,
  topicDir: string,
  mdPath: string,
): void {
  const srcFiles = iterSourceFiles(skeletonPath, SKEL_EXTS);
  if (srcFiles.length === 0) {
    report.addFail("骨架源文件", `${SKELETON_DIR}/ 下无源文件（支持 ${SKEL_EXTS.join(", ")}）`);
    return;
  }
  report.addPass("骨架源文件存在", `${srcFiles.length} 个源文件`);

  // ③a 占位符/类型逃逸
  checkPlaceholders(report, skeletonPath);
  // ③b god object
  checkGodObject(report, skeletonPath, srcFiles);
  // ③c 类型检查（tsc/mypy/cargo/go/javac）
  checkTypecheck(report, skeletonPath);
  // ③d ②§11 grep pattern（从 system-architecture.md 提）
  const archMd = join(topicDir, "system-architecture.md");
  if (existsSync(archMd)) {
    checkArchGrepPatterns(report, archMd, skeletonPath);
  } else {
    report.addSkip("②§11 grep pattern", "无 system-architecture.md，跳过架构规则检查");
  }
  // ③e 接线密度
  checkWiringDensity(report, skeletonPath);
  // ③f orphan 方法
  checkOrphanMethods(report, mdPath, skeletonPath);
}

/** ③a 占位符/类型逃逸：扫骨架源码找 TODO/any/@ts-ignore/type:ignore/nolint 等模式。 */
function checkPlaceholders(report: CheckReport, skeletonPath: string): void {
  const hits: string[] = [];
  for (const [label, patSrc, flags] of PLACEHOLDER_PATTERNS) {
    const found = searchInSources(skeletonPath, new RegExp(patSrc, flags));
    if (found.length > 0) hits.push(`${label}: ${found.length} 处`);
  }
  if (hits.length > 0) {
    report.addFail(
      "骨架无占位符/类型逃逸（③）",
      `${hits.join("; ")}。` +
        `修复建议：叶子逻辑方法体应抛 not-implemented 异常（如 throw new Error('not implemented') / raise NotImplementedError / panic!()），` +
        `非叶子方法体用注入依赖接线（this.x.foo()），不用语言特定的类型逃逸（any/@ts-ignore/type:ignore/nolint）`,
    );
  } else {
    report.addPass("骨架无占位符/类型逃逸（③）", "无 TODO/eslint-disable/any/type:ignore/nolint 等逃逸");
  }
}

/** ③b god object：每文件 LOC ≤ 阈值。 */
function checkGodObject(report: CheckReport, skeletonPath: string, srcFiles: string[]): void {
  const overLimit: string[] = [];
  let maxLoc = 0;
  for (const f of srcFiles) {
    const loc = countLines(f);
    if (loc > maxLoc) maxLoc = loc;
    if (loc > GOD_OBJECT_THRESHOLD) {
      overLimit.push(`${relative(skeletonPath, f)}: ${loc} 行`);
    }
  }
  if (overLimit.length > 0) {
    report.addFail(
      `god object（>${GOD_OBJECT_THRESHOLD} 行）`,
      `${overLimit.length} 个文件超限: ${JSON.stringify(overLimit.slice(0, ERR_LIST_MAX))}。` +
        `修复建议：按职责拆模块（如把「调度+持久化+协议」三职责拆成三个文件）或提取子类（Strategy/Handler）。` +
        `注意：${GOD_OBJECT_THRESHOLD} 是骨架阶段阈值（允许更粗粒度），实现期阈值回到 400 行`,
    );
  } else {
    report.addPass(`god object（>${GOD_OBJECT_THRESHOLD} 行）`, `最大文件 ${maxLoc} 行`);
  }
}

/** ③c 类型/编译检查（按骨架语言自动选 tsc/mypy/cargo/go/javac）。 */
function checkTypecheck(report: CheckReport, skeletonPath: string): void {
  const srcFiles = iterSourceFiles(skeletonPath, SKEL_EXTS);
  const extsPresent = new Set(srcFiles.map((f) => f.slice(f.lastIndexOf("."))));

  // [扩展名集合, 检查器名, 命令, 报告名]
  const checkers: Array<[string[], string, string[], string]> = [
    [[".ts", ".tsx"], "tsc", ["npx", "tsc", "--noEmit"], "类型检查（tsc）"],
    [[".py"], "mypy", ["mypy", "."], "类型检查（mypy）"],
    [[".rs"], "cargo", ["cargo", "check"], "编译检查（cargo check）"],
    [[".go"], "go", ["go", "build", "./..."], "编译检查（go build）"],
    [[".java"], "javac", ["javac", "-d", "/tmp/skel-javac-check", "-sourcepath", "."], "编译检查（javac）"],
  ];

  let ranAny = false;
  for (const [exts, name, cmd, reportName] of checkers) {
    if (!exts.some((e) => extsPresent.has(e))) continue;
    ranAny = true;
    try {
      execFileSync(cmd[0]!, cmd.slice(1), {
        cwd: skeletonPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      report.addPass(reportName, `${name} 通过`);
    } catch (e) {
      if (isENOENT(e)) {
        report.addSkip(reportName, `${name} 不可用: ${errMsg(e).slice(0, ERR_MSG_SHORT)}`);
      } else {
        report.addFail(
          reportName,
          `${name} 失败: ${errMsg(e).slice(0, ERR_MSG_LONG)}。` +
            `修复建议：骨架文件须 tsc 自包含（无外部未声明类型/缺 import）；` +
            `进入 ${SKELETON_DIR}/ 目录跑 \`${cmd.join(" ")}\` 看完整错误详情定位行号`,
        );
      }
    }
  }
  if (!ranAny) {
    report.addSkip("类型检查", `骨架无可识别语言的源文件（支持 ${SKEL_EXTS.join(", ")}）`);
  }
}

/** ③d 执行 system-architecture.md §11 的 grep 验收 pattern（路径映射到骨架）。 */
function checkArchGrepPatterns(report: CheckReport, archMd: string, skeletonPath: string): void {
  const section = extractSection(archMd, "反模式检查|grep\\s*验收");
  if (!section) {
    report.addSkip("②§11 grep pattern", "②无「反模式检查」章节，跳过架构规则检查");
    return;
  }
  // 提取 grep -rn "pattern" <path> [（...）] —— 保留 path
  const acLines = [...section.matchAll(/grep\s+-r\w+\s+['"]([^'"]+)['"]\s+(\S+)/g)];
  const violations: string[] = [];
  let checked = 0;
  for (const m of acLines) {
    const pat = m[1]!;
    const rawPath = m[2]!;
    if (pat.endsWith("/") || pat.length <= MIN_PATTERN_LEN) continue;
    if (rawPath.endsWith("/")) continue; // 目录级作用域保留
    checked += 1;
    // 项目路径 → 骨架路径映射：剥掉 src-electron/{runtime,renderer,shared}/src/ 前缀
    const skelSub = rawPath
      .replace(/^src-electron\/runtime\/src\//, "runtime/")
      .replace(/^src-electron\/renderer\/src\//, "renderer/")
      .replace(/^src-electron\/shared\/src\//, "shared/");
    const scope = join(skeletonPath, skelSub);
    if (!existsSync(scope)) continue; // 作用域文件骨架无对应 → N/A
    const hits = searchInSources(scope, safeRegex(pat));
    if (hits.length > 0) {
      violations.push(`pattern '${pat}' @ ${skelSub}: ${hits.length} 处违规`);
    }
  }
  if (violations.length > 0) {
    report.addFail(
      "②§11 架构规则（③）",
      `${violations.slice(0, ERR_LIST_MAX).join("; ")}（违反②架构决策的层级/依赖方向）。` +
        `期望格式：system-architecture.md §11 每条 AC 写成带路径作用域的 grep，` +
        `如 \`grep -rn 'from ".*renderer.*"' src-electron/runtime/src/\`（指向具体文件/目录，验证跨层穿透）。` +
        `非法：目录级泛搜（无 path）或与②决策无关的全局 pattern——会被跳过不报错但也不验收`,
    );
  } else if (checked > 0) {
    report.addPass(
      "②§11 架构规则（③）",
      `${checked} 条 grep pattern 作用域内核对通过（无层级穿透/方向违规；实现后真实文件 AC 见②§11）`,
    );
  } else {
    report.addSkip("②§11 grep pattern", "②§11 未提取到带路径作用域的 grep pattern");
  }
}

/** ③e 调用链接线密度：整骨架无注入依赖接线 → 退化回 Level 0 → FAIL。 */
function checkWiringDensity(report: CheckReport, skeletonPath: string): void {
  const hits = searchInSources(skeletonPath, new RegExp(WIRING_PATTERN_SRC));
  // 去重（同一行可能被命中多次）
  const uniqueLines = new Set(hits.map((h) => h.line.trim()));
  if (uniqueLines.size > 0) {
    report.addPass(
      "调用链接线密度（③e）",
      `Level 1 接线：${uniqueLines.size} 处注入依赖调用（this./self./receiver. 等，调用链在代码里真实接上）`,
    );
  } else {
    report.addFail(
      "调用链接线密度（③e）",
      "全骨架无注入依赖接线——退化回 Level 0（方法体全 throw）。" +
        "Level 1 要求模块内方法真实接线下游（this.x.foo() / self.x.foo() / receiver.x() 等），" +
        "仅叶子逻辑 throw。见 skeleton-spike.md「分层接线规则」",
    );
  }
}

/** ③f orphan 方法：§3 签名表每方法在骨架有定义。 */
function checkOrphanMethods(report: CheckReport, mdPath: string, skeletonPath: string): void {
  const section = extractSection(mdPath, "API\\s*契约|签名");
  if (!section) {
    report.addSkip("orphan 方法（③f）", "§3 API 契约章节缺失，跳过");
    return;
  }

  // 提取签名表的方法名：表格行第一/二列（标识符）
  const methodNames = new Set<string>();
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || line.includes("----")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < MIN_TABLE_CELLS) continue;
    // cells[0] 为空（| 开头），cells[1] 是第一列
    const firstCell = cells[1]!;
    const secondCell = cells[2] ?? "";
    // 跳过表头行/分组标题
    if (["方法", "类", "Class", "Method", ""].includes(firstCell)) continue;
    if (firstCell.startsWith("#")) continue;
    const candidates = [firstCell, secondCell].filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
    for (const c of candidates) {
      if (c.length >= MIN_IDENT_LEN && !["参数", "返回", "边界", "签名"].includes(c)) {
        methodNames.add(c);
      }
    }
  }

  if (methodNames.size === 0) {
    report.addSkip("orphan 方法（③f）", "§3 未提取到签名表方法名（可能格式不同），跳过");
    return;
  }

  const missing: string[] = [];
  for (const method of [...methodNames].sort()) {
    // methodName( 出现即算（定义或调用都证明方法存在）
    const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hits = searchInSources(skeletonPath, new RegExp(`${escaped}\\s*\\(`));
    if (hits.length === 0) missing.push(method);
  }
  if (missing.length > 0) {
    report.addFail(
      "orphan 方法（③f）",
      `${missing.length} 个 §3 方法在骨架无定义: ${JSON.stringify(missing.slice(0, ERR_LIST_MAX))}` +
        `（设计写了骨架没落地，orphan）。` +
        `⚠️ 误判排查：本检查用 regex 从签名表提取标识符并在骨架搜 methodName(，` +
        `若 missing 含非方法名（如表格里的类型名/状态词），给该表格单元格加反引号（如 \`complete\`）可避免误提取。` +
        `真正的方法名需在骨架源码中有 function 声明或方法定义（this.foo = / foo() 等）。`,
    );
  } else {
    report.addPass(
      "orphan 方法（③f）",
      `§3 全部 ${methodNames.size} 个方法在骨架有定义（无 orphan）`,
    );
  }
}

// ── 工具函数 ──────────────────────────────────────────────────

/** 内存扫描：iterSourceFiles + readText + RegExp，替代 python run_grep（subprocess grep）。 */
function searchInSources(root: string, pattern: RegExp): SearchHit[] {
  const hits: SearchHit[] = [];
  const files = iterSourceFiles(root, SKEL_EXTS);
  for (const file of files) {
    const content = readText(file);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        hits.push({ file, line: lines[i]!, lineNum: i + 1 });
      }
    }
    // 重置正则 lastIndex（防止带 g flag 时跨文件累积）
    pattern.lastIndex = 0;
  }
  return hits;
}

/** 把 python 正则源转成 JS RegExp（处理 \Z / 转义）。 */
function safeRegex(src: string): RegExp {
  const converted = src.replace(/\\Z/g, "(?![\\s\\S])");
  try {
    return new RegExp(converted);
  } catch {
    return /(?:)/; // 解析失败 → 永不命中（保守）
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    String((e as { code: unknown }).code) === "ENOENT"
  );
}

/** execFileSync 抛出的错误挂载 stderr 属性（Node ErrorExec 异常）。 */
function getStderr(e: Error): string | undefined {
  // e.stderr 是 Node 子进程异常挂载的属性，Error 类型声明里不存在
  // 用 Reflect.get 安全读取（避免类型断言绕过 taste/no-unsafe-cast）
  const stderr = Reflect.get(e, "stderr");
  return typeof stderr === "string" ? stderr : undefined;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    // execFileSync 的 stderr 通过 getStderr 安全读取
    const stderr = getStderr(e);
    return stderr ? `${e.message}\n${stderr}` : e.message;
  }
  return String(e);
}
