import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel } from '../src/core/model.js';
import { analyse, billOfMaterials } from '../src/core/analysis.js';
import { FASTENERS, fastener, shearCapacity, fitCount, spacingRules } from '../src/core/fasteners.js';

test('несущая способность крепежа — по табл. 20 СП 64', () => {
  // гвоздь 4 мм: изгиб 2,5·d² = 2,5·0,4² = 0,40 кН, смятие 0,35·c·d при c = 42 мм
  const nail = fastener('nail4x50');
  const c = shearCapacity(nail, { woodWidth: 50, mv: 1 });
  assert.equal(Math.round(c.pen), 42, 'глубина = длина − полка 2 мм − заострение 1,5d');
  assert.ok(Math.abs(c.bend - 400) < 1, `изгиб ${c.bend.toFixed(0)} Н`);
  assert.ok(Math.abs(c.bearing - 0.35 * 4.2 * 0.4 * 1000) < 1, `смятие ${c.bearing.toFixed(0)} Н`);
  assert.equal(c.T, Math.min(c.bend, c.bearing));
  assert.equal(c.governs, 'изгиб крепежа');

  // болт М10 насквозь: смятие 0,35·5·1 = 1,75 кН против изгиба 1,8·1² = 1,8 кН
  const bolt = shearCapacity(fastener('bolt10'), { woodWidth: 50, mv: 1 });
  assert.equal(bolt.pen, 50, 'болт проходит сквозь стропило');
  assert.ok(Math.abs(bolt.bearing - 1750) < 1);
  assert.ok(Math.abs(bolt.bend - 1800) < 1);
  assert.equal(bolt.governs, 'смятие древесины');

  // условия эксплуатации снижают несущую способность
  const wet = shearCapacity(nail, { woodWidth: 50, mv: 0.9 });
  assert.ok(Math.abs(wet.T - 0.9 * c.T) < 1e-9);
});

test('расстановка и вместимость узла', () => {
  const nail = fastener('nail4x50');
  const s = spacingRules(nail);
  assert.equal(s.s1, 60, 'S1 = 15d для гвоздей');
  assert.equal(s.s2, 16, 'S2 = 4d');
  assert.equal(s.s3, 16, 'S3 = 4d');
  const bolt = spacingRules(fastener('bolt10'));
  assert.equal(bolt.s1, 70, 'S1 = 7d для стальных нагелей');

  // на полке уголка 90 мм при S1 = 60 помещается один столбец, уголка два
  const fit = fitCount(nail, { rafterH: 250 });
  assert.equal(fit.cols, 1);
  assert.equal(fit.n, fit.cols * fit.rows * 2, 'два уголка с обеих сторон');
  // у высокого стропила сетку ограничивает полка уголка, а не высота сечения
  assert.deepEqual(fitCount(nail, { rafterH: 400 }), fit);
  // а у низкого — уже высота сечения
  assert.ok(fitCount(nail, { rafterH: 50 }).n < fit.n);
  // болт идёт сквозь стропило: там сетку задаёт само сечение
  assert.ok(fitCount(fastener('bolt10'), { rafterH: 250 }).rows
    > fitCount(fastener('bolt10'), { rafterH: 100 }).rows);
});

test('узел считается от отрыва, а число крепежей растёт с ветром', () => {
  const calm = analyse(defaultModel());
  const windy = analyse({ ...defaultModel(), site: { ...defaultModel().site, windRegion: 'V' } });

  for (const r of [calm, windy]) {
    assert.ok(r.ties.outer.force > 0 && r.ties.wall.force > 0);
    // скатная составляющая доходит только до нижней опоры
    assert.ok(r.ties.outer.along > 0);
    assert.equal(r.ties.wall.along, 0);
    assert.ok(r.ties.outer.need >= 2 && r.ties.wall.need >= 2, 'минимум два крепежа на узел');
  }
  assert.ok(windy.ties.outer.force > calm.ties.outer.force * 1.8, 'ветер V поднимает сильнее');
  assert.ok(windy.ties.outer.need > calm.ties.outer.need);

  // узел попадает в сводку
  const row = calm.summary.find((s) => s.key === 'ties');
  assert.ok(row && row.U > 0, 'строка «Крепление стропил» в сводке');
});

test('когда гвоздей не хватает, узел не проходит по вместимости', () => {
  const m = defaultModel();
  m.site.windRegion = 'VII';
  m.site.terrain = 'A';
  const nails = analyse({ ...m, rafterTie: { id: 'nail4x50' } });
  assert.ok(nails.ties.outer.need > nails.ties.outer.fit.n, 'требуется больше, чем помещается');
  assert.equal(nails.ties.outer.worst.name, 'Крепёж помещается в узле');
  assert.ok(nails.ties.outer.U > 1);

  // болты решают ту же задачу вчетверо меньшим числом
  const bolts = analyse({ ...m, rafterTie: { id: 'bolt10' } });
  assert.ok(bolts.ties.outer.need * 4 <= nails.ties.outer.need);
  assert.ok(bolts.ties.outer.U <= 1, `U = ${bolts.ties.outer.U.toFixed(2)}`);
});

test('крепёж узлов попадает в спецификацию', () => {
  const m = defaultModel();
  const r = analyse(m);
  const b = billOfMaterials(r);
  const angles = b.fasteners.find((f) => f.name.startsWith('Уголок'));
  const nails = b.fasteners.find((f) => f.name.startsWith('Гвоздь'));
  assert.ok(angles && angles.count === 4 * m.rafters.xs.length, 'по два уголка на каждый из двух узлов');
  assert.ok(nails && nails.count === (r.ties.outer.need + r.ties.wall.need) * m.rafters.xs.length);
  // масса метизов в сводке масс учитывает и крепёж узлов
  const group = b.weights.groups.find((g) => g.name === 'Метизы');
  assert.ok(group.mass >= angles.mass + nails.mass);

  // болтовой вариант уголков не требует
  const bolted = billOfMaterials(analyse({ ...m, rafterTie: { id: 'bolt12' } }));
  assert.ok(!bolted.fasteners.some((f) => f.name.startsWith('Уголок')));
  assert.ok(bolted.fasteners.some((f) => f.name.startsWith('Болт М12')));
});

test('каждый крепёж из каталога даёт рабочий расчёт', () => {
  for (const f of FASTENERS) {
    const r = analyse({ ...defaultModel(), rafterTie: { id: f.id } });
    const t = r.ties.outer;
    assert.ok(Number.isFinite(t.U) && t.need >= 2, `${f.id}: U = ${t.U}`);
    assert.ok(t.penetration >= 4 * f.d, `${f.id}: защемление ${t.penetration} < 4d`);
  }
});
