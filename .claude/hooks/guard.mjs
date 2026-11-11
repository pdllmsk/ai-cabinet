// Сторож Claude (хук PreToolUse для команд Bash, PowerShell, Monitor, для инструментов записи файлов
// и для сохранения файлов артефакта). Без зависимостей, запускается без оболочки.
//
// Команды. Режим автоприёма правок пропускает без окна команды вроде `echo ... >> processes/x/run.py`
// или `cp`, а запуск процесса фразой разрешён. Без сторожа текст из входного файла мог бы записать
// программу процесса и запустить её без единого окна. Разобрать, что команда пишет, надёжно нельзя
// (экранирование, кавычки, короткие имена Windows), поэтому правило простое: любая команда, кроме
// разрешённых команд курса, которая упоминает папку processes или .claude (в любом написании) или идёт
// изнутри них, спрашивает окно разрешения. Запись командой в tools/, templates/ и input/ закрывают
// запреты Edit в .claude/settings.json: Claude Code применяет их и к командам, в любом режиме.
// Monitor запускает команду оболочки так же, как Bash, поэтому проверяется так же.
//
// Файлы (Write, Edit, MultiEdit, NotebookEdit; Artifact с out_dir сохраняет файлы на диск). Запись в
// input/, tools/, templates/ и .claude/hooks/ запрещена в любом режиме (вдобавок к запретам Edit в
// settings.json). Запись в processes/ и .claude/ в обычных режимах решают правило ask в settings.json и
// встроенная защита .claude/ в Claude Code, если путь назван буквально (processes/..., .claude/...).
// Путь в другом написании (8.3, точка в конце, поток, ссылка) или путь, про который нельзя точно сказать,
// в кабинете он или нет (устройство Windows, сетевой путь), спрашивает сам сторож.
//
// Режимы (поле permission_mode во входе хука; D70: организация не отключает обход разрешений и Auto).
// Проверено на Claude Code 2.1.231 и 2.1.307: окно по ответу хука "ask" появляется во всех режимах,
// правило ask в settings.json спрашивает везде, кроме dontAsk, запреты deny действуют везде. Но в Auto
// встроенную защиту .claude/ (settings.local.json, скиллы) решает классификатор без окна, а команды вне
// курса классификатор пропускает сам. Поэтому в Auto сторож спрашивает окно на любую команду вне курса и
// на запись файлов в processes/ и .claude/, как в обычном режиме кабинета. В режимах обхода разрешений
// (bypassPermissions) и dontAsk окна не ждут, а команда, которая processes не называет (python
// output/fix.py), всё равно может туда писать. Поэтому там запрещены любая команда вне курса и любая
// запись в processes/ и .claude/, с подсказкой вернуть обычный режим. Режим не передан или незнаком:
// считаем, что спросить нельзя.
//
// Вход: JSON в stdin (tool_name, tool_input, cwd, permission_mode). Выход: пусто (решения нет) или
// {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"|"deny","permissionDecisionReason":"..."}}.
// Код выхода всегда 0.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REASON =
  'Claude хочет выполнить команду, которая касается программ процессов или настроек кабинета. Разрешите, только если вы сами это просили.';
export const REASON_FILE =
  'Claude хочет изменить программу процесса или настройки кабинета. Разрешите, только если вы сами это просили.';
export const REASON_NO_PROMPT =
  'В этом режиме Claude не может спросить вас, поэтому изменения программ процессов и настроек кабинета закрыты. Переключите режим на обычный (Shift+Tab) и повторите.';
export const REASON_DATA = 'Это файлы курса или ваши исходные данные, Claude их не меняет.';
export const REASON_SKILL_CMD =
  'В этом скилле есть команда, которая выполнится сама при запуске скилла, без вопроса. Сохраняйте его, только если знаете, что эта команда делает.';
export const REASON_SKILL_CMD_NO_PROMPT = `${REASON_SKILL_CMD} В этом режиме Claude не может спросить вас. Переключите режим на обычный (Shift+Tab) и повторите.`;
export const REASON_OTHER =
  'Claude хочет выполнить команду, которая не входит в курс. Разрешите, только если вы сами это просили.';

// Инструменты, которые запускают команду оболочки из поля command.
export const TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
export const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Artifact']);

// Режимы, где человек видит окно на ответ сторожа "ask" (manual: другое имя default).
const PROMPT_MODES = new Set(['default', 'manual', 'acceptEdits', 'plan', 'auto']);
// Режимы, где запись файлов в processes/ и .claude/ спрашивают правила settings.json и Claude Code сами.
const RULE_MODES = new Set(['default', 'manual', 'acceptEdits', 'plan']);

export const canPrompt = (mode) => PROMPT_MODES.has(mode);

// Решение для записи в processes/ или .claude/: окно, где оно будет, иначе запрет с подсказкой.
function guarded(mode, reason) {
  return canPrompt(mode) ? { decision: 'ask', reason } : { decision: 'deny', reason: REASON_NO_PROMPT };
}

// Разрешённые команды курса, только целиком: одна команда, без ; & | < > $ ( ) ` и переводов строки.
// Скобки можно только внутри кавычек "..." или '...' (имя скачанного файла «skill (1).zip»): bash и PowerShell
// читают их там как текст. Кавычки парные, открывает только " или ': PowerShell принимает за кавычки и
// “ ” „ ‘ ’ ‚ ‛ и закрывает ими строку, поэтому они не стоят ни вне кавычек, ни внутри "..." (“ ” „) и '...'
// (‘ ’ ‚ ‛). Иначе скобки, которые проверка видит в кавычках, PowerShell выполнил бы как выражение. По той же
// причине вне кавычек нет \" и \': для bash это обычный знак, кавычку он не открывает.
const COURSE =
  /^\s*(node\s+(\.[\\/])?tools[\\/](serve|check|update|processes|services)\.mjs|py(thon3?)?\s+(\.[\\/])?tools[\\/](read_table|analiz|llm)\.py)(\s+(?:(?!\\["'])[^;&|<>$()`\r\n"“”„'‘’‚‛]|"[^;&|<>$`\r\n"“”„]*"|'[^;&|<>$`\r\n'‘’‚‛]*')*)?$/;

const NAMES = ['processes', '.claude'];

// Имя части пути защищённое: processes или .claude; на Windows ещё с точками и пробелами в конце
// (processes. и processes  открывают ту же папку) и короткое имя 8.3 (PROCES~1, CLAUDE~1).
// Дефисы в начале снимаются: ${x:-processes} в bash раскрывается в processes.
function protectedName(part) {
  const bare = part.replace(/^-+/, '');
  const name = bare.replace(/[. ]+$/, '');
  return NAMES.includes(name) || /^(proces|claude)~\d/.test(bare);
}

const hasGlob = (s) => /[*?[]/.test(s);

function globMatches(part) {
  const body = part.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  let re;
  try {
    re = new RegExp(`^${body}$`);
  } catch {
    return true; // незакрытая [ и подобное: осторожно считаем, что может совпасть
  }
  return NAMES.some((n) => re.test(n));
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

// Раскрытие {a,b} в bash: pro{c,}esses даёт processes. Не больше limit вариантов.
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

// Свободные формы команды: строчными, без кавычек, обратных кавычек (PowerShell: `x это x) и ^ (cmd: ^x это x).
// a: обратная косая черта убрана (bash: \e это e); b: она разделитель путей (Windows, PowerShell);
// c: как b, но склеены строки "a" + "b" (PowerShell). Каждая форма ещё и с раскрытыми {a,b}.
// Строятся всегда все формы: какой бы ни была оболочка, лишнее окно лучше пропущенного.
export function looseForms(command) {
  const s = decodeAnsiC(String(command)).toLowerCase().replace(/['"`^]/g, '');
  const a = s.replace(/\\/g, '');
  const b = s.replace(/\\/g, '/');
  const c = b.replace(/\s*\+\s*/g, '');
  const forms = new Set();
  for (const f of [a, b, c]) for (const x of expandBraces(f)) forms.add(x);
  return [...forms];
}

// Части путей формы. Разделители: пробелы и знаки оболочки, в том числе : из -Path:значение
// (PowerShell) и = из VAR=значение. Звёздочка, ?, [ ] остаются: это шаблоны имён.
const TOKEN_SPLIT = /[\s;|&<>(){},=:!@#$%+]+/;

export function mentionsProtected(form, rootBase = '') {
  for (const token of form.split(TOKEN_SPLIT)) {
    if (!token) continue;
    const parts = token.split('/');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (protectedName(p)) return true;
      // Шаблон имени (p*, proc?sses, [p]rocesses) в начале относительного пути или сразу после
      // папки кабинета может раскрыться в processes или .claude.
      const prev = i === 0 ? null : parts[i - 1];
      const head = i === 0 || prev === '.' || prev === '..' || (rootBase && prev === rootBase);
      if (head && hasGlob(p) && globMatches(p)) return true;
    }
  }
  return false;
}

const fold = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

// Команда идёт из папки processes или .claude кабинета (Claude перешёл туда раньше).
export function cwdInside(cwds, roots, platform = process.platform) {
  const ci = platform === 'win32' || platform === 'darwin';
  const norm = (p) => (ci ? fold(p).toLowerCase() : fold(p));
  for (const cwd of cwds.filter(Boolean).map(norm)) {
    for (const root of roots.filter(Boolean).map(norm)) {
      if (!cwd.startsWith(`${root}/`)) continue;
      const first = cwd.slice(root.length + 1).split('/')[0];
      if (protectedName(first.toLowerCase())) return true;
    }
  }
  return false;
}

// Решение по команде: null (без решения) или { decision: 'ask' | 'deny', reason }.
// cwds: папка команды (и её настоящий путь); roots: возможные корни кабинета; mode: permission_mode.
export function classify(command, { tool = 'Bash', cwds = [], roots = [], platform = process.platform, mode } = {}) {
  if (!TOOLS.has(tool)) return null;
  if (typeof command !== 'string' || !command.trim()) return null;
  if (COURSE.test(command)) return null;
  const rootBase = roots.filter(Boolean).map((r) => fold(r).toLowerCase().split('/').pop())[0] ?? '';
  if (looseForms(command).some((f) => mentionsProtected(f, rootBase))) return guarded(mode, REASON);
  if (cwdInside(cwds, roots, platform)) return guarded(mode, REASON);
  // Команда вне курса: в обычных режимах окно спрашивает Claude Code, в Auto сторож, без окна запрет.
  if (RULE_MODES.has(mode)) return null;
  return guarded(mode, REASON_OTHER);
}

// Имя части пути без того, что Windows отбрасывает: поток после : (processes::$INDEX_ALLOCATION),
// точки и пробелы в конце. Строчными.
function bareName(part) {
  return String(part).toLowerCase().split(':')[0].replace(/[. ]+$/, '');
}

const DATA = ['input', 'tools', 'templates'];
const isData = (raw) => DATA.includes(bareName(raw)) || /^templa~\d/.test(String(raw).toLowerCase());
const isHooks = (raw) => bareName(raw) === 'hooks';
const isClaude = (raw) => bareName(raw) === '.claude' || /^claude~\d/.test(String(raw).toLowerCase());
const isProcesses = (raw) => bareName(raw) === 'processes' || /^proces~\d/.test(String(raw).toLowerCase());

// Куда в кабинете попадает файл: { zone, literal }. zone: 'data' (input/, tools/, templates/,
// .claude/hooks/), 'guarded' (processes/, .claude/, а также путь, про который нельзя точно сказать, в
// кабинете он или нет) или null. literal: путь назван буквально (processes/... или .claude/... от корня,
// без ссылок), так что правило ask из settings.json и защита Claude Code его точно узнают.
// Относительный путь берётся от папки команды и от корня кабинета, ~ от домашней папки.
// real(путь) даёт настоящий путь (ссылки, junction) или null.
export function fileTarget(file, { cwds = [], roots = [], platform = process.platform, home = homedir(), real = null } = {}) {
  const none = { zone: null, literal: false };
  if (typeof file !== 'string' || !file.trim()) return none;
  const win = platform === 'win32';
  const P = win ? win32 : posix;
  const ci = win || platform === 'darwin';
  const segs = (p) => fold(p).split('/');
  const low = (x) => (ci ? x.toLowerCase() : x);
  let raw = file.trim();
  // Пути устройств Windows: \\?\C:\... и \\.\C:\... это C:\..., \\?\UNC\сервер\... это \\сервер\...
  // Другие (\\?\Volume{...}, \\.\pipe, \\?\GLOBALROOT) и сетевые пути не по корню кабинета точно не
  // разобрать: они могут вести в кабинет (\\localhost\C$\...), поэтому считаются защищёнными.
  let unsure = false;
  if (win) {
    if (/^[\\/]{2}[?.][\\/][a-z]:/i.test(raw)) raw = raw.slice(4);
    else if (/^[\\/]{2}[?.][\\/]unc[\\/]/i.test(raw)) raw = `\\\\${raw.slice(8)}`;
    if (/^[\\/]{2}/.test(raw)) unsure = true;
  }
  if (/^~([\\/]|$)/.test(raw)) raw = P.join(home, raw.slice(1));
  const bases = [...cwds, ...roots].filter(Boolean);
  const direct = P.isAbsolute(raw) ? [P.resolve(raw)] : bases.map((b) => P.resolve(b, raw));
  const viaReal = real ? direct.map((p) => real(p)).filter(Boolean) : [];
  const rootSegs = roots.filter(Boolean).map((r) => segs(r).map(low));
  let zone = null;
  let inside = false;
  let rawGuarded = false;
  let allLiteral = true;
  for (const [p, isReal] of [...direct.map((p) => [p, false]), ...viaReal.map((p) => [p, true])]) {
    const ps = segs(p);
    const pl = ps.map(low);
    for (const rs of rootSegs) {
      if (pl.length <= rs.length || rs.some((x, i) => x !== pl[i])) continue;
      inside = true;
      const first = ps[rs.length];
      const second = ps[rs.length + 1];
      if (isData(first) || (isClaude(first) && second !== undefined && isHooks(second))) return { zone: 'data', literal: false };
      if (isProcesses(first) || isClaude(first)) {
        zone = 'guarded';
        if (!isReal) rawGuarded = true;
        if (first !== 'processes' && first !== '.claude') allLiteral = false;
      }
    }
  }
  if (zone === 'guarded') return { zone, literal: rawGuarded && allLiteral };
  if (unsure && !inside) return { zone: 'guarded', literal: false };
  return none;
}

export const fileZone = (file, ctx = {}) => fileTarget(file, ctx).zone;

// Решение по записи файла: null или { decision, reason }.
// Artifact пишет на диск только с out_dir: файлы ложатся в out_dir/<путь опубликованного файла>.
export function classifyFile(file, ctx = {}) {
  if (!FILE_TOOLS.has(ctx.tool)) return null;
  const files = Array.isArray(file) ? file : [file];
  let guardedHit = false;
  let literal = true;
  for (const f of files) {
    const t = fileTarget(f, ctx);
    if (t.zone === 'data') return { decision: 'deny', reason: REASON_DATA };
    if (t.zone === 'guarded') {
      guardedHit = true;
      literal &&= t.literal && ctx.tool !== 'Artifact';
    }
  }
  if (!guardedHit) return null;
  // Обычный режим и путь назван буквально: окно спросят правило ask и защита .claude/ в Claude Code.
  if (RULE_MODES.has(ctx.mode) && literal) return null;
  return guarded(ctx.mode, REASON_FILE);
}

// Встроенная команда в тексте скилла: !`команда` (восклицательный знак, затем в той же строке команда в
// обратных кавычках) или блок, открытый как ```!. Claude Code выполняет её при запуске скилла без вопроса.
// Флажок: команда внутри примера в блоке кода тоже считается (безопаснее спросить лишний раз). Обычное
// «Важно!» и `код` без ! перед ним не считаются; «Готово! `файл`» через пробел тоже нет: ! и кавычка
// должны стоять вплотную, как в настоящем синтаксисе. Правки Edit и MultiEdit проверяются по тексту файла
// целиком после правки (команду можно собрать из двух правок). Так же защищён .claude/commands/.
const SKILL_CMD = /!`[^`\n]+`|```[ \t]*!/;
const SKILL_DIR = /(^|\/)(\.claude|claude~\d)\/(skills|commands)\//i;

export const hasSkillCommand = (text) => typeof text === 'string' && SKILL_CMD.test(text);

// Новый текст, который запись кладёт в файл.
export function newContentOf(tool, ti) {
  if (tool === 'Write') return [ti?.content];
  if (tool === 'Edit') return [ti?.new_string];
  if (tool === 'MultiEdit') return Array.isArray(ti?.edits) ? ti.edits.map((e) => e?.new_string) : [];
  if (tool === 'NotebookEdit') return [ti?.new_source];
  return [];
}

// Путь внутри .claude/skills/ кабинета (относительный путь берётся и от папки команды).
function inSkills(file, { cwds = [], roots = [], platform = process.platform, home = homedir() } = {}) {
  if (typeof file !== 'string' || !file.trim()) return false;
  const P = platform === 'win32' ? win32 : posix;
  let raw = file.trim();
  if (/^~([\\/]|$)/.test(raw)) raw = P.join(home, raw.slice(1));
  const cands = P.isAbsolute(raw) ? [P.resolve(raw)] : [...cwds, ...roots].filter(Boolean).map((b) => P.resolve(b, raw));
  return cands.some((c) => SKILL_DIR.test(fold(c))) || SKILL_DIR.test(fold(raw));
}

// Что окажется в файле после Edit или MultiEdit: читаем файл с диска и применяем правки по порядку.
// Не вышло (файла нет, old_string не найден): { texts: фрагменты, unsure: true }.
function textsAfterEdit(tool, ti, { cwds = [], roots = [], platform = process.platform, home = homedir() } = {}) {
  const edits =
    tool === 'Edit'
      ? [{ o: ti?.old_string, n: ti?.new_string, all: ti?.replace_all === true }]
      : (Array.isArray(ti?.edits) ? ti.edits : []).map((e) => ({ o: e?.old_string, n: e?.new_string, all: e?.replace_all === true }));
  const fragments = edits.map((e) => e.n);
  try {
    const P = platform === 'win32' ? win32 : posix;
    let raw = String(ti?.file_path ?? '').trim();
    if (/^~([\\/]|$)/.test(raw)) raw = P.join(home, raw.slice(1));
    const cands = P.isAbsolute(raw) ? [P.resolve(raw)] : [...cwds, ...roots].filter(Boolean).map((b) => P.resolve(b, raw));
    const file = cands.find((c) => existsSync(c));
    if (!file) return { texts: fragments, unsure: true };
    let text = readFileSync(file, 'utf8');
    for (const e of edits) {
      if (typeof e.o !== 'string' || typeof e.n !== 'string') return { texts: [text, ...fragments], unsure: true };
      if (e.o === '') {
        text += e.n;
        continue;
      }
      if (!text.includes(e.o)) return { texts: [text, ...fragments], unsure: true };
      text = e.all ? text.split(e.o).join(e.n) : text.replace(e.o, () => e.n);
    }
    return { texts: [text, ...fragments], unsure: false };
  } catch {
    return { texts: fragments, unsure: true };
  }
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

// Решение по входу хука целиком. ctx: roots, platform, cwds (если не заданы, папка из входа), real.
export function decide(input, ctx = {}) {
  const tool = input?.tool_name ?? 'Bash';
  const ti = input?.tool_input ?? {};
  const mode = typeof input?.permission_mode === 'string' ? input.permission_mode : undefined;
  const cwds = ctx.cwds ?? [typeof input?.cwd === 'string' ? input.cwd : process.cwd()];
  const full = { ...ctx, tool, mode, cwds };
  try {
    if (FILE_TOOLS.has(tool)) {
      const base = classifyFile(filePathsOf(tool, ti), full);
      if (base?.decision === 'deny' && base.reason === REASON_DATA) return base;
      let skillCmd = false;
      if (tool !== 'Artifact' && filePathsOf(tool, ti).some((f) => inSkills(f, full))) {
        if (tool === 'Edit' || tool === 'MultiEdit') {
          const { texts, unsure } = textsAfterEdit(tool, ti, full);
          skillCmd = texts.some(hasSkillCommand) || (unsure && texts.some((x) => typeof x === 'string' && x.includes('`')));
        } else {
          skillCmd = newContentOf(tool, ti).some(hasSkillCommand);
        }
      }
      if (!skillCmd) return base;
      return canPrompt(mode)
        ? { decision: 'ask', reason: REASON_SKILL_CMD }
        : { decision: 'deny', reason: REASON_SKILL_CMD_NO_PROMPT };
    }
    if (!TOOLS.has(tool)) return null;
    // Команда в поле command; если поле названо иначе, проверяем все строки ввода.
    const command =
      typeof ti.command === 'string' ? ti.command : Object.values(ti).filter((v) => typeof v === 'string').join('\n');
    return classify(command, full);
  } catch {
    // Разбор упал: решает человек, а где спросить нельзя, запрет.
    return guarded(mode, FILE_TOOLS.has(tool) ? REASON_FILE : REASON);
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
  return json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
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
