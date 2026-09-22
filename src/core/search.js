/**
 * Подбор конструкции по минимальной стоимости материалов.
 *
 * Полный перебор — десятки тысяч сочетаний, это минуты. Но цепочка почти
 * однонаправленная: стропила грузят прогоны, прогоны грузят столбы. Отсюда
 * поэтапный поиск с отсевом:
 *
 *   1. по каждому числу стропил подбирается самое дешёвое проходящее сечение
 *      стропила и под него — обрешётка;
 *   2. лучшие по цене варианты кровельной части идут дальше, для каждого
 *      перебираются число столбов и сечения прогонов и стоек;
 *   3. собранный вариант проверяется целиком.
 *
 * Наружный ряд перебирается в двух схемах: без связей и с крестом в крайнем
 * пролёте. Без связей столб — консоль, и его сечение определяет гибкость при
 * μ = 2; с крестом столбы легче, но появляются диагонали. Что дешевле, зависит
 * от высоты, числа столбов и цен — поэтому считаются обе, и в списке видно,
 * какая выбрана.
 *
 * Внутри одного материала стоимость пропорциональна площади сечения (дерево
 * считается по объёму, металл по массе), поэтому сортамент, упорядоченный по A,
 * упорядочен и по цене: первое прошедшее сечение при переборе снизу и есть
 * самое дешёвое.
 */
import { analyse, analyseRoof, analyseLineBeam, analysePostRow, analyseCross, supportLoads, billOfMaterials } from './analysis.js';
import { ladder, section } from './sections.js';
import { spread } from './model.js';
import { pickTies } from './optimize.js';

const clone = (m) => JSON.parse(JSON.stringify(m));

/**
 * Уступить управление интерфейсу, чтобы страница не замирала. Не на каждом
 * расчёте: setTimeout(0) сам по себе стоит миллисекунду-другую, и на тысяче
 * вызовов это складывается в секунды ожидания на ровном месте.
 */
const breathe = () => new Promise((r) => setTimeout(r, 0));
const maybeBreathe = (budget) => (budget.n % 40 === 0 ? breathe() : null);

/**
 * Характеристики, по которым одно сечение может быть «не хуже» другого:
 * моменты сопротивления и инерции в обеих плоскостях, радиусы инерции,
 * сдвиговая площадь. Если сечение не лучше ни по одной из них, оно не может
 * пройти там, где не прошло второе.
 */
const CAPACITY = ['Wx', 'Wy', 'Ix', 'Iy', 'ix', 'iy', 'As'];
const dominates = (a, b) => CAPACITY.every((k) => a.props[k] >= b.props[k] * (1 - 1e-9));

/**
 * Самое дешёвое проходящее сечение — перебором снизу, с отсевом заведомо
 * слабых.
 *
 * Двоичный поиск здесь неприменим: сортамент упорядочен по расходу материала,
 * а несущая способность вдоль него не монотонна. 40×40×3 дороже 50×50×2, но
 * хуже её и по моменту сопротивления, и по радиусу инерции; у 60×60×3 радиус
 * инерции меньше, чем у более дешёвой 60×60×2. На такой «пиле» двоичный поиск
 * перешагивает через проходящие дешёвые сечения — так столбы у стены
 * получались 100×100×3 там, где хватало 60×60×2.
 */
async function cheapest(list, evaluate, target, budget) {
  const failed = [];
  for (const s of list) {
    if (failed.some((f) => dominates(f, s))) continue;
    budget.n++;
    await maybeBreathe(budget);
    if (await evaluate(s) <= target) return s;
    failed.push(s);
  }
  return null;
}

/** Сортамент того же материала, что выбран сейчас, с разумным отсевом. */
function ladderFor(currentId, opts = {}) {
  const cur = section(currentId);
  return ladder(cur.material).filter((s) => {
    if (opts.minH && s.h < opts.minH) return false;
    if (opts.square && s.h !== s.b) return false;
    return true;
  });
}

/**
 * @param {object} model исходная модель
 * @param {object} [opts]
 * @param {number} [opts.target] целевой запас: подбираются варианты с U ≤ target
 * @param {number} [opts.limit] сколько вариантов вернуть
 * @param {number} [opts.keep] сколько кровельных вариантов пускать на второй этап
 * @param {(p:{done:number,total:number,stage:string})=>void} [opts.onProgress]
 */
export async function searchByCost(model, opts = {}) {
  const target = opts.target ?? 0.9;
  const limit = opts.limit ?? 10;
  const keep = opts.keep ?? 6;
  const started = Date.now();
  const budget = { n: 0 };
  const report = (stage, done, total) => opts.onProgress?.({ stage, done, total });

  const B = model.geom.B;
  const rafterList = ladderFor(model.rafters.sectionId, { minH: 100 });
  const battenList = ladderFor(model.battens.sectionId);
  const purlinList = ladderFor(model.purlin.sectionId);
  const wallPurlinList = ladderFor(model.wallPurlin.sectionId);
  const postList = ladderFor(model.posts.sectionId, { square: true });
  const wallPostList = ladderFor(model.wallPosts.sectionId, { square: true });
  // диагональ креста — квадратная труба небольшого сечения
  const braceList = ladder('steel').filter((s) => s.h === s.b && s.h <= 80);

  // разумный диапазон шага стропил: от 1200 до 300 мм
  const counts = [];
  for (let n = Math.max(3, Math.ceil(B / 1200) + 1); n <= Math.min(25, Math.ceil(B / 300) + 1); n++) counts.push(n);

  /* ── этап 1: стропила и обрешётка ──
     считается только кровельная часть: положение и сечения опор на неё не
     влияют, а расчёт стропил — самая дорогая часть полного анализа */
  const roofs = [];
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i];
    const m = clone(model);
    m.rafters.xs = spread(B, n);
    // сначала обрешётка: её пролёт — это шаг стропил, а сечение стропила на неё
    // не влияет. При редкой расстановке она может не пройти вовсе
    const bat = await cheapest(battenList, async (b) => {
      m.battens.sectionId = b.id;
      return analyseRoof(m).battens.U;
    }, target, budget);
    if (!bat) continue;
    m.battens.sectionId = bat.id;
    // стропила считаются уже под собственным весом выбранной обрешётки
    const sec = await cheapest(rafterList, async (s) => {
      m.rafters.sectionId = s.id;
      return Math.max(...analyseRoof(m).rafters.map((r) => r.U));
    }, target, budget);
    report('стропила', i + 1, counts.length);
    if (!sec) continue;
    m.rafters.sectionId = sec.id;
    const bom = billOfMaterials(analyse(m));
    const cost = bom.items.find((it) => it.name === 'Стропила').cost
      + bom.items.find((it) => it.name === 'Обрешётка').cost;
    roofs.push({ model: m, count: n, cost });
  }
  if (!roofs.length) return { options: [], evaluated: budget.n, ms: Date.now() - started };
  roofs.sort((a, b) => a.cost - b.cost);
  const finalists = roofs.slice(0, keep);

  /* ── этап 2: опоры ──
     наружный ряд и стеновой независимы: первый несёт реакции стропил на
     прогон, второй — реакции на обвязку. Поэтому они перебираются порознь,
     а не всеми сочетаниями: 6 + 6 вариантов вместо 36.
     Считается только сам ряд — балка и стойки под ней; кровля к этому моменту
     уже посчитана и её результат переиспользуется. */
  const options = [];
  const pickRow = async (m0, side, beamList, postList, items, along = null) => {
    // схема связей меняет μ наружных столбов, поэтому ряд считается в своей
    const m = along ? { ...m0, bracing: { ...m0.bracing, along, bays: 1 } } : m0;
    const sl = supportLoads(m);
    const cfg = sl[side];
    let best = null;
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const xs = spread(B, n);
      const beamSec = await cheapest(beamList, async (s) =>
        analyseLineBeam(m, s.id, xs, cfg.loads, cfg.label).U, target, budget);
      if (!beamSec) continue;
      const beam = analyseLineBeam(m, beamSec.id, xs, cfg.loads, cfg.label);
      const postCfg = m[cfg.postsKey];
      let postSec = null, brace = null;
      if (along === 'cross') {
        // столб с крестом проходит, только если к нему приваривается проходящая
        // диагональ: катет не меньше табличного и не больше 1,2 толщины стенки,
        // и к стенке 2 мм не приварить ничего. Отсев по доминированию здесь
        // не годится — отказ по шву с несущей способностью не монотонен
        for (const s of postList) {
          budget.n++;
          await maybeBreathe(budget);
          const row = analysePostRow(m, { ...postCfg, sectionId: s.id }, beam, sl.ctx, cfg.extra);
          if (Math.max(...row.map((p) => p.U)) > target) continue;
          const withPost = { ...m, [cfg.postsKey]: { ...postCfg, sectionId: s.id, xs } };
          const b = await cheapest(braceList, async (bs) =>
            analyseCross({ ...withPost, bracing: { ...m.bracing, sectionId: bs.id } }, row)?.U ?? Infinity, target, budget);
          if (b) { postSec = s; brace = b.id; break; }
        }
      } else {
        postSec = await cheapest(postList, async (s) => {
          const row = analysePostRow(m, { ...postCfg, sectionId: s.id }, beam, sl.ctx, cfg.extra);
          return Math.max(...row.map((p) => p.U));
        }, target, budget);
      }
      if (!postSec) continue;
      const t = clone(m);
      t[cfg.postsKey].xs = xs;
      t[cfg.postsKey].sectionId = postSec.id;
      t[cfg.beamKey].sectionId = beamSec.id;
      if (brace) t.bracing.sectionId = brace;
      const bom = billOfMaterials(analyse(t));
      const cost = items.reduce((a, name) => a + (bom.items.find((it) => it.name === name)?.cost ?? 0), 0);
      if (!best || cost < best.cost) best = { cost, beam: beamSec.id, post: postSec.id, n, along, brace };
    }
    return best;
  };

  for (let i = 0; i < finalists.length; i++) {
    const base = finalists[i].model;
    const outers = [];
    for (const along of ['none', 'cross']) {
      const o = await pickRow(base, 'outer', purlinList, postList,
        ['Прогон наружный', 'Столбы наружные', 'Связи наружного ряда'], along);
      if (o) outers.push(o);
    }
    const wall = await pickRow(base, 'wall', wallPurlinList, wallPostList,
      ['Обвязка у стены', 'Столбы у стены']);
    report('опоры', i + 1, finalists.length);
    if (!outers.length || !wall) continue;

    for (const outer of outers) {
    const m = clone(base);
    m.posts.xs = spread(B, outer.n);
    m.posts.sectionId = outer.post;
    m.purlin.sectionId = outer.beam;
    m.bracing = { ...m.bracing, along: outer.along, bays: 1, ...(outer.brace ? { sectionId: outer.brace } : {}) };
    m.wallPosts.xs = spread(B, wall.n);
    m.wallPosts.sectionId = wall.post;
    m.wallPurlin.sectionId = wall.beam;

    // узлы подбираются под уже выбранные сечения: катет шва ограничен толщиной
    // стенки, и на тонкой трубе сварной узел может оказаться неисполнимым
    const withTies = pickTies(m).model;
    const res = analyse(withTies);
    // сборка из независимо подобранных рядов проверяется целиком: отдельные
    // проверки могли пройти, а огибающая — нет. Узлы при этом меряются не
    // целевым запасом, а единицей: запас внутри них уже заложен, а вместимость
    // и катет шва дискретны
    const NODES = ['ties', 'beamTies', 'bases', 'spliceJoints'];
    const elements = Math.max(...res.summary.filter((s) => !NODES.includes(s.key)).map((s) => s.U));
    // касательные силы пучения сечениями не лечатся — их решает мера против
    // пучения, а не подбор; остальные проверки базы остаются в фильтре
    const nodeU = (s) => (s.key === 'bases' ? Math.max(res.bases.outer.Usized, res.bases.wall.Usized) : s.U);
    const nodes = Math.max(...res.summary.filter((s) => NODES.includes(s.key)).map(nodeU));
    if (!(elements <= target && nodes <= 1)) continue;
    Object.assign(m, withTies);
    const bom = billOfMaterials(res);
    options.push({ model: m, cost: bom.costs.total, res, bom });
    }
  }

  options.sort((a, b) => a.cost - b.cost);
  const out = options.slice(0, limit).map((o) => ({
    model: o.model,
    cost: o.cost,
    maxU: o.res.maxU,
    mass: o.bom.weights.total,
    parts: {
      rafters: `${section(o.model.rafters.sectionId).label} × ${o.model.rafters.xs.length}`,
      battens: `${section(o.model.battens.sectionId).label} / ${o.model.battens.spacing}`,
      purlin: section(o.model.purlin.sectionId).label,
      wallPurlin: section(o.model.wallPurlin.sectionId).label,
      posts: `${section(o.model.posts.sectionId).label} × ${o.model.posts.xs.length}`,
      bracing: o.model.bracing.along === 'cross'
        ? `крест ${section(o.model.bracing.sectionId).label}`
        : 'без связей',
      wallPosts: `${section(o.model.wallPosts.sectionId).label} × ${o.model.wallPosts.xs.length}`,
    },
  }));
  return { options: out, evaluated: budget.n, ms: Date.now() - started };
}
