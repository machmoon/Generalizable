import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      // v7 moved the flat-config export under .flat; the top-level one is the
      // legacy eslintrc shape and crashes ESLint 9 (plugins as string array).
      // 'recommended' is the stable ruleset (rules-of-hooks + exhaustive-deps),
      // matching pre-v7 behaviour; 'recommended-latest' adds the new compiler
      // rules and raises 300+ new errors — adopt those deliberately, not via
      // a dependency bump.
      reactHooks.configs.flat['recommended'],
      reactRefresh.configs.vite
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // The six rules v7 added from the React Compiler. They fire 316 times on
      // today's code; surfaced as warnings so lint runs again and the findings
      // stay visible - promote them back to errors as the code adopts them.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/static-components': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "react-refresh/only-export-components": "off"
    }
  },
])
