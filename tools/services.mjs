// Сервисы-проекты: отдельные папки (по умолчанию Документы/Сервисы/<папка>) со своим service.json, программой
// и git. Кабинет их показывает и запускает: реестр me/servisy.json, карточка на странице «мой кабинет».
// Без зависимостей. Договор: active/program/plans/2026-10-30-servisy-proekty.md.
//
//   node tools/services.mjs new <название> [--dir <папка сервисов>]   новый проект из templates/service-project
//   node tools/services.mjs check <папка>    service.json и программа по правилам кабинета
//   node tools/services.mjs run <папка|имя>  запуск программы, как кнопкой «Запустить» на карточке
//   node tools/services.mjs add <папка>      проверка и запись в реестр кабинета (повторно: обновление)
//   node tools/services.mjs remove <имя>     убрать из кабинета (папку проекта не трогает)
//   node tools/services.mjs list             сервисы кабинета, результат и последний запуск
//
// Запуск: python <run> из папки проекта, свой Python кабинета (абсолютный путь вне кабинета и проекта), без
// оболочки, PYTHONPATH = <проект>/lib, UTF-8, не дольше 5 минут, замок <проект>/output/.running от двойного
// запуска, журнал <проект>/output/last-run.log. Перед запуском программа проверяется заново: правка после
// «добавь в кабинет» тоже проходит проверку. lib/llm.py и lib/read_table.py кабинет кладёт сам (new, add, run).
// Коды выхода как у processes.mjs: 0 готово, 1 есть что поправить или запуск не удался, 2 нечего делать
// (нет папки, нет сервиса, уже идёт).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import {
  DEFAULT_TIMEOUT_MS,
  LAST_RUN_FILE,
  LOCK_FILE,
  LOG_LIMIT_BYTES,
  MAX_CONCURRENT,
  SLUG_RE,
  findPython,
  isInside,
  killTree,
  programProblems,
  validateResult,
} from './processes.mjs';
import { appendJournal, folderSnapshot, journalFile, snapshotDiff } from './journal.mjs';

export const SERVICE_FILE = 'service.json';
export const REGISTRY = ['me', 'servisy.json'];
export const SERVICES_DIR_NAME = 'Сервисы';
export const TEMPLATE = ['templates', 'service-project'];
// ui.md: каталог набора интерфейса (tools/ui) для своей страницы сервиса, его читает Claude в проекте.
// design.md: правила понятной страницы и карточки, их читает Claude в проекте.
export const LIB_FILES = ['llm.py', 'read_table.py', 'service_api.py', 'ui.md', 'design.md'];
export const KINDS = ['run', 'page'];
export const PAGE_DIR = 'page';
export const OUTPUT_DIR = 'output';
// Что кабинет отдаёт статикой по адресу s/<slug>/: из page только эти виды, из output только эти.
export const PAGE_EXT = ['.html', '.js', '.css', '.json', '.png', '.svg'];
export const OUTPUT_EXT = ['.json', '.xlsx', '.docx', '.png', '.csv'];
export const DEFAULT_RESULT = 'output/result.json';
const NAME_MAX = 100;
const KILL_GRACE_MS = 5000;
const LOG_CHECK_MS = 200;
const STALE_MARGIN_MS = 60 * 1000;
const PROGRAM_SIZE_MAX = 1024 * 1024;
const PROGRAM_FILES_MAX = 200;
// Папки, которые не копируются из шаблона и не считаются своими модулями проекта.
const TEMPLATE_SKIP = new Set(['.git', '__pycache__', '.DS_Store', 'node_modules', 'Thumbs.db']);
const MODULE_SKIP = new Set(['lib', '__pycache__', 'node_modules', 'venv', 'env', 'site-packages', 'input', 'output', PAGE_DIR]);

const samePath = (a, b, platform = process.platform) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function serviceError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const lstatOrNull = (p) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

const sameBytes = (a, b) => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

// ---------- имя латиницей ----------

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // казахские буквы
  ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};

// «Сводка продаж по точкам» → svodka-prodazh-po-tochkam: строчные латинские буквы, цифры и дефис, до 40 знаков.
// Ничего латиницей не вышло: пустая строка.
export function slugify(text) {
  const latin = [...String(text ?? '').toLowerCase()]
    .map((ch) => (Object.hasOwn(TRANSLIT, ch) ? TRANSLIT[ch] : ch))
    .join('')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  let s = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 40) s = s.slice(0, 40).replace(/-+$/, '');
  return s;
}

// Свободное имя: base, base-2, base-3... taken(name) говорит, занято ли имя. Не больше 40 знаков.
function freeName(base, taken) {
  for (let n = 1; n < 1000; n++) {
    const tail = n === 1 ? '' : `-${n}`;
    const name = `${base.slice(0, 40 - tail.length).replace(/-+$/, '')}${tail}`;
    if (!taken(name)) return name;
  }
  throw serviceError('EMANY', 'Слишком много сервисов с похожим названием.');
}

// ---------- реестр me/servisy.json ----------

const registryPath = (root) => join(root, ...REGISTRY);

// { list, error, broken }: список записей { slug, name, path, kind, added_at }. Нет файла: пустой список.
// broken: файл не читается целиком, перезаписывать его нельзя (add и remove отказываются).
export function readRegistry(root) {
  let data;
  try {
    data = readJson(registryPath(root));
  } catch (e) {
    if (e.code === 'ENOENT') return { list: [], error: null, broken: false };
    return { list: [], error: `файл ${REGISTRY.join('/')} повреждён или не в формате JSON`, broken: true };
  }
  if (!Array.isArray(data)) return { list: [], error: `в файле ${REGISTRY.join('/')} нужен список JSON`, broken: true };
  const list = data.filter((e) => isObj(e) && typeof e.slug === 'string' && SLUG_RE.test(e.slug) && typeof e.path === 'string' && isAbsolute(e.path));
  return { list, error: list.length === data.length ? null : `в файле ${REGISTRY.join('/')} есть записи не по формату, они пропущены`, broken: false };
}

// Запись через временный файл: страница не прочитает половину.
function writeRegistry(root, list) {
  const file = registryPath(root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function findEntry(root, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  return readRegistry(root).list.find((e) => e.slug === slug) ?? null;
}

// ---------- service.json и проверка проекта ----------

// Относительный путь внутри проекта: части без пустых, «.», «..», «:» и \0, не абсолютный. Иначе null.
// Косая черта в конце (папка «page/») допускается.
function relParts(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!v || v.startsWith('/') || /^[A-Za-z]:/.test(v)) return null;
  const parts = v.split('/');
  if (parts[0] === '.' && parts.length > 1) parts.shift();
  return parts.every((p) => p && p !== '.' && p !== '..' && !p.includes(':') && !p.includes('\0')) ? parts : null;
}

// Файл результата из списка files: output/... проекта, без выхода наверх и скрытых файлов, вид из OUTPUT_EXT.
export function isProjectOutputFile(path) {
  if (typeof path !== 'string') return false;
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length < 2 || parts[0] !== OUTPUT_DIR) return false;
  if (!parts.every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes(':') && !s.startsWith('.'))) return false;
  return OUTPUT_EXT.includes(extname(parts[parts.length - 1]).toLowerCase());
}

// Схема карточки (как у процессов), только файлы лежат в output/ проекта.
export function validateServiceResult(obj) {
  if (!isObj(obj)) return validateResult(obj);
  const { files, ...rest } = obj;
  const errors = [...validateResult(rest).errors];
  if (files !== undefined) {
    if (!Array.isArray(files)) errors.push('files: нужен список путей к файлам');
    else {
      const bad = files.find((f) => !isProjectOutputFile(f));
      if (bad !== undefined) {
        errors.push(`files: путь ${JSON.stringify(bad)} должен вести в папку output/ проекта, файл ${OUTPUT_EXT.join(' ')}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// service.json без проверки программы: { info, problems }. info: { name, about, kind, run, result, input, page }
// с нормализованными путями (run и result: части пути, page: 'page' или null).
export function readServiceInfo(dir) {
  const problems = [];
  const file = join(dir, SERVICE_FILE);
  const st = lstatOrNull(file);
  if (!st) return { info: null, problems: [`нет файла ${SERVICE_FILE} в папке проекта`], missing: true };
  if (st.isSymbolicLink() || !st.isFile()) return { info: null, problems: [`${SERVICE_FILE} должен быть обычным файлом в папке проекта`] };
  let data;
  try {
    data = readJson(file);
  } catch {
    return { info: null, problems: [`${SERVICE_FILE} повреждён или не в формате JSON`] };
  }
  if (!isObj(data)) return { info: null, problems: [`в ${SERVICE_FILE} нужен объект JSON`] };
  const p = (text) => problems.push(`${SERVICE_FILE}: ${text}`);
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) p('name: нужно название сервиса строкой');
  else if (name.length > NAME_MAX) p(`name: название не длиннее ${NAME_MAX} знаков`);
  if (data.about !== undefined && data.about !== null && typeof data.about !== 'string') p('about: нужно описание строкой');
  const kind = KINDS.includes(data.kind) ? data.kind : null;
  if (!kind) p('kind: нужно "run" (кнопка «Запустить» и карточка) или "page" (своя страница)');
  let run = null;
  if (data.run !== undefined && data.run !== null && data.run !== '') {
    run = relParts(data.run);
    if (!run) p('run: путь к программе внутри проекта, без «..» и без диска, например "main.py"');
    else if (!/\.py$/i.test(run[run.length - 1])) p('run: программа должна быть файлом .py');
    else if (run[0].toLowerCase() === 'lib') p('run: программа не может лежать в папке lib (её кладёт кабинет)');
  } else if (kind === 'run') p('run: нужна программа .py, например "main.py"');
  // Серверная часть своей страницы: страница зовёт ../api/<действие>, кабинет запускает этот файл.
  let api = null;
  if (data.api !== undefined && data.api !== null && data.api !== '') {
    api = relParts(data.api);
    if (!api || !/\.py$/i.test(api[api.length - 1])) {
      p('api: серверная часть своей страницы, файл .py внутри проекта, например "api.py"');
      api = null;
    } else if (api[0].toLowerCase() === 'lib') {
      p('api: серверная часть не может лежать в папке lib (её кладёт кабинет)');
      api = null;
    }
  }
  let result = null;
  if (data.result !== undefined && data.result !== null && data.result !== '') {
    result = relParts(data.result);
    if (!result || result[0] !== OUTPUT_DIR || result.length < 2 || !/\.json$/i.test(result[result.length - 1])) {
      p(`result: файл .json в папке output проекта, например "${DEFAULT_RESULT}"`);
      result = null;
    }
  } else if (run) result = DEFAULT_RESULT.split('/');
  if (data.input !== undefined && data.input !== null && data.input !== '' && !relParts(data.input)) {
    p('input: папка внутри проекта, например "input/"');
  }
  let page = null;
  const pageSet = data.page !== undefined && data.page !== null && data.page !== '';
  if (kind === 'page') {
    const parts = pageSet ? relParts(data.page) : null;
    if (!parts || parts.length !== 1 || parts[0] !== PAGE_DIR) p(`page: у kind "page" нужна папка "${PAGE_DIR}/" внутри проекта`);
    else page = PAGE_DIR;
  } else if (kind === 'run' && pageSet) {
    p('page: своя страница только у kind "page"; у kind "run" поставьте "page": null');
  }
  const info = { name: name || basename(dir), about: typeof data.about === 'string' ? data.about.trim() : '', kind, run, result, input: data.input ?? null, page, api };
  return { info, problems };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMPORT_SCAN = /\bimport\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)|\bfrom\s+([\w.]+)\s+import\b/g;

function pyFilesIn(dir, out = [], depth = 0) {
  if (depth > 6 || out.length > PROGRAM_FILES_MAX) return out;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || TEMPLATE_SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) pyFilesIn(p, out, depth + 1);
    else if (e.isFile() && /\.py$/i.test(e.name)) out.push(p);
  }
  return out;
}

// Свои модули проекта: файл <имя>.py в корне или папка <имя> с __init__.py. { имя: [файлы] }.
function localModules(dir) {
  const map = new Map();
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && /\.py$/i.test(e.name)) {
      const name = e.name.slice(0, -3);
      if (IDENT.test(name)) map.set(name, [join(dir, e.name)]);
    } else if (e.isDirectory() && IDENT.test(e.name) && !MODULE_SKIP.has(e.name) && isFile(join(dir, e.name, '__init__.py'))) {
      map.set(e.name, pyFilesIn(join(dir, e.name)));
    }
  }
  return map;
}

// Имена модулей, которые файл, похоже, импортирует (с запасом: лишнее имя только добавит проверку).
function importedNames(text) {
  const names = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(IMPORT_SCAN)) {
      if (m[2]) names.add(m[2].split('.')[0]);
      else for (const part of m[1].split(',')) names.add(part.trim().split(/\s+/)[0].split('.')[0]);
    }
  }
  names.delete('');
  return names;
}

const projectWhy = (why) =>
  why
    .replace('путь вне кабинета', 'путь вне проекта')
    .replace(/^библиотека не из списка \(([^)]*)\)/, 'библиотека не из списка ($1, свои файлы .py в корне проекта)');

const relOf = (dir, file) => file.slice(dir.length + 1).replace(/\\/g, '/');

// Проверка проекта сервиса. dirArg: папка (относительно cwd). Бросает ENODIR, если папки нет.
// Ответ: { dir, info, problems: [строки], program: [{ file, line, text, why }], runFile, resultFile }.
export function checkProject(root, dirArg, { cwd = process.cwd() } = {}) {
  const asked = resolve(cwd, String(dirArg ?? ''));
  if (!dirArg || !isDir(asked)) throw serviceError('ENODIR', `Нет папки сервиса: ${asked}`);
  const dir = realpathSync(asked);
  const problems = [];
  const program = [];
  let cabinet = resolve(root);
  try {
    cabinet = realpathSync(root);
  } catch {
    // кабинета нет: сравниваем с путём как есть
  }
  if (samePath(dir, cabinet) || isInside(dir, cabinet)) {
    problems.push(`папка сервиса лежит внутри кабинета (${cabinet}): держите проект отдельно, например в папке ${SERVICES_DIR_NAME} рядом с кабинетом`);
  } else if (isInside(cabinet, dir)) {
    problems.push('внутри папки сервиса лежит кабинет: выберите папку самого проекта');
  }
  const { info, problems: infoProblems } = readServiceInfo(dir);
  problems.push(...infoProblems);
  let runFile = null;
  let resultFile = null;
  if (info?.result) resultFile = join(dir, ...info.result);
  // lib кладёт кабинет: это обычная папка проекта, не ссылка.
  const lib = lstatOrNull(join(dir, 'lib'));
  if (lib && (lib.isSymbolicLink() || !lib.isDirectory())) problems.push('lib должна быть обычной папкой проекта (её заполняет кабинет)');
  const out = lstatOrNull(join(dir, OUTPUT_DIR));
  if (out && (out.isSymbolicLink() || !out.isDirectory())) problems.push('output должна быть обычной папкой проекта');
  // Свои модули с именами модулей кабинета перекрыли бы lib/llm.py и его проверку данных.
  try {
    for (const e of readdirSync(dir)) {
      const stem = e.split('.')[0];
      if (['llm', 'read_table', 'service_api'].includes(stem)) {
        problems.push(`${e} в корне проекта: модули llm, read_table и service_api только из lib (их кладёт кабинет), переименуйте`);
      } else if (/\.(pyc|pyd|so)$/i.test(e)) {
        problems.push(`${e} в корне проекта: готовые модули Python не проверить, уберите`);
      }
    }
  } catch {
    // не прочиталась: ниже скажет проверка программы
  }
  if (info?.page) {
    const pg = lstatOrNull(join(dir, info.page));
    if (!pg || pg.isSymbolicLink() || !pg.isDirectory()) problems.push(`нет папки ${info.page} в проекте (своя страница сервиса)`);
    else if (!isFile(join(dir, info.page, 'index.html'))) problems.push(`нет файла ${info.page}/index.html: с него открывается своя страница`);
  }
  if (info?.run) {
    const file = join(dir, ...info.run);
    let real = null;
    try {
      real = realpathSync(file);
    } catch {
      problems.push(`нет программы ${info.run.join('/')} в папке проекта`);
    }
    if (real && !isInside(real, dir)) problems.push(`${info.run.join('/')} ведёт за пределы папки проекта`);
    else if (real && !isFile(real)) problems.push(`${info.run.join('/')} должен быть файлом`);
    else if (real) runFile = real;
  }
  let apiFile = null;
  if (info?.api) {
    const file = join(dir, ...info.api);
    let real = null;
    try {
      real = realpathSync(file);
    } catch {
      problems.push(`нет серверной части ${info.api.join('/')} в папке проекта`);
    }
    if (real && !isInside(real, dir)) problems.push(`${info.api.join('/')} ведёт за пределы папки проекта`);
    else if (real && !isFile(real)) problems.push(`${info.api.join('/')} должен быть файлом`);
    else if (real) apiFile = real;
  }
  if (runFile || apiFile) {
    // Программа, серверная часть и свои модули, которые они импортируют: проверка как у программ процессов.
    const modules = localModules(dir);
    const queue = [runFile, apiFile].filter(Boolean);
    const seen = new Set();
    const used = new Set();
    const texts = [];
    while (queue.length && seen.size <= PROGRAM_FILES_MAX) {
      const f = queue.shift();
      if (seen.has(f)) continue;
      seen.add(f);
      let text = '';
      try {
        if (statSync(f).size > PROGRAM_SIZE_MAX) {
          problems.push(`${relOf(dir, f)}: файл больше 1 МБ, такой не проверить`);
          continue;
        }
        text = readFileSync(f, 'utf8');
      } catch {
        problems.push(`${relOf(dir, f)}: файл не читается`);
        continue;
      }
      for (const name of importedNames(text)) {
        if (!modules.has(name)) continue;
        used.add(name);
        queue.push(...modules.get(name));
      }
      texts.push({ file: f, text });
    }
    const allow = [...used];
    for (const { file, text } of texts) {
      for (const x of programProblems(text, { allowImports: allow })) program.push({ file: relOf(dir, file), line: x.line, text: x.text, why: projectWhy(x.why) });
    }
  }
  return { dir, info, problems, program, runFile, apiFile, resultFile };
}

export const problemLines = (c) => [
  ...c.problems.map((x) => `  ${x}`),
  ...c.program.map((x) => `  ${x.file}, строка ${x.line}: ${x.why}: ${x.text}`),
];

export const okCheck = (c) => c.problems.length === 0 && c.program.length === 0;

// ---------- lib проекта ----------

// Файлы LIB_FILES из tools/ кабинета в lib/ проекта: недостающие и отличающиеся заменяются (ссылка на месте
// файла удаляется, а не пишется насквозь). Ответ: список обновлённых имён.
export function syncLib(root, dir) {
  const lib = join(dir, 'lib');
  const st = lstatOrNull(lib);
  if (st && (st.isSymbolicLink() || !st.isDirectory())) {
    throw serviceError('ELIB', 'Папка lib в проекте не обычная папка: кабинет не кладёт туда llm.py и read_table.py.');
  }
  mkdirSync(lib, { recursive: true });
  const updated = [];
  for (const name of LIB_FILES) {
    const src = join(root, 'tools', name);
    if (!isFile(src)) continue;
    const dst = join(lib, name);
    const cur = lstatOrNull(dst);
    if (cur && cur.isFile() && !cur.isSymbolicLink() && sameBytes(src, dst)) continue;
    if (cur) rmSync(dst, { force: true, recursive: cur.isDirectory() && !cur.isSymbolicLink() });
    copyFileSync(src, dst, constants.COPYFILE_EXCL);
    updated.push(name);
  }
  return updated;
}

// ---------- новый проект ----------

export const servicesHome = (root) => join(dirname(resolve(root)), SERVICES_DIR_NAME);

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (TEMPLATE_SKIP.has(e.name)) continue;
    const from = join(src, e.name);
    const to = join(dst, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else if (e.isFile()) copyFileSync(from, to, constants.COPYFILE_EXCL);
  }
}

function gitInit(dir) {
  try {
    const r = spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true, timeout: 30000, stdio: 'ignore' });
    if (r.error) return r.error.code === 'ENOENT' ? 'nogit' : 'fail';
    return r.status === 0 ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^["'«]+|["'»]+$/g, '').trim();

// Новый проект сервиса: { dir, git, name }. Папка латиницей из названия, свободное имя (-2, -3...).
export function createProject(root, name, { dir: parent, git = true, cwd = process.cwd() } = {}) {
  const title = cleanName(name);
  if (!title) throw serviceError('ENONAME', 'Укажите название сервиса: node tools/services.mjs new "Сводка продаж".');
  if (title.length > NAME_MAX) throw serviceError('ENONAME', `Название сервиса не длиннее ${NAME_MAX} знаков.`);
  const tpl = join(root, ...TEMPLATE);
  if (!isDir(tpl)) throw serviceError('ENOTEMPLATE', `Нет шаблона ${TEMPLATE.join('/')} в кабинете. Скажите Claude «обнови кабинет».`);
  const home = parent ? resolve(cwd, parent) : servicesHome(root);
  let cabinet = resolve(root);
  try {
    cabinet = realpathSync(root);
  } catch {
    // как есть
  }
  mkdirSync(home, { recursive: true });
  const realHome = realpathSync(home);
  if (samePath(realHome, cabinet) || isInside(realHome, cabinet)) {
    throw serviceError('EINSIDE', `Папка ${realHome} внутри кабинета: проекты сервисов держите отдельно, по умолчанию в папке ${SERVICES_DIR_NAME} рядом с кабинетом.`);
  }
  const folder = freeName(slugify(title) || 'servis', (n) => Boolean(lstatOrNull(join(realHome, n))));
  const dir = join(realHome, folder);
  mkdirSync(dir);
  copyTree(tpl, dir);
  syncLib(root, dir);
  for (const sub of ['input', OUTPUT_DIR]) mkdirSync(join(dir, sub), { recursive: true });
  const file = join(dir, SERVICE_FILE);
  let service = {};
  try {
    service = readJson(file);
  } catch {
    // в шаблоне нет паспорта: пишем по договору
  }
  if (!isObj(service)) service = {};
  service = { name: title, about: '', kind: 'run', run: 'main.py', result: DEFAULT_RESULT, input: 'input/', page: null, ...service };
  service.name = title;
  writeFileSync(file, JSON.stringify(service, null, 2) + '\n');
  return { dir, name: title, git: git ? gitInit(dir) : 'skip' };
}

// ---------- запуск ----------

const lockPath = (dir) => join(dir, OUTPUT_DIR, LOCK_FILE);

function pidAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readLock(file) {
  let mtimeMs, text;
  try {
    mtimeMs = statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // пишется прямо сейчас или повреждён: судим по времени файла
  }
  return { data: isObj(data) ? data : {}, mtimeMs };
}

function isStale({ data, mtimeMs }, now = Date.now()) {
  if (Number.isInteger(data.pid) && data.pid > 0 && !pidAlive(data.pid)) return true;
  const started = Date.parse(data.startedAt);
  const since = Number.isFinite(started) ? started : mtimeMs;
  const limit = (Number.isFinite(data.timeoutMs) ? data.timeoutMs : DEFAULT_TIMEOUT_MS) + KILL_GRACE_MS + STALE_MARGIN_MS;
  return now - since > limit;
}

export function isRunning(dir) {
  const lock = readLock(lockPath(dir));
  return Boolean(lock) && !isStale(lock);
}

function acquireLock(dir, timeoutMs) {
  const file = lockPath(dir);
  const lock = { pid: process.pid, startedAt: new Date().toISOString(), timeoutMs, id: randomBytes(8).toString('hex') };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(lock), { flag: 'wx' });
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readLock(file);
      if (held && !isStale(held)) break;
      rmSync(file, { force: true });
    }
  }
  throw serviceError('ERUNNING', 'Этот сервис уже считается. Дождитесь, пока обновится время на карточке.');
}

function releaseLock(dir, lock) {
  const file = lockPath(dir);
  if (readLock(file)?.data.id === lock.id) rmSync(file, { force: true });
}

function writeLastRun(dir, data) {
  const file = join(dir, OUTPUT_DIR, LAST_RUN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(data, null, 2) + '\n';
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
      writeFileSync(file, text);
    } catch {
      // не записался: карточка покажет время из результата
    }
  }
}

export function readLastRun(dir) {
  try {
    const d = readJson(join(dir, OUTPUT_DIR, LAST_RUN_FILE));
    if (d && typeof d.ok === 'boolean' && typeof d.finishedAt === 'string' && (d.code === null || Number.isInteger(d.code))) {
      const run = { ok: d.ok, code: d.code, finishedAt: d.finishedAt };
      if (Number.isFinite(d.durationMs)) run.durationMs = d.durationMs;
      return run;
    }
  } catch {
    // нет файла или повреждён
  }
  return null;
}

// Папка или имя из реестра → { dir, entry }. Имя без косой черты сначала ищется в реестре.
export function resolveTarget(root, arg, { cwd = process.cwd() } = {}) {
  if (typeof arg !== 'string' || !arg.trim()) throw serviceError('ENOARG', 'Укажите папку сервиса или его имя в кабинете.');
  const { list } = readRegistry(root);
  const looksPath = /[\\/]/.test(arg) || arg === '.' || arg === '..' || isAbsolute(arg);
  if (!looksPath) {
    const entry = list.find((e) => e.slug === arg);
    if (entry) {
      if (!isDir(entry.path)) throw serviceError('ENODIR', `Папка сервиса «${entry.name ?? entry.slug}» не найдена: ${entry.path}`, { entry });
      return { dir: realpathSync(entry.path), entry };
    }
  }
  const dir = resolve(cwd, arg);
  if (isDir(dir)) {
    const real = realpathSync(dir);
    return { dir: real, entry: list.find((e) => samePath(e.path, real)) ?? null };
  }
  const names = list.map((e) => e.slug).join(', ') || 'сервисов в кабинете пока нет';
  throw serviceError('ENOSERVICE', `Такого сервиса нет: ${arg}. Сервисы кабинета: ${names}.`);
}

const humanTime = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} мин` : `${Math.round(ms / 1000)} с`);

function writeLine(fd, text) {
  try {
    writeSync(fd, `\n${text}\n`);
  } catch {
    // журнал не пишется: итог всё равно в last-run.json
  }
}

function spawnPython(exe, runFile, fd, logPath, { cwd, timeoutMs, logLimitBytes, killGraceMs, stopTree, control, env = {} }) {
  return new Promise((done) => {
    let settled = false;
    let stopped = null;
    let spawnFailed = false;
    let timer = null;
    let grace = null;
    let watch = null;
    let child = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearInterval(watch);
      if (stopped === 'timeout') writeLine(fd, `Расчёт остановлен: он шёл дольше ${humanTime(timeoutMs)}.`);
      if (stopped === 'cancel') writeLine(fd, 'Расчёт прерван: запуск остановили.');
      if (stopped === 'log') {
        try {
          truncateSync(logPath, logLimitBytes);
        } catch {
          // не обрезался: строка всё равно допишется
        }
        writeLine(fd, `Сервис остановлен: слишком большой журнал (больше ${Math.round(logLimitBytes / 1048576)} МБ).`);
      }
      done({ code, stopped, spawnFailed });
    };
    const stop = (reason) => {
      if (stopped || settled) return;
      stopped = reason;
      try {
        stopTree(child);
      } catch {
        // ниже добьём через паузу
      }
      grace = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // процесса уже нет
        }
        finish(null);
      }, killGraceMs);
    };
    try {
      child = spawn(exe, [runFile], {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', fd, fd],
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: join(cwd, 'lib'),
          ...env,
        },
      });
    } catch (e) {
      spawnFailed = true;
      writeLine(fd, `Не удалось запустить Python (${e.code ?? e.message}).`);
      return finish(null);
    }
    child.on('error', (e) => {
      if (child.pid !== undefined) return;
      spawnFailed = true;
      writeLine(fd, `Не удалось запустить Python «${exe}» (${e.code ?? e.message}).`);
      finish(null);
    });
    child.on('exit', (code) => finish(code));
    control.stop = stop;
    if (control.cancelled) stop('cancel');
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    watch = setInterval(() => {
      try {
        if (fstatSync(fd).size > logLimitBytes) stop('log');
      } catch {
        // проверим в следующий раз
      }
    }, LOG_CHECK_MS);
  });
}

// Сколько других сервисов кабинета сейчас считается.
function runningServices(root, exceptDir) {
  return readRegistry(root).list.filter((e) => !samePath(e.path, exceptDir) && isRunning(e.path)).length;
}

// Синхронно: проверка проекта, lib, замок; затем запуск. Бросает ошибку с кодом, если запускать нельзя
// (ENOARG, ENOSERVICE, ENODIR, EBADSERVICE, ENORUN, ELIB, EOUTSIDE, ERUNNING, ELIMIT).
// done никогда не отклоняется: { ok, code, durationMs, logPath, startedAt }.
export function startServiceRun(
  root,
  target,
  {
    python,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logLimitBytes = LOG_LIMIT_BYTES,
    killGraceMs = KILL_GRACE_MS,
    maxConcurrent = MAX_CONCURRENT,
    killTree: stopTree = killTree,
  } = {},
) {
  root = resolve(root);
  const { dir, entry } = resolveTarget(root, target, { cwd });
  const c = checkProject(root, dir);
  if (!okCheck(c)) {
    throw serviceError('EBADSERVICE', `Сервис не запускается, в проекте есть что поправить:\n${problemLines(c).join('\n')}`, { check: c });
  }
  if (!c.runFile) throw serviceError('ENORUN', `У сервиса «${c.info.name}» нет программы: в ${SERVICE_FILE} не указан run.`);
  syncLib(root, dir);
  const outDir = join(dir, OUTPUT_DIR);
  mkdirSync(outDir, { recursive: true });
  const st = lstatOrNull(outDir);
  if (!st || st.isSymbolicLink() || !isInside(realpathSync(outDir), dir)) {
    throw serviceError('EOUTSIDE', 'Папка output проекта ведёт за его пределы: такой сервис не запускается.');
  }
  const lock = acquireLock(dir, timeoutMs);
  const logPath = join(outDir, 'last-run.log');
  let fd;
  try {
    if (runningServices(root, dir) >= maxConcurrent) {
      throw serviceError('ELIMIT', `Одновременно можно запускать не больше ${maxConcurrent} сервисов. Дождитесь, пока один закончится, и запустите снова.`);
    }
    writeFileSync(logPath, '');
    fd = openSync(logPath, 'a');
  } catch (e) {
    releaseLock(dir, lock);
    throw e;
  }
  const control = { stop: null, cancelled: false };
  const startedAt = Date.now();
  const slug = entry?.slug ?? basename(dir);
  const before = folderSnapshot(join(dir, 'input'));
  const done = (async () => {
    let code = null;
    let stopped = null;
    try {
      let exe = python ?? (await findPython(root));
      if (exe && (samePath(exe, dir) || isInside(exe, dir))) exe = null;
      if (control.cancelled) {
        stopped = 'cancel';
        writeLine(fd, 'Расчёт прерван: запуск остановили.');
      } else if (!exe) {
        writeLine(fd, 'Python не найден. Скажите Claude в кабинете «проверь сетап».');
      } else {
        ({ code, stopped } = await spawnPython(exe, c.runFile, fd, logPath, { cwd: dir, timeoutMs, logLimitBytes, killGraceMs, stopTree, control, env: { CABINET_JOURNAL: journalFile(root), CABINET_SERVICE: slug } }));
      }
    } catch (e) {
      writeLine(fd, `Не удалось запустить расчёт (${e.code ?? e.message}).`);
    } finally {
      try {
        closeSync(fd);
      } catch {
        // уже закрыт
      }
    }
    const ok = code === 0 && !stopped;
    const durationMs = Date.now() - startedAt;
    writeLastRun(dir, { ok, code, finishedAt: new Date().toISOString(), durationMs });
    releaseLock(dir, lock);
    appendJournal(root, { service: slug, event: 'run', ok, code, ms: durationMs, files: snapshotDiff(before, folderSnapshot(join(dir, 'input'))) });
    return { ok, code, durationMs, logPath, startedAt };
  })();
  const cancel = () => {
    control.cancelled = true;
    control.stop?.('cancel');
  };
  return { done, logPath, cancel, dir, entry, check: c };
}

// ---------- описание для списка и страницы ----------

function readResultOf(dir, info) {
  if (!info?.result) return { result: null, error: null, mtimeMs: null };
  const rel = info.result.join('/');
  const file = join(dir, ...info.result);
  let data, mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
    data = readJson(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { result: null, error: null, mtimeMs: null };
    return { result: null, error: `файл ${rel} повреждён или не в формате JSON`, mtimeMs };
  }
  const v = validateServiceResult(data);
  return v.ok ? { result: data, error: null, mtimeMs } : { result: null, error: `${rel}: ${v.errors.join('; ')}`, mtimeMs };
}

// Карточка сервиса для страницы (api/services) и списка: { slug, name, title, about, kind, run, page, path,
// result, error, running, lastRun, added_at }. page: адрес своей страницы (kind page) или null.
export function describeService(root, entry) {
  const base = {
    slug: entry.slug,
    name: entry.name ?? entry.slug,
    title: entry.name ?? entry.slug,
    about: '',
    kind: KINDS.includes(entry.kind) ? entry.kind : null,
    run: false,
    page: null,
    path: entry.path,
    result: null,
    error: null,
    running: false,
    lastRun: null,
    added_at: entry.added_at ?? null,
  };
  if (!isDir(entry.path)) return { ...base, error: `папка сервиса не найдена: ${entry.path}` };
  const dir = entry.path;
  const { info, problems } = readServiceInfo(dir);
  const res = readResultOf(dir, info);
  const name = info?.name ?? base.name;
  return {
    ...base,
    name,
    title: name,
    about: info?.about ?? '',
    kind: info?.kind ?? base.kind,
    run: Boolean(info?.run),
    page: info?.kind === 'page' && info.page ? `s/${entry.slug}/` : null,
    result: res.result,
    error: [...problems, res.error].filter(Boolean).join('; ') || null,
    running: isRunning(dir),
    lastRun: readLastRun(dir),
  };
}

export function listServices(root) {
  return readRegistry(root)
    .list.map((e) => describeService(root, e))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function serviceStatus(root, slug) {
  const entry = findEntry(root, slug);
  if (!entry) return null;
  return { running: isDir(entry.path) && isRunning(entry.path), lastRun: isDir(entry.path) ? readLastRun(entry.path) : null };
}

// ---------- добавить и убрать ----------

// check + запись в реестр. { entry, updated, check } или ошибка EBADSERVICE с check.
export function addService(root, dirArg, { cwd = process.cwd() } = {}) {
  const c = checkProject(root, dirArg, { cwd });
  if (!okCheck(c)) throw serviceError('EBADSERVICE', 'Сервис не добавлен: в проекте есть что поправить.', { check: c });
  const { list, error, broken } = readRegistry(root);
  if (broken) throw serviceError('EREGISTRY', `Реестр сервисов не читается: ${error}. Покажите это тренеру.`);
  syncLib(root, c.dir);
  const now = new Date().toISOString();
  const old = list.find((e) => samePath(e.path, c.dir));
  let entry;
  if (old) {
    entry = { ...old, name: c.info.name, kind: c.info.kind, path: c.dir, updated_at: now };
    list.splice(list.indexOf(old), 1, entry);
  } else {
    const taken = (s) => list.some((e) => e.slug === s) || isDir(join(root, 'processes', s));
    const folder = basename(c.dir);
    const base = SLUG_RE.test(folder) ? folder : slugify(c.info.name) || slugify(folder) || 'servis';
    entry = { slug: freeName(base, taken), name: c.info.name, path: c.dir, kind: c.info.kind, added_at: now };
    list.push(entry);
  }
  writeRegistry(root, list);
  return { entry, updated: Boolean(old), check: c };
}

export function removeService(root, slug) {
  const { list, error, broken } = readRegistry(root);
  if (broken) throw serviceError('EREGISTRY', `Реестр сервисов не читается: ${error}. Покажите это тренеру.`);
  const entry = list.find((e) => e.slug === slug);
  if (!entry) {
    const names = list.map((e) => e.slug).join(', ') || 'сервисов в кабинете пока нет';
    throw serviceError('ENOSERVICE', `Такого сервиса нет: ${slug}. Сервисы кабинета: ${names}.`);
  }
  writeRegistry(root, list.filter((e) => e !== entry));
  return entry;
}

// ---------- node tools/services.mjs ----------

const USAGE = `Сервисы-проекты кабинета:
  node tools/services.mjs new <название> [--dir <папка>]   создать проект сервиса (по умолчанию в папке ${SERVICES_DIR_NAME} рядом с кабинетом)
  node tools/services.mjs check <папка>                    проверить service.json и программу по правилам кабинета
  node tools/services.mjs run <папка или имя>              запустить программу сервиса, как кнопкой «Запустить»
  node tools/services.mjs add <папка>                      проверить и добавить в кабинет (повторно: обновить)
  node tools/services.mjs remove <имя>                     убрать сервис из кабинета (папку проекта не трогает)
  node tools/services.mjs list                             сервисы кабинета, их результат и последний запуск
<имя>: имя сервиса в кабинете латиницей, например svodka-prodazh (его показывает list).`;

const COLOR = { green: 'зелёный', yellow: 'жёлтый', red: 'красный' };
const pad2 = (n) => String(n).padStart(2, '0');

function formatTime(iso) {
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} с`;

function logTail(logPath, count = 12) {
  try {
    return readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-count);
  } catch {
    return [];
  }
}

function cliNew(root, args) {
  const rest = [];
  let dir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') dir = args[++i] ?? '';
    else rest.push(args[i]);
  }
  if (dir === '') return { text: 'Укажите папку после --dir.', code: 2 };
  let made;
  try {
    made = createProject(root, rest.join(' '), { dir });
  } catch (e) {
    if (['ENONAME', 'ENOTEMPLATE', 'EINSIDE', 'EMANY'].includes(e.code)) return { text: e.message, code: 2 };
    throw e;
  }
  const git = {
    ok: 'Git: история версий включена (git init).',
    nogit: 'Git на компьютере не найден: папка создана без истории версий, сервису это не мешает.',
    fail: 'Git не включился в этой папке: сервису это не мешает.',
    skip: null,
  }[made.git];
  return {
    text: [
      `Сервис «${made.name}» создан: ${made.dir}`,
      `Внутри: ${SERVICE_FILE}, main.py, input, output, lib (${LIB_FILES.join(', ')} из кабинета).`,
      git,
      'Дальше: откройте эту папку в новом разговоре (Code → Open folder) и опишите, что должен делать сервис.',
    ]
      .filter(Boolean)
      .join('\n'),
    code: 0,
  };
}

function cliCheck(root, arg) {
  if (!arg) return { text: 'Укажите папку сервиса: node tools/services.mjs check <папка>.', code: 2 };
  let c;
  try {
    c = checkProject(root, arg);
  } catch (e) {
    if (e.code === 'ENODIR') return { text: e.message, code: 2 };
    throw e;
  }
  const title = c.info?.name ? `«${c.info.name}»` : basename(c.dir);
  if (okCheck(c)) {
    const what = c.runFile ? `программа ${relOf(c.dir, c.runFile)} без запрещённого` : 'программы нет (своя страница)';
    return { text: `Проверка сервиса ${title} пройдена: ${c.dir}\n${SERVICE_FILE} по договору, ${what}.`, code: 0 };
  }
  const lines = problemLines(c);
  return {
    text: [
      `Проверка сервиса ${title} (${c.dir}): нужно поправить ${lines.length}.`,
      ...lines,
      c.program.length ? 'Программа сервиса работает без Claude и без окна: запуск других программ, eval и exec, прямые API моделей и пути вне проекта ей нельзя. Модель только через lib/llm.py.' : null,
      'Итог проверки: поправьте и проверьте снова, в кабинет сервис с такими ошибками не добавляется.',
    ]
      .filter(Boolean)
      .join('\n'),
    code: 1,
  };
}

function reportRun(c, r) {
  const title = c.info.name;
  const log = relOf(c.dir, r.logPath);
  if (!r.ok) {
    const code = r.code === null ? '' : ` (код ${r.code})`;
    const tail = logTail(r.logPath);
    const lines = [`Расчёт «${title}» не удался${code}. Журнал: ${r.logPath}`];
    if (tail.length) lines.push('Последние строки журнала:', ...tail.map((l) => `  ${l}`));
    return { text: lines.join('\n'), code: 1 };
  }
  const rel = c.info.result.join('/');
  const res = readResultOf(c.dir, c.info);
  if (res.mtimeMs === null) return { text: `Расчёт закончился, но программа не записала ${rel}: карточка не обновится. Журнал: ${log}`, code: 1 };
  if (res.error) return { text: `Расчёт закончился, но результат не годится для карточки: ${res.error}`, code: 1 };
  if (res.mtimeMs < r.startedAt - 2000) return { text: `Расчёт закончился, но ${rel} не обновился: на карточке остался прежний результат.`, code: 1 };
  const result = res.result;
  const lines = [
    `Готово: «${title}», расчёт занял ${seconds(r.durationMs)}.`,
    `Итог: ${result.summary}`,
    `Цвет карточки: ${COLOR[result.status]}.`,
    `Обновлено: ${formatTime(result.updated_at)}.`,
    `Результат: ${join(c.dir, ...c.info.result)}`,
  ];
  if (Array.isArray(result.files) && result.files.length) lines.push(`Файлы: ${result.files.map((f) => f.replace(/\\/g, '/')).join(', ')}`);
  return { text: lines.join('\n'), code: 0 };
}

// Запуск не начался: нет сервиса, уже идёт и подобное (код выхода 2, как у processes.mjs).
const RUN_REFUSALS = new Set(['ENOARG', 'ENOSERVICE', 'ENODIR', 'ELIB', 'EOUTSIDE', 'ERUNNING', 'ELIMIT']);

async function cliRun(root, arg) {
  if (!arg) return { text: 'Укажите сервис: node tools/services.mjs run <папка или имя>.', code: 2 };
  let run;
  try {
    run = startServiceRun(root, arg);
  } catch (e) {
    if (e.code === 'EBADSERVICE' || e.code === 'ENORUN') return { text: e.message, code: 1 };
    if (RUN_REFUSALS.has(e.code)) return { text: e.message, code: 2 };
    throw e;
  }
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = () => run.cancel();
  for (const s of signals) process.on(s, onSignal);
  const r = await run.done;
  for (const s of signals) process.off(s, onSignal);
  return reportRun(run.check, r);
}

function cliAdd(root, arg) {
  if (!arg) return { text: 'Укажите папку сервиса: node tools/services.mjs add <папка>.', code: 2 };
  let r;
  try {
    r = addService(root, arg);
  } catch (e) {
    if (e.code === 'ENODIR' || e.code === 'EREGISTRY') return { text: e.message, code: 2 };
    if (e.code === 'EBADSERVICE') {
      const c = e.check;
      return { text: [`Сервис не добавлен в кабинет: в проекте ${c.dir} есть что поправить.`, ...problemLines(c), 'Поправьте и повторите.'].join('\n'), code: 1 };
    }
    throw e;
  }
  const { entry, updated } = r;
  const how = entry.kind === 'page' ? 'своя страница, кнопка «Открыть»' : 'кнопка «Запустить»';
  return {
    text: [
      updated ? `Сервис «${entry.name}» обновлён в кабинете.` : `Сервис «${entry.name}» добавлен в кабинет.`,
      `Карточка на странице «мой кабинет», в меню «Мои сервисы»: ${how}.`,
      `Имя в кабинете: ${entry.slug}. Папка проекта: ${entry.path}`,
      `Запуск из кабинета: node tools/services.mjs run ${entry.slug}`,
    ].join('\n'),
    code: 0,
  };
}

function cliRemove(root, slug) {
  if (!slug) return { text: 'Укажите сервис: node tools/services.mjs remove <имя>. Имена показывает list.', code: 2 };
  try {
    const entry = removeService(root, slug);
    return { text: `Сервис «${entry.name ?? entry.slug}» убран из кабинета. Папка проекта не тронута: ${entry.path}`, code: 0 };
  } catch (e) {
    if (e.code === 'ENOSERVICE' || e.code === 'EREGISTRY') return { text: e.message, code: 2 };
    throw e;
  }
}

function describeLastRun(s) {
  const last = s.lastRun;
  if (!last) return null;
  const when = formatTime(last.finishedAt);
  if (last.ok) return `Последний запуск: ${when}, удачно.`;
  const code = last.code === null ? '' : ` (код ${last.code})`;
  return `Последний запуск: ${when}, не удался${code}, журнал ${join(s.path, OUTPUT_DIR, 'last-run.log')}.`;
}

export function formatList(root) {
  const { error } = readRegistry(root);
  const list = listServices(root);
  if (!list.length) {
    const empty = 'Сервисов-проектов в кабинете пока нет. Сервис добавляется из папки проекта фразой «добавь в кабинет».';
    return { text: error ? `${empty}\nОшибка: ${error}` : empty, code: error ? 1 : 0 };
  }
  const lines = [`Сервисов-проектов в кабинете: ${list.length}.`];
  list.forEach((s, i) => {
    const how = s.kind === 'page' ? `своя страница, кнопка «Открыть»${s.run ? ' и «Запустить»' : ''}` : 'программа, кнопка «Запустить»';
    lines.push(`${i + 1}. «${s.name}» (имя ${s.slug}): ${how}. Папка: ${s.path}`);
    if (s.running) lines.push('   Сейчас идёт расчёт.');
    if (s.result) lines.push(`   Результат: обновлён ${formatTime(s.result.updated_at)}, ${COLOR[s.result.status]}. Итог: ${s.result.summary}`);
    else if (!s.error && s.run) lines.push('   Результата пока нет.');
    const last = describeLastRun(s);
    if (last) lines.push(`   ${last}`);
    if (s.error) lines.push(`   Ошибка: ${s.error}`);
  });
  if (error) lines.push(`Ошибка: ${error}`);
  return { text: lines.join('\n'), code: error || list.some((s) => s.error) ? 1 : 0 };
}

async function dispatch(root, argv) {
  const [cmd, ...args] = argv;
  const arg = args.filter((a) => !a.startsWith('--')).join(' ');
  if (cmd === 'new') return cliNew(root, args);
  if (cmd === 'check') return cliCheck(root, arg);
  if (cmd === 'run') return cliRun(root, arg);
  if (cmd === 'add') return cliAdd(root, arg);
  if (cmd === 'remove') return cliRemove(root, arg);
  if (cmd === 'list') return formatList(root);
  return { text: USAGE, code: cmd ? 2 : 0 };
}

export async function main(argv = process.argv.slice(2)) {
  // Windows не ищет программы (git, python) в текущей папке.
  process.env.NoDefaultCurrentDirectoryInExePath = '1';
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let out;
  try {
    out = await dispatch(root, argv);
  } catch (e) {
    const what = argv.filter((a) => !a.startsWith('--')).join(' ');
    out = { text: `Не удалось выполнить «${what}» (${e.code ?? e.message}). Покажите это сообщение тренеру.`, code: 2 };
  }
  console.log(out.text);
  return out.code;
}

if (isMain(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
