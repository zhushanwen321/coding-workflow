/**
 * v1 V1Store 持久化测试（U18-U20）。
 *
 * 真实文件 IO（mkdtemp 临时目录 + V1_HOME 隔离），零 mock。
 * - save + load 往返一致
 * - 原子写（写后文件存在且 JSON 合法）
 * - findChildren 按 parentUnitId 外键查询
 * - 事务回滚（throw 后不落盘）
 *
 * 对应 test.json U18-U20。
 */
import { existsSync, readFileSync } from "node:fs";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import type { ExecutionUnit } from "../../src/v1/core/workunit.js";
import { createWave } from "../../src/v1/core/workunit.js";
import type { WorkUnitRecord } from "../../src/v1/store/schema.js";
import { encodeCwd,getV1JsonPath } from "../../src/v1/store/schema.js";
import {
  createV1Env,
  STUB_NOW,
  type V1Env,
} from "./helpers/v1-env.js";

let env: V1Env;

beforeEach(() => {
  env = createV1Env();
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
  it("save 后 _v1.json 文件存在且 JSON 合法", () => {
    env.store.save(makeUnit("atomic") as unknown as WorkUnitRecord);

    const path = getV1JsonPath(env.cwd);
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
