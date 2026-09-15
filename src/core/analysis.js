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
import { tributaries, levels, boltHeights } from './model.js';
import {
  timberBending, timberShear, timberCombined, timberLateral, timberBearing,
  steelBending, steelShear, steelStability, steelBeamColumn, steelSlenderness,
  steelLocalBuckling, deflectionCheck, worstOf,
  boltPlateBearing, boltHoleBearing, boltShear,
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

  const windUpPerp = (ctx.wind.up * trib) / 1000;
  const windDownPerp = (ctx.wind.down * trib) / 1000;

  // Схема Б.8 требует считать нижнее покрытие в двух вариантах — равномерном
  // и со снеговым мешком. За расчётное принимается худшее из них, причём
  // поэлементно: у стены правит мешок, в дальней части — равномерный снег.
  const solve = (q) => solveBeam({ length: Ls, supports, EI, GAs, q, nEl: 120 });
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
    x, trib, sec, mat, Ls, xSup, cantLen, N, Mmax, Vmax, spans,
    res,
    variant: lead.variant.label,
    reactions: {
      wall: Math.max(...byVariant.map((g) => g['ULS-1'].reactions[0].R)),
      purlin: Math.max(...byVariant.map((g) => g['ULS-1'].reactions[1].R)),
      wallUplift: uplift.reactions[0].R,
      purlinUplift: uplift.reactions[1].R,
      wallSls: Math.max(...byVariant.map((g) => g.SLS.reactions[0].R)),
      purlinSls: Math.max(...byVariant.map((g) => g.SLS.reactions[1].R)),
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

  const uls = solveBeam({ length: B, supports: xs, EI, GAs, q: () => deadD + GAMMA_F.snow * snowD, nEl: 160 });
  const sls = solveBeam({ length: B, supports: xs, EI, GAs, q: () => deadN + snowD, nEl: 160 });

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
    // покрытие лежит на обрешётке и пролётом для него служит её шаг,
    // а не расстояние между стропилами
    name: 'Пролёт под кровлю',
    value: sp, limit: ctx.dead.def.maxBatten, unit: 'мм',
    U: sp / ctx.dead.def.maxBatten,
    formula: 'шаг обрешётки ≤ допустимого пролёта покрытия',
    note: ctx.dead.def.label,
  });

  return { sec, mat, span, res: { uls, sls, point }, spans, ...worstOf(checks) };
}

/* ───────────────────── ПРОГОН И БРУС У СТЕНЫ ───────────────────── */

export function analyseLineBeam(model, sectionId, supports, loads, label) {
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

export function analyse(model) {
  const { ctx, dead, snow, wind, rafters, battens } = analyseRoof(model);
  const sl = supportLoads(model, { ctx, dead, snow, wind, rafters, battens });

  const purlin = analyseLineBeam(model, model.purlin.sectionId, sl.outer.supports, sl.outer.loads, sl.outer.label);
  const wallPurlin = analyseLineBeam(model, model.wallPurlin.sectionId, sl.wall.supports, sl.wall.loads, sl.wall.label);

  const posts = analysePostRow(model, model.posts, purlin, ctx, sl.outer.extra);
  const wallPosts = analysePostRow(model, model.wallPosts, wallPurlin, ctx, sl.wall.extra);

  const maxUplift = Math.max(0, ...posts.map((p) => p.Nup));
  const foundation = {
    uplift: maxUplift,
    requiredMass: maxUplift / 0.9 / 1000,
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
  ];

  return {
    model, ctx, dead, snow, wind,
    rafters, battens, purlin, wallPurlin, posts, wallPosts, foundation,
    thrust: sl.thrust,
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
  const G0 = 9.80665;
  const items = [];
  const add = (name, sec, lengthMm, count) => {
    const isT = sec.material === 'timber';
    const perStock = Math.max(1, Math.floor(stock / lengthMm));
    const volume = (sec.props.A * lengthMm * count) / 1e9; // м³
    const mass = (sec.massPerM * lengthMm * count) / 1000;
    items.push({
      name,
      section: sec.label,
      material: isT ? 'сосна' : 'сталь',
      count,
      length: Math.round(lengthMm),
      totalLength: (lengthMm * count) / 1000,
      stockPieces: lengthMm > stock ? null : Math.ceil(count / perStock),
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

  const sum = (f) => items.filter(f).reduce((a, i) => a + (i.mass ?? 0), 0);
  const byName = (n) => items.find((i) => i.name === n)?.mass ?? 0;
  // всё, что висит над головой (без столбов) — это и есть постоянная нагрузка на кровлю
  const roofPartMass = byName('Стропила') + byName('Обрешётка') + byName('Обвязка у стены')
    + byName('Прогон наружный') + roofMass;
  const timberVolume = items.reduce((a, i) => a + (i.volume ?? 0), 0);
  const timberMass = sum((i) => i.material === 'сосна');
  const steelMass = sum((i) => i.material === 'сталь');
  const steelLength = items.filter((i) => i.material === 'сталь').reduce((a, i) => a + i.totalLength, 0);
  const fastenerMass = fasteners.reduce((a, f) => a + f.mass, 0);
  const total = timberMass + steelMass + roofMass + fastenerMass;
  const planArea = (m.geom.B * (m.geom.L + m.geom.a)) / 1e6; // м² в плане

  const groups = [
    { name: 'Кровельное покрытие', mass: roofMass, note: ROOFING[m.roofing].label },
    { name: 'Обрешётка', mass: byName('Обрешётка'), note: 'сосна' },
    { name: 'Стропила', mass: byName('Стропила'), note: 'сосна' },
    { name: 'Прогоны и обвязка', mass: byName('Прогон наружный') + byName('Обвязка у стены'), note: 'сталь + сосна' },
    { name: 'Столбы', mass: byName('Столбы наружные') + byName('Столбы у стены'), note: 'сталь' },
    { name: 'Метизы', mass: boltMass + plateMass, note: 'шпильки и пластины' },
  ];

  const weights = {
    timber: { volume: timberVolume, mass: timberMass, density: 500 },
    steel: { mass: steelMass, length: steelLength, density: 7850 },
    roofing: { area: roofArea, mass: roofMass, label: ROOFING[m.roofing].label },
    fasteners: { mass: fastenerMass, count: boltCount * 2 },
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
      { name: 'Метизы', cost: costFasteners, base: `${boltCount} компл. × ${pr.fastenerPc} ₽` },
    ],
  };

  return { items, fasteners, weights, costs, timberVolume, timberMass, steelMass, steelLength, stock, total };
}
