// API и статика сервисов-проектов на странице кабинета. Без зависимостей. Реестр и запуск: tools/services.mjs.
//
//   GET  api/services               реестр и карточка каждого сервиса (результат, ошибка, идёт ли расчёт)
//   POST api/services/run {slug}    запуск программы сервиса, как «Запустить» у процессов: ответ 202, дальше
//                                   страница опрашивает api/services (или api/services/status/<slug>)
//   GET  api/services/status/<slug> { running, lastRun }
//   GET  s/<slug>/                  своя страница сервиса kind page: переход на s/<slug>/page/
//   GET  s/<slug>/page/<файл>       файлы папки page проекта (.html .js .css .json .png .svg), только у kind page
//   GET  s/<slug>/output/<файл>     файлы папки output проекта (.json .xlsx .docx .png .csv), на скачивание
//   POST s/<slug>/api/<действие>    серверная часть своей страницы (поле api в service.json): кабинет запускает
//                                   её в папке проекта и отдаёт её ответ JSON (tools/service-calls.mjs)
//
// Адрес s/<slug>/ повторяет устройство проекта: страница page/index.html берёт данные по ../output/<файл>,
// как и на диске (output/<файл> от папки страницы тоже работает, если в page нет своей папки output).
// Скрытые файлы, другие виды файлов, ссылки (symlink) и «..» не отдаются.
// Защита: токен в адресе (как у всей страницы), у POST ещё заголовок X-Cabinet: 1 и тип JSON: чужая страница
// или ссылка без разрешения браузера такой запрос не пришлёт.
//
// Подключение в tools/serve.mjs одной строкой: attachServices(server, root, { token, python, timeoutMs })
// перехватывает только эти адреса, остальные запросы идут в обработчик страницы как раньше.
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { SLUG_RE, isInside } from './processes.mjs';
import { OUTPUT_DIR, OUTPUT_EXT, PAGE_DIR, PAGE_EXT, findEntry, listServices, readServiceInfo, serviceStatus, startServiceRun } from './services.mjs';
import { createServiceCalls } from './service-calls.mjs';

const BODY_LIMIT = 4 * 1024;
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': JSON_TYPE,
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
// Как у всей страницы: адрес с токеном не уходит в Referer, тип файла не угадывается, ничего не кэшируется.
const SAFE_HEADERS = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };

// Ошибки запуска (services.mjs) в ответы страницы.
const RUN_STATUS = {
  ENOARG: 404,
  ENOSERVICE: 404,
  ENODIR: 404,
  ENORUN: 400,
  EBADSERVICE: 400,
  ELIB: 500,
  EOUTSIDE: 403,
  ERUNNING: 409,
  ELIMIT: 409,
};

const ONLY_PAGE = 'Сервис запускается только кнопкой «Запустить» на странице кабинета.';

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { ...SAFE_HEADERS, 'Content-Type': type, ...headers });
  res.end(body);
}
const sendJson = (res, status, data) => send(res, status, JSON_TYPE, JSON.stringify(data));
const notFound = (res) => send(res, 404, TEXT_TYPE, 'Такого файла у сервиса нет.');
const notAllowed = (res, allow) => send(res, 405, TEXT_TYPE, 'Так обратиться к странице нельзя.', { Allow: allow });
const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';
const fromPage = (req) =>
  req.headers['x-cabinet'] === '1' && /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '');

function sameToken(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

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

// API под api/services. sub: '' (список), 'run', 'status/<slug>'. Ответ отправлен всегда.
export function createServicesApi(root, { python, timeoutMs } = {}) {
  root = resolve(root);
  async function handle(req, res, sub) {
    const route = sub.replace(/\/+$/, '');
    if (route === '') {
      req.resume();
      if (!isRead(req)) return notAllowed(res, 'GET, HEAD');
      return sendJson(res, 200, listServices(root));
    }
    if (route === 'run') {
      if (req.method !== 'POST') {
        req.resume();
        return notAllowed(res, 'POST');
      }
      if (!fromPage(req)) {
        req.resume();
        return sendJson(res, 403, { error: ONLY_PAGE });
      }
      const body = await readBody(req);
      const slug = body && typeof body.slug === 'string' ? body.slug : '';
      if (!SLUG_RE.test(slug) || !findEntry(root, slug)) return sendJson(res, 404, { code: 'ENOSERVICE', error: 'Такого сервиса нет в кабинете.' });
      try {
        startServiceRun(root, slug, { python, ...(timeoutMs ? { timeoutMs } : {}) });
      } catch (e) {
        const status = RUN_STATUS[e.code];
        if (status) return sendJson(res, status, { code: e.code, error: e.message });
        return sendJson(res, 500, { error: `Не удалось начать расчёт (${e.code ?? e.message}).` });
      }
      return sendJson(res, 202, { started: true });
    }
    const [head, slug, ...more] = route.split('/');
    if (head === 'status' && slug && !more.length) {
      req.resume();
      if (!isRead(req)) return notAllowed(res, 'GET, HEAD');
      const st = serviceStatus(root, slug);
      return st ? sendJson(res, 200, st) : sendJson(res, 404, { error: 'Такого сервиса нет в кабинете.' });
    }
    req.resume();
    return sendJson(res, 404, { error: 'Такого адреса у страницы нет.' });
  }
  return (req, res, sub) => {
    handle(req, res, sub).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Сервис не ответил. Попробуйте ещё раз.' });
    });
    return true;
  };
}

// Часть пути после s/<slug>/: каждая часть отдельно раскодирована и годится (не пустая, не «.» и «..»,
// не скрытая, без косых черт, «:» и управляющих знаков). Не годится: null.
function cleanParts(raw) {
  const out = [];
  for (const r of raw) {
    let p;
    try {
      p = decodeURIComponent(r);
    } catch {
      return null;
    }
    if (!p || p === '.' || p === '..' || p.startsWith('.') || p.startsWith('~$') || /[\\/:\u0000-\u001f]/.test(p)) return null;
    out.push(p);
  }
  return out;
}

// Файл папки area (page или output) проекта dir: ни папка, ни одна часть пути не ссылка, настоящий путь
// внутри проекта. Ответ: путь или null.
async function safeFile(dir, area, parts) {
  let cur = join(dir, area);
  const top = await lstat(cur).catch(() => null);
  if (!top || top.isSymbolicLink() || !top.isDirectory()) return null;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const st = await lstat(cur).catch(() => null);
    if (!st || st.isSymbolicLink()) return null;
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return null;
  }
  const [real, base] = await Promise.all([realpath(cur), realpath(join(dir, area))]).catch(() => []);
  return real && base && isInside(real, base) ? real : null;
}

const downloadName = (name) => encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Статика s/<slug>/...: raw: части пути после «s» как пришли (не раскодированы).
export async function serveServiceFile(root, req, res, raw, { token }) {
  if (!isRead(req)) {
    req.resume();
    return notAllowed(res, 'GET, HEAD');
  }
  const [rawSlug, ...rest] = raw;
  let slug;
  try {
    slug = decodeURIComponent(rawSlug ?? '');
  } catch {
    return notFound(res);
  }
  const entry = SLUG_RE.test(slug) ? findEntry(root, slug) : null;
  if (!entry) return notFound(res);
  const dir = await realpath(entry.path).catch(() => null);
  if (!dir) return notFound(res);
  const { info } = readServiceInfo(dir);
  const isPage = info?.kind === 'page' && info.page === PAGE_DIR;
  // s/<slug> и s/<slug>/: своя страница (kind page).
  if (!rest.length || (rest.length === 1 && rest[0] === '')) {
    if (!isPage) return notFound(res);
    res.writeHead(302, { ...SAFE_HEADERS, Location: `/${token}/s/${slug}/${PAGE_DIR}/` });
    return res.end();
  }
  let [area, ...tail] = rest;
  if (area !== PAGE_DIR && area !== OUTPUT_DIR) return notFound(res);
  if (area === PAGE_DIR && !isPage) return notFound(res);
  // Страница сослалась на данные как output/<файл> (от своей папки), а не ../output/<файл>: папки page/output
  // в проекте нет, значит это output проекта.
  if (area === PAGE_DIR && tail[0] === OUTPUT_DIR && tail.length > 1 && !(await lstat(join(dir, PAGE_DIR, OUTPUT_DIR)).catch(() => null))) {
    area = OUTPUT_DIR;
    tail = tail.slice(1);
  }
  // Папка page/ (с косой чертой на конце или без): её index.html.
  let path = tail;
  if (area === PAGE_DIR && (!tail.length || (tail.length === 1 && tail[0] === ''))) {
    if (!tail.length) {
      res.writeHead(302, { ...SAFE_HEADERS, Location: `/${token}/s/${slug}/${PAGE_DIR}/` });
      return res.end();
    }
    path = ['index.html'];
  } else if (tail.length && tail[tail.length - 1] === '' && area === PAGE_DIR) {
    path = [...tail.slice(0, -1), 'index.html'];
  }
  const parts = cleanParts(path);
  if (!parts || !parts.length || parts.length > 12) return notFound(res);
  const ext = extname(parts[parts.length - 1]).toLowerCase();
  if (!(area === PAGE_DIR ? PAGE_EXT : OUTPUT_EXT).includes(ext)) return notFound(res);
  const file = await safeFile(dir, area, parts);
  if (!file) return notFound(res);
  const headers = { ...SAFE_HEADERS, 'Content-Type': TYPES[ext] ?? 'application/octet-stream' };
  if (area === OUTPUT_DIR) {
    // Файлы результатов только скачиваются и не исполняются (страница сервиса читает их через fetch).
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${downloadName(parts[parts.length - 1])}`;
    headers['Content-Security-Policy'] = 'sandbox';
  } else {
    headers['Content-Security-Policy'] = "frame-ancestors 'self'";
  }
  await new Promise((done) => {
    const stream = createReadStream(file);
    stream.on('open', () => {
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        stream.destroy();
        res.end();
        return done();
      }
      stream.pipe(res);
    });
    stream.on('error', () => {
      if (!res.headersSent) notFound(res);
      else res.destroy();
      done();
    });
    stream.on('close', done);
  });
}

// Маршрут запроса: { api: sub } или { static: raw } для адресов сервисов с верным токеном, иначе null.
export function serviceRoute(url, token) {
  let pathname;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }
  const raw = pathname.split('/');
  let first;
  try {
    first = decodeURIComponent(raw[1] ?? '');
  } catch {
    return null;
  }
  if (!sameToken(first, token)) return null;
  const [a, b, ...rest] = raw.slice(2);
  if (a === 'api' && b === 'services') {
    let sub;
    try {
      sub = rest.map(decodeURIComponent).join('/');
    } catch {
      return null;
    }
    return { api: sub };
  }
  if (a === 's' && b !== undefined) return { static: [b, ...rest] };
  return null;
}

// s/<slug>/api/<действие>: только POST со страницы кабинета (заголовок X-Cabinet: 1; тип JSON или файл
// проверяет сам вызов). raw: части пути после «s», как пришли.
async function serveApiCall(calls, req, res, raw) {
  if (req.method !== 'POST') {
    req.resume();
    return notAllowed(res, 'POST');
  }
  if (req.headers['x-cabinet'] !== '1') {
    req.resume();
    return sendJson(res, 403, { error: 'Действие сервиса вызывается только с его страницы в кабинете.' });
  }
  let slug = '';
  let route = '';
  try {
    slug = decodeURIComponent(raw[0] ?? '');
    route = decodeURIComponent(raw[2] ?? '');
  } catch {
    slug = '';
  }
  if (raw.length !== 3 || !SLUG_RE.test(slug)) {
    req.resume();
    return sendJson(res, 404, { code: 'ENOROUTE', error: 'Такого действия у сервиса нет.' });
  }
  const r = await calls(req, slug, route);
  return sendJson(res, r.status, r.body);
}

const ATTACHED = Symbol('services');

// Подключение к серверу страницы (createCabinetServer в serve.mjs): адреса сервисов обрабатывает этот модуль,
// остальное прежний обработчик. Повторный вызов на том же сервере ничего не меняет. Возвращает server.
// api: параметры вызовов серверной части для тестов (createServiceCalls в tools/service-calls.mjs).
export function attachServices(server, root, { token, python, timeoutMs, api: apiOptions = {} } = {}) {
  if (server[ATTACHED]) return server;
  if (typeof token !== 'string' || token.length < 8) throw new Error('Для страницы нужен токен (личная часть адреса).');
  server[ATTACHED] = true;
  const cabinet = resolve(root);
  const api = createServicesApi(cabinet, { python, timeoutMs });
  const calls = createServiceCalls(cabinet, { python, ...apiOptions });
  const previous = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const route = serviceRoute(req.url, token);
    if (!route) {
      for (const l of previous) l.call(server, req, res);
      return;
    }
    if (route.api !== undefined) return api(req, res, route.api);
    if (route.static[1] === 'api') {
      serveApiCall(calls, req, res, route.static).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'Сервис не ответил. Попробуйте ещё раз.' });
      });
      return;
    }
    serveServiceFile(cabinet, req, res, route.static, { token }).catch(() => {
      if (!res.headersSent) send(res, 500, TEXT_TYPE, 'Не удалось отдать файл.');
    });
  });
  return server;
}
