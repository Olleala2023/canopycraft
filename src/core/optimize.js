/** Автоподбор сечений и шагов. */
import { ladder, section } from './sections.js';
import { analyse } from './analysis.js';
import { spread } from './model.js';
import { FASTENERS, BEAM_TIES, POST_BASES, CONCRETE_DENSITY } from './fasteners.js';

const PATH = {
  rafters: (m, id) => ({ ...m, rafters: { ...m.rafters, sectionId: id } }),
  battens: (m, id) => ({ ...m, battens: { ...m.battens, sectionId: id } }),
  purlin: (m, id) => ({ ...m, purlin: { ...m.purlin, sectionId: id } }),
  wallPurlin: (m, id) => ({ ...m, wallPurlin: { ...m.wallPurlin, sectionId: id } }),
  wallPosts: (m, id) => ({ ...m, wallPosts: { ...m.wallPosts, sectionId: id } }),
  posts: (m, id) => ({ ...m, posts: { ...m.posts, sectionId: id } }),
  bracing: (m, id) => ({ ...m, bracing: { ...m.bracing, sectionId: id } }),
};

/** Помещается ли катет шва диагонали креста между стенками — 0, если креста нет. */
export const crossWeldFit = (r) => r.cross?.checks.find((c) => c.name === 'Катет шва')?.U ?? 0;

/** Коэффициент использования по группе элементов. */
export const U_OF = {
  rafters: (r) => Math.max(...r.rafters.map((x) => x.U)),
  battens: (r) => r.battens.U,
  purlin: (r) => r.purlin.U,
  wallPurlin: (r) => r.wallPurlin.U,
  wallPosts: (r) => Math.max(...r.wallPosts.map((x) => x.U)),
  // при кресте столб должен ещё и позволять приварить диагональ: к стенке 2 мм
  // по правилам катета не приварить ничего, и такой столб не годится
  posts: (r) => Math.max(...r.posts.map((x) => x.U), crossWeldFit(r)),
  // связей нет — подбирать нечего, годится любое сечение
  bracing: (r) => r.brace?.U ?? 0,
};

/**
 * Подобрать минимальное сечение элемента, при котором U ≤ target.
 * @returns {{id:string,U:number,tried:{id:string,U:number}[]}|null}
 */
export function pickSection(model, key, target = 0.95) {
  const current = section(model[key].sectionId);
  const candidates = ladder(current.material).filter((s) =>
    key === 'posts' || key === 'wallPosts' ? s.h === s.b || s.h / s.b <= 2
      // диагональ креста — квадратная труба: прямоугольная не дешевле по массе,
      // а в узле неудобна
      : key === 'bracing' ? s.h === s.b
      : true
  );
  const tried = [];
  for (const cand of candidates) {
    const m = PATH[key](model, cand.id);
    let U;
    try { U = U_OF[key](analyse(m)); } catch { continue; }
    tried.push({ id: cand.id, label: cand.label, U });
    if (U <= target) return { id: cand.id, label: cand.label, U, tried };
  }
  return null;
}

/**
 * Подобрать число стропил (шаг) при неизменном сечении.
 * @returns {{count:number,step:number,U:number}|null}
 */
export function pickRafterSpacing(model, target = 0.95, maxCount = 31) {
  for (let n = 4; n <= maxCount; n++) {
    const m = { ...model, rafters: { ...model.rafters, xs: spread(model.geom.B, n) } };
    const r = analyse(m);
    const U = Math.max(U_OF.rafters(r), r.battens.U);
    if (U <= target) return { count: n, step: model.geom.B / (n - 1), U };
  }
  return null;
}

/**
 * Подобрать узлы: крепление стропил и оба узла «прогон — столб».
 *
 * Каталоги упорядочены от простого и дешёвого к сложному (гвозди → саморезы →
 * болты; тонкий шов → толстый → пластина с болтами), поэтому первое
 * проходящее исполнение и есть то, которое стоит делать.
 *
 * Порог здесь 1,0, а не общий целевой запас: внутри узла запас уже заложен —
 * число крепежей подбирается с коэффициентом 0,85, — а вместимость узла и
 * катет шва величины дискретные, половины болта не бывает.
 */
/** Пределы бетонного блока при автоподборе — те же, что у ползунков в панели. */
const BLOCK_MAX = { side: 1200, depth: 3000 };
/** Размер с тем же целевым запасом 0,9, что и у сечений, округлённый до шага ползунка. */
const withMargin = (mm) => Math.ceil(mm / 0.9 / 50) * 50;

export function pickTies(model, target = 1) {
  let m = model;
  const log = [];
  // сначала ищем исполнение с запасом, и только если такого нет — впритык:
  // узел, набитый до последнего гвоздя, не прощает ни одной ошибки монтажа
  const tryAll = (key, list, U) => {
    for (const limit of [0.9 * target, target]) {
      for (const t of list) {
        const next = { ...m, [key]: { ...m[key], id: t.id } };
        let u;
        try { u = U(analyse(next)); } catch { continue; }
        if (u <= limit) { m = next; log.push({ key, label: t.label, U: u }); return; }
      }
    }
    log.push({ key, label: null, U: null });
  };
  // к деревянной балке не приварить — сварные исполнения для неё не предлагаем
  const forBeam = (key) => (section(m[key].sectionId).material === 'steel'
    ? BEAM_TIES
    : BEAM_TIES.filter((t) => t.kind !== 'weld'));
  tryAll('rafterTie', FASTENERS, (r) => Math.max(r.ties.outer.U, r.ties.wall.U));
  tryAll('purlinTie', forBeam('purlin'), (r) => r.beamTies.outer.U);
  tryAll('wallPurlinTie', forBeam('wallPurlin'), (r) => r.beamTies.wall.U);
  // блок фундамента — такой же подбираемый размер, как сечение: сначала растим
  // вглубь (копать дешевле, чем расширять яму), и только упёршись в предел —
  // вширь. Без этого никакое исполнение базы не пройдёт: вес блока общий
  m = { ...m, postBase: { ...m.postBase } };
  for (let i = 0; i < 8; i += 1) {
    const b = analyse(m).bases;
    // needDepth — глубина, которой хватит при нынешней стороне: она же растит
    // блок, когда его не хватает, и подрезает, когда он с лишним
    // как и сечения, блок подбирается до U ≤ 0,9, а не впритык к единице;
    // промерзание — требование геометрическое, запаса к нему не добавляем:
    // k_h = 1,1 уже внутри расчётной глубины
    const needDepth = Math.max(
      withMargin(Math.max(b.outer.needDepth, b.wall.needDepth)),
      b.outer.frost.needDepth,
    );
    if (needDepth <= BLOCK_MAX.depth) {
      if (m.postBase.depth === needDepth) break;
      m.postBase.depth = needDepth;
      continue;
    }
    // глубже уже нельзя — расширяем яму ровно настолько, чтобы хватило
    if (m.postBase.footing >= BLOCK_MAX.side) break;
    const needMass = Math.max(b.outer.needMass, b.wall.needMass);
    const sideAtMax = withMargin(Math.sqrt((needMass / CONCRETE_DENSITY) / (BLOCK_MAX.depth / 1000)) * 1000);
    m.postBase.footing = Math.min(BLOCK_MAX.side, Math.max(m.postBase.footing + 50, sideAtMax));
    m.postBase.depth = BLOCK_MAX.depth;
  }
  log.push({ key: 'postBase.block', label: `блок ${m.postBase.footing}×${m.postBase.footing}×${m.postBase.depth} мм`, U: null });

  // пучение исполнением базы не лечится — выбираем по всему остальному
  tryAll('postBase', POST_BASES, (r) => Math.max(r.bases.outer.Usized, r.bases.wall.Usized));
  // у забетонированного столба блок не может быть мельче заделки: если подбор
  // подрезал глубину ниже неё, в расчёт всё равно пойдёт заделка — приводим
  // ползунок к тому, что реально считается
  const chosen = POST_BASES.find((b) => b.id === m.postBase.id);
  if (chosen?.kind === 'embed' && m.postBase.depth < chosen.embed) {
    m = { ...m, postBase: { ...m.postBase, depth: chosen.embed } };
  }
  return { model: m, log };
}

/** Подобрать все элементы подряд, снизу вверх по цепочке. */
export function pickAll(model, target = 0.9) {
  let m = model;
  const log = [];
  for (const key of ['battens', 'rafters', 'purlin', 'wallPurlin', 'posts', 'wallPosts', 'bracing']) {
    if (key === 'bracing' && !['cross', 'roof'].includes(m.bracing?.along)) continue;
    const r = pickSection(m, key, target);
    if (r) {
      m = PATH[key](m, r.id);
      log.push({ key, label: r.label, U: r.U });
    } else {
      log.push({ key, label: null, U: null });
    }
  }
  // узлы подбираются последними: они зависят от того, какие сечения выбраны
  const ties = pickTies(m);
  return { model: ties.model, log: [...log, ...ties.log] };
}
