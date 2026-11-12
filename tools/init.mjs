// Файлы участника (me/, site/) создаются из шаблонов, если их ещё нет. Существующие не трогаем никогда.
// Новый файл в MANIFEST (как страница сервиса «Аналитика таблиц» site/analiz.html) появляется в уже поставленном
// кабинете при «обнови кабинет» (update.mjs запускает init) или при следующем запуске страницы (serve.mjs).
//
// Ещё init ставит пользовательские скиллы курса (templates/user-skills/kabinet-*) в папку скиллов Claude Code
// (~/.claude/skills, на Windows %USERPROFILE%\.claude\skills): они работают в любой папке, например в проекте
// сервиса («новый сервис», «добавь в кабинет»). Только папки с префиксом kabinet-: свои обновляем, чужие не
// трогаем. Скиллы, которые курс больше не ставит (RETIRED_USER_SKILLS), удаляем. В SKILL.md вместо {{KABINET}} подставляется путь к этому кабинету. Их же ставят update.mjs (после
// обновления) и check.mjs (проверка сетапа на первом занятии).
//
// После скиллов init обновляет проекты сервисов по новой версии кабинета (services.mjs upgradeAll: правила с
// «Уроками» человека, настройки, lib, git) и закрывает публикацию кабинета в шаблон курса (pushguard.mjs).
// Сбой здесь не меняет код выхода: файлы участника и скиллы важнее.
//
// Запуск: node tools/init.mjs [--json | --report]. Его же вызывают check.mjs, serve.mjs и update.mjs.
// --json: только список созданных файлов в JSON (его читали прежние версии update.mjs), скиллы ставятся молча.
// --report: {"created": [...], "skills": {...}, "services": {message, results}, "pushguard": {status, message}}
// в JSON (его читает update.mjs).
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const MANIFEST = [
  { from: 'templates/about-me.md', to: 'me/about-me.md' },
  { from: 'templates/rules.md', to: 'me/rules.md' },
  { from: 'templates/site/index.html', to: 'site/index.html' },
  { from: 'templates/site/render.js', to: 'site/render.js' },
  { from: 'templates/site/analiz.html', to: 'site/analiz.html' },
  { from: 'templates/site/analiz.js', to: 'site/analiz.js' },
  { from: 'templates/site/nastroiki.html', to: 'site/nastroiki.html' },
  { from: 'templates/site/prefs.js', to: 'site/prefs.js' },
  { from: 'templates/site/dark.css', to: 'site/dark.css' },
];

export function ensureParticipantFiles(root) {
  const created = [];
  for (const { from, to } of MANIFEST) {
    const src = join(root, from);
    const dst = join(root, to);
    if (existsSync(dst) || !existsSync(src)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    // COPYFILE_EXCL: даже при гонке файл участника не перезаписывается.
    copyFileSync(src, dst, constants.COPYFILE_EXCL);
    created.push(to);
  }
  return created;
}

export const USER_SKILLS_FROM = 'templates/user-skills';
export const USER_SKILL_RE = /^kabinet-[a-z0-9-]+$/;
// Скиллы, которые курс ставил раньше и больше не ставит: installUserSkills удаляет их из папки скиллов Claude.
// Только по точному списку имён: свои скиллы человека с похожим именем не трогаем.
export const RETIRED_USER_SKILLS = [
  'superpowers-brainstorming',
  'superpowers-dispatching-parallel-agents',
  'superpowers-executing-plans',
  'superpowers-finishing-a-development-branch',
  'superpowers-receiving-code-review',
  'superpowers-requesting-code-review',
  'superpowers-subagent-driven-development',
  'superpowers-systematic-debugging',
  'superpowers-test-driven-development',
  'superpowers-using-git-worktrees',
  'superpowers-using-superpowers',
  'superpowers-verification-before-completion',
  'superpowers-writing-plans',
  'superpowers-writing-skills',
];
const PLACEHOLDER = '{{KABINET}}';
const TEXT_EXT = /\.(md|txt|json)$/i;

// Папка пользовательских скиллов Claude Code: CLAUDE_CONFIG_DIR/skills, если задана, иначе ~/.claude/skills.
export function userSkillsDir(env = process.env, home = homedir()) {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'skills') : join(home, '.claude', 'skills');
}

// Файлы папки скилла: относительные пути, по файлам (системное копирование папок в Node 22 падает на кириллице
// в Windows).
function listFiles(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, e.name) : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

const readOrNull = (p) => {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
};

// Ставит или обновляет скиллы kabinet-* из templates/user-skills и удаляет RETIRED_USER_SKILLS. Возвращает
// { status: 'installed' | 'updated' | 'same' | 'none' | 'off' | 'error', dir, installed, updated, removed, error, message }.
// installed: скиллов не было, updated: были и изменились, same: всё уже как в кабинете.
export function installUserSkills(root, { env = process.env, home = homedir() } = {}) {
  const dir = userSkillsDir(env, home);
  const removed = [];
  const result = (status, extra = {}) => {
    const r = { status, dir, installed: [], updated: [], removed, error: null, ...extra };
    return { ...r, message: skillsMessage(r) };
  };
  if (env.AI_CABINET_NO_USER_SKILLS === '1') return result('off');
  for (const name of RETIRED_USER_SKILLS) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    try {
      rmSync(p, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Не удалилось (папка занята): удалим при следующей установке, ставить свои скиллы это не мешает.
    }
  }
  const src = join(root, USER_SKILLS_FROM);
  let names;
  try {
    names = readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isDirectory() && USER_SKILL_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return result('none');
  }
  if (!names.length) return result('none');
  const cabinet = root.replace(/[\\/]+$/, '');
  const installed = [];
  const updated = [];
  try {
    for (const name of names) {
      const had = existsSync(join(dir, name));
      let changed = false;
      for (const rel of listFiles(join(src, name))) {
        let data = readFileSync(join(src, name, rel));
        if (TEXT_EXT.test(rel)) data = Buffer.from(data.toString('utf8').split(PLACEHOLDER).join(cabinet), 'utf8');
        const dst = join(dir, name, rel);
        const old = readOrNull(dst);
        if (old && old.equals(data)) continue;
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, data);
        changed = true;
      }
      if (!had) installed.push(name);
      else if (changed) updated.push(name);
    }
  } catch (e) {
    return result('error', { installed, updated, error: e.code ?? e.message });
  }
  const status = installed.length ? 'installed' : updated.length ? 'updated' : 'same';
  return result(status, { installed, updated });
}

// Одна строка человеку.
export const SKILL_PHRASES = '«новый сервис», «добавь в кабинет», «подключи публикацию» и «опубликуй сервис»';

export function skillsMessage({ status, dir, error }) {
  const what = `Скиллы ${SKILL_PHRASES}`;
  if (status === 'installed') return `${what} поставлены в папку Claude: теперь они работают в любой папке.`;
  if (status === 'updated') return `${what} обновлены в папке Claude.`;
  if (status === 'same') return `${what} на месте.`;
  if (status === 'error') return `Не удалось поставить скиллы ${SKILL_PHRASES} в папку ${dir} (${error}). Покажите это сообщение тренеру.`;
  return '';
}

const why = (e) => String(e?.code ?? e?.message ?? e);

// Проекты сервисов по новой версии кабинета: { message, results }. Не бросает.
export async function upgradeServices(root) {
  try {
    const { upgradeAll } = await import('./services.mjs');
    const r = upgradeAll(root);
    return { message: r.message, results: r.results };
  } catch (e) {
    return { message: `Правила сервисов не обновлены (${why(e)}). Покажите это сообщение тренеру.`, results: [] };
  }
}

// Блок публикации кабинета в шаблон курса: { status, message }. Не бросает.
export async function guardPush(root) {
  try {
    const { ensurePushGuard } = await import('./pushguard.mjs');
    const r = ensurePushGuard(root);
    return { status: r.status, message: r.message };
  } catch (e) {
    return { status: 'error', message: `Не удалось закрыть публикацию кабинета (${why(e)}). Покажите это сообщение тренеру.` };
  }
}

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const created = ensureParticipantFiles(root);
  const skills = installUserSkills(root);
  const services = await upgradeServices(root);
  const pushguard = await guardPush(root);
  if (process.argv.includes('--report')) return console.log(JSON.stringify({ created, skills, services, pushguard }));
  if (process.argv.includes('--json')) return console.log(JSON.stringify(created));
  console.log(created.length ? `Созданы файлы: ${created.join(', ')}` : 'Все файлы участника на месте, ничего не создано.');
  if (skills.message) console.log(skills.message);
  if (services.message) console.log(services.message);
  if (pushguard.status === 'set' || pushguard.status === 'error') console.log(pushguard.message);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(`Не удалось подготовить кабинет (${why(e)}). Покажите это сообщение тренеру.`);
    process.exitCode = 1;
  });
}
