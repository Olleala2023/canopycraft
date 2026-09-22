import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel } from '../src/core/model.js';
import { analyse, billOfMaterials } from '../src/core/analysis.js';
import {
  FASTENERS, fastener, shearCapacity, fitCount, spacingRules, WELD, weldLine,
  postBase, anchorSpan,
  frostDepth,
} from '../src/core/fasteners.js';
import { pickAll, pickTies } from '../src/core/optimize.js';

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
    assert.ok(r.ties.outer.slope > 0);
    assert.equal(r.ties.wall.slope, 0);
    // а горизонтальную силу, которой стропила держат верх наружного ряда
    // и ветер на кровлю, несут оба узла
    assert.ok(r.ties.outer.hold > 0 && r.ties.wall.hold > r.ties.outer.hold);
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

/* ─────────────── узел «прогон — столб» ─────────────── */

test('сварной узел: геометрия шва и напряжения', () => {
  const m = defaultModel();
  const r = analyse(m);
  const t = r.beamTies.outer;
  assert.ok(t.welded);

  // шов по контуру столба 100×100 за вычетом 10 мм непровара на каждом из четырёх швов
  assert.equal(Math.round(t.weldLength), 2 * (100 + 100) - 40);

  // напряжение по металлу шва: отрыв и момент на площадь и момент сопротивления линии шва
  const A = WELD.betaF * t.tie.kf * t.weldLength;
  const W = WELD.betaF * t.tie.kf * weldLine(100, 100).W;
  const expect = Math.hypot(t.uplift / A + t.Mecc / W, t.H / A);
  assert.ok(Math.abs(t.tauF - expect) < 1e-6, `${t.tauF.toFixed(1)} против ${expect.toFixed(1)} МПа`);
  // по границе сплавления β_z = 1,0 — площадь больше, напряжение меньше
  assert.ok(t.tauZ < t.tauF);
});

test('катет шва ограничен толщиной стенки', () => {
  const m = defaultModel();
  // труба 100×100×3: 1,2·t = 3,6 мм, катет 3 проходит, 4 и 6 — уже нет
  const ok = analyse({ ...m, purlinTie: { id: 'weld3' } }).beamTies.outer;
  assert.ok(ok.U <= 1, `катет 3: U = ${ok.U.toFixed(2)}`);
  for (const id of ['weld4', 'weld6']) {
    const bad = analyse({ ...m, purlinTie: { id } }).beamTies.outer;
    assert.equal(bad.worst.name, 'Катет шва');
    assert.ok(bad.U > 1, `${id}: U = ${bad.U.toFixed(2)}`);
  }
  // на толстостенной трубе тот же катет проходит
  const thick = defaultModel();
  thick.posts.sectionId = 's100x100x6';
  thick.purlin.sectionId = 's100x140x6';
  assert.ok(analyse({ ...thick, purlinTie: { id: 'weld5' } }).beamTies.outer.U <= 1);
});

test('к деревянной обвязке сварка подменяется болтовым узлом', () => {
  const m = defaultModel();
  // у стены по умолчанию сосна — просим сварку и получаем болты с объяснением
  const r = analyse({ ...m, wallPurlinTie: { id: 'weld4' } });
  const t = r.beamTies.wall;
  assert.equal(t.welded, false);
  assert.match(t.fallback, /сварка невозможна/);
  assert.ok(t.checks?.length || t.worst, 'проверки посчитаны');
  // в деревянном узле появляется смятие под шайбой, которого нет в стальном
  const names = analyse(m).beamTies.wall.checks.map((c) => c.name);
  assert.ok(names.includes('Смятие древесины под шайбой'));
  assert.ok(names.includes('Болт как нагель в брусе'));
  assert.ok(!analyse(m).beamTies.outer.checks.some((c) => /древесин/.test(c.name)));
});

test('болты узла делят усилие, и их число решает', () => {
  const m = defaultModel();
  m.site.windRegion = 'VII';
  m.site.terrain = 'A';
  const two = analyse({ ...m, wallPurlinTie: { id: 'plate12x2' } }).beamTies.wall;
  const four = analyse({ ...m, wallPurlinTie: { id: 'plate12x4' } }).beamTies.wall;
  assert.equal(two.n, 2);
  assert.equal(four.n, 4);
  assert.ok(Math.abs(two.Nb - two.uplift / 2) < 1e-9, 'отрыв делится на болты');
  assert.ok(Math.abs(four.Nb - two.Nb / 2) < 1e-9);
  assert.ok(two.U > 1 && four.U < two.U, `${two.U.toFixed(2)} → ${four.U.toFixed(2)}`);
});

test('узлы прогонов попадают в сводку и спецификацию', () => {
  const r = analyse(defaultModel());
  const row = r.summary.find((s) => s.key === 'beamTies');
  assert.ok(row && row.U > 0, 'строка «Прогон на столбе»');

  const b = billOfMaterials(r);
  assert.ok(b.fasteners.some((f) => f.name.startsWith('Сварной шов')), 'шов наружного ряда');
  assert.ok(b.fasteners.some((f) => /Пластина-оголовок/.test(f.name)), 'оголовок у стены');
  const bolts = b.fasteners.find((f) => /Болт М12 класса .*узел/.test(f.name));
  assert.equal(bolts.count, 2 * defaultModel().wallPosts.xs.length);
});

/* ─────────────── база столба ─────────────── */

test('база держит момент, и разнос анкеров решает', () => {
  const m = defaultModel();
  m.site.windRegion = 'V';
  // блок заведомо тяжёлый, чтобы вес его не определял: смотрим только анкеры
  const heavy = { footing: 1200, depth: 3000 };
  const two = analyse({ ...m, postBase: { id: 'plate2m12', ...heavy } }).bases.outer;
  const four = analyse({ ...m, postBase: { id: 'plate4m12', ...heavy } }).bases.outer;

  // момент в базе: вдоль стены без связей столб — консоль под ветром, поперёк
  // ряда половина момента от эксцентриситета опирания
  assert.ok(two.M > 1e6, `${(two.M / 1e6).toFixed(2)} кН·м`);
  // два анкера с разносом 120 мм принимают весь момент парой сил
  const span2 = anchorSpan(postBase('plate2m12'));
  assert.equal(span2, 120);
  assert.ok(Math.abs(two.Na - (two.uplift / 2 + two.M / span2)) < 1e-6);
  // четыре анкера: момент делится на два анкера растянутой стороны, и разнос больше
  assert.ok(four.Na < two.Na / 2, `${(four.Na / 1000).toFixed(1)} против ${(two.Na / 1000).toFixed(1)} кН`);
  assert.ok(two.U > 1 && four.U < 1, `два: ${two.U.toFixed(2)}, четыре: ${four.U.toFixed(2)}`);
  assert.equal(two.worst.name, 'Болт на растяжение');
});

test('у раскреплённого ряда момента в базе нет', () => {
  const r = analyse(defaultModel());
  assert.ok(r.bases.wall.M < 1, 'стеновой столб раскреплён шпильками — эпюра не даёт момента внизу');
  assert.ok(r.bases.wall.U < r.bases.outer.U);
});

test('забетонированный столб: вес блока против отрыва и глубина заделки', () => {
  const m = defaultModel();
  const shallow = analyse({ ...m, postBase: { id: 'embed600', footing: 400, depth: 600 } }).bases.outer;
  // блок 400×400×600 весит 230 кг, а против отрыва нужно 600 с лишним
  assert.equal(shallow.side, 400);
  assert.ok(Math.abs(shallow.mass - 0.4 * 0.4 * 0.6 * 2400) < 1);
  assert.ok(shallow.U > 1);
  assert.equal(shallow.enough, false);

  // шире и глубже — проходит
  const big = analyse({ ...m, postBase: { id: 'embed1200', footing: 700, depth: 1200 } }).bases.outer;
  assert.ok(big.U <= 1, `U = ${big.U.toFixed(2)}`);
  assert.equal(big.enough, true);

  // блок не может быть мельче заделки: столб в нём стоит
  const forced = analyse({ ...m, postBase: { id: 'embed1200', footing: 400, depth: 400 } }).bases.outer;
  assert.equal(forced.depth, 1200, 'в расчёт идёт заделка, а не заданная глубина');

  // при схеме с защемлением требуется заделка не менее десяти размеров сечения
  assert.equal(shallow.needEmbed, 10 * 100);
  const pinned = defaultModel();
  pinned.bracing.along = 'cross';
  pinned.postBase = { id: 'embed600', footing: 700, depth: 600 };
  const noFix = analyse(pinned).bases.outer;
  assert.equal(noFix.needsFixity, false);
  assert.ok(!noFix.checks.some((c) => c.name === 'Глубина заделки'), 'шарнирной схеме заделка не нужна');
});

test('вес блока проверяется у обеих баз одинаково', () => {
  const m = defaultModel();
  const light = { footing: 400, depth: 600 }; // 230 кг против нужных 606
  for (const id of ['plate4m12', 'embed600']) {
    const b = analyse({ ...m, postBase: { id, ...light } }).bases.outer;
    assert.ok(b.checks.some((c) => c.name === 'Вес фундамента против отрыва'),
      `${id}: проверка веса блока должна быть у обеих баз`);
    assert.ok(b.U > 1, `${id}: лёгкий блок не должен проходить, U = ${b.U.toFixed(2)}`);
    assert.equal(b.enough, false);
  }

  // подсказки «сделайте так» согласованы с проверкой: по ним блок проходит
  const b0 = analyse({ ...m, postBase: { id: 'plate4m12', ...light } }).bases.outer;
  const deeper = analyse({ ...m, postBase: { id: 'plate4m12', footing: 400, depth: b0.needDepth } }).bases.outer;
  assert.equal(deeper.enough, true, `глубины ${b0.needDepth} мм должно хватить`);
  const wider = analyse({ ...m, postBase: { id: 'plate4m12', footing: b0.needSide, depth: 600 } }).bases.outer;
  assert.equal(wider.enough, true, `стороны ${b0.needSide} мм должно хватить`);
});

test('база попадает в сводку, подбор и спецификацию', () => {
  const r = analyse(defaultModel());
  assert.ok(r.summary.find((s) => s.key === 'bases'));

  const b = billOfMaterials(r);
  assert.ok(b.fasteners.some((f) => f.name.startsWith('Плита базы')));
  const anchors = b.fasteners.find((f) => f.name.startsWith('Анкер'));
  const m = defaultModel();
  assert.equal(anchors.count, 4 * (m.posts.xs.length + m.wallPosts.xs.length));

  // автоподбор выбирает базу под нагрузку
  const windy = defaultModel();
  windy.site.windRegion = 'VII';
  windy.site.terrain = 'A';
  const picked = pickAll(windy, 0.9).model;
  assert.ok(analyse(picked).bases.outer.U <= 1);
  assert.notEqual(picked.postBase.id, defaultModel().postBase.id, 'под сильный ветер нужна база крупнее');
});

/* ─────────────── мороз ─────────────── */

test('глубина промерзания по СП 22: пересчёт на грунт отношением d₀ и k_h = 1,1', () => {
  // карта даёт 1200 мм для суглинков
  const clay = frostDepth(1200, 'clay');
  assert.equal(Math.round(clay.dfn), 1200);
  assert.equal(Math.round(clay.df), 1320, 'неотапливаемый навес: d_f = 1,1·d_fn');

  // супесь промерзает глубже: 1200 · 0,28 / 0,23
  assert.equal(Math.round(frostDepth(1200, 'sandyLoam').dfn), Math.round(1200 * 0.28 / 0.23));
  // песок ещё глубже, но он непучинистый
  const sand = frostDepth(1200, 'sand');
  assert.ok(sand.dfn > clay.dfn);
  assert.equal(sand.soil.heaving, false);

  assert.equal(frostDepth(0, 'clay').set, false, '0 — не задано');
});

test('подошва ниже промерзания проверяется только для пучинистого грунта', () => {
  const run = (site) => {
    const m = defaultModel();
    Object.assign(m.site, site);
    return analyse(m).bases.outer;
  };
  const name = 'Подошва ниже промерзания';

  const unset = run({});
  assert.ok(!unset.checks.some((c) => c.name === name), 'не задано — проверки нет');
  assert.equal(unset.frost.set, false);

  // блок по умолчанию 1200 мм, а расчётная глубина 1320 — не проходит
  const shallow = run({ frostDepth: 1200, soil: 'clay' });
  const chk = shallow.checks.find((c) => c.name === name);
  assert.ok(chk, 'для суглинка проверка есть');
  assert.ok(chk.U > 1, `U = ${chk.U.toFixed(2)}`);
  assert.equal(shallow.frost.needDepth, 1350, 'нужная глубина округлена до шага 50');

  const sand = run({ frostDepth: 1200, soil: 'sand' });
  assert.ok(!sand.checks.some((c) => c.name === name), 'непучинистый грунт — от мороза не зависит');
});

test('подбор блока учитывает и вес, и мороз', () => {
  const m = defaultModel();
  m.site.frostDepth = 1200;
  m.site.soil = 'clay';
  const picked = pickTies(m).model;
  const b = analyse(picked).bases.outer;
  assert.ok(picked.postBase.depth >= 1320, `глубина ${picked.postBase.depth} мм — не мельче промерзания`);
  assert.ok(b.frost.ok, 'после подбора подошва ниже промерзания');
  assert.ok(b.enough, 'и вес по-прежнему держит отрыв');
  assert.ok(b.U <= 1, `U базы ${b.U.toFixed(2)}`);
});
