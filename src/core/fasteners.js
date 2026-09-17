/**
 * Крепёж узлов: несущая способность на срез и правила расстановки.
 *
 * Расчёт по СП 64.13330.2017, разд. 8 (нагельные соединения) и табл. 20.
 *
 * Принятая схема узла: стропило прижимается к опоре перфорированным уголком
 * с двух сторон (или сквозным болтом). Ключевое здесь то, что усилие отрыва
 * приходит на крепёж **срезом**, а не выдёргиванием: гвозди и саморезы на
 * выдёргивание в несущих узлах работать не должны, поэтому уголок, а не
 * «прибить сверху».
 *
 * Несущая способность одного крепежа на один шов, кН (размеры в см):
 *
 *   смятие древесины   T_см = 0,35·c·d     c — глубина защемления в древесине
 *   изгиб гвоздя       T_и  = 2,5·d²       при стальной накладке a = 0
 *   изгиб винта        T_и  = 1,6·d²
 *   изгиб болта        T_и  = 1,8·d²
 *
 *   T = min(T_см, T_и) · m_в
 *
 * Слагаемое 0,01·a² (0,02·a² для стальных нагелей) в формулах изгиба не
 * учитывается: накладка стальная, толщина крайнего деревянного элемента a = 0.
 * Это в запас.
 */

/** @typedef {{id:string,label:string,kind:'nail'|'screw'|'bolt',d:number,len:number,steelD?:number,short:string}} Fastener */

/** @type {Fastener[]} */
export const FASTENERS = [
  { id: 'nail4x50', label: 'уголок + ершёные гвозди 4,0×50', short: 'гвоздь 4,0×50', kind: 'nail', d: 4, len: 50 },
  { id: 'nail5x60', label: 'уголок + ершёные гвозди 5,0×60', short: 'гвоздь 5,0×60', kind: 'nail', d: 5, len: 60 },
  { id: 'screw5x70', label: 'уголок + саморезы 5,0×70', short: 'саморез 5,0×70', kind: 'screw', d: 5, len: 70 },
  { id: 'screw6x90', label: 'уголок + саморезы 6,0×90', short: 'саморез 6,0×90', kind: 'screw', d: 6, len: 90 },
  { id: 'bolt10', label: 'болт М10 насквозь', short: 'болт М10', kind: 'bolt', d: 10, len: 0 },
  { id: 'bolt12', label: 'болт М12 насквозь', short: 'болт М12', kind: 'bolt', d: 12, len: 0 },
];

const FASTENER_BY_ID = new Map(FASTENERS.map((f) => [f.id, f]));

export function fastener(id) {
  const f = FASTENER_BY_ID.get(id);
  if (!f) throw new Error(`Неизвестный крепёж: ${id}`);
  return f;
}

/** Толщина полки перфорированного уголка, мм. */
export const ANGLE_PLATE = 2;
/** Длина полки уголка, мм — типовой усиленный уголок 90×90. */
export const ANGLE_LEG = 90;
/** Диаметр самосверлящего винта, которым уголок крепится к стальному прогону, мм. */
export const SELF_DRILL_D = 5.5;

const BEND_K = { nail: 2.5, screw: 1.6, bolt: 1.8 };

/**
 * Несущая способность одного крепежа на один шов, Н.
 * @param {Fastener} f
 * @param {{woodWidth:number, mv?:number}} o woodWidth — толщина деревянного
 *   элемента, в который входит крепёж (для болта — насквозь), мм
 */
export function shearCapacity(f, { woodWidth, mv = 1 }) {
  // глубина защемления: у гвоздя и самореза за вычетом полки уголка и заострения
  const pen = f.kind === 'bolt'
    ? woodWidth
    : Math.min(f.len - ANGLE_PLATE - 1.5 * f.d, woodWidth);
  const d = f.d / 10, c = pen / 10;              // см
  const bearing = 0.35 * c * d;                  // кН
  const bend = BEND_K[f.kind] * d * d;           // кН
  const T = Math.min(bearing, bend) * mv * 1000; // Н
  return {
    T, pen,
    bearing: bearing * mv * 1000,
    bend: bend * mv * 1000,
    governs: bearing <= bend ? 'смятие древесины' : 'изгиб крепежа',
    /** норма требует защемления не менее 4d, иначе крепёж не считается несущим */
    deep: pen >= 4 * f.d,
  };
}

/**
 * Минимальные расстояния между крепежами, мм (СП 64, разд. 8).
 * S1 — вдоль волокон, S2 — поперёк, S3 — до кромки.
 */
export function spacingRules(f) {
  const k = f.kind === 'bolt' ? { s1: 7, s2: 3.5, s3: 3 } : { s1: 15, s2: 4, s3: 4 };
  return { s1: k.s1 * f.d, s2: k.s2 * f.d, s3: k.s3 * f.d, k };
}

/**
 * Сколько крепежей физически помещается в узле.
 *
 * Гвозди и саморезы бьются в полку уголка — считаем сетку на полке 90×90 мм,
 * уголка два, с обеих сторон стропила. Болт идёт сквозь стропило, его сетка
 * ограничена высотой сечения и длиной нахлёста на опору.
 */
export function fitCount(f, { rafterH, overlap = 120 }) {
  const s = spacingRules(f);
  const along = f.kind === 'bolt' ? overlap : ANGLE_LEG;
  const across = f.kind === 'bolt' ? rafterH : Math.min(rafterH, ANGLE_LEG);
  const cols = Math.max(1, Math.floor((along - 2 * s.s3) / s.s1) + 1);
  const rows = Math.max(1, Math.floor((across - 2 * s.s3) / s.s2) + 1);
  const perPlane = cols * rows;
  return {
    n: f.kind === 'bolt' ? perPlane : perPlane * 2, // болт один на оба шва, уголка два
    cols, rows, ...s,
  };
}

/** Масса одного крепежа, кг — для спецификации. */
export function fastenerMass(f) {
  const steel = 7850e-9; // кг/мм³
  if (f.kind === 'bolt') {
    const len = 90; // болт с гайкой и шайбами через стропило
    return (Math.PI * f.d * f.d) / 4 * len * steel * 1.6;
  }
  return (Math.PI * f.d * f.d) / 4 * f.len * steel * 1.15;
}

/** Масса одного перфорированного уголка 90×90×65×2, кг. */
export const ANGLE_MASS = (90 * 65 + 90 * 65) * ANGLE_PLATE * 7850e-9;
