// Local flat config for wave 1; W1-D replaces it with the workspace root config.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'vectors/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Money is bigint only: forbid the usual ways floating-point creeps in.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'No floating point in settlement.' }, { name: 'parseInt', message: 'Use BigInt().' }],
      'no-restricted-properties': [
        'error',
        { object: 'Math', message: 'Math works on number; money is bigint.' },
        { object: 'Number', property: 'parseFloat', message: 'No floating point in settlement.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='Number']", message: 'Do not convert to number in settlement code.' },
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
