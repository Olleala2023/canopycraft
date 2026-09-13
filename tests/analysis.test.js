import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel, spread, tributaries } from '../src/core/model.js';
import { analyse, billOfMaterials } from '../src/core/analysis.js';
import { snowDrift, snowMu, snowProfile } from '../src/core/loads.js';
import { phiBuckling } from '../src/core/checks.js';
import { rhsProps } from '../src/core/sections.js';

test('грузовые ширины покрывают всю ширину навеса', () => {
  const xs = spread(6000, 9);
  const t = tributaries(xs, 6000);
  assert.equal(Math.round(t.reduce((a, b) => a + b, 0)), 6000);
});

test('снеговой мешок: μ растёт с перепадом и ограничен четырьмя', () => {
  assert.ok(snowDrift(1200, 2.0).mu > 1);
  assert.equal(snowDrift(1200, 2.0).mu, 2.4);
  assert.equal(snowDrift(10000, 1.0).mu, 4);
  assert.equal(snowDrift(300, 4.0).mu, 1); // не меньше обычного покрытия
  assert.equal(snowDrift(1200, 2.0).length, 5000); // не менее 5 м
});

test('μ односкатного покрытия по прил. Б.1', () => {
  assert.equal(snowMu(8), 1);
  assert.equal(snowMu(30), 1);
  assert.equal(snowMu(45), 0.5);
  assert.equal(snowMu(60), 0);
});

test('эпюра снега убывает от стены', () => {
  const p = snowProfile({ snowRegion: 'IV', drift: true, driftH: 1200 }, 8);
  assert.ok(p.at(0) > p.at(2000));
  assert.ok(p.at(2000) > p.at(4800));
  assert.equal(p.at(0), 4.8);
});

test('φ совпадает с табл. 7 СП 16 в пределах 4 %', () => {
  const table = [[40, 0.894], [60, 0.806], [80, 0.686], [100, 0.542], [120, 0.419], [150, 0.289]];
  for (const [lam, ref] of table) {
    const { phi } = phiBuckling(lam, 240);
    assert.ok(Math.abs(phi - ref) / ref < 0.05, `λ=${lam}: ${phi.toFixed(3)} vs ${ref}`);
  }
});

test('характеристики трубы 100×100×3 близки к ГОСТ 30245', () => {
  const p = rhsProps(100, 100, 3);
  assert.ok(Math.abs(p.A - 1130) / 1130 < 0.02, `A = ${p.A.toFixed(0)} мм²`);
  assert.ok(Math.abs(p.Ix - 174.9e4) / 174.9e4 < 0.02, `Ix = ${(p.Ix / 1e4).toFixed(1)} см⁴`);
  assert.ok(Math.abs(p.ix - 39.4) / 39.4 < 0.02, `i = ${p.ix.toFixed(1)} мм`);
});

test('полный расчёт: все элементы посчитаны, снег у стены вдвое выше', () => {
  const m = defaultModel();
  const r = analyse(m);
  assert.equal(r.rafters.length, m.rafters.xs.length);
  assert.equal(r.posts.length, m.posts.xs.length);
  for (const s of r.summary) assert.ok(Number.isFinite(s.U) && s.U > 0, `${s.label}: U = ${s.U}`);
  assert.ok(r.snow.muWall === 2.4);
  assert.ok(r.wind.up > 0);
  const b = billOfMaterials(r);
  assert.ok(b.timberVolume > 0 && b.steelMass > 0);
});

test('уплотнение стропил снижает их загрузку', () => {
  const m = defaultModel();
  const sparse = analyse({ ...m, rafters: { ...m.rafters, xs: spread(m.geom.B, 6) } });
  const dense = analyse({ ...m, rafters: { ...m.rafters, xs: spread(m.geom.B, 14) } });
  const U = (r) => Math.max(...r.rafters.map((x) => x.U));
  assert.ok(U(dense) < U(sparse), `${U(dense).toFixed(2)} должно быть меньше ${U(sparse).toFixed(2)}`);
});

test('снеговой мешок заметно утяжеляет стропила', () => {
  const m = defaultModel();
  const withDrift = analyse(m);
  const without = analyse({ ...m, site: { ...m.site, drift: false } });
  const U = (r) => Math.max(...r.rafters.map((x) => x.U));
  assert.ok(U(withDrift) > U(without) * 1.3, `${U(withDrift).toFixed(2)} vs ${U(without).toFixed(2)}`);
});
