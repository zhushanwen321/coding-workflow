/**
 * rv3 单测：契约比对强化——文档宿主排除 + 归一化比对
 * （docs/rewrite/acceptance/rv3-acceptance.md §5 条款 T1-T8）。
 *
 * rv-4 语义迁移：契约输入结构改带 owner（OwnedContract[]，废除同 id root 优先
 * 去重）；本文件锁定的树内验证语义不传 frozenByUnit（配对第一道由
 * tests/rv4-contract-pairing.test.ts 专项覆盖——rv-3 行为零回退的回归锚点在此）。
 *
 * 真实 tmp 目录树（零 mock，无 git 依赖——matchContracts 只读文件系统）。
 * 用例编号 T1-T8 逐条对应验收文档 §5：
 *   T1 → README 作弊封堵；T2 → docs/ 目录排除；T3 → 显式 file 指向文档的两态区分；
 *   T4 → 归一化命中；T5 → 严格性不回退（大小写/token）；T6 → 空白折叠等价；
 *   T7 → schema 宿主保留；T8 → u8 既有场景回归。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Contract } from "../src/events/types.js";
import { matchContracts, type OwnedContract } from "../src/verify/contract-match.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rv3-cm-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 写文件（自动建父目录），fixture 全部走真实文件系统 */
function put(dir: string, rel: string, content: string | Buffer): string {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function contract(fields: Partial<Contract> = {}): Contract {
  return {
    id: "C1",
    kind: "function",
    provider: "leaf-a",
    consumer: "root",
    signature: "export function capitalize(",
    ...fields,
  };
}

/** rv-4 输入形态：契约带 owner（owner=root = consumer 声明视角，与旧语义等价） */
function owned(c: Contract): OwnedContract {
  return { contract: c, ownerUnitId: "root" };
}

// ── T1：README 作弊封堵 ──────────────────────────────────────

describe("T1：README.md 含 signature 全文、代码不含 → 全树搜索不命中；签名进代码文件 → 命中", () => {
  const SIG = "export function capitalize(";

  it("签名只写在 README.md → ok=false 且 failure 含恢复动作（README 不再是合法宿主）", () => {
    const tree = join(tmpRoot, "t1-readme-cheat");
    put(tree, "README.md", `# demo\n\n契约签名：${SIG}s) { return s; }\n`);
    put(tree, "src/util.ts", "export const version = 1;\n");

    const result = matchContracts({ contracts: [owned(contract())], checkoutDir: tree });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("C1");
    expect(result.failures[0]).toContain("恢复动作");
  });

  it("对照：同一签名放进 src/foo.ts → 命中", () => {
    const tree = join(tmpRoot, "t1-code-host");
    put(tree, "README.md", "# demo\n");
    put(tree, "src/foo.ts", `${SIG}s: string) { return s; }\n`);

    const result = matchContracts({ contracts: [owned(contract())], checkoutDir: tree });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ── T2：docs/ 目录排除 ───────────────────────────────────────

describe("T2：签名只出现在 docs/guide.md → 全树搜索不命中", () => {
  it("docs/ 目录整棵不入搜索，签名在 docs/guide.md → ok=false", () => {
    const SIG = "export function capitalize(";
    const tree = join(tmpRoot, "t2-docs-dir");
    put(tree, "docs/guide.md", `# 集成指南\n\n${SIG}s) { ... }\n`);
    put(tree, "src/util.ts", "export const version = 1;\n");

    const result = matchContracts({ contracts: [owned(contract())], checkoutDir: tree });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("C1");
  });
});

// ── T3：显式 file 指向文档（两态区分） ───────────────────────

describe("T3：显式 file 指向文档类 → 「不是契约宿主」形态而非「文件不存在」形态", () => {
  it('file: "README.md" 且 README 含签名 → failure 指明文档类文件不是契约宿主，不含「不存在」措辞', () => {
    const SIG = "export function capitalize(";
    const tree = join(tmpRoot, "t3-file-readme");
    put(tree, "README.md", `${SIG}s) { return s; }\n`);

    const result = matchContracts({
      contracts: [owned(contract({ file: "README.md" }))],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("C1");
    expect(result.failures[0]).toContain("不是契约宿主");
    expect(result.failures[0]).not.toContain("不存在");
    expect(result.failures[0]).toContain("恢复动作");
  });

  it("宿主资格先于存在性：file 指向 docs/guide.md 且该文件不存在 → 仍是「不是契约宿主」形态", () => {
    const tree = join(tmpRoot, "t3-file-docs-absent");
    put(tree, "src/util.ts", "export const version = 1;\n");

    const result = matchContracts({
      contracts: [owned(contract({ file: "docs/guide.md" }))],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("不是契约宿主");
    expect(result.failures[0]).not.toContain("不存在");
  });

  it('对照：file: "src/api.ts" 含签名 → 过', () => {
    const SIG = "export function capitalize(";
    const tree = join(tmpRoot, "t3-file-code");
    put(tree, "src/api.ts", `${SIG}s: string) { return s; }\n`);

    const result = matchContracts({
      contracts: [owned(contract({ file: "src/api.ts" }))],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ── T4：归一化命中（多行签名形态） ───────────────────────────

describe("T4：代码中签名为多行形态、契约 signature 为单行形态 → 归一化后命中", () => {
  // 代码形态：换行 + 缩进；契约形态：单行。归一化（连续空白折叠为单空格）后两者等价。
  // 注：旧的字节级包含语义下，单行 signature 不会作为字节串出现在多行代码中 → 会 miss
  //（本条款正是归一化升级的回归锚点）。
  const CODE_MULTI_LINE =
    "export function calc(\n  a: number,\n  b: number,\n): number {\n  return a + b;\n}\n";
  const SIG_SINGLE_LINE = "export function calc( a: number, b: number, ): number {";

  it("file 路径：期望文件含多行形态、契约为单行 → 命中", () => {
    const tree = join(tmpRoot, "t4-norm-file");
    put(tree, "src/calc.ts", CODE_MULTI_LINE);

    const result = matchContracts({
      contracts: [owned(contract({ signature: SIG_SINGLE_LINE, file: "src/calc.ts" }))],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("全树搜索路径：同样归一化后命中", () => {
    const tree = join(tmpRoot, "t4-norm-tree");
    put(tree, "src/calc.ts", CODE_MULTI_LINE);
    put(tree, "README.md", "# demo\n");

    const result = matchContracts({
      contracts: [owned(contract({ signature: SIG_SINGLE_LINE }))],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ── T5：严格性不回退（不做大小写折叠、不做 token 化） ────────

describe("T5：大小写差异与 token 差异 → 仍不命中", () => {
  it("大小写：契约 fooBar( vs 代码 foobar( → 不命中（归一化只折叠空白，不折叠大小写）", () => {
    const tree = join(tmpRoot, "t5-case");
    put(tree, "src/util.ts", "export function foobar(s: string) { return s; }\n");

    const result = matchContracts({
      contracts: [owned(contract({ signature: "export function fooBar(" }))],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
  });

  it("token：契约 sluggify(a,b) vs 代码 sluggify(a, c,b) → 不命中（不做 token 化，多了 c 不是等价空白差异）", () => {
    const tree = join(tmpRoot, "t5-token");
    put(tree, "src/sluggify.ts", "export function sluggify(a, c,b) { return b; }\n");

    const result = matchContracts({
      contracts: [owned(contract({ signature: "sluggify(a,b)", file: "src/sluggify.ts" }))],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("C1");
  });
});

// ── T6：空白折叠等价 ─────────────────────────────────────────

describe("T6：代码 foo(a,  b)（多空格）vs 契约 foo(a, b) → 命中", () => {
  it("空白数量差异折叠后等价 → 命中", () => {
    const tree = join(tmpRoot, "t6-ws");
    put(tree, "src/util.ts", "export function parse(foo(a,  b) { return b; })\n");

    const result = matchContracts({
      contracts: [owned(contract({ signature: "foo(a, b)", file: "src/util.ts" }))],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ── T7：schema 宿主保留（未被文档排除误伤） ──────────────────

describe("T7：.json/.yaml 文件含签名（kind=schema）→ 仍命中", () => {
  const SIG = '"type": "object", "properties": { "name": { "type": "string" } }';

  it("file: schemas/config.json 含签名 → 过（.json 是 schema 契约合法宿主）", () => {
    const tree = join(tmpRoot, "t7-json-file");
    put(tree, "schemas/config.json", `{\n  ${SIG},\n  "additionalProperties": false\n}\n`);

    const result = matchContracts({
      contracts: [
        owned(contract({ id: "S1", kind: "schema", signature: SIG, file: "schemas/config.json" })),
      ],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("全树搜索：签名只在 config/schema.yaml → 命中", () => {
    const yamlSig = "properties:\n  name:\n    type: string";
    const tree = join(tmpRoot, "t7-yaml-tree");
    put(tree, "config/schema.yaml", `${yamlSig}\n`);
    put(tree, "src/util.ts", "export const version = 1;\n");

    const result = matchContracts({
      contracts: [owned(contract({ id: "S2", kind: "schema", signature: yamlSig }))],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ── T8：既有回归（u8 契约场景在新语义下保持） ────────────────

describe("T8：u8 契约单测核心场景在新语义下保持（u8 系既有测试文件全绿由 §6 命令另行验证）", () => {
  const SIG = "export function capitalize(";

  it("file 定位命中 / 多契约不短路 / 空契约 ok 语义不变", () => {
    const tree = join(tmpRoot, "t8-regression");
    put(tree, "src/capitalize.js", `// util\n${SIG}s) {\n  return s.toUpperCase();\n}\n`);
    put(tree, "src/other.js", "export const x = 1;\n");
    put(tree, "README.md", "# demo\n");

    const hit = matchContracts({
      contracts: [owned(contract({ file: "src/capitalize.js" }))],
      checkoutDir: tree,
    });
    expect(hit.ok).toBe(true);

    const multi = matchContracts({
      contracts: [
        owned(contract({ id: "C1", file: "src/capitalize.js" })),
        owned(contract({ id: "C2", signature: "export function sluggify(", file: "src/nope.js" })),
      ],
      checkoutDir: tree,
    });
    expect(multi.ok).toBe(false);
    expect(multi.failures).toHaveLength(1);
    expect(multi.failures[0]).toContain("C2");

    const empty = matchContracts({ contracts: [], checkoutDir: tree });
    expect(empty.ok).toBe(true);
    expect(empty.failures).toEqual([]);
  });

  it("全树搜索命中深层目录文件（非文档扩展）/ node_modules 与二进制跳过语义不变", () => {
    // 深层命中：签名只在 pkg/deep/hidden.dat（非文档类扩展）
    const deepTree = join(tmpRoot, "t8-deep");
    put(deepTree, "src/util.ts", "export const version = 1;\n");
    put(deepTree, "pkg/deep/hidden.dat", `promise: ${SIG}\n`);
    const deep = matchContracts({ contracts: [owned(contract())], checkoutDir: deepTree });
    expect(deep.ok).toBe(true);

    // 跳过：签名只出现在 node_modules 诱饵与二进制中 → 不命中
    const skipTree = join(tmpRoot, "t8-skip");
    put(skipTree, "src/util.ts", "export const version = 1;\n");
    put(skipTree, "node_modules/evil/decoy.js", `${SIG}s) {}\n`);
    put(
      skipTree,
      "asset.bin",
      Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x00]), Buffer.from(`\n${SIG}\n`)]),
    );
    const skipped = matchContracts({ contracts: [owned(contract())], checkoutDir: skipTree });
    expect(skipped.ok).toBe(false);
    expect(skipped.failures[0]).toContain("C1");
  });
});
