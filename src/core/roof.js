/**
 * Кровельная часть цепочки: стропила, обрешётка, прогон и обвязка у стены
 * как балки, нагрузки от кровли на опоры.
 *
 * Единицы: мм, Н, Н/мм (= кН/м), МПа, кПа.
 */

import { section } from './sections.js';
import { propsFor } from './materials.js';
import { ROOFING, snowProfile, windPressure, GAMMA_F } from './loads.js';
import { solveBeam, deflectionSpans } from './beam.js';
import { tributaries, levels } from './model.js';
import {
  timberBending, timberShear, timberCombined, timberLateral, timberBearing, steelBending,
  steelShear, steelBeamColumn, steelLocalBuckling, deflectionCheck, worstOf, mechanismCheck,
} from './checks.js';
import { deg, stiffness, RAFTER_TRIM } from './common.js';
import { spliceScheme } from './splices.js';

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
  // γf по табл. 7.1 СП 20 — у каждого слоя по своему материалу: деревянная
  // обрешётка на стальном стропиле остаётся деревом (1,1, а не 1,05)
  const gammaOf = (material) => (material === 'timber' ? GAMMA_F.timber : GAMMA_F.steel);
  const gammaDead = gammaOf(sec.material);
  const gammaBatten = gammaOf(section(model.battens.sectionId).material);

  // погонные нагрузки, Н/мм, перпендикулярно скату
  const lineRoofN = (ctx.dead.roof * trib) / 1000;
  const lineBattenN = (ctx.dead.batten * trib) / 1000;
  const lineSelfN = sec.weight;
  const deadPerpN = (lineRoofN + lineBattenN + lineSelfN) * ca;
  const deadPerpD = (GAMMA_F.roofing * lineRoofN + gammaBatten * lineBattenN + gammaDead * lineSelfN) * ca;

  const windUpPerp = (ctx.wind.up * trib) / 1000;
  const windDownPerp = (ctx.wind.down * trib) / 1000;

  // Схема Б.8 требует считать нижнее покрытие в двух вариантах — равномерном
  // и со снеговым мешком. За расчётное принимается худшее из них, причём
  // поэлементно: у стены правит мешок, в дальней части — равномерный снег.
  const scheme = spliceScheme(model, Ls + RAFTER_TRIM, supports);
  const hinges = scheme.hinges.filter((x) => x < Ls);
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
  // одна постоянная нагрузка с коэффициентом 0,9 — то, что держит фундамент
  // от выпучивания (F в формуле (6.35) СП 22)
  const permanent = solve(() => GAMMA_F.relieving * deadPerpN);

  // определяющий вариант — тот, где больше момент в пролёте
  const peak = (r) => r.M.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const lead = byVariant.reduce((a, b) => (peak(b['ULS-1']) > peak(a['ULS-1']) ? b : a));
  const res = { 'ULS-1': lead['ULS-1'], 'ULS-2': lead['ULS-2'], 'ULS-3': uplift, SLS: lead.SLS };

  // огибающая по всем вариантам и сочетаниям
  let Mmax = 0, Vmax = 0, Mcant = 0;
  // опора — точка сетки эпюр (см. solveBeam), берётся ближайшая
  let iSup = 0;
  uplift.x.forEach((x, i) => { if (Math.abs(x - xSup) < Math.abs(uplift.x[iSup] - xSup)) iSup = i; });
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

  const w = worstOf(scheme.mechanism ? [mechanismCheck(scheme.loose)] : checks);
  return {
    x, trib, sec, mat, Ls, xSup, cantLen, N, Mmax, Vmax, spans, hinges,
    mechanism: scheme.mechanism ? scheme.loose : null,
    res,
    variant: lead.variant.label,
    reactions: {
      wall: Math.max(...byVariant.map((g) => g['ULS-1'].reactions[0].R)),
      purlin: Math.max(...byVariant.map((g) => g['ULS-1'].reactions[1].R)),
      wallUplift: uplift.reactions[0].R,
      purlinUplift: uplift.reactions[1].R,
      wallDead: permanent.reactions[0].R,
      purlinDead: permanent.reactions[1].R,
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

  const scheme = spliceScheme(model, B, xs, { always: true });
  const hinges = scheme.hinges;
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

  return {
    sec, mat, span, res: { uls, sls, point }, spans, hinges,
    mechanism: scheme.mechanism ? scheme.loose : null,
    ...worstOf(scheme.mechanism ? [mechanismCheck(scheme.loose)] : checks),
  };
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
  const scheme = spliceScheme(model, B, supports);
  const hinges = scheme.hinges;

  const uls = solveBeam({ length: B, supports, EI, GAs, q: () => self, point: loads.uls, hinges, nEl: 160 });
  const sls = solveBeam({ length: B, supports, EI, GAs, q: () => sec.weight, point: loads.sls, hinges, nEl: 160 });
  const up = solveBeam({ length: B, supports, EI, GAs, q: () => 0, point: loads.uplift, hinges, nEl: 160 });
  const dead = loads.dead
    ? solveBeam({ length: B, supports, EI, GAs, q: () => GAMMA_F.relieving * sec.weight, point: loads.dead, hinges, nEl: 160 })
    : null;

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
  return {
    label, sec, mat, res: { uls, sls, up }, spans, hinges, reactions: uls.reactions, uplift: up.reactions,
    dead: dead?.reactions ?? null,
    mechanism: scheme.mechanism ? scheme.loose : null,
    ...worstOf(scheme.mechanism ? [mechanismCheck(scheme.loose)] : checks),
  };
}

/* ─────────────────────── КРОВЛЯ ЦЕЛИКОМ ─────────────────────── */

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
  // вдоль стены стропила на шарнирах не держат: доля ветра на торец кровли,
  // которая приходится на наружную опору стропила, идёт в наружный ряд —
  // в консоли столбов или в крест. Реакция равномерной нагрузки по длине
  // L + a на опоре L. Шпильки у стены по-прежнему считаются на всю силу:
  // если кровля всё же работает диском, вся она уходит к дому — в запас
  const alongOuter = alongWall * Math.min(1, (geom.L + geom.a) / (2 * geom.L));

  return {
    roof,
    ctx: roof.ctx,
    thrust: { total: thrust, roof: thrustRoof, fascia: thrustFascia, alongWall, alongOuter },
    outer: {
      beamKey: 'purlin', postsKey: 'posts', label: 'Прогон по столбам',
      supports: [...model.posts.xs].sort((a, b) => a - b),
      loads: { uls: pick('purlin'), sls: pick('purlinSls'), uplift: pick('purlinUplift'), dead: pick('purlinDead') },
      extra: { braced: false, thrust: 0, alongWall: alongOuter },
    },
    wall: {
      beamKey: 'wallPurlin', postsKey: 'wallPosts', label: 'Обвязка у стены',
      supports: [...model.wallPosts.xs].sort((a, b) => a - b),
      loads: { uls: pick('wall'), sls: pick('wallSls'), uplift: pick('wallUplift'), dead: pick('wallDead') },
      extra: { braced: true, thrust, alongWall },
    },
  };
}
