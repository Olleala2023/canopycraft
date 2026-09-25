import { section, DENSITY } from './sections.js';
import { ROOFING } from './loads.js';
import { levels, splicePlan } from './model.js';
import { fastenerMass, ANGLE_MASS } from './fasteners.js';
import { deg, G0, RAFTER_TRIM } from './common.js';
import { BRACE_BOLT } from './posts.js';

/**
 * Спецификация и массы.
 *
 * Формулы:
 *   дерево   V = b·h·L·n,            m = V·ρ,   ρ = 500 кг/м³
 *   сталь    m = A·L·n·ρ,            ρ = 7850 кг/м³  (то же, что A[см²]·0,785 кг/м)
 *   кровля   m = g·S/g₀,             g — кН/м² по скату, S — площадь ската
 *   шпилька  m = π/4·d²·L·ρ_ст,      пластина m = a²·t·ρ_ст
 *
 * Стоимость: дерево — по объёму (V·цена за м³), металл — по массе (m·цена за кг),
 * кровля — по площади ската, метизы — поштучно. Цены задаёт пользователь.
 *
 * Собственный вес всех этих элементов уже входит в расчёт нагрузок:
 * стропила и прогоны — погонным весом сечения, обрешётка — весом на 1 м²,
 * столбы — весом ствола в осевой силе.
 */
export function billOfMaterials(result) {
  const m = result.model;
  const stock = m.opts.stockLength ?? 6000;
  const pr = m.prices ?? { timberM3: 0, steelKg: 0, roofingM2: 0, fastenerPc: 0, currency: '₽' };
  const items = [];
  const add = (name, sec, lengthMm, count) => {
    const isT = sec.material === 'timber';
    const perStock = Math.max(1, Math.floor(stock / lengthMm));
    const volume = (sec.props.A * lengthMm * count) / 1e9; // м³
    const mass = (sec.massPerM * lengthMm * count) / 1000;
    // элемент длиннее хлыста собирается из кусков: столько же хлыстов на штуку,
    // и на один стык меньше. Раньше здесь стоял прочерк — человек не видел
    // ни числа хлыстов, ни того, что элемент вообще придётся стыковать
    const plan = splicePlan(lengthMm, stock);
    items.push({
      name,
      section: sec.label,
      material: isT ? 'сосна' : 'сталь',
      count,
      length: Math.round(lengthMm),
      totalLength: (lengthMm * count) / 1000,
      stockPieces: plan.pieces > 1 ? plan.pieces * count : Math.ceil(count / perStock),
      splices: plan.splices * count,
      volume: isT ? volume : null,
      mass,
      unitPrice: isT ? pr.timberM3 : pr.steelKg,
      unit: isT ? '₽/м³' : '₽/кг',
      cost: isT ? volume * pr.timberM3 : mass * pr.steelKg,
    });
  };
  const ca = Math.cos(deg(m.geom.alpha));
  add('Стропила', section(m.rafters.sectionId), (m.geom.L + m.geom.a) / ca + RAFTER_TRIM, m.rafters.xs.length);
  const nBatten = Math.floor((m.geom.L + m.geom.a) / ca / m.battens.spacing) + 1;
  add('Обрешётка', section(m.battens.sectionId), m.geom.B, nBatten);
  add('Обвязка у стены', section(m.wallPurlin.sectionId), m.geom.B, 1);
  add('Прогон наружный', section(m.purlin.sectionId), m.geom.B, 1);
  const lv = levels(m);
  add('Столбы наружные', section(m.posts.sectionId), lv.postLength, m.posts.xs.length);
  add('Столбы у стены', section(m.wallPosts.sectionId), lv.wallPostLength, m.wallPosts.xs.length);
  if (result.cross) add('Связи наружного ряда', result.cross.sec, result.cross.length, result.cross.count);
  if (result.roofBrace) add('Связи в плоскости кровли', result.roofBrace.sec, result.roofBrace.length, result.roofBrace.count);

  // кровля
  const roofArea = (m.geom.B * ((m.geom.L + m.geom.a) / ca)) / 1e6; // м² по скату
  const roofMass = (result.dead.roof * roofArea * 1000) / G0;

  // метизы
  const wp = m.wallPosts;
  const boltLen = wp.wallThickness + 120;
  const boltCount = wp.boltCount * wp.xs.length;
  const boltMass = (Math.PI / 4) * wp.boltDiameter ** 2 * boltLen * boltCount * 7.85e-6;
  const plateMass = wp.plateSize ** 2 * 8 * boltCount * 7.85e-6;
  const fasteners = [
    { name: `Шпилька М${wp.boltDiameter} класса ${wp.boltGrade}`, count: boltCount,
      note: `длина ≥ ${boltLen} мм`, mass: boltMass, cost: boltCount * pr.fastenerPc },
    { name: `Пластина-шайба ${wp.plateSize}×${wp.plateSize}×8 мм`, count: boltCount,
      note: 'с внутренней стороны стены, под гайку с шайбой', mass: plateMass, cost: 0 },
  ];

  // узлы крепления стропил: на каждое стропило два узла — у прогона и у стены
  const nRafters = m.rafters.xs.length;
  const tieF = result.ties.outer.fastener;
  const tieCount = (result.ties.outer.need + result.ties.wall.need) * nRafters;
  if (tieF.kind === 'bolt') {
    fasteners.push({
      name: `Болт ${tieF.short.replace('болт ', '')} с гайкой и шайбами`, count: tieCount,
      note: `крепление стропил: ${result.ties.outer.need} шт у прогона и ${result.ties.wall.need} у стены на каждое`,
      // болты и метизы считаются по массе металла, уголки — поштучно
      mass: tieCount * fastenerMass(tieF), cost: tieCount * fastenerMass(tieF) * pr.steelKg,
    });
  } else {
    const angles = 4 * nRafters; // по два уголка на узел, узла два
    fasteners.push({
      name: 'Уголок крепёжный 90×90×65×2', count: angles,
      note: 'по два на узел, с обеих сторон стропила', mass: angles * ANGLE_MASS,
      cost: angles * (pr.anglePc ?? 0),
    });
    fasteners.push({
      name: tieF.short.charAt(0).toUpperCase() + tieF.short.slice(1), count: tieCount,
      note: `${result.ties.outer.need} шт у прогона и ${result.ties.wall.need} у стены на каждое стропило`,
      mass: tieCount * fastenerMass(tieF), cost: tieCount * fastenerMass(tieF) * pr.steelKg,
    });
  }

  for (const [side, bt, row] of [
    ['наружного ряда', result.beamTies.outer, m.posts],
    ['у стены', result.beamTies.wall, m.wallPosts],
  ]) {
    const n = row.xs.length;
    if (bt.welded) {
      fasteners.push({
        name: `Сварной шов оголовка ${side}`, count: n,
        note: `${Math.round(bt.weldLength)} мм по контуру, катет ${bt.tie.kf} мм`, mass: 0, cost: 0,
      });
    } else {
      const plate = Math.max(160, (bt.post.b ?? 100) + 80);
      const plateMassOne = plate * plate * 8 * 7.85e-6;
      const bolts = bt.tie.n * n;
      const boltMassOne = (Math.PI / 4) * bt.tie.d ** 2 * 120 * 7.85e-6 * 1.6;
      fasteners.push({
        name: `Пластина-оголовок ${plate}×${plate}×8 мм, ${side}`, count: n,
        note: 'приваривается на торец столба', mass: n * plateMassOne, cost: n * plateMassOne * pr.steelKg,
      });
      fasteners.push({
        name: `Болт М${bt.tie.d} класса ${bt.tie.grade}, узел ${side}`, count: bolts,
        note: `${bt.tie.n} шт на столб, с гайкой и шайбами`, mass: bolts * boltMassOne,
        cost: bolts * boltMassOne * pr.steelKg,
      });
    }
  }

  // болты крепления диагоналей по кровле к деревянным балкам
  for (const e of result.roofBrace?.ends ?? []) {
    if (e.welded) continue;
    const bolts = e.n * result.roofBrace.count;
    const oneMass = (Math.PI / 4) * BRACE_BOLT.d ** 2 * 150 * 7.85e-6 * 1.6;
    fasteners.push({
      name: `Болт М${BRACE_BOLT.d} класса ${BRACE_BOLT.grade}, диагональ ${e.where}`, count: bolts,
      note: `${e.n} шт на конец диагонали, с гайкой и шайбами`, mass: bolts * oneMass, cost: bolts * oneMass * pr.steelKg,
    });
  }

  // накладки стыков: то, чего в смете не было совсем, хотя купить придётся
  for (const j of result.spliceJoints ?? []) {
    if (j.impossible) continue;
    const plates = 2 * j.count;
    const volume = (j.plateT * j.plateH * j.plateLength) / 1e9; // м³ одной накладки
    if (j.material === 'timber') {
      fasteners.push({
        name: `Накладка стыка ${j.plateT}×${j.plateH}×${j.plateLength} мм · ${j.label.toLowerCase()}`,
        count: plates, note: 'две на стык, с обеих сторон', mass: plates * volume * DENSITY.timber,
        cost: plates * volume * pr.timberM3,
      });
      const dowels = j.n * j.count;
      const dowelMass = (Math.PI / 4) * j.d ** 2 * (j.sec.b + 2 * j.plateT + 40) * 7.85e-6 * 1.6;
      fasteners.push({
        name: `Нагель М${j.d} с гайкой и шайбами · ${j.label.toLowerCase()}`, count: dowels,
        note: `${j.n} шт на стык, сетка ${j.cols}×${j.rows} с каждой стороны`,
        mass: dowels * dowelMass, cost: dowels * dowelMass * pr.steelKg,
      });
    } else {
      fasteners.push({
        name: `Накладка стыка ${j.plateT}×${j.plateH}×${j.plateLength} мм · ${j.label.toLowerCase()}`,
        count: plates, note: `две на стык, шов по контуру катетом ${j.kf} мм`,
        mass: plates * volume * DENSITY.steel, cost: plates * volume * DENSITY.steel * pr.steelKg,
      });
    }
  }

  // плиты и анкеры баз — по рядам: у стены при блоке рядом с лентой своя плита-«столик»
  const plateRows = [[result.bases.outer, m.posts.xs.length], [result.bases.wall, m.wallPosts.xs.length]];
  const baseItems = new Map();
  const addBase = (name, count, note, massOne) => {
    const it = baseItems.get(name) ?? { name, count: 0, notes: [], mass: 0, cost: 0 };
    it.count += count;
    if (!it.notes.includes(note)) it.notes.push(note);
    it.mass += count * massOne;
    it.cost += count * massOne * pr.steelKg;
    baseItems.set(name, it);
  };
  for (const [b, count] of plateRows) {
    const pb = b.base;
    if (pb.kind !== 'plate' || !count) continue;
    const L = b.beside ? b.plate.L : pb.plate, W = b.beside ? b.plate.B : pb.plate;
    addBase(`Плита базы ${L}×${W}×${pb.t} мм`, count,
      b.beside ? 'столик у стены: столб у края, анкеры за ним' : 'приваривается на нижний торец столба',
      L * W * pb.t * 7.85e-6);
    const anchorMassOne = (Math.PI / 4) * pb.d ** 2 * (pb.hef + 120) * 7.85e-6 * 1.5;
    addBase(`Анкер М${pb.d}, заделка ${pb.hef} мм`, pb.n * count,
      `${pb.n} шт на столб, разнос ${b.span} мм`, anchorMassOne);
  }
  for (const it of baseItems.values()) {
    fasteners.push({ name: it.name, count: it.count, note: it.notes.join('; '), mass: it.mass, cost: it.cost });
  }

  const sum = (f) => items.filter(f).reduce((a, i) => a + (i.mass ?? 0), 0);
  const byName = (n) => items.find((i) => i.name === n)?.mass ?? 0;
  // всё, что висит над головой (без столбов) — это и есть постоянная нагрузка на кровлю
  const roofPartMass = byName('Стропила') + byName('Обрешётка') + byName('Обвязка у стены')
    + byName('Прогон наружный') + roofMass;
  const timberVolume = items.reduce((a, i) => a + (i.volume ?? 0), 0);
  const timberMass = sum((i) => i.material === 'сосна');
  const steelMass = sum((i) => i.material === 'сталь');
  const steelLength = items.filter((i) => i.material === 'сталь').reduce((a, i) => a + i.totalLength, 0);
  const fastenerTotal = fasteners.reduce((a, f) => a + f.mass, 0);
  const total = timberMass + steelMass + roofMass + fastenerTotal;
  const planArea = (m.geom.B * (m.geom.L + m.geom.a)) / 1e6; // м² в плане

  const groups = [
    { name: 'Кровельное покрытие', mass: roofMass, note: ROOFING[m.roofing].label },
    { name: 'Обрешётка', mass: byName('Обрешётка'), note: 'сосна' },
    { name: 'Стропила', mass: byName('Стропила'), note: 'сосна' },
    { name: 'Прогоны и обвязка', mass: byName('Прогон наружный') + byName('Обвязка у стены'), note: 'сталь + сосна' },
    { name: 'Столбы', mass: byName('Столбы наружные') + byName('Столбы у стены'), note: 'сталь' },
    ...(result.brace ? [{ name: 'Связи', mass: byName('Связи наружного ряда') + byName('Связи в плоскости кровли'), note: 'сталь' }] : []),
    { name: 'Метизы', mass: fastenerTotal, note: 'шпильки, пластины и крепёж узлов' },
  ];

  const weights = {
    timber: { volume: timberVolume, mass: timberMass, density: 500 },
    steel: { mass: steelMass, length: steelLength, density: 7850 },
    roofing: { area: roofArea, mass: roofMass, label: ROOFING[m.roofing].label },
    // fastenerMass — импортированная функция, а нужна посчитанная масса:
    // из-за этой опечатки отчёт падал на b.weights.fasteners.mass.toFixed
    fasteners: { mass: fastenerTotal, count: fasteners.reduce((a, f) => a + (f.count ?? 0), 0) },
    total,
    perSqm: total / planArea,
    planArea,
    /** нагрузка от собственного веса всей кровельной части, кПа по скату */
    deadPressure: (roofPartMass * G0) / roofArea / 1000,
    /** доля собственного веса в полной нагрузке у стены и в поле */
    deadShareWall: null,
    deadShareField: null,
    groups,
  };
  const dp = weights.deadPressure;
  weights.deadShareWall = dp / (dp + result.snow.at(0));
  weights.deadShareField = dp / (dp + result.snow.at(m.geom.L + m.geom.a));

  const costTimber = items.filter((i) => i.material === 'сосна').reduce((a, i) => a + i.cost, 0);
  const costSteel = items.filter((i) => i.material === 'сталь').reduce((a, i) => a + i.cost, 0);
  const costRoofing = roofArea * pr.roofingM2;
  const costFasteners = fasteners.reduce((a, f) => a + (f.cost ?? 0), 0);
  const costs = {
    currency: pr.currency ?? '₽',
    prices: pr,
    timber: costTimber,
    steel: costSteel,
    roofing: costRoofing,
    fasteners: costFasteners,
    total: costTimber + costSteel + costRoofing + costFasteners,
    perSqm: (costTimber + costSteel + costRoofing + costFasteners) / planArea,
    groups: [
      { name: 'Кровельное покрытие', cost: costRoofing, base: `${roofArea.toFixed(1)} м² × ${pr.roofingM2} ₽/м²` },
      { name: 'Сосна', cost: costTimber, base: `${timberVolume.toFixed(3)} м³ × ${pr.timberM3} ₽/м³` },
      { name: 'Сталь', cost: costSteel, base: `${steelMass.toFixed(0)} кг × ${pr.steelKg} ₽/кг` },
      { name: 'Метизы', cost: costFasteners, base: `${boltCount} компл. шпилек × ${pr.fastenerPc} ₽ и крепёж узлов` },
    ],
  };

  return { items, fasteners, weights, costs, timberVolume, timberMass, steelMass, steelLength, stock, total,
    spliceJoints: result.spliceJoints ?? [] };
}
