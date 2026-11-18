import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  globalIgnores([
    '**/build/',
    '**/dist/',
    '**/target/',
    '**/vendor/',
    '**/.build/',
    '**/.dart_tool/',
    '**/Pods/',
    '.tools/',
    '.local/',
    'config/private/',
    'data/',
    'operations-dist/',
    'release/',
    'test-results/',
  ]),
  js.configs.recommended,
  {
    rules: {
      // Input validators explicitly reject ASCII controls in filenames and URLs.
      'no-control-regex': 'off',
      // User-facing errors can intentionally discard credentials and private paths in the cause.
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['eslint.config.mjs', '{desktop,examples,scripts,server/workers,tests}/**/*.{js,cjs,mjs}'],
    ignores: ['desktop/ui/**'],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  { files: ['**/*.cjs'], languageOptions: { globals: globals.node } },
  {
    files: ['desktop/ui/**/*.js', 'docs/showcase/**/*.mjs', 'web/public/offline.js'],
    languageOptions: { globals: globals.browser },
  },
  { files: ['web/public/sw.js'], languageOptions: { globals: globals.serviceworker } },
  { files: ['web/public/*.worklet.js'], languageOptions: { globals: globals.audioWorklet } },
]);
