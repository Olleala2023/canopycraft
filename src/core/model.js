/** Модель навеса и значения по умолчанию. Все длины — мм, углы — градусы. */
import { section } from './sections.js';

/**
 * Схема опирания:
 *   ─ у дома: ряд стальных столбов, притянутых к газоблоку сквозными шпильками,
 *     сверху на них лежит обвязочная доска (её часто называют мауэрлатом, но
 *     мауэрлат лежит на кладке — здесь это прогон по столбам у стены);
 *   ─ снаружи: ряд отдельно стоящих столбов и прогон по ним;
 *   ─ стропила опираются на оба прогона, за наружный уходят консолью.
 */
export function defaultModel() {
  const B = 6000, L = 4000, a = 800;
  const nRafters = 11, nPosts = 4, nWallPosts = 5;
  return {
    geom: {
      B,                // ширина навеса вдоль стены
      L,                // от оси стеновых столбов до оси наружных
      a,                // свес за наружные столбы
      alpha: 8,         // уклон, °
      postHeight: 2500, // верх наружного столба от верха фундамента (на него ложится прогон)
      driftH: 1200,     // перепад высот кровля дома / навес
    },
    site: {
      // Воронеж: по картам прил. Е СП 20.13330.2016 — снег III, ветер II
      snowRegion: 'III',
      windRegion: 'II',
      terrain: 'B',
      drift: true,
      /** снеговой мешок: параметры формулы (Б.5) СП 20 */
      houseRoofLength: 6000, // l₁ — длина верхнего покрытия, мм
      driftM: 0.4,           // m₁ = m₂ — доля переносимого ветром снега
      parapet: false,        // сплошной парапет у перепада → m₁ = 0
      ce: 1.0, ct: 1.0,
      cUp: 1.4, cUnder: 0.8, cDown: 0.5,
    },
    roofing: 'prof8',
    rafters: {
      xs: Array.from({ length: nRafters }, (_, i) => (B * i) / (nRafters - 1)),
      sectionId: 't50x250',
    },
    posts: {
      xs: Array.from({ length: nPosts }, (_, i) => (B * i) / (nPosts - 1)),
      sectionId: 's100x100x3',
      mu: 2.0,
    },
    purlin: { sectionId: 's80x140x4' },
    /** Столбы у стены — притянуты сквозными шпильками к газоблоку. */
    wallPosts: {
      xs: Array.from({ length: nWallPosts }, (_, i) => (B * i) / (nWallPosts - 1)),
      sectionId: 's60x60x3',
      mu: 1.0,            // раскреплён стеной по всей высоте
      boltCount: 3,       // шпилек на столб
      boltDiameter: 16,   // М16
      boltGrade: '5.8',
      plateSize: 120,     // квадратная шайба-пластина изнутри, мм
      blockClass: 'B2.5', // класс газоблока по прочности на сжатие
      wallThickness: 300,
    },
    /** Обвязочная доска поверх стеновых столбов — по ней идут стропила. */
    wallPurlin: { sectionId: 't50x200' },
    battens: { sectionId: 't50x50', spacing: 600 },
    opts: {
      timber: { grade: 2, serviceClass: 3 },
      steel: { grade: 'C245', gammaC: 1.0 },
      bearingLength: 100,
      postEccentricity: 50,
      stockLength: 6000, // стандартная длина доски и трубы в продаже
    },
    /**
     * Цены — ориентировочные, подставьте свои.
     * Дерево считается по объёму, металл по массе, кровля по площади,
     * метизы поштучно.
     */
    prices: {
      timberM3: 25000,   // ₽ за м³ обрезной доски
      steelKg: 120,      // ₽ за кг профильной трубы
      roofingM2: 600,    // ₽ за м² покрытия
      fastenerPc: 150,   // ₽ за комплект шпилька + пластина + гайки
      currency: '₽',
    },
  };
}

/** Равномерно распределить n элементов по ширине B. */
export function spread(B, n) {
  return Array.from({ length: n }, (_, i) => (B * i) / (n - 1));
}

/** Грузовые ширины: половина расстояния до соседей слева и справа. */
export function tributaries(xs, B) {
  const s = [...xs].sort((p, q) => p - q);
  return s.map((x, i) => {
    const left = i === 0 ? 0 : (x - s[i - 1]) / 2;
    const right = i === s.length - 1 ? 0 : (s[i + 1] - x) / 2;
    const edgeLeft = i === 0 ? Math.max(0, x - 0) : 0;
    const edgeRight = i === s.length - 1 ? Math.max(0, B - x) : 0;
    return left + right + edgeLeft + edgeRight;
  });
}

/**
 * Высотные отметки, мм от верха фундамента.
 *
 * Один источник и для расчёта, и для чертежа, и для спецификации: иначе
 * разрез показывает одну длину столба, а смета другую.
 *
 *   прогон лежит на наружном столбе, стропила лежат на прогоне;
 *   у стены стропила лежат на обвязке, обвязка — на стеновом столбе,
 *   поэтому стеновой столб ниже отметки стропил на высоту обвязки.
 */
export function levels(m) {
  const rise = m.geom.L * Math.tan((m.geom.alpha * Math.PI) / 180);
  const purlinH = section(m.purlin.sectionId).h;
  const wallPurlinH = section(m.wallPurlin.sectionId).h;
  const rafterH = section(m.rafters.sectionId).h;

  const postTop = m.geom.postHeight;
  const rafterBottomOuter = postTop + purlinH;
  const rafterBottomWall = rafterBottomOuter + rise;
  const wallPostTop = rafterBottomWall - wallPurlinH;
  const canopyTopWall = rafterBottomWall + rafterH;

  return {
    rise, purlinH, wallPurlinH, rafterH,
    postTop, wallPostTop,
    rafterBottomOuter, rafterBottomWall, canopyTopWall,
    houseRoof: canopyTopWall + m.geom.driftH,
    /** длины для спецификации: +300 мм на заделку в фундамент */
    postLength: postTop + 300,
    wallPostLength: wallPostTop + 300,
  };
}

/**
 * Отметки сквозных шпилек по высоте стенового столба, мм от базы.
 * Крайние отступают от концов, чтобы не рвать газоблок у края.
 */
export function boltHeights(H, n) {
  if (n <= 1) return [H * 0.55];
  const lo = H * 0.12, hi = H * 0.92;
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}
