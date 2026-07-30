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

import { migrateLegacyV1Home } from "../../src/store/migrate-v1.js";

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

    // 数据搬到 cw 侧
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

    // 读 cw 侧数据，应是 v1 的（5 unit）
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

    // cw 侧数据不变（2 unit）
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

    // 有效目录迁移了
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

    // 孤儿搬到 cw
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
