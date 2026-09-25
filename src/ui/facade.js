/**
 * Фасад стены дома — вид со двора, из-под навеса. Чистая функция: результат
 * расчёта на входе, SVG на выходе.
 *
 * Зачем: окна и двери видны прямоугольниками с размерами и привязками, а
 * рядом — столбы у стены со шпильками и обвязка. Столбы здесь перетаскиваются
 * так же, как на плане, и цепочка размеров снизу сразу показывает, сколько
 * осталось до откоса. Геометрия — из расчёта: отметки из levels(), шпильки из
 * boltHeights(), проёмы и стена — из core/house.js.
 */
import { levels, boltHeights } from '../core/model.js';
import { houseWall, openingsOf, houseClashes, wallMarks } from '../core/analysis.js';
import { uColor, f2, esc } from './views.js';
import { dimChain } from './dims.js';

const mono = 'IBM Plex Mono, ui-monospace, monospace';

export function drawFacade(res, sel) {
  const m = res.model, B = m.geom.B;
  const lv = levels(m);
  const wall = houseWall(m);
  const xa = Math.min(0, wall.x0), xb = Math.max(B, wall.x1);
  const Htop = lv.houseRoof;
  const pad = { l: 64, r: 70, t: 40, b: 92 };
  const sc = Math.min(780 / (xb - xa), 380 / Htop);
  const vw = (xb - xa) * sc + pad.l + pad.r, vh = Htop * sc + pad.t + pad.b;
  // X(x) = ox + x·sc — та же привязка, что у плана: перетаскивание работает одинаково
  const ox = pad.l - xa * sc;
  const X = (x) => ox + x * sc;
  const Y = (z) => pad.t + (Htop - z) * sc;
  const ops = openingsOf(m);
  const clashes = houseClashes(m).filter((c) => c.kind === 'post');
  const clashed = new Set(clashes.map((c) => c.opening.index));
  const s = [];
  s.push(`<svg viewBox="0 0 ${vw} ${vh}" role="img" aria-label="Фасад стены дома">`);
  s.push(`<text x="${pad.l}" y="${pad.t - 20}" font-size="10" font-family="${mono}" fill="var(--ink-2)" letter-spacing="1.3">СТЕНА ДОМА СО ДВОРА · размеры в мм${m.house?.width > 0 ? ' · привязки от левого угла дома' : ''}</text>`);

  // стена и земля
  s.push(`<rect x="${X(wall.x0)}" y="${Y(Htop)}" width="${(wall.x1 - wall.x0) * sc}" height="${Htop * sc}" fill="var(--sunk)" stroke="var(--rule-2)"/>`);
  s.push(`<line x1="${X(xa) - 20}" y1="${Y(0)}" x2="${X(xb) + 20}" y2="${Y(0)}" stroke="var(--ink)" stroke-width="2"/>`);
  // навес по ширине: верх у стены — пунктиром, чтобы было видно, где он кончается
  s.push(`<line x1="${X(0)}" y1="${Y(lv.canopyTopWall)}" x2="${X(B)}" y2="${Y(lv.canopyTopWall)}" stroke="var(--ink-3)" stroke-dasharray="5 4"/>`);
  s.push(`<text x="${X(B) + 6}" y="${Y(lv.canopyTopWall) + 3}" font-size="9" font-family="${mono}" fill="var(--ink-3)">верх навеса ${Math.round(lv.canopyTopWall)}</text>`);

  // окна и двери
  for (const o of ops) {
    const x0 = X(o.x0), w = (o.x1 - o.x0) * sc, y0 = Y(o.top), h = (o.top - o.bottom) * sc;
    const col = clashed.has(o.index) ? 'var(--u-bad)' : 'var(--ink-2)';
    s.push(`<g pointer-events="none"><rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="var(--surface)" stroke="${col}" stroke-width="1.4"/>`);
    if (o.kind === 'window') {
      // переплёт — чтобы окно читалось окном
      s.push(`<line x1="${x0 + w / 2}" y1="${y0}" x2="${x0 + w / 2}" y2="${y0 + h}" stroke="${col}" stroke-width=".7"/>`);
      s.push(`<line x1="${x0}" y1="${y0 + h * 0.35}" x2="${x0 + w}" y2="${y0 + h * 0.35}" stroke="${col}" stroke-width=".7"/>`);
    } else {
      s.push(`<circle cx="${x0 + w - Math.min(8, w / 5)}" cy="${Y(o.bottom + 1000)}" r="2" fill="${col}"/>`);
    }
    const label = `${o.kind === 'window' ? 'окно' : 'дверь'} ${Math.round(o.x1 - o.x0)}×${Math.round(o.top - o.bottom)}`;
    s.push(`<text x="${x0 + w / 2}" y="${y0 + 13}" font-size="9.5" text-anchor="middle" font-family="${mono}" fill="${col}">${label}</text>`);
    // низ проёма от земли — у левого откоса
    if (o.bottom > 0) {
      const xd = x0 + 8;
      s.push(`<line x1="${xd}" y1="${Y(0)}" x2="${xd}" y2="${Y(o.bottom)}" stroke="var(--ink-3)" stroke-dasharray="2 2"/>`);
      s.push(`<text x="${xd + 3}" y="${Y(o.bottom / 2) + 3}" font-size="9" font-family="${mono}" fill="var(--ink-3)">низ ${Math.round(o.bottom)}</text>`);
    }
    s.push(`<title>${label} мм, низ на ${Math.round(o.bottom)} мм</title></g>`);
  }

  // обвязка по столбам — её низ: окно выше него она перекроет
  const wpH = res.wallPurlin.sec.h;
  s.push(`<g class="pickable" data-pick="wallPurlin"><rect x="${X(0)}" y="${Y(lv.wallPostTop + wpH)}" width="${B * sc}" height="${Math.max(3, wpH * sc)}" fill="var(--surface-2)" stroke="${uColor(res.wallPurlin.U)}" stroke-width="1.5"/>
    <title>Обвязка у стены ${esc(res.wallPurlin.sec.label)}, низ на ${Math.round(lv.wallPostTop)} мм · U ${f2(res.wallPurlin.U)}</title></g>`);
  s.push(`<text x="${X(B) + 6}" y="${Y(lv.wallPostTop) + 3}" font-size="9" font-family="${mono}" fill="var(--ink-3)">низ обвязки ${Math.round(lv.wallPostTop)}</text>`);

  // столбы у стены со шпильками — перетаскиваются, как на плане
  const zs = boltHeights(lv.wallPostTop, Math.max(1, m.wallPosts.boltCount));
  res.wallPosts.forEach((p, i) => {
    const on = sel?.type === 'wallPost' && sel.index === i;
    const bw = Math.max(4, p.sec.b * sc);
    s.push(`<g class="pickable draggable" data-pick="wallPost" data-index="${i}">`);
    s.push(`<rect x="${X(p.x) - bw / 2}" y="${Y(lv.wallPostTop)}" width="${bw}" height="${lv.wallPostTop * sc}" fill="${uColor(p.U)}" fill-opacity=".85" stroke="${on ? 'var(--ink)' : uColor(p.U)}" stroke-width="${on ? 2 : 1}"/>`);
    // в проёме шпильке не во что упереться — такая точка красная
    for (const z of zs) {
      const inOpening = ops.some((o) => p.x + p.sec.b / 2 > o.x0 && p.x - p.sec.b / 2 < o.x1 && z > o.bottom && z < o.top);
      s.push(`<circle cx="${X(p.x)}" cy="${Y(z)}" r="2.6" fill="${inOpening ? 'var(--u-bad)' : 'var(--ink)'}"/>`);
    }
    s.push(`<rect x="${X(p.x) - 10}" y="${Y(lv.wallPostTop)}" width="20" height="${lv.wallPostTop * sc}" fill="transparent"/>`);
    s.push(`<title>Столб у стены ${i + 1} на ${Math.round(p.x)} мм · ${esc(p.sec.label)} · U ${f2(p.U)} — тяните, чтобы передвинуть</title></g>`);
  });

  // цепочка привязок: углы, края навеса, оси столбов, откосы — и общий размер
  const marks = wallMarks(m);
  s.push(dimChain(marks, X, Y(0) + 26, 1));
  const first = marks[0].x, last = marks[marks.length - 1].x;
  const yAll = Y(0) + 66;
  s.push(`<g pointer-events="none"><line x1="${X(first)}" y1="${yAll}" x2="${X(last)}" y2="${yAll}" stroke="var(--ink-3)"/>
    <line x1="${X(first)}" y1="${yAll - 4}" x2="${X(first)}" y2="${yAll + 4}" stroke="var(--ink-3)"/>
    <line x1="${X(last)}" y1="${yAll - 4}" x2="${X(last)}" y2="${yAll + 4}" stroke="var(--ink-3)"/>
    <text x="${(X(first) + X(last)) / 2}" y="${yAll - 5}" font-size="10" text-anchor="middle" font-family="${mono}" fill="var(--ink-2)">${m.house?.width > 0 ? `стена ${Math.round(wall.x1 - wall.x0)} · навес ${B} от ${Math.round(-wall.x0)}` : `навес и стена ${B}`}</text></g>`);
  if (!ops.length) {
    s.push(`<text x="${(X(xa) + X(xb)) / 2}" y="${Y(Htop / 2)}" font-size="11" text-anchor="middle" font-family="${mono}" fill="var(--ink-3)">окна и двери добавляются в блоке «Стена дома»</text>`);
  }
  s.push('</svg>');
  return { svg: s.join(''), meta: { sc, ox, oy: pad.t, vw, vh } };
}
