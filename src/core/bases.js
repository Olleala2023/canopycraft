/**
 * База столба и фундамент: защемление в блоке, отрыв, морозное пучение.
 */

import { GAMMA_F } from './loads.js';
import {
  worstOf, boltShear, boltTension, concreteBearing, plateBending, anchorCone,
  embedDepth, anchorMass, foundationFrost, frostHeave,
} from './checks.js';
import {
  BOLT_RT, BOLT_AN, postBase, anchorSpan, minEmbed, CONCRETE,
  CONCRETE_DENSITY, frostDepth, heaveTau, HEAVE_STATES, HEAVE_SURFACES, HEAVE_GAMMA_C,
  HEAVE_GAMMA_N, skinFriction, FRICTION_LAYER, FRICTION_GAMMA_RF, upliftGammaC,
} from './fasteners.js';
import { G0 } from './common.js';

/* ─────────────────────── БАЗА СТОЛБА ─────────────────────── */

/**
 * База столба — то место, где расчётная схема встречается с землёй.
 *
 * Расчёт столба на устойчивость при μ = 2 или 0,7 предполагает защемление
 * внизу. Значит, база обязана воспринять момент от горизонтальной силы и
 * эксцентриситета опирания — иначе «защемлён внизу» остаётся словами, а
 * настоящая расчётная длина больше принятой.
 *
 * Момент берётся наибольший по эпюре столба, а вертикальная сила — отрывающая.
 * Строго говоря, это разные сочетания, но вместе они дают верхнюю оценку
 * растяжения в анкере — в запас.
 */
function analysePostBase(model, cfg, posts, ctx) {
  const base = postBase(model.postBase.id);
  const post = posts.reduce((a, p) => (p.Nup > a.Nup || (p.Nup === a.Nup && p.Mbase > a.Mbase) ? p : a));
  const sec = post.sec;
  const mat = post.mat;
  const conc = CONCRETE[model.opts.concreteClass] ?? CONCRETE.B20;
  const N = Math.max(0, post.N);
  const uplift = Math.max(0, post.Nup);
  const H = Math.abs(post.Hbase);
  const M = Math.abs(post.Mbase);
  // защемление внизу нужно, если хоть в одной плоскости верх свободен:
  // консоль держится только за фундамент
  const needsFixity = post.muX !== 1 || post.muY !== 1;

  const checks = [];
  let detail = {};

  // Бетонный блок под столбом — один и тот же и для забетонированного столба,
  // и для базы на плите: сторона и глубина задаются в панели. Его вес —
  // единственное, что держит навес от вырыва вверх, поэтому размеры не
  // угадываются, а проверяются. У забетонированного столба блок не может быть
  // мельче заделки: столб в нём стоит.
  const side = Math.max(sec.h + 100, model.postBase.footing ?? 400);
  const depth = Math.max(model.postBase.depth ?? 800, base.kind === 'embed' ? base.embed : 0);
  const mass = ((side * side * depth) / 1e9) * CONCRETE_DENSITY;
  const needMass = uplift / 0.9 / G0;
  // подсказки «сделайте так»: какой глубины хватит при этой стороне и наоборот
  const needVolume = needMass / CONCRETE_DENSITY; // м³
  const step50 = (mm) => Math.ceil(mm / 50) * 50;
  const needDepth = step50((needVolume / ((side / 1000) ** 2)) * 1000);
  const needSide = step50(Math.sqrt(needVolume / (depth / 1000)) * 1000);
  // мороз: для пучинистого грунта подошва не выше расчётной глубины промерзания
  const frost = frostDepth(model.site.frostDepth ?? 0, model.site.soil ?? 'clay');
  const frostApplies = frost.set && frost.soil.heaving;
  const needFrostDepth = frostApplies ? step50(frost.df) : 0;
  const block = {
    side, depth, mass, needMass, needDepth, needSide, enough: mass >= needMass,
    frost: { ...frost, applies: frostApplies, needDepth: needFrostDepth, ok: depth >= needFrostDepth },
  };
  // касательные силы пучения (п. 6.8.6 СП 22): грунт смерзается с боковой
  // поверхностью блока в зоне промерзания и тянет его вверх. Держат одна
  // постоянная нагрузка при γ_f = 0,9 с весом блока и трение о талый грунт
  // ниже промерзания. Замена грунта в пазухах на непучинистый (п. 6.8.12)
  // снимает саму причину — тогда проверка не применяется
  const measure = model.postBase.antiHeave ?? 'none';
  const heave = heaveCheck(model, posts, { side, depth, mass, frost, frostApplies, measure });
  block.heave = heave;
  const frostCheck = () => [
    ...(frostApplies
      ? [foundationFrost(frost.df, depth,
        `${frost.soil.label}: d_fn ${Math.round(frost.dfn)} мм, подошва блока на ${depth} мм`)]
      : []),
    ...(heave.applies ? [heave.check] : []),
  ];

  if (base.kind === 'embed') {
    if (needsFixity) {
      checks.push(embedDepth(base.embed, minEmbed(sec.h),
        `сечение ${sec.label}, схема с защемлением внизу`));
    }
    checks.push(anchorMass(uplift, mass, `блок ${side}×${side}×${depth} мм ≈ ${mass.toFixed(0)} кг`));
    checks.push(concreteBearing(N / (side * side), conc.Rb, `подошва ${side}×${side} мм`));
    checks.push(...frostCheck());
    detail = { ...block, needEmbed: minEmbed(sec.h) };
  } else {
    const A = base.plate * base.plate;
    const W = (base.plate ** 3) / 6;
    const sigma = N / A + M / W;
    const c = Math.max(0, (base.plate - sec.h) / 2);
    const Mc = (sigma * c * c) / 2;                 // Н·мм на 1 мм ширины
    const sigmaPlate = (6 * Mc) / (base.t * base.t);
    const span = anchorSpan(base);
    const rows = base.n / 2;
    const Na = uplift / base.n + M / (span * rows);
    checks.push(concreteBearing(sigma, conc.Rb, `плита ${base.plate}×${base.plate} мм, бетон ${model.opts.concreteClass ?? 'B20'}`));
    checks.push(plateBending(sigmaPlate, mat.Ry, `вылет ${Math.round(c)} мм при толщине ${base.t} мм`));
    checks.push(boltTension(Na, BOLT_RT[base.grade], BOLT_AN[base.d],
      `${base.n} × М${base.d}, разнос ${span} мм: отрыв ${(uplift / base.n / 1000).toFixed(2).replace('.', ',')} + момент ${(M / span / rows / 1000).toFixed(2).replace('.', ',')} кН`));
    checks.push(anchorCone(Na, base.hef, conc.Rbt, `заделка ${base.hef} мм в бетон ${model.opts.concreteClass ?? 'B20'}`));
    checks.push(boltShear(H / base.n, base.d, base.grade));
    // анкеры держат столб за бетон, но сам блок ещё должен не уехать вверх:
    // раньше это число только выводилось в инспекторе и в U не входило
    checks.push(anchorMass(uplift, mass, `блок ${side}×${side}×${depth} мм ≈ ${mass.toFixed(0)} кг`));
    checks.push(...frostCheck());
    detail = { sigma, sigmaPlate, span, Na, c, ...block };
  }

  // пучение размерами блока и исполнением базы не лечится: подбор базы и
  // подбор по цене смотрят на всё остальное, а сама проверка остаётся в U
  const sized = worstOf(checks.filter((c) => c !== heave.check));
  return {
    base, post: sec, N, uplift, H, M, needsFixity, concrete: model.opts.concreteClass ?? 'B20',
    x: post.x, ...detail, ...worstOf(checks), Usized: sized.U,
  };
}

/**
 * Проверка (6.35) для блока под столбом ряда. Считается по самому лёгкому
 * столбу: у него меньше всего постоянной нагрузки, а тянет грунт одинаково.
 *
 * A_fh — боковая поверхность блока в пределах расчётной глубины промерзания,
 * верх блока — на уровне земли. τ_fh — по табл. 6.12 при нормативной глубине
 * промерзания (d_th — глубина сезонного промерзания-оттаивания): она меньше
 * расчётной, а τ с глубиной падает — в запас. Коэффициенты: поверхность блока
 * (прим. 4) и геотехническая категория 1 (прим. 5, ×0,9).
 *
 * F_rf — трение о талый грунт ниже промерзания, формула (6.38): ΣR_f·A_f.
 * R_f — по нормам на сваи: как у набивной сваи на выдёргивание (п. 7.2.13
 * СП 24), R_f = γc·γ_R,f·f_i; f_i — табл. 7.3, слои не толще 2 м, в запас —
 * см. skinFriction. Надбавки из примечаний 3 и 4 к табл. 7.3 не берутся.
 * γc,g из п. 7.1.11 — коэффициент надёжности свайного фундамента — не
 * применяется: в (6.35) уже есть свой γ_n.
 */
function heaveCheck(model, posts, { side, depth, mass, frost, frostApplies, measure }) {
  if (!frostApplies) return { applies: false, reason: frost.set ? 'nonHeaving' : 'noFrost' };
  if (measure === 'replace') return { applies: false, reason: 'replaced', measure };
  const post = posts.reduce((a, p) => (p.Nperm < a.Nperm ? p : a));
  const stateId = model.site.soilState ?? 'wet';
  const surface = HEAVE_SURFACES[model.postBase.surface ?? 'rough20'] ?? HEAVE_SURFACES.rough20;
  const cat1 = !!model.site.geoCat1;
  const tauTable = heaveTau(stateId, frost.dfn);
  const tau = tauTable * surface.k * (cat1 ? 0.9 : 1);           // кПа
  const perimeter = 4 * side;                                     // мм
  const hFrozen = Math.min(frost.df, depth);
  const hThawed = Math.max(0, depth - frost.df);
  const A = (perimeter * hFrozen) / 1e6;                          // м²
  const Abelow = (perimeter * hThawed) / 1e6;
  const pull = tau * A * 1000;                                    // Н
  const blockWeight = GAMMA_F.relieving * mass * G0;
  const F = post.Nperm + blockWeight;
  // трение о талый грунт ниже промерзания: слои не толще 2 м, f по средней глубине слоя
  const IL = (HEAVE_STATES[stateId] ?? HEAVE_STATES.wet).IL;
  const gammaRf = FRICTION_GAMMA_RF[model.site.soil ?? 'clay'] ?? 0.6;
  const gammaC = upliftGammaC(depth);
  const layers = [];
  for (let z = frost.df; z < depth - 1e-6; z += FRICTION_LAYER) {
    const h = Math.min(FRICTION_LAYER, depth - z);
    const zMid = (z + h / 2) / 1000;
    const f = skinFriction(zMid, IL);
    layers.push({ from: z, h, zMid, f, R: gammaC * gammaRf * f, A: (perimeter * h) / 1e6 });
  }
  const Frf = layers.reduce((a, l) => a + l.R * l.A * 1000, 0);    // Н
  const gcgn = HEAVE_GAMMA_C / HEAVE_GAMMA_N;
  const f2 = (v) => (v / 1000).toFixed(1).replace('.', ',');
  const check = frostHeave(pull, F, Frf, gcgn,
    `τ_fh = ${Math.round(tauTable)}${surface.k !== 1 ? ` × ${String(surface.k).replace('.', ',')}` : ''}${cat1 ? ' × 0,9' : ''} = ${Math.round(tau)} кПа на ${A.toFixed(2).replace('.', ',')} м² — тянет ${f2(pull)} кН; `
    + `держат постоянная нагрузка ${f2(post.Nperm)} и блок ${f2(blockWeight)} кН`
    + (layers.length
      ? `, трение о талый грунт ниже промерзания ${f2(Frf)} кН на ${Abelow.toFixed(2).replace('.', ',')} м² (f = ${layers.map((l) => l.f).join(', ')} кПа при I_L ${String(IL).replace('.', ',')} × γc ${String(gammaC).replace('.', ',')} × γ_R,f ${String(gammaRf).replace('.', ',')}) / 1,1`
      : ', ниже промерзания блок не заходит — трения нет'));
  return {
    applies: true, measure, check, stateId, surface, cat1, tauTable, tau, perimeter, hFrozen, hThawed,
    A, Abelow, pull, F, Nperm: post.Nperm, blockWeight, Frf, layers, IL, gammaRf, gammaC, gcgn, x: post.x,
    ratio: pull / Math.max(1, F + gcgn * Frf),
  };
}

export function analysePostBases(model, posts, wallPosts, ctx) {
  return {
    outer: analysePostBase(model, model.posts, posts, ctx),
    wall: analysePostBase(model, model.wallPosts, wallPosts, ctx),
  };
}
