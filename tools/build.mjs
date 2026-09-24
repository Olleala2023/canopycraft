/**
 * Сборка: dev.html + стили + модули → index.html одним файлом.
 *
 * Модули собирает esbuild (src/ui/app.js — точка входа), стили и скрипт
 * вклеиваются в страницу. Итог — один самодостаточный файл: открывается
 * двойным кликом, работает офлайн, без сервера.
 *
 *   npm run build
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

const { outputFiles } = buildSync({
  entryPoints: [join(root, 'src/ui/app.js')],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  // без минификации: собранный index.html лежит в репозитории, и его разница
  // в PR должна читаться
  minify: false,
  charset: 'utf8',
  legalComments: 'inline',
  write: false,
  logLevel: 'error',
});
// «</script» внутри строки закрыл бы встроенный <script> раньше времени
const bundle = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const tokens = read('src/ui/tokens.css');
const css = tokens + read('src/ui/styles.css');

// страницы справки — обычные статические файлы, но палитру берут из тех же токенов
const helpCss = tokens + read('src/ui/help.css');
writeFileSync(join(root, 'help/help.css'), helpCss);

const page = read('dev.html');
const links = '<link rel="stylesheet" href="src/ui/tokens.css">\n<link rel="stylesheet" href="src/ui/styles.css">';
const entry = '<script type="module" src="src/ui/app.js"></script>';
for (const part of [links, entry]) {
  if (!page.includes(part)) {
    console.error(`В dev.html нет ожидаемой строки — сборке некуда вклеить:\n  ${part}`);
    process.exit(1);
  }
}
const html = page
  .replace(links, `<style>\n${css}\n</style>`)
  .replace(entry, `<script>\n${bundle}</script>`);
writeFileSync(join(root, 'index.html'), html);

// вариант для публикации в Artifact: без doctype/html/head/body — обёртку добавляет платформа
const inner = html
  .replace(/^[\s\S]*?<title>/, '<title>')
  .replace(/<\/head>\s*<body>/, '')
  .replace(/<\/body>\s*<\/html>\s*$/, '');
writeFileSync(join(root, 'docs/app.artifact.html'), inner);
console.log(`index.html собран: ${(html.length / 1024).toFixed(0)} КБ; docs/app.artifact.html: ${(inner.length / 1024).toFixed(0)} КБ; help/help.css: ${(helpCss.length / 1024).toFixed(0)} КБ`);
