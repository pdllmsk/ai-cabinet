// Процессы участника: папки processes/<slug>/ с process.json и run.py. Без зависимостей.
// Результат процесса лежит в output/<slug>/result.json, страница «Мой кабинет» рисует его карточкой.
// Запуск: только processes/<slug>/run.py этого кабинета, из корня кабинета, без аргументов,
// своим Python (абсолютный путь вне кабинета), по одному запуску на процесс и не больше двух на кабинет,
// не дольше timeoutMs, журнал output/<slug>/last-run.log не больше 20 МБ.
// Кнопка на странице и фраза в Claude (node tools/processes.mjs run <slug>) запускают одно и то же:
// замок output/<slug>/.running и итог последнего запуска output/<slug>/last-run.json общие для обоих.
// Процессы kind "claude" (без программы) операция «добавить процесс» больше не создаёт; старые показываются
// карточкой с фразой, «доработай <процесс>» делает для них программу.
//
//   node tools/processes.mjs list               процессы, результат и последний запуск
//   node tools/processes.mjs run <slug>         запуск, как кнопкой «Запустить»
//   node tools/processes.mjs input <slug>       папка input/<slug> для файлов человека, открывается в Проводнике
//   node tools/processes.mjs read <slug> <файл> текст файла скилла (.md, .zip, .skill) или документа Word из input/<slug>
//   node tools/processes.mjs compare <slug>     проверка программы и сверка её результата с эталоном скилла
//   node tools/processes.mjs skills             свои скиллы человека в .claude/skills
//   node tools/processes.mjs demo <slug>        демо курса из templates/processes с файлом учебного кейса
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
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
import { inflateRawSync } from 'node:zlib';
import { isMain } from './is-main.mjs';
import { appendJournal, folderSnapshot, journalFile, snapshotDiff } from './journal.mjs';

export const SLUG_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_CONCURRENT = 2;
export const LOG_LIMIT_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 5000;
const LOG_CHECK_MS = 200;
// Замок старше своего ограничения времени с этим запасом считается брошенным.
const STALE_MARGIN_MS = 60 * 1000;
export const LOCK_FILE = '.running';
export const LAST_RUN_FILE = 'last-run.json';
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const TASKKILL = join(SYSTEM_ROOT, 'System32', 'taskkill.exe');

const KINDS = ['script', 'claude'];
const STATUSES = ['green', 'yellow', 'red'];
const ROW_STATUSES = [...STATUSES, 'grey', 'info'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// path лежит внутри dir. На Windows регистр букв в путях не важен, поэтому сравнение без него.
export function isInside(path, dir, platform = process.platform) {
  const win = platform === 'win32';
  const norm = (p) => (win ? p.toLowerCase() : p);
  return norm(path).startsWith(norm(dir) + (win ? '\\' : '/'));
}
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function processError(code, message) {
  return Object.assign(new Error(message), { code });
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

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

export const hasProcess = (root, slug) =>
  typeof slug === 'string' && SLUG_RE.test(slug) && isDir(join(root, 'processes', slug));

// process.json: { title, phrase, kind, input, output }. missing: файла нет; error: файл есть, но не годится.
function readProcessInfo(root, slug) {
  const rel = `processes/${slug}/process.json`;
  let data;
  try {
    data = readJson(join(root, 'processes', slug, 'process.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return { title: slug, phrase: '', kind: null, missing: true, error: `нет файла ${rel}` };
    return { title: slug, phrase: '', kind: null, error: `файл ${rel} повреждён или не в формате JSON` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { title: slug, phrase: '', kind: null, error: `в файле ${rel} нужен объект JSON` };
  }
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : slug;
  const phrase = typeof data.phrase === 'string' ? data.phrase.trim() : '';
  if (!KINDS.includes(data.kind)) {
    return { title, phrase, kind: null, error: `${rel}: kind должен быть script или claude` };
  }
  return { title, phrase, kind: data.kind, error: null };
}

const isCell = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

// Путь файла результата: output/<slug>/..., без выхода наверх. Обратную косую черту (Windows) принимаем.
export function isOutputPath(path, slug) {
  if (typeof path !== 'string') return false;
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length < 3 || parts[0] !== 'output') return false;
  if (slug ? parts[1] !== slug : !SLUG_RE.test(parts[1])) return false;
  return parts.every((s) => s !== '' && s !== '.' && s !== '..' && !s.includes(':'));
}

// Схема result.json. slug (необязательно) проверяет, что файлы лежат в output/<slug>/.
export function validateResult(obj, slug) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['результат должен быть объектом JSON с полями title, updated_at, status, summary, columns, rows'] };
  }
  const errors = [];
  if (typeof obj.title !== 'string' || !obj.title.trim()) errors.push('title: нужно название процесса строкой');
  if (typeof obj.updated_at !== 'string' || !ISO_RE.test(obj.updated_at) || Number.isNaN(Date.parse(obj.updated_at))) {
    errors.push('updated_at: нужны дата и время в формате ISO, например 2026-09-21T10:30:00');
  }
  if (!STATUSES.includes(obj.status)) errors.push('status: нужно green, yellow или red');
  if (typeof obj.summary !== 'string') errors.push('summary: нужен итог строкой');
  const columnsOk = Array.isArray(obj.columns) && obj.columns.every((c) => typeof c === 'string');
  if (!columnsOk) errors.push('columns: нужен список названий столбцов (может быть пустым)');
  if (!Array.isArray(obj.rows)) {
    errors.push('rows: нужен список строк (может быть пустым)');
  } else if (columnsOk) {
    const bad = obj.rows.findIndex((r) => !Array.isArray(r) || r.length !== obj.columns.length || !r.every(isCell));
    if (bad !== -1) {
      errors.push(`rows: в строке ${bad + 1} нужно ${obj.columns.length} значений по числу столбцов (текст, число или null)`);
    }
  }
  const perRow = (field, good, hint) => {
    const v = obj[field];
    if (v === undefined) return;
    if (!Array.isArray(v) || (Array.isArray(obj.rows) && v.length !== obj.rows.length)) {
      errors.push(`${field}: нужен список той же длины, что rows`);
    } else if (!v.every(good)) {
      errors.push(`${field}: допустимые значения ${hint}`);
    }
  };
  // null: строка без отметки (например, обращение с темой, когда пометку получают только строки «разобрать вручную»).
  perRow('row_status', (v) => v === null || ROW_STATUSES.includes(v), 'green, yellow, red, grey, info или null');
  perRow('row_note', (v) => v === null || typeof v === 'string', 'текст или null');
  if (obj.files !== undefined) {
    if (!Array.isArray(obj.files)) {
      errors.push('files: нужен список путей к файлам');
    } else {
      const bad = obj.files.find((f) => !isOutputPath(f, slug));
      if (bad !== undefined) errors.push(`files: путь ${JSON.stringify(bad)} должен вести в папку output/${slug ?? '<процесс>'}/`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function readResult(root, slug) {
  const rel = `output/${slug}/result.json`;
  let data;
  try {
    data = readJson(join(root, 'output', slug, 'result.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return { result: null, error: null };
    return { result: null, error: `файл ${rel} повреждён или не в формате JSON` };
  }
  const v = validateResult(data, slug);
  return v.ok ? { result: data, error: null } : { result: null, error: `${rel}: ${v.errors.join('; ')}` };
}

function describe(root, slug) {
  if (!SLUG_RE.test(slug)) {
    return {
      slug,
      title: slug,
      phrase: '',
      kind: null,
      result: null,
      error: `папка processes/${slug}: в имени нужны строчные латинские буквы, цифры и дефис, до 40 знаков`,
      running: false,
    };
  }
  const info = readProcessInfo(root, slug);
  const errors = [info.error];
  if (info.kind === 'script' && !isFile(join(root, 'processes', slug, 'run.py'))) {
    errors.push(`нет файла processes/${slug}/run.py`);
  }
  const res = readResult(root, slug);
  errors.push(res.error);
  return {
    slug,
    title: info.title,
    phrase: info.phrase,
    kind: info.kind,
    result: res.result,
    error: errors.filter(Boolean).join('; ') || null,
    running: isRunning(root, slug),
  };
}

export function listProcesses(root) {
  let entries;
  try {
    entries = readdirSync(join(root, 'processes'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith('.') && isDir(join(root, 'processes', e.name)))
    .map((e) => describe(root, e.name))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}

// Замок запуска output/<slug>/.running: { pid, startedAt, timeoutMs, id }. Его создаёт тот, кто запускает
// (страница или node tools/processes.mjs), атомарно (flag wx), и снимает по окончании. Брошенный замок
// (процесса с этим pid нет или запуск идёт дольше своего срока с запасом) не мешает новому запуску.
const lockPath = (root, slug) => join(root, 'output', slug, LOCK_FILE);

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
    // Замок пишется прямо сейчас или повреждён: судим по времени файла.
  }
  return { data: data && typeof data === 'object' ? data : {}, mtimeMs };
}

function isStale({ data, mtimeMs }, now = Date.now()) {
  if (Number.isInteger(data.pid) && data.pid > 0 && !pidAlive(data.pid)) return true;
  const started = Date.parse(data.startedAt);
  const since = Number.isFinite(started) ? started : mtimeMs;
  const limit = (Number.isFinite(data.timeoutMs) ? data.timeoutMs : DEFAULT_TIMEOUT_MS) + KILL_GRACE_MS + STALE_MARGIN_MS;
  return now - since > limit;
}

function isRunning(root, slug) {
  const lock = readLock(lockPath(root, slug));
  return Boolean(lock) && !isStale(lock);
}

function acquireLock(root, slug, timeoutMs) {
  const file = lockPath(root, slug);
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
  throw processError('ERUNNING', 'Этот процесс уже идёт. Дождитесь, пока обновится время на карточке.');
}

// Снимаем только свой замок: брошенный мог быть снят и занят другим запуском.
function releaseLock(root, slug, lock) {
  const file = lockPath(root, slug);
  if (readLock(file)?.data.id === lock.id) rmSync(file, { force: true });
}

// Сколько других процессов кабинета сейчас считается (по замкам: и с этой страницы, и из Claude).
function runningInCabinet(root, except) {
  let entries;
  try {
    entries = readdirSync(join(root, 'output'), { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((e) => e.isDirectory() && e.name !== except && SLUG_RE.test(e.name) && isRunning(root, e.name)).length;
}

// Итог последнего запуска output/<slug>/last-run.json: { ok, code, finishedAt, durationMs }.
// Пишется через временный файл: страница не прочитает половину.
function writeLastRun(root, slug, data) {
  const file = join(root, 'output', slug, LAST_RUN_FILE);
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
      // Не записался: карточка всё равно покажет время из result.json.
    }
  }
}

function readLastRun(root, slug) {
  try {
    const d = readJson(join(root, 'output', slug, LAST_RUN_FILE));
    if (d && typeof d.ok === 'boolean' && typeof d.finishedAt === 'string' && (d.code === null || Number.isInteger(d.code))) {
      const run = { ok: d.ok, code: d.code, finishedAt: d.finishedAt };
      if (Number.isFinite(d.durationMs)) run.durationMs = d.durationMs;
      return run;
    }
  } catch {
    // нет файла или он повреждён: последнего запуска не знаем
  }
  return null;
}

export function processStatus(root, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return { running: false, lastRun: null };
  return { running: isRunning(root, slug), lastRun: readLastRun(root, slug) };
}

// Проверки до запуска. Ошибки с кодом: страница превращает его в ответ (404, 400, 403, 409).
// Возвращает настоящий путь run.py: запускается именно он, подменить файл после проверки нельзя.
function checkRunnable(root, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw processError('EBADSLUG', 'Такого процесса нет.');
  const info = readProcessInfo(root, slug);
  if (info.missing) throw processError('ENOPROCESS', `Такого процесса нет: ${slug}.`);
  if (info.error) throw processError('EBADPROCESS', `Процесс не запускается: ${info.error}.`);
  if (info.kind === 'claude') {
    throw processError('ECLAUDE', `этот процесс запускается фразой в Claude: ${info.phrase || info.title}`);
  }
  // run.py должен по-настоящему лежать в папке processes этого кабинета: ссылка наружу не запускается,
  // и сама папка processes, ведущая в другое место, тоже. Граница считается от настоящего пути кабинета.
  let base, file;
  try {
    base = join(realpathSync(root), 'processes');
    file = realpathSync(join(root, 'processes', slug, 'run.py'));
  } catch {
    throw processError('ENORUN', `Нет файла processes/${slug}/run.py.`);
  }
  if (!isInside(file, base)) {
    throw processError('EOUTSIDE', `Файл processes/${slug}/run.py ведёт за пределы папки processes, такой процесс не запускается.`);
  }
  if (!isFile(file)) throw processError('ENORUN', `Нет файла processes/${slug}/run.py.`);
  return file;
}

// Python ищется из папки вне кабинета: Windows ищет программу сначала в текущей папке, и python.exe
// или python.bat, подложенные в кабинет, нашлись бы раньше настоящего.
const outsideCwd = () => (process.platform === 'win32' ? SYSTEM_ROOT : dirname(process.execPath));

function isOutsideCabinet(exe, root) {
  if (typeof exe !== 'string' || !exe || !isAbsolute(exe)) return false;
  let real = exe;
  try {
    real = realpathSync(exe);
  } catch {
    // Псевдоним программы (Microsoft Store) может не раскрываться: проверяем путь как есть.
  }
  let top = resolve(root);
  try {
    top = realpathSync(root);
  } catch {
    // кабинета нет: сравниваем с путём как есть
  }
  return ![exe, real].some((p) => samePath(p, top) || isInside(p, top) || isInside(p, resolve(root)));
}

// Путь к Python из вывода пробы: последняя непустая строка, строка JSON. Юникод в пути приходит
// экранированным (\uXXXX), поэтому кодовая страница канала его не искажает. Не строка JSON: null.
export function parseExecutable(out) {
  const line = String(out ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return null;
  try {
    const value = JSON.parse(line);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

// Абсолютный путь к Python: тот же выбор, что в проверке сетапа (python или py -3 на Windows, python3 или python
// на остальных), затем sys.executable. Путь принимается, только если это файл вне кабинета. null: подходящего нет.
// Проба печатает путь через json.dumps (только ASCII) в UTF-8: на Windows Python пишет в канал в кодовой
// странице ANSI, и профиль «Айгуль Н» или казахские буквы иначе превращаются в мусор или в ошибку.
export async function resolvePython(root) {
  const { defaultExec, detectPython } = await import('./check.mjs');
  const cwd = outsideCwd();
  const exec = (cmd, args, o = {}) => defaultExec(cmd, args, { ...o, cwd });
  const py = await detectPython(exec, process.platform);
  if (!py) return null;
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const r = await exec(py.cmd, [...py.pre, '-c', 'import json, sys; print(json.dumps(sys.executable))'], { timeout: 15000, env });
  const exe = r.code === 0 ? parseExecutable(r.stdout) : null;
  return exe && isFile(exe) && isOutsideCabinet(exe, root) ? exe : null;
}

let foundPython = null;

export async function findPython(root) {
  if (foundPython && isFile(foundPython) && isOutsideCabinet(foundPython, root)) return foundPython;
  const exe = await resolvePython(root);
  foundPython = exe;
  return exe;
}

// Python не запустился по запомненному пути: забываем путь, следующий запуск найдёт Python заново.
function forgetPython(exe) {
  if (foundPython === exe) foundPython = null;
}

// На Windows дерево процессов останавливает taskkill (полный путь: не из папки кабинета), на остальных
// системах вся группа процессов. Не вышло: останавливаем хотя бы сам процесс.
export function killTree(child) {
  if (process.platform === 'win32') {
    const k = spawn(TASKKILL, ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
    k.on('exit', (code) => {
      if (code !== 0) child.kill();
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

const humanTime = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} мин` : `${Math.round(ms / 1000)} с`);

function writeLine(fd, text) {
  try {
    writeSync(fd, `\n${text}\n`);
  } catch {
    // Лог не пишется: результат запуска всё равно попадёт в статус.
  }
}

// processes/<slug>/run.py → <slug> (имя процесса для журнала).
const slugOf = (runFile) => basename(dirname(runFile));

function spawnRun(root, exe, runFile, fd, logPath, opts) {
  const { timeoutMs, logLimitBytes, killGraceMs, stopTree, control } = opts;
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
          // не обрезался: строка всё равно допишется в конец
        }
        writeLine(fd, `Процесс остановлен: слишком большой журнал (больше ${Math.round(logLimitBytes / 1048576)} МБ).`);
      }
      done({ code, stopped, spawnFailed });
    };
    // Остановка: всё дерево процессов; не закончился за killGraceMs, значит добиваем сам процесс
    // и считаем запуск неудачным, чтобы процесс не остался «идёт» навсегда.
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
        cwd: root,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', fd, fd],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', CABINET_JOURNAL: journalFile(root), CABINET_SERVICE: slugOf(runFile) },
      });
    } catch (e) {
      spawnFailed = true;
      writeLine(fd, `Не удалось запустить Python (${e.code ?? e.message}).`);
      return finish(null);
    }
    child.on('error', (e) => {
      // Процесс уже запущен (есть pid): это ошибка остановки, ждём выхода или паузы добивания.
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
        // размер не прочитался: проверим в следующий раз
      }
    }, LOG_CHECK_MS);
  });
}

// Синхронно проверяет и занимает процесс (замок), затем запускает run.py. Бросает ошибку с кодом, если запускать нельзя.
// done никогда не отклоняется: { ok, code, durationMs, logPath }; cancel() останавливает запуск.
// python: абсолютный путь к интерпретатору (по умолчанию ищется сам); killTree подменяется только в тестах.
export function startRun(
  root,
  slug,
  {
    python,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logLimitBytes = LOG_LIMIT_BYTES,
    killGraceMs = KILL_GRACE_MS,
    maxConcurrent = MAX_CONCURRENT,
    killTree: stopTree = killTree,
  } = {},
) {
  root = resolve(root);
  const runFile = checkRunnable(root, slug);
  const outDir = join(root, 'output', slug);
  mkdirSync(outDir, { recursive: true });
  const lock = acquireLock(root, slug, timeoutMs);
  const logPath = join(outDir, 'last-run.log');
  let fd;
  try {
    if (runningInCabinet(root, slug) >= maxConcurrent) {
      throw processError(
        'ELIMIT',
        `Одновременно можно запускать не больше ${maxConcurrent} расчётов. Дождитесь, пока один закончится, и запустите снова.`,
      );
    }
    // Дописывание в конец: и Python, и строки этого модуля попадают после уже записанного.
    writeFileSync(logPath, '');
    fd = openSync(logPath, 'a');
  } catch (e) {
    releaseLock(root, slug, lock);
    throw e;
  }
  const control = { stop: null, cancelled: false };
  const started = Date.now();
  const before = folderSnapshot(join(root, 'input', slug));
  const done = (async () => {
    let code = null;
    let stopped = null;
    try {
      const exe = python ?? (await findPython(root));
      if (control.cancelled) {
        stopped = 'cancel';
        writeLine(fd, 'Расчёт прерван: запуск остановили.');
      } else if (!exe) {
        writeLine(fd, 'Python не найден. Скажите Claude «проверь сетап».');
      } else {
        let spawnFailed;
        ({ code, stopped, spawnFailed } = await spawnRun(root, exe, runFile, fd, logPath, { timeoutMs, logLimitBytes, killGraceMs, stopTree, control }));
        if (spawnFailed) forgetPython(exe);
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
    const durationMs = Date.now() - started;
    // Сначала итог, потом снять замок: кто увидит «не идёт», уже прочитает свежий last-run.json.
    writeLastRun(root, slug, { ok, code, finishedAt: new Date().toISOString(), durationMs });
    releaseLock(root, slug, lock);
    appendJournal(root, { service: slug, event: 'run', ok, code, ms: durationMs, files: snapshotDiff(before, folderSnapshot(join(root, 'input', slug))) });
    return { ok, code, durationMs, logPath };
  })();
  const cancel = () => {
    control.cancelled = true;
    control.stop?.('cancel');
  };
  return { done, logPath, cancel };
}

export function runProcess(root, slug, options) {
  try {
    return startRun(root, slug, options).done;
  } catch (e) {
    return Promise.reject(e);
  }
}

// ---------- демо курса ----------

// Демо-процессы курса: шаблон templates/processes/<slug>/ и файлы учебного кейса, которые кладутся в input/<slug>/.
// Только файлы кейса (их выдумали для курса): файлы человека в input кладёт сам человек.
export const DEMOS = {
  'svetofor-tochek': ['input/case/data/prodazhi_1c.csv'],
};

// Копия папки шаблона без служебных папок (__pycache__, скрытые). Существующие файлы не перезаписываются.
function copyTemplate(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '__pycache__') continue;
    const from = join(src, e.name);
    const to = join(dst, e.name);
    if (e.isDirectory()) copyTemplate(from, to);
    else if (e.isFile()) copyFileSync(from, to, constants.COPYFILE_EXCL);
  }
}

const sameBytes = (a, b) => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

// Ставит демо: процесс из шаблона (если его ещё нет), папка input/<slug> и копии файлов кейса (если их там нет).
// Сначала все проверки, потом копирование: свой процесс человека с тем же именем и свой файл с именем файла
// кейса не трогаются, и тогда ничего не ставится и не считается. Возвращает { installed, placed, kept }.
export function installDemo(root, slug) {
  if (!Object.hasOwn(DEMOS, slug)) {
    throw processError('ENODEMO', `Такого демо нет: ${slug}. Есть: ${Object.keys(DEMOS).join(', ')}.`);
  }
  const files = DEMOS[slug];
  const tpl = join(root, 'templates', 'processes', slug);
  const dst = join(root, 'processes', slug);
  if (!isFile(join(tpl, 'run.py'))) throw processError('ENODEMO', `Нет шаблона templates/processes/${slug}. Скажите Claude «обнови кабинет».`);
  for (const rel of files) {
    if (!isFile(join(root, rel))) throw processError('ENODEMO', `Нет файла учебного кейса ${rel}. Скажите Claude «обнови кабинет».`);
  }
  if (existsSync(dst) && !sameBytes(join(tpl, 'run.py'), join(dst, 'run.py'))) {
    throw processError(
      'EOWN',
      `В кабинете уже есть свой процесс processes/${slug}, демо поверх него не ставлю. ` +
        `Если это прежнее демо курса, удалите папку processes/${slug} и повторите.`,
    );
  }
  const inputDir = join(root, 'input', slug);
  const kept = [];
  for (const rel of files) {
    const target = join(inputDir, basename(rel));
    if (!existsSync(target)) continue;
    if (!sameBytes(join(root, rel), target)) {
      throw processError(
        'EINPUT',
        `В папке input/${slug} есть другой файл ${basename(rel)}: он не совпадает с файлом учебного кейса ${rel}. ` +
          'Демо на нём не считаю. Если это ваш файл, переименуйте его или уберите из этой папки и повторите.',
      );
    }
    kept.push(`input/${slug}/${basename(rel)}`);
  }
  let installed = false;
  if (!existsSync(dst)) {
    copyTemplate(tpl, dst);
    installed = true;
  }
  mkdirSync(inputDir, { recursive: true });
  const placed = [];
  for (const rel of files) {
    const target = join(inputDir, basename(rel));
    if (existsSync(target)) continue;
    copyFileSync(join(root, rel), target, constants.COPYFILE_EXCL);
    placed.push(`input/${slug}/${basename(rel)}`);
  }
  return { installed, placed, kept };
}

// Файлы учебного кейса (input/case/data, с подпапками): путь от data и размер.
function caseFiles(root) {
  const base = join(root, 'input', 'case', 'data');
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.push({ path: p, rel: r, size: statSync(p).size });
    }
  };
  walk(base, '');
  return out;
}

// Оглавление документа xlsx или docx без docProps/ (время создания и правки, автор): { член: { size, read } }
// из центрального каталога zip, без распаковки. Файл кейса из архива платформы курса пересобран: члены и их
// байты те же, а время в zip и docProps другие. Не zip, больше OFFICE_MEMBERS членов, повтор имени: null.
const OFFICE_EXT = new Set(['.xlsx', '.docx']);
const OFFICE_MEMBERS = 2000;
const OFFICE_INFLATE_LIMIT = 64 * 1024 * 1024; // распаковка своего файла при сверке с кейсом, всего
function officeIndex(path) {
  try {
    if (statSync(path).size > ZIP_FILE_LIMIT) return null;
    const entries = zipEntries(readFileSync(path));
    if (entries.length > OFFICE_MEMBERS) return null;
    const names = new Set();
    const index = new Map();
    for (const e of entries) {
      if (names.has(e.name)) return null;
      names.add(e.name);
      if (!e.name.endsWith('/') && !/^docProps\//i.test(e.name)) index.set(e.name, e);
    }
    return index;
  } catch {
    return null;
  }
}

// Те же члены с теми же объявленными размерами: дёшево, по каталогу, до распаковки.
const sameIndex = (a, b) => a !== null && b !== null && a.size === b.size && [...a].every(([name, e]) => b.get(name)?.size === e.size);

// Те же байты членов. Член своего файла распаковывается не больше объявленного размера (он равен размеру
// члена кейса), всего не больше budget.left байт; бюджет кончился или член не читается: не копия.
function sameMembers(mine, theirs, budget) {
  try {
    for (const [name, e] of mine) {
      const c = theirs.get(name);
      c.data ??= c.read();
      if (budget.left < e.size) return false;
      const data = e.read(e.size);
      budget.left -= data.length;
      if (!data.equals(c.data)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Копия файла учебного кейса: то же содержимое, имя может быть другим. Возвращает имя файла кейса или null.
// Сначала байт в байт; xlsx и docx ещё и по содержимому архива (только с файлами кейса того же вида и с тем же
// оглавлением), другие виды файлов только байт в байт. Оглавление и члены файла кейса читаются один раз за
// вызов caseFiles.
function caseCopyOf(file, cases) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  let hit = cases.find((c) => c.size === size && sameBytes(c.path, file));
  const ext = extname(file).toLowerCase();
  if (!hit && OFFICE_EXT.has(ext)) {
    const same = cases.filter((c) => extname(c.path).toLowerCase() === ext);
    const mine = same.length ? officeIndex(file) : null;
    const budget = { left: OFFICE_INFLATE_LIMIT };
    if (mine) {
      hit = same.find((c) => {
        if (c.index === undefined) c.index = officeIndex(c.path);
        return sameIndex(mine, c.index) && sameMembers(mine, c.index, budget);
      });
    }
  }
  return hit ? hit.rel : null;
}

// ---------- чтение файла скилла и документа Word ----------

// Скилл со второго воркшопа человек скачивает файлом: SKILL.md, архив .zip или .skill (тоже zip). Документ
// Word (.docx) тоже zip. Читаем только в память, на диск ничего не распаковываем.
const ZIP_FILE_LIMIT = 20 * 1024 * 1024;
const ZIP_ENTRY_LIMIT = 5 * 1024 * 1024;
const TEXT_LIMIT = 200 * 1024;
const SKILL_EXT = new Set(['.md', '.txt', '.zip', '.skill']);
const READ_EXT = new Set([...SKILL_EXT, '.docx']);
const TEXT_EXT = /\.(md|txt|markdown)$/i;
const PROGRAM_EXT = /\.py$/i;

// Встроенная команда скилла: восклицательный знак и сразу, вплотную, команда в обратных кавычках или блок
// кода, открытый тремя обратными кавычками с восклицательным знаком. Claude Code выполняет её при запуске
// скилла без вопроса. «Готово! `файл`» через пробел не команда.
const SKILL_CMD = /!`[^`\n]+`|```[ \t]*!/;

export function skillCommandLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter((l) => SKILL_CMD.test(l.text));
}

// Файлы архива zip: [{ name, size, read(limit) }], size: размер без сжатия из каталога, read распаковывает не
// больше limit байт (и не больше 5 МБ). Только stored и deflate, без шифрования и zip64.
export function zipEntries(buf) {
  const bad = (why) => processError('EZIP', why);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('файл не похож на архив zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw bad('архив слишком большой для чтения здесь');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('архив повреждён');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const skip = nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + skip;
    const read = (limit = ZIP_ENTRY_LIMIT) => {
      if (flags & 1) throw bad(`файл ${name} в архиве закрыт паролем`);
      if (usize > ZIP_ENTRY_LIMIT || csize > ZIP_ENTRY_LIMIT) throw bad(`файл ${name} в архиве больше 5 МБ`);
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad('архив повреждён');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(limit, ZIP_ENTRY_LIMIT)) });
      throw bad(`файл ${name} в архиве сжат неизвестным способом`);
    };
    entries.push({ name, size: usize, read });
  }
  return entries;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

// Текст word/document.xml: абзац на строку, строка таблицы одной строкой с ячейками через « | ».
export function docxText(xml) {
  const lines = [];
  let para = '';
  let cell = null;
  let row = null;
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>|<w:tc[\s>]|<\/w:tc>|<w:tr[\s>]|<\/w:tr>/g;
  for (const m of xml.matchAll(re)) {
    const tag = m[0];
    if (m[1] !== undefined) para += unxml(m[1]);
    else if (tag === '<w:tab/>') para += '\t';
    else if (tag === '<w:br/>') para += ' ';
    else if (tag === '</w:p>') {
      if (cell !== null) cell.push(para.trim());
      else lines.push(para);
      para = '';
    } else if (tag.startsWith('<w:tr')) row = [];
    else if (tag.startsWith('<w:tc')) cell = [];
    else if (tag === '</w:tc>') {
      if (row && cell) row.push(cell.filter(Boolean).join(' '));
      cell = null;
    } else if (tag === '</w:tr>') {
      if (row) lines.push(row.join(' | '));
      row = null;
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const decodeText = (bytes) => Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');

// Файл из input/<slug>/ для Claude: { text, code }. Скилл: текст SKILL.md (и других текстов архива) и строки
// со встроенными командами. Документ Word: текст по абзацам.
export function readInputFile(root, slug, name) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return { text: 'Имя папки процесса: строчные латинские буквы, цифры и дефис, до 40 знаков.', code: 2 };
  }
  const dir = join(root, 'input', slug);
  const files = isDir(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.startsWith('~$')).map((e) => e.name)
    : [];
  const listing = files.length ? `Файлы в папке input/${slug}: ${files.join(', ')}.` : `Папка input/${slug} пуста или её нет.`;
  if (!name) return { text: `Укажите файл: node tools/processes.mjs read ${slug} "<имя файла>". ${listing}`, code: 2 };
  if (name !== basename(name) || name === '.' || name === '..' || name.includes('\\') || name.includes('/')) {
    return { text: `Укажите только имя файла из папки input/${slug}, без папок. ${listing}`, code: 2 };
  }
  const file = join(dir, name);
  const ext = extname(name).toLowerCase();
  if (!isFile(file)) return { text: `Нет файла input/${slug}/${name}. ${listing}`, code: 2 };
  if (!READ_EXT.has(ext)) {
    return {
      text: `Файл ${name} здесь не читается: нужен скилл (.md, .zip, .skill) или документ Word (.docx). Таблицы смотрите через python tools/read_table.py.`,
      code: 2,
    };
  }
  if (statSync(file).size > ZIP_FILE_LIMIT) return { text: `Файл ${name} больше 20 МБ, такой здесь не читается.`, code: 2 };
  const buf = readFileSync(file);
  const out = [];
  const texts = []; // [{ label, text }] для поиска встроенных команд
  try {
    if (ext === '.md' || ext === '.txt') {
      const text = decodeText(buf);
      out.push(`Файл ${name}:`, text);
      texts.push({ label: name, text });
    } else if (ext === '.docx') {
      const doc = zipEntries(buf).find((e) => e.name === 'word/document.xml');
      if (!doc) throw processError('EZIP', 'это не документ Word: внутри нет word/document.xml');
      out.push(`Документ Word ${name}, текст по абзацам (строки таблиц через « | »):`, docxText(decodeText(doc.read())));
    } else {
      const entries = zipEntries(buf).filter((e) => !e.name.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.name));
      const depth = (e) => e.name.split('/').length;
      const skill = entries.filter((e) => /(^|\/)skill\.md$/i.test(e.name)).sort((a, b) => depth(a) - depth(b))[0];
      out.push(`Архив ${name}, файлов ${entries.length}: ${entries.map((e) => e.name).join(', ')}.`);
      if (!skill) throw processError('EZIP', 'в архиве нет файла SKILL.md: это не скилл');
      const textual = [skill, ...entries.filter((e) => e !== skill && TEXT_EXT.test(e.name))];
      for (const e of textual) {
        const text = decodeText(e.read());
        out.push('', `Текст ${e.name}:`, text);
        texts.push({ label: e.name, text });
      }
      // Программа расчёта, которую чат положил в скилл (scripts/build.py): основа для программы процесса.
      // Она пришла извне: только показываем текст, не запускаем.
      const programs = entries.filter((e) => PROGRAM_EXT.test(e.name));
      for (const e of programs) {
        out.push('', `Программа ${e.name} из архива (только текст: программу из архива не запускают, это файл извне):`, decodeText(e.read()));
      }
      const other = entries.filter((e) => !textual.includes(e) && !programs.includes(e));
      if (other.length) {
        out.push('', `Остальные файлы архива (${other.map((e) => e.name).join(', ')}) здесь не показаны.`);
      }
    }
  } catch (e) {
    if (e.code === 'EZIP' || e.code === 'ERR_BUFFER_TOO_LARGE' || /inflate|incorrect|invalid/i.test(String(e.message))) {
      return { text: `Файл ${name} не читается: ${e.code === 'EZIP' ? e.message : 'архив повреждён'}.`, code: 2 };
    }
    throw e;
  }
  let text = out.join('\n');
  if (text.length > TEXT_LIMIT) text = `${text.slice(0, TEXT_LIMIT)}\n... (текст длиннее ${TEXT_LIMIT / 1024} КБ, дальше не показан)`;
  if (SKILL_EXT.has(ext)) {
    const found = texts.flatMap((t) => skillCommandLines(t.text).map((l) => `  ${t.label}, строка ${l.line}: ${l.text}`));
    text += found.length
      ? `\n\nВстроенные команды: ${found.length}. Они выполнятся сами при запуске скилла, без вопроса:\n${found.join('\n')}`
      : '\n\nВстроенных команд нет.';
  }
  return { text, code: 0 };
}

// ---------- сверка программы с эталоном ----------

// Эталон output/<slug>/etalon-skilla.json (имя файла с v1) записывает Claude: итоги из read_table.py (их считает
// программа на компьютере, в разговор идут только числа) и известный ответ человека. Файл построчно Claude не читает.
// Программа пишет те же разделы в result.json, в поле sverka. Разделы (все необязательные):
//   «итоги»: { название: число или текст }, «по категориям»: { категория: число },
//   «документов»: число, «по строкам»: { номер или ключ строки: категория или ключевое значение },
//   «срочно»: [ номера или ключи срочных строк ].
// Строка с двумя темами в эталоне (классификация): «X / Y» в «по строкам» (в «по категориям» она посчитана
// по первой теме X); программа взяла X или Y, это совпадение.
// Программа по темам пишет ещё «найдено»: { строка: { тема: [слова словаря] } }. По нему сверка подсказывает
// слабые слова: слово темы, которое стоит в строке другой темы у скилла.
export const MANUAL = 'разобрать вручную';
export const ETALON_FILE = 'etalon-skilla.json';
export const URGENT_SECTION = 'срочно';
const SECTIONS = ['итоги', 'по категориям', 'документов', 'по строкам', URGENT_SECTION];

const normText = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,]$/, '');

const normKey = (k) => {
  const t = normText(k).replace(/^№\s*/, '');
  return /^\d+([.,]0+)?$/.test(t) ? String(parseInt(t, 10)) : t;
};

const asNumber = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\s  ]/g, '').replace(',', '.');
  return /^[-+]?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

// Число совпадает с точностью до последнего знака эталона: 12345,6 в эталоне и 12345,63 у программы равны.
function sameValue(etalon, program) {
  const a = asNumber(etalon);
  const b = asNumber(program);
  if (a !== null && b !== null) {
    const decimals = (String(etalon).replace(/\s/g, '').split(/[.,]/)[1] ?? '').length;
    return Math.abs(a - b) <= 0.5 * 10 ** -decimals + 1e-9;
  }
  return normText(etalon) === normText(program);
}

const show = (v) => (v === null || v === undefined ? 'нет' : typeof v === 'number' ? String(v).replace('.', ',') : `«${v}»`);

const asMap = (obj) =>
  obj && typeof obj === 'object' && !Array.isArray(obj)
    ? new Map(Object.entries(obj).map(([k, v]) => [normKey(k), { key: k, value: v }]))
    : null;

// Темы эталона классификации: названия из «по категориям» и темы строк без « / ». Не классификация: null.
function etalonTopics(etalon) {
  const cats = asMap(etalon['по категориям']);
  if (!cats) return null;
  const topics = new Set([...cats.values()].map((c) => normText(c.key)));
  for (const { value } of asMap(etalon['по строкам'])?.values() ?? []) {
    if (typeof value === 'string' && !value.includes(' / ') && !['повтор', MANUAL].includes(normText(value))) topics.add(normText(value));
  }
  return topics;
}

// Темы строки у скилла: «X / Y» значит две темы, первая главная, только если обе части темы эталона.
// Иначе (черновик, сводная, часть не тема) значение одно, целиком.
const topicsOf = (v, topics) => {
  if (!topics || typeof v !== 'string' || !v.includes(' / ')) return [v];
  const parts = v.split(' / ').map((t) => t.trim()).filter(Boolean);
  return parts.length > 1 && parts.every((t) => topics.has(normText(t))) ? parts : [v];
};

// Номера строк раздела «срочно»: список (или объект: его ключи).
const keysOf = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v) : null);

const SHOW_ROWS = 40;
const listOf = (items) => (items.length > SHOW_ROWS ? [...items.slice(0, SHOW_ROWS), `  ... и ещё ${items.length - SHOW_ROWS}`] : items);

// Эталон по части файла (большой файл: скилл выполнен на первых строках; сводная больше 300 групп: первые 100
// групп): поле «строк в эталоне» с числом. Тогда сравниваются только строки эталона, остальные строки программы
// в эталон не входят и расхождением не считаются; категории и документы по части файла с программой не сравнить.
// Итоги эталон берёт из итогов read_table.py по всему файлу, поэтому они сравниваются всегда.
export const COVERAGE = 'строк в эталоне';
// Доля «разобрать вручную», выше которой сверка предупреждает: словарю, скорее всего, не хватает слов.
const MANUAL_WARN_SHARE = 0.2;
// Напоминание Claude перед правкой программы или словаря после сверки: одной строкой, один раз за вывод.
export const FIX_NOTE =
  'Для Claude: перед правкой программы или словаря напишите человеку текстом ответа: «Поправляю программу. Если Claude попросит разрешение, нажмите «Allow» (разрешить).»';

// Сравнение эталона и раздела sverka программы: { lines, code, differences, manual }.
// Строка, которую программа отправила в «разобрать вручную», расхождением не считается: она в списке
// для человека. Разница в категории, которая целиком объясняется такими строками, тоже.
// slovar: у процесса есть словарь (по умолчанию: программа пишет «найдено», так пишет программа по темам).
export function compareWithEtalon(etalon, program, { slovar = program?.['найдено'] !== undefined } = {}) {
  const lines = [];
  let differences = 0;
  let manual = 0;
  const manualByCategory = new Map();
  // Строки с двумя темами у скилла, где программа взяла не первую: [первая тема, тема программы].
  const shifted = [];
  const partial = typeof etalon[COVERAGE] === 'number' && Number.isFinite(etalon[COVERAGE]);
  const eRows = asMap(etalon['по строкам']);
  const pRowsAll = asMap(program['по строкам']);
  const topicSet = etalonTopics(etalon);
  if (eRows) {
    const pRows = pRowsAll ?? new Map();
    let same = 0;
    let twoTopics = 0;
    const wrong = [];
    const toManual = [];
    const missing = [];
    for (const [k, { key, value }] of eRows) {
      const got = pRows.get(k);
      const topics = topicsOf(value, topicSet);
      if (!got) missing.push(key);
      else if (normText(got.value) === MANUAL && normText(value) !== MANUAL) {
        toManual.push(`  ${key}: в эталоне ${show(value)}`);
        const main = normText(topics[0]);
        manualByCategory.set(main, (manualByCategory.get(main) ?? 0) + 1);
      } else if (sameValue(value, got.value)) same++;
      else if (topics.length > 1 && topics.some((t) => sameValue(t, got.value))) {
        same++;
        twoTopics++;
        if (!sameValue(topics[0], got.value)) shifted.push([topics[0], got.value]);
      } else wrong.push(`  ${key}: в эталоне ${show(value)}, у программы ${show(got.value)}`);
    }
    const extra = [...pRows.values()].filter((v) => !eRows.has(normKey(v.key))).map((v) => v.key);
    manual = toManual.length;
    lines.push(`По строкам: совпало ${same} из ${eRows.size}.`);
    if (twoTopics) lines.push(`Две темы в эталоне: ${twoTopics}, программа взяла одну из них.`);
    if (toManual.length) lines.push(`Программа отправила в «${MANUAL}»: ${toManual.length}.`, ...listOf(toManual));
    if (wrong.length) lines.push(`Другой результат у программы: ${wrong.length}.`, ...listOf(wrong));
    if (missing.length) lines.push(`Нет у программы: ${missing.length}: ${missing.slice(0, SHOW_ROWS).join(', ')}.`);
    if (extra.length && partial) {
      lines.push(`Не входят в эталон: ${extra.length} строк или групп программы (эталон по первым ${etalon[COVERAGE]}), их не сравниваем.`);
    } else if (extra.length) {
      lines.push(`Есть у программы, нет в эталоне: ${extra.length}: ${extra.slice(0, SHOW_ROWS).join(', ')}.`);
    }
    differences += wrong.length + missing.length + (partial ? 0 : extra.length);
  }
  // Срочные строки: пропуск срочной строки скилла это расхождение, лишняя срочная строка программы нет:
  // срочное лучше проверить лишний раз. Эталон по части файла: только строки эталона.
  const eHot = keysOf(etalon[URGENT_SECTION]);
  if (eHot) {
    const pHot = new Set((keysOf(program[URGENT_SECTION]) ?? []).map(normKey));
    const eHotKeys = new Set(eHot.map(normKey));
    const missed = eHot.filter((k) => !pHot.has(normKey(k)));
    const inEtalon = (k) => !partial || !eRows || eRows.has(k);
    const extraHot = [...(keysOf(program[URGENT_SECTION]) ?? [])].filter((k) => !eHotKeys.has(normKey(k)) && inEtalon(normKey(k)));
    if (missed.length) {
      lines.push(`Срочные строки: программа не отметила срочной ${missed.length} из ${eHot.length}: ${missed.slice(0, SHOW_ROWS).join(', ')}. Добавьте в раздел «срочно (не тема)» слово об опасности из этой строки.`);
    } else lines.push(`Срочные строки: совпали все (${eHot.length}).`);
    if (extraHot.length) lines.push(`Программа отметила срочными ещё ${extraHot.length}: ${extraHot.slice(0, SHOW_ROWS).join(', ')}. Это не расхождение: срочное лучше проверить лишний раз.`);
    differences += missed.length;
  } else {
    const pHot = keysOf(program[URGENT_SECTION]) ?? [];
    if (pHot.length) lines.push(`В эталоне нет раздела «срочно»: срочные строки программы (${pHot.length}: ${pHot.slice(0, SHOW_ROWS).join(', ')}) не сверены.`);
  }
  // Слабые слова: слово темы, которое нашлось в строке другой темы у скилла. Не расхождение: подсказка
  // для словаря (на новой неделе такое слово уводит строку не в ту тему; помеченное «?» тему само не решает).
  const found = program['найдено'];
  let weakWords = false;
  if (topicSet && eRows && found && typeof found === 'object' && !Array.isArray(found)) {
    const byRow = new Map(Object.entries(found).map(([k, v]) => [normKey(k), v]));
    const weak = new Map();
    for (const [k, { key, value }] of eRows) {
      const hits = byRow.get(k);
      if (!hits || typeof hits !== 'object' || [MANUAL, 'повтор'].includes(normText(value))) continue;
      const own = new Set(topicsOf(value, topicSet).map(normText));
      for (const [topic, words] of Object.entries(hits)) {
        if (own.has(normText(topic)) || !Array.isArray(words)) continue;
        for (const word of words) {
          if (String(word).trim().endsWith('?')) continue;
          const id = `«${word}» (${topic})`;
          if (!weak.has(id)) weak.set(id, []);
          weak.get(id).push(key);
        }
      }
    }
    if (weak.size) {
      const list = [...weak].slice(0, SHOW_ROWS).map(([id, rows]) => `${id}: ${rows.slice(0, 10).join(', ')}${rows.length > 10 ? ' ...' : ''}`);
      lines.push(`Слабые слова (стоят в строках другой темы в эталоне), пометьте их «?» в словаре: ${list.join('; ')}.`);
      weakWords = true;
    }
  }
  const whole = ['по категориям', 'документов'].filter((sec) => etalon[sec] !== undefined);
  if (partial && whole.length) {
    lines.push(`Эталон по части файла: ${whole.map((sec) => `«${sec}»`).join(', ')} по всему файлу с ним не сравнить, не сравниваем.`);
  }
  const eTotals = asMap(etalon['итоги']);
  if (partial && !eTotals) lines.push('В эталоне нет итогов: сверены только строки.');
  if (eTotals) {
    const pTotals = asMap(program['итоги']) ?? new Map();
    const bad = [];
    for (const [k, { key, value }] of eTotals) {
      const got = pTotals.get(k);
      if (!got || !sameValue(value, got.value)) bad.push(`  «${key}»: в эталоне ${show(value)}, у программы ${show(got?.value)}`);
    }
    lines.push(bad.length ? `Итоги: не совпало ${bad.length} из ${eTotals.size}.` : `Итоги: совпали все (${eTotals.size}).`, ...bad);
    differences += bad.length;
  }
  const eCats = partial ? null : asMap(etalon['по категориям']);
  // Строка с двумя темами посчитана в эталоне по первой теме; программа взяла вторую: сдвигаем её счёт.
  if (eCats) {
    for (const [from, to] of shifted) {
      const a = eCats.get(normKey(from));
      if (!a || asNumber(a.value) === null) continue;
      a.value = asNumber(a.value) - 1;
      const b = eCats.get(normKey(to));
      if (b && asNumber(b.value) !== null) b.value = asNumber(b.value) + 1;
      else if (!b) eCats.set(normKey(to), { key: String(to), value: 1 });
    }
  }
  if (eCats) {
    const pCats = asMap(program['по категориям']) ?? new Map();
    const bad = [];
    const explained = [];
    for (const [k, { key, value }] of eCats) {
      const got = pCats.get(k);
      const gotValue = got ? got.value : asNumber(value) !== null ? 0 : null;
      if (sameValue(value, gotValue)) continue;
      const gap = asNumber(value) !== null && asNumber(gotValue) !== null ? asNumber(value) - asNumber(gotValue) : null;
      if (gap !== null && gap > 0 && gap === (manualByCategory.get(k) ?? 0)) {
        explained.push(`  «${key}»: в эталоне ${show(value)}, у программы ${show(gotValue)}, разница ${show(gap)} в «${MANUAL}»`);
      } else {
        bad.push(`  «${key}»: в эталоне ${show(value)}, у программы ${show(gotValue)}`);
      }
    }
    for (const [k, { key, value }] of pCats) {
      if (!eCats.has(k) && k !== MANUAL && !sameValue(0, value)) bad.push(`  «${key}»: в эталоне нет, у программы ${show(value)}`);
    }
    if (!bad.length && !explained.length) lines.push(`По категориям: совпали все (${eCats.size}).`);
    else {
      lines.push(`По категориям: не совпало ${bad.length + explained.length}, из них объясняется строками «${MANUAL}»: ${explained.length}.`);
      lines.push(...explained, ...bad);
    }
    differences += bad.length;
  }
  if (!partial && etalon['документов'] !== undefined) {
    const got = program['документов'];
    if (sameValue(etalon['документов'], got)) lines.push(`Документов: ${show(got)}, как в эталоне.`);
    else {
      lines.push(`Документов: в эталоне ${show(etalon['документов'])}, у программы ${show(got)}.`);
      differences++;
    }
  }
  if (!SECTIONS.some((sec) => etalon[sec] !== undefined)) {
    lines.push(`В эталоне нет ни одного раздела: ${SECTIONS.map((sec) => `«${sec}»`).join(', ')}. Сравнивать нечего.`);
    return { lines, code: 2, differences, manual };
  }
  // Предупреждение, не расхождение: много строк ушло человеку, словарь стоит дополнить.
  if (pRowsAll && pRowsAll.size) {
    const sent = [...pRowsAll.values()].filter((v) => normText(v.value) === MANUAL).length;
    if (sent / pRowsAll.size > MANUAL_WARN_SHARE) {
      const why = slovar ? 'Проверьте словарь: скорее всего, в нём не хватает слов.' : `Причины в списке «${MANUAL}».`;
      lines.push(`Внимание: в «${MANUAL}» ушло ${sent} из ${pRowsAll.size} строк. ${why}`);
    }
  }
  if (differences || weakWords) lines.push(FIX_NOTE);
  if (differences) {
    lines.push(`Итог сверки: расхождений ${differences}. Поправьте словарь или программу и запустите снова.`);
  } else if (manual) {
    lines.push(`Итог сверки: результат программы совпал с эталоном, кроме ${manual} строк в «${MANUAL}».`);
  } else {
    lines.push('Итог сверки: результат программы совпал с эталоном.');
  }
  return { lines, code: differences ? 1 : 0, differences, manual };
}

// Что программе процесса нельзя: она запускается кнопкой без Claude и без окна. В интернет ходить можно
// (цены, отзывы, данные сайтов без ограничений), запускать другие программы нельзя. Проверка по строкам
// processes/<slug>/run.py (строки-комментарии пропускаются). Это проверка по словам, не песочница: она ловит
// запрещённое, написанное прямо, и известные обходы (функция по имени, другое имя для os). Возвращает
// [{ line, text, why }], по одной причине на строку.
// Библиотеки только из списка: стандартный Python, который нужен образцам справки, библиотеки для интернета,
// openpyxl, python-docx и read_table из tools. Остальные (asyncio, pty, runpy, shutil, subprocess и любые другие) по словам не проверить.
export const ALLOWED_IMPORTS = new Set([
  '__future__', 'json', 'os', 're', 'sys', 'datetime', 'pathlib', 'csv', 'math', 'decimal', 'collections',
  'itertools', 'difflib', 'unicodedata', 'zipfile', 'io', 'statistics', 'functools', 'string', 'typing',
  'dataclasses', 'copy', 'time', 'calendar', 'textwrap', 'enum', 'openpyxl', 'docx', 'read_table',
  // интернет: запросы к сайтам и разбор ответа
  'urllib', 'urllib3', 'http', 'requests', 'httpx', 'socket', 'ssl', 'html', 'xml', 'email', 'base64', 'hashlib',
  'gzip', 'uuid', 'random', 'smtplib', 'ftplib',
  // модель внутри сервиса: только через tools/llm.py, он пишет обращения в журнал кабинета
  'llm',
  // серверная часть своей страницы сервиса: помощник из lib проекта (tools/service_api.py)
  'service_api',
]);
// Что можно взять из os и sys через from ... import: остальное у них запуск программ и обходы проверки.
const FROM_LIMITS = { os: ['path'], sys: ['argv', 'exit', 'path', 'stderr', 'stdout'] };
const NOT_ALLOWED_IMPORT = 'библиотека не из списка (стандартный Python из справки, интернет, openpyxl, python-docx, read_table, llm)';

// Сначала названные прямо опасности (у них понятная причина), потом библиотеки не из списка, потом обходы.
const PROGRAM_RULES = [
  [/\b(subprocess|ctypes|importlib|webbrowser)\b/, 'запуск программ'],
  [/api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis|api\.mistral\.ai|api\.deepseek|gigachat|llm\.api\.cloud\.yandex|api\.groq|openrouter\.ai|\b(anthropic|openai)\b/i,
    'модель только через tools/llm.py: он пишет обращения в журнал кабинета'],
  [/\bhttp\.server\b|^\s*from\s+http\s+import\s+server\b/, 'своя страница или сервер в программе процесса'],
  [/\bos\.(system|popen|exec\w*|spawn\w*|posix_spawn\w*|startfile|fork\w*)\b/, 'запуск программ'],
  [/(?<![\w.])(eval|exec|compile|__import__)\s*\(/, 'выполнение текста как программы'],
];
const BYPASS_RULES = [
  [/\b(getattr|globals|locals|vars)\s*\(|__import__|builtins|\bsys\s*\.\s*(modules|_\w*)\b|__(subclasses|globals|dict|code)__/,
    'обход проверки: функция по имени (getattr, globals, builtins и подобные)'],
  [/\bos\s*\.\s*(?!path\b|replace\b)\w/, 'из os можно только os.path и os.replace'],
  [/(?<![\w.'"])(os|sys)\b(?!\s*\.)/, 'os или sys под другим именем', { skipImport: true }],
  [/\bshutil\.rmtree\b/, 'удаление папок'],
  [/\bPath\.home\b|\bexpanduser\b|["'](?:[A-Za-z]:[\\/]|\\\\\\\\[A-Za-z]|\/[A-Za-z]|~[\\/]|\.\.(?:[\\/]|["']))/, 'путь вне кабинета'],
];

// Почему импорт нельзя (или null). stmt: «import a.b as c, d» или «from a import (b, c)» одной строкой.
// extra: ещё разрешённые имена (свои модули проекта сервиса, tools/services.mjs).
function importProblem(stmt, extra) {
  const allowed = (name) => ALLOWED_IMPORTS.has(name) || extra.has(name);
  const from = /^from\s+(\S+)\s+import\s+(.+)$/s.exec(stmt);
  if (from) {
    const [, mod, list] = from;
    if (!allowed(mod.split('.')[0])) return NOT_ALLOWED_IMPORT;
    const names = list.replace(/[()\\]/g, ' ').split(',').map((n) => n.trim().split(/\s+/)[0]).filter(Boolean);
    const limit = FROM_LIMITS[mod];
    return limit && names.some((n) => !limit.includes(n)) ? `из ${mod} можно взять только ${limit.join(', ')}` : null;
  }
  for (const part of stmt.replace(/^import\s+/, '').replace(/\\/g, ' ').split(',')) {
    const [name, as] = part.trim().split(/\s+/);
    if (!name || !allowed(name.split('.')[0])) return NOT_ALLOWED_IMPORT;
    if (as === 'as' && FROM_LIMITS[name]) return 'os или sys под другим именем';
  }
  return null;
}

// Импорты строки (и после «;», «try:»), с продолжением на следующих строках: «\» в конце или «(» без «)».
// Комментарий в конце строки не в счёт.
function importsAt(lines, i) {
  const code = (k) => lines[k].replace(/#.*$/, '');
  let text = code(i);
  for (let j = i + 1; j < lines.length && (/\\\s*$/.test(text) || (/^\s*from\s/.test(text) && (text.match(/\(/g) ?? []).length > (text.match(/\)/g) ?? []).length)); j++) {
    text = `${text.replace(/\\\s*$/, '')} ${code(j)}`;
  }
  return text
    .split(';')
    .map((piece) => /(?:^|:)\s*((?:import|from)\s.*)$/s.exec(piece)?.[1].trim())
    .filter((stmt) => stmt && (/^import\s/.test(stmt) || /^from\s+\S+\s+import\b/.test(stmt)));
}

// allowImports: ещё разрешённые имена модулей (свои файлы .py проекта сервиса, tools/services.mjs).
export function programProblems(text, { allowImports = [] } = {}) {
  const extra = new Set(allowImports);
  const found = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const stmts = importsAt(lines, i);
    const rule = (rules) => rules.find(([re, , opts]) => !(opts?.skipImport && stmts.length) && re.test(line))?.[1];
    const why = rule(PROGRAM_RULES) ?? stmts.map((s) => importProblem(s, extra)).find(Boolean) ?? rule(BYPASS_RULES);
    if (why) found.push({ line: i + 1, text: line.trim(), why });
  });
  return found;
}

export function compareProcess(root, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return { text: 'Укажите процесс: node tools/processes.mjs compare <имя папки процесса>.', code: 2 };
  const etalonRel = `output/${slug}/${ETALON_FILE}`;
  const resultRel = `output/${slug}/result.json`;
  const load = (rel) => {
    try {
      return { data: readJson(join(root, ...rel.split('/'))) };
    } catch (e) {
      return { error: e.code === 'ENOENT' ? 'нет файла' : 'файл повреждён или не в формате JSON' };
    }
  };
  // Сначала сама программа: то, что ей нельзя, закрывает «готово» при любом итоге сверки.
  let program = '';
  try {
    program = readFileSync(join(root, 'processes', slug, 'run.py'), 'utf8');
  } catch {
    // нет программы: сверять нечего, это скажет вывод ниже
  }
  const problems = programProblems(program);
  const banned = problems.length
    ? [
        `В программе processes/${slug}/run.py есть то, что программе процесса нельзя (она работает без Claude и без окна):`,
        ...problems.slice(0, SHOW_ROWS).map((x) => `  строка ${x.line}: ${x.why}: ${x.text}`),
        FIX_NOTE,
        'Итог проверки программы: уберите это из программы, «готово» нельзя.',
      ]
    : [];
  const fail = (text, code) => ({ text: [text, ...banned].join('\n'), code: banned.length ? 1 : code });
  const etalon = load(etalonRel);
  if (etalon.error) return fail(`Эталона нет: ${etalonRel}, ${etalon.error}. Сначала запишите эталон: итоги из read_table.py и известный ответ человека.`, 2);
  const result = load(resultRel);
  if (result.error) return fail(`Результата программы нет: ${resultRel}, ${result.error}. Запустите node tools/processes.mjs run ${slug}.`, 2);
  const e = etalon.data;
  const p = result.data?.sverka;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return fail(`${etalonRel}: нужен объект JSON с разделами ${SECTIONS.map((s) => `«${s}»`).join(', ')}.`, 2);
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return fail(`В ${resultRel} нет раздела sverka: программа должна записать туда те же разделы, что в эталоне (${SECTIONS.map((s) => `«${s}»`).join(', ')}).`, 2);
  }
  const head = [`Сверка «${readProcessInfo(root, slug).title}»: эталон ${etalonRel}${e['файл'] ? ` (файл ${e['файл']})` : ''}, программа ${resultRel}${result.data.updated_at ? ` от ${formatTime(result.data.updated_at)}` : ''}.`];
  const r = compareWithEtalon(e, p, { slovar: isFile(join(root, 'processes', slug, 'slovar.json')) });
  // Напоминание про окно перед правкой один раз: оно уже есть в выводе сверки, у запрещённого его не повторяем.
  const tail = r.lines.includes(FIX_NOTE) ? banned.filter((l) => l !== FIX_NOTE) : banned;
  return { text: [...head, ...r.lines, ...tail].join('\n'), code: banned.length ? 1 : r.code };
}

// ---------- свои скиллы человека ----------

// Скиллы курса: их кабинет привозит сам, «своими» они не считаются.
export const COURSE_SKILLS = ['about-me', 'setup-check', 'update-cabinet', 'add-process', 'run-process', 'demo-process', 'find-process', 'ask-table'];

// Список своих скиллов из .claude/skills для операции «добавить процесс»: командой курса, без окна, с описаниями.
export function listSkills(root) {
  const dir = join(root, '.claude', 'skills');
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    // папки нет: своих скиллов нет
  }
  const own = names.filter((n) => !COURSE_SKILLS.includes(n) && isFile(join(dir, n, 'SKILL.md'))).sort();
  if (!own.length) return { text: 'Своих скиллов в кабинете нет, только скиллы курса.', code: 0 };
  const lines = [`Свои скиллы в кабинете: ${own.length}. Текст скилла: .claude/skills/<папка>/SKILL.md.`];
  for (const n of own) {
    let desc = '';
    try {
      const head = readFileSync(join(dir, n, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      const m = head.match(/^---\n[\s\S]*?^description:\s*(.+)$/m);
      desc = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    } catch {
      // не прочитался: только имя
    }
    lines.push(`- ${n}${desc ? `: ${desc.length > 200 ? `${desc.slice(0, 200)}...` : desc}` : ''}`);
  }
  return { text: lines.join('\n'), code: 0 };
}

// ---------- node tools/processes.mjs ----------

const USAGE = `Процессы кабинета:
  node tools/processes.mjs list               процессы, их результат и последний запуск
  node tools/processes.mjs run <имя>          запустить processes/<имя>/run.py, как кнопкой «Запустить»
  node tools/processes.mjs input <имя>        создать папку input/<имя> и открыть её в Проводнике (--no-open: не открывать)
  node tools/processes.mjs read <имя> <файл>  показать текст скилла (.md, .zip, .skill) или документа Word из input/<имя>
  node tools/processes.mjs compare <имя>      проверить программу и сверить её результат с эталоном скилла output/<имя>/etalon-skilla.json
  node tools/processes.mjs skills             свои скиллы человека в .claude/skills (без скиллов курса)
  node tools/processes.mjs demo <имя>         поставить демо курса из templates/processes и запустить
<имя>: имя папки процесса латиницей, например svodka-prodazh.`;

const COLOR = { green: 'зелёный', yellow: 'жёлтый', red: 'красный' };
const pad2 = (n) => String(n).padStart(2, '0');

// 2026-10-22T14:05:09+05:00 → 22.10.2026 14:05 по часам компьютера, как на карточке.
function formatTime(iso) {
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} с`;

// Имя скилла, на котором построен процесс (поле skill в process.json, необязательно).
function skillOf(root, slug) {
  try {
    const s = readJson(join(root, 'processes', slug, 'process.json')).skill;
    return typeof s === 'string' && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

// Удачный запуск, после которого карточка не обновилась (result.json нет, он не по схеме или старше запуска),
// удачным не называем.
function describeLastRun(root, slug, lastRun, result) {
  if (!lastRun) return null;
  const when = formatTime(lastRun.finishedAt);
  if (lastRun.ok) {
    let mtime = -Infinity;
    try {
      mtime = statSync(join(root, 'output', slug, 'result.json')).mtimeMs;
    } catch {
      // нет файла
    }
    const fresh = result && mtime >= Date.parse(lastRun.finishedAt) - (lastRun.durationMs ?? 0) - 2000;
    return fresh
      ? `Последний запуск: ${when}, удачно.`
      : `Последний запуск: ${when}, программа закончилась без ошибки, но карточку не обновила (output/${slug}/result.json).`;
  }
  const code = lastRun.code === null ? '' : ` (код ${lastRun.code})`;
  return `Последний запуск: ${when}, не удался${code}, журнал output/${slug}/last-run.log.`;
}

// Страница, поставленная до карточек процессов (site/ не перезаписывается обновлением): нет подключения render.js.
function oldPageLine(root) {
  let html;
  try {
    html = readFileSync(join(root, 'site', 'index.html'), 'utf8');
  } catch {
    return null;
  }
  return html.includes('render.js') ? null : 'Страница site/index.html старой версии: на ней нет карточек процессов.';
}

export function formatList(root) {
  const list = listProcesses(root);
  const page = oldPageLine(root);
  if (!list.length) {
    const empty = 'Процессов в кабинете пока нет. Чтобы добавить, скажите Claude «добавь процесс».';
    return { text: page ? `${empty}\n${page}` : empty, code: 0 };
  }
  const lines = [`Процессов в кабинете: ${list.length}.`];
  list.forEach((p, i) => {
    // Скилл называем только у процессов, которые выполняет сам Claude: у программы процесса слово «скилл»
    // в строке сбивало с толку, и расчёт делали вручную вместо run.
    const phrase = `фраза «${p.phrase || `запусти ${p.title}`}»`;
    const skill = skillOf(root, p.slug);
    const how =
      p.kind === 'script'
        ? `программа процесса, кнопка «Запустить», ${phrase}`
        : p.kind === 'claude'
          ? `выполняет сам Claude${skill ? ` по скиллу ${skill}` : ''}, ${phrase}`
          : 'запуск не настроен';
    lines.push(`${i + 1}. «${p.title}» (папка ${p.slug}): ${how}.`);
    if (p.kind === 'claude') {
      lines.push(`   Процесс старого вида, без программы и кнопки. Чтобы появилась кнопка, скажите Claude «доработай ${p.title}».`);
    }
    if (p.running) lines.push('   Сейчас идёт расчёт.');
    if (p.result) {
      lines.push(`   Результат: обновлён ${formatTime(p.result.updated_at)}, ${COLOR[p.result.status]}. Итог: ${p.result.summary}`);
    } else if (!p.error) {
      lines.push('   Результата пока нет.');
    }
    const last = describeLastRun(root, p.slug, processStatus(root, p.slug).lastRun, p.result);
    if (last) lines.push(`   ${last}`);
    if (p.error) lines.push(`   Ошибка: ${p.error}`);
  });
  if (page) lines.push(page);
  return { text: lines.join('\n'), code: list.some((p) => p.error) ? 1 : 0 };
}

function logTail(logPath, count = 12) {
  try {
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-count);
  } catch {
    return [];
  }
}

// Отчёт о запуске для Claude: «Готово» только если result.json записан этим запуском и годится для карточки.
function reportRun(root, slug, r, startedAt) {
  const title = readProcessInfo(root, slug).title;
  const rel = `output/${slug}/result.json`;
  if (!r.ok) {
    const code = r.code === null ? '' : ` (код ${r.code})`;
    const tail = logTail(r.logPath);
    const lines = [`Расчёт «${title}» не удался${code}. Журнал: output/${slug}/last-run.log`];
    if (tail.length) lines.push('Последние строки журнала:', ...tail.map((l) => `  ${l}`));
    return { text: lines.join('\n'), code: 1 };
  }
  const file = join(root, 'output', slug, 'result.json');
  let mtime;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return { text: `Расчёт закончился, но программа не записала ${rel}: карточка на странице не обновится.`, code: 1 };
  }
  const res = readResult(root, slug);
  if (res.error) return { text: `Расчёт закончился, но результат не годится для карточки: ${res.error}`, code: 1 };
  // Запас 2 с на грубые часы файловой системы.
  if (mtime < startedAt - 2000) {
    return { text: `Расчёт закончился, но ${rel} не обновился: на карточке остался прежний результат.`, code: 1 };
  }
  const result = res.result;
  const lines = [
    `Готово: «${title}», расчёт занял ${seconds(r.durationMs)}.`,
    `Итог: ${result.summary}`,
    `Цвет карточки: ${COLOR[result.status]}.`,
    `Обновлено: ${formatTime(result.updated_at)}.`,
    `Результат: ${rel}`,
  ];
  if (Array.isArray(result.files) && result.files.length) lines.push(`Файлы: ${result.files.map((f) => f.replace(/\\/g, '/')).join(', ')}`);
  return { text: lines.join('\n'), code: 0 };
}

const known = (root) => listProcesses(root).map((p) => p.slug).join(', ') || 'процессов пока нет';

async function cliRun(root, slug) {
  if (!slug) return { text: 'Укажите процесс: node tools/processes.mjs run <имя папки процесса>.', code: 2 };
  let run;
  const startedAt = Date.now();
  try {
    run = startRun(root, slug);
  } catch (e) {
    if (e.code === 'EBADSLUG' || e.code === 'ENOPROCESS') {
      return { text: `Такого процесса нет: ${slug}. Процессы кабинета: ${known(root)}.`, code: 2 };
    }
    return { text: e.message, code: 2 };
  }
  // Команду остановили (Ctrl+C или ограничение времени): останавливаем и расчёт, замок снимется.
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = () => run.cancel();
  for (const s of signals) process.on(s, onSignal);
  const r = await run.done;
  for (const s of signals) process.off(s, onSignal);
  return reportRun(root, slug, r, startedAt);
}

export function openFolder(dir) {
  const [cmd, args] =
    process.platform === 'win32'
      ? [join(SYSTEM_ROOT, 'explorer.exe'), [dir]]
      : process.platform === 'darwin'
        ? ['open', [dir]]
        : ['xdg-open', [dir]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function cliInput(root, slug, open) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return { text: 'Имя папки процесса: строчные латинские буквы, цифры и дефис, до 40 знаков, например svodka-prodazh.', code: 2 };
  }
  const dir = join(root, 'input', slug);
  const existed = isDir(dir);
  mkdirSync(dir, { recursive: true });
  // Копию файла учебного кейса помечаем: она учебная (без вопроса о коммерческих данных, дата легенды).
  const cases = caseFiles(root);
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.startsWith('~$'))
    .map((e) => {
      const copy = caseCopyOf(join(dir, e.name), cases);
      return copy ? `${e.name} (копия файла учебного кейса ${copy})` : e.name;
    });
  const lines = [`Папка ${existed ? 'уже есть' : 'создана'}: ${dir}`];
  lines.push(files.length ? `Файлы в ней: ${files.join(', ')}.` : 'Файлов в ней пока нет.');
  if (open && openFolder(dir)) lines.push(`Папка открыта в ${process.platform === 'darwin' ? 'Finder' : 'Проводнике'}.`);
  return { text: lines.join('\n'), code: 0 };
}

async function cliDemo(root, slug) {
  if (!slug) return { text: `Укажите демо: node tools/processes.mjs demo <имя>. Есть: ${Object.keys(DEMOS).join(', ')}.`, code: 2 };
  let setup;
  try {
    setup = installDemo(root, slug);
  } catch (e) {
    return { text: e.message, code: 2 };
  }
  const title = readProcessInfo(root, slug).title;
  const lines = [
    setup.installed ? `Демо «${title}» поставлен в processes/${slug}.` : `Демо «${title}» уже стоит в processes/${slug}.`,
  ];
  if (setup.placed.length) lines.push(`Копия файла учебного кейса положена: ${setup.placed.join(', ')}.`);
  if (setup.kept.length) lines.push(`Копия файла учебного кейса уже лежит: ${setup.kept.join(', ')}.`);
  const run = await cliRun(root, slug);
  return { text: `${lines.join('\n')}\n${run.text}`, code: run.code };
}

async function dispatch(root, argv) {
  const [cmd, slug] = argv;
  if (cmd === 'list') return formatList(root);
  if (cmd === 'run') return cliRun(root, slug);
  if (cmd === 'input') return cliInput(root, slug, !argv.includes('--no-open'));
  if (cmd === 'read') return readInputFile(root, slug, argv.slice(2).filter((a) => !a.startsWith('--')).join(' '));
  if (cmd === 'compare') return compareProcess(root, slug);
  if (cmd === 'skills') return listSkills(root);
  if (cmd === 'demo') return cliDemo(root, slug);
  return { text: USAGE, code: cmd ? 2 : 0 };
}

// Вывод читает Claude: вместо трейсбека одна строка по-русски с кодом ошибки.
export async function main(argv = process.argv.slice(2)) {
  // Windows не ищет программы (explorer, python) в текущей папке, то есть в кабинете.
  process.env.NoDefaultCurrentDirectoryInExePath = '1';
  const root = fileURLToPath(new URL('..', import.meta.url));
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
