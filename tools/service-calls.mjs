// Серверная часть сервиса: своя страница сервиса зовёт свой Python через кабинет.
//
//   POST s/<slug>/api/<действие>   тело JSON (data) или файл (application/octet-stream, имя в X-File-Name)
//
// Кабинет запускает `python <api> <действие>` (поле api в service.json) в папке проекта, как «Запустить»:
// свой Python кабинета, без оболочки, lib/ в PYTHONPATH (там service_api.py, llm.py, read_table.py).
// Запрос в stdin JSON { route, data, file }, ответ JSON из stdout отдаётся странице как есть.
// Код 2 (StopRun): 400 с его строкой; другой код: 500; дольше API_TIMEOUT_MS: 504; идёт расчёт сервиса: 409.
// Код серверной части проверяется так же, как программа (checkProject): с нарушениями она не запускается.
// Файл со страницы сначала ложится в скрытую папку проекта .cabinet-upload/, действие само переносит его
// (save_upload в service_api.py), остаток кабинет убирает. Каждый вызов в журнал кабинета (tools/journal.mjs).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanFileName, receiveFile, removeQuietly } from './analiz-api.mjs';
import { findPython, isInside, killTree } from './processes.mjs';
import { checkProject, findEntry, isRunning, okCheck, problemLines, syncLib } from './services.mjs';
import { appendJournal, folderSnapshot, journalFile, snapshotDiff } from './journal.mjs';

export const API_ROUTE_RE = /^[a-z0-9-]{1,40}$/;
export const API_TIMEOUT_MS = 60 * 1000;
export const API_REPLY_MAX = 5 * 1024 * 1024;
export const API_UPLOAD_MAX = 50 * 1024 * 1024;
export const API_CONCURRENT = 4;
export const UPLOAD_DIR = '.cabinet-upload';
const DATA_MAX = 1024 * 1024;
const STDERR_MAX = 64 * 1024;
const KILL_GRACE_MS = 3000;

const isJson = (req) => /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '');
const isOctets = (req) => /^application\/octet-stream\s*(;|$)/i.test(req.headers['content-type'] ?? '');
const lastLine = (text) => String(text).trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
const fail = (status, code, error) => ({ status, body: { code, error } });

// Тело JSON не больше DATA_MAX: объект или null.
function readData(req) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > DATA_MAX) over = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return done(null);
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        done(v && typeof v === 'object' && !Array.isArray(v) ? v : null);
      } catch {
        done(null);
      }
    });
    req.on('error', () => done(null));
  });
}

// Запуск серверной части: { code, stdout, stderr, stopped }. stopped: 'timeout' или 'big' (ответ больше лимита).
function runApi(exe, apiFile, route, request, { cwd, env, timeoutMs, stopTree, replyMax }) {
  return new Promise((done) => {
    let child;
    const out = [];
    let outSize = 0;
    let err = '';
    let stopped = null;
    let settled = false;
    let grace = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      done({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err, stopped });
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
      }, KILL_GRACE_MS);
    };
    try {
      child = spawn(exe, [apiFile, route], {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(cwd, 'lib'), ...env },
      });
    } catch (e) {
      return done({ code: null, stdout: '', stderr: `Не удалось запустить Python (${e.code ?? e.message}).`, stopped: null });
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.on('error', (e) => {
      if (child.pid !== undefined) return;
      err += `Не удалось запустить Python (${e.code ?? e.message}).`;
      finish(null);
    });
    child.stdout.on('data', (c) => {
      outSize += c.length;
      if (outSize > replyMax) return stop('big');
      out.push(c);
    });
    child.stderr.on('data', (c) => {
      if (err.length < STDERR_MAX) err += c.toString('utf8');
    });
    child.stdin.on('error', () => {
      // программа не дочитала запрос: её ответ всё равно разберём
    });
    child.stdin.end(JSON.stringify(request));
    child.on('close', (code) => finish(code));
  });
}

// Вызовы серверной части для одного кабинета. call(req, slug, route) → { status, body }: ответ странице JSON.
// Запрос дочитан или сброшен в любом случае.
export function createServiceCalls(root, { python, timeoutMs = API_TIMEOUT_MS, stopTree = killTree, uploadMax = API_UPLOAD_MAX, replyMax = API_REPLY_MAX, maxConcurrent = API_CONCURRENT } = {}) {
  let active = 0;

  async function prepare(req, slug, route) {
    if (!API_ROUTE_RE.test(route)) return fail(404, 'ENOROUTE', 'Такого действия у сервиса нет.');
    const entry = findEntry(root, slug);
    if (!entry) return fail(404, 'ENOSERVICE', 'Такого сервиса нет в кабинете.');
    let c;
    try {
      c = checkProject(root, entry.path);
    } catch {
      return fail(404, 'ENOSERVICE', 'Папка сервиса не найдена.');
    }
    if (c.info?.kind === 'web') return fail(404, 'EWEB', 'У сервиса для интернета действия работают на его сайте, а не в кабинете.');
    if (!c.info?.api) return fail(404, 'ENOAPI', 'У сервиса нет серверной части: в service.json нет поля api.');
    if (!okCheck(c)) return fail(400, 'EBADSERVICE', `Серверная часть не запускается, в проекте есть что поправить: ${problemLines(c).map((l) => l.trim()).join('; ')}`);
    if (!c.apiFile) return fail(400, 'EBADSERVICE', 'Серверная часть сервиса не найдена.');
    if (isRunning(c.dir)) return fail(409, 'ERUNNING', 'Идёт расчёт сервиса. Дождитесь конца и попробуйте снова.');
    if (active >= maxConcurrent) return fail(409, 'ELIMIT', 'Кабинет занят другими действиями. Попробуйте через несколько секунд.');
    return { entry, c };
  }

  // Файл со страницы во временную скрытую папку проекта: { file } или { error: ответ }.
  async function receiveUpload(req, dir) {
    let raw = '';
    try {
      raw = typeof req.headers['x-file-name'] === 'string' ? decodeURIComponent(req.headers['x-file-name']) : '';
    } catch {
      raw = '';
    }
    const name = cleanFileName(raw);
    if (!name) return { error: fail(400, 'ENAME', 'Не получилось прочитать имя файла. Переименуйте файл и загрузите снова.') };
    const declared = Number(req.headers['content-length']);
    const big = fail(413, 'EBIG', `Файл «${name}» больше ${Math.round(uploadMax / 1048576)} МБ.`);
    if (Number.isFinite(declared) && declared > uploadMax) return { error: big };
    const up = join(dir, UPLOAD_DIR);
    try {
      mkdirSync(up, { recursive: true });
      if (!isInside(realpathSync(up), dir)) throw new Error('за пределами проекта');
    } catch {
      return { error: fail(500, 'EFOLDER', 'Не получилось подготовить папку для загрузки в проекте сервиса.') };
    }
    const id = randomBytes(8).toString('hex');
    const tmp = join(up, `${id}.part`);
    const got = await receiveFile(req, tmp, uploadMax);
    if (got.over || got.error || !got.size) {
      removeQuietly(tmp);
      if (got.over) return { error: big };
      if (got.error) return { error: fail(500, 'EWRITE', `Файл «${name}» не сохранился (${got.error.code ?? got.error.message}).`) };
      return { error: fail(400, 'EEMPTY', `Файл «${name}» пустой.`) };
    }
    return { file: { name, path: `${UPLOAD_DIR}/${id}.part`, size: got.size }, tmp };
  }

  async function call(req, slug, route) {
    const ready = await prepare(req, slug, route);
    if (ready.status) {
      req.resume();
      return ready;
    }
    const { entry, c } = ready;
    active += 1;
    const started = Date.now();
    const inputDir = join(c.dir, 'input');
    const before = folderSnapshot(inputDir);
    let tmp = null;
    let reply;
    let event = 'api';
    try {
      let request;
      if (isOctets(req)) {
        event = 'upload';
        const up = await receiveUpload(req, c.dir);
        if (up.error) {
          req.resume();
          return (reply = up.error);
        }
        tmp = up.tmp;
        request = { route, data: {}, file: up.file };
      } else if (isJson(req)) {
        const data = await readData(req);
        if (!data) return (reply = fail(400, 'EDATA', 'Запрос страницы не прочитался: нужен JSON-объект до 1 МБ.'));
        request = { route, data, file: null };
      } else {
        req.resume();
        return (reply = fail(415, 'ETYPE', 'Нужен JSON или файл (application/octet-stream).'));
      }
      try {
        syncLib(root, c.dir);
      } catch (e) {
        return (reply = fail(500, 'ELIB', e.message));
      }
      let exe = python ?? (await findPython(root));
      if (exe && isInside(exe, c.dir)) exe = null;
      if (!exe) return (reply = fail(500, 'ENOPYTHON', 'Python не найден. Скажите Claude в кабинете «проверь сетап».'));
      const r = await runApi(exe, c.apiFile, route, request, {
        cwd: c.dir,
        env: { CABINET_JOURNAL: journalFile(root), CABINET_SERVICE: entry.slug },
        timeoutMs,
        stopTree,
        replyMax,
      });
      if (r.stopped === 'timeout') return (reply = fail(504, 'ETIMEOUT', `Действие «${route}» шло дольше ${Math.round(timeoutMs / 1000)} секунд и остановлено.`));
      if (r.stopped === 'big') return (reply = fail(500, 'EBIG', `Ответ действия «${route}» больше ${Math.round(replyMax / 1048576)} МБ.`));
      if (r.code === 2) return (reply = fail(400, 'ESTOP', lastLine(r.stderr) || `Действие «${route}» не выполнено.`));
      if (r.code !== 0) return (reply = fail(500, 'EFAIL', `Действие «${route}» не сработало: ${lastLine(r.stderr) || `код ${r.code}`}.`));
      let body;
      try {
        body = JSON.parse(r.stdout || '{}');
      } catch {
        return (reply = fail(500, 'EREPLY', `Действие «${route}» ответило не JSON.`));
      }
      return (reply = { status: 200, body });
    } finally {
      active -= 1;
      if (tmp) removeQuietly(tmp);
      try {
        rmdirSync(join(c.dir, UPLOAD_DIR));
      } catch {
        // папки нет или в ней ещё что-то: оставляем
      }
      appendJournal(root, {
        service: entry.slug,
        event,
        route,
        ok: reply?.status === 200,
        status: reply?.status ?? 500,
        ms: Date.now() - started,
        files: snapshotDiff(before, folderSnapshot(inputDir)),
      });
    }
  }

  return call;
}
