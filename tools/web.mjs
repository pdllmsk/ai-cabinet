// Сервис вида web (для коллег по ссылке в интернете): проверка, ключи, код доступа, страница на этом компьютере.
// Без зависимостей. Зовут скиллы «подключи публикацию» и «опубликуй сервис», а также кабинет (services.mjs).
//
//   node tools/web.mjs check "<папка проекта>"         service.json, программа, SQL, страница, db/*.sql
//   node tools/web.mjs pii "<папка проекта>"           личные данные в столбцах db/*.sql и в файлах input/
//   node tools/web.mjs secret "<папка>" --ref <ref> --host <пул> [--port 6543] [--rotate]
//                                                      роль базы: SQL с хэшем пароля, DATABASE_URL в .env
//   node tools/web.mjs code "<папка>" [--rotate]       код доступа из трёх слов в .env (код и его хэш)
//   node tools/web.mjs dev "<папка>" [--stop]          страница сервиса на этом компьютере (lib/web_dev.py)
//   node tools/web.mjs status "<папка>"                вид, публикация, какие ключи есть в .env, git
//   node tools/web.mjs migrate-plan "<папка>"          для сервиса на компьютере: таблицы базы по файлам input/
//   node tools/web.mjs verify "<папка>" [--url <адрес>] после публикации: git без ключей и данных, publish,
//                                                      сайт отвечает, без кода 401, таблицы закрыты для Supabase API
//   node tools/web.mjs save-account [--github <login>] [--vercel-team <id>] [--supabase-org <id>] [--region eu-central-1]
//                                                      учётные записи публикации в me/publikaciya.json кабинета
//
// --json: вывод одним объектом JSON. Коды выхода: 0 готово, 1 есть проблемы, 2 нечего делать или не тот проект.
// Значения ключей из .env команды не печатают (кроме тех, что сами создали: secret и code отдают их скиллу).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { findPython, programProblems } from './processes.mjs';
import { slugify } from './services.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = '.env';
export const DEV_STATE = ['output', '.web-dev.json'];
export const DEV_LOG = ['output', 'web-dev.log'];
export const WEB_ALLOW = ['web', 'db', 'read_table'];
export const ENV_KEYS = ['DATABASE_URL', 'SERVICE_ACCESS_CODE', 'SERVICE_ACCESS_CODE_HASH', 'SERVICE_COOKIE_SECRET'];
export const SCRAM_ITERATIONS = 4096;
export const CODE_ITERATIONS = 200000;
export const PII_ROWS = 200;
export const DEV_TIMEOUT_MS = 20000;
export const ACCOUNT_FILE = ['me', 'publikaciya.json'];

// Папки проекта, где программ сервиса нет: помощники кабинета, данные, страница, старая версия.
const SKIP_TOP = new Set(['lib', 'input', 'output', 'public', 'old']);
const SKIP_ANY = new Set(['__pycache__', 'node_modules', 'venv', 'env', 'site-packages']);
// Имена помощников из lib: свой файл с таким именем перекрыл бы их.
const LIB_NAMES = new Set(['web', 'db', 'read_table', 'web_dev', 'llm', 'service_api']);
const TABLE_EXT = new Set(['.csv', '.txt', '.tsv', '.xlsx', '.xlsm', '.xls']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const TASKKILL = join(SYSTEM_ROOT, 'System32', 'taskkill.exe');

function webError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const rel = (dir, file) => relative(dir, file).split('\\').join('/');

const statOrNull = (p, link = false) => {
  try {
    return link ? lstatSync(p) : statSync(p);
  } catch {
    return null;
  }
};
const isFile = (p) => Boolean(statOrNull(p)?.isFile());
const isDir = (p) => Boolean(statOrNull(p)?.isDirectory());

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
};

const readJsonFile = (file) => {
  const text = readText(file);
  if (text === null) return { missing: true };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { broken: true };
  }
};

function writeFileAtomic(file, text, mode) {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  try {
    if (mode && process.platform !== 'win32') chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  if (mode && process.platform !== 'win32') chmodSync(file, mode);
}

// ---------- .env проекта ----------

// Строки ИМЯ=значение, как их читает lib/web_dev.py: первое значение ключа, кавычки по краям снимаются.
export function parseEnv(text) {
  const env = new Map();
  for (const raw of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key || env.has(key)) continue;
    env.set(key, line.slice(eq + 1).trim().replace(/^["']|["']$/g, ''));
  }
  return env;
}

export const readEnv = (dir) => parseEnv(readText(join(dir, ENV_FILE)) ?? '');

// Записать ключи в .env проекта: строки других ключей и комментарии остаются как были, ключ заменяется на месте
// (повторы ключа убираются) или дописывается в конец. Файл только для владельца (0600, на Windows права не
// меняются), запись через временный файл: оборванная запись не портит .env.
export function writeEnv(dir, kv) {
  const pairs = Object.entries(kv ?? {}).map(([k, v]) => [k, String(v ?? '')]);
  for (const [k, v] of pairs) {
    if (!IDENT.test(k)) throw webError('EENV', `Имя ключа «${k}» не подходит для .env: латинские буквы, цифры и подчёркивание.`);
    if (/[\r\n\0]/.test(v)) throw webError('EENV', `Значение ключа ${k} не может быть из нескольких строк.`);
  }
  const file = join(dir, ENV_FILE);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  text = text.slice(bom.length);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const want = new Map(pairs);
  const done = new Set();
  const out = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && want.has(m[1])) {
      if (!done.has(m[1])) out.push(`${m[1]}=${want.get(m[1])}`);
      done.add(m[1]);
      continue;
    }
    out.push(line);
  }
  for (const [k, v] of want) if (!done.has(k)) out.push(`${k}=${v}`);
  writeFileAtomic(file, bom + out.join(eol) + eol, 0o600);
}

// ---------- паспорт проекта ----------

function projectDir(arg, cwd = process.cwd()) {
  if (!arg) throw webError('ENOARG', 'Укажите папку проекта сервиса: node tools/web.mjs <команда> "<папка>".');
  const asked = resolve(cwd, String(arg));
  if (!isDir(asked)) throw webError('ENODIR', `Нет папки сервиса: ${asked}`);
  return realpathSync(asked);
}

export function readService(dir) {
  const r = readJsonFile(join(dir, 'service.json'));
  if (r.missing) return { service: null, error: 'нет файла service.json в папке проекта' };
  if (r.broken || !isObj(r.data)) return { service: null, error: 'service.json повреждён или не в формате JSON' };
  return { service: r.data, error: null };
}

const relPath = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.trim().replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..') || /^[A-Za-z]:/.test(parts[0]) || value.trim().startsWith('/')) return null;
  return parts;
};

// ---------- проверка: SQL в коде Python ----------

const SQL_CALLS = new Set(['query', 'execute', 'insert_rows']);
const STRING_PREFIX = /^(?:r|u|b|f|br|rb|fr|rf)$/i;

// Строковый литерал Python с позиции i (кавычка или префикс r/b/f/u): { end, prefix }.
function readString(src, i) {
  const m = /^([A-Za-z]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5));
  if (!m) return { end: i + 1, prefix: '' };
  const prefix = m[1].toLowerCase();
  const q = m[2];
  let j = i + m[0].length;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (src.startsWith(q, j)) return { end: j + q.length, prefix };
    if (q.length === 1 && c === '\n') return { end: j, prefix };
    j++;
  }
  return { end: src.length, prefix };
}

const WORD_AT = /[A-Za-z_][A-Za-z0-9_]*/y;
const wordAt = (src, i) => {
  WORD_AT.lastIndex = i;
  return WORD_AT.exec(src)?.[0] ?? '';
};
const isQuote = (c) => c === '"' || c === "'";
const skipComment = (src, i) => {
  const nl = src.indexOf('\n', i);
  return nl < 0 ? src.length : nl;
};

const SQL_GLUE = {
  fstring: 'f-строка',
  percent: 'оператор %',
  plus: 'оператор +',
  format: '.format',
};

// Что не так с первым аргументом вызова (позиция сразу после «(»): склейка SQL из строк и данных.
function firstArgGlue(src, start) {
  const found = new Set();
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      i = skipComment(src, i);
      continue;
    }
    if (isQuote(c)) {
      i = readString(src, i).end;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const word = wordAt(src, i);
      if (STRING_PREFIX.test(word) && isQuote(src[i + word.length])) {
        const s = readString(src, i);
        if (s.prefix.includes('f')) found.add('fstring');
        i = s.end;
        continue;
      }
      i += word.length;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
    else if (c === '%') found.add('percent');
    else if (c === '+') found.add('plus');
    else if (c === '.' && /^\.\s*format\b/.test(src.slice(i, i + 24))) found.add('format');
    i++;
  }
  return [...found];
}

// Вызовы query(, execute(, insert_rows(, в которых SQL собирается из кусков: [{ line, why, glue }].
// Строки и комментарии Python пропускаются, вызов может занимать несколько строк (номер строки начала вызова).
export function sqlProblems(text) {
  const src = String(text ?? '');
  const found = [];
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  let prev = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      i = skipComment(src, i);
      continue;
    }
    if (isQuote(c)) {
      i = readString(src, i).end;
      prev = '';
      continue;
    }
    if (/[A-Za-z_]/.test(c) && !/[A-Za-z0-9_]/.test(src[i - 1] ?? '')) {
      const word = wordAt(src, i);
      const after = i + word.length;
      if (STRING_PREFIX.test(word) && isQuote(src[after])) {
        i = readString(src, i).end;
        prev = '';
        continue;
      }
      if (SQL_CALLS.has(word) && prev !== 'def') {
        let k = after;
        while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
        if (src[k] === '(') {
          const line = lineOf(i);
          for (const glue of firstArgGlue(src, k + 1)) {
            found.push({
              line,
              glue,
              why: `SQL склеивается из кусков (${SQL_GLUE[glue]}): данные пользователя только параметрами, например ${word}("... where id = %s", (id,))`,
            });
          }
        }
      }
      prev = word;
      i = after;
      continue;
    }
    if (!/\s/.test(c)) prev = '';
    i++;
  }
  return found;
}

// ---------- проверка: страница public/ ----------

const EXTERNAL = [
  [/<script\b[^>]*?\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//gi, 'скрипт с чужого сайта'],
  [/<link\b[^>]*?\bhref\s*=\s*["']?\s*(?:https?:)?\/\//gi, 'стиль или шрифт с чужого сайта'],
  [/@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\//gi, 'стиль с чужого сайта'],
];

const lineAtIndex = (text, index) => text.slice(0, index).split('\n').length;

export function pageProblems(text) {
  const src = String(text ?? '');
  const found = [];
  for (const [re, what] of EXTERNAL) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      found.push({ line: lineAtIndex(src, m.index), why: `${what}: страница берёт файлы только из своей папки public (набор ui/)` });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// ---------- проверка: db/*.sql ----------

// Комментарии SQL заменяются пробелами (переводы строк остаются: номера строк те же), строки в '...' не трогаются.
export function stripSqlComments(text) {
  const src = String(text ?? '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('--', i)) {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (src[i] === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") j += 2;
        else if (src[j] === "'") break;
        else j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

const SQL_NAME = String.raw`((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)`;
const normSqlName = (name) => name.replace(/"/g, '').replace(/\s+/g, '').toLowerCase();
const OBJECT_RE = new RegExp(
  String.raw`\b(create|alter|drop)\s+(?:or\s+replace\s+)?(?:(?:temporary|temp|unlogged|materialized)\s+)*(table|view|sequence|function|procedure)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?` + SQL_NAME,
  'gi',
);
const INDEX_ON_RE = new RegExp(
  String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:(?:"[^"]+"|[\w$]+)\s+)?on\s+(?:only\s+)?` + SQL_NAME,
  'gi',
);
const INDEX_NAME_RE = new RegExp(String.raw`\b(alter|drop)\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?` + SQL_NAME, 'gi');
const SCHEMA_RE = /\bcreate\s+schema\s+(?:if\s+not\s+exists\s+)?("[^"]+"|[\w$]+)/gi;
const OBJECT_WORD = { table: 'таблица', view: 'представление', sequence: 'последовательность', function: 'функция', procedure: 'процедура', index: 'индекс' };

// Миграция db/*.sql: только объекты схемы app, без удаления схем, выдачи прав наружу и ролей. [{ line, why }].
export function sqlFileProblems(text) {
  const src = stripSqlComments(text);
  const found = [];
  const add = (index, why) => found.push({ line: lineAtIndex(src, index), why });
  const outside = (name, what) => {
    const n = normSqlName(name);
    const base = n.split('.').pop();
    return `${what} ${n} вне схемы app: объекты сервиса только в схеме app, пишите app.${base}`;
  };
  for (const m of src.matchAll(OBJECT_RE)) {
    if (!normSqlName(m[3]).startsWith('app.')) add(m.index, outside(m[3], OBJECT_WORD[m[2].toLowerCase()]));
  }
  for (const m of src.matchAll(INDEX_ON_RE)) {
    if (!normSqlName(m[1]).startsWith('app.')) add(m.index, outside(m[1], 'индекс на таблицу'));
  }
  for (const m of src.matchAll(INDEX_NAME_RE)) {
    if (!normSqlName(m[2]).startsWith('app.')) add(m.index, outside(m[2], 'индекс'));
  }
  for (const m of src.matchAll(SCHEMA_RE)) {
    if (normSqlName(m[1]) !== 'app') add(m.index, `схема ${normSqlName(m[1])}: у сервиса одна схема app`);
  }
  for (const m of src.matchAll(/\bdrop\s+schema\b/gi)) add(m.index, 'drop schema: удалять схему базы нельзя');
  for (const m of src.matchAll(/\bgrant\b[^;]*/gi)) {
    const parts = m[0].split(/\bto\b/i);
    if (parts.length > 1 && /\b(anon|authenticated|public)\b/i.test(parts[parts.length - 1])) {
      add(m.index, 'grant ... to anon, authenticated или public: данные сервиса закрыты для всех, кроме роли сервиса');
    }
  }
  for (const m of src.matchAll(/\b(create|alter|drop)\s+(role|user)\b/gi)) {
    add(m.index, `${m[1].toLowerCase()} ${m[2].toLowerCase()}: роль базы заводит только кабинет (web.mjs secret)`);
  }
  return found.sort((a, b) => a.line - b.line);
}

// ---------- проверка: программа Python ----------

function pyFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 8 || out.length > 300) return;
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_ANY.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && SKIP_TOP.has(e.name)) continue;
        walk(p, depth + 1);
      } else if (e.isFile() && /\.py$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort();
}

const NOT_ALLOWED_WEB = 'библиотека не из списка (стандартный Python, web, db, read_table, openpyxl, свои файлы .py проекта)';

const webWhy = (why) => {
  if (why.startsWith('библиотека не из списка')) return NOT_ALLOWED_WEB;
  if (why.startsWith('модель только через')) return 'модель в сервисе для интернета недоступна: такой расчёт остаётся в сервисе на компьютере';
  if (why.startsWith('своя страница или сервер')) return 'свой сервер в программе: адреса /api даёт lib/web.py (serve)';
  return why.replace('путь вне кабинета', 'путь вне проекта');
};

const EXTRA_RULES = [
  [/^\s*(?:import\s+[^#\n]*\bsocket\b|from\s+socket\s+import)|\bsocket\s*\./, 'прямые сетевые соединения (socket) в сервисе для интернета нельзя'],
  [/^\s*(?:import\s+[^#\n]*\bllm\b|from\s+llm\b)/, 'модель (llm) в сервисе для интернета недоступна: такой расчёт остаётся в сервисе на компьютере'],
  [/^\s*(?:import\s+[^#\n]*\bservice_api\b|from\s+service_api\b)/, 'service_api только для страницы сервиса на компьютере: действия пишутся через serve из lib/web.py'],
];

// Программа сервиса: [{ line, text, why }] по правилам программ кабинета, правилам web и проверке SQL.
export function webCodeProblems(text, { allowImports = [] } = {}) {
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);
  const byLine = new Map();
  const put = (line, why) => {
    if (!byLine.has(line)) byLine.set(line, []);
    const list = byLine.get(line);
    if (!list.includes(why)) list.push(why);
  };
  for (const x of programProblems(src, { allowImports: [...WEB_ALLOW, ...allowImports] })) put(x.line, webWhy(x.why));
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line) || byLine.has(i + 1)) return;
    const rule = EXTRA_RULES.find(([re]) => re.test(line));
    if (rule) put(i + 1, rule[1]);
  });
  for (const x of sqlProblems(src)) put(x.line, x.why);
  const out = [];
  for (const [line, whys] of [...byLine].sort((a, b) => a[0] - b[0])) {
    for (const why of whys) out.push({ line, text: (lines[line - 1] ?? '').trim(), why });
  }
  return out;
}

function filesUnder(dir, test, depth = 0, out = []) {
  if (depth > 8 || out.length > 500) return out;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, test, depth + 1, out);
    else if (e.isFile() && test(e.name)) out.push(p);
  }
  return out.sort();
}

// Проверка проекта сервиса вида web: { ok, kind, problems: [{ file, line, why, text? }] }. line 0: файл целиком.
export function checkWebProject(root, dir) {
  const problems = [];
  const add = (file, line, why, text) => problems.push(text ? { file, line, why, text } : { file, line, why });
  const { service, error } = readService(dir);
  let kind = null;
  if (error) add('service.json', 0, error);
  else {
    kind = typeof service.kind === 'string' ? service.kind : null;
    if (kind !== 'web') add('service.json', 0, 'kind: у сервиса для интернета нужно "web"');
    if (typeof service.name !== 'string' || !service.name.trim()) add('service.json', 0, 'name: нужно название сервиса строкой');
    const api = relPath(service.api);
    if (!api || !/\.py$/i.test(api[api.length - 1])) add('service.json', 0, 'api: нужен файл действий сервиса, например "api/index.py"');
    else if (api[0].toLowerCase() === 'lib') add('service.json', 0, 'api: файл действий не может лежать в папке lib (её кладёт кабинет)');
    else if (!isFile(join(dir, ...api))) add(api.join('/'), 0, `нет файла ${api.join('/')}: в нём действия сервиса`);
    else if (!/^class\s+handler\s*\(/m.test(readText(join(dir, ...api)) ?? '')) {
      // Vercel находит вход только по классу handler: строку handler = serve(...) сборка не видит.
      add(api.join('/'), 0, 'нет класса handler: в конце файла нужно class handler(serve({...})): (иначе Vercel не соберёт сервис)');
    }
    if (service.page !== undefined && service.page !== null && service.page !== '') {
      add('service.json', 0, 'page: у сервиса для интернета страница в папке public, поставьте "page": null');
    }
  }
  if (!isFile(join(dir, 'public', 'index.html'))) add('public/index.html', 0, 'нет файла public/index.html: с него открывается сайт сервиса');
  if (!isFile(join(dir, 'vercel.json'))) add('vercel.json', 0, 'нет файла vercel.json: скажите в кабинете «обнови кабинет»');
  for (const name of ['web.py', 'db.py']) {
    if (!isFile(join(dir, 'lib', name))) add(`lib/${name}`, 0, `в папке lib нет ${name}: скажите в кабинете «обнови кабинет»`);
  }
  // Программа: все .py вне lib, input, output, public, old и скрытых папок.
  const files = pyFiles(dir);
  const own = new Set();
  for (const f of files) {
    const stem = basename(f).replace(/\.py$/i, '');
    if (stem === '__init__') {
      const pkg = basename(dirname(f));
      if (IDENT.test(pkg)) own.add(pkg);
    } else if (IDENT.test(stem)) own.add(stem);
  }
  for (const n of LIB_NAMES) own.delete(n);
  for (const f of files) {
    const name = rel(dir, f);
    const stem = basename(f).replace(/\.py$/i, '');
    if (LIB_NAMES.has(stem)) add(name, 0, `имя ${basename(f)} занято помощником из lib (web, db, read_table): переименуйте файл`);
    let text;
    try {
      if (statSync(f).size > 1024 * 1024) {
        add(name, 0, 'файл больше 1 МБ, такой не проверить');
        continue;
      }
      text = readFileSync(f, 'utf8');
    } catch {
      add(name, 0, 'файл не читается');
      continue;
    }
    for (const x of webCodeProblems(text, { allowImports: [...own] })) add(name, x.line, x.why, x.text);
  }
  // Страница: внешние скрипты и стили.
  for (const f of filesUnder(join(dir, 'public'), (n) => /\.(html?|css)$/i.test(n))) {
    const text = readText(f) ?? '';
    for (const x of pageProblems(text)) add(rel(dir, f), x.line, x.why);
  }
  // База: db/*.sql.
  let sqlFiles = [];
  try {
    sqlFiles = readdirSync(join(dir, 'db'), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.sql$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    // папки db нет: таблиц у сервиса нет
  }
  for (const n of sqlFiles) {
    for (const x of sqlFileProblems(readText(join(dir, 'db', n)) ?? '')) add(`db/${n}`, x.line, x.why);
  }
  return { ok: problems.length === 0, kind, problems };
}

// ---------- личные данные ----------

const PII_COLUMNS = [
  ['ФИО', ['фио', 'fio', 'имя', 'imya', 'отчество'], ['фамил', 'famil', 'отчеств', 'otchestv', 'surname', 'lastname', 'firstname', 'fullname']],
  ['ИИН', ['иин', 'iin'], []],
  ['ИНН', ['инн', 'inn'], []],
  ['телефон', ['тел', 'tel', 'моб', 'mob'], ['телеф', 'telef', 'phone', 'мобил', 'mobil']],
  ['почта', ['email', 'mail', 'почта', 'pochta'], ['почт', 'email']],
  ['адрес', [], ['адрес', 'adres', 'address']],
  ['паспорт', [], ['паспорт', 'pasport', 'passport']],
  ['дата рождения', [], ['рожд', 'rozhd', 'birth']],
];

// Вид личных данных по названию столбца («ФИО клиента», «telefon», «E-mail») или null.
export function columnPiiKind(name) {
  const tokens = String(name ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[eе]-mail/g, 'email')
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean);
  for (const [kind, exact, prefixes] of PII_COLUMNS) {
    if (tokens.some((t) => exact.includes(t) || prefixes.some((p) => t.startsWith(p)))) return kind;
  }
  return null;
}

const VALUE_PII = [
  ['ИИН', /(?<![\d.,])\d{12}(?!\d|[.,]\d)/],
  ['телефон', /(?<![\d+])(?:\+\s*7|8)[\s\-()]*\d(?:[\s\-()]*\d){9}(?!\d|[.,]\d)/],
  ['почта', /[^\s@<>()"',;:]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
];

// Вид личных данных по значению ячейки (12 цифр ИИН, телефон +7 или 8 и 10 цифр, почта) или null.
export function valuePiiKind(value) {
  const text = String(value ?? '');
  if (!text.trim()) return null;
  return VALUE_PII.find(([, re]) => re.test(text))?.[0] ?? null;
}

// Столбцы таблиц из create table и alter table ... add в тексте SQL: [{ table, column, line }].
export function sqlColumns(text) {
  const src = stripSqlComments(text);
  const out = [];
  const createRe = new RegExp(String.raw`\bcreate\s+(?:(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?` + SQL_NAME + String.raw`\s*\(`, 'gi');
  const SKIP = new Set(['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude', 'like']);
  for (const m of src.matchAll(createRe)) {
    const table = normSqlName(m[1]);
    let i = m.index + m[0].length;
    let depth = 0;
    let start = i;
    const items = [];
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "'") {
        i = src.indexOf("'", i + 1);
        if (i < 0) break;
      } else if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) {
          items.push([start, src.slice(start, i)]);
          break;
        }
        depth--;
      } else if (c === ',' && depth === 0) {
        items.push([start, src.slice(start, i)]);
        start = i + 1;
      }
    }
    for (const [pos, item] of items) {
      const first = /^\s*("[^"]+"|[\w$]+)/.exec(item);
      if (!first) continue;
      const col = first[1].replace(/"/g, '');
      if (SKIP.has(col.toLowerCase())) continue;
      out.push({ table, column: col, line: lineAtIndex(src, pos + first[0].length) });
    }
  }
  const alterRe = new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?` + SQL_NAME + String.raw`\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?("[^"]+"|[\w$]+)`, 'gi');
  for (const m of src.matchAll(alterRe)) {
    const col = m[2].replace(/"/g, '');
    if (SKIP.has(col.toLowerCase())) continue;
    out.push({ table: normSqlName(m[1]), column: col, line: lineAtIndex(src, m.index) });
  }
  return out;
}

function inputTables(dir) {
  return filesUnder(join(dir, 'input'), (n) => TABLE_EXT.has(extname(n).toLowerCase()));
}

// Таблица через tools/read_table.py --json: { data } или { error }.
export function readTableJson(root, python, file, { rows = PII_ROWS, sheet } = {}) {
  if (!python) return { error: 'не нашёлся Python на этом компьютере' };
  const args = [join(root, 'tools', 'read_table.py'), file, '--rows', String(rows), '--json'];
  if (sheet !== undefined && sheet !== null) args.push('--sheet', String(sheet));
  const r = spawnSync(python, args, {
    cwd: dirname(file),
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  let data = null;
  try {
    data = JSON.parse(String(r.stdout ?? '').trim());
  } catch {
    // ниже: файл не прочитался
  }
  if (isObj(data) && typeof data.error === 'string') return { error: data.error };
  if (r.status !== 0 || !isObj(data)) {
    const why = String(r.stderr ?? '').trim().split(/\r?\n/).pop() || (r.error ? String(r.error.code ?? r.error.message) : 'файл не прочитался');
    return { error: why };
  }
  return { data };
}

// Все листы файла: [{ sheet, data }] или { error }.
function readAllSheets(root, python, file, rows) {
  const first = readTableJson(root, python, file, { rows });
  if (first.error) return first;
  const sheets = Array.isArray(first.data.sheets) ? first.data.sheets : [];
  const out = [{ sheet: sheets.length > 1 ? first.data.sheet?.name ?? null : null, data: first.data }];
  for (const s of sheets.slice(1)) {
    const r = readTableJson(root, python, file, { rows, sheet: s.index });
    if (r.error) continue;
    out.push({ sheet: s.name ?? String(s.index), data: r.data });
  }
  return { list: out };
}

// Личные данные сервиса: { found: [{ where, column, kind, sheet?, table? }], unread: [{ where, why }] }.
export async function findPii(root, dir, { python } = {}) {
  const found = [];
  const unread = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.where}|${item.sheet ?? ''}|${item.column}|${item.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(item);
  };
  let sqlFiles = [];
  try {
    sqlFiles = readdirSync(join(dir, 'db')).filter((n) => /\.sql$/i.test(n)).sort();
  } catch {
    // нет папки db
  }
  for (const n of sqlFiles) {
    for (const c of sqlColumns(readText(join(dir, 'db', n)) ?? '')) {
      const kind = columnPiiKind(c.column);
      if (kind) push({ where: `db/${n}`, table: c.table, column: c.column, kind });
    }
  }
  const files = inputTables(dir);
  const exe = files.length ? (python ?? (await findPython(root))) : null;
  for (const f of files) {
    const where = rel(dir, f);
    const r = readAllSheets(root, exe, f, PII_ROWS);
    if (r.error) {
      unread.push({ where, why: r.error });
      continue;
    }
    for (const { sheet, data } of r.list) {
      const columns = Array.isArray(data.columns) ? data.columns.map((c) => String(c ?? '')) : [];
      const extra = sheet ? { sheet } : {};
      columns.forEach((c) => {
        const kind = columnPiiKind(c);
        if (kind) push({ where, column: c, kind, ...extra });
      });
      for (const row of Array.isArray(data.rows) ? data.rows : []) {
        if (!Array.isArray(row)) continue;
        row.forEach((v, k) => {
          const kind = valuePiiKind(v);
          if (kind) push({ where, column: columns[k] || `столбец ${k + 1}`, kind, ...extra });
        });
      }
    }
  }
  return { found, unread };
}

// ---------- ключ базы ----------

// SCRAM-SHA-256 по RFC 5802 и 7677 в виде, который Postgres хранит в pg_authid и принимает в password '...'.
export function scramVerifier(password, salt = randomBytes(16), iterations = SCRAM_ITERATIONS) {
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt);
  const salted = pbkdf2Sync(Buffer.from(String(password), 'utf8'), saltBuf, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${saltBuf.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

// Роль базы сервиса: app_<имя папки латиницей, дефис как подчёркивание>, не длиннее 63 знаков.
export function roleName(dir) {
  return `app_${(slugify(basename(dir)) || 'servis').replace(/-/g, '_')}`.slice(0, 63);
}

export function roleSql(role, verifier) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw webError('EROLE', `Имя роли ${role} не подходит.`);
  if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw webError('EROLE', 'Хэш пароля роли не похож на SCRAM-SHA-256.');
  return [
    'do $$ begin',
    `  if not exists (select from pg_roles where rolname = '${role}') then`,
    `    create role ${role} login password '${verifier}';`,
    '  else',
    `    alter role ${role} password '${verifier}';`,
    '  end if;',
    'end $$;',
    'create schema if not exists app;',
    `grant usage, create on schema app to ${role};`,
    `grant select, insert, update, delete on all tables in schema app to ${role};`,
    `grant usage, select on all sequences in schema app to ${role};`,
    `alter default privileges in schema app grant select, insert, update, delete on tables to ${role};`,
    `alter default privileges in schema app grant usage, select on sequences to ${role};`,
    'revoke all on schema app from anon, authenticated;',
    `alter role ${role} set search_path = app, public;`,
    `alter role ${role} set statement_timeout = '8s';`,
  ].join('\n');
}

const REF_RE = /^[a-z0-9]{6,40}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// Ключ базы: пароль роли (новый или прежний), DATABASE_URL и SERVICE_COOKIE_SECRET в .env, SQL для базы.
// { role, sql, database_url, cookie_secret, changed }. Без rotate и с DATABASE_URL этой роли пароль остаётся прежним.
export function makeSecret(dir, { ref, host, port = 6543, rotate = false } = {}) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) throw webError('EARG', 'Укажите --ref: код проекта Supabase, строчные латинские буквы и цифры.');
  if (typeof host !== 'string' || !HOST_RE.test(host)) throw webError('EARG', 'Укажите --host: адрес пула базы, например aws-0-eu-central-1.pooler.supabase.com.');
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw webError('EARG', 'Номер после --port: целое число, обычно 6543.');
  const role = roleName(dir);
  const env = readEnv(dir);
  let password = null;
  const cur = env.get('DATABASE_URL');
  if (cur && !rotate) {
    try {
      const u = new URL(cur);
      const user = decodeURIComponent(u.username);
      if (user === role || user.startsWith(`${role}.`)) password = decodeURIComponent(u.password) || null;
    } catch {
      // адрес не читается: заводим новый пароль
    }
  }
  const changed = !password;
  if (!password) password = randomBytes(32).toString('base64url');
  const database_url = `postgresql://${role}.${ref}:${encodeURIComponent(password)}@${host}:${p}/postgres?sslmode=require`;
  const kv = { DATABASE_URL: database_url };
  const cookie_secret = env.get('SERVICE_COOKIE_SECRET') || randomBytes(32).toString('base64url');
  if (!env.get('SERVICE_COOKIE_SECRET')) kv.SERVICE_COOKIE_SECRET = cookie_secret;
  writeEnv(dir, kv);
  return { role, sql: roleSql(role, scramVerifier(password)), database_url, cookie_secret, changed };
}

// ---------- код доступа ----------

// Как norm_code в lib/web.py: без учёта регистра, пробелы и подчёркивания как дефис.
export function normCode(code) {
  return String(code ?? '')
    .trim()
    .toLowerCase()
    .split(/[\s_-]+/)
    .join('-')
    .replace(/^-+|-+$/g, '');
}

// Хэш кода в формате lib/web.py hash_code: pbkdf2$<итерации>$<соль hex>$<хэш hex>, соль как строка ASCII.
export function accessCodeHash(code, salt = randomBytes(16).toString('hex'), iterations = CODE_ITERATIONS) {
  const dk = pbkdf2Sync(Buffer.from(normCode(code), 'utf8'), Buffer.from(String(salt), 'ascii'), iterations, 32, 'sha256');
  return `pbkdf2$${iterations}$${salt}$${dk.toString('hex')}`;
}

export function accessCodeOk(code, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000) return false;
  const want = Buffer.from(accessCodeHash(code, parts[2], iterations));
  const got = Buffer.from(String(stored));
  return want.length === got.length && timingSafeEqual(want, got);
}

export function loadWords(root = ROOT) {
  const text = readText(join(root, 'tools', 'words.txt'));
  if (text === null) throw webError('ENOWORDS', 'Нет словаря tools/words.txt в кабинете: скажите Claude «обнови кабинет».');
  return [...new Set(text.split(/\r?\n/).map((w) => w.trim()).filter((w) => /^[a-z]{3,7}$/.test(w)))];
}

// Три разных слова из словаря через дефис.
export function newAccessCode(words) {
  if (!Array.isArray(words) || words.length < 3) throw webError('ENOWORDS', 'В словаре кодов меньше трёх слов.');
  const picked = [];
  while (picked.length < 3) {
    const w = words[randomInt(words.length)];
    if (!picked.includes(w)) picked.push(w);
  }
  return picked.join('-');
}

// Код доступа в .env: { code, hash, changed }. Код уже есть и нет rotate: прежний код (хэш дописывается, если нет).
// Подписи cookie (SERVICE_COOKIE_SECRET) нет: она дописывается, иначе вход по коду на компьютере отвечал бы 503
// до создания базы («покажи сервис» сразу после «новый сервис»). Есть: не меняется (её же берёт secret).
export function makeCode(root, dir, { rotate = false } = {}) {
  const env = readEnv(dir);
  const extra = env.get('SERVICE_COOKIE_SECRET') ? {} : { SERVICE_COOKIE_SECRET: randomBytes(32).toString('base64url') };
  const cur = normCode(env.get('SERVICE_ACCESS_CODE') ?? '');
  if (cur && !rotate) {
    let hash = env.get('SERVICE_ACCESS_CODE_HASH') ?? '';
    const kv = { ...extra };
    if (!accessCodeOk(cur, hash)) {
      hash = accessCodeHash(cur);
      kv.SERVICE_ACCESS_CODE_HASH = hash;
    }
    if (Object.keys(kv).length) writeEnv(dir, kv);
    return { code: cur, hash, changed: false };
  }
  const code = newAccessCode(loadWords(root));
  const hash = accessCodeHash(code);
  writeEnv(dir, { SERVICE_ACCESS_CODE: code, SERVICE_ACCESS_CODE_HASH: hash, ...extra });
  return { code, hash, changed: true };
}

// ---------- страница на этом компьютере ----------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function healthy(url, timeoutMs = 1500) {
  return new Promise((done) => {
    let target;
    try {
      target = new URL('api/health', url);
    } catch {
      return done(false);
    }
    if (target.hostname !== '127.0.0.1') return done(false);
    const req = http.get(target, { timeout: timeoutMs }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(false));
  });
}

// Похож ли процесс на страницу сервиса (на Windows не проверить: только по ответу страницы).
function looksLikeDev(pid) {
  if (process.platform === 'win32') return false;
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && /web_dev\.py/.test(r.stdout ?? '');
}

function killPid(pid) {
  if (process.platform === 'win32') {
    spawnSync(TASKKILL, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // уже остановлен
    }
  }
}

const devStatePath = (dir) => join(dir, ...DEV_STATE);
const readDevState = (dir) => {
  const r = readJsonFile(devStatePath(dir));
  return isObj(r.data) && Number.isInteger(r.data.pid) && typeof r.data.url === 'string' ? r.data : null;
};

const pendingDev = new Map();

// Страница сервиса на этом компьютере: python lib/web_dev.py отдельным процессом, вывод в output/web-dev.log.
// Один процесс на проект: уже работает (процесс жив и /api/health отвечает) → { url, pid, already: true }.
export function startDev(root, dir, opts = {}) {
  const key = resolve(dir);
  if (pendingDev.has(key)) return pendingDev.get(key);
  const p = startDevNow(root, key, opts).finally(() => pendingDev.delete(key));
  pendingDev.set(key, p);
  return p;
}

async function startDevNow(root, dir, { python, env = {}, timeoutMs = DEV_TIMEOUT_MS } = {}) {
  const state = readDevState(dir);
  if (state && pidAlive(state.pid)) {
    if (await healthy(state.url)) return { url: state.url, pid: state.pid, already: true };
    if (looksLikeDev(state.pid)) killPid(state.pid);
  }
  if (!isFile(join(dir, 'lib', 'web_dev.py'))) throw webError('ELIB', 'В папке lib нет web_dev.py: скажите в кабинете «обнови кабинет».');
  const exe = python ?? (await findPython(root));
  if (!exe) throw webError('ENOPYTHON', 'Не нашёлся Python на этом компьютере: скажите в кабинете «проверь сетап».');
  mkdirSync(join(dir, 'output'), { recursive: true });
  const logPath = join(dir, ...DEV_LOG);
  const fd = openSync(logPath, 'w');
  let child;
  try {
    child = spawn(exe, [join('lib', 'web_dev.py')], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', ...env },
    });
  } finally {
    closeSync(fd);
  }
  let exited = null;
  child.on('exit', (code) => {
    exited = code ?? -1;
  });
  child.on('error', (e) => {
    exited = e.code ?? 'error';
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  const lastLine = (text) => String(text ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  while (Date.now() < deadline) {
    const text = readText(logPath) ?? '';
    const m = /Страница работает: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(text);
    if (m) {
      writeFileAtomic(devStatePath(dir), JSON.stringify({ pid: child.pid, url: m[1], started_at: new Date().toISOString() }, null, 2) + '\n');
      return { url: m[1], pid: child.pid, already: false };
    }
    if (exited !== null) {
      throw webError('EDEV', `Страница сервиса не запустилась: ${lastLine(text) || 'подробности в output/web-dev.log'}`);
    }
    await sleep(100);
  }
  killPid(child.pid);
  throw webError('EDEV', `Страница сервиса не запустилась за ${Math.round(timeoutMs / 1000)} с: подробности в output/web-dev.log`);
}

// Остановить страницу сервиса на этом компьютере: { stopped }. Чужой процесс с тем же номером не трогается.
export async function stopDev(dir) {
  const state = readDevState(dir);
  let stopped = false;
  if (state && pidAlive(state.pid) && (looksLikeDev(state.pid) || (await healthy(state.url)))) {
    killPid(state.pid);
    stopped = true;
  }
  rmSync(devStatePath(dir), { force: true });
  return { stopped };
}

// ---------- состояние ----------

function git(dir, args) {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return r.status === 0 ? String(r.stdout ?? '').trim() : null;
}

// Адрес удалённого репозитория без логина и пароля внутри.
const cleanRemote = (url) => {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]+@/, '//');
  }
};

export function gitState(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  let own = false;
  if (top) {
    try {
      own = samePath(realpathSync(top), realpathSync(dir));
    } catch {
      own = false;
    }
  }
  if (!own) return { repo: false, remote: null, branch: null, dirty: false };
  const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']) ?? git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = git(dir, ['status', '--porcelain']);
  return { repo: true, remote: cleanRemote(git(dir, ['remote', 'get-url', 'origin'])), branch, dirty: Boolean(porcelain) };
}

// { kind, template_version, published, publish, env: { КЛЮЧ: есть ли }, git, dev }: значения ключей не отдаются.
export async function webStatus(dir) {
  const { service } = readService(dir);
  const env = readEnv(dir);
  const publish = isObj(service?.publish) ? service.publish : null;
  const state = readDevState(dir);
  const devUp = Boolean(state && pidAlive(state.pid) && (await healthy(state.url)));
  return {
    kind: typeof service?.kind === 'string' ? service.kind : null,
    template_version: typeof service?.template_version === 'string' ? service.template_version : null,
    published: Boolean(publish && typeof publish.url === 'string' && publish.url),
    publish,
    env: Object.fromEntries(ENV_KEYS.map((k) => [k, Boolean(env.get(k))])),
    git: gitState(dir),
    dev: devUp ? { url: state.url, pid: state.pid } : null,
  };
}

// ---------- план перевода сервиса с компьютера в интернет ----------

const NUMBER_RE = /^[-+]?\d+(?:\.\d+)?$/;
const TIME_TAIL = String.raw`(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?`;
const DATE_DMY = new RegExp(String.raw`^\d{1,2}\.\d{1,2}\.\d{4}` + TIME_TAIL + '$');
const DATE_ISO = new RegExp(String.raw`^\d{4}-\d{1,2}-\d{1,2}` + TIME_TAIL + '$');
const isNumber = (v) => NUMBER_RE.test(String(v).split(/\s+/).join('').replaceAll(',', '.'));
const isDate = (v) => DATE_DMY.test(String(v).trim()) || DATE_ISO.test(String(v).trim());
const PG_RESERVED = new Set(
  ('all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_date ' +
    'current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch ' +
    'for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null ' +
    'offset on only or order placing primary references returning select session_user some symmetric table then to trailing ' +
    'true union unique user using variadic when where window with').split(' '),
);

// Тип столбца по значениям: numeric (все непустые числа), date (все даты), иначе text.
// Пометки «нет значения» в выгрузках (н/д, -, n/a) тип не решают.
const EMPTY_MARKS = new Set(['-', 'н/д', 'нд', 'n/a', 'na', 'нет данных']);

export function guessType(values) {
  const vals = values.map((v) => String(v ?? '').trim()).filter((v) => v && !EMPTY_MARKS.has(v.toLowerCase()));
  if (!vals.length) return 'text';
  if (vals.every(isNumber)) return 'numeric';
  if (vals.every(isDate)) return 'date';
  return 'text';
}

const sqlIdent = (text, fallback, digitPrefix = 'c_') => {
  let s = slugify(text).replace(/-/g, '_');
  if (!s) s = fallback;
  if (/^\d/.test(s)) s = `${digitPrefix}${s}`;
  if (PG_RESERVED.has(s)) s = `${s}_`;
  return s.slice(0, 63);
};

const freeIdent = (name, taken) => {
  let n = name;
  for (let k = 2; taken.has(n); k++) n = `${name.slice(0, 60)}_${k}`;
  taken.add(n);
  return n;
};

function planTable(data, file, sheet, takenTables) {
  const titles = Array.isArray(data.columns) ? data.columns.map((c) => String(c ?? '')) : [];
  const rows = Array.isArray(data.rows) ? data.rows.filter(Array.isArray) : [];
  const stem = basename(file).replace(/\.[^.]+$/, '');
  const table = freeIdent(sqlIdent(sheet ? `${stem} ${sheet}` : stem, 'tablitsa', 't_'), takenTables);
  const taken = new Set(['id']);
  const columns = titles.map((title, k) => ({
    name: freeIdent(sqlIdent(title, `stolbets_${k + 1}`), taken),
    title,
    type: guessType(rows.map((r) => r[k])),
  }));
  const sql = [
    `create table if not exists app.${table} (`,
    ['  id serial primary key', ...columns.map((c) => `  ${c.name} ${c.type}`)].join(',\n'),
    ');',
  ].join('\n');
  return { table, file, sheet: sheet ?? null, rows: Number.isInteger(data.data_rows) ? data.data_rows : rows.length, columns, sql };
}

// Зовёт ли программа модель: вызов llm.ask( или ask_model( вне строки def ask_model и вне тела этой функции
// (каркас main.py импортирует llm и держит ask_model про запас: это ещё не вызов).
export function usesModel(text) {
  let body = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const indent = /^[ \t]*/.exec(line)[0].length;
    if (body !== null) {
      if (!line.trim() || indent > body) continue;
      body = null;
    }
    const def = /^([ \t]*)(?:async\s+)?def\s+ask_model\s*\(/.exec(line);
    if (def) {
      body = def[1].length;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    if (/\bllm\.ask\s*\(|\bask_model\s*\(/.test(line.replace(/#.*$/, ''))) return true;
  }
  return false;
}

// Для сервиса на компьютере (kind run или page): { tables, page, api, llm, unread }.
export async function migratePlan(root, dir, { python } = {}) {
  const { service } = readService(dir);
  const files = inputTables(dir);
  const exe = files.length ? (python ?? (await findPython(root))) : null;
  const tables = [];
  const unread = [];
  const takenTables = new Set();
  for (const f of files) {
    const where = rel(dir, f);
    const r = readAllSheets(root, exe, f, PII_ROWS);
    if (r.error) {
      unread.push({ where, why: r.error });
      continue;
    }
    for (const { sheet, data } of r.list) tables.push(planTable(data, where, sheet, takenTables));
  }
  const apiRel = relPath(service?.api) ?? ['api.py'];
  const llm = pyFiles(dir).some((f) => usesModel(readText(f) ?? ''));
  return { tables, page: isDir(join(dir, 'page')), api: isFile(join(dir, ...apiRel)), llm, unread };
}

// ---------- проверка после публикации ----------

export const PUBLISH_FIELDS = ['url', 'github', 'vercel_project', 'supabase_ref', 'published_at'];
const FETCH_TIMEOUT_MS = 15000;

// Первое действие из serve({...}) в файле действий: имя или null.
export function firstAction(text) {
  const src = String(text ?? '');
  const at = src.search(/\bserve\s*\(\s*\{/);
  if (at < 0) return null;
  return /["']([a-z0-9-]{1,40})["']\s*:/.exec(src.slice(at))?.[1] ?? null;
}

// Первая таблица из db/001_*.sql (без схемы) или null.
function firstTable(dir) {
  let names = [];
  try {
    names = readdirSync(join(dir, 'db')).filter((n) => /^001.*\.sql$/i.test(n)).sort();
  } catch {
    return null;
  }
  for (const n of names) {
    const cols = sqlColumns(readText(join(dir, 'db', n)) ?? '');
    if (cols.length) return cols[0].table.split('.').pop();
  }
  return null;
}

async function fetchText(url, init = {}) {
  try {
    const res = await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: '', error: e?.name === 'TimeoutError' ? 'нет ответа за 15 с' : String(e?.cause?.code ?? e?.message ?? e) };
  }
}

const trimUrl = (url) => String(url).replace(/\/+$/, '');

// Проверка опубликованного сервиса: { ok, checks: [{ id, title, ok, detail }] }.
// env: окружение с SUPABASE_URL и SUPABASE_ANON_KEY (по умолчанию process.env).
export async function verifyWeb(dir, { url, env = process.env } = {}) {
  const checks = [];
  const add = (id, title, ok, detail = '') => checks.push({ id, title, ok: Boolean(ok), detail });
  // 1. В git нет ключей и данных.
  const g = gitState(dir);
  if (!g.repo) add('git-files', 'В истории версий нет ключей и данных', false, 'в папке нет истории версий (git)');
  else {
    const list = (git(dir, ['ls-files', '-z']) ?? '').split('\0').filter(Boolean);
    const bad = list.filter((f) => {
      const name = f.split('/').pop();
      if (name === '.env' || name.startsWith('.env.')) return true;
      return /^(input|output)\//.test(f) && name !== '.gitkeep';
    });
    add('git-files', 'В истории версий нет ключей и данных', bad.length === 0, bad.length ? `лишние файлы: ${bad.slice(0, 10).join(', ')}` : `файлов в истории: ${list.length}`);
  }
  // 2. Паспорт публикации.
  const { service, error } = readService(dir);
  const publish = isObj(service?.publish) ? service.publish : {};
  const missing = PUBLISH_FIELDS.filter((k) => publish[k] === undefined || publish[k] === null || publish[k] === '');
  add('publish', 'В service.json записана публикация', !error && missing.length === 0, error ?? (missing.length ? `нет полей publish: ${missing.join(', ')}` : String(publish.url)));
  // 3. Сайт: health и закрытое действие.
  const site = url || (typeof publish.url === 'string' ? publish.url : '');
  if (site) {
    const h = await fetchText(`${trimUrl(site)}/api/health`);
    let body = null;
    try {
      body = JSON.parse(h.text);
    } catch {
      // не JSON
    }
    add('health', 'Сайт отвечает', h.status === 200 && isObj(body) && body.ok === true, h.error ?? `ответ ${h.status}`);
    const apiRel = relPath(service?.api) ?? ['api', 'index.py'];
    const action = firstAction(readText(join(dir, ...apiRel)));
    if (!action) add('closed', 'Без кода доступа данные не отдаются', false, `в ${apiRel.join('/')} нет serve({...}) с действием`);
    else {
      const r = await fetchText(`${trimUrl(site)}/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      add('closed', 'Без кода доступа данные не отдаются', r.status === 401, r.error ?? `действие ${action}: ответ ${r.status}`);
    }
  } else add('health', 'Сайт отвечает', false, 'нет адреса сайта: publish.url или --url');
  // 4. Автоматический API Supabase не видит таблиц сервиса.
  const base = env?.SUPABASE_URL;
  const key = env?.SUPABASE_ANON_KEY;
  if (base && key) {
    const table = firstTable(dir);
    if (!table) add('supabase-rest', 'Таблицы сервиса закрыты для публичного ключа', true, 'таблиц в db/001 нет');
    else {
      const r = await fetchText(`${trimUrl(base)}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      let rows = null;
      try {
        rows = JSON.parse(r.text);
      } catch {
        // не JSON
      }
      const closed = r.status !== 200 || (Array.isArray(rows) && rows.length === 0);
      add('supabase-rest', 'Таблицы сервиса закрыты для публичного ключа', closed, r.error ?? `таблица ${table}: ответ ${r.status}`);
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------- учётные записи публикации ----------

// Пишет me/publikaciya.json. Можно не всё сразу: «подключи базу» записывает только организацию Supabase,
// «подключи публикацию» потом добавит GitHub и Vercel. Не названное берётся из файла как было.
export function saveAccount(root, { github, vercelTeam, supabaseOrg, region } = {}) {
  const given = (v) => v !== undefined && v !== null && v !== '';
  if (given(github) && (typeof github !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(github))) throw webError('EARG', 'После --github нужен логин GitHub: латинские буквы, цифры и дефис.');
  if (given(vercelTeam) && (typeof vercelTeam !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(vercelTeam))) throw webError('EARG', 'После --vercel-team нужен код команды Vercel (team_...).');
  if (given(supabaseOrg) && (typeof supabaseOrg !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(supabaseOrg))) throw webError('EARG', 'После --supabase-org нужен код организации Supabase.');
  if (given(region) && (typeof region !== 'string' || !/^[a-z]{2}-[a-z]+-\d$/.test(region))) throw webError('EARG', 'Регион после --region, например eu-central-1.');
  if (!given(github) && !given(vercelTeam) && !given(supabaseOrg)) throw webError('EARG', 'Укажите хотя бы одно: --github, --vercel-team или --supabase-org.');
  const file = join(root, ...ACCOUNT_FILE);
  let old = {};
  try {
    const cur = JSON.parse(readFileSync(file, 'utf8'));
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) old = cur;
  } catch {
    // файла нет или он повреждён: пишем заново
  }
  const keep = (v, k) => (given(v) ? v : typeof old[k] === 'string' ? old[k] : null);
  const data = {
    github_login: keep(github, 'github_login'),
    vercel_team_id: keep(vercelTeam, 'vercel_team_id'),
    supabase_org_id: keep(supabaseOrg, 'supabase_org_id'),
    region: keep(region, 'region') ?? 'eu-central-1',
    checked_at: new Date().toISOString(),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
  return data;
}

// ---------- командная строка ----------

const USAGE = `Сервис для интернета:
  node tools/web.mjs check "<папка проекта>"
  node tools/web.mjs pii "<папка проекта>"
  node tools/web.mjs secret "<папка проекта>" --ref <код проекта Supabase> --host <адрес пула> [--port 6543] [--rotate]
  node tools/web.mjs code "<папка проекта>" [--rotate]
  node tools/web.mjs dev "<папка проекта>" [--stop]
  node tools/web.mjs status "<папка проекта>"
  node tools/web.mjs migrate-plan "<папка проекта>"
  node tools/web.mjs verify "<папка проекта>" [--url <адрес сайта>]
  node tools/web.mjs save-account [--github <логин>] [--vercel-team <код>] [--supabase-org <код>] [--region eu-central-1]  (не названное остаётся как было)
Добавьте --json, чтобы получить ответ одним объектом JSON.`;

export function parseArgs(argv) {
  const opts = { json: false, rotate: false, stop: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--json') opts.json = true;
    else if (a === '--rotate') opts.rotate = true;
    else if (a === '--stop') opts.stop = true;
    else if (/^--[a-z-]+=/.test(a)) {
      const eq = a.indexOf('=');
      opts[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (/^--[a-z-]+$/.test(a)) {
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith('--')) opts[a.slice(2)] = '';
      else {
        opts[a.slice(2)] = String(next);
        i++;
      }
    } else pos.push(a);
  }
  return { cmd: pos[0], dir: pos[1], opts };
}

const reply = (code, json, data, lines) => ({ code, text: json ? JSON.stringify(data, null, 2) : [lines].flat().join('\n') });

function needKind(dir, kinds, json) {
  const { service, error } = readService(dir);
  if (error) return reply(2, json, { error }, `В папке ${dir} ${error}: это не проект сервиса.`);
  if (!kinds.includes(service.kind)) {
    const why = kinds.includes('web')
      ? `Это сервис на компьютере (kind ${service.kind ?? 'не указан'}), а команда для сервиса в интернете: сначала скажите «опубликуй сервис».`
      : 'Этот сервис уже для интернета (kind web): переводить нечего.';
    return reply(2, json, { error: why, kind: service.kind ?? null }, why);
  }
  return null;
}

// Ключ базы: у сервиса для интернета и у сервиса на компьютере с базой (поле db, «подключи базу»).
function needDb(dir, json) {
  const { service, error } = readService(dir);
  if (error) return reply(2, json, { error }, `В папке ${dir} ${error}: это не проект сервиса.`);
  const db = typeof service.db === 'string' && service.db.trim() !== '';
  if (service.kind === 'web' || (['run', 'page'].includes(service.kind) && db)) return null;
  const why = 'У сервиса нет базы (поля db в service.json): скажите «подключи базу».';
  return reply(2, json, { error: why, kind: service.kind ?? null }, why);
}

const where = (x) => `${x.where}${x.sheet ? `, лист «${x.sheet}»` : ''}${x.table ? `, таблица ${x.table}` : ''}`;

async function run(cmd, dirArg, opts, { root, cwd }) {
  const json = opts.json;
  if (cmd === 'save-account') {
    const data = saveAccount(root, { github: opts.github, vercelTeam: opts['vercel-team'], supabaseOrg: opts['supabase-org'], region: opts.region });
    const no = (v) => v ?? 'не подключён';
    return reply(0, json, { ok: true, file: ACCOUNT_FILE.join('/'), ...data }, `Записано в ${ACCOUNT_FILE.join('/')}: GitHub ${no(data.github_login)}, Vercel ${no(data.vercel_team_id)}, Supabase ${no(data.supabase_org_id)}, регион ${data.region}.`);
  }
  const dir = projectDir(dirArg, cwd);
  if (cmd === 'check') {
    const gate = needKind(dir, ['web'], json);
    const c = checkWebProject(root, dir);
    if (gate && c.kind !== 'web') return { ...gate, text: json ? JSON.stringify({ ...c, ok: false }, null, 2) : gate.text };
    const lines = c.ok
      ? 'Проверка сервиса для интернета: замечаний нет.'
      : [`Проверка сервиса для интернета: замечаний ${c.problems.length}.`, ...c.problems.map((x) => `  ${x.file}${x.line ? `, строка ${x.line}` : ''}: ${x.why}${x.text ? `: ${x.text}` : ''}`)];
    return reply(c.ok ? 0 : 1, json, { ok: c.ok, problems: c.problems }, lines);
  }
  if (cmd === 'pii') {
    const r = await findPii(root, dir, { python: opts.python || undefined });
    const lines = [];
    if (r.found.length) lines.push(`Похоже на личные данные: ${r.found.length}.`, ...r.found.map((x) => `  ${where(x)}: столбец «${x.column}» (${x.kind})`));
    else lines.push(`Личных данных не видно: столбцы db/*.sql и первые ${PII_ROWS} строк файлов input проверены.`);
    if (r.unread.length) lines.push('Не прочитались, проверьте сами:', ...r.unread.map((x) => `  ${x.where}: ${x.why}`));
    return reply(r.found.length || r.unread.length ? 1 : 0, json, r, lines);
  }
  if (cmd === 'secret') {
    const gate = needDb(dir, json);
    if (gate) return gate;
    const r = makeSecret(dir, { ref: opts.ref, host: opts.host, port: opts.port || 6543, rotate: opts.rotate });
    return reply(0, json, r, [
      `Ключ базы записан в .env проекта: роль ${r.role}${r.changed ? ', новый пароль' : ', пароль прежний (новый: --rotate)'}.`,
      'SQL для базы:',
      r.sql,
      'DATABASE_URL для Vercel:',
      r.database_url,
    ]);
  }
  if (cmd === 'code') {
    const gate = needKind(dir, ['web'], json);
    if (gate) return gate;
    const r = makeCode(root, dir, { rotate: opts.rotate });
    return reply(0, json, r, `Код доступа: ${r.code}${r.changed ? ' (записан в .env проекта)' : ' (прежний, новый: --rotate)'}.`);
  }
  if (cmd === 'dev') {
    if (opts.stop) {
      const r = await stopDev(dir);
      return reply(r.stopped ? 0 : 2, json, r, r.stopped ? 'Страница сервиса на этом компьютере остановлена.' : 'Страница сервиса на этом компьютере не работала.');
    }
    const gate = needKind(dir, ['web'], json);
    if (gate) return gate;
    const r = await startDev(root, dir, { python: opts.python || undefined });
    return reply(0, json, { url: r.url, pid: r.pid, already: r.already }, `Страница работает: ${r.url}`);
  }
  if (cmd === 'status') {
    const { error } = readService(dir);
    const s = await webStatus(dir);
    if (error) return reply(2, json, { ...s, error }, `В папке ${dir} ${error}: это не проект сервиса.`);
    const keys = ENV_KEYS.filter((k) => s.env[k]);
    return reply(0, json, s, [
      `Вид сервиса: ${s.kind ?? 'не указан'}${s.template_version ? `, шаблон ${s.template_version}` : ''}.`,
      s.published ? `Опубликован: ${s.publish.url}` : 'Не опубликован.',
      `Ключи в .env: ${keys.length ? keys.join(', ') : 'нет'}.`,
      s.git.repo ? `История версий: ветка ${s.git.branch ?? 'нет'}, ${s.git.remote ? `репозиторий ${s.git.remote}` : 'репозитория в интернете нет'}${s.git.dirty ? ', есть несохранённые правки' : ''}.` : 'Истории версий (git) в папке нет.',
      ...(s.dev ? [`Страница работает: ${s.dev.url}`] : []),
    ]);
  }
  if (cmd === 'migrate-plan') {
    const gate = needKind(dir, ['run', 'page'], json);
    if (gate) return gate;
    const r = await migratePlan(root, dir, { python: opts.python || undefined });
    const lines = [`Таблиц для базы: ${r.tables.length}.`];
    for (const t of r.tables) lines.push(`  app.${t.table} из ${t.file}${t.sheet ? `, лист «${t.sheet}»` : ''}: ${t.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`);
    lines.push(`Своя страница: ${r.page ? 'есть' : 'нет'}. Действия api.py: ${r.api ? 'есть' : 'нет'}. Модель (llm): ${r.llm ? 'есть, такой сервис остаётся на компьютере' : 'нет'}.`);
    if (r.unread.length) lines.push('Не прочитались:', ...r.unread.map((x) => `  ${x.where}: ${x.why}`));
    return reply(r.unread.length ? 1 : 0, json, r, lines);
  }
  if (cmd === 'verify') {
    const r = await verifyWeb(dir, { url: opts.url || undefined });
    return reply(r.ok ? 0 : 1, json, r, [
      r.ok ? 'Проверка публикации: всё в порядке.' : 'Проверка публикации: есть замечания.',
      ...r.checks.map((c) => `  ${c.ok ? 'да' : 'НЕТ'}: ${c.title}${c.detail ? ` (${c.detail})` : ''}`),
    ]);
  }
  return reply(2, json, { error: 'неизвестная команда' }, USAGE);
}

const ARG_ERRORS = new Set(['ENOARG', 'ENODIR', 'EARG']);

// { code, text }: код выхода и что напечатать.
export async function main(argv = process.argv.slice(2), { root = ROOT, cwd = process.cwd() } = {}) {
  const { cmd, dir, opts } = parseArgs(argv);
  if (!cmd) return { code: 2, text: USAGE };
  try {
    return await run(cmd, dir, opts, { root, cwd });
  } catch (e) {
    const code = ARG_ERRORS.has(e.code) ? 2 : 1;
    const message = e.code ? e.message : `Сбой: ${e.message}`;
    return reply(code, opts.json, { error: message }, message);
  }
}

// Без await на верхнем уровне: поиск Python (processes.mjs) подгружает check.mjs, а через serve.mjs и
// services-api.mjs он снова ведёт сюда. Пока этот файл ждал бы main(), такой импорт не закончился бы никогда.
if (isMain(import.meta.url)) {
  for (const s of [process.stdout, process.stderr]) s.setDefaultEncoding?.('utf8');
  main().then(({ code, text }) => {
    process.stdout.write(text + '\n');
    process.exitCode = code;
  });
}
