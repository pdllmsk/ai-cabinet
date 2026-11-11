import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'templates', 'site');

// render.js подключается на странице обычным <script>: в песочнице он кладёт CabinetRender в window.
const window = {};
runInNewContext(readFileSync(join(SITE, 'render.js'), 'utf8'), { window });
const { renderCard, renderTile, renderNav, renderPage, keyFromHash, findItem, itemKey, servicesFrom } = window.CabinetRender;

const demo = {
  slug: 'svetofor-tochek',
  title: 'Светофор точек продаж',
  phrase: 'запусти светофор точек',
  kind: 'script',
  running: false,
  error: null,
  result: {
    title: 'Светофор точек продаж',
    updated_at: '2026-10-22T14:05:09',
    status: 'red',
    summary: 'На 21.09.2026 истекли: 1.',
    columns: ['№ договора', 'Дата окончания'],
    rows: [['МП-301', '31.08.2026'], ['ПВ-08', '30.09.2026'], ['КП-18', '31.01.2027'], ['АЗ-163', null], ['НЛ-5521', 'бессрочно']],
    row_status: ['red', 'yellow', 'green', 'grey', 'info'],
    row_note: [null, null, null, null, 'бессрочно'],
    files: ['output/svetofor-tochek/svetofor.xlsx'],
  },
};

const rowsOf = (html) => [...html.matchAll(/<tr class="row-(\w+)">([\s\S]*?)<\/tr>/g)].map((m) => ({ status: m[1], html: m[2] }));

test('карточка: название, время, метка статуса, итог, таблица, файлы, кнопка', () => {
  const html = renderCard(demo);
  assert.match(html, /data-slug="svetofor-tochek"/);
  assert.match(html, /<h2[^>]*>Светофор точек продаж<\/h2>/);
  assert.match(html, /обновлено 22\.10\.2026 14:05/);
  assert.match(html, /class="badge badge-red"[^>]*>красный</);
  assert.match(html, /На 21\.09\.2026 истекли: 1\./);
  assert.match(html, /<th>№ договора<\/th>/);
  assert.match(html, /<a href="output\/svetofor-tochek\/svetofor\.xlsx"[^>]*>svetofor\.xlsx<\/a>/);
  assert.match(html, /<button type="button" class="run" data-run="svetofor-tochek">Запустить<\/button>/);
  assert.doesNotMatch(html, /Запуск фразой/);
});

test('строки окрашены по row_status, grey подписан «нет данных», info показывает row_note', () => {
  const rows = rowsOf(renderCard(demo));
  assert.deepEqual(rows.map((r) => r.status), ['red', 'yellow', 'green', 'grey', 'info']);
  assert.match(rows[3].html, /нет данных/);
  assert.match(rows[3].html, /АЗ-163/);
  assert.match(rows[4].html, /<td class="mark">бессрочно<\/td>/);
  assert.doesNotMatch(rows[2].html, /нет данных/);
});

test('без row_status: строки без окраски и без столбца отметок', () => {
  const p = { ...demo, result: { ...demo.result, row_status: undefined, row_note: undefined } };
  const html = renderCard(p);
  assert.equal(rowsOf(html).length, 0);
  assert.equal((html.match(/<tr>/g) ?? []).length, 1 + demo.result.rows.length);
  assert.doesNotMatch(html, /class="mark"/);
});

test('«разобрать вручную»: строка с пометкой info и подписью, строки без отметки (null) без окраски, ссылка на файл', () => {
  const p = {
    ...demo,
    slug: 'obr',
    result: {
      ...demo.result,
      status: 'green',
      summary: 'Обращений 3. Разобрать вручную: 1 (файл razobrat-vruchnuyu.xlsx).',
      columns: ['№', 'Тема'],
      rows: [['11', 'разобрать вручную'], ['1', 'оборудование'], ['2', 'другое']],
      row_status: ['info', null, null],
      row_note: ['разобрать вручную', null, null],
      files: ['output/obr/razobrat-vruchnuyu.xlsx'],
    },
  };
  const html = renderCard(p);
  assert.deepEqual(rowsOf(html).map((r) => r.status), ['info']);
  assert.match(rowsOf(html)[0].html, /<td class="mark">разобрать вручную<\/td>/);
  assert.equal((html.match(/<tr><td class="mark"><\/td>/g) ?? []).length, 2);
  assert.match(html, /Разобрать вручную: 1/);
  assert.match(html, /<a href="output\/obr\/razobrat-vruchnuyu\.xlsx" download>razobrat-vruchnuyu\.xlsx<\/a>/);
});

test('kind claude (процесс старого вида): вместо кнопки подсказка с фразой', () => {
  const html = renderCard({ ...demo, kind: 'claude', phrase: 'напиши черновики писем' });
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /Запуск фразой в Claude: «напиши черновики писем»/);
});

test('идёт расчёт: кнопка неактивна с подписью; сообщение об ошибке запуска показывается', () => {
  const running = renderCard({ ...demo, running: true });
  assert.match(running, /<button type="button" class="run" data-run="svetofor-tochek" disabled>идёт расчёт…<\/button>/);
  const failed = renderCard(demo, { message: 'Расчёт не удался. Подробности в output/svetofor-tochek/last-run.log' });
  assert.match(failed, /class="run-error"[^>]*>Расчёт не удался\. Подробности в output\/svetofor-tochek\/last-run\.log</);
});

test('ещё не запускался и битый результат', () => {
  const fresh = renderCard({ ...demo, result: null });
  assert.match(fresh, /ещё не запускался/);
  assert.match(fresh, /Запустить/);
  assert.doesNotMatch(fresh, /<table/);
  const broken = renderCard({ ...demo, result: null, error: 'файл output/svetofor-tochek/result.json повреждён' });
  assert.match(broken, /class="error"[^>]*>[^<]*result\.json повреждён/);
  assert.match(broken, /Запустить/);
  const badFolder = renderCard({ slug: 'Svetofor_2', title: 'Svetofor_2', phrase: '', kind: null, result: null, error: 'папка processes/Svetofor_2: в имени нужны строчные латинские буквы', running: false });
  assert.doesNotMatch(badFolder, /<button|Запуск фразой/);
  assert.match(badFolder, /class="error"/);
});

test('итог одной строкой: без таблицы и без файлов', () => {
  const html = renderCard({ ...demo, result: { ...demo.result, columns: [], rows: [], row_status: undefined, row_note: undefined, files: undefined } });
  assert.doesNotMatch(html, /<table|<a /);
  assert.match(html, /На 21\.09\.2026/);
});

test('текст из данных экранируется, ссылки только в output/<slug>/', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const p = {
    ...demo,
    title: evil,
    slug: 'svetofor-tochek',
    result: {
      ...demo.result,
      title: evil,
      summary: evil,
      columns: [evil],
      rows: [[evil], [5]],
      row_status: ['red', 'info'],
      row_note: [evil, evil],
      files: ['output/svetofor-tochek/отчёт 1.xlsx', 'output/drugoi/x.xlsx', '../me/rules.md', 'javascript:alert(1)'],
    },
  };
  const html = renderCard(p);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  assert.match(html, /href="output\/svetofor-tochek\/%D0%BE%D1%82%D1%87%D1%91%D1%82%201\.xlsx"/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<td>5<\/td>/);
  const kind = renderCard({ ...demo, kind: 'claude', phrase: evil });
  assert.doesNotMatch(kind, /<img/);
  const run = renderCard({ ...demo, slug: '"><script>' });
  assert.doesNotMatch(run, /<script>/);
});

test('renderPage: сетка, первая карточка «Аналитика таблиц»; без процессов только она, без подсказки', () => {
  for (const empty of [[], null, undefined]) {
    const html = renderPage(empty);
    assert.match(html, /^<div class="grid"><a class="tile tile-service" href="analiz\.html">/);
    assert.match(html, /<span class="tile-title">Аналитика таблиц<\/span>/);
    assert.match(html, /<span class="tile-desc">Вопрос своим таблицам словами, строки не уходят с компьютера<\/span>/);
    assert.match(html, /<span class="btn">Открыть<\/span>/);
    assert.doesNotMatch(html, /<article|Процессов пока нет|добавь процесс/);
  }
  const two = renderPage([demo, { ...demo, slug: 'vtoroi', title: 'Второй' }], { 'p:vtoroi': 'ошибка второго' });
  assert.ok(two.indexOf('tile-service') < two.indexOf('<article'), '«Аналитика таблиц» первой');
  assert.equal((two.match(/<article class="tile"/g) ?? []).length, 2);
  assert.match(two, /<article class="tile" data-slug="vtoroi">[\s\S]*class="run-error tile-msg" role="alert">ошибка второго</);
  // В сетке таблицы нет: она в подробном виде.
  assert.doesNotMatch(two, /<table/);
});

test('renderPage: #p=<slug> → подробный вид процесса со ссылкой «← Все сервисы»; чужой slug → сетка', () => {
  const list = [demo, { ...demo, slug: 'vtoroi', title: 'Второй' }];
  const html = renderPage(list, { 'p:svetofor-tochek': 'Расчёт не удался' }, { key: 'p:svetofor-tochek' });
  assert.match(html, /^<div class="detail"><p class="crumbs"><a class="back" href="#">← Все сервисы<\/a><\/p><article class="card" data-slug="svetofor-tochek">/);
  assert.match(html, /<th>№ договора<\/th>/);
  assert.match(html, /svetofor\.xlsx/);
  assert.match(html, /data-run="svetofor-tochek">Запустить</);
  assert.match(html, /class="run-error"[^>]*>Расчёт не удался</);
  assert.doesNotMatch(html, /tile-service|Второй/);
  for (const key of ['p:net-takogo', 's:svetofor-tochek', '', null]) assert.match(renderPage(list, {}, { key }), /^<div class="grid">/, String(key));
});

test('компактная карточка: название-ссылка, статус цветом, время, итог, «Запустить» и «Подробнее» на #p=<slug>', () => {
  const html = renderTile(demo);
  assert.match(html, /^<article class="tile" data-slug="svetofor-tochek">/);
  assert.match(html, /<span class="tile-icon tile-icon-red"/);
  assert.match(html, /<span class="badge badge-red">красный<\/span>/);
  assert.match(html, /<h2 class="tile-title"><a href="#p=svetofor-tochek">Светофор точек продаж<\/a><\/h2>/);
  assert.match(html, /<p class="tile-when">обновлено 22\.10\.2026 14:05<\/p>/);
  assert.match(html, /<p class="tile-sum" title="На 21\.09\.2026 истекли: 1\.">На 21\.09\.2026 истекли: 1\.<\/p>/);
  assert.match(html, /<button type="button" class="run" data-run="svetofor-tochek">Запустить<\/button><a class="btn more" href="#p=svetofor-tochek">Подробнее<\/a>/);
  assert.doesNotMatch(html, /<table|<a href="output/);
  // Идёт расчёт, ещё не запускался, процесс старого вида, битая папка.
  assert.match(renderTile({ ...demo, running: true }), /data-run="svetofor-tochek" disabled>идёт расчёт…<\/button>/);
  const fresh = renderTile({ ...demo, result: null });
  assert.match(fresh, /<p class="tile-when">ещё не запускался<\/p>/);
  assert.match(fresh, /tile-icon-none/);
  assert.doesNotMatch(fresh, /class="badge/);
  const claude = renderTile({ ...demo, kind: 'claude', phrase: 'напиши черновики писем' });
  assert.doesNotMatch(claude, /<button/);
  assert.match(claude, /Запуск фразой в Claude: «напиши черновики писем»/);
  assert.match(claude, /Подробнее/);
  const bad = renderTile({ slug: 'Svetofor_2', title: 'Svetofor_2', phrase: '', kind: null, result: null, error: 'папка processes/Svetofor_2: в имени нужны строчные латинские буквы', running: false });
  assert.match(bad, /<p class="tile-error">Ошибка: папка processes\/Svetofor_2/);
  assert.doesNotMatch(bad, /<button|ещё не запускался/);
  assert.match(bad, /href="#p=Svetofor_2"/);
});

test('меню «Мои сервисы»: точка статуса, подсветка открытого, ссылки на главную с других страниц', () => {
  assert.equal(renderNav([]), '');
  assert.equal(renderNav(null), '');
  const list = [demo, { ...demo, slug: 'vtoroi', title: 'Второй', result: null }, { ...demo, slug: 'tretii', title: 'Третий', running: true }];
  const html = renderNav(list, 'p:vtoroi', '');
  const items = [...html.matchAll(/<a class="nav-item" href="([^"]+)"( aria-current="page")?><span class="dot dot-(\w+)"/g)].map((m) => [m[1], Boolean(m[2]), m[3]]);
  assert.deepEqual(items, [['#p=svetofor-tochek', false, 'red'], ['#p=vtoroi', true, 'none'], ['#p=tretii', false, 'run']]);
  assert.match(html, /Светофор точек продаж<span class="sr-only">, красный<\/span>/);
  assert.match(html, /Второй<span class="sr-only">, ещё нет результата<\/span>/);
  assert.match(html, /Третий<span class="sr-only">, идёт расчёт<\/span>/);
  assert.match(renderNav([demo], null, './'), /href="\.\/#p=svetofor-tochek"/);
  assert.doesNotMatch(renderNav([demo], null, './'), /aria-current/);
});

test('адрес подробного вида: #p=<slug> процесс, #s=<slug> встроенный проект, остальные хеши ничего не открывают', () => {
  assert.equal(keyFromHash('#p=svetofor-tochek'), 'p:svetofor-tochek');
  assert.equal(keyFromHash('#p=Svetofor_2'), 'p:Svetofor_2');
  assert.equal(keyFromHash('#s=svodka-tochki'), 's:svodka-tochki');
  for (const h of ['', '#', '#p=', '#s=', '#x=1', 'p=abc', '#p=%E0%A4%A', null, undefined]) assert.equal(keyFromHash(h), null, String(h));
  const svc = servicesFrom([{ slug: 'svetofor-tochek', name: 'Проект с тем же slug' }])[0];
  assert.equal(findItem([demo, svc], 'p:svetofor-tochek'), demo);
  assert.equal(findItem([demo, svc], 's:svetofor-tochek'), svc, 'процесс и проект с одинаковым slug не путаются');
  assert.equal(findItem([demo], 'p:net'), null);
  assert.equal(findItem(null, 'p:x'), null);
});

test('сетка и меню: текст из данных экранируется, slug в ссылке кодируется', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const p = { ...demo, slug: '"><script>x', title: evil, result: { ...demo.result, summary: evil }, error: evil };
  for (const html of [renderTile(p, { message: evil }), renderNav([p], itemKey(p), './'), renderPage([p])]) {
    assert.doesNotMatch(html, /<img|<script>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
  assert.match(renderNav([p]), /href="#p=%22%3E%3Cscript%3Ex"/);
});

test('страница: маркер, заголовок, render.js по относительной ссылке, без внешних ресурсов', () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  assert.match(html, /data-cabinet="ok"/);
  assert.match(html, /<title>Мой кабинет<\/title>/);
  assert.match(html, /<h1>Мой кабинет<\/h1>/);
  assert.match(html, /<script src="render\.js"><\/script>/);
  // Каркас: меню слева (все сервисы, «Аналитика таблиц», «Мои сервисы», как добавить сервис), справа сервисы.
  assert.match(html, /<nav class="side" id="side" aria-label="Меню кабинета">/);
  assert.match(html, /<a class="nav-item" id="nav-all" href="#" aria-current="page">[\s\S]*?Все сервисы<\/span><\/a>/);
  assert.match(html, /<a class="nav-item" href="analiz\.html">[\s\S]*?Аналитика таблиц<\/span><\/a>/);
  assert.match(html, /<div class="nav-group" id="nav-mine" hidden>\s*<p class="nav-title">Мои сервисы<\/p>\s*<div id="nav-list"><\/div>/);
  assert.match(html, /<details class="nav-help">[\s\S]*Как добавить сервис[\s\S]*Откройте Claude во вкладке <b>Code<\/b> в новой папке и скажите <b>«новый сервис»<\/b>: Claude создаст проект\. Когда сервис готов, скажите <b>«добавь в кабинет»<\/b>\./);
  for (const needle of ["fetch('api/services'", "fetch('api/services/run'", 'JSON.stringify({ slug: slug })', 'button[data-run-service]']) assert.ok(html.includes(needle), needle);
  assert.match(html, /<button type="button" class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="nav-body">/);
  assert.ok(html.indexOf('id="side"') < html.indexOf('id="processes"'), 'меню слева от сервисов');
  assert.match(html, /grid-template-columns: 280px minmax\(0, 1fr\)/);
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*\.side\.open \.nav-body \{ display: block; \}/);
  // Тексты страницы без длинных и средних тире.
  assert.doesNotMatch(html, /[\u2012-\u2015]/);
  assert.doesNotMatch(readFileSync(join(SITE, 'render.js'), 'utf8'), /[\u2012-\u2015]/);
  assert.doesNotMatch(html, /(src|href)="(\/|https?:|\/\/)/);
  // Бренд: стили по относительной ссылке после стилей страницы (переменные переопределяются), логотип скрыт,
  // пока не загрузится: без папки бренда нет пустой рамки и битой картинки.
  assert.match(html, /<\/style>\s*<link rel="stylesheet" href="brand\/theme\.css">/);
  assert.match(html, /<img class="brand-logo" id="brand-logo" alt="" hidden>/);
  assert.match(html, /<span class="brand-name" id="brand-name" hidden><\/span>/);
  for (const needle of ["'brand/logo.svg'", "'brand/logo.png'", "fetch('brand/brand.json'"]) assert.ok(html.includes(needle), needle);
  assert.doesNotMatch(html, /<link[^>]+(https?:|\/\/)/);
  // Переменные, которые переопределяет theme.css папки бренда.
  for (const v of ['--accent:', '--accent-ink:', '--accent-dark:', '--accent-dark-ink:', '--link:', '--stripe:', '--logo-height:']) {
    assert.ok(html.includes(v), v);
  }
  assert.doesNotMatch(html, /fetch\(['"`]\//);
  assert.doesNotMatch(html, /@import|url\(/);
  for (const needle of ["'X-Cabinet': '1'", "'Content-Type': 'application/json'", "method: 'POST'", 'api/processes', 'api/run/', 'api/status/', '2000']) {
    assert.ok(html.includes(needle), needle);
  }
  assert.match(html, /last-run\.log/);
  // 409: ERUNNING ждёт этот процесс или показывает свежую карточку, ELIMIT оставляет кнопку доступной.
  assert.ok(html.includes("j.code === 'ERUNNING'"), 'страница различает коды 409');
  // Запуск фразой в Claude: пока страница на экране, список перечитывается раз в 10 секунд.
  assert.ok(html.includes('10000'), 'опрос списка раз в 10 с');
  assert.match(html, /document\.visibilityState === 'visible'/);
  assert.match(html, /setInterval\(/);
});

// Элемент страницы для песочницы: свойства и обработчики событий.
function stubElement() {
  return {
    hidden: true,
    className: '',
    textContent: '',
    innerHTML: '',
    alt: '',
    src: '',
    on: {},
    attrs: {},
    addEventListener(type, fn) {
      this.on[type] = fn;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
  };
}

// Скрипт страницы в песочнице: fetch, таймеры и DOM подставные, запросы к api/ считаются.
// Запросы бренда (brand/...) идут в brandRespond, по умолчанию 404: папки бренда нет.
const NO_BRAND = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new SyntaxError('не JSON')) });
const NO_SERVICES = NO_BRAND;

function pageSandbox(respond, brandRespond = NO_BRAND, servicesRespond = NO_SERVICES) {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const box = { innerHTML: '', addEventListener() {} };
  const ids = ['top', 'brand-logo', 'brand-name', 'nav-all', 'nav-mine', 'nav-list', 'nav-current', 'side', 'nav-toggle', 'service-frame'];
  const elements = Object.fromEntries(ids.map((id) => [id, stubElement()]));
  elements['nav-all'].attrs['aria-current'] = 'page';
  elements['nav-toggle'].attrs['aria-expanded'] = 'false';
  const location = { hash: '' };
  const winOn = {};
  const intervals = new Map();
  const timeouts = [];
  const calls = [];
  const brandCalls = [];
  const serviceCalls = [];
  const cabinetCalls = [];
  let nextId = 1;
  const document = {
    title: 'Мой кабинет',
    getElementById: (id) => (id === 'processes' ? box : elements[id] ?? null),
    visibilityState: 'visible',
    addEventListener() {},
  };
  const sandbox = {
    window: {
      CabinetRender: {
        ...window.CabinetRender,
        renderPage: (list, messages, view) => `карточек: ${list.length}` + (view && view.key ? `, подробно: ${view.key}` : ''),
      },
      addEventListener(type, fn) {
        (winOn[type] ??= []).push(fn);
      },
      scrollTo() {},
    },
    location,
    document,
    fetch: (url, opts) => {
      if (String(url).startsWith('brand/')) {
        brandCalls.push(url);
        return brandRespond(url, opts);
      }
      if (String(url).startsWith('api/services')) {
        serviceCalls.push({ url, opts });
        return servicesRespond(url, opts);
      }
      // Папка кабинета для «Редактировать» (api/cabinet): один запрос при загрузке, в счёт опроса не идёт.
      if (String(url).startsWith('api/cabinet')) {
        cabinetCalls.push({ url, opts });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ root: 'C:\\Users\\u\\Documents\\ai-cabinet' }) });
      }
      calls.push(url);
      return respond(url, opts);
    },
    setTimeout: (fn) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    JSON,
    Promise,
    setInterval: (fn) => {
      intervals.set(nextId, fn);
      return nextId++;
    },
    clearInterval: (id) => intervals.delete(id),
    encodeURIComponent,
    Error,
    Array,
    String,
  };
  runInNewContext(code, sandbox);
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    box,
    calls,
    brandCalls,
    serviceCalls,
    cabinetCalls,
    timeouts,
    elements,
    document,
    intervals,
    location,
    fire(type) {
      for (const fn of winOn[type] ?? []) fn({});
    },
    async tick() {
      for (const fn of [...intervals.values()]) fn();
      await settle();
      await settle();
    },
    settle,
  };
}

test('страница: после трёх неудачных запросов подряд опрос останавливается с подсказкой', async () => {
  const p = pageSandbox(() => Promise.reject(new TypeError('Failed to fetch')));
  await p.settle();
  await p.settle();
  assert.equal(p.calls.length, 1);
  assert.match(p.box.innerHTML, /Страница не отвечает/);
  await p.tick();
  assert.equal(p.calls.length, 2);
  await p.tick();
  assert.equal(p.calls.length, 3);
  assert.match(p.box.innerHTML, /Страница остановлена\. Скажите Claude «открой страницу»\./);
  assert.equal(p.intervals.size, 0, 'опрос раз в 10 секунд не снят');
  await p.tick();
  assert.equal(p.calls.length, 3, 'после остановки вкладка снова спрашивает');
});

test('страница: ответ 403 (чужой или старый токен) считается неудачей; удачный ответ обнуляет счёт', async () => {
  let mode = 'fail';
  const p = pageSandbox(() => {
    if (mode === 'ok') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    return Promise.resolve({ ok: false, status: 403, json: () => Promise.reject(new SyntaxError('не JSON')) });
  });
  await p.settle();
  await p.settle();
  await p.tick();
  assert.equal(p.calls.length, 2);
  mode = 'ok';
  await p.tick();
  assert.match(p.box.innerHTML, /карточек: 0/);
  mode = 'fail';
  await p.tick();
  await p.tick();
  assert.equal(p.intervals.size, 1, 'остановилась раньше трёх неудач подряд');
  await p.tick();
  assert.equal(p.calls.length, 6);
  assert.match(p.box.innerHTML, /Страница остановлена/);
  assert.equal(p.intervals.size, 0);
});

// Бренд в песочнице: brand.json отвечает brandRespond, логотип «загружается» вызовом его обработчика.
const brandJson = (data) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
const OK_LIST = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });

test('бренд: папки нет, шапка без логотипа и названия, svg и png пробуются по разу', async () => {
  const p = pageSandbox(OK_LIST);
  await p.settle();
  await p.settle();
  const logo = p.elements['brand-logo'];
  assert.equal(logo.src, 'brand/logo.svg');
  logo.on.error();
  assert.equal(logo.src, 'brand/logo.png');
  logo.on.error();
  assert.equal(logo.src, 'brand/logo.png', 'после png ничего больше не пробует');
  assert.equal(logo.hidden, true);
  assert.equal(p.elements['brand-name'].hidden, true);
  assert.equal(p.elements.top.className, 'top');
  assert.equal(p.document.title, 'Мой кабинет');
  assert.deepEqual(p.brandCalls, ['brand/brand.json']);
  assert.deepEqual(p.calls, ['api/processes'], 'запросы бренда не мешают счёту запросов страницы');
  assert.match(p.box.innerHTML, /карточек: 0/);
});

test('бренд: логотип и название, название в заголовке вкладки и подписи логотипа, текстом не повторяется', async () => {
  const p = pageSandbox(OK_LIST, brandJson({ name: '  Компания Пример  ' }));
  p.elements['brand-logo'].on.load();
  await p.settle();
  await p.settle();
  assert.equal(p.elements['brand-logo'].hidden, false);
  assert.equal(p.elements['brand-logo'].alt, 'Компания Пример');
  assert.equal(p.elements['brand-name'].hidden, true);
  assert.equal(p.elements.top.className, 'top branded');
  assert.equal(p.document.title, 'Мой кабинет · Компания Пример');
});

test('бренд: название без логотипа показывается текстом в шапке', async () => {
  const p = pageSandbox(OK_LIST, brandJson({ name: 'Компания Пример' }));
  await p.settle();
  await p.settle();
  p.elements['brand-logo'].on.error();
  p.elements['brand-logo'].on.error();
  const name = p.elements['brand-name'];
  assert.equal(name.hidden, false);
  assert.equal(name.textContent, 'Компания Пример');
  assert.equal(p.elements['brand-logo'].hidden, true);
  assert.equal(p.elements.top.className, 'top branded');
});

test('бренд: brand.json без строки name или не объект не меняет шапку, длинное название обрезается', async () => {
  for (const data of [[], { name: 5 }, { name: '   ' }, null, 'Компания']) {
    const p = pageSandbox(OK_LIST, brandJson(data));
    await p.settle();
    await p.settle();
    assert.equal(p.elements['brand-name'].hidden, true, JSON.stringify(data));
    assert.equal(p.document.title, 'Мой кабинет', JSON.stringify(data));
  }
  const p = pageSandbox(OK_LIST, brandJson({ name: 'Я'.repeat(200) }));
  await p.settle();
  await p.settle();
  assert.equal(p.elements['brand-name'].textContent.length, 80);
  const broken = pageSandbox(OK_LIST, () => Promise.reject(new TypeError('Failed to fetch')));
  await broken.settle();
  await broken.settle();
  assert.equal(broken.elements['brand-name'].hidden, true);
  assert.match(broken.box.innerHTML, /карточек: 0/);
});

test('страница: меню «Мои сервисы» из списка процессов, #p=<slug> открывает процесс справа без перезагрузки', async () => {
  const list = [
    { slug: 'svetofor-tochek', title: 'Светофор точек продаж', kind: 'script', result: { status: 'red', updated_at: '2026-10-22T14:05:09' } },
    { slug: 'vtoroi', title: 'Второй', kind: 'script', result: null },
  ];
  const p = pageSandbox(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(list) }));
  await p.settle();
  await p.settle();
  const el = p.elements;
  assert.equal(p.box.innerHTML, 'карточек: 2');
  assert.equal(el['nav-mine'].hidden, false);
  assert.match(el['nav-list'].innerHTML, /href="#p=svetofor-tochek"><span class="dot dot-red"/);
  assert.match(el['nav-list'].innerHTML, /href="#p=vtoroi"><span class="dot dot-none"/);
  assert.equal(el['nav-all'].attrs['aria-current'], 'page');
  assert.equal(el['nav-current'].textContent, 'Все сервисы');

  p.location.hash = '#p=vtoroi';
  p.fire('hashchange');
  assert.equal(p.box.innerHTML, 'карточек: 2, подробно: p:vtoroi');
  assert.equal(el['nav-all'].attrs['aria-current'], undefined);
  assert.match(el['nav-list'].innerHTML, /href="#p=vtoroi" aria-current="page"/);
  assert.equal(el['nav-current'].textContent, 'Второй');
  assert.deepEqual(p.calls, ['api/processes'], 'переход без запроса к странице');

  // Такого процесса нет (удалили, опечатка в адресе): сетка всех сервисов.
  p.location.hash = '#p=net-takogo';
  p.fire('hashchange');
  assert.equal(p.box.innerHTML, 'карточек: 2');
  assert.equal(el['nav-all'].attrs['aria-current'], 'page');
  p.location.hash = '';
  p.fire('hashchange');
  assert.equal(p.box.innerHTML, 'карточек: 2');
});

test('страница: своих сервисов нет → раздела «Мои сервисы» в меню нет; на узком экране «Меню» раскрывается', async () => {
  const p = pageSandbox(OK_LIST);
  await p.settle();
  await p.settle();
  assert.equal(p.elements['nav-mine'].hidden, true);
  assert.equal(p.elements['nav-list'].innerHTML, '');
  const toggle = p.elements['nav-toggle'];
  toggle.on.click();
  assert.equal(p.elements.side.className, 'side open');
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  toggle.on.click();
  assert.equal(p.elements.side.className, 'side');
  toggle.on.click();
  p.fire('hashchange');
  assert.equal(p.elements.side.className, 'side', 'выбор пункта сворачивает меню');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
});

// ---------- встроенные проекты сервисов (api/services) ----------

const svodka = {
  source: 'service',
  slug: 'svodka-tochki',
  name: 'Сводка продаж по Точка',
  about: 'Каждый понедельник сумма по Точка',
  kind: 'run',
  running: false,
  error: null,
  result: { ...demo.result, title: 'Сводка продаж по Точка', status: 'yellow', summary: 'Сумма за неделю 862 935.', files: ['output/svodka.xlsx', 'output/sub/otchet 1.xlsx', '../secret.xlsx', 'input/x.csv'] },
};

test('встроенный проект: карточка как у процесса, «Запустить» зовёт свой адрес, подробный вид #s=<slug>', () => {
  const tile = renderTile(svodka);
  assert.match(tile, /^<article class="tile" data-slug="svodka-tochki" data-source="service">/);
  assert.match(tile, /<span class="badge badge-yellow">жёлтый<\/span>/);
  assert.match(tile, /<h2 class="tile-title"><a href="#s=svodka-tochki">Сводка продаж по Точка<\/a><\/h2>/);
  assert.match(tile, /<p class="tile-sum" [^>]*>Сумма за неделю 862 935\.<\/p>/);
  assert.match(tile, /<button type="button" class="run" data-run-service="svodka-tochki">Запустить<\/button>/);
  assert.doesNotMatch(tile, /data-run="|Открыть/);
  assert.match(tile, /<a class="btn more" href="#s=svodka-tochki">Подробнее<\/a>/);
  assert.match(renderTile({ ...svodka, running: true }), /data-run-service="svodka-tochki" disabled>идёт расчёт…/);
  // Без результата: описание проекта вместо итога.
  assert.match(renderTile({ ...svodka, result: null }), /<p class="tile-when">ещё не запускался<\/p><p class="tile-sum tile-about">Каждый понедельник сумма по Точка<\/p>/);

  const card = renderPage([demo, svodka], { 's:svodka-tochki': 'не удалось' }, { key: 's:svodka-tochki' });
  assert.match(card, /<a class="back" href="#">← Все сервисы<\/a>/);
  assert.match(card, /<h2>Сводка продаж по Точка<\/h2>/);
  assert.match(card, /data-run-service="svodka-tochki">Запустить/);
  assert.match(card, /class="run-error"[^>]*>не удалось</);
  // Файлы проекта: только из его output/, по адресу s/<slug>/output/...
  assert.match(card, /<a href="s\/svodka-tochki\/output\/svodka\.xlsx" download>svodka\.xlsx<\/a>/);
  assert.match(card, /href="s\/svodka-tochki\/output\/sub\/otchet%201\.xlsx"/);
  assert.equal((card.match(/download>/g) ?? []).length, 2);
  assert.doesNotMatch(card, /secret|input\/x\.csv/);
});

test('встроенный проект со своей страницей (kind page): «Открыть» ведёт в подробный вид внутри кабинета, «Запустить» только если есть run', () => {
  const page = { ...svodka, slug: 'karta-tochki', name: 'Карта Точка', kind: 'page', result: null };
  const tile = renderTile(page);
  assert.match(tile, /<div class="tile-actions"><a class="btn open" href="#s=karta-tochki">Открыть<\/a><\/div>/);
  assert.doesNotMatch(tile, /<button|ещё не запускался|Подробнее/);
  // Подробный вид: ссылка на саму страницу в новой вкладке; таблицу и итог показывает страница (рамка в index.html).
  const card = renderCard(page);
  assert.match(card, /<article class="card card-page"/);
  assert.match(card, /<a class="btn open" href="s\/karta-tochki\/" target="_blank" rel="noopener">В новой вкладке<\/a>/);
  assert.match(card, /результата пока нет/);
  const done = renderCard({ ...page, run: true, result: svodka.result });
  assert.match(done, /обновлено /);
  assert.doesNotMatch(done, /<table|class="summary"|download>/);
  const both = renderTile({ ...page, run: 'main.py' });
  assert.match(both, /data-run-service="karta-tochki">Запустить<\/button><a class="btn open" href="#s=karta-tochki">Открыть<\/a>/);
  // slug кодируется и в ссылках.
  assert.match(renderTile({ ...page, slug: 'a b' }), /href="#s=a%20b"/);
  assert.match(renderCard({ ...page, slug: 'a b' }), /href="s\/a%20b\/"/);
  // Обычный проект: «Подробнее» на месте, ссылок на свою страницу нет.
  assert.match(renderTile(svodka), /Подробнее/);
  assert.doesNotMatch(renderCard(svodka), /В новой вкладке|card-page/);
});

test('servicesFrom: список или объект со списком, пометка source, записи без slug пропускаются', () => {
  // Массивы из песочницы vm: сравниваем через JSON (у них свой Array.prototype).
  assert.equal(JSON.stringify(servicesFrom(null)), '[]');
  assert.equal(JSON.stringify(servicesFrom({ error: 'x' })), '[]');
  const list = servicesFrom([{ slug: 'a', name: 'А' }, { name: 'без slug' }, null, 'строка', { slug: '' }]);
  assert.equal(JSON.stringify(list.map((x) => [x.slug, x.source])), '[["a","service"]]');
  assert.equal(servicesFrom({ services: [{ slug: 'b' }] })[0].slug, 'b');
  assert.equal(servicesFrom({ items: [{ slug: 'c' }] })[0].slug, 'c');
  // Чужое поле source не мешает: проект всегда помечен как проект.
  assert.equal(servicesFrom([{ slug: 'd', source: 'process' }])[0].source, 'service');
  // Меню: процессы и проекты вместе, у проекта ссылка #s=.
  assert.match(renderNav([demo, ...servicesFrom([{ slug: 'd', name: 'Д' }])], 's:d', './'), /href="\.\/#p=svetofor-tochek">[\s\S]*href="\.\/#s=d" aria-current="page">/);
});

const listOf = (data) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });

test('страница: карточки и меню из двух источников; api/services нет (404) → только процессы, больше не спрашивает', async () => {
  const procs = [{ slug: 'svetofor-tochek', title: 'Светофор точек продаж', kind: 'script', result: null }];
  const p = pageSandbox(listOf(procs), NO_BRAND, listOf([{ slug: 'svodka-tochki', name: 'Сводка продаж по Точка', kind: 'run', result: null }]));
  await p.settle();
  await p.settle();
  assert.equal(p.box.innerHTML, 'карточек: 2');
  assert.match(p.elements['nav-list'].innerHTML, /href="#p=svetofor-tochek"[\s\S]*href="#s=svodka-tochki"/);
  p.location.hash = '#s=svodka-tochki';
  p.fire('hashchange');
  assert.equal(p.box.innerHTML, 'карточек: 2, подробно: s:svodka-tochki');
  assert.equal(p.elements['nav-current'].textContent, 'Сводка продаж по Точка');

  const old = pageSandbox(listOf(procs));
  await old.settle();
  await old.settle();
  assert.equal(old.box.innerHTML, 'карточек: 1');
  await old.tick();
  assert.equal(old.serviceCalls.length, 1, 'после 404 api/services больше не спрашивается');
  assert.equal(old.calls.length, 2);

  // Ошибка api/services (500, не JSON, сеть): проектов просто не видно, страница работает, счёт неудач не растёт.
  for (const bad of [
    () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'x' }) }),
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('не JSON')) }),
    () => Promise.reject(new TypeError('Failed to fetch')),
  ]) {
    const q = pageSandbox(listOf(procs), NO_BRAND, bad);
    await q.settle();
    await q.settle();
    assert.equal(q.box.innerHTML, 'карточек: 1');
    for (let i = 0; i < 3; i++) await q.tick();
    assert.equal(q.intervals.size, 1, 'страница не остановилась');
    assert.equal(q.serviceCalls.length, 4, 'после ошибки (не 404) api/services спрашивается снова');
  }
});

test('страница: своя страница сервиса (kind page) в рамке под карточкой, перезагрузка только после пересчёта', async () => {
  const procs = [{ slug: 'svetofor-tochek', title: 'Светофор точек продаж', kind: 'script', result: null }];
  let karta = { slug: 'karta-tochki', name: 'Карта "Точка"', kind: 'page', page: 's/karta-tochki/', run: true, result: { updated_at: '2026-10-30T10:00:00+05:00' }, lastRun: null };
  const svodkaItem = { slug: 'svodka-tochki', name: 'Сводка', kind: 'run', page: null, result: null };
  const p = pageSandbox(listOf(procs), NO_BRAND, () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([karta, svodkaItem]) }));
  await p.settle();
  await p.settle();
  const frame = p.elements['service-frame'];
  assert.equal(frame.hidden, true, 'на сетке рамки нет');
  assert.equal(frame.innerHTML, '');

  p.location.hash = '#s=karta-tochki';
  p.fire('hashchange');
  assert.equal(frame.hidden, false);
  assert.equal(frame.innerHTML, '<iframe class="service-frame" src="s/karta-tochki/" title="Карта &quot;Точка&quot;"></iframe>');

  // Опрос без изменений: рамка не пересоздаётся (страница не перезагружается). Проверяем по подмене innerHTML.
  frame.innerHTML = 'та же рамка';
  await p.tick();
  assert.equal(frame.innerHTML, 'та же рамка');
  // Идёт расчёт с новым временем: ждём конца.
  karta = { ...karta, running: true, lastRun: { ok: true, code: 0, finishedAt: '2026-10-30T10:05:00+05:00' } };
  await p.tick();
  assert.equal(frame.innerHTML, 'та же рамка');
  // Расчёт закончился: рамка заново, страница с новыми данными.
  karta = { ...karta, running: false };
  await p.tick();
  assert.match(frame.innerHTML, /^<iframe class="service-frame" src="s\/karta-tochki\/"/);

  // Обычный проект и сетка: рамка убирается.
  p.location.hash = '#s=svodka-tochki';
  p.fire('hashchange');
  assert.equal(frame.hidden, true);
  assert.equal(frame.innerHTML, '');
  p.location.hash = '#s=karta-tochki';
  p.fire('hashchange');
  assert.equal(frame.hidden, false);
  p.location.hash = '';
  p.fire('hashchange');
  assert.equal(frame.hidden, true);
});

test('страница: «Запустить» у проекта → POST api/services/run {slug}; 202 → опрос списка; ошибка → текст на карточке', async () => {
  let running = false;
  let runResponse = { status: 202, body: { started: true } };
  const services = (url, opts) => {
    if (url === 'api/services/run') {
      running = runResponse.status === 202;
      return Promise.resolve({ ok: runResponse.status < 300, status: runResponse.status, json: () => Promise.resolve(runResponse.body) });
    }
    return listOf([{ slug: 'svodka-tochki', name: 'Сводка', kind: 'run', running, result: null }])();
  };
  const q = pageSandboxWithClicks(listOf([]), services);
  await q.settle();
  await q.settle();
  q.click('svodka-tochki');
  await q.settle();
  const run = q.serviceCalls.find((c) => c.url === 'api/services/run');
  assert.ok(run, 'запрос на запуск ушёл');
  assert.equal(run.opts.method, 'POST');
  assert.equal(run.opts.headers['X-Cabinet'], '1');
  assert.equal(run.opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(run.opts.body), { slug: 'svodka-tochki' });
  // 202: через 2 секунды список перечитывается, пока проект считается.
  const before = q.serviceCalls.filter((c) => c.url === 'api/services').length;
  running = false;
  q.flushTimeouts();
  await q.settle();
  await q.settle();
  assert.equal(q.serviceCalls.filter((c) => c.url === 'api/services').length, before + 1);

  runResponse = { status: 422, body: { error: 'В проекте нет файла main.py' } };
  q.click('svodka-tochki');
  await q.settle();
  await q.settle();
  assert.equal(q.messages()['s:svodka-tochki'], 'В проекте нет файла main.py');
});

// Песочница с настоящим обработчиком щелчка по карточкам; renderPage подменён и запоминает сообщения карточек.
function pageSandboxWithClicks(respond, servicesRespond) {
  let lastMessages = {};
  const onMessages = (m) => (lastMessages = m);
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  let onClick = null;
  const box = {
    innerHTML: '',
    addEventListener(type, fn) {
      if (type === 'click') onClick = fn;
    },
  };
  const ids = ['top', 'brand-logo', 'brand-name', 'nav-all', 'nav-mine', 'nav-list', 'nav-current', 'side', 'nav-toggle', 'service-frame'];
  const elements = Object.fromEntries(ids.map((id) => [id, stubElement()]));
  const timeouts = [];
  const serviceCalls = [];
  const sandbox = {
    window: {
      CabinetRender: {
        ...window.CabinetRender,
        renderPage: (list, messages) => {
          onMessages({ ...messages });
          return `карточек: ${list.length}`;
        },
      },
      addEventListener() {},
    },
    location: { hash: '' },
    document: { title: '', getElementById: (id) => (id === 'processes' ? box : elements[id] ?? null), visibilityState: 'visible', addEventListener() {} },
    fetch: (url, opts) => {
      if (String(url).startsWith('brand/')) return NO_BRAND();
      if (String(url).startsWith('api/services')) {
        serviceCalls.push({ url, opts });
        return servicesRespond(url, opts);
      }
      return respond(url, opts);
    },
    setTimeout: (fn) => timeouts.push(fn),
    setInterval: () => 1,
    clearInterval() {},
    encodeURIComponent,
    JSON,
    Promise,
    Error,
    Array,
    String,
  };
  runInNewContext(code, sandbox);
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    box,
    serviceCalls,
    settle,
    messages: () => lastMessages,
    click(slug) {
      const button = { disabled: false, getAttribute: (k) => (k === 'data-run-service' ? slug : null) };
      onClick({ target: { closest: (sel) => (sel === 'button[data-run-service]' ? button : null) } });
    },
    flushTimeouts() {
      for (const fn of timeouts.splice(0)) fn();
    },
  };
}
