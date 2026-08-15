/**
 * u8 单测：契约机器比对 matchContracts
 * （docs/rewrite/acceptance/u8-acceptance.md「单测验收」第 1 组，6 条）。
 *
 * 真实 tmp 目录树（零 mock，无 git 依赖——matchContracts 只读文件系统）。
 * 用例编号「验收N」逐条对应验收文档：
 *   验收1/2 → file 定位命中/未命中；验收3/4 → 全树搜索命中/未命中；
 *   验收5 → node_modules 与二进制跳过；验收6 → 多契约不短路 + 空契约 ok。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Contract } from "../src/events/types.js";
import { matchContracts } from "../src/verify/contract-match.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-u8-cm-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const CAP_SIG = "export function capitalize(";

function contract(fields: Partial<Contract> = {}): Contract {
  return {
    id: "C1",
    kind: "function",
    provider: "leaf-a",
    consumer: "root",
    signature: CAP_SIG,
    ...fields,
  };
}

/** 标准 fixture 树：src/capitalize.js 含契约签名；另有深层/干扰文件 */
function makeTree(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "pkg", "deep"), { recursive: true });
  writeFileSync(join(dir, "src", "capitalize.js"), `// util\n${CAP_SIG}s) {\n  return s.toUpperCase();\n}\n`);
  writeFileSync(join(dir, "pkg", "deep", "other.js"), "export const x = 1;\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  return dir;
}

// ── 验收1：file 定位命中 ─────────────────────────────────────

describe("验收1：契约含 file → signature 在该文件中 → 过", () => {
  it("src/capitalize.js 含签名文本 → ok=true 且无 failures", () => {
    const tree = makeTree("file-hit");
    const result = matchContracts({
      contracts: [contract({ file: "src/capitalize.js" })],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ── 验收2：file 定位未命中 ───────────────────────────────────

describe("验收2：契约含 file → 未命中 → 失败含契约 id、文件路径与恢复动作", () => {
  it("signature 不在期望文件 / 期望文件不存在 → 两种未命中都指明 C1 与路径", () => {
    const miss = matchContracts({
      contracts: [contract({ signature: "export function capitalise(", file: "src/capitalize.js" })],
      checkoutDir: makeTree("file-miss"),
    });
    expect(miss.ok).toBe(false);
    expect(miss.failures).toHaveLength(1);
    expect(miss.failures[0]).toContain("C1");
    expect(miss.failures[0]).toContain("src/capitalize.js");
    expect(miss.failures[0]).toContain("恢复动作");

    const absent = matchContracts({
      contracts: [contract({ file: "src/nope.js" })],
      checkoutDir: makeTree("file-missing"),
    });
    expect(absent.ok).toBe(false);
    expect(absent.failures[0]).toContain("C1");
    expect(absent.failures[0]).toContain("src/nope.js");
    expect(absent.failures[0]).toContain("恢复动作");
  });
});

// ── 验收3：全树搜索命中（无 file 字段） ───────────────────────

describe("验收3：契约缺 file → 全树文本搜索命中深层目录文件 → 过", () => {
  it("签名在 pkg/deep/hidden.txt（非代码路径）中 → ok=true", () => {
    const tree = makeTree("tree-hit");
    writeFileSync(join(tree, "pkg", "deep", "hidden.txt"), `promise: ${CAP_SIG}\n`);
    const result = matchContracts({ contracts: [contract()], checkoutDir: tree });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

// ── 验收4：全树搜索未命中 ────────────────────────────────────

describe("验收4：契约缺 file → 全树未命中 → 失败含契约 id 与恢复动作", () => {
  it("树内无任何文件含签名 → ok=false，failure 指明 C1", () => {
    const tree = makeTree("tree-miss");
    writeFileSync(join(tree, "src", "capitalize.js"), "// util\nexport function capitalise(s) {\n  return s;\n}\n");
    const result = matchContracts({
      contracts: [contract({ signature: "export function capitalize(" })],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("C1");
    expect(result.failures[0]).toContain("恢复动作");
  });
});

// ── 验收5：node_modules 与二进制跳过（树内放置 fixture 验证） ──

describe("验收5：全树搜索跳过 node_modules 与二进制文件", () => {
  it("签名只存在于 node_modules 诱饵与二进制文件中 → 仍判未命中（跳过即不产生假阳性）", () => {
    const tree = makeTree("skip-dirs");
    writeFileSync(join(tree, "src", "capitalize.js"), "// util（签名已漂移）\nexport function capitalise(s) {\n  return s;\n}\n");
    mkdirSync(join(tree, "node_modules", "evil"), { recursive: true });
    writeFileSync(join(tree, "node_modules", "evil", "decoy.js"), `${CAP_SIG}s) {}\n`);
    // 二进制文件：前段含 NUL 字节，尾部夹带签名文本
    const binary = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x00]), Buffer.from(`\n${CAP_SIG}\n`)]);
    writeFileSync(join(tree, "asset.bin"), binary);

    const result = matchContracts({ contracts: [contract()], checkoutDir: tree });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("C1");
    // 反证：去掉诱饵后同一签名在同结构树中可全树命中（跳过规则没有把正常文件也跳掉）
    const cleanTree = makeTree("skip-dirs-control");
    mkdirSync(join(cleanTree, "node_modules", "evil"), { recursive: true });
    writeFileSync(join(cleanTree, "node_modules", "evil", "decoy.js"), "export const y = 2;\n");
    const control = matchContracts({ contracts: [contract()], checkoutDir: cleanTree });
    expect(control.ok).toBe(true);
  });
});

// ── 验收6：多契约不短路 + 空契约 ok ──────────────────────────

describe("验收6：多契约独立判定不短路；空契约列表 → ok=true", () => {
  it("一挂一带 → failures 恰一条且只指向未命中契约；空列表 → ok", () => {
    const tree = makeTree("multi");
    const result = matchContracts({
      contracts: [
        contract({ id: "C1", signature: "export function capitalize(", file: "src/capitalize.js" }),
        contract({ id: "C2", signature: "export function sluggify(", file: "src/sluggify.js" }),
      ],
      checkoutDir: tree,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("C2");
    expect(result.failures[0]).not.toContain("C1 未命中");

    const empty = matchContracts({ contracts: [], checkoutDir: makeTree("empty") });
    expect(empty.ok).toBe(true);
    expect(empty.failures).toEqual([]);
  });
});
