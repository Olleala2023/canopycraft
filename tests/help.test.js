import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CONTROLS } from '../src/ui/controls.js';

/**
 * Справка к полям: у каждого поля — статья или пояснение прямо в панели, а
 * каждая ссылка «?» ведёт на существующую статью и существующий раздел.
 */

const help = fileURLToPath(new URL('../help/', import.meta.url));
const fields = CONTROLS.filter((c) => c.k);

test('у каждого поля есть статья справки или пояснение', () => {
  const bare = fields.filter((c) => !c.help && !c.note).map((c) => `${c.k} («${c.label}»)`);
  assert.deepEqual(bare, [], 'поле без объяснения — человек не поймёт, что туда вводить');
});

test('ссылки «?» ведут на существующие статьи и разделы', () => {
  const broken = [];
  for (const c of fields.filter((f) => f.help)) {
    const [file, anchor] = c.help.split('#');
    if (!existsSync(join(help, file))) { broken.push(`${c.k}: нет help/${file}`); continue; }
    if (anchor && !readFileSync(join(help, file), 'utf8').includes(`id="${anchor}"`)) broken.push(`${c.k}: в help/${file} нет раздела #${anchor}`);
    if (!c.helpTitle) broken.push(`${c.k}: нет helpTitle — подсказка у «?» будет пустой`);
  }
  assert.deepEqual(broken, []);
});

test('каждая статья есть в оглавлении справки', () => {
  const index = readFileSync(join(help, 'index.html'), 'utf8');
  const missing = readdirSync(help)
    .filter((f) => f.endsWith('.html') && f !== 'index.html')
    .filter((f) => !index.includes(`href="${f}"`));
  assert.deepEqual(missing, [], 'статью не найти, если на неё не ведёт оглавление');
});
