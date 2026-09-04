// ESLint flat config (eslint v9). Replaces the classic .eslintrc.json
// planned in REFACTORING.md §6 batch 2 — eslint 9 no longer reads
// .eslintrc by default; this is the functional equivalent of
// `extends: ["eslint:recommended"]`.
//
// Scope: server/ + test/ only (Node ESM). public/app/main.js is a
// browser SPA without build tooling — intentionally not linted here.
import js from '@eslint/js'
import globals from 'globals'

export default [
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'test/**/*.js', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // v0.5.bx-30 was exactly this class of bug (undefined shorthand var
      // inside a promise callback). Keep it as an error, not a warning.
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      // Codebase convention: deliberate silent catches (`catch {}`) as
      // defensive fallbacks — allowed, per REFACTORING.md batch 2
      // "lint only, do not fix existing code".
      'no-empty': ['error', { allowEmptyCatch: true }],
      // False positives in this codebase: ANSI-strip control regexes and
      // CJK full-width spaces in zh-CN strings/comments.
      'no-control-regex': 'off',
      'no-irregular-whitespace': 'off',
      // Genuine nits — kept as errors; all existing hits were fixed in the
      // batch-2 cleanup commit.
      'no-useless-assignment': 'error',
      'no-useless-escape': 'error',
    },
  },
]
