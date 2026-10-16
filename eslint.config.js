// @ts-check
// 渐进式 ESLint 配置：先用非类型感知规则（快，适配 9000+ 行的大文件），
// 只对确定性的正确性问题报 error，其余先保持 warn，后续再逐步收紧。
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
    files: ['src/**/*.{ts,tsx,js}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
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
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
      '@typescript-eslint/no-unused-expressions': [
        'warn',
        { allowShortCircuit: true, allowTernary: true },
      ],
      'no-extra-boolean-cast': 'warn',
      // 已人工核实：skyboxTextureLoad 的 finally-throw 用于保留原始错误；cadUnits 的秒差距常量精度损失可接受。
      'no-unsafe-finally': 'warn',
      'no-loss-of-precision': 'warn',
    },
  },
);
