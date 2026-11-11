// Проверка среды кабинета. Без зависимостей. Запуск: node tools/check.mjs [--net] [--json]
import http from 'node:http';
import { execFile } from 'node:child_process';
import { open, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { ensureParticipantFiles, installUserSkills } from './init.mjs';
import { randomBytes } from 'node:crypto';
import { createSiteServer, describeListenError } from './serve.mjs';

const TLS_RE = /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_|CERTIFICATE_VERIFY_FAILED/;
const NET_RE = /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ConnectTimeout|NewConnectionError|Max retries exceeded|timeout|timed out/i;
const GIT_TLS_RE = /SSL certificate problem|unable to get local issuer certificate|0x80092012|0x80092013|unable to check revocation|revocation/i;
const REVOKE_RE = /0x80092012|0x80092013|revocation/i;
const GIT_NET_RE = /Could not resolve (host|proxy)|Failed to connect|Couldn't connect|Connection (refused|reset|timed out)|Timed out|Proxy CONNECT aborted|Recv failure|ETIMEDOUT|ENOTFOUND/i;

// Адрес репозитория кабинета: ORG заменить на организацию на GitHub (то же в README.md и .github/workflows/check.yml).
export const CABINET_REPO = 'https://github.com/ORG/ai-cabinet';

// Git без вопросов: нет репозитория или нужен вход, значит ошибка, а не зависшее окно ввода.
// LC_ALL=C: сообщения git по-английски, их разбирают classifyGitFailure и update.mjs.
export const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' });

// 'tls': прокси подменяет сертификат; 'net': нет связи; 'other': что-то ещё.
export function classifyGitFailure(text) {
  if (GIT_TLS_RE.test(text)) return 'tls';
  if (GIT_NET_RE.test(text)) return 'net';
  return 'other';
}

// Первая непустая строка без точки в конце: к ней дописывается своё предложение.
export const firstLine = (text) =>
  String(text ?? '').split('\n').map((s) => s.trim().replace(/\.+$/, '')).find(Boolean) ?? 'причина неизвестна';

export function parseVersion(s) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(s ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function exitCodeFor(results) {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

// Никогда не отклоняет промис: ошибки запуска превращаются в ненулевой code.
// shell на Windows нужен для npm и pip (это .cmd); git это .exe, его зовём с shell: false.
// Node 24 ругается (DEP0190) на args вместе с shell: true, поэтому при shell зовём одной строкой.
// Аргумент с пробелом или кавычкой берём в кавычки: cmd.exe (win32) понимает только двойные, sh одинарные.
// Остальные аргументы здесь постоянные и простые.
const quoteArg = (a, platform) => {
  if (!/[\s"']/.test(a)) return a;
  return platform === 'win32' ? `"${a.replace(/"/g, '\\"')}"` : `'${a.replace(/'/g, `'\\''`)}'`;
};

export function buildExecCall(cmd, args, shell, platform = process.platform) {
  return shell
    ? { file: [cmd, ...args.map((a) => quoteArg(a, platform))].join(' '), args: undefined }
    : { file: cmd, args };
}

export function defaultExec(cmd, args, { timeout = 10000, cwd, env, shell = process.platform === 'win32' } = {}) {
  return new Promise((done) => {
    try {
      const call = buildExecCall(cmd, args, shell);
      execFile(
        ...(call.args ? [call.file, call.args] : [call.file]),
        { shell, windowsHide: true, timeout, encoding: 'utf8', cwd, env },
        (err, stdout, stderr) => {
          if (!err) return done({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
          const text = typeof err.code === 'string' ? err.code : err.killed ? 'ETIMEDOUT' : '';
          done({
            code: typeof err.code === 'number' ? err.code : 1,
            stdout: stdout ?? '',
            stderr: [stderr, text].filter(Boolean).join('\n'),
          });
        },
      );
    } catch (e) {
      done({ code: 1, stdout: '', stderr: String(e?.code ?? e?.message ?? e) });
    }
  });
}

const ok = (id, title) => ({ id, status: 'ok', title });
const warn = (id, title, hint) => ({ id, status: 'warn', title, hint });
const fail = (id, title, hint) => ({ id, status: 'fail', title, hint });

function checkNode(nodeVersion) {
  const v = parseVersion(nodeVersion);
  if (v && v[0] >= 22) return ok('node', `Node.js ${v.join('.')}`);
  return fail(
    'node',
    `Node.js ${nodeVersion || 'не найден'}: нужна версия 22 или новее`,
    'установите Node.js 22 или новее (LTS) с nodejs.org или попросите ИТ обновить его',
  );
}

async function checkGit(exec) {
  const r = await exec('git', ['--version']);
  const v = r.code === 0 ? parseVersion(r.stdout) : null;
  if (v) return ok('git', `Git ${v.join('.')}`);
  return fail('git', 'Git не найден', 'установите Git for Windows с git-scm.com или попросите ИТ');
}

export async function detectPython(exec, platform) {
  const candidates =
    platform === 'win32'
      ? [['python', []], ['py', ['-3']]]
      : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    const r = await exec(cmd, [...pre, '--version']);
    const v = r.code === 0 ? parseVersion(`${r.stdout}\n${r.stderr}`) : null;
    if (v) return { cmd, pre, version: v };
  }
  return null;
}

const pyOk = (py) => py && (py.version[0] > 3 || (py.version[0] === 3 && py.version[1] >= 12));

function pythonResult(py) {
  const hint =
    'попросите ИТ установить Python 3.12 или новее для вашей учётной записи; если разрешено, скачайте его с python.org и установите "для текущего пользователя", отметив "Add python.exe to PATH"';
  if (!py) return fail('python', 'Python не найден (или это заглушка Microsoft Store)', hint);
  if (pyOk(py)) return ok('python', `Python ${py.version.join('.')}`);
  return fail('python', `Python ${py.version.join('.')}: нужна версия 3.12 или новее`, hint);
}

// Excel читает openpyxl, Word пишет python-docx (импортируется как docx).
async function checkPyLibs(exec, py) {
  const title = 'Библиотеки Python для Excel и Word';
  if (!pyOk(py)) return fail('py-libs', 'Сначала нужен Python 3.12 или новее', 'установите его по подсказке выше, затем запустите проверку снова');
  const base = [py.cmd, ...py.pre].join(' ');
  const r = await exec(py.cmd, [...py.pre, '-c', 'import openpyxl, docx'], { timeout: 30000 });
  if (r.code === 0) return ok('py-libs', `${title} установлены`);
  const missing = /No module named ['"]?([\w.]+)/.exec(r.stderr)?.[1];
  const what = missing ? `не найдена библиотека ${missing}` : 'не удалось подключить openpyxl и docx';
  return fail('py-libs', `${title}: ${what}`, `выполните ${base} -m pip install --user openpyxl python-docx`);
}

async function checkWrite(cwd) {
  const file = join(cwd, 'проверка записи.tmp');
  try {
    await writeFile(file, 'проверка');
    return ok('write', 'Запись файлов в папку кабинета работает');
  } catch (e) {
    return fail(
      'write',
      'Не удалось создать файл в папке кабинета',
      `проверьте, что папка не только для чтения и не в защищённом месте (${e.code ?? 'ошибка'}). Передайте это ИТ`,
    );
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

function httpGet(port, path = '/') {
  return new Promise((done, bad) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => done({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', bad);
  });
}

// Отдаём служебную страницу из templates/site: свою страницу в site/ участник меняет сам.
// Порт 0: его выбирает система. Токен одноразовый, как у страницы при каждом запуске.
async function checkLocalhost(cwd) {
  const token = randomBytes(16).toString('hex');
  const server = createSiteServer(join(cwd, 'templates', 'site'), { token });
  try {
    let port;
    try {
      port = await new Promise((done, bad) => {
        server.once('error', bad);
        server.listen(0, '127.0.0.1', () => done(server.address().port));
      });
    } catch (e) {
      const text = e.code ? describeListenError(e, 0) : e.message;
      return fail('localhost', 'Страница на localhost не запускается', text);
    }
    try {
      const { status, body } = await httpGet(port, `/${token}/`);
      const guard = await httpGet(port, '/');
      if (status === 200 && body.includes('data-cabinet="ok"') && guard.status === 403) {
        return ok('localhost', `Страница на localhost открывается (порт ${port})`);
      }
      return fail(
        'localhost',
        'Страница на localhost отвечает не так, как ожидалось',
        'в кабинете нет служебной страницы templates/site/index.html. Покажите это сообщение Claude или тренеру',
      );
    } catch (e) {
      return fail(
        'localhost',
        'Страница на localhost не отвечает',
        `возможно, мешает антивирус или брандмауэр (${e.code ?? e.message}). Передайте это ИТ`,
      );
    }
  } finally {
    server.closeAllConnections?.();
    if (server.listening) await new Promise((r) => server.close(() => r()));
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Служебные файлы систем и программ: не рабочие файлы человека (.gitkeep, .DS_Store, блокировки Excel).
const isJunk = (name) => name.startsWith('.') || name.startsWith('~$') || /^(desktop\.ini|thumbs\.db)$/i.test(name);

// Настройки кабинета (сторож, разрешения, модель) Claude Code берёт из папки, где открыт разговор, и только
// при его начале. Разговор, где кабинет поставили по ссылке, открыт в другой папке и работает без них.
// Метку AI_CABINET ставит .claude/settings.json; проверяем её, только когда проверку запустил Claude.
export function checkSession(env) {
  if (env.CLAUDECODE !== '1') return null;
  if (env.AI_CABINET === '1') return ok('session', 'Разговор открыт в папке кабинета');
  return fail(
    'session',
    'Разговор открыт не в папке кабинета: правила и настройки кабинета не действуют',
    'начните новый разговор в папке ai-cabinet и скажите «начнём»',
  );
}

async function checkInput(cwd) {
  const dir = join(cwd, 'input');
  let names;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && !isJunk(e.name)).map((e) => e.name);
  } catch {
    return warn('input', 'Папки input нет', 'создайте папку input и положите туда свой рабочий файл');
  }
  if (names.length === 0) {
    return warn('input', 'В папке input пока нет файлов', 'положите туда свой рабочий файл');
  }
  for (const name of names) {
    let fh;
    try {
      fh = await open(join(dir, name), 'r');
      await fh.read(Buffer.alloc(64), 0, 64, 0);
    } catch {
      return fail(
        'input',
        `Файл «${name}» в папке input не читается`,
        'закройте файл в других программах (Excel, Word) и попробуйте снова; если не помогло, передайте ИТ',
      );
    } finally {
      await fh?.close().catch(() => {});
    }
  }
  const n = names.length;
  return ok('input', `В папке input ${n} ${plural(n, 'файл', 'файла', 'файлов')}, они читаются`);
}

function netHint(what, r) {
  const text = `${r.stderr}\n${r.stdout}`;
  const isNpm = what === 'npm';
  if (TLS_RE.test(text)) {
    return isNpm
      ? 'в сети компании, похоже, подменяют сертификаты, а корневой сертификат прокси не настроен для Node.js. Передайте ИТ: нужно указать файл сертификата в переменной NODE_EXTRA_CA_CERTS'
      : 'в сети компании, похоже, подменяют сертификаты, а корневой сертификат прокси не настроен для Python. Передайте ИТ: нужно добавить сертификат в системное хранилище или в настройки pip';
  }
  if (NET_RE.test(text)) {
    return isNpm
      ? 'нет связи с сервером пакетов. Попросите ИТ открыть адрес registry.npmjs.org'
      : 'нет связи с сервером пакетов. Попросите ИТ открыть адреса pypi.org и files.pythonhosted.org';
  }
  return `не удалось связаться с сервером пакетов: ${firstLine(text)}. Покажите это сообщение ИТ`;
}

function gitHint(r, platform) {
  const text = `${r.stderr}\n${r.stdout}`;
  switch (classifyGitFailure(text)) {
    case 'tls':
      if (REVOKE_RE.test(text)) {
        return platform === 'win32'
          ? 'Windows не может проверить отзыв сертификата GitHub. Передайте ИТ: нужен доступ к серверам CRL/OCSP, либо выполните: git config --global http.schannelCheckRevoke false'
          : 'не удаётся проверить отзыв сертификата GitHub: похоже, проблема с сертификатом или прокси. Передайте это ИТ';
      }
      return platform === 'win32'
        ? 'в сети компании, похоже, подменяют сертификаты, и Git им не доверяет. Чтобы Git брал сертификаты из Windows, выполните: git config --global http.sslBackend schannel'
        : 'в сети компании, похоже, подменяют сертификаты, а корневой сертификат прокси не настроен для Git. Передайте это ИТ';
    case 'net':
      return 'нет связи с GitHub. Попросите ИТ открыть адреса github.com и *.githubusercontent.com';
    default:
      return `не удалось связаться с GitHub: ${firstLine(text)}. Покажите это сообщение ИТ`;
  }
}

async function checkGitRemote(exec, platform) {
  const r = await exec('git', ['ls-remote', '--heads', CABINET_REPO], { timeout: 20000, env: gitEnv(), shell: false });
  if (r.code === 0) return ok('net-git', 'Связь с GitHub для обновлений кабинета работает');
  return fail('net-git', 'Связь с GitHub для обновлений кабинета не работает', gitHint(r, platform));
}

async function checkNpm(exec) {
  const r = await exec('npm', ['view', 'express', 'version', '--fetch-retries=0', '--fetch-timeout=15000'], { timeout: 20000 });
  if (r.code === 0) return ok('net-npm', 'Загрузка пакетов npm работает');
  return fail('net-npm', 'Загрузка пакетов npm не работает', netHint('npm', r));
}

async function checkPip(exec, py) {
  if (!py) return warn('net-pip', 'Python не найден, проверка pip пропущена', 'сначала установите Python 3.12 или новее');
  const r = await exec(py.cmd, [...py.pre, '-m', 'pip', 'index', 'versions', 'requests', '--retries', '0', '--timeout', '15'], { timeout: 20000 });
  if (r.code === 0) return ok('net-pip', 'Загрузка пакетов pip работает');
  return fail('net-pip', 'Загрузка пакетов pip не работает', netHint('pip', r));
}

export async function runChecks({
  cwd = fileURLToPath(new URL('..', import.meta.url)),
  net = false,
  exec = defaultExec,
  platform = process.platform,
  nodeVersion = process.version,
  env = process.env,
} = {}) {
  cwd = resolve(cwd);
  const py = await detectPython(exec, platform);
  const session = checkSession(env);
  const results = [
    ...(session ? [session] : []),
    checkNode(nodeVersion),
    await checkGit(exec),
    pythonResult(py),
    await checkPyLibs(exec, py),
    await checkWrite(cwd),
    await checkLocalhost(cwd),
    await checkInput(cwd),
  ];
  if (net) {
    results.push(await checkGitRemote(exec, platform));
    results.push(await checkNpm(exec));
    results.push(await checkPip(exec, py));
  }
  return results;
}

const MARK = { ok: '✓', warn: '!', fail: '✗' };

export function formatReport(results) {
  const lines = results.map((r) => `${MARK[r.status]} ${r.title}${r.hint ? ` → ${r.hint}` : ''}`);
  const total = results.length;
  const good = results.filter((r) => r.status === 'ok').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  const fails = results.filter((r) => r.status === 'fail').length;
  if (fails > 0) {
    const extra = warns ? `, ${warns} ${plural(warns, 'предупреждение', 'предупреждения', 'предупреждений')}` : '';
    lines.push(`Есть проблемы: ${fails} из ${total} не прошли${extra}. Покажите этот отчёт Claude или ИТ`);
  } else {
    const extra = warns ? `, ${warns} ${plural(warns, 'предупреждение', 'предупреждения', 'предупреждений')}` : '';
    lines.push(`Готово: ${good} из ${total}${extra}`);
  }
  return lines.join('\n');
}

async function main() {
  // Windows не ищет программы (python, py, git) в текущей папке, то есть в кабинете: только в PATH.
  process.env.NoDefaultCurrentDirectoryInExePath = '1';
  const args = process.argv.slice(2);
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    ensureParticipantFiles(root);
  } catch {
    // Папка только для чтения: это покажет проверка записи ниже.
  }
  // Скиллы «новый сервис» и «добавь в кабинет» для проектов сервисов (работают в любой папке): молча, проверка
  // сетапа на первом занятии их ставит. Не вышло: поставит «обнови кабинет» или node tools/init.mjs.
  installUserSkills(root);
  const results = await runChecks({ net: args.includes('--net') });
  console.log(args.includes('--json') ? JSON.stringify(results, null, 2) : formatReport(results));
  process.exitCode = exitCodeFor(results);
}

if (isMain(import.meta.url)) {
  main();
}
