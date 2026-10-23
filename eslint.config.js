// @ts-check
// 使用非类型感知规则保持检查速度，正确性与导入边界规则作为硬门禁。
// 其余质量告警持续保留，不能通过忽略源码或降低规则隐藏问题。
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      'dist-viewer-template/**',
      'release/**',
      'output/**',
      'artifacts/**',
      'test-artifacts/**',
      'public/**',
      'Assets/**',
      'Platforms/**',
      'Projects/**',
      'SharedResources/**',
      'standalone-opening/**',
      '.tmp-*/**',
      '.babylon-editor/**',
      '.codex-remote-env/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx,js}', 'electron/**/*.{ts,cts,js}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@babylonjs/core',
              allowTypeImports: true,
              message:
                '禁止从 @babylonjs/core 根入口导入运行时值；请使用精确的 @babylonjs/core/.../*.js 子路径或 import type。',
            },
            {
              name: '@babylonjs/loaders',
              allowTypeImports: true,
              message:
                '禁止从 @babylonjs/loaders 根入口导入；请使用 babylonGltfLoader.js 或具体子路径。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['electron/**/*.{ts,cts,js}', 'scripts/**/*.mjs', 'tests/**/*.{ts,mjs}', 'vite*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      // 项目大量使用 Babylon / MQTT 动态载荷，先以告警方式暴露，不阻塞合并。
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'warn',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'warn',
      'no-case-declarations': 'warn',
      'prefer-const': 'warn',
      // ESLint 10 新增的风格类推荐规则：存量代码较多，先告警后治理。
      'preserve-caught-error': 'error',
      'no-useless-assignment': 'error',
      '@typescript-eslint/no-unused-expressions': [
        'warn',
        { allowShortCircuit: true, allowTernary: true },
      ],
      'no-extra-boolean-cast': 'warn',
      // 取消失败显式保留原错误；常量使用与原IEEE754值严格相等的表示。
      'no-unsafe-finally': 'error',
      'no-loss-of-precision': 'warn',
    },
  },
);
