/**
 * Поля панели параметров: что показывать, какие значения допустимы, к какой
 * статье справки вести. Только описание — строит панель и пишет в модель
 * app.js (buildParams, syncParams).
 */
import { SECTIONS } from '../core/sections.js';
import { ROOFING, SNOW_REGIONS, WIND_REGIONS } from '../core/loads.js';
import { FASTENERS, BEAM_TIES, POST_BASES, CONCRETE, SOILS, HEAVE_STATES, HEAVE_SURFACES } from '../core/fasteners.js';
import { spread } from '../core/model.js';
import { analyse } from '../core/analysis.js';
import { pickRafterSpacing } from '../core/optimize.js';
import { f2 } from './views.js';
import { kN } from './format.js';

const steelOpts = () => SECTIONS.filter((s) => s.material === 'steel');
/** Диагональ креста — квадратная труба небольшого сечения. */
const braceOpts = () => SECTIONS.filter((s) => s.material === 'steel' && s.h === s.b && s.h <= 80);
const anyOpts = () => SECTIONS;

/**
 * Кнопки «подобрать» у блока фундамента целятся в тот же запас 0,9, что и
 * подбор сечений: needDepth и needSide из расчёта — это ровно единица.
 */
const blockMargin = (mm) => Math.ceil(mm / 0.9 / 50) * 50;

export const CONTROLS = [
  { group: 'Геометрия', open: true },
  { k: 'geom.B', label: 'Ширина навеса', help: 'geometry.html#dims', helpTitle: 'ширина, пролёт и свес', type: 'range', min: 3000, max: 12000, step: 250, unit: 'мм' },
  { k: 'geom.L', label: 'Пролёт до столбов', help: 'geometry.html#dims', helpTitle: 'ширина, пролёт и свес', type: 'range', min: 2000, max: 6500, step: 100, unit: 'мм' },
  { k: 'geom.a', label: 'Свес за столбы', help: 'geometry.html#dims', helpTitle: 'ширина, пролёт и свес', type: 'range', min: 0, max: 2000, step: 50, unit: 'мм' },
  { k: 'geom.alpha', label: 'Уклон', help: 'geometry.html#slope', helpTitle: 'уклон', type: 'range', min: 3, max: 30, step: 1, unit: '°' },
  { k: 'geom.postHeight', label: 'Высота столба', help: 'geometry.html#height', helpTitle: 'высота столба и отметки', type: 'range', min: 1800, max: 4000, step: 50, unit: 'мм' },
  { k: 'geom.driftH', label: 'Перепад до кровли дома', help: 'snow.html', helpTitle: 'снеговой мешок у стены', type: 'range', min: 0, max: 4000, step: 100, unit: 'мм' },

  { group: 'Элементы', open: true },
  { k: '#rafterCount', label: 'Стропил', help: 'geometry.html#spacing', helpTitle: 'число стропил и столбов', type: 'range', min: 3, max: 25, step: 1, unit: 'шт', actions: [
      ['равномерно', (m) => { m.rafters.xs = spread(m.geom.B, m.rafters.xs.length); return 'Стропила распределены равномерно'; }],
      ['подобрать шаг', (m) => {
        const r = pickRafterSpacing(m, 0.9);
        if (!r) return 'Даже при 31 стропиле сечение не проходит — нужно крупнее';
        m.rafters.xs = spread(m.geom.B, r.count);
        return `Шаг ${Math.round(r.step)} мм (${r.count} шт), U = ${f2(r.U)}`;
      }]] },
  { k: 'roofing', label: 'Покрытие', help: 'sections.html#roofing', helpTitle: 'покрытие и обрешётка', type: 'select', options: () => Object.entries(ROOFING).map(([id, v]) => ({ id, label: v.label })) },
  { k: 'rafters.sectionId', label: 'Сечение стропила', help: 'sections.html#sections', helpTitle: 'сечения: доска и труба', type: 'select', options: anyOpts, pick: 'rafters' },
  { k: 'battens.sectionId', label: 'Обрешётка', help: 'sections.html#roofing', helpTitle: 'покрытие и обрешётка', type: 'select', options: anyOpts, pick: 'battens' },
  { k: 'battens.spacing', label: 'Шаг обрешётки', help: 'sections.html#roofing', helpTitle: 'покрытие и обрешётка', type: 'range', min: 200, max: 1200, step: 50, unit: 'мм' },
  { k: 'purlin.sectionId', label: 'Прогон наружный', help: 'sections.html#sections', helpTitle: 'сечения: доска и труба', type: 'select', options: anyOpts, pick: 'purlin' },
  { k: 'rafterTie.id', label: 'Крепление стропила к опоре', type: 'select',
    options: () => FASTENERS.map((f) => ({ id: f.id, label: f.label })),
    note: 'Ветер поднимает лёгкую кровлю, и стропило висит на крепеже. Уголок нужен затем, чтобы усилие пришло на крепёж срезом: на выдёргивание гвозди и саморезы в несущих узлах не работают. Число крепежей считается, проверяется — помещается ли оно по правилам расстановки.' },
  { k: 'purlinTie.id', label: 'Узел «прогон — столб»', type: 'select',
    options: () => BEAM_TIES.map((t) => ({ id: t.id, label: t.label })),
    note: 'Вниз прогон держит само опирание, торец в торец. Узел нужен против ветрового отрыва и горизонтальной силы. Катет шва не может быть больше 1,2 толщины самой тонкой стенки — на трубе 3 мм это 3,6 мм.' },
  { k: '#postCount', label: 'Столбов наружных', help: 'geometry.html#spacing', helpTitle: 'число стропил и столбов', type: 'range', min: 2, max: 9, step: 1, unit: 'шт' },
  { k: 'posts.sectionId', label: 'Сечение наружного столба', help: 'sections.html#sections', helpTitle: 'сечения: доска и труба', type: 'select', options: steelOpts, pick: 'posts' },
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
  { k: 'postBase.surface', label: 'Поверхность блока', help: 'frost.html', helpTitle: 'касательные силы пучения', type: 'select',
    options: () => Object.entries(HEAVE_SURFACES).map(([id, v]) => ({ id, label: v.label })),
    note: 'Коэффициент к силе пучения (прим. 4 к табл. 6.12 СП 22): бетон, залитый прямо в яму, повторяет все неровности стенок, и мёрзлому грунту есть за что держаться.' },
  { k: 'postBase.antiHeave', label: 'Против пучения', help: 'frost.html', helpTitle: 'касательные силы пучения', type: 'select',
    options: () => [
      { id: 'none', label: 'ничего — блок в родном грунте' },
      { id: 'replace', label: 'пазухи засыпаны непучинистым грунтом' }],
    live: (r) => {
      const h = r?.bases?.outer?.heave;
      if (!h) return '';
      if (h.reason === 'noFrost') return 'глубина промерзания не задана — пучение не проверяется';
      if (h.reason === 'nonHeaving') return 'грунт непучинистый — касательных сил нет';
      if (h.reason === 'replaced') return 'проверка касательных сил не применяется: у блока непучинистый грунт';
      return `грунт тянет блок вверх с силой ${f2(h.pull / 1000)} кН, держат ${f2(h.F / 1000)} кН`
        + (h.check.U > 1 ? ` — не проходит в ${Math.round(h.check.U)} раз` : ' — проходит');
    },
    note: 'Засыпка пазух песком средней крупности или ПГС с отводом воды — мера из п. 6.8.12 СП 22: у боковой поверхности блока грунт не пучится. Ширину засыпки и дренаж калькулятор не считает — их конструируют.' },
  { k: 'bracing.along', label: 'Что держит верх ряда вдоль стены', help: 'braces.html', helpTitle: 'раскрепление столбов', type: 'select', options: () => [
      { id: 'none', label: 'ничего — столбы консоли, μ = 2' },
      { id: 'cross', label: 'крест в крайнем пролёте — μ = 1' },
      { id: 'roof', label: 'диагонали в плоскости кровли — μ = 1' }],
    live: (r) => {
      if (!r) return '';
      const along = r.model.bracing?.along;
      if (!r.brace) {
        if (along === 'cross') return 'Крест не поставить: в ряду нужен хотя бы один пролёт';
        if (along === 'roof') return 'Диагонали по кровле не поставить: нужно хотя бы два стропила';
        return `μ вдоль ряда 2,0 — верх свободен, ветер вдоль стены ${kN(r.thrust.alongOuter)} кН идёт в консоли столбов. Поперёк ряда верх держат стропила: μ = 1`;
      }
      const c = r.brace;
      const per = r.cross ? r.cross.bays.length : 1;
      return `μ = 1 в обеих плоскостях. ${r.cross ? 'Крест' : 'Диагонали по кровле'} держат ${kN(c.F)} кН: ветер ${kN(c.wind / per)} + условная сила столбов ${kN(c.qfic / per)} · U ${f2(c.U)}`;
    },
    note: 'μ не выбирается, а следует из того, что держит верх. Поперёк ряда это стропила — распорки до стены; их крепление и обвязка у стены на это усилие проверяются. Вдоль стены стропила на шарнирах держать не могут: без связи столб — консоль, и сечение определяет гибкость. Крест ставится между столбами и добавляет им вертикаль; диагонали по кровле идут от прогона к обвязке и отдают силу в шпильки у дома. Подкос от столба к прогону связью не является.' },
  { k: 'bracing.bays', label: 'Крест в пролётах', help: 'braces.html', helpTitle: 'раскрепление столбов', type: 'select', numeric: true, options: () => [
      { id: '1', label: 'в одном крайнем' },
      { id: '2', label: 'в обоих крайних — усилие делится пополам' }],
    live: (r) => (r?.cross
      ? `пролёт ${Math.round(r.cross.span)} мм, диагонали ${r.cross.count} × ${Math.round(r.cross.length)} мм; столбам пролёта +${kN(r.cross.V)} кН в сжатие и ${kN(r.cross.Vup)} в отрыв`
      : 'только для креста') },
  { k: 'bracing.roofBays', label: 'Ячейка диагоналей по кровле', help: 'braces.html', helpTitle: 'раскрепление столбов', type: 'select', numeric: true, options: () => [
      { id: '1', label: 'один шаг стропил' },
      { id: '2', label: 'два шага стропил' },
      { id: '3', label: 'три шага стропил' }],
    live: (r) => (r?.roofBrace
      ? `ячейка ${Math.round(r.roofBrace.w)} × ${Math.round(r.roofBrace.Lr)} мм: диагональ тянет ${kN(r.roofBrace.T)} кН при силе ${kN(r.roofBrace.F)}, крайним стропилам ±${kN(r.roofBrace.Nchord)} кН`
      : 'только для диагоналей по кровле'),
    note: 'Ячейка узкая и длинная, диагональ почти параллельна стропилам: усилие в ней во столько раз больше силы, во сколько она длиннее ширины ячейки. Шире ячейка — легче диагонали, крепление и крайние стропила.' },
  { k: 'bracing.sectionId', label: 'Сечение диагоналей', help: 'braces.html', helpTitle: 'раскрепление столбов', type: 'select', options: braceOpts, pick: 'bracing',
    live: (r) => (r?.brace
      ? `растяжение ${kN(r.brace.T)} кН · гибкость ${Math.round(r.brace.lambda)} из 400 · U ${f2(r.brace.U)}${r.brace.U > 1 ? ` — не проходит: ${r.brace.worst.name.toLowerCase()}` : ''}`
      : 'связей нет — не используется'),
    note: 'Диагонали работают на растяжение по очереди. К стали привариваются швом по контуру торца: катет не меньше табличного по толщине более толстого элемента и не больше 1,2 толщины более тонкого — стенку 2 мм к столбу 3 мм не приварить. К дереву — болтами М12, не больше четырёх на конец.' },

  { group: 'Крепление к дому' },
  { k: 'wallPurlin.sectionId', label: 'Обвязка поверх столбов', help: 'sections.html#sections', helpTitle: 'сечения: доска и труба', type: 'select', options: anyOpts, pick: 'wallPurlin' },
  { k: 'wallPurlinTie.id', label: 'Узел «обвязка — столб»', type: 'select',
    options: () => BEAM_TIES.map((t) => ({ id: t.id, label: t.label })),
    note: 'К деревянной обвязке не приварить: если выбрана сварка, расчёт всё равно считает болтовой узел и пишет об этом.' },
  { k: '#wallPostCount', label: 'Столбов у стены', help: 'geometry.html#spacing', helpTitle: 'число стропил и столбов', type: 'range', min: 2, max: 9, step: 1, unit: 'шт' },
  { k: 'wallPosts.sectionId', label: 'Сечение стенового столба', help: 'sections.html#sections', helpTitle: 'сечения: доска и труба', type: 'select', options: steelOpts, pick: 'wallPosts',
    note: 'Столб притянут к стене шпильками в нескольких точках по высоте — уехать вбок он не может ни в одной плоскости, поэтому μ = 1. Шпильки на это проверяются.' },
  { k: 'wallPosts.boltCount', label: 'Шпилек на столб', help: 'wall.html#count', helpTitle: 'число, диаметр и класс шпилек', type: 'range', min: 2, max: 6, step: 1, unit: 'шт' },
  { k: 'wallPosts.boltDiameter', label: 'Диаметр шпильки', help: 'wall.html#count', helpTitle: 'число, диаметр и класс шпилек', type: 'select', numeric: true, options: () => [
      { id: '12', label: 'М12' }, { id: '16', label: 'М16' }, { id: '20', label: 'М20' }, { id: '24', label: 'М24' }] },
  { k: 'wallPosts.boltGrade', label: 'Класс прочности шпильки', help: 'wall.html#count', helpTitle: 'число, диаметр и класс шпилек', type: 'select', options: () => [
      { id: '4.8', label: '4.8' }, { id: '5.8', label: '5.8' }, { id: '8.8', label: '8.8' }] },
  { k: 'wallPosts.plateSize', label: 'Шайба-пластина изнутри', help: 'wall.html#plate', helpTitle: 'шайба-пластина', type: 'range', min: 60, max: 250, step: 10, unit: 'мм' },
  { k: 'wallPosts.blockClass', label: 'Класс газоблока', help: 'wall.html#block', helpTitle: 'класс газоблока', type: 'select', options: () => [
      { id: 'B2.0', label: 'B2,0 (D400) — R 0,85 МПа' },
      { id: 'B2.5', label: 'B2,5 (D500) — R 1,0 МПа' },
      { id: 'B3.5', label: 'B3,5 (D600) — R 1,3 МПа' },
      { id: 'B5.0', label: 'B5,0 (D700) — R 1,7 МПа' }] },
  { k: 'wallPosts.wallThickness', label: 'Толщина стены', help: 'wall.html#count', helpTitle: 'толщина стены', type: 'range', min: 200, max: 500, step: 25, unit: 'мм' },
  { k: 'opts.postEccentricity', label: 'Эксцентриситет опирания на столб', help: 'wall.html#ecc', helpTitle: 'эксцентриситет опирания', type: 'range', min: 0, max: 120, step: 5, unit: 'мм' },

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
  { k: 'site.soilState', label: 'Состояние пучинистого грунта', help: 'frost.html', helpTitle: 'касательные силы пучения', type: 'select',
    options: () => Object.entries(HEAVE_STATES).map(([id, v]) => ({ id, label: `${v.label} — τ ${v.tau[0]} кПа` })),
    note: 'Строка табл. 6.12 СП 22: чем влажнее и мягче грунт, тем сильнее он тянет блок за бока. I_L — показатель текучести глинистого грунта, S_r — степень влажности песка; без изысканий берите первую строку, по ней же считается обратная засыпка.' },
  { k: 'site.geoCat1', label: 'Геотехническая категория 1 (τ × 0,9)', help: 'frost.html', helpTitle: 'касательные силы пучения', type: 'check' },
  { k: 'site.drift', label: 'Снеговой мешок у стены дома', help: 'snow.html', helpTitle: 'снеговой мешок у стены', type: 'check' },
  { k: 'site.houseRoofLength', label: 'Длина ската дома l₁', help: 'snow.html', helpTitle: 'снеговой мешок у стены', type: 'range', min: 0, max: 30000, step: 500, unit: 'мм' },
  { k: 'site.houseRoofSlope', label: 'Уклон кровли дома α', help: 'snow.html', helpTitle: 'снеговой мешок у стены', type: 'range', min: 0, max: 45, step: 1, unit: '°' },
  { k: 'site.crossSlope', label: 'Поперечный уклон навеса φ', help: 'snow.html', helpTitle: 'снеговой мешок у стены', type: 'range', min: 0, max: 30, step: 1, unit: '°' },
  { k: 'site.reverseSlope', label: 'Уклон навеса к стене (обратный, k₂ = 1)', help: 'snow.html', helpTitle: 'снеговой мешок у стены', type: 'check' },
  { k: 'site.parapet', label: 'Сплошной парапет у перепада (m₁ = 0)', help: 'snow.html', helpTitle: 'снеговой мешок у стены', type: 'check' },

  { group: 'Материалы', side: 'right' },
  { k: 'opts.timber.grade', label: 'Сорт сосны', help: 'sections.html#grade', helpTitle: 'сорт сосны', type: 'select', numeric: true,
    options: () => [{ id: '1', label: '1 сорт' }, { id: '2', label: '2 сорт' }, { id: '3', label: '3 сорт' }] },
  { k: 'opts.timber.serviceClass', label: 'Условия эксплуатации', help: 'sections.html#service', helpTitle: 'условия эксплуатации', type: 'select', numeric: true,
    options: () => [{ id: '2', label: '2 — под навесом, m_в = 1,0' }, { id: '3', label: '3 — открытый воздух, m_в = 0,9' }, { id: '4', label: '4 — влажная среда, m_в = 0,85' }] },
  { k: 'opts.steel.grade', label: 'Сталь', help: 'sections.html#steel', helpTitle: 'сталь', type: 'select',
    options: () => [{ id: 'C245', label: 'С245 — R_y 240 МПа' }, { id: 'C255', label: 'С255 — R_y 240 МПа' }, { id: 'C345', label: 'С345 — R_y 315 МПа' }] },
  { k: 'opts.concreteClass', label: 'Бетон фундамента', help: 'sections.html#concrete', helpTitle: 'бетон фундамента', type: 'select',
    options: () => Object.keys(CONCRETE).map((id) => ({ id, label: `${id} — R_b ${String(CONCRETE[id].Rb).replace('.', ',')} МПа` })) },
  { k: 'opts.stockLength', label: 'Стандартная длина в продаже', help: 'sections.html#stock', helpTitle: 'длина хлыста и стыки', type: 'select', numeric: true,
    options: () => [{ id: '4000', label: '4 м' }, { id: '6000', label: '6 м' }, { id: '12000', label: '12 м' }] },
  { k: 'opts.spliceJoint', label: 'Стык по длине', help: 'sections.html#stock', helpTitle: 'длина хлыста и стыки', type: 'select',
    options: () => [
      { id: 'butt', label: 'встык — момент не передаётся' },
      { id: 'plate', label: 'накладка — сечение восстановлено' },
    ],
    note: 'Что делать, когда элемент длиннее хлыста. Простой стык встык работает шарниром: опорный момент в нём исчезает, а пролётные растут. Накладка с восстановлением сечения оставляет балку неразрезной — но её саму расчёт пока не проверяет, это на вас.' },

  { group: 'Цены — подставьте свои', side: 'right' },
  { k: 'prices.timberM3', label: 'Доска обрезная, ₽/м³', help: 'cost.html', helpTitle: 'подбор по цене', type: 'number', min: 0, step: 500 },
  { k: 'prices.steelKg', label: 'Профильная труба, ₽/кг', help: 'cost.html', helpTitle: 'подбор по цене', type: 'number', min: 0, step: 5 },
  { k: 'prices.roofingM2', label: 'Кровля, ₽/м²', help: 'cost.html', helpTitle: 'подбор по цене', type: 'number', min: 0, step: 50 },
  { k: 'prices.fastenerPc', label: 'Комплект шпилька+пластина, ₽/шт', help: 'cost.html', helpTitle: 'подбор по цене', type: 'number', min: 0, step: 10 },
  { k: 'prices.anglePc', label: 'Уголок крепёжный, ₽/шт', help: 'cost.html', helpTitle: 'подбор по цене', type: 'number', min: 0, step: 10 },
];
