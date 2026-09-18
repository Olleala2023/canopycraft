/** Отрисовка: план, разрез, эпюры. Чистые функции — строка SVG + метрика для попадания курсора. */
import { levels, boltHeights } from '../core/model.js';
import { section } from '../core/sections.js';

export const uColor = (U) =>
  U > 1 ? 'var(--u-bad)' : U > 0.85 ? 'var(--u-warn)' : U > 0.5 ? 'var(--u-ok)' : 'var(--u-low)';

const f2 = (x) => x.toFixed(2).replace('.', ',');
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const mono = 'IBM Plex Mono, ui-monospace, monospace';

function dimH(x1, x2, y, text, color = 'var(--ink-3)') {
  return `<g pointer-events="none"><line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}"/>
   <line x1="${x1}" y1="${y - 4}" x2="${x1}" y2="${y + 4}" stroke="${color}"/>
   <line x1="${x2}" y1="${y - 4}" x2="${x2}" y2="${y + 4}" stroke="${color}"/>
   <text x="${(x1 + x2) / 2}" y="${y - 5}" font-size="10" text-anchor="middle" font-family="${mono}" fill="${color}">${text}</text></g>`;
}
function dimV(y1, y2, x, text, color = 'var(--ink-3)') {
  return `<g pointer-events="none"><line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${color}"/>
   <line x1="${x - 4}" y1="${y1}" x2="${x + 4}" y2="${y1}" stroke="${color}"/>
   <line x1="${x - 4}" y1="${y2}" x2="${x + 4}" y2="${y2}" stroke="${color}"/>
   <text transform="translate(${x - 5},${(y1 + y2) / 2}) rotate(-90)" font-size="10" text-anchor="middle" font-family="${mono}" fill="${color}">${text}</text></g>`;
}

/* ───────────────────────────── ПЛАН ───────────────────────────── */

export function drawPlan(res, sel) {
  const m = res.model, g = m.geom;
  const pad = { l: 60, r: 34, t: 44, b: 68 };
  const sc = Math.min(780 / g.B, 360 / (g.L + g.a));
  const W = g.B * sc, H = (g.L + g.a) * sc;
  const vw = W + pad.l + pad.r, vh = H + pad.t + pad.b;
  const X = (x) => pad.l + x * sc, Y = (y) => pad.t + y * sc;
  const s = [];
  s.push(`<svg viewBox="0 0 ${vw} ${vh}" role="img" aria-label="План навеса с картой загрузки">`);
  s.push(`<defs><linearGradient id="drift" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="var(--u-bad)" stop-opacity=".28"/>
    <stop offset="1" stop-color="var(--u-bad)" stop-opacity="0"/></linearGradient></defs>`);

  s.push(`<rect x="${X(0)}" y="${Y(0)}" width="${W}" height="${H}" fill="var(--surface)" stroke="var(--rule-2)"/>`);
  if (res.snow.driftLength > 0) {
    const bd = Math.min(H, res.snow.driftLength * sc);
    s.push(`<rect x="${X(0)}" y="${Y(0)}" width="${W}" height="${bd}" fill="url(#drift)"/>`);

  }
  s.push(`<line x1="${X(0)}" y1="${Y(0)}" x2="${X(g.B)}" y2="${Y(0)}" stroke="var(--ink)" stroke-width="5"/>`);
  s.push(`<text x="${X(0)}" y="${Y(0) - 12}" font-size="10" font-family="${mono}" fill="var(--ink-2)" letter-spacing="1.3">СТЕНА ДОМА · газоблок ${m.wallPosts.wallThickness} мм, столбы на сквозных шпильках М${m.wallPosts.boltDiameter}</text>`);
  s.push(`<g class="pickable" data-pick="wallPurlin"><rect x="${X(0)}" y="${Y(0)}" width="${W}" height="12" fill="transparent"/>
    <line x1="${X(0)}" y1="${Y(0) + 5}" x2="${X(g.B)}" y2="${Y(0) + 5}" stroke="${uColor(res.wallPurlin.U)}" stroke-width="5"/>
    <title>Обвязка у стены ${res.wallPurlin.sec.label} · U ${f2(res.wallPurlin.U)}</title></g>`);

  // стропила
  const rsec = res.rafters[0]?.sec;
  const tw = Math.max(2.5, (rsec?.b ?? 50) * sc * 0.9);
  res.rafters.forEach((r, i) => {
    const x = X(r.x);
    const on = sel.type === 'rafter' && sel.index === i;
    s.push(`<g class="pickable draggable" data-pick="rafter" data-index="${i}">`);
    s.push(`<rect x="${x - 9}" y="${Y(0)}" width="18" height="${H}" fill="transparent"/>`);
    s.push(`<line x1="${x}" y1="${Y(0)}" x2="${x}" y2="${Y(g.L + g.a)}" stroke="${uColor(r.U)}" stroke-width="${tw}" opacity="${on ? 1 : 0.85}"/>`);
    if (on) s.push(`<line x1="${x}" y1="${Y(0) - 5}" x2="${x}" y2="${Y(g.L + g.a) + 5}" stroke="var(--ink)" stroke-dasharray="3 3"/>`);
    s.push(`<text x="${x}" y="${Y(g.L + g.a) + 13}" font-size="9.5" text-anchor="middle" font-family="${mono}" fill="${uColor(r.U)}">${f2(r.U)}</text>`);
    s.push(`<title>Стропило ${i + 1} · ${r.sec.label} · грузовая ${Math.round(r.trib)} мм · U ${f2(r.U)} (${r.worst?.name})</title></g>`);
  });

  // прогон
  s.push(`<g class="pickable" data-pick="purlin"><rect x="${X(0)}" y="${Y(g.L) - 7}" width="${W}" height="14" fill="transparent"/>
    <line x1="${X(0)}" y1="${Y(g.L)}" x2="${X(g.B)}" y2="${Y(g.L)}" stroke="${uColor(res.purlin.U)}" stroke-width="5"/>
    <title>Прогон ${res.purlin.sec.label} · U ${f2(res.purlin.U)}</title></g>`);

  // столбы
  res.posts.forEach((p, i) => {
    const px = X(p.x), py = Y(g.L), sz = 11;
    s.push(`<g class="pickable draggable" data-pick="post" data-index="${i}">
      <rect x="${px - 10}" y="${py - 10}" width="20" height="20" fill="transparent"/>
      <rect x="${px - sz / 2}" y="${py - sz / 2}" width="${sz}" height="${sz}" fill="var(--surface)" stroke="${uColor(p.U)}" stroke-width="2.6"/>
      <title>Столб ${i + 1} · ${p.sec.label} · N ${f2(p.N / 1000)} кН · U ${f2(p.U)}</title></g>`);
  });
  if (sel.type === 'post') {
    const px = X(res.posts[sel.index]?.x ?? 0);
    s.push(`<circle cx="${px}" cy="${Y(g.L)}" r="13" fill="none" stroke="var(--ink)" stroke-dasharray="3 3"/>`);
  }

  res.wallPosts.forEach((p, i) => {
    const px = X(p.x), py = Y(0) + 5, sz = 10;
    s.push(`<g class="pickable draggable" data-pick="wallPost" data-index="${i}">
      <rect x="${px - 10}" y="${py - 10}" width="20" height="20" fill="transparent"/>
      <rect x="${px - sz / 2}" y="${py - sz / 2}" width="${sz}" height="${sz}" fill="var(--surface)" stroke="${uColor(p.U)}" stroke-width="2.6"/>
      <title>Столб у стены ${i + 1} · ${p.sec.label} · N ${f2(p.N / 1000)} кН · U ${f2(p.U)}</title></g>`);
  });
  if (sel.type === 'wallPost') {
    const px = X(res.wallPosts[sel.index]?.x ?? 0);
    s.push(`<circle cx="${px}" cy="${Y(0) + 5}" r="13" fill="none" stroke="var(--ink)" stroke-dasharray="3 3"/>`);
  }

  // обрешётка — тонкими штрихами
  const nB = Math.floor((g.L + g.a) / m.battens.spacing);
  for (let i = 1; i <= nB; i++) {
    const y = Y(Math.min(g.L + g.a, i * m.battens.spacing));
    s.push(`<line x1="${X(0)}" y1="${y}" x2="${X(g.B)}" y2="${y}" stroke="${uColor(res.battens.U)}" stroke-width="1" opacity=".35"/>`);
  }

  if (res.snow.driftLength > 0) {
    const dl = `снеговой мешок · μ = ${f2(res.snow.muWall)} · ${f2(res.snow.muWall * res.snow.Sg * 1.4)} кПа расчётных`;
    s.push(`<rect x="${X(0) + 5}" y="${Y(0) + 5}" width="${dl.length * 5.6}" height="16" fill="var(--surface)" opacity=".94" stroke="var(--u-bad)" stroke-opacity=".4" pointer-events="none"/>`);
    s.push(`<text x="${X(0) + 9}" y="${Y(0) + 17}" font-size="10" font-family="${mono}" fill="var(--u-bad)">${dl}</text>`);
  }
  s.push(dimH(X(0), X(g.B), Y(g.L + g.a) + 34, `${g.B}`));
  s.push(dimV(Y(0), Y(g.L), X(0) - 26, `${g.L}`));
  if (g.a > 0) s.push(dimV(Y(g.L), Y(g.L + g.a), X(0) - 26, `${g.a}`, 'var(--u-warn)'));
  const steps = [];
  for (let i = 1; i < res.rafters.length; i++) steps.push(Math.round(res.rafters[i].x - res.rafters[i - 1].x));
  const uniq = [...new Set(steps)];
  s.push(`<text x="${X(g.B)}" y="${Y(g.L + g.a) + 50}" font-size="10" text-anchor="end" font-family="${mono}" fill="var(--ink-3)">шаг стропил ${uniq.length === 1 ? uniq[0] : `${Math.min(...steps)}…${Math.max(...steps)}`} мм</text>`);
  s.push('</svg>');
  return { svg: s.join(''), meta: { sc, ox: pad.l, oy: pad.t, vw, vh } };
}

/* ──────────────────────────── РАЗРЕЗ ──────────────────────────── */

export function drawSection(res) {
  const m = res.model, g = m.geom;
  const lv = levels(m);
  const al = (g.alpha * Math.PI) / 180, tg = Math.tan(al);
  const total = g.L + g.a;
  const totalH = lv.houseRoof + 700;
  const pad = { l: 142, r: 48, t: 30, b: 66 };
  const sc = Math.min(680 / (total + 700), 380 / totalH);
  const vw = (total + 800) * sc + pad.l + pad.r;
  const vh = totalH * sc + pad.t + pad.b;
  const X = (x) => pad.l + (x + 420) * sc;
  const Y = (y) => pad.t + (totalH - y) * sc; // y — высота от верха фундамента
  const s = [];
  const sec = (id) => section(id);
  s.push(`<svg viewBox="0 0 ${vw} ${vh}" role="img" aria-label="Разрез навеса">`);

  // ── дом
  const eave = 260; // свес кровли дома над стеной — снег сходит именно отсюда
  s.push(`<rect x="${X(-420)}" y="${Y(lv.houseRoof)}" width="${420 * sc}" height="${lv.houseRoof * sc}" fill="var(--sunk)" stroke="var(--rule-2)"/>`);
  s.push(`<line x1="${X(-420)}" y1="${Y(lv.houseRoof + 620)}" x2="${X(eave)}" y2="${Y(lv.houseRoof)}" stroke="var(--ink-2)" stroke-width="1.5"/>`);
  s.push(`<line x1="${X(-420)}" y1="${Y(lv.houseRoof)}" x2="${X(eave)}" y2="${Y(lv.houseRoof)}" stroke="var(--ink-2)" stroke-width="3"/>`);
  s.push(`<text x="${X(eave) + 8}" y="${Y(lv.houseRoof) - 6}" font-size="10" font-family="${mono}" fill="var(--ink-2)">кровля дома — снег сходит отсюда</text>`);
  s.push(`<text transform="translate(${X(-210)},${Y(lv.postTop * 0.3)}) rotate(-90)" font-size="11" text-anchor="middle" font-family="${mono}" fill="var(--ink-3)">ДОМ</text>`);

  // ── размерная цепочка слева
  const xDim = X(-420) - 30;
  s.push(`<line x1="${xDim - 6}" y1="${Y(lv.houseRoof)}" x2="${X(-420)}" y2="${Y(lv.houseRoof)}" stroke="var(--ink-2)" stroke-width="1" stroke-dasharray="4 3" opacity=".7" pointer-events="none"/>`);
  for (const hv of [0, lv.canopyTopWall]) {
    s.push(`<line x1="${xDim - 6}" y1="${Y(hv)}" x2="${X(120)}" y2="${Y(hv)}" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="4 3" opacity=".7" pointer-events="none"/>`);
  }
  s.push(dimV(Y(0), Y(lv.canopyTopWall), xDim, `${Math.round(lv.canopyTopWall)} до верха навеса`, 'var(--u-warn)'));
  s.push(dimV(Y(lv.canopyTopWall), Y(lv.houseRoof), xDim, `перепад ${g.driftH} до кровли дома`, 'var(--u-bad)'));

  // ── снег: эпюра лежит на верхней кромке стропил
  const kPa = 70; // мм чертежа на 1 кПа снега
  const top = (x) => lv.canopyTopWall - x * tg;
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const x = (total * i) / 24;
    pts.push(`${X(x)},${Y(top(x) + res.snow.at(x) * kPa)}`);
  }
  s.push(`<polygon points="${X(0)},${Y(top(0))} ${pts.join(' ')} ${X(total)},${Y(top(total))}" fill="var(--u-bad)" fill-opacity=".18" stroke="var(--u-bad)" stroke-width="1" pointer-events="none"/>`);
  s.push(`<text x="${X(150)}" y="${Y(top(0) + res.snow.at(0) * kPa) - 7}" font-size="10" font-family="${mono}" fill="var(--u-bad)">снег ${f2(res.snow.at(0))} → ${f2(res.snow.at(total))} кПа (нормативный)</text>`);

  // ── ветер
  s.push('<g stroke="var(--accent-2)" fill="var(--accent-2)" pointer-events="none">');
  for (let i = 1; i <= 4; i++) {
    const x = (total * i) / 5, y0 = Y(top(x));
    s.push(`<line x1="${X(x)}" y1="${y0 - 5}" x2="${X(x)}" y2="${y0 - 26}"/><polygon points="${X(x) - 3},${y0 - 24} ${X(x) + 3},${y0 - 24} ${X(x)},${y0 - 31}"/>`);
  }
  s.push(`</g><text x="${X(total)}" y="${Y(lv.canopyTopWall) - 36}" font-size="10" text-anchor="end" font-family="${mono}" fill="var(--accent-2)">ветровой отрыв ${f2(res.wind.up)} кПа</text>`);

  // ── стропило: наклонный брус по нижней кромке от обвязки до конца свеса
  const rH = lv.rafterH * sc;
  const rU = Math.max(...res.rafters.map((r) => r.U));
  const x1 = X(0), y1 = Y(lv.rafterBottomWall), x2 = X(total), y2 = Y(lv.rafterBottomWall - total * tg);
  const len = Math.hypot(x2 - x1, y2 - y1);
  s.push(`<rect x="${x1}" y="${y1 - rH}" width="${len}" height="${rH}" fill="${uColor(rU)}" opacity=".92" stroke="var(--surface)" stroke-width="1"
     transform="rotate(${(Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI} ${x1} ${y1})"/>`);
  // подпись уклона — под стропилом, чтобы не налезала на снег
  s.push(`<text x="${X(total * 0.45)}" y="${Y(lv.rafterBottomWall - total * 0.45 * tg) + 24}" font-size="10" text-anchor="middle" font-family="${mono}" fill="var(--ink-2)">уклон ${g.alpha}° · стропило ${sec(m.rafters.sectionId).label}</text>`);

  // ── обвязка у стены и стеновой столб
  const wpS = sec(m.wallPosts.sectionId), wbS = sec(m.wallPurlin.sectionId);
  s.push(`<rect x="${X(0)}" y="${Y(lv.rafterBottomWall)}" width="${Math.max(3, wbS.b * sc)}" height="${lv.wallPurlinH * sc}" fill="${uColor(res.wallPurlin.U)}" opacity=".95" stroke="var(--surface)" stroke-width="1"/>`);
  s.push(`<rect x="${X(0)}" y="${Y(lv.wallPostTop)}" width="${Math.max(4, wpS.b * sc)}" height="${lv.wallPostTop * sc}" fill="${uColor(res.wallPosts[0].U)}" opacity=".9" stroke="var(--surface)" stroke-width="1"/>`);
  const nb = m.wallPosts.boltCount;
  for (const hy of boltHeights(lv.wallPostTop, nb)) {
    s.push(`<line x1="${X(-m.wallPosts.wallThickness)}" y1="${Y(hy)}" x2="${X(90)}" y2="${Y(hy)}" stroke="var(--ink)" stroke-width="1.6"/>`);
    s.push(`<rect x="${X(-m.wallPosts.wallThickness) - 4}" y="${Y(hy) - 6}" width="5" height="12" fill="var(--ink)"/>`);
  }
  s.push(`<text x="${X(130)}" y="${Y(lv.wallPostTop * 0.62)}" font-size="9.5" font-family="${mono}" fill="var(--ink-2)">${nb} × М${m.wallPosts.boltDiameter} сквозь газоблок ${m.wallPosts.wallThickness}</text>`);
  s.push(`<text x="${X(130)}" y="${Y(lv.wallPostTop * 0.62) + 13}" font-size="9.5" font-family="${mono}" fill="var(--ink-3)">столб ${wpS.label} · ${Math.round(lv.wallPostLength)} мм</text>`);
  s.push(`<text x="${X(130)}" y="${Y(lv.wallPostTop * 0.62) + 26}" font-size="9.5" font-family="${mono}" fill="var(--ink-3)">обвязка ${wbS.label}</text>`);

  // ── наружный прогон и столб
  const pS = sec(m.purlin.sectionId), poS = sec(m.posts.sectionId);
  s.push(`<rect x="${X(g.L) - (pS.b * sc) / 2}" y="${Y(lv.rafterBottomOuter)}" width="${Math.max(3, pS.b * sc)}" height="${lv.purlinH * sc}" fill="${uColor(res.purlin.U)}" opacity=".95" stroke="var(--surface)" stroke-width="1"/>`);
  s.push(`<rect x="${X(g.L) - (poS.b * sc) / 2}" y="${Y(lv.postTop)}" width="${Math.max(4, poS.b * sc)}" height="${lv.postTop * sc}" fill="${uColor(res.posts[0].U)}" opacity=".9" stroke="var(--surface)" stroke-width="1"/>`);
  s.push(`<text x="${X(g.L) - 14}" y="${Y(lv.postTop * 0.3)}" font-size="9.5" text-anchor="end" font-family="${mono}" fill="var(--ink-3)">столб ${poS.label} · ${Math.round(lv.postLength)} мм</text>`);
  s.push(`<text x="${X(g.L) - 14}" y="${Y(lv.postTop * 0.3) + 13}" font-size="9.5" text-anchor="end" font-family="${mono}" fill="var(--ink-3)">прогон ${pS.label}</text>`);

  // ── фундамент
  const fs = Math.max(300, res.foundation.cubeSide);
  s.push(`<rect x="${X(g.L) - (fs * sc) / 2}" y="${Y(0)}" width="${fs * sc}" height="${fs * sc * 0.55}" fill="var(--sunk)" stroke="var(--rule-2)"/>`);
  s.push(`<text x="${X(g.L)}" y="${Y(0) + fs * sc * 0.55 + 26}" font-size="9.5" text-anchor="middle" font-family="${mono}" fill="var(--ink-3)">фундамент ≈ ${Math.round(fs)} мм</text>`);

  // ── размеры
  s.push(dimH(X(0), X(g.L), Y(0) + 34, `${g.L}`));
  s.push(dimH(X(g.L), X(total), Y(0) + 34, `${g.a}`, 'var(--u-warn)'));
  s.push(dimV(Y(0), Y(lv.postTop), X(total) + 30, `${Math.round(lv.postTop)} наружный столб`));
  s.push('</svg>');
  return { svg: s.join(''), meta: null };
}

/* ──────────────────────────── ЭПЮРЫ ──────────────────────────── */

function chart(title, xs, ys, W, H, x0, y0, color, unit, scaleY, flip = false) {
  const maxA = Math.max(1e-9, ...ys.map(Math.abs));
  const k = (H / 2 / maxA) * 0.92 * (flip ? -1 : 1);
  const pts = [];
  for (let i = 0; i < xs.length; i += 2) {
    pts.push(`${(x0 + (W * xs[i]) / xs[xs.length - 1]).toFixed(1)},${(y0 + H / 2 - ys[i] * k).toFixed(1)}`);
  }
  return `<g><text x="${x0}" y="${y0 - 5}" font-size="10" font-family="${mono}" fill="var(--ink-3)" letter-spacing="1.1">${title}</text>
   <line x1="${x0}" y1="${y0 + H / 2}" x2="${x0 + W}" y2="${y0 + H / 2}" stroke="var(--rule-2)"/>
   <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6"/>
   <text x="${x0 + W}" y="${y0 - 5}" font-size="10" text-anchor="end" font-family="${mono}" fill="${color}">max ${(maxA * scaleY).toFixed(2).replace('.', ',')} ${unit}</text></g>`;
}

function emptyDiagrams(text) {
  return {
    svg: `<svg viewBox="0 0 600 90" role="img" aria-label="${esc(text)}">
      <text x="300" y="46" font-size="13" text-anchor="middle" font-family="${mono}" fill="var(--ink-3)">${esc(text)}</text></svg>`,
    meta: null,
  };
}

export function drawDiagrams(res, sel) {
  const el = pickElement(res, sel);
  if (!el) return emptyDiagrams('Выберите элемент на плане или в сводке внизу');
  if (!el.res) return emptyDiagrams(`Для элемента «${el.title.toLowerCase()}» эпюры не строятся`);
  const r = el.res.uls ?? el.res['ULS-1'];
  const sls = el.res.sls ?? el.res.SLS;
  const vertical = el.kind === 'post' || el.kind === 'wallPost';
  const W = 720, H = 84, pad = { l: 46, r: 26, t: 48 }; // сверху оставлено место под панель масштаба
  const vw = W + pad.l + pad.r, vh = 3 * (H + 34) + pad.t;
  const xs = Array.from(r.x);
  const s = [`<svg viewBox="0 0 ${vw} ${vh}" role="img" aria-label="Эпюры">`];
  s.push(chart(`ЭПЮРА M · ${el.title}${vertical ? ' · по высоте от базы' : ' · на растянутом волокне'}`,
    xs, Array.from(r.M), W, H, pad.l, pad.t, 'var(--accent-2)', 'кН·м', 1e-6, true));
  s.push(chart(vertical ? 'ПОПЕРЕЧНАЯ СИЛА' : 'ЭПЮРА Q', xs, Array.from(r.V), W, H, pad.l, pad.t + H + 34, 'var(--u-ok)', 'кН', 1e-3));
  s.push(chart(vertical ? 'ГОРИЗОНТАЛЬНОЕ СМЕЩЕНИЕ' : 'ПРОГИБ (нормативные нагрузки)',
    xs, Array.from(sls.w), W, H, pad.l, pad.t + 2 * (H + 34), 'var(--u-warn)', 'мм', 1));
  for (const sup of r.reactions) {
    const x = pad.l + (W * sup.x) / xs[xs.length - 1];
    s.push(`<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${vh - 8}" stroke="var(--ink-3)" stroke-dasharray="2 4" opacity=".7"/>`);
    s.push(`<text x="${x + 3}" y="${vh - 2}" font-size="9" font-family="${mono}" fill="var(--ink-3)">${f2(sup.R / 1000)} кН</text>`);
    if (vertical) s.push(`<text x="${x + 3}" y="${vh - 12}" font-size="8.5" font-family="${mono}" fill="var(--ink-3)">${Math.round(sup.x)}</text>`);
  }
  s.push('</svg>');
  return { svg: s.join(''), meta: null };
}

/** Элемент, выбранный в интерфейсе. */
export function pickElement(res, sel) {
  if (sel.type === 'rafter') {
    const r = res.rafters[sel.index] ?? res.rafters[0];
    return r && { ...r, title: `СТРОПИЛО ${(sel.index ?? 0) + 1}`, kind: 'rafter' };
  }
  if (sel.type === 'purlin') return { ...res.purlin, title: 'ПРОГОН', kind: 'purlin' };
  if (sel.type === 'wallPurlin') return { ...res.wallPurlin, title: 'ОБВЯЗКА У СТЕНЫ', kind: 'wallPurlin' };
  if (sel.type === 'wallPost') {
    const p = res.wallPosts[sel.index] ?? res.wallPosts[0];
    return p && { ...p, title: `СТОЛБ У СТЕНЫ ${(sel.index ?? 0) + 1}`, kind: 'wallPost', res: { uls: p.diagram, sls: p.diagram } };
  }
  if (sel.type === 'battens') return { ...res.battens, title: 'ОБРЕШЁТКА', res: { uls: res.battens.res.uls, sls: res.battens.res.sls }, kind: 'battens' };
  if (sel.type === 'post') {
    const p = res.posts[sel.index] ?? res.posts[0];
    return p && { ...p, title: `СТОЛБ ${(sel.index ?? 0) + 1}`, kind: 'post', res: { uls: p.diagram, sls: p.diagram } };
  }
  if (sel.type === 'base') {
    const b = res.bases[sel.side ?? 'outer'];
    return b && { ...b, kind: 'base', sec: { label: b.base.short },
      title: sel.side === 'wall' ? 'БАЗА СТОЛБА У СТЕНЫ' : 'БАЗА НАРУЖНОГО СТОЛБА' };
  }
  if (sel.type === 'beamTie') {
    const t = res.beamTies[sel.side ?? 'outer'];
    return t && { ...t, kind: 'beamTie', sec: { label: t.tie.short },
      title: sel.side === 'wall' ? 'УЗЕЛ: ОБВЯЗКА — СТОЛБ' : 'УЗЕЛ: ПРОГОН — СТОЛБ' };
  }
  if (sel.type === 'tie') {
    const t = res.ties[sel.side ?? 'outer'];
    return t && { ...t, kind: 'tie', sec: t.fastener,
      title: sel.side === 'wall' ? 'УЗЕЛ: СТРОПИЛО — ОБВЯЗКА' : 'УЗЕЛ: СТРОПИЛО — ПРОГОН' };
  }
  return null;
}

export { f2, esc };

/* ──────────────────────── УЗЛЫ ──────────────────────── */

/**
 * Узловые чертежи: то, что распечатывают и везут на объект.
 *
 * Всё рисуется по числам расчёта, а не «примерно»: крепежей ровно столько,
 * сколько посчитано, шаги между ними — расчётные, катет шва и разнос анкеров
 * подписаны теми значениями, которые проверены.
 */
const RULE = 'var(--rule-2)';

/** Рамка детали с заголовком и подписью-вердиктом. */
function detailFrame(box, title, caption, U) {
  const { x, y, w, h } = box;
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--surface)" stroke="${RULE}"/>
    <rect x="${x}" y="${y}" width="${w}" height="22" fill="var(--surface-2)" stroke="${RULE}"/>
    <text x="${x + 9}" y="${y + 15}" font-size="10" font-family="${mono}" fill="var(--ink-2)" letter-spacing="1.1">${esc(title)}</text>
    <text x="${x + w - 9}" y="${y + 15}" font-size="10.5" font-family="${mono}" text-anchor="end" fill="${uColor(U)}">U ${f2(U)}</text>
    <text x="${x + 9}" y="${y + h - 9}" font-size="10" font-family="${mono}" fill="var(--ink-3)">${esc(caption)}</text>
  </g>`;
}

/** Рабочее поле детали: внутри рамки, без заголовка и подписи. */
const inner = (box) => ({ x: box.x + 10, y: box.y + 28, w: box.w - 20, h: box.h - 56 });

/**
 * Узел «стропило — опора»: уголок с крепежом в расчётном количестве.
 *
 * Вид вдоль опоры, поэтому она показана в сечении: прогон — труба 80×140,
 * обвязка — доска на ребро. Стропило лежит на верхней грани и опирается на
 * дальнее ребро — при уклоне 8° на ширине опоры остаётся клиновидный зазор
 * миллиметров в десять, его и выбирают запилом или подкладкой.
 */
function nodeRafterTie(t, rafterSec, alpha, box, clip) {
  const p = inner(box);
  const supB = t.support.b, supH = t.support.h, rH = rafterSec.h;
  const up = 300, down = 110;                        // сколько стропила показать в обе стороны
  const sc = Math.min(p.w / (up + down + supB + 40), p.h / (rH + supH + 70));
  const mm = (v) => v * sc;
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h - mm(supH) - 26;              // верх опоры
  const pivot = cx + mm(supB / 2);                   // дальнее ребро опоры — точка опирания
  const s = [`<g clip-path="url(#${clip})">`];

  // опора в сечении
  s.push(`<rect x="${cx - mm(supB / 2)}" y="${cy}" width="${mm(supB)}" height="${mm(supH)}"
    fill="var(--sunk)" stroke="var(--ink)" stroke-width="1.3"/>`);
  s.push(dimH(cx - mm(supB / 2), cx + mm(supB / 2), cy + mm(supH) + 16, `${supB}`));
  s.push(`<text x="${cx + mm(supB / 2) + 8}" y="${cy + mm(supH) - 2}" font-size="9" font-family="${mono}" fill="var(--ink-3)">${esc(t.support.label)}</text>`);

  // стропило: опирается на дальнее ребро и уходит вверх к стене
  const leg = 90, legDown = 65;
  const ax = pivot - mm(legDown);                    // уголок ставится со стороны пролёта
  const rot = [];
  rot.push(`<rect x="${pivot - mm(up)}" y="${cy - mm(rH)}" width="${mm(up + down)}" height="${mm(rH)}"
    fill="var(--surface-2)" stroke="var(--ink)" stroke-width="1.3"/>`);
  rot.push(`<rect x="${ax}" y="${cy - mm(leg)}" width="3" height="${mm(leg)}" fill="var(--accent-2)"/>`);
  const nails = [];
  let left = t.need;
  for (let r = 0; r < t.fit.rows && left > 0; r++) {
    for (let c = 0; c < t.fit.cols && left > 0; c++, left--) {
      nails.push([ax + 9 + mm(c * t.spacing.s1), cy - mm(leg) + mm(14 + r * t.spacing.s2)]);
    }
  }
  for (const [nx, ny] of nails) rot.push(`<circle cx="${nx}" cy="${ny}" r="2.4" fill="var(--u-bad)"/>`);
  if (nails.length > 1) rot.push(dimV(nails[0][1], nails[1][1], ax + 32, `${Math.round(t.spacing.s2)}`));
  if (t.need > t.fit.n) {
    // нарисовано столько, сколько влезает; расчёт требует больше — это и есть отказ
    rot.push(`<text x="${ax}" y="${cy - mm(leg) - 8}" font-size="9" font-family="${mono}" fill="var(--u-bad)">нужно ${t.need}, влезает ${t.fit.n}</text>`);
  }
  // уклон вниз к свесу: поворот по часовой вокруг точки опирания
  s.push(`<g transform="rotate(${alpha} ${pivot} ${cy})">${rot.join('')}</g>`);

  // нижняя полка уголка — по верху опоры
  s.push(`<rect x="${ax}" y="${cy}" width="${mm(legDown)}" height="3" fill="var(--accent-2)"/>`);
  s.push(`<text x="${p.x + 2}" y="${p.y + 12}" font-size="9" font-family="${mono}" fill="var(--ink-3)">стропило ${esc(rafterSec.label)}, уклон ${alpha}°</text>`);
  if (alpha > 0) {
    const gap = Math.round(supB * Math.tan((alpha * Math.PI) / 180));
    s.push(`<text x="${p.x + 2}" y="${p.y + p.h - 1}" font-size="9" font-family="${mono}" fill="var(--ink-3)">опирание на дальнее ребро, зазор от уклона ≈ ${gap} мм — запил или подкладка</text>`);
  }

  // отрыв — справа, чтобы не спорить с подписями
  const arrowX = p.x + p.w - 12;
  s.push(`<g pointer-events="none">
    <line x1="${arrowX}" y1="${p.y + 34}" x2="${arrowX}" y2="${p.y + 14}" stroke="var(--u-bad)" stroke-width="1.6"/>
    <path d="M${arrowX - 4},${p.y + 20} L${arrowX},${p.y + 11} L${arrowX + 4},${p.y + 20} z" fill="var(--u-bad)"/>
    <text x="${arrowX - 7}" y="${p.y + 20}" font-size="9.5" text-anchor="end" font-family="${mono}" fill="var(--u-bad)">отрыв ${f2(t.force / 1000)} кН</text>
  </g>`);
  s.push('</g>');
  return s.join('');
}

/** Узел «прогон — столб»: сварка по контуру или пластина с болтами. */
function nodeBeamTie(t, box, clip) {
  const p = inner(box);
  const postB = t.post.b, beamH = t.beam.h, beamW = 300, postShow = 150;
  const sc = Math.min(p.w / (beamW + 60), p.h / (beamH + postShow + 60));
  const mm = (v) => v * sc;
  const cx = p.x + p.w / 2;
  const base = p.y + p.h - 14;
  const top = base - mm(postShow);                    // оголовок столба
  const s = [`<g clip-path="url(#${clip})">`];

  s.push(`<rect x="${cx - mm(postB / 2)}" y="${top}" width="${mm(postB)}" height="${mm(postShow)}"
    fill="var(--surface-2)" stroke="var(--ink)" stroke-width="1.3"/>`);
  s.push(`<text x="${cx}" y="${base + 11}" font-size="9" text-anchor="middle" font-family="${mono}" fill="var(--ink-3)">столб ${esc(t.post.label)}</text>`);

  const plT = t.welded ? 0 : 8;
  const beamY = top - mm(plT) - mm(beamH);
  if (!t.welded) {
    const pl = t.plate ?? postB + 80;
    s.push(`<rect x="${cx - mm(pl / 2)}" y="${top - mm(plT)}" width="${mm(pl)}" height="${mm(plT)}"
      fill="var(--accent-soft)" stroke="var(--accent-2)" stroke-width="1.2"/>`);
  }
  s.push(`<rect x="${cx - mm(beamW / 2)}" y="${beamY}" width="${mm(beamW)}" height="${mm(beamH)}"
    fill="var(--sunk)" stroke="var(--ink)" stroke-width="1.3"/>`);
  s.push(`<text x="${cx - mm(beamW / 2)}" y="${beamY - 6}" font-size="9" font-family="${mono}" fill="var(--ink-3)">${esc(t.beam.label)}</text>`);

  if (t.welded) {
    const kf = Math.max(5, mm(t.tie.kf) * 4);
    for (const sgn of [-1, 1]) {
      const x = cx + sgn * mm(postB / 2);
      s.push(`<path d="M${x},${top} L${x + sgn * kf},${top} L${x},${top - kf} z" fill="var(--u-warn)" stroke="var(--u-warn)"/>`);
    }
    const lx = cx + mm(postB / 2) + 8;
    s.push(`<line x1="${lx}" y1="${top - 4}" x2="${lx + 26}" y2="${top - 22}" stroke="var(--ink-3)"/>`);
    s.push(`<text x="${lx + 29}" y="${top - 22}" font-size="9" font-family="${mono}" fill="var(--ink-2)">k = ${t.tie.kf}</text>`);
  } else {
    const span = Math.max(80, (t.plate ?? postB + 80) - 80);
    for (const sgn of [-1, 1]) {
      const x = cx + sgn * mm(span / 2);
      s.push(`<line x1="${x}" y1="${beamY - 5}" x2="${x}" y2="${top + 5}" stroke="var(--u-bad)" stroke-width="2"/>`);
      s.push(`<circle cx="${x}" cy="${beamY - 7}" r="2.6" fill="var(--u-bad)"/>`);
    }
    s.push(dimH(cx - mm(span / 2), cx + mm(span / 2), top + 24, `${Math.round(span)}`));
  }

  const arrowX = p.x + p.w - 12;
  s.push(`<g pointer-events="none">
    <line x1="${arrowX}" y1="${p.y + 32}" x2="${arrowX}" y2="${p.y + 12}" stroke="var(--u-bad)" stroke-width="1.6"/>
    <path d="M${arrowX - 4},${p.y + 18} L${arrowX},${p.y + 9} L${arrowX + 4},${p.y + 18} z" fill="var(--u-bad)"/>
    <text x="${arrowX - 7}" y="${p.y + 18}" font-size="9.5" text-anchor="end" font-family="${mono}" fill="var(--u-bad)">отрыв ${f2(t.uplift / 1000)} кН</text>
  </g>`);
  s.push('</g>');
  return s.join('');
}

/** База столба: плита с анкерами либо заделка в бетон. */
function nodeBase(b, box, clip) {
  const p = inner(box);
  const isPlate = b.base.kind === 'plate';
  const deep = isPlate ? b.base.hef + 80 : b.base.embed;
  const wide = isPlate ? b.base.plate + 200 : b.side;
  const postShow = 130;
  const sc = Math.min(p.w / (wide + 70), p.h / (deep + postShow + 30));
  const mm = (v) => v * sc;
  const cx = p.x + p.w / 2;
  const ground = p.y + p.h - mm(deep) - 16;
  const s = [`<g clip-path="url(#${clip})">`];

  s.push(`<rect x="${cx - mm(wide / 2)}" y="${ground}" width="${mm(wide)}" height="${mm(deep)}"
    fill="url(#nodeHatch)" stroke="var(--ink)" stroke-width="1.3"/>`);
  s.push(`<line x1="${cx - mm(wide / 2) - 10}" y1="${ground}" x2="${cx + mm(wide / 2) + 10}" y2="${ground}" stroke="var(--ink)" stroke-width="1.6"/>`);

  const postTop = ground - mm(postShow);
  if (isPlate) {
    s.push(`<rect x="${cx - mm(b.post.b / 2)}" y="${postTop}" width="${mm(b.post.b)}" height="${mm(postShow) - mm(b.base.t)}"
      fill="var(--surface-2)" stroke="var(--ink)" stroke-width="1.3"/>`);
    s.push(`<rect x="${cx - mm(b.base.plate / 2)}" y="${ground - mm(b.base.t)}" width="${mm(b.base.plate)}" height="${Math.max(3, mm(b.base.t))}"
      fill="var(--accent-soft)" stroke="var(--accent-2)" stroke-width="1.2"/>`);
    for (const sgn of [-1, 1]) {
      const x = cx + sgn * mm(b.span / 2);
      s.push(`<line x1="${x}" y1="${ground - mm(b.base.t) - 6}" x2="${x}" y2="${ground + mm(b.base.hef)}" stroke="var(--u-bad)" stroke-width="2.2"/>`);
      s.push(`<path d="M${x},${ground + mm(b.base.hef)} L${x + sgn * mm(45)},${ground + mm(b.base.hef)}" stroke="var(--u-bad)" stroke-width="2.2" fill="none"/>`);
    }
    s.push(dimH(cx - mm(b.span / 2), cx + mm(b.span / 2), ground + mm(b.base.hef) + 18, `разнос ${b.span}`));
    s.push(dimV(ground, ground + mm(b.base.hef), cx + mm(wide / 2) + 18, `${b.base.hef}`));
  } else {
    s.push(`<rect x="${cx - mm(b.post.b / 2)}" y="${postTop}" width="${mm(b.post.b)}" height="${mm(postShow) + mm(b.base.embed) - mm(60)}"
      fill="var(--surface-2)" stroke="var(--ink)" stroke-width="1.3"/>`);
    s.push(dimV(ground, ground + mm(b.base.embed), cx + mm(wide / 2) + 18, `${b.base.embed}`));
    s.push(dimH(cx - mm(wide / 2), cx + mm(wide / 2), ground + mm(deep) + 16, `${b.side}`));
    s.push(`<text x="${p.x}" y="${p.y + p.h}" font-size="9" font-family="${mono}" fill="var(--u-bad)">блок ${Math.round(b.mass)} кг · нужно ${Math.round(b.uplift / 0.9 / 9.80665)} кг</text>`);
  }
  s.push(`<text x="${cx + mm(b.post.b / 2) + 6}" y="${postTop + 12}" font-size="9" font-family="${mono}" fill="var(--ink-3)">${esc(b.post.label)}</text>`);
  s.push('</g>');
  return s.join('');
}

export function drawNodes(res, sel) {
  const m = res.model;
  const alpha = m.geom.alpha;
  const rafterSec = res.rafters[0].sec;
  const W = 1080, H = 660, pad = { l: 16, t: 44 };
  const bw = (W - pad.l * 2 - 2 * 18) / 3, bh = (H - pad.t - 16 - 18) / 2;
  const clips = [];
  const s = [`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Узловые чертежи">`];
  s.push(`<defs><pattern id="nodeHatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
    <rect width="7" height="7" fill="var(--sunk)"/><line x1="0" y1="0" x2="0" y2="7" stroke="var(--ink-3)" stroke-width="1"/></pattern></defs>`);
  s.push(`<text x="${pad.l}" y="26" font-size="10.5" font-family="${mono}" fill="var(--ink-2)" letter-spacing="1.3">УЗЛЫ · всё по числам расчёта: крепежей столько, сколько посчитано, шаги и размеры расчётные</text>`);

  const rows = [
    { side: 'outer', label: 'наружный ряд', tie: res.ties.outer, beam: res.beamTies.outer, base: res.bases.outer },
    { side: 'wall', label: 'у стены', tie: res.ties.wall, beam: res.beamTies.wall, base: res.bases.wall },
  ];
  rows.forEach((row, r) => {
    const y = pad.t + r * (bh + 18);
    const boxes = [0, 1, 2].map((c) => ({ x: pad.l + c * (bw + 18), y, w: bw, h: bh }));

    const detail = (box, pick, title, caption, U, draw) => {
      const id = `clip-${pick}-${row.side}`;
      const p = inner(box);
      clips.push(`<clipPath id="${id}"><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/></clipPath>`);
      return `<g class="pickable" data-pick="${pick}" data-side="${row.side}">`
        + detailFrame(box, title, caption, U) + draw(id)
        + `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="transparent"/></g>`;
    };

    s.push(detail(boxes[0], 'tie', `1.${r + 1} СТРОПИЛО — ${row.side === 'wall' ? 'ОБВЯЗКА' : 'ПРОГОН'}`,
      `${row.tie.need} × ${row.tie.fastener.short}${row.tie.fastener.kind === 'bolt' ? '' : ' · два уголка'}`,
      row.tie.U, (c) => nodeRafterTie(row.tie, rafterSec, alpha, boxes[0], c)));

    s.push(detail(boxes[1], 'beamTie', `2.${r + 1} ${row.side === 'wall' ? 'ОБВЯЗКА' : 'ПРОГОН'} — СТОЛБ`,
      row.beam.welded ? `сварка по контуру, катет ${row.beam.tie.kf} мм` : `${row.beam.n} × М${row.beam.tie.d} через пластину`,
      row.beam.U, (c) => nodeBeamTie(row.beam, boxes[1], c)));

    s.push(detail(boxes[2], 'base', `3.${r + 1} БАЗА · ${row.label.toUpperCase()}`,
      row.base.base.kind === 'plate'
        ? `плита ${row.base.base.plate}×${row.base.base.plate}, ${row.base.base.n} × М${row.base.base.d}`
        : `заделка ${row.base.base.embed} мм, подошва ${row.base.side} мм`,
      row.base.U, (c) => nodeBase(row.base, boxes[2], c)));
  });

  s.splice(1, 0, `<defs>${clips.join('')}</defs>`);
  s.push('</svg>');
  return { svg: s.join(''), meta: null };
}
