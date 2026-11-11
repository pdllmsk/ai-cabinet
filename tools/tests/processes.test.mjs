import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';
import {
  LOG_LIMIT_BYTES,
  MAX_CONCURRENT,
  listProcesses,
  processStatus,
  resolvePython,
  runProcess,
  startRun,
  validateResult,
} from '../processes.mjs';

// Кабинет во временной папке с кириллицей и пробелом, как в профиле Windows.
function makeCabinet() {
  const base = mkdtempSync(join(tmpdir(), 'proc-'));
  const root = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(root, { recursive: true });
  const add = (slug, json, runPy) => {
    const dir = join(root, 'processes', slug);
    mkdirSync(dir, { recursive: true });
    if (json !== undefined) writeFileSync(join(dir, 'process.json'), typeof json === 'string' ? json : JSON.stringify(json));
    if (runPy !== undefined) writeFileSync(join(dir, 'run.py'), runPy);
    return dir;
  };
  const result = (slug, data) => {
    mkdirSync(join(root, 'output', slug), { recursive: true });
    writeFileSync(join(root, 'output', slug, 'result.json'), typeof data === 'string' ? data : JSON.stringify(data));
  };
  return { base, root, add, result, done: () => rmSync(base, { recursive: true, force: true }) };
}

const script = (slug, title = slug) => ({ title, phrase: `запусти ${title}`, kind: 'script', input: `input/${slug}/`, output: `output/${slug}/` });

const goodResult = (slug) => ({
  title: 'Светофор',
  updated_at: '2026-09-21T10:30:00',
  status: 'red',
  summary: 'Истекли: 1.',
  columns: ['№', 'Дата'],
  rows: [['А-1', '31.08.2026'], ['А-2', ''], ['А-3', 'бессрочно']],
  row_status: ['red', 'grey', 'info'],
  row_note: [null, null, 'бессрочно'],
  files: [`output/${slug}/svetofor.xlsx`],
});

const PROBE = `import json, os, sys
os.makedirs(os.path.join("output", "probe"), exist_ok=True)
with open(os.path.join("output", "probe", "probe.json"), "w", encoding="utf-8") as f:
    json.dump({"cwd": os.getcwd(), "argv": sys.argv}, f)
print("готово: строка в stdout")
print("предупреждение в stderr", file=sys.stderr)
`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('listProcesses: нет папки processes → пустой список', () => {
  const c = makeCabinet();
  try {
    assert.deepEqual(listProcesses(c.root), []);
  } finally {
    c.done();
  }
});

test('listProcesses: процессы с результатом, без результата, kind claude, битые файлы не роняют список', () => {
  const c = makeCabinet();
  try {
    c.add('svetofor', script('svetofor', 'Светофор точек продаж'), 'print(1)\n');
    c.result('svetofor', goodResult('svetofor'));
    c.add('pisma', { title: 'Черновики писем', phrase: 'напиши черновики писем', kind: 'claude', input: 'input/pisma/', output: 'output/pisma/' });
    c.add('novyi', script('novyi', 'Новый процесс'), 'print(1)\n');
    c.add('bityi', script('bityi', 'Битый результат'), 'print(1)\n');
    c.result('bityi', '{"title": "обрыв');
    c.add('ne-po-sheme', script('ne-po-sheme', 'Не по схеме'), 'print(1)\n');
    c.result('ne-po-sheme', { title: 'x', status: 'blue' });
    c.add('bez-json', undefined, 'print(1)\n');
    c.add('bez-run', script('bez-run', 'Без программы'));
    c.add('Svetofor_2', script('x'), 'print(1)\n');
    writeFileSync(join(c.root, 'processes', 'zametka.txt'), 'не процесс');
    mkdirSync(join(c.root, 'processes', '.skrytaya'));

    const list = listProcesses(c.root);
    const by = Object.fromEntries(list.map((p) => [p.slug, p]));
    assert.deepEqual(Object.keys(by).sort(), ['Svetofor_2', 'bez-json', 'bez-run', 'bityi', 'ne-po-sheme', 'novyi', 'pisma', 'svetofor']);
    for (const p of list) {
      assert.deepEqual(Object.keys(p).sort(), ['error', 'kind', 'phrase', 'result', 'running', 'slug', 'title']);
      assert.equal(p.running, false);
    }

    assert.equal(by.svetofor.title, 'Светофор точек продаж');
    assert.equal(by.svetofor.phrase, 'запусти Светофор точек продаж');
    assert.equal(by.svetofor.kind, 'script');
    assert.equal(by.svetofor.error, null);
    assert.deepEqual(by.svetofor.result, goodResult('svetofor'));

    assert.equal(by.pisma.kind, 'claude');
    assert.equal(by.pisma.result, null);
    assert.equal(by.pisma.error, null);

    assert.equal(by.novyi.result, null);
    assert.equal(by.novyi.error, null);

    assert.equal(by.bityi.result, null);
    assert.match(by.bityi.error, /output\/bityi\/result\.json/);
    assert.match(by.bityi.error, /[А-Яа-я]/);

    assert.equal(by['ne-po-sheme'].result, null);
    assert.match(by['ne-po-sheme'].error, /status/);

    assert.match(by['bez-json'].error, /process\.json/);
    assert.match(by['bez-run'].error, /run\.py/);
    assert.equal(by.Svetofor_2.kind, null);
    assert.match(by.Svetofor_2.error, /латинск/);
  } finally {
    c.done();
  }
});

test('listProcesses: process.json с BOM и битый process.json', () => {
  const c = makeCabinet();
  try {
    c.add('s-bom', '\uFEFF' + JSON.stringify(script('s-bom', 'С BOM')), 'print(1)\n');
    c.add('lomanyi', '{"title": ', 'print(1)\n');
    c.add('chuzhoi-kind', { ...script('chuzhoi-kind'), kind: 'robot' }, 'print(1)\n');
    const by = Object.fromEntries(listProcesses(c.root).map((p) => [p.slug, p]));
    assert.equal(by['s-bom'].title, 'С BOM');
    assert.equal(by['s-bom'].error, null);
    assert.match(by.lomanyi.error, /process\.json/);
    assert.equal(by.lomanyi.title, 'lomanyi');
    assert.match(by['chuzhoi-kind'].error, /kind/);
  } finally {
    c.done();
  }
});

test('validateResult: правильный результат и минимальный (итог одной строкой)', () => {
  assert.deepEqual(validateResult(goodResult('svetofor'), 'svetofor'), { ok: true, errors: [] });
  const minimal = { title: 'Итог', updated_at: '2026-09-21T10:30:00+05:00', status: 'green', summary: 'Всё в порядке.', columns: [], rows: [] };
  assert.deepEqual(validateResult(minimal), { ok: true, errors: [] });
});

test('validateResult: ошибки по-русски с именем поля', () => {
  const bad = (patch, field) => {
    const r = validateResult({ ...goodResult('s'), ...patch }, 's');
    assert.equal(r.ok, false, field);
    assert.ok(r.errors.some((e) => e.startsWith(field) && /[А-Яа-я]/.test(e)), `${field}: ${r.errors.join(' | ')}`);
  };
  bad({ title: '' }, 'title');
  bad({ updated_at: 'вчера' }, 'updated_at');
  bad({ status: 'grey' }, 'status');
  bad({ summary: 5 }, 'summary');
  bad({ columns: 'А, Б' }, 'columns');
  bad({ rows: [['только одна ячейка']], row_status: undefined, row_note: undefined }, 'rows');
  bad({ rows: [[{ a: 1 }, 'x'], ['a', 'b'], ['a', 'b']] }, 'rows');
  bad({ row_status: ['red', 'grey'] }, 'row_status');
  bad({ row_status: ['red', 'grey', 'purple'] }, 'row_status');
  bad({ row_note: [null, 1, null] }, 'row_note');
  bad({ files: ['C:/Users/секрет.xlsx'] }, 'files');
  bad({ files: ['output/s/../../me/rules.md'] }, 'files');
  bad({ files: ['output/chuzhoi/x.xlsx'] }, 'files');
  bad({ files: 'output/s/x.xlsx' }, 'files');
  for (const v of [null, [], 'строка', 5]) {
    const r = validateResult(v);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /[А-Яа-я]/);
  }
  const missing = validateResult({});
  for (const f of ['title', 'updated_at', 'status', 'summary', 'columns', 'rows']) {
    assert.ok(missing.errors.some((e) => e.startsWith(f)), f);
  }
});

test('validateResult: «разобрать вручную»: строки без отметки (null) и с пометкой info, файлы Word и Excel в output/<slug>/', () => {
  const r = {
    ...goodResult('obr'),
    status: 'green',
    rows: [['11', 'Точка-09', 'разобрать вручную'], ['1', 'Точка-07', 'оборудование'], ['2', 'Точка-03', 'другое']],
    columns: ['№', 'Точка', 'Тема'],
    row_status: ['info', null, null],
    row_note: ['разобрать вручную', null, null],
    files: ['output/obr/razobrat-vruchnuyu.xlsx', 'output/obr/obrashcheniya-po-temam.xlsx', 'output/obr/pisma/pismo-01.docx'],
    sverka: { 'итоги': { 'обращений': 3 }, 'по строкам': { 11: 'разобрать вручную' } },
  };
  assert.deepEqual(validateResult(r, 'obr'), { ok: true, errors: [] });
  assert.equal(validateResult({ ...r, row_status: ['info', null, 'purple'] }, 'obr').ok, false);
  assert.equal(validateResult({ ...r, files: ['output/obr/../drugoy/pismo.docx'] }, 'obr').ok, false);
});

test('validateResult: путь с обратной косой чертой от Windows допустим', () => {
  assert.equal(validateResult({ ...goodResult('s'), files: ['output\\s\\svetofor.xlsx'] }, 's').ok, true);
});

test('runProcess: запускает processes/<slug>/run.py из корня кабинета без аргументов, лог в output/<slug>/last-run.log', async () => {
  const c = makeCabinet();
  try {
    c.add('probe', script('probe'), PROBE);
    const r = await runProcess(c.root, 'probe');
    assert.equal(r.ok, true, readFileSync(r.logPath, 'utf8'));
    assert.equal(r.code, 0);
    assert.ok(r.durationMs >= 0);
    assert.equal(r.logPath, join(c.root, 'output', 'probe', 'last-run.log'));
    const probe = JSON.parse(readFileSync(join(c.root, 'output', 'probe', 'probe.json'), 'utf8'));
    assert.equal(realpathSync(probe.cwd), realpathSync(c.root));
    assert.equal(probe.argv.length, 1);
    // Запускается уже проверенный настоящий путь run.py, а не имя, которое можно подменить после проверки.
    assert.equal(probe.argv[0], realpathSync(join(c.root, 'processes', 'probe', 'run.py')));
    const log = readFileSync(r.logPath, 'utf8');
    assert.match(log, /готово: строка в stdout/);
    assert.match(log, /предупреждение в stderr/);
    const st = processStatus(c.root, 'probe');
    assert.equal(st.running, false);
    assert.equal(st.lastRun.ok, true);
    assert.equal(st.lastRun.code, 0);
    assert.ok(!Number.isNaN(Date.parse(st.lastRun.finishedAt)));
  } finally {
    c.done();
  }
});

test('runProcess: ненулевой код выхода → ok false и код в lastRun; лог перезаписывается', async () => {
  const c = makeCabinet();
  try {
    c.add('oshibka', script('oshibka'), 'import sys\nprint("второй запуск")\nsys.exit(3)\n');
    mkdirSync(join(c.root, 'output', 'oshibka'), { recursive: true });
    writeFileSync(join(c.root, 'output', 'oshibka', 'last-run.log'), 'старый лог\n');
    const r = await runProcess(c.root, 'oshibka');
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    const log = readFileSync(r.logPath, 'utf8');
    assert.doesNotMatch(log, /старый лог/);
    assert.match(log, /второй запуск/);
    const { ok, code } = processStatus(c.root, 'oshibka').lastRun;
    assert.deepEqual({ ok, code }, { ok: false, code: 3 });
  } finally {
    c.done();
  }
});

test('runProcess: отказы с кодами: чужое имя, выход за папку, kind claude, нет run.py', async () => {
  const c = makeCabinet();
  try {
    c.add('pisma', { title: 'Черновики писем', phrase: 'напиши черновики писем', kind: 'claude' });
    c.add('bez-run', script('bez-run'));
    c.add('lomanyi', '{', 'print(1)\n');
    mkdirSync(join(c.root, 'outside'), { recursive: true });
    writeFileSync(join(c.root, 'outside', 'run.py'), 'print("не должен запуститься")\n');
    const cases = [
      ['net-takogo', 'ENOPROCESS'],
      ['../outside', 'EBADSLUG'],
      ['..', 'EBADSLUG'],
      ['a/b', 'EBADSLUG'],
      ['Pisma', 'EBADSLUG'],
      ['', 'EBADSLUG'],
      ['x'.repeat(41), 'EBADSLUG'],
      [undefined, 'EBADSLUG'],
      ['pisma', 'ECLAUDE'],
      ['bez-run', 'ENORUN'],
      ['lomanyi', 'EBADPROCESS'],
    ];
    for (const [slug, code] of cases) {
      await assert.rejects(runProcess(c.root, slug), (e) => e.code === code && /[А-Яа-я]/.test(e.message), String(slug));
      assert.throws(() => startRun(c.root, slug), (e) => e.code === code, String(slug));
    }
    await assert.rejects(runProcess(c.root, 'pisma'), /этот процесс запускается фразой в Claude: напиши черновики писем/);
  } finally {
    c.done();
  }
});

test('runProcess: run.py-ссылка или папка-ссылка наружу из processes не запускаются', async (t) => {
  const c = makeCabinet();
  try {
    const outside = join(c.base, 'chuzhaya papka');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'run.py'), 'open("vzlom.txt", "w").write("x")\n');
    writeFileSync(join(outside, 'process.json'), JSON.stringify(script('vneshnyaya')));
    const dir = c.add('ssylka', script('ssylka'));
    try {
      symlinkSync(join(outside, 'run.py'), join(dir, 'run.py'));
    } catch (e) {
      return t.skip(`символические ссылки на файлы недоступны (${e.code})`);
    }
    await assert.rejects(runProcess(c.root, 'ssylka'), (e) => e.code === 'EOUTSIDE');
    mkdirSync(join(c.root, 'processes'), { recursive: true });
    symlinkSync(outside, join(c.root, 'processes', 'vneshnyaya'), 'junction');
    await assert.rejects(runProcess(c.root, 'vneshnyaya'), (e) => e.code === 'EOUTSIDE');
    await sleep(300);
    assert.throws(() => readFileSync(join(c.root, 'vzlom.txt')), /ENOENT/);
  } finally {
    c.done();
  }
});

test('runProcess: второй запуск того же процесса, пока идёт первый → ERUNNING; другой процесс можно', async () => {
  const c = makeCabinet();
  try {
    // Первый запуск ждёт файла-сигнала, а не фиксированное время: холодный старт Python у второго
    // процесса может идти дольше любой паузы.
    const go = join(c.root, 'output', 'dolgiy', 'go');
    c.add(
      'dolgiy',
      script('dolgiy'),
      'import os, time\ngo = os.path.join("output", "dolgiy", "go")\nfor _ in range(1200):\n    if os.path.exists(go):\n        break\n    time.sleep(0.05)\n',
    );
    c.add('bystryi', script('bystryi'), 'print("ok")\n');
    const first = runProcess(c.root, 'dolgiy');
    assert.equal(processStatus(c.root, 'dolgiy').running, true);
    assert.throws(() => startRun(c.root, 'dolgiy'), (e) => e.code === 'ERUNNING' && /уже идёт/.test(e.message));
    await assert.rejects(runProcess(c.root, 'dolgiy'), (e) => e.code === 'ERUNNING');
    assert.equal((await runProcess(c.root, 'bystryi')).ok, true);
    assert.equal(listProcesses(c.root).find((p) => p.slug === 'dolgiy').running, true);
    writeFileSync(go, '');
    assert.equal((await first).ok, true);
    assert.equal(processStatus(c.root, 'dolgiy').running, false);
    assert.equal((await runProcess(c.root, 'dolgiy')).ok, true);
  } finally {
    c.done();
  }
});

test('runProcess: по таймауту процесс и его дочерние процессы останавливаются', async () => {
  const c = makeCabinet();
  try {
    c.add(
      'zavis',
      script('zavis'),
      `import os, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
with open(os.path.join("output", "zavis", "child.pid"), "w") as f:
    f.write(str(child.pid))
print("жду", flush=True)
time.sleep(60)
`,
    );
    const started = Date.now();
    // Два холодных старта Python (процесс и его дочерний) должны успеть до остановки по времени.
    const r = await runProcess(c.root, 'zavis', { timeoutMs: 8000 });
    assert.ok(Date.now() - started < 25000, `шёл ${Date.now() - started} мс`);
    assert.equal(r.ok, false);
    const log = readFileSync(r.logPath, 'utf8');
    assert.match(log, /жду/);
    assert.match(log, /остановлен/i);
    const pid = Number(readFileSync(join(c.root, 'output', 'zavis', 'child.pid'), 'utf8'));
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    assert.equal(alive(pid), false, `дочерний процесс ${pid} жив`);
    assert.equal(processStatus(c.root, 'zavis').running, false);
    assert.equal(processStatus(c.root, 'zavis').lastRun.ok, false);
  } finally {
    c.done();
  }
});

test('runProcess: Python не найден → ok false, понятная строка в логе', async () => {
  const c = makeCabinet();
  try {
    c.add('bez-python', script('bez-python'), 'print(1)\n');
    const r = await runProcess(c.root, 'bez-python', { python: join(c.base, 'net-takogo-python') });
    assert.equal(r.ok, false);
    assert.equal(r.code, null);
    assert.match(readFileSync(r.logPath, 'utf8'), /Python/);
    assert.equal(processStatus(c.root, 'bez-python').running, false);
  } finally {
    c.done();
  }
});

test('processStatus: процесса не запускали → running false, lastRun null', () => {
  const c = makeCabinet();
  try {
    c.add('novyi', script('novyi'), 'print(1)\n');
    assert.deepEqual(processStatus(c.root, 'novyi'), { running: false, lastRun: null });
  } finally {
    c.done();
  }
});

test('resolvePython: абсолютный путь к настоящему Python вне кабинета', async () => {
  const c = makeCabinet();
  try {
    const exe = await resolvePython(c.root);
    assert.ok(exe, 'Python не найден');
    assert.ok(isAbsolute(exe), exe);
    assert.ok(statSync(exe).isFile(), exe);
    assert.ok(!realpathSync(exe).startsWith(realpathSync(c.root) + sep), exe);
  } finally {
    c.done();
  }
});

test('Python, подложенный в папку кабинета, не находится и не запускается', { skip: process.platform === 'win32' && 'на Windows поиск в текущей папке закрыт иначе, тест для sh' }, async () => {
  const c = makeCabinet();
  const cwd = process.cwd();
  const path = process.env.PATH;
  try {
    // Подделка отвечает как Python и оставляет след. «.» в начале PATH изображает поиск Windows в текущей папке.
    const fake = `#!/bin/sh
echo pwned > "${join(c.root, 'pwned.txt')}"
case "$1" in --version) echo "Python 3.12.9";; -c) echo "${join(c.root, 'python3')}";; esac
`;
    for (const name of ['python3', 'python']) {
      writeFileSync(join(c.root, name), fake);
      chmodSync(join(c.root, name), 0o755);
    }
    process.chdir(c.root);
    process.env.PATH = `.${delimiter}${path}`;
    const exe = await resolvePython(c.root);
    assert.ok(exe && !exe.startsWith(c.root), String(exe));
    c.add('probe', script('probe'), 'import json, os, sys\nos.makedirs(os.path.join("output", "probe"), exist_ok=True)\nopen(os.path.join("output", "probe", "exe.txt"), "w").write(sys.executable)\n');
    const r = await runProcess(c.root, 'probe');
    assert.equal(r.ok, true, readFileSync(r.logPath, 'utf8'));
    assert.ok(!readFileSync(join(c.root, 'output', 'probe', 'exe.txt'), 'utf8').startsWith(c.root));
    assert.equal(existsSync(join(c.root, 'pwned.txt')), false, 'подделка запускалась');
  } finally {
    process.chdir(cwd);
    process.env.PATH = path;
    c.done();
  }
});

test('runProcess: папка processes, ведущая за пределы кабинета, не запускается', async (t) => {
  const c = makeCabinet();
  try {
    const outside = join(c.base, 'chuzhie processy');
    mkdirSync(join(outside, 'vneshniy'), { recursive: true });
    writeFileSync(join(outside, 'vneshniy', 'process.json'), JSON.stringify(script('vneshniy')));
    writeFileSync(join(outside, 'vneshniy', 'run.py'), 'open("vzlom.txt", "w").write("x")\n');
    try {
      symlinkSync(outside, join(c.root, 'processes'), 'junction');
    } catch (e) {
      return t.skip(`ссылки на папки недоступны (${e.code})`);
    }
    await assert.rejects(runProcess(c.root, 'vneshniy'), (e) => e.code === 'EOUTSIDE');
    await sleep(300);
    assert.equal(existsSync(join(c.root, 'vzlom.txt')), false);
  } finally {
    c.done();
  }
});

test('runProcess: журнал больше лимита → процесс остановлен, журнал обрезан, строка по-русски', async () => {
  const c = makeCabinet();
  try {
    assert.equal(LOG_LIMIT_BYTES, 20 * 1024 * 1024);
    c.add('boltun', script('boltun'), 'import sys\nwhile True:\n    sys.stdout.write("x" * 65536)\n');
    const limit = 1024 * 1024;
    const started = Date.now();
    const r = await runProcess(c.root, 'boltun', { logLimitBytes: limit, timeoutMs: 60000 });
    assert.ok(Date.now() - started < 20000, `шёл ${Date.now() - started} мс`);
    assert.equal(r.ok, false);
    const log = readFileSync(r.logPath, 'utf8');
    assert.match(log, /Процесс остановлен: слишком большой журнал/);
    assert.ok(statSync(r.logPath).size < limit + 1000, `размер ${statSync(r.logPath).size}`);
    assert.equal(processStatus(c.root, 'boltun').running, false);
  } finally {
    c.done();
  }
});

test('runProcess: остановка дерева не сработала → через паузу процесс добивается, статус не залипает', async () => {
  const c = makeCabinet();
  try {
    c.add('upryamyi', script('upryamyi'), `import os, time
with open(os.path.join("output", "upryamyi", "pid.txt"), "w") as f:
    f.write(str(os.getpid()))
time.sleep(60)
`);
    const started = Date.now();
    const r = await runProcess(c.root, 'upryamyi', { timeoutMs: 1500, killGraceMs: 300, killTree: () => {} });
    assert.ok(Date.now() - started < 10000, `шёл ${Date.now() - started} мс`);
    assert.equal(r.ok, false);
    assert.equal(processStatus(c.root, 'upryamyi').running, false);
    assert.equal(processStatus(c.root, 'upryamyi').lastRun.ok, false);
    const pid = Number(readFileSync(join(c.root, 'output', 'upryamyi', 'pid.txt'), 'utf8'));
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    assert.equal(alive(pid), false, `процесс ${pid} жив`);
  } finally {
    c.done();
  }
});

test('runProcess: не больше двух расчётов одновременно в одном кабинете', async () => {
  const c = makeCabinet();
  try {
    assert.equal(MAX_CONCURRENT, 2);
    for (const s of ['odin', 'dva', 'tri']) c.add(s, script(s), 'import time\ntime.sleep(1.5)\n');
    const first = runProcess(c.root, 'odin');
    const second = runProcess(c.root, 'dva');
    assert.throws(() => startRun(c.root, 'tri'), (e) => e.code === 'ELIMIT' && /[А-Яа-я]/.test(e.message));
    // Другой кабинет на том же сервере считается отдельно.
    const d = makeCabinet();
    try {
      d.add('tri', script('tri'), 'print(1)\n');
      assert.equal((await runProcess(d.root, 'tri')).ok, true);
    } finally {
      d.done();
    }
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.equal((await runProcess(c.root, 'tri')).ok, true);
  } finally {
    c.done();
  }
});

// Замок output/<slug>/.running и статус output/<slug>/last-run.json общие для страницы и node tools/processes.mjs.
test('замок: пока идёт расчёт, лежит output/<slug>/.running с pid и временем; после конца снят, last-run.json записан', async () => {
  const c = makeCabinet();
  try {
    c.add('dolgiy', script('dolgiy'), 'import time\ntime.sleep(1)\n');
    const run = startRun(c.root, 'dolgiy');
    const lockFile = join(c.root, 'output', 'dolgiy', '.running');
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    assert.equal(lock.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(lock.startedAt)));
    assert.equal(processStatus(c.root, 'dolgiy').running, true);
    const r = await run.done;
    assert.equal(r.ok, true, readFileSync(r.logPath, 'utf8'));
    assert.equal(existsSync(lockFile), false);
    const last = JSON.parse(readFileSync(join(c.root, 'output', 'dolgiy', 'last-run.json'), 'utf8'));
    assert.deepEqual(processStatus(c.root, 'dolgiy'), { running: false, lastRun: last });
    assert.deepEqual([last.ok, last.code], [true, 0]);
    assert.ok(Number.isInteger(last.durationMs));
  } finally {
    c.done();
  }
});

test('замок: чужой живой запуск даёт ERUNNING, устаревший (процесса нет или идёт дольше срока) снимается', async () => {
  const c = makeCabinet();
  try {
    c.add('svodka', script('svodka'), 'print("ok")\n');
    const out = join(c.root, 'output', 'svodka');
    mkdirSync(out, { recursive: true });
    const lockFile = join(out, '.running');
    // Живой процесс: этот тест. Журнал прежнего запуска не трогается.
    writeFileSync(join(out, 'last-run.log'), 'журнал идущего расчёта\n');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), timeoutMs: 60000, id: 'x' }));
    assert.throws(() => startRun(c.root, 'svodka'), (e) => e.code === 'ERUNNING');
    assert.equal(readFileSync(join(out, 'last-run.log'), 'utf8'), 'журнал идущего расчёта\n');
    assert.equal(listProcesses(c.root)[0].running, true);
    // Файл замка пишется прямо сейчас (пустой, свежий): тоже «идёт».
    writeFileSync(lockFile, '');
    assert.throws(() => startRun(c.root, 'svodka'), (e) => e.code === 'ERUNNING');
    // Процесса с таким pid уже нет.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    writeFileSync(lockFile, JSON.stringify({ pid: Number(dead.stdout), startedAt: new Date().toISOString(), timeoutMs: 60000, id: 'y' }));
    assert.equal(processStatus(c.root, 'svodka').running, false);
    assert.equal((await runProcess(c.root, 'svodka')).ok, true);
    assert.equal(existsSync(lockFile), false);
    // Живой pid, но расчёт идёт дольше своего срока с запасом.
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 3600 * 1000).toISOString(), timeoutMs: 1000, id: 'z' }));
    assert.equal(processStatus(c.root, 'svodka').running, false);
    assert.equal((await runProcess(c.root, 'svodka')).ok, true);
    // Пустой файл замка, оставшийся надолго.
    writeFileSync(lockFile, '');
    const old = new Date(Date.now() - 3600 * 1000);
    utimesSync(lockFile, old, old);
    assert.equal((await runProcess(c.root, 'svodka')).ok, true);
    assert.equal(existsSync(lockFile), false);
  } finally {
    c.done();
  }
});

test('замок: лимит двух расчётов считает и запуски из других программ (файлы замков)', () => {
  const c = makeCabinet();
  try {
    for (const s of ['odin', 'dva', 'tri']) c.add(s, script(s), 'print(1)\n');
    for (const s of ['odin', 'dva']) {
      mkdirSync(join(c.root, 'output', s), { recursive: true });
      writeFileSync(join(c.root, 'output', s, '.running'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), timeoutMs: 60000, id: s }));
    }
    assert.throws(() => startRun(c.root, 'tri'), (e) => e.code === 'ELIMIT');
    assert.equal(existsSync(join(c.root, 'output', 'tri', '.running')), false, 'замок отказанного запуска остался');
  } finally {
    c.done();
  }
});

test('cancel: остановка запуска снимает замок и пишет неудачный last-run.json', async () => {
  const c = makeCabinet();
  try {
    c.add('zavis', script('zavis'), 'import time\nprint("жду", flush=True)\ntime.sleep(60)\n');
    const run = startRun(c.root, 'zavis');
    for (let i = 0; i < 200 && !readFileSync(run.logPath, 'utf8').includes('жду'); i++) await sleep(50);
    run.cancel();
    const r = await run.done;
    assert.equal(r.ok, false);
    assert.match(readFileSync(run.logPath, 'utf8'), /прерван/);
    assert.equal(existsSync(join(c.root, 'output', 'zavis', '.running')), false);
    assert.equal(processStatus(c.root, 'zavis').lastRun.ok, false);
  } finally {
    c.done();
  }
});
