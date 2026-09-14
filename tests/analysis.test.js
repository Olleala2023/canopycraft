import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel, spread, tributaries } from '../src/core/model.js';
import { analyse, billOfMaterials } from '../src/core/analysis.js';
import { snowDrift, snowMu, snowProfile } from '../src/core/loads.js';
import { phiBuckling } from '../src/core/checks.js';
import { rhsProps, section as sectionById } from '../src/core/sections.js';

test('грузовые ширины покрывают всю ширину навеса', () => {
  const xs = spread(6000, 9);
  const t = tributaries(xs, 6000);
  assert.equal(Math.round(t.reduce((a, b) => a + b, 0)), 6000);
});

test('снеговой мешок: μ растёт с перепадом и ограничен четырьмя', () => {
  assert.ok(snowDrift(1200, 2.0).mu > 1);
  assert.equal(snowDrift(1200, 2.0).mu, 2.4);
  assert.equal(snowDrift(10000, 1.0).mu, 4);
  assert.equal(snowDrift(300, 4.0).mu, 1); // не меньше обычного покрытия
  assert.equal(snowDrift(1200, 2.0).length, 5000); // не менее 5 м
});

test('μ односкатного покрытия по прил. Б.1', () => {
  assert.equal(snowMu(8), 1);
  assert.equal(snowMu(30), 1);
  assert.equal(snowMu(45), 0.5);
  assert.equal(snowMu(60), 0);
});

test('эпюра снега убывает от стены', () => {
  const p = snowProfile({ snowRegion: 'IV', drift: true, driftH: 1200 }, 8);
  assert.ok(p.at(0) > p.at(2000));
  assert.ok(p.at(2000) > p.at(4800));
  assert.equal(p.at(0), 4.8);
});

test('φ совпадает с табл. 7 СП 16 в пределах 4 %', () => {
  const table = [[40, 0.894], [60, 0.806], [80, 0.686], [100, 0.542], [120, 0.419], [150, 0.289]];
  for (const [lam, ref] of table) {
    const { phi } = phiBuckling(lam, 240);
    assert.ok(Math.abs(phi - ref) / ref < 0.05, `λ=${lam}: ${phi.toFixed(3)} vs ${ref}`);
  }
});

test('характеристики трубы 100×100×3 близки к ГОСТ 30245', () => {
  const p = rhsProps(100, 100, 3);
  assert.ok(Math.abs(p.A - 1130) / 1130 < 0.02, `A = ${p.A.toFixed(0)} мм²`);
  assert.ok(Math.abs(p.Ix - 174.9e4) / 174.9e4 < 0.02, `Ix = ${(p.Ix / 1e4).toFixed(1)} см⁴`);
  assert.ok(Math.abs(p.ix - 39.4) / 39.4 < 0.02, `i = ${p.ix.toFixed(1)} мм`);
});

test('полный расчёт: все элементы посчитаны, снег у стены вдвое выше', () => {
  const m = defaultModel();
  const r = analyse(m);
  assert.equal(r.rafters.length, m.rafters.xs.length);
  assert.equal(r.posts.length, m.posts.xs.length);
  for (const s of r.summary) assert.ok(Number.isFinite(s.U) && s.U > 0, `${s.label}: U = ${s.U}`);
  // нагрузка в снеговом мешке определяется перепадом высот, а не районом:
  // μ·S_g = 2·h·γ_сн = 2·1,2·2,0 = 4,8 кПа
  assert.ok(Math.abs(r.snow.muWall * r.snow.Sg - 4.8) < 1e-9, `${r.snow.muWall * r.snow.Sg} кПа`);
  assert.ok(r.wind.up > 0);
  assert.equal(r.wallPosts.length, m.wallPosts.xs.length);
  const b = billOfMaterials(r);
  assert.ok(b.timberVolume > 0 && b.steelMass > 0);
});

test('уплотнение стропил снижает их загрузку', () => {
  const m = defaultModel();
  const sparse = analyse({ ...m, rafters: { ...m.rafters, xs: spread(m.geom.B, 6) } });
  const dense = analyse({ ...m, rafters: { ...m.rafters, xs: spread(m.geom.B, 14) } });
  const U = (r) => Math.max(...r.rafters.map((x) => x.U));
  assert.ok(U(dense) < U(sparse), `${U(dense).toFixed(2)} должно быть меньше ${U(sparse).toFixed(2)}`);
});

test('снеговой мешок заметно утяжеляет стропила', () => {
  const m = defaultModel();
  const withDrift = analyse(m);
  const without = analyse({ ...m, site: { ...m.site, drift: false } });
  const U = (r) => Math.max(...r.rafters.map((x) => x.U));
  assert.ok(U(withDrift) > U(without) * 1.3, `${U(withDrift).toFixed(2)} vs ${U(without).toFixed(2)}`);
});

test('распор даёт только ветер: у вертикальных опор ΣH = 0 от силы тяжести', () => {
  const m = defaultModel();
  const calm = analyse({ ...m, site: { ...m.site, windRegion: 'Ia' } });
  const windy = analyse({ ...m, site: { ...m.site, windRegion: 'VII' } });
  assert.ok(windy.thrust.total > calm.thrust.total * 3, 'распор должен расти с ветровым районом');
  // снег распора не создаёт: реакции опор вертикальные
  const light = analyse({ ...m, site: { ...m.site, snowRegion: 'I' } });
  const heavy = analyse({ ...m, site: { ...m.site, snowRegion: 'VIII' } });
  assert.equal(light.thrust.total.toFixed(6), heavy.thrust.total.toFixed(6));
  assert.ok(heavy.rafters[5].N > light.rafters[5].N, 'внутреннее осевое усилие при этом растёт');
});

test('шпильки в газоблоке проверяются и зависят от размера шайбы', () => {
  const m = defaultModel();
  const small = analyse({ ...m, wallPosts: { ...m.wallPosts, plateSize: 60 } });
  const big = analyse({ ...m, wallPosts: { ...m.wallPosts, plateSize: 200 } });
  const U = (r) => r.wallPosts[1].bolts.checks.find((c) => c.name.includes('под шайбой')).U;
  assert.ok(U(small) > U(big) * 5, `${U(small).toFixed(3)} vs ${U(big).toFixed(3)}`);
  assert.ok(big.wallPosts[1].bolts.count === m.wallPosts.boltCount);
});

test('стеновой столб выгоднее наружного: он раскреплён стеной', () => {
  const m = defaultModel();
  const r = analyse(m);
  const outer = r.posts[1].checks.find((c) => c.name === 'Устойчивость столба');
  const wall = r.wallPosts[1].checks.find((c) => c.name === 'Устойчивость столба');
  assert.ok(wall.note.includes('φ'), 'в примечании должен быть φ');
  assert.ok(r.posts[1].lef > r.wallPosts[1].lef, 'расчётная длина наружного столба больше');
});

test('спецификация считает хлысты стандартной длины', () => {
  const r = analyse(defaultModel());
  const b = billOfMaterials(r);
  const rafters = b.items.find((i) => i.name === 'Стропила');
  assert.equal(rafters.stockPieces, rafters.count); // 4,9 м из 6 м — по одной на хлыст
  const battens = b.items.find((i) => i.name === 'Обрешётка');
  assert.equal(battens.stockPieces, battens.count); // 6 м ровно
  assert.ok(b.fasteners[0].count === r.model.wallPosts.boltCount * r.model.wallPosts.xs.length);
  assert.ok(b.steelLength > 0);
});

test('погонные массы сечений совпадают с сортаментом', () => {
  const cases = [['s100x100x3', 8.9], ['s60x60x3', 5.2], ['s80x140x4', 13.1], ['t50x200', 5.0]];
  for (const [id, ref] of cases) {
    const m = sectionById(id).massPerM;
    assert.ok(Math.abs(m - ref) / ref < 0.03, `${id}: ${m.toFixed(2)} против ${ref} кг/м`);
  }
});

test('массы сходятся: сумма групп = итогу, дерево = объём × плотность', () => {
  const b = billOfMaterials(analyse(defaultModel()));
  const w = b.weights;
  const bySum = w.groups.reduce((a, g) => a + g.mass, 0);
  assert.ok(Math.abs(bySum - w.total) < 0.5, `${bySum.toFixed(1)} ≠ ${w.total.toFixed(1)}`);
  assert.ok(Math.abs(w.timber.mass - w.timber.volume * 500) < 0.5, 'm = V·ρ');
  assert.ok(w.perSqm > 10 && w.perSqm < 100, `${w.perSqm.toFixed(1)} кг/м² — вне разумного диапазона`);
  assert.ok(w.deadShareWall < w.deadShareField, 'у стены снега больше, доля собственного веса меньше');
});

test('тяжёлая кровля увеличивает и массу, и загрузку стропил', () => {
  const m = defaultModel();
  const light = analyse({ ...m, roofing: 'pc8' });
  const heavy = analyse({ ...m, roofing: 'soft' });
  const wl = billOfMaterials(light).weights, wh = billOfMaterials(heavy).weights;
  assert.ok(wh.roofing.mass > wl.roofing.mass * 5, 'мягкая черепица тяжелее поликарбоната');
  assert.ok(wh.total > wl.total);
  const U = (r) => Math.max(...r.rafters.map((x) => x.U));
  assert.ok(U(heavy) > U(light), 'вес кровли участвует в расчёте, а не только в смете');
});

test('стоимость считается по заданным ценам и линейна по ним', () => {
  const m = defaultModel();
  const b = billOfMaterials(analyse(m));
  const c = b.costs;
  assert.ok(Math.abs(c.timber - b.weights.timber.volume * m.prices.timberM3) < 1, 'дерево по объёму');
  assert.ok(Math.abs(c.steel - b.weights.steel.mass * m.prices.steelKg) < 1, 'металл по массе');
  assert.ok(Math.abs(c.total - (c.timber + c.steel + c.roofing + c.fasteners)) < 1, 'итог сходится');

  const double = billOfMaterials(analyse({ ...m, prices: { ...m.prices, steelKg: m.prices.steelKg * 2 } }));
  assert.ok(Math.abs(double.costs.steel - c.steel * 2) < 1, 'удвоение цены удваивает стоимость металла');
  assert.ok(Math.abs(double.costs.timber - c.timber) < 1, 'цена металла не влияет на дерево');

  const free = billOfMaterials(analyse({ ...m, prices: { timberM3: 0, steelKg: 0, roofingM2: 0, fastenerPc: 0, currency: '₽' } }));
  assert.equal(free.costs.total, 0, 'нулевые цены дают нулевую смету, а не NaN');
});

test('ссылка на расчёт: короткая, восстанавливает модель, переживает мусор', async () => {
  const { encodeModel, decodeModel, diffModel, mergeModel } = await import('../src/core/share.js');
  const base = defaultModel();

  assert.deepEqual(diffModel(base), {}, 'умолчания не занимают места в ссылке');
  assert.ok(encodeModel(base).length < 8, `пустая ссылка: ${encodeModel(base).length} символов`);

  const changed = structuredClone(base);
  changed.geom.L = 5200;
  changed.rafters.sectionId = 't50x200';
  changed.prices.steelKg = 190;
  changed.posts.xs = [0, 2500, 5000, 6000];
  const code = encodeModel(changed);
  assert.ok(code.length < 200, `ссылка на изменённый расчёт: ${code.length} символов`);

  const back = decodeModel(code);
  assert.deepEqual(back, changed, 'модель восстанавливается один в один');
  assert.equal(analyse(back).maxU.toFixed(4), analyse(changed).maxU.toFixed(4));

  assert.equal(decodeModel('это не base64!!!'), null);
  assert.equal(decodeModel(''), null);

  // ссылка со старым или чужим ключом не ломает модель
  const patched = mergeModel({ geom: { L: 3000, чужое: 1 }, несуществующее: 42 }, base);
  assert.equal(patched.geom.L, 3000);
  assert.equal(patched.несуществующее, undefined);
  assert.equal(patched.geom.чужое, undefined);
  assert.equal(patched.geom.B, base.geom.B, 'остальное берётся из умолчаний');
});

test('у столбов есть эпюры по высоте, а не одно число', async () => {
  const { boltHeights } = await import('../src/core/model.js');
  const r = analyse(defaultModel());
  for (const p of [r.posts[1], r.wallPosts[2]]) {
    assert.ok(p.diagram && p.diagram.M.length > 50, 'эпюра момента построена');
    assert.ok(p.diagram.x[p.diagram.x.length - 1] > 1000, 'ось — высота столба');
    assert.ok(Math.abs(p.M) > 0, 'расчётный момент взят из эпюры');
  }
  // наружный столб — консоль: момент максимален у базы и падает к верху
  const outer = r.posts[1].diagram;
  assert.ok(Math.abs(outer.M[0]) > Math.abs(outer.M[outer.M.length - 1]), 'момент консоли растёт к базе');

  // стеновой столб: сумма реакций базы и шпилек равна приложенному распору
  const w = r.wallPosts[2];
  const sum = w.diagram.reactions.reduce((a, x) => a + x.R, 0);
  assert.ok(Math.abs(sum - w.Hpost) < 1, `${sum.toFixed(2)} ≠ ${w.Hpost.toFixed(2)} Н`);
  assert.equal(w.bolts.forces.length, defaultModel().wallPosts.boltCount);
  assert.equal(w.bolts.heights.length, defaultModel().wallPosts.boltCount);
  assert.deepEqual(w.bolts.heights, boltHeights(w.H, defaultModel().wallPosts.boltCount));
  // усилие на шпильку берётся из расчёта, а не делением поровну
  assert.ok(w.bolts.Nbolt > Math.max(...w.bolts.forces) - 1e-6);
});

test('усилие на шпильку растёт с распором и с эксцентриситетом опирания', () => {
  const m = defaultModel();
  const worst = (mm) => Math.max(...analyse(mm).wallPosts.map((p) => p.bolts.Nbolt));

  const calm = worst({ ...m, site: { ...m.site, windRegion: 'Ia' } });
  const windy = worst({ ...m, site: { ...m.site, windRegion: 'VII' } });
  assert.ok(windy > calm, `${windy.toFixed(0)} должно быть больше ${calm.toFixed(0)} Н`);

  const centred = worst({ ...m, opts: { ...m.opts, postEccentricity: 5 } });
  const offset = worst({ ...m, opts: { ...m.opts, postEccentricity: 80 } });
  assert.ok(offset > centred, `${offset.toFixed(0)} должно быть больше ${centred.toFixed(0)} Н`);
});

test('момент вверху столба воспринимается парой ближайших шпилек', () => {
  // шпильки разнесены шире — плечо пары больше, усилия меньше
  const m = defaultModel();
  const r = analyse(m);
  const w = r.wallPosts[2];
  const top = w.bolts.forces[w.bolts.forces.length - 1];
  const bottom = w.bolts.forces[0];
  assert.ok(top > bottom, `верхняя шпилька нагружена сильнее: ${top.toFixed(0)} против ${bottom.toFixed(0)} Н`);
});
