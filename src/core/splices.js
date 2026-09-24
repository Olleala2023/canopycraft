/**
 * Стыки по длине: где элемент длиннее хлыста, как стык меняет расчётную
 * схему (шарнир встык на опоре или неразрезность с накладкой) и расчёт
 * самой накладки.
 */

import { levels, splicePlan } from './model.js';
import { worstOf, weldMetal, weldFusion, weldLeg, spliceDowel, splicePlateBending } from './checks.js';
import {
  weldLine, weldMinLeg, WELD, dowelDouble, SPLICE_PLATES, SPLICE_DOWELS,
  SPLICE_GAP,
} from './fasteners.js';
import { deg, RAFTER_TRIM } from './common.js';

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
  return spliceScheme(model, length, supports, opts).hinges;
}

/**
 * Расчётная схема элемента со стыками встык: где шарниры и держится ли она.
 *
 * Кусок между стыками встык меньше чем на двух опорах — механизм. Решатель
 * такую систему всё равно «решит»: матрица вырождена, прогиб выходит порядка
 * 10¹² мм, а нагрузка с болтающегося куска в реакции не попадает. Поэтому для
 * изменяемой схемы шарниры не отдаются вовсе: элемент решается неразрезным —
 * таким он станет, если стык перекрыть накладкой, — и по этим реакциям
 * нагрузка идёт дальше по цепочке. Сам элемент при этом не проверяется:
 * вместо проверок у него одна «Изменяемая схема» с U = ∞ (mechanismCheck).
 *
 * @returns {{hinges:number[], loose:object[], mechanism:boolean}}
 *   hinges — стыки для решателя; loose — куски меньше чем на двух опорах
 */
export function spliceScheme(model, length, supports = [], opts = {}) {
  // обрешётку стыкуют на стропиле внахлёст, накладок на неё не ставят —
  // для неё стык всегда работает шарниром, какой бы тип ни был выбран
  if (!opts.always && (model.opts.spliceJoint ?? 'butt') !== 'butt') return { hinges: [], loose: [], mechanism: false };
  const stock = model.opts.stockLength ?? 6000;
  const plan = splicePlan(length, stock, supports, { onSupports: true });
  const loose = plan.splices ? plan.cuts.filter((c) => c.unstable) : [];
  if (loose.length) return { hinges: [], loose, mechanism: true };
  return { hinges: plan.at.filter((x) => x > 0 && x < length), loose, mechanism: false };
}

export function spliceReport(model) {
  const { geom } = model;
  const stock = model.opts.stockLength ?? 6000;
  const ca = Math.cos(deg(geom.alpha));
  const lv = levels(model);
  const parts = [
    { key: 'rafters', label: 'Стропило', beam: true,
      length: (geom.L + geom.a) / ca + RAFTER_TRIM, supports: [0, geom.L / ca] },
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
