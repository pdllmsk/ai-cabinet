// node tools/processes.mjs list | run | input | demo: общий с кнопкой запуск, замок и статус в файлах output/<slug>/.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { createCabinetServer, listenFirstFree } from '../serve.mjs';
import { crc32, deflateRawSync } from 'node:zlib';
import { processStatus, zipEntries } from '../processes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = '0123456789abcdef0123456789abcdef';
const RUN_HEADERS = { 'X-Cabinet': '1', 'Content-Type': 'application/json' };

const RESULT_PY = (slug, title) => `import json, os, sys
from datetime import datetime
out = os.path.join("output", "${slug}")
os.makedirs(out, exist_ok=True)
res = {"title": "${title}", "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
       "status": "yellow", "summary": "Сумма за неделю: 1200, нет данных по Точка-03.", "columns": ["Точка", "Сумма"],
       "rows": [["Точка-01", 1200], ["Точка-03", None]], "row_status": ["green", "grey"],
       "files": ["output/${slug}/svodka.xlsx"]}
with open(os.path.join(out, "result.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, allow_nan=False)
print("готово")
`;

const SLOW_PY = (slug, seconds) => `import json, os, time
from datetime import datetime
time.sleep(${seconds})
out = os.path.join("output", "${slug}")
os.makedirs(out, exist_ok=True)
res = {"title": "Долгий", "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
       "status": "green", "summary": "Долгий расчёт закончен.", "columns": [], "rows": []}
with open(os.path.join(out, "result.json"), "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False)
`;

let base, cab;

function addProcess(slug, json, runPy) {
  const dir = join(cab, 'processes', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'process.json'), JSON.stringify(json));
  if (runPy !== undefined) writeFileSync(join(dir, 'run.py'), runPy);
}

const script = (slug, title) => ({ title, phrase: `запусти ${title.toLowerCase()}`, kind: 'script', input: `input/${slug}/`, output: `output/${slug}/` });

before(() => {
  base = mkdtempSync(join(tmpdir(), 'cli-'));
  cab = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(cab, { recursive: true });
  copyDir(join(ROOT, 'tools'), join(cab, 'tools'));
  rmSync(join(cab, 'tools', 'tests'), { recursive: true, force: true });
  copyDir(join(ROOT, 'templates'), join(cab, 'templates'));
  rmSync(join(cab, 'templates', 'processes', 'svetofor-tochek', '__pycache__'), { recursive: true, force: true });
  copyDir(join(ROOT, 'templates', 'site'), join(cab, 'site'));
  mkdirSync(join(cab, 'input', 'case', 'data'), { recursive: true });
  for (const f of ['ostatki_1c.xlsx', 'prodazhi_1c.csv']) {
    writeFileSync(join(cab, 'input', 'case', 'data', f), readFileSync(join(ROOT, 'input', 'case', 'data', f)));
  }
  addProcess('svodka-prodazh', { ...script('svodka-prodazh', 'Сводка продаж'), phrase: 'запусти сводку продаж' }, RESULT_PY('svodka-prodazh', 'Сводка продаж'));
  addProcess('dolgiy', script('dolgiy', 'Долгий'), SLOW_PY('dolgiy', 2));
  addProcess('padaet', script('padaet', 'Падает'), 'import sys\nprint("строка 1")\nprint("Нет файла input/padaet/sales.csv", file=sys.stderr)\nsys.exit(2)\n');
  addProcess('molchit', script('molchit', 'Молчит'), 'print("ничего не записал")\n');
  addProcess('krivoy', script('krivoy', 'Кривой'), `import json, os
os.makedirs(os.path.join("output", "krivoy"), exist_ok=True)
open(os.path.join("output", "krivoy", "result.json"), "w").write('{"title": "Кривой", "updated_at": "2026-10-22T10:00:00", "status": "blue", "summary": "", "columns": [], "rows": []}')
`);
  addProcess('pisma', { title: 'Черновики писем', phrase: 'запусти черновики писем', kind: 'claude', skill: 'pisma-postavshchikam', input: 'input/pisma/', output: 'output/pisma/' });
});

after(() => rmSync(base, { recursive: true, force: true }));

// CLI из копии tools/ внутри кабинета: корень кабинета он находит от своего расположения.
function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [join(cab, 'tools', 'processes.mjs'), ...args], {
    cwd: opts.cwd ?? cab,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...opts.env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function cliAsync(args) {
  const child = spawn(process.execPath, [join(cab, 'tools', 'processes.mjs'), ...args], { cwd: cab, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  // close, а не exit: к close весь вывод уже прочитан.
  const done = new Promise((r) => child.on('close', (code, signal) => r({ code, signal, out })));
  return { child, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lockOf = (slug) => join(cab, 'output', slug, '.running');
const lastRunOf = (slug) => join(cab, 'output', slug, 'last-run.json');

// check может бросить (файла ещё нет, файл пишется и пока пуст): это значит «ещё нет».
async function waitFor(check, what, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const v = check();
      if (v) return v;
    } catch {
      // ещё нет
    }
    await sleep(20);
  }
  throw new Error(`не дождались: ${what}`);
}

function request(port, method, path, headers = {}, body) {
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
        res({ status: r.statusCode, json });
      });
    });
    req.on('error', rej);
    req.end(body);
  });
}

async function withServer(fn) {
  const server = createCabinetServer(cab, { token: TOKEN });
  const port = await listenFirstFree(server, { from: 18900, to: 18999 });
  try {
    await fn({
      run: (slug) => request(port, 'POST', `/${TOKEN}/api/run/${slug}`, RUN_HEADERS, '{}'),
      status: async (slug) => (await request(port, 'GET', `/${TOKEN}/api/status/${slug}`)).json,
      list: async () => (await request(port, 'GET', `/${TOKEN}/api/processes`)).json,
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  }
}

test('run: удачный расчёт → «Готово», итог, путь к result.json; last-run.json записан, замок снят', () => {
  const r = cli(['run', 'svodka-prodazh']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Готово: «Сводка продаж»/m);
  assert.match(r.out, /Итог: Сумма за неделю: 1200, нет данных по Точка-03\./);
  assert.match(r.out, /Цвет карточки: жёлтый/);
  assert.match(r.out, /Результат: output\/svodka-prodazh\/result\.json/);
  assert.match(r.out, /Файлы: output\/svodka-prodazh\/svodka\.xlsx/);
  assert.doesNotMatch(r.out, /[\u2012-\u2015]/);
  const last = JSON.parse(readFileSync(lastRunOf('svodka-prodazh'), 'utf8'));
  assert.equal(last.ok, true);
  assert.equal(last.code, 0);
  assert.ok(!Number.isNaN(Date.parse(last.finishedAt)));
  assert.ok(Number.isInteger(last.durationMs) && last.durationMs >= 0);
  assert.equal(existsSync(lockOf('svodka-prodazh')), false, 'замок остался');
  assert.match(readFileSync(join(cab, 'output', 'svodka-prodazh', 'last-run.log'), 'utf8'), /готово/);
});

test('run: расчёт упал → код 1, «не удался», последние строки журнала; last-run.json ok false', () => {
  const r = cli(['run', 'padaet']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /не удался/);
  assert.match(r.out, /output\/padaet\/last-run\.log/);
  assert.match(r.out, /Нет файла input\/padaet\/sales\.csv/);
  const last = JSON.parse(readFileSync(lastRunOf('padaet'), 'utf8'));
  assert.deepEqual([last.ok, last.code], [false, 2]);
  assert.equal(existsSync(lockOf('padaet')), false);
});

test('run: программа не записала result.json или записала не по схеме → код 1, «готово» не печатается', () => {
  const silent = cli(['run', 'molchit']);
  assert.equal(silent.code, 1, silent.out);
  assert.match(silent.out, /не записала output\/molchit\/result\.json/);
  assert.doesNotMatch(silent.out, /Готово/);
  const bad = cli(['run', 'krivoy']);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /result\.json/);
  assert.match(bad.out, /status: нужно green, yellow или red/);
  assert.doesNotMatch(bad.out, /Готово/);
});

test('run: result.json не обновился (старый файл остался) → код 1', () => {
  addProcess('staryi', script('staryi', 'Старый'), 'print("посчитал, но не записал")\n');
  mkdirSync(join(cab, 'output', 'staryi'), { recursive: true });
  writeFileSync(
    join(cab, 'output', 'staryi', 'result.json'),
    JSON.stringify({ title: 'Старый', updated_at: '2026-09-21T10:00:00', status: 'green', summary: 'старый итог', columns: [], rows: [] }),
  );
  const old = new Date(Date.now() - 3600 * 1000);
  utimesSync(join(cab, 'output', 'staryi', 'result.json'), old, old);
  const r = cli(['run', 'staryi']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /не обновился/);
});

test('run: нет такого процесса → код 2 и список процессов; kind claude → код 2 и фраза', () => {
  const none = cli(['run', 'net-takogo']);
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /Такого процесса нет: net-takogo/);
  assert.match(none.out, /svodka-prodazh/);
  const bad = cli(['run', '../tools']);
  assert.equal(bad.code, 2, bad.out);
  const claude = cli(['run', 'pisma']);
  assert.equal(claude.code, 2, claude.out);
  assert.match(claude.out, /фразой в Claude: запусти черновики писем/);
  const empty = cli(['run']);
  assert.equal(empty.code, 2, empty.out);
});

test('list: процессы с названием, папкой, фразой, результатом, последним запуском и ошибками', () => {
  cli(['run', 'svodka-prodazh']);
  const r = cli(['list']);
  assert.equal(r.code, 1, r.out); // есть процессы с ошибкой (krivoy)
  assert.match(r.out, /«Сводка продаж» \(папка svodka-prodazh\)/);
  // Строка программы процесса без слова «скилл»: Sonnet принимал его за «выполни сам».
  assert.match(r.out, /«Сводка продаж» \(папка svodka-prodazh\): программа процесса, кнопка «Запустить», фраза «запусти сводку продаж»\.\n/);
  assert.match(r.out, /Результат: обновлён \d\d\.\d\d\.\d{4} \d\d:\d\d, жёлтый\. Итог: Сумма за неделю/);
  assert.match(r.out, /Последний запуск: \d\d\.\d\d\.\d{4} \d\d:\d\d, удачно/);
  assert.match(r.out, /«Черновики писем» \(папка pisma\): выполняет сам Claude по скиллу pisma-postavshchikam, фраза «запусти черновики писем»\./);
  assert.match(r.out, /«Кривой» \(папка krivoy\)[\s\S]*?Ошибка: output\/krivoy\/result\.json: status/);
  // Программа закончилась без ошибки, но карточку не обновила: «удачно» не пишется.
  assert.match(r.out, /«Молчит» \(папка molchit\)[^\n]*\n\s+Результата пока нет\.\n\s+Последний запуск: [^\n]*карточк[^\n]*не обновил/);
  assert.match(r.out, /«Старый» \(папка staryi\)[^\n]*\n[^\n]*\n\s+Последний запуск: [^\n]*не обновил/);
  assert.match(r.out, /«Падает» \(папка padaet\)[\s\S]*?Последний запуск: [^\n]*не удался \(код 2\)/);
  assert.doesNotMatch(r.out, /[\u2012-\u2015]/);
});

test('list: старая страница без карточек (нет render.js) называется отдельной строкой', () => {
  const html = join(cab, 'site', 'index.html');
  const current = readFileSync(html, 'utf8');
  try {
    assert.doesNotMatch(cli(['list']).out, /старой версии/);
    writeFileSync(html, '<!doctype html><body data-cabinet="ok">Кабинет работает</body>');
    assert.match(cli(['list']).out, /^Страница site\/index\.html старой версии: на ней нет карточек процессов\.$/m);
  } finally {
    writeFileSync(html, current);
  }
});

test('list: без процессов → подсказка «добавь процесс», код 0', () => {
  const b = mkdtempSync(join(tmpdir(), 'cli0-'));
  try {
    const root = join(b, 'ai-cabinet');
    copyDir(join(ROOT, 'tools'), join(root, 'tools'));
    const r = spawnSync(process.execPath, [join(root, 'tools', 'processes.mjs'), 'list'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Процессов в кабинете пока нет/);
    assert.match(r.stdout, /«добавь процесс»/);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test('CLI и кнопка не запускают один процесс одновременно: запуск фразой виден странице, кнопка получает 409', async () => {
  await withServer(async (api) => {
    const phrase = cliAsync(['run', 'dolgiy']);
    // Замок создаётся пустым и дописывается: разбираем его, пока не прочитается целиком.
    const lock = await waitFor(() => JSON.parse(readFileSync(lockOf('dolgiy'), 'utf8')), 'замок от CLI');
    assert.equal(lock.pid, phrase.child.pid);
    assert.ok(!Number.isNaN(Date.parse(lock.startedAt)));
    const button = await api.run('dolgiy');
    assert.equal(button.status, 409);
    assert.equal(button.json.code, 'ERUNNING');
    assert.equal((await api.status('dolgiy')).running, true);
    assert.equal((await api.list()).find((p) => p.slug === 'dolgiy').running, true);
    const r = await phrase.done;
    assert.equal(r.code, 0, r.out);
    const st = await api.status('dolgiy');
    assert.equal(st.running, false);
    const last = JSON.parse(readFileSync(lastRunOf('dolgiy'), 'utf8'));
    assert.deepEqual(st.lastRun, last);
    assert.equal(st.lastRun.ok, true);
  });
});

test('кнопка идёт → фраза получает «уже идёт» (код 2) и не трогает журнал', async () => {
  await withServer(async (api) => {
    assert.equal((await api.run('dolgiy')).status, 202);
    assert.equal(existsSync(lockOf('dolgiy')), true);
    const r = cli(['run', 'dolgiy']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /уже идёт/);
    for (let i = 0; i < 200 && (await api.status('dolgiy')).running; i++) await sleep(50);
    const st = await api.status('dolgiy');
    assert.equal(st.running, false);
    assert.equal(st.lastRun.ok, true, readFileSync(join(cab, 'output', 'dolgiy', 'last-run.log'), 'utf8'));
  });
});

test('lastRun переживает перезапуск страницы: новый сервер читает last-run.json', async () => {
  const r = cli(['run', 'padaet']);
  assert.equal(r.code, 1);
  const finishedAt = JSON.parse(readFileSync(lastRunOf('padaet'), 'utf8')).finishedAt;
  await withServer(async (api) => {
    const st = await api.status('padaet');
    assert.equal(st.running, false);
    assert.deepEqual([st.lastRun.ok, st.lastRun.code, st.lastRun.finishedAt], [false, 2, finishedAt]);
  });
  assert.deepEqual(processStatus(cab, 'padaet').lastRun.finishedAt, finishedAt);
});

test('CLI остановили (Ctrl+C, конец команды) → расчёт остановлен, замок снят, last-run.json ok false', { skip: process.platform === 'win32' && 'сигналы на Windows так не доставляются' }, async () => {
  addProcess('zavis', script('zavis', 'Завис'), 'import time\nprint("жду", flush=True)\ntime.sleep(60)\n');
  const run = cliAsync(['run', 'zavis']);
  await waitFor(() => existsSync(lockOf('zavis')) && readFileSync(join(cab, 'output', 'zavis', 'last-run.log'), 'utf8').includes('жду'), 'расчёт начался');
  run.child.kill('SIGTERM');
  const r = await run.done;
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(lockOf('zavis')), false, 'замок остался');
  const last = JSON.parse(readFileSync(lastRunOf('zavis'), 'utf8'));
  assert.equal(last.ok, false);
  assert.match(readFileSync(join(cab, 'output', 'zavis', 'last-run.log'), 'utf8'), /прерван/);
});

test('input: копия файла учебного кейса помечена, свой файл нет', () => {
  const dir = join(cab, 'input', 'na-keyse');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prodazhi.csv'), readFileSync(join(cab, 'input', 'case', 'data', 'prodazhi_1c.csv')));
  writeFileSync(join(dir, 'prodazhi_1c.csv'), 'свой файл с тем же именем\n');
  const r = cli(['input', 'na-keyse', '--no-open']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /prodazhi\.csv \(копия файла учебного кейса prodazhi_1c\.csv\)/);
  assert.match(r.out, /prodazhi_1c\.csv(?! \()/);
  assert.doesNotMatch(r.out, /prodazhi_1c\.csv \(копия/);
});

// Архив zip из членов [[имя, байты]]: время файлов, сжатие и порядок не как у файла кейса. local(имя, данные)
// может подменить сжатые данные и объявленный размер члена (бомба: один поток на все члены).
function zipOf(members, local = null) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  const shared = new Map();
  for (const [nameText, data] of members) {
    const name = Buffer.from(nameText, 'utf8');
    const own = local ? local(nameText, data) : { comp: deflateRawSync(data, { level: 1 }), size: data.length, crc: crc32(data) };
    const fields = (h, at) => {
      h.writeUInt16LE(8, at);
      h.writeUInt16LE(0x6000, at + 2); // 12:00
      h.writeUInt16LE(0x5b57, at + 4); // 23.10.2025
      h.writeUInt32LE(own.crc, at + 6);
      h.writeUInt32LE(own.comp.length, at + 10);
      h.writeUInt32LE(own.size, at + 14);
      h.writeUInt16LE(name.length, at + 18);
    };
    let at = offset;
    if (own.shared && shared.has(own.shared)) at = shared.get(own.shared);
    else {
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);
      fields(head, 8);
      parts.push(head, name, own.comp);
      if (own.shared) shared.set(own.shared, offset);
      offset += 30 + name.length + own.comp.length;
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    fields(central, 10);
    central.writeUInt32LE(at, 42);
    centrals.push(central, name);
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// Файл кейса, пересобранный заново (как в архиве платформы курса): то же содержимое, другие время файлов
// в zip, сжатие, порядок членов и docProps. change(имя, байты) правит члены архива.
const rezip = (buf, change = (name, data) => data) => zipOf(zipEntries(buf).reverse().map((e) => [e.name, change(e.name, e.read())]));

// Одна ячейка (или абзац) другая: первый знак первого значения в листе или документе.
const oneCell = (member) => (name, data) =>
  name === member ? Buffer.from(data.toString('utf8').replace(/(<(?:v|t|w:t)(?:\s[^>]*)?>)([^<])/, (m, tag, c) => tag + (c === '1' ? '2' : '1'))) : data;
const newProps = (name, data) => (name.startsWith('docProps/') ? Buffer.from(data.toString('utf8').replace(/<\/cp:coreProperties>|<\/Properties>/, '<!-- пересобран -->$&')) : data);

test('input: копия файла кейса из архива платформы (xlsx и docx пересобраны) узнаётся по содержимому, правка ячейки нет', () => {
  const data = join(cab, 'input', 'case', 'data');
  writeFileSync(join(data, 'shablon_otcheta.docx'), readFileSync(join(ROOT, 'input', 'case', 'data', 'shablon_otcheta.docx')));
  const dir = join(cab, 'input', 'platforma');
  mkdirSync(dir, { recursive: true });
  const xlsx = readFileSync(join(data, 'ostatki_1c.xlsx'));
  const docx = readFileSync(join(data, 'shablon_otcheta.docx'));
  const files = {
    'ostatki s platformy.xlsx': rezip(xlsx, newProps),
    'Остатки правка.xlsx': rezip(xlsx, oneCell('xl/worksheets/sheet1.xml')),
    'otchet s platformy.docx': rezip(docx, newProps),
    'Отчёт правка.docx': rezip(docx, oneCell('word/document.xml')),
    'ostatki.csv': xlsx, // то же содержимое, другое расширение: только байт в байт с файлом кейса того же вида
  };
  for (const [name, buf] of Object.entries(files)) writeFileSync(join(dir, name), buf);
  assert.notDeepEqual(files['ostatki s platformy.xlsx'], xlsx);
  const r = cli(['input', 'platforma', '--no-open']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ostatki s platformy\.xlsx \(копия файла учебного кейса ostatki_1c\.xlsx\)/);
  assert.match(r.out, /otchet s platformy\.docx \(копия файла учебного кейса shablon_otcheta\.docx\)/);
  for (const own of ['Остатки правка.xlsx', 'Отчёт правка.docx']) {
    assert.ok(r.out.includes(own), r.out);
    assert.ok(!r.out.includes(`${own} (копия`), `${own}: правка ячейки, это не копия кейса`);
  }
  assert.match(r.out, /ostatki\.csv \(копия файла учебного кейса ostatki_1c\.xlsx\)/); // байт в байт: как раньше
});

test('input: копия кейса с лимитами: бомба zip, битый файл, повтор имени члена не копия, команда не падает', () => {
  const data = join(cab, 'input', 'case', 'data');
  const dir = join(cab, 'input', 'bomby');
  mkdirSync(dir, { recursive: true });
  const xlsx = readFileSync(join(data, 'ostatki_1c.xlsx'));
  const members = zipEntries(xlsx).map((e) => [e.name, e.read()]);
  const zeros = deflateRawSync(Buffer.alloc(5 * 1024 * 1024 - 1), { level: 9 });
  const bomb = (size) => () => ({ comp: zeros, size, crc: 0, shared: 'zeros' });
  // Проба ревью: 1500 членов на одном потоке в 5 МБ (раньше 2 ГБ в памяти и падение).
  const many = Array.from({ length: 1500 }, (_, k) => [String(k).padStart(6, '0'), Buffer.alloc(0)]);
  writeFileSync(join(dir, 'bomba.xlsx'), zipOf(many, bomb(5 * 1024 * 1024 - 1)));
  // Оглавление как у файла кейса (те же имена и размеры), а каждый член распаковывается в 5 МБ нулей.
  writeFileSync(join(dir, 'bomba kak ostatki.xlsx'), zipOf(members, (name, d) => bomb(d.length)()));
  // Больше 2000 членов: не копия, даже без распаковки.
  writeFileSync(join(dir, 'mnogo chlenov.xlsx'), zipOf(Array.from({ length: 2001 }, (_, k) => [`m${k}`, Buffer.from('x')])));
  writeFileSync(join(dir, 'bityi.xlsx'), xlsx.subarray(0, Math.floor(xlsx.length / 2)));
  writeFileSync(join(dir, 'ne zip.docx'), 'просто текст');
  // Повтор имени: первым свой лист, за ним лист кейса с тем же именем. Excel откроет первый.
  const sheet = members.find(([name]) => name === 'xl/worksheets/sheet1.xml');
  writeFileSync(join(dir, 'povtor.xlsx'), zipOf([[sheet[0], Buffer.from(sheet[1].toString('utf8').replace('<sheetData>', '<sheetData><!-- свой -->'))], ...members]));
  const started = Date.now();
  const r = cli(['input', 'bomby', '--no-open']);
  assert.equal(r.code, 0, r.out);
  assert.ok(Date.now() - started < 10000, `долго: ${Date.now() - started} мс`);
  for (const name of ['bomba.xlsx', 'bomba kak ostatki.xlsx', 'mnogo chlenov.xlsx', 'bityi.xlsx', 'ne zip.docx', 'povtor.xlsx']) {
    assert.ok(r.out.includes(name), `${name}: ${r.out}`);
    assert.ok(!r.out.includes(`${name} (копия`), `${name}: не копия кейса`);
  }
});

test('без трейсбека: неожиданная ошибка даёт короткую русскую строку и код 2; имена вроде constructor не ломают demo', () => {
  writeFileSync(join(cab, 'input', 'fayl-a-ne-papka'), 'x');
  const r = cli(['input', 'fayl-a-ne-papka', '--no-open']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /^Не удалось выполнить/m);
  assert.doesNotMatch(r.out, /\n\s+at /);
  for (const name of ['constructor', '__proto__', 'toString']) {
    const d = cli(['demo', name]);
    assert.equal(d.code, 2, `${name}: ${d.out}`);
    assert.match(d.out, /Такого демо нет/);
    assert.doesNotMatch(d.out, /\n\s+at /);
  }
});

test('input: создаёт input/<slug>, печатает полный путь и файлы; неверное имя → код 2', () => {
  const r = cli(['input', 'svodka-prodazh', '--no-open']);
  assert.equal(r.code, 0, r.out);
  const dir = join(cab, 'input', 'svodka-prodazh');
  assert.ok(statSync(dir).isDirectory());
  // Полный путь, как его увидит человек. Сравнение настоящих путей: временная папка Windows бывает короткой (RUNNER~1).
  const printed = r.out.match(/^Папка создана: (.+)$/m)?.[1];
  assert.ok(printed, r.out);
  assert.equal(realpathSync.native(printed), realpathSync.native(dir));
  assert.match(r.out, /Файлов в ней пока нет/);
  writeFileSync(join(dir, 'sales_week.csv'), 'Точка;Сумма\n');
  const again = cli(['input', 'svodka-prodazh', '--no-open']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /уже есть/);
  assert.match(again.out, /sales_week\.csv/);
  for (const bad of ['Svodka', '../me', 'a/b', '']) {
    const x = cli(['input', bad, '--no-open']);
    assert.equal(x.code, 2, `${bad}: ${x.out}`);
  }
  assert.equal(existsSync(join(cab, 'me')), false);
});

const hasOpenpyxl = () => {
  for (const py of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(py, ['-c', 'import openpyxl'], { encoding: 'utf8' });
    if (r.status === 0) return true;
  }
  return false;
};

test('demo: ставит процесс курса, кладёт копию файла кейса и считает эталон 7/1/2/1/1/2', { skip: !hasOpenpyxl() && 'нет openpyxl' }, () => {
  const r = cli(['demo', 'svetofor-tochek']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /поставлен в processes\/svetofor-tochek/);
  assert.match(r.out, /input\/svetofor-tochek\/prodazhi_1c\.csv/);
  assert.match(r.out, /^Готово: «Светофор точек продаж»/m);
  assert.ok(existsSync(join(cab, 'processes', 'svetofor-tochek', 'run.py')));
  assert.equal(existsSync(join(cab, 'processes', 'svetofor-tochek', '__pycache__')), false);
  assert.deepEqual(
    readFileSync(join(cab, 'input', 'svetofor-tochek', 'prodazhi_1c.csv')),
    readFileSync(join(cab, 'input', 'case', 'data', 'prodazhi_1c.csv')),
  );
  const res = JSON.parse(readFileSync(join(cab, 'output', 'svetofor-tochek', 'result.json'), 'utf8'));
  const count = {};
  for (const s of res.row_status) count[s] = (count[s] ?? 0) + 1;
  assert.equal([res.rows.length, count.red, count.yellow, count.grey, count.info, count.green].join('/'), '7/1/2/1/1/2');
  // Второй показ: ничего не копирует заново и считает снова.
  const again = cli(['demo', 'svetofor-tochek']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /уже стоит/);
  assert.match(again.out, /Готово/);
});

test('demo: в input лежит другой файл с именем файла кейса → честно говорит и не считает', () => {
  const b = mkdtempSync(join(tmpdir(), 'cli-demo2-'));
  try {
    const root = join(b, 'ai-cabinet');
    copyDir(join(ROOT, 'tools'), join(root, 'tools'));
    copyDir(join(ROOT, 'templates', 'processes'), join(root, 'templates', 'processes'));
    rmSync(join(root, 'templates', 'processes', 'svetofor-tochek', '__pycache__'), { recursive: true, force: true });
    mkdirSync(join(root, 'input', 'case', 'data'), { recursive: true });
    writeFileSync(join(root, 'input', 'case', 'data', 'prodazhi_1c.csv'), readFileSync(join(ROOT, 'input', 'case', 'data', 'prodazhi_1c.csv')));
    mkdirSync(join(root, 'input', 'svetofor-tochek'), { recursive: true });
    writeFileSync(join(root, 'input', 'svetofor-tochek', 'prodazhi_1c.csv'), 'моя выгрузка');
    const r = spawnSync(process.execPath, [join(root, 'tools', 'processes.mjs'), 'demo', 'svetofor-tochek'], { cwd: root, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 2, out);
    assert.match(out, /не совпадает с файлом учебного кейса/);
    assert.doesNotMatch(out, /Готово|Копия файла учебного кейса/);
    assert.equal(readFileSync(join(root, 'input', 'svetofor-tochek', 'prodazhi_1c.csv'), 'utf8'), 'моя выгрузка');
    assert.equal(existsSync(join(root, 'output', 'svetofor-tochek')), false, 'расчёт запускался');
    assert.equal(existsSync(join(root, 'processes', 'svetofor-tochek')), false, 'демо поставлено');
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test('demo: свой процесс с тем же именем не перезаписывается; неизвестное демо → код 2', () => {
  const b = mkdtempSync(join(tmpdir(), 'cli-demo-'));
  try {
    const root = join(b, 'ai-cabinet');
    copyDir(join(ROOT, 'tools'), join(root, 'tools'));
    copyDir(join(ROOT, 'templates', 'processes'), join(root, 'templates', 'processes'));
    mkdirSync(join(root, 'input', 'case', 'data'), { recursive: true });
    writeFileSync(join(root, 'input', 'case', 'data', 'prodazhi_1c.csv'), 'x');
    mkdirSync(join(root, 'processes', 'svetofor-tochek'), { recursive: true });
    writeFileSync(join(root, 'processes', 'svetofor-tochek', 'run.py'), 'print("мой светофор")\n');
    const run = (args) => spawnSync(process.execPath, [join(root, 'tools', 'processes.mjs'), ...args], { cwd: root, encoding: 'utf8' });
    const own = run(['demo', 'svetofor-tochek']);
    assert.equal(own.status, 2, own.stdout + own.stderr);
    assert.match(own.stdout + own.stderr, /свой процесс/);
    assert.equal(readFileSync(join(root, 'processes', 'svetofor-tochek', 'run.py'), 'utf8'), 'print("мой светофор")\n');
    assert.equal(existsSync(join(root, 'input', 'svetofor-tochek')), false);
    const unknown = run(['demo', 'net-takogo']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stdout + unknown.stderr, /svetofor-tochek/);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test('без команды: подсказка по командам', () => {
  const r = cli([]);
  assert.equal(r.code, 0, r.out);
  for (const c of ['list', 'run', 'input', 'demo']) assert.match(r.out, new RegExp(`processes\\.mjs ${c}`));
});
