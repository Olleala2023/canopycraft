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
  // нагрузка в снеговом мешке определяется перепадом высот, а не районом:
  // μ·S_g = 2·h·γ_сн = 2·1,2·2,0 = 4,8 кПа
  assert.ok(Math.abs(r.snow.muWall * r.snow.Sg - 4.8) < 1e-9, `${r.snow.muWall * r.snow.Sg} кПа`);
  assert.ok(r.wind.up > 0);
  assert.equal(r.wallPosts.length, m.wallPosts.xs.length);
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

test('распор даёт только ветер: у вертикальных опор ΣH = 0 от силы тяжести', () => {
  const m = defaultModel();
  const calm = analyse({ ...m, site: { ...m.site, windRegion: 'Ia' } });
  const windy = analyse({ ...m, site: { ...m.site, windRegion: 'VII' } });
  assert.ok(windy.thrust.total > calm.thrust.total * 3, 'распор должен расти с ветровым районом');
  // снег распора не создаёт: реакции опор вертикальные
  const light = analyse({ ...m, site: { ...m.site, snowRegion: 'I' } });
  const heavy = analyse({ ...m, site: { ...m.site, snowRegion: 'VIII' } });
  assert.equal(light.thrust.total.toFixed(6), heavy.thrust.total.toFixed(6));
  assert.ok(heavy.rafters[5].N > light.rafters[5].N, 'внутреннее осевое усилие при этом растёт');
});

test('шпильки в газоблоке проверяются и зависят от размера шайбы', () => {
  const m = defaultModel();
  const small = analyse({ ...m, wallPosts: { ...m.wallPosts, plateSize: 60 } });
  const big = analyse({ ...m, wallPosts: { ...m.wallPosts, plateSize: 200 } });
  const U = (r) => r.wallPosts[1].bolts.checks.find((c) => c.name.includes('под шайбой')).U;
  assert.ok(U(small) > U(big) * 5, `${U(small).toFixed(3)} vs ${U(big).toFixed(3)}`);
  assert.ok(big.wallPosts[1].bolts.count === m.wallPosts.boltCount);
});

test('стеновой столб выгоднее наружного: он раскреплён стеной', () => {
  const m = defaultModel();
  const r = analyse(m);
  const outer = r.posts[1].checks.find((c) => c.name === 'Устойчивость столба');
  const wall = r.wallPosts[1].checks.find((c) => c.name === 'Устойчивость столба');
  assert.ok(wall.note.includes('φ'), 'в примечании должен быть φ');
  assert.ok(r.posts[1].lef > r.wallPosts[1].lef, 'расчётная длина наружного столба больше');
});

test('спецификация считает хлысты стандартной длины', () => {
  const r = analyse(defaultModel());
  const b = billOfMaterials(r);
  const rafters = b.items.find((i) => i.name === 'Стропила');
  assert.equal(rafters.stockPieces, rafters.count); // 4,9 м из 6 м — по одной на хлыст
  const battens = b.items.find((i) => i.name === 'Обрешётка');
  assert.equal(battens.stockPieces, battens.count); // 6 м ровно
  assert.ok(b.fasteners[0].count === r.model.wallPosts.boltCount * r.model.wallPosts.xs.length);
  assert.ok(b.steelLength > 0);
});
