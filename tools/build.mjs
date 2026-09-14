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
  'src/core/model.js',
  'src/core/share.js',
  'src/core/analysis.js',
  'src/core/optimize.js',
  'src/ui/views.js',
  'src/ui/app.js',
];

function strip(src) {
  return src
    .replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\};\s*$/gm, '')
    .replace(/^export\s+(const|let|var|function|class|async)/gm, '$1');
}

const bundle = ORDER.map((f) => `/* ── ${f} ── */\n${strip(readFileSync(join(root, f), 'utf8'))}`).join('\n');
const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
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
console.log(`index.html собран: ${(html.length / 1024).toFixed(0)} КБ; docs/app.artifact.html: ${(inner.length / 1024).toFixed(0)} КБ`);
