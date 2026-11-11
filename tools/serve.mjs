// Локальный сервер страницы кабинета. Без зависимостей. Слушает только петлевые адреса 127.0.0.1 и [::1]
// одного номера порта, адрес печатает с 127.0.0.1.
import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { ensureParticipantFiles } from './init.mjs';
import { BRAND_EXT, findBrandDir } from './brand.mjs';
import { SLUG_RE, hasProcess, isInside, listProcesses, processStatus, startRun } from './processes.mjs';
import { ANALIZ, EXCEL_NAME_RE, createAnalizApi } from './analiz-api.mjs';
import { attachServices } from './services-api.mjs';
import { createCabinetApi } from './cabinet-api.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// На каждом ответе: адрес с токеном не уходит в Referer, тип файла не угадывается, ничего не кэшируется.
const SAFE_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const sendJson = (res, status, data) => send(res, status, TYPES['.json'], JSON.stringify(data));

const notFound = (res, where = 'site') =>
  send(res, 404, 'text/plain; charset=utf-8', `Такого файла нет в папке ${where}.`);

const notAllowed = (res, allow) =>
  send(res, 405, 'text/plain; charset=utf-8', 'Так обратиться к странице нельзя.', { Allow: allow });

const isRead = (req) => req.method === 'GET' || req.method === 'HEAD';

const forbidden = (res) =>
  send(
    res,
    403,
    'text/plain; charset=utf-8',
    'Страница кабинета открывается только по своей ссылке. Скажите Claude «открой страницу».',
  );

const PORT_MIN = 20000;
const PORT_SPAN = 10000;

// Порт зависит от имени пользователя Windows: на общем сервере у каждого свой стартовый порт.
export function portForUser(username) {
  const h = createHash('sha256').update(String(username).toLowerCase()).digest();
  return PORT_MIN + (h.readUInt32BE(0) % PORT_SPAN);
}

export function currentUser() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || '';
  }
}

// Личный секрет адреса страницы: новый при каждом запуске и только в памяти. Старая вкладка или чужая
// программа на освободившемся порту получают токен, который уже ничего не открывает.
export function newPageToken() {
  return randomBytes(16).toString('hex');
}

function sameToken(a, b) {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

// Файл из папки base. Путь не выходит за base, а настоящий путь (после ссылок) не выходит за папку,
// которую возвращает top() (по умолчанию настоящий путь base). dirIndex: папка отдаётся своим index.html.
async function serveFile(res, base, rel, { top = () => realpath(base), where = 'site', headers = () => ({}), dirIndex = true } = {}) {
  if (rel.includes('\0')) return notFound(res, where);
  let file = resolve(base, '.' + rel);
  if (file !== base && !file.startsWith(base + sep)) return notFound(res, where);
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory() && dirIndex) {
    file = resolve(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) return notFound(res, where);
  const [real, limit] = await Promise.all([realpath(file), top()]).catch(() => []);
  if (!real || !isInside(real, limit)) return notFound(res, where);
  const body = await readFile(real);
  send(res, 200, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', body, headers(file));
}

// Файлы результатов только скачиваются и не исполняются на странице: HTML или SVG из output
// не получит доступ к адресу с токеном.
const downloadHeaders = (file) => ({
  'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(file)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`,
  'Content-Security-Policy': 'sandbox',
});

// Файлы бренда: имя одним сегментом из латиницы, цифр, «_» и «-» с расширением из BRAND_EXT.
// Без «/», «\», «..» и скрытых файлов. SVG, открытый отдельной вкладкой, не выполняет скрипты.
const BRAND_NAME_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const brandHeaders = () => ({ 'Content-Security-Policy': 'sandbox' });

// Набор интерфейса курса (tools/ui): Basecoat, Tailwind, Chart.js и kabinet.css/js для своих страниц сервисов.
// Имя одним сегментом, как у бренда. ui/brand.css собирается из theme.css бренда: переменные переименованы
// в --brand-*, чтобы --accent бренда (цвет компании) не перекрыл --accent Basecoat (фон под указателем).
const UI_EXT = new Set(['.css', '.js', '.html', '.svg', '.png', '.json']);
const UI_BRAND = 'brand.css';

async function brandForUi(brand) {
  const dir = brand ? await brand() : null;
  const css = dir ? await readFile(join(dir, 'theme.css'), 'utf8').catch(() => '') : '';
  return css.replace(/--([A-Za-z0-9_-]+)/g, '--brand-$1');
}

// Страница отдаётся только под /<token>/. Остальные пути: 403.
// Необязательный api(req, res, sub) вызывается для /<token>/api/<sub>; вернёт true или промис
// с true, если ответ отправлен.
// Необязательный output { root, allow(slug, parts) }: /<token>/output/<slug>/<файл> отдаётся из <root>/output/<slug>
// только для чтения, на скачивание и только там, где allow(slug, parts) истинно (parts: части пути после slug).
// Граница считается от настоящего пути кабинета: папка output, ведущая в другое место, не отдаётся.
// Необязательный brand(): папка бренда или null. /<token>/brand/<файл> отдаётся только из неё (tools/brand.mjs):
// .css, .svg, .png, .json, без вложенных папок и без выхода за неё по ссылкам. Нет папки: 404.
// Необязательный ui: папка набора интерфейса. /<token>/ui/<файл> отдаётся из неё (без вложенных папок),
// /<token>/ui/brand.css: переменные бренда под именами --brand-* (нет бренда: пустой файл).
export function createSiteServer(rootDir, { token, api, output, brand, ui } = {}) {
  if (typeof token !== 'string' || token.length < 8) {
    throw new Error('Для страницы нужен токен (личная часть адреса).');
  }
  const root = resolve(rootDir);
  return http.createServer(async (req, res) => {
    try {
      for (const [k, v] of Object.entries(SAFE_HEADERS)) res.setHeader(k, v);
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        return forbidden(res);
      }
      const first = pathname.split('/')[1] ?? '';
      if (!sameToken(first, token)) return forbidden(res);
      if (pathname === `/${first}`) {
        res.writeHead(301, { Location: `/${token}/`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      const rel = pathname.slice(first.length + 1);
      if (api && (rel === '/api' || rel.startsWith('/api/'))) {
        if (await api(req, res, rel.slice('/api/'.length))) return;
        if (!res.headersSent) return notFound(res);
        return;
      }
      if (!isRead(req)) return notAllowed(res, 'GET, HEAD');
      if (brand && /^\/brand(\/|$)/i.test(rel)) {
        const name = rel.slice('/brand/'.length);
        if (!BRAND_NAME_RE.test(name) || !BRAND_EXT.has(extname(name).toLowerCase())) return notFound(res, 'brand');
        const dir = await brand();
        if (!dir) return notFound(res, 'brand');
        return await serveFile(res, resolve(dir), '/' + name, { where: 'brand', headers: brandHeaders, dirIndex: false });
      }
      if (ui && /^\/ui(\/|$)/i.test(rel)) {
        const name = rel.slice('/ui/'.length);
        if (name === UI_BRAND) return send(res, 200, TYPES['.css'], await brandForUi(brand));
        if (!BRAND_NAME_RE.test(name) || !UI_EXT.has(extname(name).toLowerCase())) return notFound(res, 'ui');
        return await serveFile(res, resolve(ui), '/' + name, { where: 'ui', dirIndex: false });
      }
      if (output && rel.startsWith('/output/')) {
        const [slug, ...rest] = rel.slice('/output/'.length).split('/');
        if (!SLUG_RE.test(slug) || !output.allow(slug, rest)) return notFound(res, 'output');
        const cabinet = resolve(output.root);
        return await serveFile(res, resolve(cabinet, 'output', slug), '/' + rest.join('/'), {
          top: async () => join(await realpath(cabinet), 'output'),
          where: 'output',
          headers: downloadHeaders,
        });
      }
      return await serveFile(res, root, rel);
    } catch {
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Не удалось отдать файл.');
    }
  });
}

// Ошибки запуска (processes.mjs) в ответы страницы.
const RUN_STATUS = {
  EBADSLUG: 404,
  ENOPROCESS: 404,
  ENORUN: 404,
  EOUTSIDE: 403,
  ECLAUDE: 400,
  EBADPROCESS: 400,
  ERUNNING: 409,
  ELIMIT: 409,
};

// Запуск только кнопкой со страницы: заголовок X-Cabinet и тип JSON чужая форма или ссылка
// без разрешения браузера не пришлёт.
const fromPage = (req) =>
  req.headers['x-cabinet'] === '1' && /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '');

// API процессов под /<token>/api/: список, запуск, статус.
export function createProcessApi(root, { python, timeoutMs } = {}) {
  const handle = (req, res, sub) => {
    const [route, ...rest] = sub.split('/');
    // Имя процесса: ровно один сегмент пути; «run/a/../b» и подобное даёт null и ответ 404.
    const slug = rest.length === 1 ? rest[0] : null;
    if (sub === 'processes') {
      if (!isRead(req)) return notAllowed(res, 'GET, HEAD');
      return sendJson(res, 200, listProcesses(root));
    }
    if (route === 'run' && rest.length) {
      if (req.method !== 'POST') return notAllowed(res, 'POST');
      req.resume();
      if (!fromPage(req)) {
        return sendJson(res, 403, { error: 'Процесс запускается только кнопкой «Запустить» на странице кабинета.' });
      }
      try {
        startRun(root, slug, { python, timeoutMs });
      } catch (e) {
        const status = RUN_STATUS[e.code];
        // code (например ERUNNING или ELIMIT) нужен странице, чтобы различать ответы 409.
        if (status) return sendJson(res, status, { error: e.message, code: e.code });
        return sendJson(res, 500, { error: `Не удалось начать расчёт (${e.code ?? e.message}).` });
      }
      return sendJson(res, 202, { started: true });
    }
    if (route === 'status' && rest.length) {
      if (!isRead(req)) return notAllowed(res, 'GET, HEAD');
      if (!hasProcess(root, slug)) return sendJson(res, 404, { error: 'Такого процесса нет.' });
      return sendJson(res, 200, processStatus(root, slug));
    }
    return sendJson(res, 404, { error: 'Такого адреса у страницы нет.' });
  };
  // Ответ API отправлен всегда.
  return (req, res, sub) => {
    handle(req, res, sub);
    return true;
  };
}

// Файлы результатов, которые страница отдаёт на скачивание: output/<slug>/ процесса и файлы Excel сервиса
// «Аналитика таблиц» прямо в output/analiz/ (история и прочее оттуда не отдаются).
const outputAllowed = (root) => (slug, parts) =>
  hasProcess(root, slug) || (slug === ANALIZ && parts.length === 1 && EXCEL_NAME_RE.test(parts[0]));

// Страница кабинета целиком: site/ (с ней и страница сервиса analiz.html), API процессов и сервиса
// «Аналитика таблиц» (api/analiz/...), файлы результатов из output/ и бренд.
// Папка бренда ищется при каждом запросе: её можно положить, не перезапуская страницу.
// analiz: параметры API сервиса для тестов (tools/analiz-api.mjs); cabinet: то же для api/cabinet
// (tools/cabinet-api.mjs: папки, версия, проверки для страницы «Настройки»).
export function createCabinetServer(cabinetRoot, { token, python, timeoutMs, brand, analiz = {}, cabinet = {}, serviceApi = {} } = {}) {
  const root = resolve(cabinetRoot);
  const processApi = createProcessApi(root, { python, timeoutMs });
  const analizApi = createAnalizApi(root, { python, ...analiz });
  const cabinetApi = createCabinetApi(root, { python, ...cabinet });
  const prefix = `${ANALIZ}/`;
  const api = (req, res, sub) => {
    if (sub.startsWith(prefix)) return analizApi(req, res, sub.slice(prefix.length));
    if (sub === 'cabinet' || sub.startsWith('cabinet/')) return cabinetApi(req, res, sub.slice('cabinet'.length).replace(/^\//, ''));
    return processApi(req, res, sub);
  };
  const server = createSiteServer(resolve(root, 'site'), {
    token,
    api,
    output: { root, allow: outputAllowed(root) },
    brand: brand ?? (() => findBrandDir(root)),
    ui: resolve(root, 'tools', 'ui'),
  });
  // Сервисы-проекты (tools/services-api.mjs): api/services/..., s/<slug>/page/... и s/<slug>/output/...
  return attachServices(server, root, { token, python, timeoutMs, api: serviceApi });
}

function tryListen(server, host, port) {
  return new Promise((ok, fail) => {
    const onError = (e) => fail(e);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      ok(server.address().port);
    });
  });
}

const BUSY = new Set(['EADDRINUSE', 'EACCES']);

const closeServer = (server) => new Promise((ok) => server.close(() => ok()));

// Второй сервер с тем же обработчиком запросов: для адреса [::1].
export function twinServer(server) {
  const twin = http.createServer();
  for (const listener of server.listeners('request')) twin.on('request', listener);
  return twin;
}

// Один номер порта на 127.0.0.1 и, если есть twin, на [::1]. Браузер по имени localhost часто идёт
// сначала на ::1: чужая программа на [::1] того же порта получила бы адрес с токеном. Поэтому [::1],
// занятый кем-то другим, значит, что порт не годится: открытое на 127.0.0.1 закрывается, ошибка уходит
// наверх (EADDRINUSE или EACCES). Другие ошибки [::1] (EADDRNOTAVAIL, EAFNOSUPPORT: IPv6 в системе нет
// или выключен) не мешают: туда не попадёт и браузер.
async function listenLoopback(server, twin, port, host, state) {
  const got = await tryListen(server, host, port);
  if (!twin || state.noIpv6) return got;
  try {
    await tryListen(twin, '::1', got);
  } catch (e) {
    if (!BUSY.has(e.code)) {
      state.noIpv6 = true;
      return got;
    }
    await closeServer(server);
    throw e;
  }
  return got;
}

// Пробует порты по кругу в диапазоне from..to, начиная со start, не больше attempts попыток.
// Все заняты: порт выбирает система (номер вне диапазона, страница всё равно работает).
// twin: второй сервер (twinServer) для того же номера порта на [::1].
export async function listenFirstFree(
  server,
  { host = '127.0.0.1', from = PORT_MIN, to = PORT_MIN + PORT_SPAN - 1, start = from, attempts = 50, twin = null } = {},
) {
  const size = to - from + 1;
  const tries = Math.min(attempts, size);
  const state = {};
  for (let i = 0; i < tries; i++) {
    const port = from + ((start - from + i) % size);
    try {
      return await listenLoopback(server, twin, port, host, state);
    } catch (e) {
      if (!BUSY.has(e.code)) throw e;
    }
  }
  for (let i = 0; i < 5; i++) {
    try {
      return await listenLoopback(server, twin, 0, host, state);
    } catch (e) {
      if (!BUSY.has(e.code)) throw e;
    }
  }
  throw new Error(`Все порты с ${from} по ${to} заняты. Закройте другие программы и попробуйте снова.`);
}

// Ровно этот порт (параметр --port) на 127.0.0.1 и [::1].
export function listenFixed(server, port, { twin = null, host = '127.0.0.1' } = {}) {
  return listenLoopback(server, twin, port, host, {});
}

function openBrowser(url) {
  // cmd.exe по полному пути: файл cmd.exe в папке кабинета не должен запуститься вместо системного.
  const comspec = process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const [cmd, args] =
    process.platform === 'win32'
      ? [comspec, ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Браузер не открылся: адрес уже напечатан.
  }
}

export function describeListenError(err, port) {
  const code = err?.code;
  const next = port < 65535 ? ` Выберите другой номер: --port ${port + 1}` : '';
  const tail = code ? ` (${code})` : '';
  switch (code) {
    case 'EADDRINUSE':
      return `Порт ${port} занят другой программой.${next}${tail}`;
    case 'EACCES':
      return `Порт ${port} закрыт системой.${next}${tail}`;
    case 'EPERM':
      return `Системе не разрешено открыть порт ${port}. Возможно, мешает антивирус или брандмауэр.${next}${tail}`;
    case 'EADDRNOTAVAIL':
      return `Адрес 127.0.0.1 сейчас недоступен на этом компьютере. Проверьте сетевые настройки.${tail}`;
    default:
      return `Не удалось открыть порт ${port}. Покажите это сообщение Claude или тренеру.${tail}`;
  }
}

async function main() {
  // Windows (cmd.exe и поиск программ в Node) не ищет программы в текущей папке, то есть в кабинете.
  process.env.NoDefaultCurrentDirectoryInExePath = '1';
  const args = process.argv.slice(2);
  const open = args.includes('--open');
  const pi = args.indexOf('--port');
  let fixed = null;
  if (pi !== -1) {
    fixed = Number(args[pi + 1]);
    if (!Number.isInteger(fixed) || fixed < 1 || fixed > 65535) {
      console.error('Укажите номер порта числом, например: --port 8080');
      process.exit(1);
    }
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    ensureParticipantFiles(root);
  } catch (e) {
    console.error(`Не удалось создать файлы кабинета из шаблонов (${e.code ?? e.message}).`);
  }
  // Файл с токеном от прошлых версий кабинета больше не нужен: токен живёт только в памяти.
  try {
    rmSync(resolve(root, 'me', 'page-token.txt'), { force: true });
  } catch {
    // Не удалился: он ничего не открывает.
  }
  const token = newPageToken();
  const server = createCabinetServer(root, { token });
  const twin = twinServer(server);
  let port;
  try {
    port = fixed
      ? await listenFixed(server, fixed, { twin })
      : await listenFirstFree(server, { start: portForUser(currentUser()), twin });
  } catch (e) {
    // Диапазон занят целиком: у этой ошибки уже есть русский текст и нет code.
    console.error(e.code ? describeListenError(e, fixed ?? PORT_MIN) : e.message);
    process.exit(1);
  }
  // Адрес с 127.0.0.1, без имени localhost: браузер не пойдёт на [::1] и не спросит DNS.
  const url = `http://127.0.0.1:${port}/${token}/`;
  console.log(`Страница работает: ${url}`);
  console.log('Остановить: Ctrl+C');
  if (open) openBrowser(url);
}

if (isMain(import.meta.url)) {
  main();
}
