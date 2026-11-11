// Путь к Python для кнопки «Запустить»: отдельный файл, чтобы кэш найденного Python был пустым.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { isInside, parseExecutable, resolvePython, runProcess } from '../processes.mjs';

const WIN = process.platform === 'win32';
// Казахские буквы вне cp1251: на Windows Python пишет в канал в кодовой странице ANSI и на них падает.
const NON_ASCII = 'Әсел Қ';

const PROBE = `import json, os, sys
os.makedirs(os.path.join("output", "probe"), exist_ok=True)
with open(os.path.join("output", "probe", "exe.json"), "w", encoding="utf-8") as f:
    json.dump(sys.executable, f)
`;

function makeCabinet() {
  const base = mkdtempSync(join(tmpdir(), 'pyp-'));
  const root = join(base, 'Айгуль Н', 'ai-cabinet');
  const dir = join(root, 'processes', 'probe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'process.json'), JSON.stringify({ title: 'Проба', phrase: 'запусти пробу', kind: 'script' }));
  writeFileSync(join(dir, 'run.py'), PROBE);
  return { base, root, done: () => rmSync(base, { recursive: true, force: true }) };
}

// venv без pip в папке с казахскими буквами: sys.executable указывает внутрь неё.
function makeVenv(base, python) {
  const venv = join(base, NON_ASCII, 'venv');
  mkdirSync(dirname(venv), { recursive: true });
  const r = spawnSync(python, ['-m', 'venv', '--without-pip', venv], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return { venv, bin: join(venv, WIN ? 'Scripts' : 'bin') };
}

const exeFrom = (root) => JSON.parse(readFileSync(join(root, 'output', 'probe', 'exe.json'), 'utf8'));

test('parseExecutable: последняя строка в JSON, юникод через \\u, мусор → null', () => {
  assert.equal(parseExecutable('"C:\\\\Users\\\\\\u0410\\u0439\\u0433\\u0443\\u043b\\u044c \\u041d\\\\python.exe"\r\n'), 'C:\\Users\\Айгуль Н\\python.exe');
  assert.equal(parseExecutable('предупреждение\n"/usr/bin/python3"\n'), '/usr/bin/python3');
  assert.equal(parseExecutable('\uFEFF"/opt/\\u04d8\\u0441\\u0435\\u043b \\u049a/python"'), '/opt/Әсел Қ/python');
  for (const bad of ['', 'C:\\Users\\������ �\\python.exe', '42', 'null', '"', '["/usr/bin/python3"]']) {
    assert.equal(parseExecutable(bad), null, bad);
  }
});

test('isInside: на Windows без учёта регистра, на остальных с учётом', () => {
  assert.equal(isInside('C:\\Users\\Айгуль Н\\ai-cabinet\\python.exe', 'c:\\users\\айгуль н\\AI-CABINET', 'win32'), true);
  assert.equal(isInside('C:\\Users\\X\\ai-cabinet-2\\python.exe', 'C:\\Users\\X\\ai-cabinet', 'win32'), false);
  assert.equal(isInside('/home/a/Cab/python3', '/home/a/cab', 'linux'), false);
  assert.equal(isInside('/home/a/cab/python3', '/home/a/cab', 'linux'), true);
});

test('Python в папке с казахскими буквами: путь не искажается, запуск идёт им', async (t) => {
  const c = makeCabinet();
  const path = process.env.PATH;
  try {
    const system = await resolvePython(c.root);
    assert.ok(system, 'Python не найден');
    const v = makeVenv(c.base, system);
    if (!v) return t.skip('venv не создаётся');
    process.env.PATH = `${v.bin}${delimiter}${path}`;
    const exe = await resolvePython(c.root);
    assert.ok(exe && exe.includes(NON_ASCII), String(exe));
    assert.ok(statSync(exe).isFile(), exe);
    // Кэш пуст (отдельный файл тестов): запуск без явного python находит тот же путь и запускает им.
    const r = await runProcess(c.root, 'probe');
    assert.equal(r.ok, true, readFileSync(r.logPath, 'utf8'));
    assert.equal(exeFrom(c.root), exe);
  } finally {
    process.env.PATH = path;
    c.done();
  }
});

test('Python, который перестал запускаться, забывается: следующий запуск ищет заново', { skip: WIN && 'на Windows права файла не запрещают запуск' }, async (t) => {
  const c = makeCabinet();
  const path = process.env.PATH;
  try {
    const system = await resolvePython(c.root);
    const v = makeVenv(c.base, system);
    if (!v) return t.skip('venv не создаётся');
    process.env.PATH = `${v.bin}${delimiter}${path}`;
    const first = await runProcess(c.root, 'probe');
    assert.equal(first.ok, true, readFileSync(first.logPath, 'utf8'));
    const cached = exeFrom(c.root);
    assert.ok(cached.includes(NON_ASCII), cached);
    // Тот же путь, но уже не программа: запуск падает, и путь не должен остаться в памяти.
    for (const name of ['python', 'python3']) {
      try {
        unlinkSync(join(v.bin, name));
      } catch {
        // такого имени в venv нет
      }
      writeFileSync(join(v.bin, name), 'не программа', { mode: 0o644 });
    }
    const broken = await runProcess(c.root, 'probe');
    assert.equal(broken.ok, false);
    assert.match(readFileSync(broken.logPath, 'utf8'), /Не удалось запустить Python/);
    const again = await runProcess(c.root, 'probe');
    assert.equal(again.ok, true, readFileSync(again.logPath, 'utf8'));
    assert.ok(!exeFrom(c.root).includes(NON_ASCII), exeFrom(c.root));
  } finally {
    process.env.PATH = path;
    c.done();
  }
});
