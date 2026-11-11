// Шаблон проекта сервиса templates/service-project: каркас main.py. Читает самый свежий файл в input/,
// пишет output/result.json по схеме карточки, понятные ошибки одной строкой по-русски, без трейсбека.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { programProblems, validateResult } from '../processes.mjs';
import { copyDir } from './copy-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(ROOT, 'templates', 'service-project');

// ---------- каркас main.py в настоящей папке ----------

function findPython() {
  for (const exe of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(exe, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return exe;
  }
  return null;
}
const PY = findPython();

// Проект, как его создаёт кабинет: копия шаблона, в lib копии tools/llm.py и tools/read_table.py.
function makeProject({ lib = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'svc-'));
  const dir = join(base, 'Айгуль Н', 'Сервисы', 'svodka prodazh');
  copyDir(TEMPLATE, dir);
  rmSync(join(dir, '__pycache__'), { recursive: true, force: true });
  if (lib) for (const f of ['llm.py', 'read_table.py']) copyFileSync(join(ROOT, 'tools', f), join(dir, 'lib', f));
  return { base, dir, done: () => rmSync(base, { recursive: true, force: true }) };
}

const runMain = (dir) =>
  spawnSync(PY, ['main.py'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });

test('каркас main.py проходит проверку программ кабинета', () => {
  assert.deepEqual(programProblems(readFileSync(join(TEMPLATE, 'main.py'), 'utf8')), []);
});

test('каркас main.py на выгрузке 1С учебного кейса: output/result.json по схеме карточки', (t) => {
  if (!PY) return t.skip('нет Python');
  const p = makeProject();
  try {
    copyFileSync(join(ROOT, 'input', 'case', 'data', 'prodazhi_1c.csv'), join(p.dir, 'input', 'prodazhi_1c.csv'));
    const r = runMain(p.dir);
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(readFileSync(join(p.dir, 'output', 'result.json'), 'utf8'));
    assert.deepEqual(validateResult(res), { ok: true, errors: [] });
    assert.equal(res.title, 'Новый сервис');
    assert.equal(res.status, 'green');
    assert.deepEqual(res.columns, ['Столбец', 'Заполнено', 'Из них числа']);
    assert.ok(res.rows.some((row) => row[0] === 'Точка'), JSON.stringify(res.rows));
    assert.match(res.summary, /prodazhi_1c\.csv/);
    assert.ok(!existsSync(join(p.dir, 'output', 'result.json.tmp')));
    assert.match(r.stdout, /Каркас сервиса/);
  } finally {
    p.done();
  }
});

test('каркас main.py: нет файла, нет lib, сбой программы: одна строка по-русски, коды 2 и 1, без трейсбека', (t) => {
  if (!PY) return t.skip('нет Python');
  const p = makeProject();
  const q = makeProject({ lib: false });
  try {
    let r = runMain(p.dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^В папке input нет файла с данными/);
    assert.doesNotMatch(r.stderr, /Traceback/);

    writeFileSync(join(q.dir, 'input', 'x.csv'), 'a;b\n1;2\n');
    r = runMain(q.dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /В папке lib нет файла read_table\.py/);

    writeFileSync(join(p.dir, 'input', 'x.csv'), 'a;b\n1;2\n');
    const main = readFileSync(join(p.dir, 'main.py'), 'utf8').replace(/\r\n/g, '\n').replace('    src = newest_input()\n', '    src = newest_input()\n    {}["Сумма"]\n');
    writeFileSync(join(p.dir, 'main.py'), main);
    r = runMain(p.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^Сбой программы сервиса \(main\.py, строка \d+\): KeyError: 'Сумма'\. Скажите Claude/);
    assert.equal(r.stderr.trim().split('\n').length, 1);
    assert.doesNotMatch(r.stderr, /Traceback/);
  } finally {
    p.done();
    q.done();
  }
});

test('каркас main.py: ключ из .env читается программой, нет ключа: понятная причина', (t) => {
  if (!PY) return t.skip('нет Python');
  const p = makeProject();
  try {
    writeFileSync(join(p.dir, '.env'), '\uFEFFSITE_KEY="секрет 1"\n');
    const probe = (name) =>
      spawnSync(PY, ['-c', `import main\ntry:\n    print(main.read_env("${name}"))\nexcept main.StopRun as e:\n    print("STOP", e)`], {
        cwd: p.dir,
        encoding: 'utf8',
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    assert.equal(probe('SITE_KEY').stdout.trim(), 'секрет 1');
    assert.match(probe('NET').stdout, /^STOP Нет ключа NET в файле \.env/);
  } finally {
    p.done();
  }
});

test('шаблон проекта копируется в путь с кириллицей и пробелом по файлам', () => {
  const p = makeProject();
  try {
    for (const f of ['.gitignore', '.claude/settings.json', 'input/.gitkeep', 'lib/llm.py']) {
      assert.ok(existsSync(join(p.dir, f)), f);
    }
    assert.equal(realpathSync(p.dir).endsWith('svodka prodazh'), true);
  } finally {
    p.done();
  }
});
