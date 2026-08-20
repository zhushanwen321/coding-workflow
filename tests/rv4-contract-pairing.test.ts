/**
 * rv4 单测：契约比对配对化（docs/rewrite/acceptance/rv4-acceptance.md §5 T7-T9）。
 *
 * matchContracts 两道独立比对（第一道配对 consumer ≡ provider 冻结 + 第二道树内
 * 验证，任一 fail 即契约 fail）。真实 tmp 目录树（零 mock，无 git 依赖——
 * matchContracts 只读文件系统）：
 *   T7 → 配对漂移拦截（核心）：一字之差 fail，消息含两侧归一化文本；树内恰好
 *        命中也 fail（第一道独立）
 *   T8 → 无 provider 声明拦截：provider 从未冻结同 id 契约 → fail
 *   T9 → 一致通过 + self-provider 跳过：归一化等价（空白差异）过；provider=owner
 *        的 root 集成契约跳过配对、树内命中即过；同 id 多 owner 任一命中树内即过
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Contract } from "../src/events/types.js";
import { matchContracts, type OwnedContract } from "../src/verify/contract-match.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-rv4-pair-"));

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

/** owner=root 的 consumer 契约（rv-4 输入形态：全量带 owner，同 id 不去重） */
function owned(c: Contract, ownerUnitId = "root"): OwnedContract {
  return { contract: c, ownerUnitId };
}

// ── T7：配对漂移拦截（核心） ────────────────────────────────

describe("T7 漂移拦截：consumer 与 provider 冻结版一字之差 → 配对 fail，树内命中也 fail（第一道独立）", () => {
  const CONSUMER_SIG = "export function capitalize(";
  const PROVIDER_SIG = "export function capitalise("; // 一字之差（token 差异，非空白差异）

  /** T7 树：consumer 版签名恰好也在树内（file 定位命中）——证明 fail 只来自配对 */
  function makeTree(name: string): string {
    const tree = join(tmpRoot, name);
    put(tree, "src/calls.js", `// consumer 侧调用现场（含完整签名文本）\nconst ref = "${CONSUMER_SIG}s)";\n`);
    put(tree, "src/renderer.js", `${PROVIDER_SIG}s) { return s; }\n`);
    return tree;
  }

  it("配对 fail：消息含「契约漂移」与两侧归一化文本（owner 侧与 provider 冻结侧）", () => {
    const result = matchContracts({
      contracts: [owned(contract({ signature: CONSUMER_SIG, file: "src/calls.js" }))],
      frozenByUnit: new Map([
        ["root", [contract({ signature: CONSUMER_SIG })]],
        ["leaf-a", [contract({ signature: PROVIDER_SIG })]],
      ]),
      checkoutDir: makeTree("t7-drift"),
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("契约漂移");
    expect(result.failures[0]).toContain("C1");
    // 两侧归一化文本都在消息里（归属判断需要对照两侧）
    expect(result.failures[0]).toContain(CONSUMER_SIG);
    expect(result.failures[0]).toContain(PROVIDER_SIG);
    expect(result.failures[0]).toContain("恢复动作");
  });

  it("树内恰好命中也 fail：同一棵树把 frozen 换成一致版 → ok=true（对照证明树内确实命中，fail 只来自配对）", () => {
    // 对照 1：frozen 一致（provider 冻结 = consumer 签名）→ 配对过 + 树内命中 → pass
    const consistent = matchContracts({
      contracts: [owned(contract({ signature: CONSUMER_SIG, file: "src/calls.js" }))],
      frozenByUnit: new Map([
        ["root", [contract({ signature: CONSUMER_SIG })]],
        ["leaf-a", [contract({ signature: CONSUMER_SIG })]],
      ]),
      checkoutDir: makeTree("t7-consistent"),
    });
    expect(consistent.ok).toBe(true);
    expect(consistent.failures).toEqual([]);

    // 对照 2（主断言的树内事实）：不传 frozenByUnit（只跑树内）→ 同树命中 → pass
    // ——T7 主用例的 fail 不可能来自树内，只能来自配对第一道
    const treeOnly = matchContracts({
      contracts: [owned(contract({ signature: CONSUMER_SIG, file: "src/calls.js" }))],
      checkoutDir: makeTree("t7-tree-only"),
    });
    expect(treeOnly.ok).toBe(true);
  });
});

// ── T8：无 provider 声明拦截 ────────────────────────────────

describe("T8 无 provider 声明：provider 冻结 spec 从未声明此 id → fail", () => {
  it("frozenByUnit 无该 provider（或同 id 缺位）→ fail「契约无 provider 声明」+ 恢复动作", () => {
    const tree = join(tmpRoot, "t8-no-declare");
    put(tree, "src/renderer.js", "export function capitalize(s) { return s; }\n");

    // 形态 1：provider unit 的契约集整体缺失
    const missing = matchContracts({
      contracts: [owned(contract({ provider: "leaf-x" }))],
      frozenByUnit: new Map([["root", [contract({ provider: "leaf-x" })]]]),
      checkoutDir: tree,
    });
    expect(missing.ok).toBe(false);
    expect(missing.failures[0]).toContain("C1");
    expect(missing.failures[0]).toContain("契约无 provider 声明");
    expect(missing.failures[0]).toContain("leaf-x");
    expect(missing.failures[0]).toContain("恢复动作");

    // 形态 2：provider unit 有契约集但无同 id（声明了别的契约，没声明 C1）
    const noId = matchContracts({
      contracts: [owned(contract({ provider: "leaf-x" }))],
      frozenByUnit: new Map([
        ["root", [contract({ provider: "leaf-x" })]],
        ["leaf-x", [contract({ id: "OTHER", provider: "leaf-x", signature: "export const x = 1;" })]],
      ]),
      checkoutDir: tree,
    });
    expect(noId.ok).toBe(false);
    expect(noId.failures[0]).toContain("契约无 provider 声明");
  });
});

// ── T9：一致通过 + self-provider 跳过 ────────────────────────

describe("T9 一致通过 + self-provider 跳过：归一化等价过配对；provider=owner 跳过配对、树内命中即过", () => {
  // 归一化等价的构造口径：provider 冻结版是换行/缩进形态，consumer 侧是单行
  // 形态——空白折叠（连续空白 → 单空格）+ trim 后全等（token 间零空格 vs 单
  // 空格的差异不是归一化可消除的，故不用那种形态）
  const SIG_SINGLE_LINE = "export function capitalize(s: string)";
  const SIG_MULTI_LINE = "export function\ncapitalize(s:\n    string)";

  it("consumer ≡ provider 冻结（空白风格差异）→ 配对过 + 树内命中 → pass", () => {
    const tree = join(tmpRoot, "t9-equiv");
    put(tree, "src/capitalize.js", `${SIG_MULTI_LINE} { return s.toUpperCase(); }\n`);
    const result = matchContracts({
      contracts: [owned(contract({ signature: SIG_SINGLE_LINE, file: "src/capitalize.js" }))],
      frozenByUnit: new Map([
        ["root", [contract({ signature: SIG_SINGLE_LINE })]],
        ["leaf-a", [contract({ signature: SIG_MULTI_LINE })]],
      ]),
      checkoutDir: tree,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("root 自声明契约（provider=root 自身）→ 跳过配对（无外部承诺可比对）、树内命中 → pass", () => {
    const tree = join(tmpRoot, "t9-self-provider");
    put(tree, "src/integration.js", "export function orchestrate() { return 1; }\n");
    const result = matchContracts({
      contracts: [
        owned(
          contract({ id: "R1", provider: "root", signature: "export function orchestrate(" }),
          "root",
        ),
      ],
      // frozenByUnit 不含 root 的 R1 也不影响——self-provider 不进配对
      frozenByUnit: new Map(),
      checkoutDir: tree,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("同 id 多 owner（去重废除后的并存形态）：任一 owner 版本树内命中即该 id 树内过；全未命中才逐条 fail", () => {
    // root 版签名不在树内（漂移文本），child 版命中 → 树内过；配对两侧一致 → 整体 pass
    const hitTree = join(tmpRoot, "t9-multi-hit");
    put(hitTree, "src/renderer.js", "export function capitalize(s) { return s; }\n");
    const childSig = "export function capitalize(";
    const rootSig = "export function capitalise("; // root 记错版（树内不存在）
    const hit = matchContracts({
      contracts: [
        owned(contract({ signature: rootSig }), "root"),
        owned(contract({ signature: childSig }), "leaf-a"),
      ],
      // root 版 provider=leaf-a → 与 leaf-a 冻结版（childSig）配对：一字差 → fail
      frozenByUnit: new Map([
        ["root", []],
        ["leaf-a", [contract({ signature: childSig })]],
      ]),
      checkoutDir: hitTree,
    });
    // 配对拦截（canon A-7 残余条款：同 id 冲突显性化——root 版与 child 冻结版比对失败）
    expect(hit.ok).toBe(false);
    expect(hit.failures).toHaveLength(1);
    expect(hit.failures[0]).toContain("契约漂移");
    expect(hit.failures[0]).toContain(rootSig);
    expect(hit.failures[0]).toContain(childSig);

    // 对照：把 root 版 provider 改为 root 自身（self-provider 跳过配对）→ 树内
    // 同 id 任一命中（child 版命中）即过 → 整体 pass（多 owner 并存不再丢条目）
    const pass = matchContracts({
      contracts: [
        owned(contract({ signature: rootSig, provider: "root" }), "root"),
        owned(contract({ signature: childSig }), "leaf-a"),
      ],
      frozenByUnit: new Map([["leaf-a", [contract({ signature: childSig })]]]),
      checkoutDir: hitTree,
    });
    expect(pass.ok).toBe(true);
    expect(pass.failures).toEqual([]);
  });

  it("空契约列表 → ok=true（无承诺需要配对）", () => {
    const tree = join(tmpRoot, "t9-empty");
    put(tree, "src/util.js", "export const x = 1;\n");
    const empty = matchContracts({
      contracts: [],
      frozenByUnit: new Map(),
      checkoutDir: tree,
    });
    expect(empty.ok).toBe(true);
    expect(empty.failures).toEqual([]);
  });
});
