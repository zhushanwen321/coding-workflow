/**
 * spec.json 的 typebox schema 与校验（u2 验收文档「evidence submit --kind spec」锁定）。
 *
 * spec.json 结构 `{ acceptance, contracts, split }` 是 src/events/types.ts 领域类型的
 * 文件投影：typebox 在入口处做机器校验（字段类型不符 → 列出具体字段错误），
 * 校验通过后按 Static 类型直读——Schema 与领域类型的一致性由本文件单点维护，
 * 领域类型变更时此处必须同步（两处都在 u2/u3 验收文档口径内）。
 */
import { Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const AcceptanceItemSchema = Type.Object({
  id: Type.String(),
  core: Type.Boolean(),
  title: Type.String(),
  type: Type.Union([
    Type.Literal("unit"),
    Type.Literal("integration"),
    Type.Literal("e2e-real"),
    Type.Literal("e2e-mock"),
    Type.Literal("manual"),
  ]),
  command: Type.Optional(Type.String()),
  scenario: Type.Optional(Type.String()),
  mockFidelityNote: Type.Optional(Type.String()),
  /** 测试框架显式声明（合法值由 spec gate 规则⑧校验；缺省按 type 推导——对齐领域类型 AcceptanceItem.runner） */
  runner: Type.Optional(Type.String()),
  /**
   * 随机性显式声明（rv-5，对齐领域类型 AcceptanceItem.nondeterministic?: true）：
   * 仅接受字面 true——false 与缺省语义等价，写 false 属无意义输入，schema 直接拒
   * （错误指向字段路径，spec 作者改为删字段或写 true）。
   */
  nondeterministic: Type.Optional(Type.Literal(true)),
  /**
   * 验收层级（al-2，对齐领域类型 AcceptanceItem.layer?: AcceptanceLayer）：
   * 合法值 "unit" | "topic" 与 AcceptanceLayer 联合逐字符一致（两处一致性由
   * al-2 验收文档单点维护，注释互相指向）。schema 显式声明后非法值在入口被拒
   * （错误含字段路径），不依赖 gate。缺省不写键 = unit——缺省语义靠键缺失
   * 表达，旧账本重放兼容（显式声明才入账）。
   */
  layer: Type.Optional(Type.Union([Type.Literal("unit"), Type.Literal("topic")])),
});

export const ContractSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([
    Type.Literal("function"),
    Type.Literal("api"),
    Type.Literal("class"),
    Type.Literal("event"),
    Type.Literal("schema"),
    Type.Literal("other"),
  ]),
  provider: Type.String(),
  consumer: Type.String(),
  signature: Type.String(),
  /** 签名应存在的文件（相对仓库根路径）；缺省 = 集成时全树搜索（对齐领域类型 Contract.file） */
  file: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

export const SplitEntrySchema = Type.Object({
  unitId: Type.String(),
  briefRef: Type.Optional(Type.String()),
  dependsOn: Type.Array(Type.String()),
  files: Type.Optional(Type.Array(Type.String())),
});

export const SpecFileSchema = Type.Object({
  acceptance: Type.Array(AcceptanceItemSchema),
  contracts: Type.Array(ContractSchema),
  split: Type.Array(SplitEntrySchema),
});

export type SpecFile = Static<typeof SpecFileSchema>;

export interface SpecFileValidation {
  ok: boolean;
  /** 具体字段错误（typebox 路径 + 原始 message），如 "/acceptance/0/id: Expected string" */
  errors: string[];
}

/**
 * 校验 spec.json 解析出的未知数据。只做 schema 判定，不打印不退出——
 * 错误的呈现方式（stderr + exit 1）由调用方统一。
 */
export function validateSpecFile(data: unknown): SpecFileValidation {
  const errors = [...Value.Errors(SpecFileSchema, data)].map(
    (e) => `${e.path}: ${e.message}`,
  );
  return { ok: errors.length === 0, errors };
}
