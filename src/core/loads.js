/**
 * Нагрузки и их сочетания — СП 20.13330.2016.
 * Давления в кПа (кН/м²), длины в мм, углы в градусах.
 */

/** Расчётное значение веса снегового покрова S_g, кПа. Табл. 10.1. */
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
 * Снеговой мешок у стены дома — прил. Б, схема Б.10 (перепад высот).
 * @param {number} hDrop перепад высот кровля дома / навес, мм
 * @param {number} Sg расчётный вес снегового покрова, кПа
 * @returns {{mu:number, length:number}} μ у стены и длина зоны намёта, мм
 */
export function snowDrift(hDrop, Sg) {
  const gammaSnow = 2.0; // кН/м³, удельный вес снега
  const h = Math.max(0, hDrop) / 1000;
  const mu = Math.min(4.0, (2 * h * gammaSnow) / Sg);
  const length = Math.min(16000, Math.max(5000, 2 * hDrop));
  return { mu: Math.max(1, mu), length };
}

/**
 * Эпюра снега вдоль ската: функция горизонтальной координаты от стены (мм) → кПа.
 * Расчётное значение; нормативное = 0,7 от расчётного (п. 10.12).
 */
export function snowProfile(site, alphaDeg) {
  const Sg = SNOW_REGIONS[site.snowRegion];
  const muRoof = snowMu(alphaDeg) * (site.ce ?? 1.0) * (site.ct ?? 1.0);
  if (!site.drift) return { at: () => muRoof * Sg, muWall: muRoof, driftLength: 0, Sg };
  const d = snowDrift(site.driftH ?? 1200, Sg);
  const muWall = Math.max(muRoof, d.mu) * (site.ct ?? 1.0);
  return {
    Sg,
    muWall,
    driftLength: d.length,
    at(y) {
      const k = Math.min(1, Math.max(0, y) / d.length);
      return (muWall - (muWall - muRoof) * k) * Sg;
    },
  };
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
