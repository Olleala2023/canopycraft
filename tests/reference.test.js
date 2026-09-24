import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel } from '../src/core/model.js';
import { analyse, billOfMaterials, spliceReport } from '../src/core/analysis.js';
import { drawPlan, drawSection, drawDiagrams, drawNodes } from '../src/ui/views.js';

/**
 * Эталонные расчёты.
 *
 * 1. Ручной счёт стропила — нагрузки по СП 20 и статика балки с консолью
 *    выписаны здесь отдельно от кода расчёта, числами из норм.
 * 2. Эталон варианта по умолчанию — коэффициенты использования и смета.
 *    Любое изменение расчёта, которое их сдвигает, должно быть объяснено
 *    в PR, а числа здесь обновлены осознанно.
 * 3. Вырожденные случаи — расчёт не падает, не выдаёт NaN и не выдаёт
 *    изменяемую схему за проходящую.
 */

const close = (actual, expected, relTol, msg) => {
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(rel <= relTol, `${msg}: ${actual} вместо ${expected} (расхождение ${(rel * 100).toFixed(2)} %)`);
};

test('стропило вручную: снег по СП 20, собственный вес, балка с консолью', () => {
  const m = defaultModel();
  m.site.drift = false; // без мешка снег равномерный — его можно посчитать руками
  const r = analyse(m);
  const raf = r.rafters[5]; // среднее стропило: грузовая ширина — шаг 600 мм
  assert.equal(raf.trib, 600, 'грузовая ширина среднего стропила');

  const ca = Math.cos((8 * Math.PI) / 180); // уклон 8°
  const trib = 600; // мм

  // Снег, п. 10.1 СП 20: S₀ = cₑ·cₜ·μ·S_g. Район III — S_g = 1,5 кПа (табл. 10.1),
  // μ = 1 при уклоне до 30° (Б.1), cₑ = cₜ = 1. Расчётный — γf = 1,4 (п. 10.12).
  // Снег задан на горизонтальную проекцию: на метр ската приходится S·cos α,
  // поперёк ската из этого идёт ещё cos α.
  const S0 = 1.0 * 1.0 * 1.0 * 1.5; // кПа
  const qSnow = 1.4 * S0 * (trib / 1000) * ca * ca; // Н/мм

  // Постоянные — на метр ската, поперёк ската × cos α:
  //   профлист С8 0,05 кПа, γf = 1,2 (табл. 7.1 СП 20);
  //   обрешётка 50×50 шагом 600 мм и стропило 50×250 — сосна 500 кг/м³, γf = 1,1.
  const g = 9.80665;
  const roof = 0.05 * (trib / 1000); // Н/мм
  const batten = (50 * 50 * 1e-6 * 500 * g) / 1000 / 600 * trib; // Н/мм: кг/м → Н/мм, на шаг 600
  const self = (50 * 250 * 1e-6 * 500 * g) / 1000; // Н/мм
  const qDead = (1.2 * roof + 1.1 * (batten + self)) * ca;

  const q = qDead + qSnow; // сочетание ULS-1: постоянные + снег
  const l = 4000 / ca; // пролёт по скату, мм
  const c = 800 / ca; // консоль по скату, мм

  // Балка на двух опорах с консолью под равномерной q:
  //   R_A = q·(l² − c²) / 2l,  R_B = q·(l + c)² / 2l,
  //   M в пролёте = R_A² / 2q,  M над опорой = q·c² / 2.
  const RA = (q * (l * l - c * c)) / (2 * l);
  const RB = (q * (l + c) ** 2) / (2 * l);
  const Mspan = (RA * RA) / (2 * q);
  const Msup = (q * c * c) / 2;

  const uls = raf.res['ULS-1'];
  const [rWall, rPurlin] = uls.reactions.map((x) => x.R);
  close(rWall, RA, 0.005, 'реакция у стены');
  close(rPurlin, RB, 0.005, 'реакция на прогоне');
  close(Math.max(...uls.M), Mspan, 0.005, 'момент в пролёте');
  close(Math.abs(Math.min(...uls.M)), Msup, 0.005, 'момент над опорой');

  // изгиб, п. 7.9 СП 64: σ = M / W, W = b·h²/6
  const bend = raf.checks.find((ch) => ch.name === 'Изгиб');
  close(bend.value, Math.abs(raf.Mmax) / ((50 * 250 * 250) / 6), 0.001, 'напряжение изгиба σ = M/W');
  assert.ok(Math.abs(raf.Mmax) >= Mspan * 0.999, 'огибающая меньше момента от снега — потеряно сочетание');
});

test('смета вручную: объём стропил', () => {
  const b = billOfMaterials(analyse(defaultModel()));
  const raf = b.items.find((i) => i.name === 'Стропила');
  // длина по скату (4000 + 800) / cos 8° и 100 мм на запил, 11 штук 50×250
  const len = (4000 + 800) / Math.cos((8 * Math.PI) / 180) + 100;
  close(raf.length, len, 0.001, 'длина стропила');
  close(raf.volume, 11 * 0.05 * 0.25 * (len / 1000), 0.001, 'объём стропил, м³');
});

/**
 * Эталон варианта по умолчанию. Если число здесь разошлось, это не повод
 * поправить эталон молча: сначала понять, почему изменился расчёт, и
 * написать об этом в PR (раздел «Изменились ли числа расчёта»).
 */
const REFERENCE = {
  U: {
    battens: 0.750,
    rafters: 0.582,
    purlin: 0.193, // было 0,189: опорный момент проскакивал между точками эпюры
    posts: 0.846,
    wallPurlin: 0.485,
    wallPosts: 0.868,
    ties: 0.827,
    beamTies: 0.833,
    bases: 0.842,
  },
  timberVolume: 0.875, // м³
  steelMass: 263.9, // кг
  cost: 84552, // ₽
};

test('эталон варианта по умолчанию: коэффициенты использования', () => {
  const r = analyse(defaultModel());
  const got = Object.fromEntries(r.summary.map((s) => [s.key, s.U]));
  assert.deepEqual(Object.keys(got).sort(), Object.keys(REFERENCE.U).sort(), 'изменился состав сводки');
  for (const [k, U] of Object.entries(REFERENCE.U)) {
    assert.ok(Math.abs(got[k] - U) < 0.0015, `${k}: U = ${got[k].toFixed(3)} вместо эталонных ${U.toFixed(3)} — объясните в PR, почему расчёт изменился`);
  }
});

test('эталон варианта по умолчанию: смета', () => {
  const b = billOfMaterials(analyse(defaultModel()));
  close(b.timberVolume, REFERENCE.timberVolume, 0.001, 'объём дерева');
  close(b.steelMass, REFERENCE.steelMass, 0.001, 'масса стали');
  close(b.costs.total, REFERENCE.cost, 0.001, 'стоимость');
});

const VIEWS = [drawPlan, drawSection, drawDiagrams, drawNodes];

const DEGENERATE = {
  'плоская кровля, уклон 0°': (m) => { m.geom.alpha = 0; },
  'без свеса': (m) => { m.geom.a = 0; },
  'без снегового мешка': (m) => { m.site.drift = false; },
  'перепад до кровли дома 0': (m) => { m.geom.driftH = 0; },
  'всего два стропила': (m) => { m.rafters.xs = [0, m.geom.B]; },
  'уклон 45°': (m) => { m.geom.alpha = 45; },
  'свес длиннее пролёта': (m) => { m.geom.a = 4500; },
};

test('вырожденные случаи: расчёт не падает, без NaN, чертежи рисуются', () => {
  for (const [name, change] of Object.entries(DEGENERATE)) {
    const m = defaultModel();
    change(m);
    const r = analyse(m);
    for (const s of r.summary) assert.ok(!Number.isNaN(s.U), `${name}: U = NaN у «${s.label}»`);
    assert.ok(!Number.isNaN(r.maxU), `${name}: maxU = NaN`);
    for (const draw of VIEWS) {
      const svg = draw(r, { type: 'rafter', index: 0 }).svg;
      assert.ok(!/NaN|undefined/.test(svg), `${name}: ${(/.{0,60}(NaN|undefined).{0,60}/.exec(svg) ?? [])[0]}`);
    }
  }
});

test('изменяемая схема не выдаётся за проходящую', () => {
  // Стропило длиннее хлыста 6 м: стык встык ложится на прогон, и свес остаётся
  // куском на одной опоре. Расчёт обязан это назвать и не показать «проходит».
  for (const name of ['уклон 45°', 'свес длиннее пролёта']) {
    const m = defaultModel();
    DEGENERATE[name](m);
    const raf = spliceReport(m).find((p) => p.key === 'rafters');
    assert.ok(raf?.unstable, `${name}: кусок стропила на одной опоре не отмечен как изменяемая схема`);
    const r = analyse(m);
    assert.ok(r.maxU > 1, `${name}: изменяемая схема показана проходящей`);
    // раньше решатель «решал» вырожденную систему: прогиб ~10¹² мм, U ≈ 4·10¹¹ —
    // конечное число, которое попадало в шапку и отчёт вместо слов
    assert.equal(r.maxU, Infinity, `${name}: maxU = ${r.maxU} — число по вырожденному решению вместо «изменяемая схема»`);
    const row = r.summary.find((s) => s.key === 'rafters');
    assert.equal(row.U, Infinity, `${name}: U стропил ${row.U} — конечное число у механизма`);
    assert.equal(row.worst.name, 'Изменяемая схема', `${name}: определяет «${row.worst.name}», а не изменяемая схема`);
    for (const raf of r.rafters) {
      assert.deepEqual(raf.checks.map((c) => c.name), ['Изменяемая схема'],
        `${name}: у механизма остались проверки по вырожденному решению`);
    }
  }
});
