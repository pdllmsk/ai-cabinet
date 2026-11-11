import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { createCabinetServer, listenFirstFree } from '../serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
const T = `/${TOKEN}`;
const RUN_HEADERS = { 'X-Cabinet': '1', 'Content-Type': 'application/json' };

const RESULT_PY = (slug) => `import json, os
from datetime import datetime
out = os.path.join("output", "${slug}")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "otchet.txt"), "w", encoding="utf-8") as f:
    f.write("отчёт процесса")
res = {"title": "Демо", "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
       "status": "green", "summary": "Всё в порядке.", "columns": ["А"], "rows": [["1"]],
       "files": ["output/${slug}/otchet.txt"]}
with open(os.path.join(out, "result.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False)
print("готово")
`;

let base, cab, server, port;

function addProcess(slug, json, runPy) {
  const dir = join(cab, 'processes', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'process.json'), JSON.stringify(json));
  if (runPy) writeFileSync(join(dir, 'run.py'), runPy);
}

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'api-'));
  cab = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(cab, { recursive: true });
  copyDir(join(ROOT, 'templates', 'site'), join(cab, 'site'));
  writeFileSync(join(cab, 'CLAUDE.md'), 'секретные правила кабинета');
  addProcess('demo', { title: 'Демо', phrase: 'запусти демо', kind: 'script' }, RESULT_PY('demo'));
  addProcess('dolgiy', { title: 'Долгий', phrase: 'запусти долгий', kind: 'script' }, 'import time\ntime.sleep(1.5)\n');
  addProcess('padaet', { title: 'Падает', phrase: 'запусти падает', kind: 'script' }, 'import sys\nprint("сломался")\nsys.exit(2)\n');
  addProcess('pisma', { title: 'Черновики писем', phrase: 'напиши черновики писем', kind: 'claude' });
  addProcess('bityi', { title: 'Битый', phrase: 'запусти битый', kind: 'script' }, 'print(1)\n');
  mkdirSync(join(cab, 'output', 'bityi'), { recursive: true });
  writeFileSync(join(cab, 'output', 'bityi', 'result.json'), '{"title": ');
  mkdirSync(join(cab, 'output', 'backup-2026-10-18-0905'), { recursive: true });
  writeFileSync(join(cab, 'output', 'backup-2026-10-18-0905', 'CLAUDE.md'), 'копия');
  server = createCabinetServer(cab, { token: TOKEN });
  port = await listenFirstFree(server, { from: 18600, to: 18699 });
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

// http.request без нормализации пути (fetch схлопывает /../).
function request(method, path, headers = {}, body, onPort = port) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: onPort, path, method, headers, agent: false }, (r) => {
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
const get = (path) => request('GET', path);
const run = (slug, headers = RUN_HEADERS) => request('POST', `${T}/api/run/${slug}`, headers, '{}');

async function waitIdle(slug) {
  for (let i = 0; i < 100; i++) {
    const s = await get(`${T}/api/status/${slug}`);
    assert.equal(s.status, 200);
    if (!s.json.running) return s.json;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${slug}: расчёт не закончился`);
}

test('заголовки no-referrer, nosniff, no-store на всех ответах', async () => {
  const responses = [
    await get(`${T}/`),
    await get('/'),
    await get(T),
    await get(`${T}/net-takogo.html`),
    await get(`${T}/api/processes`),
    await get(`${T}/api/net-takogo`),
    await run('demo', {}),
    await get(`${T}/api/status/net-takogo`),
    await get(`${T}/output/demo/net.txt`),
  ];
  for (const r of responses) {
    assert.equal(r.headers['referrer-policy'], 'no-referrer', `${r.status}`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', `${r.status}`);
    assert.equal(r.headers['cache-control'], 'no-store', `${r.status}`);
  }
});

test('GET api/processes: список в JSON, битый result.json даёт error только у своего процесса', async () => {
  const r = await get(`${T}/api/processes`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/json/);
  const by = Object.fromEntries(r.json.map((p) => [p.slug, p]));
  assert.deepEqual(Object.keys(by).sort(), ['bityi', 'demo', 'dolgiy', 'padaet', 'pisma']);
  assert.match(by.bityi.error, /result\.json/);
  assert.equal(by.demo.error, null);
  assert.equal(by.pisma.kind, 'claude');
  assert.equal((await request('POST', `${T}/api/processes`, RUN_HEADERS, '{}')).status, 405);
});

test('POST api/run без токена, с чужим токеном, без заголовка X-Cabinet или без JSON → 403, ничего не запускается', async () => {
  const noToken = await request('POST', '/api/run/demo', RUN_HEADERS, '{}');
  assert.equal(noToken.status, 403);
  const wrong = await request('POST', `/${TOKEN.slice(0, -1)}0/api/run/demo`, RUN_HEADERS, '{}');
  assert.equal(wrong.status, 403);
  for (const headers of [{}, { 'Content-Type': 'application/json' }, { 'X-Cabinet': '1' }, { 'X-Cabinet': '1', 'Content-Type': 'text/plain' }, { 'X-Cabinet': '0', 'Content-Type': 'application/json' }, { 'X-Cabinet': '1', 'Content-Type': 'application/x-www-form-urlencoded' }]) {
    const r = await run('demo', headers);
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.match(r.json.error, /[А-Яа-я]/);
  }
  assert.equal((await get(`${T}/api/status/demo`)).json.running, false);
  assert.equal(existsSync(join(cab, 'output', 'demo', 'last-run.log')), false);
});

test('POST api/run: неизвестное имя и выход за папку → 404, kind claude → 400 с фразой', async () => {
  for (const slug of ['net-takogo', '..%2f..%2fCLAUDE.md', '..', 'Demo', 'demo%2f..%2fdemo', '%2e%2e']) {
    const r = await run(slug);
    assert.equal(r.status, 404, slug);
    assert.match(r.json.error, /[А-Яа-я]/, slug);
  }
  const claude = await run('pisma');
  assert.equal(claude.status, 400);
  assert.equal(claude.json.error, 'этот процесс запускается фразой в Claude: напиши черновики писем');
  assert.equal((await get(`${T}/api/run/demo`)).status, 405);
});

test('POST api/run: 202 сразу, статус running, затем lastRun ok и свежий result.json', async () => {
  const r = await run('demo');
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { started: true });
  const st = await waitIdle('demo');
  assert.equal(st.lastRun.ok, true, readFileSync(join(cab, 'output', 'demo', 'last-run.log'), 'utf8'));
  assert.equal(st.lastRun.code, 0);
  assert.ok(!Number.isNaN(Date.parse(st.lastRun.finishedAt)));
  const list = (await get(`${T}/api/processes`)).json;
  const demo = list.find((p) => p.slug === 'demo');
  assert.equal(demo.result.title, 'Демо');
  assert.equal(demo.error, null);
  assert.match(readFileSync(join(cab, 'output', 'demo', 'last-run.log'), 'utf8'), /готово/);
});

test('POST api/run: повторный запуск, пока идёт первый → 409', async () => {
  assert.equal((await run('dolgiy')).status, 202);
  const second = await run('dolgiy');
  assert.equal(second.status, 409);
  assert.match(second.json.error, /уже идёт/);
  assert.equal(second.json.code, 'ERUNNING');
  assert.equal((await get(`${T}/api/status/dolgiy`)).json.running, true);
  assert.equal((await get(`${T}/api/processes`)).json.find((p) => p.slug === 'dolgiy').running, true);
  const st = await waitIdle('dolgiy');
  assert.equal(st.lastRun.ok, true);
  assert.equal((await run('dolgiy')).status, 202);
  await waitIdle('dolgiy');
});

test('GET api/status: ошибка расчёта видна в lastRun; неизвестный процесс → 404', async () => {
  assert.equal((await run('padaet')).status, 202);
  const st = await waitIdle('padaet');
  assert.deepEqual({ ok: st.lastRun.ok, code: st.lastRun.code }, { ok: false, code: 2 });
  assert.equal((await get(`${T}/api/status/net-takogo`)).status, 404);
  assert.equal((await get(`${T}/api/status/..%2fdemo`)).status, 404);
  assert.deepEqual((await get(`${T}/api/status/pisma`)).json, { running: false, lastRun: null });
});

test('output/<slug>/ отдаётся только для чтения и только внутри output процесса', async () => {
  if (!existsSync(join(cab, 'output', 'demo', 'otchet.txt'))) {
    assert.equal((await run('demo')).status, 202);
    await waitIdle('demo');
  }
  const ok = await get(`${T}/output/demo/otchet.txt`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'отчёт процесса');
  assert.equal((await get(`${T}/output/demo/last-run.log`)).status, 200);
  assert.equal((await request('POST', `${T}/output/demo/otchet.txt`, RUN_HEADERS, '{}')).status, 405);
  assert.equal((await get('/output/demo/otchet.txt')).status, 403);
  for (const p of [
    `${T}/output/demo/..%2f..%2fCLAUDE.md`,
    `${T}/output/..%2fCLAUDE.md`,
    `${T}/output/backup-2026-10-18-0905/CLAUDE.md`,
    `${T}/output/net-takogo/x.txt`,
    `${T}/output/demo/%2e%2e/%2e%2e/CLAUDE.md`,
    `${T}/output/demo/..%5c..%5cCLAUDE.md`,
  ]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes('секретные'), p);
  }
});

test('OPTIONS на api/run: 405 и никаких разрешений Access-Control для чужих страниц', async () => {
  const r = await request('OPTIONS', `${T}/api/run/demo`, {
    Origin: 'http://evil.example',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'x-cabinet, content-type',
  });
  assert.equal(r.status, 405);
  assert.deepEqual(Object.keys(r.headers).filter((h) => h.startsWith('access-control-')), []);
});

test('файлы output отдаются только на скачивание и в песочнице', async () => {
  if (!existsSync(join(cab, 'output', 'demo', 'otchet.txt'))) {
    assert.equal((await run('demo')).status, 202);
    await waitIdle('demo');
  }
  const r = await get(`${T}/output/demo/otchet.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-disposition'], /^attachment; filename\*=UTF-8''otchet\.txt$/);
  assert.equal(r.headers['content-security-policy'], 'sandbox');
  const page = await get(`${T}/`);
  assert.equal(page.headers['content-disposition'], undefined);
});

// Отдельный кабинет со своим сервером: для проверок, которые меняют папки кабинета.
async function withCabinet(setup, fn) {
  const b = mkdtempSync(join(tmpdir(), 'api2-'));
  const root = join(b, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(root, { recursive: true });
  copyDir(join(ROOT, 'templates', 'site'), join(root, 'site'));
  const s = createCabinetServer(root, { token: TOKEN });
  try {
    if ((await setup(root, b)) === false) return;
    const p = await listenFirstFree(s, { from: 18800, to: 18899 });
    await fn((method, path, headers, body) => request(method, path, headers, body, p));
  } finally {
    s.closeAllConnections?.();
    if (s.listening) await new Promise((r) => s.close(() => r()));
    rmSync(b, { recursive: true, force: true });
  }
}

test('output: папка output, ведущая за пределы кабинета, не отдаётся', async (t) => {
  await withCabinet(
    (root, b) => {
      const dir = join(root, 'processes', 'demo');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'process.json'), JSON.stringify({ title: 'Демо', phrase: 'запусти демо', kind: 'script' }));
      const outside = join(b, 'chuzhoy output');
      mkdirSync(join(outside, 'demo'), { recursive: true });
      writeFileSync(join(outside, 'demo', 'x.txt'), 'секретные данные снаружи');
      try {
        symlinkSync(outside, join(root, 'output'), 'junction');
      } catch (e) {
        t.skip(`ссылки на папки недоступны (${e.code})`);
        return false;
      }
    },
    async (req) => {
      const r = await req('GET', `${T}/output/demo/x.txt`);
      assert.equal(r.status, 404);
      assert.ok(!r.body.includes('секретные'));
    },
  );
});

test('третий одновременный расчёт в кабинете → 409 с русским текстом', async () => {
  await withCabinet(
    (root) => {
      for (const slug of ['odin', 'dva', 'tri']) {
        const dir = join(root, 'processes', slug);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'process.json'), JSON.stringify({ title: slug, phrase: `запусти ${slug}`, kind: 'script' }));
        writeFileSync(join(dir, 'run.py'), 'import time\ntime.sleep(1.5)\n');
      }
    },
    async (req) => {
      const go = (slug) => req('POST', `${T}/api/run/${slug}`, RUN_HEADERS, '{}');
      assert.equal((await go('odin')).status, 202);
      assert.equal((await go('dva')).status, 202);
      const third = await go('tri');
      assert.equal(third.status, 409);
      assert.match(third.json.error, /не больше 2/);
      assert.equal(third.json.code, 'ELIMIT');
      for (const slug of ['odin', 'dva']) {
        for (let i = 0; i < 100; i++) {
          const st = await req('GET', `${T}/api/status/${slug}`);
          if (!st.json.running) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.equal((await go('tri')).status, 202);
      for (let i = 0; i < 100; i++) {
        if (!(await req('GET', `${T}/api/status/tri`)).json.running) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  );
});

test('output: ссылка из output/<slug>/ наружу не отдаётся', async (t) => {
  mkdirSync(join(cab, 'output', 'demo'), { recursive: true });
  try {
    symlinkSync(join(cab, 'CLAUDE.md'), join(cab, 'output', 'demo', 'ssylka.md'));
  } catch (e) {
    return t.skip(`символические ссылки на файлы недоступны (${e.code})`);
  }
  const r = await get(`${T}/output/demo/ssylka.md`);
  assert.equal(r.status, 404);
  assert.ok(!r.body.includes('секретные'));
});

test('страница кабинета отдаётся под токеном вместе с render.js, только на чтение', async () => {
  const page = await get(`${T}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, /data-cabinet="ok"/);
  const js = await get(`${T}/render.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.equal((await request('POST', `${T}/`, RUN_HEADERS, '{}')).status, 405);
});
