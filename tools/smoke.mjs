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
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, extname, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
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

async function launch(chrome, profile) {
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--window-size=1400,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((ok, fail) => {
    let buf = '';
    const t = setTimeout(() => fail(new Error('Chrome не ответил за 20 с')), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); ok(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(t); fail(new Error(`Chrome завершился с кодом ${code}: ${buf.slice(-400)}`)); });
  });
  return { proc, port: new URL(ws).port };
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
  const profile = await mkdtemp(join(tmpdir(), 'canopycraft-smoke-'));
  const { proc, port } = await launch(chrome, profile);
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
