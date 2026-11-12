// Страница кабинета и сервисы-проекты: api/services, api/services/run, статика s/<slug>/page и s/<slug>/output.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { createCabinetServer, listenFirstFree } from '../serve.mjs';
import { attachServices, serviceRoute } from '../services-api.mjs';
import { addService, createProject } from '../services.mjs';
import { stopDev } from '../web.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = '5e7a1c9d0b2f4e6a8c1d3f5a7b9c0e2d';
const T = `/${TOKEN}`;
const RUN_HEADERS = { 'X-Cabinet': '1', 'Content-Type': 'application/json' };

const RESULT_PY = `import json
from datetime import datetime
from pathlib import Path

out = Path("output")
out.mkdir(exist_ok=True)
(out / "svodka.csv").write_text("Точка;Сумма\\nТочка-01;1200\\n", encoding="utf-8")
res = {"title": "Сводка", "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
       "status": "green", "summary": "Сумма: 1200.", "columns": ["Точка", "Сумма"], "rows": [["Точка-01", 1200]],
       "files": ["output/svodka.csv"]}
(out / "result.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
`;

let base, cab, home, server, port;
const dirs = {};

function project(folder, service, files) {
  const dir = join(home, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'service.json'), JSON.stringify({ about: '', input: 'input/', result: 'output/result.json', page: null, ...service }, null, 2));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  dirs[folder] = dir;
  return dir;
}

let linksOk = true;

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'svc-api-'));
  cab = join(base, 'Айгуль Н', 'ai-cabinet');
  home = join(base, 'Айгуль Н', 'Сервисы');
  mkdirSync(join(cab, 'me'), { recursive: true });
  copyDir(join(ROOT, 'templates', 'site'), join(cab, 'site'));
  // tools/ кабинета: оттуда run кладёт lib/llm.py и lib/read_table.py в проект.
  copyDir(join(ROOT, 'tools'), join(cab, 'tools'));
  rmSync(join(cab, 'tools', 'tests'), { recursive: true, force: true });
  writeFileSync(join(cab, 'CLAUDE.md'), 'правила кабинета');
  project('svodka', { name: 'Сводка продаж', kind: 'run', run: 'main.py' }, { 'main.py': RESULT_PY });
  project('Отчёт страница', { name: 'Отчёт страницей', kind: 'page', run: null, result: null, page: 'page/' }, {
    'page/index.html': '<!doctype html><h1>Отчёт</h1><script src="app.js"></script>',
    'page/app.js': "fetch('../output/data.json')",
    'page/style.css': 'h1 { color: navy }',
    'page/secret.txt': 'не отдаётся',
    'page/.hidden.json': '{}',
    'page/sub/index.html': '<p>вложенная</p>',
    'output/data.json': '{"сумма": 1200}',
    'output/chart.png': 'png',
    'output/last-run.log': 'журнал',
    'output/.env.json': '{"key": "секрет"}',
    'main.py': 'print(1)\n',
  });
  project('dolgiy', { name: 'Долгий', kind: 'run', run: 'main.py' }, { 'main.py': 'import time\ntime.sleep(1.5)\n' });
  project('zapret', { name: 'Запрет', kind: 'run', run: 'main.py' }, { 'main.py': RESULT_PY });
  writeFileSync(join(home, 'secret.json'), '{"чужое": true}');
  mkdirSync(join(base, 'naruzhu'), { recursive: true });
  writeFileSync(join(base, 'naruzhu', 'x.json'), '{"наружу": true}');
  try {
    symlinkSync(join(home, 'secret.json'), join(dirs['Отчёт страница'], 'page', 'link.json'), 'file');
    symlinkSync(join(base, 'naruzhu'), join(dirs['Отчёт страница'], 'page', 'linkdir'), 'junction');
    symlinkSync(join(home, 'secret.json'), join(dirs['Отчёт страница'], 'output', 'link.json'), 'file');
  } catch {
    linksOk = false;
  }
  for (const d of Object.values(dirs)) addService(cab, d);
  // Программу поправили после «добавь в кабинет»: кнопка её не запустит.
  writeFileSync(join(dirs.zapret, 'main.py'), `import subprocess\n${RESULT_PY}`);
  server = createCabinetServer(cab, { token: TOKEN });
  port = await listenFirstFree(server, { from: 19400, to: 19499 });
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

// http.request без нормализации пути (fetch схлопывает /../).
function request(method, path, headers = {}, body) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // не JSON
        }
        res({ status: r.statusCode, headers: r.headers, body: text, json });
      });
    });
    req.on('error', rej);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDone(slug, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await request('GET', `${T}/api/services/status/${slug}`);
    if (r.status === 200 && !r.json.running && r.json.lastRun) return r.json;
    await sleep(50);
  }
  throw new Error(`не дождались конца расчёта ${slug}`);
}

test('без токена и с чужим токеном: 403, сервисы и их файлы не видны', async () => {
  for (const path of ['/api/services', '/s/svodka/output/svodka.csv', `/${'0'.repeat(32)}/api/services`, `/${'0'.repeat(32)}/s/otchet-stranitsey/page/`]) {
    const r = await request('GET', path);
    assert.equal(r.status, 403, path);
    assert.doesNotMatch(r.body, /Сводка|Отчёт/);
  }
  const p = await request('POST', '/api/services/run', RUN_HEADERS, JSON.stringify({ slug: 'svodka' }));
  assert.equal(p.status, 403);
});

test('GET api/services: реестр и карточка каждого сервиса, как у процессов', async () => {
  const r = await request('GET', `${T}/api/services`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.ok(Array.isArray(r.json));
  const by = Object.fromEntries(r.json.map((s) => [s.slug, s]));
  assert.deepEqual(Object.keys(by).sort(), ['dolgiy', 'otchet-stranitsey', 'svodka', 'zapret']);
  const s = by.svodka;
  assert.equal(s.name, 'Сводка продаж');
  assert.equal(s.title, 'Сводка продаж');
  assert.equal(s.kind, 'run');
  assert.equal(s.run, true);
  assert.equal(s.page, null);
  assert.equal(s.running, false);
  assert.equal(s.error, null);
  const pg = by['otchet-stranitsey'];
  assert.equal(pg.kind, 'page');
  assert.equal(pg.run, false);
  assert.equal(pg.page, 's/otchet-stranitsey/');
  const w = await request('POST', `${T}/api/services`, RUN_HEADERS, '{}');
  assert.equal(w.status, 405);
  // Остальная страница работает как раньше.
  assert.equal((await request('GET', `${T}/api/processes`)).status, 200);
  assert.equal((await request('GET', `${T}/`)).status, 200);
  assert.equal((await request('GET', `${T}/api/services/nichego`)).status, 404);
});

test('POST api/services/run: только со страницы (X-Cabinet и JSON), неизвестный сервис 404', async () => {
  const body = JSON.stringify({ slug: 'svodka' });
  assert.equal((await request('POST', `${T}/api/services/run`, { 'Content-Type': 'application/json' }, body)).status, 403);
  assert.equal((await request('POST', `${T}/api/services/run`, { 'X-Cabinet': '1', 'Content-Type': 'text/plain' }, body)).status, 403);
  assert.equal((await request('POST', `${T}/api/services/run`, { 'X-Cabinet': '1' }, body)).status, 403);
  const g = await request('GET', `${T}/api/services/run`);
  assert.equal(g.status, 405);
  assert.equal(g.headers.allow, 'POST');
  for (const b of [JSON.stringify({ slug: 'net-takogo' }), JSON.stringify({ slug: '../svodka' }), '{"slug": ', '[]']) {
    const r = await request('POST', `${T}/api/services/run`, RUN_HEADERS, b);
    assert.equal(r.status, 404, b);
    assert.ok(r.json.error);
  }
});

test('POST api/services/run: 202, расчёт в папке проекта, карточка с результатом и последним запуском', async () => {
  const r = await request('POST', `${T}/api/services/run`, RUN_HEADERS, JSON.stringify({ slug: 'svodka' }));
  assert.equal(r.status, 202, r.body);
  assert.equal(r.json.started, true);
  const st = await waitDone('svodka');
  assert.equal(st.lastRun.ok, true);
  const list = (await request('GET', `${T}/api/services`)).json;
  const s = list.find((x) => x.slug === 'svodka');
  assert.equal(s.result.status, 'green');
  assert.equal(s.result.summary, 'Сумма: 1200.');
  assert.deepEqual(s.result.files, ['output/svodka.csv']);
  assert.equal(s.lastRun.ok, true);
  // Файл результата по ссылке карточки: s/<slug>/output/..., на скачивание.
  const f = await request('GET', `${T}/s/svodka/output/svodka.csv`);
  assert.equal(f.status, 200);
  assert.match(f.body, /Точка-01;1200/);
  assert.match(f.headers['content-disposition'], /^attachment/);
  assert.equal(f.headers['content-security-policy'], 'sandbox');
});

test('двойной запуск: второй POST получает 409 ERUNNING', async () => {
  const body = JSON.stringify({ slug: 'dolgiy' });
  const first = await request('POST', `${T}/api/services/run`, RUN_HEADERS, body);
  assert.equal(first.status, 202);
  const second = await request('POST', `${T}/api/services/run`, RUN_HEADERS, body);
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'ERUNNING');
  const list = (await request('GET', `${T}/api/services`)).json;
  assert.equal(list.find((x) => x.slug === 'dolgiy').running, true);
  await waitDone('dolgiy');
});

test('программа с запрещённым после «добавь в кабинет»: кнопка не запускает, 400 с причиной', async () => {
  const r = await request('POST', `${T}/api/services/run`, RUN_HEADERS, JSON.stringify({ slug: 'zapret' }));
  assert.equal(r.status, 400, r.body);
  assert.equal(r.json.code, 'EBADSERVICE');
  assert.match(r.json.error, /запуск программ/);
});

test('статика kind page: s/<slug>/ ведёт на page/, файлы page и output, данные по ../output/ и output/', async () => {
  const s = 'otchet-stranitsey';
  for (const path of [`${T}/s/${s}/`, `${T}/s/${s}`, `${T}/s/${s}/page`]) {
    const r = await request('GET', path);
    assert.equal(r.status, 302, path);
    assert.equal(r.headers.location, `${T}/s/${s}/page/`);
  }
  const html = await request('GET', `${T}/s/${s}/page/`);
  assert.equal(html.status, 200);
  assert.match(html.headers['content-type'], /text\/html/);
  assert.match(html.body, /<h1>Отчёт<\/h1>/);
  assert.equal(html.headers['referrer-policy'], 'no-referrer');
  assert.match((await request('GET', `${T}/s/${s}/page/app.js`)).headers['content-type'], /javascript/);
  assert.equal((await request('GET', `${T}/s/${s}/page/style.css`)).status, 200);
  assert.match((await request('GET', `${T}/s/${s}/page/sub/`)).body, /вложенная/);
  const data = await request('GET', `${T}/s/${s}/output/data.json`);
  assert.equal(data.status, 200);
  assert.deepEqual(data.json, { сумма: 1200 });
  // Страница сослалась на output/data.json от своей папки: тот же файл.
  assert.deepEqual((await request('GET', `${T}/s/${s}/page/output/data.json`)).json, { сумма: 1200 });
  assert.equal((await request('GET', `${T}/s/${s}/output/chart.png`)).headers['content-type'], 'image/png');
  const head = await request('HEAD', `${T}/s/${s}/page/`);
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await request('POST', `${T}/s/${s}/page/`, RUN_HEADERS, '{}')).status, 405);
});

test('статика: другие виды файлов, скрытые, файлы проекта вне page и output, выход за папку: 404', async () => {
  const s = 'otchet-stranitsey';
  const paths = [
    `/s/${s}/page/secret.txt`,
    `/s/${s}/page/.hidden.json`,
    `/s/${s}/output/last-run.log`,
    `/s/${s}/output/.env.json`,
    `/s/${s}/main.py`,
    `/s/${s}/service.json`,
    `/s/${s}/page/../service.json`,
    `/s/${s}/page/..%2Fservice.json`,
    `/s/${s}/page/..%5Cservice.json`,
    `/s/${s}/output/..%2F..%2Fsecret.json`,
    `/s/${s}/page/%2e%2e/%2e%2e/secret.json`,
    `/s/${s}/output/%2e%2e/%2e%2e/secret.json`,
    `/s/${s}/page/sub%2Findex.html`,
    `/s/${s}/page/C:%5Cx.json`,
    `/s/${s}/page/index.html%00.json`,
    `/s/svodka/`,
    `/s/svodka/page/`,
    `/s/svodka/output/result.json/`,
    `/s/net-takogo/page/`,
    `/s/..%2Fsvodka/output/svodka.csv`,
    `/s/SVODKA/output/svodka.csv`,
  ];
  for (const p of paths) {
    const r = await request('GET', `${T}${p}`);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /чужое|наружу|секрет|print/, p);
  }
});

test('статика: ссылки (symlink) в page и output не отдаются', async (t) => {
  if (!linksOk) return t.skip('ссылки на этом компьютере не создаются');
  const s = 'otchet-stranitsey';
  for (const p of [`/s/${s}/page/link.json`, `/s/${s}/page/linkdir/x.json`, `/s/${s}/output/link.json`]) {
    const r = await request('GET', `${T}${p}`);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /чужое|наружу/, p);
  }
});

test('attachServices: повторное подключение ничего не дублирует; маршрут только с верным токеном', async () => {
  assert.equal(attachServices(server, cab, { token: TOKEN }), server);
  assert.equal(server.listeners('request').length, 1);
  assert.equal((await request('GET', `${T}/api/services`)).status, 200);
  assert.deepEqual(serviceRoute(`${T}/api/services/run`, TOKEN), { api: 'run' });
  assert.deepEqual(serviceRoute(`${T}/api/services`, TOKEN), { api: '' });
  assert.deepEqual(serviceRoute(`${T}/s/a/page/x.js`, TOKEN), { static: ['a', 'page', 'x.js'] });
  assert.equal(serviceRoute('/api/services', TOKEN), null);
  assert.equal(serviceRoute(`${T}/api/processes`, TOKEN), null);
  assert.equal(serviceRoute(`${T}/api%2Fservices`, TOKEN), null);
});

// ---------- сервис для интернета (kind web): карточка сайта, код доступа, страница на компьютере ----------

function journalEvents() {
  const dir = join(cab, 'journal');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('web: карточка сайта вместо page/, итог до и после публикации, без «Запустить»', async () => {
  copyDir(join(ROOT, 'templates', 'web-service'), join(cab, 'templates', 'web-service'));
  const made = createProject(cab, 'Заявки', { kind: 'web', git: false });
  dirs.zayavki = made.dir;
  addService(cab, made.dir);
  let item = (await request('GET', `${T}/api/services`)).json.find((x) => x.slug === 'zayavki');
  assert.equal(item.kind, 'page');
  assert.equal(item.web, true);
  assert.equal(item.run, false);
  assert.equal(item.page, 's/zayavki/');
  assert.equal(item.result.summary, 'Не опубликован: скажите «опубликуй сервис» в папке сервиса');
  // s/<slug>/ и s/<slug>/page ведут на page/, там карточка сайта (файл курса tools/web-card.html).
  for (const path of [`${T}/s/zayavki/`, `${T}/s/zayavki`, `${T}/s/zayavki/page`]) {
    const r = await request('GET', path);
    assert.equal(r.status, 302, path);
    assert.equal(r.headers.location, `${T}/s/zayavki/page/`);
  }
  const card = await request('GET', `${T}/s/zayavki/page/`);
  assert.equal(card.status, 200);
  assert.match(card.headers['content-type'], /text\/html/);
  assert.equal(card.headers['content-security-policy'], "frame-ancestors 'self'");
  assert.equal(card.body, readFileSync(join(cab, 'tools', 'web-card.html'), 'utf8'));
  for (const text of ['Открыть сайт', 'Показать код', 'Показать на компьютере', 'Изменить сервис: кнопка «Редактировать» на карточке', '../../../ui/kabinet.css', '../../../api/services']) {
    assert.ok(card.body.includes(text), text);
  }
  assert.doesNotMatch(card.body, /[\u2012-\u2015]/, 'без тире');
  assert.equal((await request('GET', `${T}/s/zayavki/page/index.html`)).status, 200);
  // Файлы проекта через карточку не отдаются: ни public, ни page, ни api.
  for (const path of ['page/index2.html', 'page/app.js', 'public/index.html', 'page/../service.json', 'service.json']) {
    assert.equal((await request('GET', `${T}/s/zayavki/${path}`)).status, 404, path);
  }
  assert.equal((await request('GET', `${T}/s/zayavki/api/index.py`)).status, 405, 'адреса api/ только для действий (POST)');
  // Действия сайта кабинет не запускает: они работают на сайте (и на компьютере через «Показать на компьютере»).
  const call = await request('POST', `${T}/s/zayavki/api/zapisi`, RUN_HEADERS, '{}');
  assert.equal(call.status, 404);
  assert.equal(call.json.code, 'EWEB');
  // Запуска у сайта нет: 400 с причиной.
  const run = await request('POST', `${T}/api/services/run`, RUN_HEADERS, JSON.stringify({ slug: 'zayavki' }));
  assert.equal(run.status, 400);
  assert.equal(run.json.code, 'EWEB');
  // После публикации: адрес в итоге и в поле url.
  const sj = JSON.parse(readFileSync(join(made.dir, 'service.json'), 'utf8'));
  writeFileSync(join(made.dir, 'service.json'), JSON.stringify({ ...sj, publish: { url: 'https://zayavki-aigul.vercel.app', published_at: '2026-11-12T06:30:00+05:00' } }, null, 2));
  item = (await request('GET', `${T}/api/services`)).json.find((x) => x.slug === 'zayavki');
  assert.equal(item.url, 'https://zayavki-aigul.vercel.app');
  assert.equal(item.result.status, 'green');
  assert.equal(item.result.summary, 'Опубликован: https://zayavki-aigul.vercel.app');
  assert.equal(item.result.updated_at, '2026-11-12T06:30:00+05:00');
});

test('web: код доступа только с заголовком X-Cabinet; нет кода или не сайт: 404; запись в журнал', async () => {
  const path = `${T}/api/services/zayavki/code`;
  assert.equal((await request('GET', path)).status, 403);
  assert.equal((await request('GET', path, { 'X-Cabinet': '0' })).status, 403);
  const none = await request('GET', path, { 'X-Cabinet': '1' });
  assert.equal(none.status, 404);
  assert.match(none.json.error, /опубликуй сервис/);
  writeFileSync(join(dirs.zayavki, '.env'), 'SERVICE_ACCESS_CODE=kot-dom-les\nSERVICE_ACCESS_CODE_HASH=x\n');
  const ok = await request('GET', path, { 'X-Cabinet': '1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { code: 'kot-dom-les' });
  assert.equal((await request('GET', `${T}/api/services/svodka/code`, { 'X-Cabinet': '1' })).status, 404);
  assert.equal((await request('GET', `${T}/api/services/net-takogo/code`, { 'X-Cabinet': '1' })).status, 404);
  assert.equal((await request('POST', path, RUN_HEADERS, '{}')).status, 405);
  // Без токена страницы: 403, как у всего кабинета.
  assert.equal((await request('GET', '/api/services/zayavki/code', { 'X-Cabinet': '1' })).status, 403);
  const ev = journalEvents().filter((e) => e.event === 'web.code.show' && e.service === 'zayavki');
  assert.deepEqual(ev.map((e) => e.ok), [false, true]);
  assert.ok(!JSON.stringify(journalEvents()).includes('kot-dom-les'), 'кода в журнале нет');
});

test('web: «Показать на компьютере» запускает страницу один раз, повтор отдаёт тот же адрес', { timeout: 90000 }, async () => {
  const path = `${T}/api/services/zayavki/dev`;
  assert.equal((await request('GET', path)).status, 405);
  assert.equal((await request('POST', path, { 'Content-Type': 'application/json' }, '{}')).status, 403);
  assert.equal((await request('POST', `${T}/api/services/svodka/dev`, RUN_HEADERS, '{}')).status, 404);
  try {
    const first = await request('POST', path, RUN_HEADERS, '{}');
    assert.equal(first.status, 200, first.body);
    assert.match(first.json.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(first.json.already, false);
    const state = JSON.parse(readFileSync(join(dirs.zayavki, 'output', '.web-dev.json'), 'utf8'));
    const second = await request('POST', path, RUN_HEADERS, '{}');
    assert.equal(second.status, 200, second.body);
    assert.deepEqual(second.json, { url: first.json.url, already: true });
    assert.equal(JSON.parse(readFileSync(join(dirs.zayavki, 'output', '.web-dev.json'), 'utf8')).pid, state.pid, 'второй процесс не запущен');
    const health = await new Promise((done) => http.get(`${first.json.url}api/health`, (r) => { r.resume(); done(r.statusCode); }).on('error', () => done(0)));
    assert.equal(health, 200);
    const ev = journalEvents().filter((e) => e.event === 'web.dev.start' && e.service === 'zayavki');
    assert.deepEqual(ev.map((e) => [e.ok, e.already]), [[true, false], [true, true]]);
  } finally {
    await stopDev(dirs.zayavki);
  }
});
