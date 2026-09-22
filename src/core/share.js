/**
 * Упаковка модели в ссылку.
 *
 * В URL кладётся не вся модель, а только отличия от значений по умолчанию —
 * тогда ссылка на слегка изменённый расчёт остаётся короткой, а новые поля,
 * появившиеся в программе позже, подставятся из текущих умолчаний.
 */
import { defaultModel } from './model.js';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Разница между моделью и эталоном: только изменённые листья и массивы целиком. */
export function diffModel(model, base = defaultModel()) {
  const out = {};
  for (const [k, v] of Object.entries(model)) {
    const b = base?.[k];
    if (isPlain(v) && isPlain(b)) {
      const d = diffModel(v, b);
      if (Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(v) !== JSON.stringify(b)) {
      out[k] = v;
    }
  }
  return out;
}

/** Накладывает разницу на эталон. Неизвестные ключи игнорируются. */
export function mergeModel(patch, base = defaultModel()) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlain(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in out)) continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? mergeModel(v, out[k]) : v;
  }
  return out;
}

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code) {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Старые ссылки.
 *
 * До разделения по плоскостям в модели было одно поле mu, потом muX и muY,
 * которые выбирались из списка. Теперь μ следует из схемы связей
 * (model.bracing), а полей μ нет вовсе. mergeModel неизвестные ключи молча
 * выбрасывает, и такая ссылка тихо считалась бы с умолчаниями — поэтому
 * переводим: μ ≤ 1 вдоль ряда у наружного столба значило «верх удержан
 * связями», то есть крест в ряду. Поперёк ряда выбирать больше нечего —
 * верх там держат стропила. Что перевели, говорим словами.
 */
function migrate(patch) {
  const notes = [];
  if (!isPlain(patch)) return { patch, notes };
  const out = { ...patch };
  for (const row of ['posts', 'wallPosts']) {
    const r = out[row];
    if (!isPlain(r) || !('mu' in r || 'muX' in r || 'muY' in r)) continue;
    const { mu, muX, muY, ...rest } = r;
    out[row] = rest;
    const along = muY ?? mu;
    if (row === 'posts' && along !== undefined && along <= 1) {
      out.bracing = { along: 'cross', ...(isPlain(out.bracing) ? out.bracing : {}) };
      notes.push(`В ссылке у наружных столбов стояло μ = ${String(along).replace('.', ',')} вдоль ряда — верх удержан связями. `
        + 'Теперь μ задаётся схемой: поставлен крест в крайнем пролёте, и он проверяется.');
    } else if (row === 'posts' && (muX ?? mu) !== undefined && (muX ?? mu) !== 2) {
      notes.push('μ поперёк ряда из ссылки больше не выбирается: верх там держат стропила, и это проверяется.');
    }
  }
  return { patch: out, notes };
}

/** Модель → строка для адресной строки. */
export function encodeModel(model) {
  return toBase64Url(JSON.stringify(diffModel(model)));
}

/** Строка из адресной строки → модель. null, если строка испорчена. */
export function decodeModel(code) {
  try {
    const { patch } = migrate(JSON.parse(fromBase64Url(code)));
    if (!isPlain(patch)) return null;
    return mergeModel(patch);
  } catch {
    return null;
  }
}

/** Что пришлось перевести при чтении старой ссылки — для сообщения человеку. */
export function decodeNotes(code) {
  try {
    return migrate(JSON.parse(fromBase64Url(code))).notes;
  } catch {
    return [];
  }
}
