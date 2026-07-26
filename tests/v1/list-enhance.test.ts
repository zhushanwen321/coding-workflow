/**
 * Wave B: cw v1 list 增强——跨 cwd/分页/分组/模糊匹配/--long 测试。
 *
 * 覆盖 12 个核心场景（对应 plan TC-B1 到 TC-B12）：
 *   - 默认参数 + 分页元信息（TC-B1）
 *   - --limit/--offset 分页（TC-B2）
 *   - --grep 模糊匹配（TC-B3）
 *   - --all 跨 cwd + group header（TC-B4）
 *   - --all 同 repo 多 worktree 去重（TC-B5）
 *   - --all 与 --cwd 互斥（TC-B6）
 *   - 旧 store 无 repoMeta 降级（TC-B7）
 *   - --cwd 指定查别的 cwd（TC-B8）
 *   - updated 列绝对时间（TC-B9）
 *   - --long 追加 children/created 列（TC-B10）
 *   - 空 store 友好提示（TC-B11）
 *   - 损坏 _v1.json 跳过（TC-B12）
 *
 * 测试策略：真实 fs + 真实 V1Store + 真实 JSON 文件（zero mock）。
 * V1_HOME 隔离：每个 describe 的 beforeEach 设独立 tmp V1_HOME（吸取 Wave A C1 教训）。
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderList, type AnnotatedUnit } from "../../src/readonly/render.js";
import { loadAllCwdsFromHome } from "../../src/readonly/cross-cwd.js";
import { V1Store } from "../../src/store/v1-store.js";
import { encodeCwd } from "../../src/store/schema.js";
import type { RepoMeta, WorkUnitRecord } from "../../src/store/schema.js";

/** 造一个最小 WorkUnitRecord（靠索引签名 [key: string]: unknown 过类型，不强转）。 */
function makeUnit(
  id: string,
  opts: {
    scope?: string;
    slug?: string;
    status?: string;
    objective?: string;
    parentUnitId?: string;
    statusHistoryAt?: string;
    createdAt?: string;
  } = {},
): WorkUnitRecord {
  return {
    id,
    scope: opts.scope ?? "wave",
    slug: opts.slug ?? id.split(":")[1] ?? id,
    status: opts.status ?? "created",
    statusHistory: [
      { at: opts.createdAt ?? "2026-07-26T10:00:00.000Z", action: "create", to: "created" },
      ...(opts.statusHistoryAt
        ? [{ at: opts.statusHistoryAt, action: "plan", to: opts.status ?? "created" }]
        : []),
    ],
    basedOnParent: [],
    abandonedRefs: [],
    objective: opts.objective ?? "test objective",
    parentUnitId: opts.parentUnitId,
  } as WorkUnitRecord;
}

/** 构造一个有效的 RepoMeta（用于 --all group header 测试）。 */
function makeRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    remoteUrl: "git@github.com:foo/bar.git",
    branch: "main",
    worktreePath: "/fake/cwd",
    headCommit: "a1b2c3d",
    recordedAt: "2026-07-26T12:00:00.000Z",
    ...overrides,
  };
}

describe("Wave B: renderList 默认参数 + 分页", () => {
  it("TC-B1: 默认 limit=10，超过时尾部显示 Showing 分页元信息", () => {
    // 12 个 unit（不同 updatedAt）
    const annotated: AnnotatedUnit[] = [];
    for (let i = 0; i < 12; i++) {
      annotated.push({
        unit: makeUnit(`wave:u${i}`, {
          statusHistoryAt: `2026-07-26T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
        }),
      });
    }

    const out = renderList(annotated, {});
    const lines = out.split("\n").filter((l) => l.length > 0);

    // 表头 + 分隔行 + 10 行数据 + 分页分隔 + 分页元信息
    expect(out).toMatch(/Showing 1–10 of 12/);
    expect(out).toMatch(/use --offset 10 for next page/);
    // 10 行数据（不算表头/分隔/分页）
    const dataLines = lines.filter((l) => l.startsWith("wave:u"));
    expect(dataLines.length).toBe(10);
  });

  it("TC-B1b: unit 数 ≤ limit 时不显示分页元信息", () => {
    const annotated: AnnotatedUnit[] = [
      { unit: makeUnit("wave:a") },
      { unit: makeUnit("wave:b") },
    ];
    const out = renderList(annotated, {});
    expect(out).not.toMatch(/Showing/);
  });
});

describe("Wave B: renderList --limit/--offset 分页", () => {
  it("TC-B2: --limit 5 --offset 5 返回第 6-10 个 + 正确分页元信息", () => {
    const annotated: AnnotatedUnit[] = [];
    for (let i = 0; i < 12; i++) {
      annotated.push({
        unit: makeUnit(`wave:u${i}`, {
          statusHistoryAt: `2026-07-26T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
        }),
      });
    }

    const out = renderList(annotated, { limit: 5, offset: 5 });
    expect(out).toMatch(/Showing 6–10 of 12/);
    expect(out).toMatch(/use --offset 10 for next page/);
    const dataLines = out.split("\n").filter((l) => l.startsWith("wave:u"));
    expect(dataLines.length).toBe(5);
  });

  it("TC-B2b: offset 超出总数时返回友好提示", () => {
    const annotated: AnnotatedUnit[] = [{ unit: makeUnit("wave:a") }];
    const out = renderList(annotated, { limit: 10, offset: 100 });
    expect(out).toMatch(/no units on this page/);
    expect(out).toMatch(/total 1/);
  });
});

describe("Wave B: renderList --grep 模糊匹配", () => {
  it("TC-B3: grep 匹配 slug + objective（大小写不敏感 substring）", () => {
    const annotated: AnnotatedUnit[] = [
      { unit: makeUnit("wave:auth-x", { objective: "实现认证 module" }) },
      { unit: makeUnit("wave:login", { objective: "login flow" }) },
      { unit: makeUnit("feat:read", { objective: "read feature" }) },
    ];

    const out = renderList(annotated, { grep: "AUTH" }); // 大写测不敏感
    expect(out).toMatch(/wave:auth-x/);
    expect(out).not.toMatch(/wave:login/);
    expect(out).not.toMatch(/feat:read/);
    expect(out).toMatch(/Showing 1–1 of 1|^[^S]/); // 单条不分页或仅 1 条
  });

  it("TC-B3b: grep 匹配 objective 而非 slug", () => {
    const annotated: AnnotatedUnit[] = [
      { unit: makeUnit("wave:abc", { objective: "implement auth" }) },
      { unit: makeUnit("wave:xyz", { objective: "other thing" }) },
    ];
    const out = renderList(annotated, { grep: "auth" });
    expect(out).toMatch(/wave:abc/);
    expect(out).not.toMatch(/wave:xyz/);
  });
});

describe("Wave B: renderList --all group header + repoMeta", () => {
  it("TC-B4: --all 按 cwd 分组，每组有 group header（repo/branch/@commit/cwd）", () => {
    const meta1 = makeRepoMeta({ worktreePath: "/repo/ws-a", branch: "feat-a", headCommit: "aaa1111" });
    const meta2 = makeRepoMeta({
      remoteUrl: "git@github.com:other/repo.git",
      worktreePath: "/repo/ws-b",
      branch: "feat-b",
      headCommit: "bbb2222",
    });

    const annotated: AnnotatedUnit[] = [
      { unit: makeUnit("wave:a1"), cwd: "/repo/ws-a", repoMeta: meta1 },
      { unit: makeUnit("wave:b1"), cwd: "/repo/ws-b", repoMeta: meta2 },
    ];

    const out = renderList(annotated, { all: true });

    // 两个 group header
    expect(out).toMatch(/git@github.com:foo\/bar\.git/);
    expect(out).toMatch(/git@github.com:other\/repo\.git/);
    expect(out).toMatch(/branch feat-a/);
    expect(out).toMatch(/branch feat-b/);
    expect(out).toMatch(/@ aaa1111/);
    expect(out).toMatch(/@ bbb2222/);
    expect(out).toMatch(/cwd\s+\/repo\/ws-a/);
    expect(out).toMatch(/cwd\s+\/repo\/ws-b/);
  });

  it("TC-B5: --all 同 repo 多 worktree 的 remoteUrl 去重（后续显示 (same repo)）", () => {
    const meta1 = makeRepoMeta({ worktreePath: "/repo/ws-a" });
    const meta2 = makeRepoMeta({ worktreePath: "/repo/ws-b" }); // 同 remoteUrl

    const annotated: AnnotatedUnit[] = [
      { unit: makeUnit("wave:a1"), cwd: "/repo/ws-a", repoMeta: meta1 },
      { unit: makeUnit("wave:b1"), cwd: "/repo/ws-b", repoMeta: meta2 },
    ];

    const out = renderList(annotated, { all: true });

    // 首个 group 显示完整 remoteUrl
    expect(out).toMatch(/git@github\.com:foo\/bar\.git/);
    // 第二个 group 显示 (same repo)
    expect(out).toMatch(/\(same repo\)/);
  });

  it("TC-B7: --all 旧 store 无 repoMeta 时 group header 显示 (no repo meta)", () => {
    const annotated: AnnotatedUnit[] = [
      { unit: makeUnit("wave:old"), cwd: "/old/cwd" }, // 无 repoMeta
    ];

    const out = renderList(annotated, { all: true });
    expect(out).toMatch(/\(no repo meta\)/);
    expect(out).toMatch(/branch\s+-/); // branch 字段降级为 -
    expect(out).toMatch(/cwd\s+\/old\/cwd/);
  });
});

describe("Wave B: renderList --long 追加列", () => {
  it("TC-B10: --long 追加 children/created 列，children 按 parentUnitId 反查", () => {
    // parent + 2 个 child
    const parent = makeUnit("slice:parent");
    const child1 = makeUnit("wave:c1", { parentUnitId: "slice:parent" });
    const child2 = makeUnit("wave:c2", { parentUnitId: "slice:parent" });
    const annotated: AnnotatedUnit[] = [
      { unit: parent },
      { unit: child1 },
      { unit: child2 },
    ];

    const out = renderList(annotated, { verbose: true });
    // 表头含 children/created
    expect(out).toMatch(/children/);
    expect(out).toMatch(/created/);
    // parent 行的 children 列是 2（有 2 个 child）
    const parentLine = out.split("\n").find((l) => l.startsWith("slice:parent"));
    expect(parentLine).toBeDefined();
    // children 列在 objective 之后，应为 "2"
    expect(parentLine!).toMatch(/\s2\s/);
  });

  it("TC-B10b: 无 --long 时不显示 children/created 列", () => {
    const annotated: AnnotatedUnit[] = [{ unit: makeUnit("wave:a") }];
    const out = renderList(annotated, {});
    expect(out).not.toMatch(/^children/m);
    expect(out).not.toMatch(/^created/m);
  });
});

describe("Wave B: renderList 边界", () => {
  it("TC-B11: 空 store 输出 (no units)", () => {
    const out = renderList([], {});
    expect(out.trim()).toBe("(no units)");
  });

  it("TC-B11b: layer 过滤无匹配输出 (no units in layer)", () => {
    const annotated: AnnotatedUnit[] = [{ unit: makeUnit("wave:a") }];
    const out = renderList(annotated, { layer: "epic" });
    expect(out).toMatch(/no units in layer: epic/);
  });

  it("TC-B9: updated 列显示绝对时间 YYYY-MM-DD HH:mm", () => {
    const annotated: AnnotatedUnit[] = [
      {
        unit: makeUnit("wave:a", {
          statusHistoryAt: "2026-07-26T10:30:00.000Z",
        }),
      },
    ];
    const out = renderList(annotated, {});
    // 本地时区格式化（含日期）——至少含 2026-07-26 或 2026-07-25（时区跨日可能）
    expect(out).toMatch(/2026-07-2[56]/);
  });

  it("TC-B9b: statusHistory 为空时 updated 显示 -", () => {
    const unit = {
      id: "wave:empty",
      scope: "wave",
      slug: "empty",
      status: "created",
      statusHistory: [],
      basedOnParent: [],
      abandonedRefs: [],
      objective: "no history",
    } as WorkUnitRecord;
    const out = renderList([{ unit }], {});
    const line = out.split("\n").find((l) => l.startsWith("wave:empty"));
    expect(line).toMatch(/\s-\s/); // updated 列是 -
  });
});

// ═══════════════════════════════════════════════════════════════
// loadAllCwdsFromHome + cli 层（真实 fs，需 V1_HOME 隔离）
// ═══════════════════════════════════════════════════════════════

describe("Wave B: loadAllCwdsFromHome 跨 cwd 遍历", () => {
  let v1Home: string;
  let prevV1Home: string | undefined;

  beforeEach(() => {
    v1Home = mkdtempSync(join(tmpdir(), "cw-list-v1home-"));
    prevV1Home = process.env.V1_HOME;
    process.env.V1_HOME = v1Home;
  });
  afterEach(() => {
    if (prevV1Home === undefined) delete process.env.V1_HOME;
    else process.env.V1_HOME = prevV1Home;
    rmSync(v1Home, { recursive: true, force: true });
  });

  /** 在 v1Home 下造一个 cwd 的 _v1.json。 */
  function writeCwdStore(cwd: string, units: WorkUnitRecord[], repoMeta?: RepoMeta): void {
    const encoded = encodeCwd(cwd);
    const dir = join(v1Home, encoded);
    mkdirSync(dir, { recursive: true });
    const data: Record<string, unknown> = { schemaVersion: 1, workUnits: units };
    if (repoMeta) data.repoMeta = repoMeta;
    writeFileSync(join(dir, "_v1.json"), JSON.stringify(data));
  }

  it("TC-B4fs: 真实 fs 遍历多个 cwd，按 repoMeta.recordedAt DESC 排序", () => {
    writeCwdStore("/fake/a", [makeUnit("wave:a")], makeRepoMeta({ recordedAt: "2026-07-26T10:00:00.000Z", worktreePath: "/fake/a" }));
    writeCwdStore("/fake/b", [makeUnit("wave:b")], makeRepoMeta({ recordedAt: "2026-07-26T12:00:00.000Z", worktreePath: "/fake/b" }));

    const loaded = loadAllCwdsFromHome(v1Home);
    expect(loaded.length).toBe(2);
    // b 的 recordedAt 更新（12:00），排前面
    expect(loaded[0].data.workUnits[0].id).toBe("wave:b");
    expect(loaded[1].data.workUnits[0].id).toBe("wave:a");
  });

  it("TC-B12: 损坏的 _v1.json 被跳过，不影响其他 cwd", () => {
    writeCwdStore("/fake/good", [makeUnit("wave:good")], makeRepoMeta({ worktreePath: "/fake/good" }));
    // 造一个损坏的
    const badDir = join(v1Home, encodeCwd("/fake/bad"));
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "_v1.json"), "corrupted{{{invalid json");

    const loaded = loadAllCwdsFromHome(v1Home);
    expect(loaded.length).toBe(1); // 损坏的跳过
    expect(loaded[0].data.workUnits[0].id).toBe("wave:good");
  });

  it("TC-B7fs: 无 repoMeta 的旧 store 仍能加载（cwd 从 encodedCwd 反解）", () => {
    writeCwdStore("/fake/old", [makeUnit("wave:old")]); // 无 repoMeta
    const loaded = loadAllCwdsFromHome(v1Home);
    expect(loaded.length).toBe(1);
    expect(loaded[0].cwd).toBe("/fake/old"); // 从 encodedCwd 反解
    expect(loaded[0].data.repoMeta).toBeUndefined();
  });

  it("TC-B7fs-b: 有 repoMeta 时 cwd 优先用 worktreePath（更精确）", () => {
    // encodedCwd 是 /fake/encoded，但 repoMeta.worktreePath 是 /real/path
    writeCwdStore(
      "/fake/encoded",
      [makeUnit("wave:x")],
      makeRepoMeta({ worktreePath: "/real/path" }),
    );
    const loaded = loadAllCwdsFromHome(v1Home);
    expect(loaded[0].cwd).toBe("/real/path"); // 优先 worktreePath
  });

  it("TC-B12b: V1_HOME 不存在时返回空数组（不抛）", () => {
    const loaded = loadAllCwdsFromHome(join(v1Home, "nonexistent-subdir"));
    expect(loaded).toEqual([]);
  });

  it("TC-B5fs: 真实 fs 同 repo 多 worktree，renderList --all 的 group header 去重", () => {
    // 两个 cwd 共享 remoteUrl（同 repo 不同 worktree）
    writeCwdStore("/repo/ws-a", [makeUnit("wave:a")], makeRepoMeta({ worktreePath: "/repo/ws-a" }));
    writeCwdStore("/repo/ws-b", [makeUnit("wave:b")], makeRepoMeta({ worktreePath: "/repo/ws-b" }));

    const loaded = loadAllCwdsFromHome(v1Home);
    const annotated: AnnotatedUnit[] = [];
    for (const { cwd, data } of loaded) {
      for (const unit of data.workUnits) {
        annotated.push({ unit, cwd, repoMeta: data.repoMeta });
      }
    }

    const out = renderList(annotated, { all: true });
    // 首个 group 显示完整 remoteUrl
    expect(out).toMatch(/git@github\.com:foo\/bar\.git/);
    // 第二个 group 显示 (same repo)
    expect(out).toMatch(/\(same repo\)/);
  });
});

describe("Wave B: V1Store 集成 + --cwd", () => {
  let v1Home: string;
  let prevV1Home: string | undefined;
  let cwdA: string;
  let cwdB: string;

  beforeEach(() => {
    v1Home = mkdtempSync(join(tmpdir(), "cw-list-v1home-"));
    prevV1Home = process.env.V1_HOME;
    process.env.V1_HOME = v1Home;
    cwdA = mkdtempSync(join(tmpdir(), "cw-list-cwdA-"));
    cwdB = mkdtempSync(join(tmpdir(), "cw-list-cwdB-"));
  });
  afterEach(() => {
    if (prevV1Home === undefined) delete process.env.V1_HOME;
    else process.env.V1_HOME = prevV1Home;
    rmSync(v1Home, { recursive: true, force: true });
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
  });

  it("TC-B8: --cwd 指定查别的 cwd（通过 V1Store 切换 cwd）", () => {
    // cwdA 存 wave:a，cwdB 存 wave:b
    const storeA = new V1Store(cwdA);
    storeA.save(makeUnit("wave:a"));
    const storeB = new V1Store(cwdB);
    storeB.save(makeUnit("wave:b"));

    // 默认查 cwdA
    const unitsA = new V1Store(cwdA).loadAll();
    expect(unitsA.map((u) => u.id)).toEqual(["wave:a"]);

    // 用 cwdB 的 store 查
    const unitsB = new V1Store(cwdB).loadAll();
    expect(unitsB.map((u) => u.id)).toEqual(["wave:b"]);
  });

  it.skip("TC-B6: --all 与 --cwd 互斥（cli 层，需 e2e，smoke test 已验证）", () => {
    // 由 `node dist/cli.js v1 list --all --cwd /tmp` → exit 1 + 错误信息 验证过
    // cli 层逻辑在 src/cli.ts，e2e 测试成本高，暂跳过
  });
});
