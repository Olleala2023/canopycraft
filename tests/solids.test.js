import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel, levels } from '../src/core/model.js';
import { analyse } from '../src/core/analysis.js';
import { buildSolids, selectionBox, SELECT_PAD, toScene } from '../src/ui/solids.js';

/**
 * 3D-вид строится из тех же чисел, что и расчёт. Детали должны стыковаться
 * так, как их считают: стропило лежит на прогоне и обвязке, столбы доходят
 * до них, обрешётка лежит на стропилах. Зазор или врезание — это 3D, который
 * разошёлся с расчётом.
 */

const EPS = 1e-6; // мм

/** Нижняя грань бруска (по up) в точке оси с параметром s ∈ [0; 1]. */
function underside(e, s) {
  const p = e.from.map((v, i) => v + (e.to[i] - v) * s);
  return p.map((v, i) => v - (e.up[i] * e.h) / 2);
}
/** Верхняя грань. */
function topside(e, s) {
  const p = e.from.map((v, i) => v + (e.to[i] - v) * s);
  return p.map((v, i) => v + (e.up[i] * e.h) / 2);
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < EPS, `${msg}: ${a} вместо ${b}`);

for (const [name, change] of [
  ['по умолчанию', () => {}],
  ['уклон 20°, свес 1200, высокий столб', (m) => { m.geom.alpha = 20; m.geom.a = 1200; m.geom.postHeight = 3200; }],
  ['крест в ряду', (m) => { m.bracing.along = 'cross'; }],
  ['связи по кровле', (m) => { m.bracing.along = 'roof'; }],
]) {
  test(`3D: детали стыкуются как в расчёте — ${name}`, () => {
    const m = defaultModel();
    change(m);
    const res = analyse(m);
    const lv = levels(m);
    const solids = buildSolids(res);
    const of = (kind) => solids.filter((e) => e.kind === kind);

    assert.equal(of('rafter').length, m.rafters.xs.length, 'не все стропила');
    assert.equal(of('post').length, m.posts.xs.length, 'не все наружные столбы');
    assert.equal(of('wallPost').length, m.wallPosts.xs.length, 'не все столбы у стены');
    for (const e of solids) {
      assert.ok([...e.from, ...e.to, e.w, e.h].every(Number.isFinite), `${e.label}: не число в геометрии`);
    }

    const purlin = of('purlin')[0], wallPurlin = of('wallPurlin')[0];
    const tanA = Math.tan((m.geom.alpha * Math.PI) / 180);
    for (const r of of('rafter')) {
      // низ стропила над наружным прогоном — ровно верх прогона
      const len = Math.hypot(...r.to.map((v, i) => v - r.from[i]));
      const sPurlin = (m.geom.L / Math.cos((m.geom.alpha * Math.PI) / 180)) / len;
      close(underside(r, sPurlin)[2], topside(purlin, 0)[2], `${r.label} не лежит на прогоне`);
      close(underside(r, 0)[2], topside(wallPurlin, 0)[2], `${r.label} не лежит на обвязке`);
      close(underside(r, 0)[2] - underside(r, sPurlin)[2], m.geom.L * tanA, `${r.label}: подъём не L·tg α`);
    }
    for (const p of of('post')) close(p.to[2], lv.postTop, `${p.label} не доходит до прогона`);
    for (const p of of('wallPost')) close(p.to[2], lv.wallPostTop, `${p.label} не доходит до обвязки`);
    close(topside(purlin, 0)[2], lv.rafterBottomOuter, 'верх прогона — не низ стропила по levels()');

    // обрешётка — на верху стропил: низ рейки лежит в плоскости их верха
    const raf = of('rafter')[0];
    const top0 = topside(raf, 0);
    for (const b of of('batten')) {
      const u = underside(b, 0);
      const off = u.reduce((acc, v, i) => acc + (v - top0[i]) * raf.up[i], 0);
      close(off, 0, `рейка на y = ${b.from[1].toFixed(0)} не лежит на стропилах`);
    }
    // число реек — как в спецификации
    const Ls = (m.geom.L + m.geom.a) / Math.cos((m.geom.alpha * Math.PI) / 180);
    assert.equal(of('batten').length, Math.floor(Ls / m.battens.spacing) + 1, 'реек не столько, сколько в смете');
  });
}

test('3D: у каждой детали, кроме кровли, есть что выбрать и её U', () => {
  const m = defaultModel();
  m.bracing.along = 'cross';
  for (const e of buildSolids(analyse(m))) {
    if (e.ghost) continue;
    assert.ok(e.sel?.type, `${e.label}: клик ничего не выберет`);
    assert.ok(Number.isFinite(e.U), `${e.label}: нет U — нечем красить`);
  }
});

test('3D: рамка выбранной детали отступает на одно и то же расстояние, какой бы длинной деталь ни была', () => {
  const solids = buildSolids(analyse(defaultModel()));
  for (const kind of ['batten', 'rafter', 'post', 'purlin']) {
    const e = solids.find((x) => x.kind === kind);
    const len = Math.hypot(...e.to.map((v, i) => v - e.from[i]));
    const box = selectionBox(e);
    // раньше рамка была деталью × 1,04: у рейки 6 м — по 120 мм за торцами
    close(box.len - len, 2 * SELECT_PAD, `${e.label}: рамка длиннее детали не на 2 × ${SELECT_PAD} мм`);
    close(box.w - e.w, 2 * SELECT_PAD, `${e.label}: рамка шире детали не на 2 × ${SELECT_PAD} мм`);
    close(box.h - e.h, 2 * SELECT_PAD, `${e.label}: рамка выше детали не на 2 × ${SELECT_PAD} мм`);
  }
});

test('3D не зеркальный: у зрителя во дворе, лицом к дому, x растёт вправо — как на плане', () => {
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  // из двора (y = 5000 по расчёту) к стене (y = 0) — куда смотрит зритель, в сцене
  const forward = sub(toScene([0, 0, 0]), toScene([0, 5000, 0]));
  const up = toScene([0, 0, 1]);
  const sign = (v) => v.map((c) => Math.sign(c) + 0); // + 0: −0 и 0 для deepEqual разные
  const right = sign(cross(forward, up));
  // сцена three.js — правая тройка: «вправо» зрителя = взгляд × вверх
  assert.deepEqual(right, sign(toScene([1, 0, 0])), 'x = 0 оказался справа — 3D зеркален плану и фасаду');
});
