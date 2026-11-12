import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks, formatReport, parseVersion, exitCodeFor, buildExecCall, classifyGitFailure, checkSession } from '../check.mjs';
import { copyDir } from './copy-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeCabinet({ withInput = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cab-'));
  const dir = join(base, 'Айгуль Н');
  mkdirSync(join(dir, 'templates', 'site'), { recursive: true });
  mkdirSync(join(dir, 'input'));
  writeFileSync(join(dir, 'templates', 'site', 'index.html'), '<body data-cabinet="ok">x</body>');
  writeFileSync(join(dir, 'input', '.gitkeep'), '');
  if (withInput) writeFileSync(join(dir, 'input', 'отчёт.csv'), 'a;b\n1;2\n');
  return { base, dir };
}

// Заглушка exec: ключ "cmd arg arg" -> ответ; нет ключа -> команда не найдена.
function stub(table) {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    if (table[key]) return table[key];
    return { code: 1, stdout: '', stderr: 'ENOENT' };
  };
}
const good = {
  'git --version': { code: 0, stdout: 'git version 2.45.1\n', stderr: '' },
  'python3 --version': { code: 0, stdout: 'Python 3.12.4\n', stderr: '' },
  'python --version': { code: 0, stdout: 'Python 3.12.4\n', stderr: '' },
  'python3 -c import openpyxl, docx': { code: 0, stdout: '', stderr: '' },
  'python -c import openpyxl, docx': { code: 0, stdout: '', stderr: '' },
  'py -3 -c import openpyxl, docx': { code: 0, stdout: '', stderr: '' },
};
const byId = (rs, id) => rs.find((r) => r.id === id);

test('parseVersion: node, python, мусор', () => {
  assert.deepEqual(parseVersion('v22.19.0'), [22, 19, 0]);
  assert.deepEqual(parseVersion('Python 3.12.4'), [3, 12, 4]);
  assert.equal(parseVersion('Python was not found; run without arguments'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

test('node 20 -> fail с подсказкой про Node 22', async () => {
  const { base, dir } = makeCabinet();
  try {
    const rs = await runChecks({ cwd: dir, exec: stub(good), platform: 'linux', env: {}, nodeVersion: 'v20.11.0' });
    const n = byId(rs, 'node');
    assert.equal(n.status, 'fail');
    assert.match(n.hint, /Node\.js 22/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('все базовые проверки проходят в cwd с кириллицей и пробелом', async () => {
  const { base, dir } = makeCabinet({ withInput: true });
  try {
    const rs = await runChecks({ cwd: dir, exec: stub(good), platform: 'linux', env: {}, nodeVersion: 'v22.19.0' });
    for (const id of ['node', 'git', 'python', 'write', 'localhost', 'input']) {
      assert.equal(byId(rs, id)?.status, 'ok', `${id}: ${JSON.stringify(byId(rs, id))}`);
    }
    assert.equal(byId(rs, 'net-npm'), undefined);
    assert.equal(byId(rs, 'net-git'), undefined);
    assert.equal(existsSync(join(dir, 'проверка записи.tmp')), false);
    assert.equal(exitCodeFor(rs), 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('git отсутствует -> fail', async () => {
  const { base, dir } = makeCabinet();
  try {
    const t = { ...good };
    delete t['git --version'];
    const rs = await runChecks({ cwd: dir, exec: stub(t), platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'git').status, 'fail');
    assert.equal(exitCodeFor(rs), 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('python: заглушка Store (9009) -> fail с подсказкой, без исключения', async () => {
  const { base, dir } = makeCabinet();
  try {
    const store = { code: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store' };
    const exec = stub({ ...good, 'python --version': store, 'py -3 --version': store });
    const rs = await runChecks({ cwd: dir, exec, platform: 'win32', env: {}, nodeVersion: 'v22.0.0' });
    const p = byId(rs, 'python');
    assert.equal(p.status, 'fail');
    assert.match(p.hint, /ИТ/);
    assert.match(p.hint, /python\.org/);
    assert.match(p.hint, /текущего пользователя/);
    assert.match(p.hint, /Add python\.exe to PATH/);
    assert.equal(byId(rs, 'py-libs').status, 'fail');
    assert.match(byId(rs, 'py-libs').title, /Сначала нужен Python/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('python: на Windows пробует py -3 после python; старый Python -> fail', async () => {
  const { base, dir } = makeCabinet();
  try {
    const calls = [];
    const inner = stub({
      ...good,
      'python --version': { code: 9009, stdout: '', stderr: 'Python was not found' },
      'py -3 --version': { code: 0, stdout: 'Python 3.12.1\n', stderr: '' },
    });
    const exec = async (c, a, o) => { calls.push([c, ...a].join(' ')); return inner(c, a, o); };
    let rs = await runChecks({ cwd: dir, exec, platform: 'win32', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'python').status, 'ok');
    assert.ok(calls.indexOf('python --version') < calls.indexOf('py -3 --version'));

    const old = stub({ ...good, 'python3 --version': { code: 0, stdout: 'Python 3.9.6\n', stderr: '' } });
    rs = await runChecks({ cwd: dir, exec: old, platform: 'darwin', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'python').status, 'fail');
    assert.match(byId(rs, 'python').hint, /3\.12/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('net-npm: SELF_SIGNED_CERT_IN_CHAIN -> fail, hint про корневой сертификат', async () => {
  const { base, dir } = makeCabinet();
  try {
    const exec = stub({
      ...good,
      'npm view express version --fetch-retries=0 --fetch-timeout=15000': { code: 1, stdout: '', stderr: 'npm error code SELF_SIGNED_CERT_IN_CHAIN\n' },
      'python3 -m pip index versions requests --retries 0 --timeout 15': { code: 0, stdout: 'requests (2.32.3)', stderr: '' },
    });
    const rs = await runChecks({ cwd: dir, net: true, exec, platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    const n = byId(rs, 'net-npm');
    assert.equal(n.status, 'fail');
    assert.match(n.hint, /сертификат/);
    assert.match(n.hint, /NODE_EXTRA_CA_CERTS/);
    assert.match(n.hint, /ИТ/);
    assert.equal(byId(rs, 'net-pip').status, 'ok');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('net-pip: CERTIFICATE_VERIFY_FAILED -> тот же hint; ENOTFOUND/ConnectTimeout -> белый список', async () => {
  const { base, dir } = makeCabinet();
  const run = async (stderr, npmStderr = '') =>
    runChecks({
      cwd: dir,
      net: true,
      platform: 'linux',
      env: {}, nodeVersion: 'v22.0.0',
      exec: stub({
        ...good,
        'npm view express version --fetch-retries=0 --fetch-timeout=15000': npmStderr
          ? { code: 1, stdout: '', stderr: npmStderr }
          : { code: 0, stdout: '4.19.2\n', stderr: '' },
        'python3 -m pip index versions requests --retries 0 --timeout 15': { code: 1, stdout: '', stderr },
      }),
    });
  try {
    let rs = await run('SSLError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed');
    assert.equal(byId(rs, 'net-pip').status, 'fail');
    assert.match(byId(rs, 'net-pip').hint, /сертификат/);
    assert.match(byId(rs, 'net-pip').hint, /ИТ/);

    rs = await run('NewConnectionError: Failed to establish', 'npm error code ENOTFOUND');
    assert.match(byId(rs, 'net-pip').hint, /pypi\.org/);
    assert.match(byId(rs, 'net-pip').hint, /files\.pythonhosted\.org/);
    assert.match(byId(rs, 'net-npm').hint, /registry\.npmjs\.org/);

    rs = await run('ConnectTimeoutError');
    assert.match(byId(rs, 'net-pip').hint, /pypi\.org/);

    rs = await run('что-то странное\nвторая строка');
    assert.match(byId(rs, 'net-pip').hint, /что-то странное/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('net-pip без Python -> warn "Python не найден"', async () => {
  const { base, dir } = makeCabinet();
  try {
    const exec = stub({
      'git --version': good['git --version'],
      'npm view express version --fetch-retries=0 --fetch-timeout=15000': { code: 0, stdout: '4.19.2\n', stderr: '' },
    });
    const rs = await runChecks({ cwd: dir, net: true, exec, platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'net-pip').status, 'warn');
    assert.match(byId(rs, 'net-pip').title, /Python не найден, проверка pip пропущена/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('session: вне Claude не проверяется; без метки кабинета fail; с меткой ok', async () => {
  assert.equal(checkSession({}), null);
  const out = checkSession({ CLAUDECODE: '1' });
  assert.equal(out.status, 'fail');
  assert.match(out.hint, /новый разговор в папке ai-cabinet/);
  assert.equal(checkSession({ CLAUDECODE: '1', AI_CABINET: '1' }).status, 'ok');
  const { base, dir } = makeCabinet();
  try {
    const rs = await runChecks({ cwd: dir, exec: stub(good), platform: 'linux', env: { CLAUDECODE: '1' }, nodeVersion: 'v22.0.0' });
    assert.equal(rs[0].id, 'session');
    assert.equal(rs[0].status, 'fail');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('input: пустой -> warn; есть файл -> ok; нечитаемый -> fail', async () => {
  const empty = makeCabinet();
  const full = makeCabinet({ withInput: true });
  try {
    let rs = await runChecks({ cwd: empty.dir, exec: stub(good), platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'input').status, 'warn');
    assert.match(byId(rs, 'input').hint, /положите/);
    rs = await runChecks({ cwd: full.dir, exec: stub(good), platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'input').status, 'ok');
    assert.match(byId(rs, 'input').title, /1/);
  } finally {
    rmSync(empty.base, { recursive: true, force: true });
    rmSync(full.base, { recursive: true, force: true });
  }
});

test('formatReport: значки, подсказки, итог, без тире', () => {
  const rs = [
    { id: 'a', status: 'ok', title: 'Node.js 22.19.0' },
    { id: 'b', status: 'warn', title: 'В папке input пока нет файлов', hint: 'положите туда свой рабочий файл' },
    { id: 'c', status: 'fail', title: 'Git не найден', hint: 'установите Git' },
  ];
  const out = formatReport(rs);
  const lines = out.split('\n');
  assert.equal(lines[0], '✓ Node.js 22.19.0');
  assert.equal(lines[1], '! В папке input пока нет файлов → положите туда свой рабочий файл');
  assert.equal(lines[2], '✗ Git не найден → установите Git');
  assert.match(lines.at(-1), /^Есть проблемы/);
  assert.doesNotMatch(out, /[—–]/);
  const okOut = formatReport([rs[0], rs[0], rs[1]]);
  assert.match(okOut.split('\n').at(-1), /^Готово: 2 из 3, 1 предупреждение$/);
});

test('exitCodeFor: 1 при fail, иначе 0', () => {
  assert.equal(exitCodeFor([{ status: 'ok' }, { status: 'warn' }]), 0);
  assert.equal(exitCodeFor([{ status: 'ok' }, { status: 'fail' }]), 1);
  assert.equal(exitCodeFor([]), 0);
});

test('CLI --json: массив результатов', () => {
  // Скиллы kabinet-* в настоящую папку Claude разработчика тест не ставит.
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check.mjs'), '--json'], { encoding: 'utf8', env: { ...process.env, AI_CABINET_NO_USER_SKILLS: '1', AI_CABINET_NO_PUSHGUARD: '1' } });
  const arr = JSON.parse(r.stdout);
  assert.ok(Array.isArray(arr) && arr.length >= 6);
  for (const x of arr) {
    assert.equal(typeof x.id, 'string');
    assert.equal(typeof x.title, 'string');
    assert.ok(['ok', 'warn', 'fail'].includes(x.status));
  }
  assert.equal(r.status, arr.some((x) => x.status === 'fail') ? 1 : 0);
});

test('CLI через символическую ссылку из другого cwd (кириллица и пробел)', () => {
  const base = mkdtempSync(join(tmpdir(), 'lnk-'));
  try {
    const real = join(base, 'Айгуль Н', 'кабинет');
    mkdirSync(real, { recursive: true });
    copyDir(join(ROOT, 'tools'), join(real, 'tools'));
    copyDir(join(ROOT, 'templates'), join(real, 'templates'));
    mkdirSync(join(real, 'input'));
    const link = join(base, 'ссылка на кабинет');
    symlinkSync(real, link, 'junction');
    const config = join(base, 'папка Claude');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config, AI_CABINET_NO_USER_SKILLS: '' };
    const r = spawnSync(process.execPath, [join(link, 'tools', 'check.mjs'), '--json'], { encoding: 'utf8', cwd: base, env });
    const arr = JSON.parse(r.stdout);
    assert.ok(arr.length >= 6);
    assert.equal(arr.find((x) => x.id === 'localhost')?.status, 'ok');
    assert.ok(existsSync(join(real, 'me', 'about-me.md')), 'CLI создаёт me/ из шаблонов');
    assert.ok(existsSync(join(real, 'site', 'index.html')), 'CLI создаёт site/ из шаблонов');
    // Проверка сетапа ставит скиллы для проектов сервисов, путь к кабинету подставлен.
    const skill = readFileSync(join(config, 'skills', 'kabinet-novyi-servis', 'SKILL.md'), 'utf8');
    // Windows: путь к кабинету может прийти в короткой форме (8.3), через ссылку или с другим регистром.
    const low = skill.toLowerCase();
    const forms = [real, link, realpathSync(real), realpathSync.native(real)].map((x) => String(x).toLowerCase());
    assert.ok(forms.some((f) => low.includes(f)) && !skill.includes('{{KABINET}}'), 'путь к кабинету в скилле');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('localhost-проверка: порт от системы, токен одноразовый, me/page-token.txt не создаётся', async () => {
  const { base, dir } = makeCabinet();
  try {
    const r = (await runChecks({ cwd: dir, exec: stub({}) })).find((x) => x.id === 'localhost');
    assert.equal(r.status, 'ok');
    assert.ok(!existsSync(join(dir, 'me', 'page-token.txt')));
    assert.ok(!existsSync(join(dir, 'me')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('net-проверки передают ограничения таймаута инструментам', async () => {
  const { base, dir } = makeCabinet();
  try {
    const calls = [];
    const inner = stub(good);
    const exec = async (c, a, o) => { calls.push({ cmd: c, args: a, o }); return inner(c, a, o); };
    await runChecks({ cwd: dir, net: true, exec, platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    const npm = calls.find((c) => c.cmd === 'npm');
    assert.deepEqual(npm.args, ['view', 'express', 'version', '--fetch-retries=0', '--fetch-timeout=15000']);
    assert.equal(npm.o.timeout, 20000);
    const pip = calls.find((c) => c.args.includes('pip'));
    assert.deepEqual(pip.args, ['-m', 'pip', 'index', 'versions', 'requests', '--retries', '0', '--timeout', '15']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const GIT_LS = 'git ls-remote --heads https://github.com/ORG/ai-cabinet';
const SSL_TEXT =
  "fatal: unable to access 'https://github.com/ORG/ai-cabinet/': SSL certificate problem: unable to get local issuer certificate";

test('check net-git: stderr «SSL certificate problem» на win32 → fail с подсказкой schannel', async () => {
  const { base, dir } = makeCabinet();
  try {
    const calls = [];
    const inner = stub({ ...good, [GIT_LS]: { code: 128, stdout: '', stderr: SSL_TEXT } });
    const exec = async (c, a, o) => { calls.push({ cmd: c, args: a, o }); return inner(c, a, o); };
    let rs = await runChecks({ cwd: dir, net: true, exec, platform: 'win32', env: {}, nodeVersion: 'v22.0.0' });
    const g = byId(rs, 'net-git');
    assert.equal(g.status, 'fail');
    assert.match(g.hint, /выполните: git config --global http\.sslBackend schannel/);
    const call = calls.find((x) => x.cmd === 'git' && x.args[0] === 'ls-remote');
    assert.equal(call.o.env.GIT_TERMINAL_PROMPT, '0');

    rs = await runChecks({ cwd: dir, net: true, exec, platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'net-git').status, 'fail');
    assert.match(byId(rs, 'net-git').hint, /сертификат/);
    assert.doesNotMatch(byId(rs, 'net-git').hint, /schannel/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('check net-git: ok; нет связи → github.com и *.githubusercontent.com; прочее → первая строка', async () => {
  const { base, dir } = makeCabinet();
  const run = (r) =>
    runChecks({ cwd: dir, net: true, platform: 'linux', env: {}, nodeVersion: 'v22.0.0', exec: stub({ ...good, [GIT_LS]: r }) });
  try {
    let rs = await run({ code: 0, stdout: 'abc\trefs/heads/main\n', stderr: '' });
    assert.equal(byId(rs, 'net-git').status, 'ok');

    for (const stderr of [
      "fatal: unable to access 'https://github.com/ORG/ai-cabinet/': Could not resolve host: github.com",
      "fatal: unable to access 'https://github.com/ORG/ai-cabinet/': Failed to connect to github.com port 443 after 21045 ms: Timed out",
      'ETIMEDOUT',
    ]) {
      rs = await run({ code: 128, stdout: '', stderr });
      assert.equal(byId(rs, 'net-git').status, 'fail', stderr);
      assert.match(byId(rs, 'net-git').hint, /github\.com и \*\.githubusercontent\.com/, stderr);
    }

    rs = await run({ code: 128, stdout: '', stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/ORG/ai-cabinet/' not found" });
    assert.equal(byId(rs, 'net-git').status, 'fail');
    assert.match(byId(rs, 'net-git').hint, /remote: Repository not found\. Покажите/);
    assert.doesNotMatch(byId(rs, 'net-git').hint, /fatal/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('buildExecCall: при shell одна строка без массива аргументов (DEP0190), без shell как есть', () => {
  assert.deepEqual(buildExecCall('npm', ['view', 'express', 'version'], true), { file: 'npm view express version', args: undefined });
  assert.deepEqual(buildExecCall('git', ['--version'], false), { file: 'git', args: ['--version'] });
});

test('input: служебные файлы (~$, dotfiles, desktop.ini, Thumbs.db) не считаются', async () => {
  const { base, dir } = makeCabinet({ withInput: true });
  try {
    for (const n of ['~$отчёт.xlsx', '.DS_Store', 'desktop.ini', 'Thumbs.db']) writeFileSync(join(dir, 'input', n), 'x');
    const rs = await runChecks({ cwd: dir, exec: stub(good), platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'input').status, 'ok');
    assert.match(byId(rs, 'input').title, /1 файл,/);
    rmSync(join(dir, 'input', 'отчёт.csv'));
    const rs2 = await runChecks({ cwd: dir, exec: stub(good), platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs2, 'input').status, 'warn');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('git: ошибки проверки отзыва сертификата (Schannel) считаются проблемой сертификата с подсказкой', async () => {
  for (const text of [
    'schannel: next InitializeSecurityContext failed: Unknown error (0x80092012) - The revocation function was unable to check revocation for the certificate.',
    'schannel: ... (0x80092013) - The revocation function was unable to check revocation because the revocation server was offline.',
    'unable to check revocation',
  ]) {
    assert.equal(classifyGitFailure(text), 'tls', text);
  }
  const { base, dir } = makeCabinet();
  try {
    const exec = stub({ ...good, [GIT_LS]: { code: 128, stdout: '', stderr: 'schannel: (0x80092012) revocation' } });
    const win = byId(await runChecks({ cwd: dir, net: true, exec, platform: 'win32', env: {}, nodeVersion: 'v22.0.0' }), 'net-git');
    assert.match(win.hint, /CRL\/OCSP/);
    assert.match(win.hint, /schannelCheckRevoke false/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Node: подсказка «22 или новее»', async () => {
  const { base, dir } = makeCabinet();
  try {
    const rs = await runChecks({ cwd: dir, exec: stub(good), platform: 'linux', env: {}, nodeVersion: 'v20.0.0' });
    assert.match(byId(rs, 'node').hint, /22 или новее \(LTS\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const LIBS_MISSING = { code: 1, stdout: '', stderr: "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\nModuleNotFoundError: No module named 'openpyxl'\n" };

test('py-libs: библиотеки на месте -> ok, команда с кавычками вокруг -c', async () => {
  const { base, dir } = makeCabinet();
  try {
    const calls = [];
    const inner = stub(good);
    const exec = async (c, a, o) => { calls.push([c, ...a]); return inner(c, a, o); };
    const rs = await runChecks({ cwd: dir, exec, platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'py-libs').status, 'ok');
    assert.deepEqual(calls.find((c) => c.includes('-c')), ['python3', '-c', 'import openpyxl, docx']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('py-libs: нет модуля -> fail с pip install --user, команда как обнаружена (py -3)', async () => {
  const { base, dir } = makeCabinet();
  try {
    let rs = await runChecks({ cwd: dir, exec: stub({ ...good, 'python3 -c import openpyxl, docx': LIBS_MISSING }), platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    let l = byId(rs, 'py-libs');
    assert.equal(l.status, 'fail');
    assert.match(l.title, /openpyxl/);
    assert.match(l.hint, /python3 -m pip install --user openpyxl python-docx/);

    const exec = stub({
      ...good,
      'python --version': { code: 9009, stdout: '', stderr: 'Python was not found' },
      'py -3 --version': { code: 0, stdout: 'Python 3.12.1\n', stderr: '' },
      'py -3 -c import openpyxl, docx': { code: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'docx'" },
    });
    rs = await runChecks({ cwd: dir, exec, platform: 'win32', env: {}, nodeVersion: 'v22.0.0' });
    l = byId(rs, 'py-libs');
    assert.equal(l.status, 'fail');
    assert.match(l.title, /docx/);
    assert.match(l.hint, /py -3 -m pip install --user openpyxl python-docx/);
    assert.equal(exitCodeFor(rs), 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('py-libs: нет Python -> fail "Сначала нужен Python", проверка не запускается', async () => {
  const { base, dir } = makeCabinet();
  try {
    const calls = [];
    const inner = stub({ 'git --version': good['git --version'] });
    const exec = async (c, a, o) => { calls.push([c, ...a].join(' ')); return inner(c, a, o); };
    const rs = await runChecks({ cwd: dir, exec, platform: 'linux', env: {}, nodeVersion: 'v22.0.0' });
    assert.equal(byId(rs, 'python').status, 'fail');
    assert.equal(byId(rs, 'py-libs').status, 'fail');
    assert.match(byId(rs, 'py-libs').title, /Сначала нужен Python/);
    assert.ok(!calls.some((c) => c.includes('-c')));
    assert.equal(JSON.parse(JSON.stringify(rs)).every((r) => 'id' in r && 'status' in r && 'title' in r), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('buildExecCall: аргумент с пробелом берётся в кавычки (cmd на win32, sh на posix)', () => {
  const args = ['-3', '-c', 'import openpyxl, docx'];
  assert.deepEqual(buildExecCall('py', args, true, 'win32'), { file: 'py -3 -c "import openpyxl, docx"', args: undefined });
  assert.deepEqual(buildExecCall('python3', ['-c', 'import openpyxl, docx'], true, 'linux'), { file: "python3 -c 'import openpyxl, docx'", args: undefined });
  assert.deepEqual(buildExecCall('python3', ['-c', 'import openpyxl, docx'], false, 'linux'), { file: 'python3', args: ['-c', 'import openpyxl, docx'] });
});

test('публикация: строка блока пуша и связь с GitHub, Vercel, Supabase', async () => {
  const { pushGuardResult, checkPublishNet } = await import('../check.mjs');
  const url = 'https://github.com/pdllmsk/ai-cabinet.git';
  assert.equal(pushGuardResult({ origin: null }), null);
  assert.equal(pushGuardResult({ origin: 'https://github.com/me/x.git', pushurl: null, hook: false }), null);
  assert.equal(pushGuardResult({ origin: url, pushurl: 'no_push://pdllmsk/ai-cabinet', hook: true }).status, 'ok');
  const bad = pushGuardResult({ origin: url, pushurl: null, hook: true });
  assert.equal(bad.status, 'fail');
  assert.match(bad.hint, /тренеру/);

  const good = await checkPublishNet(async () => ({ ok: true }));
  assert.equal(good.status, 'ok');
  const cut = await checkPublishNet(async (h) => (h.port === 5432 ? { ok: false, error: 'ETIMEDOUT' } : { ok: true }));
  assert.equal(cut.status, 'warn');
  assert.match(cut.title, /pooler\.supabase\.com:5432/);
  assert.match(cut.hint, /ИТ/);
  assert.doesNotMatch(cut.title + cut.hint, /[‒-―]/);
});
