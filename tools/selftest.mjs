// Самопроверка кабинета на этом компьютере: весь путь участника без Claude и без модели, на копии кабинета во
// временной папке (в пути кириллица и пробел, как в профиле «Айгуль Н»). Кабинет человека не меняется, скиллы
// Claude ставятся во временную папку, страница поднимается на свободном порту и останавливается в конце.
//
//   node tools/selftest.mjs            по строке на проверку (✓, ✗ с подсказкой, ! предупреждение) и итог
//   node tools/selftest.mjs --json     то же в JSON
//   node tools/selftest.mjs --keep     временную папку не удалять (показать тренеру)
//
// Что проверяется: среда (Node, git, Python, библиотеки), установка (init, скиллы), демо «Аналитики таблиц»
// и «Светофора точек продаж», сервис-проект (new, add, run, list) и что из него уходит в git (данные и .env нет),
// проверка данных перед моделью (tools/llm.py), страница: файлы, API процессов, сервисов, настроек и аналитики
// (паспорт, история, загрузка и удаление файла), кнопки «Запустить», скачивание результата, защита токеном.
// Коды выхода: 0 всё работает (предупреждения не мешают), 1 есть ошибки.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { findPython } from './processes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_TOP = new Set(['.git', 'node_modules', 'me', 'output', 'site', 'processes', '.superpowers']);
const STEP_MS = 6 * 60 * 1000;
const results = [];

function add(status, title, detail = '') {
  results.push({ status, title, detail });
}
const ok = (title, detail) => add('ok', title, detail);
const fail = (title, detail) => add('fail', title, detail);
const warn = (title, detail) => add('warn', title, detail);

function run(cmd, args, { cwd, env, timeout = STEP_MS, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, timeout, input, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { code: r.status, out, error: r.error };
}

const lastLine = (text) => String(text).trim().split(/\r?\n/).filter(Boolean).pop() ?? '';

// Файлы кабинета для копии: из git (как у участника после «поставь кабинет»), без git обход папки.
// Папки человека (me, input кроме учебного кейса, output, site, processes) не копируются.
function cabinetFiles(root) {
  const g = run('git', ['-C', root, 'ls-files', '-z'], { timeout: 30000 });
  if (g.code === 0 && g.out.includes('\0')) {
    return g.out.split('\0').filter(Boolean).filter((f) => !SKIP_TOP.has(f.split('/')[0]) && (!f.startsWith('input/') || f.startsWith('input/case/') || f === 'input/.gitkeep'));
  }
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && SKIP_TOP.has(e.name)) continue;
      if (r === 'input' || (r.startsWith('input/') && !r.startsWith('input/case'))) {
        if (e.isDirectory() && r === 'input') walk(r);
        continue;
      }
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out;
}

// Копия по файлам: системное копирование папок в Node 22 падает на кириллице в Windows.
function copyCabinet(root, files, dest) {
  for (const f of files) {
    const to = join(dest, ...f.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(root, ...f.split('/')), to);
  }
  mkdirSync(join(dest, 'input'), { recursive: true });
  mkdirSync(join(dest, 'output'), { recursive: true });
}

function findFile(dir, name) {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    }
  }
  return null;
}

const samePath = (a, b) => {
  const n = (p) => {
    let r = resolve(p);
    try {
      r = realpathSync.native(r);
    } catch {
      // нет пути: сравниваем как есть
    }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
};

// ---------- страница ----------

function startPage(cab, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(cab, 'tools', 'serve.mjs')], { cwd: cab, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const timer = setTimeout(() => done({ child, url: null, text }), 30000);
    const onData = (c) => {
      text += c.toString('utf8');
      const m = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\//.exec(text);
      if (m) {
        clearTimeout(timer);
        done({ child, url: m[0], text });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => {
      clearTimeout(timer);
      done({ child: null, url: null, text });
    });
  });
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done) => {
    const req = http.request(url, { method, headers, agent: false, timeout: 60000 }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch {
          json = null;
        }
        done({ status: r.statusCode, text: buf.toString('utf8'), json, size: buf.length });
      });
    });
    req.on('timeout', () => req.destroy(new Error('нет ответа 60 секунд')));
    req.on('error', (e) => done({ status: 0, text: e.message, json: null, size: 0 }));
    req.end(body);
  });
}

const PAGE = { 'X-Cabinet': '1' };
const JSON_POST = { 'X-Cabinet': '1', 'Content-Type': 'application/json' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Запуск кнопкой: POST, затем опрос статуса до конца расчёта (не дольше 3 минут).
async function runAndWait(start, status) {
  const r = await start();
  if (r.status !== 202) return { ok: false, detail: `ответ ${r.status}: ${r.json?.error ?? r.text.slice(0, 200)}` };
  for (let i = 0; i < 180; i++) {
    await wait(1000);
    const s = await status();
    if (s.status === 200 && s.json && !s.json.running) {
      const last = s.json.lastRun ?? s.json.last_run ?? null;
      const good = !last || last.ok !== false;
      return { ok: good, detail: good ? '' : `расчёт не удался: ${JSON.stringify(last).slice(0, 300)}` };
    }
  }
  return { ok: false, detail: 'расчёт не закончился за 3 минуты' };
}

// Серверная часть своей страницы сервиса: как её пишет Claude по правилам проекта сервиса.
const SELFTEST_API = `import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from service_api import serve, save_upload, remove_file


def upload(data, file):
    return {"file": save_upload(file)}


def delete(data, file):
    remove_file(data.get("name", ""))
    return {"ok": True}


serve({"upload": upload, "delete": delete})
`;

function readJournal(cab) {
  const dir = join(cab, 'journal');
  if (!existsSync(dir)) return [];
  const lines = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
      try {
        if (l.trim()) lines.push(JSON.parse(l));
      } catch {
        // строка повреждена: пропускаем
      }
    }
  }
  return lines;
}

async function pageChecks(cab, url, slugService, proj) {
  const base = new URL(url);
  const at = (p) => new URL(p, base).toString();
  const root = `${base.protocol}//${base.host}/`;

  const home = await request(url);
  if (home.status === 200 && home.text.includes('data-cabinet="ok"')) ok('Страница кабинета открывается');
  else fail('Страница кабинета не открывается', `ответ ${home.status}`);
  const noToken = await request(root);
  if (noToken.status !== 200) ok('Без секретной части адреса страница закрыта');
  else fail('Страница открывается без секретной части адреса', 'покажите тренеру');

  const files = ['analiz.html', 'nastroiki.html', 'render.js', 'analiz.js', 'prefs.js', 'dark.css'];
  const missing = [];
  for (const f of files) if ((await request(at(f))).status !== 200) missing.push(f);
  if (!missing.length) ok('Страницы «Аналитика таблиц», «Настройки» и тёмная тема на месте');
  else fail('Не отдаются файлы страницы', missing.join(', '));

  const procs = await request(at('api/processes'));
  const svet = Array.isArray(procs.json) ? procs.json.find((p) => p.slug === 'svetofor-tochek') : null;
  if (svet && svet.result) ok('Карточка «Светофор точек продаж» с результатом', svet.result.summary ?? '');
  else fail('Нет карточки «Светофор точек продаж»', `ответ ${procs.status}`);

  const svc = await request(at('api/services'));
  const list = Array.isArray(svc.json) ? svc.json : svc.json?.services ?? [];
  const mine = list.find((s) => s.slug === slugService);
  if (mine && mine.result && !mine.error) ok('Карточка своего сервиса-проекта с результатом');
  else fail('Нет карточки своего сервиса', mine?.error ?? `ответ ${svc.status}`);

  const cabInfo = await request(at('api/cabinet'), { headers: PAGE });
  if (cabInfo.status === 200 && cabInfo.json && samePath(cabInfo.json.root, cab)) ok('«Настройки»: папки кабинета', cabInfo.json.root);
  else fail('«Настройки» не показывают папку кабинета', `ответ ${cabInfo.status}`);
  const checks = await request(at('api/cabinet/checks'), { headers: PAGE });
  const py = checks.json?.checks?.find((c) => c.id === 'python');
  if (py?.ok) ok('«Настройки»: проверка Python зелёная', py.detail);
  else fail('«Настройки»: Python красный', py?.detail ?? `ответ ${checks.status}`);
  const claude = checks.json?.checks?.find((c) => c.id === 'claude');
  if (claude?.ok) ok('Claude для сервисов найден (вопросы со страницы «Аналитика таблиц»)');
  else warn('Claude для сервисов не найден', 'вопросы к таблицам тогда задаются во вкладке Code; страница это подскажет');

  const pass = await request(at('api/analiz/passport'), { headers: PAGE });
  const pfiles = pass.json?.passport?.files ?? [];
  if (pass.status === 200 && pfiles.length) ok('«Аналитика таблиц»: описание данных', `файлов: ${pfiles.length}`);
  else fail('«Аналитика таблиц»: описание данных не читается', pass.json?.error ?? `ответ ${pass.status}`);
  const hist = await request(at('api/analiz/history'), { headers: PAGE });
  if (hist.status === 200 && (hist.json?.items ?? []).length) ok('«Аналитика таблиц»: готовый ответ в истории');
  else fail('«Аналитика таблиц»: истории ответов нет', hist.json?.error ?? `ответ ${hist.status}`);

  const name = 'Проверка загрузки (1).csv';
  const up = await request(at('api/analiz/upload'), {
    method: 'POST',
    headers: { 'X-Cabinet': '1', 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
    body: Buffer.from('﻿Точка;Сумма\nМега 1;10\nМега 2;20\n', 'utf8'),
  });
  const saved = up.json?.file;
  if (up.status === 200 && saved && existsSync(join(cab, 'input', 'analiz', saved))) ok('Загрузка файла со страницы', saved);
  else fail('Загрузка файла со страницы не работает', up.json?.error ?? `ответ ${up.status}`);
  if (saved) {
    const del = await request(at('api/analiz/delete'), { method: 'POST', headers: JSON_POST, body: JSON.stringify({ file: saved }) });
    if (del.status === 200 && !existsSync(join(cab, 'input', 'analiz', saved))) ok('Корзина: файл удаляется со страницы');
    else fail('Корзина не удаляет файл', del.json?.error ?? `ответ ${del.status}`);
  }

  const p = await runAndWait(
    () => request(at('api/run/svetofor-tochek'), { method: 'POST', headers: JSON_POST, body: '{}' }),
    () => request(at('api/status/svetofor-tochek')),
  );
  if (p.ok) ok('Кнопка «Запустить» у процесса');
  else fail('Кнопка «Запустить» у процесса не сработала', p.detail);
  const s = await runAndWait(
    () => request(at('api/services/run'), { method: 'POST', headers: JSON_POST, body: JSON.stringify({ slug: slugService }) }),
    () => request(at(`api/services/status/${encodeURIComponent(slugService)}`)),
  );
  if (s.ok) ok('Кнопка «Запустить» у сервиса-проекта');
  else fail('Кнопка «Запустить» у сервиса-проекта не сработала', s.detail);

  const xl = await request(at('output/svetofor-tochek/svetofor.xlsx'));
  if (xl.status === 200 && xl.size > 1000) ok('Скачивание результата (svetofor.xlsx)');
  else fail('Результат не скачивается', `ответ ${xl.status}`);

  // Своя страница сервиса и её серверная часть: загрузка и удаление файла кодом самого сервиса.
  if (slugService && proj) {
    const sp = await request(at(`s/${encodeURIComponent(slugService)}/page/`));
    if (sp.status === 200 && sp.text.includes('Проверка своей страницы')) ok('Своя страница сервиса открывается в кабинете');
    else fail('Своя страница сервиса не открывается', `ответ ${sp.status}`);
    const fname = 'Проверка действия (1).csv';
    const u = await request(at(`s/${encodeURIComponent(slugService)}/api/upload`), {
      method: 'POST',
      headers: { 'X-Cabinet': '1', 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fname) },
      body: Buffer.from('Точка;Сумма\nМега 1;10\n', 'utf8'),
    });
    const got = u.json?.file;
    if (u.status === 200 && got && existsSync(join(proj, 'input', got))) ok('Серверная часть сервиса: загрузка файла со своей страницы', got);
    else fail('Серверная часть сервиса не принимает файл', u.json?.error ?? `ответ ${u.status}`);
    if (got) {
      const d = await request(at(`s/${encodeURIComponent(slugService)}/api/delete`), { method: 'POST', headers: JSON_POST, body: JSON.stringify({ name: got }) });
      if (d.status === 200 && !existsSync(join(proj, 'input', got))) ok('Серверная часть сервиса: удаление файла');
      else fail('Серверная часть сервиса не удаляет файл', d.json?.error ?? `ответ ${d.status}`);
    }
    const j = readJournal(cab);
    const has = (e) => j.some((l) => l.event === e && l.service === slugService);
    if (has('run') && has('upload') && has('api')) ok('Журнал кабинета: запуск, загрузка и действие записаны', `событий: ${j.length}`);
    else fail('Журнал кабинета неполный', `событий: ${j.length}, ${[...new Set(j.map((l) => l.event))].join(', ')}`);
  }
}

// ---------- основное ----------

export async function selftest({ keep = false } = {}) {
  results.length = 0;
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node}: нужен 22 или новее`, 'попросите ИТ обновить Node.js');
  const git = run('git', ['--version'], { timeout: 20000 });
  if (git.code === 0) ok(lastLine(git.out));
  else fail('Git не найден', 'без него кабинет не обновляется и сервисы не уходят в репозиторий');

  const work = mkdtempSync(join(tmpdir(), 'kabinet-selftest-'));
  const docs = join(work, 'Проверка кабинета', 'Документы');
  const cab = join(docs, 'ai-cabinet');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(work, 'claude-config'), PYTHONIOENCODING: 'utf-8', NoDefaultCurrentDirectoryInExePath: '1' };
  let page = null;
  try {
    const files = cabinetFiles(ROOT);
    copyCabinet(ROOT, files, cab);
    ok('Копия кабинета во временной папке', `${files.length} файлов, ${cab}`);

    const py = await findPython(cab).catch(() => null);
    if (py) ok('Python найден', py);
    else {
      fail('Python не найден', 'скажите Claude «проверь сетап» или позовите тренера');
      return finish(work, keep);
    }
    const libs = run(py, ['-c', 'import openpyxl, docx; print("ok")'], { env, timeout: 60000 });
    if (libs.code === 0) ok('Библиотеки Python для Excel и Word');
    else fail('Нет библиотек openpyxl или python-docx', 'скажите Claude «проверь сетап»: он поставит их');

    const node = process.execPath;
    const init = run(node, [join(cab, 'tools', 'init.mjs'), '--report'], { cwd: cab, env });
    let report = null;
    try {
      report = JSON.parse(init.out);
    } catch {
      report = null;
    }
    const need = ['site/index.html', 'site/analiz.html', 'site/nastroiki.html', 'site/prefs.js', 'site/dark.css'];
    if (init.code === 0 && need.every((f) => existsSync(join(cab, ...f.split('/'))))) ok('Установка: страницы кабинета созданы');
    else fail('Установка не создала страницы', lastLine(init.out));
    const skills = report?.skills;
    if (skills && !skills.error && existsSync(join(env.CLAUDE_CONFIG_DIR, 'skills', 'kabinet-novyi-servis', 'SKILL.md'))) ok('Скиллы «новый сервис» и «добавь в кабинет» ставятся');
    else fail('Скиллы «новый сервис» и «добавь в кабинет» не ставятся', skills?.error ?? lastLine(init.out));

    const demo = run(py, [join(cab, 'tools', 'analiz.py'), 'demo'], { cwd: cab, env });
    if (demo.code === 0 && existsSync(join(cab, 'output', 'analiz', 'history.json'))) ok('«Покажи пример сервиса»: готовый ответ «Аналитики таблиц»', lastLine(demo.out));
    else fail('Пример «Аналитики таблиц» не считается', lastLine(demo.out));

    const svet = run(node, [join(cab, 'tools', 'processes.mjs'), 'demo', 'svetofor-tochek'], { cwd: cab, env });
    if (svet.code === 0 && existsSync(join(cab, 'output', 'svetofor-tochek', 'result.json'))) ok('Демо «Светофор точек продаж» считается');
    else fail('Демо «Светофор точек продаж» не считается', lastLine(svet.out));

    // Сервис-проект: как «новый сервис» и «добавь в кабинет» у участника.
    const home = join(docs, 'Сервисы');
    const made = run(node, [join(cab, 'tools', 'services.mjs'), 'new', 'Проверка сервиса', '--dir', home], { cwd: cab, env });
    const dirs = existsSync(home) ? readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
    const proj = dirs.length ? join(home, dirs[0].name) : null;
    if (made.code === 0 && proj && existsSync(join(proj, 'service.json'))) ok('«Новый сервис»: проект создан рядом с кабинетом', relative(docs, proj));
    else fail('«Новый сервис» не создал проект', lastLine(made.out));
    let slug = null;
    if (proj) {
      const sales = findFile(join(cab, 'input', 'case'), 'prodazhi_1c.csv');
      if (sales) copyFileSync(sales, join(proj, 'input', 'prodazhi_1c.csv'));
      writeFileSync(join(proj, '.env'), 'PROVERKA_KEY=ne-sekret\n');
      // Своя страница и серверная часть, как их делает Claude по правилам проекта сервиса.
      mkdirSync(join(proj, 'page'), { recursive: true });
      writeFileSync(join(proj, 'page', 'index.html'), '<!doctype html><meta charset="utf-8"><h1>Проверка своей страницы</h1>');
      writeFileSync(join(proj, 'api.py'), SELFTEST_API);
      const sj = JSON.parse(readFileSync(join(proj, 'service.json'), 'utf8'));
      writeFileSync(join(proj, 'service.json'), JSON.stringify({ ...sj, kind: 'page', page: 'page/', api: 'api.py' }, null, 2));
      const addR = run(node, [join(cab, 'tools', 'services.mjs'), 'add', proj], { cwd: cab, env });
      const m = /Имя в кабинете: ([a-z0-9-]+)/.exec(addR.out);
      slug = m ? m[1] : null;
      if (addR.code === 0 && slug) ok('«Добавь в кабинет»: сервис записан в кабинет', slug);
      else fail('«Добавь в кабинет» не сработал', lastLine(addR.out));
      if (slug) {
        const runR = run(node, [join(cab, 'tools', 'services.mjs'), 'run', slug], { cwd: cab, env });
        if (runR.code === 0 && existsSync(join(proj, 'output', 'result.json'))) ok('Сервис-проект запускается', lastLine(runR.out));
        else fail('Сервис-проект не запускается', lastLine(runR.out));
      }
      // Что уйдёт в репозиторий из проекта: данные из input, результаты и .env не должны.
      const st = run('git', ['-C', proj, 'status', '--porcelain', '--untracked-files=all'], { env, timeout: 30000 });
      if (st.code !== 0) warn('В проекте сервиса нет git', lastLine(st.out));
      else {
        const paths = st.out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
        const leaks = paths.filter((p) => /^input\/(?!\.gitkeep)|^output\/(?!\.gitkeep)|(^|\/)\.env/.test(p));
        if (!leaks.length) ok('В git проекта не попадают данные, результаты и .env', `к отправке: ${paths.length} файлов кода`);
        else fail('В git проекта попадут данные или ключи', leaks.join(', '));
      }
    }

    // Проверка данных перед моделью: персональные данные не пропускаются.
    const bad = join(work, 'pd.txt');
    writeFileSync(bad, 'Тестов Тест Тестович, ИИН 900101300123, +7 701 123 45 67, test@example.com\n');
    const good = join(work, 'clean.txt');
    writeFileSync(good, 'Столбцы: Точка (текст), Сумма (число). Итог: 18 847 700 тг.\n');
    const cb = run(py, [join(cab, 'tools', 'llm.py'), 'check', bad], { cwd: cab, env, timeout: 60000 });
    const cg = run(py, [join(cab, 'tools', 'llm.py'), 'check', good], { cwd: cab, env, timeout: 60000 });
    if (cb.code === 1 && cg.code === 0) ok('Проверка перед моделью: персональные данные не пропускает, описание пропускает');
    else fail('Проверка перед моделью работает не так', `с ПД: код ${cb.code}, без ПД: код ${cg.code}. ${lastLine(cb.out)}`);

    page = await startPage(cab, env);
    if (!page.url) fail('Страница не запустилась', lastLine(page.text));
    else {
      ok('Страница запускается', page.url.replace(/[0-9a-f]{32}/, '…'));
      await pageChecks(cab, page.url, slug, proj);
    }
  } catch (e) {
    fail('Проверка прервалась', e.stack ?? String(e));
  } finally {
    if (page?.child) page.child.kill();
  }
  return finish(work, keep);
}

function finish(work, keep) {
  if (!keep) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // временная папка удалится системой
    }
  }
  return { results: results.slice(), work: keep ? work : null };
}

async function main() {
  const args = process.argv.slice(2);
  process.env.NoDefaultCurrentDirectoryInExePath = '1';
  if (!args.includes('--json')) console.log('Проверка кабинета на этом компьютере: копия во временной папке, ваш кабинет не меняется. Обычно 1-3 минуты.\n');
  const { results: res, work } = await selftest({ keep: args.includes('--keep') });
  const bad = res.filter((r) => r.status === 'fail');
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok: !bad.length, results: res, work }, null, 1));
  } else {
    for (const r of res) console.log(`${r.status === 'ok' ? '✓' : r.status === 'warn' ? '!' : '✗'} ${r.title}${r.detail ? `: ${r.detail}` : ''}`);
    console.log('');
    const warns = res.filter((r) => r.status === 'warn').length;
    console.log(bad.length ? `Есть ошибки: ${bad.length} из ${res.length}. Покажите этот экран тренеру.` : `Всё работает: ${res.length - warns} из ${res.length} проверок${warns ? `, предупреждений: ${warns}` : ''}.`);
    if (work) console.log(`Временная папка оставлена: ${work}`);
  }
  process.exitCode = bad.length ? 1 : 0;
}

if (isMain(import.meta.url)) main();
