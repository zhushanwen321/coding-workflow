/**
 * v1 guidance — input schema 自动注入器（从 core TS 类型生成 schema 文本）。
 *
 * 来源：v5 cli-and-guidance §3.6「schema 自动生成」+ §4.x 各示例的 schema 段。
 *
 * 职责：用 typescript 官方 createSourceFile 解析 src/core/*.ts 的 interface，
 *      提取字段名/类型/可选/枚举/JSDoc 注释，渲染成 markdown schema block。
 *      避免类型改了 guidance 漂移（schema 从源码自动提取，不手写）。
 *
 * 映射规则（§3.6）：
 *   - `interface X { field: T }` → `{ "field": <T 的 schema> }`
 *   - 联合类型 `"a" | "b" | "c"` → 原样列出枚举值（用 | 分隔）
 *   - 可选字段 `field?: T` → 字段名后标「（可选）」
 *   - 引用类型（字段类型是另一个 interface 名）→ 内联展开（避免 agent 跳转查阅）
 *   - `extends WorkUnitItem` → 自动补 `id: string` + `status: "active" | "abandoned"` 字段
 *   - 字段上方 JSDoc 注释 → 作为字段说明附在后面
 *
 * 边界（已知不支持，core 当前未使用）：
 *   - 仅支持 `Identifier[]` 数组语法，不支持 `Array<T>` / `Map<K,V>` / `Promise<T>` 等容器类型
 *   - 不支持泛型 interface（core 全部是声明式无泛型 interface）
 *   - 不支持交叉类型 `A & B`（core 未使用）
 *   若 core 未来引入这些写法，需扩展 renderMember 的类型分支
 *
 * IO 说明：本函数读源文件是构建时/测试时调用（不是运行时 IO）。
 *      sourceFilePath 相对于 cwd（调用方保证指向 src/core/*.ts）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

import {
  ACTION_SCHEMA,
  EPIC_ACTION_SCHEMA,
  FEATURE_ACTION_SCHEMA,
  type SchemaSource,
  SLICE_ACTION_SCHEMA,
} from "./action-schemas.js";

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

/** 解析后的 interface 成员描述（中间表示，便于渲染 + 测试断言）。 */
export interface MemberDescriptor {
  /** 字段名。 */
  name: string;
  /** 字段类型文本（getText(sourceFile)，保留原样，如 `"unit" | "integration"` / `string[]`）。 */
  typeText: string;
  /** 是否可选（questionToken 存在）。 */
  optional: boolean;
  /** JSDoc 注释（无则空字符串）。 */
  jsDoc: string;
}

/** 解析后的 interface 描述。 */
export interface InterfaceDescriptor {
  /** interface 名。 */
  name: string;
  /** 直接声明的成员（不含继承的）。 */
  members: MemberDescriptor[];
  /** extends 的父 interface 名（如 ["WorkUnitItem"]）。 */
  extendsNames: string[];
}

/**
 * 带 jsDoc 数组的 Node 形态（TS 内部 NodeObject 持有，类型层未公开声明）。
 *
 * setParentNodes=true 时 createSourceFile 会填充 jsDoc；用命名接口收窄（单次断言），
 * 避免双重断言（as unknown as）与全可选结构断言（taste/no-unsafe-cast 规则）。
 */
interface NodeWithJsDoc {
  jsDoc?: ReadonlyArray<ts.JSDoc>;
}

// ═══════════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════════

/**
 * 从 core 源码提取指定 interface 的 schema 文本。
 *
 * @param sourceFilePath core 源文件路径（相对 cwd，如 "src/core/plan.ts"）
 * @param interfaceName 要提取的 interface 名（如 "WaveTestCase"）
 * @returns 渲染后的 schema 文本（含继承补字段 + 内联展开引用类型 + 注释 + 可选标注）。
 *          interface 不存在时抛错（fail-fast，避免静默返回空 schema 导致 guidance 漂移）。
 */
export function injectSchema(sourceFilePath: string, interfaceName: string): string {
  const sourceText = readFileSync(sourceFilePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    sourceFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  const allInterfaces = collectInterfaces(sourceFile);
  const target = allInterfaces.get(interfaceName);
  if (target === undefined) {
    throw new Error(
      `injectSchema: interface "${interfaceName}" not found in ${sourceFilePath}`,
    );
  }

  // 解析并递归展开引用类型 + 补 extends 字段。
  const lines = renderInterface(target, allInterfaces, /* depth */ 0, new Set());
  return ["{", ...lines, "}"].join("\n");
}

// ═══════════════════════════════════════════════════════════════
// 构建期：生成预计算 schema 产物
// ═══════════════════════════════════════════════════════════════

/** 单个 action 的预计算 schema 条目。 */
export interface SchemaGenEntry {
  /** 来源 core 源文件路径。 */
  sourceFilePath: string;
  /** 提取的 interface 名。 */
  interfaceName: string;
  /** 渲染后的 schema 文本。 */
  schemaText: string;
}

/**
 * 为四层所有 schema 表中声明的 action 预计算 schema 文本，输出可序列化的 JSON 对象。
 *
 * 设计：npm pack 只发布 dist/ 目录，运行时 src/core/*.ts 可能不存在。
 * 因此在 build 阶段调用本函数生成 dist/guidance/schemas.gen.json，
 * 运行时优先读该 JSON 产物，命中则直接返回 schema 文本；未命中再降级回
 * injectSchema（开发时无 build 产物仍可工作）。
 *
 * key 格式：`${scope}:${action}`（如 `wave:clarify` / `slice:plan`）。四层可能有同名 action
 * 但不同 input interface（如 plan：wave=PlanInput、slice=PlanSliceInput），用 scope 前缀避免同名 key 冲突。
 * 读取侧（readSchemaText / 四层 get*SchemaText）必须用同样的 `${scope}:${action}` key 查缓存。
 *
 * @returns `${scope}:${action}` → SchemaGenEntry 的映射对象。
 */
export function buildSchemaGenFile(): Record<string, SchemaGenEntry> {
  const result: Record<string, SchemaGenEntry> = {};
  // 合并四层 schema 表。各层 *ACTION_SCHEMA 的元素类型均为 { sourceFilePath, interfaceName } | undefined，
  // 结构同构，用 SchemaSource 收敛（schema-injector 不关心各层 scope 语义，只负责提取 schema 文本）。
  const allSources: ReadonlyArray<[scope: string, table: Readonly<Record<string, SchemaSource | undefined>>]> = [
    ["wave", ACTION_SCHEMA],
    ["slice", SLICE_ACTION_SCHEMA],
    ["feature", FEATURE_ACTION_SCHEMA],
    ["epic", EPIC_ACTION_SCHEMA],
  ];
  for (const [scope, table] of allSources) {
    for (const [action, source] of Object.entries(table)) {
      if (source === undefined) {
        continue;
      }
      result[`${scope}:${action}`] = {
        sourceFilePath: source.sourceFilePath,
        interfaceName: source.interfaceName,
        schemaText: injectSchema(source.sourceFilePath, source.interfaceName),
      };
    }
  }
  return result;
}

/**
 * 定位预计算 schema 产物路径（dist/guidance/schemas.gen.json）。
 *
 * 本文件在 src/guidance/schema-injector.ts 或 dist/guidance/schema-injector.js 中运行，
 * 向上两层即项目根目录，再拼 dist/guidance/schemas.gen.json。
 *
 * 供四层 get*SchemaText 共享（提取 readSchemaText 后不再各写一份）。
 */
export function getSchemaGenFilePath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  // schema-injector.{ts,js} 与 schemas.gen.json 同在 guidance/ 目录
  // （src/guidance/ 开发态、dist/guidance/ 打包态），直接取同目录文件。
  return resolve(dirname(currentFile), "schemas.gen.json");
}

/** 从预计算 JSON 产物读取某条目的结构（与 buildSchemaGenFile 输出一致）。 */
interface SchemaGenFile {
  [key: string]: { schemaText: string } | undefined;
}

/** readSchemaText 的入参形态：source 缺失时用 flatHint 兜底（无结构化 schema 的 action）。 */
interface ReadSchemaTextArgs {
  /** scope 前缀（wave/slice/feature/epic），用于拼缓存 key `${scope}:${action}`。 */
  scope: string;
  /** action 名（如 clarify/plan）。 */
  action: string;
  /** 该 action 的 schema 来源（结构化 input）；undefined 表示无结构化 schema。 */
  source: SchemaSource | undefined;
  /** 无结构化 schema 时的扁平参数提示文本。 */
  flatHint: string;
  /** 模块级缓存 Map（四层各自一份，避免跨 scope 串扰 + 避免改各层已 export 的缓存名）。 */
  cache: Map<string, string>;
}

/**
 * 读缓存优先的 schema 文本（四层 get*SchemaText 共享）。
 *
 * 优先级：
 *   1. 命中 cache（同一 `${scope}:${action}` 第二次调用直接返回）；
 *   2. 命中 dist/guidance/schemas.gen.json 中 `${scope}:${action}` 条目 → 返回产物 schemaText；
 *   3. 降级到 injectSchema 实时解析 src/core/*.ts（开发时无 build 产物）；
 *   4. source 为 undefined（无结构化 schema）→ 用 flatHint；injectSchema 抛错时返回兜底提示文本。
 *
 * 缓存 key 用 `${scope}:${action}`（与 buildSchemaGenFile 的 key 格式一致），四层共享同一份 schemas.gen.json。
 * schema 是静态的，模块级缓存安全（整个进程只读一次源文件 / JSON）。
 *
 * 不抛错：schema 是给 agent 看的辅助信息，缺失只降级体验，不阻断 guidance。
 */
export function readSchemaText({
  scope,
  action,
  source,
  flatHint,
  cache,
}: ReadSchemaTextArgs): string {
  const cacheKey = `${scope}:${action}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  let text: string;
  if (source === undefined) {
    // 无结构化 schema 的 action（create / execute / replan / abort）：用扁平参数提示。
    text = flatHint ?? "（无结构化 input schema）";
  } else {
    const genPath = getSchemaGenFilePath();
    if (existsSync(genPath)) {
      try {
        const genFile = JSON.parse(readFileSync(genPath, "utf-8")) as SchemaGenFile;
        const entry = genFile[cacheKey];
        if (entry?.schemaText !== undefined) {
          text = entry.schemaText;
        } else {
          text = injectSchema(source.sourceFilePath, source.interfaceName);
        }
      } catch {
        text = injectSchema(source.sourceFilePath, source.interfaceName);
      }
    } else {
      try {
        text = injectSchema(source.sourceFilePath, source.interfaceName);
      } catch {
        // 降级：源文件缺失或 interface 不存在时给出可读提示，不阻断 guidance。
        text = `（无法从 ${source.sourceFilePath} 提取 ${source.interfaceName} schema，请检查源文件）`;
      }
    }
  }
  cache.set(cacheKey, text);
  return text;
}

// ═══════════════════════════════════════════════════════════════
// 内部：解析
// ═══════════════════════════════════════════════════════════════

/** 收集 SourceFile 里所有 InterfaceDeclaration，按 name 索引。 */
function collectInterfaces(sourceFile: ts.SourceFile): Map<string, InterfaceDescriptor> {
  const map = new Map<string, InterfaceDescriptor>();
  function walk(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node)) {
      map.set(node.name.text, parseInterface(node, sourceFile));
    }
    ts.forEachChild(node, walk);
  }
  walk(sourceFile);
  return map;
}

/** 把 InterfaceDeclaration 解析成 InterfaceDescriptor。 */
function parseInterface(
  node: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile,
): InterfaceDescriptor {
  const members: MemberDescriptor[] = [];
  for (const member of node.members) {
    if (!ts.isPropertySignature(member)) {
      continue;
    }
    const name = member.name.getText(sourceFile);
    members.push({
      name,
      typeText: member.type?.getText(sourceFile) ?? "unknown",
      optional: member.questionToken !== undefined,
      jsDoc: extractJsDoc(member),
    });
  }

  const extendsNames: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const t of clause.types) {
      extendsNames.push(t.expression.getText(sourceFile));
    }
  }

  return { name: node.name.text, members, extendsNames };
}

/**
 * 提取 PropertySignature 上的 JSDoc 注释（取第一段 comment 文本）。
 *
 * setParentNodes=true 时 createSourceFile 在节点上填充 jsDoc 数组（TS 内部 NodeObject 持有），
 * 但 ts.PropertySignature 类型层未公开声明此属性——通过 NodeWithJsDoc 命名接口单次断言收窄
 * （避免 as unknown as 双重断言 + 避免全可选结构断言，符合 taste/no-unsafe-cast）。
 */
function extractJsDoc(member: ts.PropertySignature): string {
  const docs = (member as NodeWithJsDoc).jsDoc;
  if (!docs || docs.length === 0) {
    return "";
  }
  const comment = docs[0]?.comment;
  if (typeof comment === "string") {
    return comment.trim();
  }
  if (Array.isArray(comment)) {
    return comment.join(" ").trim();
  }
  return "";
}

// ═══════════════════════════════════════════════════════════════
// 内部：渲染
// ═══════════════════════════════════════════════════════════════

/** 缩进单位：2 个空格（与 core TS 源码缩进一致）。 */
const INDENT_UNIT = "  ";

/** 按 depth 生成缩进前缀（depth=0 → 1 个单位，逐层 +1）。 */
function indentFor(depth: number): string {
  return INDENT_UNIT.repeat(depth + 1);
}

/** 退回一级缩进（内联展开的闭合括号对齐外层）。 */
function unindent(indent: string): string {
  return indent.slice(0, -INDENT_UNIT.length);
}

/**
 * 渲染单个 interface 为 schema 行（递归展开引用类型）。
 *
 * @param itf 目标 interface
 * @param all 同文件所有 interface（按需展开引用）
 * @param depth 缩进深度
 * @param visiting 正在展开的 interface 名栈（防循环引用）
 * @returns schema 行数组（已含缩进）
 */
function renderInterface(
  itf: InterfaceDescriptor,
  all: Map<string, InterfaceDescriptor>,
  depth: number,
  visiting: Set<string>,
): string[] {
  // 先收集「有效字段」：extends 的父字段（递归补）+ 自身字段。
  const ordered = resolveMembers(itf, all, visiting);
  const lines: string[] = [];
  const lastIndex = ordered.length - 1;
  ordered.forEach((m, i) => {
    const comma = i === lastIndex ? "" : ",";
    lines.push(renderMember(m, all, depth, visiting) + comma);
  });
  return lines;
}

/**
 * 解析 interface 的最终字段集：extends 链的字段在前（先父后子），自身字段在后。
 * 同名字段子覆盖父（TS 语义，这里按声明顺序后者覆盖）。
 */
function resolveMembers(
  itf: InterfaceDescriptor,
  all: Map<string, InterfaceDescriptor>,
  visiting: Set<string>,
): MemberDescriptor[] {
  const merged = new Map<string, MemberDescriptor>();

  // 先递归补 extends 的父 interface 字段（先父后子顺序）。
  for (const parentName of itf.extendsNames) {
    const parent = all.get(parentName);
    if (parent === undefined) {
      // 父 interface 不在当前文件（如跨文件 extends）——跳过，不补字段。
      // 本 topic 的 core interface 都同文件 extends，此处兜底不阻塞。
      continue;
    }
    if (visiting.has(parentName)) {
      // 循环 extends 防护（core 无此情况，防御性）。
      continue;
    }
    visiting.add(parentName);
    for (const m of resolveMembers(parent, all, visiting)) {
      merged.set(m.name, m);
    }
    visiting.delete(parentName);
  }

  // 自身字段覆盖父字段。
  for (const m of itf.members) {
    merged.set(m.name, m);
  }

  return [...merged.values()];
}

/**
 * 渲染单个字段为 schema 行（含缩进 + 可选标注 + 引用类型内联展开 + 注释）。
 */
function renderMember(
  m: MemberDescriptor,
  all: Map<string, InterfaceDescriptor>,
  depth: number,
  visiting: Set<string>,
): string {
  const indent = indentFor(depth);
  const optionalMark = m.optional ? "（可选）" : "";
  // 渲染为行内注释时去掉末尾句号（中英文），避免 `。,` / `..` 视觉杂音。
  const trimmedDoc = m.jsDoc.replace(/[.。]+$/, "");
  const commentSuffix = trimmedDoc !== "" ? ` // ${trimmedDoc}` : "";

  // 引用类型内联展开：字段类型文本恰好是另一个 interface 名 → 内联展开该 interface。
  const referenced = all.get(m.typeText);
  if (referenced !== undefined && !visiting.has(m.typeText)) {
    visiting.add(m.typeText);
    const innerLines = renderInterface(referenced, all, depth + 1, visiting);
    visiting.delete(m.typeText);
    // 内联：`"field（可选）": { ...inner... }`，闭合括号退回一级对齐外层。
    const open = `${indent}"${m.name}${optionalMark}": {`;
    const close = `${unindent(indent)}}`;
    return [open, ...innerLines, close].join("\n") + commentSuffix;
  }

  // 数组引用类型内联展开：`XxxType[]` → `[{ ...XxxType... }]`。
  const arrayRefMatch = matchArrayReference(m.typeText);
  if (arrayRefMatch !== null) {
    const refName = arrayRefMatch;
    const ref = all.get(refName);
    if (ref !== undefined && !visiting.has(refName)) {
      visiting.add(refName);
      const innerDepth = depth + 1;
      const innerLines = renderInterface(ref, all, innerDepth + 1, visiting);
      visiting.delete(refName);
      const innerIndent = indentFor(innerDepth);
      return [
        `${indent}"${m.name}${optionalMark}": [`,
        `${innerIndent}{`,
        ...innerLines,
        `${innerIndent}}`,
        `${indent}]${commentSuffix}`,
      ].join("\n");
    }
  }

  // 基础类型 / 联合 / 未识别引用：原样输出类型文本。
  return `${indent}"${m.name}${optionalMark}": ${m.typeText}${commentSuffix}`;
}

/**
 * 若 typeText 形如 `XxxName[]`（单层引用数组），返回引用名；否则返回 null。
 * 只匹配「标识符 + []」，不处理 `string[]`（string 是内置，不是可展开的 interface）。
 */
function matchArrayReference(typeText: string): string | null {
  const match = /^([A-Z][A-Za-z0-9_]*)\[\]$/.exec(typeText);
  return match === null ? null : match[1];
}
