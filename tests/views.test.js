import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel } from '../src/core/model.js';
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
