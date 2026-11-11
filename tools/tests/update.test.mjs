import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBackupDir, updateCabinet } from '../update.mjs';
import { ensureParticipantFiles } from '../init.mjs';
import { defaultExec } from '../check.mjs';
import { copyDir } from './copy-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Настройки git разработчика не влияют на тест: пустой глобальный конфиг только для этого процесса.
const CFG = mkdtempSync(join(tmpdir(), 'gitcfg-'));
writeFileSync(join(CFG, 'config'), '');
process.env.GIT_CONFIG_GLOBAL = join(CFG, 'config');
process.env.GIT_CONFIG_NOSYSTEM = '1';
after(() => rmSync(CFG, { recursive: true, force: true }));

// Обновление ставит скиллы kabinet-* в папку скиллов Claude (init.mjs --report): в тестах это временная домашняя
// папка, не настоящая папка разработчика.
const HOME = mkdtempSync(join(tmpdir(), 'home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.AI_CABINET_NO_USER_SKILLS;
after(() => rmSync(HOME, { recursive: true, force: true }));
const SKILLS_DIR = join(HOME, '.claude', 'skills');

const ID = ['-c', 'user.name=Тренер', '-c', 'user.email=trainer@example.com', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) =>
  execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const read = (...p) => readFileSync(join(...p), 'utf8');

// Мир обновления: репозиторий тренера (seed) публикует в bare upstream, участник клонирует его в «Айгуль Н».
function makeWorld() {
  const base = mkdtempSync(join(tmpdir(), 'upd-'));
  const home = join(base, 'Айгуль Н');
  const seed = join(home, 'seed');
  const upstream = join(home, 'upstream.git');
  const cabinet = join(home, 'ai-cabinet');
  mkdirSync(seed, { recursive: true });
  copyDir(join(ROOT, 'templates'), join(seed, 'templates'));
  copyDir(join(ROOT, 'tools'), join(seed, 'tools'));
  copyFileSync(join(ROOT, '.gitignore'), join(seed, '.gitignore'));
  writeFileSync(join(seed, 'CLAUDE.md'), '# Правила кабинета\nверсия 1\n');
  writeFileSync(join(seed, 'START.md'), '# Ваш кабинет\n');
  for (const d of ['input', 'output']) {
    mkdirSync(join(seed, d));
    writeFileSync(join(seed, d, '.gitkeep'), '');
  }
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'v1');
  git(home, 'clone', '-q', '--bare', seed, upstream);
  git(seed, 'remote', 'add', 'origin', upstream);
  git(home, 'clone', '-q', upstream, cabinet);
  ensureParticipantFiles(cabinet);
  const publish = (files) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(seed, f)), { recursive: true });
      writeFileSync(join(seed, f), text);
    }
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'next');
    git(seed, 'push', '-q', 'origin', 'main');
  };
  return { base, home, cabinet, publish };
}

const backups = (c) => readdirSync(join(c, 'output')).filter((n) => n.startsWith('backup-'));

test('update: правка CLAUDE.md участником уходит в output/backup-*, CLAUDE.md = upstream, me/ и input/ целы', async () => {
  const w = makeWorld();
  const c = w.cabinet;
  try {
    writeFileSync(join(c, 'me', 'about-me.md'), '# Обо мне\nэкономист\n');
    writeFileSync(join(c, 'input', 'отчёт продаж.csv'), 'a;b\n1;2\n');
    writeFileSync(join(c, 'site', 'index.html'), '<p>моя страница</p>');
    mkdirSync(join(c, '.claude', 'skills', 'moy-skill'), { recursive: true });
    writeFileSync(join(c, '.claude', 'skills', 'moy-skill', 'SKILL.md'), 'мой скилл');
    writeFileSync(join(c, 'CLAUDE.md'), '# Правила кабинета\nверсия 1\nправка участника\n');
    rmSync(join(c, 'START.md'));
    w.publish({ 'CLAUDE.md': '# Правила кабинета\nверсия 2\n' });

    const r = await updateCabinet({ root: c });
    assert.equal(r.status, 'updated', r.message);
    assert.deepEqual(r.backedUp, ['CLAUDE.md']);
    assert.equal(read(c, 'CLAUDE.md'), '# Правила кабинета\nверсия 2\n');
    assert.equal(read(c, 'START.md'), '# Ваш кабинет\n');

    const [b] = backups(c);
    assert.match(b, /^backup-\d{4}-\d{2}-\d{2}-\d{4}$/);
    assert.equal(read(c, 'output', b, 'CLAUDE.md'), '# Правила кабинета\nверсия 1\nправка участника\n');
    assert.ok(r.message.includes(`output/${b}`), r.message);

    assert.equal(read(c, 'me', 'about-me.md'), '# Обо мне\nэкономист\n');
    assert.equal(read(c, 'me', 'rules.md'), read(ROOT, 'templates', 'rules.md'));
    assert.equal(read(c, 'input', 'отчёт продаж.csv'), 'a;b\n1;2\n');
    assert.equal(read(c, 'site', 'index.html'), '<p>моя страница</p>');
    assert.equal(read(c, '.claude', 'skills', 'moy-skill', 'SKILL.md'), 'мой скилл');
    assert.equal(git(c, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.doesNotMatch(r.message, /[—–]/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('update: новая версия добавляет шаблон в MANIFEST → файл у участника появляется сразу, его файлы целы', async () => {
  const w = makeWorld();
  const c = w.cabinet;
  try {
    writeFileSync(join(c, 'me', 'about-me.md'), '# Обо мне\nэкономист\n');
    writeFileSync(join(c, 'site', 'index.html'), '<p>моя страница</p>');
    mkdirSync(join(c, 'processes', 'moy-process'), { recursive: true });
    writeFileSync(join(c, 'processes', 'moy-process', 'run.py'), 'print(1)\n');
    const init = read(ROOT, 'tools', 'init.mjs');
    const next = init.replace('export const MANIFEST = [', "export const MANIFEST = [\n  { from: 'templates/novyi.md', to: 'me/novyi.md' },");
    assert.notEqual(next, init);
    w.publish({ 'templates/novyi.md': '# Новый шаблон\n', 'tools/init.mjs': next });

    const r = await updateCabinet({ root: c });
    assert.equal(r.status, 'updated', r.message);
    assert.equal(read(c, 'me', 'novyi.md'), '# Новый шаблон\n');
    assert.match(r.message, /me\/novyi\.md/);
    assert.equal(read(c, 'me', 'about-me.md'), '# Обо мне\nэкономист\n');
    assert.equal(read(c, 'me', 'rules.md'), read(ROOT, 'templates', 'rules.md'));
    assert.equal(read(c, 'site', 'index.html'), '<p>моя страница</p>');
    assert.equal(read(c, 'processes', 'moy-process', 'run.py'), 'print(1)\n');
    assert.equal(git(c, 'status', '--porcelain', '--untracked-files=no'), '');
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('update: второй запуск → up-to-date; папка без .git → no-git', async () => {
  const w = makeWorld();
  try {
    let r = await updateCabinet({ root: w.cabinet });
    assert.equal(r.status, 'up-to-date', r.message);
    assert.deepEqual(r.backedUp, []);

    w.publish({ 'START.md': '# Ваш кабинет\nверсия 2\n' });
    rmSync(join(w.cabinet, 'me'), { recursive: true });
    r = await updateCabinet({ root: w.cabinet });
    assert.equal(r.status, 'updated', r.message);
    assert.ok(existsSync(join(w.cabinet, 'me', 'about-me.md')), 'me/ создаётся заново из шаблонов');

    r = await updateCabinet({ root: w.cabinet });
    assert.equal(r.status, 'up-to-date', r.message);
    assert.deepEqual(r.backedUp, []);
    assert.deepEqual(backups(w.cabinet), []);
    assert.match(r.message, /[А-Яа-я]/);

    const zip = join(w.home, 'из архива');
    mkdirSync(zip);
    r = await updateCabinet({ root: zip });
    assert.equal(r.status, 'no-git');
    assert.deepEqual(r.backedUp, []);
    assert.match(r.message, /архив/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('update: свои коммиты в кабинете → error «позовите тренера», ничего не меняется', async () => {
  const w = makeWorld();
  const c = w.cabinet;
  try {
    writeFileSync(join(c, 'START.md'), 'моя версия\n');
    git(c, 'commit', '-q', '-am', 'своё');
    const head = git(c, 'rev-parse', 'HEAD');
    writeFileSync(join(c, 'CLAUDE.md'), 'правка участника\n');
    w.publish({ 'CLAUDE.md': '# Правила кабинета\nверсия 2\n' });

    const r = await updateCabinet({ root: c });
    assert.equal(r.status, 'error');
    assert.match(r.message, /в кабинете есть свои сохранённые версии, позовите тренера/);
    assert.match(r.message, /не изменены/);
    assert.equal(git(c, 'rev-parse', 'HEAD'), head);
    assert.equal(read(c, 'START.md'), 'моя версия\n');
    assert.equal(read(c, 'CLAUDE.md'), 'правка участника\n');
    assert.deepEqual(r.backedUp, []);
    assert.deepEqual(backups(c), []);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('update: копию сделать нельзя → error, правка участника на месте, merge не запускается', { skip: process.platform === 'win32' && 'chmod на Windows не запрещает запись' }, async () => {
  const w = makeWorld();
  const c = w.cabinet;
  try {
    writeFileSync(join(c, 'CLAUDE.md'), 'правка участника\n');
    w.publish({ 'CLAUDE.md': 'версия 2\n' });
    chmodSync(join(c, 'output'), 0o500);
    const calls = [];
    const exec = async (cmd, args, o) => { calls.push(args.join(' ')); return defaultExec(cmd, args, o); };
    const r = await updateCabinet({ root: c, exec });
    assert.equal(r.status, 'error');
    assert.match(r.message, /CLAUDE\.md/);
    assert.match(r.message, /не изменены/);
    assert.equal(read(c, 'CLAUDE.md'), 'правка участника\n');
    assert.ok(!calls.some((x) => x.startsWith('checkout') || x.startsWith('merge ')), calls.join('\n'));
  } finally {
    chmodSync(join(c, 'output'), 0o700);
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('update: ошибка сертификата на Windows → повтор через schannel с подсказкой; на macOS без повтора', async () => {
  const w = makeWorld();
  try {
    w.publish({ 'CLAUDE.md': 'версия 2\n' });
    const SSL =
      "fatal: unable to access 'https://github.com/ORG/ai-cabinet/': SSL certificate problem: unable to get local issuer certificate";
    const calls = [];
    // Настоящий git, кроме обычного fetch: он «упирается» в прокси.
    const exec = async (cmd, args, o) => {
      calls.push(args.join(' '));
      assert.equal(o.env.GIT_TERMINAL_PROMPT, '0');
      if (args[0] === 'fetch') return { code: 128, stdout: '', stderr: SSL };
      return defaultExec(cmd, args, o);
    };

    let r = await updateCabinet({ root: w.cabinet, exec, platform: 'darwin' });
    assert.equal(r.status, 'error');
    assert.match(r.message, /сертификат/);
    assert.ok(!calls.some((x) => x.includes('schannel')), calls.join('\n'));

    calls.length = 0;
    r = await updateCabinet({ root: w.cabinet, exec, platform: 'win32' });
    assert.equal(r.status, 'updated', r.message);
    assert.ok(calls.includes('-c http.sslBackend=schannel fetch'), calls.join('\n'));
    assert.match(r.message, /git config --global http\.sslBackend schannel/);
    assert.equal(read(w.cabinet, 'CLAUDE.md'), 'версия 2\n');
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('update: новая версия добавляет файл, который у участника уже есть → error с путём, кабинет как был', async () => {
  const w = makeWorld();
  const c = w.cabinet;
  try {
    mkdirSync(join(c, '.claude', 'skills', 'x'), { recursive: true });
    writeFileSync(join(c, '.claude', 'skills', 'x', 'SKILL.md'), 'мой скилл\n');
    writeFileSync(join(c, 'CLAUDE.md'), 'правка участника\n');
    rmSync(join(c, 'START.md'));
    const head = git(c, 'rev-parse', 'HEAD');
    w.publish({ '.claude/skills/x/SKILL.md': 'скилл курса\n', 'CLAUDE.md': 'версия 2\n' });

    const r = await updateCabinet({ root: c });
    assert.equal(r.status, 'error');
    assert.match(r.message, /\.claude\/skills\/x\/SKILL\.md/);
    assert.match(r.message, /Переименуйте или перенесите/);
    assert.match(r.message, /не изменены/);
    assert.doesNotMatch(r.message, /From |->|возвращены к версии курса/);
    assert.equal(read(c, '.claude', 'skills', 'x', 'SKILL.md'), 'мой скилл\n');
    assert.equal(read(c, 'CLAUDE.md'), 'правка участника\n');
    assert.equal(existsSync(join(c, 'START.md')), false);
    assert.equal(git(c, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(r.backedUp, []);
    assert.deepEqual(backups(c), []);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('update: другая ошибка слияния → строка fatal без сводки fetch, правки на месте', async () => {
  const w = makeWorld();
  const c = w.cabinet;
  try {
    writeFileSync(join(c, 'CLAUDE.md'), 'правка участника\n');
    w.publish({ 'START.md': 'версия 2\n' });
    const stderr = 'From https://github.com/ORG/ai-cabinet\n   e003ff9..bbba3da  main       -> origin/main\nhint: что-то\nfatal: Not possible to fast-forward, aborting.\n';
    const exec = async (cmd, args, o) =>
      args[0] === 'merge' ? { code: 128, stdout: '', stderr } : defaultExec(cmd, args, o);
    const r = await updateCabinet({ root: c, exec });
    assert.equal(r.status, 'error');
    assert.match(r.message, /fatal: Not possible to fast-forward, aborting\. Покажите/);
    assert.doesNotMatch(r.message, /From |->|hint/);
    assert.equal(read(c, 'CLAUDE.md'), 'правка участника\n');
    assert.equal(read(c, 'START.md'), '# Ваш кабинет\n');
    assert.deepEqual(backups(c), []);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('update: папка копий по местному времени, при совпадении -2, -3', () => {
  const base = mkdtempSync(join(tmpdir(), 'bak-'));
  try {
    const d = new Date(2026, 9, 18, 9, 5);
    assert.equal(pickBackupDir(base, d), 'output/backup-2026-10-18-0905');
    mkdirSync(join(base, 'output', 'backup-2026-10-18-0905'), { recursive: true });
    assert.equal(pickBackupDir(base, d), 'output/backup-2026-10-18-0905-2');
    mkdirSync(join(base, 'output', 'backup-2026-10-18-0905-2'));
    assert.equal(pickBackupDir(base, d), 'output/backup-2026-10-18-0905-3');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('update: ошибка проверки отзыва сертификата (Schannel) → совет про CRL/OCSP и schannelCheckRevoke', async () => {
  const w = makeWorld();
  try {
    w.publish({ 'CLAUDE.md': 'версия 2\n' });
    const exec = async (cmd, args, o) =>
      args.includes('fetch')
        ? { code: 128, stdout: '', stderr: 'fatal: schannel: next InitializeSecurityContext failed: (0x80092012) revocation function was unable to check revocation' }
        : defaultExec(cmd, args, o);
    const r = await updateCabinet({ root: w.cabinet, exec, platform: 'win32' });
    assert.equal(r.status, 'error');
    assert.match(r.message, /CRL\/OCSP/);
    assert.match(r.message, /schannelCheckRevoke false/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('update: после обновления скиллы «новый сервис» и «добавь в кабинет» в папке Claude, строка об этом одна; чужой скилл цел', async () => {
  const w = makeWorld();
  try {
    rmSync(SKILLS_DIR, { recursive: true, force: true });
    mkdirSync(join(SKILLS_DIR, 'moy-skill'), { recursive: true });
    writeFileSync(join(SKILLS_DIR, 'moy-skill', 'SKILL.md'), 'мой скилл');
    w.publish({ 'START.md': '# Ваш кабинет\nверсия 2\n' });
    let r = await updateCabinet({ root: w.cabinet });
    assert.equal(r.status, 'updated', r.message);
    assert.equal(r.message.split('\n').filter((l) => l.includes('«новый сервис»')).length, 1, r.message);
    assert.match(r.message, /поставлены в папку Claude/);
    for (const name of ['kabinet-novyi-servis', 'kabinet-dobav-v-kabinet']) {
      const text = read(SKILLS_DIR, name, 'SKILL.md');
      assert.ok(text.includes(w.cabinet) && !text.includes('{{KABINET}}'), name);
    }
    assert.equal(read(SKILLS_DIR, 'moy-skill', 'SKILL.md'), 'мой скилл');
    // Ничего нового и скиллы на месте: лишней строки нет.
    r = await updateCabinet({ root: w.cabinet });
    assert.equal(r.status, 'up-to-date', r.message);
    assert.doesNotMatch(r.message, /новый сервис/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});
