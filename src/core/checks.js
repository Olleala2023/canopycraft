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

/**
 * Сжатие с изгибом в двух плоскостях — у наружного столба, когда вдоль стены
 * связей нет: поперёк ряда момент от эксцентриситета опирания, вдоль — от
 * ветра на консоль. Моменты складываются линейно, φ берётся по худшей
 * плоскости — это верхняя оценка по отношению к формулам СП 16 для
 * двухосного изгиба, в запас.
 */
export function steelBeamColumn2(N, Mx, My, props, mat, lefX, lefY) {
  const Rd = mat.Ry * mat.gammaC;
  const plane = (lef, i, I) => {
    const { phi } = phiBuckling(lef / i, mat.Ry, mat.E);
    const Ncr = (Math.PI * Math.PI * mat.E * I) / (lef * lef);
    return { phi, amp: 1 / Math.max(0.2, 1 - Math.abs(N) / Ncr) };
  };
  const x = plane(lefX, props.ix, props.Ix);
  const y = plane(lefY, props.iy, props.Iy);
  const phi = Math.min(x.phi, y.phi);
  const value = Math.abs(N) / (phi * props.A * Rd)
    + (Math.abs(Mx) * x.amp) / (props.Wx * Rd) + (Math.abs(My) * y.amp) / (props.Wy * Rd);
  const c = chk('Сжатие с изгибом', value, 1.0, '',
    'N/(φ·A·R_y·γ_c) + M_x·η_x/(W_x·R_y·γ_c) + M_y·η_y/(W_y·R_y·γ_c) ≤ 1',
    `изгиб в двух плоскостях, φ = ${phi.toFixed(3)} по худшей, η_x = ${x.amp.toFixed(2)}, η_y = ${y.amp.toFixed(2)}`);
  c.phi = phi;
  return c;
}

/**
 * Условная поперечная сила в сжатом стержне, Н — формула (18) СП 16:
 *   Q_fic = 7,15·10⁻⁶·(2330 − E/R_y)·N/φ.
 * На неё считают связи, которые уменьшают расчётную длину сжатых стержней
 * (правило СНиП II-23-81* п. 5.8*, перенесённое в СП 16): чтобы удержать
 * столб от выпучивания, связь должна что-то держать, даже когда ветра нет.
 * φ — в той плоскости, которую связь раскрепляет.
 */
export function qFic(N, phi, mat) {
  return 7.15e-6 * (2330 - mat.E / mat.Ry) * Math.max(0, N) / Math.max(1e-6, phi);
}

/** Растяжение диагонали связи: N ≤ A·R_y·γ_c. */
export function braceTension(N, A, mat, note) {
  return chk('Растяжение связи', Math.abs(N), A * mat.Ry * mat.gammaC, 'Н', 'N ≤ A·R_y·γ_c', note);
}

/**
 * Предельная гибкость растянутой связи: 400 (СП 16, табл. 33). Слишком
 * тонкая диагональ провисает и болтается — держать она начинает, только
 * когда верх уже уехал.
 */
export function braceSlenderness(lambda, note) {
  return chk('Гибкость связи', lambda, 400, '', 'λ ≤ 400 для растянутых связей — табл. 33 СП 16', note);
}

/**
 * Изгиб балки из своей плоскости горизонтальными силами — у обвязки у стены
 * это распор, который приносят стропила: через них держится верх наружного
 * ряда и ветер на кровлю.
 */
export function lateralBending(M, W, R, note) {
  return chk('Изгиб из плоскости от распора', Math.abs(M) / W, R, 'МПа', 'σ = M_y/W_y ≤ R', note);
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

/**
 * Геометрически изменяемая схема: кусок между стыками встык лежит меньше чем
 * на двух опорах. Стык встык не передаёт ни момента, ни поперечной силы, и
 * такой кусок поворачивается вокруг единственной опоры (или падает, если опор
 * нет). Это строительная механика, а не пункт норм: прочность здесь проверять
 * не на чем, и никакое сечение схему не спасает.
 *
 * value — число таких кусков, предел — ноль, U = value / 0 = ∞. Бесконечность
 * явная (а не NaN от испорченных данных): интерфейс по ней пишет «изменяемая
 * схема», а не «расчёт не сошёлся».
 *
 * @param {{x0:number,x1:number,supports:number}[]} loose куски меньше чем на двух опорах
 */
export function mechanismCheck(loose) {
  const mm = (x) => Math.round(x);
  return {
    name: 'Изменяемая схема',
    value: loose.length,
    limit: 0,
    unit: 'шт',
    U: Infinity,
    formula: 'каждый кусок между стыками встык — не меньше чем на двух опорах',
    note: `${loose.map((c) => `кусок ${mm(c.x0)}–${mm(c.x1)} мм, опор: ${c.supports}`).join('; ')}`
      + ' — такой кусок поворачивается вокруг опоры, удержать его нечему',
  };
}

/**
 * Худшая проверка из набора и общий коэффициент использования.
 * Нечисловой U (испорченные исходные данные) считается бесконечным:
 * такой результат должен бросаться в глаза, а не прятаться за нулём.
 */
export function worstOf(checks) {
  const list = checks.filter(Boolean);
  let worst = null;
  let U = 0;
  for (const c of list) {
    const u = Number.isFinite(c.U) ? c.U : Infinity;
    if (worst === null || u > U) { worst = c; U = u; }
  }
  return { checks: list, U, worst };
}

/* ───────────── КРЕПЛЕНИЕ К ГАЗОБЕТОННОЙ СТЕНЕ ───────────── */

/**
 * Расчётное сопротивление сжатию кладки из ячеистобетонных блоков на клею, МПа.
 * Ориентир по СП 15.13330; уточняется по данным производителя блоков.
 */
export const AERATED_R = { 'B2.0': 0.85, 'B2.5': 1.0, 'B3.5': 1.3, 'B5.0': 1.7 };

/** Смятие газоблока под шайбой сквозной шпильки (растяжение от стены). */
export function boltPlateBearing(N, plateSize, boltD, blockClass) {
  const R = AERATED_R[blockClass] ?? 1.0;
  const area = plateSize * plateSize - (Math.PI * boltD * boltD) / 4;
  return chk('Смятие газоблока под шайбой', Math.abs(N) / area, R * 1.2, 'МПа',
    'σ = N/A_шайбы ≤ 1,2·R_кладки',
    `шайба ${plateSize}×${plateSize} мм, блок ${blockClass} → R = ${R} МПа`);
}

/** Смятие газоблока стенкой отверстия от поперечной силы на шпильку. */
export function boltHoleBearing(V, boltD, wallThickness, blockClass) {
  const R = AERATED_R[blockClass] ?? 1.0;
  return chk('Смятие газоблока в отверстии', Math.abs(V) / (boltD * wallThickness), R * 1.2, 'МПа',
    'σ = Q/(d·t_стены) ≤ 1,2·R_кладки',
    `М${boltD} через стену ${wallThickness} мм`);
}

/* ─────────────────────── БАЗА СТОЛБА ─────────────────────── */

/** Смятие бетона под опорной плитой при внецентренном сжатии. */
export function concreteBearing(sigma, Rb, note) {
  return chk('Смятие бетона под плитой', sigma, Rb, 'МПа', 'σ = N/A + M/W ≤ R_b', note);
}

/** Изгиб опорной плиты: консольный вылет за гранью столба под отпором бетона. */
export function plateBending(sigma, Ry, note) {
  return chk('Изгиб опорной плиты', sigma, Ry, 'МПа', 'σ = 6·M/t² ≤ R_y, M = σ_б·c²/2', note);
}

/** Вырыв конуса бетона анкером: проекция конуса под 45°. */
export function anchorCone(N, hef, Rbt, note) {
  const area = Math.PI * hef * hef;
  return chk('Вырыв конуса бетона', Math.abs(N), Rbt * area, 'Н',
    'N ≤ R_bt·π·h_ef²', note);
}

/** Заделка забетонированного столба: конструктивный минимум. */
export function embedDepth(h, need, note) {
  return chk('Глубина заделки', need, h, 'мм', 'h ≥ 10·h_сечения — иначе защемления нет', note);
}

/** Подошва блока ниже расчётной глубины промерзания — для пучинистых грунтов. */
export function foundationFrost(df, depth, note) {
  return chk('Подошва ниже промерзания', df, depth, 'мм',
    'd ≥ d_f = k_h·d_fn, k_h = 1,1 — СП 22 п. 5.5', note);
}

/** Масса фундамента против отрыва: удерживает только вес, с коэффициентом 0,9. */
/**
 * Устойчивость фундамента против касательных сил морозного пучения —
 * формула (6.35) СП 22: τ_fh·A_fh − F ≤ (γ_c/γ_n)·F_rf. Записана как
 * сравнение сил: то, что тянет вверх, против того, что держит, — тогда U
 * читается как во всех остальных проверках.
 */
export function frostHeave(pull, F, Frf, gcgn, note) {
  return chk('Касательные силы пучения', pull, F + gcgn * Frf, 'Н',
    'τ_fh·A_fh ≤ F + (γ_c/γ_n)·F_rf — СП 22, ф. (6.35)', note);
}

export function anchorMass(uplift, mass, note) {
  return chk('Вес фундамента против отрыва', Math.abs(uplift), 0.9 * mass * 9.80665, 'Н',
    'N_отр ≤ 0,9·m·g', note);
}

/* ─────────────────── УЗЕЛ «ПРОГОН — СТОЛБ» ─────────────────── */

/** Угловой шов по металлу шва, СП 16 ф. (176): τ ≤ R_wf·γ_wf·γ_c. */
export function weldMetal(tau, Rwf, note) {
  return chk('Шов по металлу шва', tau, Rwf, 'МПа', 'τ = N/(β_f·k_f·l_ш) ≤ R_wf·γ_wf·γ_c', note);
}

/** Угловой шов по металлу границы сплавления, R_wz = 0,45·R_un. */
export function weldFusion(tau, Run, note) {
  return chk('Шов по границе сплавления', tau, 0.45 * Run, 'МПа',
    'τ = N/(β_z·k_f·l_ш) ≤ R_wz·γ_wz·γ_c', note);
}

/** Катет шва: не меньше минимального по табл. 38 и не больше 1,2·t тонкого элемента. */
export function weldLeg(kf, kfMin, kfMax, note) {
  const value = kf < kfMin ? kfMin / kf : kf / kfMax;
  return chk('Катет шва', value, 1, '',
    `${kfMin} ≤ k_f ≤ 1,2·t_min = ${kfMax.toFixed(1).replace(".", ",")} мм`, note);
}

/** Растяжение болта, СП 16 ф. (188): N ≤ R_bt·A_bn. */
export function boltTension(N, Rbt, Abn, note) {
  return chk('Болт на растяжение', Math.abs(N), Rbt * Abn, 'Н', 'N ≤ R_bt·A_bn', note);
}

/** Смятие древесины поперёк волокон под шайбой. */
export function timberWasherBearing(N, side, boltD, mat, note) {
  const area = side * side - (Math.PI * boltD * boltD) / 4;
  return chk('Смятие древесины под шайбой', Math.abs(N) / area, mat.Rcm90, 'МПа',
    'σ = N/A_шайбы ≤ R_см90', note);
}

/* ─────────────────── СТЫК БАЛКИ ПО ДЛИНЕ ─────────────────── */

/** Равнодействующая на самый нагруженный нагель группы стыка. */
export function spliceDowel(force, T, note) {
  return chk('Нагель стыка на срез', Math.abs(force), T, 'Н',
    'N_max ≤ T — двухсрезное соединение, табл. 20 СП 64', note);
}

/** Накладка на изгиб: пара накладок делит момент сечения пополам. */
export function splicePlateBending(M, t, h, R, note) {
  return chk('Изгиб накладки', (3 * Math.abs(M)) / (t * h * h), R, 'МПа',
    'σ = (M/2)/(t·h²/6) ≤ R — по половине момента на каждую накладку', note);
}

/* ─────────────────── УЗЕЛ КРЕПЛЕНИЯ СТРОПИЛА ─────────────────── */

/**
 * Срез группы крепежей в узле: усилие делится на все крепежи поровну.
 * @param {number} force равнодействующая на узел, Н
 * @param {number} n число крепежей
 * @param {number} T несущая способность одного на один шов, Н
 */
export function tieShear(force, n, T, note) {
  return chk('Крепёж на срез', Math.abs(force), n * T, 'Н',
    'N ≤ n·T, T — табл. 20 СП 64', note);
}

/**
 * Требуемое число крепежей против того, что помещается по правилам
 * расстановки. Если не помещается — узел не собрать, нужен другой крепёж.
 */
export function tieFit(need, fit, note) {
  return chk('Крепёж помещается в узле', need, fit, 'шт',
    'n_треб ≤ n_мест при S1, S2, S3 по разд. 8 СП 64', note);
}

/** Смятие стенки стального профиля крепежом. R_bp = 1,35·R_un (СП 16, табл. Г.5). */
export function steelHoleBearing(N, d, t, mat, note) {
  return chk('Смятие стенки профиля', Math.abs(N) / (d * t), 1.35 * mat.Run, 'МПа',
    'σ = N/(d·t) ≤ R_bp', note);
}

/** Срез шпильки. R_bs = 0,4·R_bun (СП 16, табл. Д.5): класс 5.8 → 200 МПа, 8.8 → 320 МПа. */
export function boltShear(V, boltD, grade = '5.8', planes = 1) {
  const Rbs = { '4.8': 160, '5.8': 200, '8.8': 320 }[grade] ?? 200;
  const As = { 10: 58, 12: 84.3, 16: 157, 20: 245, 24: 353 }[boltD] ?? (Math.PI * boltD * boltD) / 4 * 0.78;
  return chk('Срез шпильки', Math.abs(V) / (As * planes), Rbs, 'МПа',
    'τ = Q/A_ш ≤ R_bs', `М${boltD} класса ${grade}, A_нетто = ${As} мм²`);
}
