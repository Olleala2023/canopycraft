import test from 'node:test';
import assert from 'node:assert/strict';
import { solveBeam, deflectionSpans } from '../src/core/beam.js';

const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: ${a} ≠ ${b}`);

test('однопролётная шарнирная балка под равномерной нагрузкой', () => {
  const L = 4000, w = 2.0, EI = 10000 * (50 * 200 ** 3) / 12;
  const r = solveBeam({ length: L, supports: [0, L], EI, GAs: 0, q: () => w });
  close(r.maxM, (w * L * L) / 8, 1e-3, 'M = wL²/8');
  close(r.reactions[0].R, (w * L) / 2, 1e-3, 'R = wL/2');
  const f = deflectionSpans(r, L, [0, L]).spans[0].f;
  close(f, (5 * w * L ** 4) / (384 * EI), 5e-3, 'f = 5wL⁴/384EI');
});

/** Индекс точки эпюры, ближайшей к x: сетка вывода неравномерная (см. solveBeam). */
const nearest = (r, x) => r.x.reduce((best, xi, i) => (Math.abs(xi - x) < Math.abs(r.x[best] - x) ? i : best), 0);

test('консоль под равномерной нагрузкой (балка с вылетом)', () => {
  const L = 3000, a = 1000, w = 1.5;
  const EI = 10000 * (50 * 200 ** 3) / 12;
  const r = solveBeam({ length: L + a, supports: [0, L], EI, q: () => w });
  const Mend = r.M[r.M.length - 1];
  assert.ok(Math.abs(Mend) < 1e-3 * (w * a * a) / 2, `момент на свободном конце: ${Mend}`);
  close(r.M[nearest(r, L)], -(w * a * a) / 2, 5e-3, 'опорный момент −wa²/2');
});

test('сосредоточенная сила посередине пролёта', () => {
  const L = 5000, P = 3000, EI = 206000 * 4.36e6;
  const r = solveBeam({ length: L, supports: [0, L], EI, point: [{ x: L / 2, P }] });
  close(r.maxM, (P * L) / 4, 5e-3, 'M = PL/4');
  const f = deflectionSpans(r, L, [0, L]).spans[0].f;
  close(f, (P * L ** 3) / (48 * EI), 1e-2, 'f = PL³/48EI');
});

test('двухпролётная неразрезная балка', () => {
  const L = 3000, w = 2.0, EI = 10000 * (50 * 200 ** 3) / 12;
  const r = solveBeam({ length: 2 * L, supports: [0, L, 2 * L], EI, q: () => w });
  close(r.M[nearest(r, L)], -(w * L * L) / 8, 1e-2, 'момент над средней опорой −wL²/8');
  close(r.reactions[1].R, 1.25 * w * L, 1e-2, 'реакция средней опоры 1,25wL');
});

test('сдвиговые деформации увеличивают прогиб короткой деревянной балки', () => {
  const L = 1500, w = 3.0, b = 50, h = 200;
  const EI = 10000 * (b * h ** 3) / 12;
  const GAs = 500 * (5 / 6) * b * h;
  const noShear = solveBeam({ length: L, supports: [0, L], EI, GAs: 0, q: () => w });
  const withShear = solveBeam({ length: L, supports: [0, L], EI, GAs, q: () => w });
  const f0 = deflectionSpans(noShear, L, [0, L]).spans[0].f;
  const f1 = deflectionSpans(withShear, L, [0, L]).spans[0].f;
  assert.ok(f1 > f0 * 1.15, `сдвиг должен заметно добавлять прогиб: ${f0} → ${f1}`);
  // сравнение с формулой (50) СП 64: f = f₀·[1 + c·(h/l)²], c = 15,4 (E/G = 20)
  close(f1 / f0, 1 + 15.4 * (h / L) ** 2, 0.1, 'соответствие формуле (50) СП 64');
});

test('сосредоточенный момент на конце балки', () => {
  const L = 4000, M0 = 2.5e6, EI = 206000 * 4.36e6;
  const r = solveBeam({ length: L, supports: [0, L], EI, moments: [{ x: 0, M: M0 }] });
  close(r.M[0], M0, 5e-3, 'M на нагруженном конце');
  assert.ok(Math.abs(r.M[r.M.length - 1]) < 1e-6 * M0, `M на дальней опоре: ${r.M[r.M.length - 1]}`);
  const mid = r.M[Math.round((r.M.length - 1) / 2)];
  close(mid, M0 / 2, 1e-2, 'момент убывает линейно');
  close(r.reactions[0].R, -M0 / L, 5e-3, 'реакция −M/L');
  assert.ok(Math.abs(r.reactions[0].R + r.reactions[1].R) < 1e-6 * (M0 / L), 'сумма вертикальных реакций нулевая');
});

test('пик момента над опорой не проскакивает между точками эпюры', () => {
  // опора не попадает на равномерную сетку 1/400 длины: раньше максимум
  // |M| брался в соседней точке и занижал опорный момент на V·dx/2
  const l = 4039.31, c = 807.86, w = 1.3, EI = 10000 * (50 * 250 ** 3) / 12;
  const r = solveBeam({ length: l + c, supports: [0, l], EI, q: () => w });
  const Msup = (w * c * c) / 2;
  close(Math.abs(Math.min(...r.M)), Msup, 1e-4, 'момент над опорой wc²/2');
  // наибольшая |Q| — вплотную слева от опоры, до скачка на реакцию: w·l − R_A
  const RA = (w * (l * l - c * c)) / (2 * l);
  close(Math.max(...r.V.map(Math.abs)), Math.max(RA, w * l - RA, w * c), 1e-4, 'наибольшая Q у опоры, слева от скачка');
});
