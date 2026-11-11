// Обновление кабинета до последней версии курса. Файлы участника не трогает, неудачное обновление ничего не меняет.
// Запуск: node tools/update.mjs
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { ensureParticipantFiles } from './init.mjs';
import { classifyGitFailure, defaultExec, firstLine, gitEnv } from './check.mjs';

const SCHANNEL = ['-c', 'http.sslBackend=schannel'];
const NO_CHANGE = 'Файлы кабинета не изменены.';

const pad = (n) => String(n).padStart(2, '0');

// Папка для копий: output/backup-ГГГГ-ММ-ДД-ЧЧММ по местному времени; занята, значит -2, -3.
export function pickBackupDir(root, date = new Date()) {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const base = `output/backup-${stamp}`;
  for (let i = 1; ; i++) {
    const rel = i === 1 ? base : `${base}-${i}`;
    if (!existsSync(join(root, rel))) return rel;
  }
}

// «XY путь\0»; X это индекс, Y рабочая папка. X = 'A': файл добавлен самим участником, его нет в версии курса.
function parseStatus(out) {
  return out
    .split('\0')
    .filter(Boolean)
    .map((e) => ({ x: e[0], path: e.slice(3) }));
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// Причина из вывода git: первая строка «fatal:» или «error:». Сводку fetch («From …», «a..b main -> origin/main»)
// и подсказки «hint:» не показываем.
function gitReason(r) {
  const lines = `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const main = lines.find((l) => /^(fatal|error):/.test(l));
  return firstLine(main ?? lines.filter((l) => !/^(From |hint:)/.test(l) && !l.includes('->')).join('\n'));
}

// Пути, которые мешают слиянию: git перечисляет их строками с табуляцией.
function blockingPaths(r) {
  if (!/would be overwritten by merge/.test(r.stderr)) return [];
  return r.stderr.split('\n').filter((l) => l.startsWith('\t')).map((l) => l.trim()).filter(Boolean);
}

// Недостающие файлы участника из шаблонов и скиллы kabinet-* в папке скиллов Claude. init.mjs запускается
// отдельным процессом: он читает MANIFEST и шаблоны уже новой версии, а в памяти этого процесса осталась старая.
// Не вышло: создаём файлы старым MANIFEST (лучше, чем ничего), скиллы поставит следующая проверка сетапа.
// Возвращает { created: [...], skills: строка человеку или '' }.
async function createFromTemplates(root) {
  const r = await defaultExec(process.execPath, [join(root, 'tools', 'init.mjs'), '--report'], { cwd: root, shell: false, timeout: 30000 });
  if (r.code === 0) {
    try {
      const out = JSON.parse(r.stdout);
      if (Array.isArray(out?.created)) {
        const s = out.skills;
        const line = ['installed', 'updated', 'error'].includes(s?.status) && typeof s.message === 'string' ? s.message : '';
        return { created: out.created, skills: line };
      }
    } catch {
      // Вывод не JSON: ниже создаём сами.
    }
  }
  try {
    return { created: ensureParticipantFiles(root), skills: '' };
  } catch {
    // Не страшно: check.mjs и serve.mjs создадут недостающее при следующем запуске.
    return { created: [], skills: '' };
  }
}

export async function updateCabinet({
  root = fileURLToPath(new URL('..', import.meta.url)),
  exec = defaultExec,
  platform = process.platform,
} = {}) {
  let backedUp = [];
  const result = (status, lines) => ({ status, backedUp, message: lines.filter(Boolean).join('\n') });
  const fail = (text, tail = NO_CHANGE) => result('error', [`Не удалось обновить кабинет: ${text}`, tail]);
  const ask = (r) => `${gitReason(r)}. Покажите это сообщение тренеру.`;

  if (!existsSync(join(root, '.git'))) {
    return result('no-git', [
      'Этот кабинет установлен из архива, поэтому сам он не обновляется.',
      'Попросите у тренера новый архив кабинета и скопируйте его файлы в папку кабинета с заменой. Ваши файлы в папках me, input, output и site при этом останутся как есть.',
    ]);
  }

  const git = (args, timeout = 60000) => exec('git', args, { cwd: root, env: gitEnv(), shell: false, timeout });

  // 1. Забрать новую версию, ничего не меняя в папке. На Windows при подмене сертификата повтор через schannel.
  let fetch = await git(['fetch'], 120000);
  let viaSchannel = false;
  if (fetch.code !== 0 && platform === 'win32' && classifyGitFailure(fetch.stderr) === 'tls') {
    fetch = await git([...SCHANNEL, 'fetch'], 120000);
    viaSchannel = fetch.code === 0;
  }
  if (fetch.code !== 0) {
    if (/ENOENT/.test(fetch.stderr)) return fail('на компьютере не найдена программа Git. Позовите тренера или ИТ.');
    const kind = classifyGitFailure(fetch.stderr);
    if (kind === 'tls' && /0x80092012|0x80092013|revocation/i.test(fetch.stderr)) {
      return fail('Windows не может проверить отзыв сертификата GitHub. Передайте тренеру или ИТ: нужен доступ к серверам CRL/OCSP, либо выполните: git config --global http.schannelCheckRevoke false.');
    }
    if (kind === 'tls') {
      return fail('в сети компании, похоже, подменяют сертификаты, и Git им не доверяет. Покажите это сообщение тренеру или ИТ.');
    }
    if (kind === 'net') return fail('нет связи с GitHub. Попросите ИТ открыть адреса github.com и *.githubusercontent.com.');
    return fail(ask(fetch));
  }
  const schannelTip = viaSchannel
    ? 'Сеть компании подменяет сертификаты, поэтому обновление прошло через сертификаты Windows. Чтобы так было всегда, тренер или ИТ могут выполнить: git config --global http.sslBackend schannel'
    : '';
  const finish = async (status, lines) => {
    const { created, skills } = await createFromTemplates(root);
    return result(status, [...lines, created.length ? `Созданы из шаблонов: ${created.join(', ')}.` : '', skills, schannelTip]);
  };

  // 2. Нового нет: ничего не трогаем.
  const known = await git(['merge-base', '--is-ancestor', '@{u}', 'HEAD']);
  if (known.code === 0) return finish('up-to-date', ['Обновлений нет: у вас последняя версия кабинета.']);
  if (known.code !== 1) return fail(ask(known));

  // 3. Свои коммиты участника: перемотать нельзя, ничего не трогаем.
  const ff = await git(['merge-base', '--is-ancestor', 'HEAD', '@{u}']);
  if (ff.code === 1) return fail('в кабинете есть свои сохранённые версии, позовите тренера.');
  if (ff.code !== 0) return fail(ask(ff));

  // 4. Изменённые и удалённые файлы курса: копия в output/backup-*, затем версия из HEAD на место.
  const st = await git(['status', '--porcelain', '-z', '--untracked-files=no', '--no-renames']);
  if (st.code !== 0) return fail(ask(st));
  const changed = parseStatus(st.stdout).filter((e) => e.x !== 'A').map((e) => e.path);
  const deleted = [];
  let backupDir = null;
  for (const path of changed) {
    if (!isFile(join(root, path))) {
      deleted.push(path);
      continue;
    }
    backupDir ??= pickBackupDir(root);
    const dst = join(root, backupDir, path);
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(root, path), dst);
    } catch (e) {
      // Без копии файл не возвращаем: правка участника не должна пропасть.
      return fail(
        `не получилось сохранить копию файла ${path} (${e.code ?? e.message}).`,
        `${NO_CHANGE} Закройте этот файл в других программах и попробуйте снова или позовите тренера.`,
      );
    }
    backedUp.push(path);
  }

  // Откат шага 4, если дальше не вышло: файлы участника снова такие, как были до обновления.
  const rollback = () => {
    const stuck = [];
    for (const p of backedUp) {
      try {
        copyFileSync(join(root, backupDir, p), join(root, p));
      } catch {
        stuck.push(p);
      }
    }
    for (const p of deleted) {
      try {
        rmSync(join(root, p), { force: true });
      } catch {
        stuck.push(p);
      }
    }
    if (stuck.length) {
      return `Часть файлов вернуть как было не удалось: ${stuck.join(', ')}. Ваши правки лежат в папке ${backupDir}. Позовите тренера.`;
    }
    if (backupDir) rmSync(join(root, backupDir), { recursive: true, force: true });
    backedUp = [];
    return NO_CHANGE;
  };

  if (changed.length) {
    const co = await git(['checkout', 'HEAD', '--', ...changed]);
    if (co.code !== 0) return fail(ask(co), rollback());
  }

  // 5. Перемотка на новую версию.
  const merge = await git(['merge', '--ff-only', '@{u}'], 120000);
  if (merge.code !== 0) {
    const blocking = blockingPaths(merge);
    const reason = blocking.length
      ? `новая версия кабинета добавляет файлы, которые у вас уже есть: ${blocking.join(', ')}. Переименуйте или перенесите их и повторите «обнови кабинет».`
      : ask(merge);
    return fail(reason, rollback());
  }

  // 6. Готово.
  return finish('updated', [
    'Кабинет обновлён.',
    backedUp.length
      ? `Ваши правки в файлах курса сохранены в папке ${backupDir}: ${backedUp.join(', ')}. Сами эти файлы возвращены к версии курса.`
      : '',
  ]);
}

async function main() {
  try {
    const r = await updateCabinet();
    console.log(r.message);
    process.exitCode = r.status === 'updated' || r.status === 'up-to-date' ? 0 : 1;
  } catch (e) {
    console.log(`Не удалось обновить кабинет: ${e.code ?? e.message}. Покажите это сообщение тренеру.`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  main();
}
