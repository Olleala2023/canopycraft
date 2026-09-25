import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel } from '../src/core/model.js';
import { analyse, billOfMaterials, spliceReport } from '../src/core/analysis.js';
import { drawPlan, drawSection, drawDiagrams, drawNodes } from '../src/ui/views.js';
import { phiBuckling } from '../src/core/checks.js';

/**
 * Эталонные расчёты.
 *
 * 1. Ручной счёт — нагрузки по СП 20 и статика выписаны здесь отдельно от кода
 *    расчёта, числами из норм: деревянное и стальное стропило, снеговой мешок по
 *    схеме Б.8, крест в ряду.
 * 2. Эталон варианта по умолчанию — коэффициенты использования и смета.
 *    Любое изменение расчёта, которое их сдвигает, должно быть объяснено
 *    в PR, а числа здесь обновлены осознанно.
 * 3. Вырожденные случаи — расчёт не падает, не выдаёт NaN и не выдаёт
 *    изменяемую схему за проходящую.
 */

/**
 * Допуски сверки. Под равномерной нагрузкой статика точная — расходиться не
 * с чем, кроме округления. Под переменной (снеговой мешок) узловые силы МКЭ
 * дают расхождение до 4·10⁻⁴ в моменте над опорой. Допуск строгий нарочно:
 * γf 1,05 вместо 1,1 у обрешётки — это 4·10⁻⁴ нагрузки, и его надо заметить.
 */
const EXACT = 1e-6;
const FEM = 1e-3;

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
  close(rWall, RA, EXACT, 'реакция у стены');
  close(rPurlin, RB, EXACT, 'реакция на прогоне');
  close(Math.max(...uls.M), Mspan, EXACT, 'момент в пролёте');
  close(Math.abs(Math.min(...uls.M)), Msup, EXACT, 'момент над опорой');

  // изгиб, п. 7.9 СП 64: σ = M / W, W = b·h²/6
  const bend = raf.checks.find((ch) => ch.name === 'Изгиб');
  close(bend.value, Math.abs(raf.Mmax) / ((50 * 250 * 250) / 6), 0.001, 'напряжение изгиба σ = M/W');
  assert.ok(Math.abs(raf.Mmax) >= Mspan * 0.999, 'огибающая меньше момента от снега — потеряно сочетание');
});

test('стальное стропило вручную: собственный вес трубы, γf 1,05, изгиб по СП 16', () => {
  const m = defaultModel();
  m.site.drift = false;
  m.rafters.sectionId = 's60x120x3'; // труба 120×60×3 по ГОСТ 30245
  const r = analyse(m);
  const raf = r.rafters[5];
  const sec = raf.sec;

  const ca = Math.cos((8 * Math.PI) / 180);
  const trib = 600;
  const g = 9.80665;

  // Сталь 7850 кг/м³: погонный вес трубы — площадь сечения из сортамента × плотность.
  // Коэффициент надёжности для стали γf = 1,05 (табл. 7.1 СП 20), дерева — 1,1,
  // кровли — 1,2. Снег — как у деревянного стропила: 1,4·1,5 кПа на проекцию.
  const self = (sec.props.A * 1e-6 * 7850 * g) / 1000; // Н/мм
  const roof = 0.05 * (trib / 1000);
  const batten = ((50 * 50 * 1e-6 * 500 * g) / 1000 / 600) * trib;
  const qDead = (1.2 * roof + 1.1 * batten + 1.05 * self) * ca;
  const qSnow = 1.4 * 1.5 * (trib / 1000) * ca * ca;
  const q = qDead + qSnow;

  const l = 4000 / ca, c = 800 / ca;
  const RA = (q * (l * l - c * c)) / (2 * l);
  const RB = (q * (l + c) ** 2) / (2 * l);
  const uls = raf.res['ULS-1'];
  close(sec.weight, self, 0.001, 'погонный вес трубы: A·7850·g');
  close(uls.reactions[0].R, RA, EXACT, 'реакция у стены');
  close(uls.reactions[1].R, RB, EXACT, 'реакция на прогоне');
  close(Math.max(...uls.M), (RA * RA) / (2 * q), EXACT, 'момент в пролёте');

  // Изгиб, п. 8.2.1 СП 16: M / W ≤ R_y·γ_c; С245 — R_y = 240 МПа (табл. В.5), γ_c = 1
  const bend = raf.checks.find((ch) => ch.name === 'Изгиб');
  assert.equal(bend.limit, 240, 'R_y·γ_c для С245');
  close(bend.value, Math.abs(raf.Mmax) / sec.props.Wx, 0.001, 'σ = M / W');
  // Срез: R_s = 0,58·R_y (табл. 2 СП 16)
  close(raf.checks.find((ch) => ch.name === 'Срез').limit, 0.58 * 240, 0.001, 'R_s = 0,58·R_y');
});

test('снеговой мешок вручную: схема Б.8 СП 20 и стропило под трапециевидной нагрузкой', () => {
  const r = analyse(defaultModel());

  // Перепад h = 1,2 м, кровля дома l′₁ = 6 м с уклоном 20° (m₁ = 0,4), навес шириной
  // a = 6 м и вылетом l′₂ = 4,8 м, уклон β = 8°, S₀ = 1,5 кПа.
  // Перечисление «в»: m₂ = 0,5·k₁·k₂·k₃, k₁ = √(a/21), k₂ = 1 − β/35, k₃ = 1.
  const m2 = 0.5 * Math.sqrt(6 / 21) * (1 - 8 / 35);
  // (Б.5): μ = 1 + (m₁·l′₁ + m₂·l′₂)/h = 3,82 — больше потолка 2h/S₀ = 1,6 («д»)
  const raw = 1 + (0.4 * 6 + m2 * 4.8) / 1.2;
  const mu = (2 * 1.2) / 1.5;
  assert.ok(raw > mu, 'μ по (Б.5) должен упереться в 2h/S₀');
  // «г», (Б.6): b = 2h·(μ − 1 + 2m₂)/(2h/S₀ − 1 + 2m₂) = 7,67 м, но не более 5h = 6 м
  const b = Math.min((2 * 1.2 * (raw - 1 + 2 * m2)) / (mu - 1 + 2 * m2), 5 * 1.2, 16);
  // «е»: b ≥ l′₂, значит μ₁ = 1 − 2m₂
  const mu1 = 1 - 2 * m2;

  close(r.snow.muWall, mu, 1e-6, 'μ у стены');
  close(r.snow.driftLength, b * 1000, 1e-6, 'длина мешка b');
  close(r.snow.muEnd, mu1, 1e-6, 'μ₁ на дальнем конце');

  // Стропило: снег на проекцию убывает линейно от стены, y = s·cos α — расстояние
  // по горизонтали. Мешок длиннее всего навеса (6 м > 4,8 м), поэтому на всём
  // стропиле q(s) = A + B·s.
  const ca = Math.cos((8 * Math.PI) / 180);
  const trib = 600, g = 9.80665;
  const roof = 0.05 * (trib / 1000);
  const batten = ((50 * 50 * 1e-6 * 500 * g) / 1000 / 600) * trib;
  const self = (50 * 250 * 1e-6 * 500 * g) / 1000;
  const qDead = (1.2 * roof + 1.1 * (batten + self)) * ca;
  const snowK = 1.4 * 1.5 * (trib / 1000) * ca * ca; // Н/мм на единицу μ
  const A = qDead + snowK * mu;
  const B = (-snowK * (mu - mu1) * ca) / (b * 1000); // dμ/ds = −(μ − μ₁)·cos α / b

  // Статика балки с консолью под q(s) = A + B·s на [0, L], опоры в 0 и l:
  //   полная нагрузка W = A·L + B·L²/2, её момент относительно s = 0 — A·L²/2 + B·L³/3;
  //   R_B = момент / l, R_A = W − R_B;
  //   в пролёте Q(s) = R_A − A·s − B·s²/2 = 0 → s₀, M(s₀) = R_A·s₀ − A·s₀²/2 − B·s₀³/6;
  //   над опорой — момент нагрузки консоли относительно опоры.
  const l = 4000 / ca, c = 800 / ca, L = l + c;
  const W = A * L + (B * L * L) / 2;
  const RB = ((A * L * L) / 2 + (B * L ** 3) / 3) / l;
  const RA = W - RB;
  const s0 = (-A + Math.sqrt(A * A + 2 * B * RA)) / B;
  const Mspan = RA * s0 - (A * s0 * s0) / 2 - (B * s0 ** 3) / 6;
  const Msup = (A * c * c) / 2 + B * ((L ** 3 - l ** 3) / 3 - (l * (L * L - l * l)) / 2);

  // С мешком момент в пролёте больше, чем от равномерного снега, — мешок и определяет
  const qU = qDead + snowK;
  const MspanUniform = ((qU * (l * l - c * c)) / (2 * l)) ** 2 / (2 * qU);
  assert.ok(Mspan > MspanUniform, 'в ручном счёте мешок должен давать больший момент');

  const raf = r.rafters[5];
  assert.equal(raf.variant, 'снеговой мешок', 'определяющим выбран не мешок');
  const uls = raf.res['ULS-1'];
  close(uls.reactions[0].R, RA, FEM, 'реакция у стены');
  close(uls.reactions[1].R, RB, FEM, 'реакция на прогоне');
  close(Math.max(...uls.M), Mspan, FEM, 'момент в пролёте');
  close(Math.abs(Math.min(...uls.M)), Msup, FEM, 'момент над опорой');
});

test('крест в ряду вручную: геометрия диагонали, условная сила по (18) СП 16, растяжение', () => {
  const m = defaultModel();
  m.bracing.along = 'cross'; // крест в крайнем пролёте наружного ряда
  const r = analyse(m);
  const cross = r.cross;
  assert.ok(cross, 'крест не посчитан');

  // Условная поперечная сила, формула (18) СП 16: Q_fic = 7,15·10⁻⁶·(2330 − E/R_y)·N/φ,
  // E = 206 000 МПа, R_y = 240 МПа; φ — по гибкости вдоль ряда λ = l_ef,y / i_y
  // (п. 7.1.3, кривая «b»). Ветер вдоль стены делится между столбами поровну.
  // N здесь — без вертикальной силы самого креста (Vcross): сила креста зависит
  // от Q_fic, и программа не замыкает этот круг. Это упрощение не в запас —
  // около 1,5 % силы на крест; если его уберут, эталон нужно обновить.
  const share = r.posts[0].holdY - r.posts[0].QficY;
  for (const p of r.posts) {
    const { phi } = phiBuckling(p.lefY / p.sec.props.iy, 240, 206000);
    const N = p.N - (p.Vcross ?? 0);
    close(p.QficY, (7.15e-6 * (2330 - 206000 / 240) * N) / phi, 0.001, `Q_fic столба x = ${p.x}`);
    close(p.holdY - p.QficY, share, 1e-9, `доля ветра вдоль стены у столба x = ${p.x}`);
  }

  // Всё, что держат связи вдоль ряда, делится поровну между крестами; крест — в
  // пролёте 2000 мм, диагональ от 150 мм над базой до 150 мм под верхом столба 2500 мм.
  const F = r.posts.reduce((a, p) => a + p.holdY, 0) / cross.bays.length;
  const s = 2000, hd = 2500 - 2 * 150;
  const len = Math.hypot(s, hd);
  close(cross.F, F, 1e-9, 'сила на крест');
  close(cross.length, len, 1e-9, 'длина диагонали');
  // Узел верха в равновесии: горизонталь диагонали T·s/l = F → T = F·l/s,
  // вертикаль T·h/l = F·h/s тянет один столб вверх, другой вниз.
  close(cross.T, (F * len) / s, 1e-9, 'усилие в диагонали');
  close(cross.V, (F * hd) / s, 1e-9, 'вертикальная сила на столбы');
  // Растяжение, п. 7.1.1 СП 16: N ≤ A·R_y·γ_c
  const tension = cross.checks.find((ch) => ch.name === 'Растяжение связи');
  close(tension.limit, cross.sec.props.A * 240, 1e-9, 'A·R_y·γ_c');
  close(tension.value, cross.T, 1e-9, 'N = T');
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
  // было 84 552: у стены плита-столик 310×250 вместо 250×250 — 5 плит, +5,9 кг стали
  cost: 85258, // ₽
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
