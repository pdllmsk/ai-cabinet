// Сторож проекта сервиса (хук PreToolUse). Упрощённый сторож кабинета (ai-cabinet/.claude/hooks/guard.mjs).
// Без зависимостей, запускается без оболочки: в settings.json "command": "node", "args": [путь к этому файлу].
//
// Файлы (Write, Edit, MultiEdit, NotebookEdit; Artifact с out_dir сохраняет файлы на диск). Запись в lib/
// (копии помощников кабинета: read_table.py и llm.py, который проверяет данные перед отправкой в модель) и в
// .claude/ (настройки проекта и этот сторож) запрещена в любом режиме и в любом написании пути: регистр,
// короткое имя 8.3, точка и пробел в конце, поток после двоеточия, ссылка. Запись вне папки проекта: в обычных
// режимах спрашивает сам Claude Code, в Auto окно сторожа, где окна нет, запрет.
//
// Команды (Bash, PowerShell, Monitor). Разобрать, что команда пишет, надёжно нельзя, поэтому правило простое:
// окно разрешения, если команда
// - упоминает lib или .claude (кроме разрешённых: python main.py, python lib/read_table.py, python lib/llm.py,
//   и нескольких таких через ; && || или с новой строки),
// - идёт не из папки проекта или изнутри lib/ и .claude/,
// - выходит за папку проекта: абсолютный путь вне проекта, .., ~, переменные среды ($HOME, %USERPROFILE%).
// Команды кабинета (tools/services.mjs при «добавь в кабинет» и «новый сервис») тоже выходят за проект: у их
// окна своя понятная подпись. Остальное в обычных режимах решает Claude Code (правила allow в settings.json),
// в Auto окно сторожа на любую команду, кроме разрешённых, где окна нет, запрет.
//
// Режимы (поле permission_mode во входе хука): окно по ответу "ask" появляется в default, manual, acceptEdits,
// plan и auto. В bypassPermissions, dontAsk, без режима или в незнакомом спросить нельзя: вместо окна запрет с
// подсказкой вернуть обычный режим.
//
// Вход: JSON в stdin (tool_name, tool_input, cwd, permission_mode). Выход: пусто (решения нет) или
// {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"|"deny","permissionDecisionReason":"..."}}.
// Код выхода всегда 0.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REASON_LOCKED =
  'Папка lib (помощники из кабинета) и папка .claude (настройки проекта) не меняются. Claude работает с main.py, service.json и папкой output.';
export const REASON_PROTECTED =
  'Claude хочет выполнить команду, которая касается папки lib или настроек проекта. Разрешите, только если вы сами это просили.';
export const REASON_OUTSIDE =
  'Claude хочет выполнить команду за пределами папки проекта. Разрешите, только если вы сами это просили.';
export const REASON_CABINET =
  'Claude хочет выполнить команду кабинета: создать, проверить, запустить или добавить сервис в кабинет. Разрешите, если вы просили «новый сервис» или «добавь в кабинет».';
export const REASON_OTHER =
  'Claude хочет выполнить команду, которой нет в списке разрешённых для проекта. Разрешите, только если вы сами это просили.';
export const REASON_FILE_OUTSIDE =
  'Claude хочет записать файл за пределами папки проекта. Разрешите, только если вы сами это просили.';
export const REASON_NO_PROMPT =
  'В этом режиме Claude не может спросить вас, поэтому такие действия закрыты. Переключите режим на обычный (Shift+Tab) и повторите.';

export const TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
export const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Artifact']);

// Режимы, где человек видит окно на ответ "ask" (manual: другое имя default).
const PROMPT_MODES = new Set(['default', 'manual', 'acceptEdits', 'plan', 'auto']);
// Режимы, где команды и запись вне проекта спрашивает сам Claude Code.
const RULE_MODES = new Set(['default', 'manual', 'acceptEdits', 'plan']);

export const canPrompt = (mode) => PROMPT_MODES.has(mode);
const guarded = (mode, reason) => (canPrompt(mode) ? { decision: 'ask', reason } : { decision: 'deny', reason: REASON_NO_PROMPT });

// Разрешённые команды проекта: программа сервиса и помощники из lib. Аргументы без ; & | < > $ ( ) ` и переводов
// строки; скобки можно только в кавычках "..." и '...'. Кавычки парные, открывает только " или ' (PowerShell
// закрывает строку и типографскими кавычками, поэтому их нет ни вне кавычек, ни внутри).
const PROGRAM = /^\s*py(?:thon3?)?\s+(?:\.[\\/])?(?:main\.py|lib[\\/](?:read_table|llm)\.py)(?=\s|$)/;
const ARGS = /^(\s+(?:(?!\\["'])[^;&|<>$()`\r\n"“”„'‘’‚‛]|"[^;&|<>$`\r\n"“”„]*"|'[^;&|<>$`\r\n'‘’‚‛]*')*)?\s*$/;
export const isAllowed = (command) => PROGRAM.test(command) && ARGS.test(command.replace(PROGRAM, ''));
// Несколько разрешённых команд через ; && || или с новой строки (Claude так проверяет итоги): каждая часть
// разрешённая. Разрезано неверно (знак внутри кавычек): часть не пройдёт проверку, и команда идёт обычным путём.
const parts = (command) => command.split(/;|&&|\|\||\r?\n/).map((x) => x.trim()).filter(Boolean);
export const allAllowed = (command) => {
  const list = parts(command);
  return list.length > 0 && list.every(isAllowed);
};

const NAMES = ['lib', '.claude'];

// Защищённое имя части пути: lib или .claude; на Windows ещё с точками и пробелами в конце и короткое имя
// .claude (CLAUDE~1). Дефисы в начале снимаются: ${x:-lib} в bash раскрывается в lib.
function protectedName(part) {
  const bare = part.replace(/^-+/, '');
  const name = bare.replace(/[. ]+$/, '');
  return NAMES.includes(name) || /^claude~\d/.test(bare);
}

const hasGlob = (s) => /[*?[]/.test(s);

function globMatches(part) {
  const body = part.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    const re = new RegExp(`^${body}$`);
    return NAMES.some((n) => re.test(n));
  } catch {
    return true; // незакрытая [ и подобное: осторожно считаем, что может совпасть
  }
}

// $'...' в bash: \xHH, \uHHHH, восьмеричные коды и \n превращаются в символы.
function decodeAnsiC(text) {
  return text.replace(/\$'((?:[^'\\]|\\.)*)'/g, (m, body) =>
    body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|.)/g, (s, e) => {
      try {
        if (/^[xuU]/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 16));
        if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
      } catch {
        return '';
      }
      return { n: '\n', t: '\t', r: '\r' }[e] ?? e;
    }),
  );
}

// Раскрытие {a,b} в bash: l{i,}b даёт lib. Не больше limit вариантов.
function expandBraces(text, limit = 64) {
  const done = [];
  const todo = [text];
  while (todo.length && done.length + todo.length <= limit) {
    const t = todo.pop();
    const m = /\{([^{}]*,[^{}]*)\}/.exec(t);
    if (!m) {
      done.push(t);
      continue;
    }
    for (const alt of m[1].split(',')) todo.push(t.slice(0, m.index) + alt + t.slice(m.index + m[0].length));
  }
  return [...done, ...todo];
}

// Свободные формы команды: строчными, без кавычек, ` (PowerShell) и ^ (cmd). a: обратная косая черта убрана
// (bash: \l это l); b: она разделитель путей; c: как b, но склеены строки "a" + "b" (PowerShell).
export function looseForms(command) {
  const s = decodeAnsiC(String(command)).toLowerCase().replace(/['"`^]/g, '');
  const a = s.replace(/\\/g, '');
  const b = s.replace(/\\/g, '/');
  const c = b.replace(/\s*\+\s*/g, '');
  const forms = new Set();
  for (const f of [a, b, c]) for (const x of expandBraces(f)) forms.add(x);
  return [...forms];
}

const TOKEN_SPLIT = /[\s;|&<>(){},=:!@#$%+]+/;

export function mentionsProtected(form, rootBase = '') {
  for (const token of form.split(TOKEN_SPLIT)) {
    if (!token) continue;
    const parts = token.split('/');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (protectedName(p)) return true;
      // Шаблон имени (l*, li?, [l]ib) в начале относительного пути или сразу после папки проекта.
      const prev = i === 0 ? null : parts[i - 1];
      const head = i === 0 || prev === '.' || prev === '..' || (rootBase && prev === rootBase);
      if (head && hasGlob(p) && globMatches(p)) return true;
    }
  }
  return false;
}

const fold = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const caseless = (platform) => platform === 'win32' || platform === 'darwin';

// Путь внутри одной из папок проекта (или сама папка). Без учёта регистра на Windows и Mac.
function insideAny(path, roots, platform) {
  const norm = (p) => (caseless(platform) ? fold(p).toLowerCase() : fold(p));
  const p = norm(path);
  return roots.filter(Boolean).some((r) => {
    const root = norm(r);
    return p === root || p.startsWith(`${root}/`);
  });
}

// Первая часть пути после папки проекта или null, если путь вне проекта.
function firstInside(path, roots, platform) {
  const norm = (p) => (caseless(platform) ? fold(p).toLowerCase() : fold(p));
  const p = norm(path);
  for (const r of roots.filter(Boolean)) {
    const root = norm(r);
    if (p.startsWith(`${root}/`)) return fold(path).slice(fold(r).length + 1).split('/')[0];
    if (p === root) return '';
  }
  return null;
}

// Переменные среды: куда ведут, сторож не знает ($HOME, ${X}, $(...), %USERPROFILE%, $env:X). $null, $true,
// $false из PowerShell не в счёт.
const VARS = /\$(?!(?:null|true|false)\b)(?:[{(]|[A-Za-z_])|%[A-Za-z_][\w()]*%/i;
// Начало пути: диск (C:\ или C:/), корень (/ или \), домашняя папка (~), выход наверх (..).
const PATH_START = /^(?:[a-z]:[\\/]|[\\/]|~(?:[\\/]|$)|\.\.(?:[\\/]|$))/i;
const PATH_IN_TEXT = /(?<![\p{L}\p{N}_.\-\\/])(?:[a-z]:[\\/]|[\\/]|~(?=[\\/]|$|\s)|\.\.(?=[\\/]|$|\s))[^\s"'`;|&<>(){},=]*/giu;
const HARMLESS = /^(?:\/dev\/(?:null|stdout|stderr)|nul)$/i;

// Пути в тексте команды. Строка в кавычках, которая сама начинается как путь, берётся целиком (путь с пробелом);
// в остальном тексте, и внутри других строк в кавычках (python -c "open('/etc/x')"), ищутся начала путей.
export function pathCandidates(command) {
  const out = [];
  const scan = (s) => {
    for (const m of s.matchAll(PATH_IN_TEXT)) out.push(m[0]);
  };
  const text = String(command).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`]*/gi, ' '); // адреса сайтов не пути
  const rest = text.replace(/"([^"]*)"|'([^']*)'/g, (m, a, b) => {
    const s = a ?? b;
    if (PATH_START.test(s)) out.push(s);
    else scan(s);
    return ' ';
  });
  scan(rest);
  return out.filter((p) => !HARMLESS.test(p));
}

// Путь из команды ведёт за папку проекта. Относительный путь без .. остаётся в проекте.
function leavesProject(candidate, { cwds = [], roots = [], platform = process.platform, home = homedir() }) {
  const win = platform === 'win32';
  const P = win ? win32 : posix;
  let p = candidate;
  if (/^~/.test(p)) p = P.join(home, p.slice(1));
  if (win && /^\/[a-z](\/|$)/i.test(p)) p = `${p[1]}:/${p.slice(3)}`; // Git Bash: /c/Users это C:\Users
  const abs = P.isAbsolute(p) || (win && /^[a-z]:/i.test(p));
  if (!abs && !/(^|[\\/])\.\.([\\/]|$)/.test(p)) return false;
  const targets = abs ? [P.resolve(p)] : cwds.filter(Boolean).map((b) => P.resolve(b, p));
  if (!targets.length) return true;
  return targets.some((t) => !insideAny(t, roots, platform));
}

export function goesOutside(command, ctx = {}) {
  return expandBraces(decodeAnsiC(String(command))).some(
    (v) => VARS.test(v) || pathCandidates(v).some((c) => leavesProject(c, ctx)) || /(^|[;&|]\s*)(cd|chdir|pushd)\s*($|[;&|])/i.test(v),
  );
}

const CABINET = /tools[\\/]+services\.mjs/i;

// Решение по команде: null (без решения) или { decision: 'ask' | 'deny', reason }.
export function classify(command, { tool = 'Bash', cwds = [], roots = [], platform = process.platform, mode, home = homedir() } = {}) {
  if (!TOOLS.has(tool)) return null;
  if (typeof command !== 'string' || !command.trim()) return null;
  const allowed = allAllowed(command);
  const rootBase = roots.filter(Boolean).map((r) => fold(r).toLowerCase().split('/').pop())[0] ?? '';
  // У разрешённой команды lib в начале законно: проверяем только её аргументы.
  const checked = allowed ? parts(command).map((x) => x.replace(PROGRAM, '')).join(' ') : command;
  if (looseForms(checked).some((f) => mentionsProtected(f, rootBase))) return guarded(mode, REASON_PROTECTED);
  const cwdList = cwds.filter(Boolean);
  if (cwdList.length && roots.some(Boolean)) {
    const firsts = cwdList.map((c) => firstInside(c, roots, platform));
    if (firsts.every((f) => f === null)) return guarded(mode, REASON_OUTSIDE);
    if (firsts.some((f) => f && protectedName(f.toLowerCase()))) return guarded(mode, REASON_PROTECTED);
  }
  if (goesOutside(command, { cwds: cwdList, roots, platform, home })) {
    return guarded(mode, CABINET.test(command) ? REASON_CABINET : REASON_OUTSIDE);
  }
  if (allowed || RULE_MODES.has(mode)) return null;
  return guarded(mode, REASON_OTHER);
}

// Имя части пути без того, что Windows отбрасывает: поток после :, точки и пробелы в конце. Строчными.
const bareName = (part) => String(part).toLowerCase().split(':')[0].replace(/[. ]+$/, '');
const isLocked = (raw) => ['lib', '.claude'].includes(bareName(raw)) || /^claude~\d/.test(String(raw).toLowerCase());

// Куда попадает файл: 'locked' (lib/ или .claude/ проекта), 'outside' (вне проекта) или null.
// Относительный путь берётся от папки команды и от папки проекта, ~ от домашней папки. real(путь) даёт
// настоящий путь (ссылки, junction) или null.
export function fileZone(file, { cwds = [], roots = [], platform = process.platform, home = homedir(), real = null } = {}) {
  if (typeof file !== 'string' || !file.trim()) return null;
  const win = platform === 'win32';
  const P = win ? win32 : posix;
  let raw = file.trim();
  // Пути устройств Windows: \\?\C:\... и \\.\C:\... это C:\...; остальные и сетевые пути считаются вне проекта.
  if (win && /^[\\/]{2}[?.][\\/][a-z]:/i.test(raw)) raw = raw.slice(4);
  if (/^~([\\/]|$)/.test(raw)) raw = P.join(home, raw.slice(1));
  const bases = [...cwds, ...roots].filter(Boolean);
  const direct = P.isAbsolute(raw) ? [P.resolve(raw)] : bases.map((b) => P.resolve(b, raw));
  const viaReal = real ? direct.map((p) => real(p)).filter(Boolean) : [];
  let outside = false;
  for (const p of [...direct, ...viaReal]) {
    const first = firstInside(p, roots, platform);
    if (first === null) {
      outside = true;
      continue;
    }
    if (first && isLocked(first)) return 'locked';
  }
  return outside ? 'outside' : null;
}

// Пути, куда пишет инструмент записи. Artifact: out_dir и out_dir/<path или paths>; без out_dir не пишет.
export function filePathsOf(tool, ti) {
  if (tool === 'Artifact') {
    if (typeof ti?.out_dir !== 'string' || !ti.out_dir.trim()) return [];
    const dir = ti.out_dir.replace(/[\\/]+$/, '');
    const names = [ti.path, ...(Array.isArray(ti.paths) ? ti.paths : [])].filter((x) => typeof x === 'string' && x);
    return [`${dir}/_`, ...names.map((n) => `${dir}/${n}`)];
  }
  return [typeof ti?.file_path === 'string' ? ti.file_path : typeof ti?.notebook_path === 'string' ? ti.notebook_path : ''];
}

export function classifyFile(files, ctx = {}) {
  if (!FILE_TOOLS.has(ctx.tool)) return null;
  let outside = false;
  for (const f of Array.isArray(files) ? files : [files]) {
    const zone = fileZone(f, ctx);
    if (zone === 'locked') return { decision: 'deny', reason: REASON_LOCKED };
    if (zone === 'outside') outside = true;
  }
  if (!outside || RULE_MODES.has(ctx.mode)) return null;
  return guarded(ctx.mode, REASON_FILE_OUTSIDE);
}

// Решение по входу хука целиком. ctx: roots, platform, home, cwds (если не заданы, папка из входа), real.
export function decide(input, ctx = {}) {
  const tool = input?.tool_name ?? 'Bash';
  const ti = input?.tool_input ?? {};
  const mode = typeof input?.permission_mode === 'string' ? input.permission_mode : undefined;
  const cwds = ctx.cwds ?? [typeof input?.cwd === 'string' ? input.cwd : process.cwd()];
  const full = { ...ctx, tool, mode, cwds };
  try {
    if (FILE_TOOLS.has(tool)) return classifyFile(filePathsOf(tool, ti), full);
    if (!TOOLS.has(tool)) return null;
    const command =
      typeof ti.command === 'string' ? ti.command : Object.values(ti).filter((v) => typeof v === 'string').join('\n');
    return classify(command, full);
  } catch {
    // Разбор упал: решает человек, а где спросить нельзя, запрет.
    return guarded(mode, FILE_TOOLS.has(tool) ? REASON_FILE_OUTSIDE : REASON_OTHER);
  }
}

// Ответ хуку: не-ASCII как \uXXXX, чтобы кодовая страница Windows не испортила текст.
export function hookOutput(result) {
  if (!result) return '';
  const json = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: result.reason,
    },
  });
  return json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function real(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

// Настоящий путь файла, которого ещё нет: настоящий путь ближайшей существующей папки и остаток.
function nearestReal(p) {
  let dir = p;
  const rest = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(dir)) {
      const r = real(dir);
      return r ? resolve(r, ...rest) : null;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    rest.unshift(dir.slice(up.length).replace(/^[\\/]+/, ''));
    dir = up;
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input || typeof input !== 'object') return;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  const roots = [ROOT, real(ROOT), envRoot, envRoot && real(envRoot)];
  process.stdout.write(hookOutput(decide(input, { cwds: [cwd, real(cwd)], roots, real: nearestReal })));
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
