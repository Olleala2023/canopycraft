/** Форматирование чисел и слов для интерфейса и отчёта. */
import { f2 } from './views.js';

/** Ньютоны → килоньютоны с десятичной запятой. */
export const kN = (v) => f2(v / 1000);

/** Склонение числительного: 1 стык, 2 стыка, 5 стыков. */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  const word = a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  return `${n} ${word}`;
}
