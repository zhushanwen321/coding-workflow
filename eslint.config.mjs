import tasteConfig from './taste-lint/base.mjs';

export default [
  ...tasteConfig,
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      // 测试 fixture 值（时间偏移、大小阈值等）在上下文中自解释，无需命名常量
      'no-magic-numbers': 'off',
      // 测试构造 fixture 需要灵活的类型断言，放宽 unsafe-cast 检测
      'taste/no-unsafe-cast': 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.xyz-harness/**',
      'skill/**',
    ],
  },
];
