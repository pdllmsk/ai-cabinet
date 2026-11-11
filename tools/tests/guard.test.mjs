// Сторож .claude/hooks/guard.mjs: любая команда, кроме команд курса, которая упоминает processes или .claude
// в любом написании или идёт изнутри них, спрашивает окно. tools/, templates/, input/ закрывают запреты Edit.
// Запись файлов в input/, tools/, templates/, .claude/hooks/ запрещена всегда. В режимах, где окна нет
// (bypassPermissions, dontAsk, режим не передан или незнаком), вместо окна запрет (D70).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REASON,
  REASON_DATA,
  REASON_FILE,
  REASON_NO_PROMPT,
  REASON_OTHER,
  REASON_SKILL_CMD,
  REASON_SKILL_CMD_NO_PROMPT,
  classify,
  classifyFile,
  decide,
  fileTarget,
  fileZone,
  hookOutput,
  looseForms,
} from '../../.claude/hooks/guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(ROOT, '.claude', 'hooks', 'guard.mjs');

// Таблицы команд ниже проверяются в режиме автоприёма правок (режим кабинета по умолчанию).
const NIX = { tool: 'Bash', roots: ['/home/aigul/ai-cabinet'], cwds: ['/home/aigul/ai-cabinet'], platform: 'linux', mode: 'acceptEdits' };
const WIN = {
  tool: 'PowerShell',
  roots: ['C:\\Users\\Айгуль Н\\ai-cabinet'],
  cwds: ['C:\\Users\\Айгуль Н\\ai-cabinet'],
  platform: 'win32',
  mode: 'acceptEdits',
};
const GITBASH = { ...WIN, tool: 'Bash' };

const ASK_BASH = [
  // Найдено на ревью: обход через \ и cp без окна.
  "echo '# e1' >> proc\\esses/x/run.py",
  'cp output/a.py proc\\esses/x/a1.py',
  'echo x > processes/x/run.py',
  'ls processes',
  'cat processes/x/run.py',
  "echo x > 'proc''esses'/x/run.py",
  'echo x > "pro"cesses/x/run.py',
  'echo x > pro{c,}esses/x/run.py',
  'echo x > {proc,xx}esses/x/run.py',
  "echo x > $'\\x70rocesses'/x/run.py",
  "echo x > $'\\160rocesses'/x/run.py",
  "echo x > proc$''esses/x/run.py",
  'echo x > p*/x/run.py',
  'echo x > ./proc?sses/x/run.py',
  'echo x > [p]rocesses/x/run.py',
  'echo x > output/../p*/x/run.py',
  'echo x > ${D:-processes}/x/run.py',
  'D=processes; echo x > $D/x/run.py',
  'echo x > /home/aigul/ai-cabinet/processes/x/run.py',
  'echo x > /home/aigul/ai-cabinet/p*/x/run.py',
  'echo x > processes./x/run.py',
  'echo x > "processes /x/run.py"',
  'echo x > PROCES~1/x/run.py',
  'echo x > CLAUDE~1/settings.local.json',
  'echo x > PROCESSES/x/run.py',
  "python -c \"open('processes/x/run.py','w').write('x')\"",
  "bash -c 'echo x > processes/x/run.py'",
  'cmd /c "echo x > proc^esses\\x\\run.py"',
  'node tools/processes.mjs run x && echo x > processes/x/run.py',
  'node tools/processes.mjs list > processes/x/run.py',
  'cd processes/x && echo x > run.py',
  'echo x > .claude/settings.local.json',
  'echo x > .clau\\de/settings.local.json',
  'cp evil.mjs .claude/hooks/guard.mjs',
  'echo x >> ~/ai-cabinet/.claude/skills/moi/SKILL.md',
  'rm -rf .claude/skills/moi',
];

const ASK_POWERSHELL = [
  'Set-Content -Path:processes\\x\\run.py -Value:x',
  'Add-Content -Path:processes\\x\\run.py -Value:x',
  'Clear-Content -Path:processes\\x\\run.py',
  'Remove-Item -Path:processes\\x -Recurse',
  'Set-Content proc`esses\\x\\run.py x',
  'Set-Content ("proc" + "esses" + "\\x\\run.py") x',
  "New-Item -ItemType Directory -Force -Path 'processes', 'output\\x'",
  "Copy-Item -Recurse -Force -LiteralPath 'templates\\processes\\svetofor-tochek' -Destination 'processes\\svetofor-tochek'",
  'Set-Content PROCES~1\\x\\run.py x',
  'Set-Content processes.\\x\\run.py x',
  'Set-Content processes...\\x\\run.py x',
  "Set-Content 'processes \\x\\run.py' x",
  "[IO.File]::WriteAllText('processes\\x\\run.py', 'x')",
  'echo x > "C:\\Users\\Айгуль Н\\ai-cabinet\\processes\\x\\run.py"',
  'Set-Location processes\\x; Set-Content run.py x',
  "Set-Content -LiteralPath:.claude\\settings.local.json -Value:'{}'",
  'Set-Content CLAUDE~1\\settings.local.json x',
];

// Команды курса целиком: без решения сторожа в любом режиме.
const COURSE_CMDS = [
  'node tools/serve.mjs --open',
  'node tools/check.mjs',
  'node tools/check.mjs --json',
  'node tools/update.mjs',
  'node tools/processes.mjs run svetofor-tochek',
  'node tools/processes.mjs demo svetofor-tochek',
  'node tools/processes.mjs input svodka-prodazh --no-open',
  'node tools/processes.mjs list',
  'node tools\\processes.mjs list',
  'python tools/read_table.py "input/case/data/prodazhi_1c.csv" --rows 3',
  'py tools/read_table.py "input\\svodka\\Продажи сентябрь.xlsx" --sheet 2',
  'python tools/read_table.py "processes/svodka/data.csv"',
  // Mac: python и py обычно нет, есть python3.
  'python3 tools/read_table.py "input/case/data/prodazhi_1c.csv" --rows 3',
  // Скобки внутри кавычек: имя скачанного файла «skill (1).zip».
  'node tools/processes.mjs read razbor "skill (1).zip"',
  "node tools/processes.mjs read razbor 'skill (1).zip'",
  'python tools/read_table.py "input/svodka/Отчёт (2).xlsx" --from 101 --rows 100',
];

// Команды вне курса, которые не называют processes и .claude: в обычных режимах без решения сторожа
// (окно спрашивает Claude Code), в Auto окно сторожа, без окна запрет.
const OTHER = [
  "python -c \"import openpyxl; wb = openpyxl.load_workbook('input/case/data/reestr_dogovorov.xlsx'); print(wb.sheetnames)\"",
  "python - <<'EOF'\nimport openpyxl\nwb = openpyxl.load_workbook('input/case/data/reestr_dogovorov.xlsx')\nprint(wb.sheetnames)\nEOF",
  "awk -F';' '{print $1}' input/case/data/prodazhi_1c.csv",
  'head -n 5 input/svodka/sales.csv',
  'cat input/a.csv | tee output/b.csv',
  'node tools/processes.mjs list | head -n 20',
  'node tools/processes.mjs input svodka --no-open 2>&1',
  'python -m pip install --user openpyxl python-docx',
  'ls output',
  'rm output/svodka/*.tmp',
  'cp *.csv output/',
  'node --version',
  'echo "# заметки" > output/notes.md',
  // tools/, templates/, input/: решает не сторож, а запреты Edit в settings.json.
  'echo x > tools/serve.mjs',
  'echo x > templ\\ates/x.txt',
  'mkdir -p input/svodka',
];

const NONE = [...COURSE_CMDS, ...OTHER];

const COURSE_POWERSHELL = [
  'node tools\\processes.mjs run svetofor-tochek',
  'py tools\\read_table.py "input\\Отчёт сентябрь.xlsx"',
  'node tools\\processes.mjs read razbor "skill (1).zip"',
];
const OTHER_POWERSHELL = [
  "Get-Content input\\case\\data\\prodazhi_1c.csv -TotalCount 5",
  "Copy-Item -LiteralPath 'input\\case\\data\\reestr_dogovorov.xlsx' -Destination 'output\\reestr.xlsx'",
];
const NONE_POWERSHELL = [...COURSE_POWERSHELL, ...OTHER_POWERSHELL];

// Скобки вне кавычек остаются под запретом: в PowerShell (выражение) внутри аргументов выполняется. Кавычки
// считаются так же, как их видит оболочка: «"» и «'», а «“ ” „ ‘ ’» PowerShell тоже принимает за кавычки.
const NOT_COURSE = [
  'node tools/processes.mjs read razbor skill (1).zip',
  'node tools/processes.mjs read razbor "x"(Remove-Item output)"y"',
  'node tools/processes.mjs read razbor "x”(Remove-Item output)“y"',
  "node tools/processes.mjs read razbor '\"'(Remove-Item output)'\"'",
  "node tools/processes.mjs read razbor 'x’(Remove-Item output)‘y'",
  'node tools/processes.mjs read razbor "skill (1).zip',
  'node tools/processes.mjs read razbor "$(rm -rf output)"',
  'node tools/processes.mjs read razbor "x`(y)"',
  'node tools/processes.mjs read razbor "skill (1).zip"; rm -rf output',
  'node tools/processes.mjs read razbor \\"(touch x)\\"',
];

test('сторож: скобки в кавычках у команды курса без окна, вне кавычек и с подменой кавычек не команда курса', () => {
  for (const ctx of [NIX, GITBASH, WIN]) {
    for (const cmd of NOT_COURSE) {
      assert.equal(classify(cmd, { ...ctx, mode: 'auto' })?.decision, 'ask', `${ctx.tool}: ${cmd}`);
      assert.equal(classify(cmd, { ...ctx, mode: 'bypassPermissions' })?.decision, 'deny', `${ctx.tool}: ${cmd}`);
    }
    for (const cmd of ['node tools/processes.mjs read razbor "skill (1).zip"', "node tools/processes.mjs read razbor 'skill (1).zip'"]) {
      assert.equal(classify(cmd, { ...ctx, mode: 'auto' }), null, `${ctx.tool}: ${cmd}`);
    }
  }
});

function check(table, ctx, want) {
  const wrong = [];
  for (const cmd of table) {
    const got = classify(cmd, ctx);
    const ok = want ? got?.decision === 'ask' && got.reason === REASON : got === null;
    if (!ok) wrong.push(`${JSON.stringify(cmd)}: получили ${got ? got.decision : 'null'}`);
  }
  assert.deepEqual(wrong, []);
}

test('сторож: обходы из ревью и другие написания processes и .claude спрашивают окно (bash)', () => {
  check(ASK_BASH, NIX, true);
  check(ASK_BASH, GITBASH, true);
});

test('сторож: PowerShell, параметры через двоеточие, `, склейка строк, 8.3, точка и пробел в конце', () => {
  check(ASK_POWERSHELL, WIN, true);
});

test('сторож: команды курса, чтение input/ и запись в tools/, templates/, input/ без решения', () => {
  check(NONE, NIX, false);
  check(NONE, GITBASH, false);
  check(NONE_POWERSHELL, WIN, false);
});

test('сторож: команда изнутри processes/ или .claude/ кабинета спрашивает; другие инструменты без решения', () => {
  assert.equal(classify('echo x > run.py', { ...NIX, cwds: ['/home/aigul/ai-cabinet/processes/x'] })?.decision, 'ask');
  assert.equal(classify('echo x > a.md', { ...NIX, cwds: ['/home/aigul/ai-cabinet/.claude/skills'] })?.decision, 'ask');
  assert.equal(classify('echo x > run.py', { ...NIX, cwds: ['/home/aigul/ai-cabinet/output'] }), null);
  // Настоящий путь папки (ссылка или другой корень, например CLAUDE_PROJECT_DIR) тоже сравнивается.
  const ctx = { ...NIX, roots: ['/home/aigul/ai-cabinet', '/mnt/real/ai-cabinet'], cwds: ['/tmp/link', '/mnt/real/ai-cabinet/processes/x'] };
  assert.equal(classify('echo x > run.py', ctx)?.decision, 'ask');
  assert.equal(classify('Set-Content run.py x', { ...WIN, cwds: ['C:\\Users\\Айгуль Н\\AI-CABINET\\Processes\\x'] })?.decision, 'ask');
  assert.equal(classify('cat processes/x/run.py', { ...NIX, tool: 'Read' }), null);
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'processes/x/run.py' }, cwd: NIX.cwds[0] }, NIX), null);
  assert.equal(decide({ tool_name: 'Grep', tool_input: { pattern: 'x', path: 'input' }, cwd: NIX.cwds[0] }, NIX), null);
});

// D70: таблица режим × действие. Ожидаемое решение: 'ask', 'deny' или null (сторож молчит).
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const CAB = '/home/aigul/ai-cabinet';
const CASES = [
  ['Bash: запись в processes', 'Bash', { command: "echo '# x' >> processes/svetofor-tochek/run.py" }],
  ['Bash: запись в .claude', 'Bash', { command: 'echo {} > .claude/settings.local.json' }],
  ['Monitor: запись в processes', 'Monitor', { command: 'echo x >> processes/x/run.py', description: 'x' }],
  ['Write processes/x/run.py', 'Write', { file_path: 'processes/x/run.py', content: 'x' }],
  ['Edit .claude/settings.json', 'Edit', { file_path: `${CAB}/.claude/settings.json`, old_string: 'a', new_string: 'b' }],
  ['Write input/x.csv', 'Write', { file_path: `${CAB}/input/x.csv`, content: 'x' }],
  ['Write tools/x.mjs', 'Write', { file_path: 'tools/x.mjs', content: 'x' }],
  ['Write output/x.csv', 'Write', { file_path: `${CAB}/output/x.csv`, content: 'x' }],
  ['команда вне курса: python output/fix.py', 'Bash', { command: 'python output/fix.py' }],
  ['команда вне курса: node output/w.js', 'Bash', { command: 'node output/w.js' }],
  ['команда вне курса: ls', 'Bash', { command: 'ls' }],
  ['Monitor вне курса: tail -f output/log.txt', 'Monitor', { command: 'tail -f output/log.txt', description: 'x' }],
  ['команда курса: processes.mjs run', 'Bash', { command: 'node tools/processes.mjs run svetofor-tochek' }],
  ['команда курса: read_table.py', 'Bash', { command: 'python tools/read_table.py "input/x/a.csv" --rows 3' }],
];
const A = { decision: 'ask', reason: REASON };
const AF = { decision: 'ask', reason: REASON_FILE };
const AO = { decision: 'ask', reason: REASON_OTHER };
const N = { decision: 'deny', reason: REASON_NO_PROMPT };
const D = { decision: 'deny', reason: REASON_DATA };
// Обычные режимы: окно спрашивают правила settings.json и Claude Code.
const ROW_RULES = [A, A, A, null, null, D, D, null, null, null, null, null, null, null];
// Auto: окно спрашивает сторож (защиту .claude/ и команды вне курса в Auto решает классификатор).
const ROW_AUTO = [A, A, A, AF, AF, D, D, null, AO, AO, AO, AO, null, null];
// Окна нет: запрет с подсказкой на всё, кроме команд курса и обычных файлов.
const ROW_CLOSED = [N, N, N, N, N, D, D, null, N, N, N, N, null, null];
const EXPECTED = {
  default: ROW_RULES,
  acceptEdits: ROW_RULES,
  plan: ROW_RULES,
  auto: ROW_AUTO,
  dontAsk: ROW_CLOSED,
  bypassPermissions: ROW_CLOSED,
};

function table(run) {
  const wrong = [];
  for (const mode of MODES) {
    CASES.forEach(([name, tool, ti], i) => {
      const got = run(mode, tool, ti);
      const want = EXPECTED[mode][i];
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${mode} / ${name}: ждали ${want?.decision ?? 'null'}, получили ${got?.decision ?? 'null'}`);
    });
  }
  return wrong;
}

test('режимы: таблица решений по режимам и действиям (D70)', () => {
  const wrong = table((mode, tool, ti) => decide({ tool_name: tool, tool_input: ti, cwd: CAB, permission_mode: mode }, { roots: [CAB], platform: 'linux' }));
  assert.deepEqual(wrong, []);
});

test('режимы: режим не передан или незнаком, значит спросить нельзя: processes/ и .claude/ закрыты', () => {
  for (const mode of [undefined, null, '', 'bubble', 'yolo', 'Default', 42]) {
    const got = CASES.map(([, tool, ti]) => decide({ tool_name: tool, tool_input: ti, cwd: CAB, permission_mode: mode }, { roots: [CAB], platform: 'linux' }));
    assert.deepEqual(got, ROW_CLOSED, String(mode));
  }
  // manual: другое имя обычного режима.
  const manual = CASES.map(([, tool, ti]) => decide({ tool_name: tool, tool_input: ti, cwd: CAB, permission_mode: 'manual' }, { roots: [CAB], platform: 'linux' }));
  assert.deepEqual(manual, ROW_RULES);
});

test('режимы: без окна любая команда вне курса запрещена (и обходы из ревью, и PowerShell, и Monitor), команды курса без решения', () => {
  for (const mode of ['bypassPermissions', 'dontAsk', undefined, 'bubble']) {
    const wrong = [];
    const tables = [[ASK_BASH, NIX], [ASK_BASH, GITBASH], [ASK_POWERSHELL, WIN], [OTHER, NIX], [OTHER, { ...NIX, tool: 'Monitor' }], [OTHER_POWERSHELL, WIN]];
    for (const [table, ctx] of tables) {
      for (const cmd of table) {
        const got = classify(cmd, { ...ctx, mode });
        if (got?.decision !== 'deny' || got.reason !== REASON_NO_PROMPT) wrong.push(`${mode}: ${JSON.stringify(cmd)}`);
      }
    }
    for (const [table, ctx] of [[COURSE_CMDS, NIX], [COURSE_CMDS, { ...NIX, tool: 'Monitor' }], [COURSE_POWERSHELL, WIN]]) {
      for (const cmd of table) if (classify(cmd, { ...ctx, mode }) !== null) wrong.push(`${mode} (ждали null): ${JSON.stringify(cmd)}`);
    }
    assert.deepEqual(wrong, []);
  }
});

test('режимы: в Auto любая команда вне курса спрашивает окно, команды курса без решения', () => {
  const wrong = [];
  for (const [table, ctx] of [[OTHER, NIX], [OTHER, { ...NIX, tool: 'Monitor' }], [OTHER_POWERSHELL, WIN]]) {
    for (const cmd of table) {
      const got = classify(cmd, { ...ctx, mode: 'auto' });
      if (got?.decision !== 'ask' || got.reason !== REASON_OTHER) wrong.push(JSON.stringify(cmd));
    }
  }
  for (const [table, ctx] of [[ASK_BASH, NIX], [ASK_POWERSHELL, WIN]]) {
    for (const cmd of table) {
      const got = classify(cmd, { ...ctx, mode: 'auto' });
      if (got?.decision !== 'ask' || got.reason !== REASON) wrong.push(`(processes/.claude) ${JSON.stringify(cmd)}`);
    }
  }
  for (const [table, ctx] of [[COURSE_CMDS, NIX], [COURSE_POWERSHELL, WIN]]) {
    for (const cmd of table) if (classify(cmd, { ...ctx, mode: 'auto' }) !== null) wrong.push(`(ждали null) ${JSON.stringify(cmd)}`);
  }
  assert.deepEqual(wrong, []);
});

const WROOT = 'C:\\Users\\Айгуль Н\\ai-cabinet';
const WCTX = { roots: [WROOT], cwds: [WROOT], platform: 'win32', home: 'C:\\Users\\Айгуль Н' };
const XCTX = { roots: [CAB], cwds: [CAB], platform: 'linux', home: '/home/aigul' };

test('файлы: любое написание пути в кабинет, как у команд (8.3, точка и пробел в конце, поток, регистр, ~, ..)', () => {
  const zones = [
    // Windows
    [`${WROOT}\\processes\\x\\run.py`, 'guarded'],
    [`${WROOT}\\PROCES~1\\x\\run.py`, 'guarded'],
    [`${WROOT}\\processes.\\x\\run.py`, 'guarded'],
    [`${WROOT}\\processes \\x\\run.py`, 'guarded'],
    [`${WROOT}\\processes::$INDEX_ALLOCATION\\x\\run.py`, 'guarded'],
    [`\\\\?\\${WROOT}\\processes\\x\\run.py`, 'guarded'],
    [`\\\\.\\${WROOT}\\input\\x.csv`, 'data'],
    [`//?/${WROOT}/tools/x.mjs`, 'data'],
    [`\\\\?\\${WROOT}\\output\\x.csv`, null],
    // Сетевые пути и устройства без буквы диска: в кабинете они или нет, точно не сказать.
    ['\\\\?\\UNC\\localhost\\C$\\Users\\Айгуль Н\\ai-cabinet\\processes\\x\\run.py', 'guarded'],
    ['\\\\localhost\\C$\\Users\\Айгуль Н\\ai-cabinet\\processes\\x\\run.py', 'guarded'],
    ['\\\\fileserver\\share\\x.csv', 'guarded'],
    ['\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\Users\\x.py', 'guarded'],
    ['\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\x.py', 'guarded'],
    ['\\\\.\\pipe\\x', 'guarded'],
    ['c:/users/айгуль н/AI-CABINET/Processes/x/run.py', 'guarded'],
    ['processes\\x\\run.py', 'guarded'],
    ['output\\..\\processes\\x\\run.py', 'guarded'],
    ['~\\ai-cabinet\\.claude\\settings.local.json', 'guarded'],
    [`${WROOT}\\CLAUDE~1\\skills\\moi\\SKILL.md`, 'guarded'],
    [`${WROOT}\\.claude\\hooks\\guard.mjs`, 'data'],
    [`${WROOT}\\.claude.\\hooks.\\guard.mjs`, 'data'],
    [`${WROOT}\\CLAUDE~1\\hooks\\guard.mjs`, 'data'],
    [`${WROOT}\\TEMPLA~1\\processes\\x\\run.py`, 'data'],
    [`${WROOT}\\Input\\x.csv`, 'data'],
    [`${WROOT}\\input.\\x.csv`, 'data'],
    ['tools\\serve.mjs', 'data'],
    [`${WROOT}\\output\\x.csv`, null],
    [`${WROOT}\\me\\rules.md`, null],
    ['C:\\Users\\Другой\\processes\\x.py', null],
  ];
  const wrong = zones.filter(([p, z]) => fileZone(p, WCTX) !== z).map(([p, z]) => `${p}: ждали ${z}, получили ${fileZone(p, WCTX)}`);
  const nix = [
    [`${CAB}/processes/x/run.py`, 'guarded'],
    ['./processes/x/run.py', 'guarded'],
    ['output/../processes/x/run.py', 'guarded'],
    ['~/ai-cabinet/.claude/skills/moi/SKILL.md', 'guarded'],
    [`${CAB}/.claude/hooks/guard.mjs`, 'data'],
    [`${CAB}/templates/processes/x/run.py`, 'data'],
    [`${CAB}/output/processes/x.csv`, null],
    ['/home/aigul/processes/x.py', null],
  ];
  for (const [p, z] of nix) if (fileZone(p, XCTX) !== z) wrong.push(`${p}: ждали ${z}, получили ${fileZone(p, XCTX)}`);
  // Относительный путь от папки команды внутри processes/.
  if (fileZone('run.py', { ...XCTX, cwds: [`${CAB}/processes/x`] }) !== 'guarded') wrong.push('run.py изнутри processes/x');
  // Настоящий путь: ссылка из output/ ведёт в processes/.
  const real = (p) => (p.startsWith(`${CAB}/output/link`) ? p.replace(`${CAB}/output/link`, `${CAB}/processes/x`) : null);
  if (fileZone(`${CAB}/output/link/run.py`, { ...XCTX, real }) !== 'guarded') wrong.push('ссылка output/link -> processes/x');
  assert.deepEqual(wrong, []);
});

test('файлы: в обычных режимах путь не буквально (8.3, точка, поток, регистр, ссылка, сетевой) спрашивает сам сторож', () => {
  const W = (p, mode = 'acceptEdits') => classifyFile(p, { ...WCTX, tool: 'Write', mode });
  const X = (p, ctx = {}) => classifyFile(p, { ...XCTX, tool: 'Edit', mode: 'default', ...ctx });
  const wrong = [];
  for (const p of [
    `${WROOT}\\PROCES~1\\x\\run.py`,
    `${WROOT}\\processes.\\x\\run.py`,
    `${WROOT}\\processes \\x\\run.py`,
    `${WROOT}\\processes::$INDEX_ALLOCATION\\x\\run.py`,
    `${WROOT}\\Processes\\x\\run.py`,
    `${WROOT}\\CLAUDE~1\\settings.local.json`,
    '\\\\localhost\\C$\\Users\\Айгуль Н\\ai-cabinet\\processes\\x\\run.py',
    '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\x.py',
  ]) {
    for (const mode of ['default', 'acceptEdits', 'plan']) {
      const got = W(p, mode);
      if (got?.decision !== 'ask' || got.reason !== REASON_FILE) wrong.push(`${mode} ${p}: ${got?.decision ?? 'null'}`);
    }
  }
  // Буквально: решают правило ask и защита Claude Code, сторож молчит.
  for (const p of [`${WROOT}\\processes\\x\\run.py`, 'processes\\x\\run.py', `\\\\?\\${WROOT}\\.claude\\settings.local.json`, `${WROOT}\\output\\x.csv`]) {
    if (W(p) !== null) wrong.push(`(ждали null) ${p}`);
  }
  if (X(`${CAB}/processes/x/run.py`) !== null) wrong.push('(ждали null) linux processes');
  if (X(`${CAB}/PROCESSES/x/run.py`)?.decision !== 'ask') wrong.push('linux PROCESSES');
  // Ссылка output/link -> processes/x: правило по пути ссылки не сработает, спрашивает сторож.
  const real = (p) => (p.startsWith(`${CAB}/output/link`) ? p.replace(`${CAB}/output/link`, `${CAB}/processes/x`) : p);
  if (X(`${CAB}/output/link/run.py`, { real })?.decision !== 'ask') wrong.push('ссылка output/link');
  if (X(`${CAB}/processes/x/run.py`, { real }) !== null) wrong.push('(ждали null) processes с настоящим путём');
  assert.deepEqual(wrong, []);
  assert.deepEqual(fileTarget(`${CAB}/processes/x/run.py`, XCTX), { zone: 'guarded', literal: true });
  assert.deepEqual(fileTarget(`${CAB}/output/x`, XCTX), { zone: null, literal: false });
});

test('файлы: Artifact сохраняет на диск только с out_dir; папка и путь опубликованного файла проверяются', () => {
  const ctx = { roots: [CAB], platform: 'linux' };
  const art = (ti, mode) => decide({ tool_name: 'Artifact', tool_input: ti, cwd: CAB, permission_mode: mode }, ctx);
  assert.equal(art({ action: 'read', url: 'https://claude.ai/artifact/x', path: 'run.py' }, 'bypassPermissions'), null);
  assert.equal(art({ action: 'publish', file_path: 'processes/x/run.py' }, 'bypassPermissions'), null);
  assert.equal(art({ action: 'read', path: 'a.csv', out_dir: `${CAB}/output/x` }, 'bypassPermissions'), null);
  assert.deepEqual(art({ action: 'read', path: 'run.py', out_dir: 'processes/x' }, 'acceptEdits'), AF);
  assert.deepEqual(art({ action: 'read', path: 'run.py', out_dir: 'processes/x' }, 'auto'), AF);
  assert.deepEqual(art({ action: 'read', path: 'run.py', out_dir: 'processes/x' }, 'bypassPermissions'), N);
  assert.deepEqual(art({ action: 'read', paths: ['a.css', 'processes/x/run.py'], out_dir: CAB }, 'default'), AF);
  assert.deepEqual(art({ action: 'read', path: 'x.csv', out_dir: `${CAB}/input` }, 'auto'), D);
  assert.deepEqual(art({ action: 'read', path: 'hooks/guard.mjs', out_dir: `${CAB}/.claude` }, 'default'), D);
});

test('файлы: Write, Edit, MultiEdit, NotebookEdit; путь из file_path или notebook_path; другие инструменты без решения', () => {
  const ctx = { roots: [CAB], platform: 'linux' };
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    assert.deepEqual(decide({ tool_name: tool, tool_input: { file_path: 'input/a.csv' }, cwd: CAB, permission_mode: 'acceptEdits' }, ctx), D, tool);
    assert.deepEqual(decide({ tool_name: tool, tool_input: { file_path: 'processes/x/run.py' }, cwd: CAB, permission_mode: 'bypassPermissions' }, ctx), N, tool);
  }
  assert.deepEqual(decide({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'processes/x/a.ipynb', new_source: 'x' }, cwd: CAB, permission_mode: 'auto' }, ctx), AF);
  assert.deepEqual(decide({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'templates/a.ipynb' }, cwd: CAB, permission_mode: 'default' }, ctx), D);
  assert.equal(decide({ tool_name: 'Write', tool_input: {}, cwd: CAB, permission_mode: 'bypassPermissions' }, ctx), null);
  assert.equal(classifyFile('processes/x/run.py', { ...ctx, tool: 'Read', mode: 'bypassPermissions' }), null);
});

test('looseForms: обратная косая черта и убрана, и как разделитель; кавычки и ` убраны', () => {
  const forms = looseForms('Echo "A" > proc\\esses\\X');
  assert.ok(forms.includes('echo a > processesx'));
  assert.ok(forms.includes('echo a > proc/esses/x'));
});

test('классификатор не падает на странных строках', () => {
  for (const cmd of ['', '   ', '"', "'", '>', '<<', '2>&1', '|||', 'echo "незакрытая', '$(', '`', '((', '[', '[[[', 'cd', "$'\\U110000'", '{'.repeat(50) + ','.repeat(50), '\\\\']) {
    assert.doesNotThrow(() => classify(cmd, NIX), cmd);
    assert.doesNotThrow(() => classify(cmd, WIN), cmd);
    assert.doesNotThrow(() => fileZone(cmd, XCTX), cmd);
    assert.doesNotThrow(() => fileZone(cmd, WCTX), cmd);
  }
  assert.equal(classify(undefined, NIX), null);
  assert.equal(fileZone(undefined, XCTX), null);
  for (const bad of [null, 1, 'x', [], { tool_input: null }, { tool_name: 'Write', tool_input: { file_path: 5 } }]) {
    assert.doesNotThrow(() => decide(bad, { roots: [CAB], platform: 'linux' }));
  }
});

test('тексты: по-русски, без тире и без слов, которых человеку не говорят', () => {
  assert.equal(REASON, 'Claude хочет выполнить команду, которая касается программ процессов или настроек кабинета. Разрешите, только если вы сами это просили.');
  assert.equal(REASON_FILE, 'Claude хочет изменить программу процесса или настройки кабинета. Разрешите, только если вы сами это просили.');
  assert.equal(REASON_NO_PROMPT, 'В этом режиме Claude не может спросить вас, поэтому изменения программ процессов и настроек кабинета закрыты. Переключите режим на обычный (Shift+Tab) и повторите.');
  assert.equal(REASON_DATA, 'Это файлы курса или ваши исходные данные, Claude их не меняет.');
  assert.equal(REASON_OTHER, 'Claude хочет выполнить команду, которая не входит в курс. Разрешите, только если вы сами это просили.');
  for (const r of [REASON, REASON_FILE, REASON_NO_PROMPT, REASON_DATA, REASON_OTHER]) assert.doesNotMatch(r, /[\u2012-\u2015]|скрипт|порт|сервер|терминал|консол|в фоне/i);
});

test('hookOutput: формат PreToolUse, не-ASCII экранирован, без решения пусто', () => {
  assert.equal(hookOutput(null), '');
  for (const r of [{ decision: 'ask', reason: REASON }, { decision: 'deny', reason: REASON_NO_PROMPT }]) {
    const out = hookOutput(r);
    assert.match(out, /^[\x20-\x7e]+$/);
    assert.deepEqual(JSON.parse(out), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.decision, permissionDecisionReason: r.reason },
    });
  }
});

function runHook(input, env = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const outOf = (r) => (r.stdout === '' ? null : JSON.parse(r.stdout).hookSpecificOutput);

test('хук как процесс: JSON из stdin, решение в stdout, код 0', () => {
  const ask = runHook({ tool_name: 'Bash', cwd: ROOT, permission_mode: 'acceptEdits', tool_input: { command: "echo '# e1' >> proc\\esses/x/run.py" } });
  assert.equal(ask.status, 0, ask.stderr);
  assert.deepEqual(outOf(ask), { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: REASON });
  const ps = runHook({ tool_name: 'PowerShell', cwd: ROOT, permission_mode: 'default', tool_input: { command: 'Set-Content -Path:processes\\x\\run.py -Value:x' } });
  assert.equal(outOf(ps).permissionDecision, 'ask');
  for (const command of ['node tools/processes.mjs run x', 'echo x > tools/serve.mjs', "awk '{print $1}' input/a.csv"]) {
    const r = runHook({ tool_name: 'Bash', cwd: ROOT, permission_mode: 'acceptEdits', tool_input: { command } });
    assert.equal(r.status, 0, command);
    assert.equal(r.stdout, '', command);
  }
  // В обходе разрешений команда курса без решения, любая другая запрещена; Monitor так же, как Bash.
  assert.equal(runHook({ tool_name: 'Bash', cwd: ROOT, permission_mode: 'bypassPermissions', tool_input: { command: 'node tools/processes.mjs run x' } }).stdout, '');
  for (const tool_name of ['Bash', 'PowerShell', 'Monitor']) {
    const r = runHook({ tool_name, cwd: ROOT, permission_mode: 'bypassPermissions', tool_input: { command: 'python output/fix.py', description: 'x' } });
    assert.deepEqual(outOf(r), { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON_NO_PROMPT }, tool_name);
  }
  assert.equal(outOf(runHook({ tool_name: 'Monitor', cwd: ROOT, permission_mode: 'auto', tool_input: { command: 'tail -f output/log.txt' } })).permissionDecisionReason, REASON_OTHER);
  // Без режима во входе: спросить нельзя.
  assert.deepEqual(outOf(runHook({ tool_name: 'Bash', cwd: ROOT, tool_input: { command: 'echo x > processes/x/run.py' } })), {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: REASON_NO_PROMPT,
  });
  assert.equal(runHook({ tool_name: 'Read', cwd: ROOT, permission_mode: 'bypassPermissions', tool_input: { file_path: 'processes/x/run.py' } }).stdout, '');
  for (const bad of ['', 'не JSON', '{}', '{"tool_input":{}}', 'null', '42']) {
    const r = runHook(bad);
    assert.equal(r.status, 0, bad);
    assert.equal(r.stdout, '', bad);
  }
});

test('хук как процесс: таблица режим × действие в настоящем кабинете (D70)', () => {
  // Пути из таблицы переносятся в настоящий кабинет: корень хук берёт из своего места.
  const abs = (ti) =>
    typeof ti.file_path === 'string' && ti.file_path.startsWith(CAB) ? { ...ti, file_path: join(ROOT, ti.file_path.slice(CAB.length + 1)) } : ti;
  const wrong = table((mode, tool, ti) => {
    const r = runHook({ tool_name: tool, cwd: ROOT, permission_mode: mode, tool_input: abs(ti) });
    assert.equal(r.status, 0, r.stderr);
    const out = outOf(r);
    return out && { decision: out.permissionDecision, reason: out.permissionDecisionReason };
  });
  assert.deepEqual(wrong, []);
});

test('хук как процесс: корень из CLAUDE_PROJECT_DIR и настоящий путь папки команды и файла', (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-')));
  try {
    const cab = join(base, 'Айгуль Н', 'ai-cabinet');
    mkdirSync(join(cab, 'processes', 'x'), { recursive: true });
    mkdirSync(join(cab, 'output'), { recursive: true });
    const env = { CLAUDE_PROJECT_DIR: cab };
    const inside = runHook({ tool_name: 'Bash', cwd: join(cab, 'processes', 'x'), permission_mode: 'acceptEdits', tool_input: { command: 'echo x > run.py' } }, env);
    assert.equal(outOf(inside).permissionDecision, 'ask');
    const outside = runHook({ tool_name: 'Bash', cwd: join(cab), permission_mode: 'acceptEdits', tool_input: { command: 'echo x > run.py' } }, env);
    assert.equal(outside.stdout, '');
    const file = runHook({ tool_name: 'Write', cwd: cab, permission_mode: 'bypassPermissions', tool_input: { file_path: join(cab, 'processes', 'x', 'run.py') } }, env);
    assert.equal(outOf(file).permissionDecision, 'deny');
    const rel = runHook({ tool_name: 'Edit', cwd: join(cab, 'processes', 'x'), permission_mode: 'dontAsk', tool_input: { file_path: 'run.py' } }, env);
    assert.equal(outOf(rel).permissionDecision, 'deny');
    const link = join(base, 'ssylka');
    const fileLink = join(cab, 'output', 'link');
    try {
      symlinkSync(join(cab, 'processes', 'x'), link, 'junction');
      symlinkSync(join(cab, 'processes', 'x'), fileLink, 'junction');
    } catch (e) {
      return t.skip(`ссылки на папки недоступны (${e.code})`);
    }
    const viaLink = runHook({ tool_name: 'Bash', cwd: link, permission_mode: 'acceptEdits', tool_input: { command: 'echo x > run.py' } }, env);
    assert.equal(outOf(viaLink).permissionDecision, 'ask');
    // Файл через ссылку output/link -> processes/x: настоящий путь в processes/.
    writeFileSync(join(cab, 'processes', 'x', 'run.py'), 'x');
    for (const name of ['run.py', 'new.py']) {
      const viaFileLink = runHook({ tool_name: 'Write', cwd: cab, permission_mode: 'bypassPermissions', tool_input: { file_path: join(fileLink, name) } }, env);
      assert.equal(outOf(viaFileLink)?.permissionDecision, 'deny', name);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('settings.json: сторож без оболочки (exec) на Bash, PowerShell, Monitor, записи файлов и Artifact, правка хука под запретом, py для таблиц', () => {
  const s = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const pre = s.hooks?.PreToolUse ?? [];
  const has = (m, tool) => new RegExp(`(^|\\|)${tool}(\\||$)`).test(m);
  const tools = ['Bash', 'PowerShell', 'Monitor', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Artifact'];
  const entry = pre.find((h) => tools.every((tool) => has(h.matcher, tool)));
  assert.ok(entry, `нет PreToolUse с matcher ${tools.join('|')}`);
  const hook = entry.hooks.find((h) => h.type === 'command');
  assert.equal(hook.command, 'node');
  assert.deepEqual(hook.args, ['${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.mjs']);
  assert.ok(s.permissions.deny.includes('Edit(./.claude/hooks/**)'), 'нужен запрет Edit(./.claude/hooks/**)');
  for (const d of ['Edit(./input/**)', 'Edit(./tools/**)', 'Edit(./templates/**)', 'Edit(./journal/**)']) assert.ok(s.permissions.deny.includes(d), d);
  assert.ok((s.permissions.ask ?? []).includes('Edit(./processes/**)'), 'нужен вопрос Edit(./processes/**)');
  assert.ok(s.permissions.allow.includes('Bash(py tools/read_table.py*)'), 'нужно разрешение Bash(py tools/read_table.py*)');
  assert.ok(s.permissions.allow.includes('Bash(python3 tools/read_table.py*)'), 'нужно разрешение Bash(python3 tools/read_table.py*)');
  assert.equal(s.env?.AI_CABINET, '1', 'нужна метка env.AI_CABINET: по ней проверка сетапа видит разговор в папке кабинета');
});

// Встроенные команды в скиллах: !`команда` и блок ```! выполняются при запуске скилла без вопроса.
test('скиллы: встроенная команда в новом тексте, таблица текстов x режимы', () => {
  const ctx = { roots: [CAB], platform: 'linux' };
  const SK = '.claude/skills/moi/SKILL.md';
  const texts = [
    ['чистый текст', 'Сделай сводку по `input/a.csv`. Важно! Не меняй файл.', false],
    ['inline-код без !', 'Запусти `node tools/check.mjs` и перескажи', false],
    ['! в прозе', 'Важно! Это нужно сделать до пятницы!', false],
    ['команда !`...`', 'Текущая дата: !`date`', true],
    ['блок ```!', 'Шаги:\n```!\nls -la\n```\n', true],
    ['! с пробелом перед кодом', 'Готово! `output/a.xlsx` сохранён', false],
    ['команда в примере внутри блока кода', '```md\nДата: !`date`\n```\n', true],
  ];
  const modes = ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk', undefined];
  const run = (tool, ti, mode) => decide({ tool_name: tool, tool_input: ti, cwd: CAB, permission_mode: mode }, ctx);
  for (const [name, text, flagged] of texts) {
    for (const mode of modes) {
      const label = `${name} / ${mode}`;
      for (const [tool, ti] of [
        ['Write', { file_path: SK, content: text }],
        ['Edit', { file_path: SK, old_string: 'x', new_string: text }],
        ['MultiEdit', { file_path: SK, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: text }] }],
        ['Write', { file_path: `${CAB}/.claude/skills/moi/extra.md`, content: text }],
      ]) {
        // Edit по файлу, которого нет, с кавычкой во фрагменте спрашивает (тест ниже): здесь только Write.
        if (!flagged && text.includes('`') && tool !== 'Write') continue;
        const got = run(tool, ti, mode);
        if (!flagged) {
          assert.notEqual(got?.reason, REASON_SKILL_CMD, label);
          assert.notEqual(got?.reason, REASON_SKILL_CMD_NO_PROMPT, label);
        } else if (['default', 'manual', 'acceptEdits', 'plan', 'auto'].includes(mode)) {
          assert.deepEqual(got, { decision: 'ask', reason: REASON_SKILL_CMD }, label);
        } else {
          assert.deepEqual(got, { decision: 'deny', reason: REASON_SKILL_CMD_NO_PROMPT }, label);
        }
      }
    }
  }
  assert.match(REASON_SKILL_CMD, /^В этом скилле есть команда, которая выполнится сама при запуске скилла, без вопроса\./);
  assert.match(REASON_SKILL_CMD_NO_PROMPT, /Shift\+Tab/);
});

test('скиллы: команда вне .claude/skills не трогается, NotebookEdit и запрет данных сохраняются', () => {
  const ctx = { roots: [CAB], platform: 'linux' };
  const run = (tool, ti, mode) => decide({ tool_name: tool, tool_input: ti, cwd: CAB, permission_mode: mode }, ctx);
  assert.equal(run('Write', { file_path: 'output/n.md', content: 'x !`date`' }, 'acceptEdits'), null);
  assert.equal(run('Write', { file_path: 'me/n.md', content: '```!\nls\n```' }, 'default'), null);
  assert.equal(run('Write', { file_path: '.claude/skills/moi/SKILL.md', content: 'обычный текст' }, 'acceptEdits'), null);
  assert.equal(run('NotebookEdit', { notebook_path: '.claude/skills/moi/a.ipynb', new_source: '!`date`' }, 'acceptEdits')?.reason, REASON_SKILL_CMD);
  assert.deepEqual(run('Write', { file_path: 'tools/a.md', content: '!`date`' }, 'acceptEdits'), { decision: 'deny', reason: REASON_DATA });
  // Относительный путь от папки скилла
  const inSk = decide({ tool_name: 'Write', tool_input: { file_path: 'SKILL.md', content: '!`date`' }, cwd: `${CAB}/.claude/skills/moi`, permission_mode: 'acceptEdits' }, { roots: [CAB], platform: 'linux' });
  assert.equal(inSk?.reason, REASON_SKILL_CMD);
});

test('setup-check: правило про чужие скиллы и настройка VS Code', () => {
  const t = readFileSync(join(ROOT, '.claude', 'skills', 'setup-check', 'SKILL.md'), 'utf8');
  assert.ok(t.includes('Чужие скиллы не ставим. Добавляйте только свои скиллы и те, что даёт курс. Скилл из интернета или от знакомых может содержать команды, которые выполнятся на вашем компьютере без вашего ведома'));
  assert.ok(t.includes('claudeCode.initialPermissionMode') && t.includes('acceptEdits'));
  assert.ok(!/[\u2012-\u2015]/.test(t));
});

test('скиллы: команду нельзя собрать из двух правок и в .claude/commands', () => {
  const base = mkdtempSync(join(tmpdir(), 'guard-skill-'));
  try {
    const cab = realpathSync(base);
    mkdirSync(join(cab, '.claude', 'skills', 'moi'), { recursive: true });
    mkdirSync(join(cab, '.claude', 'commands'), { recursive: true });
    const sk = join(cab, '.claude', 'skills', 'moi', 'SKILL.md');
    const ctx = { roots: [cab], platform: process.platform };
    const run = (tool, ti, mode) => decide({ tool_name: tool, tool_input: ti, cwd: cab, permission_mode: mode }, ctx);
    const PROMPT = ['default', 'manual', 'acceptEdits', 'plan', 'auto'];
    const NOPROMPT = ['bypassPermissions', 'dontAsk', undefined];
    const expectAll = (tool, ti) => {
      for (const m of PROMPT) assert.deepEqual(run(tool, ti, m), { decision: 'ask', reason: REASON_SKILL_CMD }, `${tool} ${m}`);
      for (const m of NOPROMPT) assert.deepEqual(run(tool, ti, m), { decision: 'deny', reason: REASON_SKILL_CMD_NO_PROMPT }, `${tool} ${m}`);
    };
    // Write «Дата: !», потом Edit добавляет `date`
    writeFileSync(sk, 'Дата: !\n');
    expectAll('Edit', { file_path: sk, old_string: 'Дата: !', new_string: 'Дата: !`date`' });
    expectAll('Edit', { file_path: sk, old_string: '!', new_string: '!`date`' });
    // Правка вставляет только `date`, а ! уже в файле
    expectAll('Edit', { file_path: sk, old_string: 'Дата: !\n', new_string: 'Дата: !`date`\n' });
    // MultiEdit: две правки по отдельности безобидны
    writeFileSync(sk, 'АБ\n');
    expectAll('MultiEdit', { file_path: sk, edits: [{ old_string: 'А', new_string: 'Дата: !' }, { old_string: 'Б', new_string: '`date`' }] });
    // replace_all
    writeFileSync(sk, 'x ! y\n');
    expectAll('Edit', { file_path: sk, old_string: ' y', new_string: '`date`', replace_all: true });
    // безобидная правка безобидного файла
    writeFileSync(sk, 'Привет\n');
    for (const m of [...PROMPT, ...NOPROMPT]) assert.notEqual(run('Edit', { file_path: sk, old_string: 'Привет', new_string: 'Готово! `a.xlsx`' }, m)?.reason, REASON_SKILL_CMD, m);
    // файл не прочитать или old_string не найден: во фрагменте есть кавычка, значит спрашиваем
    expectAll('Edit', { file_path: join(cab, '.claude', 'skills', 'new', 'SKILL.md'), old_string: 'a', new_string: '`date`' });
    expectAll('Edit', { file_path: sk, old_string: 'нет такого', new_string: '`date`' });
    assert.notEqual(run('Edit', { file_path: sk, old_string: 'нет такого', new_string: 'просто текст' }, 'acceptEdits')?.reason, REASON_SKILL_CMD);
    // .claude/commands
    const cmd = join(cab, '.claude', 'commands', 'x.md');
    expectAll('Write', { file_path: cmd, content: 'Дата: !`date`' });
    writeFileSync(cmd, 'Дата: !\n');
    expectAll('Edit', { file_path: cmd, old_string: '!', new_string: '!`date`' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
