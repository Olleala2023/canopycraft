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
      houseRoofLength: 6000, // l′₁ — длина верхнего покрытия, мм
      houseRoofSlope: 20,    // α кровли дома, град: ≤ 20° → m₁ = 0,4, иначе 0,3
      crossSlope: 0,         // φ — поперечный уклон навеса, град (перечисление «в»)
      reverseSlope: false,   // уклон навеса к стене → k₂ = 1
      parapet: false,        // сплошной парапет у перепада → m₁ = 0 (прим. 4)
      ce: 1.0, ct: 1.0,
      cUp: 1.4, cUnder: 0.8, cDown: 0.5,
      /**
       * Мороз: нормативная глубина промерзания для суглинков по карте, мм, и
       * грунт на площадке. 0 — не задано: подставлять глубину по памяти нельзя,
       * поэтому по умолчанию фундамент по морозу не проверен, и об этом
       * предупреждение над сводкой.
       */
      frostDepth: 0,
      soil: 'clay',
    },
    roofing: 'prof8',
    rafters: {
      xs: Array.from({ length: nRafters }, (_, i) => (B * i) / (nRafters - 1)),
      sectionId: 't50x250',
    },
    posts: {
      xs: Array.from({ length: nPosts }, (_, i) => (B * i) / (nPosts - 1)),
      sectionId: 's100x100x3',
    },
    /**
     * Что держит верх наружного ряда от смещения — отсюда и μ столбов.
     * Выбирается не μ, а схема: μ из списка можно было поставить 1,0 без
     * единой связи, и столб проходил, хотя верх ничем не удержан.
     *
     * Поперёк ряда верх держат сами стропила — это распорки до стены; их
     * крепление и обвязка у стены на это усилие проверяются, выбирать нечего.
     * Вдоль стены стропила на шарнирах — параллелограмм, держать может только
     * связь: 'none' — ничего, столбы консоли, μ = 2; 'cross' — крест из двух
     * диагоналей в крайнем пролёте ряда (bays — в одном или в обоих крайних),
     * μ = 1. По умолчанию ничего, как и раньше: программа не вправе считать,
     * что связь есть.
     */
    bracing: { along: 'none', bays: 1, sectionId: 's40x40x3' },
    purlin: { sectionId: 's80x140x4' },
    /** Крепление стропила к опоре от ветрового отрыва — см. core/fasteners.js */
    rafterTie: { id: 'nail4x50' },
    /** Узлы «прогон — столб»: наружный ряд сварной, у стены болтовой (там сосна) */
    purlinTie: { id: 'weld3' },
    /**
     * База столба: чем он держится за фундамент — см. core/fasteners.js.
     * Бетонный блок задаётся размерами: сторона и глубина. Его вес —
     * единственное, что держит лёгкий навес от вырыва вверх, поэтому
     * размеры задаёт пользователь, а расчёт их проверяет.
     */
    postBase: { id: 'plate4m12', footing: 500, depth: 1200 },
    wallPurlinTie: { id: 'plate12x2' },
    /** Столбы у стены — притянуты сквозными шпильками к газоблоку. */
    wallPosts: {
      xs: Array.from({ length: nWallPosts }, (_, i) => (B * i) / (nWallPosts - 1)),
      sectionId: 's60x60x3',
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
      concreteClass: 'B20',
      stockLength: 6000, // стандартная длина доски и трубы в продаже
      /**
       * Как выполнен стык по длине там, где элемент длиннее хлыста:
       * 'butt' — встык, момент через стык не идёт (шарнир), так делают,
       * если о стыке не подумали; 'plate' — накладка восстанавливает сечение,
       * балка остаётся неразрезной. По умолчанию худший случай, как и μ = 2
       * у столбов: программа не вправе считать, что накладка есть.
       */
      spliceJoint: 'butt',
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
      anglePc: 60,       // ₽ за перфорированный уголок крепления стропила
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
 * Раскладка стыков линейного элемента по длине хлыста.
 *
 * Элемент длиннее хлыста купить нельзя — его собирают из кусков, и в местах
 * стыка балка перестаёт быть неразрезной, если стык не восстанавливает
 * сечение накладкой. Стыки раскладываются от левого конца через длину хлыста:
 * так их режут на практике, а остаток уходит в последний кусок.
 *
 * Отдельно проверяется опирание каждого куска. Кусок, попавший меньше чем на
 * две опоры, — это уже не балка с пониженным запасом, а геометрически
 * изменяемая схема. Опора точно в месте стыка засчитывается обоим кускам:
 * физически они оба на неё ложатся.
 *
 * @param {number} length длина элемента, мм
 * @param {number} stock длина хлыста в продаже, мм
 * @param {number[]} supports координаты опор по длине элемента, мм
 */
const SPLICE_EPS = 1; // мм: округления сечений и длин не должны плодить лишний стык

/** Куски, на которые заданные стыки делят элемент, и опирание каждого. */
function splicePieces(length, at, supports) {
  const sup = [...supports].sort((a, b) => a - b);
  const bounds = [0, ...at, length];
  const cuts = bounds.slice(0, -1).map((x0, i) => {
    const x1 = bounds[i + 1];
    const on = sup.filter((x) => x >= x0 - SPLICE_EPS && x <= x1 + SPLICE_EPS).length;
    return { x0, x1, length: x1 - x0, supports: on, unstable: on < 2 };
  });
  return { pieces: at.length + 1, splices: at.length, at, cuts, unstable: cuts.some((c) => c.unstable) };
}

/**
 * Стыки встык — только по опорам.
 *
 * Стык без накладки не передаёт ни момента, ни поперечной силы: два торца
 * просто стоят рядом. Значит, он обязан лежать на опоре, иначе куски не
 * связаны ничем и каждый должен стоять на своих ногах. Кладём стык на самую
 * дальнюю опору в пределах хлыста — так и режут на практике.
 *
 * Если опоры в пределах хлыста нет, собрать нельзя: возвращается impossible.
 */
export function spliceAtSupports(length, stock, supports) {
  const inner = [...supports].sort((a, b) => a - b)
    .filter((x) => x > SPLICE_EPS && x < length - SPLICE_EPS);
  const at = [];
  let start = 0;
  while (length - start > stock + SPLICE_EPS) {
    let pick = -1;
    for (const x of inner) if (x > start + SPLICE_EPS && x <= start + stock + SPLICE_EPS) pick = x;
    if (pick < 0) return { at, impossible: true, from: start };
    at.push(pick);
    start = pick;
  }
  return { at, impossible: false, from: null };
}

/**
 * Раскладка стыков линейного элемента по длине хлыста.
 *
 * Элемент длиннее хлыста купить нельзя — его собирают из кусков. По умолчанию
 * стыки идут от левого конца через длину хлыста: так режут, когда стык держит
 * накладка и место его не принципиально. С opts.onSupports стыки кладутся на
 * опоры — это обязательно для стыка встык.
 *
 * Отдельно проверяется опирание каждого куска. Кусок, попавший меньше чем на
 * две опоры, — это уже не балка с пониженным запасом, а геометрически
 * изменяемая схема. Опора точно в месте стыка засчитывается обоим кускам:
 * физически они оба на неё ложатся.
 *
 * @param {number} length длина элемента, мм
 * @param {number} stock длина хлыста в продаже, мм
 * @param {number[]} supports координаты опор по длине элемента, мм
 * @param {{onSupports?:boolean}} [opts]
 */
export function splicePlan(length, stock, supports = [], opts = {}) {
  if (opts.onSupports) {
    const s = spliceAtSupports(length, stock, supports);
    return { stock, impossible: s.impossible, from: s.from, ...splicePieces(length, s.at, supports) };
  }
  const pieces = Math.max(1, Math.ceil((length - SPLICE_EPS) / stock));
  const at = Array.from({ length: pieces - 1 }, (_, i) => stock * (i + 1));
  return { stock, impossible: false, from: null, ...splicePieces(length, at, supports) };
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
