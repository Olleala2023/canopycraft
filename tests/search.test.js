import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultModel, spread } from '../src/core/model.js';
import { analyse, analyseRoof, analyseLineBeam, analysePostRow, supportLoads, billOfMaterials } from '../src/core/analysis.js';
import { ladder, section } from '../src/core/sections.js';
import { searchByCost } from '../src/core/search.js';
import { decodeModel, encodeModel } from '../src/core/share.js';

function sample() {
  const m = defaultModel();
  m.geom.L = 3100;
  m.geom.alpha = 11;
  m.geom.postHeight = 2350;
  return m;
}

/** Тот же отбор сортамента, что и в поиске. */
function ladderFor(id, opts = {}) {
  return ladder(section(id).material).filter((s) => {
    if (opts.minH && s.h < opts.minH) return false;
    if (opts.square && s.h !== s.b) return false;
    return true;
  });
}

const U_OF = {
  rafters: (r) => Math.max(...r.rafters.map((x) => x.U)),
  battens: (r) => r.battens.U,
  purlin: (r) => r.purlin.U,
  wallPurlin: (r) => r.wallPurlin.U,
  // при кресте к столбу должна привариваться диагональ — как и в подборе
  posts: (r) => Math.max(...r.posts.map((x) => x.U),
    r.cross?.checks.find((c) => c.name === 'Катет шва')?.U ?? 0),
  wallPosts: (r) => Math.max(...r.wallPosts.map((x) => x.U)),
  bracing: (r) => r.cross?.U ?? 0,
};

test('узкие расчёты элемента совпадают с полным расчётом', () => {
  const m = sample();
  const res = analyse(m);
  const sl = supportLoads(m);

  const purlin = analyseLineBeam(m, m.purlin.sectionId, sl.outer.supports, sl.outer.loads, sl.outer.label);
  assert.equal(purlin.U, res.purlin.U);
  const posts = analysePostRow(m, m.posts, purlin, sl.ctx, sl.outer.extra);
  assert.equal(Math.max(...posts.map((p) => p.U)), U_OF.posts(res));

  const wallPurlin = analyseLineBeam(m, m.wallPurlin.sectionId, sl.wall.supports, sl.wall.loads, sl.wall.label);
  assert.equal(wallPurlin.U, res.wallPurlin.U);
  const wallPosts = analysePostRow(m, m.wallPosts, wallPurlin, sl.ctx, sl.wall.extra);
  assert.equal(Math.max(...wallPosts.map((p) => p.U)), U_OF.wallPosts(res));

  assert.equal(analyseRoof(m).battens.U, res.battens.U);
});

test('несущая способность сортамента не монотонна по цене', () => {
  // ради этого в поиске линейный перебор, а не двоичный: более дорогое сечение
  // бывает слабее более дешёвого, и двоичный поиск через такие «ямы» шагает мимо
  const list = ladder('steel').filter((s) => s.h === s.b);
  let worse = 0;
  for (let i = 1; i < list.length; i++) {
    for (let j = 0; j < i; j++) {
      if (list[j].props.ix > list[i].props.ix || list[j].props.Wx > list[i].props.Wx) { worse++; break; }
    }
  }
  assert.ok(worse > 0, 'сортамент оказался монотонным — проверить, не изменился ли порядок');
});

test('подбор по стоимости не оставляет более дешёвого проходящего сечения', async () => {
  const target = 0.9;
  const r = await searchByCost(sample(), { target, limit: 3, keep: 2 });
  assert.ok(r.options.length > 0, 'поиск ничего не нашёл');

  for (const opt of r.options) {
    const m = opt.model;
    // элементы — по целевому запасу, узлы — по единице: запас внутри них уже
    // заложен, а вместимость узла и катет шва дискретны
    const res = analyse(m);
    const NODES = ['ties', 'beamTies', 'bases'];
    for (const row of res.summary) {
      const limit = NODES.includes(row.key) ? 1 : target;
      assert.ok(row.U <= limit + 1e-9, `${row.label}: U = ${row.U.toFixed(2)} > ${limit}`);
    }
    const lists = {
      rafters: ladderFor(m.rafters.sectionId, { minH: 100 }),
      battens: ladderFor(m.battens.sectionId),
      purlin: ladderFor(m.purlin.sectionId),
      wallPurlin: ladderFor(m.wallPurlin.sectionId),
      posts: ladderFor(m.posts.sectionId, { square: true }),
      wallPosts: ladderFor(m.wallPosts.sectionId, { square: true }),
      ...(m.bracing.along === 'cross'
        ? { bracing: ladder('steel').filter((s) => s.h === s.b && s.h <= 80) } : {}),
    };
    for (const [key, list] of Object.entries(lists)) {
      const chosen = section(m[key].sectionId);
      for (const cand of list) {
        if (cand.props.A >= chosen.props.A) continue;
        const t = JSON.parse(JSON.stringify(m));
        t[key].sectionId = cand.id;
        const U = U_OF[key](analyse(t));
        assert.ok(U > target,
          `${key}: ${cand.label} (A=${cand.props.A.toFixed(0)}) проходит с U=${U.toFixed(2)}, ` +
          `а подобрано более дорогое ${chosen.label} (A=${chosen.props.A.toFixed(0)})`);
      }
    }
  }
});

test('столбы у стены не тяжелее наружных при прочих равных', async () => {
  // стеновой ряд раскреплён сквозными шпильками (μ = 1), наружный стоит
  // свободно (μ = 2) и несёт больший грузовой участок — обратное соотношение
  // означало бы ошибку подбора
  const r = await searchByCost(sample(), { target: 0.9, limit: 3, keep: 2 });
  for (const opt of r.options) {
    const outer = section(opt.model.posts.sectionId);
    const wall = section(opt.model.wallPosts.sectionId);
    assert.ok(wall.props.A <= outer.props.A,
      `у стены ${wall.label} (A=${wall.props.A.toFixed(0)}), снаружи ${outer.label} (A=${outer.props.A.toFixed(0)})`);
  }
});

test('старые ссылки с μ переводятся на схему связей и говорят об этом', async () => {
  const { decodeNotes } = await import('../src/core/share.js');
  const pack = (o) => Buffer.from(JSON.stringify(o), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // самая старая: одно μ на обе плоскости
  const oldest = pack({ posts: { mu: 1 } });
  const m = decodeModel(oldest);
  assert.equal(m.bracing.along, 'cross', 'μ = 1 значило «верх удержан связями»');
  assert.equal(m.posts.mu, undefined);
  assert.equal(m.posts.muY, undefined);
  assert.equal(decodeNotes(oldest).length, 1);
  // μ по плоскостям: вдоль ряда 2 — связей нет, и переводить нечего
  const free = pack({ posts: { muX: 1, muY: 2 } });
  assert.equal(decodeModel(free).bracing.along, 'none');
  assert.equal(decodeNotes(free).length, 1, 'но про μ поперёк ряда сказать надо');
  // новые ссылки по-прежнему короткие и обратимые
  const t = defaultModel();
  t.bracing.along = 'cross';
  assert.equal(decodeModel(encodeModel(t)).bracing.along, 'cross');
  assert.deepEqual(decodeNotes(encodeModel(t)), []);
});

test('подбор по цене сравнивает наружный ряд без связей и с крестом', async () => {
  const r = await searchByCost(sample(), { target: 0.9, limit: 20, keep: 2 });
  const schemes = new Set(r.options.map((o) => o.model.bracing.along));
  assert.ok(schemes.has('none') && schemes.has('cross'), `в списке только ${[...schemes].join(', ')}`);
  for (const o of r.options) {
    const res = analyse(o.model);
    if (o.model.bracing.along === 'cross') {
      assert.ok(res.cross, 'у варианта с крестом крест посчитан');
      assert.match(o.parts.bracing, /^крест /);
      // с крестом столбы легче: гибкость вдоль ряда считается при μ = 1
      assert.equal(res.posts[0].muY, 1);
      assert.ok(billOfMaterials(res).items.some((i) => i.name === 'Связи наружного ряда'), 'связи в смете');
    } else {
      assert.equal(res.cross, null);
      assert.equal(o.parts.bracing, 'без связей');
    }
    assert.ok(Math.abs(billOfMaterials(res).costs.total - o.cost) < 1e-6, 'цена варианта — цена его сметы');
  }
});
