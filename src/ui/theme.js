import { $ } from './dom.js';

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

/** Кнопка темы; onChange(название) — сказать человеку, что тема сменилась. */
export function initTheme(onChange) {
  $('btn-theme').addEventListener('click', () => {
    const next = THEMES[(THEMES.findIndex((x) => x.id === readTheme()) + 1) % THEMES.length];
    try { localStorage.setItem(THEME_KEY, next.id); } catch { /* приватный режим */ }
    applyTheme(next.id);
    onChange(next.label);
  });
  applyTheme(readTheme());
}
