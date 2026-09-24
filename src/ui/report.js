/**
 * Печатный отчёт: исходные данные, проверки с формулами, спецификация,
 * ограничения. Версия программы и ссылка на расчёт в шапке делают отчёт
 * воспроизводимым. Чистая функция — результат и ссылка на входе, HTML на выходе.
 */
import { billOfMaterials } from '../core/analysis.js';
import { ROOFING, SNOW_REGIONS } from '../core/loads.js';
import { VERSION } from '../core/version.js';
import { f2 } from './views.js';
import { kN } from './format.js';

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

/**
 * Ссылка на расчёт в отчёте: по распечатке вариант открывается снова ровно
 * таким, каким его посчитали. Вместе с версией это делает отчёт воспроизводимым.
 * Открытый двойным кликом файл даёт адрес file://, который у другого человека
 * не откроется, — тогда нужна своя копия калькулятора, о чём и сказано.
 */
function reportLink(url) {
  const local = url.startsWith('file:');
  const safe = url.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return `<p class="report-link">Расчёт по ссылке: <a href="${safe}">${safe}</a>${local
    ? '<br>Ссылка ведёт на файл на этом компьютере. На другом — откройте свою копию калькулятора и замените в адресе всё до «#p=».'
    : ''}</p>`;
}

export function reportHtml(res, url) {
  const m = res.model, b = billOfMaterials(res);
  const el = (x) => `<tr><td>${x.label}</td><td>${x.U > 1 ? 'НЕ ПРОХОДИТ' : 'проходит'}</td><td>${f2(x.U)}</td><td>${x.worst?.name ?? '—'}</td></tr>`;
  const checkRows = (title, checks) => `<h3>${title}</h3><table><tr><th>Проверка</th><th>Условие</th><th>Значение</th><th>Предел</th><th>U</th></tr>` +
    checks.map((c) => `<tr><td>${c.name}</td><td>${c.formula}${c.U === Infinity && c.note ? ` — ${c.note}` : ''}</td><td>${f2(c.value)} ${c.unit}</td><td>${f2(c.limit)} ${c.unit}</td><td>${f2(c.U)}</td></tr>`).join('') + '</table>';
  const worstRafter = res.rafters.reduce((a, c) => (a.U > c.U ? a : c));
  const worstPost = res.posts.reduce((a, c) => (a.U > c.U ? a : c));
  const worstWallPost = res.wallPosts.reduce((a, c) => (a.U > c.U ? a : c));
  const wp = m.wallPosts;
  return `
    <h1>Расчёт навеса, пристроенного к дому</h1>
    <p>Дата: ${new Date().toLocaleDateString('ru-RU')}. CanopyCraft v${VERSION}. Нормы: СП 20.13330.2016, СП 64.13330.2017, СП 16.13330.2017.</p>
    ${reportLink(url)}
    <h2>1. Исходные данные</h2>
    <table>
      <tr><td>Габариты</td><td>${m.geom.B} × ${m.geom.L} мм, свес ${m.geom.a} мм, уклон ${m.geom.alpha}°</td></tr>
      <tr><td>Крепление стропил</td><td>${res.ties.outer.need} × ${res.ties.outer.fastener.short} у прогона, ${res.ties.wall.need} × ${res.ties.wall.fastener.short} у обвязки; шаги S1 ${Math.round(res.ties.outer.spacing.s1)}, S2 ${Math.round(res.ties.outer.spacing.s2)}, S3 ${Math.round(res.ties.outer.spacing.s3)} мм</td></tr>
      <tr><td>Высота столбов</td><td>${m.geom.postHeight} мм; μ наружных ${f2(worstPost.muX)}/${f2(worstPost.muY)}, стеновых ${f2(worstWallPost.muX)}/${f2(worstWallPost.muY)} (поперёк/вдоль ряда)</td></tr>
      <tr><td>Раскрепление наружного ряда</td><td>поперёк ряда верх держат стропила: сила ${kN(res.bracing.holdX)} кН уходит по ним к стене и проверяется в креплении стропил и в обвязке;
        вдоль стены ${res.cross
          ? `крест из диагоналей ${res.cross.sec.label} в ${res.cross.bays.length === 2 ? 'обоих крайних пролётах' : 'крайнем пролёте'}, держит ${kN(res.cross.F)} кН (ветер плюс условная поперечная сила столбов по формуле (18) СП 16)`
          : res.roofBrace
            ? `диагонали ${res.roofBrace.sec.label} в плоскости кровли в крайней ячейке ${Math.round(res.roofBrace.w)} × ${Math.round(res.roofBrace.Lr)} мм, держат ${kN(res.roofBrace.F)} кН и отдают их по обвязке в шпильки у дома; крайние стропила ячейки проверены как стойки фермы`
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
    ${res.roofBrace ? checkRows(`Связи в плоскости кровли: диагонали ${res.roofBrace.sec.label}`, res.roofBrace.checks) : ''}
    <h2>4. Узлы и фундамент (оценочно)</h2>
    <table>
      <tr><td>Горизонтальный распор на стеновой ряд</td><td>${kN(res.bracing.toWall)} кН: скат ${f2(res.thrust.roof / 1000)} + наружная кромка ${f2(res.thrust.fascia / 1000)} + верх наружного ряда ${kN(res.bracing.holdX)}. Сила тяжести распора не даёт — все опоры вертикальные.</td></tr>
      <tr><td>Одна шпилька</td><td>растяжение ${f2(worstWallPost.bolts.Nbolt / 1000)} кН, срез ${f2(worstWallPost.bolts.Vbolt / 1000)} кН</td></tr>
      <tr><td>Нагрузка на наружный столб</td><td>вниз ${f2(res.foundation.maxDown / 1000)} кН, отрыв ${f2(res.foundation.uplift / 1000)} кН</td></tr>
      <tr><td>Фундамент против отрыва</td><td>удержать ${f2(res.foundation.requiredHold)} кН — это ${Math.round(res.foundation.requiredMassKg)} кг бетона на столб, куб со стороной ≈ ${Math.round(res.foundation.cubeSide)} мм</td></tr>
      <tr><td>Касательные силы пучения</td><td>${(() => {
        const h = res.bases.outer.heave;
        if (h.applies) return `τ_fh·A_fh = ${f2(h.pull / 1000)} кН против F = ${f2(h.F / 1000)} кН (постоянная нагрузка и блок при γ_f = 0,9) плюс трение о талый грунт ${f2(h.Frf / 1000)} кН / 1,1 — ${h.check.U > 1 ? 'не проходит' : 'проходит'} (СП 22, ф. (6.35), (6.38), табл. 6.12; СП 24, п. 7.2.13, табл. 7.3 и 7.6)`;
        if (h.reason === 'replaced') return 'не проверяются: принята засыпка пазух непучинистым грунтом (п. 6.8.12 СП 22)';
        if (h.reason === 'nonHeaving') return 'грунт непучинистый';
        return 'глубина промерзания не задана — не проверено';
      })()}</td></tr>
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
    <p>Расчёт не охватывает: расчёт основания по грунту (несущая способность и осадка), анкерные
    уширения и другие конструктивные меры против пучения, кроме засыпки пазух непучинистым грунтом, диагонали в плоскости кровли, огнестойкость, температурные воздействия. Опирание стропил принято шарнирным. Внецентренное сжатие столбов проверено
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
