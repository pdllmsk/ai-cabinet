// API сервиса «Аналитика таблиц» под /<token>/api/analiz/ (страница site/analiz.html). Без зависимостей.
// Считает движок tools/analiz.py (подкоманды passport, ask, excel): он запускается своим Python кабинета
// (абсолютный путь вне кабинета, как у процессов), из корня кабинета, без оболочки, аргументы отдельными строками.
// Ответ движка: JSON в stdout. Коды выхода: 0 готово, 3 на компьютере нет claude, 4 запрос не прошёл проверку
// llm.py (слишком большой объём), 5 вопрос требует читать текст строк (это делает Claude во вкладке Code), другие (обычно 2): ошибка,
// её текст в JSON (error) или в последней строке stderr.
//
//   GET  api/analiz/passport          паспорт данных из input/analiz/ (файлы, листы, столбцы, число строк)
//   POST api/analiz/ask {question}     вопрос: движок шлёт в модель только паспорт и вопрос, считает сам
//   GET  api/analiz/history           история ответов из output/analiz/history.json, новые сверху
//   POST api/analiz/excel {id}         Excel с графиком в output/analiz/, ответ: ссылка на скачивание
//   POST api/analiz/open-folder       создаёт input/analiz/ и открывает её в Проводнике (Finder на Mac)
//   POST api/analiz/upload            файл со страницы в input/analiz/: тело файла как есть
//                                     (application/octet-stream), имя в заголовке X-File-Name (encodeURIComponent)
//   POST api/analiz/delete {file}     удалить таблицу из input/analiz/ (кнопка-корзина в «Ваших данных»):
//                                     путь как в паспорте, только внутри папки, без скрытых частей и ссылок
//
// Защита как у кнопки «Запустить»: токен в адресе (проверяет serve.mjs), заголовок X-Cabinet: 1 на всех
// запросах, у POST ещё тип JSON (у upload application/octet-stream). Чужая страница или ссылка без разрешения
// браузера такой запрос не пришлёт.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, copyFileSync, createWriteStream, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { findPython, isInside, killTree, openFolder as openInExplorer } from './processes.mjs';
import { journalFile } from './journal.mjs';

export const ANALIZ = 'analiz';
export const ASK_TIMEOUT_MS = 3 * 60 * 1000;
export const ENGINE_TIMEOUT_MS = 2 * 60 * 1000;
export const QUESTION_MAX = 1000;
export const HISTORY_SHOW = 50;
// Загрузка со страницы: таблицы, которые читает движок, до 50 МБ на файл.
export const UPLOAD_MAX = 50 * 1024 * 1024;
export const UPLOAD_EXT = ['.xlsx', '.xlsm', '.csv', '.txt'];
const NAME_MAX = 150;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const BODY_LIMIT = 16 * 1024;
const STDOUT_LIMIT = 20 * 1024 * 1024;
const STDERR_LIMIT = 256 * 1024;
const HISTORY_LIMIT = 50 * 1024 * 1024;
const KILL_GRACE_MS = 5000;
const MESSAGE_MAX = 600;
// Номер ответа из истории: латиница, цифры, «_», «.», «:», «-», не с «-» (иначе движок примет его за параметр).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
// Файл Excel из output/analiz/, который отдаётся на скачивание: одно имя без папок, не скрытый, .xlsx.
export const EXCEL_NAME_RE = /^[^\\/:*?"<>|\0.][^\\/:*?"<>|\0]*\.xlsx$/i;

const JSON_TYPE = 'application/json; charset=utf-8';
const sendJson = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const clip = (s, n = MESSAGE_MAX) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const hasHeader = (req) => req.headers['x-cabinet'] === '1';
const isJson = (req) => /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '');
const isOctets = (req) => /^application\/octet-stream\s*(;|$)/i.test(req.headers['content-type'] ?? '');

// Имя загруженного файла: только последняя часть пути (без папок и «..»), без управляющих знаков и знаков,
// запрещённых в именах Windows (заменяются на «_»), без точек и пробелов по краям, не скрытый (точка в начале)
// и не временный файл Excel («~$»). Кириллица и пробелы остаются. Не больше NAME_MAX знаков. Пусто: ''.
export function cleanFileName(value) {
  if (typeof value !== 'string') return '';
  let name = typeof value.toWellFormed === 'function' ? value.toWellFormed() : value;
  name = name.normalize('NFC').split(/[\\/]/).pop();
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  name = name.replace(/[<>:"|?*]/g, '_').replace(/\s+/g, ' ').replace(/\.{2,}/g, '.');
  name = name.replace(/^(?:[\s.]|~\$)+/, '').replace(/[\s.]+$/, '');
  const ext = extname(name);
  let stem = name.slice(0, name.length - ext.length).trim();
  if (!stem) return '';
  if (name.length > NAME_MAX) stem = stem.slice(0, Math.max(1, NAME_MAX - ext.length)).trim();
  if (WIN_RESERVED.test(stem.split('.')[0])) stem = `_${stem}`;
  return stem + ext;
}

// «Продажи.xlsx», «Продажи (2).xlsx», «Продажи (3).xlsx»...
const numbered = (name, n) => {
  if (n === 1) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
};

// Временный файл под постоянным именем: ссылкой (link) или копией с запретом перезаписи. Файл с таким именем уже
// есть (и на Windows и Mac без учёта регистра букв): следующий номер. Ответ: итоговое имя.
export function placeFile(tmp, dir, name) {
  for (let n = 1; n <= 999; n++) {
    const target = join(dir, numbered(name, n));
    try {
      linkSync(tmp, target);
      return numbered(name, n);
    } catch (e) {
      if (e.code === 'EEXIST') continue;
    }
    try {
      copyFileSync(tmp, target, constants.COPYFILE_EXCL);
      return numbered(name, n);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw Object.assign(new Error('слишком много файлов с таким именем'), { code: 'EMANY' });
}

export const removeQuietly = (p) => {
  try {
    unlinkSync(p);
  } catch {
    // файла уже нет
  }
};

// Тело запроса во временный файл, не больше limit байт: { size } или { over } или { error }. Тело больше limit
// дочитывается без записи, чтобы страница получила ответ, а не оборванное соединение.
// Ответ только после закрытия записи: файл создаётся не сразу, и удалённый раньше времени .part появился бы снова.
export function receiveFile(req, tmp, limit) {
  return new Promise((done) => {
    let size = 0;
    let over = false;
    let ended = false;
    const out = createWriteStream(tmp, { flags: 'wx' });
    const closed = new Promise((ok) => out.once('close', ok));
    const finish = (result) => closed.then(() => done(result));
    out.on('error', (e) => {
      req.resume();
      finish({ error: e });
    });
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        out.destroy();
        return;
      }
      if (!out.write(c)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      ended = true;
      if (over) return finish({ over: true });
      out.end(() => finish({ size }));
    });
    req.on('error', (e) => {
      out.destroy();
      finish({ error: e });
    });
    req.on('close', () => {
      if (ended) return;
      out.destroy();
      finish({ error: new Error('соединение оборвалось') });
    });
  });
}

// Вопрос для движка: одна строка, без управляющих знаков, без «-» и пробелов в начале (иначе движок примет вопрос
// за параметр), не длиннее QUESTION_MAX. Пустая строка: вопроса нет.
export function cleanQuestion(value) {
  if (typeof value !== 'string') return '';
  let q = typeof value.toWellFormed === 'function' ? value.toWellFormed() : value;
  q = q.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ');
  return q.replace(/^[\s\-]+/, '').trim();
}

export const codePhrase = (question) => `проанализируй таблицу: ${question}`;

// JSON из вывода движка: весь вывод, иначе последняя строка JSON, иначе от первой «{» до последней «}».
export function parseEngineJson(text) {
  const s = String(text ?? '').replace(/^﻿/, '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // ниже по строкам
  }
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[[{]/.test(lines[i])) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // следующая строка
    }
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      // не JSON
    }
  }
  return null;
}

// Понятный текст ошибки движка: поле JSON (error, message, reason, hint), находки проверки,
// иначе последняя содержательная строка stderr (без строк трейсбека).
export function engineMessage(json, stderr) {
  if (isObj(json)) {
    for (const k of ['error', 'message', 'reason', 'hint']) {
      if (typeof json[k] === 'string' && json[k].trim()) return clip(json[k]);
    }
    if (Array.isArray(json.findings) && json.findings.length) {
      const what = json.findings
        .map((f) => (typeof f === 'string' ? f : isObj(f) ? f.kind ?? f.type ?? f.what ?? f.name : null))
        .filter((x) => typeof x === 'string' && x)
        .join(', ');
      if (what) return clip(`не отправлено в модель: ${what}`);
    }
  }
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^\s/.test(l) && !/^Traceback \(most recent call last\)/.test(l));
  return lines.length ? clip(lines[lines.length - 1]) : null;
}

// Запуск движка: { code, stdout, stderr, timedOut, tooBig, spawnError }. Никогда не отклоняется.
// Остановка (время вышло, слишком большой вывод): всё дерево процессов (у ask внутри работает claude).
export function runEngine(exe, script, args, { cwd, timeoutMs, stopTree = killTree, killGraceMs = KILL_GRACE_MS, env = {} }) {
  return new Promise((done) => {
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let tooBig = false;
    let settled = false;
    let timer = null;
    let grace = null;
    let child;
    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      done({
        code,
        timedOut,
        tooBig,
        spawnError,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    };
    const stop = () => {
      if (grace) return;
      try {
        stopTree(child);
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // процесса уже нет
        }
      }
      // Дерево не закрылось за паузу: отвечаем без него, чтобы страница не ждала вечно.
      grace = setTimeout(() => finish(null), killGraceMs);
    };
    try {
      child = spawn(exe, [script, ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', ...env },
      });
    } catch (e) {
      return finish(null, e.code ?? e.message);
    }
    child.stdout.on('data', (c) => {
      if (outLen + c.length > STDOUT_LIMIT) {
        tooBig = true;
        return stop();
      }
      out.push(c);
      outLen += c.length;
    });
    child.stderr.on('data', (c) => {
      if (errLen >= STDERR_LIMIT) return;
      err.push(c);
      errLen += c.length;
    });
    child.on('error', (e) => {
      // Процесс уже запущен (есть pid): это ошибка остановки, ждём закрытия.
      if (child.pid !== undefined) return;
      finish(null, e.code ?? e.message);
    });
    child.on('close', (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
  });
}

const timeOf = (e) => {
  for (const k of ['created', 'time', 'created_at', 'asked_at', 'at', 'updated_at', 'ts']) {
    const v = e[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
};

// Запись истории в плоский ответ { id, question, columns, rows, ... , time }: принимает и плоский ответ движка,
// и запись вида { question, spec, result: {...}, time }.
function flatten(e) {
  const inner = isObj(e.result) ? e.result : isObj(e.answer) ? e.answer : null;
  const a = inner ? { ...e, ...inner } : { ...e };
  if (inner) {
    delete a.result;
    delete a.answer;
    if (a.id === undefined && e.id !== undefined) a.id = e.id;
    if (typeof a.question !== 'string' && typeof e.question === 'string') a.question = e.question;
  }
  const t = timeOf(a) ?? timeOf(e);
  if (t) a.time = t;
  return a;
}

// История: список ответов (или объект со списком items, history, answers), новые сверху, не больше limit.
// Время (у движка поле created) есть у всех записей: по времени, при равном времени как в файле; иначе как в файле
// (движок пишет новые ответы в начало).
export function normalizeHistory(data, limit = HISTORY_SHOW) {
  const list = Array.isArray(data)
    ? data
    : isObj(data)
      ? [data.items, data.history, data.answers, data.entries].find(Array.isArray)
      : null;
  if (!Array.isArray(list)) return [];
  const items = list.filter(isObj).map((e, i) => ({ a: flatten(e), i }));
  const ms = (x) => Date.parse(String(x.a.time ?? '').replace(' ', 'T'));
  const byTime = items.length > 0 && items.every((x) => !Number.isNaN(ms(x)));
  if (byTime) items.sort((x, y) => ms(y) - ms(x) || x.i - y.i);
  return items.slice(0, limit).map((x) => x.a);
}

// Тело запроса JSON не больше BODY_LIMIT: объект или null.
function readBody(req) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) over = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return done({ over: true });
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        done({ body: isObj(v) ? v : null });
      } catch {
        done({ body: null });
      }
    });
    req.on('error', () => done({ body: null }));
  });
}

const notAllowed = (res, allow) => {
  res.writeHead(405, { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store', Allow: allow });
  res.end(JSON.stringify({ error: 'Так обратиться к странице нельзя.' }));
};

const ONLY_PAGE = 'Сервис «Аналитика таблиц» работает только со своей страницы кабинета.';
const NO_PYTHON = 'Python не найден. Скажите Claude «проверь сетап».';
const NO_ENGINE = 'Сервис «Аналитика таблиц» в этом кабинете ещё не установлен. Скажите Claude «обнови кабинет».';
const BUSY = 'Предыдущий вопрос ещё считается. Дождитесь ответа и спросите снова.';
const NO_CLAUDE =
  'На этом компьютере не найден Claude Code командной строки, поэтому страница не может спросить модель. Задайте вопрос Claude во вкладке Code.';
const PERSONAL = 'Вопрос не отправлен в модель: слишком большой объём описания данных.';
const NEED_ROWS = 'Для этого вопроса нужно читать текст строк: задайте его Claude во вкладке Code.';

const BAD_TYPE = 'Подходят файлы Excel (.xlsx, .xlsm) и CSV (.csv, .txt). Старый файл Excel (.xls) откройте в Excel и сохраните как .xlsx.';
const TOO_BIG = `Файл больше ${UPLOAD_MAX / 1024 / 1024} МБ. Оставьте в нём нужные листы и строки или положите его в папку с данными сами.`;

// API сервиса. Параметры для тестов: python (путь к интерпретатору), openFolder(dir) вместо Проводника,
// askTimeoutMs и engineTimeoutMs, stopTree, uploadMax (наибольший загружаемый файл, байт).
export function createAnalizApi(root, { python, openFolder = openInExplorer, askTimeoutMs = ASK_TIMEOUT_MS, engineTimeoutMs = ENGINE_TIMEOUT_MS, stopTree, uploadMax = UPLOAD_MAX } = {}) {
  const script = join(root, 'tools', 'analiz.py');
  const outDir = join(root, 'output', ANALIZ);
  let asking = false;
  let passportRun = null;

  // Движок с подкомандой: { ok, code, json, message, timedOut } или { fail: [status, body] }, если запустить нельзя.
  async function engine(args, timeoutMs) {
    if (!isFile(script)) return { fail: [500, { code: 'ENOENGINE', error: NO_ENGINE }] };
    const exe = python ?? (await findPython(root));
    if (!exe) return { fail: [500, { code: 'ENOPYTHON', error: NO_PYTHON }] };
    // Обращения движка к модели (через tools/llm.py) пишутся в журнал кабинета как сервис analiz.
    const env = { CABINET_JOURNAL: journalFile(root), CABINET_SERVICE: ANALIZ };
    const r = await runEngine(exe, script, args, { cwd: root, timeoutMs, env, ...(stopTree ? { stopTree } : {}) });
    if (r.spawnError) return { fail: [500, { code: 'ENOPYTHON', error: `Не удалось запустить Python (${r.spawnError}). Скажите Claude «проверь сетап».` }] };
    const json = parseEngineJson(r.stdout);
    return { ok: r.code === 0 && !r.timedOut && !r.tooBig, code: r.code, json, message: engineMessage(json, r.stderr), timedOut: r.timedOut, tooBig: r.tooBig };
  }

  async function passport(res) {
    // Два запроса паспорта сразу (две вкладки, «Обновить» дважды): движок читает файлы один раз.
    passportRun ??= engine(['passport'], engineTimeoutMs).finally(() => {
      passportRun = null;
    });
    const r = await passportRun;
    if (r.fail) return sendJson(res, ...r.fail);
    if (r.timedOut) return sendJson(res, 504, { code: 'ETIMEOUT', error: 'Файлы читались дольше 2 минут. Уберите из папки лишние большие файлы и нажмите «Обновить».' });
    // Паспорт списком файлов тоже годится: страница ждёт объект с files.
    const data = Array.isArray(r.json) ? { files: r.json } : r.json;
    if (!r.ok || !isObj(data)) {
      return sendJson(res, 500, { code: 'EENGINE', error: r.message || 'Не получилось прочитать файлы с данными.' });
    }
    return sendJson(res, 200, { ok: true, passport: data });
  }

  async function ask(req, res) {
    const { body, over } = await readBody(req);
    if (over) return sendJson(res, 413, { code: 'ELONG', error: `Вопрос слишком длинный: не больше ${QUESTION_MAX} знаков.` });
    if (!body) return sendJson(res, 400, { code: 'EBODY', error: 'Не получилось прочитать вопрос.' });
    const question = cleanQuestion(body.question);
    if (!question) return sendJson(res, 400, { code: 'EEMPTY', error: 'Напишите вопрос.' });
    if (question.length > QUESTION_MAX) {
      return sendJson(res, 400, { code: 'ELONG', error: `Вопрос длиннее ${QUESTION_MAX} знаков: сократите его.` });
    }
    if (asking) return sendJson(res, 409, { code: 'EBUSY', error: BUSY });
    asking = true;
    let r;
    try {
      r = await engine(['ask', question], askTimeoutMs);
    } finally {
      asking = false;
    }
    const phrase = codePhrase(question);
    if (r.fail) return sendJson(res, ...r.fail);
    if (r.timedOut) {
      return sendJson(res, 504, {
        code: 'ETIMEOUT',
        error: `Вопрос считался дольше ${Math.round(askTimeoutMs / 60000)} мин и остановлен. Спросите проще или задайте вопрос Claude во вкладке Code.`,
        phrase,
      });
    }
    if (r.code === 3) return sendJson(res, 503, { code: 'ENOCLAUDE', error: NO_CLAUDE, detail: r.message, phrase });
    if (r.code === 4) return sendJson(res, 422, { code: 'EPERSONAL', error: r.message || PERSONAL });
    if (r.code === 5) return sendJson(res, 422, { code: 'EROWS', error: r.message || NEED_ROWS, phrase });
    if (!r.ok) return sendJson(res, 422, { code: 'EENGINE', error: r.message || 'Не получилось ответить на вопрос.' });
    if (!isObj(r.json)) return sendJson(res, 500, { code: 'EENGINE', error: 'Программа сервиса ответила не так, как ожидалось. Покажите это тренеру.' });
    return sendJson(res, 200, { ok: true, answer: r.json });
  }

  function history(res) {
    const file = join(outDir, 'history.json');
    let text;
    try {
      if (statSync(file).size > HISTORY_LIMIT) {
        return sendJson(res, 500, { code: 'EHISTORY', error: 'История ответов слишком большая (output/analiz/history.json).' });
      }
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return sendJson(res, 200, { ok: true, items: [], total: 0 });
      return sendJson(res, 500, { code: 'EHISTORY', error: `Не получилось прочитать историю ответов (${e.code ?? e.message}).` });
    }
    let data;
    try {
      data = JSON.parse(text.replace(/^﻿/, '') || '[]');
    } catch {
      return sendJson(res, 500, { code: 'EHISTORY', error: 'Файл истории ответов output/analiz/history.json повреждён.' });
    }
    const all = normalizeHistory(data, Infinity);
    return sendJson(res, 200, { ok: true, items: all.slice(0, HISTORY_SHOW), total: all.length });
  }

  // Файл Excel, который сделал движок: имя из его ответа (file, path, xlsx) или самый свежий .xlsx с номером ответа.
  // Отдаётся только файл, который по-настоящему лежит в output/analiz/.
  function excelFile(json, id) {
    const named = typeof json === 'string' ? json : isObj(json) ? [json.file, json.path, json.xlsx, json.excel].find((v) => typeof v === 'string' && v) : null;
    let name = named ? named.split(/[\\/]/).pop() : null;
    if (!name) {
      try {
        name = readdirSync(outDir)
          .filter((f) => EXCEL_NAME_RE.test(f) && f.includes(id))
          .map((f) => ({ f, t: statSync(join(outDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t)[0]?.f;
      } catch {
        name = null;
      }
    }
    if (!name || !EXCEL_NAME_RE.test(name)) return null;
    try {
      const real = realpathSync(join(outDir, name));
      if (!isInside(real, realpathSync(outDir)) || !isFile(real)) return null;
    } catch {
      return null;
    }
    return name;
  }

  async function excel(req, res) {
    const { body } = await readBody(req);
    const raw = body && (typeof body.id === 'string' || typeof body.id === 'number') ? String(body.id) : '';
    if (!ID_RE.test(raw)) return sendJson(res, 400, { code: 'EBADID', error: 'Такого ответа нет в истории.' });
    const r = await engine(['excel', raw], engineTimeoutMs);
    if (r.fail) return sendJson(res, ...r.fail);
    if (r.timedOut) return sendJson(res, 504, { code: 'ETIMEOUT', error: 'Файл Excel готовился дольше 2 минут и остановлен.' });
    if (!r.ok) return sendJson(res, 422, { code: 'EENGINE', error: r.message || 'Не получилось сделать файл Excel.' });
    const name = excelFile(r.json, raw);
    if (!name) return sendJson(res, 500, { code: 'ENOFILE', error: 'Программа сервиса не положила файл Excel в output/analiz.' });
    return sendJson(res, 200, { ok: true, file: name, url: `output/${ANALIZ}/${encodeURIComponent(name)}` });
  }

  // Папка с данными input/analiz/: создаётся, если нет; должна быть папкой внутри кабинета. Ответ: путь или null.
  function dataFolder() {
    const dir = join(root, 'input', ANALIZ);
    try {
      mkdirSync(dir, { recursive: true });
      const real = realpathSync(dir);
      return isDir(real) && isInside(real, realpathSync(root)) ? real : null;
    } catch {
      return null;
    }
  }

  // Файл со страницы в input/analiz/: имя чистится, тип по расширению, запись через временный скрытый файл
  // (движок такие не читает), существующий файл не перезаписывается: новый получает номер « (2)».
  async function upload(req, res) {
    const header = req.headers['x-file-name'];
    let raw = '';
    try {
      raw = typeof header === 'string' ? decodeURIComponent(header) : '';
    } catch {
      raw = '';
    }
    const name = cleanFileName(raw);
    const refuse = (status, body) => {
      req.resume();
      return sendJson(res, status, body);
    };
    if (!name) return refuse(400, { code: 'ENAME', error: 'Не получилось прочитать имя файла. Переименуйте файл и загрузите снова.' });
    if (!UPLOAD_EXT.includes(extname(name).toLowerCase())) return refuse(415, { code: 'ETYPE', error: `Файл «${name}» не загружен. ${BAD_TYPE}`, file: name });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > uploadMax) return refuse(413, { code: 'EBIG', error: `Файл «${name}» не загружен. ${TOO_BIG}`, file: name });
    const dir = dataFolder();
    if (!dir) return refuse(500, { code: 'EFOLDER', error: 'Не получилось открыть папку input/analiz в кабинете.' });
    const tmp = join(dir, `.upload-${randomBytes(8).toString('hex')}.part`);
    const got = await receiveFile(req, tmp, uploadMax);
    if (got.over || got.error || !got.size) {
      removeQuietly(tmp);
      if (got.over) return sendJson(res, 413, { code: 'EBIG', error: `Файл «${name}» не загружен. ${TOO_BIG}`, file: name });
      if (got.error) return sendJson(res, 500, { code: 'EWRITE', error: `Файл «${name}» не сохранился (${got.error.code ?? got.error.message}).`, file: name });
      return sendJson(res, 400, { code: 'EEMPTY', error: `Файл «${name}» пустой.`, file: name });
    }
    let saved;
    try {
      saved = placeFile(tmp, dir, name);
    } catch (e) {
      return sendJson(res, 500, { code: 'EWRITE', error: `Файл «${name}» не сохранился (${e.code ?? e.message}).`, file: name });
    } finally {
      removeQuietly(tmp);
    }
    return sendJson(res, 200, { ok: true, file: saved, renamed: saved !== name, size: got.size });
  }

  // Кнопка-корзина у файла в «Ваших данных»: file как в паспорте (путь от input/analiz через «/»).
  // Удаляется только таблица (тип как у загрузки и .xls) внутри input/analiz: без «..», скрытых частей пути
  // и ссылок (symlink) за пределы папки.
  function removeDataFile(res, body) {
    const rel = body && typeof body.file === 'string' ? body.file : '';
    const parts = rel.split('/');
    const bad = !rel || rel.length > 400 || parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p.startsWith('~$') || /[\\:\u0000-\u001f]/.test(p));
    if (bad || ![...UPLOAD_EXT, '.xls'].includes(extname(rel).toLowerCase())) {
      return sendJson(res, 400, { code: 'ENAME', error: 'Такой файл со страницы удалить нельзя.' });
    }
    const dir = dataFolder();
    if (!dir) return sendJson(res, 500, { code: 'EFOLDER', error: 'Не получилось открыть папку input/analiz в кабинете.' });
    const path = join(dir, ...parts);
    let real;
    try {
      if (!lstatSync(path).isFile()) throw Object.assign(new Error('не файл'), { code: 'ENOTFILE' });
      real = realpathSync(path);
    } catch (e) {
      if (e.code === 'ENOENT') return sendJson(res, 404, { code: 'ENOFILE', error: `Файла «${rel}» уже нет. Нажмите «Обновить».`, file: rel });
      return sendJson(res, 400, { code: 'ENAME', error: 'Такой файл со страницы удалить нельзя.' });
    }
    if (!isInside(real, dir)) return sendJson(res, 400, { code: 'ENAME', error: 'Такой файл со страницы удалить нельзя.' });
    try {
      unlinkSync(real);
    } catch (e) {
      const busy = e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
      return sendJson(res, 409, {
        code: 'EBUSY',
        error: busy ? `Файл «${rel}» не удалился: он открыт в Excel или другой программе. Закройте его и попробуйте снова.` : `Файл «${rel}» не удалился (${e.code ?? e.message}).`,
        file: rel,
      });
    }
    return sendJson(res, 200, { ok: true, file: rel });
  }

  function openDataFolder(res) {
    const dir = join(root, 'input', ANALIZ);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      return sendJson(res, 500, { code: 'EFOLDER', error: `Не получилось создать папку input/analiz (${e.code ?? e.message}).` });
    }
    if (!isDir(dir)) return sendJson(res, 500, { code: 'EFOLDER', error: 'На месте папки input/analiz лежит файл. Уберите его и попробуйте снова.' });
    let opened = false;
    try {
      opened = openFolder(dir) !== false;
    } catch {
      opened = false;
    }
    return sendJson(res, 200, { ok: true, opened, path: dir, app: process.platform === 'darwin' ? 'Finder' : 'Проводник' });
  }

  async function handle(req, res, sub) {
    const route = sub.replace(/\/+$/, '');
    const reads = { passport: true, history: true };
    const posts = { ask: true, excel: true, 'open-folder': true, upload: true, delete: true };
    if (!reads[route] && !posts[route]) {
      req.resume();
      return sendJson(res, 404, { error: 'Такого адреса у страницы нет.' });
    }
    if (reads[route]) {
      req.resume();
      if (!isRead(req)) return notAllowed(res, 'GET, HEAD');
      if (!hasHeader(req)) return sendJson(res, 403, { error: ONLY_PAGE });
      return route === 'passport' ? passport(res) : history(res);
    }
    if (req.method !== 'POST') {
      req.resume();
      return notAllowed(res, 'POST');
    }
    if (!hasHeader(req) || !(route === 'upload' ? isOctets(req) : isJson(req))) {
      req.resume();
      return sendJson(res, 403, { error: ONLY_PAGE });
    }
    if (route === 'upload') return upload(req, res);
    if (route === 'ask') return ask(req, res);
    if (route === 'excel') return excel(req, res);
    if (route === 'delete') return removeDataFile(res, (await readBody(req)).body);
    req.resume();
    return openDataFolder(res);
  }

  // Ответ отправлен всегда, даже если обработчик упал.
  return (req, res, sub) => {
    handle(req, res, sub).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Сервис «Аналитика таблиц» не ответил. Попробуйте ещё раз.' });
    });
    return true;
  };
}
