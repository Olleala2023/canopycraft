/**
 * Сборка расчёта: передача нагрузок по цепочке и проверки всех элементов.
 *
 * кровля → обрешётка → стропила → { прогон | брус у стены } → столбы → фундамент
 *
 * Единицы: мм, Н, Н/мм (= кН/м), МПа, кПа.
 */
import { section } from './sections.js';
import { propsFor } from './materials.js';
import { ROOFING, snowProfile, windPressure, GAMMA_F } from './loads.js';
import { solveBeam, deflectionSpans } from './beam.js';
import { tributaries } from './model.js';
import {
  timberBending, timberShear, timberCombined, timberLateral, timberBearing,
  steelBending, steelShear, steelStability, steelBeamColumn, steelSlenderness,
  steelLocalBuckling, deflectionCheck, worstOf,
} from './checks.js';

const deg = (d) => (d * Math.PI) / 180;

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

  const snowAt = (xs) => (ctx.snow.at(xs * ca) * trib) / 1000 * ca * ca;
  const windUpPerp = (ctx.wind.up * trib) / 1000;
  const windDownPerp = (ctx.wind.down * trib) / 1000;

  const combos = {
    'ULS-1': (xs) => deadPerpD + snowAt(xs),
    'ULS-2': (xs) => deadPerpD + snowAt(xs) + 0.9 * windDownPerp,
    'ULS-3': () => GAMMA_F.relieving * deadPerpN - windUpPerp,
    SLS: (xs) => deadPerpN + 0.7 * snowAt(xs),
  };

  const res = {};
  for (const [id, q] of Object.entries(combos)) {
    res[id] = solveBeam({ length: Ls, supports, EI, GAs, q, nEl: 120 });
  }

  // огибающая по ULS
  let Mmax = 0, Vmax = 0, Mcant = 0;
  const iSup = Math.round((xSup / Ls) * (res['ULS-1'].x.length - 1));
  for (const id of ['ULS-1', 'ULS-2', 'ULS-3']) {
    const r = res[id];
    for (let i = 0; i < r.M.length; i++) {
      if (Math.abs(r.M[i]) > Math.abs(Mmax)) Mmax = r.M[i];
      if (Math.abs(r.V[i]) > Math.abs(Vmax)) Vmax = r.V[i];
    }
    if (Math.abs(r.M[iSup]) > Math.abs(Mcant)) Mcant = r.M[iSup];
  }

  // осевое сжатие вдоль стропила (скатная составляющая), максимум у нижней опоры
  const qVertMax = (GAMMA_F.roofing * lineRoofN + gammaDead * (lineBattenN + lineSelfN)) +
    (ctx.snow.at(0) * trib) / 1000;
  const N = qVertMax * Ls * sa;

  const spans = deflectionSpans(res.SLS, Ls, supports).spans;
  const cantLen = Ls - xSup;
  const lambda = xSup / (sec.material === 'timber' ? sec.h / Math.sqrt(12) : sec.props.ix);

  const checks = [];
  if (sec.material === 'timber') {
    checks.push(timberBending(Mmax, sec.props.Wx, mat));
    checks.push(timberShear(Vmax, sec, mat));
    checks.push(timberCombined(N, Mmax, sec, mat, lambda));
    if (cantLen > 200) checks.push(timberLateral(Mcant, sec, mat, cantLen));
    checks.push(timberBearing(res['ULS-1'].reactions[1].R, sec, mat, model.opts.bearingLength));
  } else {
    checks.push(steelBending(Mmax, sec.props.Wx, mat));
    checks.push(steelShear(Vmax, sec.props, mat));
    checks.push(steelBeamColumn(N, Mmax, sec.props, mat, xSup, 'x'));
    checks.push(steelLocalBuckling(sec, mat, 0));
  }
  checks.push(deflectionCheck(spans, 200));

  const w = worstOf(checks);
  return {
    x, trib, sec, mat, Ls, xSup, cantLen, N, Mmax, Vmax, spans,
    res,
    reactions: {
      wall: res['ULS-1'].reactions[0].R,
      purlin: res['ULS-1'].reactions[1].R,
      wallUplift: res['ULS-3'].reactions[0].R,
      purlinUplift: res['ULS-3'].reactions[1].R,
      wallSls: res.SLS.reactions[0].R,
      purlinSls: res.SLS.reactions[1].R,
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
  const snowD = (ctx.snow.at(0) * sp) / 1000 * ca * ca;

  const uls = solveBeam({ length: B, supports: xs, EI, GAs, q: () => deadD + snowD, nEl: 160 });
  const sls = solveBeam({ length: B, supports: xs, EI, GAs, q: () => deadN + 0.7 * snowD, nEl: 160 });

  // сосредоточенная 1 кН (СП 20 п. 8.3.4) в середине наибольшего пролёта
  let span = 0, mid = B / 2;
  for (let i = 0; i + 1 < xs.length; i++) {
    if (xs[i + 1] - xs[i] > span) { span = xs[i + 1] - xs[i]; mid = (xs[i] + xs[i + 1]) / 2; }
  }
  const point = solveBeam({ length: B, supports: xs, EI, GAs, q: () => deadD, point: [{ x: mid, P: 1000 }], nEl: 160 });

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
    name: 'Пролёт под кровлю',
    value: span, limit: ctx.dead.def.maxBatten, unit: 'мм',
    U: span / ctx.dead.def.maxBatten,
    formula: 'шаг стропил ≤ допустимого пролёта покрытия',
    note: ctx.dead.def.label,
  });

  return { sec, mat, span, res: { uls, sls, point }, spans, ...worstOf(checks) };
}

/* ───────────────────── ПРОГОН И БРУС У СТЕНЫ ───────────────────── */

function analyseLineBeam(model, sectionId, supports, loads, label) {
  const sec = section(sectionId);
  const mat = propsFor(sec, model.opts);
  const { EI, GAs } = stiffness(sec, mat);
  const B = model.geom.B;
  const gammaDead = sec.material === 'timber' ? GAMMA_F.timber : GAMMA_F.steel;
  const self = sec.weight * gammaDead;

  const uls = solveBeam({ length: B, supports, EI, GAs, q: () => self, point: loads.uls, nEl: 160 });
  const sls = solveBeam({ length: B, supports, EI, GAs, q: () => sec.weight, point: loads.sls, nEl: 160 });
  const up = solveBeam({ length: B, supports, EI, GAs, q: () => 0, point: loads.uplift, nEl: 160 });

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
  return { label, sec, mat, res: { uls, sls, up }, spans, reactions: uls.reactions, uplift: up.reactions, ...worstOf(checks) };
}

/* ───────────────────────── СТОЛБЫ ───────────────────────── */

function analysePosts(model, purlin, ctx) {
  const sec = section(model.posts.sectionId);
  const mat = propsFor(sec, model.opts);
  const H = model.geom.postHeight;
  const lef = model.posts.mu * H;
  const fascia = sec.h + 200; // высота наветренной кромки навеса, мм

  return purlin.reactions.map((r, i) => {
    const N = Math.max(0, r.R) + sec.weight * H * GAMMA_F.steel;
    const trib = i === 0 || i === purlin.reactions.length - 1
      ? model.geom.B / (2 * Math.max(1, purlin.reactions.length - 1))
      : model.geom.B / Math.max(1, purlin.reactions.length - 1);
    // изгиб: боковой ветер на фризовую кромку + эксцентриситет опирания прогона
    const Hwind = (ctx.wind.lateral * fascia * trib) / 1e6 * 1000; // Н
    const Mwind = Hwind * H;
    const Mecc = N * model.opts.postEccentricity;
    const M = Mwind + Mecc;
    const Nup = -(purlin.uplift[i]?.R ?? 0);

    const stab = steelStability(N, sec.props, mat, lef, 'y');
    const bc = steelBeamColumn(N, M, sec.props, mat, lef, 'x');
    const checks = [
      stab,
      bc,
      steelSlenderness(stab.lambda, stab.U),
      steelLocalBuckling(sec, mat, stab.lb),
    ];
    return { x: r.x, N, M, Nup, sec, mat, lef, ...worstOf(checks) };
  });
}

/* ───────────────────────── ВСЁ ВМЕСТЕ ───────────────────────── */

export function analyse(model) {
  const { geom } = model;
  const dead = roofDead(model);
  const snow = snowProfile(model.site, geom.alpha);
  const zTop = geom.postHeight + geom.L * Math.tan(deg(geom.alpha));
  const wind = windPressure(model.site, zTop);
  const ctx = { dead, snow, wind };

  const xs = [...model.rafters.xs].sort((a, b) => a - b);
  const tribs = tributaries(xs, geom.B);
  const cache = new Map();
  const rafters = xs.map((x, i) => {
    const key = Math.round(tribs[i] * 10);
    if (!cache.has(key)) cache.set(key, analyseRafter(model, 0, tribs[i], ctx));
    const base = cache.get(key);
    return { ...base, x, index: i };
  });

  const pick = (key) => rafters.map((r) => ({ x: r.x, P: r.reactions[key] }));
  const posts = [...model.posts.xs].sort((a, b) => a - b);
  const purlin = analyseLineBeam(model, model.purlin.sectionId, posts,
    { uls: pick('purlin'), sls: pick('purlinSls'), uplift: pick('purlinUplift') }, 'Прогон по столбам');

  const anchors = [];
  for (let x = 0; x <= geom.B + 1; x += model.wallBeam.anchorSpacing) anchors.push(Math.min(x, geom.B));
  const wallBeam = analyseLineBeam(model, model.wallBeam.sectionId, anchors,
    { uls: pick('wall'), sls: pick('wallSls'), uplift: pick('wallUplift') }, 'Брус у стены');
  wallBeam.anchorForce = Math.max(...wallBeam.reactions.map((r) => r.R));
  wallBeam.anchorUplift = Math.max(0, ...wallBeam.uplift.map((r) => -r.R));

  const battens = analyseBattens(model, ctx);
  const postList = analysePosts(model, purlin, ctx);

  // фундамент — оценочно
  const maxUplift = Math.max(0, ...postList.map((p) => p.Nup));
  const foundation = {
    uplift: maxUplift,
    requiredMass: maxUplift / 0.9 / 1000, // кН
    cubeSide: Math.cbrt(Math.max(0.001, maxUplift / 0.9 / 1000 / 24)) * 1000, // мм, ρ_бетона 24 кН/м³
    maxDown: Math.max(...postList.map((p) => p.N)),
  };

  const all = [
    { key: 'battens', label: 'Обрешётка', U: battens.U, worst: battens.worst },
    { key: 'rafters', label: 'Стропила', U: Math.max(...rafters.map((r) => r.U)), worst: rafters.reduce((a, b) => (a.U > b.U ? a : b)).worst },
    { key: 'purlin', label: 'Прогон', U: purlin.U, worst: purlin.worst },
    { key: 'wallBeam', label: 'Брус у стены', U: wallBeam.U, worst: wallBeam.worst },
    { key: 'posts', label: 'Столбы', U: Math.max(...postList.map((p) => p.U)), worst: postList.reduce((a, b) => (a.U > b.U ? a : b)).worst },
  ];

  return {
    model, ctx, dead, snow, wind,
    rafters, battens, purlin, wallBeam, posts: postList, foundation,
    summary: all,
    maxU: Math.max(...all.map((a) => a.U)),
  };
}

/** Спецификация материалов. */
export function billOfMaterials(result) {
  const m = result.model;
  const items = [];
  const add = (name, sec, lengthMm, count) => {
    const total = (lengthMm * count) / 1000;
    const isT = sec.material === 'timber';
    items.push({
      name,
      section: sec.label,
      material: isT ? 'сосна' : 'сталь',
      count,
      length: lengthMm,
      totalLength: total,
      volume: isT ? (sec.props.A * lengthMm * count) / 1e9 : null,
      mass: !isT ? sec.props.A * lengthMm * count * 7.85e-6 : null,
    });
  };
  const ca = Math.cos(deg(m.geom.alpha));
  add('Стропила', section(m.rafters.sectionId), Math.round((m.geom.L + m.geom.a) / ca), m.rafters.xs.length);
  const nBatten = Math.floor((m.geom.L + m.geom.a) / ca / m.battens.spacing) + 1;
  add('Обрешётка', section(m.battens.sectionId), m.geom.B, nBatten);
  add('Прогон', section(m.purlin.sectionId), m.geom.B, 1);
  add('Брус у стены', section(m.wallBeam.sectionId), m.geom.B, 1);
  add('Столбы', section(m.posts.sectionId), m.geom.postHeight + 300, m.posts.xs.length);

  const timberVolume = items.filter((i) => i.volume).reduce((s, i) => s + i.volume, 0);
  const steelMass = items.filter((i) => i.mass).reduce((s, i) => s + i.mass, 0);
  return { items, timberVolume, steelMass };
}
