import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel, spread } from '../src/core/model.js';
import { analyse } from '../src/core/analysis.js';
import { drawPlan, drawSection, drawDiagrams, drawNodes } from '../src/ui/views.js';

const VIEWS = [
  ['план', drawPlan, 'План навеса'],
  ['разрез', drawSection, 'Разрез навеса'],
  ['эпюры', drawDiagrams, 'Эпюры'],
  ['узлы', drawNodes, 'Узловые чертежи'],
];

test('каждый вид рисуется и подписан своим именем', () => {
  const res = analyse(defaultModel());
  const sel = { type: 'rafter', index: 0 };
  for (const [name, draw, label] of VIEWS) {
    const out = draw(res, sel);
    assert.ok(out.svg.startsWith('<svg'), `${name}: не SVG`);
    assert.ok(out.svg.includes(`aria-label="${label}`), `${name}: чужая подпись — виды перепутаны`);
    assert.ok(out.svg.endsWith('</svg>'), `${name}: SVG не закрыт`);
  }
});

test('в чертежах нет NaN и undefined', () => {
  const res = analyse(defaultModel());
  for (const [name, draw] of VIEWS) {
    const svg = draw(res, { type: 'rafter', index: 0 }).svg;
    assert.ok(!/NaN|undefined/.test(svg), `${name}: ${(/.{0,60}(NaN|undefined).{0,60}/.exec(svg) ?? [])[0]}`);
  }
});

test('ссылки внутри SVG указывают на объявленные defs', () => {
  const res = analyse(defaultModel());
  for (const [name, draw] of VIEWS) {
    const svg = draw(res, { type: 'rafter', index: 0 }).svg;
    const declared = new Set([...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) {
      assert.ok(declared.has(m[1]), `${name}: ссылка на #${m[1]}, которого нет`);
    }
  }
});

test('узловые чертежи собраны по числам расчёта', () => {
  const m = defaultModel();
  const res = analyse(m);
  const svg = drawNodes(res, { type: 'rafter', index: 0 }).svg;

  // шесть деталей: три узла × два ряда, каждая кликабельна
  const picks = [...svg.matchAll(/data-pick="(\w+)" data-side="(\w+)"/g)].map((x) => `${x[1]}:${x[2]}`);
  assert.deepEqual(new Set(picks), new Set(['tie:outer', 'tie:wall', 'beamTie:outer', 'beamTie:wall', 'base:outer', 'base:wall']));

  // подписи берут значения из расчёта, а не из воздуха
  assert.ok(svg.includes(`${res.ties.outer.need} × ${res.ties.outer.fastener.short}`));
  assert.ok(svg.includes(`катет ${res.beamTies.outer.tie.kf} мм`));
  assert.ok(svg.includes(`${res.bases.outer.base.plate}×${res.bases.outer.base.plate}`));

  // при нехватке места на чертеже появляется прямое предупреждение
  const windy = defaultModel();
  windy.site.windRegion = 'VII';
  windy.site.terrain = 'A';
  const tight = analyse(windy);
  assert.ok(tight.ties.outer.need > tight.ties.outer.fit.n, 'ожидалась перегрузка узла');
  assert.ok(drawNodes(tight, { type: 'rafter', index: 0 }).svg.includes(`нужно ${tight.ties.outer.need}, влезает`));
});

test('стык по длине попадает на чертежи, а без стыков их не рисуют', () => {
  const plain = analyse(defaultModel());
  assert.ok(!drawNodes(plain, { type: 'rafter', index: 0 }).svg.includes('СТЫК'),
    'навес в один хлыст — стыковать нечего, лишней детали быть не должно');
  assert.ok(!drawSection(plain).svg.includes('вне плоскости разреза'));

  const wide = defaultModel();
  wide.geom.B = 9000;
  wide.rafters.xs = spread(9000, 16);
  wide.posts.xs = spread(9000, 5);
  wide.wallPosts.xs = spread(9000, 7);

  const butt = drawNodes(analyse(wide), { type: 'rafter', index: 0 }).svg;
  assert.ok(butt.includes('4.1 СТЫК · ПРОГОН'), 'деталь стыка прогона');
  assert.ok(butt.includes('4.2 СТЫК · ОБВЯЗКА'), 'деталь стыка обвязки');
  assert.ok(butt.includes('торец в торец'), 'встык рисуется торцами над опорой');
  assert.ok(!butt.includes('U 0,00'), 'у стыка встык считать нечего — U не выводится');

  wide.opts.spliceJoint = 'plate';
  const res = analyse(wide);
  const plate = drawNodes(res, { type: 'rafter', index: 0 }).svg;
  const wall = res.spliceJoints.find((j) => j.key === 'wallPurlin');
  assert.ok(plate.includes(`${wall.n} × М${wall.d}`), 'нагели подписаны расчётным числом');
  assert.ok(plate.includes(`${wall.plateLength}`), 'длина накладки — расчётная');
  assert.ok(plate.includes('data-pick="splice"'), 'по детали можно кликнуть');

  const section = drawSection(res).svg;
  assert.ok(section.includes('вне плоскости разреза'), 'разрез честно говорит, что стык не в его плоскости');
  assert.ok(section.includes('накладках'), 'и на чём он держится');
});

test('изменяемая схема: вместо эпюр — слова, U подписан знаком ∞', () => {
  const m = defaultModel();
  m.geom.alpha = 45;
  const res = analyse(m);
  const diagrams = drawDiagrams(res, { type: 'rafter', index: 0 }).svg;
  assert.ok(diagrams.includes('изменяемая схема'), 'эпюры механизма нарисованы как у нормальной балки');
  const plan = drawPlan(res, { type: 'rafter', index: 0 }).svg;
  assert.ok(plan.includes('∞'), 'U стропила на плане подписан не знаком ∞');
  assert.ok(!plan.includes('Infinity'), 'на плане «Infinity» вместо ∞');
});
