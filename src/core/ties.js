/**
 * Узлы крепления: стропило к опоре (отрыв, срез крепежа, расстановка) и
 * прогон к столбу.
 */

import { section } from './sections.js';
import { propsFor } from './materials.js';
import { solveBeam } from './beam.js';
import { tributaries } from './model.js';
import {
  worstOf, lateralBending, boltShear, tieShear, tieFit, steelHoleBearing,
  weldMetal, weldFusion, weldLeg, boltTension, timberWasherBearing,
} from './checks.js';
import {
  fastener, shearCapacity, fitCount, spacingRules, SELF_DRILL_D, beamTie,
  weldLine, weldMinLeg, WELD, BOLT_RT, BOLT_AN, WASHER_SIDE,
} from './fasteners.js';

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
export const TIE_TARGET = 0.85;

function analyseTie(model, rafters, side, support, ctx, hold = 0) {
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
  const slope = side === 'outer' ? Math.abs(worst.r.reactions.alongUplift) : 0;
  // стропило — распорка, которой держится верх наружного ряда: через узел
  // идёт то, что ряд отдаёт стропилам, а у стены — ещё и ветер на кровлю.
  // Сила горизонтальная, вдоль стропила; складываем её со скатной по модулю,
  // не раскладывая по углу, — в запас
  const along = slope + hold;
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
    side, fastener: f, force, uplift, along, slope, hold, T, need, fit, spacing: sp,
    penetration: cap.pen, governs: cap.governs,
    support: supSec, x: worst.r.x,
    ...worstOf(checks),
  };
}

/**
 * @param {{outer:number, wall:number}} [hold] горизонтальная сила на одно
 *   стропило, Н: сколько приходится держать узлу у прогона и у стены
 */
export function analyseTies(model, rafters, ctx, hold = { outer: 0, wall: 0 }) {
  return {
    outer: analyseTie(model, rafters, 'outer', model.purlin, ctx, hold.outer),
    wall: analyseTie(model, rafters, 'wall', model.wallPurlin, ctx, hold.wall),
  };
}

/**
 * Обвязка у стены из своей плоскости. Стропила упираются в неё и приносят
 * горизонтальную силу: ветер на кровлю и то, что держит верх наружного ряда.
 * Между стеновыми столбами обвязка работает балкой на ребро — считаем её
 * неразрезной на тех же опорах и с теми же стыками, что и в плоскости.
 * Прижимает ли её к стене — неизвестно, поэтому стена в расчёт не берётся.
 */
export function wallPurlinLateral(model, beam, supports, Htotal) {
  const sec = beam.sec;
  const mat = beam.mat;
  const xs = [...model.rafters.xs].sort((a, b) => a - b);
  const tr = tributaries(xs, model.geom.B);
  const point = xs.map((x, i) => ({ x, P: (Htotal * tr[i]) / model.geom.B }));
  const EI = mat.E * sec.props.Iy;
  const res = solveBeam({ length: model.geom.B, supports, EI, point, hinges: beam.hinges ?? [], nEl: 120 });
  let M = 0;
  for (let k = 0; k < res.M.length; k++) if (Math.abs(res.M[k]) > Math.abs(M)) M = res.M[k];
  const R = sec.material === 'timber' ? mat.Rbend : mat.Ry * mat.gammaC;
  const f2 = (v) => (v / 1000).toFixed(2).replace('.', ',');
  return lateralBending(M, sec.props.Wy, R,
    `${f2(Htotal)} кН на ${xs.length} стропил, M_y = ${f2(Math.abs(M) / 1000)} кН·м, W_y = ${Math.round(sec.props.Wy / 1000)} см³`);
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
  const post = posts.reduce((a, p) => (p.Nup > a.Nup || (p.Nup === a.Nup && p.Htie > a.Htie) ? p : a));
  const uplift = Math.max(0, post.Nup);
  const H = Math.abs(post.Htie);
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
