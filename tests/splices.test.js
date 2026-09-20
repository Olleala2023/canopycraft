import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel, splicePlan, spread } from '../src/core/model.js';
import { analyse, billOfMaterials, spliceReport } from '../src/core/analysis.js';

test('раскладка стыков: хлысты от левого конца, остаток в последнем куске', () => {
  const one = splicePlan(6000, 6000, [0, 3000, 6000]);
  assert.equal(one.pieces, 1, 'ровно хлыст — стыковать нечего');
  assert.equal(one.splices, 0);
  assert.deepEqual(one.at, []);

  const two = splicePlan(9000, 6000, [0, 2250, 4500, 6750, 9000]);
  assert.equal(two.pieces, 2);
  assert.equal(two.splices, 1);
  assert.deepEqual(two.at, [6000], 'стык через длину хлыста от левого конца');
  assert.deepEqual(two.cuts.map((c) => c.length), [6000, 3000], 'остаток уходит в последний кусок');

  const three = splicePlan(13000, 6000, [0, 6500, 13000]);
  assert.equal(three.pieces, 3);
  assert.deepEqual(three.at, [6000, 12000]);
});

test('допуск в миллиметр не плодит лишний стык на округлениях длины', () => {
  assert.equal(splicePlan(6000.4, 6000, []).pieces, 1, 'полмиллиметра сверх хлыста — тот же хлыст');
  assert.equal(splicePlan(6002, 6000, []).pieces, 2, 'а два миллиметра уже стык');
});

test('кусок меньше чем на двух опорах — геометрически изменяемая схема', () => {
  // опоры 0/2250/4500/6750/9000: оба куска ложатся на несколько опор
  const ok = splicePlan(9000, 6000, [0, 2250, 4500, 6750, 9000]);
  assert.equal(ok.unstable, false);
  assert.deepEqual(ok.cuts.map((c) => c.supports), [3, 2]);

  // опоры 0/2000/4000/9000: правый кусок 6000–9000 висит на одной
  const bad = splicePlan(9000, 6000, [0, 2000, 4000, 9000]);
  assert.equal(bad.unstable, true);
  assert.equal(bad.cuts[1].supports, 1);
  assert.equal(bad.cuts[0].unstable, false, 'левый кусок при этом в порядке');
});

test('опора точно в месте стыка засчитывается обоим кускам', () => {
  const p = splicePlan(9000, 6000, [0, 3000, 6000, 9000]);
  assert.deepEqual(p.cuts.map((c) => c.supports), [3, 2], 'опора 6000 попала в оба куска');
  assert.equal(p.unstable, false);
});

test('расчёт по умолчанию укладывается в хлыст и о стыках не говорит', () => {
  const res = analyse(defaultModel());
  assert.deepEqual(res.splices, [], 'навес 6 м при хлысте 6 м стыков не требует');
  const b = billOfMaterials(res);
  assert.ok(b.items.every((i) => i.splices === 0));
  assert.ok(b.items.every((i) => Number.isFinite(i.stockPieces)), 'число хлыстов известно для всех позиций');
});

test('навес шире хлыста: стыки названы и посчитаны', () => {
  const m = defaultModel();
  m.geom.B = 9000;
  m.rafters.xs = spread(9000, 16);
  m.posts.xs = spread(9000, 5);
  m.wallPosts.xs = spread(9000, 7);

  const rep = spliceReport(m);
  const purlin = rep.find((s) => s.key === 'purlin');
  assert.ok(purlin, 'прогон длиной 9 м не помещается в хлыст 6 м');
  assert.equal(purlin.splices, 1);
  assert.equal(purlin.unstable, false);
  assert.ok(!rep.some((s) => s.key === 'rafters'), 'стропило 4,9 м стыковать не нужно');

  const b = billOfMaterials(analyse(m));
  const item = b.items.find((i) => i.name === 'Прогон наружный');
  assert.equal(item.stockPieces, 2, 'раньше здесь стоял прочерк');
  assert.equal(item.splices, 1);
  const battens = b.items.find((i) => i.name === 'Обрешётка');
  assert.equal(battens.splices, battens.count, 'по одному стыку на каждую доску обрешётки');
});

test('расстановка столбов, при которой кусок остаётся на одной опоре', () => {
  const m = defaultModel();
  m.geom.B = 9000;
  m.rafters.xs = spread(9000, 16);
  m.posts.xs = [0, 2000, 4000, 9000];
  m.wallPosts.xs = spread(9000, 7);

  const purlin = analyse(m).splices.find((s) => s.key === 'purlin');
  assert.equal(purlin.unstable, true, 'кусок 6000–9000 ложится на один столб');
  assert.equal(purlin.cuts.find((c) => c.unstable).x0, 6000);
});

test('столбы попадают в отчёт при коротком хлысте, но схему по ним не судим', () => {
  const m = defaultModel();
  m.opts.stockLength = 4000;
  m.geom.postHeight = 4000; // + 300 мм заделки — длиннее хлыста 4 м
  const posts = spliceReport(m).find((s) => s.key === 'posts');
  assert.ok(posts, 'столб длиннее хлыста должен быть назван');
  assert.equal(posts.splices, 1);
  assert.equal(posts.unstable, false, 'стойка — не балка на опорах, изменяемости тут не считаем');
});
