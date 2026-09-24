import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Палитра — только src/ui/tokens.css. Всё остальное берёт цвета через var(--…),
 * иначе тёмная тема и печать разъезжаются: цвет, вписанный напрямую, не
 * переключается вместе с темой.
 */

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const read = (f) => readFileSync(join(root, f), 'utf8');

/** Вырезает блоки @media print { … } — печать всегда светлая, там HEX законны. */
function withoutPrint(css) {
  let out = '';
  let i = 0;
  for (;;) {
    const at = css.indexOf('@media print', i);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, at);
    let j = css.indexOf('{', at);
    for (let depth = 0; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
}

/** Блок @media print { … } целиком. */
function printBlock(css) {
  const at = css.indexOf('@media print');
  return at < 0 ? '' : css.slice(at, css.length - withoutPrint(css.slice(at)).length);
}

const RAW = [
  [/#[0-9A-Fa-f]{3,8}\b/g, 'HEX'],
  [/\b(?:rgba?|hsla?)\(/g, 'rgb()/hsl()'],
  [/(?:fill|stroke|stop-color|color|background)\s*[=:]\s*['"]?(?:white|black|red|green|blue|gr[ae]y|orange|yellow)\b/g, 'имя цвета'],
];

/** Находки «сырых» цветов с номерами строк; ссылки url(#…) и href="#…" не цвета. */
function rawColors(text) {
  const found = [];
  text.split('\n').forEach((line, n) => {
    const clean = line.replace(/url\(#[^)]*\)|href="#[^"]*"|'#'/g, '');
    for (const [re, kind] of RAW) {
      for (const m of clean.matchAll(re)) found.push(`строка ${n + 1}: ${kind} ${m[0]}`);
    }
  });
  return found;
}

const SOURCES = [
  'src/ui/styles.css',
  'src/ui/help.css',
  'src/ui/views.js',
  'src/ui/app.js',
  ...readdirSync(join(root, 'help')).filter((f) => f.endsWith('.html')).map((f) => `help/${f}`),
];

test('цвета вне tokens.css — только через var(--…), кроме печати', () => {
  for (const f of SOURCES) {
    const text = f.endsWith('.css') ? withoutPrint(read(f)) : read(f);
    assert.deepEqual(rawColors(text), [], `${f}: цвет вписан напрямую — заведите токен в src/ui/tokens.css`);
  }
});

test('dev.html: цвета только через токены, theme-color совпадает с --accent', () => {
  const html = read('dev.html');
  const meta = /<meta name="theme-color" content="(#[0-9A-Fa-f]+)">/.exec(html);
  assert.ok(meta, 'нет <meta name="theme-color">');
  const accent = /--accent:\s*(#[0-9A-Fa-f]+)/.exec(read('src/ui/tokens.css'))[1];
  assert.equal(meta[1].toUpperCase(), accent.toUpperCase(), 'theme-color разошёлся с --accent светлой темы');
  assert.deepEqual(rawColors(html.replace(meta[0], '')), [], 'dev.html: цвет вписан напрямую');
});

/** Имена токенов, объявленных в куске CSS. */
const tokenNames = (css) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).sort();

test('каждый токен объявлен в светлой теме, в обеих тёмных и в печати', () => {
  const css = read('src/ui/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, sel, body]) => ({ sel: sel.trim(), names: tokenNames(body) }))
    .filter((b) => b.names.length);
  const light = blocks.find((b) => b.sel === ':root');
  const darkMedia = blocks.find((b) => b.sel === ':root:not([data-theme="light"])');
  const darkAttr = blocks.find((b) => b.sel === ':root[data-theme="dark"]');
  assert.ok(light && darkMedia && darkAttr, 'в tokens.css нет одного из трёх блоков палитры');
  assert.deepEqual(darkMedia.names, light.names, 'тёмная тема по prefers-color-scheme: не тот набор токенов');
  assert.deepEqual(darkAttr.names, light.names, 'тёмная тема по data-theme: не тот набор токенов');

  // color-scheme не токен, а в печатном блоке кроме токенов есть и правила
  const print = tokenNames(printBlock(read('src/ui/styles.css')));
  const missing = light.names.filter((n) => !print.includes(n));
  assert.deepEqual(missing, [], 'печатный блок styles.css: токен не переопределён — в печати возьмётся цвет экранной темы');
});

test('var(--…) ссылается только на объявленные токены', () => {
  const declared = new Set([
    ...tokenNames(read('src/ui/tokens.css')),
    ...SOURCES.filter((f) => f.endsWith('.css')).flatMap((f) => tokenNames(read(f))),
  ]);
  for (const f of SOURCES) {
    const unknown = [...new Set([...read(f).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))].filter((n) => !declared.has(n));
    assert.deepEqual(unknown, [], `${f}: ссылка на необъявленный токен — цвет молча пропадёт`);
  }
});
