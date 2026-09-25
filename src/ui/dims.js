/**
 * Цепочка размеров вдоль стены — общая для плана и фасада. Чистая функция:
 * точки привязки (wallMarks) и масштаб на входе, строка SVG на выходе.
 */
const mono = 'IBM Plex Mono, ui-monospace, monospace';

/** Засечки точек: ось столба и откос — чернилами, углы и края навеса — бледнее. */
const TICK = { post: 'var(--ink)', jamb: 'var(--ink-2)', corner: 'var(--ink-3)', edge: 'var(--ink-3)' };

/**
 * @param {{ x:number, kinds:string[] }[]} marks — по возрастанию x, мм
 * @param {(x:number)=>number} X — мм → px
 * @param {number} y — линия цепочки, px
 * @param {number} [dir] — с какой стороны линии размеры: −1 над ней, +1 под ней
 */
export function dimChain(marks, X, y, dir = -1) {
  if (marks.length < 2) return '';
  const s = ['<g pointer-events="none" class="dim-chain">'];
  s.push(`<line x1="${X(marks[0].x)}" y1="${y}" x2="${X(marks[marks.length - 1].x)}" y2="${y}" stroke="var(--ink-3)"/>`);
  for (const mk of marks) {
    const kind = ['post', 'jamb', 'corner', 'edge'].find((k) => mk.kinds.includes(k));
    const h = kind === 'post' || kind === 'jamb' ? 5 : 4;
    s.push(`<line x1="${X(mk.x) - 3}" y1="${y + 3}" x2="${X(mk.x) + 3}" y2="${y - 3}" stroke="${TICK[kind]}" stroke-width="1.3"/>`);
    s.push(`<line x1="${X(mk.x)}" y1="${y - h}" x2="${X(mk.x)}" y2="${y + h}" stroke="${TICK[kind]}"/>`);
  }
  // узкий размер не помещается — каждый второй такой уходит во второй ряд, дальше от линии
  let flip = false;
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1].x, b = marks[i].x;
    const len = Math.round(b - a);
    const text = String(len);
    const px = X(b) - X(a);
    const narrow = px < text.length * 6.2 + 6;
    const far = narrow && (flip = !flip);
    const ty = dir < 0 ? y - (far ? 16 : 5) : y + (far ? 24 : 13);
    s.push(`<text x="${(X(a) + X(b)) / 2}" y="${ty}" font-size="${narrow ? 9 : 10}" text-anchor="middle" font-family="${mono}" fill="var(--ink-2)">${text}</text>`);
  }
  s.push('</g>');
  return s.join('');
}
