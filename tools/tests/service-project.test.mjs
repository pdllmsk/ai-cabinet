// Шаблон проекта сервиса templates/service-project: сторож проекта (.claude/hooks/guard.mjs) и каркас main.py.
// Сторож: запись в lib/ и .claude/ запрещена всегда; команда, которая упоминает lib или .claude (кроме разрешённых),
// идёт не из проекта или выходит за него, спрашивает окно; где окна нет, запрет. Каркас: читает самый свежий файл
// в input/, пишет output/result.json по схеме карточки, понятные ошибки одной строкой по-русски, без трейсбека.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REASON_CABINET,
  REASON_FILE_OUTSIDE,
  REASON_LOCKED,
  REASON_NO_PROMPT,
  REASON_OTHER,
  REASON_OUTSIDE,
  REASON_PROTECTED,
  classify,
  classifyFile,
  decide,
  hookOutput,
  pathCandidates,
} from '../../templates/service-project/.claude/hooks/guard.mjs';
import { programProblems, validateResult } from '../processes.mjs';
import { copyDir } from './copy-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(ROOT, 'templates', 'service-project');

const WIN_ROOT = 'C:\\Users\\Айгуль Н\\Documents\\Сервисы\\svodka-prodazh';
const WIN = { tool: 'Bash', roots: [WIN_ROOT], cwds: [WIN_ROOT], platform: 'win32', mode: 'acceptEdits', home: 'C:\\Users\\Айгуль Н' };
const NIX_ROOT = '/home/aigul/Документы/Сервисы/svodka-prodazh';
const NIX = { tool: 'Bash', roots: [NIX_ROOT], cwds: [NIX_ROOT], platform: 'linux', mode: 'acceptEdits', home: '/home/aigul' };
const CABINET_CMD = 'node "C:\\Users\\Айгуль Н\\Documents\\ai-cabinet\\tools\\services.mjs" add "C:\\Users\\Айгуль Н\\Documents\\Сервисы\\svodka-prodazh"';

const decision = (cmd, ctx) => classify(cmd, ctx)?.decision ?? null;
const reason = (cmd, ctx) => classify(cmd, ctx)?.reason ?? null;

test('сторож проекта: разрешённые команды и команды внутри проекта без решения', () => {
  for (const cmd of [
    'python main.py',
    'py main.py',
    'python ./main.py',
    'python lib/read_table.py "input/sales tochki.csv" --rows 5',
    'python lib/read_table.py "input/x.csv" --sum "Сумма, л" --by "Точка" --where "Дата=14.09.2026..20.09.2026"',
    'python lib/llm.py status',
    `python "${WIN_ROOT}\\main.py"`,
    'ls input',
    'git status',
    'git init',
    'ls 2>/dev/null',
    'dir 2>$null',
    'curl https://example.kz/prices',
    'ls Документы/x',
    'python lib/read_table.py "input/x.csv" --sum "Сумма"; python lib/read_table.py "input/x.csv" --by "Точка"',
    'python main.py && python lib/read_table.py "input/x.csv" --rows 5',
  ]) {
    assert.equal(decision(cmd, WIN), null, cmd);
  }
  assert.equal(decision('python3 main.py', NIX), null);
});

test('сторож проекта: lib и .claude в любом написании спрашивают окно', () => {
  for (const cmd of [
    'cat lib/llm.py',
    'echo x > lib/llm.py',
    'cp a .claude/settings.json',
    'type CLAUDE~1\\settings.json',
    'ls l*',
    'rm -f l{i,}b/llm.py',
    "echo $'\\x6c'ib",
    'python lib/read_table.py ".claude/settings.json"',
    'python main.py lib',
    'python lib/read_table.py "input/x.csv"; cat lib/llm.py',
    'python lib/read_table.py "input/x.csv" --sum "a;b" && rm lib/llm.py',
  ]) {
    assert.equal(decision(cmd, WIN), 'ask', cmd);
    assert.equal(reason(cmd, WIN), REASON_PROTECTED, cmd);
  }
});

test('сторож проекта: команда за пределами проекта спрашивает окно, команда кабинета со своей подписью', () => {
  for (const cmd of [
    'cat ../ai-cabinet/input/x.csv',
    'ls ~/Documents',
    'cat /etc/passwd',
    'ls /c/Users',
    'cd ..',
    'cd',
    'echo $HOME',
    'dir %USERPROFILE%',
    'Get-ChildItem $env:USERPROFILE',
    `python -c "open('/etc/passwd')"`,
    'python lib/read_table.py "C:\\Users\\Айгуль Н\\Documents\\ai-cabinet\\input\\x.csv"',
    'type \\\\server\\share\\x.txt',
    'python lib/read_table.py "input/x.csv"; python lib/read_table.py "/etc/passwd"',
  ]) {
    assert.equal(decision(cmd, WIN), 'ask', cmd);
    assert.equal(reason(cmd, WIN), REASON_OUTSIDE, cmd);
  }
  assert.equal(reason(CABINET_CMD, WIN), REASON_CABINET);
  assert.equal(reason('cat /home/aigul/ai-cabinet/CLAUDE.md', NIX), REASON_OUTSIDE);
  assert.equal(decision(`cat "${NIX_ROOT}/output/result.json"`, NIX), null);
  // Команда идёт из папки вне проекта или изнутри lib/.
  assert.equal(reason('ls', { ...WIN, cwds: ['C:\\Users\\Айгуль Н\\Documents'] }), REASON_OUTSIDE);
  assert.equal(reason('ls', { ...WIN, cwds: [`${WIN_ROOT}\\lib`] }), REASON_PROTECTED);
});

test('сторож проекта: режимы (Auto: окно на всё, кроме разрешённого; без окна: запрет)', () => {
  for (const mode of ['default', 'manual', 'acceptEdits', 'plan']) {
    assert.equal(decision('ls', { ...NIX, mode }), null, mode);
    assert.equal(decision('cat lib/x', { ...NIX, mode }), 'ask', mode);
  }
  assert.equal(decision('python3 main.py', { ...NIX, mode: 'auto' }), null);
  assert.equal(reason('ls', { ...NIX, mode: 'auto' }), REASON_OTHER);
  for (const mode of ['bypassPermissions', 'dontAsk', undefined, 'новый']) {
    assert.equal(decision('python3 main.py', { ...NIX, mode }), null, String(mode));
    assert.equal(reason('ls', { ...NIX, mode }), REASON_NO_PROMPT, String(mode));
    assert.equal(reason('cat /etc/passwd', { ...NIX, mode }), REASON_NO_PROMPT, String(mode));
  }
});

test('сторож проекта: запись в lib/ и .claude/ запрещена всегда, вне проекта решает Claude Code, в Auto окно', () => {
  const file = (f, mode = 'acceptEdits', tool = 'Write') => classifyFile([f], { ...WIN, tool, mode });
  for (const f of ['lib/llm.py', 'LIB\\read_table.py', 'lib./x.py', 'lib /x.py', '.claude/settings.json', '.claude/hooks/guard.mjs',
    'CLAUDE~1/settings.json', '.claude::$INDEX_ALLOCATION/x', `${WIN_ROOT}\\Lib\\llm.py`, 'output\\..\\lib\\llm.py']) {
    for (const mode of ['acceptEdits', 'auto', 'bypassPermissions']) {
      assert.deepEqual(file(f, mode), { decision: 'deny', reason: REASON_LOCKED }, `${f} ${mode}`);
    }
  }
  for (const f of ['main.py', 'service.json', 'CLAUDE.md', 'output/result.json', 'page/index.html', 'library/x.py']) {
    assert.equal(file(f), null, f);
    assert.equal(file(f, 'bypassPermissions'), null, f);
  }
  const outside = 'C:\\Users\\Айгуль Н\\Documents\\ai-cabinet\\CLAUDE.md';
  assert.equal(file(outside), null);
  assert.deepEqual(file(outside, 'auto'), { decision: 'ask', reason: REASON_FILE_OUTSIDE });
  assert.deepEqual(file('..\\x.txt', 'dontAsk'), { decision: 'deny', reason: REASON_NO_PROMPT });
  assert.equal(classifyFile([], { ...WIN, tool: 'Artifact', mode: 'auto' }), null);
  for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) assert.equal(file('lib/llm.py', 'acceptEdits', tool).decision, 'deny', tool);
  assert.equal(classifyFile(['lib/llm.py'], { ...WIN, tool: 'Read', mode: 'acceptEdits' }), null);
});

test('сторож проекта: пути из текста команды (кавычки с пробелом целиком, адреса сайтов не пути)', () => {
  assert.deepEqual(pathCandidates('python lib/read_table.py "input/a b.csv"'), []);
  assert.deepEqual(pathCandidates('node "C:\\Users\\А Н\\x.mjs" check .'), ['C:\\Users\\А Н\\x.mjs']);
  assert.deepEqual(pathCandidates('curl https://example.kz/a/b'), []);
  assert.deepEqual(pathCandidates(`python -c "open('/etc/x')"`), ['/etc/x']);
  assert.deepEqual(pathCandidates('ls ../x ~/y 2>/dev/null'), ['../x', '~/y']);
});

test('сторож проекта: тексты по-русски, без тире и без слов, которых человеку не говорят', () => {
  for (const r of [REASON_LOCKED, REASON_PROTECTED, REASON_OUTSIDE, REASON_CABINET, REASON_OTHER, REASON_FILE_OUTSIDE, REASON_NO_PROMPT]) {
    assert.match(r, /[А-Яа-я]/);
    assert.doesNotMatch(r, /[\u2012-\u2015]/);
    assert.doesNotMatch(r, /скрипт|терминал|консол|сервер|порт\b|хук/i);
  }
  assert.equal(hookOutput(null), '');
  assert.doesNotMatch(hookOutput({ decision: 'ask', reason: REASON_OUTSIDE }), /[^\x00-\x7f]/);
});

// ---------- как процесс и каркас main.py в настоящей папке ----------

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

test('хук проекта как процесс: JSON из stdin, решение в stdout, корень из CLAUDE_PROJECT_DIR', () => {
  const p = makeProject({ lib: false });
  try {
    const guard = join(p.dir, '.claude', 'hooks', 'guard.mjs');
    const hook = (input) => {
      const r = spawnSync(process.execPath, [guard], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: p.dir } });
      assert.equal(r.status, 0);
      return r.stdout === '' ? null : JSON.parse(r.stdout).hookSpecificOutput;
    };
    const base = { cwd: p.dir, permission_mode: 'acceptEdits' };
    assert.equal(hook({ ...base, tool_name: 'Write', tool_input: { file_path: join(p.dir, 'lib', 'llm.py'), content: 'x' } }).permissionDecision, 'deny');
    assert.equal(hook({ ...base, tool_name: 'Write', tool_input: { file_path: join(p.dir, 'main.py'), content: 'x' } }), null);
    assert.equal(hook({ ...base, tool_name: 'Bash', tool_input: { command: 'python main.py' } }), null);
    const out = hook({ ...base, tool_name: 'Bash', tool_input: { command: `cat "${join(p.base, 'секрет.txt')}"` } });
    assert.equal(out.permissionDecision, 'ask');
    assert.equal(out.permissionDecisionReason, REASON_OUTSIDE);
    assert.equal(hook({ ...base, permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'ls' } }).permissionDecision, 'deny');
    // Мусор на входе: без решения, код 0.
    const r = spawnSync(process.execPath, [guard], { input: 'не json', encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(decide({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: p.dir, permission_mode: 'acceptEdits' }, { roots: [p.dir] }), null);
  } finally {
    p.done();
  }
});

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
    for (const f of ['.gitignore', '.claude/settings.json', '.claude/hooks/guard.mjs', 'input/.gitkeep', 'lib/llm.py']) {
      assert.ok(existsSync(join(p.dir, f)), f);
    }
    assert.equal(realpathSync(p.dir).endsWith('svodka prodazh'), true);
  } finally {
    p.done();
  }
});
