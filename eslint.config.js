// Root ESLint flat config. Packages run `eslint .` and pick this file up.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'contracts/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.wrangler/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Settlement keeps the stricter type-checked set it was written against.
    files: ['packages/settle/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Settlement money is bigint only: forbid the usual ways floating point creeps in.
    files: ['packages/settle/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'No floating point in settlement.' },
        { name: 'parseInt', message: 'Use BigInt().' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', message: 'Math works on number; money is bigint.' },
        { object: 'Number', property: 'parseFloat', message: 'No floating point in settlement.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number']",
          message: 'Do not convert to number in settlement code.',
        },
      ],
    },
  },
);
