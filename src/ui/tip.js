/**
 * Пояснения к полям панели — по кнопке «?».
 *
 * Пояснение нужно прочитать пару раз, пока не запомнишь, что за показатель, а
 * место под полем оно занимает всегда. Поэтому текст живёт в карточке, которая
 * всплывает у кнопки: по нажатию — и на телефоне, где наведения нет, — и по
 * наведению мыши с небольшой задержкой. Карточка одна на всю страницу, на
 * встроенном Popover API: закрывается по Esc и кликом мимо.
 */
import { $ } from './dom.js';

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** Кнопка «?» для поля: ключ поля в data-tip, содержимое карточки — из lookup. */
export function tipButton(key, label) {
  return `<button type="button" class="help" data-tip="${esc(key)}" aria-label="Пояснение: ${esc(label)}" aria-expanded="false">?</button>`;
}

const HOVER_OPEN = 350; // мс: мышь, пролетевшая мимо, карточку не открывает
const HOVER_CLOSE = 200; // мс: чтобы успеть перевести мышь на ссылку в карточке

/**
 * @param {(key:string)=>{label:string, note?:string, help?:string, helpTitle?:string}|null} lookup
 */
export function initTip(lookup) {
  const tip = $('tip');
  let owner = null; // кнопка, у которой открыта карточка
  let pinned = false; // открыта нажатием — наведение её не закрывает
  let timer = 0;

  const html = (t) => [
    `<b class="tip-title">${esc(t.label)}</b>`,
    t.note ? `<p>${esc(t.note)}</p>` : '',
    t.help ? `<a href="help/${esc(t.help)}" target="_blank" rel="noopener">Подробнее${t.helpTitle ? `: ${esc(t.helpTitle)}` : ''} →</a>` : '',
  ].join('');

  function place(btn) {
    const b = btn.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight, pad = 8;
    let left = Math.min(Math.max(pad, b.left - 12), innerWidth - w - pad);
    let top = b.bottom + 6;
    if (top + h > innerHeight - pad) top = Math.max(pad, b.top - h - 6); // не влезла вниз — над кнопкой
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function open(btn, byClick) {
    const t = lookup(btn.getAttribute('data-tip'));
    if (!t) return;
    if (owner && owner !== btn) owner.setAttribute('aria-expanded', 'false');
    owner = btn;
    pinned = byClick;
    tip.innerHTML = html(t);
    if (!tip.matches(':popover-open')) tip.showPopover();
    place(btn);
    btn.setAttribute('aria-expanded', 'true');
  }

  function close() {
    if (tip.matches(':popover-open')) tip.hidePopover();
  }

  // закрыли Esc или кликом мимо — Popover API сам, нам остаётся забыть владельца
  tip.addEventListener('toggle', (e) => {
    if (e.newState === 'closed' && owner) {
      owner.setAttribute('aria-expanded', 'false');
      owner = null;
      pinned = false;
    }
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-tip]');
    if (!btn) return;
    e.preventDefault(); // кнопка внутри <label>: не передавать клик полю
    clearTimeout(timer);
    if (owner === btn && pinned) close();
    else open(btn, true);
  });

  // наведение — только мышью: касание пальцем даёт и pointerover, и click, и
  // карточка открылась бы дважды. Тип указателя надёжнее медиазапроса (hover):
  // ноутбук с сенсорным экраном умеет и то и другое
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const btn = e.target.closest?.('[data-tip]');
    if (btn) {
      clearTimeout(timer);
      if (owner !== btn) timer = setTimeout(() => open(btn, false), HOVER_OPEN);
    } else if (e.target.closest?.('#tip')) {
      clearTimeout(timer);
    }
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (!e.target.closest?.('[data-tip], #tip')) return;
    if (e.relatedTarget?.closest?.('[data-tip], #tip')) return;
    clearTimeout(timer);
    if (!pinned) timer = setTimeout(close, HOVER_CLOSE);
  });

  // прокрутили панель или окно — карточка остаётся у своей кнопки
  addEventListener('scroll', () => { if (owner) place(owner); }, true);
}
