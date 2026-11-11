import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, USER_SKILL_RE, ensureParticipantFiles, installUserSkills, userSkillsDir } from '../init.mjs';
import { copyDir } from './copy-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Домашняя папка для CLI: скиллы kabinet-* ставятся сюда, а не в настоящую папку Claude разработчика.
function envWithHome(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.AI_CABINET_NO_USER_SKILLS;
  return env;
}

function makeCabinet() {
  const base = mkdtempSync(join(tmpdir(), 'init-'));
  const dir = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(dir, { recursive: true });
  copyDir(join(ROOT, 'templates'), join(dir, 'templates'));
  return { base, dir };
}

test('init: создаёт отсутствующие, не трогает существующие, повторный запуск ничего не создаёт', () => {
  const { base, dir } = makeCabinet();
  try {
    mkdirSync(join(dir, 'me'));
    writeFileSync(join(dir, 'me', 'rules.md'), 'мои правила участника');

    const created = ensureParticipantFiles(dir);
    assert.deepEqual(created.sort(), ['me/about-me.md', 'site/analiz.html', 'site/analiz.js', 'site/dark.css', 'site/index.html', 'site/nastroiki.html', 'site/prefs.js', 'site/render.js']);
    assert.equal(readFileSync(join(dir, 'me', 'rules.md'), 'utf8'), 'мои правила участника');
    for (const { from, to } of MANIFEST.filter((m) => m.to !== 'me/rules.md')) {
      assert.equal(readFileSync(join(dir, to), 'utf8'), readFileSync(join(dir, from), 'utf8'), to);
    }

    writeFileSync(join(dir, 'site', 'index.html'), '<p>моя страница</p>');
    assert.deepEqual(ensureParticipantFiles(dir), []);
    assert.equal(readFileSync(join(dir, 'site', 'index.html'), 'utf8'), '<p>моя страница</p>');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init: MANIFEST берёт шаблоны из templates и кладёт в me и site', () => {
  assert.deepEqual(MANIFEST, [
    { from: 'templates/about-me.md', to: 'me/about-me.md' },
    { from: 'templates/rules.md', to: 'me/rules.md' },
    { from: 'templates/site/index.html', to: 'site/index.html' },
    { from: 'templates/site/render.js', to: 'site/render.js' },
    { from: 'templates/site/analiz.html', to: 'site/analiz.html' },
    { from: 'templates/site/analiz.js', to: 'site/analiz.js' },
    { from: 'templates/site/nastroiki.html', to: 'site/nastroiki.html' },
    { from: 'templates/site/prefs.js', to: 'site/prefs.js' },
    { from: 'templates/site/dark.css', to: 'site/dark.css' },
  ]);
  for (const { from } of MANIFEST) assert.ok(existsSync(join(ROOT, from)), from);
});

test('init: CLI из пути с кириллицей и пробелом называет созданные файлы', () => {
  const { base, dir } = makeCabinet();
  try {
    copyDir(join(ROOT, 'tools'), join(dir, 'tools'));
    const run = () => spawnSync(process.execPath, [join(dir, 'tools', 'init.mjs')], { encoding: 'utf8', cwd: base, env: envWithHome(join(base, 'дом')) });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /me\/about-me\.md/);
    assert.ok(existsSync(join(dir, 'site', 'index.html')));
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /[А-Яа-я]/);
    assert.doesNotMatch(r.stdout, /about-me/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init: --json печатает список созданных файлов', () => {
  const { base, dir } = makeCabinet();
  try {
    copyDir(join(ROOT, 'tools'), join(dir, 'tools'));
    const run = () => spawnSync(process.execPath, [join(dir, 'tools', 'init.mjs'), '--json'], { encoding: 'utf8', cwd: base, env: envWithHome(join(base, 'дом')) });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).sort(), MANIFEST.map((m) => m.to).sort());
    r = run();
    assert.deepEqual(JSON.parse(r.stdout), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init: кабинет, поставленный до сервиса «Аналитика таблиц», получает его страницу, своя страница и render.js целы', () => {
  const { base, dir } = makeCabinet();
  try {
    mkdirSync(join(dir, 'me'), { recursive: true });
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, 'me', 'about-me.md'), 'обо мне');
    writeFileSync(join(dir, 'me', 'rules.md'), 'мои правила');
    writeFileSync(join(dir, 'site', 'index.html'), '<p>моя страница</p>');
    writeFileSync(join(dir, 'site', 'render.js'), '// мой render');
    assert.deepEqual(ensureParticipantFiles(dir).sort(), ['site/analiz.html', 'site/analiz.js', 'site/dark.css', 'site/nastroiki.html', 'site/prefs.js']);
    assert.equal(readFileSync(join(dir, 'site', 'index.html'), 'utf8'), '<p>моя страница</p>');
    assert.equal(readFileSync(join(dir, 'site', 'render.js'), 'utf8'), '// мой render');
    assert.equal(readFileSync(join(dir, 'site', 'analiz.html'), 'utf8'), readFileSync(join(ROOT, 'templates', 'site', 'analiz.html'), 'utf8'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Пользовательские скиллы: templates/user-skills/kabinet-* в папку скиллов Claude (~/.claude/skills).
const SKILLS = readdirSync(join(ROOT, 'templates', 'user-skills')).filter((n) => USER_SKILL_RE.test(n)).sort();

test('скиллы: в шаблонах курса kabinet-novyi-servis и kabinet-dobav-v-kabinet', () => {
  assert.deepEqual(SKILLS, ['kabinet-dobav-v-kabinet', 'kabinet-novyi-servis']);
});

test('скиллы: ставятся с путём к кабинету, повтор ничего не меняет, свои обновляются, чужие целы', () => {
  const { base, dir } = makeCabinet();
  const home = join(base, 'Айгуль Н дом');
  const env = {};
  try {
    // Чужой скилл человека и папка не из курса в шаблонах: их не трогаем и не ставим.
    const target = join(home, '.claude', 'skills');
    mkdirSync(join(target, 'moy-skill'), { recursive: true });
    writeFileSync(join(target, 'moy-skill', 'SKILL.md'), 'мой скилл');
    mkdirSync(join(dir, 'templates', 'user-skills', 'chuzhoy'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'user-skills', 'chuzhoy', 'SKILL.md'), 'не курса');

    let r = installUserSkills(dir, { env, home });
    assert.equal(r.status, 'installed');
    assert.equal(r.dir, target);
    assert.deepEqual(r.installed, SKILLS);
    assert.match(r.message, /^Скиллы «новый сервис» и «добавь в кабинет» поставлены/);
    for (const name of SKILLS) {
      const text = readFileSync(join(target, name, 'SKILL.md'), 'utf8');
      const tpl = readFileSync(join(ROOT, 'templates', 'user-skills', name, 'SKILL.md'), 'utf8');
      assert.ok(tpl.includes('{{KABINET}}'), `${name}: в шаблоне нет {{KABINET}}`);
      assert.equal(text, tpl.split('{{KABINET}}').join(dir.replace(/[\\/]+$/, '')));
    }
    assert.equal(readFileSync(join(target, 'moy-skill', 'SKILL.md'), 'utf8'), 'мой скилл');
    assert.ok(!existsSync(join(target, 'chuzhoy')));

    r = installUserSkills(dir, { env, home });
    assert.equal(r.status, 'same');
    assert.deepEqual([r.installed, r.updated], [[], []]);

    writeFileSync(join(target, SKILLS[0], 'SKILL.md'), 'старая версия');
    r = installUserSkills(dir, { env, home });
    assert.equal(r.status, 'updated');
    assert.deepEqual(r.updated, [SKILLS[0]]);
    assert.match(r.message, /обновлены/);
    assert.ok(readFileSync(join(target, SKILLS[0], 'SKILL.md'), 'utf8').includes(dir.replace(/[\\/]+$/, '')));
    assert.equal(readFileSync(join(target, 'moy-skill', 'SKILL.md'), 'utf8'), 'мой скилл');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('скиллы: CLAUDE_CONFIG_DIR, выключатель AI_CABINET_NO_USER_SKILLS, ошибка записи одной строкой', () => {
  const { base, dir } = makeCabinet();
  try {
    assert.equal(userSkillsDir({}, join(base, 'дом')), join(base, 'дом', '.claude', 'skills'));
    assert.equal(userSkillsDir({ CLAUDE_CONFIG_DIR: join(base, 'conf') }, join(base, 'дом')), join(base, 'conf', 'skills'));
    let r = installUserSkills(dir, { env: { AI_CABINET_NO_USER_SKILLS: '1' }, home: join(base, 'дом') });
    assert.equal(r.status, 'off');
    assert.equal(r.message, '');
    assert.ok(!existsSync(join(base, 'дом')));
    // Папка скиллов занята файлом: запись не выходит, причина одной строкой, без исключения.
    mkdirSync(join(base, 'дом2', '.claude'), { recursive: true });
    writeFileSync(join(base, 'дом2', '.claude', 'skills'), 'файл');
    r = installUserSkills(dir, { env: {}, home: join(base, 'дом2') });
    assert.equal(r.status, 'error');
    assert.match(r.message, /^Не удалось поставить скиллы .* Покажите это сообщение тренеру\.$/);
    assert.equal(r.message.split('\n').length, 1);
    // В кабинете нет templates/user-skills (старая версия шаблонов): ничего не делаем.
    rmSync(join(dir, 'templates', 'user-skills'), { recursive: true });
    r = installUserSkills(dir, { env: {}, home: join(base, 'дом3') });
    assert.equal(r.status, 'none');
    assert.ok(!existsSync(join(base, 'дом3')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('скиллы: CLI из пути с кириллицей ставит их во временную домашнюю папку (HOME, USERPROFILE) и пишет одну строку', () => {
  const { base, dir } = makeCabinet();
  const home = join(base, 'Айгуль Н');
  try {
    copyDir(join(ROOT, 'tools'), join(dir, 'tools'));
    const run = (...args) => spawnSync(process.execPath, [join(dir, 'tools', 'init.mjs'), ...args], { encoding: 'utf8', cwd: base, env: envWithHome(home) });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^Скиллы «новый сервис» и «добавь в кабинет» поставлены/);
    for (const name of SKILLS) assert.ok(existsSync(join(home, '.claude', 'skills', name, 'SKILL.md')), name);
    r = run();
    assert.match(r.stdout, /на месте/);
    // --report для update.mjs: созданные файлы и итог по скиллам.
    rmSync(join(home, '.claude', 'skills', SKILLS[1]), { recursive: true });
    r = run('--report');
    const rep = JSON.parse(r.stdout);
    assert.deepEqual(rep.created, []);
    assert.equal(rep.skills.status, 'installed');
    assert.deepEqual(rep.skills.installed, [SKILLS[1]]);
    // --json как раньше: только список созданных файлов (его читают прежние версии update.mjs).
    r = run('--json');
    assert.deepEqual(JSON.parse(r.stdout), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
