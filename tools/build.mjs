/**
 * Однофайловая сборка: dev.html + styles.css + модули → index.html.
 * Никаких зависимостей: модули просто склеиваются в порядке зависимостей,
 * import/export снимаются, всё оборачивается в одну IIFE.
 *   node tools/build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = [
  'src/core/sections.js',
  'src/core/materials.js',
  'src/core/loads.js',
  'src/core/beam.js',
  'src/core/checks.js',
  'src/core/fasteners.js',
  'src/core/model.js',
  'src/core/share.js',
  'src/core/analysis.js',
  'src/core/optimize.js',
  'src/core/search.js',
  'src/ui/views.js',
  'src/ui/app.js',
];

/**
 * Склейка снимает import'ы, поэтому переименование при импорте
 * (import { a as b }) в бандле превращается в обращение к несуществующему
 * имени — модульные тесты при этом проходят. Ловим на сборке.
 */
function aliasedImports(src, file) {
  const out = [];
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';/gm)) {
    for (const part of m[1].split(',')) {
      const as = /(\S+)\s+as\s+(\S+)/.exec(part.trim());
      if (as) out.push(`${as[1]} as ${as[2]} (${file} ← ${m[2]})`);
    }
  }
  return out;
}

function strip(src) {
  return src
    .replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\};\s*$/gm, '')
    .replace(/^export\s+(const|let|var|function|class|async)/gm, '$1');
}

/**
 * Склейка не даёт модулям своей области видимости, поэтому одинаковые имена
 * верхнего уровня в разных файлах ломают бандл молча — браузер падает на
 * «Identifier has already been declared». Ловим это на сборке.
 */
function topLevelNames(src) {
  const names = [];
  for (const line of src.split('\n')) {
    const m = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

const raw = ORDER.map((f) => ({ f, text: readFileSync(join(root, f), 'utf8') }));
const aliases = raw.flatMap(({ f, text }) => aliasedImports(text, f));
if (aliases.length) {
  console.error('Переименование при импорте не переживает склейку:\n  ' + aliases.join('\n  '));
  process.exit(1);
}
const pieces = raw.map(({ f, text }) => ({ f, src: strip(text) }));
const seen = new Map();
const clashes = [];
for (const { f, src } of pieces) {
  for (const n of topLevelNames(src)) {
    if (seen.has(n) && seen.get(n) !== f) clashes.push(`${n}: ${seen.get(n)} и ${f}`);
    else seen.set(n, f);
  }
}
if (clashes.length) {
  console.error('Одинаковые имена верхнего уровня в разных модулях:\n  ' + clashes.join('\n  '));
  process.exit(1);
}

const bundle = pieces.map(({ f, src }) => `/* ── ${f} ── */\n${src}`).join('\n');
const tokens = readFileSync(join(root, 'src/ui/tokens.css'), 'utf8');
const css = tokens + readFileSync(join(root, 'src/ui/styles.css'), 'utf8');

// страницы справки — обычные статические файлы, но палитру берут из тех же токенов
const helpCss = tokens + readFileSync(join(root, 'src/ui/help.css'), 'utf8');
writeFileSync(join(root, 'help/help.css'), helpCss);
let html = readFileSync(join(root, 'dev.html'), 'utf8');

html = html
  .replace('<link rel="stylesheet" href="src/ui/styles.css">', `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="src/ui/app.js"></script>',
    `<script>\n(function(){\n"use strict";\n${bundle}\n})();\n</script>`);

writeFileSync(join(root, 'index.html'), html);

// вариант для публикации в Artifact: без doctype/html/head/body — обёртку добавляет платформа
const inner = html
  .replace(/^[\s\S]*?<title>/, '<title>')
  .replace(/<\/head>\s*<body>/, '')
  .replace(/<\/body>\s*<\/html>\s*$/, '');
writeFileSync(join(root, 'docs/app.artifact.html'), inner);
console.log(`index.html собран: ${(html.length / 1024).toFixed(0)} КБ; docs/app.artifact.html: ${(inner.length / 1024).toFixed(0)} КБ; help/help.css: ${(helpCss.length / 1024).toFixed(0)} КБ`);
