/**
 * Сборка расчёта: передача нагрузок по цепочке и проверки всех элементов.
 *
 * кровля → обрешётка → стропила → { прогон | брус у стены } → столбы → фундамент
 *
 * Единицы: мм, Н, Н/мм (= кН/м), МПа, кПа.
 */
import { section, DENSITY } from './sections.js';
import { propsFor } from './materials.js';
import { ROOFING, snowProfile, windPressure, GAMMA_F } from './loads.js';
import { solveBeam, deflectionSpans } from './beam.js';
import { tributaries, levels, boltHeights, splicePlan } from './model.js';
import {
  timberBending, timberShear, timberCombined, timberLateral, timberBearing,
  steelBending, steelShear, steelStability, steelBeamColumn, steelSlenderness,
  steelLocalBuckling, deflectionCheck, worstOf,
  boltPlateBearing, boltHoleBearing, boltShear,
  tieShear, tieFit, steelHoleBearing,
  weldMetal, weldFusion, weldLeg, boltTension, timberWasherBearing,
  concreteBearing, plateBending, anchorCone, embedDepth, anchorMass, foundationFrost,
  spliceDowel,
  splicePlateBending,
} from './checks.js';
import {
  fastener, shearCapacity, fitCount, spacingRules, fastenerMass, ANGLE_MASS, SELF_DRILL_D,
  beamTie, weldLine, weldMinLeg, WELD, BOLT_RT, BOLT_AN, WASHER_SIDE,
  postBase, anchorSpan, minEmbed, CONCRETE, CONCRETE_DENSITY,
  dowelDouble,
  SPLICE_PLATES,
  SPLICE_DOWELS,
  SPLICE_GAP,
  frostDepth,
} from './fasteners.js';

const deg = (d) => (d * Math.PI) / 180;
/** Ускорение свободного падения, м/с² — вес бетона против отрыва. */
const G0 = 9.80665;

/** Жёсткости сечения для решателя. */
function stiffness(sec, mat) {
  const p = sec.props;
  return { EI: mat.E * p.Ix, GAs: mat.G * p.As };
}

/** Собственный вес кровельного «пирога» без стропил, кН/м² по скату. */
function roofDead(model) {
  const roof = ROOFING[model.roofing];
  const batten = section(model.battens.sectionId);
  const gBatten = (batten.weight * 1000) / model.battens.spacing; // кН/м / мм → кН/м²
  return { roof: roof.g, batten: gBatten, total: roof.g + gBatten, def: roof };
}

/* ───────────────────────── СТРОПИЛА ───────────────────────── */

function analyseRafter(model, x, trib, ctx) {
  const { geom } = model;
  const sec = section(model.rafters.sectionId);
  const mat = propsFor(sec, model.opts);
  const { EI, GAs } = stiffness(sec, mat);
  const al = deg(geom.alpha), ca = Math.cos(al), sa = Math.sin(al);

  const Ls = (geom.L + geom.a) / ca;      // полная длина по скату
  const xSup = geom.L / ca;               // опора на прогон
  const supports = [0, xSup];
  const gammaDead = sec.material === 'timber' ? GAMMA_F.timber : GAMMA_F.steel;

  // погонные нагрузки, Н/мм, перпендикулярно скату
  const lineRoofN = (ctx.dead.roof * trib) / 1000;
  const lineBattenN = (ctx.dead.batten * trib) / 1000;
  const lineSelfN = sec.weight;
  const deadPerpN = (lineRoofN + lineBattenN + lineSelfN) * ca;
  const deadPerpD = (GAMMA_F.roofing * lineRoofN + gammaDead * (lineBattenN + lineSelfN)) * ca;

  const windUpPerp = (ctx.wind.up * trib) / 1000;
  const windDownPerp = (ctx.wind.down * trib) / 1000;

  // Схема Б.8 требует считать нижнее покрытие в двух вариантах — равномерном
  // и со снеговым мешком. За расчётное принимается худшее из них, причём
  // поэлементно: у стены правит мешок, в дальней части — равномерный снег.
  const hinges = spliceHinges(model, Ls, supports);
  const solve = (q) => solveBeam({ length: Ls, supports, EI, GAs, q, hinges, nEl: 120 });
  const byVariant = ctx.snow.variants.map((v) => {
    const snowAt = (xs) => (v.at(xs * ca) * trib) / 1000 * ca * ca;
    return {
      variant: v,
      'ULS-1': solve((xs) => deadPerpD + GAMMA_F.snow * snowAt(xs)),
      'ULS-2': solve((xs) => deadPerpD + GAMMA_F.snow * snowAt(xs) + 0.9 * windDownPerp),
      SLS: solve((xs) => deadPerpN + snowAt(xs)),
    };
  });
  const uplift = solve(() => GAMMA_F.relieving * deadPerpN - windUpPerp);

  // определяющий вариант — тот, где больше момент в пролёте
  const peak = (r) => r.M.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const lead = byVariant.reduce((a, b) => (peak(b['ULS-1']) > peak(a['ULS-1']) ? b : a));
  const res = { 'ULS-1': lead['ULS-1'], 'ULS-2': lead['ULS-2'], 'ULS-3': uplift, SLS: lead.SLS };

  // огибающая по всем вариантам и сочетаниям
  let Mmax = 0, Vmax = 0, Mcant = 0;
  const iSup = Math.round((xSup / Ls) * (uplift.x.length - 1));
  const envelope = byVariant.flatMap((g) => [g['ULS-1'], g['ULS-2']]).concat([uplift]);
  for (const r of envelope) {
    for (let i = 0; i < r.M.length; i++) {
      if (Math.abs(r.M[i]) > Math.abs(Mmax)) Mmax = r.M[i];
      if (Math.abs(r.V[i]) > Math.abs(Vmax)) Vmax = r.V[i];
    }
    if (Math.abs(r.M[iSup]) > Math.abs(Mcant)) Mcant = r.M[iSup];
  }

  // осевое сжатие вдоль стропила: вертикальная нагрузка × sin α, накапливается
  // к нижней опоре (внешние реакции при этом вертикальные — распора нет)
  const totalPerp = Math.max(...byVariant.map((g) => g['ULS-1'].reactions.reduce((sum, r) => sum + r.R, 0)));
  const N = totalPerp * (sa / ca);

  // прогибы — тоже огибающая по вариантам загружения
  const spans = deflectionSpans(byVariant[0].SLS, Ls, supports).spans;
  for (const g of byVariant.slice(1)) {
    deflectionSpans(g.SLS, Ls, supports).spans.forEach((sp, i) => {
      if (sp.f > spans[i].f) spans[i] = sp;
    });
  }
  const cantLen = Ls - xSup;
  const lambda = xSup / (sec.material === 'timber' ? sec.h / Math.sqrt(12) : sec.props.ix);

  const checks = [];
  if (sec.material === 'timber') {
    checks.push(timberBending(Mmax, sec.props.Wx, mat));
    checks.push(timberShear(Vmax, sec, mat));
    checks.push(timberCombined(N, Mmax, sec, mat, lambda));
    if (cantLen > 200) checks.push(timberLateral(Mcant, sec, mat, cantLen));
    checks.push(timberBearing(Math.max(...byVariant.map((g) => g['ULS-1'].reactions[1].R)), sec, mat, model.opts.bearingLength));
  } else {
    checks.push(steelBending(Mmax, sec.props.Wx, mat));
    checks.push(steelShear(Vmax, sec.props, mat));
    checks.push(steelBeamColumn(N, Mmax, sec.props, mat, xSup, 'x'));
    checks.push(steelLocalBuckling(sec, mat, 0));
  }
  checks.push(deflectionCheck(spans, 200));

  const w = worstOf(checks);
  return {
    x, trib, sec, mat, Ls, xSup, cantLen, N, Mmax, Vmax, spans, hinges,
    res,
    variant: lead.variant.label,
    reactions: {
      wall: Math.max(...byVariant.map((g) => g['ULS-1'].reactions[0].R)),
      purlin: Math.max(...byVariant.map((g) => g['ULS-1'].reactions[1].R)),
      wallUplift: uplift.reactions[0].R,
      purlinUplift: uplift.reactions[1].R,
      wallSls: Math.max(...byVariant.map((g) => g.SLS.reactions[0].R)),
      purlinSls: Math.max(...byVariant.map((g) => g.SLS.reactions[1].R)),
      // скатная составляющая в том же сочетании, что и отрыв: снега в нём нет,
      // а собственный вес взят с разгружающим коэффициентом 0,9
      alongUplift: GAMMA_F.relieving * deadPerpN * Ls * (sa / ca),
    },
    ...w,
  };
}

/* ───────────────────────── ОБРЕШЁТКА ───────────────────────── */

function analyseBattens(model, ctx) {
  const sec = section(model.battens.sectionId);
  const mat = propsFor(sec, model.opts);
  const { EI, GAs } = stiffness(sec, mat);
  const xs = [...model.rafters.xs].sort((a, b) => a - b);
  const B = model.geom.B;
  const gammaDead = sec.material === 'timber' ? GAMMA_F.timber : GAMMA_F.steel;
  const ca = Math.cos(deg(model.geom.alpha));

  // худшее место — у стены, там снеговой мешок
  const sp = model.battens.spacing;
  const deadN = ((ctx.dead.roof * sp) / 1000 + sec.weight) * ca;
  const deadD = (GAMMA_F.roofing * (ctx.dead.roof * sp) / 1000 + gammaDead * sec.weight) * ca;
  const snowD = (Math.max(...ctx.snow.variants.map((v) => v.at(0))) * sp) / 1000 * ca * ca;

  const hinges = spliceHinges(model, B, xs, { always: true });
  const uls = solveBeam({ length: B, supports: xs, EI, GAs, q: () => deadD + GAMMA_F.snow * snowD, hinges, nEl: 160 });
  const sls = solveBeam({ length: B, supports: xs, EI, GAs, q: () => deadN + snowD, hinges, nEl: 160 });

  // сосредоточенная 1 кН (СП 20 п. 8.3.4) в середине наибольшего пролёта
  let span = 0, mid = B / 2;
  for (let i = 0; i + 1 < xs.length; i++) {
    if (xs[i + 1] - xs[i] > span) { span = xs[i + 1] - xs[i]; mid = (xs[i] + xs[i + 1]) / 2; }
  }
  const point = solveBeam({ length: B, supports: xs, EI, GAs, q: () => deadD, point: [{ x: mid, P: 1000 }], hinges, nEl: 160 });

  const Mmax = Math.abs(uls.maxM) > Math.abs(point.maxM) ? uls.maxM : point.maxM;
  const Vmax = Math.abs(uls.maxV) > Math.abs(point.maxV) ? uls.maxV : point.maxV;
  const spans = deflectionSpans(sls, B, xs).spans;

  const checks = [];
  if (sec.material === 'timber') {
    checks.push(timberBending(Mmax, sec.props.Wx, mat));
    checks.push(timberShear(Vmax, sec, mat));
  } else {
    checks.push(steelBending(Mmax, sec.props.Wx, mat));
    checks.push(steelShear(Vmax, sec.props, mat));
  }
  checks.push(deflectionCheck(spans, 150));
  // ограничение производителя кровли по пролёту обрешётки
  checks.push({
    // покрытие лежит на обрешётке и пролётом для него служит её шаг,
    // а не расстояние между стропилами
    name: 'Пролёт под кровлю',
    value: sp, limit: ctx.dead.def.maxBatten, unit: 'мм',
    U: sp / ctx.dead.def.maxBatten,
    formula: 'шаг обрешётки ≤ допустимого пролёта покрытия',
    note: ctx.dead.def.label,
  });

  return { sec, mat, span, res: { uls, sls, point }, spans, hinges, ...worstOf(checks) };
}

/* ───────────────────── ПРОГОН И БРУС У СТЕНЫ ───────────────────── */

export function analyseLineBeam(model, sectionId, supports, loads, label) {
  const sec = section(sectionId);
  const mat = propsFor(sec, model.opts);
  const { EI, GAs } = stiffness(sec, mat);
  const B = model.geom.B;
  const gammaDead = sec.material === 'timber' ? GAMMA_F.timber : GAMMA_F.steel;
  const self = sec.weight * gammaDead;

  // элемент длиннее хлыста собирается из кусков: стык встык момент не передаёт
  const hinges = spliceHinges(model, B, supports);

  const uls = solveBeam({ length: B, supports, EI, GAs, q: () => self, point: loads.uls, hinges, nEl: 160 });
  const sls = solveBeam({ length: B, supports, EI, GAs, q: () => sec.weight, point: loads.sls, hinges, nEl: 160 });
  const up = solveBeam({ length: B, supports, EI, GAs, q: () => 0, point: loads.uplift, hinges, nEl: 160 });

  const spans = deflectionSpans(sls, B, supports).spans;
  const checks = [];
  if (sec.material === 'timber') {
    checks.push(timberBending(uls.maxM, sec.props.Wx, mat));
    checks.push(timberShear(uls.maxV, sec, mat));
  } else {
    checks.push(steelBending(uls.maxM, sec.props.Wx, mat));
    checks.push(steelShear(uls.maxV, sec.props, mat));
  }
  checks.push(deflectionCheck(spans, 200));
  return { label, sec, mat, res: { uls, sls, up }, spans, hinges, reactions: uls.reactions, uplift: up.reactions, ...worstOf(checks) };
}

/* ───────────────── УЗЕЛ КРЕПЛЕНИЯ СТРОПИЛА ───────────────── */

/**
 * Крепление стропила к опоре от отрыва.
 *
 * Ветер поднимает кровлю: при лёгком покрытии собственный вес отрыв не
 * перекрывает, и стропило висит на крепеже. Узел принят такой: стропило
 * прижато к опоре перфорированным уголком с двух сторон (или сквозным
 * болтом), крепёж работает на срез — на выдёргивание гвозди и саморезы в
 * несущих узлах работать не должны.
 *
 * На узел приходит равнодействующая двух сил: вертикального отрыва и скатной
 * составляющей, которая накапливается к нижней опоре — к наружному прогону.
 * Число крепежей подбирается, а проверяется то, помещается ли оно в узле по
 * правилам расстановки: если нет — нужен крепёж крупнее, а не «набить гуще».
 */
const TIE_TARGET = 0.85;

function analyseTie(model, rafters, side, support, ctx) {
  const f = fastener(model.rafterTie.id);
  const sec = section(model.rafters.sectionId);
  const mat = propsFor(sec, model.opts);
  const supSec = section(support.sectionId);
  const supMat = propsFor(supSec, model.opts);

  // худшее стропило ряда: у крайних грузовая ширина меньше, но и прижимающий вес тоже
  const worst = rafters.reduce((a, r) => {
    const up = -r.reactions[side === 'wall' ? 'wallUplift' : 'purlinUplift'];
    return up > a.up ? { up, r } : a;
  }, { up: -Infinity, r: rafters[0] });
  const uplift = Math.max(0, worst.up);
  // скатная составляющая доходит до нижней опоры — она у наружного прогона
  const along = side === 'outer' ? Math.abs(worst.r.reactions.alongUplift) : 0;
  const force = Math.hypot(uplift, along);

  const cap = shearCapacity(f, { woodWidth: sec.b, mv: mat.mv ?? 1 });
  // если опора деревянная, вторая половина крепежа работает в ней — берём худшее
  const capSup = supSec.material === 'timber'
    ? shearCapacity(f, { woodWidth: supSec.b, mv: supMat.mv ?? 1 })
    : cap;
  const T = Math.min(cap.T, capSup.T);
  // число крепежей подбирается с тем же целевым запасом, что и сечения при
  // автоподборе: узел, собранный впритык, не оставляет права на ошибку монтажа
  const need = Math.max(2, Math.ceil(force / (TIE_TARGET * T)));
  const fit = fitCount(f, { rafterH: sec.h });
  const sp = spacingRules(f);

  const checks = [
    tieShear(force, need, T, `${need} × ${f.short}, T = ${(T / 1000).toFixed(2).replace('.', ',')} кН · ${cap.governs}`),
    tieFit(need, fit.n, `${fit.cols}×${fit.rows} при S1 ${sp.s1}, S2 ${sp.s2}, S3 ${sp.s3} мм`),
  ];
  if (supSec.material === 'steel') {
    // уголок крепится к профилю самосверлящими винтами того же числа
    checks.push(boltShear(force / need, SELF_DRILL_D, '5.8'));
    checks.push(steelHoleBearing(force / need, SELF_DRILL_D, supSec.t ?? 3, supMat,
      `винт ${SELF_DRILL_D} мм в стенку ${supSec.t ?? 3} мм`));
  }
  if (!cap.deep) {
    checks.push(tieShear(force, 0, 0,
      `защемление ${cap.pen} мм меньше 4d = ${4 * f.d} мм — крепёж не несущий`));
  }

  return {
    side, fastener: f, force, uplift, along, T, need, fit, spacing: sp,
    penetration: cap.pen, governs: cap.governs,
    support: supSec, x: worst.r.x,
    ...worstOf(checks),
  };
}

export function analyseTies(model, rafters, ctx) {
  return {
    outer: analyseTie(model, rafters, 'outer', model.purlin, ctx),
    wall: analyseTie(model, rafters, 'wall', model.wallPurlin, ctx),
  };
}

/* ──────────────── УЗЕЛ «ПРОГОН — СТОЛБ» ──────────────── */

/**
 * Прогон опирается на оголовок столба. Вертикальную нагрузку вниз держит само
 * опирание, торец в торец, — узел для неё не нужен. Узел держит то, что
 * пытается снять прогон с оголовка: ветровой отрыв и горизонтальную силу.
 *
 * Сварной узел жёсткий, поэтому в шов идёт ещё и момент от эксцентриситета
 * опирания. Болтовой в один ряд принимается шарнирным: момент там
 * воспринимается смятием площадки опирания, а болты держат отрыв и сдвиг.
 */
function analyseBeamTie(model, tieId, beam, posts) {
  let tie = beamTie(tieId);
  const postSec = posts[0].sec;
  const mat = posts[0].mat;
  const beamSec = beam.sec;
  const beamMat = beam.mat;

  // худший столб ряда: по отрыву, а при равном отрыве — по горизонтальной силе
  const post = posts.reduce((a, p) => (p.Nup > a.Nup || (p.Nup === a.Nup && p.Hpost > a.Hpost) ? p : a));
  const uplift = Math.max(0, post.Nup);
  const H = Math.abs(post.Hpost);
  const Mecc = Math.abs(post.N * model.opts.postEccentricity);

  const checks = [];
  let welded = tie.kind === 'weld';
  let fallback = null;
  if (welded && beamSec.material !== 'steel') {
    // к деревянной обвязке не приварить — считаем болтовой узел
    fallback = `${beamSec.label} — сосна, сварка невозможна: принят болтовой узел`;
    tie = beamTie('plate12x2');
    welded = false;
  }

  let detail = {};
  if (welded) {
    const line = weldLine(postSec.b, postSec.h);
    const Aw = WELD.betaF * tie.kf * line.length;
    const Az = WELD.betaZ * tie.kf * line.length;
    const Wf = WELD.betaF * tie.kf * line.W;
    const Wz = WELD.betaZ * tie.kf * line.W;
    const tauF = Math.hypot(uplift / Aw + Mecc / Wf, H / Aw);
    const tauZ = Math.hypot(uplift / Az + Mecc / Wz, H / Az);
    const tMin = Math.min(postSec.t ?? 3, beamSec.t ?? 3);
    const kfMin = weldMinLeg(Math.max(postSec.t ?? 3, beamSec.t ?? 3));
    const note = `шов ${Math.round(line.length)} мм по контуру ${postSec.label}`;
    checks.push(weldMetal(tauF, WELD.Rwf, note));
    checks.push(weldFusion(tauZ, mat.Run, note));
    checks.push(weldLeg(tie.kf, kfMin, 1.2 * tMin, `стенки ${postSec.t} и ${beamSec.t ?? '—'} мм`));
    detail = { weldLength: line.length, tauF, tauZ, kfMin, kfMax: 1.2 * tMin };
  } else {
    const n = tie.n;
    const Nb = uplift / n;
    const Vb = H / n;
    const note = `${n} × М${tie.d} класса ${tie.grade}`;
    checks.push(boltTension(Nb, BOLT_RT[tie.grade], BOLT_AN[tie.d], note));
    checks.push(boltShear(Vb, tie.d, tie.grade));
    if (beamSec.material === 'timber') {
      const side = WASHER_SIDE[tie.d] ?? 40;
      checks.push(timberWasherBearing(Nb, side, tie.d, beamMat, `шайба ${side}×${side} мм`));
      // горизонтальная сила передаётся болтом как нагелем в древесине
      const cap = shearCapacity({ ...tie, kind: 'bolt', len: 0 }, { woodWidth: beamSec.b, mv: beamMat.mv ?? 1 });
      const dowel = tieShear(H, n, cap.T, `T = ${(cap.T / 1000).toFixed(2).replace('.', ',')} кН · ${cap.governs}`);
      dowel.name = 'Болт как нагель в брусе';
      checks.push(dowel);
      detail = { washer: side, dowelT: cap.T };
    } else {
      checks.push(steelHoleBearing(Vb, tie.d, beamSec.t ?? 3, beamMat, `болт М${tie.d} в стенку ${beamSec.t} мм`));
    }
    detail = { ...detail, n, Nb, Vb, plate: Math.max(160, (postSec.b ?? 100) + 80) };
  }
  return {
    tie, welded, fallback, uplift, H, Mecc, post: postSec, beam: beamSec, x: post.x,
    ...detail, ...worstOf(checks),
  };
}

export function analyseBeamTies(model, purlin, wallPurlin, posts, wallPosts) {
  return {
    outer: analyseBeamTie(model, model.purlinTie.id, purlin, posts),
    wall: analyseBeamTie(model, model.wallPurlinTie.id, wallPurlin, wallPosts),
  };
}

/* ───────────────────────── СТОЛБЫ ───────────────────────── */

/**
 * Ряд столбов под прогоном.
 * @param {object} cfg model.posts или model.wallPosts
 * @param {object} purlin результат расчёта прогона, лежащего на этом ряду
 * @param {{braced:boolean, thrust:number, alongWall:number}} extra
 *   braced — столб раскреплён стеной (сквозные шпильки);
 *   thrust — суммарный горизонтальный распор от ската и ветра на весь ряд, Н;
 *   alongWall — ветровая сила вдоль стены на весь ряд, Н.
 */
export function analysePostRow(model, cfg, purlin, ctx, extra) {
  const sec = section(cfg.sectionId);
  const mat = propsFor(sec, model.opts);
  const lv = levels(model);
  const H = extra.braced ? lv.wallPostTop : lv.postTop;
  // расчётные длины в двух плоскостях: поперёк ряда (x — к дому и от дома,
  // в этой же плоскости действуют ветровой распор и эксцентриситет) и вдоль
  // ряда (y — вдоль стены). Закрепления там разные, поэтому и μ разные
  const lefX = cfg.muX * H;
  const lefY = cfg.muY * H;
  const lef = Math.max(lefX, lefY);
  const fascia = sec.h + 200;
  const n = purlin.reactions.length;
  const EI = mat.E * sec.props.Ix;
  const GAs = mat.G * sec.props.As;

  return purlin.reactions.map((r, i) => {
    const N = Math.max(0, r.R) + sec.weight * H * GAMMA_F.steel;
    const trib = i === 0 || i === n - 1 ? model.geom.B / (2 * Math.max(1, n - 1)) : model.geom.B / Math.max(1, n - 1);
    const Hwind = extra.braced ? 0 : (ctx.wind.lateral * fascia * trib) / 1e6 * 1000;
    const Hpost = (extra.thrust ?? 0) / n + Hwind;
    const Mecc = N * model.opts.postEccentricity;
    const Nup = -(purlin.uplift[i]?.R ?? 0);

    // эпюры по высоте столба: горизонтальная сила и момент от эксцентриситета
    // приложены вверху, в уровне опирания прогона
    let diagram, bolts = null;
    if (extra.braced) {
      // столб держат сквозные шпильки — балка на опорах в их отметках плюс база
      const zs = boltHeights(H, Math.max(1, cfg.boltCount));
      diagram = solveBeam({
        length: H, supports: [0, ...zs], EI, GAs,
        point: [{ x: H, P: Hpost }], moments: [{ x: H, M: Mecc }], nEl: 80,
      });
      const forces = diagram.reactions.slice(1).map((x) => Math.abs(x.R));
      const Nbolt = Math.max(0, ...forces);
      const Vbolt = Math.max(Math.max(0, Nup), (extra.alongWall ?? 0) / n) / Math.max(1, cfg.boltCount);
      bolts = { Nbolt, Vbolt, count: cfg.boltCount, heights: zs, forces };
    } else {
      // отдельно стоящий столб — консоль, защемлённая в фундаменте
      const nS = 121, x = new Float64Array(nS), M = new Float64Array(nS), V = new Float64Array(nS), w = new Float64Array(nS);
      for (let k = 0; k < nS; k++) {
        const z = (H * k) / (nS - 1);
        x[k] = z;
        V[k] = Hpost;
        M[k] = Mecc + Hpost * (H - z);
        w[k] = (Hpost * z * z * (3 * H - z)) / 6 / EI + (Mecc * z * z) / 2 / EI;
      }
      diagram = { x, M, V, w, reactions: [{ x: 0, R: Hpost }], maxM: M[0], maxV: Hpost };
    }
    let M = 0;
    for (let k = 0; k < diagram.M.length; k++) if (Math.abs(diagram.M[k]) > Math.abs(M)) M = diagram.M[k];

    // устойчивость проверяется в каждой плоскости своей расчётной длиной
    const stabX = steelStability(N, sec.props, mat, lefX, 'x');
    const stabY = steelStability(N, sec.props, mat, lefY, 'y');
    stabX.name = 'Устойчивость поперёк ряда';
    stabY.name = 'Устойчивость вдоль ряда';
    const stab = stabX.U >= stabY.U ? stabX : stabY;
    const checks = [
      stabX,
      stabY,
      steelBeamColumn(N, M, sec.props, mat, lefX, 'x'),
      // гибкость и местная устойчивость — по той плоскости, которая правит
      // общей устойчивостью: там наибольшая λ и наименьший φ
      steelSlenderness(Math.max(stabX.lambda, stabY.lambda), stab.U),
      steelLocalBuckling(sec, mat, stab.lb),
    ];
    if (bolts) {
      const bChecks = [
        boltPlateBearing(bolts.Nbolt, cfg.plateSize, cfg.boltDiameter, cfg.blockClass),
        boltHoleBearing(bolts.Vbolt, cfg.boltDiameter, cfg.wallThickness, cfg.blockClass),
        boltShear(bolts.Vbolt, cfg.boltDiameter, cfg.boltGrade),
      ];
      Object.assign(bolts, worstOf(bChecks));
      checks.push(...bChecks);
    }

    return {
      x: r.x, N, M, Nup, Hpost, sec, mat, lef, lefX, lefY, H, bolts, diagram,
      braced: !!extra.braced, ...worstOf(checks),
    };
  });
}

/* ─────────────────────── БАЗА СТОЛБА ─────────────────────── */

/**
 * База столба — то место, где расчётная схема встречается с землёй.
 *
 * Расчёт столба на устойчивость при μ = 2 или 0,7 предполагает защемление
 * внизу. Значит, база обязана воспринять момент от горизонтальной силы и
 * эксцентриситета опирания — иначе «защемлён внизу» остаётся словами, а
 * настоящая расчётная длина больше принятой.
 *
 * Момент берётся наибольший по эпюре столба, а вертикальная сила — отрывающая.
 * Строго говоря, это разные сочетания, но вместе они дают верхнюю оценку
 * растяжения в анкере — в запас.
 */
function analysePostBase(model, cfg, posts, ctx) {
  const base = postBase(model.postBase.id);
  const post = posts.reduce((a, p) => (p.Nup > a.Nup || (p.Nup === a.Nup && Math.abs(p.diagram.M[0]) > Math.abs(a.diagram.M[0])) ? p : a));
  const sec = post.sec;
  const mat = post.mat;
  const conc = CONCRETE[model.opts.concreteClass] ?? CONCRETE.B20;
  const N = Math.max(0, post.N);
  const uplift = Math.max(0, post.Nup);
  const H = Math.abs(post.Hpost);
  const M = Math.abs(post.diagram.M[0]);
  // защемление внизу предполагается всюду, кроме шарнирной схемы μ = 1
  const needsFixity = cfg.muX !== 1 || cfg.muY !== 1;

  const checks = [];
  let detail = {};

  // Бетонный блок под столбом — один и тот же и для забетонированного столба,
  // и для базы на плите: сторона и глубина задаются в панели. Его вес —
  // единственное, что держит навес от вырыва вверх, поэтому размеры не
  // угадываются, а проверяются. У забетонированного столба блок не может быть
  // мельче заделки: столб в нём стоит.
  const side = Math.max(sec.h + 100, model.postBase.footing ?? 400);
  const depth = Math.max(model.postBase.depth ?? 800, base.kind === 'embed' ? base.embed : 0);
  const mass = ((side * side * depth) / 1e9) * CONCRETE_DENSITY;
  const needMass = uplift / 0.9 / G0;
  // подсказки «сделайте так»: какой глубины хватит при этой стороне и наоборот
  const needVolume = needMass / CONCRETE_DENSITY; // м³
  const step50 = (mm) => Math.ceil(mm / 50) * 50;
  const needDepth = step50((needVolume / ((side / 1000) ** 2)) * 1000);
  const needSide = step50(Math.sqrt(needVolume / (depth / 1000)) * 1000);
  // мороз: для пучинистого грунта подошва не выше расчётной глубины промерзания
  const frost = frostDepth(model.site.frostDepth ?? 0, model.site.soil ?? 'clay');
  const frostApplies = frost.set && frost.soil.heaving;
  const needFrostDepth = frostApplies ? step50(frost.df) : 0;
  const block = {
    side, depth, mass, needMass, needDepth, needSide, enough: mass >= needMass,
    frost: { ...frost, applies: frostApplies, needDepth: needFrostDepth, ok: depth >= needFrostDepth },
  };
  const frostCheck = () => (frostApplies
    ? [foundationFrost(frost.df, depth,
      `${frost.soil.label}: d_fn ${Math.round(frost.dfn)} мм, подошва блока на ${depth} мм`)]
    : []);

  if (base.kind === 'embed') {
    if (needsFixity) {
      checks.push(embedDepth(base.embed, minEmbed(sec.h),
        `сечение ${sec.label}, схема с защемлением внизу`));
    }
    checks.push(anchorMass(uplift, mass, `блок ${side}×${side}×${depth} мм ≈ ${mass.toFixed(0)} кг`));
    checks.push(concreteBearing(N / (side * side), conc.Rb, `подошва ${side}×${side} мм`));
    checks.push(...frostCheck());
    detail = { ...block, needEmbed: minEmbed(sec.h) };
  } else {
    const A = base.plate * base.plate;
    const W = (base.plate ** 3) / 6;
    const sigma = N / A + M / W;
    const c = Math.max(0, (base.plate - sec.h) / 2);
    const Mc = (sigma * c * c) / 2;                 // Н·мм на 1 мм ширины
    const sigmaPlate = (6 * Mc) / (base.t * base.t);
    const span = anchorSpan(base);
    const rows = base.n / 2;
    const Na = uplift / base.n + M / (span * rows);
    checks.push(concreteBearing(sigma, conc.Rb, `плита ${base.plate}×${base.plate} мм, бетон ${model.opts.concreteClass ?? 'B20'}`));
    checks.push(plateBending(sigmaPlate, mat.Ry, `вылет ${Math.round(c)} мм при толщине ${base.t} мм`));
    checks.push(boltTension(Na, BOLT_RT[base.grade], BOLT_AN[base.d],
      `${base.n} × М${base.d}, разнос ${span} мм: отрыв ${(uplift / base.n / 1000).toFixed(2).replace('.', ',')} + момент ${(M / span / rows / 1000).toFixed(2).replace('.', ',')} кН`));
    checks.push(anchorCone(Na, base.hef, conc.Rbt, `заделка ${base.hef} мм в бетон ${model.opts.concreteClass ?? 'B20'}`));
    checks.push(boltShear(H / base.n, base.d, base.grade));
    // анкеры держат столб за бетон, но сам блок ещё должен не уехать вверх:
    // раньше это число только выводилось в инспекторе и в U не входило
    checks.push(anchorMass(uplift, mass, `блок ${side}×${side}×${depth} мм ≈ ${mass.toFixed(0)} кг`));
    checks.push(...frostCheck());
    detail = { sigma, sigmaPlate, span, Na, c, ...block };
  }

  return {
    base, post: sec, N, uplift, H, M, needsFixity, concrete: model.opts.concreteClass ?? 'B20',
    x: post.x, ...detail, ...worstOf(checks),
  };
}

export function analysePostBases(model, posts, wallPosts, ctx) {
  return {
    outer: analysePostBase(model, model.posts, posts, ctx),
    wall: analysePostBase(model, model.wallPosts, wallPosts, ctx),
  };
}


/* ───────────────── СТЫК БАЛКИ ПО ДЛИНЕ ───────────────── */

/**
 * Узел стыка: накладка, которая восстанавливает сечение.
 *
 * Стык встык не передаёт ничего, поэтому он обязан лежать на опоре — это
 * решает раскладка. Накладка же ставится там, где удобно резать, и обязана
 * пропустить через себя и момент, и поперечную силу того сечения, в котором
 * стоит. Считаем её как настоящий узел и выдаём типоразмер.
 *
 * Дерево: две боковые накладки на нагелях, симметричное двухсрезное
 * соединение. Момент воспринимается группой нагелей по обе стороны стыка,
 * поперечная сила делится между ними поровну.
 *
 * Сталь: две накладки по боковым стенкам на угловых швах по контуру.
 *
 * Подбор идёт снизу — от самого тонкого и дешёвого исполнения, как и сечения
 * при подборе по цене.
 */
const SPLICE_TARGET = 0.85;
const SPLICE_LENGTH_STEP = 50;

/** Момент и поперечная сила в сечении стыка. Q берётся худшая из двух сторон. */
function forcesAt(res, x) {
  const xs = res.x;
  let i = 0;
  for (let k = 0; k < xs.length; k++) if (Math.abs(xs[k] - x) < Math.abs(xs[i] - x)) i = k;
  const lo = Math.max(0, i - 1), hi = Math.min(xs.length - 1, i + 1);
  let M = 0, V = 0;
  for (let k = lo; k <= hi; k++) {
    if (Math.abs(res.M[k]) > Math.abs(M)) M = res.M[k];
    if (Math.abs(res.V[k]) > Math.abs(V)) V = res.V[k];
  }
  return { M, V };
}

/**
 * Расстановка нагелей с одной стороны стыка: два ряда по высоте, колонки
 * с шагом S1 от торца. Возвращает координаты относительно центра стыка.
 */
function dowelGrid(d, h, cols) {
  const s1 = 7 * d, s2 = 3.5 * d, s3 = 3 * d;
  // второй ряд помещается, только если между рядами остаётся S2, а до кромок S3
  const y = h / 2 - s3;
  const rows = 2 * y >= s2 ? [y, -y] : [0];
  const pts = [];
  for (let c = 0; c < cols; c++) {
    const x = SPLICE_GAP / 2 + s1 * (c + 1);
    for (const yy of rows) pts.push({ x, y: yy });
  }
  const reach = pts[pts.length - 1].x;
  return { pts, rows: rows.length, s1, s2, s3, reach, plateLength: 2 * (reach + s1) };
}

/**
 * Наибольшее усилие на нагель группы: момент относительно центра тяжести плюс срез.
 *
 * Группы две — по обе стороны стыка, и эксцентриситет у них противоположный.
 * У одной поперечная сила момент разгружает, у другой добавляет, поэтому
 * переносим по модулю: считаем ту группу, которой хуже.
 */
function dowelForce(pts, M, V) {
  const n = pts.length;
  const xc = pts.reduce((a, p) => a + p.x, 0) / n;
  const r2 = pts.reduce((a, p) => a + (p.x - xc) ** 2 + p.y * p.y, 0);
  const Mg = Math.abs(M) + Math.abs(V) * xc;
  let max = 0;
  for (const p of pts) {
    const fx = (-Mg * p.y) / r2;
    const fy = (Mg * (p.x - xc)) / r2 + V / n;
    max = Math.max(max, Math.hypot(fx, fy));
  }
  return { force: max, n, xc, r2 };
}

function timberSplice(sec, mat, M, V) {
  let best = null;
  // сверлить двадцать отверстий вместо восьми никто не станет: сначала ищем
  // решение с наименьшим числом нагелей, и только потом с меньшим диаметром
  for (let cols = 2; cols <= 5 && !best; cols++) {
    for (const d of SPLICE_DOWELS) {
      for (const t of SPLICE_PLATES.timber) {
        const cap = dowelDouble({ d, plate: t, beam: sec.b, mv: mat.mv ?? 1 });
        const grid = dowelGrid(d, sec.h, cols);
        const f = dowelForce(grid.pts, M, V);
        const perSide = grid.pts.length;
        const total = 2 * perSide;
        const len = Math.ceil(grid.plateLength / SPLICE_LENGTH_STEP) * SPLICE_LENGTH_STEP;
        const checks = [
          spliceDowel(f.force, cap.T,
            `${perSide} нагелей М${d} с каждой стороны в ${grid.rows === 2 ? 'два ряда' : 'один ряд'}, T = ${(cap.T / 1000).toFixed(2).replace('.', ',')} кН · ${cap.governs}`),
          splicePlateBending(M, t, sec.h, mat.Rbend, `накладка ${t}×${sec.h} мм, их две`),
        ];
        const w = worstOf(checks);
        if (w.U <= SPLICE_TARGET) {
          best = {
            material: 'timber', d, plateT: t, plateH: sec.h, plateLength: len,
            cols, rows: grid.rows, n: total, T: cap.T, governs: cap.governs, force: f.force,
            spacing: { s1: grid.s1, s2: grid.s2, s3: grid.s3 },
            solution: `две накладки ${t}×${sec.h} мм длиной ${len} мм, ${total} нагелей М${d}`,
            checks, ...w,
          };
          break;
        }
      }
      if (best) break;
    }
  }
  return best;
}

function steelSplice(sec, mat, M, V) {
  const tw = sec.t ?? 3;
  let best = null;
  // накладка тоньше стенки — решение сомнительное и на катет шва всё равно
  // не даёт ничего: kf ограничен наименьшей из толщин
  for (const t of SPLICE_PLATES.steel.filter((x) => x >= tw)) {
    const kfMin = weldMinLeg(Math.max(t, tw));
    const kfMax = 1.2 * Math.min(t, tw);
    if (kfMin > kfMax) continue; // такой накладкой к этой стенке не приварить
    const kf = kfMin;
    for (let len = 100; len <= 400; len += SPLICE_LENGTH_STEP) {
      const line = weldLine(len, sec.h);
      const Aw = WELD.betaF * kf * line.length, Wf = WELD.betaF * kf * line.W;
      const Az = WELD.betaZ * kf * line.length, Wz = WELD.betaZ * kf * line.W;
      // накладок две, каждая берёт половину момента и половину поперечной силы
      const tauF = Math.hypot(Math.abs(M) / 2 / Wf, Math.abs(V) / 2 / Aw);
      const tauZ = Math.hypot(Math.abs(M) / 2 / Wz, Math.abs(V) / 2 / Az);
      const note = `шов по контуру накладки ${len}×${sec.h} мм, катет ${kf} мм`;
      const checks = [
        weldMetal(tauF, WELD.Rwf, note),
        weldFusion(tauZ, mat.Run, note),
        weldLeg(kf, kfMin, kfMax, `стенка ${tw} мм и накладка ${t} мм`),
        splicePlateBending(M, t, sec.h, mat.Ry, `накладка ${t}×${sec.h} мм, их две`),
      ];
      const w = worstOf(checks);
      if (w.U <= SPLICE_TARGET) {
        best = {
          material: 'steel', plateT: t, plateH: sec.h, plateLength: 2 * len + SPLICE_GAP,
          weldLength: line.length, kf, tauF, tauZ,
          solution: `две накладки ${t}×${sec.h} мм длиной ${2 * len + SPLICE_GAP} мм, шов по контуру катетом ${kf} мм`,
          checks, ...w,
        };
        break;
      }
    }
    if (best) break;
  }
  return best;
}

/**
 * Стыки-накладки всех балок, которые не помещаются в хлыст.
 * При стыке встык узла нет: там стык лежит на опоре и ничего не передаёт.
 */
export function analyseSpliceJoints(model, elements) {
  if ((model.opts.spliceJoint ?? 'butt') !== 'plate') return [];
  const out = [];
  for (const { key, label, el, length, supports } of elements) {
    const stock = model.opts.stockLength ?? 6000;
    const plan = splicePlan(length, stock, supports);
    if (!plan.splices) continue;
    // худший стык элемента: где больше момент
    const diag = el.res.uls ?? el.res['ULS-1'];
    let worstX = plan.at[0], worst = forcesAt(diag, plan.at[0]);
    for (const x of plan.at) {
      const f = forcesAt(diag, x);
      if (Math.abs(f.M) > Math.abs(worst.M)) { worst = f; worstX = x; }
    }
    const joint = el.sec.material === 'timber'
      ? timberSplice(el.sec, el.mat, worst.M, worst.V)
      : steelSplice(el.sec, el.mat, worst.M, worst.V);
    out.push(joint
      ? { key, label, x: worstX, M: worst.M, V: worst.V, count: plan.splices, sec: el.sec, ...joint }
      : {
        key, label, x: worstX, M: worst.M, V: worst.V, count: plan.splices, sec: el.sec,
        material: el.sec.material, impossible: true, U: Infinity,
        solution: 'из сортамента накладок не собирается — уменьшите пролёт или перенесите стык',
        checks: [], worst: { name: 'Накладка не подбирается', U: Infinity },
      });
  }
  return out;
}

/* ───────────────────────── ВСЁ ВМЕСТЕ ───────────────────────── */

/**
 * Кровельная часть (нагрузки, стропила, обрешётка) не зависит от положения
 * и сечений столбов, поэтому её результат переиспользуется между вызовами —
 * иначе перетаскивание столба каждый кадр пересчитывало бы все стропила.
 */
let roofMemo = { key: null, value: null };

export function analyseRoof(model) {
  const key = JSON.stringify([model.geom, model.site, model.roofing, model.rafters, model.battens, model.opts]);
  if (roofMemo.key === key) return roofMemo.value;

  const { geom } = model;
  const dead = roofDead(model);
  const snow = snowProfile(model.site, geom.alpha, { driftH: geom.driftH, depth: geom.L + geom.a, width: geom.B, alpha: geom.alpha });
  const zTop = levels(model).canopyTopWall;
  const wind = windPressure(model.site, zTop);
  const ctx = { dead, snow, wind };

  const xs = [...model.rafters.xs].sort((a, b) => a - b);
  const tribs = tributaries(xs, geom.B);
  const cache = new Map();
  const rafters = xs.map((x, i) => {
    const k = Math.round(tribs[i] * 10);
    if (!cache.has(k)) cache.set(k, analyseRafter(model, 0, tribs[i], ctx));
    return { ...cache.get(k), x, index: i };
  });
  const battens = analyseBattens(model, ctx);

  roofMemo = { key, value: { ctx, dead, snow, wind, rafters, battens } };
  return roofMemo.value;
}

/**
 * Нагрузки и схемы, которые кровля передаёт опорной части.
 *
 * Вынесено отдельно, чтобы подбор сечений мог считать один прогон или один ряд
 * столбов, не пересчитывая всю конструкцию: формулы распора при этом остаются
 * в одном месте и не расходятся с полным расчётом.
 */
export function supportLoads(model, roof = analyseRoof(model)) {
  const { geom } = model;
  const pick = (key) => roof.rafters.map((r) => ({ x: r.x, P: r.reactions[key] }));

  // ── горизонтальные силы, которые должен принять стеновой ряд.
  // Сила тяжести распора не даёт: опоры вертикальные, ΣH = 0. Горизонталь — только ветер:
  // горизонтальная проекция давления по нормали к скату плюс напор на наружную кромку.
  const al = deg(geom.alpha);
  const roofArea = (geom.B * (geom.L + geom.a)) / 1e6; // м²
  const fasciaH = section(model.rafters.sectionId).h + 200;
  const thrustRoof = roof.wind.up * roofArea * Math.sin(al) * 1000;
  const thrustFascia = roof.wind.lateral * ((fasciaH * geom.B) / 1e6) * 1000;
  const thrust = thrustRoof + thrustFascia;
  const alongWall = roof.wind.lateral * ((fasciaH * geom.L) / 1e6) * 1000;

  return {
    roof,
    ctx: roof.ctx,
    thrust: { total: thrust, roof: thrustRoof, fascia: thrustFascia, alongWall },
    outer: {
      beamKey: 'purlin', postsKey: 'posts', label: 'Прогон по столбам',
      supports: [...model.posts.xs].sort((a, b) => a - b),
      loads: { uls: pick('purlin'), sls: pick('purlinSls'), uplift: pick('purlinUplift') },
      extra: { braced: false, thrust: 0, alongWall: 0 },
    },
    wall: {
      beamKey: 'wallPurlin', postsKey: 'wallPosts', label: 'Обвязка у стены',
      supports: [...model.wallPosts.xs].sort((a, b) => a - b),
      loads: { uls: pick('wall'), sls: pick('wallSls'), uplift: pick('wallUplift') },
      extra: { braced: true, thrust, alongWall },
    },
  };
}

/**
 * Стыки по длине: какие элементы не помещаются в хлыст.
 *
 * Балки считаются неразрезными по всей ширине навеса, а купить их целиком
 * можно только пока элемент короче хлыста. Дальше расчёт опирается на
 * элемент, которого не существует, и об этом надо сказать вслух: стык без
 * накладки — шарнир, он снимает опорный момент и поднимает пролётные.
 *
 * Отдельно ловится случай, когда кусок ложится меньше чем на две опоры:
 * это уже не пониженный запас, а геометрически изменяемая схема.
 *
 * Столбы попадают в список при коротком хлысте, но схему по ним не судим —
 * стойка не балка на опорах, стык в ней конструируется отдельно.
 */
/**
 * Координаты стыков внутри элемента для расчётной схемы.
 *
 * Пустой список, если элемент влезает в хлыст или стык выполнен накладкой:
 * тогда сечение восстановлено и балка остаётся неразрезной. Стык ровно на
 * конце элемента ничего не рвёт, поэтому в схему не идёт.
 */
export function spliceHinges(model, length, supports = [], opts = {}) {
  // обрешётку стыкуют на стропиле внахлёст, накладок на неё не ставят —
  // для неё стык всегда работает шарниром, какой бы тип ни был выбран
  if (!opts.always && (model.opts.spliceJoint ?? 'butt') !== 'butt') return [];
  const stock = model.opts.stockLength ?? 6000;
  return splicePlan(length, stock, supports, { onSupports: true }).at.filter((x) => x > 0 && x < length);
}

export function spliceReport(model) {
  const { geom } = model;
  const stock = model.opts.stockLength ?? 6000;
  const ca = Math.cos(deg(geom.alpha));
  const lv = levels(model);
  const parts = [
    { key: 'rafters', label: 'Стропило', beam: true,
      length: (geom.L + geom.a) / ca + 100, supports: [0, geom.L / ca] },
    { key: 'battens', label: 'Обрешётка', beam: true,
      length: geom.B, supports: [...model.rafters.xs] },
    { key: 'wallPurlin', label: 'Обвязка у стены', beam: true,
      length: geom.B, supports: [...model.wallPosts.xs] },
    { key: 'purlin', label: 'Прогон наружный', beam: true,
      length: geom.B, supports: [...model.posts.xs] },
    { key: 'posts', label: 'Столб наружный', beam: false, length: lv.postLength, supports: [] },
    { key: 'wallPosts', label: 'Столб у стены', beam: false, length: lv.wallPostLength, supports: [] },
  ];
  const butt = (model.opts.spliceJoint ?? 'butt') === 'butt';
  return parts
    .map((p) => {
      // стык встык кладётся на опору — иначе куски не связаны ничем
      const plan = splicePlan(p.length, stock, p.supports, { onSupports: (butt || p.key === 'battens') && p.beam });
      return { ...p, ...plan, unstable: p.beam && plan.unstable, impossible: p.beam && plan.impossible };
    })
    .filter((p) => p.splices > 0 || p.impossible);
}

export function analyse(model) {
  const { ctx, dead, snow, wind, rafters, battens } = analyseRoof(model);
  const sl = supportLoads(model, { ctx, dead, snow, wind, rafters, battens });

  const purlin = analyseLineBeam(model, model.purlin.sectionId, sl.outer.supports, sl.outer.loads, sl.outer.label);
  const wallPurlin = analyseLineBeam(model, model.wallPurlin.sectionId, sl.wall.supports, sl.wall.loads, sl.wall.label);

  const posts = analysePostRow(model, model.posts, purlin, ctx, sl.outer.extra);
  const wallPosts = analysePostRow(model, model.wallPosts, wallPurlin, ctx, sl.wall.extra);
  const ties = analyseTies(model, rafters, ctx);
  const beamTies = analyseBeamTies(model, purlin, wallPurlin, posts, wallPosts);
  const bases = analysePostBases(model, posts, wallPosts, ctx);
  const ca = Math.cos(deg(model.geom.alpha));
  const worstRafter = rafters.reduce((a, b) => (a.U > b.U ? a : b));
  const spliceJoints = analyseSpliceJoints(model, [
    { key: 'purlin', label: 'Прогон наружный', el: purlin, length: model.geom.B, supports: sl.outer.supports },
    { key: 'wallPurlin', label: 'Обвязка у стены', el: wallPurlin, length: model.geom.B, supports: sl.wall.supports },
    { key: 'rafters', label: 'Стропило', el: worstRafter, length: worstRafter.Ls, supports: [0, model.geom.L / ca] },
  ]);

  const maxUplift = Math.max(0, ...posts.map((p) => p.Nup));
  const foundation = {
    uplift: maxUplift,
    /** сила, которую фундамент обязан удержать, кН — с коэффициентом 0,9 на вес */
    requiredHold: maxUplift / 0.9 / 1000,
    /** та же величина в килограммах бетона: человек считает фундамент весом, а не ньютонами */
    requiredMassKg: maxUplift / 0.9 / G0,
    cubeSide: Math.cbrt(Math.max(0.001, maxUplift / 0.9 / 1000 / 24)) * 1000,
    maxDown: Math.max(...posts.map((p) => p.N)),
  };

  const rowWorst = (list) => list.reduce((a, b) => (a.U > b.U ? a : b));
  const all = [
    { key: 'battens', label: 'Обрешётка', U: battens.U, worst: battens.worst },
    { key: 'rafters', label: 'Стропила', U: Math.max(...rafters.map((r) => r.U)), worst: rowWorst(rafters).worst },
    { key: 'purlin', label: 'Прогон наружный', U: purlin.U, worst: purlin.worst },
    { key: 'posts', label: 'Столбы наружные', U: Math.max(...posts.map((p) => p.U)), worst: rowWorst(posts).worst },
    { key: 'wallPurlin', label: 'Обвязка у стены', U: wallPurlin.U, worst: wallPurlin.worst },
    { key: 'wallPosts', label: 'Столбы у стены', U: Math.max(...wallPosts.map((p) => p.U)), worst: rowWorst(wallPosts).worst },
    { key: 'ties', label: 'Крепление стропил', U: Math.max(ties.outer.U, ties.wall.U),
      worst: (ties.outer.U > ties.wall.U ? ties.outer : ties.wall).worst },
    { key: 'beamTies', label: 'Прогон на столбе', U: Math.max(beamTies.outer.U, beamTies.wall.U),
      worst: (beamTies.outer.U > beamTies.wall.U ? beamTies.outer : beamTies.wall).worst },
    { key: 'bases', label: 'База столба', U: Math.max(bases.outer.U, bases.wall.U),
      worst: (bases.outer.U > bases.wall.U ? bases.outer : bases.wall).worst },
  ];
  if (spliceJoints.length) {
    const worstSplice = spliceJoints.reduce((a, b) => (a.U > b.U ? a : b));
    all.push({ key: 'spliceJoints', label: 'Стык по длине', U: worstSplice.U, worst: worstSplice.worst });
  }

  return {
    model, ctx, dead, snow, wind,
    rafters, battens, purlin, wallPurlin, posts, wallPosts, ties, beamTies, bases, foundation,
    thrust: sl.thrust,
    splices: spliceReport(model),
    spliceJoints,
    summary: all,
    maxU: Math.max(...all.map((a) => a.U)),
  };
}

/**
 * Спецификация и массы.
 *
 * Формулы:
 *   дерево   V = b·h·L·n,            m = V·ρ,   ρ = 500 кг/м³
 *   сталь    m = A·L·n·ρ,            ρ = 7850 кг/м³  (то же, что A[см²]·0,785 кг/м)
 *   кровля   m = g·S/g₀,             g — кН/м² по скату, S — площадь ската
 *   шпилька  m = π/4·d²·L·ρ_ст,      пластина m = a²·t·ρ_ст
 *
 * Стоимость: дерево — по объёму (V·цена за м³), металл — по массе (m·цена за кг),
 * кровля — по площади ската, метизы — поштучно. Цены задаёт пользователь.
 *
 * Собственный вес всех этих элементов уже входит в расчёт нагрузок:
 * стропила и прогоны — погонным весом сечения, обрешётка — весом на 1 м²,
 * столбы — весом ствола в осевой силе.
 */
export function billOfMaterials(result) {
  const m = result.model;
  const stock = m.opts.stockLength ?? 6000;
  const pr = m.prices ?? { timberM3: 0, steelKg: 0, roofingM2: 0, fastenerPc: 0, currency: '₽' };
  const items = [];
  const add = (name, sec, lengthMm, count) => {
    const isT = sec.material === 'timber';
    const perStock = Math.max(1, Math.floor(stock / lengthMm));
    const volume = (sec.props.A * lengthMm * count) / 1e9; // м³
    const mass = (sec.massPerM * lengthMm * count) / 1000;
    // элемент длиннее хлыста собирается из кусков: столько же хлыстов на штуку,
    // и на один стык меньше. Раньше здесь стоял прочерк — человек не видел
    // ни числа хлыстов, ни того, что элемент вообще придётся стыковать
    const plan = splicePlan(lengthMm, stock);
    items.push({
      name,
      section: sec.label,
      material: isT ? 'сосна' : 'сталь',
      count,
      length: Math.round(lengthMm),
      totalLength: (lengthMm * count) / 1000,
      stockPieces: plan.pieces > 1 ? plan.pieces * count : Math.ceil(count / perStock),
      splices: plan.splices * count,
      volume: isT ? volume : null,
      mass,
      unitPrice: isT ? pr.timberM3 : pr.steelKg,
      unit: isT ? '₽/м³' : '₽/кг',
      cost: isT ? volume * pr.timberM3 : mass * pr.steelKg,
    });
  };
  const ca = Math.cos(deg(m.geom.alpha));
  add('Стропила', section(m.rafters.sectionId), (m.geom.L + m.geom.a) / ca + 100, m.rafters.xs.length);
  const nBatten = Math.floor((m.geom.L + m.geom.a) / ca / m.battens.spacing) + 1;
  add('Обрешётка', section(m.battens.sectionId), m.geom.B, nBatten);
  add('Обвязка у стены', section(m.wallPurlin.sectionId), m.geom.B, 1);
  add('Прогон наружный', section(m.purlin.sectionId), m.geom.B, 1);
  const lv = levels(m);
  add('Столбы наружные', section(m.posts.sectionId), lv.postLength, m.posts.xs.length);
  add('Столбы у стены', section(m.wallPosts.sectionId), lv.wallPostLength, m.wallPosts.xs.length);

  // кровля
  const roofArea = (m.geom.B * ((m.geom.L + m.geom.a) / ca)) / 1e6; // м² по скату
  const roofMass = (result.dead.roof * roofArea * 1000) / G0;

  // метизы
  const wp = m.wallPosts;
  const boltLen = wp.wallThickness + 120;
  const boltCount = wp.boltCount * wp.xs.length;
  const boltMass = (Math.PI / 4) * wp.boltDiameter ** 2 * boltLen * boltCount * 7.85e-6;
  const plateMass = wp.plateSize ** 2 * 8 * boltCount * 7.85e-6;
  const fasteners = [
    { name: `Шпилька М${wp.boltDiameter} класса ${wp.boltGrade}`, count: boltCount,
      note: `длина ≥ ${boltLen} мм`, mass: boltMass, cost: boltCount * pr.fastenerPc },
    { name: `Пластина-шайба ${wp.plateSize}×${wp.plateSize}×8 мм`, count: boltCount,
      note: 'с внутренней стороны стены, под гайку с шайбой', mass: plateMass, cost: 0 },
  ];

  // узлы крепления стропил: на каждое стропило два узла — у прогона и у стены
  const nRafters = m.rafters.xs.length;
  const tieF = result.ties.outer.fastener;
  const tieCount = (result.ties.outer.need + result.ties.wall.need) * nRafters;
  if (tieF.kind === 'bolt') {
    fasteners.push({
      name: `Болт ${tieF.short.replace('болт ', '')} с гайкой и шайбами`, count: tieCount,
      note: `крепление стропил: ${result.ties.outer.need} шт у прогона и ${result.ties.wall.need} у стены на каждое`,
      // болты и метизы считаются по массе металла, уголки — поштучно
      mass: tieCount * fastenerMass(tieF), cost: tieCount * fastenerMass(tieF) * pr.steelKg,
    });
  } else {
    const angles = 4 * nRafters; // по два уголка на узел, узла два
    fasteners.push({
      name: 'Уголок крепёжный 90×90×65×2', count: angles,
      note: 'по два на узел, с обеих сторон стропила', mass: angles * ANGLE_MASS,
      cost: angles * (pr.anglePc ?? 0),
    });
    fasteners.push({
      name: tieF.short.charAt(0).toUpperCase() + tieF.short.slice(1), count: tieCount,
      note: `${result.ties.outer.need} шт у прогона и ${result.ties.wall.need} у стены на каждое стропило`,
      mass: tieCount * fastenerMass(tieF), cost: tieCount * fastenerMass(tieF) * pr.steelKg,
    });
  }

  for (const [side, bt, row] of [
    ['наружного ряда', result.beamTies.outer, m.posts],
    ['у стены', result.beamTies.wall, m.wallPosts],
  ]) {
    const n = row.xs.length;
    if (bt.welded) {
      fasteners.push({
        name: `Сварной шов оголовка ${side}`, count: n,
        note: `${Math.round(bt.weldLength)} мм по контуру, катет ${bt.tie.kf} мм`, mass: 0, cost: 0,
      });
    } else {
      const plate = Math.max(160, (bt.post.b ?? 100) + 80);
      const plateMassOne = plate * plate * 8 * 7.85e-6;
      const bolts = bt.tie.n * n;
      const boltMassOne = (Math.PI / 4) * bt.tie.d ** 2 * 120 * 7.85e-6 * 1.6;
      fasteners.push({
        name: `Пластина-оголовок ${plate}×${plate}×8 мм, ${side}`, count: n,
        note: 'приваривается на торец столба', mass: n * plateMassOne, cost: n * plateMassOne * pr.steelKg,
      });
      fasteners.push({
        name: `Болт М${bt.tie.d} класса ${bt.tie.grade}, узел ${side}`, count: bolts,
        note: `${bt.tie.n} шт на столб, с гайкой и шайбами`, mass: bolts * boltMassOne,
        cost: bolts * boltMassOne * pr.steelKg,
      });
    }
  }

  // накладки стыков: то, чего в смете не было совсем, хотя купить придётся
  for (const j of result.spliceJoints ?? []) {
    if (j.impossible) continue;
    const plates = 2 * j.count;
    const volume = (j.plateT * j.plateH * j.plateLength) / 1e9; // м³ одной накладки
    if (j.material === 'timber') {
      fasteners.push({
        name: `Накладка стыка ${j.plateT}×${j.plateH}×${j.plateLength} мм · ${j.label.toLowerCase()}`,
        count: plates, note: 'две на стык, с обеих сторон', mass: plates * volume * DENSITY.timber,
        cost: plates * volume * pr.timberM3,
      });
      const dowels = j.n * j.count;
      const dowelMass = (Math.PI / 4) * j.d ** 2 * (j.sec.b + 2 * j.plateT + 40) * 7.85e-6 * 1.6;
      fasteners.push({
        name: `Нагель М${j.d} с гайкой и шайбами · ${j.label.toLowerCase()}`, count: dowels,
        note: `${j.n} шт на стык, сетка ${j.cols}×${j.rows} с каждой стороны`,
        mass: dowels * dowelMass, cost: dowels * dowelMass * pr.steelKg,
      });
    } else {
      fasteners.push({
        name: `Накладка стыка ${j.plateT}×${j.plateH}×${j.plateLength} мм · ${j.label.toLowerCase()}`,
        count: plates, note: `две на стык, шов по контуру катетом ${j.kf} мм`,
        mass: plates * volume * DENSITY.steel, cost: plates * volume * DENSITY.steel * pr.steelKg,
      });
    }
  }

  const nAllPosts = m.posts.xs.length + m.wallPosts.xs.length;
  const pb = result.bases.outer.base;
  if (pb.kind === 'plate') {
    const plateMassOne = pb.plate * pb.plate * pb.t * 7.85e-6;
    const anchors = pb.n * nAllPosts;
    const anchorMassOne = (Math.PI / 4) * pb.d ** 2 * (pb.hef + 120) * 7.85e-6 * 1.5;
    fasteners.push({
      name: `Плита базы ${pb.plate}×${pb.plate}×${pb.t} мм`, count: nAllPosts,
      note: 'приваривается на нижний торец столба', mass: nAllPosts * plateMassOne,
      cost: nAllPosts * plateMassOne * pr.steelKg,
    });
    fasteners.push({
      name: `Анкер М${pb.d}, заделка ${pb.hef} мм`, count: anchors,
      note: `${pb.n} шт на столб, разнос ${result.bases.outer.span} мм`,
      mass: anchors * anchorMassOne, cost: anchors * anchorMassOne * pr.steelKg,
    });
  }

  const sum = (f) => items.filter(f).reduce((a, i) => a + (i.mass ?? 0), 0);
  const byName = (n) => items.find((i) => i.name === n)?.mass ?? 0;
  // всё, что висит над головой (без столбов) — это и есть постоянная нагрузка на кровлю
  const roofPartMass = byName('Стропила') + byName('Обрешётка') + byName('Обвязка у стены')
    + byName('Прогон наружный') + roofMass;
  const timberVolume = items.reduce((a, i) => a + (i.volume ?? 0), 0);
  const timberMass = sum((i) => i.material === 'сосна');
  const steelMass = sum((i) => i.material === 'сталь');
  const steelLength = items.filter((i) => i.material === 'сталь').reduce((a, i) => a + i.totalLength, 0);
  const fastenerTotal = fasteners.reduce((a, f) => a + f.mass, 0);
  const total = timberMass + steelMass + roofMass + fastenerTotal;
  const planArea = (m.geom.B * (m.geom.L + m.geom.a)) / 1e6; // м² в плане

  const groups = [
    { name: 'Кровельное покрытие', mass: roofMass, note: ROOFING[m.roofing].label },
    { name: 'Обрешётка', mass: byName('Обрешётка'), note: 'сосна' },
    { name: 'Стропила', mass: byName('Стропила'), note: 'сосна' },
    { name: 'Прогоны и обвязка', mass: byName('Прогон наружный') + byName('Обвязка у стены'), note: 'сталь + сосна' },
    { name: 'Столбы', mass: byName('Столбы наружные') + byName('Столбы у стены'), note: 'сталь' },
    { name: 'Метизы', mass: fastenerTotal, note: 'шпильки, пластины и крепёж узлов' },
  ];

  const weights = {
    timber: { volume: timberVolume, mass: timberMass, density: 500 },
    steel: { mass: steelMass, length: steelLength, density: 7850 },
    roofing: { area: roofArea, mass: roofMass, label: ROOFING[m.roofing].label },
    // fastenerMass — импортированная функция, а нужна посчитанная масса:
    // из-за этой опечатки отчёт падал на b.weights.fasteners.mass.toFixed
    fasteners: { mass: fastenerTotal, count: fasteners.reduce((a, f) => a + (f.count ?? 0), 0) },
    total,
    perSqm: total / planArea,
    planArea,
    /** нагрузка от собственного веса всей кровельной части, кПа по скату */
    deadPressure: (roofPartMass * G0) / roofArea / 1000,
    /** доля собственного веса в полной нагрузке у стены и в поле */
    deadShareWall: null,
    deadShareField: null,
    groups,
  };
  const dp = weights.deadPressure;
  weights.deadShareWall = dp / (dp + result.snow.at(0));
  weights.deadShareField = dp / (dp + result.snow.at(m.geom.L + m.geom.a));

  const costTimber = items.filter((i) => i.material === 'сосна').reduce((a, i) => a + i.cost, 0);
  const costSteel = items.filter((i) => i.material === 'сталь').reduce((a, i) => a + i.cost, 0);
  const costRoofing = roofArea * pr.roofingM2;
  const costFasteners = fasteners.reduce((a, f) => a + (f.cost ?? 0), 0);
  const costs = {
    currency: pr.currency ?? '₽',
    prices: pr,
    timber: costTimber,
    steel: costSteel,
    roofing: costRoofing,
    fasteners: costFasteners,
    total: costTimber + costSteel + costRoofing + costFasteners,
    perSqm: (costTimber + costSteel + costRoofing + costFasteners) / planArea,
    groups: [
      { name: 'Кровельное покрытие', cost: costRoofing, base: `${roofArea.toFixed(1)} м² × ${pr.roofingM2} ₽/м²` },
      { name: 'Сосна', cost: costTimber, base: `${timberVolume.toFixed(3)} м³ × ${pr.timberM3} ₽/м³` },
      { name: 'Сталь', cost: costSteel, base: `${steelMass.toFixed(0)} кг × ${pr.steelKg} ₽/кг` },
      { name: 'Метизы', cost: costFasteners, base: `${boltCount} компл. шпилек × ${pr.fastenerPc} ₽ и крепёж узлов` },
    ],
  };

  return { items, fasteners, weights, costs, timberVolume, timberMass, steelMass, steelLength, stock, total,
    spliceJoints: result.spliceJoints ?? [] };
}
