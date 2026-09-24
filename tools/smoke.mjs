/**
 * Смоук-тест интерфейса в настоящем браузере.
 *
 * Тесты ядра не видят того, что собирается в браузере: отчёт, инспектор,
 * чертежи узлов, подбор по цене, миграцию старых ссылок. Кнопка «Отчёт»
 * однажды падала неделю (#35), и ни один тест этого не заметил. Здесь
 * страница открывается в Chrome и проходится целиком: вкладки, карточки,
 * каждое поле панели, кнопки, ключевые сценарии, справка. Любое исключение
 * или console.error — падение с шагом, на котором оно случилось.
 *
 * Никаких зависимостей, как и у всего проекта: Chrome управляется по
 * протоколу отладки (CDP) через встроенный в Node 22 WebSocket, страницы
 * отдаёт node:http. Chrome берётся из переменной CHROME или ищется на
 * обычных местах — на раннерах GitHub он уже установлен.
 *
 *   npm run smoke
 *   CHROME=/path/to/chrome npm run smoke
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, extname, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// скриншоты для глазной сверки: CI выкладывает папку артефактом прогона
const shots = join(root, 'smoke-shots');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
};

/* ───────────── окружение: сервер и браузер ───────────── */

function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(root, path || 'index.html');
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const list = [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && existsSync(pw)) {
    for (const d of readdirSync(pw)) if (d.startsWith('chromium-')) list.push(join(pw, d, 'chrome-linux', 'chrome'));
  }
  return list.find((p) => existsSync(p));
}

/** Сколько ждать, пока Chrome откроет порт отладки, мс. */
const LAUNCH_WAIT = 45000;

/**
 * Chrome с портом отладки. Порт узнаётся двумя путями, какой раньше: по строке
 * «DevTools listening» в stderr и по файлу DevToolsActivePort, который Chrome
 * пишет в профиль, когда порт уже слушает. На раннерах GitHub строка в stderr
 * иногда не приходила за 20 с, и смоук падал до первого шага (прогоны #20 и
 * #23), а повтор проходил. Если порта нет и за LAUNCH_WAIT, в ошибке — хвост
 * stderr: по нему видно, на чём браузер встал.
 */
async function launch(chrome, profile) {
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--disable-dev-shm-usage',
    '--password-store=basic', '--use-mock-keychain', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--window-size=1400,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let buf = '';
  proc.stderr.on('data', (d) => { buf += d; });
  const port = await new Promise((ok, fail) => {
    const started = Date.now();
    // опрос асинхронный, и следующий тик может прийти, когда исход уже известен
    let settled = false;
    const done = (fn) => { if (settled) return; settled = true; clearInterval(poll); proc.off('exit', onExit); fn(); };
    const onExit = (code) => done(() => fail(new Error(`Chrome завершился с кодом ${code}: ${buf.slice(-600)}`)));
    proc.on('exit', onExit);
    const poll = setInterval(async () => {
      const m = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) { done(() => ok(m[1])); return; }
      const file = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      if (/^\d+\n/.test(file)) { done(() => ok(file.split('\n')[0])); return; }
      if (Date.now() - started > LAUNCH_WAIT) {
        done(() => {
          proc.kill('SIGKILL');
          fail(new Error(`Chrome не открыл порт отладки за ${LAUNCH_WAIT / 1000} с. `
            + `stderr: ${buf.slice(-600).trim() || '(пусто)'}`));
        });
      }
    }, 100);
  });
  return { proc, port };
}

/**
 * Запуск браузера с одной повторной попыткой на чистом профиле. Повторяется
 * только старт Chrome, до первого шага теста: сами проверки не повторяются
 * никогда, упавший шаг — это ошибка.
 */
async function startBrowser(chrome) {
  for (let attempt = 1; ; attempt++) {
    const profile = await mkdtemp(join(tmpdir(), 'canopycraft-smoke-'));
    try {
      return { ...(await launch(chrome, profile)), profile };
    } catch (e) {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
      if (attempt >= 2) throw e;
      console.error(`${e.message}\nЗапускаю Chrome ещё раз.`);
    }
  }
}

/** Вкладка браузера по протоколу отладки. */
async function openPage(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { ok, fail } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) fail(new Error(`${m.error.message}`)); else ok(m.result);
    } else if (m.method) {
      for (const l of listeners) l(m.method, m.params);
    }
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

/* ───────────── сам тест ───────────── */

const failures = [];
let stepName = 'запуск';
const fail = (what) => failures.push(`[${stepName}] ${what}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('Chrome не найден. Укажите путь в переменной CHROME.');
    process.exit(2);
  }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { proc, port, profile } = await startBrowser(chrome);
  const started = Date.now();

  try {
    const page = await openPage(port);
    const { send } = page;
    page.on((method, p) => {
      if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails;
        fail(`исключение: ${d.exception?.description ?? d.text}`.split('\n').slice(0, 3).join(' | '));
      }
      if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        fail(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
      }
      // «Ссылка на расчёт» без доступа к буферу обмена показывает prompt —
      // окно надо закрыть, иначе страница встанет
      if (method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    await send('Runtime.enable');
    await send('Page.enable');

    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result?.value;
    };
    const waitFor = async (expr, ms, what) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (await ev(expr).catch(() => false)) return true;
        await wait(100);
      }
      fail(`не дождался: ${what}`);
      return false;
    };
    const step = async (name, fn) => {
      stepName = name;
      const before = failures.length;
      try { await fn(); } catch (e) { fail(e.message.split('\n')[0]); }
      console.log(`${failures.length > before ? '✗' : '✓'} ${name}`);
    };
    const open = async (path) => {
      await send('Page.navigate', { url: `${base}/${path}` });
      await waitFor("document.readyState === 'complete'", 15000, `загрузка ${path}`);
    };
    const appReady = () => waitFor("/U/.test(document.getElementById('verdict-pill')?.textContent ?? '')", 15000, 'вердикт в шапке');
    // печать и буфер обмена в безголовом браузере не нужны
    const stubs = "window.print = () => {};";

    await step('страница открывается', async () => {
      await open('index.html');
      await appReady();
      await ev(stubs);
      const cards = await ev("document.querySelectorAll('#summary [data-sel]').length");
      if (cards < 8) fail(`в сводке ${cards} карточек`);
    });

    // обход всего, что открывается кликом: вкладки, карточки сводки в каждой
    // вкладке, детали плана и узлов. Повторяется после каждого сценария —
    // крест, мороз и подбор добавляют карточки и детали, которых раньше не было
    const visitAll = async () => {
      for (const tab of ['tab-plan', 'tab-section', 'tab-diagrams', 'tab-nodes']) {
        await ev(`document.getElementById('${tab}').click()`);
        if (!(await ev("!!document.querySelector('#canvas svg')"))) fail(`${tab}: нет чертежа`);
        const keys = await ev("[...document.querySelectorAll('#summary [data-sel]')].map((c) => c.getAttribute('data-sel'))");
        for (const k of keys) {
          await ev(`document.querySelector('#summary [data-sel="${k}"]').click()`);
          if (!(await ev("document.getElementById('inspector').textContent.trim().length > 0"))) fail(`${tab}, ${k}: пустой инспектор`);
        }
      }
      for (const tab of ['tab-plan', 'tab-nodes']) {
        await ev(`document.getElementById('${tab}').click()`);
        const n = await ev("document.querySelectorAll('#canvas [data-pick]').length");
        for (let i = 0; i < n; i++) {
          await ev(`(() => {
            const g = document.querySelectorAll('#canvas [data-pick]')[${i}];
            if (!g) return;
            g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
          })()`);
          // эпюры выбранного элемента
          await ev("document.getElementById('tab-diagrams').click()");
          await ev(`document.getElementById('${tab}').click()`);
        }
      }
      await ev("document.getElementById('tab-plan').click()");
    };

    await step('вкладки, карточки сводки, детали плана и узлов', visitAll);

    await step('каждое поле панели', async () => {
      await ev("document.getElementById('tab-plan').click()");
      const fields = await ev(`[...document.querySelectorAll('#params select, #params-right select, #params input, #params-right input')]
        .filter((el) => el.id).map((el) => ({ id: el.id, type: el.tagName === 'SELECT' ? 'select' : el.type,
          options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value) : null, min: el.min, max: el.max }))`);
      if (fields.length < 30) fail(`полей в панели ${fields.length}`);
      for (const f of fields) {
        let values;
        if (f.type === 'select') {
          // из длинных списков сортамента — каждый восьмой и крайние
          values = f.options.length > 12 ? f.options.filter((_, i, a) => i % 8 === 0 || i === a.length - 1) : f.options;
        } else if (f.type === 'range') values = [f.min, f.max];
        else if (f.type === 'number') values = ['0', '1000'];
        else if (f.type === 'checkbox') values = ['toggle', 'toggle'];
        else continue;
        const was = await ev(`(() => { const el = document.getElementById('${f.id}'); return el.type === 'checkbox' ? el.checked : el.value; })()`);
        for (const v of [...values, 'restore']) {
          await ev(`(() => {
            const el = document.getElementById('${f.id}');
            if (!el) return;
            const v = ${JSON.stringify(v)};
            if (el.type === 'checkbox') el.checked = v === 'restore' ? ${JSON.stringify(was)} : !el.checked;
            else el.value = v === 'restore' ? ${JSON.stringify(was)} : v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
        }
        if (!(await ev("/U/.test(document.getElementById('verdict-pill').textContent)"))) fail(`${f.id}: вердикт пропал`);
      }
    });

    await step('кнопки «подобрать» у полей', async () => {
      const n = await ev("document.querySelectorAll('[data-act], [data-pick-el]').length");
      for (let i = 0; i < n; i++) {
        await ev(`document.querySelectorAll('[data-act], [data-pick-el]')[${i}].click()`);
        await wait(40);
      }
      await waitFor("![...document.querySelectorAll('[data-act], [data-pick-el]')].some((b) => b.textContent === '…')", 20000, 'кнопки подбора отработали');
    });

    await step('отчёт, ссылка, тема, масштаб', async () => {
      await ev(stubs);
      await ev("document.getElementById('btn-report').click()");
      if (!(await ev("document.querySelectorAll('#report h2').length >= 5"))) fail('отчёт не собрался');
      // по распечатке вариант должен открываться снова: версия и ссылка с моделью
      const ver = await ev("document.getElementById('app-version').textContent");
      if (!/^v\d+\.\d+\.\d+$/.test(ver)) fail(`версия в подвале: «${ver}»`);
      if (!(await ev(`document.getElementById('report').textContent.includes('CanopyCraft ${ver}')`))) fail('в отчёте нет версии');
      const link = await ev("document.querySelector('#report .report-link a')?.getAttribute('href') ?? ''");
      if (!link.includes('#p=')) fail(`в отчёте нет ссылки на расчёт: «${link}»`);
      await ev("document.getElementById('btn-link').click()");
      await wait(300);
      for (const id of ['btn-theme', 'btn-theme', 'zoom-in', 'zoom-out', 'zoom-reset']) await ev(`document.getElementById('${id}').click()`);
    });

    await step('«Подобрать всё»', async () => {
      await ev("document.getElementById('btn-pick-all').click()");
      await waitFor("document.getElementById('btn-pick-all').textContent === 'Подобрать всё'", 30000, 'подбор всего');
    });

    await step('подбор по цене и применение варианта', async () => {
      await ev("document.getElementById('btn-cost-search').click()");
      if (await waitFor("!!document.querySelector('#search [data-apply]')", 60000, 'варианты подбора')) {
        await ev("document.querySelector('#search [data-apply]').click()");
        await wait(300);
        await visitAll();
      }
    });

    await step('крест в ряду', async () => {
      await ev("(() => { const el = document.getElementById('c_bracing_along'); el.value = 'cross'; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
      if (!(await ev("!!document.querySelector('#summary [data-sel=\"bracing\"]')"))) fail('нет карточки «Связи ряда»');
      await ev("document.getElementById('tab-nodes').click()");
      if (!(await ev("[...document.querySelectorAll('#canvas svg text')].some((t) => /СВЯЗЬ/.test(t.textContent))"))) fail('нет чертежа креста');
      await visitAll();
    });

    await step('диагонали в плоскости кровли', async () => {
      await ev("(() => { const el = document.getElementById('c_bracing_along'); el.value = 'roof'; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
      if (!(await ev("/кровле/.test(document.querySelector('#summary [data-sel=\"bracing\"]')?.textContent ?? '')"))) fail('нет карточки «Связи по кровле»');
      await ev("document.getElementById('tab-nodes').click()");
      if (!(await ev("[...document.querySelectorAll('#canvas svg text')].some((t) => /СВЯЗИ ПО КРОВЛЕ/.test(t.textContent))"))) fail('нет чертежа ячейки');
      for (const bays of ['1', '3', '2']) {
        await ev(`(() => { const el = document.getElementById('c_bracing_roofBays'); el.value = '${bays}'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      }
      await visitAll();
      await ev(stubs);
      await ev("document.getElementById('btn-report').click()");
      if (!(await ev("/плоскости кровли/.test(document.getElementById('report').textContent)"))) fail('в отчёте нет связей по кровле');
    });

    await step('мороз: пучение и замена грунта', async () => {
      const set = (id, v) => ev(`(() => { const el = document.getElementById('${id}'); el.value = '${v}'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await set('c_site_frostDepth', '1200');
      await set('c_site_soil', 'clay');
      await set('c_postBase_antiHeave', 'none');
      if (!(await ev("/выдавит/.test(document.getElementById('warns').textContent)"))) fail('нет предупреждения о выпучивании');
      await visitAll();
      await set('c_postBase_antiHeave', 'replace');
      if (!(await ev("/засыпк/.test(document.getElementById('warns').textContent)"))) fail('нет предупреждения о засыпке');
      await ev(stubs);
      await ev("document.getElementById('btn-report').click()");
    });

    await step('старая ссылка с μ', async () => {
      const code = Buffer.from(JSON.stringify({ posts: { mu: 1 } }), 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await open(`index.html?smoke=link#p=${code}`);
      await appReady();
      if ((await ev("document.getElementById('c_bracing_along').value")) !== 'cross') fail('μ = 1 не перевёлся в крест');
      if (!(await ev("/ссылке/.test(document.getElementById('hint').textContent)"))) fail('нет подсказки о переводе');
    });

    // Вид проверяется там, где он чаще всего разъезжается: на ширине телефона
    // (горизонтальная прокрутка страницы) и в тёмной теме (цвет, вписанный мимо
    // токенов, или нечитаемый текст). Заодно снимаются скриншоты каждой вкладки.
    const tabs = ['tab-plan', 'tab-section', 'tab-diagrams', 'tab-nodes'];
    const shoot = async (name) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
    };
    // контраст текста и фона по WCAG: 4,5 — порог для обычного текста
    const contrast = `(() => {
      const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
      const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const cs = getComputedStyle(document.body);
      const [a, b] = [lum(cs.color), lum(cs.backgroundColor)].sort((x, y) => y - x);
      return { ratio: (a + 0.05) / (b + 0.05), bg: lum(cs.backgroundColor) };
    })()`;
    const setTheme = (t) => ev(`(() => { const h = document.documentElement; if (${JSON.stringify(t)}) h.setAttribute('data-theme', ${JSON.stringify(t)}); else h.removeAttribute('data-theme'); })()`);

    await step('тёмная и светлая темы, скриншоты вкладок', async () => {
      await mkdir(shots, { recursive: true });
      await ev('localStorage.clear()');
      await open('index.html');
      await appReady();
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        const c = await ev(contrast);
        if (c.ratio < 4.5) fail(`${theme}: контраст текста ${c.ratio.toFixed(1)} < 4,5`);
        if (theme === 'dark' ? c.bg > 0.1 : c.bg < 0.5) fail(`${theme}: фон страницы не той темы (яркость ${c.bg.toFixed(2)})`);
        for (const tab of tabs) {
          await ev(`document.getElementById('${tab}').click()`);
          await shoot(`desktop-${theme}-${tab.slice(4)}`);
        }
      }
      await setTheme(null);
    });

    await step('ширина телефона: без горизонтальной прокрутки', async () => {
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await open('index.html');
      await appReady();
      for (const tab of tabs) {
        await ev(`document.getElementById('${tab}').click()`);
        const over = await ev(`(() => {
          const w = document.documentElement.clientWidth;
          if (document.documentElement.scrollWidth <= w + 1) return null;
          // виновник — самый внешний вылезший элемент: сам шире экрана, а родитель
          // помещается (или сам прокручивается). Его и надо чинить, а не потомков
          const right = (el) => el.getBoundingClientRect().right;
          return [...document.querySelectorAll('body *')]
            .filter((el) => right(el) > w + 1 && (right(el.parentElement) <= w + 1 || getComputedStyle(el.parentElement).overflowX !== 'visible'))
            .filter((el) => { for (let p = el.parentElement; p; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return false; return true; })
            .map((el) => ({ el, r: right(el) }))
            .sort((a, b) => b.r - a.r).slice(0, 3)
            .map(({ el, r }) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + ' до ' + Math.round(r) + ' px')
            .join(', ') || 'ширина ' + document.documentElement.scrollWidth + ' px';
        })()`);
        if (over) fail(`${tab}: страница шире экрана 390 px — ${over}`);
        await shoot(`phone-light-${tab.slice(4)}`);
      }
      await send('Emulation.clearDeviceMetricsOverride');
    });

    // Стропило длиннее хлыста: стык встык ложится на прогон, свес остаётся куском
    // на одной опоре. Раньше в шапке стояло «макс U = 396372569068,9» — число по
    // вырожденному решению. Ползунок уклона кончается на 30°, поэтому 45° — ссылкой
    await step('изменяемая схема: уклон 45° по ссылке', async () => {
      const code = Buffer.from(JSON.stringify({ geom: { alpha: 45 } }), 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await open(`index.html?smoke=mechanism#p=${code}`);
      await appReady();
      await ev(stubs);
      const pill = await ev("document.getElementById('verdict-pill').textContent");
      if (!/U = ∞/.test(pill) || !/изменяемая схема/.test(pill)) fail(`в шапке «${pill}» вместо U = ∞ и изменяемой схемы`);
      if (/\d{5,}|Infinity/.test(pill)) fail(`в шапке мусорное число: «${pill}»`);
      if (await ev('document.documentElement.scrollWidth > document.documentElement.clientWidth + 1')) fail('шапка с изменяемой схемой шире телефона');
      await shoot('phone-light-mechanism');
      await send('Emulation.clearDeviceMetricsOverride');

      const card = await ev("document.querySelector('#summary [data-sel=\"rafters\"]')?.textContent ?? ''");
      if (!/∞/.test(card) || !/Изменяемая схема/.test(card)) fail(`карточка стропил: «${card.replace(/\s+/g, ' ').trim()}»`);
      await ev("document.querySelector('#summary [data-sel=\"rafters\"]').click()");
      if (!(await ev("/Не проходит: изменяемая схема/.test(document.getElementById('inspector').textContent)"))) fail('инспектор не называет изменяемую схему');
      await ev("document.getElementById('tab-diagrams').click()");
      if (!(await ev("/изменяемая схема/.test(document.querySelector('#canvas svg')?.textContent ?? '')"))) fail('эпюры механизма нарисованы');
      await ev("document.getElementById('btn-report').click()");
      if (!(await ev("/Изменяемая схема/.test(document.getElementById('report').textContent)"))) fail('в отчёте нет изменяемой схемы');
      // по ячейкам: в сплошном textContent соседние числа таблицы склеиваются
      const junk = await ev(`[...document.querySelectorAll('#report td')].map((td) => td.textContent)
        .find((t) => /Infinity|\\d{7,},\\d/.test(t)) ?? null`);
      if (junk) fail(`в отчёте мусорное число: ${junk.slice(0, 80)}`);
      await visitAll();
      // innerText, а не textContent: в textContent попадает и исходник встроенного скрипта
      const inf = await ev("(/.{0,60}Infinity.{0,30}/.exec(document.body.innerText) ?? [])[0] ?? null");
      if (inf) fail(`на странице «Infinity» вместо ∞: ${inf.replace(/\\s+/g, ' ')}`);
    });

    // Отмена и возврат: клавиши (по физической клавише — в русской раскладке
    // на Z стоит «я»), кнопки, слияние быстрых правок в один шаг, и то, что
    // клавиши правки текста в поле ввода принадлежат полю.
    await step('отменить и вернуть', async () => {
      await ev('localStorage.clear()');
      await open('index.html');
      await appReady();
      const val = (id) => ev(`document.getElementById('${id}').value`);
      const set = (id, v) => ev(`(() => { const el = document.getElementById('${id}'); el.value = '${v}'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const key = (code, extra = {}, target = 'document.body') => ev(`${target}.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', key: ${JSON.stringify(extra.key ?? 'z')}, ctrlKey: ${!!extra.ctrl}, shiftKey: ${!!extra.shift}, bubbles: true }))`);
      const disabled = (id) => ev(`document.getElementById('${id}').disabled`);
      if (!(await disabled('btn-undo'))) fail('в начале «Отменить» доступна');
      const B0 = await val('c_geom_B'), L0 = await val('c_geom_L');
      // ползунок, протянутый быстро, — один шаг
      for (const v of ['6200', '6400', '6600', '7000']) await set('c_geom_B', v);
      await wait(500);
      await set('c_geom_L', '3500');
      await key('KeyZ', { ctrl: true, key: 'я' });
      if ((await val('c_geom_L')) !== L0) fail(`Ctrl+Z не вернул вылет: ${await val('c_geom_L')}`);
      if ((await val('c_geom_B')) !== '7000') fail('Ctrl+Z отменил лишнее');
      await key('KeyZ', { ctrl: true });
      if ((await val('c_geom_B')) !== B0) fail(`протянутый ползунок отменился не целиком: ${await val('c_geom_B')}`);
      if (!(await disabled('btn-undo'))) fail('в начале истории «Отменить» доступна');
      await key('KeyY', { ctrl: true, key: 'y' });
      if ((await val('c_geom_B')) !== '7000') fail('Ctrl+Y не вернул ширину');
      await ev("document.getElementById('btn-redo').click()");
      if ((await val('c_geom_L')) !== '3500') fail('кнопка «Вернуть» не сработала');
      if (!(await disabled('btn-redo'))) fail('вернуть больше нечего, а кнопка доступна');
      // «Сбросить» тоже отменяется
      await ev("document.getElementById('btn-reset').click()");
      await ev("document.getElementById('btn-undo').click()");
      if ((await val('c_geom_L')) !== '3500') fail('сброс не отменился');
      // Backspace в поле ввода стирает текст, а не стропило
      const rafters = () => ev("document.querySelectorAll('#canvas [data-pick=\"rafter\"]').length");
      await ev("document.getElementById('tab-plan').click()");
      const n0 = await rafters();
      const field = "document.querySelector('#params input[type=number], #params-right input[type=number]')";
      await key('Backspace', { key: 'Backspace' }, field);
      if ((await rafters()) !== n0) fail('Backspace в поле ввода удалил стропило');
      await key('Delete', { key: 'Delete' });
      if ((await rafters()) !== n0 - 1) fail('Delete вне поля не удалил выбранное стропило');
      await key('KeyZ', { ctrl: true });
      if ((await rafters()) !== n0) fail('удаление стропила не отменилось');
    });

    // модульная версия: склейка прячет забытый импорт (имя и так общее),
    // а dev.html на нём падает — проверяем, что она поднимается без ошибок
    // Забытый импорт проявляется только там, где имя вызывается, — поэтому
    // включаются сценарии с узкими полями и карточками: крест, мороз, стык
    // накладкой, и обходятся все вкладки и отчёт.
    await step('модульная версия dev.html', async () => {
      await open('dev.html');
      await appReady();
      const set = (id, v) => ev(`(() => { const el = document.getElementById('${id}'); el.value = '${v}'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await set('c_bracing_along', 'cross');
      await set('c_site_frostDepth', '1200');
      await set('c_site_soil', 'clay');
      await set('c_opts_spliceJoint', 'plate');
      await set('c_geom_B', '9000');
      await visitAll();
      await ev("window.print = () => {}; document.getElementById('btn-report').click()");
      if (!(await ev("document.querySelectorAll('#report h2').length >= 5"))) fail('dev.html: отчёт не собрался');
    });

    await step('справка', async () => {
      const pages = readdirSync(join(root, 'help')).filter((f) => f.endsWith('.html'));
      for (const p of pages) {
        await open(`help/${p}`);
        if (!(await ev("!!document.querySelector('h1')"))) fail(`help/${p}: нет заголовка`);
      }
    });

    page.close();
  } finally {
    proc.kill();
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const sec = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length) {
    // одна и та же ошибка на каждом клике — одна строка с числом повторов
    const counts = new Map();
    for (const f of failures) counts.set(f, (counts.get(f) ?? 0) + 1);
    console.error(`\nСмоук-тест не прошёл за ${sec} с — ошибок: ${counts.size}`);
    for (const [f, n] of [...counts].slice(0, 30)) console.error(`  ${f}${n > 1 ? `  (×${n})` : ''}`);
    process.exit(1);
  }
  console.log(`\nСмоук-тест прошёл за ${sec} с.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
