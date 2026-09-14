/**
 * Нагрузки и их сочетания — СП 20.13330.2016.
 * Давления в кПа (кН/м²), длины в мм, углы в градусах.
 */

/**
 * НОРМАТИВНОЕ значение веса снегового покрова S_g, кПа. Табл. 10.1 СП 20.13330.2016.
 * Изменение № 2 перевело таблицу из расчётных значений в нормативные:
 * по п. 10.1 формула даёт нормативную нагрузку, а расчётная получается
 * умножением на γ_f = 1,4 (п. 10.12).
 */
export const SNOW_REGIONS = { I: 0.5, II: 1.0, III: 1.5, IV: 2.0, V: 2.5, VI: 3.0, VII: 3.5, VIII: 4.0 };

/** Нормативное давление ветра w_0, кПа. Табл. 11.1. */
export const WIND_REGIONS = { Ia: 0.17, I: 0.23, II: 0.30, III: 0.38, IV: 0.48, V: 0.60, VI: 0.73, VII: 0.85 };

/** k(z_e) — табл. 11.2. Типы местности: A открытая, B пригород/лес, C плотная застройка. */
const K_TABLE = {
  A: [[5, 0.75], [10, 1.0], [20, 1.25], [40, 1.5], [60, 1.7], [80, 1.85], [100, 2.0]],
  B: [[5, 0.5], [10, 0.65], [20, 0.85], [40, 1.1], [60, 1.3], [80, 1.45], [100, 1.6]],
  C: [[5, 0.4], [10, 0.4], [20, 0.55], [40, 0.8], [60, 1.0], [80, 1.15], [100, 1.25]],
};
/** ζ(z_e) — коэффициент пульсаций давления ветра, табл. 11.4. */
const ZETA_TABLE = {
  A: [[5, 0.85], [10, 0.76], [20, 0.69], [40, 0.62], [60, 0.58], [80, 0.56], [100, 0.54]],
  B: [[5, 1.22], [10, 1.06], [20, 0.92], [40, 0.80], [60, 0.75], [80, 0.71], [100, 0.68]],
  C: [[5, 1.78], [10, 1.78], [20, 1.50], [40, 1.26], [60, 1.14], [80, 1.06], [100, 1.0]],
};

function interp(table, z) {
  if (z <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (z <= table[i][0]) {
      const [z0, v0] = table[i - 1], [z1, v1] = table[i];
      return v0 + ((v1 - v0) * (z - z0)) / (z1 - z0);
    }
  }
  return table[table.length - 1][1];
}

/** Кровельные покрытия: собственный вес по скату, кН/м², и предельный пролёт обрешётки, мм. */
export const ROOFING = {
  pc6: { label: 'Поликарбонат сотовый 6 мм', g: 0.013, maxBatten: 600 },
  pc8: { label: 'Поликарбонат сотовый 8 мм', g: 0.015, maxBatten: 700 },
  pc10: { label: 'Поликарбонат сотовый 10 мм', g: 0.017, maxBatten: 900 },
  pcm4: { label: 'Поликарбонат монолитный 4 мм', g: 0.048, maxBatten: 700 },
  prof8: { label: 'Профлист С8–С21, 0,5 мм', g: 0.05, maxBatten: 800 },
  prof35: { label: 'Профлист НС35–Н60, 0,7 мм', g: 0.08, maxBatten: 1500 },
  metal: { label: 'Металлочерепица', g: 0.05, maxBatten: 350 },
  soft: { label: 'Мягкая черепица по OSB-9', g: 0.20, maxBatten: 250 },
};

/** μ для односкатного покрытия. Прил. Б.1 СП 20. */
export function snowMu(alphaDeg) {
  if (alphaDeg <= 30) return 1.0;
  if (alphaDeg >= 60) return 0.0;
  return (60 - alphaDeg) / 30;
}

/**
 * Снеговой мешок у перепада высоты.
 * СП 20.13330.2016, приложение Б, схема Б.8 (рисунок Б.11, профиль «в» — навес).
 *
 *   (Б.5)  μ = 1 + (m₁·l′₁ + m₂·l′₂) / h
 *
 * Перечисление «в» — для пониженных покрытий шириной a < 21 м:
 *   m₂ = 0,5·k₁·k₂·k₃, но не менее 0,1
 *   k₁ = √(a/21);  k₂ = 1 − β/35 (при обратном уклоне k₂ = 1);  k₃ = 1 − φ/30, но не менее 0,3
 *
 * Перечисление «г» — длина зоны повышенных снегоотложений:
 *   при μ ≤ 2h/S₀ :  b = 2h, но не более 16 м
 *   при μ > 2h/S₀ :  (Б.6)  b = 2h · (μ − 1 + 2m₂) / (2h/S₀ − 1 + 2m₂),
 *                    но не более 5h и не более 16 м
 *
 * Перечисление «д» — потолок μ: 2h/S₀; 4 для покрытия здания при l′ ≤ 48 м;
 *   6 для навеса либо покрытия здания при l′ > 72 м, между 48 и 72 — интерполяция.
 *
 * Перечисление «е» — коэффициент μ₁ на дальнем конце зоны.
 *
 * Примечание 3 — при h < S₀/2 местную нагрузку у перепада не учитывают.
 * Примечание 4 — сплошной парапет высотой более 0,5·S₀ и более 1,2 м → m₁ = 0.
 *
 * @param {object} o
 * @param {number} o.h  перепад высоты, м; при h > 8 м принимается 8 м
 * @param {number} o.Sg нормативный вес снегового покрова S₀, кПа
 * @param {number} o.l1 длина верхнего покрытия, м (не более 100)
 * @param {number} o.l2 длина нижнего покрытия, м (не более 100 и не более 3a)
 * @param {number} o.a  ширина нижнего покрытия, м
 * @param {number} [o.beta] уклон нижнего покрытия вдоль переноса, град
 * @param {number} [o.phi] поперечный уклон нижнего покрытия, град
 * @param {boolean} [o.reverseSlope] обратный уклон (к перепаду) → k₂ = 1
 * @param {number} [o.m1] доля переноса с верхнего покрытия (0,4 при α ≤ 20°, иначе 0,3)
 * @param {boolean} [o.parapet] сплошной парапет у перепада → m₁ = 0
 * @param {boolean} [o.lowerIsCanopy] нижнее покрытие — навес
 */
export function snowDrift(o) {
  const h = Math.min(8, Math.max(0, o.h));
  const Sg = o.Sg;
  const a = Math.max(0.1, o.a ?? 21);
  const l1 = Math.min(100, Math.max(0, o.l1 ?? 0));
  // длина переноса по нижнему покрытию без парапетов — не более утроенной ширины
  const l2 = Math.min(100, 3 * a, Math.max(0, o.l2 ?? 0));
  const m1 = o.parapet ? 0 : (o.m1 ?? 0.4);

  // перечисление «в»
  let m2 = o.m2 ?? 0.4;
  let m2parts = null;
  if (a < 21) {
    const k1 = Math.sqrt(a / 21);
    const k2 = o.reverseSlope ? 1 : Math.max(0, 1 - (o.beta ?? 0) / 35);
    const k3 = Math.max(0.3, 1 - (o.phi ?? 0) / 30);
    m2 = Math.max(0.1, 0.5 * k1 * k2 * k3);
    m2parts = { k1, k2, k3 };
  }

  const capGeom = (2 * h) / Sg;
  const capAbs = o.lowerIsCanopy === false ? capBuilding(l1, l2) : 6;
  const none = {
    applies: false, mu: 1, mu1: 1, raw: 1, capGeom, capAbs, governs: 'перепад мал (прим. 3)',
    length: 0, h, l1, l2, a, m1, m2, m2parts,
  };
  if (h <= 0 || h < Sg / 2) return none; // примечание 3

  const raw = 1 + (m1 * l1 + m2 * l2) / h;
  const mu = Math.max(1, Math.min(raw, capGeom, capAbs));

  // перечисление «г» и формула (Б.6)
  const spread = raw > capGeom;
  let b = 2 * h;
  if (spread) {
    const den = capGeom - 1 + 2 * m2;
    b = den > 1e-6 ? (2 * h * (raw - 1 + 2 * m2)) / den : 5 * h;
    b = Math.min(b, 5 * h);
  }
  b = Math.min(b, 16);

  // перечисление «е»
  let mu1;
  if (!o.parapet && (b >= l2 || raw <= capGeom)) mu1 = 1 - 2 * m2;
  else if (o.parapet && (b >= l2 || (l2 > b && raw <= capGeom))) {
    mu1 = l2 > b && raw <= capGeom ? 1 - (m2 * l2) / Math.max(1e-6, l2 - h) : 1 - 2 * m2;
  } else {
    mu1 = (l2 - 0.5 * mu * b) / Math.max(1e-6, l2 - 0.5 * b);
  }
  mu1 = Math.max(0.2, mu1);

  const governs =
    mu === capGeom && capGeom < raw ? 'ограничение μ ≤ 2h/S₀'
      : mu === capAbs && capAbs < raw ? `ограничение μ ≤ ${capAbs.toFixed(1)}`
        : 'формула (Б.5)';

  return { applies: true, mu, mu1, raw, capGeom, capAbs, governs, length: b * 1000, spread, h, l1, l2, a, m1, m2, m2parts };
}

/** Потолок μ для нижнего покрытия здания: 4 при l′ ≤ 48 м, 6 при l′ > 72 м, между — интерполяция. */
function capBuilding(l1, l2) {
  const l = Math.max(l1, l2);
  if (l <= 48) return 4;
  if (l > 72) return 6;
  return 4 + (2 * (l - 48)) / 24;
}

/**
 * Эпюра снега вдоль ската: функция горизонтальной координаты от стены (мм) → кПа.
 * Возвращает НОРМАТИВНОЕ значение (п. 10.1); расчётное = γ_f · нормативное, γ_f = 1,4.
 */
export function snowProfile(site, alphaDeg, geom = {}) {
  const Sg = SNOW_REGIONS[site.snowRegion];
  const muRoof = snowMu(alphaDeg) * (site.ce ?? 1.0) * (site.ct ?? 1.0);
  const uniform = { id: 'uniform', label: 'равномерный', at: () => muRoof * Sg };

  const plain = (drift) => ({
    Sg, muWall: muRoof, driftLength: 0, drift,
    variants: [uniform], at: uniform.at,
  });
  if (!site.drift) return plain(null);

  const d = snowDrift({
    h: (geom.driftH ?? 0) / 1000,
    Sg,
    l1: (site.houseRoofLength ?? 6000) / 1000,
    l2: (geom.depth ?? 0) / 1000,
    a: (geom.width ?? 0) / 1000,
    beta: geom.alpha ?? 0,
    phi: site.crossSlope ?? 0,
    reverseSlope: !!site.reverseSlope,
    m1: (site.houseRoofSlope ?? 20) > 20 ? 0.3 : 0.4,
    parapet: !!site.parapet,
    lowerIsCanopy: true,
  });
  if (!d.applies) return plain(d);

  // схема Б.8: нижнее покрытие считают в двух вариантах — равномерном
  // и с мешком; за расчётный принимается худший для каждого элемента
  const bag = {
    id: 'bag',
    label: 'снеговой мешок',
    at(y) {
      const k = Math.min(1, Math.max(0, y) / d.length);
      return (d.mu - (d.mu - d.mu1) * k) * Sg;
    },
  };
  return { Sg, muWall: d.mu, muEnd: d.mu1, driftLength: d.length, drift: d, variants: [uniform, bag], at: bag.at };
}

/**
 * Ветровое давление на уровне кровли навеса.
 * w = w_0 · k(z_e) · c · (1 + ζ·ν)  — п. 11.1.
 * @returns {{up:number, down:number, lateral:number, wm:number}} кПа, расчётные значения
 */
export function windPressure(site, zMm) {
  const w0 = WIND_REGIONS[site.windRegion];
  const z = Math.max(2, zMm / 1000);
  const k = interp(K_TABLE[site.terrain] ?? K_TABLE.B, z);
  const zeta = interp(ZETA_TABLE[site.terrain] ?? ZETA_TABLE.B, z);
  const nu = 0.95; // коэффициент пространственной корреляции для малых сооружений
  const dyn = 1 + zeta * nu;
  const wm = w0 * k;
  const gammaF = 1.4;
  const cUp = site.cUp ?? 1.4; // отсос сверху
  const cUnder = site.cUnder ?? 0.8; // поддув снизу
  const cDown = site.cDown ?? 0.5; // прижимающая составляющая при другом направлении
  return {
    wm,
    dyn,
    up: w0 * k * dyn * (cUp + cUnder) * gammaF,
    down: w0 * k * dyn * cDown * gammaF,
    lateral: w0 * k * dyn * 1.4 * gammaF, // на боковую проекцию столба/фризовой доски
  };
}

/** Коэффициенты надёжности по нагрузке, табл. 7.1 СП 20. */
export const GAMMA_F = {
  snow: 1.4, // п. 10.12 СП 20
  wind: 1.4, // разд. 11 СП 20
  steel: 1.05,
  timber: 1.1,
  roofing: 1.2,
  relieving: 0.9, // постоянная, когда она разгружает (проверка на отрыв)
};

/**
 * Сочетания нагрузок. Каждое возвращает множители для составляющих.
 * ULS — по прочности и устойчивости, SLS — по прогибам (нормативные нагрузки).
 */
export const COMBOS = [
  { id: 'ULS-1', label: 'G + снег', kind: 'uls', dead: null, snow: 1.0, wind: 0 },
  { id: 'ULS-2', label: 'G + снег + 0,9·ветер↓', kind: 'uls', dead: null, snow: 1.0, wind: 0.9 },
  { id: 'ULS-3', label: '0,9·G − ветер↑ (отрыв)', kind: 'uplift', dead: GAMMA_F.relieving, snow: 0, wind: -1.0 },
  { id: 'SLS', label: 'G_н + S_н (прогибы)', kind: 'sls', dead: 1.0, snow: 0.7, wind: 0 },
];
