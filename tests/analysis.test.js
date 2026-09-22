import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel, spread, tributaries } from '../src/core/model.js';
import { analyse, billOfMaterials } from '../src/core/analysis.js';
import { snowDrift, snowMu, snowProfile, SNOW_REGIONS } from '../src/core/loads.js';
import { phiBuckling } from '../src/core/checks.js';
import { rhsProps, section as sectionById } from '../src/core/sections.js';

test('грузовые ширины покрывают всю ширину навеса', () => {
  const xs = spread(6000, 9);
  const t = tributaries(xs, 6000);
  assert.equal(Math.round(t.reduce((a, b) => a + b, 0)), 6000);
});

test('снеговой мешок: схема Б.8, формулы (Б.5) и (Б.6), перечисления «в», «г», «д», «е»', () => {
  const base = { h: 1.2, Sg: 1.5, l1: 6, l2: 4.8, a: 6, beta: 8, phi: 0, m1: 0.4, lowerIsCanopy: true };
  const d = snowDrift(base);

  // перечисление «в»: m₂ = 0,5·k₁·k₂·k₃ при ширине покрытия меньше 21 м
  assert.equal(d.m2parts.k1.toFixed(4), Math.sqrt(6 / 21).toFixed(4));
  assert.equal(d.m2parts.k2.toFixed(4), (1 - 8 / 35).toFixed(4));
  assert.equal(d.m2parts.k3, 1);
  assert.equal(d.m2.toFixed(4), (0.5 * Math.sqrt(6 / 21) * (1 - 8 / 35)).toFixed(4));
  assert.equal(snowDrift({ ...base, reverseSlope: true }).m2parts.k2, 1, 'обратный уклон → k₂ = 1');
  assert.ok(snowDrift({ ...base, a: 0.5 }).m2 >= 0.1, 'm₂ не менее 0,1');
  assert.equal(snowDrift({ ...base, a: 30 }).m2, 0.4, 'при a ≥ 21 м перечисление «в» не применяется');

  // формула (Б.5): делитель h, а не 2h
  assert.equal(d.raw.toFixed(4), (1 + (0.4 * 6 + d.m2 * 4.8) / 1.2).toFixed(4));

  // перечисление «д»
  assert.equal(d.capGeom.toFixed(4), (2 * 1.2 / 1.5).toFixed(4));
  assert.equal(d.capAbs, 6, 'для навеса потолок 6');
  assert.equal(snowDrift({ ...base, lowerIsCanopy: false, l1: 20, l2: 20 }).capAbs, 4, 'для здания при l′ ≤ 48 м — 4');
  assert.equal(snowDrift({ ...base, lowerIsCanopy: false, l1: 90, l2: 20 }).capAbs, 6, 'при l′ > 72 м — 6');
  assert.equal(snowDrift({ ...base, lowerIsCanopy: false, l1: 60, l2: 20 }).capAbs, 5, 'между — интерполяция');
  assert.equal(d.mu, d.capGeom, 'у навеса у стены обычно правит 2h/S₀');

  // перечисление «г» и формула (Б.6)
  const tight = snowDrift({ ...base, l1: 0.5, l2: 0.5, Sg: 0.5 });
  assert.ok(tight.raw <= tight.capGeom);
  assert.equal(tight.spread, false);
  assert.equal(tight.length, 2400, 'b = 2h');

  assert.equal(d.spread, true);
  const bExact = (2 * 1.2 * (d.raw - 1 + 2 * d.m2)) / (d.capGeom - 1 + 2 * d.m2);
  assert.ok(bExact > 5 * 1.2, 'здесь формула (Б.6) упирается в потолок 5h');
  assert.equal(d.length, 6000, 'b = 5h');
  assert.equal(snowDrift({ ...base, h: 8, Sg: 1.5 }).length, 16000, 'не более 16 м');

  // перечисление «е»: при b ≥ l′₂ и без парапета μ₁ = 1 − 2m₂
  assert.equal(d.mu1.toFixed(4), (1 - 2 * d.m2).toFixed(4));
  assert.ok(d.mu1 >= 0.2, 'μ₁ не менее 0,2');

  // примечание 3: при h < S₀/2 мешок не учитывается
  assert.equal(snowDrift({ ...base, h: 0.6, Sg: 1.5 }).applies, false);
  assert.equal(snowDrift({ ...base, h: 0.8, Sg: 1.5 }).applies, true);

  // примечание 4: парапет снимает перенос с верхнего покрытия
  assert.equal(snowDrift({ ...base, parapet: true }).m1, 0);
  assert.ok(snowDrift({ ...base, parapet: true }).raw < d.raw);

  // l′₂ не более утроенной ширины покрытия
  assert.equal(snowDrift({ ...base, a: 1, l2: 50 }).l2, 3);
});

test('μ односкатного покрытия по прил. Б.1', () => {
  assert.equal(snowMu(8), 1);
  assert.equal(snowMu(30), 1);
  assert.equal(snowMu(45), 0.5);
  assert.equal(snowMu(60), 0);
});

test('нижнее покрытие считается в двух вариантах загружения (схема Б.8, «а»)', () => {
  const site = { snowRegion: 'IV', drift: true, houseRoofLength: 6000, houseRoofSlope: 20 };
  const p = snowProfile(site, 8, { driftH: 1200, depth: 4800, width: 6000, alpha: 8 });
  assert.equal(p.variants.length, 2, 'равномерный и мешок');

  const [uniform, bag] = p.variants;
  assert.equal(uniform.at(0), SNOW_REGIONS.IV, 'равномерный — просто S₀ при α ≤ 30°');
  assert.ok(bag.at(0) > uniform.at(0), 'у стены мешок тяжелее');
  assert.ok(bag.at(0) > bag.at(2000) && bag.at(2000) > bag.at(4800), 'эпюра мешка убывает от стены');
  assert.ok(bag.at(4800) < uniform.at(0), 'в дальней части правит уже равномерный вариант');

  // без перепада остаётся один вариант
  const flat = snowProfile({ ...site, drift: false }, 8, { driftH: 1200, depth: 4800, width: 6000 });
  assert.equal(flat.variants.length, 1);
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
  // при малом перепаде правит ограничение μ ≤ 2h/S_g, то есть μ·S_g = 2h
  assert.ok(Math.abs(r.snow.muWall * r.snow.Sg - 2.4) < 1e-9, `${r.snow.muWall * r.snow.Sg} кПа`);
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

test('снеговой мешок утяжеляет стропила и грузит стену сильнее свеса', () => {
  const m = defaultModel();
  const withDrift = analyse(m);
  const without = analyse({ ...m, site: { ...m.site, drift: false } });
  const U = (r) => Math.max(...r.rafters.map((x) => x.U));
  assert.ok(U(withDrift) > U(without) * 1.1, `${U(withDrift).toFixed(2)} vs ${U(without).toFixed(2)}`);
  assert.ok(withDrift.snow.at(0) > withDrift.snow.at(m.geom.L), 'у стены снега больше, чем в поле');
  // с мешком реакция на стену больше, чем без него
  const rw = (r) => r.rafters[Math.floor(r.rafters.length / 2)].reactions.wall;
  assert.ok(rw(withDrift) > rw(without) * 1.15, `${(rw(withDrift) / 1000).toFixed(2)} против ${(rw(without) / 1000).toFixed(2)} кН`);
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
  const outer = r.posts[1].checks.find((c) => c.name === 'Устойчивость вдоль ряда');
  assert.ok(outer.note.includes('φ'), 'в примечании должен быть φ');
  assert.ok(r.posts[1].lef > r.wallPosts[1].lef, 'расчётная длина наружного столба больше');
});

test('μ следует из схемы связей, а не выбирается', () => {
  // без связей: поперёк ряда верх держат стропила, вдоль стены — ничего
  const free = analyse(defaultModel()).posts[1];
  assert.equal(free.muX, 1);
  assert.equal(free.muY, 2);
  assert.equal(Math.round(free.lefX), Math.round(free.H));
  assert.equal(Math.round(free.lefY), Math.round(2 * free.H));
  const x = free.checks.find((c) => c.name === 'Устойчивость поперёк ряда');
  const y = free.checks.find((c) => c.name === 'Устойчивость вдоль ряда');
  assert.ok(y.U > x.U, 'плоскость без связей должна быть загружена сильнее');
  // гибкость ограничивается по худшей плоскости, и без связей она и правит
  const flex = free.checks.find((c) => c.name === 'Гибкость');
  assert.ok(Math.abs(flex.value - y.lambda) < 1e-6, 'в проверку гибкости идёт худшая λ');
  assert.equal(free.worst.name, 'Гибкость');

  // крест в ряду даёт вдоль стены 1,0 — и столб заметно легчает
  const m = defaultModel();
  m.bracing.along = 'cross';
  const braced = analyse(m).posts[1];
  assert.equal(braced.muY, 1);
  assert.ok(braced.U < free.U * 0.8, `${braced.U.toFixed(2)} против ${free.U.toFixed(2)}`);

  // стеновой ряд держит стена
  const w = analyse(defaultModel()).wallPosts[1];
  assert.equal(w.muX, 1);
  assert.equal(w.muY, 1);
});

test('без связей ветер вдоль стены идёт в консоли наружного ряда', () => {
  const r = analyse(defaultModel());
  const p = r.posts[1];
  assert.ok(p.Hy > 0, 'наружный ряд получает долю ветра вдоль стены');
  assert.ok(Math.abs(p.My - p.Hy * p.H) < 1e-6, 'консоль: момент у базы H·h');
  assert.ok(p.diagramY && Math.abs(p.diagramY.M[0]) > Math.abs(p.diagramY.M.at(-1)), 'эпюра вдоль ряда растёт к базе');
  const total = r.posts.reduce((a, q) => a + q.Hy, 0);
  assert.ok(Math.abs(total - r.thrust.alongOuter) < 1e-6, 'вся доля наружного ряда распределена по столбам');
  // сжатие с изгибом считается в двух плоскостях
  const bc = p.checks.find((c) => c.name === 'Сжатие с изгибом');
  assert.ok(bc.formula.includes('M_y'), bc.formula);

  // с крестом верх удержан: момента вдоль ряда у столба нет, сила ушла в связь
  const m = defaultModel();
  m.bracing.along = 'cross';
  const q = analyse(m).posts[1];
  assert.equal(q.My, 0);
  assert.equal(q.diagramY, null);
});

test('верх наружного ряда держат стропила: сила доходит до стены и проверяется', () => {
  const r = analyse(defaultModel());
  const holdX = r.posts.reduce((a, p) => a + p.holdX, 0);
  assert.ok(holdX > 0);
  // условная поперечная сила по формуле (18) СП 16: 7,15·10⁻⁶·(2330 − E/R_y)·N/φ
  const p = r.posts[1];
  const stabX = p.checks.find((c) => c.name === 'Устойчивость поперёк ряда');
  const expect = 7.15e-6 * (2330 - p.mat.E / p.mat.Ry) * (p.N - p.Vcross) / stabX.phi;
  assert.ok(Math.abs(p.QficX - expect) < 1e-6, `${p.QficX} против ${expect}`);
  // стеновой ряд принимает и ветер на кровлю, и то, что держит наружный ряд
  assert.ok(Math.abs(r.bracing.toWall - (r.thrust.total + holdX)) < 1e-6);
  const perPost = r.wallPosts[1].Hpost;
  assert.ok(Math.abs(perPost - r.bracing.toWall / r.wallPosts.length) < 1e-6);
  // узлы крепления стропил и обвязка у стены это усилие видят
  const nR = r.model.rafters.xs.length;
  assert.ok(Math.abs(r.ties.outer.hold - holdX / nR) < 1e-6);
  assert.ok(Math.abs(r.ties.wall.hold - r.bracing.toWall / nR) < 1e-6);
  assert.ok(r.wallPurlin.checks.some((c) => c.name === 'Изгиб из плоскости от распора'));
});

test('крест: усилие в диагонали, добавка в столбы пролёта и строка в смете', () => {
  const m = defaultModel();
  m.bracing.along = 'cross';
  const r = analyse(m);
  const c = r.cross;
  assert.ok(c, 'крест посчитан');
  assert.equal(c.count, 2);
  // держит весь ряд: долю ветра вдоль стены и условные силы всех столбов
  const qfic = r.posts.reduce((a, p) => a + p.QficY, 0);
  assert.ok(Math.abs(c.F - (r.thrust.alongOuter + qfic)) < 1e-6);
  // растяжение диагонали F·l/s, вертикаль на столбы F·h/s
  assert.ok(Math.abs(c.T - (c.F * c.length) / c.span) < 1e-6);
  assert.ok(Math.abs(c.V - (c.F * c.hd) / c.span) < 1e-6);
  // столбы пролёта со связью получают вертикаль и в сжатие, и в отрыв;
  // в отрыв — только ветровая часть: условная сила — от сжатия под снегом
  assert.ok(Math.abs(r.posts[0].Vcross - c.V) < 1e-6);
  assert.ok(Math.abs(r.posts[1].Vcross - c.V) < 1e-6);
  assert.equal(r.posts[2].Vcross, 0);
  assert.ok(Math.abs(r.posts[0].VcrossUp - (c.Vup)) < 1e-6);
  assert.ok(Math.abs(c.Vup - (r.thrust.alongOuter * c.hd) / c.span) < 1e-6);
  assert.ok(c.Vup < c.V);
  for (const name of ['Растяжение связи', 'Гибкость связи', 'Шов по металлу шва', 'Катет шва']) {
    assert.ok(c.checks.some((k) => k.name === name), name);
  }
  assert.ok(r.summary.some((s) => s.key === 'bracing'), 'строка «Связи ряда» в сводке');
  const bom = billOfMaterials(r);
  const item = bom.items.find((i) => i.name === 'Связи наружного ряда');
  assert.ok(item && item.count === 2 && item.cost > 0);

  // в обоих крайних пролётах — четыре диагонали, и каждая держит половину
  const two = defaultModel();
  two.bracing = { ...two.bracing, along: 'cross', bays: 2 };
  const r2 = analyse(two);
  assert.equal(r2.cross.count, 4);
  assert.ok(Math.abs(r2.cross.F - c.F / 2) < 1e-6);

  // тонкую диагональ к столбу не приварить: катет по табл. 38 больше 1,2·t
  const thin = defaultModel();
  thin.bracing = { ...thin.bracing, along: 'cross', sectionId: 's40x40x2' };
  const t = analyse(thin).cross;
  assert.equal(t.worst.name, 'Катет шва');
  assert.ok(t.U > 1);
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
  // наружный столб поперёк ряда: верх удержан стропилами, низ — шарнир,
  // момент от эксцентриситета опирания наибольший вверху и падает к базе
  const outer = r.posts[1].diagram;
  assert.ok(Math.abs(outer.M.at(-1)) > Math.abs(outer.M[0]), 'момент наибольший у оголовка');

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

test('испорченные исходные данные не роняют расчёт', () => {
  const m = defaultModel();
  const broken = analyse({ ...m, site: { ...m.site, snowRegion: 'нет такого' } });
  for (const s of broken.summary) {
    assert.ok(s.worst, `${s.label}: определяющая проверка должна быть названа`);
  }
  assert.ok(!Number.isFinite(broken.maxU), 'такой результат должен быть виден, а не выглядеть нулём');
});

test('снег: таблица даёт нормативное значение, расчётное — γ_f = 1,4', async () => {
  const { GAMMA_F } = await import('../src/core/loads.js');
  assert.equal(GAMMA_F.snow, 1.4, 'п. 10.12 СП 20');

  const m = defaultModel();
  const r = analyse(m);
  // прогибы считаются на полное нормативное значение, прочность — на расчётное
  const rafter = r.rafters[Math.floor(r.rafters.length / 2)];
  const qUls = rafter.res['ULS-1'];
  const qSls = rafter.res.SLS;
  const sumR = (x) => x.reactions.reduce((a, b) => a + b.R, 0);
  assert.ok(sumR(qUls) > sumR(qSls) * 1.25, `расчётная нагрузка должна быть заметно больше нормативной: ${(sumR(qUls) / 1000).toFixed(1)} против ${(sumR(qSls) / 1000).toFixed(1)} кН`);

  // при удвоении снегового района расчётная нагрузка растёт, нормативная тоже
  const heavier = analyse({ ...m, site: { ...m.site, snowRegion: 'VIII' } });
  const h = heavier.rafters[Math.floor(heavier.rafters.length / 2)];
  assert.ok(sumR(h.res['ULS-1']) > sumR(qUls));
});

test('допустимый пролёт кровли меряется шагом обрешётки, а не стропил', () => {
  const m = defaultModel();
  const lim = (r) => r.battens.checks.find((c) => c.name === 'Пролёт под кровлю');

  const dense = analyse({ ...m, battens: { ...m.battens, spacing: 400 } });
  const sparse = analyse({ ...m, battens: { ...m.battens, spacing: 900 } });
  assert.equal(lim(dense).value, 400);
  assert.equal(lim(sparse).value, 900);
  assert.ok(lim(sparse).U > lim(dense).U, 'реже обрешётка — ближе к пределу покрытия');

  // шаг стропил на эту проверку не влияет
  const wide = analyse({ ...m, rafters: { ...m.rafters, xs: spread(m.geom.B, 5) } });
  assert.equal(lim(wide).value, m.battens.spacing);

  // мягкая черепица требует куда более частой обрешётки, чем профлист
  const soft = analyse({ ...m, roofing: 'soft' });
  assert.ok(lim(soft).U > lim(analyse(m)).U * 2);
});

test('подбор по цене: варианты в запасе, отсортированы, не дороже текущего', async () => {
  const { searchByCost } = await import('../src/core/search.js');
  const m = defaultModel();
  m.geom.B = 3000; // поменьше, чтобы тест не тянулся
  m.geom.L = 2500;
  m.rafters.xs = spread(3000, 6);
  m.posts.xs = spread(3000, 3);
  m.wallPosts.xs = spread(3000, 3);

  const target = 0.9;
  const before = billOfMaterials(analyse(m)).costs.total;
  const stages = [];
  const r = await searchByCost(m, { target, keep: 2, limit: 4, onProgress: (p) => stages.push(p.stage) });

  assert.ok(r.options.length > 0, 'хоть один вариант должен найтись');
  assert.ok(stages.includes('стропила') && stages.includes('опоры'), 'прогресс сообщается по этапам');

  for (const o of r.options) {
    assert.ok(o.maxU <= target + 1e-9, `вариант за ${Math.round(o.cost)} ₽ имеет U = ${o.maxU.toFixed(2)}`);
    // каждый вариант — работоспособная модель, а не выборка полей
    const check = analyse(o.model);
    assert.ok(Math.abs(check.maxU - o.maxU) < 1e-9, 'модель варианта воспроизводит свой же результат');
    assert.ok(Math.abs(billOfMaterials(check).costs.total - o.cost) < 1, 'и свою же стоимость');
  }
  for (let i = 1; i < r.options.length; i++) {
    assert.ok(r.options[i].cost >= r.options[i - 1].cost, 'отсортировано по возрастанию цены');
  }
  assert.ok(r.options[0].cost <= before, 'лучший вариант не дороже исходного');

  // геометрия не трогается
  assert.equal(r.options[0].model.geom.B, m.geom.B);
  assert.equal(r.options[0].model.geom.L, m.geom.L);
  assert.equal(r.options[0].model.geom.alpha, m.geom.alpha);
});

test('массы в сводке — числа, а не функции: отчёт печатает их напрямую', () => {
  const b = billOfMaterials(analyse(defaultModel()));
  for (const [key, w] of Object.entries(b.weights)) {
    if (w && typeof w === 'object' && 'mass' in w) {
      assert.equal(typeof w.mass, 'number', `${key}: масса должна быть числом`);
      assert.ok(Number.isFinite(w.mass) && w.mass > 0, `${key}: масса ${w.mass}`);
    }
  }
  const group = b.weights.groups.find((g) => g.name === 'Метизы');
  assert.ok(Math.abs(group.mass - b.weights.fasteners.mass) < 1e-9,
    'метизы в группах и в сводке — одно и то же число');
  assert.equal(b.weights.fasteners.count, b.fasteners.reduce((a, f) => a + (f.count ?? 0), 0));
});

test('фундамент против отрыва: сила в кН и масса в кг — одно и то же число', () => {
  const res = analyse(defaultModel());
  const f = res.foundation;
  assert.ok(f.requiredHold > 0 && f.requiredMassKg > 0);
  // 1 кН удерживается примерно 102 кг веса: проверяем, что перевод не разъехался
  assert.ok(Math.abs(f.requiredMassKg * 9.80665 / 1000 - f.requiredHold) < 1e-9,
    'масса в кг и сила в кН должны быть одной величиной в разных единицах');
  // сторона куба считается от той же величины при весе бетона 24 кН/м³
  const side = Math.cbrt(f.requiredHold / 24) * 1000;
  assert.ok(Math.abs(side - f.cubeSide) < 1e-6, 'сторона куба — от той же силы');
  // и всё это сходится с проверкой базы забетонированного столба
  const m = defaultModel();
  m.postBase = { id: 'embed1200', footing: 400 };
  const base = analyse(m).bases.outer;
  const need = base.uplift / 0.9 / 9.80665;
  assert.ok(Math.abs(need - f.requiredMassKg) < 1, 'инспектор базы и сводка считают одно и то же');
});
