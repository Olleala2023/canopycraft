import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel, splicePlan, spread } from '../src/core/model.js';
import { analyse, billOfMaterials, spliceReport, spliceHinges, spliceScheme } from '../src/core/analysis.js';
import { solveBeam } from '../src/core/beam.js';
import { dowelDouble } from '../src/core/fasteners.js';

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

test('стык встык садится на опору, а не на длину хлыста', () => {
  // 0/2000/4000/9000: наивный стык при 6000 оставил бы правый кусок на одном столбе,
  // но стык встык кладётся на самую дальнюю опору в пределах хлыста — это 4000
  const plan = splicePlan(9000, 6000, [0, 2000, 4000, 9000], { onSupports: true });
  assert.deepEqual(plan.at, [4000]);
  assert.equal(plan.unstable, false, 'оба куска встали на опоры');
  assert.equal(plan.impossible, false);

  const naive = splicePlan(9000, 6000, [0, 2000, 4000, 9000]);
  assert.deepEqual(naive.at, [6000], 'для накладки место стыка не привязано к опорам');
  assert.equal(naive.unstable, true, 'и тогда правый кусок висит на одном столбе');
});

test('стык встык невозможен, если в пределах хлыста нет опоры', () => {
  // пролёт 7 м между столбами: кусок длиной в хлыст не на чем закончить
  const plan = splicePlan(11000, 6000, [0, 7000, 11000], { onSupports: true });
  assert.equal(plan.impossible, true);
  assert.equal(plan.from, 0, 'не нашлось опоры в пределах хлыста от начала');

  const m = defaultModel();
  m.geom.B = 11000;
  m.rafters.xs = spread(11000, 19);
  m.posts.xs = [0, 7000, 11000];
  m.wallPosts.xs = spread(11000, 9);
  const purlin = analyse(m).splices.find((s) => s.key === 'purlin');
  assert.equal(purlin.impossible, true, 'расчёт обязан сказать, что так не собрать');
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

/* ───────── стык в расчётной схеме ───────── */

test('шарнир в решателе: два пролёта со стыком над средней опорой = две простые балки', () => {
  const L = 3000, q = 2, EI = 206000 * 3e6;
  const run = (hinges) => solveBeam({ length: 2 * L, supports: [0, L, 2 * L], EI, GAs: 0, q: () => q, hinges, nEl: 200 });
  const at = (r, x) => {
    let best = 0;
    for (let i = 0; i < r.x.length; i++) if (Math.abs(r.x[i] - x) < Math.abs(r.x[best] - x)) best = i;
    return r.M[best];
  };
  const wmax = (r, x0, x1) => {
    let f = 0;
    for (let i = 0; i < r.x.length; i++) if (r.x[i] >= x0 && r.x[i] <= x1 && Math.abs(r.w[i]) > Math.abs(f)) f = r.w[i];
    return f;
  };

  const cont = run([]);
  assert.ok(Math.abs(at(cont, L) - (-q * L * L / 8)) < 1e-3 * q * L * L, 'неразрезная: момент над опорой −qL²/8');
  assert.ok(Math.abs(cont.reactions[1].R - 1.25 * q * L) < 1, 'неразрезная: средняя реакция 1,25·qL');

  const hin = run([L]);
  assert.ok(Math.abs(at(hin, L)) < 1e-6 * q * L * L, 'со стыком момент через него не идёт');
  assert.ok(Math.abs(at(hin, L / 2) - (q * L * L / 8)) < 1e-3 * q * L * L, 'в пролёте qL²/8, как у простой балки');
  assert.ok(Math.abs(hin.reactions[0].R - 0.5 * q * L) < 1, 'крайняя реакция 0,5·qL');
  assert.ok(Math.abs(hin.reactions[1].R - q * L) < 1, 'средняя реакция qL');

  // прогиб справа от стыка считается по восстановленному повороту, а не по чужому
  const fTheory = (5 * q * L ** 4) / (384 * EI);
  assert.ok(Math.abs(wmax(hin, 0, L) - fTheory) < 0.01 * fTheory, 'слева 5qL⁴/384EI');
  assert.ok(Math.abs(wmax(hin, L, 2 * L) - fTheory) < 0.01 * fTheory, 'справа столько же');
});

test('стык на конце балки ничего не рвёт', () => {
  const L = 3000, q = 2, EI = 206000 * 3e6;
  const plain = solveBeam({ length: L, supports: [0, L], EI, GAs: 0, q: () => q, nEl: 120 });
  const edge = solveBeam({ length: L, supports: [0, L], EI, GAs: 0, q: () => q, hinges: [0, L], nEl: 120 });
  assert.ok(Math.abs(plain.maxM - edge.maxM) < 1e-6 * Math.abs(plain.maxM), 'на концах непрерывности нет');
});

test('накладка оставляет балку неразрезной, стык встык — нет', () => {
  const m = defaultModel();
  m.geom.B = 9000;
  const sup = [0, 2250, 4500, 6750, 9000];
  assert.deepEqual(spliceHinges(m, 9000, sup), [4500], 'встык по умолчанию — шарнир на опоре 4500');
  assert.deepEqual(spliceHinges(m, 6000, sup), [], 'элемент по длине хлыста стыка не требует');
  m.opts.spliceJoint = 'plate';
  assert.deepEqual(spliceHinges(m, 9000, sup), [], 'накладка восстанавливает сечение — шарнира нет');
});

test('расчёт по умолчанию не зависит от типа стыка: стыков там нет', () => {
  const a = analyse(defaultModel());
  const m = defaultModel();
  m.opts.spliceJoint = 'plate';
  assert.equal(analyse(m).maxU, a.maxU, 'навес 6 м при хлысте 6 м считается одинаково');
});

test('стык встык поднимает момент в прогоне против неразрезной схемы', () => {
  const build = (joint) => {
    const m = defaultModel();
    m.geom.B = 9000;
    m.rafters.xs = spread(9000, 16);
    m.posts.xs = spread(9000, 5);
    m.wallPosts.xs = spread(9000, 7);
    m.purlin.sectionId = 's60x80x3';
    m.opts.spliceJoint = joint;
    return analyse(m).purlin;
  };
  const plate = build('plate'), butt = build('butt');
  assert.ok(butt.U > plate.U * 1.15, `шарнир должен заметно грузить прогон: ${plate.U.toFixed(3)} → ${butt.U.toFixed(3)}`);
  assert.ok(plate.U < 1 && butt.U > 1, 'сечение, проходящее неразрезным, со стыком встык не проходит');
  const sum = (b) => b.reactions.reduce((a, r) => a + r.R, 0);
  assert.ok(Math.abs(sum(plate) - sum(butt)) < 0.01 * sum(plate), 'сумма реакций не зависит от схемы');
});

/* ───────── узел стыка ───────── */

test('двухсрезный нагель: берётся наименьшее из трёх по табл. 20 СП 64', () => {
  // нагель М12 в балке 50 мм с накладками 25 мм: смятие балки 0,5·c·d = 3 кН
  const a = dowelDouble({ d: 12, plate: 25, beam: 50 });
  assert.equal(Math.round(a.T), 3000);
  assert.equal(a.governs, 'смятие балки');

  // тонкие накладки 10 мм: 2·0,8·a·d = 1,92 кН — теперь правят они
  const b = dowelDouble({ d: 12, plate: 10, beam: 50 });
  assert.equal(Math.round(b.T), 1920);
  assert.equal(b.governs, 'смятие накладок');

  // толстая балка и толстые накладки: упираемся в изгиб нагеля 2·1,8·d²
  const c = dowelDouble({ d: 12, plate: 50, beam: 200 });
  assert.equal(Math.round(c.T), Math.round(2 * 1.8 * 1.2 * 1.2 * 1000));
  assert.equal(c.governs, 'изгиб нагеля');

  // влажность снижает всё разом
  assert.equal(dowelDouble({ d: 12, plate: 25, beam: 50, mv: 0.9 }).T, 0.9 * a.T);
});

test('при стыке встык узла нет, при накладке — есть и он посчитан', () => {
  const build = (joint) => {
    const m = defaultModel();
    m.geom.B = 9000;
    m.rafters.xs = spread(9000, 16);
    m.posts.xs = spread(9000, 5);
    m.wallPosts.xs = spread(9000, 7);
    m.opts.spliceJoint = joint;
    return analyse(m);
  };
  assert.deepEqual(build('butt').spliceJoints, [], 'стык встык лежит на опоре и ничего не передаёт');

  const res = build('plate');
  assert.ok(res.spliceJoints.length >= 2, 'прогон и обвязка стыкуются, и у каждого свой узел');
  assert.ok(!res.spliceJoints.some((j) => j.key === 'battens'), 'обрешётку стыкуют на стропиле, накладок на неё не ставят');

  const wall = res.spliceJoints.find((j) => j.key === 'wallPurlin');
  assert.equal(wall.material, 'timber');
  assert.ok(wall.n >= 4 && wall.d >= 12, `нагели подобраны: ${wall.solution}`);
  assert.ok(wall.U <= 0.85, 'узел подбирается с тем же целевым запасом, что и сечения');
  assert.match(wall.solution, /накладки .*мм, \d+ нагелей М\d+/);

  const purlin = res.spliceJoints.find((j) => j.key === 'purlin');
  assert.equal(purlin.material, 'steel');
  assert.ok(purlin.weldLength > 0 && purlin.kf >= 3, `шов подобран: ${purlin.solution}`);

  assert.ok(res.summary.some((s) => s.key === 'spliceJoints'), 'узел стыка виден в сводке');
});

test('нагели не вылезают за кромку низкого сечения', () => {
  const m = defaultModel();
  m.geom.B = 9000;
  m.rafters.xs = spread(9000, 16);
  m.posts.xs = spread(9000, 5);
  m.wallPosts.xs = spread(9000, 7);
  m.wallPurlin.sectionId = 't50x100'; // 100 мм высоты — два ряда нагелей М20 не встанут
  m.opts.spliceJoint = 'plate';
  const wall = analyse(m).spliceJoints.find((j) => j.key === 'wallPurlin');
  if (wall && !wall.impossible) {
    const halfH = 100 / 2;
    assert.ok(wall.rows === 1 || halfH - 3 * wall.d >= 1.75 * wall.d,
      `при ${wall.rows} рядах нагели М${wall.d} должны помещаться в 100 мм`);
  }
});

test('накладки и нагели попадают в смету', () => {
  const m = defaultModel();
  m.geom.B = 9000;
  m.rafters.xs = spread(9000, 16);
  m.posts.xs = spread(9000, 5);
  m.wallPosts.xs = spread(9000, 7);
  m.opts.spliceJoint = 'plate';
  const b = billOfMaterials(analyse(m));
  const plates = b.fasteners.filter((f) => f.name.startsWith('Накладка стыка'));
  assert.ok(plates.length >= 2, 'накладки обоих стыков в спецификации');
  assert.ok(plates.every((f) => f.mass > 0 && f.cost > 0), 'у накладок есть масса и цена');
  assert.ok(b.fasteners.some((f) => f.name.startsWith('Нагель')), 'нагели тоже');

  const butt = defaultModel();
  Object.assign(butt.geom, { B: 9000 });
  butt.rafters.xs = spread(9000, 16);
  butt.posts.xs = spread(9000, 5);
  butt.wallPosts.xs = spread(9000, 7);
  const bb = billOfMaterials(analyse(butt));
  assert.ok(!bb.fasteners.some((f) => f.name.startsWith('Накладка стыка')), 'при стыке встык накладок нет');
  assert.ok(b.costs.total > bb.costs.total, 'накладки стоят денег, и это видно в смете');
});

/** Случаи, где стык встык оставляет кусок на одной опоре: навес 6,5 м, хлыст 6 м. */
const LOOSE = {
  purlin: (m) => { m.geom.B = 6500; m.posts.xs = [250, 6000]; },
  wallPurlin: (m) => { m.geom.B = 6500; m.wallPosts.xs = [250, 6000]; },
  battens: (m) => { m.geom.B = 6500; m.rafters.xs = [0, 1500, 3000, 4500, 6000]; },
};

test('прогон, обвязка и обрешётка с куском на одной опоре — изменяемая схема, U = ∞', () => {
  for (const [key, change] of Object.entries(LOOSE)) {
    const m = defaultModel();
    change(m);
    assert.ok(spliceReport(m).find((p) => p.key === key)?.unstable,
      `${key}: предупреждение не видит куска 6000–6500 мм на одной опоре — пример не тот`);
    const r = analyse(m);
    assert.equal(r[key].U, Infinity, `${key}: U = ${r[key].U} — проверки по вырожденному решению`);
    assert.deepEqual(r[key].checks.map((c) => c.name), ['Изменяемая схема'], `${key}: лишние проверки у механизма`);
    assert.deepEqual(r[key].mechanism.map((c) => [Math.round(c.x0), Math.round(c.x1), c.supports]), [[6000, 6500, 1]],
      `${key}: не тот кусок назван болтающимся`);
    assert.equal(r.maxU, Infinity, `${key}: механизм не попал в максимум`);
  }
});

test('изменяемая схема передаёт на опоры всю нагрузку, а не теряет кусок', () => {
  // вырожденное решение теряло нагрузку с болтающегося куска: сумма реакций
  // выходила меньше приложенных сил. Эпюра Q строится статикой по реакциям,
  // поэтому на правом конце она равна ΣR − ΣF и у равновесной схемы — нулю
  const m = defaultModel();
  LOOSE.purlin(m);
  const { uls, sls } = analyse(m).purlin.res;
  const total = uls.reactions.reduce((a, x) => a + x.R, 0);
  const tail = uls.V[uls.V.length - 1];
  assert.ok(Math.abs(tail) < 1e-6 * total, `на опоры не дошло ${Math.round(-tail)} Н из ${Math.round(total - tail)} Н`);
  const w = Math.max(...sls.w.map(Math.abs));
  assert.ok(w < 1000, `прогиб ${Math.round(w)} мм — решена вырожденная система`);
});

test('при накладке кусок на одной опоре механизмом не считается', () => {
  const m = defaultModel();
  LOOSE.purlin(m);
  m.opts.spliceJoint = 'plate';
  const s = spliceScheme(m, 6500, [250, 6000]);
  assert.equal(s.mechanism, false, 'накладка восстанавливает сечение — кусок держится');
  assert.ok(Number.isFinite(analyse(m).purlin.U), 'прогон на накладке проверяется как обычно');
});

test('стропило решается по той же длине, что и предупреждение о стыке', () => {
  // длина по скату 5950 мм влезает в хлыст, а с припуском на торцовку 100 мм —
  // уже нет: предупреждение говорило «изменяемая схема», а проверки проходили
  const m = defaultModel();
  Object.assign(m.geom, { alpha: 0, L: 4000, a: 1950 });
  assert.ok(spliceReport(m).find((p) => p.key === 'rafters')?.unstable, 'предупреждение не видит стыка — пример не тот');
  assert.equal(analyse(m).rafters[0].U, Infinity, 'расчёт стропила разошёлся с предупреждением о стыке');
});
