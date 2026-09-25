import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel } from '../src/core/model.js';
import { analyse, billOfMaterials } from '../src/core/analysis.js';
import { anchorConeEdge } from '../src/core/checks.js';
import { CONCRETE, WALL_GAP, sidePlate, postBase } from '../src/core/fasteners.js';
import { buildSolids, buildContext } from '../src/ui/solids.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} вместо ${b}`);

test('столб у стены: блок рядом с лентой — плита-столик вручную', () => {
  const r = analyse(defaultModel());
  const b = r.bases.wall;
  assert.ok(b.beside, 'по умолчанию блок у стены должен стоять рядом с фундаментом дома');
  // столб 60×60, плита 4 × М12 шириной 250: анкеры в 60 + 40 = 100 и 100 + 170 = 270 мм от стены
  assert.deepEqual(b.plate, { L: 310, B: 250, uPost: 30, uIn: 100, uOut: 270 }, 'геометрия плиты-столика');
  close(b.offset, WALL_GAP + 250 - 30, 1e-9, 'центр блока от оси столба: зазор + половина блока − половина столба');

  const N = b.N, Nup = b.uplift, Rb = CONCRETE.B20.Rb;
  const d = 270 - WALL_GAP, arm = 270 - 30;
  close(b.sigmaNeed, (2 * N * arm) / (250 * d * d), 1e-9, 'смятие у края: σ_тр = 2·N·(u_о − u_ст)/(B·d²)');
  // прямоугольная эпюра R_b шириной Y у края блока: момент относительно дальнего ряда
  const Y = d - Math.sqrt(d * d - (2 * N * arm) / (Rb * 250));
  close(Rb * 250 * Y * (d - Y / 2), N * arm, 1e-6, 'эпюра у края не уравновешивает сжатие столба');
  close(b.T, Rb * 250 * Y - N, 1e-6, 'растяжение дальнего ряда при сжатии');
  // отрыв: рычаг относительно дальнего края
  close(b.Tin, (Nup * (270 - 30)) / (270 - 100), 1e-6, 'растяжение ближнего ряда при отрыве');
  close(b.Na, Math.max(b.T, b.Tin) / 2, 1e-6, 'на анкер: больший ряд пополам');
  const names = b.checks.map((c) => c.name);
  for (const n of ['Смятие бетона у края блока', 'Изгиб плиты-столика', 'Вырыв конуса бетона у края блока', 'Вес фундамента против отрыва']) {
    assert.ok(names.includes(n), `нет проверки «${n}»`);
  }
});

test('столб у стены: шпильки на овальных отверстиях отрыв не держат', () => {
  const m = defaultModel();
  const beside = analyse(m).wallPosts;
  m.wallPosts.footing = 'axis';
  const axis = analyse(m).wallPosts;
  const p = axis[1];
  assert.ok(p.Nup / p.bolts.count > beside[1].bolts.Vbolt + 1, 'при блоке по оси отрыв должен идти в шпильки');
  close(p.bolts.Vbolt, Math.max(p.Nup, beside[1].bolts.Vbolt * p.bolts.count) / p.bolts.count, 1e-6, 'срез шпильки при блоке по оси');
  for (const q of beside) {
    assert.ok(q.bolts.slotted, 'у блока рядом с лентой шпильки должны быть на овалах');
    assert.ok(q.bolts.Vbolt < q.Nup / q.bolts.count, `столб ${q.x}: в срез шпильки попал отрыв`);
  }
});

test('столб у стены: пучение тянет блок у ленты за три грани, а не за четыре', () => {
  const m = defaultModel();
  m.site.frostDepth = 1400;
  const beside = analyse(m).bases.wall.heave;
  m.wallPosts.footing = 'axis';
  const axis = analyse(m).bases.wall.heave;
  assert.ok(beside.applies && axis.applies, 'пучение должно проверяться при заданном промерзании');
  close(beside.pull / axis.pull, 3 / 4, 1e-9, 'грань на прокладке не должна тянуть');
  close(beside.Frf / Math.max(1e-9, axis.Frf), axis.Frf ? 3 / 4 : 0, 1e-9, 'трения по грани на прокладке нет');
});

test('столб у стены: забетонировать вплотную к стене нельзя — плита на анкерах', () => {
  const m = defaultModel();
  m.postBase.id = 'embed800';
  const r = analyse(m);
  assert.equal(r.bases.outer.base.kind, 'embed', 'наружные остаются забетонированными');
  assert.equal(r.bases.wall.base.kind, 'plate', 'у стены должна быть плита на анкерах');
  assert.ok(r.bases.wall.forcedPlate, 'подмена заделки плитой должна быть отмечена');
  m.wallPosts.footing = 'axis';
  assert.equal(analyse(m).bases.wall.base.kind, 'embed', 'при блоке по оси заделка у стены возможна');
});

test('вырыв конуса у края: круг без сегмента за гранью', () => {
  const full = anchorConeEdge(1, 100, 100, 1, '');
  close(full.limit, Math.PI * 100 * 100, 1e-6, 'грань дальше h_ef — конус целый');
  close(anchorConeEdge(1, 100, 0, 1, '').limit, (Math.PI * 100 * 100) / 2, 1e-6, 'анкер у самой грани — полкруга');
  const c = 50, r = 100;
  const seg = r * r * Math.acos(c / r) - c * Math.sqrt(r * r - c * c);
  close(anchorConeEdge(1, r, c, 1, '').limit, Math.PI * r * r - seg, 1e-6, 'сегмент круга за гранью');
});

test('3D: блок у стены не заходит в стену, плита-столик от грани стены', () => {
  const r = analyse(defaultModel());
  const wall = buildContext(r).wall;
  const face = wall.from[1] + wall.h / 2; // лицевая грань стены
  const solids = buildSolids(r);
  const blocks = solids.filter((e) => e.kind === 'base' && e.sel.side === 'wall');
  assert.equal(blocks.length, r.model.wallPosts.xs.length, 'не под каждым столбом у стены блок');
  for (const blk of blocks) {
    close(blk.from[1] - blk.h / 2, face + WALL_GAP, 1e-9, 'внутренняя грань блока — за прокладкой от стены');
  }
  const plates = solids.filter((e) => e.kind === 'basePlate' && e.sel.side === 'wall');
  const pl = sidePlate(postBase('plate4m12'), r.wallPosts[0].sec.h);
  for (const p of plates) {
    close(p.from[1] - p.h / 2, face, 1e-9, 'плита-столик должна начинаться у грани стены');
    close(p.h, pl.L, 1e-9, 'длина плиты в 3D — не та, что в расчёте');
  }
});

test('смета: у стены плита-столик своего размера', () => {
  const b = billOfMaterials(analyse(defaultModel()));
  const wall = b.fasteners.find((f) => f.name === 'Плита базы 310×250×10 мм');
  assert.ok(wall, 'в смете нет плиты-столика');
  assert.equal(wall.count, 5, 'плит-столиков — по числу столбов у стены');
  assert.equal(b.fasteners.find((f) => f.name === 'Плита базы 250×250×10 мм').count, 4, 'обычных плит — по числу наружных столбов');
  assert.equal(b.fasteners.find((f) => /^Анкер/.test(f.name)).count, 36, 'анкеров 4 × 9 столбов');
});
