/**
 * CodeTaste ESLint 基础配置 — TypeScript / Node.js 项目
 *
 * 从 xyz-pi-extensions/taste-lint/base.mjs 适配而来，
 * 路径调整为 ./rules/（无 shared/ 前缀），ignores 适配本项目目录结构。
 *
 * 使用：在项目 eslint.config.mjs 中导入
 *   import tasteConfig from './taste-lint/base.mjs';
 *   export default tasteConfig;
 *
 * 依赖：typescript-eslint, eslint-plugin-simple-import-sort
 */
import tseslint from 'typescript-eslint';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import preferAllsettled from './rules/prefer-allsettled.mjs';
import noSilentCatch from './rules/no-silent-catch.mjs';
import noUnboundedWhileTrue from './rules/no-unbounded-while-true.mjs';
import noInlineImportType from './rules/no-inline-import-type.mjs';
import noEslintDisable from './rules/no-eslint-disable.mjs';
import noUnsafeCast from './rules/no-unsafe-cast.mjs';

export const tastePlugin = {
  meta: { name: 'eslint-plugin-taste' },
  rules: {
    'prefer-allsettled': preferAllsettled,
    'no-silent-catch': noSilentCatch,
    'no-unbounded-while-true': noUnboundedWhileTrue,
    'no-inline-import-type': noInlineImportType,
    'no-eslint-disable': noEslintDisable,
    'no-unsafe-cast': noUnsafeCast,
  },
};

/** 品味规则配置 */
export const tasteRules = {
  // 类型即契约
  // no-explicit-any 设为 error（与 CLAUDE.md / quality-gates.md 文档一致）。
  // 生产代码目前 0 个显式 any；如需不可避免场景，用 unknown + 类型守卫。
  '@typescript-eslint/no-explicit-any': 'error',

  // 允许 _ 前缀的未使用变量和参数（惯用模式）
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

  // 结构先于一切
  'max-lines': ['warn', { max: 1000, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],

  // 语义化命名
  'no-magic-numbers': ['warn', {
    ignore: [0, 1, -1],
    ignoreArrayIndexes: true,
  }],

  // 反馈不断裂
  'no-empty': 'error',

  // 安全无例外
  'no-eval': 'error',
  'no-implied-eval': 'error',

  // Import 排序
  'simple-import-sort/imports': 'warn',
  'simple-import-sort/exports': 'warn',

  // 品味自定义规则
  'taste/prefer-allsettled': 'warn',
  'taste/no-silent-catch': 'warn',
  'taste/no-unbounded-while-true': 'warn',
  'taste/no-inline-import-type': 'warn',
  // taste/no-eslint-disable 通过 githook pre-commit 在变更文件中强制执行，不在 ESLint 配置中启用
  // 检测 as never / as any / as unknown as / 全可选结构断言
  'taste/no-unsafe-cast': 'warn',
};

export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { taste: tastePlugin, 'simple-import-sort': simpleImportSort },
    rules: tasteRules,
  },
  // 测试文件：describe/it 回调天然包含大量用例声明，max-lines-per-function 的 300 行限制
  // 不适用（规则本意是防逻辑复杂，非防测试用例多）。社区标准做法是对测试文件豁免。
  // 生产代码仍受 300 行约束。结构问题由 review 把关。
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/vitest.config.ts'],
    rules: {
      'max-lines-per-function': 'off',
      // 测试文件随用例增长，1000 行限制不适用（社区标准对测试文件豁免）
      'max-lines': 'off',
    },
  },
  // mock 桩文件：常含字面量数据表与桩实现，
  // no-magic-numbers 与 max-lines-per-function 不适用（数据非逻辑）。
  {
    files: ['**/mocks/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'no-magic-numbers': 'off',
    },
  },
  {
    ignores: ['**/node_modules/**', '.xyz-harness/**', '**/*.d.ts'],
  },
];
