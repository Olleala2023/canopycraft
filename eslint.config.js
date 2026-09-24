/**
 * Проверка кода: забытые импорты, необъявленные и неиспользуемые имена,
 * опечатки. Правила — рекомендуемый набор ESLint.
 *
 *   npm run lint
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['index.html', 'docs/**', 'help/**', 'node_modules/**', 'smoke-shots/**'] },
  js.configs.recommended,
  {
    // Неиспользуемый параметр — не ошибка: у видов чертежа, проверок и расчётов
    // одинаковые подписи (res, sel), (model, cfg, …), и единая подпись важнее.
    rules: { 'no-unused-vars': ['error', { args: 'none' }] },
  },
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
  {
    // браузер — только интерфейсу; расчётное ядро про него не знает, и document
    // или window в src/core — ошибка «не объявлено»
    files: ['src/ui/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    // ядру — только то, что есть и в браузере, и в Node (таймеры, TextEncoder,
    // btoa): оно же гоняется в тестах под Node
    files: ['src/core/**/*.js'],
    languageOptions: { globals: globals['shared-node-browser'] },
  },
  {
    files: ['tests/**/*.js', 'tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },
];
