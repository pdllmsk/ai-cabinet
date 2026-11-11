// Журнал кабинета: что запускалось и какие файлы использовались, основа контроля для ИТ.
// Строка JSON на событие в journal/ГГГГ-ММ.jsonl кабинета: { at, user, service, event, ok, ms, ... }.
// События: run («Запустить» у сервиса и процесса), api и upload (серверная часть сервиса), model (tools/llm.py,
// файл журнала ему передаёт переменная CABINET_JOURNAL). Содержимое файлов в журнал не попадает, только имена.
// Запись не мешает работе: не вышло записать, событие пропадает молча.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { userInfo } from 'node:os';

export const JOURNAL_DIR = 'journal';
const NAMES_MAX = 50;
const SNAPSHOT_MAX = 2000;
const SNAPSHOT_DEPTH = 3;

const pad = (n) => String(n).padStart(2, '0');

export function journalFile(root, date = new Date()) {
  return join(root, JOURNAL_DIR, `${date.getFullYear()}-${pad(date.getMonth() + 1)}.jsonl`);
}

function userName() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || '';
  }
}

export function appendJournal(root, event, date = new Date()) {
  try {
    mkdirSync(join(root, JOURNAL_DIR), { recursive: true });
    appendFileSync(journalFile(root, date), JSON.stringify({ at: date.toISOString(), user: userName(), ...event }) + '\n');
    return true;
  } catch {
    return false;
  }
}

// Имена файлов папки (путь от неё через «/»), без скрытых, временных файлов Office и ссылок. Нет папки: пусто.
export function folderSnapshot(dir) {
  const names = new Set();
  const walk = (abs, rel, depth) => {
    if (depth > SNAPSHOT_DEPTH || names.size >= SNAPSHOT_MAX) return;
    let entries = [];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (names.size >= SNAPSHOT_MAX || e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), name, depth + 1);
      else if (e.isFile()) names.add(name);
    }
  };
  walk(dir, '', 1);
  return names;
}

// Что появилось и пропало между снимками: { added, removed, total } (total: файлов после). Без перемен: только total.
export function snapshotDiff(before, after) {
  const added = [...after].filter((n) => !before.has(n)).sort();
  const removed = [...before].filter((n) => !after.has(n)).sort();
  const out = { total: after.size };
  if (added.length) out.added = added.slice(0, NAMES_MAX);
  if (removed.length) out.removed = removed.slice(0, NAMES_MAX);
  return out;
}

// Для страницы «Настройки»: сколько событий в журнале за месяц. Нет журнала: 0.
export function journalStats(root, date = new Date()) {
  const file = journalFile(root, date);
  let events = 0;
  try {
    events = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    events = 0;
  }
  return { folder: JOURNAL_DIR, file: `${JOURNAL_DIR}/${basename(file)}`, events };
}
