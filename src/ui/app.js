import { defaultModel, spread } from '../core/model.js';
import { analyse, billOfMaterials } from '../core/analysis.js';
import { SECTIONS, section } from '../core/sections.js';
import { ROOFING, SNOW_REGIONS, WIND_REGIONS } from '../core/loads.js';
import { FASTENERS, BEAM_TIES, POST_BASES, CONCRETE, SOILS } from '../core/fasteners.js';
import { pickSection, pickRafterSpacing, pickAll } from '../core/optimize.js';
import { searchByCost } from '../core/search.js';
import { encodeModel, decodeModel, decodeNotes, upgradeModel } from '../core/share.js';
import { drawPlan, drawSection, drawDiagrams, drawNodes, pickElement, uColor, f2 } from './views.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'canopycraft.model.v2';

/**
 * Что пришлось перевести при чтении старой ссылки или сохранённого расчёта:
 * поля, которых больше нет, не должны пропадать молча.
 */
let upgradeNotes = [];

/** Расчёт из ссылки важнее сохранённого: по ссылке приходят делиться конкретным вариантом. */
function initialModel() {
  const h = typeof location !== 'undefined' ? location.hash : '';
  const fromLink = h && h.startsWith('#p=') ? decodeModel(h.slice(3)) : null;
  if (fromLink) upgradeNotes = decodeNotes(h.slice(3));
  return fromLink ?? load() ?? defaultModel();
}

const state = {
  model: initialModel(),
  sel: { type: 'rafter', index: 0 },
  view: 'plan',
  result: null,
  meta: null,
};

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (!(m && m.geom && m.wallPosts && m.wallPurlin && m.prices)) return null;
    // сохранённый в прошлой версии расчёт: недостающие поля — из умолчаний,
    // исчезнувшие — переводим и говорим об этом
    const up = upgradeModel(m);
    upgradeNotes = up.notes;
    return up.model;
  } catch { return null; }
}
function save() {
  if (drag) return; // во время перетаскивания сохраняем один раз, в конце
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.model)); } catch { /* приватный режим */ }
  syncUrl();
}

/** Адресная строка всегда показывает текущий расчёт — её можно скопировать в любой момент. */
let urlTimer = 0;
function syncUrl() {
  if (urlTimer) return;
  urlTimer = setTimeout(() => {
    urlTimer = 0;
    try {
      const code = encodeModel(state.model);
      const base = location.href.split('#')[0];
      history.replaceState(null, '', code ? `${base}#p=${code}` : base);
    } catch { /* внутри фрейма адресная строка недоступна — не беда */ }
  }, 400);
}

/** Ссылка на текущий расчёт. */
function shareUrl() {
  const code = encodeModel(state.model);
  return location.href.split('#')[0] + (code ? `#p=${code}` : '');
}

/* ─────────────────── панель параметров ─────────────────── */

const timberOpts = () => SECTIONS.filter((s) => s.material === 'timber');
const steelOpts = () => SECTIONS.filter((s) => s.material === 'steel');
/** Диагональ креста — квадратная труба небольшого сечения. */
const braceOpts = () => SECTIONS.filter((s) => s.material === 'steel' && s.h === s.b && s.h <= 80);
const kN = (v) => f2(v / 1000);
const anyOpts = () => SECTIONS;

/**
 * Кнопки «подобрать» у блока фундамента целятся в тот же запас 0,9, что и
 * подбор сечений: needDepth и needSide из расчёта — это ровно единица.
 */
const blockMargin = (mm) => Math.ceil(mm / 0.9 / 50) * 50;

const CONTROLS = [
  { group: 'Геометрия', open: true },
  { k: 'geom.B', label: 'Ширина навеса', type: 'range', min: 3000, max: 12000, step: 250, unit: 'мм' },
  { k: 'geom.L', label: 'Пролёт до столбов', type: 'range', min: 2000, max: 6500, step: 100, unit: 'мм' },
  { k: 'geom.a', label: 'Свес за столбы', type: 'range', min: 0, max: 2000, step: 50, unit: 'мм' },
  { k: 'geom.alpha', label: 'Уклон', type: 'range', min: 3, max: 30, step: 1, unit: '°' },
  { k: 'geom.postHeight', label: 'Высота столба', type: 'range', min: 1800, max: 4000, step: 50, unit: 'мм' },
  { k: 'geom.driftH', label: 'Перепад до кровли дома', help: 'snow.html', helpTitle: 'снеговой мешок у стены', type: 'range', min: 0, max: 4000, step: 100, unit: 'мм' },

  { group: 'Элементы', open: true },
  { k: '#rafterCount', label: 'Стропил', type: 'range', min: 3, max: 25, step: 1, unit: 'шт', actions: [
      ['равномерно', (m) => { m.rafters.xs = spread(m.geom.B, m.rafters.xs.length); return 'Стропила распределены равномерно'; }],
      ['подобрать шаг', (m) => {
        const r = pickRafterSpacing(m, 0.9);
        if (!r) return 'Даже при 31 стропиле сечение не проходит — нужно крупнее';
        m.rafters.xs = spread(m.geom.B, r.count);
        return `Шаг ${Math.round(r.step)} мм (${r.count} шт), U = ${f2(r.U)}`;
      }]] },
  { k: 'roofing', label: 'Покрытие', type: 'select', options: () => Object.entries(ROOFING).map(([id, v]) => ({ id, label: v.label })) },
  { k: 'rafters.sectionId', label: 'Сечение стропила', type: 'select', options: anyOpts, pick: 'rafters' },
  { k: 'battens.sectionId', label: 'Обрешётка', type: 'select', options: anyOpts, pick: 'battens' },
  { k: 'battens.spacing', label: 'Шаг обрешётки', type: 'range', min: 200, max: 1200, step: 50, unit: 'мм' },
  { k: 'purlin.sectionId', label: 'Прогон наружный', type: 'select', options: anyOpts, pick: 'purlin' },
  { k: 'rafterTie.id', label: 'Крепление стропила к опоре', type: 'select',
    options: () => FASTENERS.map((f) => ({ id: f.id, label: f.label })),
    note: 'Ветер поднимает лёгкую кровлю, и стропило висит на крепеже. Уголок нужен затем, чтобы усилие пришло на крепёж срезом: на выдёргивание гвозди и саморезы в несущих узлах не работают. Число крепежей считается, проверяется — помещается ли оно по правилам расстановки.' },
  { k: 'purlinTie.id', label: 'Узел «прогон — столб»', type: 'select',
    options: () => BEAM_TIES.map((t) => ({ id: t.id, label: t.label })),
    note: 'Вниз прогон держит само опирание, торец в торец. Узел нужен против ветрового отрыва и горизонтальной силы. Катет шва не может быть больше 1,2 толщины самой тонкой стенки — на трубе 3 мм это 3,6 мм.' },
  { k: '#postCount', label: 'Столбов наружных', type: 'range', min: 2, max: 9, step: 1, unit: 'шт' },
  { k: 'posts.sectionId', label: 'Сечение наружного столба', type: 'select', options: steelOpts, pick: 'posts' },
  { k: 'postBase.id', label: 'База столба', type: 'select',
    options: () => POST_BASES.map((b) => ({ id: b.id, label: b.label })),
    note: 'Пока вдоль стены связей нет, столб — консоль, защемлённая внизу: база обязана воспринять момент от ветра. Два анкера с малым разносом его не держат, и тогда «защемлён внизу» остаётся словами.' },
  { k: 'postBase.footing', label: 'Сторона блока фундамента', type: 'range', min: 300, max: 1200, step: 50, unit: 'мм',
    actions: [['подобрать сторону', (m) => {
      const r = analyse(m);
      const need = blockMargin(Math.max(r.bases.outer.needSide, r.bases.wall.needSide));
      m.postBase.footing = Math.min(1200, Math.max(300, need));
      return need > 1200
        ? `При такой глубине нужна сторона ${need} мм — копайте глубже`
        : `Сторона ${m.postBase.footing} мм — блок держит отрыв`;
    }]],
    note: 'Сторона бетонного блока под столбом — и для забетонированного, и под плитой. Его вес держит навес от вырыва вверх: проверка «Вес фундамента против отрыва» в карточке «База столба».' },
  { k: 'postBase.depth', label: 'Глубина блока фундамента', type: 'range', min: 300, max: 3000, step: 50, unit: 'мм',
    actions: [['подобрать глубину', (m) => {
      const r = analyse(m);
      const byWeight = blockMargin(Math.max(r.bases.outer.needDepth, r.bases.wall.needDepth));
      const byFrost = r.bases.outer.frost.needDepth;
      const need = Math.max(byWeight, byFrost);
      m.postBase.depth = Math.min(3000, Math.max(300, need));
      if (need > 3000) return `При такой стороне нужна глубина ${need} мм — делайте блок шире`;
      return byFrost >= byWeight
        ? `Глубина ${m.postBase.depth} мм — определяет промерзание, по весу хватило бы ${byWeight}`
        : `Глубина ${m.postBase.depth} мм — блок держит отрыв${byFrost ? ' и ниже промерзания' : ''}`;
    }]],
    note: 'У забетонированного столба блок не может быть мельче заделки — если поставить меньше, в расчёт всё равно пойдёт глубина заделки. Если задана глубина промерзания, подошва для пучинистого грунта должна быть не выше неё.' },
  { k: 'bracing.along', label: 'Что держит верх ряда вдоль стены', help: 'braces.html', helpTitle: 'раскрепление столбов', type: 'select', options: () => [
      { id: 'none', label: 'ничего — столбы консоли, μ = 2' },
      { id: 'cross', label: 'крест в крайнем пролёте — μ = 1' }],
    live: (r) => {
      if (!r) return '';
      if (!r.cross) {
        return r.model.bracing?.along === 'cross'
          ? 'Крест не поставить: в ряду нужен хотя бы один пролёт'
          : `μ вдоль ряда 2,0 — верх свободен, ветер вдоль стены ${kN(r.thrust.alongOuter)} кН идёт в консоли столбов. Поперёк ряда верх держат стропила: μ = 1`;
      }
      const c = r.cross;
      return `μ = 1 в обеих плоскостях. Крест держит ${kN(c.F)} кН: ветер ${kN(c.wind / c.bays.length)} + условная сила столбов ${kN(c.qfic / c.bays.length)} · U ${f2(c.U)}`;
    },
    note: 'μ не выбирается, а следует из того, что держит верх. Поперёк ряда это стропила — распорки до стены; их крепление и обвязка у стены на это усилие проверяются. Вдоль стены стропила на шарнирах держать не могут: без креста столб — консоль, и сечение определяет гибкость. Подкос от столба к прогону связью не является.' },
  { k: 'bracing.bays', label: 'Крест в пролётах', type: 'select', numeric: true, options: () => [
      { id: '1', label: 'в одном крайнем' },
      { id: '2', label: 'в обоих крайних — усилие делится пополам' }],
    live: (r) => (r?.cross
      ? `пролёт ${Math.round(r.cross.span)} мм, диагонали ${r.cross.count} × ${Math.round(r.cross.length)} мм; столбам пролёта +${kN(r.cross.V)} кН в сжатие и ${kN(r.cross.Vup)} в отрыв`
      : 'связей нет — не используется') },
  { k: 'bracing.sectionId', label: 'Сечение диагонали креста', type: 'select', options: braceOpts, pick: 'bracing',
    live: (r) => (r?.cross
      ? `растяжение ${kN(r.cross.T)} кН · гибкость ${Math.round(r.cross.lambda)} из 400 · шов k = ${r.cross.kf} мм · U ${f2(r.cross.U)}${r.cross.U > 1 ? ` — не проходит: ${r.cross.worst.name.toLowerCase()}` : ''}`
      : 'связей нет — не используется'),
    note: 'Диагонали работают на растяжение по очереди и привариваются к столбам швом по контуру торца. Катет не меньше табличного по толщине столба и не больше 1,2 толщины диагонали: стенку 2 мм к столбу 3 мм не приварить.' },

  { group: 'Крепление к дому' },
  { k: 'wallPurlin.sectionId', label: 'Обвязка поверх столбов', type: 'select', options: anyOpts, pick: 'wallPurlin' },
  { k: 'wallPurlinTie.id', label: 'Узел «обвязка — столб»', type: 'select',
    options: () => BEAM_TIES.map((t) => ({ id: t.id, label: t.label })),
    note: 'К деревянной обвязке не приварить: если выбрана сварка, расчёт всё равно считает болтовой узел и пишет об этом.' },
  { k: '#wallPostCount', label: 'Столбов у стены', type: 'range', min: 2, max: 9, step: 1, unit: 'шт' },
  { k: 'wallPosts.sectionId', label: 'Сечение стенового столба', type: 'select', options: steelOpts, pick: 'wallPosts',
    note: 'Столб притянут к стене шпильками в нескольких точках по высоте — уехать вбок он не может ни в одной плоскости, поэтому μ = 1. Шпильки на это проверяются.' },
  { k: 'wallPosts.boltCount', label: 'Шпилек на столб', type: 'range', min: 2, max: 6, step: 1, unit: 'шт' },
  { k: 'wallPosts.boltDiameter', label: 'Диаметр шпильки', type: 'select', numeric: true, options: () => [
      { id: '12', label: 'М12' }, { id: '16', label: 'М16' }, { id: '20', label: 'М20' }, { id: '24', label: 'М24' }] },
  { k: 'wallPosts.boltGrade', label: 'Класс прочности шпильки', type: 'select', options: () => [
      { id: '4.8', label: '4.8' }, { id: '5.8', label: '5.8' }, { id: '8.8', label: '8.8' }] },
  { k: 'wallPosts.plateSize', label: 'Шайба-пластина изнутри', type: 'range', min: 60, max: 250, step: 10, unit: 'мм' },
  { k: 'wallPosts.blockClass', label: 'Класс газоблока', type: 'select', options: () => [
      { id: 'B2.0', label: 'B2,0 (D400) — R 0,85 МПа' },
      { id: 'B2.5', label: 'B2,5 (D500) — R 1,0 МПа' },
      { id: 'B3.5', label: 'B3,5 (D600) — R 1,3 МПа' },
      { id: 'B5.0', label: 'B5,0 (D700) — R 1,7 МПа' }] },
  { k: 'wallPosts.wallThickness', label: 'Толщина стены', type: 'range', min: 200, max: 500, step: 25, unit: 'мм' },
  { k: 'opts.postEccentricity', label: 'Эксцентриситет опирания на столб', type: 'range', min: 0, max: 120, step: 5, unit: 'мм' },

  { group: 'Площадка', side: 'right' },
  { k: 'site.snowRegion', label: 'Снеговой район', help: 'site.html', helpTitle: 'где взять район и на что он влияет', type: 'select', options: () => Object.entries(SNOW_REGIONS).map(([id, v]) => ({ id, label: `${id} — ${String(v).replace('.', ',')} кПа` })) },
  { k: 'site.windRegion', label: 'Ветровой район', help: 'site.html', helpTitle: 'где взять район и на что он влияет', type: 'select', options: () => Object.entries(WIND_REGIONS).map(([id, v]) => ({ id, label: `${id} — ${String(v).replace('.', ',')} кПа` })) },
  { k: 'site.terrain', label: 'Тип местности', help: 'site.html', helpTitle: 'тип местности и пульсации ветра', type: 'select', options: () => [
      { id: 'A', label: 'A — открытая' }, { id: 'B', label: 'B — пригород, лес' }, { id: 'C', label: 'C — плотная застройка' }],
    note: 'Районы берутся по картам приложения Е СП 20. По умолчанию стоит Воронеж: снег III, ветер II, местность B — если строите не там, это первое, что нужно поменять.' },
  { k: 'site.frostDepth', label: 'Глубина промерзания для суглинков', help: 'frost.html', helpTitle: 'мороз, пучение и глубина фундамента', type: 'range', min: 0, max: 3000, step: 50, unit: 'мм',
    note: 'С карты нормативных глубин промерзания — она даётся для суглинков и глин, на ваш грунт калькулятор пересчитает сам. 0 — не задано: тогда фундамент по морозу не проверяется.' },
  { k: 'site.soil', label: 'Грунт на площадке', help: 'frost.html', helpTitle: 'мороз, пучение и глубина фундамента', type: 'select',
    options: () => Object.entries(SOILS).map(([id, v]) => ({ id, label: `${v.label}${v.heaving ? ' — пучинистый' : ''}` })) },
  { k: 'site.drift', label: 'Снеговой мешок у стены дома', help: 'snow.html', helpTitle: 'снеговой мешок у стены', type: 'check' },
  { k: 'site.houseRoofLength', label: 'Длина ската дома l₁', type: 'range', min: 0, max: 30000, step: 500, unit: 'мм' },
  { k: 'site.houseRoofSlope', label: 'Уклон кровли дома α', type: 'range', min: 0, max: 45, step: 1, unit: '°' },
  { k: 'site.crossSlope', label: 'Поперечный уклон навеса φ', type: 'range', min: 0, max: 30, step: 1, unit: '°' },
  { k: 'site.reverseSlope', label: 'Уклон навеса к стене (обратный, k₂ = 1)', type: 'check' },
  { k: 'site.parapet', label: 'Сплошной парапет у перепада (m₁ = 0)', type: 'check' },

  { group: 'Материалы', side: 'right' },
  { k: 'opts.timber.grade', label: 'Сорт сосны', type: 'select', numeric: true,
    options: () => [{ id: '1', label: '1 сорт' }, { id: '2', label: '2 сорт' }, { id: '3', label: '3 сорт' }] },
  { k: 'opts.timber.serviceClass', label: 'Условия эксплуатации', type: 'select', numeric: true,
    options: () => [{ id: '2', label: '2 — под навесом, m_в = 1,0' }, { id: '3', label: '3 — открытый воздух, m_в = 0,9' }, { id: '4', label: '4 — влажная среда, m_в = 0,85' }] },
  { k: 'opts.steel.grade', label: 'Сталь', type: 'select',
    options: () => [{ id: 'C245', label: 'С245 — R_y 240 МПа' }, { id: 'C255', label: 'С255 — R_y 240 МПа' }, { id: 'C345', label: 'С345 — R_y 315 МПа' }] },
  { k: 'opts.concreteClass', label: 'Бетон фундамента', type: 'select',
    options: () => Object.keys(CONCRETE).map((id) => ({ id, label: `${id} — R_b ${String(CONCRETE[id].Rb).replace('.', ',')} МПа` })) },
  { k: 'opts.stockLength', label: 'Стандартная длина в продаже', type: 'select', numeric: true,
    options: () => [{ id: '4000', label: '4 м' }, { id: '6000', label: '6 м' }, { id: '12000', label: '12 м' }] },
  { k: 'opts.spliceJoint', label: 'Стык по длине', type: 'select',
    options: () => [
      { id: 'butt', label: 'встык — момент не передаётся' },
      { id: 'plate', label: 'накладка — сечение восстановлено' },
    ],
    note: 'Что делать, когда элемент длиннее хлыста. Простой стык встык работает шарниром: опорный момент в нём исчезает, а пролётные растут. Накладка с восстановлением сечения оставляет балку неразрезной — но её саму расчёт пока не проверяет, это на вас.' },

  { group: 'Цены — подставьте свои', side: 'right' },
  { k: 'prices.timberM3', label: 'Доска обрезная, ₽/м³', type: 'number', min: 0, step: 500 },
  { k: 'prices.steelKg', label: 'Профильная труба, ₽/кг', type: 'number', min: 0, step: 5 },
  { k: 'prices.roofingM2', label: 'Кровля, ₽/м²', type: 'number', min: 0, step: 50 },
  { k: 'prices.fastenerPc', label: 'Комплект шпилька+пластина, ₽/шт', type: 'number', min: 0, step: 10 },
  { k: 'prices.anglePc', label: 'Уголок крепёжный, ₽/шт', type: 'number', min: 0, step: 10 },
];

const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
function setPath(o, p, v) {
  const parts = p.split('.');
  const last = parts.pop();
  const t = parts.reduce((a, k) => a[k], o);
  t[last] = v;
}

function readVirtual(k) {
  if (k === '#rafterCount') return state.model.rafters.xs.length;
  if (k === '#postCount') return state.model.posts.xs.length;
  if (k === '#wallPostCount') return state.model.wallPosts.xs.length;
  return getPath(state.model, k);
}
function writeVirtual(k, v) {
  if (k === '#rafterCount') { state.model.rafters.xs = spread(state.model.geom.B, v); return; }
  if (k === '#postCount') { state.model.posts.xs = spread(state.model.geom.B, v); return; }
  if (k === '#wallPostCount') { state.model.wallPosts.xs = spread(state.model.geom.B, v); return; }
  setPath(state.model, k, v);
}

/**
 * Свёрнутость блоков переживает перезагрузку: настройки площадки и цен правят
 * один раз, и каждый раз раскрывать их заново — лишний клик.
 */
const GROUPS_KEY = 'canopycraft.groups';
const readGroups = () => { try { return JSON.parse(localStorage.getItem(GROUPS_KEY)) ?? {}; } catch { return {}; } };
const writeGroups = (v) => { try { localStorage.setItem(GROUPS_KEY, JSON.stringify(v)); } catch { /* приватный режим */ } };

/**
 * Ссылка на статью справки рядом с подписью поля. Открывается в новой вкладке:
 * расчёт в текущей остаётся нетронутым.
 */
const helpLink = (c) => (c.help
  ? ` <a class="help" href="help/${c.help}" target="_blank" rel="noopener" title="Справка: ${c.helpTitle ?? 'подробнее'}" aria-label="Справка: ${c.helpTitle ?? 'подробнее'}">?</a>`
  : '');

function buildParams() {
  const hosts = { left: $('params'), right: $('params-right') };
  hosts.left.innerHTML = '';
  hosts.right.innerHTML = '';
  const opened = readGroups();
  let body = hosts.left;

  for (const c of CONTROLS) {
    if (c.group) {
      const box = document.createElement('details');
      box.className = 'grp';
      box.open = opened[c.group] ?? !!c.open;
      box.innerHTML = `<summary class="pane-title">${c.group}</summary><div class="grp-body"></div>`;
      box.addEventListener('toggle', () => {
        const st = readGroups();
        st[c.group] = box.open;
        writeGroups(st);
      });
      (hosts[c.side] ?? hosts.left).appendChild(box);
      body = box.querySelector('.grp-body');
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const id = 'c_' + c.k.replace(/[.#]/g, '_');
    if (c.type === 'check') {
      wrap.innerHTML = `<label class="check" for="${id}"><input type="checkbox" id="${id}"><span>${c.label}${helpLink(c)}</span></label>`;
    } else if (c.type === 'number') {
      wrap.innerHTML = `<label for="${id}">${c.label}</label><input type="number" id="${id}" min="${c.min ?? 0}" step="${c.step ?? 1}" inputmode="numeric">`;
    } else if (c.type === 'range') {
      const acts = (c.actions ?? []).map((a, i) => `<button class="btn" data-act="${c.k}:${i}" style="padding:0 6px;font-size:11px">${a[0]}</button>`).join(' ');
      wrap.innerHTML = `<label for="${id}">${c.label}${helpLink(c)} <b data-val="${id}"></b></label><input type="range" id="${id}" min="${c.min}" max="${c.max}" step="${c.step}">${acts ? `<div style="display:flex;gap:5px;margin-top:3px">${acts}</div>` : ''}`;
    } else {
      const opts = c.options().map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
      wrap.innerHTML = `<label for="${id}">${c.label}${helpLink(c)}${c.pick ? ` <button class="btn" data-pick-el="${c.pick}" style="padding:0 6px;font-size:11px">подобрать</button>` : ''}</label><select id="${id}">${opts}</select>`;
    }
    if (c.live) {
      // живая подсказка: что эта настройка даёт в расчёте прямо сейчас
      const n = document.createElement('small');
      n.className = 'note live';
      n.setAttribute('data-live', id);
      wrap.appendChild(n);
    }
    if (c.note) {
      const n = document.createElement('small');
      n.className = 'note';
      n.textContent = c.note;
      wrap.appendChild(n);
    }
    body.appendChild(wrap);
    const input = wrap.querySelector('input,select');
    input.addEventListener('input', () => {
      let v = c.type === 'check' ? input.checked : input.value;
      if (c.type === 'range' || c.type === 'number' || c.numeric) v = Number(v) || 0;
      writeVirtual(c.k, v);
      if (c.k === 'geom.B') {
        state.model.rafters.xs = spread(state.model.geom.B, state.model.rafters.xs.length);
        state.model.posts.xs = spread(state.model.geom.B, state.model.posts.xs.length);
        state.model.wallPosts.xs = spread(state.model.geom.B, state.model.wallPosts.xs.length);
      }
      render();
    });
  }

  for (const host of [hosts.left, hosts.right]) {
    host.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        const [key, i] = b.getAttribute('data-act').split(':');
        const ctrl = CONTROLS.find((c) => c.k === key);
        b.textContent = '…';
        setTimeout(() => {
          const msg = ctrl.actions[Number(i)][1](state.model);
          b.textContent = ctrl.actions[Number(i)][0];
          render(msg);
        }, 10);
      })
    );
    host.querySelectorAll('[data-pick-el]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        const key = b.getAttribute('data-pick-el');
        b.textContent = '…';
        setTimeout(() => {
          const r = key === 'rafters' && e.shiftKey ? null : pickSection(state.model, key, 0.9);
          if (r) { setPath(state.model, `${key}.sectionId`, r.id); }
          b.textContent = 'подобрать';
          render(r ? `Подобрано: ${r.label}, U = ${f2(r.U)}` : 'Подходящего сечения в сортаменте нет — уменьшите пролёт или шаг');
        }, 10);
      })
    );
  }
}

function syncParams() {
  for (const c of CONTROLS) {
    if (c.group) continue;
    const id = 'c_' + c.k.replace(/[.#]/g, '_');
    const el = $(id);
    if (!el) continue;
    const v = readVirtual(c.k);
    if (c.type === 'check') el.checked = !!v;
    else el.value = String(v);
    const live = c.live && document.querySelector(`[data-live="${id}"]`);
    if (live) live.textContent = c.live(state.result);
    const b = document.querySelector(`[data-val="${id}"]`);
    if (b) {
      let extra = '';
      if (c.k === '#rafterCount') extra = ` · шаг ${Math.round(state.model.geom.B / (v - 1))}`;
      if (c.k === '#postCount' || c.k === '#wallPostCount') extra = ` · пролёт ${Math.round(state.model.geom.B / (v - 1))}`;
      if (c.k === 'site.frostDepth') {
        const f = state.result?.bases?.outer?.frost;
        if (!v) extra = ' — не задано, по морозу не проверяется';
        else if (f) extra = f.soil.heaving
          ? ` · под навесом d_f = ${Math.round(f.df)} мм`
          : ` · грунт непучинистый — глубина от мороза не зависит`;
      }
      // размеры блока сразу показывают, держит он отрыв или нет
      if (c.k === 'postBase.footing' || c.k === 'postBase.depth') {
        const bs = state.result?.bases;
        if (bs) {
          const b0 = bs.outer.mass - bs.outer.needMass <= bs.wall.mass - bs.wall.needMass ? bs.outer : bs.wall;
          const forced = c.k === 'postBase.depth' && b0.depth !== v ? ` (в расчёте ${b0.depth} — не мельче заделки)` : '';
          extra = `${forced} · блок ${Math.round(b0.mass)} кг из ${Math.round(b0.needMass)} нужных${b0.enough ? '' : ' — не держит'}`;
        }
      }
      b.textContent = `${v} ${c.unit ?? ''}${extra}`;
    }
  }
}

/* ─────────────────── инспектор ─────────────────── */

function renderInspector(res) {
  const el = pickElement(res, state.sel);
  const host = $('inspector');
  if (!el) { host.innerHTML = ''; return; }
  const rows = [];
  rows.push(`<div class="pane-title">${el.title} · ${el.sec.label}</div>`);
  for (const c of el.checks) {
    rows.push(`<div class="chk">
      <span class="nm">${c.name}</span><span class="v" style="color:${uColor(c.U)}">${f2(c.U)}</span>
      <span class="bar"><span style="width:${Math.min(100, c.U * 100).toFixed(0)}%;background:${uColor(c.U)}"></span></span>
      <span class="fx">${c.formula}${c.note ? ' · ' + c.note : ''} → ${fmtVal(c)}</span>
    </div>`);
  }
  const worstName = el.worst?.name ?? '—';
  const v = !Number.isFinite(el.U)
    ? '<b>Расчёт не сошёлся.</b> Проверьте исходные данные — какой-то из параметров задан некорректно.'
    : el.U > 1 ? `<b>Не проходит.</b> Определяет «${worstName}» — ${f2(el.U)}.`
    : el.U > 0.85 ? `<b>На пределе.</b> Определяет «${worstName}» — ${f2(el.U)}.`
    : el.U < 0.4 ? '<b>Большой запас.</b> Можно уменьшить сечение или увеличить шаг.'
    : `<b>Проходит.</b> Определяет «${worstName}» — ${f2(el.U)}.`;
  rows.push(`<div class="verdict" style="border-color:${uColor(el.U)}">${v}</div>`);

  const kv = [];
  if (el.kind === 'rafter') {
    kv.push(['Грузовая ширина', `${Math.round(el.trib)} мм`]);
    kv.push(['Длина по скату', `${Math.round(el.Ls)} мм`]);
    kv.push(['M max', `${f2(Math.abs(el.Mmax) / 1e6)} кН·м`]);
    kv.push(['Q max', `${f2(Math.abs(el.Vmax) / 1000)} кН`]);
    kv.push(['N (скатная)', `${f2(el.N / 1000)} кН`]);
    for (const s of el.spans) kv.push([`Прогиб, ${s.kind}`, `${f2(s.f)} мм / ${f2(s.limitLength / 200)}`]);
    kv.push(['Реакция на стену', `${f2(el.reactions.wall / 1000)} кН`]);
    kv.push(['Реакция на прогон', `${f2(el.reactions.purlin / 1000)} кН`]);
  } else if (el.kind === 'post' || el.kind === 'wallPost') {
    kv.push(['N сжатие', `${f2(el.N / 1000)} кН`]);
    kv.push([el.bolts ? 'M' : 'M поперёк ряда', `${f2(el.M / 1e6)} кН·м`]);
    if (el.My) kv.push(['M вдоль ряда', `${f2(el.My / 1e6)} кН·м — ветер вдоль стены ${kN(el.Hy)} кН на консоль`]);
    kv.push(['Отрыв', `${f2(Math.max(0, el.Nup) / 1000)} кН`]);
    const held = el.bolts ? 'стена' : 'стропила';
    kv.push(['Поперёк ряда', `μ = ${f2(el.muX)} · верх держит ${held} · l_ef ${Math.round(el.lefX)} мм`]);
    kv.push(['Вдоль ряда', el.muY > 1
      ? `μ = ${f2(el.muY)} · верх свободен · l_ef ${Math.round(el.lefY)} мм`
      : `μ = ${f2(el.muY)} · верх держит ${el.bolts ? 'стена' : 'крест'} · l_ef ${Math.round(el.lefY)} мм`]);
    if (!el.bolts) {
      kv.push(['Отдаёт стропилам', `${kN(el.holdX)} кН: ветер на прогон ${kN(el.Hwind)} + условная сила ${kN(el.QficX)}`]);
      if (el.QficY) kv.push(['Отдаёт кресту', `${kN(el.holdY)} кН, условная сила ${kN(el.QficY)}`]);
      if (el.Vcross) kv.push(['От креста в столб', `${kN(el.Vcross)} кН в сжатие, ${kN(el.VcrossUp)} в отрыв — от ветра`]);
    }
    if (el.bolts) {
      kv.push(['Горизонт. распор на столб', `${f2(el.Hpost / 1000)} кН`]);
      kv.push(['Шпилек', `${el.bolts.count} × М${res.model.wallPosts.boltDiameter}`]);
      kv.push(['На шпильку: растяжение', `${f2(el.bolts.Nbolt / 1000)} кН`]);
      kv.push(['На шпильку: срез', `${f2(el.bolts.Vbolt / 1000)} кН`]);
      kv.push(['По шпилькам снизу вверх', el.bolts.forces.map((f) => f2(f / 1000)).join(' / ') + ' кН']);
    }
  } else if (el.kind === 'tie') {
    kv.push(['Отрыв ветром', `${f2(el.uplift / 1000)} кН`]);
    if (el.slope > 0) kv.push(['Скатная составляющая', `${f2(el.slope / 1000)} кН`]);
    if (el.hold > 0) kv.push(['Распор через стропило', `${kN(el.hold)} кН — ${el.side === 'wall' ? 'ветер на кровлю и верх наружного ряда' : 'верх наружного ряда'}`]);
    kv.push(['На узел', `${f2(el.force / 1000)} кН`]);
    kv.push(['Крепёж', `${el.need} × ${el.fastener.short}`]);
    kv.push(['Несущая одного', `${f2(el.T / 1000)} кН · ${el.governs}`]);
    kv.push(['Защемление в древесине', `${Math.round(el.penetration)} мм`]);
    kv.push(['Помещается в узле', `${el.fit.n} шт · сетка ${el.fit.cols}×${el.fit.rows}`]);
    kv.push(['Шаги S1 / S2 / S3', `${Math.round(el.spacing.s1)} / ${Math.round(el.spacing.s2)} / ${Math.round(el.spacing.s3)} мм`]);
    kv.push(['Опора', `${el.support.label} · ${el.support.material === 'steel' ? 'сталь' : 'сосна'}`]);
  } else if (el.kind === 'beamTie') {
    if (el.fallback) kv.push(['Исполнение', el.fallback]);
    kv.push(['Отрыв ветром', `${f2(el.uplift / 1000)} кН`]);
    kv.push(['Горизонтальная сила', `${f2(el.H / 1000)} кН`]);
    if (el.welded) {
      kv.push(['Момент от эксцентриситета', `${f2(el.Mecc / 1e6)} кН·м`]);
      kv.push(['Длина шва по контуру', `${Math.round(el.weldLength)} мм`]);
      kv.push(['Катет', `${el.tie.kf} мм · допустимо ${el.kfMin}…${f2(el.kfMax)} мм`]);
      kv.push(['Напряжение в шве', `${f2(el.tauF)} / ${f2(el.tauZ)} МПа`]);
    } else {
      kv.push(['Болтов на столб', `${el.n} × М${el.tie.d} класса ${el.tie.grade}`]);
      kv.push(['На болт: растяжение', `${f2(el.Nb / 1000)} кН`]);
      kv.push(['На болт: срез', `${f2(el.Vb / 1000)} кН`]);
      if (el.washer) kv.push(['Шайба под гайку', `${el.washer}×${el.washer} мм`]);
    }
    kv.push(['Опора', `${el.post.label} · прогон ${el.beam.label}`]);
  } else if (el.kind === 'bracing') {
    kv.push(['Где', `${el.bays.length === 2 ? 'оба крайних пролёта' : 'крайний пролёт'} · пролёт ${Math.round(el.span)} мм`]);
    kv.push(['Диагонали', `${el.count} × ${el.sec.label}, длина ${Math.round(el.length)} мм`]);
    kv.push(['Держит вдоль ряда', `${kN(el.F)} кН = ветер ${kN(el.wind / el.bays.length)} + условная сила столбов ${kN(el.qfic / el.bays.length)}`]);
    kv.push(['Растяжение диагонали', `${kN(el.T)} кН`]);
    kv.push(['В столбы пролёта', `${kN(el.V)} кН в сжатие, ${kN(el.Vup)} в отрыв`]);
    kv.push(['Гибкость', `${Math.round(el.lambda)} из 400`]);
    kv.push(['Шов', `${Math.round(el.weldLength)} мм по контуру торца, катет ${el.kf} мм`]);
  } else if (el.kind === 'splice') {
    kv.push(['Решение', el.solution]);
    kv.push(['Сечение стыка', `${Math.round(el.x)} мм от левого края`]);
    kv.push(['Момент в стыке', `${f2(el.M / 1e6)} кН·м`]);
    kv.push(['Поперечная сила', `${f2(el.V / 1000)} кН`]);
    kv.push(['Стыков на элементе', `${el.count} шт`]);
    if (el.material === 'timber' && el.d) {
      kv.push(['Нагели', `${el.n} × М${el.d} · ${plural(el.cols, 'колонка', 'колонки', 'колонок')} в ${el.rows === 2 ? 'два ряда' : 'один ряд'}`]);
      kv.push(['На крайний нагель', `${f2(el.force / 1000)} кН при T = ${f2(el.T / 1000)} кН`]);
      kv.push(['Шаги S1 / S2 / S3', `${Math.round(el.spacing.s1)} / ${Math.round(el.spacing.s2)} / ${Math.round(el.spacing.s3)} мм`]);
    }
    if (el.weldLength) {
      kv.push(['Длина шва по контуру', `${Math.round(el.weldLength)} мм · катет ${el.kf} мм`]);
      kv.push(['Напряжение в шве', `${f2(el.tauF)} / ${f2(el.tauZ)} МПа`]);
    }
    if (el.plateT) kv.push(['Накладки', `2 × ${el.plateT}×${el.plateH} мм, длина ${el.plateLength} мм`]);
  } else if (el.kind === 'base') {
    kv.push(['Сжатие', `${f2(el.N / 1000)} кН`]);
    kv.push(['Отрыв ветром', `${f2(el.uplift / 1000)} кН`]);
    kv.push(['Момент в базе', `${f2(el.M / 1e6)} кН·м`]);
    kv.push(['Схема столба', el.needsFixity ? 'с защемлением внизу — база держит момент' : 'шарнир внизу, связи вверху']);
    if (el.base.kind === 'embed') {
      if (el.needsFixity) kv.push(['Заделка для защемления', `не менее ${el.needEmbed} мм`]);
    } else {
      kv.push(['На анкер: растяжение', `${f2(el.Na / 1000)} кН`]);
      kv.push(['Разнос анкеров', `${el.span} мм · вылет плиты ${Math.round(el.c)} мм`]);
      kv.push(['Под плитой', `${f2(el.sigma)} МПа при R_b ${f2((CONCRETE[el.concrete] ?? CONCRETE.B20).Rb)}`]);
    }
    // блок бетона — общая часть обеих баз: вес против отрыва и как его добрать
    kv.push(['Блок бетона', `${el.side}×${el.side}×${el.depth} мм = ${Math.round(el.mass)} кг`]);
    kv.push(['Нужно против отрыва', `${Math.round(el.needMass)} кг`]);
    if (el.frost?.set) {
      kv.push(['Промерзание', el.frost.soil.heaving
        ? `d_fn ${Math.round(el.frost.dfn)} мм, расчётная ${Math.round(el.frost.df)} мм · ${el.frost.soil.label}`
        : `${el.frost.soil.label} — непучинистый, глубина от мороза не зависит`]);
    } else {
      kv.push(['Промерзание', 'не задано — по морозу не проверено']);
    }
    kv.push([el.enough ? 'Запас по весу' : 'Не хватает',
      el.enough
        ? `${Math.round(el.mass - el.needMass)} кг`
        : `${Math.round(el.needMass - el.mass)} кг — глубина ${el.needDepth} мм при этой стороне или сторона ${el.needSide} мм при этой глубине`]);
  } else if (el.res?.uls) {
    kv.push(['M max', `${f2(Math.abs(el.res.uls.maxM) / 1e6)} кН·м`]);
    if (el.kind === 'wallPurlin' && el.lateralH) {
      kv.push(['Распор от стропил', `${kN(el.lateralH)} кН — изгиб из плоскости между столбами`]);
    }
    kv.push(['Q max', `${f2(Math.abs(el.res.uls.maxV) / 1000)} кН`]);
    const worstSpan = el.spans?.reduce((a, b) => (a.f > b.f ? a : b), { f: 0, limitLength: 1 });
    if (worstSpan) kv.push(['Прогиб', `${f2(worstSpan.f)} мм`]);
  }
  rows.push(kv.map(([a, b]) => `<div class="kv"><span>${a}</span><span>${b}</span></div>`).join(''));
  host.innerHTML = rows.join('');
}

const fmtVal = (c) => `${f2(c.value)}${c.unit ? ' ' + c.unit : ''} / ${f2(c.limit)}${c.unit ? ' ' + c.unit : ''}`;

/* ─────────────────── сводка и спецификация ─────────────────── */

const SEL_FOR = {
  battens: { type: 'battens' }, rafters: { type: 'rafter', index: 0 },
  purlin: { type: 'purlin' }, wallPurlin: { type: 'wallPurlin' },
  posts: { type: 'post', index: 0 }, wallPosts: { type: 'wallPost', index: 0 },
  ties: { type: 'tie', side: 'outer' },
  beamTies: { type: 'beamTie', side: 'outer' },
  bases: { type: 'base', side: 'outer' },
  spliceJoints: { type: 'splice' },
  bracing: { type: 'bracing' },
};
const ROW_OF = { rafters: ['rafters', 'rafter'], posts: ['posts', 'post'], wallPosts: ['wallPosts', 'wallPost'] };
function selectRow(res, key) {
  if (key === 'ties') return { type: 'tie', side: res.ties.outer.U >= res.ties.wall.U ? 'outer' : 'wall' };
  if (key === 'beamTies') return { type: 'beamTie', side: res.beamTies.outer.U >= res.beamTies.wall.U ? 'outer' : 'wall' };
  if (key === 'bases') return { type: 'base', side: res.bases.outer.U >= res.bases.wall.U ? 'outer' : 'wall' };
  if (key === 'spliceJoints') {
    const worst = res.spliceJoints.reduce((a, b) => (a.U > b.U ? a : b), res.spliceJoints[0]);
    return { type: 'splice', key: worst?.key };
  }
  const row = ROW_OF[key];
  if (!row) return { ...SEL_FOR[key] };
  const list = res[row[0]];
  const i = list.reduce((bi, e, idx) => (e.U > list[bi].U ? idx : bi), 0);
  return { type: row[1], index: i };
}

/**
 * Предупреждения над сводкой: то, о чём расчёт молчит, хотя обязан сказать.
 *
 * Балки решаются неразрезными по всей ширине, но элемент длиннее хлыста
 * придётся стыковать, и стык без накладки работает шарниром. Отдельной
 * строкой — случай, когда кусок ложится меньше чем на две опоры: это уже
 * не пониженный запас, а геометрически изменяемая схема.
 */
function renderWarns(res) {
  const list = res.splices;
  const host = $('warns');
  const frostWarns = frostWarnings(res);
  if (!list.length) { host.innerHTML = frostWarns.join(''); return; }
  const stock = res.model.opts.stockLength ?? 6000;
  const butt = (res.model.opts.spliceJoint ?? 'butt') === 'butt';
  const mm = (x) => Math.round(x);
  const out = [];

  for (const s of list.filter((e) => e.impossible)) {
    out.push(`<div class="warn bad"><b>${s.label}: стык встык сюда не поставить.</b>
      Элемент длиной ${mm(s.length)} мм не помещается в хлыст ${(stock / 1000).toFixed(0)} м,
      а опоры в пределах хлыста от отметки ${mm(s.from)} мм нет. Стык встык обязан лежать на
      опоре — он не передаёт ни момента, ни поперечной силы. Поставьте опору ближе или
      выберите стык с накладкой.</div>`);
  }

  for (const s of list.filter((e) => e.unstable && !e.impossible)) {
    const bad = s.cuts.filter((c) => c.unstable)
      .map((c) => `${mm(c.x0)}–${mm(c.x1)} мм (опор: ${c.supports})`).join(', ');
    out.push(butt
      ? `<div class="warn bad"><b>${s.label}: стык оставляет кусок меньше чем на двух опорах.</b>
          Куски ${bad} — при стыке встык это геометрически изменяемая схема, считать там нечего.
          Переставьте опоры так, чтобы каждый кусок лёг минимум на две, или выполните стык накладкой.</div>`
      : `<div class="warn bad"><b>${s.label}: кусок держится только накладкой.</b>
          Куски ${bad} — без накладки, восстанавливающей сечение, это изменяемая схема.
          Расчёт верит, что накладка есть, и сам её не проверяет.</div>`);
  }

  const spliced = list.filter((s) => s.splices > 0);
  if (!spliced.length) { host.innerHTML = [...frostWarns, ...out].join(''); return; }
  const items = spliced.map((s) => `${s.label} — ${plural(s.pieces, 'хлыст', 'хлыста', 'хлыстов')}, ${plural(s.splices, 'стык', 'стыка', 'стыков')} при ${s.at.map(mm).join(' и ')} мм`);
  out.push(`<div class="warn"><b>Длиннее хлыста ${(stock / 1000).toFixed(0)} м — потребуются стыки.</b>
    ${items.join('; ')}. ${butt
      ? 'Стык принят встык и посчитан шарниром: момент через него не идёт, опорный момент исчезает, а пролётные растут. Если стык будет с накладкой, переключите «Стык по длине» в блоке «Материалы».'
      : 'Стык принят с накладкой, и балка считается неразрезной. Сама накладка посчитана — решение в карточке «Стык по длине» внизу; накладку надо выполнить именно так, иначе неразрезности не будет.'}
    <a href="help/limits.html" target="_blank" rel="noopener">Что считается, а что нет</a>.</div>`);

  host.innerHTML = [...frostWarns, ...out].join('');
}

/**
 * Мороз: два честных предупреждения. Глубина промерзания не задана — значит,
 * фундамент по морозу не проверен вовсе. Задана, грунт пучинистый — подошва
 * ниже промерзания проверена, но это условие необходимое, а не достаточное:
 * касательные силы пучения тянут столб за боковую поверхность, и их расчёт
 * пока не сделан. Зелёная проверка глубины не должна выглядеть как «по морозу
 * всё хорошо».
 */
function frostWarnings(res) {
  const f = res.bases.outer.frost;
  const more = '<a href="help/frost.html" target="_blank" rel="noopener">мороз и пучение</a>';
  if (!f.set) {
    return [`<div class="warn"><b>Глубина промерзания не задана — фундамент по морозу не проверен.</b>
      Задайте её в блоке «Площадка» по карте нормативных глубин для суглинков и выберите грунт.
      Для пучинистых грунтов глубину фундамента в средней полосе обычно определяет именно мороз,
      а не вес против отрыва — ${more}.</div>`];
  }
  if (!f.soil.heaving) return [];
  return [`<div class="warn"><b>Касательные силы пучения не проверены.</b>
    Подошва ниже промерзания — условие необходимое, но не достаточное: пучинистый грунт
    (${f.soil.label}) смерзается с боковой поверхностью столба и тянет его вверх, даже если
    подошва глубже промерзания. Этот расчёт пока не сделан — что с этим делают на практике:
    ${more}.</div>`];
}

/** Склонение числительного: 1 стык, 2 стыка, 5 стыков. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  const word = a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  return `${n} ${word}`;
}

function renderSummary(res) {
  $('summary').innerHTML = res.summary.map((s) => `
    <div class="card" data-sel="${s.key}">
      <span class="t">${s.label}</span>
      <span class="u" style="color:${uColor(s.U)}">${f2(s.U)}</span>
      <span class="bar"><span style="width:${Math.min(100, s.U * 100).toFixed(0)}%;background:${uColor(s.U)}"></span></span>
      <span class="w">${s.worst ? s.worst.name : ''}</span>
    </div>`).join('');
  $('summary').querySelectorAll('[data-sel]').forEach((c) =>
    c.addEventListener('click', () => {
      state.sel = selectRow(res, c.getAttribute('data-sel'));
      render();
    }));
}

/**
 * Строка под спецификацией: сколько стыков придётся сделать.
 *
 * Цена считается по чистому объёму и массе, поэтому сам стык в неё не входит —
 * ни накладка, ни метизы. Сказать об этом надо там же, где человек смотрит,
 * что покупать.
 */
function spliceReportNote(b) {
  const spliced = b.items.filter((i) => i.splices > 0);
  if (!spliced.length) return '';
  const list = spliced.map((i) => `${i.name.toLowerCase()} — ${i.splices} на ${i.count} шт`).join(', ');
  const joints = b.spliceJoints ?? [];
  return `<p><b>Стыки по длине.</b> Элементы длиннее хлыста ${(b.stock / 1000).toFixed(0)} м собираются
    из кусков: ${list}. ${joints.length
      ? 'Стыки выполняются накладками, и балка считается неразрезной. Решение по каждому: '
        + joints.map((j) => `${j.label.toLowerCase()} — ${j.solution}`).join('; ') + '.'
      : 'Стыки выполняются встык и по расчёту лежат на опорах: момент через них не передаётся, накладки не нужны.'}</p>`;
}

function spliceNote(b) {
  const spliced = b.items.filter((i) => i.splices > 0);
  if (!spliced.length) return '';
  const total = spliced.reduce((a, i) => a + i.splices, 0);
  const list = spliced.map((i) => `${i.name.toLowerCase()} — ${i.splices}`).join(', ');
  const plated = (b.spliceJoints ?? []).length > 0;
  return `<div class="hint" style="border:0;padding:6px 0 0">
    Стыков по длине: <b>${total}</b> (${list}). ${plated
      ? 'Накладки и их метизы посчитаны и включены в смету — смотрите строки «Накладка стыка».'
      : 'Стык встык лежит на опоре и ничего не передаёт, поэтому накладок в смете нет.'}</div>`;
}

function renderBom(res, b) {
  const w = b.weights;
  const c = b.costs;
  const money = (x) => Math.round(x).toLocaleString('ru-RU');
  const rows = b.items.map((i) => `<tr><td>${i.name}</td><td>${i.section}</td><td>${i.material}</td>
    <td class="n">${i.count}</td><td class="n">${i.length}</td><td class="n">${i.totalLength.toFixed(1)}</td>
    <td class="n">${i.stockPieces ?? '—'}</td><td class="n">${i.volume ? i.volume.toFixed(3) : '—'}</td>
    <td class="n">${i.mass.toFixed(1)}</td><td class="n">${money(i.cost)}</td></tr>`).join('');
  const fast = b.fasteners.map((f) => `<tr><td>${f.name}</td><td colspan="2">${f.note}</td>
    <td class="n">${f.count}</td><td colspan="3"></td><td class="n">—</td><td class="n">${f.mass.toFixed(1)}</td>
    <td class="n">${f.cost ? money(f.cost) : '—'}</td></tr>`).join('');
  const groups = w.groups.map((g) => `<div class="kv"><span>${g.name} <i style="color:var(--ink-3);font-style:normal">· ${g.note}</i></span><span>${g.mass.toFixed(0)} кг</span></div>`).join('');

  $('bom').innerHTML = `<div class="pane-title">Спецификация · закупка хлыстами по ${(b.stock / 1000).toFixed(0)} м</div>
    <div class="tbl"><table>
    <tr><th>Элемент</th><th>Сечение</th><th>Материал</th><th>Шт</th><th>Длина, мм</th><th>Всего, м</th><th>Купить</th><th>Объём, м³</th><th>Масса, кг</th><th>Стоимость, ${c.currency}</th></tr>
    ${rows}${fast}
    <tr><td colspan="7"><b>Итого</b></td><td class="n"><b>${w.timber.volume.toFixed(3)}</b></td><td class="n"><b>${w.total.toFixed(0)}</b></td><td class="n"><b>${money(c.total - c.roofing)}</b></td></tr></table></div>
    ${spliceNote(b)}

    <div class="pane-title" style="margin-top:14px">Масса конструкции</div>
    <div class="row2" style="gap:14px">
      <div>${groups}</div>
      <div>
        <div class="kv"><span><b>Сосна</b></span><span><b>${w.timber.volume.toFixed(3)} м³ · ${w.timber.mass.toFixed(0)} кг</b></span></div>
        <div class="kv"><span><b>Сталь</b></span><span><b>${w.steel.length.toFixed(1)} пог. м · ${w.steel.mass.toFixed(0)} кг</b></span></div>
        <div class="kv"><span><b>Кровля</b> · ${w.roofing.area.toFixed(1)} м²</span><span><b>${w.roofing.mass.toFixed(0)} кг</b></span></div>
        <div class="kv"><span><b>Всего</b> на ${w.planArea.toFixed(1)} м² навеса</span><span><b>${w.total.toFixed(0)} кг · ${w.perSqm.toFixed(1)} кг/м²</b></span></div>
        <div class="kv"><span>Собственный вес кровельной части</span><span>${f2(w.deadPressure)} кПа</span></div>
        <div class="kv"><span>Его доля в нагрузке: у стены / в поле</span><span>${(w.deadShareWall * 100).toFixed(0)} % / ${(w.deadShareField * 100).toFixed(0)} %</span></div>
      </div>
    </div>
    <div class="hint" style="border:0;padding:8px 0 0">
      m = V·ρ для дерева (ρ = 500 кг/м³, сухая сосна) и m = A·L·ρ для стали (ρ = 7850 кг/м³).
      Этот вес уже учтён в расчёте нагрузок, а не добавлен задним числом.
    </div>

    <div class="pane-title" style="margin-top:14px">Стоимость материалов</div>
    <div class="row2" style="gap:14px">
      <div>${c.groups.map((g) => `<div class="kv"><span>${g.name} <i style="color:var(--ink-3);font-style:normal">· ${g.base}</i></span><span>${money(g.cost)} ${c.currency}</span></div>`).join('')}</div>
      <div>
        <div class="kv"><span><b>Всего материалов</b></span><span><b>${money(c.total)} ${c.currency}</b></span></div>
        <div class="kv"><span>На 1 м² навеса</span><span>${money(c.perSqm)} ${c.currency}/м²</span></div>
        <div class="kv"><span>Доля дерева / металла</span><span>${c.total > 0 ? `${Math.round((c.timber / c.total) * 100)} % / ${Math.round((c.steel / c.total) * 100)} %` : '—'}</span></div>
      </div>
    </div>
    <div class="hint" style="border:0;padding:8px 0 0">
      Цены задаются в панели слева: дерево по объёму, металл по массе, кровля по площади, метизы поштучно.
      Метизы посчитанных узлов сюда входят, а работа, фундамент, доставка и раскрой — нет.
    </div>

    ${res.snow.drift && res.snow.drift.applies ? `
      <div class="kv" style="margin-top:10px"><span>Снеговой мешок · μ по СП 20 (Б.5)</span><span>формула ${f2(res.snow.drift.raw)} · 2h/S₀ ${f2(res.snow.drift.capGeom)} · потолок ${f2(res.snow.drift.capAbs)} → принято ${f2(res.snow.muWall)} (${res.snow.drift.governs})</span></div>
      <div class="kv"><span>Зона b (Б.6) и μ₁ (перечисление «е»)</span><span>b = ${Math.round(res.snow.driftLength)} мм${res.snow.drift.spread ? ' (ветвь с растеканием)' : ''} · μ₁ = ${f2(res.snow.drift.mu1)}</span></div>
      <div class="kv"><span>m₂ по перечислению «в»</span><span>${res.snow.drift.m2parts
        ? `0,5·k₁·k₂·k₃ = 0,5·${f2(res.snow.drift.m2parts.k1)}·${f2(res.snow.drift.m2parts.k2)}·${f2(res.snow.drift.m2parts.k3)} = ${f2(res.snow.drift.m2)} (a = ${f2(res.snow.drift.a)} м)`
        : `${f2(res.snow.drift.m2)} — ширина покрытия ≥ 21 м`}</span></div>`
      : res.snow.drift ? `<div class="kv" style="margin-top:10px"><span>Снеговой мешок</span><span>не учитывается: ${res.snow.drift.governs}</span></div>` : ''}
    <div class="kv"><span>Ветровой распор на стеновой ряд</span><span>${f2(res.thrust.total / 1000)} кН (скат ${f2(res.thrust.roof / 1000)} + кромка ${f2(res.thrust.fascia / 1000)})</span></div>
    <div class="kv"><span>Наружный столб: вниз / отрыв</span><span>${f2(res.foundation.maxDown / 1000)} кН / ${f2(res.foundation.uplift / 1000)} кН → фундамент ≥ ${Math.round(res.foundation.cubeSide)} мм куб</span></div>`;
}

/**
 * Стоимость в шапке. Рядом показывается изменение относительно прошлого
 * значения — чтобы цена правки была видна в момент правки, а не после
 * прокрутки вниз. Дельта держится до следующего изменения, иначе она
 * мигала бы на каждой перерисовке.
 */
let lastCost = null;
let lastDelta = 0;

function resetCostBaseline() {
  lastCost = null;
  lastDelta = 0;
}

function renderCost(bom) {
  const pill = $('cost-pill');
  if (!pill) return;
  const total = bom.costs.total;
  if (!(total > 0)) { // цены обнулены — прятать, а не показывать «0 ₽»
    pill.hidden = true;
    resetCostBaseline(); // иначе при возврате цен всплывёт дельта от прошлой жизни
    return;
  }
  pill.hidden = false;
  const money = (x) => Math.round(x).toLocaleString('ru-RU');
  if (lastCost !== null && Math.abs(total - lastCost) >= 1) lastDelta = total - lastCost;
  lastCost = total;
  const d = Math.round(lastDelta);
  pill.innerHTML = `${money(total)} ${bom.costs.currency}` +
    (d ? ` <span class="delta">${d > 0 ? '+' : '−'}${money(Math.abs(d))}</span>` : '');
  pill.title = `Материалы: ${money(total)} ${bom.costs.currency}` +
    (d ? `, последняя правка ${d > 0 ? 'подорожала' : 'удешевила'} на ${money(Math.abs(d))}` : '') +
    '. Нажмите, чтобы перейти к смете.';
}

$('cost-pill').addEventListener('click', () => {
  $('bom').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ─────────────────── подбор по цене ─────────────────── */

let searchTarget = 0.9;
let searchBusy = false;

function money(x) { return Math.round(x).toLocaleString('ru-RU'); }

async function runCostSearch() {
  if (searchBusy) return;
  searchBusy = true;
  const host = $('search');
  const btn = $('btn-cost-search');
  btn.disabled = true;
  btn.textContent = 'Считаю…';
  host.hidden = false;
  host.innerHTML = `<div class="pane-title">Подбор по цене</div>
    <div class="hint" id="search-note" style="border:0;padding:0">Перебираю сочетания…</div>
    <div class="progress"><span id="search-bar" style="width:0%"></span></div>`;
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const before = billOfMaterials(state.result).costs.total;
  try {
    const r = await searchByCost(state.model, {
      target: searchTarget,
      onProgress: ({ stage, done, total }) => {
        const note = $('search-note'), bar = $('search-bar');
        if (note) note.textContent = `${stage}: ${done} из ${total}`;
        if (bar) bar.style.width = `${Math.round((done / total) * 100)}%`;
      },
    });
    renderSearch(r, before);
  } catch (e) {
    host.innerHTML = `<div class="pane-title">Подбор по цене${SEARCH_HELP}</div><div class="hint" style="border:0;padding:0">Не получилось: ${String(e)}</div>`;
  }
  btn.disabled = false;
  btn.textContent = 'Подобрать по цене';
  searchBusy = false;
}

/** Кружок «?» в заголовке таблицы подбора: объяснение, почему варианты именно такие. */
const SEARCH_HELP = '<a class="help" href="help/cost.html" target="_blank" rel="noopener"'
  + ' title="Справка: почему подбор предлагает именно это" aria-label="Справка: почему подбор предлагает именно это">?</a>';

function renderSearch(r, before) {
  const host = $('search');
  const cur = billOfMaterials(state.result);
  if (!r.options.length) {
    host.innerHTML = `<div class="pane-title">Подбор по цене</div>
      <div class="hint" style="border:0;padding:0">Ни одно сочетание не уложилось в запас U ≤ ${f2(searchTarget)}.
      Сортамента не хватает — уменьшите пролёт или свес, либо ослабьте запас.</div>`;
    return;
  }
  const rows = r.options.map((o, i) => {
    const save = before - o.cost;
    return `<tr class="opt-row${i === 0 ? ' best' : ''}">
      <td class="n">${money(o.cost)} ${cur.costs.currency}</td>
      <td class="n ${save > 0 ? 'save' : ''}">${save > 0 ? '−' + money(save) : save < 0 ? '+' + money(-save) : '—'}</td>
      <td class="n">${f2(o.maxU)}</td>
      <td class="n">${Math.round(o.mass)} кг</td>
      <td>${o.parts.rafters}</td><td>${o.parts.battens}</td>
      <td>${o.parts.purlin}</td><td>${o.parts.posts}</td><td>${o.parts.bracing}</td>
      <td>${o.parts.wallPurlin}</td><td>${o.parts.wallPosts}</td>
      <td><button class="btn" data-apply="${i}">применить</button></td></tr>`;
  }).join('');

  host.innerHTML = `<div class="pane-title">Подбор по цене · ${r.options.length} лучших из ${r.evaluated} расчётов за ${(r.ms / 1000).toFixed(1)} с${SEARCH_HELP}</div>
    <div class="tbl"><table>
      <tr><th>Стоимость</th><th>Разница</th><th>Макс U</th><th>Масса</th>
        <th>Стропила</th><th>Обрешётка</th><th>Прогон</th><th>Столбы</th><th>Связи</th><th>Обвязка</th><th>Столбы у стены</th><th></th></tr>
      <tr><td class="n"><b>${money(before)} ${cur.costs.currency}</b></td><td class="n">текущий</td>
        <td class="n">${f2(state.result.maxU)}</td><td class="n">${Math.round(cur.weights.total)} кг</td>
        <td>${o2(state.model.rafters.sectionId)} × ${state.model.rafters.xs.length}</td>
        <td>${o2(state.model.battens.sectionId)} / ${state.model.battens.spacing}</td>
        <td>${o2(state.model.purlin.sectionId)}</td>
        <td>${o2(state.model.posts.sectionId)} × ${state.model.posts.xs.length}</td>
        <td>${state.model.bracing?.along === 'cross' ? `крест ${o2(state.model.bracing.sectionId)}` : 'без связей'}</td>
        <td>${o2(state.model.wallPurlin.sectionId)}</td>
        <td>${o2(state.model.wallPosts.sectionId)} × ${state.model.wallPosts.xs.length}</td><td></td></tr>
      ${rows}
    </table></div>
    <div class="row2" style="gap:14px;margin-top:10px">
      <div class="hint" style="border:0;padding:0">
        Перебираются сечения и число стропил, столбов обоих рядов, прогонов и обрешётки,
        а наружный ряд — в двух схемах: без связей и с крестом в крайнем пролёте.
        Геометрия не трогается. Сортамент берётся того же материала, что выбран сейчас.
      </div>
      <div class="hint" style="border:0;padding:0">
        Метизы узлов в смете есть, а работа, доставка, фундамент и раскрой — нет: вариант с частыми
        стропилами дешевле по кубатуре, но дороже по монтажу. Оптимум зависит от ваших цен —
        перебор имеет смысл после того, как вы подставили свои.
      </div>
    </div>
    <div class="field" style="max-width:260px;margin-top:8px">
      <label for="search-target">Целевой запас — подбирать до U ≤ <b>${f2(searchTarget)}</b></label>
      <input type="range" id="search-target" min="0.7" max="1" step="0.05" value="${searchTarget}">
    </div>`;

  host.querySelectorAll('[data-apply]').forEach((b) =>
    b.addEventListener('click', () => {
      const o = r.options[Number(b.getAttribute('data-apply'))];
      state.model = JSON.parse(JSON.stringify(o.model));
      resetCostBaseline();
      $('search').hidden = true;
      render(`Применён вариант за ${money(o.cost)} ${cur.costs.currency}`);
    }));
  const t = $('search-target');
  t.addEventListener('change', () => { searchTarget = Number(t.value); runCostSearch(); });
}

/** Подпись сечения по его идентификатору. */
const o2 = (id) => section(id).label;

$('btn-cost-search').addEventListener('click', runCostSearch);

/* ─────────────────── сцена и перетаскивание ─────────────────── */

function renderCanvas(res) {
  const DRAW = { plan: drawPlan, section: drawSection, diagrams: drawDiagrams, nodes: drawNodes };
  const out = (DRAW[state.view] ?? drawPlan)(res, state.sel);
  $('canvas').innerHTML = out.svg;
  state.meta = out.meta;
  wrapForZoom();
  if (state.view === 'plan') wirePlan();
  if (state.view === 'nodes') wireNodes();
}

/* ─────────────────── масштаб и панорама ─────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
const zoom = { plan: { k: 1, tx: 0, ty: 0 }, section: { k: 1, tx: 0, ty: 0 }, diagrams: { k: 1, tx: 0, ty: 0 }, nodes: { k: 1, tx: 0, ty: 0 } };
const zv = () => zoom[state.view];

function svgEl() { return $('canvas').querySelector('svg'); }

/** Размеры системы координат рисунка и его положение на экране. */
function frame() {
  const svg = svgEl();
  if (!svg) return null;
  const b = svg.viewBox.baseVal;
  return { svg, w: b.width, h: b.height, rect: svg.getBoundingClientRect() };
}

/**
 * Экранная точка → координаты SVG.
 * Через getScreenCTM, а не вручную через viewBox и ширину элемента: при
 * height 100 % включается центрирование по preserveAspectRatio, и ручной
 * пересчёт начинает врать.
 * @param {boolean} inner true — в системе координат самого рисунка,
 *   то есть уже с учётом масштаба и сдвига.
 */
function toSvg(clientX, clientY, inner = false) {
  const svg = svgEl();
  if (!svg) return { x: 0, y: 0 };
  const target = inner ? svg.querySelector('g[data-zoom]') || svg : svg;
  const ctm = target.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

const toFrame = (clientX, clientY) => toSvg(clientX, clientY, false);

/**
 * Панорама свободная — всё клеточное поле рабочее. Ограничение мягкое:
 * не даём увести рисунок целиком из виду, кусок всегда остаётся на экране.
 */
function clampPan() {
  const f = frame();
  if (!f) return;
  const z = zv();
  const keep = 80; // сколько единиц рисунка обязано остаться видимым
  z.tx = Math.min(f.w - keep, Math.max(keep - z.k * f.w, z.tx));
  z.ty = Math.min(f.h - keep, Math.max(keep - z.k * f.h, z.ty));
}

/** Всё содержимое рисунка складывается в одну группу, её и двигаем. */
function wrapForZoom() {
  const svg = svgEl();
  if (!svg) return;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('data-zoom', '');
  while (svg.firstChild) g.appendChild(svg.firstChild);
  svg.appendChild(g);
  applyZoom();
}

function applyZoom() {
  const svg = svgEl();
  const g = svg && svg.querySelector('g[data-zoom]');
  const z = zv();
  if (g) g.setAttribute('transform', `translate(${z.tx.toFixed(2)} ${z.ty.toFixed(2)}) scale(${z.k.toFixed(4)})`);
  const out = $('zoom-val');
  if (out) out.textContent = `${Math.round(z.k * 100)} %`;
}

/** Масштабирование вокруг точки: она остаётся под курсором. */
function zoomAt(point, factor) {
  const z = zv();
  const k = Math.min(14, Math.max(1, z.k * factor));
  if (k === z.k) return;
  z.tx = point.x - (point.x - z.tx) * (k / z.k);
  z.ty = point.y - (point.y - z.ty) * (k / z.k);
  z.k = k;
  clampPan();
  applyZoom();
}

const canvasEl = $('canvas');
canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(toFrame(e.clientX, e.clientY), e.deltaY < 0 ? 1.18 : 1 / 1.18);
}, { passive: false });

let pan = null;
const pointers = new Map();
let pinch = null;

canvasEl.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { // щипок на сенсорном экране
    pan = null;
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
    return;
  }
  if (e.target.closest && e.target.closest('[data-pick]')) return; // тянут элемент схемы
  pan = { x: e.clientX, y: e.clientY, tx: zv().tx, ty: zv().ty };
  canvasEl.setPointerCapture(e.pointerId);
});

canvasEl.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch.dist > 0) zoomAt(toFrame((a.x + b.x) / 2, (a.y + b.y) / 2), dist / pinch.dist);
    pinch.dist = dist;
    return;
  }
  if (!pan) return;
  const f = frame();
  if (!f) return;
  const z = zv();
  const scale = f.rect.width > 0 ? f.w / f.rect.width : 1; // единиц рисунка в пикселе
  z.tx = pan.tx + (e.clientX - pan.x) * scale;
  z.ty = pan.ty + (e.clientY - pan.y) * scale;
  clampPan();
  applyZoom();
});

const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) pan = null;
};
canvasEl.addEventListener('pointerup', endPointer);
canvasEl.addEventListener('pointercancel', endPointer);

$('zoom-in').addEventListener('click', () => { const f = frame(); if (f) zoomAt({ x: f.w / 2, y: f.h / 2 }, 1.4); });
$('zoom-out').addEventListener('click', () => { const f = frame(); if (f) zoomAt({ x: f.w / 2, y: f.h / 2 }, 1 / 1.4); });
$('zoom-reset').addEventListener('click', () => { const z = zv(); z.k = 1; z.tx = 0; z.ty = 0; applyZoom(); });

/** Массивы координат, которые можно таскать мышью. */
const ARRAY_OF = {
  rafter: (m) => m.rafters.xs,
  post: (m) => m.posts.xs,
  wallPost: (m) => m.wallPosts.xs,
};
const LABEL_OF = { rafter: 'Стропило', post: 'Столб', wallPost: 'Столб у стены' };
const MIN_GAP = 100; // мм — соседи не могут слипнуться или поменяться местами

/**
 * Состояние перетаскивания живёт вне разметки, а слушатели висят на window:
 * каждая перерисовка заменяет SVG целиком, вместе с элементом, который иначе
 * держал бы захват указателя — тогда перетаскивание обрывалось бы на первом шаге.
 */
let drag = null;
let dragFrame = 0;

function canvasToMm(clientX, clientY = 0) {
  const meta = state.meta;
  if (!meta) return 0;
  return (toSvg(clientX, clientY, true).x - meta.ox) / meta.sc;
}

function onDragMove(e) {
  if (!drag) return;
  e.preventDefault();
  drag.clientX = e.clientX;
  drag.fine = e.shiftKey;
  if (dragFrame) return; // кадры склеиваются, чтобы пересчёт не отставал от мыши
  dragFrame = requestAnimationFrame(() => {
    dragFrame = 0;
    if (!drag) return;
    const arr = ARRAY_OF[drag.type](state.model);
    const step = drag.fine ? 10 : 50;
    const x = Math.max(drag.lo, Math.min(drag.hi, Math.round(canvasToMm(drag.clientX) / step) * step));
    if (arr[drag.index] === x) return;
    arr[drag.index] = x;
    drag.moved = true;
    render(`${LABEL_OF[drag.type]} ${drag.index + 1} → ${Math.round(x)} мм`);
  });
}

function onDragEnd() {
  if (!drag) return;
  if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
  const moved = drag.moved;
  drag = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  if (moved) save();
  else render(); // простой клик — только подсветить выбранный элемент
}

/** Клик по детали узла открывает этот узел в инспекторе. */
function wireNodes() {
  $('canvas').querySelectorAll('[data-pick]').forEach((g) => {
    g.addEventListener('pointerdown', () => {
      state.sel = {
        type: g.getAttribute('data-pick'),
        side: g.getAttribute('data-side') ?? undefined,
        key: g.getAttribute('data-key') ?? undefined,
      };
      render();
    });
  });
}

function wirePlan() {
  const svg = $('canvas').querySelector('svg');
  svg.querySelectorAll('[data-pick]').forEach((g) => {
    g.addEventListener('pointerdown', (e) => {
      const type = g.getAttribute('data-pick');
      if (!ARRAY_OF[type]) { state.sel = { type }; render(); return; }
      const index = Number(g.getAttribute('data-index'));
      const arr = ARRAY_OF[type](state.model);
      state.sel = { type, index };
      drag = {
        type, index, moved: false, clientX: e.clientX, fine: e.shiftKey,
        lo: index > 0 ? arr[index - 1] + MIN_GAP : 0,
        hi: index < arr.length - 1 ? arr[index + 1] - MIN_GAP : state.model.geom.B,
      };
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragEnd);
      window.addEventListener('pointercancel', onDragEnd);
      e.preventDefault();
      renderInspector(state.result);
    });
  });
}

// двойной клик слушаем на контейнере, а не на SVG: SVG подменяется между кликами
$('canvas').addEventListener('dblclick', (e) => {
  if (state.view !== 'plan') return;
  const x = Math.max(0, Math.min(state.model.geom.B, Math.round(canvasToMm(e.clientX) / 50) * 50));
  state.model.rafters.xs.push(x);
  state.model.rafters.xs.sort((a, b) => a - b);
  state.sel = { type: 'rafter', index: state.model.rafters.xs.indexOf(x) };
  render(`Добавлено стропило на ${x} мм`);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.sel.type === 'rafter' && state.model.rafters.xs.length > 3) {
      state.model.rafters.xs.splice(state.sel.index, 1);
      state.sel.index = Math.max(0, state.sel.index - 1);
      render('Стропило удалено');
    } else if ((state.sel.type === 'post' || state.sel.type === 'wallPost')) {
      const arr = ARRAY_OF[state.sel.type](state.model);
      if (arr.length > 2) {
        arr.splice(state.sel.index, 1);
        state.sel.index = Math.max(0, state.sel.index - 1);
        render(`${LABEL_OF[state.sel.type]} удалён`);
      }
    }
  }
});

/* ─────────────────── отчёт ─────────────────── */

function buildReport(res) {
  const m = res.model, b = billOfMaterials(res);
  const el = (x) => `<tr><td>${x.label}</td><td>${x.U > 1 ? 'НЕ ПРОХОДИТ' : 'проходит'}</td><td>${f2(x.U)}</td><td>${x.worst?.name ?? '—'}</td></tr>`;
  const checkRows = (title, checks) => `<h3>${title}</h3><table><tr><th>Проверка</th><th>Условие</th><th>Значение</th><th>Предел</th><th>U</th></tr>` +
    checks.map((c) => `<tr><td>${c.name}</td><td>${c.formula}</td><td>${f2(c.value)} ${c.unit}</td><td>${f2(c.limit)} ${c.unit}</td><td>${f2(c.U)}</td></tr>`).join('') + '</table>';
  const worstRafter = res.rafters.reduce((a, c) => (a.U > c.U ? a : c));
  const worstPost = res.posts.reduce((a, c) => (a.U > c.U ? a : c));
  const worstWallPost = res.wallPosts.reduce((a, c) => (a.U > c.U ? a : c));
  const wp = m.wallPosts;
  $('report').innerHTML = `
    <h1>Расчёт навеса, пристроенного к дому</h1>
    <p>Дата: ${new Date().toLocaleDateString('ru-RU')}. Нормы: СП 20.13330.2016, СП 64.13330.2017, СП 16.13330.2017.</p>
    <h2>1. Исходные данные</h2>
    <table>
      <tr><td>Габариты</td><td>${m.geom.B} × ${m.geom.L} мм, свес ${m.geom.a} мм, уклон ${m.geom.alpha}°</td></tr>
      <tr><td>Крепление стропил</td><td>${res.ties.outer.need} × ${res.ties.outer.fastener.short} у прогона, ${res.ties.wall.need} × ${res.ties.wall.fastener.short} у обвязки; шаги S1 ${Math.round(res.ties.outer.spacing.s1)}, S2 ${Math.round(res.ties.outer.spacing.s2)}, S3 ${Math.round(res.ties.outer.spacing.s3)} мм</td></tr>
      <tr><td>Высота столбов</td><td>${m.geom.postHeight} мм; μ наружных ${f2(worstPost.muX)}/${f2(worstPost.muY)}, стеновых ${f2(worstWallPost.muX)}/${f2(worstWallPost.muY)} (поперёк/вдоль ряда)</td></tr>
      <tr><td>Раскрепление наружного ряда</td><td>поперёк ряда верх держат стропила: сила ${kN(res.bracing.holdX)} кН уходит по ним к стене и проверяется в креплении стропил и в обвязке;
        вдоль стены ${res.cross
          ? `крест из диагоналей ${res.cross.sec.label} в ${res.cross.bays.length === 2 ? 'обоих крайних пролётах' : 'крайнем пролёте'}, держит ${kN(res.cross.F)} кН (ветер плюс условная поперечная сила столбов по формуле (18) СП 16)`
          : 'связей нет — столбы консоли, μ = 2, ветер вдоль стены идёт в них'}</td></tr>
      <tr><td>Крепление к дому</td><td>${wp.xs.length} стальных столба ${worstWallPost.sec.label}, притянуты сквозными шпильками М${wp.boltDiameter} класса ${wp.boltGrade} по ${wp.boltCount} шт на столб через стену из газоблока ${wp.blockClass} толщиной ${wp.wallThickness} мм; шайба-пластина ${wp.plateSize}×${wp.plateSize} мм с внутренней стороны. Поверх столбов — обвязка ${res.wallPurlin.sec.label}, по ней идут стропила.</td></tr>
      <tr><td>Покрытие</td><td>${ROOFING[m.roofing].label}</td></tr>
      <tr><td>Снеговой район</td><td>${m.site.snowRegion}, S_g = ${SNOW_REGIONS[m.site.snowRegion]} кПа</td></tr>
      <tr><td>Ветровой район</td><td>${m.site.windRegion}, местность ${m.site.terrain}</td></tr>
      <tr><td>Снеговой мешок</td><td>${m.site.drift && res.snow.drift && res.snow.drift.applies
        ? `перепад h = ${(res.snow.drift.h).toFixed(2)} м, l₁ = ${res.snow.drift.l1.toFixed(1)} м, l₂ = ${res.snow.drift.l2.toFixed(1)} м, m₁ = ${res.snow.drift.m1}, m₂ = ${res.snow.drift.m2}.
           По формуле (Б.5) μ = ${f2(res.snow.drift.raw)}; ограничения: 2h/S_g = ${f2(res.snow.drift.capGeom)}, потолок ${res.snow.drift.capAbs}.
           Принято μ = ${f2(res.snow.muWall)} — ${res.snow.drift.governs}.
           m₂ по перечислению «в» = ${f2(res.snow.drift.m2)}${res.snow.drift.m2parts ? ` (k₁ = ${f2(res.snow.drift.m2parts.k1)}, k₂ = ${f2(res.snow.drift.m2parts.k2)}, k₃ = ${f2(res.snow.drift.m2parts.k3)})` : ''}.
           Зона b ${res.snow.drift.spread ? 'по формуле (Б.6)' : '= 2h'} = ${Math.round(res.snow.driftLength)} мм, μ₁ по перечислению «е» = ${f2(res.snow.drift.mu1)}.
           Нижнее покрытие рассчитано в двух вариантах загружения — равномерном и с мешком (схема Б.8), принята огибающая.`
        : (res.snow.drift ? `не учитывается: ${res.snow.drift.governs}` : 'не учитывается')}</td></tr>
      <tr><td>Материалы</td><td>сосна ${m.opts.timber.grade} сорт, класс эксплуатации ${m.opts.timber.serviceClass}; сталь ${m.opts.steel.grade}</td></tr>
    </table>
    <h2>2. Нагрузки</h2>
    <table>
      <tr><td>Собственный вес кровли и обрешётки</td><td>${f2(res.dead.total)} кН/м² по скату</td></tr>
      <tr><td>Снег у стены / в поле</td><td>нормативный ${f2(res.snow.at(0))} / ${f2(res.snow.at(m.geom.L + m.geom.a))} кПа;
        расчётный (γ_f = 1,4) ${f2(res.snow.at(0) * 1.4)} / ${f2(res.snow.at(m.geom.L + m.geom.a) * 1.4)} кПа</td></tr>
      <tr><td>Ветровой отрыв</td><td>${f2(res.wind.up)} кПа</td></tr>
      <tr><td>Сосредоточенная (п. 8.3.4)</td><td>1,0 кН на обрешётку</td></tr>
    </table>
    <h2>3. Результаты по элементам</h2>
    <table><tr><th>Элемент</th><th>Итог</th><th>U</th><th>Определяющая проверка</th></tr>${res.summary.map(el).join('')}</table>
    ${checkRows(`Стропило ${worstRafter.sec.label} (самое нагруженное)`, worstRafter.checks)}
    ${checkRows(`Обрешётка ${res.battens.sec.label}`, res.battens.checks)}
    ${checkRows(`Прогон ${res.purlin.sec.label}`, res.purlin.checks)}
    ${checkRows(`Обвязка у стены ${res.wallPurlin.sec.label}`, res.wallPurlin.checks)}
    ${checkRows(`Наружный столб ${worstPost.sec.label} (самый нагруженный)`, worstPost.checks)}
    ${checkRows(`Стеновой столб ${worstWallPost.sec.label} и его крепление (самый нагруженный)`, worstWallPost.checks)}
    ${res.cross ? checkRows(`Связи наружного ряда: крест ${res.cross.sec.label}`, res.cross.checks) : ''}
    <h2>4. Узлы и фундамент (оценочно)</h2>
    <table>
      <tr><td>Горизонтальный распор на стеновой ряд</td><td>${kN(res.bracing.toWall)} кН: скат ${f2(res.thrust.roof / 1000)} + наружная кромка ${f2(res.thrust.fascia / 1000)} + верх наружного ряда ${kN(res.bracing.holdX)}. Сила тяжести распора не даёт — все опоры вертикальные.</td></tr>
      <tr><td>Одна шпилька</td><td>растяжение ${f2(worstWallPost.bolts.Nbolt / 1000)} кН, срез ${f2(worstWallPost.bolts.Vbolt / 1000)} кН</td></tr>
      <tr><td>Нагрузка на наружный столб</td><td>вниз ${f2(res.foundation.maxDown / 1000)} кН, отрыв ${f2(res.foundation.uplift / 1000)} кН</td></tr>
      <tr><td>Фундамент против отрыва</td><td>удержать ${f2(res.foundation.requiredHold)} кН — это ${Math.round(res.foundation.requiredMassKg)} кг бетона на столб, куб со стороной ≈ ${Math.round(res.foundation.cubeSide)} мм</td></tr>
    </table>
    <h2>5. Массы конструкции</h2>
    <p>Собственный вес всех элементов входит в расчёт нагрузок: стропила и прогоны — погонным
    весом сечения, обрешётка — весом на 1 м², столбы — весом ствола в осевой силе. Формулы:</p>
    <p><i>дерево:</i> V = b·h·L·n, m = V·ρ, ρ = 500 кг/м³ (сухая сосна; свежераспиленная до 700–800).<br>
       <i>сталь:</i> m = A·L·n·ρ, ρ = 7850 кг/м³ — то же, что A[см²]·0,785 кг/м.<br>
       <i>кровля:</i> m = g·S/g₀, где g — вес покрытия по скату, S — площадь ската.</p>
    <table><tr><th>Группа</th><th>Что входит</th><th>Масса, кг</th></tr>
      ${b.weights.groups.map((g) => `<tr><td>${g.name}</td><td>${g.note}</td><td>${g.mass.toFixed(1)}</td></tr>`).join('')}
      <tr><td colspan="2"><b>Всего</b></td><td><b>${b.weights.total.toFixed(0)}</b></td></tr>
    </table>
    <table>
      <tr><td>Сосна</td><td>${b.weights.timber.volume.toFixed(3)} м³ = ${b.weights.timber.mass.toFixed(0)} кг</td></tr>
      <tr><td>Сталь</td><td>${b.weights.steel.length.toFixed(1)} пог. м = ${b.weights.steel.mass.toFixed(0)} кг</td></tr>
      <tr><td>Кровля</td><td>${b.weights.roofing.area.toFixed(1)} м² = ${b.weights.roofing.mass.toFixed(0)} кг</td></tr>
      <tr><td>Метизы</td><td>${b.weights.fasteners.mass.toFixed(1)} кг</td></tr>
      <tr><td>Удельный вес навеса</td><td>${b.weights.perSqm.toFixed(1)} кг/м² в плане</td></tr>
      <tr><td>Собственный вес кровельной части</td><td>${f2(b.weights.deadPressure)} кПа — это ${(b.weights.deadShareWall * 100).toFixed(0)} % полной нагрузки у стены и ${(b.weights.deadShareField * 100).toFixed(0)} % в поле</td></tr>
    </table>

    <h2>6. Стоимость материалов</h2>
    <p>Цены — те, что заданы в расчёте; метизы посчитанных узлов в смете есть, а работа, фундамент,
    доставка и раскрой не учтены.</p>
    <table><tr><th>Группа</th><th>Расчёт</th><th>Стоимость, ${b.costs.currency}</th></tr>
      ${b.costs.groups.map((g) => `<tr><td>${g.name}</td><td>${g.base}</td><td>${Math.round(g.cost).toLocaleString('ru-RU')}</td></tr>`).join('')}
      <tr><td colspan="2"><b>Всего</b></td><td><b>${Math.round(b.costs.total).toLocaleString('ru-RU')}</b></td></tr>
      <tr><td colspan="2">На 1 м² навеса</td><td>${Math.round(b.costs.perSqm).toLocaleString('ru-RU')}</td></tr>
    </table>

    <h2>7. Спецификация</h2>
    <table><tr><th>Элемент</th><th>Сечение</th><th>Шт</th><th>Длина, мм</th><th>Хлыстов по ${(b.stock / 1000).toFixed(0)} м</th><th>Объём</th><th>Масса</th><th>Стоимость</th></tr>
      ${b.items.map((i) => `<tr><td>${i.name}</td><td>${i.section}</td><td>${i.count}</td><td>${i.length}</td><td>${i.stockPieces ?? '—'}</td><td>${i.volume ? i.volume.toFixed(3) + ' м³' : '—'}</td><td>${i.mass.toFixed(1)} кг</td><td>${Math.round(i.cost).toLocaleString('ru-RU')} ${b.costs.currency}</td></tr>`).join('')}
      <tr><td colspan="5"><b>Итого</b></td><td><b>${b.timberVolume.toFixed(3)} м³</b></td><td><b>${b.weights.total.toFixed(0)} кг</b></td><td><b>${Math.round(b.costs.total).toLocaleString('ru-RU')} ${b.costs.currency}</b></td></tr></table>
    <p>${b.fasteners.map((x) => `${x.name} — ${x.count} шт, ${x.note}`).join('<br>')}</p>
    ${spliceReportNote(b)}
    <h2>8. Ограничения</h2>
    <p>Расчёт не охватывает: расчёт основания по грунту, касательные силы морозного пучения,
    диагонали в плоскости кровли, огнестойкость, температурные воздействия. Опирание стропил принято шарнирным. Внецентренное сжатие столбов проверено
    с усилением момента по деформированной схеме (консервативнее табличного φ_e прил. Д.3 СП 16).</p>
    <p>Снеговой мешок посчитан по схеме Б.8 приложения Б СП 20.13330.2016: формула (Б.5),
    перечисление «в» для m₂, перечисление «г» с формулой (Б.6) для длины зоны, перечисление «д»
    для потолка μ, перечисление «е» для μ₁, примечание 3 (при h &lt; S₀/2 мешок не учитывается).
    Эпюра — по профилю «в» рисунка Б.11 (навес): линейный спад от μ у стены до μ₁ на длине b.
    Нижнее покрытие рассчитано в двух вариантах загружения, как требует перечисление «а».</p>
    <p>Не реализованы: схемы с продольными фонарями и ступенчатыми перепадами (l′ = l* − 2h′),
    вариант с парапетом на нижнем покрытии проверен не полностью, разрыв между покрытием
    и стенкой перепада (перечисление «ж»). Потолок μ ≤ 8 из онлайн-калькуляторов в СП отсутствует.</p>
    <p>Крепление к газоблоку: расчётное сопротивление кладки принято ориентировочно по СП 15.13330
    (B2,5 → 1,0 МПа) — уточните по данным производителя блоков. Принято, что стеновые столбы опираются
    на собственное основание, а шпильки воспринимают только горизонтальные силы и отрыв; неравномерность
    между шпильками учтена коэффициентом 1,5 на верхнюю. Поперёк ряда горизонтальная сила идёт
    по стропилам к стене, и это проверено: крепление стропил, изгиб обвязки из плоскости, стеновой ряд.
    Вдоль стены стропила держать не могут, и кровля диском не считается: без креста в ряду наружные
    столбы работают консолями.</p>
    <p>Результат — инженерная оценка, а не проект, прошедший экспертизу.</p>`;
}

/* ─────────────────── рендер ─────────────────── */

let hintText = 'Колесо или щипок — масштаб, тянуть фон — сдвиг · стропила и столбы тянутся мышью с шагом 50 мм, с Shift 10 мм · двойной клик — добавить стропило · Del — удалить';

function render(hint) {
  if (hint) hintText = hint;
  const res = analyse(state.model);
  state.result = res;
  const rows = { rafter: res.rafters, post: res.posts, wallPost: res.wallPosts }[state.sel.type];
  if (rows && state.sel.index >= rows.length) state.sel.index = rows.length - 1;
  const bom = billOfMaterials(res);
  syncParams();
  renderCanvas(res);
  renderInspector(res);
  renderWarns(res);
  renderSummary(res);
  renderBom(res, bom);
  renderCost(bom);
  const pill = $('verdict-pill');
  pill.textContent = Number.isFinite(res.maxU)
    ? `макс U = ${f2(res.maxU)} · ${res.maxU > 1 ? 'не проходит' : res.maxU > 0.85 ? 'на пределе' : 'проходит'}`
    : 'расчёт не сошёлся — проверьте данные';
  pill.style.color = uColor(res.maxU);
  pill.style.borderColor = uColor(res.maxU);
  $('hint').textContent = state.view === 'nodes'
    ? 'Чертежи собраны по числам расчёта: крепежей столько, сколько посчитано, шаги и размеры расчётные · клик по детали открывает её проверки справа · меняйте исполнение узлов в блоке «Элементы»'
    : hintText;
  save();
}

/* ─────────────────── события шапки ─────────────────── */

const TABS = [['tab-plan', 'plan'], ['tab-section', 'section'], ['tab-diagrams', 'diagrams'], ['tab-nodes', 'nodes']];
for (const [id, view] of TABS) {
  $(id).addEventListener('click', () => {
    state.view = view;
    for (const [t] of TABS) $(t).setAttribute('aria-pressed', String(t === id));
    render();
  });
}
$('btn-pick-all').addEventListener('click', () => {
  $('btn-pick-all').textContent = 'Считаю…';
  setTimeout(() => {
    const sp = pickRafterSpacing(state.model, 0.9);
    if (sp) state.model.rafters.xs = spread(state.model.geom.B, sp.count);
    const out = pickAll(state.model, 0.9);
    state.model = out.model;
    $('btn-pick-all').textContent = 'Подобрать всё';
    render('Подобрано: ' + out.log.map((l) => `${l.label ?? '—'}`).join(' · ') + (sp ? ` · стропил ${sp.count} шт` : ''));
  }, 10);
});
$('btn-report').addEventListener('click', () => { buildReport(state.result); window.print(); });
$('btn-link').addEventListener('click', async () => {
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    render(`Ссылка на расчёт скопирована · ${url.length} символов`);
  } catch {
    window.prompt('Ссылка на расчёт:', url);
  }
});
/* ─────────────────── тема оформления ─────────────────── */

/**
 * Три положения: «как в системе» (по умолчанию), светлая, тёмная.
 * Палитра целиком на CSS-переменных, поэтому переключение — это один атрибут
 * data-theme на <html>; при «как в системе» атрибута нет и решает
 * prefers-color-scheme. Перерисовывать чертёж не нужно: SVG тоже красится
 * переменными.
 */
const THEME_KEY = 'canopycraft.theme';
const THEMES = [
  { id: 'auto', icon: '◐', label: 'как в системе' },
  { id: 'light', icon: '☀', label: 'светлая' },
  { id: 'dark', icon: '☾', label: 'тёмная' },
];
const readTheme = () => { try { return localStorage.getItem(THEME_KEY) ?? 'auto'; } catch { return 'auto'; } };

function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  if (t.id === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t.id);
  const b = $('btn-theme');
  b.textContent = t.icon;
  b.title = `Тема: ${t.label}. Нажмите, чтобы сменить`;
  b.setAttribute('aria-label', `Тема: ${t.label}`);
}

$('btn-theme').addEventListener('click', () => {
  const next = THEMES[(THEMES.findIndex((x) => x.id === readTheme()) + 1) % THEMES.length];
  try { localStorage.setItem(THEME_KEY, next.id); } catch { /* приватный режим */ }
  applyTheme(next.id);
  render(`Тема: ${next.label}`);
});
applyTheme(readTheme());

/* ─────────────────── фоновая музыка ─────────────────── */

/**
 * Плейлист в случайном порядке, кнопка ♪ рядом с темой и ползунок громкости.
 *
 * Имена файлов заданы списком, а не читаются из папки: статическая страница
 * не может получить её содержимое — на GitHub Pages нет листинга каталога, а
 * при открытии index.html двойным кликом fetch к file:// запрещён вовсе.
 * Поэтому треки называются числами: какие из 1..8 лежат в папке, выясняется
 * при первом включении — недостающие отсеиваются по ошибке загрузки и больше
 * не трогаются. Так файл можно добавить или убрать, не трогая код.
 *
 * preload='none' — ничего не качается, пока не нажали play: у тех, кто музыку
 * не включает, страница не тяжелеет ни на байт. Сам запуск возможен только
 * после действия пользователя (браузеры блокируют автозапуск со звуком),
 * поэтому включённая в прошлый раз музыка подхватывается не при загрузке, а
 * при первом клике или нажатии клавиши.
 */
const AUDIO_DIR = 'assets/audio/';
const AUDIO_FILES = ['1.mp3', '2.mp3', '3.mp3', '4.mp3', '5.mp3', '6.mp3', '7.mp3', '8.mp3'];
const AUDIO_KEY = 'canopycraft.audio';
const AUDIO_DEFAULT = { on: false, vol: 35 };
const readAudio = () => {
  try { return { ...AUDIO_DEFAULT, ...JSON.parse(localStorage.getItem(AUDIO_KEY) ?? '{}') }; }
  catch { return { ...AUDIO_DEFAULT }; }
};
const writeAudio = (v) => { try { localStorage.setItem(AUDIO_KEY, JSON.stringify(v)); } catch { /* приватный режим */ } };

let audioState = readAudio();
let audioTag = null;
let audioPool = [...AUDIO_FILES];   // имена, которые ещё не оказались отсутствующими
let audioQueue = [];                // перемешанный порядок на текущий круг
let audioNow = null;

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Следующий трек: круг в случайном порядке, и он не начинается тем же, чем кончился прошлый. */
function nextTrack() {
  if (!audioQueue.length) {
    audioQueue = shuffle([...audioPool]);
    if (audioQueue.length > 1 && audioQueue[0] === audioNow) audioQueue.push(audioQueue.shift());
  }
  audioNow = audioQueue.shift();
  return audioNow;
}

function audioTagOf() {
  if (!audioTag) {
    audioTag = new Audio();
    audioTag.preload = 'none';
    // трек кончился — сразу следующий; файла нет — вычёркиваем и берём следующий
    audioTag.addEventListener('ended', () => { if (audioState.on) playAudio(); });
    audioTag.addEventListener('error', () => {
      if (!audioState.on) return;
      audioPool = audioPool.filter((n) => n !== audioNow);
      audioQueue = audioQueue.filter((n) => n !== audioNow);
      if (audioPool.length) { playAudio(); return; }
      audioState = { ...audioState, on: false };
      writeAudio(audioState);
      paintAudio();
      render(`Музыки нет. Положите файлы ${AUDIO_DIR}1.mp3, 2.mp3 … (до 8) в репозиторий рядом с index.html`);
    });
  }
  return audioTag;
}

function paintAudio() {
  const b = $('btn-audio');
  const vol = $('audio-vol');
  b.classList.toggle('off', !audioState.on);
  // без числа треков: до первого круга в списке ещё лежат имена, которых в
  // папке нет, и счётчик показывал бы 8 при пяти файлах
  b.title = audioState.on
    ? `Играет ${audioNow ?? '…'}. Нажмите, чтобы выключить`
    : 'Включить фоновую музыку';
  b.setAttribute('aria-pressed', String(audioState.on));
  vol.hidden = !audioState.on;
  vol.value = String(audioState.vol);
  if (audioTag) audioTag.volume = audioState.vol / 100;
}

async function playAudio() {
  const a = audioTagOf();
  a.volume = audioState.vol / 100;
  a.src = AUDIO_DIR + nextTrack();
  try { await a.play(); } catch { /* автозапуск заблокирован — ждём клика */ }
  paintAudio();
}

$('btn-audio').addEventListener('click', () => {
  audioState = { ...audioState, on: !audioState.on };
  writeAudio(audioState);
  paintAudio();
  if (audioState.on) {
    audioPool = audioPool.length ? audioPool : [...AUDIO_FILES];
    audioQueue = [];
    playAudio();
  } else {
    audioTagOf().pause();
  }
});
$('audio-vol').addEventListener('input', (e) => {
  audioState = { ...audioState, vol: Number(e.target.value) };
  writeAudio(audioState);
  if (audioTag) audioTag.volume = audioState.vol / 100;
});
paintAudio();
if (audioState.on) {
  // включена с прошлого раза: браузер даст звук только после действия пользователя
  const resume = () => {
    window.removeEventListener('pointerdown', resume);
    window.removeEventListener('keydown', resume);
    if (audioState.on) playAudio();
  };
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);
}

$('btn-reset').addEventListener('click', () => {
  state.model = defaultModel();
  state.sel = { type: 'rafter', index: 0 };
  resetCostBaseline();
  render('Сброшено к значениям по умолчанию');
});
// открыли ссылку на другой расчёт в той же вкладке
window.addEventListener('hashchange', () => {
  const h = location.hash;
  if (!h.startsWith('#p=')) return;
  if (h.slice(3) === encodeModel(state.model)) return;
  const m = decodeModel(h.slice(3));
  if (!m) return;
  state.model = m;
  resetCostBaseline();
  render(['Загружен расчёт из ссылки.', ...decodeNotes(h.slice(3))].join(' '));
});

function selectWorst(res) {
  state.sel = selectRow(res, res.summary.reduce((a, b) => (a.U > b.U ? a : b)).key);
}

buildParams();
selectWorst(analyse(state.model));
render(upgradeNotes.join(' ') || undefined);
