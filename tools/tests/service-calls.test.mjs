// Серверная часть сервиса: POST s/<slug>/api/<действие> (tools/service-calls.mjs) и журнал кабинета.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { createCabinetServer, listenFirstFree } from '../serve.mjs';
import { addService } from '../services.mjs';
import { UPLOAD_DIR } from '../service-calls.mjs';
import { folderSnapshot, journalStats, snapshotDiff } from '../journal.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = '7c1e9a3d5b0f2e4a6c8d1f3a5b7c9e0d';
const T = `/${TOKEN}`;
const JSON_HEADERS = { 'X-Cabinet': '1', 'Content-Type': 'application/json' };

const RESULT_PY = `import json
from datetime import datetime
from pathlib import Path

out = Path("output")
out.mkdir(exist_ok=True)
res = {"title": "Сводка", "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
       "status": "green", "summary": "Сумма: 1200.", "columns": [], "rows": []}
(out / "result.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
`;

const API_PY = `import time
import llm
from service_api import serve, StopRun, save_upload, remove_file, list_files


def upload(data, file):
    return {"file": save_upload(file)}


def delete(data, file):
    remove_file(data.get("name", ""))
    return {"ok": True}


def files(data, file):
    return {"files": [f["name"] for f in list_files()]}


def echo(data, file):
    return {"got": data, "file": file}


def stop(data, file):
    raise StopRun("Нет файла с продажами: загрузите его.")


def crash(data, file):
    return 1 / 0


def slow(data, file):
    time.sleep(10)


def big(data, file):
    return {"x": "я" * 100000}


def model(data, file):
    try:
        llm.ask("Сводка", "Иванов Иван Петрович, +7 701 123 45 67 " + "x" * 60000)
    except llm.LLMBlocked:
        return {"blocked": True}
    return {"blocked": False}


serve({"upload": upload, "delete": delete, "files": files, "echo": echo, "stop": stop, "crash": crash,
       "slow": slow, "big": big, "model": model})
`;

let base, cab, home, server, port;
const dirs = {};

function project(folder, service, files) {
  const dir = join(home, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'service.json'), JSON.stringify({ about: '', input: 'input/', result: 'output/result.json', ...service }, null, 2));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  dirs[folder] = dir;
  return dir;
}

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'svc-calls-'));
  cab = join(base, 'Айгуль Н', 'ai-cabinet');
  home = join(base, 'Айгуль Н', 'Сервисы');
  mkdirSync(join(cab, 'me'), { recursive: true });
  copyDir(join(ROOT, 'templates', 'site'), join(cab, 'site'));
  copyDir(join(ROOT, 'tools'), join(cab, 'tools'));
  rmSync(join(cab, 'tools', 'tests'), { recursive: true, force: true });
  writeFileSync(join(cab, 'CLAUDE.md'), 'правила кабинета');
  const page = { 'page/index.html': '<!doctype html><h1>Страница</h1>' };
  project('stranitsa', { name: 'Своя страница', kind: 'page', run: 'main.py', page: 'page/', api: 'api.py' }, { ...page, 'main.py': RESULT_PY, 'api.py': API_PY, 'input/.gitkeep': '' });
  project('bez-api', { name: 'Без серверной части', kind: 'run', run: 'main.py' }, { 'main.py': RESULT_PY });
  project('plokhoy', { name: 'Плохая серверная часть', kind: 'page', run: 'main.py', page: 'page/', api: 'api.py' }, { ...page, 'main.py': RESULT_PY, 'api.py': 'import subprocess\nfrom service_api import serve\nserve({})\n' });
  project('dolgiy', { name: 'Долгий', kind: 'page', run: 'main.py', page: 'page/', api: 'api.py' }, { ...page, 'main.py': 'import time\ntime.sleep(1.5)\n', 'api.py': API_PY });
  for (const d of Object.values(dirs)) {
    try {
      addService(cab, d);
    } catch {
      // plokhoy не проходит проверку: в реестр кладём сами, как если бы код поправили после «добавь в кабинет»
    }
  }
  const reg = JSON.parse(readFileSync(join(cab, 'me', 'servisy.json'), 'utf8'));
  if (!reg.some((e) => e.slug === 'plokhoy')) {
    reg.push({ slug: 'plokhoy', name: 'Плохая серверная часть', path: dirs.plokhoy, kind: 'page', added_at: new Date().toISOString() });
    writeFileSync(join(cab, 'me', 'servisy.json'), JSON.stringify(reg, null, 2));
  }
  server = createCabinetServer(cab, { token: TOKEN, serviceApi: { timeoutMs: 2000, replyMax: 64 * 1024 } });
  port = await listenFirstFree(server, { from: 19500, to: 19599 });
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r()));
  rmSync(base, { recursive: true, force: true });
});

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

const call = (slug, route, data = {}) => request('POST', `${T}/s/${slug}/api/${route}`, JSON_HEADERS, JSON.stringify(data));
const upload = (slug, name, body) =>
  request('POST', `${T}/s/${slug}/api/upload`, { 'X-Cabinet': '1', 'Content-Type': 'application/octet-stream', ...(name === null ? {} : { 'X-File-Name': encodeURIComponent(name) }) }, body);

function journal() {
  const dir = join(cab, 'journal');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('защита: без X-Cabinet 403, GET 405, чужой сервис и плохой маршрут 404, без поля api 404', async () => {
  let r = await request('POST', `${T}/s/stranitsa/api/echo`, { 'Content-Type': 'application/json' }, '{}');
  assert.equal(r.status, 403);
  r = await request('GET', `${T}/s/stranitsa/api/echo`, { 'X-Cabinet': '1' });
  assert.equal(r.status, 405);
  r = await request('POST', `/${'0'.repeat(32)}/s/stranitsa/api/echo`, JSON_HEADERS, '{}');
  assert.equal(r.status, 403, 'чужой токен');
  assert.equal((await call('nikakoy', 'echo')).status, 404);
  for (const bad of ['Echo', 'echo_1', 'a'.repeat(41), '%2E%2E']) assert.equal((await call('stranitsa', encodeURIComponent(bad))).json.code, 'ENOROUTE', bad);
  // «..» в адресе схлопывается раньше: до действий запрос не доходит.
  assert.notEqual((await request('POST', `${T}/s/stranitsa/api/..`, JSON_HEADERS, '{}')).status, 200);
  r = await request('POST', `${T}/s/stranitsa/api/echo/lishnee`, JSON_HEADERS, '{}');
  assert.equal(r.status, 404);
  r = await call('bez-api', 'echo');
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'ENOAPI');
});

test('код серверной части проверяется как программа: subprocess → 400 с причиной, не запускается', async () => {
  const r = await call('plokhoy', 'echo');
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'EBADSERVICE');
  assert.match(r.json.error, /api\.py, строка 1/);
});

test('ответ действия JSON проходит как есть; тело не JSON 415, битый JSON 400', async () => {
  const r = await call('stranitsa', 'echo', { город: 'Астана', n: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { got: { город: 'Астана', n: 3 }, file: null });
  assert.equal((await request('POST', `${T}/s/stranitsa/api/echo`, { 'X-Cabinet': '1', 'Content-Type': 'text/plain' }, 'x')).status, 415);
  const bad = await request('POST', `${T}/s/stranitsa/api/echo`, JSON_HEADERS, '[1,2]');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'EDATA');
});

test('StopRun → 400 со строкой человеку; сбой → 500 с местом; долго → 504; большой ответ → 500', async () => {
  let r = await call('stranitsa', 'stop');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Нет файла с продажами: загрузите его.');
  r = await call('stranitsa', 'crash');
  assert.equal(r.status, 500);
  assert.match(r.json.error, /api\.py, строка \d+: ZeroDivisionError/);
  r = await call('stranitsa', 'nety');
  assert.equal(r.status, 400, 'действия нет в serve: StopRun из помощника');
  assert.match(r.json.error, /нет действия «nety»/);
  r = await call('stranitsa', 'slow');
  assert.equal(r.status, 504);
  r = await call('stranitsa', 'big');
  assert.equal(r.status, 500);
  assert.equal(r.json.code, 'EBIG');
});

test('загрузка, список и удаление файлов своим кодом сервиса; временная папка убрана; журнал', async () => {
  const before = journal().length;
  let r = await upload('stranitsa', 'Продажи (1).csv', 'Точка;Сумма\nТочка-01;1200\n');
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.file, 'Продажи (1).csv');
  r = await upload('stranitsa', 'Продажи (1).csv', 'ещё');
  assert.equal(r.json.file, 'Продажи (1) (2).csv', 'занятое имя получает номер');
  assert.ok(existsSync(join(dirs.stranitsa, 'input', 'Продажи (1).csv')));
  assert.equal(existsSync(join(dirs.stranitsa, UPLOAD_DIR)), false, 'временная папка убрана');
  r = await call('stranitsa', 'files');
  assert.deepEqual(r.json.files.sort(), ['Продажи (1) (2).csv', 'Продажи (1).csv']);
  r = await call('stranitsa', 'delete', { name: 'Продажи (1) (2).csv' });
  assert.equal(r.status, 200);
  assert.equal(existsSync(join(dirs.stranitsa, 'input', 'Продажи (1) (2).csv')), false);
  for (const name of ['../service.json', '.gitkeep', '']) {
    r = await call('stranitsa', 'delete', { name });
    assert.equal(r.status, 400, name);
  }
  assert.ok(existsSync(join(dirs.stranitsa, 'service.json')));
  // Пустой файл и файл без имени: кабинет отказывает сам, временных файлов не остаётся.
  assert.equal((await upload('stranitsa', 'pusto.csv', '')).json.code, 'EEMPTY');
  assert.equal((await upload('stranitsa', null, 'x')).json.code, 'ENAME');
  assert.equal(existsSync(join(dirs.stranitsa, UPLOAD_DIR)), false);

  const lines = journal().slice(before);
  const up = lines.find((l) => l.event === 'upload' && l.ok);
  assert.ok(up, 'строка загрузки в журнале');
  assert.equal(up.service, 'stranitsa');
  assert.deepEqual(up.files.added, ['Продажи (1).csv']);
  const del = lines.find((l) => l.event === 'api' && l.route === 'delete' && l.ok);
  assert.deepEqual(del.files.removed, ['Продажи (1) (2).csv']);
  assert.ok(lines.every((l) => typeof l.at === 'string' && 'user' in l && typeof l.ms === 'number'));
  assert.ok(!JSON.stringify(lines).includes('Точка-01'), 'содержимое файлов в журнал не попадает');
});

test('обращение к модели со слишком большим объёмом: не отправлено, в журнале строка model без самих данных', async () => {
  const r = await call('stranitsa', 'model');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { blocked: true });
  const m = journal().filter((l) => l.event === 'model');
  assert.equal(m.length, 1);
  assert.equal(m[0].service, 'stranitsa');
  assert.equal(m[0].ok, false);
  assert.match(m[0].reason, /слишком большой объём/);
  assert.ok(!JSON.stringify(m).includes('Иванов') && !JSON.stringify(m).includes('701'));
});

test('пока идёт «Запустить», действие отвечает 409; запуск тоже в журнале', async () => {
  let r = await request('POST', `${T}/api/services/run`, JSON_HEADERS, JSON.stringify({ slug: 'dolgiy' }));
  assert.equal(r.status, 202);
  r = await call('dolgiy', 'echo');
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'ERUNNING');
  const until = Date.now() + 20000;
  while (Date.now() < until && !journal().some((l) => l.event === 'run' && l.service === 'dolgiy')) await sleep(100);
  const run = journal().find((l) => l.event === 'run' && l.service === 'dolgiy');
  assert.ok(run, 'строка запуска в журнале');
  assert.equal(run.ok, true);
  assert.equal(run.files.total, 0);
  assert.equal((await call('dolgiy', 'echo')).status, 200, 'после расчёта действие снова работает');
});

test('журнал: снимок папки и разница, счёт событий для «Настроек»', () => {
  const dir = join(base, 'snap');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'a.xlsx'), 'a');
  writeFileSync(join(dir, 'sub', 'b.csv'), 'b');
  writeFileSync(join(dir, '.hidden'), 'h');
  writeFileSync(join(dir, '~$a.xlsx'), 'lock');
  const s1 = folderSnapshot(dir);
  assert.deepEqual([...s1].sort(), ['a.xlsx', 'sub/b.csv']);
  writeFileSync(join(dir, 'c.docx'), 'c');
  rmSync(join(dir, 'a.xlsx'));
  assert.deepEqual(snapshotDiff(s1, folderSnapshot(dir)), { total: 2, added: ['c.docx'], removed: ['a.xlsx'] });
  assert.deepEqual(snapshotDiff(s1, s1), { total: 2 });
  assert.deepEqual(folderSnapshot(join(dir, 'netu')), new Set());
  const st = journalStats(cab);
  assert.equal(st.folder, 'journal');
  assert.ok(st.events >= journal().filter((l) => l.at.startsWith(new Date().toISOString().slice(0, 7))).length - 1);
  assert.equal(journalStats(join(base, 'net-kabineta')).events, 0);
});
