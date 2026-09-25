/**
 * База столба и фундамент: защемление в блоке, отрыв, морозное пучение.
 */

import { GAMMA_F } from './loads.js';
import {
  worstOf, boltShear, boltTension, concreteBearing, plateBending, anchorCone, anchorConeEdge,
  edgeBearing, sidePlateBending, embedDepth, anchorMass, foundationFrost, frostHeave,
} from './checks.js';
import {
  BOLT_RT, BOLT_AN, postBase, anchorSpan, minEmbed, CONCRETE,
  CONCRETE_DENSITY, frostDepth, heaveTau, HEAVE_STATES, HEAVE_SURFACES, HEAVE_GAMMA_C,
  HEAVE_GAMMA_N, skinFriction, FRICTION_LAYER, FRICTION_GAMMA_RF, upliftGammaC,
  WALL_GAP, sidePlate,
} from './fasteners.js';
import { G0 } from './common.js';
import { wallBeside } from './model.js';

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
function analysePostBase(model, cfg, posts, ctx, { beside = false } = {}) {
  const chosen = postBase(model.postBase.id);
  // блок у ленты дома: столб стоит у края блока, забетонировать его туда нельзя —
  // у стены тогда плита на анкерах того типа, что по умолчанию
  const forcedPlate = beside && chosen.kind === 'embed';
  const base = forcedPlate ? postBase(DEFAULT_WALL_PLATE) : chosen;
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
  let detail;

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
  // у блока рядом с лентой одна грань — на прокладке, грунта там нет:
  // ни пучения, ни трения по ней
  const faces = beside ? 3 : 4;
  const heave = heaveCheck(model, posts, { side, depth, mass, frost, frostApplies, measure, faces });
  block.heave = heave;
  const frostCheck = () => [
    ...(frostApplies
      ? [foundationFrost(frost.df, depth,
        `${frost.soil.label}: d_fn ${Math.round(frost.dfn)} мм, подошва блока на ${depth} мм`)]
      : []),
    ...(heave.applies ? [heave.check] : []),
  ];

  if (beside) {
    detail = { ...block, ...sidePlateChecks(model, base, sec, mat, conc, { N, uplift, H }, checks) };
    checks.push(anchorMass(uplift, mass, `блок ${side}×${side}×${depth} мм ≈ ${mass.toFixed(0)} кг — шпильки на овальных отверстиях отрыв не держат`));
    checks.push(...frostCheck());
    // центр блока смещён от оси столба наружу: блок стоит за прокладкой
    detail.gap = WALL_GAP;
    detail.offset = WALL_GAP + side / 2 - sec.h / 2;
    detail.forcedPlate = forcedPlate;
  } else if (base.kind === 'embed') {
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
    beside, x: post.x, ...detail, ...worstOf(checks), Usized: sized.U,
  };
}

/** Плита у стены, если выбран забетонированный столб, — её забетонировать нельзя. */
const DEFAULT_WALL_PLATE = 'plate4m12';

/**
 * Плита-«столик» под столбом у стены (см. sidePlate): столб у края плиты, край
 * блока — за зазором WALL_GAP, анкеры двумя рядами за столбом.
 *
 * Координата u — от грани стены наружу. Сжатие N приходит в u_ст = h/2, а бетон
 * начинается только с u = зазор, поэтому плита — рычаг: у края блока бетон
 * мнётся (прямоугольная эпюра R_b шириной Y), дальний ряд анкеров растянут.
 * Равновесие моментов относительно дальнего ряда:
 *   R_b·B·Y·(d − Y/2) = N·(u_о − u_ст), d = u_о − зазор,
 *   T = R_b·B·Y − N.
 * Отрыв: столб тянет плиту вверх у края, ближний ряд держит, дальний край
 * упирается в бетон — по правилу рычага T_б = N_отр·(u_о − u_ст)/(u_о − u_б).
 * Изгиб плиты — в сечении по грани столба от сил справа от неё.
 */
function sidePlateChecks(model, base, sec, mat, conc, { N, uplift, H }, checks) {
  const g = WALL_GAP;
  const pl = sidePlate(base, sec.h);
  const { B, uPost, uIn, uOut } = pl;
  const perRow = base.n / 2;
  const d = uOut - g;
  const arm = uOut - uPost;
  const sigmaNeed = (2 * N * arm) / (B * d * d);
  const disc = d * d - (2 * N * arm) / (conc.Rb * B);
  const Y = disc >= 0 ? d - Math.sqrt(disc) : d;
  const C = conc.Rb * B * Y;
  const T = Math.max(0, C - N);
  // отрыв: ближний ряд держит, дальний край — точка опоры
  const Tin = (uplift * (uOut - uPost)) / (uOut - uIn);
  const Fout = Tin - uplift;
  const NaComp = T / perRow;
  const NaUp = Tin / perRow;
  const Na = Math.max(NaComp, NaUp);
  // изгиб плиты по грани столба: сжатие — анкер снаружи вниз, отпор бетона за гранью вверх
  const x0 = Math.max(g, sec.h);
  const bearOut = Math.max(0, g + Y - x0);
  const Mcomp = Math.abs(T * (uOut - sec.h) - conc.Rb * B * bearOut * (x0 - sec.h + bearOut / 2));
  const Mup = Math.abs(Fout * (uOut - sec.h) - Tin * (uIn - sec.h));
  const Mplate = Math.max(Mcomp, Mup);
  const sigmaPlate = (6 * Mplate) / (B * base.t * base.t);
  const edge = uIn - g; // от ближнего ряда анкеров до грани блока
  const kN = (v) => (v / 1000).toFixed(2).replace('.', ',');
  const concName = model.opts.concreteClass ?? 'B20';

  checks.push(edgeBearing(sigmaNeed, conc.Rb,
    `столб в ${Math.round(uPost)} мм от стены, край блока в ${g} мм, дальний ряд анкеров в ${Math.round(uOut)} мм; бетон ${concName}`));
  checks.push(sidePlateBending(sigmaPlate, mat.Ry,
    `плита ${pl.L}×${B}×${base.t} мм, M = ${(Mplate / 1e6).toFixed(2).replace('.', ',')} кН·м у грани столба`));
  checks.push(boltTension(Na, BOLT_RT[base.grade], BOLT_AN[base.d],
    `${base.n} × М${base.d}, по ${perRow} в ряду: ${NaComp >= NaUp ? `дальний ряд при сжатии ${kN(T)} кН` : `ближний ряд при отрыве ${kN(Tin)} кН`}`));
  checks.push(anchorConeEdge(Na, base.hef, edge, conc.Rbt,
    `заделка ${base.hef} мм, до грани блока ${Math.round(edge)} мм, бетон ${concName}`));
  checks.push(boltShear(H / base.n, base.d, base.grade));

  return { plate: pl, span: uOut - uIn, Na, NaComp, NaUp, T, Tin, Y, sigmaNeed, sigmaPlate, Mplate, edge, c: uOut - sec.h };
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
function heaveCheck(model, posts, { side, depth, mass, frost, frostApplies, measure, faces = 4 }) {
  if (!frostApplies) return { applies: false, reason: frost.set ? 'nonHeaving' : 'noFrost' };
  if (measure === 'replace') return { applies: false, reason: 'replaced', measure };
  const post = posts.reduce((a, p) => (p.Nperm < a.Nperm ? p : a));
  const stateId = model.site.soilState ?? 'wet';
  const surface = HEAVE_SURFACES[model.postBase.surface ?? 'rough20'] ?? HEAVE_SURFACES.rough20;
  const cat1 = !!model.site.geoCat1;
  const tauTable = heaveTau(stateId, frost.dfn);
  const tau = tauTable * surface.k * (cat1 ? 0.9 : 1);           // кПа
  const perimeter = faces * side;                                 // мм, грани в грунте
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
    wall: analysePostBase(model, model.wallPosts, wallPosts, ctx, { beside: wallBeside(model) }),
  };
}
