import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/core/version.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('версия: src/core/version.js, package.json и CHANGELOG.md говорят одно', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, 'версия не вида X.Y.Z');
  assert.equal(JSON.parse(read('package.json')).version, VERSION, 'package.json разошёлся с src/core/version.js');
  const top = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/m.exec(read('CHANGELOG.md'));
  assert.ok(top, 'в CHANGELOG.md нет записи вида «## X.Y.Z — ГГГГ-ММ-ДД»');
  assert.equal(top[1], VERSION, 'верхняя запись CHANGELOG.md не про текущую версию — допишите, что изменилось');
});

test('версия не вписана руками в dev.html — её ставит app.js', () => {
  assert.ok(!/>v\d+\.\d+/.test(read('dev.html')), 'в dev.html осталась версия текстом: она разойдётся с src/core/version.js');
});
