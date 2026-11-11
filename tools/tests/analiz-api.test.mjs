// API сервиса «Аналитика таблиц» (tools/analiz-api.mjs) через сервер кабинета. Движок tools/analiz.py подменён:
// во временном кабинете (путь с кириллицей и пробелом) лежит маленькая программа на Python, она отвечает по
// контракту и записывает, с какими аргументами её позвали. Python настоящий, как у кнопки «Запустить».
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { createCabinetServer, listenFirstFree } from '../serve.mjs';
import { QUESTION_MAX, UPLOAD_MAX, cleanFileName, cleanQuestion, codePhrase, engineMessage, normalizeHistory, parseEngineJson } from '../analiz-api.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const T = `/${TOKEN}`;
const READ = { 'X-Cabinet': '1' };
// Порты 19100-19299: другие файлы тестов (serve, processes-api) идут параллельно на 18500-18999.
const WRITE = { 'X-Cabinet': '1', 'Content-Type': 'application/json' };

// Подменённый движок: подкоманды passport, ask, excel по контракту. Вопрос определяет исход:
// «нет claude...» код 3, «пд...» (большой объём) код 4, «строки...» код 5, «ошибка...» трейсбек и код 1, «долго...» ждёт 30 с,
// «тихо...» пустой вывод. История как у настоящего движка: новые в начале списка, время в поле created.
const FAKE_ENGINE = String.raw`import json, os, sys, time
args = sys.argv[1:]
cmd = args[0] if args else ""
out = os.path.join("output", "analiz")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "calls.jsonl"), "a", encoding="utf-8") as f:
    f.write(json.dumps(args, ensure_ascii=False) + "\n")

def say(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)

if cmd == "passport":
    folder = os.path.join("input", "analiz")
    names = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
    say({"folder": "input/analiz", "files": [{"file": n, "sheets": [{"sheet": None, "rows": 2, "columns": [
        {"name": "Точка", "type": "текст", "values": ["Точка-01", "Точка-02"]},
        {"name": "Сумма", "type": "число", "min": 1.5, "max": 2}]}]} for n in names]})
if cmd == "ask":
    q = args[1]
    if q.startswith("нет claude"):
        say({"error": "claude не найден на этом компьютере"}, 3)
    if q.startswith("пд"):
        say({"error": "Вопрос не отправлен в модель: слишком большой объём: 60001 знаков (больше 60000)"}, 4)
    if q.startswith("строки"):
        say({"error": "Для этого вопроса нужно читать текст строк (нужно читать жалобы): задайте его Claude во вкладке Code: «проанализируй таблицу: строки: о чём жалуются».", "code": 5, "need_rows": True}, 5)
    if q.startswith("ошибка"):
        sys.stderr.write('Traceback (most recent call last):\n  File "analiz.py", line 1\n    x\nValueError: Нет столбца «Сумма»\n')
        sys.exit(1)
    if q.startswith("долго"):
        time.sleep(30)
    if q.startswith("тихо"):
        sys.exit(0)
    hist = os.path.join(out, "history.json")
    items = json.load(open(hist, encoding="utf-8")) if os.path.exists(hist) else []
    ans = {"id": "otvet-%d" % (len(items) + 1), "question": q, "spec": {"table": "prodazhi.csv"},
           "columns": ["Точка", "Сумма"], "rows": [["Точка-01", 1.5], ["Точка-02", 2]], "total_rows": 2,
           "totals": {"Сумма": 3.5}, "notes": [], "summary": "Всего 3,5 л.", "created": "2026-10-29T22:%02d:00" % (len(items) + 1)}
    items.insert(0, ans)
    json.dump(items, open(hist, "w", encoding="utf-8"), ensure_ascii=False)
    print("служебная строка движка")
    say(ans)
if cmd == "excel":
    name = "otvet-%s.xlsx" % args[1]
    with open(os.path.join(out, name), "wb") as f:
        f.write(b"PK\x03\x04 excel")
    say({"file": "output/analiz/" + name})
sys.exit(2)
`;

let base, cab, server, port, quick, quickPort;
const opened = [];

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'analiz-'));
  cab = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(join(cab, 'tools'), { recursive: true });
  copyDir(join(ROOT, 'templates', 'site'), join(cab, 'site'));
  writeFileSync(join(cab, 'tools', 'analiz.py'), FAKE_ENGINE);
  writeFileSync(join(cab, 'CLAUDE.md'), 'секретные правила кабинета');
  server = createCabinetServer(cab, { token: TOKEN, analiz: { openFolder: (dir) => opened.push(dir) } });
  port = await listenFirstFree(server, { from: 19100, to: 19149 });
  // Второй сервер того же кабинета с коротким ограничением времени: для проверки остановки долгого вопроса;
  // у него же загрузка до 1 КБ (проверка ответа 413 без файла в 50 МБ).
  quick = createCabinetServer(cab, { token: TOKEN, analiz: { askTimeoutMs: 1500, openFolder: () => true, uploadMax: 1024 } });
  quickPort = await listenFirstFree(quick, { from: 19150, to: 19199 });
});

after(async () => {
  for (const s of [server, quick]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r()));
  }
  rmSync(base, { recursive: true, force: true });
});

function request(method, path, headers = {}, body, onPort = port) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: onPort, path, method, headers, agent: false }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // не JSON
        }
        res({ status: r.statusCode, headers: r.headers, body: text, buf, json });
      });
    });
    req.on('error', rej);
    req.end(body);
  });
}
const get = (path, headers = READ, onPort) => request('GET', path, headers, undefined, onPort);
const post = (path, data, headers = WRITE, onPort) => request('POST', path, headers, JSON.stringify(data), onPort);
const ask = (question, onPort) => post(`${T}/api/analiz/ask`, { question }, WRITE, onPort);

const calls = () =>
  existsSync(join(cab, 'output', 'analiz', 'calls.jsonl'))
    ? readFileSync(join(cab, 'output', 'analiz', 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

test('без токена, с чужим токеном, без заголовка X-Cabinet или без JSON → 403, движок не запускается', async () => {
  const before = calls().length;
  const routes = ['passport', 'history'];
  for (const r of routes) {
    assert.equal((await get(`/api/analiz/${r}`)).status, 403, r);
    assert.equal((await get(`/0000000000000000/api/analiz/${r}`)).status, 403, r);
    const noHeader = await get(`${T}/api/analiz/${r}`, {});
    assert.equal(noHeader.status, 403, r);
    assert.match(noHeader.json.error, /только со своей страницы/);
  }
  for (const r of ['ask', 'excel', 'open-folder']) {
    assert.equal((await post(`/api/analiz/${r}`, { question: 'вопрос', id: 'a' })).status, 403, r);
    assert.equal((await post(`${T}/api/analiz/${r}`, { question: 'вопрос', id: 'a' }, { 'Content-Type': 'application/json' })).status, 403, r);
    assert.equal((await post(`${T}/api/analiz/${r}`, { question: 'вопрос', id: 'a' }, { 'X-Cabinet': '1', 'Content-Type': 'text/plain' })).status, 403, r);
  }
  assert.equal(calls().length, before, 'движок не вызывался');
  assert.equal(opened.length, 0, 'папка не открывалась');
  assert.equal(existsSync(join(cab, 'input', 'analiz')), false, 'папка input/analiz не создана');
});

test('неверный метод → 405, неизвестный адрес → 404; заголовки no-referrer, nosniff, no-store', async () => {
  const r1 = await request('POST', `${T}/api/analiz/passport`, WRITE, '{}');
  assert.equal(r1.status, 405);
  assert.equal(r1.headers.allow, 'GET, HEAD');
  const r2 = await get(`${T}/api/analiz/ask`);
  assert.equal(r2.status, 405);
  assert.equal(r2.headers.allow, 'POST');
  const r3 = await get(`${T}/api/analiz/net-takogo`);
  assert.equal(r3.status, 404);
  for (const r of [r1, r2, r3]) {
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  // API процессов рядом работает как раньше.
  assert.equal((await get(`${T}/api/processes`)).status, 200);
});

test('open-folder: создаёт input/analiz и открывает её (без настоящего Проводника); паспорт видит положенный файл', async () => {
  let p = await get(`${T}/api/analiz/passport`);
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.passport.files, []);
  const r = await post(`${T}/api/analiz/open-folder`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.opened, true);
  assert.equal(r.json.path, join(cab, 'input', 'analiz'));
  assert.deepEqual(opened, [join(cab, 'input', 'analiz')]);
  assert.ok(existsSync(join(cab, 'input', 'analiz')));
  writeFileSync(join(cab, 'input', 'analiz', 'prodazhi.csv'), 'Точка;Сумма\nТочка-01;1,5\n');
  p = await get(`${T}/api/analiz/passport`);
  assert.equal(p.status, 200);
  assert.equal(p.json.passport.files[0].file, 'prodazhi.csv');
  assert.equal(p.json.passport.files[0].sheets[0].columns[0].name, 'Точка');
  // Повторно: папка уже есть, ответ тот же.
  assert.equal((await post(`${T}/api/analiz/open-folder`, {})).status, 200);
});

test('ask: ответ движка по контракту, вопрос доходит одним аргументом как есть, без оболочки', async () => {
  const q = 'Сколько тенге "Золото 585" & %PATH% $(whoami) `id` по Точка? 50%';
  const r = await ask(q);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.answer.question, q);
  assert.deepEqual(r.json.answer.columns, ['Точка', 'Сумма']);
  assert.deepEqual(calls().at(-1), ['ask', q]);
  const h = await get(`${T}/api/analiz/history`);
  assert.equal(h.status, 200);
  assert.equal(h.json.items[0].question, q);
});

test('ask: вопрос чистится (переводы строк, «-» в начале), пустой и слишком длинный не отправляются', async () => {
  const r = await ask('  -- итого\nпо   Точка\t');
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(calls().at(-1), ['ask', 'итого по Точка']);
  const n = calls().length;
  const empty = await ask('  \n ');
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, 'EEMPTY');
  const long = await ask('я'.repeat(QUESTION_MAX + 1));
  assert.equal(long.status, 400);
  assert.equal(long.json.code, 'ELONG');
  const notText = await post(`${T}/api/analiz/ask`, { question: 42 });
  assert.equal(notText.status, 400);
  const huge = await request('POST', `${T}/api/analiz/ask`, WRITE, JSON.stringify({ question: 'я'.repeat(20000) }));
  assert.equal(huge.status, 413);
  const broken = await request('POST', `${T}/api/analiz/ask`, WRITE, '{"question": ');
  assert.equal(broken.status, 400);
  assert.equal(calls().length, n, 'движок не вызывался');
});

test('ask: код 3 (нет claude) → 503 ENOCLAUDE с фразой для вкладки Code', async () => {
  const r = await ask('нет claude: продажи по Точка');
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'ENOCLAUDE');
  assert.equal(r.json.phrase, 'проанализируй таблицу: нет claude: продажи по Точка');
  assert.equal(r.json.phrase, codePhrase('нет claude: продажи по Точка'));
  assert.match(r.json.error, /вкладке Code/);
});

test('ask: код 4 (не прошло проверку llm.py) → 422 EPERSONAL с причиной от движка', async () => {
  const r = await ask('пд: выручка по клиентам');
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'EPERSONAL');
  assert.equal(r.json.error, 'Вопрос не отправлен в модель: слишком большой объём: 60001 знаков (больше 60000)');
});

test('ask: код 5 (нужно читать текст строк) → 422 EROWS с фразой для вкладки Code', async () => {
  const r = await ask('строки: о чём жалуются');
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'EROWS');
  assert.match(r.json.error, /вкладке Code/);
  assert.equal(r.json.phrase, 'проанализируй таблицу: строки: о чём жалуются');
});

test('ask: ошибка движка → понятная строка без трейсбека; пустой вывод → 500', async () => {
  const r = await ask('ошибка: сумма');
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'EENGINE');
  assert.equal(r.json.error, 'ValueError: Нет столбца «Сумма»');
  assert.doesNotMatch(r.json.error, /Traceback|File "/);
  const silent = await ask('тихо');
  assert.equal(silent.status, 500);
  assert.equal(silent.json.code, 'EENGINE');
});

test('ask: дольше ограничения → 504 и движок остановлен; второй вопрос, пока идёт первый → 409', async () => {
  const slow = ask('долго считать', quickPort);
  await new Promise((r) => setTimeout(r, 300));
  const second = await ask('второй вопрос', quickPort);
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'EBUSY');
  const started = Date.now();
  const r = await slow;
  assert.equal(r.status, 504);
  assert.equal(r.json.code, 'ETIMEOUT');
  assert.equal(r.json.phrase, 'проанализируй таблицу: долго считать');
  assert.ok(Date.now() - started < 15000, 'ответ не ждал 30 с');
  // После остановки вопросы снова принимаются.
  assert.equal((await ask('после долгого', quickPort)).status, 200);
});

test('history: новые сверху; файла нет → пусто; битый файл → 500 с понятным текстом; вложенный вид записей', async () => {
  const file = join(cab, 'output', 'analiz', 'history.json');
  const saved = readFileSync(file, 'utf8');
  try {
    const h = await get(`${T}/api/analiz/history`);
    const times = h.json.items.map((a) => a.time);
    assert.ok(times.length >= 3 && times.every(Boolean), 'время из поля created');
    assert.deepEqual(times, [...times].sort().reverse());
    assert.equal(h.json.total, h.json.items.length);

    rmSync(file);
    const none = await get(`${T}/api/analiz/history`);
    assert.equal(none.status, 200);
    assert.deepEqual(none.json.items, []);

    writeFileSync(file, '[{"question": ');
    const broken = await get(`${T}/api/analiz/history`);
    assert.equal(broken.status, 500);
    assert.match(broken.json.error, /history\.json/);

    writeFileSync(
      file,
      JSON.stringify({
        items: [
          { id: 'x1', question: 'первый', time: '2026-10-29T10:00:00', result: { columns: ['А'], rows: [[1]], summary: 'раз' } },
          { id: 'x2', question: 'второй', time: '2026-10-29T11:00:00', result: { columns: ['А'], rows: [[2]], summary: 'два' } },
        ],
      }),
    );
    const nested = await get(`${T}/api/analiz/history`);
    assert.deepEqual(nested.json.items.map((a) => [a.id, a.question, a.summary]), [['x2', 'второй', 'два'], ['x1', 'первый', 'раз']]);
  } finally {
    writeFileSync(file, saved);
  }
});

test('excel: ссылка на файл в output/analiz, файл скачивается; чужой номер и лишние файлы не отдаются', async () => {
  const r = await post(`${T}/api/analiz/excel`, { id: 'otvet-1' });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.file, 'otvet-otvet-1.xlsx');
  assert.equal(r.json.url, 'output/analiz/otvet-otvet-1.xlsx');
  assert.deepEqual(calls().at(-1), ['excel', 'otvet-1']);
  const file = await get(`${T}/${r.json.url}`, {});
  assert.equal(file.status, 200);
  assert.match(file.headers['content-disposition'], /^attachment; filename\*=UTF-8''otvet-otvet-1\.xlsx$/);
  assert.equal(file.headers['content-security-policy'], 'sandbox');
  assert.match(file.headers['content-type'], /spreadsheetml/);
  assert.equal(file.buf.subarray(0, 2).toString(), 'PK');

  const n = calls().length;
  for (const id of ['-rf', '../x', '', 'a b', 'я'.repeat(3), null]) {
    const bad = await post(`${T}/api/analiz/excel`, { id });
    assert.equal(bad.status, 400, String(id));
  }
  assert.equal(calls().length, n, 'движок не вызывался');
  // Из output/analiz отдаются только файлы Excel: история, журнал вызовов и вложенные пути нет.
  for (const p of ['history.json', 'calls.jsonl', '..%2Fanaliz%2Fhistory.json', 'sub/x.xlsx', '.skrytyi.xlsx']) {
    assert.equal((await get(`${T}/output/analiz/${p}`, {})).status, 404, p);
  }
});

test('страница сервиса и её скрипт отдаются под токеном, только на чтение; без токена 403', async () => {
  const page = await get(`${T}/analiz.html`, {});
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body, /<h1>Аналитика таблиц<\/h1>/);
  const js = await get(`${T}/analiz.js`, {});
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.match(js.body, /AnalizRender/);
  assert.equal((await get('/analiz.html', {})).status, 403);
  assert.equal((await request('POST', `${T}/analiz.html`, WRITE, '{}')).status, 405);
  const main = await get(`${T}/`, {});
  assert.match(main.body, /<a class="nav-item" href="analiz\.html">/);
  assert.match(page.body, /<script src="render\.js"><\/script>/);
  assert.equal((await get(`${T}/render.js`, {})).status, 200);
});

test('движка нет в кабинете: понятный ответ «обнови кабинет», Python не ищется', async () => {
  const other = join(base, 'bez-dvizhka');
  mkdirSync(join(other, 'site'), { recursive: true });
  const s = createCabinetServer(other, { token: TOKEN, python: join(other, 'net-pythona.exe') });
  const p = await listenFirstFree(s, { from: 19200, to: 19249 });
  try {
    for (const r of [await get(`${T}/api/analiz/passport`, READ, p), await ask('вопрос', p), await post(`${T}/api/analiz/excel`, { id: 'a1' }, WRITE, p)]) {
      assert.equal(r.status, 500);
      assert.equal(r.json.code, 'ENOENGINE');
      assert.match(r.json.error, /обнови кабинет/);
    }
    const h = await get(`${T}/api/analiz/history`, READ, p);
    assert.deepEqual(h.json.items, []);
  } finally {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r()));
  }
});

test('Python не запускается: понятный ответ «проверь сетап»', async () => {
  const s = createCabinetServer(cab, { token: TOKEN, python: join(base, 'net-takogo-pythona', 'python.exe') });
  const p = await listenFirstFree(s, { from: 19250, to: 19299 });
  try {
    const r = await get(`${T}/api/analiz/passport`, READ, p);
    assert.equal(r.status, 500);
    assert.equal(r.json.code, 'ENOPYTHON');
    assert.match(r.json.error, /проверь сетап/);
  } finally {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r()));
  }
});

// ---------- чистые функции ----------

test('cleanQuestion: одна строка, без управляющих знаков и «-» в начале', () => {
  assert.equal(cleanQuestion('  Продажи\r\nпо Точка\u0000 '), 'Продажи по Точка');
  assert.equal(cleanQuestion('--help'), 'help');
  assert.equal(cleanQuestion('-5% к прошлой неделе?'), '5% к прошлой неделе?');
  assert.equal(cleanQuestion('Точка-05 упала?'), 'Точка-05 упала?');
  assert.equal(cleanQuestion(null), '');
  assert.equal(cleanQuestion(['a']), '');
  assert.equal(cleanQuestion('a\ud800b'), 'a\ufffdb');
});

test('parseEngineJson: весь вывод, последняя строка JSON или объект внутри текста', () => {
  assert.deepEqual(parseEngineJson('{"a": 1}'), { a: 1 });
  assert.deepEqual(parseEngineJson('\ufeff{"a": 1}\n'), { a: 1 });
  assert.deepEqual(parseEngineJson('читаю файлы\n{"a": 2}\n'), { a: 2 });
  assert.deepEqual(parseEngineJson('итог: {"a": 3} готово'), { a: 3 });
  assert.equal(parseEngineJson(''), null);
  assert.equal(parseEngineJson('просто текст'), null);
});

test('engineMessage: поле JSON, находки проверки, последняя строка stderr без трейсбека', () => {
  assert.equal(engineMessage({ error: 'Нет столбца' }, 'x'), 'Нет столбца');
  assert.equal(engineMessage({ findings: ['ИИН', { kind: 'телефон' }] }, ''), 'не отправлено в модель: ИИН, телефон');
  assert.equal(engineMessage(null, 'Traceback (most recent call last):\n  File "a.py"\nKeyError: «Сумма»\n'), 'KeyError: «Сумма»');
  assert.equal(engineMessage(null, ''), null);
  assert.ok(engineMessage({ error: 'я'.repeat(5000) }, '').length <= 600);
});

test('normalizeHistory: список, объект со списком, без времени как в файле, ограничение', () => {
  assert.deepEqual(normalizeHistory(null), []);
  assert.deepEqual(normalizeHistory({ nothing: 1 }), []);
  const flat = [{ id: 3 }, { id: 2 }, 'мусор', { id: 1 }];
  assert.deepEqual(normalizeHistory(flat).map((a) => a.id), [3, 2, 1]);
  // Как у движка: новые в начале, время в created; одинаковое время не меняет порядок файла.
  const engine = [
    { id: 'q-2', created: '2026-10-29T22:15:00' },
    { id: 'q-1b', created: '2026-10-29T22:10:00' },
    { id: 'q-1a', created: '2026-10-29T22:10:00' },
  ];
  assert.deepEqual(normalizeHistory(engine).map((a) => [a.id, a.time]), [
    ['q-2', '2026-10-29T22:15:00'],
    ['q-1b', '2026-10-29T22:10:00'],
    ['q-1a', '2026-10-29T22:10:00'],
  ]);
  const timed = [
    { id: 'b', created_at: '2026-10-29 12:00:00' },
    { id: 'a', created_at: '2026-10-29 09:00:00' },
    { id: 'c', created_at: '2026-10-29 15:00:00' },
  ];
  assert.deepEqual(normalizeHistory({ history: timed }).map((a) => [a.id, a.time]), [
    ['c', '2026-10-29 15:00:00'],
    ['b', '2026-10-29 12:00:00'],
    ['a', '2026-10-29 09:00:00'],
  ]);
  assert.equal(normalizeHistory(Array.from({ length: 80 }, (_, i) => ({ id: i }))).length, 50);
});

// ---------- загрузка файлов со страницы ----------

const UP = { 'X-Cabinet': '1', 'Content-Type': 'application/octet-stream' };
const upload = (name, body, headers = UP, onPort) =>
  request('POST', `${T}/api/analiz/upload`, { ...headers, ...(name === null ? {} : { 'X-File-Name': encodeURIComponent(name) }) }, body, onPort);
const dataDir = () => join(cab, 'input', 'analiz');
const dataFiles = () => (existsSync(dataDir()) ? readdirSync(dataDir()).sort() : []);

test('upload: файл ложится в input/analiz как есть, кириллица и пробелы в имени; тот же файл ещё раз → « (2)», без перезаписи', async () => {
  const csv = Buffer.from('Точка;Сумма\nТочка-01;1,5\n', 'utf8');
  const r = await upload('Продажи Точка октябрь.csv', csv);
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json, { ok: true, file: 'Продажи Точка октябрь.csv', renamed: false, size: csv.length });
  assert.deepEqual(readFileSync(join(dataDir(), 'Продажи Точка октябрь.csv')), csv);
  const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3, 0xff]);
  const again = await upload('Продажи Точка октябрь.csv', xlsx);
  assert.equal(again.status, 200);
  assert.equal(again.json.file, 'Продажи Точка октябрь (2).csv');
  assert.equal(again.json.renamed, true);
  assert.deepEqual(readFileSync(join(dataDir(), 'Продажи Точка октябрь.csv')), csv, 'первый файл не перезаписан');
  assert.deepEqual(readFileSync(join(dataDir(), 'Продажи Точка октябрь (2).csv')), xlsx, 'двоичный файл без изменений');
  assert.equal((await upload('Продажи Точка октябрь.csv', csv)).json.file, 'Продажи Точка октябрь (3).csv');
  assert.equal((await upload('Книга.XLSX', xlsx)).json.file, 'Книга.XLSX', 'расширение без учёта регистра');
  assert.equal((await upload('макрос.xlsm', xlsx)).status, 200);
  assert.equal((await upload('выгрузка.txt', csv)).status, 200);
  assert.ok(!dataFiles().some((f) => f.startsWith('.')), 'временных файлов не осталось');
  // Паспорт видит загруженный файл.
  const pass = await get(`${T}/api/analiz/passport`);
  assert.ok(pass.json.passport.files.some((f) => f.file === 'Продажи Точка октябрь (2).csv'));
});

test('upload: путь в имени отбрасывается, файл только в input/analiz; управляющие знаки и скрытое имя чистятся', async () => {
  const body = Buffer.from('a;b\n1;2\n');
  const claude = readFileSync(join(cab, 'CLAUDE.md'), 'utf8');
  for (const [name, saved] of [
    ['../../CLAUDE.md.csv', 'CLAUDE.md.csv'],
    ['..\\..\\..\\zlo.csv', 'zlo.csv'],
    ['/etc/passwd.csv', 'passwd.csv'],
    ['C:\\Users\\Айгуль\\Desktop\\отчёт.xlsx', 'отчёт.xlsx'],
    ['.skrytyi.csv', 'skrytyi.csv'],
    ['~$vremennyi.xlsx', 'vremennyi.xlsx'],
    ['a\u0000b\u0007c\nd.csv', 'abcd.csv'],
    ['что?где:когда*.csv', 'что_где_когда_.csv'],
  ]) {
    const r = await upload(name, body);
    assert.equal(r.status, 200, `${name}: ${r.body}`);
    assert.equal(r.json.file, saved, name);
    assert.ok(existsSync(join(dataDir(), saved)), saved);
  }
  assert.equal(readFileSync(join(cab, 'CLAUDE.md'), 'utf8'), claude, 'файл вне папки не тронут');
  assert.ok(!existsSync(join(cab, 'CLAUDE.md.csv')) && !existsSync(join(base, 'zlo.csv')));
  for (const bad of ['..', '.', '', '   ', '/', '%E0%A4%A']) {
    const r = await request('POST', `${T}/api/analiz/upload`, { ...UP, 'X-File-Name': bad === '%E0%A4%A' ? bad : encodeURIComponent(bad) }, body);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await upload(null, body)).status, 400, 'без имени');
});

test('upload: не та таблица → 415, больше ограничения → 413, пустой → 400; файла нет', async () => {
  const before = dataFiles();
  for (const name of ['virus.exe', 'staryi.xls', 'otchet.pdf', 'bez-rasshireniya', 'skript.csv.js', '.csv']) {
    const r = await upload(name, Buffer.from('x'));
    assert.equal(r.status, 415, name);
    assert.equal(r.json.code, 'ETYPE', name);
    assert.match(r.json.error, /Подходят файлы Excel \(\.xlsx, \.xlsm\) и CSV \(\.csv, \.txt\)/);
  }
  assert.equal(UPLOAD_MAX, 50 * 1024 * 1024);
  // Ограничение 1 КБ на втором сервере: длина в заголовке больше → сразу 413; тело кусками без длины → тоже 413.
  const big = await upload('bolshoi.csv', Buffer.alloc(2048, 0x41), UP, quickPort);
  assert.equal(big.status, 413);
  assert.equal(big.json.code, 'EBIG');
  assert.match(big.json.error, /больше 50 МБ/);
  // Тело кусками больше ограничения: ответ 413, временный .part не остаётся. Повторы ловят гонку: файл
  // создаётся не сразу, и удалить его можно только после закрытия записи.
  const chunkedOver = (parts) => new Promise((res, rej) => {
    const req = http.request(
      { host: '127.0.0.1', port: quickPort, path: `${T}/api/analiz/upload`, method: 'POST', agent: false, headers: { ...UP, 'X-File-Name': 'kuskami.csv', 'Transfer-Encoding': 'chunked' } },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => res({ status: r.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      },
    );
    req.on('error', rej);
    for (const n of parts) req.write(Buffer.alloc(n, 0x42));
    req.end();
  });
  for (let i = 0; i < 30; i++) {
    assert.equal((await chunkedOver([600, 600, 600, 600])).status, 413);
    assert.equal((await chunkedOver([2048])).status, 413, 'больше ограничения первым же куском');
  }
  assert.equal((await upload('malenkii.csv', Buffer.alloc(1000, 0x41), UP, quickPort)).status, 200, 'до ограничения можно');
  const empty = await upload('pustoi.csv', Buffer.alloc(0));
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, 'EEMPTY');
  assert.deepEqual(dataFiles(), [...before, 'malenkii.csv'].sort(), 'лишних файлов (и временных) нет');
});

test('upload: без токена и с чужим токеном 403, без X-Cabinet или не тот тип тела 403, GET 405', async () => {
  const before = dataFiles();
  const body = Buffer.from('a;b\n');
  const name = encodeURIComponent('chuzhoi.csv');
  assert.equal((await request('POST', '/api/analiz/upload', { ...UP, 'X-File-Name': name }, body)).status, 403);
  assert.equal((await request('POST', '/0000000000000000/api/analiz/upload', { ...UP, 'X-File-Name': name }, body)).status, 403);
  const noHeader = await request('POST', `${T}/api/analiz/upload`, { 'Content-Type': 'application/octet-stream', 'X-File-Name': name }, body);
  assert.equal(noHeader.status, 403);
  assert.match(noHeader.json.error, /только со своей страницы/);
  for (const type of ['application/json', 'multipart/form-data; boundary=x', 'text/plain']) {
    assert.equal((await request('POST', `${T}/api/analiz/upload`, { 'X-Cabinet': '1', 'Content-Type': type, 'X-File-Name': name }, body)).status, 403, type);
  }
  const g = await get(`${T}/api/analiz/upload`);
  assert.equal(g.status, 405);
  assert.equal(g.headers.allow, 'POST');
  assert.deepEqual(dataFiles(), before, 'ничего не записано');
});

test('cleanFileName: последняя часть пути, без управляющих знаков, «..», скрытого и временного имени, кириллица остаётся', () => {
  assert.equal(cleanFileName('Продажи Точка октябрь.xlsx'), 'Продажи Точка октябрь.xlsx');
  assert.equal(cleanFileName('../../a.csv'), 'a.csv');
  assert.equal(cleanFileName('a/b\\c.csv'), 'c.csv');
  assert.equal(cleanFileName('отчёт..итог.csv'), 'отчёт.итог.csv');
  assert.equal(cleanFileName('  x  .csv  '), 'x.csv');
  assert.equal(cleanFileName('con.csv'), '_con.csv');
  assert.equal(cleanFileName('a\u202eb.csv'), 'ab.csv');
  assert.equal(cleanFileName('я'.repeat(300) + '.xlsx').length, 150);
  assert.ok(cleanFileName('я'.repeat(300) + '.xlsx').endsWith('.xlsx'));
  for (const bad of ['', '..', '.', '/', '~$', '.csv', null, 5]) assert.equal(cleanFileName(bad), bad === '.csv' ? 'csv' : '', String(bad));
});

test('delete: корзина удаляет таблицу из input/analiz и подпапки; чужие пути, скрытые, ссылки и не таблицы нельзя', async () => {
  mkdirSync(join(dataDir(), 'arhiv'), { recursive: true });
  writeFileSync(join(dataDir(), 'udalit.csv'), 'a;b\n1;2\n');
  writeFileSync(join(dataDir(), 'arhiv', 'staryi.xlsx'), 'x');
  writeFileSync(join(dataDir(), '.skrytyi.csv'), 'x');
  writeFileSync(join(cab, 'input', 'ryadom.csv'), 'x');
  const del = (file, headers = WRITE) => post(`${T}/api/analiz/delete`, { file }, headers);
  // Только со страницы: без X-Cabinet или не JSON 403, GET 405.
  assert.equal((await del('udalit.csv', { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await request('POST', `${T}/api/analiz/delete`, { 'X-Cabinet': '1', 'Content-Type': 'text/plain' }, '{"file":"udalit.csv"}')).status, 403);
  assert.equal((await get(`${T}/api/analiz/delete`)).status, 405);
  for (const file of ['../ryadom.csv', 'arhiv/../../ryadom.csv', '/etc/passwd.csv', 'C:\\x.csv', 'arhiv\\staryi.xlsx', '.skrytyi.csv', 'arhiv/.x.csv', '~$Книга.xlsx', 'CLAUDE.md', 'arhiv', '', 'a//b.csv']) {
    const r = await del(file);
    assert.equal(r.status, 400, file);
    assert.equal(r.json.code, 'ENAME', file);
  }
  assert.equal((await post(`${T}/api/analiz/delete`, { file: 5 })).status, 400, 'не строка');
  assert.ok(existsSync(join(cab, 'input', 'ryadom.csv')), 'файл рядом с папкой цел');
  assert.ok(existsSync(join(dataDir(), '.skrytyi.csv')), 'скрытый файл цел');
  const ok = await del('udalit.csv');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, file: 'udalit.csv' });
  assert.ok(!existsSync(join(dataDir(), 'udalit.csv')));
  assert.equal((await del('arhiv/staryi.xlsx')).status, 200, 'файл в подпапке, как в паспорте');
  assert.ok(existsSync(join(dataDir(), 'arhiv')), 'подпапка остаётся');
  const again = await del('udalit.csv');
  assert.equal(again.status, 404);
  assert.equal(again.json.code, 'ENOFILE');
  rmSync(join(dataDir(), 'arhiv'), { recursive: true, force: true });
  rmSync(join(dataDir(), '.skrytyi.csv'), { force: true });
  rmSync(join(cab, 'input', 'ryadom.csv'), { force: true });
});

test('delete: ссылка (symlink) из input/analiz на файл вне папки не удаляется', { skip: process.platform === 'win32' }, async () => {
  const { symlinkSync } = await import('node:fs');
  writeFileSync(join(cab, 'vne.csv'), 'x');
  symlinkSync(join(cab, 'vne.csv'), join(dataDir(), 'ssylka.csv'));
  try {
    const r = await post(`${T}/api/analiz/delete`, { file: 'ssylka.csv' });
    assert.equal(r.status, 400);
    assert.ok(existsSync(join(cab, 'vne.csv')), 'файл вне папки цел');
  } finally {
    rmSync(join(dataDir(), 'ssylka.csv'), { force: true });
    rmSync(join(cab, 'vne.csv'), { force: true });
  }
});
