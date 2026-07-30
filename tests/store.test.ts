/**
 * v1 CwStore 持久化测试（U18-U21）。
 *
 * 真实文件 IO（mkdtemp 临时目录 + CW_HOME 隔离），零 mock。
 * - save + load 往返一致
 * - 原子写（写后文件存在且 JSON 合法）
 * - findChildren 按 parentUnitId 外键查询
 * - 事务回滚（throw 后不落盘）
 * - load/lock 鲁棒性：损坏文件抛错、unlink 错误可观测、TOCTOU fingerprint 保护
 *
 * 对应 test.json U18-U21。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ExecutionUnit } from "../src/core/workunit.js";
import { createWave } from "../src/core/workunit.js";
import type { WorkUnitRecord } from "../src/store/schema.js";
import { encodeCwd, getCwJsonPath } from "../src/store/schema.js";
import {
  createCwEnv,
  type CwEnv,
  STUB_NOW,
} from "./helpers/env.js";

let env: CwEnv;

beforeEach(() => {
  env = createCwEnv();
});

afterEach(() => {
  env.cleanup();
});

function makeUnit(slug: string, parentUnitId = "slice:p"): ExecutionUnit {
  return createWave({
    slug,
    objective: `o-${slug}`,
    parentUnitId,
    basedOnParent: [],
    createdAt: STUB_NOW,
  });
}

describe("U18: save + load 往返一致", () => {
  it("save 后 load 同一 id 返回相同记录", () => {
    const unit = makeUnit("w1");
    env.store.save(unit as unknown as WorkUnitRecord);

    const loaded = env.store.load(unit.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("wave:w1");
    expect(loaded!.scope).toBe("wave");
    expect(loaded!.status).toBe("created");
    expect(loaded!.slug).toBe("w1");
    expect(loaded!.objective).toBe("o-w1");
  });

  it("load 不存在的 id → null", () => {
    expect(env.store.load("wave:nope")).toBeNull();
  });

  it("save 同一 id 两次（upsert）→ 整体替换，不重复", () => {
    const unit = makeUnit("w2");
    env.store.save(unit as unknown as WorkUnitRecord);
    unit.objective = "updated objective";
    env.store.save(unit as unknown as WorkUnitRecord);

    const all = env.store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.objective).toBe("updated objective");
  });

  it("save 多个 unit → loadAll 返回全部", () => {
    env.store.save(makeUnit("a") as unknown as WorkUnitRecord);
    env.store.save(makeUnit("b") as unknown as WorkUnitRecord);
    env.store.save(makeUnit("c") as unknown as WorkUnitRecord);
    expect(env.store.loadAll()).toHaveLength(3);
  });
});

describe("U19: 原子写 + findChildren", () => {
  it("save 后 store.json 文件存在且 JSON 合法", () => {
    env.store.save(makeUnit("atomic") as unknown as WorkUnitRecord);

    const path = getCwJsonPath(env.cwd);
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { workUnits: WorkUnitRecord[] };
    expect(parsed.workUnits).toHaveLength(1);
    expect(parsed.workUnits[0]!.id).toBe("wave:atomic");
  });

  it("findChildren 按 parentUnitId 外键查询", () => {
    env.store.save(makeUnit("parent", "slice:root") as unknown as WorkUnitRecord);
    env.store.save(makeUnit("c1", "wave:parent") as unknown as WorkUnitRecord);
    env.store.save(makeUnit("c2", "wave:parent") as unknown as WorkUnitRecord);
    env.store.save(makeUnit("other", "wave:another") as unknown as WorkUnitRecord);

    const children = env.store.findChildren("wave:parent");
    expect(children).toHaveLength(2);
    const ids = children.map((c) => c.id).sort();
    expect(ids).toEqual(["wave:c1", "wave:c2"]);
  });

  it("findChildren 无匹配 → 空数组", () => {
    env.store.save(makeUnit("lonely") as unknown as WorkUnitRecord);
    expect(env.store.findChildren("wave:nonexistent")).toEqual([]);
  });

  it("encodeCwd 正确编码路径", () => {
    expect(encodeCwd("/a/b/c")).toBe("__a__b__c");
    expect(encodeCwd(env.cwd)).toBe(env.cwd.replace(/\//g, "__"));
  });
});

describe("U20: 事务回滚", () => {
  it("transaction 内 throw → 不落盘（磁盘保持事务前状态）", () => {
    // 先存一个 unit（事务前状态）
    env.store.save(makeUnit("before") as unknown as WorkUnitRecord);
    expect(env.store.loadAll()).toHaveLength(1);

    // 开事务，在里面 save 新 unit 后抛错
    expect(() =>
      env.store.transaction(() => {
        env.store.save(makeUnit("during") as unknown as WorkUnitRecord);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // 回滚：during 不应落盘，仍只有 before
    const all = env.store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("wave:before");
  });

  it("transaction 正常返回 → 落盘", () => {
    const result = env.store.transaction(() => {
      env.store.save(makeUnit("tx-ok") as unknown as WorkUnitRecord);
      return "done";
    });
    expect(result).toBe("done");
    const all = env.store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("wave:tx-ok");
  });

  it("事务内同事务多次 save 原子落盘", () => {
    env.store.transaction(() => {
      env.store.save(makeUnit("m1") as unknown as WorkUnitRecord);
      env.store.save(makeUnit("m2") as unknown as WorkUnitRecord);
      env.store.save(makeUnit("m3") as unknown as WorkUnitRecord);
    });
    expect(env.store.loadAll()).toHaveLength(3);
  });

  it("事务回滚后 store 仍可正常使用（锁已释放）", () => {
    expect(() =>
      env.store.transaction(() => {
        throw new Error("first fail");
      }),
    ).toThrow();

    // 锁应已释放，可正常 save
    env.store.save(makeUnit("after-rollback") as unknown as WorkUnitRecord);
    expect(env.store.load("wave:after-rollback")).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// U21：load/lock 鲁棒性（修复 M1 + M7 + M8）
//   - M1：文件解析失败不再静默回退空库，抛错避免删库效应
//   - M7：unlinkLockFile 非 ENOENT 错误在 verbose 模式下记 stderr
//   - M8：acquireLock stale 检测与 unlink 之间 fingerprint 比对，防 TOCTOU
// ══════════════════════════════════════════════════════════════

describe("U21: load/lock 鲁棒性", () => {
  // 内部工具：拿 store.json 的 lockfile 路径（dbPath + ".lock"）。
  function lockPath(): string {
    return getCwJsonPath(env.cwd) + ".lock";
  }

  describe("M1: store.json 解析失败 → throw（不静默丢数据）", () => {
    it("load 在损坏文件上抛错（不再返回空数据）", () => {
      const path = getCwJsonPath(env.cwd);
      writeFileSync(path, "{ this is not valid json", "utf-8");

      expect(() => env.store.load("wave:any")).toThrow(/failed to parse store\.json/);
      expect(() => env.store.loadAll()).toThrow(/failed to parse store\.json/);
      expect(() => env.store.findChildren("any")).toThrow(/failed to parse store\.json/);
    });

    it("save 在损坏文件上抛错且不覆盖磁盘（保护残存数据）", () => {
      const path = getCwJsonPath(env.cwd);
      // 模拟"磁盘上事实上残存数据但 JSON 损坏"的场景。
      const corrupt = `{
  "workUnits": [{ "id": "wave:survivor"`;
      writeFileSync(path, corrupt, "utf-8");

      // save 必须抛错（不能闷头执行 delete-the-data 的事务）。
      const unit = makeUnit("attacker") as unknown as WorkUnitRecord;
      expect(() => env.store.save(unit)).toThrow(/failed to parse store\.json/);

      // 关键不变式：损坏前的文件必须还在磁盘上。未修复 M1 之前，此处会被覆盖成空库。
      expect(existsSync(path)).toBe(true);
      const raw = readFileSync(path, "utf-8");
      expect(raw).toBe(corrupt);
    });

    it("空文件不存在 → load 仍返回空（全新安装场景，正常路径）", () => {
      // 不写任何文件，load 应是空库。
      expect(env.store.load("wave:any")).toBeNull();
      expect(env.store.loadAll()).toEqual([]);
    });
  });

  describe("M7: unlinkLockFile 非 ENOENT 错误在 verbose 模式下记 stderr", () => {
    // vi.spyOn 返回 MockInstance；这里只需用 mock.calls 检查调用记录，类型用 unknown 收口。
    let stderrSpy: unknown;
    let prevVerbose: string | undefined;

    beforeEach(() => {
      prevVerbose = process.env["CW_VERBOSE"];
      // spy 在 beforeEach 里建，afterEach 里还原；避免多 case 互相干扰。
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      (stderrSpy as { mockRestore: () => void } | undefined)?.mockRestore();
      if (prevVerbose === undefined) {
        delete process.env["CW_VERBOSE"];
      } else {
        process.env["CW_VERBOSE"] = prevVerbose;
      }
    });

    it("verbose 开启时，非 ENOENT unlink 错误写入 stderr", () => {
      process.env["CW_VERBOSE"] = "1";

      const lp = lockPath();
      // 把 lockfile 路径建为一个目录：unlinkSync 会返回 EPERM，触发 logVerbose 分支。
      mkdirSync(lp, { recursive: false });

      // acquireLock 会看到 EEXIST → readLockFingerprint 读目录拿到 garbage → null →
      // unlinkLockFile → EPERM。重试 50 次超时后抛错。
      expect(() =>
        env.store.save(makeUnit("m7") as unknown as WorkUnitRecord),
      ).toThrow(/failed to acquire lock/);

      const stderrCalls = (
        stderrSpy as { mock: { calls: unknown[][] } }
      ).mock.calls
        .map((c) => String(c[0]))
        .join("");
      // 至少有一条由 verbose 写入的 unlink 失败诊断。
      expect(stderrCalls).toMatch(/\[cw-store\] unlinkSync\(.+\) failed:/);
    });

    it("verbose 关闭时同样场景不写 stderr（保持静默兼容旧行为）", () => {
      delete process.env["CW_VERBOSE"];

      const lp = lockPath();
      mkdirSync(lp, { recursive: false });

      expect(() =>
        env.store.save(makeUnit("m7-quiet") as unknown as WorkUnitRecord),
      ).toThrow(/failed to acquire lock/);

      const stderrCalls = (
        stderrSpy as { mock: { calls: unknown[][] } }
      ).mock.calls
        .map((c) => String(c[0]))
        .join("");
      expect(stderrCalls).not.toMatch(/\[cw-store\] unlinkSync/);
    });

    it("ENOENT 路径在 verbose 模式下也不写 stderr（无害丢失仍静默）", () => {
      process.env["CW_VERBOSE"] = "1";

      // 直接调用 save（无任何手动造 lockfile）→ 正常路径下 releaseLock 调 unlinkLockFile
      // 时 lockfile 恰好被其他路径删了 → ENOENT → 静默吞。
      env.store.save(makeUnit("m7-enoent") as unknown as WorkUnitRecord);

      const stderrCalls = (
        stderrSpy as { mock: { calls: unknown[][] } }
      ).mock.calls
        .map((c) => String(c[0]))
        .join("");
      expect(stderrCalls).not.toMatch(/\[cw-store\] unlinkSync/);
    });
  });

  describe("M8: acquireLock 的 TOCTOU fingerprint 保护", () => {
    it("stale lockfile（超时）能正常抢占，save 成功", () => {
      // 1. 先存一个 unit 到磁盘（场景需要）。
      env.store.save(makeUnit("pre-m8") as unknown as WorkUnitRecord);

      // 2. 手工造一个 stale lockfile：内容是当前 process.pid，但 timestamp 是远古。
      const lp = lockPath();
      const ancient = Date.now() - 60_000; // 60s 前，远超 LOCK_STALE_TIMEOUT_MS（30s）。
      writeFileSync(lp, `${process.pid}\n${ancient}\n`, "utf-8");

      // 3. 下一个 save() 走 acquireLock → EEXIST → readLockFingerprint 拿到指纹
      // → isStaleLock 返回 true（超时）→ 二次读取指纹仍匹配（未走 TOCTOU）→
      // unlink + 重试创建锁 → 成功。
      const u = makeUnit("post-m8") as unknown as WorkUnitRecord;
      env.store.save(u);

      // 4. 写入完成，旧 unit 仍在 + 新 unit 也进去。
      expect(env.store.load("wave:pre-m8")).not.toBeNull();
      expect(env.store.load("wave:post-m8")?.objective).toBe("o-post-m8");

      // 5. 锁文件在事务完成后被清理。
      expect(existsSync(lp)).toBe(false);
    });

    it("stale 内容（pid 死 + 超时）被识别为 stale 后成功回收，数据未损坏", () => {
      // 1. 预存一个 unit，然后手工造一个"假装另一进程占着"的 stale lockfile。
      env.store.save(makeUnit("pre-m8-block") as unknown as WorkUnitRecord);
      const lp = lockPath();
      // 极大随机 pid 几乎不可能存在 → isProcessAlive 返回 false。
      const staleTs = Date.now() - 60_000;
      const fakePid = 9_999_999;
      writeFileSync(lp, `${fakePid}\n${staleTs}\n`, "utf-8");

      // 2. save：指纹 → isStaleLock(true，pid 死 + 超时) → 二次指纹仍匹配 → unlink → 重试
      // → 锁可抢到。验证指纹一致分支不被误跳（TOCTOU 窗口未触发）。
      env.store.save(makeUnit("after-unblock") as unknown as WorkUnitRecord);

      expect(env.store.load("wave:after-unblock")).not.toBeNull();
      expect(env.store.load("wave:pre-m8-block")).not.toBeNull();
      expect(existsSync(lp)).toBe(false);
    });
  });
});
