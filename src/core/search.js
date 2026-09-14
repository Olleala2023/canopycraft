/**
 * Подбор конструкции по минимальной стоимости материалов.
 *
 * Полный перебор — десятки тысяч сочетаний, это минуты. Но цепочка почти
 * однонаправленная: стропила грузят прогоны, прогоны грузят столбы. Отсюда
 * поэтапный поиск с отсевом:
 *
 *   1. по каждому числу стропил двоичным поиском по сортаменту находится
 *      самое дешёвое проходящее сечение;
 *   2. лучшие по цене варианты кровельной части идут дальше, для каждого
 *      перебираются число столбов и сечения прогонов и стоек;
 *   3. в конце подбирается сечение обрешётки.
 *
 * Сортаменты отсортированы по расходу материала, а внутри одного материала
 * порядок по цене тот же — поэтому двоичный поиск ищет именно дешёвое.
 */
import { analyse, billOfMaterials } from './analysis.js';
import { ladder, section } from './sections.js';
import { spread } from './model.js';
import { U_OF } from './optimize.js';

const clone = (m) => JSON.parse(JSON.stringify(m));

/**
 * Уступить управление интерфейсу, чтобы страница не замирала. Не на каждом
 * расчёте: setTimeout(0) сам по себе стоит миллисекунду-другую, и на тысяче
 * вызовов это складывается в секунды ожидания на ровном месте.
 */
const breathe = () => new Promise((r) => setTimeout(r, 0));
const maybeBreathe = (budget) => (budget.n % 25 === 0 ? breathe() : null);

/**
 * Двоичный поиск самого дешёвого проходящего сечения.
 * Предполагается почти монотонность: крупнее сечение — меньше загрузка.
 * Если даже самое крупное не проходит, возвращается null.
 */
async function cheapest(list, evaluate, target, budget) {
  if (!list.length) return null;
  budget.n++;
  await maybeBreathe(budget);
  if (await evaluate(list[list.length - 1]) > target) return null;
  let lo = 0, hi = list.length - 1, best = list[hi];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    budget.n++;
    await maybeBreathe(budget);
    if (await evaluate(list[mid]) <= target) { best = list[mid]; hi = mid - 1; } else lo = mid + 1;
  }
  return best;
}

/**
 * Перебор снизу вверх с ранним выходом. Для обрешётки это дешевле двоичного
 * поиска: самое лёгкое сечение обычно проходит сразу, и хватает одного расчёта.
 */
async function cheapestFromBottom(list, evaluate, target, budget) {
  for (const s of list) {
    budget.n++;
    await maybeBreathe(budget);
    if (await evaluate(s) <= target) return s;
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

  // разумный диапазон шага стропил: от 1200 до 300 мм
  const counts = [];
  for (let n = Math.max(3, Math.ceil(B / 1200) + 1); n <= Math.min(25, Math.ceil(B / 300) + 1); n++) counts.push(n);

  /* ── этап 1: стропила ── */
  const roofs = [];
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i];
    const m = clone(model);
    m.rafters.xs = spread(B, n);
    const sec = await cheapest(rafterList, async (s) => {
      m.rafters.sectionId = s.id;
      await breathe();
      return U_OF.rafters(analyse(m));
    }, target, budget);
    report('стропила', i + 1, counts.length);
    if (!sec) continue;
    m.rafters.sectionId = sec.id;
    // обрешётка проверяется здесь же: её пролёт — это шаг стропил, и при
    // редкой расстановке она может не пройти, каким бы ни было стропило
    const bat = await cheapestFromBottom(battenList, async (b) => {
      m.battens.sectionId = b.id;
      return U_OF.battens(analyse(m));
    }, target, budget);
    if (!bat) continue;
    m.battens.sectionId = bat.id;
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
     а не всеми сочетаниями: 6 + 6 вариантов вместо 36. */
  const options = [];
  const pickRow = async (m, cfg) => {
    let best = null;
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const t = clone(m);
      t[cfg.postsKey].xs = spread(B, n);
      const beam = await cheapest(cfg.beamList, async (s) => {
        t[cfg.beamKey].sectionId = s.id;
        return U_OF[cfg.beamU](analyse(t));
      }, target, budget);
      if (!beam) continue;
      t[cfg.beamKey].sectionId = beam.id;
      const post = await cheapest(cfg.postList, async (s) => {
        t[cfg.postsKey].sectionId = s.id;
        return U_OF[cfg.postsU](analyse(t));
      }, target, budget);
      if (!post) continue;
      t[cfg.postsKey].sectionId = post.id;
      const bom = billOfMaterials(analyse(t));
      const cost = cfg.items.reduce((a, name) => a + (bom.items.find((it) => it.name === name)?.cost ?? 0), 0);
      if (!best || cost < best.cost) best = { cost, beam: beam.id, post: post.id, n };
    }
    return best;
  };

  for (let i = 0; i < finalists.length; i++) {
    const base = finalists[i].model;
    const outer = await pickRow(base, {
      postsKey: 'posts', beamKey: 'purlin', beamList: purlinList, postList,
      beamU: 'purlin', postsU: 'posts', items: ['Прогон наружный', 'Столбы наружные'],
    });
    const wall = await pickRow(base, {
      postsKey: 'wallPosts', beamKey: 'wallPurlin', beamList: wallPurlinList, postList: wallPostList,
      beamU: 'wallPurlin', postsU: 'wallPosts', items: ['Обвязка у стены', 'Столбы у стены'],
    });
    report('опоры', i + 1, finalists.length);
    if (!outer || !wall) continue;

    const m = clone(base);
    m.posts.xs = spread(B, outer.n);
    m.posts.sectionId = outer.post;
    m.purlin.sectionId = outer.beam;
    m.wallPosts.xs = spread(B, wall.n);
    m.wallPosts.sectionId = wall.post;
    m.wallPurlin.sectionId = wall.beam;

    const res = analyse(m);
    // сборка из независимо подобранных рядов проверяется целиком:
    // отдельные проверки могли пройти, а огибающая — нет
    if (!(res.maxU <= target)) continue;
    const bom = billOfMaterials(res);
    options.push({ model: m, cost: bom.costs.total, res, bom });
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
      wallPosts: `${section(o.model.wallPosts.sectionId).label} × ${o.model.wallPosts.xs.length}`,
    },
  }));
  return { options: out, evaluated: budget.n, ms: Date.now() - started };
}
