/**
 * Сортаменты сечений.
 *
 * Единицы всюду: мм, мм², мм⁴, мм³.
 *
 * Профильные трубы — ГОСТ 30245-2003 (гнутосварные) и ГОСТ 8645-68 для мелких.
 * Геометрические характеристики вычисляются с учётом скруглений углов
 * (R_нар = 2,0t при t ≤ 6 мм, иначе 2,5t), поэтому отличаются от табличных
 * значений ГОСТ примерно на 1 %, но всегда в безопасную сторону по сравнению
 * с наивной «разностью прямых прямоугольников» (та завышает I на 3–6 %).
 *
 * Пиломатериал — ГОСТ 24454-80, размеры при влажности 20 %.
 */

/** Площадь одного углового «серпика» между квадратом r×r и четвертью круга. */
const cornerArea = (r) => (1 - Math.PI / 4) * r * r;
/** Расстояние от угла до центра тяжести этого серпика. */
const cornerCentroid = (r) => (r * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI);

/** Момент инерции прямоугольника со скруглёнными углами относительно своей оси. */
function roundedRectI(b, h, r) {
  if (r <= 0) return (b * h * h * h) / 12;
  const d = h / 2 - cornerCentroid(r);
  return (b * h * h * h) / 12 - 4 * cornerArea(r) * d * d;
}
function roundedRectA(b, h, r) {
  return b * h - 4 * cornerArea(r);
}

/**
 * Геометрические характеристики замкнутого гнутосварного профиля.
 * @param {number} h высота (в плоскости основного изгиба), мм
 * @param {number} b ширина, мм
 * @param {number} t толщина стенки, мм
 */
export function rhsProps(h, b, t) {
  const Ro = t <= 6 ? 2.0 * t : 2.5 * t;
  const Ri = Math.max(0, Ro - t);
  const bi = b - 2 * t;
  const hi = h - 2 * t;
  const A = roundedRectA(b, h, Ro) - roundedRectA(bi, hi, Ri);
  const Ix = roundedRectI(b, h, Ro) - roundedRectI(bi, hi, Ri);
  const Iy = roundedRectI(h, b, Ro) - roundedRectI(hi, bi, Ri);
  return {
    A,
    Ix,
    Iy,
    Wx: Ix / (h / 2),
    Wy: Iy / (b / 2),
    ix: Math.sqrt(Ix / A),
    iy: Math.sqrt(Iy / A),
    /** сдвиговая площадь — две стенки */
    As: 2 * t * hi,
    /** статический момент полусечения (для касательных напряжений) */
    Sx: b * t * (h - t) / 2 + 2 * t * (hi / 2) * (hi / 4),
  };
}

/** Характеристики прямоугольного деревянного сечения. */
export function rectProps(h, b) {
  const A = b * h;
  return {
    A,
    Ix: (b * h * h * h) / 12,
    Iy: (h * b * b * b) / 12,
    Wx: (b * h * h) / 6,
    Wy: (h * b * b) / 6,
    ix: h / Math.sqrt(12),
    iy: b / Math.sqrt(12),
    As: (5 / 6) * A,
    Sx: (b * h * h) / 8,
  };
}

const STEEL_SIZES = [
  // квадратные
  [40, 40, [2, 3]], [50, 50, [2, 3, 4]], [60, 60, [2, 3, 4, 5]],
  [80, 80, [3, 4, 5, 6]], [100, 100, [3, 4, 5, 6]], [120, 120, [4, 5, 6]],
  [140, 140, [4, 5, 6]], [150, 150, [4, 5, 6]], [160, 160, [5, 6]],
  [180, 180, [5, 6]], [200, 200, [6, 8]],
  // прямоугольные (первое число — высота, работает в плоскости изгиба)
  [50, 25, [2, 3]], [60, 30, [2, 3]], [60, 40, [2, 3]], [80, 40, [2, 3, 4]],
  [80, 60, [3, 4]], [100, 50, [3, 4, 5]], [100, 60, [3, 4, 5]], [100, 80, [3, 4, 5]],
  [120, 60, [3, 4, 5]], [120, 80, [4, 5, 6]], [140, 80, [4, 5, 6]],
  [140, 100, [4, 5, 6]], [160, 80, [4, 5, 6]], [160, 120, [5, 6]],
  [180, 100, [5, 6]], [200, 100, [5, 6, 8]], [200, 120, [6, 8]],
];

const TIMBER_SIZES = [
  [100, 25], [100, 32], [100, 40], [50, 50], [100, 50],
  [150, 40], [150, 50], [150, 100],
  [175, 50], [200, 40], [200, 50], [200, 60], [200, 75], [200, 100],
  [225, 50], [250, 50], [250, 60], [250, 75], [250, 100],
];

/** @typedef {{id:string,label:string,material:'timber'|'steel',h:number,b:number,t?:number,props:object,weight:number,massPerM:number}} Section */

/**
 * Плотность материалов, кг/м³.
 * Сосна при эксплуатационной влажности 12–20 % — 500; свежераспиленная
 * доска весит до 700–800 кг/м³, это стоит помнить при подъёме вручную.
 * Сталь — 7850.
 */
export const DENSITY = { timber: 500, steel: 7850 };
const G = 9.80665; // м/с²

/** Погонная масса сечения, кг/м:  m = A·ρ,  A в м². */
function massPerMetre(A, material) {
  return A * 1e-6 * DENSITY[material];
}
/** Погонный вес, кН/м:  q = m·g. */
function selfWeight(A, material) {
  return (massPerMetre(A, material) * G) / 1000;
}

/** @type {Section[]} */
export const SECTIONS = [];

for (const [h, b] of TIMBER_SIZES) {
  const props = rectProps(h, b);
  SECTIONS.push({
    id: `t${b}x${h}`,
    label: `${b}×${h}`,
    material: 'timber',
    h, b,
    props,
    weight: selfWeight(props.A, 'timber'),
    massPerM: massPerMetre(props.A, 'timber'),
  });
}
for (const [h, b, ts] of STEEL_SIZES) {
  for (const t of ts) {
    const props = rhsProps(h, b, t);
    SECTIONS.push({
      id: `s${b}x${h}x${t}`,
      label: `${b}×${h}×${t}`,
      material: 'steel',
      h, b, t,
      props,
      weight: selfWeight(props.A, 'steel'),
      massPerM: massPerMetre(props.A, 'steel'),
    });
  }
}

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

export function section(id) {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`Неизвестное сечение: ${id}`);
  return s;
}

/** Сечения одного материала, от самого дешёвого (по расходу материала) к дорогому. */
export function ladder(material, opts = {}) {
  const { minH = 0, maxH = 1e9 } = opts;
  return SECTIONS
    .filter((s) => s.material === material && s.h >= minH && s.h <= maxH)
    // при равном расходе материала (а значит и цене) впереди идёт сечение
    // с большим моментом сопротивления: 25×100 не дороже 50×50, но вдвое сильнее
    .sort((a, b) => a.props.A - b.props.A || b.props.Wx - a.props.Wx);
}
