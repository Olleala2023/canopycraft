/**
 * Редактор окон и дверей стены дома в панели. Чистые функции: разметка строк
 * по списку проёмов и правка списка по полю, которое изменили. Состояние и
 * перерисовку ведёт app.js.
 */
import { OPENING_KINDS, houseWall } from '../core/analysis.js';

/** Поля проёма: ключ, подпись, шаг. Все — мм. */
const FIELDS = [
  ['x', 'от угла', 50],
  ['w', 'ширина', 50],
  ['h', 'высота', 50],
  ['bottom', 'низ', 50],
];

/** Строки редактора — по одной на проём. */
export function openingsRows(list) {
  if (!list.length) return '';
  return list.map((o, i) => {
    const kinds = Object.entries(OPENING_KINDS)
      .map(([id, v]) => `<option value="${id}"${o.kind === id ? ' selected' : ''}>${v.label}</option>`).join('');
    const nums = FIELDS.map(([f, label, step]) =>
      `<label class="op-num"><span>${label}</span><input type="number" min="0" step="${step}" inputmode="numeric" data-op="${i}" data-f="${f}" value="${o[f]}" aria-label="${label}, мм"></label>`).join('');
    return `<div class="op-row" data-row="${i}"><div class="op-head"><select data-op="${i}" data-f="kind" aria-label="Проём ${i + 1}: что это">${kinds}</select>`
      + `<button type="button" class="btn" data-op-del="${i}" aria-label="Убрать проём ${i + 1}" title="Убрать">×</button></div>`
      + `<div class="op-nums">${nums}</div></div>`;
  }).join('') + '<small class="op-units">размеры в мм · от левого угла дома · низ от земли</small>';
}

/** Сигнатура списка: меняется — строки строятся заново, иначе только значения. */
export const openingsShape = (list) => list.map((o) => o.kind).join(',');

/** Изменили поле строки — записать в список. true, если что-то поменялось. */
export function applyOpeningInput(list, el) {
  const i = Number(el.getAttribute('data-op'));
  const f = el.getAttribute('data-f');
  const o = list[i];
  if (!o || !f) return false;
  if (f === 'kind') {
    if (!OPENING_KINDS[el.value]) return false;
    // сменили окно на дверь — и размеры типовые для нового вида, кроме положения
    const { w, h, bottom } = OPENING_KINDS[el.value];
    Object.assign(o, { kind: el.value, w, h, bottom });
    return true;
  }
  const v = Math.max(0, Number(el.value) || 0);
  if (o[f] === v) return false;
  o[f] = v;
  return true;
}

/**
 * Новый проём типового размера — посередине участка стены под навесом.
 * Размеры — только заготовка: человек меряет свои и правит.
 */
export function newOpening(kind, model) {
  const t = OPENING_KINDS[kind] ?? OPENING_KINDS.window;
  const { x0 } = houseWall(model);
  const mid = model.geom.B / 2 - x0; // середина навеса от угла дома
  const x = Math.max(0, Math.round((mid - t.w / 2) / 50) * 50);
  return { kind: OPENING_KINDS[kind] ? kind : 'window', x, w: t.w, h: t.h, bottom: t.bottom };
}
