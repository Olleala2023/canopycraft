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

/* ─────────────────── УЗЕЛ «ПРОГОН — СТОЛБ» ─────────────────── */

/**
 * Прогон опирается на оголовок столба. Вертикальную нагрузку вниз держит
 * само опирание — торец в торец, узел для этого не нужен. Узел держит то,
 * что пытается прогон с этого оголовка снять: ветровой отрыв, горизонтальную
 * силу и момент от эксцентриситета опирания.
 *
 * Два исполнения:
 *   сварка   — угловые швы по контуру оголовка (только для стального прогона);
 *   пластина — оголовок с приваренной пластиной, прогон на болтах.
 */
export const BEAM_TIES = [
  { id: 'weld3', label: 'сварка по контуру, катет 3 мм', short: 'шов k=3', kind: 'weld', kf: 3 },
  { id: 'weld4', label: 'сварка по контуру, катет 4 мм', short: 'шов k=4', kind: 'weld', kf: 4 },
  { id: 'weld5', label: 'сварка по контуру, катет 5 мм', short: 'шов k=5', kind: 'weld', kf: 5 },
  { id: 'weld6', label: 'сварка по контуру, катет 6 мм', short: 'шов k=6', kind: 'weld', kf: 6 },
  { id: 'plate10x2', label: 'пластина-оголовок + 2 болта М10', short: '2 × М10', kind: 'plate', d: 10, n: 2, grade: '5.8' },
  { id: 'plate10x4', label: 'пластина-оголовок + 4 болта М10', short: '4 × М10', kind: 'plate', d: 10, n: 4, grade: '5.8' },
  { id: 'plate12x2', label: 'пластина-оголовок + 2 болта М12', short: '2 × М12', kind: 'plate', d: 12, n: 2, grade: '5.8' },
  { id: 'plate12x4', label: 'пластина-оголовок + 4 болта М12', short: '4 × М12', kind: 'plate', d: 12, n: 4, grade: '5.8' },
];

const BEAM_TIE_BY_ID = new Map(BEAM_TIES.map((t) => [t.id, t]));

export function beamTie(id) {
  const t = BEAM_TIE_BY_ID.get(id);
  if (!t) throw new Error(`Неизвестный узел: ${id}`);
  return t;
}

/**
 * Угловой шов, СП 16 п. 14.1.7. Ручная сварка электродами Э46 или
 * полуавтоматическая проволокой ≤ 1,4 мм: β_f = 0,7, β_z = 1,0.
 */
export const WELD = { Rwf: 200, betaF: 0.7, betaZ: 1.0, gapEnd: 10 };

/**
 * Геометрия шва по контуру прямоугольного профиля: расчётная длина и момент
 * сопротивления линии шва. С каждого из четырёх швов снимается по 10 мм на
 * непровар в начале и конце.
 * @param {number} b ширина профиля, мм
 * @param {number} h высота профиля в плоскости изгиба, мм
 */
export function weldLine(b, h) {
  const length = Math.max(1, 2 * (b + h) - 4 * WELD.gapEnd);
  return { length, W: b * h + (h * h) / 3 };
}

/** Наименьший допустимый катет шва по табл. 38 СП 16, мм. */
export function weldMinLeg(tMax) {
  if (tMax <= 4) return 3;
  if (tMax <= 5) return 4;
  if (tMax <= 10) return 5;
  return 6;
}

/** Расчётные сопротивления болтов растяжению, МПа (СП 16, табл. Д.5). */
export const BOLT_RT = { '4.8': 160, '5.8': 200, '8.8': 400 };
/** Площадь нетто по резьбе, мм² (ГОСТ 24379). */
export const BOLT_AN = { 10: 52.3, 12: 76.2, 16: 144, 20: 225, 24: 324 };
/** Сторона квадратной шайбы-пластины под болт, мм. */
export const WASHER_SIDE = { 10: 40, 12: 50, 16: 60 };

/* ─────────────────────── БАЗА СТОЛБА ─────────────────────── */

/**
 * База решает, законна ли расчётная схема столба. Расчёт на устойчивость при
 * μ = 2 предполагает защемление внизу — значит, база обязана воспринять момент
 * от горизонтальной силы и эксцентриситета. Два анкера с малым разносом такой
 * момент не держат, и тогда «защемлён внизу» — просто слова.
 *
 * Варианты: столб забетонирован в фундамент (заделка длиной хода) или
 * опирается на приваренную плиту с анкерами.
 */
export const POST_BASES = [
  { id: 'embed600', kind: 'embed', label: 'забетонирован, заделка 600 мм', short: 'бетон 600', embed: 600 },
  { id: 'embed800', kind: 'embed', label: 'забетонирован, заделка 800 мм', short: 'бетон 800', embed: 800 },
  { id: 'embed1200', kind: 'embed', label: 'забетонирован, заделка 1200 мм', short: 'бетон 1200', embed: 1200 },
  { id: 'plate2m12', kind: 'plate', label: 'плита 200×200×8 + 2 анкера М12', short: '2 × М12', n: 2, d: 12, plate: 200, t: 8, hef: 200, grade: '5.8' },
  { id: 'plate4m12', kind: 'plate', label: 'плита 250×250×10 + 4 анкера М12', short: '4 × М12', n: 4, d: 12, plate: 250, t: 10, hef: 250, grade: '5.8' },
  { id: 'plate4m16', kind: 'plate', label: 'плита 300×300×12 + 4 анкера М16', short: '4 × М16', n: 4, d: 16, plate: 300, t: 12, hef: 300, grade: '5.8' },
  { id: 'plate4m20', kind: 'plate', label: 'плита 350×350×14 + 4 анкера М20', short: '4 × М20', n: 4, d: 20, plate: 350, t: 14, hef: 400, grade: '5.8' },
];

const BASE_BY_ID = new Map(POST_BASES.map((b) => [b.id, b]));

export function postBase(id) {
  const b = BASE_BY_ID.get(id);
  if (!b) throw new Error(`Неизвестная база: ${id}`);
  return b;
}

/** Бетон фундамента: R_b и R_bt, МПа (СП 63.13330, табл. 6.8). */
export const CONCRETE = {
  B15: { Rb: 8.5, Rbt: 0.75 },
  B20: { Rb: 11.5, Rbt: 0.90 },
  B25: { Rb: 14.5, Rbt: 1.05 },
  B30: { Rb: 17.0, Rbt: 1.15 },
};

/** Отступ анкера от края плиты, мм. */
export const ANCHOR_EDGE = 40;
/** Плотность железобетона, кг/м³ — для массы фундамента против отрыва. */
export const CONCRETE_DENSITY = 2400;

/** Разнос анкеров по осям, мм. */
export const anchorSpan = (base) => Math.max(40, base.plate - 2 * ANCHOR_EDGE);

/**
 * Наименьшая глубина заделки забетонированного столба: десять размеров
 * сечения. Конструктивное правило, а не расчёт по грунту — ниже этого о
 * защемлении говорить нельзя.
 */
export const minEmbed = (postH) => 10 * postH;
