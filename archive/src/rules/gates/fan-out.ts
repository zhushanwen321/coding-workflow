/**
 * fan-out 上限常量（领域规则，零 IO）。
 *
 * 来源：v5 重构 E3（fan-out 上限 gate）。
 *
 * fan-out 定义：某个被继承的 parent 条目 id 被多少个子 split 引用（inheritedItemIds 命中）。
 * 同一条目被过多子层继承时，replan 影响面查询会扇出到大量分支（影响面爆炸），
 * execute 并行度也无法收敛。每层拆分的上限不同（epic 拆 feature 可稍多，wave 层最细）。
 *
 * 消费方：design-review.ts 的 splitFanOutLimitBySplits（各层 wrapper 注入对应上限）。
 */
export const MAX_EPIC_TO_FEATURE = 7;
export const MAX_FEATURE_TO_SLICE = 5;
export const MAX_SLICE_TO_WAVE = 6;
