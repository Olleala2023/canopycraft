/**
 * Столбы и связи: расчётные длины из схемы связей, ряд столбов под прогоном,
 * крест в ряду и диагонали в плоскости кровли.
 */

import { section } from './sections.js';
import { propsFor } from './materials.js';
import { GAMMA_F } from './loads.js';
import { solveBeam } from './beam.js';
import { levels, boltHeights } from './model.js';
import {
  timberCombined, steelStability, steelBeamColumn, steelSlenderness, steelLocalBuckling, worstOf,
  phiBuckling, steelBeamColumn2, qFic, braceTension, braceSlenderness, boltPlateBearing,
  boltHoleBearing, boltShear, tieShear, weldMetal, weldFusion, weldLeg,
} from './checks.js';
import { shearCapacity, weldLine, weldMinLeg, WELD } from './fasteners.js';
import { TIE_TARGET } from './ties.js';

/* ───────────────────────── СТОЛБЫ ───────────────────────── */

/**
 * Коэффициенты расчётной длины из схемы: μ не выбирается, а следует из того,
 * что держит верх столба. Раскреплённому верху даём 1,0, а не 0,7: для 0,7
 * нужно ещё и защемление внизу, а на него база не рассчитывается — в запас.
 *
 *   стеновой ряд — притянут к стене шпильками, в обеих плоскостях 1,0;
 *   наружный поперёк ряда — верх держат стропила, распорки до стены: 1,0,
 *     их крепление и обвязка у стены на это усилие проверяются;
 *   наружный вдоль стены — стропила на шарнирах держать не могут, это
 *     параллелограмм; 1,0 только при кресте в ряду, иначе консоль, 2,0.
 */
export function postMu(model, row) {
  if (row === 'wall') return { muX: 1, muY: 1, heldX: 'стена', heldY: 'стена' };
  const along = model.bracing?.along;
  const held = along === 'cross' ? 'крест' : along === 'roof' ? 'диагонали по кровле' : null;
  return { muX: 1, muY: held ? 1 : 2, heldX: 'стропила', heldY: held };
}

/** Отступ точек крепления диагоналей креста от базы и от оголовка, мм. */
export const CROSS_INSET = 150;

/**
 * Пролёты наружного ряда, в которых стоит крест: крайний или оба крайних.
 * Индексы — по столбам ряда слева направо.
 */
export function crossBays(model, xs) {
  if (model.bracing?.along !== 'cross' || xs.length < 2) return [];
  const s = [...xs].sort((a, b) => a - b);
  const pairs = [[0, 1]];
  if ((model.bracing.bays ?? 1) >= 2 && s.length >= 3) pairs.push([s.length - 2, s.length - 1]);
  return pairs.map(([i, j]) => ({ i, j, x0: s[i], x1: s[j], span: s[j] - s[i] }));
}

/** Геометрия диагонали: высота между точками крепления, длина и доли усилия. */
function crossGeometry(H, span) {
  const hd = Math.max(100, H - 2 * CROSS_INSET);
  const length = Math.hypot(span, hd);
  // горизонтальная сила F растягивает диагональ усилием F·l/s и тянет
  // столбы пролёта по вертикали силой F·h/s — один вверх, другой вниз
  return { hd, length, tension: length / span, vertical: hd / span };
}

/**
 * Ряд столбов под прогоном.
 * @param {object} cfg model.posts или model.wallPosts
 * @param {object} purlin результат расчёта прогона, лежащего на этом ряду
 * @param {{braced:boolean, thrust:number, alongWall:number}} extra
 *   braced — столб раскреплён стеной (сквозные шпильки);
 *   thrust — горизонтальная сила поперёк ряда на весь ряд, Н (только у стены:
 *     наружный ряд свою отдаёт через стропила);
 *   alongWall — ветровая сила вдоль стены на весь ряд, Н.
 */
export function analysePostRow(model, cfg, purlin, ctx, extra) {
  const sec = section(cfg.sectionId);
  const mat = propsFor(sec, model.opts);
  const lv = levels(model);
  const wall = !!extra.braced;
  const H = wall ? lv.wallPostTop : lv.postTop;
  const mu = postMu(model, wall ? 'wall' : 'outer');
  // расчётные длины в двух плоскостях: поперёк ряда (x — к дому и от дома,
  // в этой же плоскости эксцентриситет опирания) и вдоль ряда (y — вдоль стены)
  const lefX = mu.muX * H;
  const lefY = mu.muY * H;
  const lef = Math.max(lefX, lefY);
  const fascia = sec.h + 200;
  const n = purlin.reactions.length;
  const EI = mat.E * sec.props.Ix;
  const GAs = mat.G * sec.props.As;
  const phiX = phiBuckling(lefX / sec.props.ix, mat.Ry, mat.E).phi;
  const phiY = phiBuckling(lefY / sec.props.iy, mat.Ry, mat.E).phi;
  const alongShare = (extra.alongWall ?? 0) / n;

  // первый проход: осевые силы и то, что уходит в связи
  const pre = purlin.reactions.map((r, i) => {
    const N = Math.max(0, r.R) + sec.weight * H * GAMMA_F.steel;
    const trib = i === 0 || i === n - 1 ? model.geom.B / (2 * Math.max(1, n - 1)) : model.geom.B / Math.max(1, n - 1);
    const Hwind = wall ? 0 : (ctx.wind.lateral * fascia * trib) / 1e6 * 1000;
    // верх, удержанный от смещения, связь обязана держать и без ветра:
    // условная поперечная сила от выпучивания самого столба
    const QficX = wall ? 0 : qFic(N, phiX, mat);
    const QficY = !wall && mu.heldY ? qFic(N, phiY, mat) : 0;
    // одна постоянная нагрузка при γ_f = 0,9 — против выпучивания морозом
    const Nperm = Math.max(0, purlin.dead?.[i]?.R ?? 0) + GAMMA_F.relieving * sec.weight * H;
    return { r, N, Hwind, QficX, QficY, Nperm, Nup: -(purlin.uplift[i]?.R ?? 0) };
  });

  // крест: вся сила вдоль ряда приходит по прогону в пролёт со связью
  const bays = wall ? [] : crossBays(model, pre.map((p) => p.r.x));
  const holdYTotal = mu.heldY && !wall ? pre.reduce((a, p) => a + alongShare + p.QficY, 0) : 0;
  const Fcross = bays.length ? holdYTotal / bays.length : 0;
  // в отрыв идёт только ветровая часть: условная сила — от сжатия столбов
  // под снегом, а отрыв считается при ветре без снега
  const FcrossWind = bays.length && mu.heldY && !wall ? (alongShare * n) / bays.length : 0;
  const down = new Map(), up = new Map();
  for (const b of bays) {
    const g = crossGeometry(H, b.span);
    for (const k of [b.i, b.j]) {
      down.set(k, (down.get(k) ?? 0) + Fcross * g.vertical);
      up.set(k, (up.get(k) ?? 0) + FcrossWind * g.vertical);
    }
  }

  return pre.map((p, i) => {
    const Vcross = down.get(i) ?? 0;
    const VcrossUp = up.get(i) ?? 0;
    // ветер в обе стороны: у каждого столба пролёта связь и прижимает, и отрывает
    const N = p.N + Vcross;
    const Nup = p.Nup + VcrossUp;
    const Mecc = N * model.opts.postEccentricity;

    let diagram, diagramY = null, bolts = null;
    let Hpost = 0, Hy = 0, Htie, Hbase, Mbase, My = 0;
    if (wall) {
      // столб держат сквозные шпильки — балка на опорах в их отметках плюс база
      Hpost = (extra.thrust ?? 0) / n;
      const zs = boltHeights(H, Math.max(1, cfg.boltCount));
      diagram = solveBeam({
        length: H, supports: [0, ...zs], EI, GAs,
        point: [{ x: H, P: Hpost }], moments: [{ x: H, M: Mecc }], nEl: 80,
      });
      const forces = diagram.reactions.slice(1).map((x) => Math.abs(x.R));
      const Nbolt = Math.max(0, ...forces);
      const Vbolt = Math.max(Math.max(0, Nup), (extra.alongWall ?? 0) / n) / Math.max(1, cfg.boltCount);
      bolts = { Nbolt, Vbolt, count: cfg.boltCount, heights: zs, forces };
      Htie = Hpost;
      Hbase = Hpost;
      Mbase = Math.abs(diagram.M[0]);
    } else {
      // поперёк ряда верх удержан стропилами: столб — стойка на двух опорах,
      // вверху момент от эксцентриситета опирания. Горизонтальная сила сюда
      // не идёт — её забирают стропила
      const nS = 121, x = new Float64Array(nS), M = new Float64Array(nS), V = new Float64Array(nS), w = new Float64Array(nS);
      for (let k = 0; k < nS; k++) {
        const z = (H * k) / (nS - 1);
        x[k] = z;
        M[k] = (Mecc * z) / H;
        V[k] = Mecc / H;
        w[k] = (Mecc * z * (H * H - z * z)) / (6 * EI * H);
      }
      diagram = { x, M, V, w, reactions: [{ x: 0, R: Mecc / H }], maxM: Mecc };
      if (!mu.heldY) {
        // вдоль стены верх свободен: консоль, защемлённая в фундаменте, и ветер
        // вдоль стены делится между столбами ряда
        Hy = alongShare;
        const xy = new Float64Array(nS), My_ = new Float64Array(nS), Vy = new Float64Array(nS), wy = new Float64Array(nS);
        const EIy = mat.E * sec.props.Iy;
        for (let k = 0; k < nS; k++) {
          const z = (H * k) / (nS - 1);
          xy[k] = z;
          Vy[k] = Hy;
          My_[k] = Hy * (H - z);
          wy[k] = (Hy * z * z * (3 * H - z)) / 6 / EIy;
        }
        diagramY = { x: xy, M: My_, V: Vy, w: wy, reactions: [{ x: 0, R: Hy }], maxM: My_[0] };
        My = Hy * H;
      }
      // через узел «прогон — столб» проходит то, что столб отдаёт связям,
      // а у столба с крестом — ещё и вся сила вдоль ряда, собранная прогоном
      const tieY = mu.heldY ? (Vcross ? Fcross : p.QficY) : Hy;
      Htie = Math.hypot(p.QficX, tieY);
      // база: низ диагонали креста упирается в базу своего столба
      Hbase = Math.abs(Hy) + (Vcross ? Fcross : 0);
      // поперёк ряда низ столба при удержанном верхе принимается шарниром,
      // но плита с анкерами часть момента всё равно заберёт: при защемлении
      // внизу это половина верхнего — её и даём базе, в запас
      Mbase = Math.abs(Mecc) / 2 + Math.abs(My);
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
      wall
        ? steelBeamColumn(N, M, sec.props, mat, lefX, 'x')
        : steelBeamColumn2(N, M, My, sec.props, mat, lefX, lefY),
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
      x: p.r.x, N, M, My, Nup, Nperm: p.Nperm, Hpost, Hy, Htie, Hbase, Mbase, sec, mat, lef, lefX, lefY, H, bolts,
      diagram, diagramY, braced: wall, muX: mu.muX, muY: mu.muY,
      // что столб отдаёт тем, кто держит его верх
      Hwind: p.Hwind, QficX: p.QficX, QficY: p.QficY,
      holdX: p.Hwind + p.QficX,
      holdY: mu.heldY && !wall ? alongShare + p.QficY : 0,
      Vcross, VcrossUp,
      ...worstOf(checks),
    };
  });
}

/** Болт крепления диагонали к деревянному элементу и наибольшее их число в узле. */
export const BRACE_BOLT = { d: 12, grade: '5.8', max: 4 };

/**
 * Крепление конца диагонали к балке: к стальной — шов по контуру торца, к
 * деревянной — болты М12 как нагели (табл. 20 СП 64): число подбирается с
 * тем же запасом 0,85, что у крепежа стропил, но не больше четырёх — больше
 * в торец диагонали не поставить.
 */
function braceEnd(T, brace, beam, where) {
  if (beam.sec.material === 'steel') {
    const tMin = Math.min(brace.t ?? 2, beam.sec.t ?? 3);
    const kfMin = weldMinLeg(Math.max(brace.t ?? 2, beam.sec.t ?? 3));
    const kfMax = 1.2 * tMin;
    const kf = kfMin;
    const line = weldLine(brace.b, brace.h);
    const note = `${where}: шов ${Math.round(line.length)} мм по контуру торца ${brace.label}, катет ${kf} мм`;
    const checks = [
      weldMetal(T / (WELD.betaF * kf * line.length), WELD.Rwf, note),
      weldFusion(T / (WELD.betaZ * kf * line.length), beam.mat.Run, note),
      weldLeg(kf, kfMin, kfMax, `${where}: стенки ${brace.t} и ${beam.sec.t} мм`),
    ];
    return { where, welded: true, kf, weldLength: line.length, checks };
  }
  const cap = shearCapacity({ kind: 'bolt', d: BRACE_BOLT.d, len: 0 }, { woodWidth: beam.sec.b, mv: beam.mat.mv ?? 1 });
  const n = Math.min(BRACE_BOLT.max, Math.max(1, Math.ceil(T / (TIE_TARGET * cap.T))));
  const dowel = tieShear(T, n, cap.T, `${where}: ${n} × М${BRACE_BOLT.d} в ${beam.sec.label}, T = ${(cap.T / 1000).toFixed(2).replace('.', ',')} кН · ${cap.governs}`);
  dowel.name = `Болты в древесине — ${where}`;
  const shear = boltShear(T / n, BRACE_BOLT.d, BRACE_BOLT.grade);
  shear.name = `Срез болта — ${where}`;
  return { where, welded: false, n, T1: cap.T, checks: [dowel, shear] };
}

/**
 * Диагонали в плоскости кровли: горизонтальная ферма в крайней ячейке.
 *
 * Пояса фермы — наружный прогон и обвязка у стены, стойки — крайние стропила
 * ячейки, раскосы — две диагонали, работающие на растяжение по очереди.
 * Сила вдоль стены — ветер, пришедший на наружный ряд, и условные поперечные
 * силы его столбов — приходит по прогону в ячейку и уходит по обвязке в
 * шпильки у дома. Столбы вертикали от связи не получают, в отличие от креста.
 *
 * Ячейка узкая и длинная: ширина w — один-три шага стропил, длина — скат
 * между опорами L_ск. Диагональ почти параллельна стропилам, поэтому:
 *   растяжение диагонали  T = F·l/w,  l = √(w² + L_ск²)
 *   продольная в стропиле N = F·L_ск/w — в сжатие одному, в растяжение другому
 * Оба крайних стропила проверяются на сжатие с изгибом с этой добавкой — ветер
 * дует в обе стороны.
 */
export function analyseRoofBrace(model, posts, rafters, beams) {
  if (model.bracing?.along !== 'roof' || rafters.length < 2) return null;
  const sec = section(model.bracing.sectionId);
  const mat = propsFor(sec, model.opts);
  const xs = rafters.map((r) => r.x);
  const k = Math.min(Math.max(1, model.bracing.roofBays ?? 2), xs.length - 1);
  const w = xs[k] - xs[0];
  const Lr = rafters[0].xSup;                              // скат между опорами, мм
  const length = Math.hypot(w, Lr);
  const wind = posts.reduce((a, p) => a + (p.holdY - p.QficY), 0);
  const qfic = posts.reduce((a, p) => a + p.QficY, 0);
  const F = wind + qfic;
  const T = (F * length) / w;
  const Nchord = (F * Lr) / w;
  const i = Math.min(sec.props.ix, sec.props.iy);
  const lambda = length / i;
  const f2 = (v) => (v / 1000).toFixed(2).replace('.', ',');

  const ends = [
    braceEnd(T, sec, beams.purlin, 'у прогона'),
    braceEnd(T, sec, beams.wallPurlin, 'у обвязки'),
  ];
  // крайние стропила ячейки — стойки фермы: к их сжатию добавляется N
  const chords = [rafters[0], rafters[k]].map((r, j) => {
    const N = r.N + Nchord;
    const c = r.sec.material === 'timber'
      ? timberCombined(N, r.Mmax, r.sec, r.mat, r.xSup / (r.sec.h / Math.sqrt(12)))
      : steelBeamColumn(N, r.Mmax, r.sec.props, r.mat, r.xSup, 'x');
    c.name = `Стропило ${j === 0 ? 1 : k + 1} — стойка связевой фермы`;
    c.note = `${c.note ?? ''}; N = ${f2(r.N)} + ${f2(Nchord)} кН от фермы`;
    return c;
  });
  const checks = [
    braceTension(T, sec.props.A, mat,
      `${sec.label}: ветер ${f2(wind)} + условная сила столбов ${f2(qfic)} кН, ячейка ${Math.round(w)} × ${Math.round(Lr)} мм`),
    braceSlenderness(lambda, `l = ${Math.round(length)} мм, i = ${i.toFixed(1).replace('.', ',')} мм`),
    ...ends.flatMap((e) => e.checks),
    ...chords,
  ];
  return {
    kind: 'roof', sec, mat, bays: k, count: 2, F, wind, qfic, T, Nchord, w, Lr, length, lambda,
    x0: xs[0], x1: xs[k], ends, rafterIdx: [0, k],
    ...worstOf(checks),
  };
}

/**
 * Крест в наружном ряду: две диагонали в пролёте между столбами, работают на
 * растяжение по очереди — при ветре в одну сторону тянет одна, в другую —
 * другая. Сжатую диагональ не учитываем: тонкая, она выпучится сразу.
 *
 * Держит всю силу вдоль ряда: ветер, пришедший на наружный ряд, и условные
 * поперечные силы всех столбов ряда — прогон собирает их в пролёт со связью.
 * Диагональ приварена к столбам швом по контуру торца.
 */
export function analyseCross(model, posts) {
  const bays = crossBays(model, posts.map((p) => p.x));
  if (!bays.length) return null;
  const sec = section(model.bracing.sectionId);
  const mat = propsFor(sec, model.opts);
  const post = posts[0].sec;
  const H = posts[0].H;
  const wind = posts.reduce((a, p) => a + (p.holdY - p.QficY), 0);
  const qfic = posts.reduce((a, p) => a + p.QficY, 0);
  const F = (wind + qfic) / bays.length;
  // худший пролёт — самый короткий: там диагональ круче и усилие в ней больше
  const bay = bays.reduce((a, b) => (b.span < a.span ? b : a));
  const g = crossGeometry(H, bay.span);
  const T = F * g.tension;
  const V = F * g.vertical;
  const Vup = (wind / bays.length) * g.vertical;
  const i = Math.min(sec.props.ix, sec.props.iy);
  const lambda = g.length / i;

  const tMin = Math.min(sec.t ?? 2, post.t ?? 3);
  const kfMin = weldMinLeg(Math.max(sec.t ?? 2, post.t ?? 3));
  const kfMax = 1.2 * tMin;
  const kf = kfMin;
  const line = weldLine(sec.b, sec.h);
  const tauF = T / (WELD.betaF * kf * line.length);
  const tauZ = T / (WELD.betaZ * kf * line.length);
  const weldNote = `шов ${Math.round(line.length)} мм по контуру торца ${sec.label}, катет ${kf} мм`;
  const f2 = (v) => (v / 1000).toFixed(2).replace('.', ',');

  const checks = [
    braceTension(T, sec.props.A, mat,
      `${sec.label}: ветер ${f2(wind / bays.length)} + условная сила столбов ${f2(qfic / bays.length)} кН, диагональ ${Math.round(g.length)} мм`),
    braceSlenderness(lambda, `l = ${Math.round(g.length)} мм, i = ${i.toFixed(1).replace('.', ',')} мм`),
    weldMetal(tauF, WELD.Rwf, weldNote),
    weldFusion(tauZ, mat.Run, weldNote),
    weldLeg(kf, kfMin, kfMax, `стенки ${sec.t} и ${post.t} мм`),
  ];
  return {
    sec, mat, bays, count: 2 * bays.length, F, T, V, Vup, wind, qfic,
    span: bay.span, hd: g.hd, length: g.length, lambda,
    kf, weldLength: line.length, tauF, tauZ,
    ...worstOf(checks),
  };
}
