/**
 * EngineDeps —— 通用引擎的依赖注入接口。
 *
 * 设计意图：把引擎依赖的外部能力（store 持久化 / gate runner / 时间 / 随机）
 * 抽成接口，引擎通过 deps 调用，不直接 import 具体实现。
 *
 * 这样：
 *   - 原型阶段用内存 mock 实现这些接口（不接 CwStore）
 *   - 迁移阶段替换为真实实现（CwStoreAdapter / DefaultGateRunner）
 *   - 测试阶段可注入自定义实现
 *
 * 与 cw 0.x 的对应关系：
 *   - store ← CwStore（store.ts），原型阶段用 InMemoryStore
 *   - gateRunner ← 原型用 DefaultGateRunner，迁移后接 cw 0.x gate.ts 具名函数
 *   - now ← Date.now / new Date().toISOString()
 */
import type { Unit } from "./unit.js";
import type { GateRunner } from "./gate.js";

/**
 * Unit store 接口 —— 引擎对持久化层的抽象。
 *
 * cw 0.x 的 CwStore 有 30+ 具名方法（insertTopic / appendGateHistory / insertWaves / ...），
 * 1.0 引擎不直接调这些方法——引擎只通过 collections 字段读写 unit。
 * 持久化层负责把 Unit 的 collections 序列化到磁盘 / 反序列化回内存。
 *
 * 原型阶段用 InMemoryStore 实现，迁移阶段写 CwStoreAdapter。
 */
export interface UnitStore {
  /** 加载 unit（按 id）。 */
  load(id: string): Unit<string, unknown> | null;
  /** 保存 unit（覆盖式，事务由实现保证）。 */
  save(unit: Unit<string, unknown>): void;
  /** 按 parentUnitId 查所有 child unit（递归嵌套用）。 */
  findChildren(parentUnitId: string): Unit<string, unknown>[];
  /** 按 derivedFromId 查下游 unit（跨层 drift 传播用）。 */
  findByDerivedFrom(upstreamUnitId: string): Unit<string, unknown>[];
}

/**
 * 内存 mock store —— 原型阶段用。
 *
 * 不接磁盘，纯内存。事务性靠 caller 保证（引擎在 dispatch 内不并发）。
 */
export class InMemoryStore implements UnitStore {
  private units = new Map<string, Unit<string, unknown>>();

  load(id: string): Unit<string, unknown> | null {
    return this.units.get(id) ?? null;
  }

  save(unit: Unit<string, unknown>): void {
    // 深拷贝避免外部 mutation
    this.units.set(unit.id, structuredClone(unit));
  }

  findChildren(parentUnitId: string): Unit<string, unknown>[] {
    return Array.from(this.units.values()).filter(
      (u) => u.parentUnitId === parentUnitId,
    );
  }

  findByDerivedFrom(upstreamUnitId: string): Unit<string, unknown>[] {
    return Array.from(this.units.values()).filter(
      (u) => u.derivedFromId === upstreamUnitId,
    );
  }
}

/**
 * 时间提供者（便于测试注入）。
 */
export interface Clock {
  now(): string;
}

/**
 * 系统时钟默认实现。
 */
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/**
 * 引擎完整依赖集合。
 */
export interface EngineDeps {
  store: UnitStore;
  gateRunner: GateRunner;
  clock: Clock;
}
