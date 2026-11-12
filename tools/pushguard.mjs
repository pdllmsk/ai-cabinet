// Блок пуша в шаблон курса (pdllmsk/ai-cabinet): кабинет студента не публикуется, «обнови кабинет» работает.
// Два рубежа: pushurl у origin ведёт в несуществующий протокол no_push (git push падает сразу, fetch идёт по
// обычному адресу) и хук .git/hooks/pre-push с понятной фразой, если pushurl кто-то поменял.
// Вызывается из init.mjs (после «обнови кабинет»), serve.mjs и check.mjs. Повторный вызов ничего не меняет.
//
// Кабинет автора курса (откуда шаблон и пушат): git config ai-cabinet.author true, тогда блок не ставится.
// Тесты: AI_CABINET_NO_PUSHGUARD=1.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TEMPLATE_REPO_RE = /github\.com[:/]pdllmsk\/ai-cabinet(\.git)?\/?$/i;
export const NO_PUSH_URL = 'no_push://pdllmsk/ai-cabinet';
export const HOOK_MARK = '# ai-cabinet-pushguard';
export const HOOK_TEXT = 'Кабинет курса не публикуется. Сервис публикуйте фразой «опубликуй сервис» в его папке.';

const HOOK_BLOCK = `${HOOK_MARK}
case "$2" in
  *pdllmsk/ai-cabinet*|no_push*)
    echo "${HOOK_TEXT}" >&2
    exit 1;;
esac
`;

// git в папке кабинета без вопросов и окон. { code, stdout }.
function defaultExec(root, args) {
  try {
    const r = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    if (r.error) return { code: r.error.code === 'ENOENT' ? 127 : 1, stdout: '' };
    return { code: r.status ?? 1, stdout: r.stdout ?? '' };
  } catch {
    return { code: 1, stdout: '' };
  }
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const readOrNull = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const hookPath = (root) => join(root, '.git', 'hooks', 'pre-push');

// Новый текст хука: наш блок в начале, после первой строки «#!» (своего хука человека не теряем).
export function hookWithGuard(current) {
  if (current === null || current === undefined || !current.trim()) return `#!/bin/sh\n${HOOK_BLOCK}`;
  if (current.includes(HOOK_MARK)) return current;
  const nl = current.indexOf('\n');
  if (current.startsWith('#!')) {
    const first = nl === -1 ? current : current.slice(0, nl);
    const rest = nl === -1 ? '' : current.slice(nl + 1);
    return `${first}\n${HOOK_BLOCK}${rest}`;
  }
  return `#!/bin/sh\n${HOOK_BLOCK}${current}`;
}

const config = (root, exec, key) => {
  const r = exec(root, ['config', '--get', key]);
  return r.code === 0 ? r.stdout.trim() || null : null;
};

// Что стоит сейчас: { pushurl, hook, origin }.
export function pushGuardState(root, { exec = defaultExec } = {}) {
  if (!isDir(join(root, '.git'))) return { pushurl: null, hook: false, origin: null };
  const hook = readOrNull(hookPath(root));
  return {
    pushurl: config(root, exec, 'remote.origin.pushurl'),
    hook: Boolean(hook && hook.includes(HOOK_MARK)),
    origin: config(root, exec, 'remote.origin.url'),
  };
}

// { status: 'set' | 'ok' | 'nogit' | 'other' | 'error', message }.
// set: что-то поставили сейчас; ok: всё уже стояло; nogit: у кабинета нет своей папки .git (архив или рабочая
// копия разработчика); other: origin не шаблон курса или кабинет автора, ничего не трогаем.
export function ensurePushGuard(root, { exec = defaultExec, env = process.env } = {}) {
  // Тесты кабинета запускают check.mjs на самой папке шаблона: там блок не нужен.
  if (env.AI_CABINET_NO_PUSHGUARD === '1') return { status: 'other', message: 'Блок пуша выключен (AI_CABINET_NO_PUSHGUARD).' };
  if (!isDir(join(root, '.git'))) return { status: 'nogit', message: 'Кабинет без истории версий: публиковать его нечем.' };
  const origin = config(root, exec, 'remote.origin.url');
  if (!origin || !TEMPLATE_REPO_RE.test(origin)) return { status: 'other', message: 'Кабинет не из шаблона курса: блок пуша не нужен.' };
  if (config(root, exec, 'ai-cabinet.author') === 'true') return { status: 'other', message: 'Кабинет автора курса: блок пуша не ставится.' };
  let changed = false;
  try {
    if (config(root, exec, 'remote.origin.pushurl') !== NO_PUSH_URL) {
      const r = exec(root, ['config', 'remote.origin.pushurl', NO_PUSH_URL]);
      if (r.code !== 0) return { status: 'error', message: 'Не удалось закрыть публикацию кабинета: git не записал настройку. Покажите это тренеру.' };
      changed = true;
    }
    const file = hookPath(root);
    const cur = readOrNull(file);
    if (!cur || !cur.includes(HOOK_MARK)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, hookWithGuard(cur));
      changed = true;
    }
    try {
      if ((statSync(file).mode & 0o111) === 0) {
        chmodSync(file, 0o755);
        changed = true;
      }
    } catch {
      // Windows: права не важны, Git для Windows запускает хук и так
    }
  } catch (e) {
    return { status: 'error', message: `Не удалось закрыть публикацию кабинета (${e.code ?? e.message}). Покажите это тренеру.` };
  }
  return changed
    ? { status: 'set', message: 'Публикация кабинета закрыта: из кабинета ничего не уходит в шаблон курса.' }
    : { status: 'ok', message: 'Публикация кабинета закрыта.' };
}
