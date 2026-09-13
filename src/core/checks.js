/**
 * Проверки несущей способности.
 * Дерево — СП 64.13330.2017, сталь — СП 16.13330.2017.
 *
 * Каждая проверка возвращает единый объект:
 *   { name, value, limit, unit, U, formula, note }
 * где U = value / limit — коэффициент использования.
 */

const chk = (name, value, limit, unit, formula, note) => ({
  name,
  value,
  limit,
  unit,
  U: limit > 0 ? value / limit : 0,
  formula,
  note,
});

/* ─────────────────────────── ДЕРЕВО ─────────────────────────── */

export function timberBending(M, W, mat) {
  return chk('Изгиб', Math.abs(M) / W, mat.Rbend, 'МПа', 'σ = M / W ≤ R_и·m_в·m_дл');
}

export function timberShear(V, sec, mat) {
  const tau = (1.5 * Math.abs(V)) / (sec.b * sec.h);
  return chk('Скалывание', tau, mat.Rshear, 'МПа', 'τ = 1,5·Q/(b·h) ≤ R_ск');
}

/**
 * Сжатие с изгибом, п. 7.17 СП 64: N/(A·R_с) + M_д/(W·R_и) ≤ 1,
 * где M_д = M/ξ, ξ = 1 − λ²·N/(3000·A·R_с).
 */
export function timberCombined(N, M, sec, mat, lambda) {
  const A = sec.b * sec.h;
  const W = (sec.b * sec.h * sec.h) / 6;
  const Rc = mat.Rcompr;
  let xi = 1 - (lambda * lambda * Math.abs(N)) / (3000 * A * Rc);
  if (xi < 0.05) xi = 0.05;
  const Md = Math.abs(M) / xi;
  const value = Math.abs(N) / (A * Rc) + Md / (W * mat.Rbend);
  return chk('Сжатие с изгибом', value, 1.0, '', 'N/(A·R_с) + M_д/(W·R_и) ≤ 1',
    `ξ = ${xi.toFixed(3)}, λ = ${lambda.toFixed(0)}`);
}

/**
 * Устойчивость плоской формы деформирования, п. 7.4.2 СП 64:
 * σ ≤ φ_м·R_и, φ_м = 140·b²·k_ф/(l_р·h).
 * l_р — расстояние между закреплениями СЖАТОЙ кромки.
 */
export function timberLateral(M, sec, mat, lr, kf = 1.75) {
  if (lr <= 0) return null;
  const W = (sec.b * sec.h * sec.h) / 6;
  const phiM = Math.min(1, (140 * sec.b * sec.b * kf) / (lr * sec.h));
  return chk('Устойчивость плоской формы', Math.abs(M) / W, phiM * mat.Rbend, 'МПа',
    'σ ≤ φ_м·R_и,  φ_м = 140·b²·k_ф/(l_р·h)',
    `φ_м = ${phiM.toFixed(2)}, l_р = ${Math.round(lr)} мм`);
}

/** Смятие поперёк волокон на опоре. */
export function timberBearing(R, sec, mat, supportLength) {
  const value = Math.abs(R) / (sec.b * supportLength);
  return chk('Смятие на опоре', value, mat.Rcm90, 'МПа', 'σ_см = R/(b·l_оп) ≤ R_см,90',
    `площадка ${supportLength} мм`);
}

/* ─────────────────────────── СТАЛЬ ─────────────────────────── */

export function steelBending(M, W, mat, c1 = 1.0) {
  return chk('Изгиб', Math.abs(M) / (c1 * W), mat.Ry * mat.gammaC, 'МПа',
    'M/W_n,min ≤ R_y·γ_c');
}

/** τ = Q·S/(I·t_w) при t_w = 2t; для замкнутого профиля равносильно Q/A_стенок. */
export function steelShear(V, props, mat) {
  const tau = Math.abs(V) / props.As;
  return chk('Срез', tau, mat.Rs * mat.gammaC, 'МПа', 'τ = Q/A_стенок ≤ R_s·γ_c');
}

/**
 * Коэффициент устойчивости при центральном сжатии, п. 7.1.3 СП 16.
 * Тип кривой «b» (гнутосварные замкнутые профили): α = 0,04, β = 0,09.
 */
export function phiBuckling(lambda, Ry, E = 206000, curve = 'b') {
  const AB = { a: [0.03, 0.06], b: [0.04, 0.09], c: [0.04, 0.14] }[curve];
  const lb = lambda * Math.sqrt(Ry / E);
  if (lb <= 0.4) return { phi: 1, lb };
  if (lb > 3.8) return { phi: 332 / (lb * lb * (51 - lb)), lb };
  const delta = 9.87 * (1 - AB[0] + AB[1] * lb) + lb * lb;
  const phi = (0.5 * (delta - Math.sqrt(delta * delta - 39.48 * lb * lb))) / (lb * lb);
  return { phi: Math.min(1, phi), lb };
}

/** Устойчивость центрально-сжатого стержня. */
export function steelStability(N, props, mat, lef, axis = 'y') {
  const i = axis === 'y' ? props.iy : props.ix;
  const lambda = lef / i;
  const { phi, lb } = phiBuckling(lambda, mat.Ry, mat.E);
  const c = chk('Устойчивость столба', Math.abs(N), phi * props.A * mat.Ry * mat.gammaC, 'Н',
    'N ≤ φ·A·R_y·γ_c', `λ = ${lambda.toFixed(0)}, λ̄ = ${lb.toFixed(2)}, φ = ${phi.toFixed(3)}`);
  c.lambda = lambda;
  c.phi = phi;
  c.lb = lb;
  return c;
}

/**
 * Сжатие с изгибом. Вместо таблицы φ_e (прил. Д.3 СП 16) используется
 * взаимодействие с усилением момента по деформированной схеме —
 * результат заведомо не менее консервативен, чем по φ_e.
 */
export function steelBeamColumn(N, M, props, mat, lef, axis = 'x') {
  const i = axis === 'x' ? props.ix : props.iy;
  const I = axis === 'x' ? props.Ix : props.Iy;
  const W = axis === 'x' ? props.Wx : props.Wy;
  const lambda = lef / i;
  const { phi } = phiBuckling(lambda, mat.Ry, mat.E);
  const Ncr = (Math.PI * Math.PI * mat.E * I) / (lef * lef);
  const amp = 1 / Math.max(0.2, 1 - Math.abs(N) / Ncr);
  const Rd = mat.Ry * mat.gammaC;
  const value = Math.abs(N) / (phi * props.A * Rd) + (Math.abs(M) * amp) / (W * Rd);
  const c = chk('Сжатие с изгибом', value, 1.0, '',
    'N/(φ·A·R_y·γ_c) + M·η/(W·R_y·γ_c) ≤ 1',
    `φ = ${phi.toFixed(3)}, η = ${amp.toFixed(2)}, N_cr = ${(Ncr / 1000).toFixed(0)} кН`);
  c.phi = phi;
  c.lambda = lambda;
  return c;
}

/** Предельная гибкость сжатого элемента: λ_u = 180 − 60α. */
export function steelSlenderness(lambda, alpha) {
  const a = Math.min(1, Math.max(0.5, alpha));
  return chk('Гибкость', lambda, 180 - 60 * a, '', 'λ ≤ 180 − 60·α', `α = ${a.toFixed(2)}`);
}

/** Местная устойчивость стенки замкнутого профиля, табл. 9 СП 16. */
export function steelLocalBuckling(sec, mat, lb = 0) {
  const bef = sec.h - 2 * (sec.t ?? 0);
  const t = sec.t ?? 1;
  const limit = Math.min(1.9, 1.2 + 0.35 * lb) * Math.sqrt(mat.E / mat.Ry);
  return chk('Местная устойчивость стенки', bef / t, limit, '',
    'b_ef/t ≤ (1,2 + 0,35·λ̄)·√(E/R_y)');
}

/* ─────────────────────── ОБЩИЕ ─────────────────────── */

/**
 * Прогибы. Предельные значения — табл. 19 СП 64 и прил. Д СП 20.
 * @param {{kind:string,f:number,limitLength:number}[]} spans
 * @param {number} ratio знаменатель: 200 для стропил и прогонов, 150 для обрешётки
 */
export function deflectionCheck(spans, ratio) {
  let worst = null;
  for (const s of spans) {
    const limit = s.limitLength / ratio;
    const c = chk('Прогиб', s.f, limit, 'мм', `f ≤ l/${ratio}`,
      `${s.kind} ${Math.round(s.x1 - s.x0)} мм${s.kind === 'консоль' ? ' (расчётная длина 2a)' : ''}`);
    if (!worst || c.U > worst.U) worst = c;
  }
  return worst;
}

/** Худшая проверка из набора и общий коэффициент использования. */
export function worstOf(checks) {
  const list = checks.filter(Boolean);
  const U = list.reduce((m, c) => Math.max(m, c.U), 0);
  const worst = list.find((c) => c.U === U) ?? null;
  return { checks: list, U, worst };
}
