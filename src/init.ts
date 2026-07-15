/**
 * init — 项目文档基建诊断（只读）。
 *
 * 移植自 xyz-pi-extensions/coding-workflow 的 skills/coding-init + check-init.ts，
 * 适配 cw-cli 的 agent-agnostic + 零外部依赖约束。
 *
 * 与 dispatch action 的本质区别：init 是 topic 之前的基建步骤，**不进状态机**。
 * dispatch 必须 loadTopic → guard → handler，init 无 topic，在 cli.ts 只读分支直接处理
 * （与 status/list/stats 同级）。
 *
 * 职责边界（与 coding-init MANDATORY 一致）：
 *   - **只扫描、报告**，绝不覆盖或改写已有文档（已有文档是用户资产，覆盖不可逆）
 *   - 返回缺失文档的骨架字符串，由 agent 向用户确认后用 write 工具创建
 *   - cw init 本身不碰文件系统（纯只读诊断）
 *
 * 三类检查：
 *   A 文档存在性 + 骨架态（对照文档分级表，含 ASCII 占位符 = 未沉淀骨架）
 *   B 回读一致性（仅 ARCHITECTURE/NFR 非骨架态时跑；骨架态跳过——无内容可核对）
 *   C 缺失文档附骨架字符串（供 agent write）
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── 类型 ─────────────────────────────────────────────────────

export type DocLevel = "必备" | "推荐" | "可选";

export type DocStatus = "ok" | "missing" | "skeleton" | "stale";

export interface InitDocResult {
  /** 文档组名（如「主配置」「CONTEXT.md」）。 */
  name: string;
  level: DocLevel;
  status: DocStatus;
  /** 相对 docRoot 的文件名（status=missing 时为建议创建的文件名）。 */
  path: string;
  /** 状态详情（人可读）。 */
  detail: string;
  /** status=missing 时的骨架内容（供 agent write 创建）。已存在文档不附带。 */
  skeleton?: string;
}

export interface InitResult {
  /** 文档根（主配置所在目录，缺失则 workspacePath）。 */
  docRoot: string;
  /** 检测到的主配置文件名（AGENTS.md 优先），缺失为 null。 */
  mainConfig: "AGENTS.md" | "CLAUDE.md" | null;
  /** 文档检查结果（按分级表顺序）。 */
  docs: InitDocResult[];
  /** 必备文档全 ok 且无 stale = true（ready=true 才建议直接进 create 流程）。 */
  ready: boolean;
}

// ── 文档分组（与 coding-init SKILL.md「文档清单与分级」表一致） ──
//
// [组名, 候选文件名, 级别, 是否 always-current 回读对象]
// 主配置组内任一存在即 OK（AGENTS.md/CLAUDE.md 二选一）。
interface DocGroup {
  name: string;
  candidates: readonly string[];
  level: DocLevel;
  /** always-current 文档会做回读一致性检查（漂移标 stale）。 */
  alwaysCurrent: boolean;
}

const DOC_GROUPS: readonly DocGroup[] = [
  { name: "主配置", candidates: ["AGENTS.md", "CLAUDE.md"], level: "必备", alwaysCurrent: false },
  { name: "README.md", candidates: ["README.md"], level: "必备", alwaysCurrent: false },
  { name: "CONTEXT.md", candidates: ["CONTEXT.md"], level: "必备", alwaysCurrent: false },
  { name: "ARCHITECTURE.md", candidates: ["ARCHITECTURE.md"], level: "推荐", alwaysCurrent: true },
  { name: "PRODUCT.md", candidates: ["PRODUCT.md"], level: "推荐", alwaysCurrent: false },
  { name: "NFR.md", candidates: ["NFR.md"], level: "推荐", alwaysCurrent: true },
  { name: "TEST-STRATEGY.md", candidates: ["TEST-STRATEGY.md"], level: "可选", alwaysCurrent: false },
  { name: "DESIGN-LOG.md", candidates: ["DESIGN-LOG.md"], level: "可选", alwaysCurrent: false },
];

// ── 骨架判定（ASCII-only 占位符） ─────────────────────────────
//
// 故意只匹配 ASCII 占位符（{{var}}/{snake_case}/TODO/TBD/FIXME/XXX），
// 不匹配中文占位符。取舍：已沉淀文档也常含中文占位残留，纳入会误判为骨架。
// 与 check-init.ts 的 PLACEHOLDER_RE 一致（不复用别处的判定函数——语义不同）。
const PLACEHOLDER_RE =
  /\{\{[^}]+\}\}|\{[a-zA-Z_][a-zA-Z0-9_.\-]*\}|\b(TODO|TBD|FIXME|XXX)\b/;

/** 内容是否仍是未填充骨架（含 ASCII 占位符）。 */
function isSkeletonContent(content: string): boolean {
  return PLACEHOLDER_RE.test(content);
}

// ── 回读提取正则 ─────────────────────────────────────────────

// Mermaid stateDiagram 转换行：A --> B（过滤 [*]/note/direction 等非状态词）
const STATE_TRANSITION_RE = /^\s*(\w+)\s*-->\s*(\w+)/;
const STATE_BLACKLIST = new Set(["note", "direction", "state", "left", "right", "up", "down"]);

// 「验证」字段值中的反引号标识符：`foo` / `Bar.baz()`
const BACKTICK_ID_RE = /`([A-Za-z_][\w.]*)`/g;
// 可字面匹配的模块名：纯 ASCII 标识符（中文/含空格跳过——机器不可靠验证）
const ASCII_IDENT_RE = /^[A-Za-z][A-Za-z0-9_\-]{1,}$/;

// ── 源码遍历（移植自 shared.ts iterSourceFiles） ─────────────

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "__pycache__", ".next"]);
const SOURCE_EXTS = [".ts", ".tsx", ".py", ".rs", ".js", ".jsx"] as const;

/** 遍历 root 下指定扩展名的源文件（跳过依赖/构建产物目录）。 */
function iterSourceFiles(root: string): string[] {
  const out: string[] = [];
  if (!isDir(root)) return out;
  walk(root, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    // Dirent 的 isDirectory/endsWith 不会抛；坏 entry（symlink 等）由上面 readdirSync 的 catch 兜底
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (SOURCE_EXTS.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
}

// ── 文件工具 ─────────────────────────────────────────────────

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 读文件文本（不存在/读失败返回 null）。 */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ── 文档根定位 ───────────────────────────────────────────────

/**
 * 文档根 = 主配置（AGENTS/CLAUDE）所在目录；缺失则回退 workspacePath。
 * 只扫 workspacePath 本身（不递归）——深度定位是 agent 的职责。
 */
function resolveDocRoot(
  workspacePath: string,
): { docRoot: string; mainConfig: "AGENTS.md" | "CLAUDE.md" | null } {
  for (const name of ["AGENTS.md", "CLAUDE.md"] as const) {
    if (isFile(join(workspacePath, name))) {
      return { docRoot: workspacePath, mainConfig: name };
    }
  }
  return { docRoot: workspacePath, mainConfig: null };
}

// ── 主流程 ───────────────────────────────────────────────────

/**
 * 项目文档基建诊断（只读）。
 *
 * @param workspacePath 项目根（主配置/长期文档所在层）
 * @returns InitResult——含 docRoot、mainConfig、docs 清单、ready 标志
 */
export function runInit(workspacePath: string): InitResult {
  const { docRoot, mainConfig } = resolveDocRoot(workspacePath);

  // 预读所有源码到内存，供回读字面匹配复用（iterSourceFiles 已跳 node_modules/dist/.git）
  const sourceCache = buildSourceCache(workspacePath);

  const docs: InitDocResult[] = [];
  for (const group of DOC_GROUPS) {
    docs.push(checkDocGroup(group, docRoot, sourceCache));
  }

  // ready：必备文档全 ok 且无 stale（推荐/可选缺失不阻断）
  const requiredNotReady = docs.filter(
    (d) => d.level === "必备" && d.status !== "ok",
  );
  const hasStale = docs.some((d) => d.status === "stale");
  const ready = requiredNotReady.length === 0 && !hasStale;

  return { docRoot, mainConfig, docs, ready };
}

/** 检查单个文档组：存在性 → 骨架态 → 回读一致性。 */
function checkDocGroup(
  group: DocGroup,
  docRoot: string,
  sourceCache: readonly string[],
): InitDocResult {
  // 找组内第一个存在的候选文件
  let existing: string | null = null;
  for (const cand of group.candidates) {
    if (isFile(join(docRoot, cand))) {
      existing = cand;
      break;
    }
  }

  const label = `${group.name}（${group.level}）`;

  if (existing === null) {
    return {
      name: label,
      level: group.level,
      status: "missing",
      path: group.candidates[0]!,
      detail: `缺失（${group.level}）`,
      // 所有缺失文档都附骨架（主配置组只对 AGENTS.md 给骨架——它是新项目默认推荐）
      skeleton: getSkeleton(group.candidates[0]!),
    };
  }

  const p = join(docRoot, existing);
  const content = readText(p);
  if (content === null) {
    return {
      name: label,
      level: group.level,
      status: "missing",
      path: existing,
      detail: `${existing}：读取失败`,
    };
  }

  if (isSkeletonContent(content)) {
    return {
      name: label,
      level: group.level,
      status: "skeleton",
      path: existing,
      detail: `${existing}：含未替换占位符（骨架态，内容未沉淀）`,
    };
  }

  // 非骨架态 always-current 文档：做回读一致性
  if (group.alwaysCurrent) {
    const staleDetail = checkReadback(existing, content, sourceCache);
    if (staleDetail !== null) {
      return {
        name: label,
        level: group.level,
        status: "stale",
        path: existing,
        detail: staleDetail,
      };
    }
  }

  return {
    name: label,
    level: group.level,
    status: "ok",
    path: existing,
    detail: `${existing}：已沉淀`,
  };
}

// ── 回读一致性 ───────────────────────────────────────────────

/** 预读所有源码到内存，供多次字面匹配复用。 */
function buildSourceCache(workspacePath: string): string[] {
  const cache: string[] = [];
  for (const fp of iterSourceFiles(workspacePath)) {
    const text = readText(fp);
    if (text !== null) cache.push(text);
  }
  return cache;
}

/** token 是否在源码缓存中出现（字面匹配）。 */
function searchSource(cache: readonly string[], token: string): boolean {
  return cache.some((c) => c.includes(token));
}

/**
 * 回读一致性检查（仅 always-current 文档调用）。
 * @returns stale 详情字符串；无漂移返回 null
 */
function checkReadback(
  filename: string,
  content: string,
  cache: readonly string[],
): string | null {
  if (filename === "ARCHITECTURE.md") {
    return readbackArchitecture(content, cache);
  }
  if (filename === "NFR.md") {
    return readbackNfr(content, cache);
  }
  return null;
}

/** ARCHITECTURE 回读：模块名 + 状态机枚举 vs 源码。 */
function readbackArchitecture(
  content: string,
  cache: readonly string[],
): string | null {
  const staleParts: string[] = [];

  // 1. 模块名（「模块划分」表第 1 列）
  const modules = extractArchitectureModules(content);
  const staleModules: string[] = [];
  let checked = 0;
  for (const mod of modules) {
    if (!ASCII_IDENT_RE.test(mod)) continue; // 中文/含空格模块名——机器不可靠验证，跳过
    checked += 1;
    if (!searchSource(cache, mod)) staleModules.push(mod);
  }
  if (checked > 0 && staleModules.length > 0) {
    staleParts.push(`模块未在源码找到: ${JSON.stringify(staleModules)}`);
  }

  // 2. 状态机枚举（「关键状态机」mermaid A --> B）
  const states = extractStateMachineStates(content);
  if (states.size > 0) {
    const staleStates = [...states].filter((s) => !searchSource(cache, s));
    if (staleStates.length > 0) {
      staleParts.push(
        `状态机状态未在源码找到: ${JSON.stringify(staleStates.sort())}`,
      );
    }
  }

  return staleParts.length > 0 ? staleParts.join("; ") : null;
}

/** NFR 回读：约束「验证」字段反引号标识符 vs 源码。 */
function readbackNfr(content: string, cache: readonly string[]): string | null {
  const verMap = extractNfrVerificationIds(content);
  if (Object.keys(verMap).length === 0) return null;

  const staleConstraints: Array<[string, string[]]> = [];
  for (const [cid, ids] of Object.entries(verMap)) {
    // 全部标识符都命不中 = 漂移信号强（验证指向的代码符号全不在）
    if (!ids.some((i) => searchSource(cache, i))) {
      staleConstraints.push([cid, ids]);
    }
  }
  if (staleConstraints.length === 0) return null;

  const details = staleConstraints
    .map(([cid, ids]) => `${cid}→${JSON.stringify(ids)}`)
    .join("; ");
  return `约束验证标识符未在源码找到: ${details}`;
}

// ── 回读提取辅助 ─────────────────────────────────────────────

/** 提取匹配 headingPattern 的 ## 章节内容（到下一个 ## 之间）。 */
function extractSectionContent(content: string, headingPattern: string): string {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(headingPattern);
  let collecting = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (collecting) break; // 遇到下一个 ##，结束
      if (pattern.test(line)) collecting = true;
      continue;
    }
    if (collecting) out.push(line);
  }
  return out.join("\n");
}

/** 提取「模块划分」表第 1 列模块名。 */
function extractArchitectureModules(content: string): string[] {
  const section = extractSectionContent(content, "模块划分");
  if (!section) return [];
  const names: string[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|") || line.includes("---")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] 空（首尾 |），cells[1] 第一列；表格至少 2 个 cell
    const MIN_TABLE_CELLS = 2;
    if (cells.length >= MIN_TABLE_CELLS) {
      const name = cells[1];
      if (name && name !== "模块") names.push(name); // 跳表头
    }
  }
  return names;
}

/** 提取「关键状态机」Mermaid 图的状态名（A --> B 转换两端）。 */
function extractStateMachineStates(content: string): Set<string> {
  const section = extractSectionContent(content, "关键状态机");
  if (!section) return new Set();
  const states = new Set<string>();
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(STATE_TRANSITION_RE);
    if (m) {
      for (const s of [m[1]!, m[2]!]) {
        if (!STATE_BLACKLIST.has(s.toLowerCase())) states.add(s);
      }
    }
  }
  return states;
}

/**
 * 提取每个 NFR 约束「验证」字段中的反引号代码标识符。
 * 返回 { constraint_id: [identifier, ...] }。无反引号标识符的约束不出现。
 */
function extractNfrVerificationIds(content: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  // 按 ### 约束标题分块
  const blocks = content.split(/\n(?=###\s+[SDPCRV]O?-\d+)/);
  for (const block of blocks) {
    const titleM = block.match(/^###\s+([SDPCRV]O?-\d+)/);
    if (!titleM?.[1]) continue;
    const cid = titleM[1];
    const verM = block.match(/^-\s*\*\*验证\*\*[：:](.+)$/m);
    if (!verM?.[1]) continue;
    const ids = [...verM[1].matchAll(BACKTICK_ID_RE)].map((m) => m[1]!);
    if (ids.length > 0) result[cid] = ids;
  }
  return result;
}

// ── 骨架模板 ─────────────────────────────────────────────────
//
// 内容对齐 coding-init 的 references/templates/*.md。
// 与 src/prompts/*.ts 同模式：硬编码 TS 模板字符串，engine 内嵌，不读外部文件。
// 只放章节标题 + 占位提示，不 LLM 生成臃肿内容。

const SKELETONS: Record<string, string> = {
  "README.md": `# {项目名}

> 一句话说明这是什么项目。

## 简介

{这个项目解决什么问题，核心功能}

## 安装

\`\`\`bash
{安装步骤}
\`\`\`

## 使用

\`\`\`bash
{基本用法}
\`\`\`

## 开发

\`\`\`bash
{开发命令}
\`\`\`

## License

MIT
`,

  "AGENTS.md": `# {项目名}

> AI 协作规范的单一真相源（跨工具标准）。保持最小化（under 100 行）——臃肿的 context 文件会降低 agent 成功率。

## 项目概述

{一段话：这是什么，解决什么问题}

## 技术栈

- 语言：{}
- 框架：{}
- 数据库：{}
- 关键依赖：{}

## 常用命令

\`\`\`bash
{}          # 开发
{} test     # 测试
{} build    # 构建
\`\`\`

## 核心代码约定

{3-5 条最重要的约定，不要事无巨细。例：禁止 any / 统一 Promise.allSettled / 函数不超过 80 行}

## 架构约定

{分层/模块边界，3-5 条。详细架构见 ARCHITECTURE.md}

## 测试约定

- {零 mock：真实 store + tmp 目录 + 真实子进程，mock 掉验证逻辑 = 失去测试意义}
- {测试目的是发现 bug，不是覆盖率填充——好的测试红=有bug/绿=修复}
- {详细策略见 TEST-STRATEGY.md}

## 术语

领域术语见 CONTEXT.md，在此不重复。
`,

  "CONTEXT.md": `# 统一语言（Ubiquitous Language）

> 记录领域术语的统一定义，所有阶段和编码都应使用此处的术语。

## 术语表

| 术语 | 定义 | 别名 |
|------|------|------|
| {术语} | {精确定义} | {其他叫法，无则留空} |

## 业务边界

{系统的职责范围：做什么，不做什么}
`,

  "ARCHITECTURE.md": `# 系统架构

> 当前态快照，非历史——架构演进的历史决策见 docs/adr/。

## 分层

{层次结构 + 每层职责}

## 模块划分

| 模块 | 职责 | 变化轴 |
|------|------|--------|
| {模块} | {职责} | {会因为什么而改} |

## 关键状态机

{核心实体的状态流转，Mermaid stateDiagram}

## 外部依赖

{4 类分类：In-process / Local-sub / Remote-owned / True-external}
`,

  "PRODUCT.md": `# 产品文档

> always-current，更新频率低（愿景稳定）。给新需求提供「产品已经是什么」的上下文。

## 愿景

{一两句话：这个产品为什么存在、解决谁的什么问题}

## 核心用户

| Actor | 诉求 | 边界 |
|-------|------|------|
| {角色} | {核心诉求} | {不做什么 / 权限边界} |

## 功能边界

{当前产品已覆盖的功能域。标注每个域的成熟度（核心/稳定/实验）}

## 非目标（Non-goals）

> 本文件最有价值的章节——产品边界的有效载体，防止功能蔓延。

- 不做 {X} — {理由}
`,

  "NFR.md": `# 工程约束（NFR）

> always-current。每条约束必须四件套齐全（约束/为什么/验证/例外）；缺"验证" = 空头口号。

## 安全

### S-1 {约束名}

- **约束**：{可执行的 imperative}
- **为什么**：{溯源 + 不可逆理由}
- **验证**：{可执行的验证方式：测试名 / grep AC / 机器检查。缺验证 = 空头口号}
- **例外**：{无，或明确例外边界}

## 性能

<!-- 前缀 P-*：SLO、热路径预算、缓存不变式 -->

## 并发控制

<!-- 前缀 C-*：锁粒度、幂等模型、事务边界 -->

## 稳定性·高可用

<!-- 前缀 R-*：降级策略、熔断阈值、重试边界 -->

## 已知残余风险

| ID | 风险 | 接受理由 | 监控方式 |
|----|------|---------|---------|
| RISK-1 | {风险描述} | {为何接受} | {告警/指标} |
`,

  "TEST-STRATEGY.md": `# 测试策略

> always-current。记录测试策略（金字塔/边界/门禁/约定），非每次的 test-matrix 堆叠。

## 测试目的

测试的首要目标是**发现 bug**，不是覆盖率填充。

- 好的测试有 bug 发现能力：断言「期望的正确行为」，代码有 bug 时红色失败暴露它，修复后绿色
- 覆盖率 100% 不能替代 bug 发现能力——一条不可回退基线（见下）失败就是事故，比百分比更直接
- 反模式：为通过而构建测试（只测 happy path、断言过弱、mock 掉验证逻辑）= 覆盖率好看但抓不到 bug

### 测试设计原则

- {异常路径优先：非法输入/错误分支/边界条件的测试比 happy path 更有价值}
- {隐含约定：测「大家以为成立但没写下来的规则」——重复提交、回退后脏数据、分批提交数据合并}
- {对称性：相似功能的校验应对称——创建有守门，删除有没有？成功路径有校验，失败路径有没有？}
- {每个测试回答「防什么 bug」——答不上来的是覆盖率填充}

## 测试金字塔与边界

| 层 | 测什么 | 不测什么 | mock 策略 |
|---|---|---|---|
| 单元（纯函数） | {无副作用的判定与计算} | {不碰文件系统/git/store} | {纯函数无需 mock} |
| 集成（dispatch） | {走完整 handler 路径：状态流转 + store 落盘 + gate} | {不 spawn 子进程} | {真实 store + 真实 git，禁 mock 核心验证逻辑} |
| E2E（子进程） | {CLI 入口到归档全链跑通} | {不 mock 任何东西} | {零 mock——入口/状态机/store/git 全真实} |

**职责切分**：上层不重复下层的断言。单元层保证判定逻辑正确；集成层保证 handler 编排正确；E2E 层保证端到端不断裂。

### E2E 层约定

- {隔离：每个测试独立临时环境（tmp 目录），测试间无状态共享}
- {构建依赖：E2E 跑构建产物，改完源码要先 build，否则测旧代码}
- {共享基建：子进程调用/环境创建/断言工具提取到 helpers/，不在测试内联}
- {拆分：按功能域（或按 action）拆分测试文件，单文件超阈值时拆}

## Mock 与测试数据约定

**禁 mock 边界**（mock 掉这些 = 失去测试意义）：

- {验证逻辑本身（如判定函数、guard、append-only 校验）——mock 掉等于不测}
- {核心数据层（store/git）——用真实实现 + tmp 目录隔离，不 stub 读写}

**允许 mock 的边界**：

- {外部依赖（网络/第三方 API）——用 fake/stub 隔离，不依赖真实服务}
- {测试数据——用构造函数 + overrides 控制差异，不硬编码}

## 覆盖率门禁

{门禁机制说明。核心理念：不卡覆盖率数字，靠不可回退基线（下）和每层职责覆盖守护。覆盖率是参考，不是目标。}

## 不可回退基线（Regression Baseline）

> 比覆盖率更直接的测试目标。每条标溯源。破坏即事故。

### RB-1 {基线名}

- **断言**：{一句话：期望的正确行为}
- **破坏即**：{事故级别——这条被破坏会导致什么}
- **关联约束**：NFR {S-1}
`,

  "DESIGN-LOG.md": `# 设计历史索引

> 跨主题导航。每主题一行，收尾时更新状态。

## 主题台账

| Topic | 主题 | 开始 | 归档 | 沉淀去向 | 状态 |
|-------|------|------|------|---------|------|
| {yyyy-MM-dd}-{slug} | {一句话主题} | {MM-DD} | {MM-DD 或 —} | {ADR-NNN, NFR S-N ...} | in-progress / archived |

## 状态语义

- in-progress — 设计/实施中
- archived — 已收尾，沉淀已进长期文档
- abandoned — 放弃，标理由

## 活跃 ADR 索引

| ADR | 标题 | 状态 | 溯源 |
|-----|------|------|------|
| ADR-NNN | {一句话} | accepted | [from: {topic}] |
`,
};

/** 获取文档骨架内容。AGENTS.md 和 CLAUDE.md 共享同一骨架（都是 AI 协作规范载体，有一个即可）。 */
function getSkeleton(filename: string): string | undefined {
  if (filename === "CLAUDE.md") return SKELETONS["AGENTS.md"]!;
  return SKELETONS[filename];
}
