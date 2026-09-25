import { defaultModel, spread } from '../core/model.js';
import { analyse, billOfMaterials } from '../core/analysis.js';
import { section } from '../core/sections.js';
import { CONCRETE } from '../core/fasteners.js';
import { pickSection, pickRafterSpacing, pickAll } from '../core/optimize.js';
import { searchByCost } from '../core/search.js';
import { encodeModel, decodeModel, decodeNotes, upgradeModel } from '../core/share.js';
import { VERSION } from '../core/version.js';
import { drawPlan, drawSection, drawDiagrams, drawNodes, pickElement, uColor, f2 } from './views.js';
import { $ } from './dom.js';
import { kN, plural } from './format.js';
import { CONTROLS } from './controls.js';
import { warningsHtml } from './warnings.js';
import { reportHtml } from './report.js';
import { initTheme } from './theme.js';
import { initAudio } from './audio.js';
import { initTip, tipButton } from './tip.js';
import { createHistory } from './history.js';
import { create3D } from './view3d.js';
import { drawFacade } from './facade.js';
import { openingsRows, openingsShape, applyOpeningInput, newOpening } from './openings.js';

$('app-version').textContent = `v${VERSION}`;
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

/** «Отменить» и «Вернуть»: снимки модели после каждой перерисовки (см. history.js). */
const undoLog = createHistory();

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
/** Кнопка «?» у поля: пояснение и ссылка на статью — в карточке (tip.js). */
const helpLink = (c) => (c.help || c.note ? ` ${tipButton(c.k, c.label)}` : '');

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
      wrap.innerHTML = `<label for="${id}">${c.label}${helpLink(c)}</label><input type="number" id="${id}" min="${c.min ?? 0}" step="${c.step ?? 1}" inputmode="numeric">`;
    } else if (c.type === 'openings') {
      wrap.innerHTML = `<span class="field-label">${c.label}${helpLink(c)}</span><div class="ops" id="${id}"></div>`
        + '<div style="display:flex;gap:5px;margin-top:4px"><button type="button" class="btn" data-op-add="window" style="padding:0 6px;font-size:11px">+ окно</button> '
        + '<button type="button" class="btn" data-op-add="door" style="padding:0 6px;font-size:11px">+ дверь</button></div>';
      body.appendChild(wrap);
      wireOpenings(wrap, wrap.querySelector('.ops'));
      continue;
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

/**
 * Окна и двери: список правится на месте, перерисовка — как у любого поля.
 * Строки строятся заново, только когда проёмы добавили, убрали или сменили
 * вид, — иначе поле, в котором сейчас печатают, потеряло бы фокус.
 */
function wireOpenings(wrap, box) {
  const list = () => state.model.house.openings;
  box.addEventListener('input', (e) => {
    if (e.target.matches('[data-op]') && applyOpeningInput(list(), e.target)) render();
  });
  wrap.addEventListener('click', (e) => {
    const add = e.target.closest('[data-op-add]');
    const del = e.target.closest('[data-op-del]');
    if (add) list().push(newOpening(add.getAttribute('data-op-add'), state.model));
    else if (del) list().splice(Number(del.getAttribute('data-op-del')), 1);
    else return;
    e.preventDefault();
    render(add ? 'Проём добавлен — задайте его размеры и положение' : 'Проём убран');
  });
}

function syncOpenings(box) {
  const list = state.model.house.openings;
  const shape = openingsShape(list);
  if (box.dataset.shape !== shape || !box.childElementCount) {
    box.innerHTML = openingsRows(list);
    box.dataset.shape = shape;
    return;
  }
  box.querySelectorAll('input[data-op]').forEach((el) => {
    const v = list[Number(el.getAttribute('data-op'))]?.[el.getAttribute('data-f')];
    if (el !== document.activeElement && String(v) !== el.value) el.value = String(v);
  });
}

function syncParams() {
  for (const c of CONTROLS) {
    if (c.group) continue;
    const id = 'c_' + c.k.replace(/[.#]/g, '_');
    const el = $(id);
    if (!el) continue;
    if (c.type === 'openings') { syncOpenings(el); continue; }
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

/** Выбор, для которого инспектор показан сейчас, — чтобы понять, что выбрали другое. */
let inspected = '';

function renderInspector(res) {
  const el = pickElement(res, state.sel);
  const host = $('inspector');
  // выбрали другой элемент — правая колонка прокручивается к его проверкам:
  // она прокручивается сама по себе, и новый инспектор мог оказаться выше края
  const key = JSON.stringify(state.sel);
  if (key !== inspected) { inspected = key; $('side').scrollTop = 0; }
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
  const v = el.worst?.U === Infinity
    ? `<b>Не проходит: ${worstName.toLowerCase()}.</b>${el.worst.note ? ` ${el.worst.note[0].toUpperCase()}${el.worst.note.slice(1)}.` : ''}${el.mechanism
      ? ' Усилия ниже — по неразрезной схеме, какой элемент станет со стыком на накладке: по ним нагрузка передана на опоры.'
      : ''}`
    : !Number.isFinite(el.U)
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
      kv.push(['На шпильку: срез', `${f2(el.bolts.Vbolt / 1000)} кН${el.bolts.slotted ? ' — только вдоль стены: отверстия овальные, отрыв не берут' : ''}`]);
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
  } else if (el.kind === 'roofBrace') {
    kv.push(['Где', `крайняя ячейка ${Math.round(el.w)} × ${Math.round(el.Lr)} мм — ${plural(el.bays, 'шаг', 'шага', 'шагов')} стропил`]);
    kv.push(['Диагонали', `${el.count} × ${el.sec.label}, длина ${Math.round(el.length)} мм`]);
    kv.push(['Держат вдоль стены', `${kN(el.F)} кН = ветер ${kN(el.wind)} + условная сила столбов ${kN(el.qfic)}`]);
    kv.push(['Растяжение диагонали', `${kN(el.T)} кН — в ${f2(el.T / el.F)} раза больше силы`]);
    kv.push(['Крайним стропилам', `±${kN(el.Nchord)} кН продольной силы`]);
    kv.push(['Гибкость', `${Math.round(el.lambda)} из 400`]);
    for (const e of el.ends) {
      kv.push([`Крепление ${e.where}`, e.welded ? `шов по контуру торца, катет ${e.kf} мм` : `${e.n} × М12, болт как нагель ${kN(e.T1)} кН`]);
    }
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
    } else if (el.beside) {
      kv.push(['Блок', `рядом с фундаментом дома, зазор ${el.gap} мм; центр в ${Math.round(el.offset)} мм от оси столба`]);
      kv.push(['Плита-столик', `${el.plate.L}×${el.plate.B}×${el.base.t} мм, столб у края${el.forcedPlate ? ' · вместо заделки' : ''}`]);
      kv.push(['Анкеры', `в ${Math.round(el.plate.uIn)} и ${Math.round(el.plate.uOut)} мм от стены, до грани блока ${Math.round(el.edge)} мм`]);
      kv.push(['На анкер: растяжение', `${f2(el.Na / 1000)} кН — ${el.NaComp >= el.NaUp ? 'при сжатии, дальний ряд' : 'при отрыве, ближний ряд'}`]);
      kv.push(['Шпильки в стену', 'на овальных отверстиях: отрыв держит только блок']);
    } else {
      kv.push(['На анкер: растяжение', `${f2(el.Na / 1000)} кН`]);
      kv.push(['Разнос анкеров', `${el.span} мм · вылет плиты ${Math.round(el.c)} мм`]);
      kv.push(['Под плитой', `${f2(el.sigma)} МПа при R_b ${f2((CONCRETE[el.concrete] ?? CONCRETE.B20).Rb)}`]);
    }
    // блок бетона — общая часть обеих баз: вес против отрыва и как его добрать
    kv.push(['Блок бетона', `${el.side}×${el.side}×${el.depth} мм = ${Math.round(el.mass)} кг`]);
    kv.push(['Нужно против отрыва', `${Math.round(el.needMass)} кг`]);
    if (el.heave?.applies) {
      kv.push(['Пучение: тянет', `${kN(el.heave.pull)} кН — τ_fh ${Math.round(el.heave.tau)} кПа на ${el.heave.A.toFixed(2).replace('.', ',')} м²`]);
      kv.push(['Пучение: держат', `${kN(el.heave.F)} кН — постоянная ${kN(el.heave.Nperm)} и блок ${kN(el.heave.blockWeight)}`]);
    } else if (el.heave?.reason === 'replaced') {
      kv.push(['Пучение', 'пазухи засыпаны непучинистым грунтом — не проверяется']);
    }
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
        <td>${state.model.bracing?.along === 'cross' ? `крест ${o2(state.model.bracing.sectionId)}`
          : state.model.bracing?.along === 'roof' ? `по кровле ${o2(state.model.bracing.sectionId)}` : 'без связей'}</td>
        <td>${o2(state.model.wallPurlin.sectionId)}</td>
        <td>${o2(state.model.wallPosts.sectionId)} × ${state.model.wallPosts.xs.length}</td><td></td></tr>
      ${rows}
    </table></div>
    <div class="row2" style="gap:14px;margin-top:10px">
      <div class="hint" style="border:0;padding:0">
        Перебираются сечения и число стропил, столбов обоих рядов, прогонов и обрешётки,
        а наружный ряд — в трёх схемах: без связей, с крестом в крайнем пролёте и с диагоналями
        в плоскости кровли.
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

/** 3D-вид живёт, пока открыта его вкладка: камера сохраняется между перерисовками. */
let view3d = null;

function renderCanvas(res) {
  if (state.view === '3d') {
    view3d ??= create3D($('canvas'), { onPick: (sel) => { state.sel = sel; render(); } });
    $('canvas').view3d = view3d; // для смоука: где на экране деталь, нарисован ли кадр
    view3d?.update(res, state.sel);
    state.meta = null;
    return;
  }
  if (view3d) { view3d.dispose(); view3d = null; $('canvas').view3d = null; }
  const DRAW = { plan: drawPlan, wall: drawFacade, section: drawSection, diagrams: drawDiagrams, nodes: drawNodes };
  const out = (DRAW[state.view] ?? drawPlan)(res, state.sel);
  $('canvas').innerHTML = out.svg;
  state.meta = out.meta;
  wrapForZoom();
  // фасад привязан по x так же, как план: столбы у стены тянутся и там
  if (state.view === 'plan' || state.view === 'wall') wirePlan();
  if (state.view === 'nodes') wireNodes();
}

/* ─────────────────── масштаб и панорама ─────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
const zoom = { plan: { k: 1, tx: 0, ty: 0 }, wall: { k: 1, tx: 0, ty: 0 }, section: { k: 1, tx: 0, ty: 0 }, diagrams: { k: 1, tx: 0, ty: 0 }, nodes: { k: 1, tx: 0, ty: 0 } };
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
  if (state.view === '3d') return; // камерой 3D управляет сам вид
  e.preventDefault();
  zoomAt(toFrame(e.clientX, e.clientY), e.deltaY < 0 ? 1.18 : 1 / 1.18);
}, { passive: false });

let pan = null;
const pointers = new Map();
let pinch = null;

canvasEl.addEventListener('pointerdown', (e) => {
  if (state.view === '3d') return;
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
  if (state.view === '3d') return;
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

$('zoom-in').addEventListener('click', () => {
  if (view3d) { view3d.zoom(1.4); return; }
  const f = frame(); if (f) zoomAt({ x: f.w / 2, y: f.h / 2 }, 1.4);
});
$('zoom-out').addEventListener('click', () => {
  if (view3d) { view3d.zoom(1 / 1.4); return; }
  const f = frame(); if (f) zoomAt({ x: f.w / 2, y: f.h / 2 }, 1 / 1.4);
});
$('zoom-reset').addEventListener('click', () => {
  if (view3d) { view3d.reset(); return; }
  const z = zv(); z.k = 1; z.tx = 0; z.ty = 0; applyZoom();
});

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

/**
 * Где клавиши принадлежат полю, а не чертежу. В поле ввода Backspace стирает
 * цифру, а Ctrl+Z отменяет набранный текст — перехватывать их нельзя: раньше
 * Backspace в поле заодно удалял выбранное стропило.
 */
const typingIn = (el) => !!el?.closest?.('textarea, select, input:not([type=range]):not([type=checkbox]):not([type=radio])');

document.addEventListener('keydown', (e) => {
  // по физической клавише: в русской раскладке на Z стоит «я»
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyZ' || e.code === 'KeyY')) {
    if (typingIn(e.target)) return;
    e.preventDefault();
    if (e.code === 'KeyY' || e.shiftKey) redoStep(); else undoStep();
    return;
  }
  if (typingIn(e.target)) return;
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

/* ─────────────────── рендер ─────────────────── */

/**
 * Почему максимальный U бесконечен, если причина названа: элемент с проверкой,
 * которой нечего считать (изменяемая схема, накладка не подбирается). Такая
 * проверка ставит U = Infinity явно. NaN от испорченных данных worstOf тоже
 * превращает в бесконечность, но у худшей проверки U остаётся NaN — тогда
 * причины нет, и честнее сказать «расчёт не сошёлся».
 */
function infiniteCause(res) {
  const bad = res.summary.filter((s) => !Number.isFinite(s.U));
  if (!bad.length || bad.some((s) => s.worst?.U !== Infinity)) return null;
  return `${bad[0].label.toLowerCase()}: ${bad[0].worst.name.toLowerCase()}`;
}

let hintText = 'Колесо или щипок — масштаб, тянуть фон — сдвиг · стропила и столбы тянутся мышью с шагом 50 мм, с Shift 10 мм · двойной клик — добавить стропило · Del — удалить · Ctrl+Z — отменить, Ctrl+Y — вернуть';

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
  $('warns').innerHTML = warningsHtml(res);
  renderSummary(res);
  renderBom(res, bom);
  renderCost(bom);
  const pill = $('verdict-pill');
  const cause = infiniteCause(res);
  pill.textContent = Number.isFinite(res.maxU)
    ? `макс U = ${f2(res.maxU)} · ${res.maxU > 1 ? 'не проходит' : res.maxU > 0.85 ? 'на пределе' : 'проходит'}`
    : cause ? `U = ∞ · ${cause}` : 'расчёт не сошёлся — проверьте данные';
  pill.style.color = uColor(res.maxU);
  pill.style.borderColor = uColor(res.maxU);
  $('hint').textContent = state.view === '3d'
    ? 'Тянуть — вращать · колесо или щипок — ближе и дальше · правой кнопкой или двумя пальцами — сдвиг · клик по детали открывает её проверки справа · ⌂ — вернуть вид · цвет — коэффициент U'
    : state.view === 'wall'
    ? 'Стена дома со двора: окна, двери, столбы у стены со шпильками и обвязка · столбы тянутся мышью, как на плане, Shift — точнее · цепочка снизу — привязки от угла до откосов и осей столбов · проёмы задаются в блоке «Стена дома»'
    : state.view === 'nodes'
    ? 'Чертежи собраны по числам расчёта: крепежей столько, сколько посчитано, шаги и размеры расчётные · клик по детали открывает её проверки справа · меняйте исполнение узлов в блоке «Элементы»'
    : hintText;
  save();
  undoLog.record(state.model);
  paintUndo();
}

function paintUndo() {
  $('btn-undo').disabled = !undoLog.canUndo;
  $('btn-redo').disabled = !undoLog.canRedo;
}

function undoStep() {
  const m = undoLog.undo();
  if (!m) return;
  state.model = m;
  render(undoLog.canUndo ? 'Отменено · Ctrl+Z — ещё, Ctrl+Y — вернуть' : 'Отменено до начала · Ctrl+Y — вернуть');
}

function redoStep() {
  const m = undoLog.redo();
  if (!m) return;
  state.model = m;
  render('Возвращено · Ctrl+Z — снова отменить');
}

$('btn-undo').addEventListener('click', undoStep);
$('btn-redo').addEventListener('click', redoStep);

/* ─────────────────── события шапки ─────────────────── */

const TABS = [['tab-plan', 'plan'], ['tab-wall', 'wall'], ['tab-section', 'section'], ['tab-diagrams', 'diagrams'], ['tab-nodes', 'nodes'], ['tab-3d', '3d']];
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
$('btn-report').addEventListener('click', () => {
  $('report').innerHTML = reportHtml(state.result, shareUrl());
  window.print();
});
$('btn-link').addEventListener('click', async () => {
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    render(`Ссылка на расчёт скопирована · ${url.length} символов`);
  } catch {
    window.prompt('Ссылка на расчёт:', url);
  }
});

initTheme((label) => render(`Тема: ${label}`));
initTip((key) => {
  const c = CONTROLS.find((x) => x.k === key);
  return c ? { label: c.label, note: c.note, help: c.help, helpTitle: c.helpTitle } : null;
});
initAudio((text) => render(text));

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
undoLog.reset(state.model);
render(upgradeNotes.join(' ') || undefined);
