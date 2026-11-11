import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST } from '../init.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Файлы шаблона: отслеживаемые + новые, не игнорируемые git.
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)
  .filter((f) => existsSync(join(ROOT, f)));

const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const PARTICIPANT = (f) =>
  f === 'CLAUDE.md' ||
  f === 'START.md' ||
  f === 'start-cabinet.cmd' ||
  f === 'start-cabinet.command' ||
  ['.claude/skills/', '.claude/hooks/', 'templates/', 'me/', 'site/'].some((p) => f.startsWith(p));

// Учебный кейс: тексты курса, стилевые правила участника на него не распространяются.
const CASE_DIR = 'input/case/';
const isCase = (f) => f.startsWith(CASE_DIR);
const TEXT_EXT = /\.(md|csv|txt|json|html)$/i;
// Пользовательские скиллы курса: ставятся в папку скиллов Claude и работают в любой папке.
const USER_SKILLS = 'templates/user-skills/';

test('имена файлов только латиница без пробелов', () => {
  const bad = files.filter((f) => f.split('/').some((s) => !/^[A-Za-z0-9._-]+$/.test(s)) && !isCase(f));
  assert.deepEqual(bad, []);
});

test('имена файлов кейса только ASCII (скопированные выгрузки могут быть с пробелом и скобками)', () => {
  const bad = files.filter((f) => isCase(f) && f.split('/').some((s) => !/^[A-Za-z0-9._ ()-]+$/.test(s)));
  assert.deepEqual(bad, []);
});

test('кейс входит в репо и не игнорируется: input/case/README.md отслеживается', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  assert.ok(tracked.includes('input/case/README.md'), 'README кейса не отслеживается');
  assert.ok(tracked.some((f) => f.startsWith('input/case/data/')), 'нет data кейса');
  assert.ok(!tracked.some((f) => /(^|\/)(trainer|_gen)(\/|$)|trainer-key/.test(f)), 'в репо попали trainer/_gen');
  const ignored = (p) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT }).status === 0;
  assert.equal(ignored('input/case/README.md'), false);
  assert.equal(ignored('input/moi-fayl.xlsx'), true);
});

// Имя клиента не должно попасть в публичный репозиторий, поэтому в тесте только хеши.
const CLIENT_HASHES = new Set([
  '06c8c47bab0d6cb6ca934521184e8539c444c61b6809bcfc8122dad1b53f07e1',
  'fbc8cf19f43c292eed00091f58167c043cce31212e9d23caa807bc787f640360',
  '6250aecf3fa543ecd9dfb5655a9be835b6a616aa9e79f9fc7c315c09974f0018',
]);
const HASH_LENGTHS = [5, 6, 11];
const sha = (x) => createHash('sha256').update(x).digest('hex');

function hasClientName(text) {
  for (const token of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    for (const n of HASH_LENGTHS) {
      for (let i = 0; i + n <= token.length; i++) {
        if (CLIENT_HASHES.has(sha(token.slice(i, i + n)))) return true;
      }
    }
  }
  return false;
}

test('нет имени клиента (по хешам)', () => {
  assert.equal(hasClientName('Hello world'), false);
  // Бренд курса (логотип, цвета, название компании) встроен в репозиторий: только templates/brand/.
  const bad = files.filter((f) => !f.startsWith('templates/brand/') && (hasClientName(f) || ((!isCase(f) || TEXT_EXT.test(f)) && hasClientName(read(f)))));
  assert.deepEqual(bad, []);
});

// python3 только в строке про Mac: на Windows python3 открывает заглушку Microsoft Store. Исключение: правило
// allow в настройках шаблона проекта сервиса ("Bash(python3 main.py*)"), это не текст для человека и Claude.
test('тексты участника без тире (U+2012-U+2015) и python3 вне Mac', (t) => {
  // tools/design.md тоже: его формулировки Claude передаёт человеку.
  const mine = files.filter((f) => PARTICIPANT(f) || f === 'tools/design.md');
  if (mine.length === 0) return t.skip('нет файлов участника');
  const py3 = (l) => l.includes('python3') && !l.includes('Mac') && !/^\s*"Bash\(python3 [^"]*\)",?\s*$/.test(l);
  const bad = mine.filter((f) => /[\u2012-\u2015]/.test(read(f)) || read(f).split('\n').some(py3));
  assert.deepEqual(bad, []);
});

// Неразрывный пробел из образца в скилле Claude переписывает в программу обычным: разбор чисел ломается.
test('скиллы без неразрывных и невидимых пробелов', () => {
  const bad = files.filter((f) => (f.startsWith('.claude/skills/') || f.startsWith(USER_SKILLS)) && /[\u00a0\u2007\u202f\u200b]/.test(read(f)));
  assert.deepEqual(bad, []);
});

test('скиллы: name совпадает с папкой, description есть', (t) => {
  const skills = files.filter((f) => /^(\.claude\/skills|templates\/user-skills)\/[^/]+\/SKILL\.md$/.test(f));
  if (skills.length === 0) return t.skip('нет скиллов');
  for (const f of skills) {
    const dir = f.split('/').at(-2);
    const m = read(f).replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
    assert.ok(m, `${f}: нет frontmatter`);
    const name = m[1].match(/^name:\s*(.+)$/m);
    const desc = m[1].match(/^description:\s*(.+)$/m);
    assert.ok(name, `${f}: нет name`);
    assert.equal(name[1].trim().replace(/^["']|["']$/g, ''), dir, `${f}: name не совпадает с папкой`);
    assert.ok(desc && desc[1].trim().length > 0, `${f}: нет description`);
  }
});

test('settings: sonnet, без обхода, PYTHONUTF8, input защищён, без автопамяти', () => {
  const p = '.claude/settings.json';
  assert.ok(files.includes(p), 'нет .claude/settings.json');
  const s = JSON.parse(read(p));
  assert.equal(s.model, 'sonnet');
  assert.notEqual(s.permissions.defaultMode, 'bypassPermissions');
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(s.env.PYTHONUTF8, '1');
  assert.ok(s.permissions.deny.includes('Edit(./input/**)'));
  // Инструменты курса запускаются без вопроса, поэтому править их Claude не может.
  assert.ok(s.permissions.deny.includes('Edit(./tools/**)'), 'нужен запрет Edit(./tools/**)');
  // «Запомни» пишется только в мои правила: автопамять проекта не читается и не пишется.
  assert.equal(s.autoMemoryEnabled, false, 'нужен "autoMemoryEnabled": false');
  // Процесс запускается фразой без вопроса, как кнопкой. Поэтому программу процесса Claude пишет только
  // через окно разрешения: правка processes/ всегда спрашивает человека.
  assert.ok(s.permissions.allow.includes('Bash(node tools/processes.mjs*)'), 'нужно разрешение Bash(node tools/processes.mjs*)');
  assert.ok((s.permissions.ask ?? []).includes('Edit(./processes/**)'), 'нужен вопрос Edit(./processes/**)');
  // Демо копирует templates/processes в processes/ и запускается той же разрешённой командой: шаблоны не правятся.
  assert.ok(s.permissions.deny.includes('Edit(./templates/**)'), 'нужен запрет Edit(./templates/**)');
});

test('lint: каждый @import из CLAUDE.md есть в репо или в MANIFEST.to', (t) => {
  if (!files.includes('CLAUDE.md')) return t.skip('нет CLAUDE.md');
  const text = read('CLAUDE.md')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
  const paths = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) =>
    m[1].replace(/[.,;:!?)]+$/, ''),
  );
  assert.ok(paths.length > 0, 'в CLAUDE.md нет @import');
  const created = MANIFEST.map((m) => m.to);
  const missing = paths.filter((p) => !files.includes(p) && !created.includes(p));
  assert.deepEqual(missing, []);
});

// Хук проверки команд: файл курса в репо (обновление его привезёт), имя ASCII, правка под запретом.
test('хук .claude/hooks/guard.mjs отслеживается, имя ASCII, зарегистрирован в settings.json', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const hooks = tracked.filter((f) => f.startsWith('.claude/hooks/'));
  assert.deepEqual(hooks, ['.claude/hooks/guard.mjs']);
  assert.ok(hooks.every((f) => /^[A-Za-z0-9._/-]+$/.test(f)));
  const ignored = (p) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT }).status === 0;
  assert.equal(ignored('.claude/hooks/guard.mjs'), false);
  const s = JSON.parse(read('.claude/settings.json'));
  const cmds = (s.hooks?.PreToolUse ?? []).flatMap((h) => h.hooks.map((x) => [x.command, ...(x.args ?? [])].join(' ')));
  assert.ok(cmds.some((c) => c.includes('.claude/hooks/guard.mjs')), 'хук не зарегистрирован');
  assert.ok(s.permissions.deny.includes('Edit(./.claude/hooks/**)'), 'нужен запрет Edit(./.claude/hooks/**)');
});

test('файлы участника вне репо: обновление их не перезапишет', () => {
  const tracked = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const own = tracked.filter(
    (f) => ['me/', 'site/', 'input/', 'output/'].some((p) => f.startsWith(p)) && !f.endsWith('/.gitkeep') && !isCase(f),
  );
  assert.deepEqual(own, []);
  const ignored = (p) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT }).status === 0;
  for (const { from, to } of MANIFEST) {
    assert.ok(files.includes(from), `${from}: шаблона нет в репо`);
    assert.equal(ignored(from), false, `${from}: шаблон попал под .gitignore`);
    assert.equal(ignored(to), true, `${to} не в .gitignore`);
  }
  assert.equal(ignored('.claude/settings.local.json'), true, '.claude/settings.local.json не в .gitignore');
  // Процессы участника его, шаблоны процессов курса в репо.
  assert.equal(ignored('processes/svodka-prodazh/run.py'), true, 'processes/ не в .gitignore');
  assert.equal(ignored('templates/processes/svetofor-tochek/run.py'), false, 'шаблоны процессов попали под .gitignore');
});

test('шаблоны me/ начинаются со строки-заглушки, которую узнают правила кабинета', () => {
  const MARK = 'Файл пока не заполнен.';
  for (const f of ['templates/about-me.md', 'templates/rules.md']) {
    const lines = read(f).replace(/\r\n/g, '\n').split('\n');
    assert.equal(lines[0].startsWith('# '), true, `${f}: первая строка не заголовок`);
    assert.ok(lines[2].startsWith(MARK), `${f}: третья строка не начинается с заглушки`);
    assert.equal(lines.filter((l) => l.includes(MARK)).length, 1, `${f}: заглушка не одной строкой`);
  }
  assert.ok(read('CLAUDE.md').includes(`«${MARK}»`));
  assert.ok(read('.claude/skills/about-me/SKILL.md').includes(`«${MARK}»`));
});

test('в tools нет системного копирования папок (падает на кириллице в Node 22 на Windows)', () => {
  const word = ['cp', 'Sync'].join('');
  const bad = files.filter((f) => f.startsWith('tools/') && read(f).includes(word));
  assert.deepEqual(bad, []);
});

// Скиллы курса загружаются как скиллы: встроенная команда в их тексте выполнилась бы сама при запуске.
// Шаблон тот же, что у сторожа кабинета: восклицательный знак и команда в обратных кавычках или блок ```!.
test('скиллы курса без встроенных команд', () => {
  const pattern = new RegExp(['!', '[ \\t]*`[^`\\n]+`|', '`'.repeat(3), '[ \\t]*!'].join(''));
  const bad = files.filter((f) => (f.startsWith('.claude/skills/') || f.startsWith(USER_SKILLS)) && pattern.test(read(f)));
  assert.deepEqual(bad, []);
});

// Фразы, которые Claude говорит человеку (в кавычках «...»), без технических слов. Перечень самих слов
// («скрипт», «порт») в правилах для Claude не фраза человеку и не считается.
function quotes(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '«') {
      if (depth > 0) cur += ch;
      depth++;
    } else if (ch === '»' && depth > 0) {
      depth--;
      if (depth === 0) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    } else if (depth > 0) cur += ch;
  }
  return out;
}

test('скиллы процессов: фразы человеку без слов скрипт, порт, сервер, терминал, консоль, в фоне', () => {
  const words = /(^|[^а-яё])(скрипт|порт|сервер|терминал|консол|в фоне)/i;
  for (const f of ['.claude/skills/add-process/SKILL.md', '.claude/skills/run-process/SKILL.md', '.claude/skills/demo-process/SKILL.md',
    `${USER_SKILLS}kabinet-novyi-servis/SKILL.md`, `${USER_SKILLS}kabinet-dobav-v-kabinet/SKILL.md`, 'templates/service-project/CLAUDE.md', 'templates/service-project/README.md']) {
    const bad = quotes(read(f)).filter((q) => words.test(q) && !/^(скрипт|код|сервер|порт|терминал|консоль|в фоне)$/.test(q.trim()));
    assert.deepEqual(bad, [], f);
  }
});

const rules0 = () => read('CLAUDE.md');

test('добавить процесс: всегда программа (kind script), процесс без программы не создаётся; справка с образцами на месте', () => {
  const skill = read('.claude/skills/add-process/SKILL.md');
  assert.match(skill, /"kind": "script"/);
  assert.doesNotMatch(skill, /"kind": "claude"|kind: claude/);
  for (const must of ['etalon-skilla.json', 'sverka-so-skillom.md', 'razobrat-vruchnuyu.xlsx', 'slovar.json', 'shablon.docx',
    'node tools/processes.mjs compare', 'node tools/processes.mjs read', 'programma.md']) {
    assert.ok(skill.includes(must), `в скилле нет ${must}`);
  }
  assert.ok(files.includes('.claude/skills/add-process/programma.md'));
  const run = read('.claude/skills/run-process/SKILL.md');
  assert.match(run, /## Доработать процесс/);
  assert.match(run, /## Добавить слово в словарь/);
  assert.match(run, /## Пополнить словарь/);
  // Правка процесса: остановка видимым текстом перед записью, как в add-process.
  assert.ok(run.includes('«Так? Поправляю?»') && run.includes('«Так? Добавляю?»'));
  assert.ok(skill.includes('«Так? Записываю программу?»'));
  // Срочность: раздел словаря «срочно (не тема)» один и тот же в справке, остановке, run-process и сверке.
  const guide = read('.claude/skills/add-process/programma.md');
  assert.ok(guide.includes('URGENT = "срочно (не тема)"') && guide.includes('"срочно (не тема)": ['));
  assert.ok(skill.includes('| срочно (не тема) | <слова срочности через запятую> |'));
  // Эталон без строк (Claude строки файла человека не читает), основа без скилла, интернет в программе.
  assert.ok(!skill.includes('"срочно": ['), 'в примере эталона не должно быть строк: темы строк Claude не определяет');
  assert.ok(skill.includes('Файлы человека в модель для анализа не идут') && rules0().includes('Файлы человека в модель для анализа не идут'));
  assert.ok(skill.includes('«Из чего собираем процесс?»') && skill.includes('«Опишу своими словами»') && skill.includes('### Известный ответ'));
  assert.ok(guide.includes('## Данные из интернета') && guide.includes('# --- Данные из интернета ---'));
  // Модель внутри сервиса можно, только через tools/llm.py с проверкой данных.
  assert.ok(guide.includes('## Модель внутри программы') && guide.includes('llm.LLMBlocked'));
  assert.ok(rules0().includes('tools/llm.py'));
  assert.ok(run.includes('→ срочно') && run.includes('«срочно (не тема)»'));
  assert.ok(read('tools/processes.mjs').includes('Добавьте в раздел «срочно (не тема)»'));
  // Слабые слова «?»: правило с примерами в справке и в шаге 4, проверка строк «проверьте» при пополнении.
  for (const text of [guide, skill]) assert.ok(text.includes('«не работает», «ждать», «не принимают»') && text.includes('"касса?"'));
  assert.ok(guide.includes('WEAK = "?"') && run.includes('слабое слово сильным не делай'));
  // Пополнение показывает разложенные строки и спрашивает дословно (тот же вопрос в текстах курса).
  assert.ok(run.includes('«Верно? Напишите номера строк, где тема не та, или «всё верно».»'));
  assert.ok(guide.includes('Не подбирай слово под одну строку') && run.includes('Не подбирай слово под одну строку'));
  // Правка программы или словаря после сверки: строка про окно перед каждой правкой.
  assert.ok(skill.includes('Без этой строки `run.py` и `slovar.json` не правь.'));
  const rules = read('CLAUDE.md');
  assert.match(rules, /\| «доработай» и название процесса/);
  assert.match(rules, /\| «добавь в словарь процесса <название>: <слово> → <тема>»/);
  assert.match(rules, /\| «пополни словарь процесса <название>»/);
});

test('запуск двойным щелчком: start-cabinet.cmd и .command', () => {
  const cmd = readFileSync(join(ROOT, 'start-cabinet.cmd'));
  const t = cmd.toString('utf8');
  assert.ok(t.includes('pushd "%~dp0"'));
  assert.ok(t.includes('node tools\\serve.mjs --open'));
  assert.ok(t.includes('chcp 65001 >nul'));
  // node.cmd в папке кабинета не запустится вместо настоящего node: cmd.exe не ищет программы в текущей папке.
  const lines = t.split('\r\n');
  const noCwd = lines.indexOf('set "NoDefaultCurrentDirectoryInExePath=1"');
  assert.ok(noCwd > lines.indexOf('chcp 65001 >nul') && noCwd < lines.findIndex((l) => l.startsWith('where node')), 'NoDefaultCurrentDirectoryInExePath после chcp и до where node');
  assert.ok(t.includes('Окно не закрывайте, пока работаете со страницей. Закрыли окно: страница остановится.'));
  assert.notEqual(cmd[0], 0xef, 'без BOM');
  assert.equal(t.replace(/\r\n/g, '').match(/[\r\n]/g), null, 'все переводы строк CRLF');
  assert.ok(t.includes('\r\n'));
  assert.ok(files.includes('start-cabinet.cmd') && files.includes('start-cabinet.command'));
  const sh = read('start-cabinet.command');
  assert.ok(sh.startsWith('#!/bin/bash\n') && sh.includes('cd "$(dirname "$0")"') && sh.includes('node tools/serve.mjs --open'));
  assert.ok(!sh.includes('\r'));
  if (process.platform !== 'win32') assert.ok(statSync(join(ROOT, 'start-cabinet.command')).mode & 0o100, 'исполняемый');
  assert.ok(read('START.md').includes('start-cabinet.cmd'));
});

// Сервис = отдельный проект, кабинет = витрина: шаблон проекта и скиллы, которые работают в любой папке.
test('шаблон проекта сервиса: файлы, lib пустая, settings проекта, service.json по договору', () => {
  const T = 'templates/service-project/';
  for (const f of ['CLAUDE.md', 'README.md', 'service.json', 'main.py', '.gitignore', '.claude/settings.json', '.claude/hooks/guard.mjs',
    'input/.gitkeep', 'output/.gitkeep', 'lib/.gitkeep']) {
    assert.ok(files.includes(T + f), `нет ${T}${f}`);
  }
  // lib заполняет кабинет при создании проекта (tools/services.mjs new): в шаблоне своих копий нет.
  assert.deepEqual(files.filter((f) => f.startsWith(`${T}lib/`)), [`${T}lib/.gitkeep`]);
  const svc = JSON.parse(read(`${T}service.json`));
  assert.deepEqual(Object.keys(svc), ['name', 'about', 'kind', 'run', 'result', 'input', 'page']);
  assert.deepEqual([svc.kind, svc.run, svc.result, svc.input, svc.page], ['run', 'main.py', 'output/result.json', 'input/', null]);
  const s = JSON.parse(read(`${T}.claude/settings.json`));
  assert.equal(s.model, 'sonnet');
  assert.equal(s.autoMemoryEnabled, false, 'уроки пишутся в правила проекта, не в автопамять');
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(s.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS, '1');
  assert.equal(s.env.PYTHONUTF8, '1');
  for (const d of ['Read(./.env)', 'Read(./.env.*)', 'Read(./**/.env)', 'Read(./**/.env.*)', 'Edit(./lib/**)', 'Edit(./.claude/hooks/**)']) {
    assert.ok(s.permissions.deny.includes(d), `нет запрета ${d}`);
  }
  for (const a of ['Bash(python main.py*)', 'Bash(py main.py*)', 'Bash(python lib/read_table.py*)']) assert.ok(s.permissions.allow.includes(a), a);
  const hooks = s.hooks.PreToolUse.flatMap((h) => h.hooks.map((x) => ({ ...x, matcher: h.matcher })));
  const guard = hooks.find((h) => (h.args ?? []).some((a) => a.endsWith('/.claude/hooks/guard.mjs')));
  assert.ok(guard, 'сторож проекта не зарегистрирован');
  assert.equal(guard.command, 'node', 'сторож запускается без оболочки');
  assert.deepEqual(guard.args, ['${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.mjs']);
  for (const tool of ['Bash', 'PowerShell', 'Monitor', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Artifact']) {
    assert.ok(guard.matcher.split('|').includes(tool), `сторож не видит ${tool}`);
  }
});

test('шаблон проекта сервиса: .gitignore закрывает .env, данные и результат, но не .gitkeep', () => {
  const T = 'templates/service-project/';
  const ignored = (p) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT }).status === 0;
  for (const p of ['.env', '.env.local', 'input/prodazhi.xlsx', 'output/result.json', '__pycache__/x.pyc', '.claude/settings.local.json']) {
    assert.equal(ignored(T + p), true, `${p} не в .gitignore проекта`);
  }
  for (const p of ['input/.gitkeep', 'output/.gitkeep', 'lib/.gitkeep', 'lib/llm.py', 'main.py', 'service.json', 'CLAUDE.md', '.claude/settings.json']) {
    assert.equal(ignored(T + p), false, `${p} попал под .gitignore`);
  }
});

test('шаблон проекта сервиса: правила проекта (данные, секреты, модель, известный ответ, уроки, «добавь в кабинет»)', () => {
  const rules = read('templates/service-project/CLAUDE.md').replace(/\r\n/g, '\n');  // git на Windows: CRLF
  for (const must of ['## Уроки', 'Уроков пока нет.', 'известный ответ', 'до слова «готово»', '`python lib/read_table.py "input/<файл>" --rows 5`',
    'Строки файла целиком в разговор не бери', '`.env`', 'не открываешь', 'lib/llm.py', 'output/result.json', '«добавь в кабинет»',
    'kabinet-dobav-v-kabinet', 'subprocess', 'eval', 'PYTHONPATH=lib']) {
    assert.ok(rules.includes(must), `в правилах проекта нет ${must}`);
  }
  // Уроки последним разделом: Claude дописывает их в конец.
  assert.equal(rules.trimEnd().split('\n## ').at(-1).split('\n')[0], 'Уроки');
  const readme = read('templates/service-project/README.md');
  assert.ok(readme.includes('**добавь в кабинет**') && readme.includes('`input`'));
});

test('скиллы kabinet-*: фразы, команды кабинета в кавычках, поиск кабинета, окно разрешения заранее', () => {
  const nov = read(`${USER_SKILLS}kabinet-novyi-servis/SKILL.md`);
  const add = read(`${USER_SKILLS}kabinet-dobav-v-kabinet/SKILL.md`);
  assert.ok(nov.includes('node "<кабинет>/tools/services.mjs" new "<название>"'));
  for (const sub of ['check', 'run', 'add']) assert.ok(add.includes(`node "<кабинет>/tools/services.mjs" ${sub} "<проект>"`), sub);
  for (const text of [nov, add]) {
    for (const must of ['{{KABINET}}', 'AI_CABINET_DIR', "'Documents','ai-cabinet'", "'Документы','ai-cabinet'", '**Allow** (разрешить)', 'Cannot find module']) {
      assert.ok(text.includes(must), must);
    }
  }
  assert.match(nov.split('\n---')[0], /«новый сервис», «создай сервис»/);
  assert.match(add.split('\n---')[0], /«добавь в кабинет», «встрой в кабинет»/);
  assert.ok(nov.includes('Откройте эту папку в новом разговоре'));
  // Скиллы ставятся только с префиксом kabinet-: чужие папки в ~/.claude/skills init не трогает.
  assert.ok(files.filter((f) => f.startsWith(USER_SKILLS)).every((f) => /^templates\/user-skills\/kabinet-[a-z0-9-]+\//.test(f)));
  const rules = read('CLAUDE.md');
  assert.match(rules, /\| «новый сервис», «создай сервис» \|[^\n]*kabinet-novyi-servis/);
  assert.ok(rules.includes('## Сервисы-проекты') && rules.includes('templates/user-skills/kabinet-novyi-servis/SKILL.md'));
  assert.ok(read('START.md').includes('**новый сервис**'));
});

// Правила понятной страницы и карточки: один файл курса, на него ссылаются правила проекта сервиса и скиллы процессов.
test('design.md: ссылки-обязанности в правилах проекта сервиса и в скиллах процессов', () => {
  assert.ok(files.includes('tools/design.md'), 'нет tools/design.md');
  const proj = read('templates/service-project/CLAUDE.md');
  const section = (title) => proj.split(/\n## /).find((s) => s.startsWith(title)) ?? '';
  assert.match(section('Результат: output/result.json'), /lib\/design\.md/);
  assert.match(section('Своя страница'), /lib\/design\.md/);
  assert.match(read('.claude/skills/add-process/SKILL.md'), /tools\/design\.md/);
  assert.match(read('.claude/skills/run-process/SKILL.md'), /tools\/design\.md/);
});

// В файлах курса нет указаний на сторонние плагины и их установку, в design.md ещё и на сторонние библиотеки и вид.
// Названий плагинов-источников design.md в репозитории нет даже в тесте: только хеши, как у имени клиента.
const PLUGIN_HASHES = new Map([
  [13, '2931516d2e2c8bd56a36948aa11421aaf8071cff52171badf85bdf039f38b633'],
  [15, '7429eb2e51b7dc87b330ea49667c58234ee4326ad3bfb64e60fc6afb13149f8b'],
]);
const hasPluginName = (text) => {
  const t = text.toLowerCase();
  for (const [n, h] of PLUGIN_HASHES) {
    for (let i = t.indexOf('-'); i !== -1; i = t.indexOf('-', i + 1)) {
      for (let s = Math.max(0, i - n + 1); s <= i && s + n <= t.length; s++) if (sha(t.slice(s, s + n)) === h) return true;
    }
  }
  return false;
};
test('без сторонних плагинов; design.md только в терминах кабинета', () => {
  // Набор интерфейса tools/ui чужой и сжатый: в нём «plugin» свой, его не смотрим.
  const course = files.filter((f) => !isCase(f) && !f.startsWith('tools/ui/') && /\.(md|csv|txt|json|html|mjs|js|py|cmd|command)$/i.test(f));
  const config = /enabledPlugins|extraKnownMarketplaces|claude plugin install/;
  const bad = course.filter((f) => f !== 'tools/tests/template.test.mjs' && (config.test(read(f)) || hasPluginName(read(f))));
  assert.deepEqual(bad, []);
  const d = read('tools/design.md');
  const foreign = d.match(/плагин|plugin|скилл|skill|tailwind|basecoat|chart\.js|https?:|rgb\(|font-family|#[0-9a-f]{3,8}\b|\bQ\d+\b/gi);
  assert.equal(foreign, null, `в tools/design.md: ${foreign}`);
});
