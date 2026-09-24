import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Каждый модуль импортирует всё, чем пользуется из других модулей.
 *
 * Склейка в index.html кладёт все модули в одну область видимости, поэтому
 * забытый импорт там не виден: имя и так доступно. А модульная версия
 * (dev.html) падает — так при разбивке app.js на модули потерялись f2 и
 * ROOFING. Тест ищет имена, которые объявлены на верхнем уровне другого
 * модуля, используются здесь, но не импортированы и не объявлены локально.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['src/core', 'src/ui'].flatMap((d) =>
  readdirSync(join(root, d)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`));
const read = (f) => readFileSync(join(root, f), 'utf8');

/** Код без комментариев и без текста строк — чтобы слово в подсказке не считалось использованием. */
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const topLevel = (src) => [...src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const imported = (src) => [...src.matchAll(/^import\s*\{([^}]*)\}\s*from/gm)]
  .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
/** Любое локальное объявление в модуле: переменная, функция, класс, параметры функций и стрелок. */
function declared(code) {
  const names = [...code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const params = [
    ...code.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g),
    ...code.matchAll(/\(([^()]*)\)\s*=>/g),
  ].flatMap((m) => m[1].match(/[A-Za-z_$][\w$]*(?=\s*(?:=|,|$|\}))/g) ?? []);
  const arrow = [...code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)].map((m) => m[1]);
  return new Set([...names, ...params, ...arrow]);
}

test('модули импортируют всё, чем пользуются из других модулей', () => {
  const owners = new Map();
  for (const f of files) for (const n of topLevel(read(f))) owners.set(n, f);
  const problems = [];
  for (const f of files) {
    const src = read(f);
    // импорт и реэкспорт — сами по себе не использование
    const code = codeOf(src
      .replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, '')
      .replace(/^export\s*\{[^}]*\}\s*from\s*'[^']+';\s*$/gm, ''));
    const known = new Set([...imported(src), ...declared(code)]);
    for (const [name, owner] of owners) {
      if (owner === f || known.has(name)) continue;
      const re = new RegExp(`(?:(?<=\\.\\.\\.)|(?<![\\w$.]))${name.replace(/\$/g, '\\$')}(?![\\w$\\{])(?!\\s*:)`);
      if (re.test(code)) problems.push(`${f}: «${name}» из ${owner} не импортирован`);
    }
  }
  assert.deepEqual(problems, [], 'модульная версия (dev.html) упадёт на этих именах');
});
