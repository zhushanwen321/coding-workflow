/**
 * migrate-v1 测试 — ~/.v1 → ~/.cw 数据迁移逻辑。
 *
 * 零 mock：用 mkdtemp 临时目录构造 legacyHome / cwHome，真实文件 IO。
 * 不碰用户真实的 ~/.v1 / ~/.cw（通过 opts 注入临时路径绕过 homedir()）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { migrateLegacyV1Filename, migrateLegacyV1Home } from "../src/store/migrate-v1.js";

/** 构造一个最小合法的 _v1.json 内容。recordedAt 可空（测时间比较）。 */
function makeV1Json(recordedAt: string, unitCount = 1): string {
  const units = Array.from({ length: unitCount }, (_, i) => ({
    id: `wave:test-${i}`,
    scope: "wave",
    status: "closed",
  }));
  return JSON.stringify({
    schemaVersion: 1,
    repoMeta: { recordedAt, worktreePath: "/tmp/test" },
    workUnits: units,
  });
}

/** 构造测试环境：tmp 目录下的 legacyHome + cwHome。 */
function setupEnv() {
  const root = mkdtempSync(join(tmpdir(), "cw-migrate-test-"));
  const legacyHome = join(root, "legacy-v1");
  const cwHome = join(root, "cw-home");
  mkdirSync(legacyHome, { recursive: true });
  mkdirSync(cwHome, { recursive: true });
  return { root, legacyHome, cwHome };
}

/** 在 legacyHome 或 cwHome 下构造一个 encodedCwd 子目录 + _v1.json。 */
function seedStore(home: string, encodedCwd: string, recordedAt: string, unitCount = 1): void {
  const dir = join(home, encodedCwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_v1.json"), makeV1Json(recordedAt, unitCount));
}

const ENV = encodeURI("proj-a").replace(/[^a-z0-9]/gi, "_"); // 简单 encodedCwd 名

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-migrate-outer-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("migrate-v1: migrateLegacyV1Home", () => {
  it("~/.v1 不存在 → 秒返回，不报错（幂等）", () => {
    const { legacyHome, cwHome } = setupEnv();
    rmSync(legacyHome, { recursive: true, force: true }); // 删掉 legacyHome 模拟不存在

    expect(() => migrateLegacyV1Home({ legacyHome, cwHome })).not.toThrow();
    expect(existsSync(legacyHome)).toBe(false);
  });

  it("仅 ~/.v1 有 → 搬到 ~/.cw，原 ~/.v1 子目录清空后 rmdir", () => {
    const { legacyHome, cwHome } = setupEnv();
    seedStore(legacyHome, ENV, "2026-07-29T10:00:00Z", 3);

    migrateLegacyV1Home({ legacyHome, cwHome });

    // 数据搬到 cw 侧（home 迁移搬整个目录，文件名仍是 _v1.json；文件名迁移才改成 store.json）
    expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(true);
    // v1 侧清空
    expect(existsSync(join(legacyHome, ENV))).toBe(false);
    expect(existsSync(legacyHome)).toBe(false); // rmdir 了
  });

  it("两边都有、~/.v1 更新 → v1 覆盖 cw", () => {
    const { legacyHome, cwHome } = setupEnv();
    seedStore(legacyHome, ENV, "2026-07-29T10:00:00Z", 5); // v1 更新 + 更多 unit
    seedStore(cwHome, ENV, "2026-07-29T05:00:00Z", 2); // cw 更旧

    migrateLegacyV1Home({ legacyHome, cwHome });

    // 读 cw 侧数据，应是 v1 的（5 unit）。home 迁移后文件名仍是 _v1.json
    const cwData = JSON.parse(
      readFileSync(join(cwHome, ENV, "_v1.json"), "utf-8"),
    );
    expect(cwData.workUnits.length).toBe(5);
    expect(existsSync(join(legacyHome, ENV))).toBe(false);
  });

  it("两边都有、~/.cw 更新 → 删 v1，cw 不变", () => {
    const { legacyHome, cwHome } = setupEnv();
    seedStore(legacyHome, ENV, "2026-07-29T05:00:00Z", 5); // v1 更旧
    seedStore(cwHome, ENV, "2026-07-29T10:00:00Z", 2); // cw 更新

    migrateLegacyV1Home({ legacyHome, cwHome });

    // cw 侧数据不变（2 unit）。home 迁移后文件名仍是 _v1.json
    const cwData = JSON.parse(
      readFileSync(join(cwHome, ENV, "_v1.json"), "utf-8"),
    );
    expect(cwData.workUnits.length).toBe(2);
    expect(existsSync(join(legacyHome, ENV))).toBe(false); // v1 删了
  });

  it("recordedAt 相同 → 取 v1 覆盖 cw（保守，迁移前最后写入的优先）", () => {
    const { legacyHome, cwHome } = setupEnv();
    seedStore(legacyHome, ENV, "2026-07-29T10:00:00Z", 5);
    seedStore(cwHome, ENV, "2026-07-29T10:00:00Z", 2);

    migrateLegacyV1Home({ legacyHome, cwHome });

    const cwData = JSON.parse(
      readFileSync(join(cwHome, ENV, "_v1.json"), "utf-8"),
    );
    expect(cwData.workUnits.length).toBe(5); // 取了 v1 的
  });

  it("~/.v1 子目录 _v1.json 解析失败 → warn 跳过，不删原文件", () => {
    const { legacyHome, cwHome } = setupEnv();
    // 构造一个损坏的 _v1.json
    const dir = join(legacyHome, ENV);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "_v1.json"), "{ invalid json !!!");

    // 不应抛错
    expect(() => migrateLegacyV1Home({ legacyHome, cwHome })).not.toThrow();
    // 原文件保留（没被删）
    expect(existsSync(join(legacyHome, ENV, "_v1.json"))).toBe(true);
  });

  it("~/.v1 子目录无 _v1.json（空目录或残留临时文件）→ 清理掉，不影响其他有效目录", () => {
    const { legacyHome, cwHome } = setupEnv();
    // 一个有效目录
    seedStore(legacyHome, "valid-proj", "2026-07-29T10:00:00Z", 1);
    // 一个空目录（残留 .tmp）
    const emptyDir = join(legacyHome, "empty-proj");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, ".tmp"), "残留");

    migrateLegacyV1Home({ legacyHome, cwHome });

    // 有效目录迁移了（home 迁移后文件名仍是 _v1.json）
    expect(existsSync(join(cwHome, "valid-proj", "_v1.json"))).toBe(true);
    // 空目录被清理（无数据价值），~/.v1 全空后 rmdir
    expect(existsSync(join(legacyHome, "empty-proj"))).toBe(false);
    expect(existsSync(legacyHome)).toBe(false);
  });

  it("多个 encodedCwd 混合场景：孤儿搬移 + 冲突合并 + 损坏跳过", () => {
    const { legacyHome, cwHome } = setupEnv();
    // 孤儿（仅 v1 有）
    seedStore(legacyHome, "orphan-proj", "2026-07-29T10:00:00Z", 1);
    // 冲突（v1 更新）
    seedStore(legacyHome, "conflict-proj", "2026-07-29T12:00:00Z", 3);
    seedStore(cwHome, "conflict-proj", "2026-07-29T08:00:00Z", 1);
    // 损坏
    const corruptDir = join(legacyHome, "corrupt-proj");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "_v1.json"), "!!!bad");

    migrateLegacyV1Home({ legacyHome, cwHome });

    // 孤儿搬到 cw（home 迁移后文件名仍是 _v1.json）
    expect(existsSync(join(cwHome, "orphan-proj", "_v1.json"))).toBe(true);
    // 冲突取 v1（3 unit）
    const conflictData = JSON.parse(
      readFileSync(join(cwHome, "conflict-proj", "_v1.json"), "utf-8"),
    );
    expect(conflictData.workUnits.length).toBe(3);
    // 损坏的原文件保留
    expect(existsSync(join(legacyHome, "corrupt-proj", "_v1.json"))).toBe(true);
    // ~/.v1 因损坏目录残留没被 rmdir
    expect(existsSync(legacyHome)).toBe(true);
  });
});

describe("migrate-v1: migrateLegacyV1Filename", () => {
  // 文件名迁移：cwHome/<cwd>/ 内 _v1.json → store.json 同目录改名。
  // 与 home 迁移不同：seedStore 在这里只用来造 legacy 文件名（_v1.json），
  // 造 store.json（新文件名）时直接 writeFileSync。

  it("仅 _v1.json 存在 → rename 成 store.json", () => {
    const { cwHome } = setupEnv();
    // 造一个旧文件名 _v1.json（模拟迁移前的状态）
    seedStore(cwHome, ENV, "2026-07-29T10:00:00Z", 2);

    migrateLegacyV1Filename({ cwHome });

    expect(existsSync(join(cwHome, ENV, "store.json"))).toBe(true);
    expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(false);
  });

  it("仅 store.json 存在 → 秒过（幂等），store.json 内容不变", () => {
    const { cwHome } = setupEnv();
    // 直接造新文件名 store.json（无 _v1.json，模拟已迁移）
    const dir = join(cwHome, ENV);
    mkdirSync(dir, { recursive: true });
    const expected = makeV1Json("2026-07-29T10:00:00Z", 1);
    writeFileSync(join(dir, "store.json"), expected);

    migrateLegacyV1Filename({ cwHome });

    // store.json 内容不变，没有 _v1.json 产生
    expect(readFileSync(join(cwHome, ENV, "store.json"), "utf-8")).toBe(expected);
    expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(false);
  });

  it("两边都有、_v1 更新 → _v1 覆盖 store，_v1 删除", () => {
    const { cwHome } = setupEnv();
    const dir = join(cwHome, ENV);
    mkdirSync(dir, { recursive: true });
    // _v1.json 更新（12:00，3 unit）
    writeFileSync(join(dir, "_v1.json"), makeV1Json("2026-07-29T12:00:00Z", 3));
    // store.json 更旧（08:00，1 unit）
    writeFileSync(join(dir, "store.json"), makeV1Json("2026-07-29T08:00:00Z", 1));

    migrateLegacyV1Filename({ cwHome });

    // store.json 是 _v1 的内容（3 unit），_v1.json 删了
    const data = JSON.parse(readFileSync(join(cwHome, ENV, "store.json"), "utf-8"));
    expect(data.workUnits.length).toBe(3);
    expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(false);
  });

  it("两边都有、store 更新 → 删 _v1，store 不变", () => {
    const { cwHome } = setupEnv();
    const dir = join(cwHome, ENV);
    mkdirSync(dir, { recursive: true });
    // _v1.json 更旧（08:00，3 unit）
    writeFileSync(join(dir, "_v1.json"), makeV1Json("2026-07-29T08:00:00Z", 3));
    // store.json 更新（12:00，1 unit）
    const storeContent = makeV1Json("2026-07-29T12:00:00Z", 1);
    writeFileSync(join(dir, "store.json"), storeContent);

    migrateLegacyV1Filename({ cwHome });

    // store.json 不变（1 unit），_v1.json 删了
    expect(readFileSync(join(cwHome, ENV, "store.json"), "utf-8")).toBe(storeContent);
    expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(false);
  });

  it("_v1.json 解析失败 → 保留原文件，store.json 不变", () => {
    const { cwHome } = setupEnv();
    const dir = join(cwHome, ENV);
    mkdirSync(dir, { recursive: true });
    // 损坏的 _v1.json
    writeFileSync(join(dir, "_v1.json"), "{ invalid json !!!");
    // 正常的 store.json
    const storeContent = makeV1Json("2026-07-29T10:00:00Z", 1);
    writeFileSync(join(dir, "store.json"), storeContent);

    // 不应抛错
    expect(() => migrateLegacyV1Filename({ cwHome })).not.toThrow();
    // 损坏的 _v1.json 保留（没被删，防数据丢失）
    expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(true);
    // store.json 不变
    expect(readFileSync(join(cwHome, ENV, "store.json"), "utf-8")).toBe(storeContent);
  });

  it("CW_HOME 被 process.env 覆盖时仍执行（与 home 迁移秒返回形成对照）", () => {
    // 两迁移函数唯一的语义差异点：home 迁移在 CW_HOME 被覆盖时秒返回（不擅自搬数据），
    // 文件名迁移「无论 CW_HOME 是否覆盖都执行」（用户自定义路径里的旧文件名也得改）。
    // 走生产解析路径——设 process.env.CW_HOME、不传 opts（getCwHome 读 env），固化该分支契约，
    // 与 home 迁移在同样条件下的秒返回形成对照，回归保护「函数内部是否尊重 CW_HOME」。
    const prevCwHome = process.env.CW_HOME;
    const { cwHome } = setupEnv();
    process.env.CW_HOME = cwHome; // 非默认绝对路径
    try {
      seedStore(cwHome, ENV, "2026-07-29T10:00:00Z", 2);

      // 对照：home 迁移在 CW_HOME 覆盖时秒返回（CW_HOME 检查即 return，不碰 ~/.v1），
      // cwHome 内的 _v1.json 原地不动，store.json 也不产生。
      migrateLegacyV1Home();
      expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(true);
      expect(existsSync(join(cwHome, ENV, "store.json"))).toBe(false);

      // 被测分支：filename 迁移无视 CW_HOME 覆盖，照常 _v1.json → store.json 改名。
      migrateLegacyV1Filename();
      expect(existsSync(join(cwHome, ENV, "store.json"))).toBe(true);
      expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(false);
    } finally {
      if (prevCwHome === undefined) {
        delete process.env.CW_HOME;
      } else {
        process.env.CW_HOME = prevCwHome;
      }
    }
  });
});

describe("migrate-v1: end-to-end home → filename 串联顺序", () => {
  // cli.ts 调用契约（src/cli.ts:944-947）：
  //   1) migrateLegacyV1Home()  —— 跨目录搬 ~/.v1/<cwd>/_v1.json → ~/.cw/<cwd>/_v1.json
  //   2) migrateLegacyV1Filename() —— 同目录改名 ~/.cw/<cwd>/_v1.json → store.json
  // cli.ts 注释明确「文件名迁移必须在 home 迁移之后」。若未来调换顺序或改并行，
  // 阶段 2 在 ~/.cw 找不到 _v1.json 会静默漏迁。这里固化顺序契约，两个 describe 独立测
  // 不能覆盖该端到端串联。

  it("先 home 再 filename：~/.v1/<cwd>/_v1.json 最终落到 ~/.cw/<cwd>/store.json，~/.v1 清空", () => {
    const { legacyHome, cwHome } = setupEnv();
    // seed ~/.v1/<ENV>/_v1.json（迁移前的唯一数据来源，cw 侧无任何文件）
    const expected = makeV1Json("2026-07-29T10:00:00Z", 3);
    {
      const dir = join(legacyHome, ENV);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "_v1.json"), expected);
    }

    // 阶段 1：home 迁移——跨目录搬移，cw 侧此时文件名仍是 _v1.json
    migrateLegacyV1Home({ legacyHome, cwHome });
    expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(true);
    expect(existsSync(join(cwHome, ENV, "store.json"))).toBe(false);

    // 阶段 2：filename 迁移——同目录改名 _v1.json → store.json
    migrateLegacyV1Filename({ cwHome });

    // 最终落到 store.json，内容正确
    expect(existsSync(join(cwHome, ENV, "store.json"))).toBe(true);
    expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(false);
    expect(readFileSync(join(cwHome, ENV, "store.json"), "utf-8")).toBe(expected);

    // ~/.v1 已清空（_v1.json 不再存在，legacyHome 全空后被 rmdir）
    expect(existsSync(join(legacyHome, ENV, "_v1.json"))).toBe(false);
    expect(existsSync(legacyHome)).toBe(false);
  });

  it("顺序契约：单独调 filename（跳过 home）→ 在 ~/.cw 找不到 _v1.json，静默漏迁", () => {
    // 反向验证：若违反「先 home 再 filename」顺序（如并行或调换），阶段 2 无源可搬。
    // 证实串联顺序是必需的，而非可选——固化该回归保护。
    const { legacyHome, cwHome } = setupEnv();
    seedStore(legacyHome, ENV, "2026-07-29T10:00:00Z", 3); // 源在 ~/.v1
    // cwHome 下无 _v1.json（home 迁移还没跑）

    // 只跑 filename 迁移：cwHome 下遍历不到 ENV 子目录，无操作
    migrateLegacyV1Filename({ cwHome });

    // 数据仍在 ~/.v1 原地，~/.cw 下什么都没产生（漏迁，但因无源文件、无报错——静默）
    expect(existsSync(join(cwHome, ENV, "store.json"))).toBe(false);
    expect(existsSync(join(cwHome, ENV, "_v1.json"))).toBe(false);
    expect(existsSync(join(legacyHome, ENV, "_v1.json"))).toBe(true);
  });
});
