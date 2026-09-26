import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The API base URL must come from the environment, never a literal.
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^https?:\\/\\//]",
          message:
            'Hardcoded absolute URLs are not allowed. Use the API base URL from import.meta.env.',
        },
      ],
    },
  },
  {
    // Deployment config runs in Node at build time, not in the browser.
    files: ['vercel.mjs', 'vercel.test.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-syntax': 'off' },
  },
);
