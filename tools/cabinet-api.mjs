// API страницы «Настройки» (site/nastroiki.html) и кнопки «Редактировать» на главной. Без зависимостей.
//
//   GET  api/cabinet                 { root, services, analiz, version: { commit, date } | null, journal }: папки
//                                    кабинета (абсолютные пути), версия кабинета из git, журнал за месяц
//                                    ({ folder, file, events }, tools/journal.mjs)
//   GET  api/cabinet/checks          { checks: [{ id, ok, title, detail }] }: Python и Claude для сервисов
//   POST api/cabinet/open {folder}   открыть папку в Проводнике (Finder): cabinet, services или analiz
//
// Защита как у сервиса «Аналитика таблиц»: токен в адресе (проверяет serve.mjs), заголовок X-Cabinet: 1 на всех
// запросах, у POST ещё тип JSON: чужая страница или ссылка без разрешения браузера такой запрос не пришлёт.
import { execFile } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { journalStats } from './journal.mjs';
import { findPython, openFolder as openInExplorer } from './processes.mjs';
import { servicesHome } from './services.mjs';

const BODY_LIMIT = 4 * 1024;
const CHECK_TIMEOUT_MS = 20000;
const SAFE_HEADERS = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
const ONLY_PAGE = 'Так обратиться к кабинету можно только со страницы кабинета.';

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { ...SAFE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}
const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';
const hasHeader = (req) => req.headers['x-cabinet'] === '1';
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isJson = (req) => /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '');

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

// Программа без оболочки, не дольше timeoutMs: { ok, out } (out: первая непустая строка вывода).
function runLine(cmd, args, { cwd, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';
      done({ ok: !err, out: text, code: err?.code });
    });
  });
}

// Версия кабинета: последний коммит (короткий номер и дата). Нет git или истории: null.
export async function cabinetVersion(root) {
  const r = await runLine('git', ['-C', root, 'log', '-1', '--format=%h %cI'], { timeoutMs: 5000 });
  const m = r.ok ? /^([0-9a-f]{7,})\s+(\S+)$/.exec(r.out) : null;
  return m ? { commit: m[1], date: m[2] } : null;
}

// Папки кабинета для страницы: сам кабинет, папка проектов сервисов рядом с ним и данные «Аналитики таблиц».
export function cabinetFolders(root) {
  return { root, services: servicesHome(root), analiz: join(root, 'input', 'analiz') };
}

// Проверки для страницы настроек. python: путь к интерпретатору (для тестов), иначе как у процессов.
export async function cabinetChecks(root, { python } = {}) {
  const exe = python ?? (await findPython(root).catch(() => null));
  if (!exe) {
    return [
      { id: 'python', ok: false, title: 'Python не найден', detail: 'Без него сервисы не запускаются. Скажите Claude в папке кабинета «проверь сетап».' },
      { id: 'claude', ok: false, title: 'Claude для сервисов не проверен', detail: 'Сначала нужен Python.' },
    ];
  }
  const [ver, llm] = await Promise.all([
    runLine(exe, ['--version'], { cwd: root }),
    runLine(exe, [join(root, 'tools', 'llm.py'), 'status'], { cwd: root }),
  ]);
  const claudeOk = llm.ok && /^Claude для сервисов:/.test(llm.out);
  return [
    ver.ok
      ? { id: 'python', ok: true, title: 'Python работает', detail: ver.out }
      : { id: 'python', ok: false, title: 'Python не запускается', detail: ver.out || 'Скажите Claude в папке кабинета «проверь сетап».' },
    claudeOk
      ? { id: 'claude', ok: true, title: 'Claude для сервисов найден', detail: 'Сервисы могут звать модель через проверку кабинета.' }
      : { id: 'claude', ok: false, title: 'Claude для сервисов не найден', detail: llm.out || 'Вопросы к таблицам задавайте во вкладке Code.' },
  ];
}

const FOLDERS = { cabinet: 'root', services: 'services', analiz: 'analiz' };

// API под api/cabinet. sub: '' (папки и версия), 'checks', 'open'. Ответ отправлен всегда.
// Параметры для тестов: python, openFolder(dir) вместо Проводника, version(root) вместо git.
export function createCabinetApi(root, { python, openFolder = openInExplorer, version = cabinetVersion } = {}) {
  root = resolve(root);
  async function handle(req, res, sub) {
    const route = sub.replace(/\/+$/, '');
    if (route === '' || route === 'checks') {
      req.resume();
      if (!isRead(req)) return sendJson(res, 405, { error: 'Так обратиться к кабинету нельзя.' }, { Allow: 'GET, HEAD' });
      if (!hasHeader(req)) return sendJson(res, 403, { error: ONLY_PAGE });
      if (route === 'checks') return sendJson(res, 200, { checks: await cabinetChecks(root, { python }) });
      return sendJson(res, 200, { ...cabinetFolders(root), version: await version(root).catch(() => null), journal: journalStats(root) });
    }
    if (route === 'open') {
      if (req.method !== 'POST') {
        req.resume();
        return sendJson(res, 405, { error: 'Так обратиться к кабинету нельзя.' }, { Allow: 'POST' });
      }
      if (!hasHeader(req) || !isJson(req)) {
        req.resume();
        return sendJson(res, 403, { error: ONLY_PAGE });
      }
      const body = await readBody(req);
      const key = body && Object.prototype.hasOwnProperty.call(FOLDERS, body.folder) ? FOLDERS[body.folder] : null;
      if (!key) return sendJson(res, 400, { error: 'Такой папки у кабинета нет.' });
      const dir = cabinetFolders(root)[key];
      try {
        mkdirSync(dir, { recursive: true });
      } catch (e) {
        return sendJson(res, 500, { error: `Не получилось создать папку ${dir} (${e.code ?? e.message}).` });
      }
      if (!isDir(dir)) return sendJson(res, 500, { error: `На месте папки ${dir} лежит файл.` });
      let opened = false;
      try {
        opened = openFolder(dir) !== false;
      } catch {
        opened = false;
      }
      return sendJson(res, 200, { ok: true, opened, path: dir, app: process.platform === 'darwin' ? 'Finder' : 'Проводник' });
    }
    req.resume();
    return sendJson(res, 404, { error: 'Такого адреса у страницы нет.' });
  }
  return (req, res, sub) => {
    handle(req, res, sub).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Кабинет не ответил. Попробуйте ещё раз.' });
    });
    return true;
  };
}
