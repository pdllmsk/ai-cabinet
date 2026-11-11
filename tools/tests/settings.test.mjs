// Настройки кабинета: api/cabinet, ссылки «Редактировать», тема (prefs.js, dark.css) и страница
// «Настройки» (site/nastroiki.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cabinetChecks, cabinetFolders, createCabinetApi } from '../cabinet-api.mjs';
import { servicesHome } from '../services.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'templates', 'site');

// ---------- api/cabinet ----------

function serve(api) {
  const server = http.createServer((req, res) => {
    const sub = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/api\/cabinet\/?/, '');
    api(req, res, sub);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function call(server, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers, agent: false }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        ok({ status: r.statusCode, json, headers: r.headers });
      });
    });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const HDR = { 'X-Cabinet': '1' };
const POST = { 'X-Cabinet': '1', 'Content-Type': 'application/json' };

test('api/cabinet: папки и версия только со страницы (X-Cabinet), версия из git или null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kab-set-'));
  const opened = [];
  const api = createCabinetApi(dir, { version: async () => ({ commit: 'abc1234', date: '2026-10-30T01:20:00+05:00' }), openFolder: (d) => opened.push(d) });
  const server = await serve(api);
  try {
    assert.equal((await call(server, '/api/cabinet')).status, 403, 'без заголовка страницы');
    const r = await call(server, '/api/cabinet', { headers: HDR });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    assert.deepEqual(r.json, {
      root: resolve(dir),
      services: servicesHome(dir),
      analiz: join(resolve(dir), 'input', 'analiz'),
      version: { commit: 'abc1234', date: '2026-10-30T01:20:00+05:00' },
      // Журнал кабинета (tools/journal.mjs): папка, файл месяца и число событий; журнала нет: 0.
      journal: { folder: 'journal', file: `journal/${month}.jsonl`, events: 0 },
    });
    assert.equal((await call(server, '/api/cabinet', { method: 'POST', headers: POST, body: '{}' })).status, 405);
    assert.equal((await call(server, '/api/cabinet/nichego', { headers: HDR })).status, 404);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // git нет или истории нет: версия null, страница пишет, что узнать не получилось.
  const bare = mkdtempSync(join(tmpdir(), 'kab-set-'));
  const server2 = await serve(createCabinetApi(bare));
  try {
    const r = await call(server2, '/api/cabinet', { headers: HDR });
    assert.equal(r.status, 200);
    assert.equal(r.json.version, null);
  } finally {
    server2.close();
    rmSync(bare, { recursive: true, force: true });
  }
});

test('api/cabinet/open: только три папки кабинета, POST со страницы, папка данных создаётся', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kab-set-'));
  const opened = [];
  const server = await serve(createCabinetApi(dir, { version: async () => null, openFolder: (d) => opened.push(d) }));
  try {
    assert.equal((await call(server, '/api/cabinet/open', { method: 'POST', headers: HDR, body: '{"folder":"cabinet"}' })).status, 403, 'не JSON');
    assert.equal((await call(server, '/api/cabinet/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"folder":"cabinet"}' })).status, 403, 'без X-Cabinet');
    assert.equal((await call(server, '/api/cabinet/open', { headers: HDR })).status, 405);
    for (const folder of ['..', '/etc', 'C:\\Windows', 'toString', '', 'root']) {
      const r = await call(server, '/api/cabinet/open', { method: 'POST', headers: POST, body: JSON.stringify({ folder }) });
      assert.equal(r.status, 400, folder);
    }
    assert.equal(opened.length, 0, 'чужие папки не открываются');
    const r = await call(server, '/api/cabinet/open', { method: 'POST', headers: POST, body: '{"folder":"analiz"}' });
    assert.equal(r.status, 200);
    assert.equal(r.json.opened, true);
    assert.equal(r.json.path, join(resolve(dir), 'input', 'analiz'));
    assert.ok(statSync(r.json.path).isDirectory(), 'папка данных создана');
    assert.deepEqual(opened, [join(resolve(dir), 'input', 'analiz')]);
    const c = await call(server, '/api/cabinet/open', { method: 'POST', headers: POST, body: '{"folder":"cabinet"}' });
    assert.equal(c.json.path, resolve(dir));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('api/cabinet/checks: нет Python или он не запускается → красные пункты с подсказкой, без исключения', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kab-set-'));
  try {
    const checks = await cabinetChecks(dir, { python: join(dir, 'net-takogo-python') });
    assert.deepEqual(checks.map((c) => [c.id, c.ok]), [['python', false], ['claude', false]]);
    for (const c of checks) assert.ok(c.title && c.detail, c.id);
    assert.deepEqual(cabinetFolders(dir), { root: dir, services: servicesHome(dir), analiz: join(dir, 'input', 'analiz') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- prefs.js: тема и ссылка «Редактировать» ----------

function loadPrefs({ stored = {}, systemDark = false, storageThrows = false } = {}) {
  const attrs = {};
  const classes = new Set();
  const store = { ...stored };
  const window = {
    localStorage: {
      getItem: (k) => {
        if (storageThrows) throw new Error('нет доступа');
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
      setItem: (k, v) => {
        if (storageThrows) throw new Error('нет доступа');
        store[k] = String(v);
      },
    },
    matchMedia: () => ({ matches: systemDark, addEventListener() {} }),
  };
  const document = {
    documentElement: {
      setAttribute: (k, v) => (attrs[k] = v),
      removeAttribute: (k) => delete attrs[k],
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    },
    getElementById: () => null,
    addEventListener() {},
  };
  runInNewContext(readFileSync(join(SITE, 'prefs.js'), 'utf8'), { window, document, encodeURIComponent, encodeURI, String });
  return { P: window.CabinetPrefs, attrs, classes, store };
}

test('prefs.js: тема по умолчанию как в системе, выбор сохраняется, без доступа к хранилищу не падает', () => {
  let s = loadPrefs();
  assert.equal(s.P.theme(), 'auto');
  assert.equal(s.attrs['data-theme'], undefined);
  assert.equal(s.classes.has('dk'), false);
  s = loadPrefs({ systemDark: true });
  assert.equal(s.attrs['data-theme'], undefined, 'как в системе: атрибута нет, работает @media');
  assert.equal(s.classes.has('dk'), true, 'система тёмная: .dk для правил страниц');
  s = loadPrefs({ stored: { 'kabinet-theme': 'dark' } });
  assert.equal(s.attrs['data-theme'], 'dark');
  assert.equal(s.classes.has('dk'), true);
  s.P.setTheme('light');
  assert.equal(s.store['kabinet-theme'], 'light');
  assert.equal(s.attrs['data-theme'], 'light');
  assert.equal(s.classes.has('dk'), false);
  s.P.setTheme('rozovaya');
  assert.equal(s.store['kabinet-theme'], 'light', 'чужое значение не пишется');
  s = loadPrefs({ stored: { 'kabinet-theme': '<script>' } });
  assert.equal(s.P.theme(), 'auto', 'чужое значение в хранилище: как в системе');
  s = loadPrefs({ storageThrows: true });
  assert.equal(s.P.theme(), 'auto');
  s.P.setTheme('dark');
  assert.equal(s.attrs['data-theme'], 'dark', 'без хранилища выбор действует до перезагрузки');
  assert.equal(s.P.editor(), 'claude');
});

test('prefs.js: «Редактировать» открывает Claude в папке (claude://code/new) или папку в VS Code', () => {
  const { P } = loadPrefs();
  const win = 'C:\\Users\\Айгуль Н\\Документы\\Сервисы\\svodka & co';
  assert.equal(
    P.editHref(win, 'Доработай сервис: '),
    'claude://code/new?folder=' + encodeURIComponent(win) + '&q=' + encodeURIComponent('Доработай сервис: '),
  );
  assert.ok(!P.editHref(win, '').includes('&q='), 'без начала просьбы поля q нет');
  assert.equal(P.editHref('', 'x'), null);
  assert.equal(P.editHref(null, 'x'), null);
  assert.equal(P.editHref(win, 'x', 'vscode'), 'vscode://file/' + encodeURI('C:/Users/Айгуль Н/Документы/Сервисы/svodka & co'));
  assert.equal(P.editHref('/Users/u/Документы/Сервисы/a', 'x', 'vscode'), 'vscode://file' + encodeURI('/Users/u/Документы/Сервисы/a'));
  const s = loadPrefs({ stored: { 'kabinet-editor': 'vscode' } });
  assert.equal(s.P.editor(), 'vscode');
  assert.ok(s.P.editHref(win, 'x').startsWith('vscode://file/'), 'выбор из настроек');
  s.P.setEditor('notepad');
  assert.equal(s.store['kabinet-editor'], 'vscode');
});

// ---------- render.js: кнопка на карточках ----------

const rwin = {};
runInNewContext(readFileSync(join(SITE, 'render.js'), 'utf8'), { window: rwin });
const R = rwin.CabinetRender;

test('render.js: «Редактировать» на карточке и в подробном виде только со ссылкой от страницы', () => {
  const svc = { source: 'service', slug: 'svodka', name: 'Сводка <Точка>', kind: 'run', path: '/x', result: null };
  const edit = (p) => (p.slug === 'svodka' ? 'claude://code/new?folder=%2Fx&q=a"b' : null);
  const tile = R.renderTile(svc, { edit });
  assert.match(tile, /<a class="tile-edit" href="claude:\/\/code\/new\?folder=%2Fx&amp;q=a&quot;b" title="Редактировать в Claude" aria-label="Редактировать «Сводка &lt;Точка&gt;»">/);
  assert.doesNotMatch(R.renderTile(svc, {}), /tile-edit/, 'без ссылки кнопки нет');
  assert.doesNotMatch(R.renderTile({ ...svc, slug: 'drugoi' }, { edit }), /tile-edit/);
  const card = R.renderCard(svc, { edit });
  assert.match(card, /<a class="btn edit" href="claude:[^"]*"[^>]*>.*<span>Редактировать<\/span><\/a>/);
  const page = R.renderPage([svc], {}, { key: 's:svodka', edit });
  assert.match(page, /btn edit/);
  assert.match(R.renderPage([svc], {}, { edit }), /tile-edit/);
  assert.doesNotMatch(R.renderPage([svc], {}, {}), /edit/);
});

// ---------- страница «Настройки», тема, общие файлы ----------

test('nastroiki.html: каркас и меню как на главной, тема и редактор, проверка, папки, версия; без интернета и тире', () => {
  const html = readFileSync(join(SITE, 'nastroiki.html'), 'utf8');
  const index = readFileSync(join(SITE, 'index.html'), 'utf8');
  assert.match(html, /<body data-cabinet="ok">/);
  assert.match(html, /<title>Настройки<\/title>/);
  assert.match(html, /<h1>Настройки<\/h1>/);
  const block = (h, from, to) => h.slice(h.indexOf(from), h.indexOf(to, h.indexOf(from)));
  assert.equal(block(html, '  /* Каркас', '  .help b'), block(index, '  /* Каркас', '  .help b'));
  assert.match(html, /<a class="nav-item" id="nav-all" href="\.\/">/);
  assert.match(html, /<a class="nav-item nav-settings" href="nastroiki\.html" aria-current="page">/);
  for (const v of ['auto', 'light', 'dark']) assert.match(html, new RegExp(`<input type="radio" name="theme" value="${v}">`));
  for (const v of ['claude', 'vscode']) assert.match(html, new RegExp(`<input type="radio" name="editor" value="${v}">`));
  for (const needle of ["fetch('api/cabinet/checks'", "fetch('api/cabinet'", "fetch('api/cabinet/open'", "'X-Cabinet': '1'", "P.editHref(d.root, 'обнови кабинет', 'claude')"]) {
    assert.ok(html.includes(needle), needle);
  }
  assert.doesNotMatch(html, /[\u2012-\u2015]/);
  assert.doesNotMatch(html, /(src|href)="(\/|https?:|\/\/)/);
  assert.doesNotMatch(html, /<link[^>]+(https?:|\/\/)/);
  assert.ok(!html.includes('innerHTML = d.') && !html.includes("innerHTML = c."), 'ответ сервера в разметку только через esc');
});

test('тема: prefs.js в <head> до стилей, dark.css после стилей бренда, кнопка темы в шапке на всех страницах', () => {
  for (const name of ['index.html', 'analiz.html', 'nastroiki.html']) {
    const html = readFileSync(join(SITE, name), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(head.indexOf('<script src="prefs.js"></script>') !== -1 && head.indexOf('<script src="prefs.js"></script>') < head.indexOf('<style>'), name);
    assert.match(head, /<link rel="stylesheet" href="brand\/theme\.css">\s*<link rel="stylesheet" href="dark\.css">/, name);
    assert.match(html, /<button type="button" class="theme-toggle" id="theme-toggle" aria-pressed="false"/, name);
    assert.match(html, /<a class="nav-item nav-settings" href="nastroiki\.html"/, name);
  }
  const css = readFileSync(join(SITE, 'dark.css'), 'utf8');
  assert.doesNotMatch(css, /@import|url\(|https?:/);
  assert.match(css, /:root\[data-theme="dark"\] \{/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/);
  // Тёмные значения одинаковы в обоих блоках: выбор «Тёмная» и тёмная система выглядят одинаково.
  const vars = (s) => [...s.matchAll(/(--[a-z-]+): ([^;]+);/g)].map((m) => m[1] + ':' + m[2]);
  const a = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('@media'));
  const b = css.slice(css.indexOf('@media'), css.indexOf('/* Места'));
  assert.deepEqual(vars(a), vars(b));
  assert.doesNotMatch(readFileSync(join(SITE, 'prefs.js'), 'utf8'), /[\u2012-\u2015]/);
});

test('render.js: карандаш на «Аналитике таблиц»: карточка не ссылка целиком, название, «Открыть» и карандаш отдельно', () => {
  const edit = (p) => (p.source === 'builtin' ? 'claude://code/new?folder=%2Fk&q=x' : null);
  const html = R.renderPage([], {}, { edit });
  assert.match(html, /^<div class="grid"><article class="tile tile-service"><div class="tile-top"><span class="tile-icon" aria-hidden="true">/);
  assert.match(html, /<a class="tile-edit" href="claude:\/\/code\/new\?folder=%2Fk&amp;q=x" title="Редактировать в Claude" aria-label="Редактировать «Аналитика таблиц»">/);
  assert.match(html, /<h2 class="tile-title"><a href="analiz\.html">Аналитика таблиц<\/a><\/h2>/);
  assert.match(html, /<a class="btn" href="analiz\.html">Открыть<\/a>/);
  assert.doesNotMatch(html, /<a class="tile[ "]/, 'ссылки внутри ссылки нет');
  // Без ссылки от страницы карточка прежняя.
  assert.match(R.renderPage([], {}, {}), /^<div class="grid"><a class="tile tile-service" href="analiz\.html">/);
});
