/**
 * Материалы: расчётные сопротивления и коэффициенты условий работы.
 * Дерево — СП 64.13330.2017, сталь — СП 16.13330.2017.
 * Напряжения в МПа (Н/мм²), модули в МПа.
 */

/** Расчётные сопротивления сосны/ели, МПа. Табл. 3 СП 64.13330.2017. */
const TIMBER_GRADES = {
  1: { bendSmall: 14, bendMid: 15, bendWide: 16, tension: 10, shear: 1.8 },
  2: { bendSmall: 13, bendMid: 14, bendWide: 15, tension: 7, shear: 1.8 },
  3: { bendSmall: 8.5, bendMid: 10, bendWide: 11, tension: 0, shear: 1.6 },
};

/**
 * Коэффициент условий работы по влажности m_в, табл. 9 СП 64.13330.2017.
 * 1–2 — закрытые помещения и под навесом, 3 — открытый воздух, 4 — влажная среда.
 */
const SERVICE_CLASS_M = { 1: 1.0, 2: 1.0, 3: 0.9, 4: 0.85 };

export const TIMBER_DEFAULTS = {
  grade: 2,
  serviceClass: 3, // навес — открытый воздух
  E: 10000,
  G: 500,
  Rcm90: 3.0, // местное смятие поперёк волокон
  density: 5.0, // кН/м³
};

/**
 * Расчётные характеристики деревянного элемента заданного сечения.
 * @param {{h:number,b:number}} sec
 * @param {{grade?:number,serviceClass?:number,mdl?:number}} opts
 */
export function timberProps(sec, opts = {}) {
  const grade = opts.grade ?? TIMBER_DEFAULTS.grade;
  const cls = opts.serviceClass ?? TIMBER_DEFAULTS.serviceClass;
  const mdl = opts.mdl ?? 1.0; // 1,0 — сочетание с кратковременной (снег); 0,66 — только постоянная
  const g = TIMBER_GRADES[grade];
  // выбор строки таблицы 3 по ширине и высоте сечения
  let Rbase;
  if (sec.b > 130 && sec.h > 110 && sec.h <= 500) Rbase = g.bendWide;
  else if (sec.b > 110 && sec.h > 110 && sec.h <= 500) Rbase = g.bendMid;
  else Rbase = g.bendSmall;
  const mv = SERVICE_CLASS_M[cls];
  const k = mv * mdl;
  return {
    material: 'timber',
    Rbend: Rbase * k,
    Rcompr: Rbase * k,
    Rtens: g.tension * k,
    Rshear: g.shear * k,
    Rcm90: TIMBER_DEFAULTS.Rcm90 * mv,
    E: TIMBER_DEFAULTS.E,
    G: TIMBER_DEFAULTS.G,
    mv, mdl, grade,
    note: `сосна ${grade} сорт, m_в=${mv}, m_дл=${mdl}`,
  };
}

/** Стали для гнутосварных профилей. R_y, R_un — МПа. */
const STEELS = {
  C245: { Ry: 240, Run: 370, label: 'С245' },
  C255: { Ry: 240, Run: 370, label: 'С255' },
  C345: { Ry: 315, Run: 470, label: 'С345' },
};

export const STEEL_DEFAULTS = { grade: 'C245', gammaC: 1.0, E: 206000, G: 79000, density: 78.5 };

export function steelProps(opts = {}) {
  const g = STEELS[opts.grade ?? STEEL_DEFAULTS.grade];
  const gammaC = opts.gammaC ?? STEEL_DEFAULTS.gammaC;
  return {
    material: 'steel',
    Ry: g.Ry,
    Run: g.Run,
    Rs: 0.58 * g.Ry,
    E: STEEL_DEFAULTS.E,
    G: STEEL_DEFAULTS.G,
    gammaC,
    label: g.label,
    note: `${g.label}, γ_c=${gammaC}`,
  };
}

/** Свойства материала по сечению и настройкам модели. */
export function propsFor(sec, opts = {}) {
  return sec.material === 'timber' ? timberProps(sec, opts.timber) : steelProps(opts.steel);
}

export { TIMBER_GRADES, SERVICE_CLASS_M, STEELS };
