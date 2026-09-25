import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel, levels, boltHeights } from '../src/core/model.js';
import { analyse, houseWall, openingsOf, houseClashes, wallMarks } from '../src/core/analysis.js';
import { drawFacade } from '../src/ui/facade.js';
import { buildContext } from '../src/ui/solids.js';
import { encodeModel, decodeModel } from '../src/core/share.js';
import { drawPlan } from '../src/ui/views.js';
import { warningsHtml } from '../src/ui/warnings.js';
import { applyOpeningInput, newOpening } from '../src/ui/openings.js';

test('стена дома: ширина не задана — стена ровно по навесу', () => {
  const m = defaultModel();
  assert.deepEqual(houseWall(m), { x0: 0, x1: m.geom.B }, 'без ширины стена должна совпадать с навесом');
  const ctx = buildContext(analyse(m));
  assert.equal(ctx.wall.w, m.geom.B, 'в 3D стена шире навеса, хотя ширина дома не задана');
  assert.equal(ctx.wall.from[0], m.geom.B / 2, 'в 3D стена сдвинута относительно навеса');
  assert.deepEqual(ctx.openings, [], 'проёмов не задавали, а они нарисованы');
});

test('стена дома: ширина и отступ навеса от левого угла', () => {
  const m = defaultModel();
  m.house.width = 9000;
  m.house.offset = 1500;
  assert.deepEqual(houseWall(m), { x0: -1500, x1: 7500 }, 'стена 9000 с навесом в 1500 от угла: −1500…7500 по навесу');
  const ctx = buildContext(analyse(m));
  assert.equal(ctx.wall.w, 9000, 'ширина стены в 3D не та');
  assert.equal(ctx.wall.from[0], 3000, 'середина стены в 3D не та');
});

test('проёмы: от угла дома в координаты навеса, битые размеры отбрасываются', () => {
  const m = defaultModel();
  m.house.width = 9000;
  m.house.offset = 1500;
  m.house.openings = [
    { kind: 'window', x: 2000, w: 1200, h: 1400, bottom: 900 },
    { kind: 'door', x: 5000, w: 0, h: 2100, bottom: 0 },
    { kind: 'door', x: 'abc', w: 900, h: 2100, bottom: 0 },
  ];
  const ops = openingsOf(m);
  assert.equal(ops.length, 1, 'проём нулевой ширины или с нечислом должен отбрасываться');
  assert.deepEqual([ops[0].x0, ops[0].x1, ops[0].bottom, ops[0].top], [500, 1700, 900, 2300], 'окно в 2000 от угла при отступе 1500 — это 500 от края навеса');
  const ctx = buildContext(analyse(m));
  assert.equal(ctx.openings.length, 1, 'в 3D не то число проёмов');
  assert.equal(ctx.openings[0].w, 1200, 'ширина окна в 3D не та');
});

test('проёмы: столб на проёме и шпильки в нём', () => {
  const m = defaultModel();
  const lv = levels(m);
  const zs = boltHeights(lv.wallPostTop, m.wallPosts.boltCount);
  // дверь 900 от земли, на ней столб x = 3000: в неё попадают шпильки ниже 2100
  m.house.openings = [{ kind: 'door', x: 2600, w: 900, h: 2100, bottom: 0 }];
  const c = houseClashes(m);
  assert.equal(c.length, 1, 'столб на двери не замечен');
  assert.equal(c[0].post, 2, 'на дверь 2600…3500 встаёт третий столб (x = 3000)');
  assert.equal(c[0].bolts, zs.filter((z) => z < 2100).length, 'не то число шпилек в проёме');
  // дверь между столбами — чисто
  m.house.openings = [{ kind: 'door', x: 1800, w: 900, h: 2100, bottom: 0 }];
  assert.deepEqual(houseClashes(m), [], 'дверь в простенке 1500…3000 не мешает столбам');
  // край столба заходит на откос: сечение 60 мм, столб x = 1500 — до 1530
  m.house.openings = [{ kind: 'window', x: 1520, w: 1000, h: 1000, bottom: 900 }];
  assert.equal(houseClashes(m).length, 1, 'столб, заходящий на откос краем сечения, не замечен');
});

test('проёмы: обвязка перекрывает верх высокого проёма', () => {
  const m = defaultModel();
  const top = levels(m).wallPostTop;
  m.house.openings = [{ kind: 'window', x: 1800, w: 900, h: 1000, bottom: top - 900 }];
  assert.deepEqual(houseClashes(m).map((c) => c.kind), ['purlin'], 'окно выше низа обвязки не замечено');
  m.house.openings[0].bottom = top - 1000;
  assert.deepEqual(houseClashes(m), [], 'окно вровень с низом обвязки ей не мешает');
  // проём вне навеса — не его забота
  m.house.width = 12000;
  m.house.openings = [{ kind: 'window', x: 8000, w: 900, h: 3000, bottom: 900 }];
  assert.deepEqual(houseClashes(m), [], 'окно за краем навеса не может мешать обвязке');
});

test('проёмы: предупреждение над сводкой и красный проём на плане', () => {
  const m = defaultModel();
  m.house.openings = [{ kind: 'door', x: 2600, w: 900, h: 2100, bottom: 0 }];
  const res = analyse(m);
  const w = warningsHtml(res);
  assert.match(w, /Столб у стены 3 стоит на проёме: дверь 900 мм/, 'нет предупреждения о столбе на двери');
  assert.match(w, /загораживает проход/, 'про дверь не сказано, что столб мешает проходу');
  const plan = drawPlan(res, { type: 'rafter', index: 0 }).svg;
  assert.match(plan, /stroke="var\(--u-bad\)"\/><title>Дверь 900 × 2100/, 'на плане дверь со столбом не красная');
  assert.doesNotMatch(warningsHtml(analyse(defaultModel())), /проём/, 'без проёмов предупреждений о них быть не должно');
});

test('проёмы: переживают ссылку на расчёт', () => {
  const m = defaultModel();
  m.house.width = 9000;
  m.house.openings = [{ kind: 'door', x: 2600, w: 900, h: 2100, bottom: 0 }];
  const back = decodeModel(encodeModel(m));
  assert.deepEqual(back.house, m.house, 'стена дома потерялась в ссылке');
  assert.deepEqual(decodeModel(encodeModel(defaultModel())).house, defaultModel().house, 'старая ссылка без стены дома должна открываться с умолчаниями');
});

test('редактор проёмов: смена вида ставит типовые размеры, числа не уходят в минус', () => {
  const m = defaultModel();
  const list = [newOpening('window', m)];
  assert.equal(list[0].x, 2400, 'окно 1200 должно встать посередине навеса 6000: 2400 от угла');
  const el = (op, f, value) => ({ value, getAttribute: (a) => ({ 'data-op': String(op), 'data-f': f }[a]) });
  assert.ok(applyOpeningInput(list, el(0, 'kind', 'door')));
  assert.deepEqual([list[0].kind, list[0].w, list[0].h, list[0].bottom, list[0].x], ['door', 900, 2100, 0, 2400], 'дверь должна получить типовые размеры и сохранить положение');
  applyOpeningInput(list, el(0, 'x', '-300'));
  assert.equal(list[0].x, 0, 'отрицательное положение должно обрезаться до нуля');
  assert.equal(applyOpeningInput(list, el(5, 'x', '100')), false, 'правка несуществующей строки должна игнорироваться');
});

/** Дом 9 м, навес 6 м в 1,5 м от угла: дверь и два окна — как у пользователя. */
function withOpenings() {
  const m = defaultModel();
  m.house.width = 9000;
  m.house.offset = 1500;
  m.house.openings = [
    { kind: 'door', x: 3900, w: 900, h: 2100, bottom: 0 },
    { kind: 'window', x: 1800, w: 1200, h: 1400, bottom: 900 },
    { kind: 'window', x: 5400, w: 1200, h: 1400, bottom: 900 },
  ];
  return m;
}

test('привязки вдоль стены: углы, края навеса, оси столбов и откосы по порядку', () => {
  const marks = wallMarks(withOpenings());
  // по навесу: угол −1500, окно 300…1500, дверь 2400…3300, окно 3900…5100, угол 7500
  assert.deepEqual(marks.map((mk) => mk.x), [-1500, 0, 300, 1500, 2400, 3000, 3300, 3900, 4500, 5100, 6000, 7500],
    'точки привязки не те или не по порядку');
  assert.deepEqual(marks.find((mk) => mk.x === 1500).kinds.sort(), ['jamb', 'post'], 'откос и ось столба в одной точке должны склеиться');
  assert.deepEqual(marks.find((mk) => mk.x === 0).kinds, ['edge', 'post'], 'край навеса и крайний столб — одна точка');
  const clipped = wallMarks(withOpenings(), { from: 0, to: 6000 });
  assert.equal(clipped[0].x, 0, 'на плане цепочка начинается с края навеса');
  assert.equal(clipped[clipped.length - 1].x, 6000, 'на плане цепочка кончается краем навеса');
  assert.ok(clipped.every((mk) => mk.x >= 0 && mk.x <= 6000), 'угол дома за краем навеса попал на план');
});

test('фасад стены: проёмы с размерами, столбы тянутся, шпилька в проёме красная', () => {
  const res = analyse(withOpenings());
  const { svg, meta } = drawFacade(res, { type: 'wallPost', index: 2 });
  assert.match(svg, /дверь 900×2100/, 'дверь не подписана размерами');
  assert.equal((svg.match(/>окно 1200×1400</g) ?? []).length, 2, 'не оба окна подписаны');
  assert.equal((svg.match(/data-pick="wallPost"/g) ?? []).length, 5, 'не все столбы у стены можно взять мышью');
  // привязка по x такая же, как у плана: x = ox + мм·sc
  assert.ok(Number.isFinite(meta.sc) && Number.isFinite(meta.ox), 'у фасада нет привязки для перетаскивания');
  // столб 3 (x = 3000) стоит в двери 2400…3300: две нижние шпильки из трёх — в проёме
  const post3 = svg.split('data-index="2"')[1].split('</g>')[0];
  assert.equal((post3.match(/fill="var\(--u-bad\)"/g) ?? []).length, 2, 'шпильки в двери не выделены');
  for (const len of ['1500', '1200', '900', '300']) assert.match(svg, new RegExp(`>${len}</text>`), `в цепочке нет размера ${len}`);
});
