/**
 * Стена дома, к которой примыкает навес: её ширина, окна и двери.
 *
 * На прочность навеса это не влияет — расчёт стены дома не касается. Зато
 * от проёмов зависит, где можно поставить столб у стены: шпилька, попавшая в
 * окно, ничего не держит, а столб перед дверью мешает ходить. Поэтому проёмы
 * хранятся в модели, рисуются и сверяются со столбами и обвязкой.
 *
 * Координаты — как у навеса: x вдоль стены от левого края навеса, мм; высота —
 * от верха фундамента столбов, практически от земли у стены.
 * Проём в модели задан от левого угла дома — так его меряют рулеткой.
 */
import { levels, boltHeights } from './model.js';
import { section } from './sections.js';

export const OPENING_KINDS = {
  window: { label: 'окно', w: 1200, h: 1400, bottom: 900 },
  door: { label: 'дверь', w: 900, h: 2100, bottom: 0 },
};

/**
 * Стена дома в координатах навеса. Ширина 0 — «не задана»: стена рисуется
 * ровно по навесу, как чаще всего и бывает, когда навес во всю стену.
 * @returns {{ x0:number, x1:number }} мм
 */
export function houseWall(m) {
  const h = m.house ?? {};
  if (!(h.width > 0)) return { x0: 0, x1: m.geom.B };
  const x0 = -(h.offset ?? 0);
  return { x0, x1: x0 + h.width };
}

/**
 * Проёмы в координатах навеса — только с осмысленными размерами.
 * @returns {{ index:number, kind:string, label:string, x0:number, x1:number, bottom:number, top:number }[]}
 */
export function openingsOf(m) {
  const { x0 } = houseWall(m);
  const list = m.house?.openings ?? [];
  const out = [];
  list.forEach((o, index) => {
    const kind = OPENING_KINDS[o?.kind] ? o.kind : 'window';
    const nums = [o?.x, o?.w, o?.h, o?.bottom];
    if (!nums.every(Number.isFinite) || o.w <= 0 || o.h <= 0) return;
    out.push({ index, kind, label: OPENING_KINDS[kind].label,
      x0: x0 + o.x, x1: x0 + o.x + o.w, bottom: o.bottom, top: o.bottom + o.h });
  });
  return out;
}

/**
 * Где проёмы мешают навесу.
 *
 *  - столб у стены встаёт на проём: его шпильки, попавшие в проём, некуда
 *    завести, а столб перед дверью ещё и загораживает проход;
 *  - обвязка у стены идёт по высоте проёма и перекрывает его верх.
 *
 * @returns {{ kind:'post'|'purlin', opening:object, post?:number, bolts?:number }[]}
 */
export function houseClashes(m) {
  const lv = levels(m);
  const half = section(m.wallPosts.sectionId).b / 2;
  const zs = boltHeights(lv.wallPostTop, Math.max(1, m.wallPosts.boltCount));
  const out = [];
  for (const o of openingsOf(m)) {
    m.wallPosts.xs.forEach((x, i) => {
      if (x + half <= o.x0 || x - half >= o.x1 || o.bottom >= lv.wallPostTop) return;
      const bolts = zs.filter((z) => z > o.bottom && z < o.top).length;
      out.push({ kind: 'post', opening: o, post: i, bolts });
    });
    // обвязка — от верха стеновых столбов до низа стропил, по всей ширине навеса
    const overlaps = o.x1 > 0 && o.x0 < m.geom.B;
    if (overlaps && o.top > lv.wallPostTop) out.push({ kind: 'purlin', opening: o });
  }
  return out;
}

/**
 * Точки привязки вдоль стены для цепочки размеров: углы дома, края навеса,
 * оси столбов у стены и откосы проёмов — по возрастанию x, совпадающие (ближе
 * 1 мм) склеены в одну. Между соседними точками — размер, который меряют
 * рулеткой: от угла до откоса, от откоса до оси столба.
 *
 * @param {{ from?:number, to?:number }} range — только точки в этих пределах,
 *   мм по навесу (план показывает стену лишь в пределах навеса)
 * @returns {{ x:number, kinds:string[] }[]} kinds: 'corner' | 'edge' | 'post' | 'jamb'
 */
export function wallMarks(m, { from = -Infinity, to = Infinity } = {}) {
  const wall = houseWall(m);
  const raw = [];
  if (m.house?.width > 0) raw.push([wall.x0, 'corner'], [wall.x1, 'corner']);
  raw.push([0, 'edge'], [m.geom.B, 'edge']);
  for (const x of m.wallPosts.xs) raw.push([x, 'post']);
  for (const o of openingsOf(m)) raw.push([o.x0, 'jamb'], [o.x1, 'jamb']);
  const inside = raw
    .map(([x, kind]) => [Math.min(to, Math.max(from, x)), kind, x])
    .filter(([x, , x0]) => x === x0 || x === from || x === to)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [x, kind] of inside) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - x) < 1) { if (!last.kinds.includes(kind)) last.kinds.push(kind); } else out.push({ x, kinds: [kind] });
  }
  return out;
}
