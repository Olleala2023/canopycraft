import { defaultModel, spread } from '../core/model.js';
import { analyse, billOfMaterials } from '../core/analysis.js';
import { SECTIONS, section } from '../core/sections.js';
import { ROOFING, SNOW_REGIONS, WIND_REGIONS } from '../core/loads.js';
import { pickSection, pickRafterSpacing, pickAll } from '../core/optimize.js';
import { drawPlan, drawSection, drawDiagrams, pickElement, uColor, f2 } from './views.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'canopycraft.model.v2';

const state = {
  model: load() ?? defaultModel(),
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
    return m && m.geom && m.wallPosts && m.wallPurlin ? m : null;
  } catch { return null; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.model)); } catch { /* приватный режим */ }
}

/* ─────────────────── панель параметров ─────────────────── */

const timberOpts = () => SECTIONS.filter((s) => s.material === 'timber');
const steelOpts = () => SECTIONS.filter((s) => s.material === 'steel');
const anyOpts = () => SECTIONS;

const CONTROLS = [
  { group: 'Геометрия' },
  { k: 'geom.B', label: 'Ширина навеса', type: 'range', min: 3000, max: 12000, step: 250, unit: 'мм' },
  { k: 'geom.L', label: 'Пролёт до столбов', type: 'range', min: 2000, max: 6500, step: 100, unit: 'мм' },
  { k: 'geom.a', label: 'Свес за столбы', type: 'range', min: 0, max: 2000, step: 50, unit: 'мм' },
  { k: 'geom.alpha', label: 'Уклон', type: 'range', min: 3, max: 30, step: 1, unit: '°' },
  { k: 'geom.postHeight', label: 'Высота столба', type: 'range', min: 1800, max: 4000, step: 50, unit: 'мм' },
  { k: 'geom.driftH', label: 'Перепад до кровли дома', type: 'range', min: 0, max: 4000, step: 100, unit: 'мм' },

  { group: 'Элементы' },
  { k: '#rafterCount', label: 'Стропил', type: 'range', min: 3, max: 25, step: 1, unit: 'шт', actions: [
      ['равномерно', (m) => { m.rafters.xs = spread(m.geom.B, m.rafters.xs.length); return 'Стропила распределены равномерно'; }],
      ['подобрать шаг', (m) => {
        const r = pickRafterSpacing(m, 0.9);
        if (!r) return 'Даже при 31 стропиле сечение не проходит — нужно крупнее';
        m.rafters.xs = spread(m.geom.B, r.count);
        return `Шаг ${Math.round(r.step)} мм (${r.count} шт), U = ${f2(r.U)}`;
      }]] },
  { k: 'rafters.sectionId', label: 'Сечение стропила', type: 'select', options: anyOpts, pick: 'rafters' },
  { k: 'battens.sectionId', label: 'Обрешётка', type: 'select', options: anyOpts, pick: 'battens' },
  { k: 'battens.spacing', label: 'Шаг обрешётки', type: 'range', min: 200, max: 1200, step: 50, unit: 'мм' },
  { k: 'purlin.sectionId', label: 'Прогон наружный', type: 'select', options: anyOpts, pick: 'purlin' },
  { k: '#postCount', label: 'Столбов наружных', type: 'range', min: 2, max: 9, step: 1, unit: 'шт' },
  { k: 'posts.sectionId', label: 'Сечение наружного столба', type: 'select', options: steelOpts, pick: 'posts' },
  { k: 'posts.mu', label: 'μ наружного столба', type: 'select', options: () => [
      { id: '2', label: '2,0 — защемлён внизу, свободен вверху' },
      { id: '1', label: '1,0 — есть связи в обе стороны' },
      { id: '0.7', label: '0,7 — защемление + шарнир' }], numeric: true },

  { group: 'Крепление к дому' },
  { k: 'wallPurlin.sectionId', label: 'Обвязка поверх столбов', type: 'select', options: anyOpts, pick: 'wallPurlin' },
  { k: '#wallPostCount', label: 'Столбов у стены', type: 'range', min: 2, max: 9, step: 1, unit: 'шт' },
  { k: 'wallPosts.sectionId', label: 'Сечение стенового столба', type: 'select', options: steelOpts, pick: 'wallPosts' },
  { k: 'wallPosts.mu', label: 'μ стенового столба', type: 'select', numeric: true, options: () => [
      { id: '1', label: '1,0 — раскреплён стеной' },
      { id: '0.7', label: '0,7 — жёсткая заделка внизу' },
      { id: '2', label: '2,0 — крепление к стене не учитывать' }] },
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

  { group: 'Площадка и кровля' },
  { k: 'roofing', label: 'Покрытие', type: 'select', options: () => Object.entries(ROOFING).map(([id, v]) => ({ id, label: v.label })) },
  { k: 'site.snowRegion', label: 'Снеговой район', type: 'select', options: () => Object.entries(SNOW_REGIONS).map(([id, v]) => ({ id, label: `${id} — ${String(v).replace('.', ',')} кПа` })) },
  { k: 'site.windRegion', label: 'Ветровой район', type: 'select', options: () => Object.entries(WIND_REGIONS).map(([id, v]) => ({ id, label: `${id} — ${String(v).replace('.', ',')} кПа` })) },
  { k: 'site.terrain', label: 'Тип местности', type: 'select', options: () => [
      { id: 'A', label: 'A — открытая' }, { id: 'B', label: 'B — пригород, лес' }, { id: 'C', label: 'C — плотная застройка' }] },
  { k: 'site.drift', label: 'Снеговой мешок у стены дома', type: 'check' },

  { group: 'Материалы' },
  { k: 'opts.timber.grade', label: 'Сорт сосны', type: 'select', numeric: true,
    options: () => [{ id: '1', label: '1 сорт' }, { id: '2', label: '2 сорт' }, { id: '3', label: '3 сорт' }] },
  { k: 'opts.timber.serviceClass', label: 'Условия эксплуатации', type: 'select', numeric: true,
    options: () => [{ id: '2', label: '2 — под навесом, m_в = 1,0' }, { id: '3', label: '3 — открытый воздух, m_в = 0,9' }, { id: '4', label: '4 — влажная среда, m_в = 0,85' }] },
  { k: 'opts.stockLength', label: 'Стандартная длина в продаже', type: 'select', numeric: true,
    options: () => [{ id: '4000', label: '4 м' }, { id: '6000', label: '6 м' }, { id: '12000', label: '12 м' }] },
  { k: 'opts.steel.grade', label: 'Сталь', type: 'select',
    options: () => [{ id: 'C245', label: 'С245 — R_y 240 МПа' }, { id: 'C255', label: 'С255 — R_y 240 МПа' }, { id: 'C345', label: 'С345 — R_y 315 МПа' }] },
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

function buildParams() {
  const host = $('params');
  host.innerHTML = '';
  for (const c of CONTROLS) {
    if (c.group) {
      const t = document.createElement('div');
      t.className = 'pane-title';
      t.textContent = c.group;
      host.appendChild(t);
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const id = 'c_' + c.k.replace(/[.#]/g, '_');
    if (c.type === 'check') {
      wrap.innerHTML = `<label class="check" for="${id}"><input type="checkbox" id="${id}"><span>${c.label}</span></label>`;
    } else if (c.type === 'range') {
      const acts = (c.actions ?? []).map((a, i) => `<button class="btn" data-act="${c.k}:${i}" style="padding:0 6px;font-size:11px">${a[0]}</button>`).join(' ');
      wrap.innerHTML = `<label for="${id}">${c.label} <b data-val="${id}"></b></label><input type="range" id="${id}" min="${c.min}" max="${c.max}" step="${c.step}">${acts ? `<div style="display:flex;gap:5px;margin-top:3px">${acts}</div>` : ''}`;
    } else {
      const opts = c.options().map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
      wrap.innerHTML = `<label for="${id}">${c.label}${c.pick ? ` <button class="btn" data-pick-el="${c.pick}" style="padding:0 6px;font-size:11px">подобрать</button>` : ''}</label><select id="${id}">${opts}</select>`;
    }
    host.appendChild(wrap);
    const input = wrap.querySelector('input,select');
    input.addEventListener('input', () => {
      let v = c.type === 'check' ? input.checked : input.value;
      if (c.type === 'range' || c.numeric) v = Number(v);
      writeVirtual(c.k, v);
      if (c.k === 'geom.B') {
        state.model.rafters.xs = spread(state.model.geom.B, state.model.rafters.xs.length);
        state.model.posts.xs = spread(state.model.geom.B, state.model.posts.xs.length);
        state.model.wallPosts.xs = spread(state.model.geom.B, state.model.wallPosts.xs.length);
      }
      render();
    });
  }
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

function syncParams() {
  for (const c of CONTROLS) {
    if (c.group) continue;
    const id = 'c_' + c.k.replace(/[.#]/g, '_');
    const el = $(id);
    if (!el) continue;
    const v = readVirtual(c.k);
    if (c.type === 'check') el.checked = !!v;
    else el.value = String(v);
    const b = document.querySelector(`[data-val="${id}"]`);
    if (b) {
      let extra = '';
      if (c.k === '#rafterCount') extra = ` · шаг ${Math.round(state.model.geom.B / (v - 1))}`;
      if (c.k === '#postCount' || c.k === '#wallPostCount') extra = ` · пролёт ${Math.round(state.model.geom.B / (v - 1))}`;
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
  const v = el.U > 1
    ? `<b>Не проходит.</b> Определяет «${el.worst.name}» — ${f2(el.U)}.`
    : el.U > 0.85 ? `<b>На пределе.</b> Определяет «${el.worst.name}» — ${f2(el.U)}.`
    : el.U < 0.4 ? `<b>Большой запас.</b> Можно уменьшить сечение или увеличить шаг.`
    : `<b>Проходит.</b> Определяет «${el.worst.name}» — ${f2(el.U)}.`;
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
    kv.push(['M', `${f2(el.M / 1e6)} кН·м`]);
    kv.push(['Отрыв', `${f2(Math.max(0, el.Nup) / 1000)} кН`]);
    kv.push(['Расчётная длина', `${Math.round(el.lef)} мм`]);
    if (el.bolts) {
      kv.push(['Горизонт. распор на столб', `${f2(el.Hpost / 1000)} кН`]);
      kv.push(['Шпилек', `${el.bolts.count} × М${res.model.wallPosts.boltDiameter}`]);
      kv.push(['На шпильку: растяжение', `${f2(el.bolts.Nbolt / 1000)} кН`]);
      kv.push(['На шпильку: срез', `${f2(el.bolts.Vbolt / 1000)} кН`]);
    }
  } else if (el.res?.uls) {
    kv.push(['M max', `${f2(Math.abs(el.res.uls.maxM) / 1e6)} кН·м`]);
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
};
const ROW_OF = { rafters: ['rafters', 'rafter'], posts: ['posts', 'post'], wallPosts: ['wallPosts', 'wallPost'] };
function selectRow(res, key) {
  const row = ROW_OF[key];
  if (!row) return { ...SEL_FOR[key] };
  const list = res[row[0]];
  const i = list.reduce((bi, e, idx) => (e.U > list[bi].U ? idx : bi), 0);
  return { type: row[1], index: i };
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

function renderBom(res) {
  const b = billOfMaterials(res);
  const rows = b.items.map((i) => `<tr><td>${i.name}</td><td>${i.section}</td><td>${i.material}</td>
    <td class="n">${i.count}</td><td class="n">${i.length}</td><td class="n">${i.totalLength.toFixed(1)}</td>
    <td class="n">${i.stockPieces ?? '—'}</td><td class="n">${i.volume ? i.volume.toFixed(3) + ' м³' : i.mass.toFixed(0) + ' кг'}</td></tr>`).join('');
  const fast = b.fasteners.map((f) => `<div class="kv"><span>${f.name} — ${f.count} шт</span><span>${f.note}</span></div>`).join('');
  $('bom').innerHTML = `<div class="pane-title">Спецификация · закупка хлыстами по ${(b.stock / 1000).toFixed(0)} м</div>
    <div class="tbl"><table>
    <tr><th>Элемент</th><th>Сечение</th><th>Материал</th><th>Шт</th><th>Длина, мм</th><th>Всего, м</th><th>Купить, хлыстов</th><th>Объём / масса</th></tr>
    ${rows}
    <tr><td colspan="7"><b>Итого</b></td><td class="n"><b>${b.timberVolume.toFixed(3)} м³ · ${b.steelMass.toFixed(0)} кг</b></td></tr></table></div>
    ${fast}
    <div class="kv"><span>Ветровой распор на стеновой ряд</span><span>${f2(res.thrust.total / 1000)} кН (скат ${f2(res.thrust.roof / 1000)} + кромка ${f2(res.thrust.fascia / 1000)})</span></div>
    <div class="kv"><span>Наружный столб: вниз / отрыв</span><span>${f2(res.foundation.maxDown / 1000)} кН / ${f2(res.foundation.uplift / 1000)} кН → фундамент ≥ ${Math.round(res.foundation.cubeSide)} мм куб</span></div>`;
}

/* ─────────────────── сцена и перетаскивание ─────────────────── */

function renderCanvas(res) {
  const draw = state.view === 'plan' ? drawPlan : state.view === 'section' ? drawSection : drawDiagrams;
  const out = draw(res, state.sel);
  $('canvas').innerHTML = out.svg;
  state.meta = out.meta;
  if (state.view === 'plan') wirePlan(res);
}

function wirePlan(res) {
  const svg = $('canvas').querySelector('svg');
  const meta = state.meta;
  const toMm = (clientX) => {
    const r = svg.getBoundingClientRect();
    return (((clientX - r.left) / r.width) * meta.vw - meta.ox) / meta.sc;
  };
  let drag = null;
  svg.querySelectorAll('[data-pick]').forEach((g) => {
    g.addEventListener('pointerdown', (e) => {
      const type = g.getAttribute('data-pick');
      const index = Number(g.getAttribute('data-index'));
      state.sel = type === 'purlin' ? { type: 'purlin' } : { type, index };
      renderInspector(res);
      if (type === 'purlin') { render(); return; }
      drag = { type, index, moved: false };
      g.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    g.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const B = state.model.geom.B;
      let x = Math.round(toMm(e.clientX) / 50) * 50;
      x = Math.max(0, Math.min(B, x));
      const arr = drag.type === 'rafter' ? state.model.rafters.xs : state.model.posts.xs;
      if (arr[drag.index] === x) return;
      arr[drag.index] = x;
      arr.sort((a, b) => a - b);
      drag.index = arr.indexOf(x);
      state.sel = { type: drag.type, index: drag.index };
      drag.moved = true;
      render(`${drag.type === 'rafter' ? 'Стропило' : 'Столб'} ${drag.index + 1} → ${x} мм`);
    });
    const end = () => { if (drag) { drag = null; save(); } };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
  });
  svg.addEventListener('dblclick', (e) => {
    const x = Math.max(0, Math.min(state.model.geom.B, Math.round(toMm(e.clientX) / 50) * 50));
    state.model.rafters.xs.push(x);
    state.model.rafters.xs.sort((a, b) => a - b);
    state.sel = { type: 'rafter', index: state.model.rafters.xs.indexOf(x) };
    render(`Добавлено стропило на ${x} мм`);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.sel.type === 'rafter' && state.model.rafters.xs.length > 3) {
      state.model.rafters.xs.splice(state.sel.index, 1);
      state.sel.index = Math.max(0, state.sel.index - 1);
      render('Стропило удалено');
    } else if (state.sel.type === 'post' && state.model.posts.xs.length > 2) {
      state.model.posts.xs.splice(state.sel.index, 1);
      state.sel.index = Math.max(0, state.sel.index - 1);
      render('Столб удалён');
    }
  }
});

/* ─────────────────── отчёт ─────────────────── */

function buildReport(res) {
  const m = res.model, b = billOfMaterials(res);
  const el = (x) => `<tr><td>${x.label}</td><td>${x.U > 1 ? 'НЕ ПРОХОДИТ' : 'проходит'}</td><td>${f2(x.U)}</td><td>${x.worst?.name ?? ''}</td></tr>`;
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
      <tr><td>Высота столбов</td><td>${m.geom.postHeight} мм; μ наружных ${m.posts.mu}, стеновых ${wp.mu}</td></tr>
      <tr><td>Крепление к дому</td><td>${wp.xs.length} стальных столба ${worstWallPost.sec.label}, притянуты сквозными шпильками М${wp.boltDiameter} класса ${wp.boltGrade} по ${wp.boltCount} шт на столб через стену из газоблока ${wp.blockClass} толщиной ${wp.wallThickness} мм; шайба-пластина ${wp.plateSize}×${wp.plateSize} мм с внутренней стороны. Поверх столбов — обвязка ${res.wallPurlin.sec.label}, по ней идут стропила.</td></tr>
      <tr><td>Покрытие</td><td>${ROOFING[m.roofing].label}</td></tr>
      <tr><td>Снеговой район</td><td>${m.site.snowRegion}, S_g = ${SNOW_REGIONS[m.site.snowRegion]} кПа</td></tr>
      <tr><td>Ветровой район</td><td>${m.site.windRegion}, местность ${m.site.terrain}</td></tr>
      <tr><td>Снеговой мешок</td><td>${m.site.drift ? `перепад ${m.geom.driftH} мм, μ = ${f2(res.snow.muWall)}, зона ${res.snow.driftLength} мм` : 'не учитывается'}</td></tr>
      <tr><td>Материалы</td><td>сосна ${m.opts.timber.grade} сорт, класс эксплуатации ${m.opts.timber.serviceClass}; сталь ${m.opts.steel.grade}</td></tr>
    </table>
    <h2>2. Нагрузки</h2>
    <table>
      <tr><td>Собственный вес кровли и обрешётки</td><td>${f2(res.dead.total)} кН/м² по скату</td></tr>
      <tr><td>Снег у стены / в поле (расчётный)</td><td>${f2(res.snow.at(0))} / ${f2(res.snow.at(m.geom.L + m.geom.a))} кПа</td></tr>
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
    <h2>4. Узлы и фундамент (оценочно)</h2>
    <table>
      <tr><td>Горизонтальный распор на стеновой ряд</td><td>${f2(res.thrust.total / 1000)} кН: скат ${f2(res.thrust.roof / 1000)} + наружная кромка ${f2(res.thrust.fascia / 1000)}. Сила тяжести распора не даёт — все опоры вертикальные.</td></tr>
      <tr><td>Одна шпилька</td><td>растяжение ${f2(worstWallPost.bolts.Nbolt / 1000)} кН, срез ${f2(worstWallPost.bolts.Vbolt / 1000)} кН</td></tr>
      <tr><td>Нагрузка на наружный столб</td><td>вниз ${f2(res.foundation.maxDown / 1000)} кН, отрыв ${f2(res.foundation.uplift / 1000)} кН</td></tr>
      <tr><td>Фундамент против отрыва</td><td>масса ≥ ${f2(res.foundation.requiredMass)} кН, куб бетона ≈ ${Math.round(res.foundation.cubeSide)} мм</td></tr>
    </table>
    <h2>5. Спецификация</h2>
    <table><tr><th>Элемент</th><th>Сечение</th><th>Шт</th><th>Длина, мм</th><th>Хлыстов по ${(b.stock / 1000).toFixed(0)} м</th><th>Итого</th></tr>
      ${b.items.map((i) => `<tr><td>${i.name}</td><td>${i.section}</td><td>${i.count}</td><td>${i.length}</td><td>${i.stockPieces ?? '—'}</td><td>${i.volume ? i.volume.toFixed(3) + ' м³' : i.mass.toFixed(0) + ' кг'}</td></tr>`).join('')}
      <tr><td colspan="5"><b>Итого</b></td><td><b>${b.timberVolume.toFixed(3)} м³ сосны, ${b.steelMass.toFixed(0)} кг стали</b></td></tr></table>
    <p>${b.fasteners.map((x) => `${x.name} — ${x.count} шт, ${x.note}`).join('<br>')}</p>
    <h2>6. Ограничения</h2>
    <p>Расчёт не охватывает: сварные швы, расчёт основания по грунту, ветровые связи, огнестойкость,
    температурные воздействия. Опирание стропил принято шарнирным. Внецентренное сжатие столбов проверено
    с усилением момента по деформированной схеме (консервативнее табличного φ_e прил. Д.3 СП 16).</p>
    <p>Крепление к газоблоку: расчётное сопротивление кладки принято ориентировочно по СП 15.13330
    (B2,5 → 1,0 МПа) — уточните по данным производителя блоков. Принято, что стеновые столбы опираются
    на собственное основание, а шпильки воспринимают только горизонтальные силы и отрыв; неравномерность
    между шпильками учтена коэффициентом 1,5 на верхнюю. Принято также, что плоскость кровли
    (обрешётка и крепление стропил к обвязке) передаёт горизонтальный распор на раскреплённый стеновой ряд;
    иначе наружные столбы нужно раскреплять раскосами.</p>
    <p>Результат — инженерная оценка, а не проект, прошедший экспертизу.</p>`;
}

/* ─────────────────── рендер ─────────────────── */

let hintText = 'Тяните стропила и столбы мышью · двойной клик — добавить стропило · Del — удалить · клик по элементу — проверки справа';

function render(hint) {
  if (hint) hintText = hint;
  const res = analyse(state.model);
  state.result = res;
  const n = state.sel.type === 'rafter' ? res.rafters.length : state.sel.type === 'post' ? res.posts.length : 1;
  if (state.sel.index >= n) state.sel.index = n - 1;
  syncParams();
  renderCanvas(res);
  renderInspector(res);
  renderSummary(res);
  renderBom(res);
  const pill = $('verdict-pill');
  pill.textContent = `макс U = ${f2(res.maxU)} · ${res.maxU > 1 ? 'не проходит' : res.maxU > 0.85 ? 'на пределе' : 'проходит'}`;
  pill.style.color = uColor(res.maxU);
  pill.style.borderColor = uColor(res.maxU);
  $('hint').textContent = hintText;
  save();
}

/* ─────────────────── события шапки ─────────────────── */

for (const [id, view] of [['tab-plan', 'plan'], ['tab-section', 'section'], ['tab-diagrams', 'diagrams']]) {
  $(id).addEventListener('click', () => {
    state.view = view;
    for (const t of ['tab-plan', 'tab-section', 'tab-diagrams']) $(t).setAttribute('aria-pressed', String(t === id));
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
$('btn-json').addEventListener('click', async () => {
  const text = JSON.stringify(state.model, null, 2);
  try { await navigator.clipboard.writeText(text); render('Модель скопирована в буфер обмена'); }
  catch { window.prompt('Скопируйте JSON модели:', text); }
});
$('btn-reset').addEventListener('click', () => { state.model = defaultModel(); state.sel = { type: 'rafter', index: 0 }; render('Сброшено к значениям по умолчанию'); });

function selectWorst(res) {
  state.sel = selectRow(res, res.summary.reduce((a, b) => (a.U > b.U ? a : b)).key);
}

buildParams();
selectWorst(analyse(state.model));
render();
