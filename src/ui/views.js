/** Отрисовка: план, разрез, эпюры. Чистые функции — строка SVG + метрика для попадания курсора. */
import { levels } from '../core/model.js';
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
    const dl = `снеговой мешок · μ = ${f2(res.snow.muWall)} · ${f2(res.snow.muWall * res.snow.Sg)} кПа`;
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
  s.push(`<rect x="${X(-420)}" y="${Y(lv.houseRoof + 500)}" width="${420 * sc}" height="${(lv.houseRoof + 500) * sc}" fill="var(--sunk)" stroke="var(--rule-2)"/>`);
  s.push(`<text transform="translate(${X(-210)},${Y(lv.postTop * 0.3)}) rotate(-90)" font-size="11" text-anchor="middle" font-family="${mono}" fill="var(--ink-3)">ДОМ</text>`);

  // ── размерная цепочка слева
  const xDim = X(-420) - 30;
  s.push(`<line x1="${xDim - 6}" y1="${Y(lv.houseRoof)}" x2="${X(0)}" y2="${Y(lv.houseRoof)}" stroke="var(--ink-2)" stroke-width="2"/>`);
  for (const hv of [0, lv.canopyTopWall]) {
    s.push(`<line x1="${xDim - 6}" y1="${Y(hv)}" x2="${X(120)}" y2="${Y(hv)}" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="4 3" opacity=".7" pointer-events="none"/>`);
  }
  s.push(dimV(Y(0), Y(lv.canopyTopWall), xDim, `${Math.round(lv.canopyTopWall)} до верха навеса`, 'var(--u-warn)'));
  s.push(dimV(Y(lv.canopyTopWall), Y(lv.houseRoof), xDim, `перепад ${g.driftH}`, 'var(--u-bad)'));

  // ── снег: эпюра лежит на верхней кромке стропил
  const kPa = 1000 * sc * 0.9;
  const top = (x) => lv.canopyTopWall - x * tg;
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const x = (total * i) / 24;
    pts.push(`${X(x)},${Y(top(x) + res.snow.at(x) * kPa)}`);
  }
  s.push(`<polygon points="${X(0)},${Y(top(0))} ${pts.join(' ')} ${X(total)},${Y(top(total))}" fill="var(--u-bad)" fill-opacity=".18" stroke="var(--u-bad)" stroke-width="1" pointer-events="none"/>`);
  s.push(`<text x="${X(150)}" y="${Y(top(0) + res.snow.at(0) * kPa) - 7}" font-size="10" font-family="${mono}" fill="var(--u-bad)">снег ${f2(res.snow.at(0))} → ${f2(res.snow.at(total))} кПа</text>`);

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
  for (let i = 0; i < nb; i++) {
    const hy = (lv.wallPostTop * (i + 0.6)) / (nb + 0.2);
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

export function drawDiagrams(res, sel) {
  const el = pickElement(res, sel);
  if (!el || !el.res) return { svg: '<svg viewBox="0 0 100 40"></svg>', meta: null };
  const r = el.res.uls ?? el.res['ULS-1'];
  const sls = el.res.sls ?? el.res.SLS;
  const W = 720, H = 84, pad = { l: 46, r: 26, t: 26 };
  const vw = W + pad.l + pad.r, vh = 3 * (H + 34) + pad.t;
  const xs = Array.from(r.x);
  const s = [`<svg viewBox="0 0 ${vw} ${vh}" role="img" aria-label="Эпюры">`];
  s.push(chart(`ЭПЮРА M · ${el.title} · на растянутом волокне`, xs, Array.from(r.M), W, H, pad.l, pad.t, 'var(--accent-2)', 'кН·м', 1e-6, true));
  s.push(chart('ЭПЮРА Q', xs, Array.from(r.V), W, H, pad.l, pad.t + H + 34, 'var(--u-ok)', 'кН', 1e-3));
  s.push(chart('ПРОГИБ (нормативные нагрузки)', xs, Array.from(sls.w), W, H, pad.l, pad.t + 2 * (H + 34), 'var(--u-warn)', 'мм', 1));
  for (const sup of r.reactions) {
    const x = pad.l + (W * sup.x) / xs[xs.length - 1];
    s.push(`<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${vh - 8}" stroke="var(--ink-3)" stroke-dasharray="2 4" opacity=".7"/>`);
    s.push(`<text x="${x + 3}" y="${vh - 2}" font-size="9" font-family="${mono}" fill="var(--ink-3)">${f2(sup.R / 1000)} кН</text>`);
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
    return p && { ...p, title: `СТОЛБ У СТЕНЫ ${(sel.index ?? 0) + 1}`, kind: 'wallPost', res: null };
  }
  if (sel.type === 'battens') return { ...res.battens, title: 'ОБРЕШЁТКА', res: { uls: res.battens.res.uls, sls: res.battens.res.sls }, kind: 'battens' };
  if (sel.type === 'post') {
    const p = res.posts[sel.index] ?? res.posts[0];
    return p && { ...p, title: `СТОЛБ ${(sel.index ?? 0) + 1}`, kind: 'post', res: null };
  }
  return null;
}

export { f2, esc };
