/**
 * Детали навеса для 3D-вида — по результату расчёта.
 *
 * Чистая функция без three.js и без браузера: на входе результат analyse(),
 * на выходе список брусков. Геометрия — только из расчёта: отметки из
 * levels(), координаты стропил и столбов из модели, сечения из результата.
 * Своих чисел «на глаз» здесь нет, как и в чертежах, — иначе 3D разойдётся с
 * расчётом (так на узловом чертеже однажды стропило врезалось в опору).
 *
 * Система координат, мм: x — вдоль стены (0…B), y — от оси столбов у стены
 * наружу (0 у стены, L у наружного ряда, L + a — край свеса), z — вверх от
 * верха фундамента.
 *
 * Брусок — { from, to, w, h, up }: ось от точки from до to, сечение w × h, где
 * h откладывается вдоль up (перпендикулярно оси), w — поперёк. Так одной
 * формой описываются и столбы, и наклонные стропила, и диагонали связей.
 */
import { levels } from '../core/model.js';
import { houseWall, openingsOf } from '../core/analysis.js';

const OPENING_T = 20; // мм, толщина щита проёма на стене — только для рисунка
const CROSS_INSET = 150; // мм, как в расчёте креста (posts.js): диагональ не до самой базы

/**
 * @returns {{ kind:string, label:string, sel:object|null, U:number|null,
 *   from:number[], to:number[], w:number, h:number, up:number[], ghost?:boolean }[]}
 */
export function buildSolids(res) {
  const m = res.model;
  const { B, L, a, alpha } = m.geom;
  const lv = levels(m);
  const t = (alpha * Math.PI) / 180;
  const ca = Math.cos(t), sa = Math.sin(t);
  // вдоль ската вниз, от стены наружу, и нормаль к скату вверх
  const down = [0, ca, -sa];
  const normal = [0, sa, ca];
  const add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k, p[2] + v[2] * k];
  /** Низ стропила над точкой y — плоскость, на которой лежат стропила. */
  const rafterBottom = (x, y) => [x, y, lv.rafterBottomWall - y * Math.tan(t)];
  const Ls = (L + a) / ca;
  const out = [];

  // стропила: низом — по плоскости опирания, от оси стеновых столбов до края свеса
  const raf = res.rafters[0].sec;
  res.rafters.forEach((r, i) => {
    const p0 = add(rafterBottom(r.x, 0), normal, raf.h / 2);
    out.push({ kind: 'rafter', label: `Стропило ${i + 1}`, sel: { type: 'rafter', index: i }, U: r.U,
      from: p0, to: add(p0, down, Ls), w: raf.b, h: raf.h, up: normal });
  });

  // обрешётка — поперёк стропил, по их верху, с шагом вдоль ската
  const bat = res.battens.sec;
  const nBatten = Math.floor(Ls / m.battens.spacing) + 1;
  for (let k = 0; k < nBatten; k++) {
    const s = Math.min(Ls - bat.b / 2, bat.b / 2 + k * m.battens.spacing);
    const c = add(add(rafterBottom(0, 0), down, s), normal, raf.h + bat.h / 2);
    out.push({ kind: 'batten', label: 'Обрешётка', sel: { type: 'battens' }, U: res.battens.U,
      from: c, to: [B, c[1], c[2]], w: bat.b, h: bat.h, up: normal });
  }

  // кровля — тонкий лист поверх обрешётки, полупрозрачный и не выбирается
  const roof0 = add(rafterBottom(0, 0), normal, raf.h + bat.h + 3);
  out.push({ kind: 'roof', label: 'Кровля', sel: null, U: null, ghost: true,
    from: [B / 2, roof0[1], roof0[2]], to: add([B / 2, roof0[1], roof0[2]], down, Ls), w: B, h: 6, up: normal });

  // прогон на наружных столбах и обвязка на стеновых — вдоль стены
  const pur = res.purlin.sec, wpur = res.wallPurlin.sec;
  out.push({ kind: 'purlin', label: 'Прогон', sel: { type: 'purlin' }, U: res.purlin.U,
    from: [0, L, lv.postTop + pur.h / 2], to: [B, L, lv.postTop + pur.h / 2], w: pur.b, h: pur.h, up: [0, 0, 1] });
  out.push({ kind: 'wallPurlin', label: 'Обвязка у стены', sel: { type: 'wallPurlin' }, U: res.wallPurlin.U,
    from: [0, 0, lv.wallPostTop + wpur.h / 2], to: [B, 0, lv.wallPostTop + wpur.h / 2], w: wpur.b, h: wpur.h, up: [0, 0, 1] });

  // столбы — от верха фундамента до низа прогона и обвязки
  res.posts.forEach((p, i) => out.push({ kind: 'post', label: `Столб ${i + 1}`, sel: { type: 'post', index: i }, U: p.U,
    from: [p.x, L, 0], to: [p.x, L, lv.postTop], w: p.sec.b, h: p.sec.h, up: [0, 1, 0] }));
  res.wallPosts.forEach((p, i) => out.push({ kind: 'wallPost', label: `Столб у стены ${i + 1}`, sel: { type: 'wallPost', index: i }, U: p.U,
    from: [p.x, 0, 0], to: [p.x, 0, lv.wallPostTop], w: p.sec.b, h: p.sec.h, up: [0, 1, 0] }));

  // блоки фундамента под столбами — ниже нуля. Блок у стены, стоящий рядом с
  // фундаментом дома, смещён от оси столба наружу (offset из расчёта), и столб
  // стоит на краю плиты-«столика»
  for (const [side, row, y] of [['outer', res.posts, L], ['wall', res.wallPosts, 0]]) {
    const b = res.bases[side];
    if (!b?.side || !b?.depth) continue;
    const label = side === 'wall' ? 'Фундамент столба у стены' : 'Фундамент наружного столба';
    const yBlock = y + (b.beside ? b.offset : 0);
    for (const p of row) {
      out.push({ kind: 'base', label, sel: { type: 'base', side }, U: b.U,
        from: [p.x, yBlock, -b.depth], to: [p.x, yBlock, 0], w: b.side, h: b.side, up: [0, 1, 0] });
      if (b.base.kind !== 'plate') continue;
      // плита: у стены — столик от грани стены наружу, у наружных — по центру столба
      const pl = b.beside ? b.plate : { L: b.base.plate, B: b.base.plate };
      const yPlate = b.beside ? y - p.sec.h / 2 + pl.L / 2 : y;
      out.push({ kind: 'basePlate', label: `Плита базы ${pl.L}×${pl.B}`, sel: { type: 'base', side }, U: b.U,
        from: [p.x, yPlate, 0], to: [p.x, yPlate, b.base.t], w: pl.B, h: pl.L, up: [0, 1, 0] });
    }
  }

  // крест в пролёте наружного ряда
  if (res.cross) {
    const d = res.cross.sec;
    for (const bay of res.cross.bays) {
      const z0 = CROSS_INSET, z1 = lv.postTop - CROSS_INSET;
      for (const [xa, xb] of [[bay.x0, bay.x1], [bay.x1, bay.x0]]) {
        out.push({ kind: 'brace', label: 'Связь — крест', sel: { type: 'bracing' }, U: res.cross.U,
          from: [xa, L, z0], to: [xb, L, z1], w: d.b, h: d.h, up: [0, 1, 0] });
      }
    }
  }

  // диагонали в плоскости кровли — под стропилами, от прогона к обвязке
  if (res.roofBrace) {
    const rb = res.roofBrace, d = rb.sec;
    const under = (x, y) => add(rafterBottom(x, y), normal, -d.h / 2);
    for (const [xa, xb] of [[rb.x0, rb.x1], [rb.x1, rb.x0]]) {
      out.push({ kind: 'brace', label: 'Связи по кровле', sel: { type: 'bracing' }, U: rb.U,
        from: under(xa, L), to: under(xb, 0), w: d.b, h: d.h, up: normal });
    }
  }

  return out;
}

/**
 * Стена дома, её окна и двери и земля — для ориентира, не детали навеса.
 * Стена по ширине — из модели (houseWall), проём — тонкий щит на лицевой
 * стороне стены, под навесом.
 */
export function buildContext(res) {
  const m = res.model;
  const lv = levels(m);
  const wallPost = res.wallPosts[0]?.sec;
  const face = -(wallPost?.h ?? 60) / 2;
  const t = m.wallPosts.wallThickness ?? 300;
  const top = lv.houseRoof;
  const { x0, x1 } = houseWall(m);
  const yc = face - t / 2;
  const openings = openingsOf(m).map((o) => {
    // проём не выше стены: окно под самой кровлей рисуется до её края
    const bottom = Math.min(o.bottom, top), up = Math.min(o.top, top);
    return { kind: o.kind, label: o.label, index: o.index,
      from: [(o.x0 + o.x1) / 2, face + OPENING_T / 2, bottom], to: [(o.x0 + o.x1) / 2, face + OPENING_T / 2, up], w: o.x1 - o.x0, h: OPENING_T, up: [0, 1, 0] };
  }).filter((o) => o.to[2] > o.from[2]);
  const xMin = Math.min(0, x0), xMax = Math.max(m.geom.B, x1);
  return {
    wall: { from: [(x0 + x1) / 2, yc, 0], to: [(x0 + x1) / 2, yc, top], w: x1 - x0, h: t, up: [0, 1, 0] },
    openings,
    ground: { size: Math.max(xMax - xMin, m.geom.L + m.geom.a) * 2.2, center: [(xMin + xMax) / 2, (m.geom.L + m.geom.a) / 2] },
  };
}
