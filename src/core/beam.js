/**
 * Балочный решатель: МКЭ, элемент Тимошенко (учитывает сдвиговые деформации).
 *
 * Система координат: x вдоль оси балки, прогиб v и нагрузки — положительные вниз.
 * Единицы: мм, Н, Н/мм, МПа, мм⁴.
 *
 * Опоры — шарнирные (v = 0), число и положение произвольные, консоли с любой стороны.
 * Эпюры M и Q считаются статикой по найденным реакциям, а не по узловым усилиям МКЭ,
 * поэтому не зависят от густоты сетки.
 *
 * Стыки по длине задаются через hinges: в таком узле прогиб общий, а поворот нет —
 * момент через стык не передаётся. Реализовано статической конденсацией поворота
 * у правого от стыка элемента: узловой поворот остаётся за левым элементом, правый
 * получает шарнирное примыкание. Это точно, а не приближённо, и не ломает ленточную
 * структуру матрицы.
 */

/** Симметричная ленточная матрица: хранится верхняя лента. */
function bandedSolve(n, bw, band, f) {
  const A = band;
  const idx = (i, j) => i * (bw + 1) + (j - i);
  // LDL^T
  for (let i = 0; i < n; i++) {
    for (let j = i; j <= Math.min(i + bw, n - 1); j++) {
      let s = A[idx(i, j)];
      for (let k = Math.max(0, i - bw, j - bw); k < i; k++) {
        s -= A[idx(k, i)] * A[idx(k, j)] * A[idx(k, k)];
      }
      if (i === j) A[idx(i, i)] = s;
      else A[idx(i, j)] = s / A[idx(i, i)];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = f[i];
    for (let k = Math.max(0, i - bw); k < i; k++) s -= A[idx(k, i)] * A[idx(k, k)] * y[k];
    y[i] = s / A[idx(i, i)];
  }
  const u = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k <= Math.min(i + bw, n - 1); k++) s -= A[idx(i, k)] * u[k];
    u[i] = s;
  }
  return u;
}

function elementStiffness(Le, EI, GAs) {
  const phi = GAs > 0 ? (12 * EI) / (GAs * Le * Le) : 0;
  const c = EI / (Le * Le * Le * (1 + phi));
  const L = Le;
  return [
    [12 * c, 6 * L * c, -12 * c, 6 * L * c],
    [6 * L * c, (4 + phi) * L * L * c, -6 * L * c, (2 - phi) * L * L * c],
    [-12 * c, -6 * L * c, 12 * c, -6 * L * c],
    [6 * L * c, (2 - phi) * L * L * c, -6 * L * c, (4 + phi) * L * L * c],
  ];
}

/**
 * Шарнирное примыкание конца элемента: поворот r исключается статической
 * конденсацией из матрицы жёсткости и из вектора нагрузки элемента.
 * Строка и столбец r обнуляются — этот поворот больше не общий с соседом.
 */
function releaseEnd(k, fe, r) {
  const krr = k[r][r];
  if (!(Math.abs(krr) > 0)) return { k, fe };
  const k2 = k.map((row) => row.slice());
  const f2 = fe.slice();
  for (let a = 0; a < 4; a++) {
    if (a === r) continue;
    f2[a] = fe[a] - (k[a][r] * fe[r]) / krr;
    for (let b = 0; b < 4; b++) {
      if (b === r) continue;
      k2[a][b] = k[a][b] - (k[a][r] * k[r][b]) / krr;
    }
  }
  for (let i = 0; i < 4; i++) { k2[r][i] = 0; k2[i][r] = 0; }
  f2[r] = 0;
  return { k: k2, fe: f2 };
}

/**
 * Поворот, исключённый конденсацией, — восстанавливается по решению,
 * иначе прогиб справа от стыка интерполируется по чужому повороту.
 */
function recoverRotation(k0, fe0, r, ue) {
  let s = fe0[r];
  for (let b = 0; b < 4; b++) if (b !== r) s -= k0[r][b] * ue[b];
  return s / k0[r][r];
}

/**
 * @param {object} o
 * @param {number} o.length длина балки, мм
 * @param {number[]} o.supports координаты шарнирных опор, мм
 * @param {number} o.EI жёсткость на изгиб, Н·мм²
 * @param {number} o.GAs сдвиговая жёсткость, Н (0 — не учитывать сдвиг)
 * @param {(x:number)=>number} [o.q] распределённая нагрузка, Н/мм, вниз
 * @param {{x:number,P:number}[]} [o.point] сосредоточенные силы, Н, вниз
 * @param {{x:number,M:number}[]} [o.moments] сосредоточенные моменты, Н·мм
 * @param {number[]} [o.hinges] стыки по длине: координаты, где момент не передаётся
 * @param {number} [o.nEl] минимальное число конечных элементов
 */
export function solveBeam(o) {
  const { length, EI, GAs = 0 } = o;
  const q = o.q ?? (() => 0);
  const point = o.point ?? [];
  const moments = o.moments ?? [];
  const nEl = o.nEl ?? 120;

  // --- сетка: равномерная плюс узлы в опорах и под силами
  const set = new Set([0, length]);
  for (let i = 1; i < nEl; i++) set.add((length * i) / nEl);
  for (const s of o.supports) set.add(Math.min(length, Math.max(0, s)));
  for (const p of point) set.add(Math.min(length, Math.max(0, p.x)));
  for (const p of moments) set.add(Math.min(length, Math.max(0, p.x)));
  for (const h of o.hinges ?? []) if (h > 0 && h < length) set.add(h);
  const X = [...set].sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 1e-6);
  const nn = X.length;
  const ndof = 2 * nn;
  const bw = 3;

  const band = new Float64Array(ndof * (bw + 1));
  const F = new Float64Array(ndof);
  const idx = (i, j) => i * (bw + 1) + (j - i);
  const elems = [];

  // стык рвёт непрерывность поворота: узловой поворот оставляем левому элементу,
  // правый примыкает шарнирно. Концы балки пропускаем — рвать там нечего
  const released = new Set();
  for (const h of o.hinges ?? []) {
    let n = -1;
    for (let i = 1; i < nn - 1; i++) if (n < 0 || Math.abs(X[i] - h) < Math.abs(X[n] - h)) n = i;
    if (n > 0 && Math.abs(X[n] - h) < 1e-6) released.add(n);
  }

  for (let e = 0; e < nn - 1; e++) {
    const Le = X[e + 1] - X[e];
    const k0 = elementStiffness(Le, EI, GAs);
    const dofs = [2 * e, 2 * e + 1, 2 * e + 2, 2 * e + 3];
    // распределённая нагрузка: интегрируем q по элементу (3 точки Симпсона)
    const wm = (q(X[e]) + 4 * q(X[e] + Le / 2) + q(X[e + 1])) / 6;
    const fe0 = [(wm * Le) / 2, (wm * Le * Le) / 12, (wm * Le) / 2, -(wm * Le * Le) / 12];
    const rel = released.has(e) ? 1 : -1; // шарнир в левом узле этого элемента
    const { k, fe } = rel >= 0 ? releaseEnd(k0, fe0, rel) : { k: k0, fe: fe0 };
    elems.push({ k, dofs, Le, x0: X[e], rel, k0, fe0 });
    for (let a = 0; a < 4; a++) {
      for (let b = a; b < 4; b++) {
        const i = dofs[a], j = dofs[b];
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        band[idx(lo, hi)] += k[a][b];
      }
    }
    for (let a = 0; a < 4; a++) F[dofs[a]] += fe[a];
  }
  const Fload = Float64Array.from(F);
  for (const p of point) {
    let n = 0;
    for (let i = 0; i < nn; i++) if (Math.abs(X[i] - p.x) < Math.abs(X[n] - p.x)) n = i;
    F[2 * n] += p.P;
    Fload[2 * n] += p.P;
  }

  // --- закрепления: v = 0
  for (const p of moments) {
    let n = 0;
    for (let i = 0; i < nn; i++) if (Math.abs(X[i] - p.x) < Math.abs(X[n] - p.x)) n = i;
    F[2 * n + 1] += p.M;
    Fload[2 * n + 1] += p.M;
  }

  const fixed = [];
  for (const s of o.supports) {
    let n = 0;
    for (let i = 0; i < nn; i++) if (Math.abs(X[i] - s) < Math.abs(X[n] - s)) n = i;
    fixed.push({ node: n, dof: 2 * n, x: X[n] });
  }
  for (const fx of fixed) {
    const d = fx.dof;
    for (let j = Math.max(0, d - bw); j <= Math.min(ndof - 1, d + bw); j++) {
      if (j < d) band[idx(j, d)] = 0;
      else if (j > d) band[idx(d, j)] = 0;
    }
    band[idx(d, d)] = 1;
    F[d] = 0;
  }

  const u = bandedSolve(ndof, bw, band, F);

  // --- реакции
  const KU = new Float64Array(ndof);
  for (const el of elems) {
    for (let a = 0; a < 4; a++) {
      let s = 0;
      for (let b = 0; b < 4; b++) s += el.k[a][b] * u[el.dofs[b]];
      KU[el.dofs[a]] += s;
    }
  }
  // R > 0 — усилие, которое балка передаёт на опору (реакция направлена вверх)
  const reactions = fixed.map((fx) => ({ x: fx.x, R: Fload[fx.dof] - KU[fx.dof] }));

  // --- эпюры статикой
  const nSample = 401;
  const xs = new Float64Array(nSample);
  const V = new Float64Array(nSample);
  const M = new Float64Array(nSample);
  const dx = length / (nSample - 1);
  // I0 = ∫q dt, I1 = ∫q·t dt — момент считается точной статикой,
  // а не интегрированием эпюры Q (иначе скачки в опорах дают ошибку ~ΔR·dx/2)
  let I0 = 0, I1 = 0;
  for (let i = 0; i < nSample; i++) {
    const x = i * dx;
    xs[i] = x;
    if (i > 0) {
      const xa = x - dx, xm = xa + dx / 2;
      I0 += ((q(xa) + 4 * q(xm) + q(x)) / 6) * dx;
      I1 += ((q(xa) * xa + 4 * q(xm) * xm + q(x) * x) / 6) * dx;
    }
    let v = -I0;
    let m = -(x * I0 - I1);
    for (const r of reactions) if (r.x <= x + 1e-9) { v += r.R; m += r.R * (x - r.x); }
    for (const p of point) if (p.x <= x + 1e-9) { v -= p.P; m -= p.P * (x - p.x); }
    for (const p of moments) if (p.x <= x + 1e-9) m += p.M;
    V[i] = v;
    M[i] = m;
  }

  // --- прогибы: интерполяция узловых значений на ту же сетку
  const w = new Float64Array(nSample);
  let n0 = 0;
  for (let i = 0; i < nSample; i++) {
    const x = xs[i];
    while (n0 < nn - 2 && X[n0 + 1] < x) n0++;
    const xa = X[n0], xb = X[n0 + 1];
    const t = (x - xa) / (xb - xa);
    const el = elems[n0];
    const ue = [u[2 * n0], u[2 * n0 + 1], u[2 * n0 + 2], u[2 * n0 + 3]];
    const va = ue[0], vb = ue[2], tb = ue[3];
    const ta = el.rel === 1 ? recoverRotation(el.k0, el.fe0, 1, ue) : ue[1];
    const Le = xb - xa;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
    w[i] = h00 * va + h10 * Le * ta + h01 * vb + h11 * Le * tb;
  }

  let maxM = 0, maxV = 0;
  for (let i = 0; i < nSample; i++) {
    if (Math.abs(M[i]) > Math.abs(maxM)) maxM = M[i];
    if (Math.abs(V[i]) > Math.abs(maxV)) maxV = V[i];
  }

  return { x: xs, V, M, w, reactions, maxM, maxV, nodes: X, u };
}

/**
 * Максимальные прогибы по участкам: между соседними опорами и на консолях.
 * @returns {{spans:{x0:number,x1:number,f:number,limitLength:number}[]}}
 */
export function deflectionSpans(res, length, supports) {
  const sup = [...supports].sort((a, b) => a - b);
  const spans = [];
  const pick = (x0, x1) => {
    let f = 0;
    for (let i = 0; i < res.x.length; i++) {
      const x = res.x[i];
      if (x < x0 - 1e-6 || x > x1 + 1e-6) continue;
      if (Math.abs(res.w[i]) > Math.abs(f)) f = res.w[i];
    }
    return f;
  };
  if (sup.length && sup[0] > 1) spans.push({ kind: 'консоль', x0: 0, x1: sup[0], f: Math.abs(pick(0, sup[0])), limitLength: 2 * sup[0] });
  for (let i = 0; i + 1 < sup.length; i++) {
    spans.push({ kind: 'пролёт', x0: sup[i], x1: sup[i + 1], f: Math.abs(pick(sup[i], sup[i + 1])), limitLength: sup[i + 1] - sup[i] });
  }
  const last = sup[sup.length - 1];
  if (last !== undefined && length - last > 1) {
    spans.push({ kind: 'консоль', x0: last, x1: length, f: Math.abs(pick(last, length)), limitLength: 2 * (length - last) });
  }
  return { spans };
}
