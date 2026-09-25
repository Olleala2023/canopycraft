/**
 * Сборка расчёта: передача нагрузок по цепочке и проверки всех элементов.
 *
 * кровля → обрешётка → стропила → { прогон | брус у стены } → столбы → фундамент
 *
 * Сами элементы считаются в своих модулях (roof, ties, posts, bases, splices),
 * смета — в bom. Этот модуль собирает их в один результат и отдаёт наружу
 * всё, чем пользуются интерфейс, подбор и тесты.
 *
 * Единицы: мм, Н, Н/мм (= кН/м), МПа, кПа.
 */

import { worstOf } from './checks.js';
import { deg, G0 } from './common.js';
import { analyseSpliceJoints, spliceReport } from './splices.js';
import { analyseLineBeam, analyseRoof, supportLoads } from './roof.js';
import { analyseTies, wallPurlinLateral, analyseBeamTies } from './ties.js';
import { postMu, analysePostRow, analyseRoofBrace, analyseCross } from './posts.js';
import { analysePostBases } from './bases.js';

export function analyse(model) {
  const { ctx, dead, snow, wind, rafters, battens } = analyseRoof(model);
  const sl = supportLoads(model, { ctx, dead, snow, wind, rafters, battens });

  const purlin = analyseLineBeam(model, model.purlin.sectionId, sl.outer.supports, sl.outer.loads, sl.outer.label);
  const wallPurlin = analyseLineBeam(model, model.wallPurlin.sectionId, sl.wall.supports, sl.wall.loads, sl.wall.label);

  const posts = analysePostRow(model, model.posts, purlin, ctx, sl.outer.extra);
  // верх наружного ряда поперёк держат стропила: всё, что ряд им отдаёт,
  // по стропилам уходит к стене — в узлы крепления, обвязку и стеновой ряд
  const holdX = posts.reduce((a, p) => a + p.holdX, 0);
  const toWall = sl.thrust.total + holdX;
  // диагонали по кровле отдают силу вдоль стены по обвязке в шпильки: ветер
  // там уже учтён целиком, добавляются условные силы наружных столбов
  const roofQfic = model.bracing?.along === 'roof' ? posts.reduce((a, p) => a + p.QficY, 0) : 0;
  const wallPosts = analysePostRow(model, model.wallPosts, wallPurlin, ctx,
    { ...sl.wall.extra, thrust: toWall, alongWall: sl.wall.extra.alongWall + roofQfic });
  const nR = Math.max(1, model.rafters.xs.length);
  const ties = analyseTies(model, rafters, ctx, { outer: holdX / nR, wall: toWall / nR });
  const lateral = wallPurlinLateral(model, wallPurlin, sl.wall.supports, toWall);
  // у изменяемой схемы других проверок нет — боковой изгиб тоже не к чему прикладывать
  if (!wallPurlin.mechanism) Object.assign(wallPurlin, worstOf([...wallPurlin.checks, lateral]));
  Object.assign(wallPurlin, { lateral, lateralH: toWall });
  const cross = analyseCross(model, posts);
  const roofBrace = analyseRoofBrace(model, posts, rafters, { purlin, wallPurlin });
  const brace = cross ?? roofBrace;
  const beamTies = analyseBeamTies(model, purlin, wallPurlin, posts, wallPosts);
  const bases = analysePostBases(model, posts, wallPosts, ctx);
  const ca = Math.cos(deg(model.geom.alpha));
  const worstRafter = rafters.reduce((a, b) => (a.U > b.U ? a : b));
  const spliceJoints = analyseSpliceJoints(model, [
    { key: 'purlin', label: 'Прогон наружный', el: purlin, length: model.geom.B, supports: sl.outer.supports },
    { key: 'wallPurlin', label: 'Обвязка у стены', el: wallPurlin, length: model.geom.B, supports: sl.wall.supports },
    { key: 'rafters', label: 'Стропило', el: worstRafter, length: worstRafter.Ls, supports: [0, model.geom.L / ca] },
  ]);

  const maxUplift = Math.max(0, ...posts.map((p) => p.Nup));
  const foundation = {
    uplift: maxUplift,
    /** сила, которую фундамент обязан удержать, кН — с коэффициентом 0,9 на вес */
    requiredHold: maxUplift / 0.9 / 1000,
    /** та же величина в килограммах бетона: человек считает фундамент весом, а не ньютонами */
    requiredMassKg: maxUplift / 0.9 / G0,
    cubeSide: Math.cbrt(Math.max(0.001, maxUplift / 0.9 / 1000 / 24)) * 1000,
    maxDown: Math.max(...posts.map((p) => p.N)),
  };

  const rowWorst = (list) => list.reduce((a, b) => (a.U > b.U ? a : b));
  const all = [
    { key: 'battens', label: 'Обрешётка', U: battens.U, worst: battens.worst },
    { key: 'rafters', label: 'Стропила', U: Math.max(...rafters.map((r) => r.U)), worst: rowWorst(rafters).worst },
    { key: 'purlin', label: 'Прогон наружный', U: purlin.U, worst: purlin.worst },
    { key: 'posts', label: 'Столбы наружные', U: Math.max(...posts.map((p) => p.U)), worst: rowWorst(posts).worst },
    { key: 'wallPurlin', label: 'Обвязка у стены', U: wallPurlin.U, worst: wallPurlin.worst },
    { key: 'wallPosts', label: 'Столбы у стены', U: Math.max(...wallPosts.map((p) => p.U)), worst: rowWorst(wallPosts).worst },
    { key: 'ties', label: 'Крепление стропил', U: Math.max(ties.outer.U, ties.wall.U),
      worst: (ties.outer.U > ties.wall.U ? ties.outer : ties.wall).worst },
    { key: 'beamTies', label: 'Прогон на столбе', U: Math.max(beamTies.outer.U, beamTies.wall.U),
      worst: (beamTies.outer.U > beamTies.wall.U ? beamTies.outer : beamTies.wall).worst },
    { key: 'bases', label: 'База столба', U: Math.max(bases.outer.U, bases.wall.U),
      worst: (bases.outer.U > bases.wall.U ? bases.outer : bases.wall).worst },
  ];
  if (brace) all.push({ key: 'bracing', label: cross ? 'Связи ряда' : 'Связи по кровле', U: brace.U, worst: brace.worst });
  if (spliceJoints.length) {
    const worstSplice = spliceJoints.reduce((a, b) => (a.U > b.U ? a : b));
    all.push({ key: 'spliceJoints', label: 'Стык по длине', U: worstSplice.U, worst: worstSplice.worst });
  }

  return {
    model, ctx, dead, snow, wind,
    rafters, battens, purlin, wallPurlin, posts, wallPosts, ties, beamTies, bases, foundation,
    cross, roofBrace, brace,
    bracing: { ...postMu(model, 'outer'), holdX, toWall, alongOuter: sl.thrust.alongOuter },
    thrust: sl.thrust,
    splices: spliceReport(model),
    spliceJoints,
    summary: all,
    maxU: Math.max(...all.map((a) => a.U)),
  };
}

// Наружу — всё, чем пользуются интерфейс, подбор и тесты: импортёрам не нужно
// знать, в каком модуле что живёт.
export { billOfMaterials } from './bom.js';
export { analyseRoof, analyseLineBeam, supportLoads } from './roof.js';
export { analysePostRow, analyseCross, analyseRoofBrace, postMu, crossBays, CROSS_INSET } from './posts.js';
export { analyseTies, analyseBeamTies } from './ties.js';
export { analysePostBases } from './bases.js';
export { wallBeside } from './model.js';
export { OPENING_KINDS, houseWall, openingsOf, houseClashes } from './house.js';
export { spliceReport, spliceHinges, spliceScheme, analyseSpliceJoints } from './splices.js';
