// node tools/services.mjs new | check | run | add | remove | list: сервисы-проекты вне кабинета, реестр me/servisy.json.
// Временный кабинет в профиле с кириллицей и пробелом («Айгуль Н»), проекты в папке «Сервисы» рядом с ним.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import {
  addService,
  checkProject,
  createProject,
  describeService,
  findProjects,
  isProjectOutputFile,
  LIB_FILES,
  LIB_FILES_WEB,
  listServices,
  mergeLessons,
  readRegistry,
  slugify,
  startServiceRun,
  TEMPLATE_VERSION,
  upgradeAll,
  upgradeProject,
  validateServiceResult,
} from '../services.mjs';
import { LOCK_FILE } from '../processes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Настройки git разработчика не влияют на тест: пустой глобальный конфиг (без имени и почты) для этого процесса
// и для команд, которые он запускает.
const GITCFG = mkdtempSync(join(tmpdir(), 'gitcfg-'));
writeFileSync(join(GITCFG, 'config'), '');
process.env.GIT_CONFIG_GLOBAL = join(GITCFG, 'config');
process.env.GIT_CONFIG_NOSYSTEM = '1';
after(() => rmSync(GITCFG, { recursive: true, force: true }));

const MAIN_PY = (title = 'Сводка') => `import json
from datetime import datetime
from pathlib import Path

out = Path("output")
out.mkdir(exist_ok=True)
res = {"title": "${title}", "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
       "status": "green", "summary": "Сумма за неделю: 1200.", "columns": ["Точка", "Сумма"],
       "rows": [["Точка-01", 1200]], "files": ["output/svodka.csv"]}
(out / "svodka.csv").write_text("Точка;Сумма\\nТочка-01;1200\\n", encoding="utf-8")
(out / "result.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
print("готово")
`;

// Программа, которая показывает, откуда взялись llm и read_table: из lib проекта (PYTHONPATH).
const LIB_PY = `import json
from datetime import datetime
from pathlib import Path
import llm
import read_table

out = Path("output")
out.mkdir(exist_ok=True)
res = {"title": "Где lib", "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
       "status": "green", "summary": str(Path(llm.__file__).resolve().parent), "columns": [], "rows": []}
(out / "result.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
`;

const SLEEP_PY = (sec) => `import time
time.sleep(${sec})
`;

let base, cab, home;

const svc = (over = {}) => ({ name: 'Сводка продаж', about: 'Сумма по Точка', kind: 'run', run: 'main.py', result: 'output/result.json', input: 'input/', page: null, ...over });

// Проект в папке «Сервисы» рядом с кабинетом: service.json и файлы { путь: текст }.
function project(folder, service, files = {}) {
  const dir = join(home, folder);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (service !== undefined) writeFileSync(join(dir, 'service.json'), typeof service === 'string' ? service : JSON.stringify(service, null, 2));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

before(() => {
  base = mkdtempSync(join(tmpdir(), 'svc-'));
  const profile = join(base, 'Айгуль Н');
  cab = join(profile, 'ai-cabinet');
  home = join(profile, 'Сервисы');
  mkdirSync(cab, { recursive: true });
  copyDir(join(ROOT, 'tools'), join(cab, 'tools'));
  rmSync(join(cab, 'tools', 'tests'), { recursive: true, force: true });
  rmSync(join(cab, 'tools', '__pycache__'), { recursive: true, force: true });
  // Шаблон проекта: минимальная заглушка (настоящий шаблон проверяет отдельный тест ниже).
  const tpl = join(cab, 'templates', 'service-project');
  mkdirSync(join(tpl, '.claude'), { recursive: true });
  mkdirSync(join(tpl, 'lib'), { recursive: true });
  mkdirSync(join(tpl, 'input'), { recursive: true });
  writeFileSync(join(tpl, 'service.json'), JSON.stringify(svc({ name: 'Название сервиса', about: '' }), null, 2));
  writeFileSync(join(tpl, 'main.py'), MAIN_PY());
  writeFileSync(join(tpl, 'CLAUDE.md'), '# Правила проекта сервиса\n');
  writeFileSync(join(tpl, '.gitignore'), '.env*\ninput/*\noutput/*\n__pycache__/\n');
  writeFileSync(join(tpl, '.claude', 'settings.json'), '{}\n');
  writeFileSync(join(tpl, 'input', '.gitkeep'), '');
  mkdirSync(join(cab, 'me'), { recursive: true });
});

after(() => rmSync(base, { recursive: true, force: true }));

function cli(args, { cwd = cab } = {}) {
  const r = spawnSync(process.execPath, [join(cab, 'tools', 'services.mjs'), ...args], { cwd, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

test('slugify: русские и казахские буквы латиницей, до 40 знаков; пусто, если латиницы нет', () => {
  assert.equal(slugify('Сводка продаж'), 'svodka-prodazh');
  assert.equal(slugify('Светофор точек (Мега)'), 'svetofor-tochek-mega');
  assert.equal(slugify('Қазақ ұлттық өнімі'), 'kazak-ulttyk-onimi');
  assert.equal(slugify('Письма поставщикам'), 'pisma-postavshchikam');
  assert.equal(slugify('!!!'), '');
  assert.ok(slugify('очень длинное название сервиса который считает всё подряд').length <= 40);
  assert.match(slugify('очень длинное название сервиса который считает всё подряд'), /^[a-z0-9-]+[a-z0-9]$/);
});

test('new: папка латиницей в «Сервисы» рядом с кабинетом, шаблон, lib из кабинета, название в service.json, git', () => {
  const r = cli(['new', 'Сводка продаж']);
  assert.equal(r.code, 0, r.out);
  const dir = join(home, 'svodka-prodazh');
  assert.ok(r.out.includes(realpathSync(dir)), r.out);
  assert.match(r.out, /Open folder/);
  const s = JSON.parse(readFileSync(join(dir, 'service.json'), 'utf8'));
  assert.equal(s.name, 'Сводка продаж');
  assert.equal(s.kind, 'run');
  assert.equal(s.run, 'main.py');
  assert.deepEqual(LIB_FILES, ['llm.py', 'read_table.py', 'service_api.py', 'ui.md', 'design.md']);
  for (const f of LIB_FILES) {
    assert.ok(readFileSync(join(dir, 'lib', f)).equals(readFileSync(join(cab, 'tools', f))), f);
  }
  assert.ok(existsSync(join(dir, '.gitignore')), 'скрытые файлы шаблона копируются');
  assert.ok(existsSync(join(dir, '.claude', 'settings.json')));
  assert.ok(existsSync(join(dir, 'main.py')));
  assert.ok(existsSync(join(dir, 'output')));
  if (hasGit) {
    assert.ok(existsSync(join(dir, '.git')), r.out);
    assert.match(r.out, /git init/);
  }
  // То же название ещё раз: новая папка с номером, старая не тронута.
  const again = cli(['new', 'Сводка продаж']);
  assert.equal(again.code, 0, again.out);
  assert.ok(existsSync(join(home, 'svodka-prodazh-2', 'service.json')));
  rmSync(join(home, 'svodka-prodazh-2'), { recursive: true, force: true });
});

test('new --dir: своя папка с кириллицей и пробелом; без названия и внутри кабинета: код 2', () => {
  const other = join(base, 'Айгуль Н', 'Мои проекты');
  const r = cli(['new', 'Жалобы клиентов', '--dir', other]);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(other, 'zhaloby-klientov', 'service.json')), r.out);
  assert.equal(cli(['new']).code, 2);
  const inside = cli(['new', 'Внутри', '--dir', join(cab, 'output')]);
  assert.equal(inside.code, 2, inside.out);
  assert.match(inside.out, /внутри кабинета/);
  assert.equal(existsSync(join(cab, 'output', 'vnutri')), false);
});

test('new: нет шаблона в кабинете → код 2 и подсказка «обнови кабинет»', () => {
  const tpl = join(cab, 'templates', 'service-project');
  const away = join(cab, 'templates', 'service-project.away');
  copyDir(tpl, away);
  rmSync(tpl, { recursive: true, force: true });
  try {
    const r = cli(['new', 'Без шаблона']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /обнови кабинет/);
  } finally {
    copyDir(away, tpl);
    rmSync(away, { recursive: true, force: true });
  }
});

test('check: новый проект из шаблона проходит; папки нет: код 2', () => {
  const r = cli(['check', join(home, 'svodka-prodazh')]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /пройдена/);
  // Из папки проекта: «.».
  const dot = cli(['check', '.'], { cwd: join(home, 'svodka-prodazh') });
  assert.equal(dot.code, 0, dot.out);
  assert.equal(cli(['check', join(home, 'net-takoy')]).code, 2);
});

test('check: запрещённое в программе и в своём модуле, путь вне проекта, свой llm.py; add такой не принимает', () => {
  const dir = project('zapret', svc({ name: 'Запрет' }), {
    'main.py': 'import subprocess\nimport helpers\nopen("C:\\\\Users\\\\x.txt")\n',
    'helpers.py': 'import os\nos.system("dir")\n',
    'llm.py': 'print(1)\n',
    'test_main.py': 'import unittest\n',
  });
  const r = cli(['check', dir]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /main\.py, строка 1: запуск программ/);
  assert.match(r.out, /main\.py, строка 3: путь вне проекта/);
  assert.match(r.out, /helpers\.py, строка 2: запуск программ/);
  assert.match(r.out, /llm\.py в корне проекта/);
  assert.doesNotMatch(r.out, /test_main\.py/, 'файл, который программа не импортирует, не проверяется');
  const add = cli(['add', dir]);
  assert.equal(add.code, 1, add.out);
  assert.match(add.out, /не добавлен/);
  assert.equal(readRegistry(cab).list.some((e) => e.slug === 'zapret'), false);
  // Тот же проект без запрещённого: свой модуль helpers разрешён.
  project('zapret', svc({ name: 'Запрет' }), {
    'main.py': `import helpers\n${MAIN_PY('Запрет')}`,
    'helpers.py': 'from pathlib import Path\n\ndef total(x):\n    return sum(x)\n',
  });
  const ok = cli(['check', dir]);
  assert.equal(ok.code, 0, ok.out);
  // Модуль не из корня проекта и не из списка: нельзя.
  project('zapret', svc({ name: 'Запрет' }), { 'main.py': 'import pandas\n' });
  assert.match(cli(['check', dir]).out, /библиотека не из списка/);
});

test('check: service.json не по договору', () => {
  const cases = [
    [undefined, /нет файла service\.json/],
    ['{"name": ', /повреждён/],
    [svc({ name: '' }), /name: нужно название/],
    [svc({ kind: 'script' }), /kind: нужно "run"/],
    [svc({ run: '../main.py' }), /run: путь к программе внутри проекта/],
    [svc({ run: 'C:/x/main.py' }), /run: путь к программе внутри проекта/],
    [svc({ run: 'main.txt' }), /run: программа должна быть файлом \.py/],
    [svc({ run: 'lib/llm.py' }), /не может лежать в папке lib/],
    [svc({ run: 'net.py' }), /нет программы net\.py/],
    [svc({ result: 'result.json' }), /result: файл \.json в папке output/],
    [svc({ page: 'page/' }), /page: своя страница только у kind "page"/],
    [svc({ kind: 'page', run: null, page: 'site/' }), /page: у kind "page" нужна папка "page\/"/],
    [svc({ kind: 'page', run: null, page: 'page/' }), /нет папки page/],
  ];
  for (const [service, re] of cases) {
    const dir = project('pasport', service, { 'main.py': MAIN_PY() });
    const r = cli(['check', dir]);
    assert.equal(r.code, 1, `${JSON.stringify(service)}\n${r.out}`);
    assert.match(r.out, re, `${JSON.stringify(service)}\n${r.out}`);
  }
  // Своя страница без программы: годится.
  const page = project('pasport', svc({ kind: 'page', run: null, result: null, page: 'page/' }), { 'page/index.html': '<h1>Отчёт</h1>' });
  assert.equal(cli(['check', page]).code, 0);
});

test('check: проект внутри кабинета не годится', () => {
  const dir = join(cab, 'output', 'moy-servis');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'service.json'), JSON.stringify(svc()));
  writeFileSync(join(dir, 'main.py'), MAIN_PY());
  const r = cli(['check', dir]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /внутри кабинета/);
  rmSync(dir, { recursive: true, force: true });
});

test('add: запись в реестр, slug из папки, повторный add обновляет без дубля; тот же slug у другой папки: -2', () => {
  const dir = join(home, 'svodka-prodazh');
  const r = cli(['add', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /добавлен в кабинет/);
  assert.match(r.out, /svodka-prodazh/);
  let list = readRegistry(cab).list;
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['added_at', 'kind', 'name', 'path', 'slug']);
  assert.equal(list[0].slug, 'svodka-prodazh');
  assert.equal(list[0].path, realpathSync(dir));
  assert.equal(list[0].kind, 'run');
  const added = list[0].added_at;
  // Повторно, с новым названием и из папки проекта («.»): та же запись.
  const s = JSON.parse(readFileSync(join(dir, 'service.json'), 'utf8'));
  writeFileSync(join(dir, 'service.json'), JSON.stringify({ ...s, name: 'Сводка продаж по Точка' }));
  const again = cli(['add', '.'], { cwd: dir });
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /обновлён/);
  list = readRegistry(cab).list;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Сводка продаж по Точка');
  assert.equal(list[0].slug, 'svodka-prodazh');
  assert.equal(list[0].added_at, added);
  // Другая папка с кириллическим именем и тем же названием: slug из названия, свободный.
  const other = project('Сводка копия', svc({ name: 'Svodka prodazh' }), { 'main.py': MAIN_PY() });
  const r2 = cli(['add', other]);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(readRegistry(cab).list.find((e) => e.path === realpathSync(other)).slug, 'svodka-prodazh-2');
  assert.equal(cli(['remove', 'svodka-prodazh-2']).code, 0);
  rmSync(other, { recursive: true, force: true });
});

test('run: по имени из реестра и по папке; PYTHONPATH = lib проекта, журнал и итог в output проекта', () => {
  const r = cli(['run', 'svodka-prodazh']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Готово: «Сводка продаж по Точка»/);
  assert.match(r.out, /Цвет карточки: зелёный/);
  assert.match(r.out, /Файлы: output\/svodka\.csv/);
  const dir = join(home, 'svodka-prodazh');
  assert.ok(existsSync(join(dir, 'output', 'result.json')));
  assert.match(readFileSync(join(dir, 'output', 'last-run.log'), 'utf8'), /готово/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'output', 'last-run.json'), 'utf8')).ok, true);
  assert.equal(existsSync(join(dir, 'output', '.running')), false, 'замок снят');
  // Не из реестра, по папке, из самой папки проекта.
  const libDir = project('gde-lib', svc({ name: 'Где lib' }), { 'main.py': LIB_PY });
  const r2 = cli(['run', '.'], { cwd: libDir });
  assert.equal(r2.code, 0, r2.out);
  const res = JSON.parse(readFileSync(join(libDir, 'output', 'result.json'), 'utf8'));
  // Windows: один путь бывает в короткой форме (RUNNER~1) и в полной; сравниваем настоящие пути без учёта регистра.
  const same = (a, b) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  assert.ok(same(res.summary, join(libDir, 'lib')), `llm и read_table из lib проекта: ${res.summary}`);
  assert.ok(existsSync(join(libDir, 'lib', 'llm.py')), 'run кладёт lib сам');
  // Проект, созданный до design.md: файл появляется при первом запуске.
  assert.ok(readFileSync(join(libDir, 'lib', 'design.md')).equals(readFileSync(join(cab, 'tools', 'design.md'))), 'run кладёт design.md');
  assert.equal(cli(['run', 'net-takogo']).code, 2);
});

test('run: программа упала, ничего не записала, результат не по схеме: код 1 и понятный текст', () => {
  const fail = project('padaet', svc({ name: 'Падает' }), { 'main.py': 'import sys\nprint("Нет файла input/sales.csv", file=sys.stderr)\nsys.exit(2)\n' });
  const r = cli(['run', fail]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /не удался \(код 2\)/);
  assert.match(r.out, /Нет файла input\/sales\.csv/);
  const silent = project('molchit', svc({ name: 'Молчит' }), { 'main.py': 'print("ничего")\n' });
  const r2 = cli(['run', silent]);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /не записала output\/result\.json/);
  const bad = project('krivoy', svc({ name: 'Кривой' }), {
    'main.py': `from pathlib import Path\nPath("output").mkdir(exist_ok=True)\nPath("output/result.json").write_text('{"title": "Кривой", "updated_at": "2026-10-30T10:00:00", "status": "blue", "summary": "", "columns": [], "rows": [], "files": ["secret.csv"]}', encoding="utf-8")\n`,
  });
  const r3 = cli(['run', bad]);
  assert.equal(r3.code, 1, r3.out);
  assert.match(r3.out, /не годится для карточки/);
  assert.match(r3.out, /status/);
  assert.match(r3.out, /files/);
  // Запрещённое в программе: не запускается вовсе.
  const banned = project('zapusk', svc({ name: 'Запуск' }), { 'main.py': 'import subprocess\n' });
  const r4 = cli(['run', banned]);
  assert.equal(r4.code, 1, r4.out);
  assert.match(r4.out, /не запускается/);
  assert.equal(existsSync(join(banned, 'output', 'last-run.log')), false);
});

test('схема результата сервиса: файлы только output/ проекта и только разрешённых видов', () => {
  assert.equal(isProjectOutputFile('output/svodka.xlsx'), true);
  assert.equal(isProjectOutputFile('output\\Отчёт за неделю.docx'), true);
  assert.equal(isProjectOutputFile('output/sub/chart.png'), true);
  for (const bad of ['svodka.xlsx', 'output/../main.py', 'output/.env.json', 'output/x.html', 'output/', 'C:/output/x.csv', 'output/a:b.csv']) {
    assert.equal(isProjectOutputFile(bad), false, bad);
  }
  const good = { title: 'А', updated_at: '2026-10-30T10:00:00', status: 'green', summary: '', columns: [], rows: [], files: ['output/a.csv'] };
  assert.equal(validateServiceResult(good).ok, true);
  assert.equal(validateServiceResult({ ...good, files: ['output/servis/a.txt'] }).ok, false);
});

test('двойной запуск: второй получает ERUNNING, CLI отвечает «уже считается» с кодом 2', async () => {
  const dir = project('dolgiy', svc({ name: 'Долгий' }), { 'main.py': SLEEP_PY(2) });
  const first = startServiceRun(cab, dir);
  assert.throws(() => startServiceRun(cab, dir), (e) => e.code === 'ERUNNING');
  const r = cli(['run', dir]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /уже считается/);
  const done = await first.done;
  assert.equal(done.ok, true);
  assert.equal(existsSync(join(dir, 'output', '.running')), false);
});

test('таймаут: долгая программа останавливается, замок снят, в журнале причина', async () => {
  const dir = project('zavis', svc({ name: 'Завис' }), { 'main.py': SLEEP_PY(60) });
  const t0 = Date.now();
  const run = startServiceRun(cab, dir, { timeoutMs: 700, killGraceMs: 2000 });
  const r = await run.done;
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 15000, 'остановился быстро');
  assert.match(readFileSync(run.logPath, 'utf8'), /дольше/);
  assert.equal(existsSync(join(dir, 'output', '.running')), false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'output', 'last-run.json'), 'utf8')).ok, false);
});

test('list: реестр, статус и время результата; пропавшая папка: ошибка и код 1; remove', () => {
  const r = cli(['list']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Сервисов-проектов в кабинете: 1/);
  assert.match(r.out, /«Сводка продаж по Точка» \(имя svodka-prodazh\)/);
  assert.match(r.out, /Результат: обновлён \d\d\.\d\d\.\d{4} \d\d:\d\d, зелёный/);
  assert.match(r.out, /Последний запуск: .*удачно/);
  const items = listServices(cab);
  assert.equal(items[0].slug, 'svodka-prodazh');
  assert.equal(items[0].run, true);
  assert.equal(items[0].result.status, 'green');
  assert.equal(items[0].lastRun.ok, true);
  // Папку проекта убрали: в списке ошибка.
  const gone = project('propal', svc({ name: 'Пропал' }), { 'main.py': MAIN_PY() });
  addService(cab, gone);
  rmSync(gone, { recursive: true, force: true });
  const r2 = cli(['list']);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /папка сервиса не найдена/);
  assert.equal(cli(['run', 'propal']).code, 2);
  const rm = cli(['remove', 'propal']);
  assert.equal(rm.code, 0, rm.out);
  assert.match(rm.out, /убран из кабинета/);
  assert.equal(cli(['remove', 'propal']).code, 2);
  assert.equal(cli(['list']).code, 0);
});

test('реестр повреждён: add и remove его не перезаписывают', () => {
  const file = join(cab, 'me', 'servisy.json');
  const saved = readFileSync(file);
  writeFileSync(file, '[{"slug": ');
  try {
    const r = cli(['add', join(home, 'svodka-prodazh')]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /не читается/);
    assert.equal(readFileSync(file, 'utf8'), '[{"slug": ');
    assert.equal(cli(['list']).code, 1);
  } finally {
    writeFileSync(file, saved);
  }
});

test('lib-ссылка наружу: кабинет не пишет через неё, run отказывается', (t) => {
  const dir = project('lib-ssylka', svc({ name: 'Ссылка' }), { 'main.py': MAIN_PY() });
  const outside = join(base, 'naruzhu');
  mkdirSync(outside, { recursive: true });
  try {
    symlinkSync(outside, join(dir, 'lib'), 'junction');
  } catch {
    return t.skip('ссылки на этом компьютере не создаются');
  }
  const r = cli(['run', dir]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /lib должна быть обычной папкой/);
  assert.equal(existsSync(join(outside, 'llm.py')), false);
});

test('checkProject: программа импортирует свой пакет: проверяются все его файлы', () => {
  const dir = project('paket', svc({ name: 'Пакет' }), {
    'main.py': 'from utils.calc import total\n',
    'utils/__init__.py': '',
    'utils/calc.py': 'eval("1")\n',
  });
  const c = checkProject(cab, dir);
  assert.ok(c.program.some((x) => x.file === 'utils/calc.py' && /выполнение текста/.test(x.why)), JSON.stringify(c.program));
});

test('настоящий шаблон templates/service-project (если уже есть): проект из него проходит check', (t) => {
  const real = join(ROOT, 'templates', 'service-project');
  if (!existsSync(real)) return t.skip('шаблона пока нет');
  const c2 = join(base, 'real', 'ai-cabinet');
  mkdirSync(c2, { recursive: true });
  copyDir(join(cab, 'tools'), join(c2, 'tools'));
  copyDir(real, join(c2, 'templates', 'service-project'));
  const r = spawnSync(process.execPath, [join(c2, 'tools', 'services.mjs'), 'new', 'Проверка шаблона'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = join(base, 'real', 'Сервисы', 'proverka-shablona');
  const chk = spawnSync(process.execPath, [join(c2, 'tools', 'services.mjs'), 'check', dir], { encoding: 'utf8' });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
});

test('кабинет разрешает node tools/services.mjs в settings.json', () => {
  const s = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.permissions.allow.includes('Bash(node tools/services.mjs*)'));
});

// ---------- обновление проектов после «обнови кабинет» (upgrade, upgrade-all) ----------

// Отдельный кабинет со своей папкой «Сервисы»: upgrade-all обходит все проекты рядом с кабинетом.
function freshCabinet(name) {
  const profile = join(base, name);
  const c = join(profile, 'ai-cabinet');
  mkdirSync(join(c, 'me'), { recursive: true });
  copyDir(join(cab, 'tools'), join(c, 'tools'));
  copyDir(join(cab, 'templates', 'service-project'), join(c, 'templates', 'service-project'));
  copyDir(join(ROOT, 'templates', 'web-service'), join(c, 'templates', 'web-service'));
  return { c, svcHome: join(profile, 'Сервисы') };
}

function oldProject(svcHome, folder, service, files = {}) {
  const dir = join(svcHome, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'service.json'), typeof service === 'string' ? service : JSON.stringify(service, null, 2));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return realpathSync(dir);
}

// Хэши файлов папки (путь от неё): так видно, что файлы человека не тронуты ни на байт.
function hashes(dir, keep) {
  const out = {};
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!keep(r)) continue;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else out[r] = createHash('sha256').update(readFileSync(join(abs, e.name))).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

const gitOut = (dir, ...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
const listFiles = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const OLD_RUN = { name: 'Сводка', about: 'Сумма по точкам', kind: 'run', run: 'main.py', result: 'output/result.json', input: 'input/', page: null, moe_pole: { a: 1 } };
// «Уроки» человека: CRLF, эмодзи, без перевода строки в конце: всё должно дойти байт в байт.
const LESSONS = '## Уроки\r\n\r\n- 10.11: возвраты вычитаю 🙂\r\n- 11.11: «Точка-01» без НДС';

test('upgrade: новые правила, «Уроки» байт в байт, копии в .claude/backup, settings, .gitignore, git main, template_version', () => {
  const { c, svcHome } = freshCabinet('upg-1');
  const oldClaude = `# Правила проекта сервиса (вчерашние)\n\nСтарый текст.\n\n${LESSONS}`;
  const dir = oldProject(svcHome, 'svodka', OLD_RUN, {
    'CLAUDE.md': oldClaude,
    'main.py': MAIN_PY(),
    'input/продажи.csv': 'Точка;Сумма\n1;2\n',
    'output/result.json': '{}',
    '.env': 'MOY_KLYUCH=секрет\n',
    '.gitignore': '# моё\nmoi-fayl.txt\n.env*\n',
    '.claude/settings.json': '{"old": true}\n',
    '.claude/settings.local.json': '{"moe": true}\n',
  });
  const own = (r) => ['main.py', 'input', 'output', '.env', '.claude', '.claude/settings.local.json'].some((p) => r === p || r.startsWith(`${p}/`)) && r !== '.claude/settings.json' && !r.startsWith('.claude/backup');
  const before = hashes(dir, own);
  const r = upgradeProject(c, dir);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.name, 'Сводка');
  for (const x of ['.gitignore', 'CLAUDE.md', '.claude/settings.json', 'service.json', 'lib/llm.py']) assert.ok(r.changed.includes(x), `${x}: ${r.changed}`);
  // Правила: шаблон (в нём «Уроков» нет: раздел человека после пустой строки), затем раздел человека как был.
  const tpl = readFileSync(join(c, 'templates', 'service-project', 'CLAUDE.md'), 'utf8');
  const now = readFileSync(join(dir, 'CLAUDE.md'));
  assert.ok(now.equals(Buffer.from(`${tpl.trimEnd()}\n\n${LESSONS}`)), now.toString());
  // Копии: старые правила и настройки в .claude/backup.
  const backups = listFiles(join(dir, '.claude', 'backup'));
  const claudeCopy = backups.find((n) => /^CLAUDE-\d{8}-\d{4}\.md$/.test(n));
  const settingsCopy = backups.find((n) => /^settings-\d{8}-\d{4}\.json$/.test(n));
  assert.ok(claudeCopy && settingsCopy, backups.join(', '));
  assert.equal(readFileSync(join(dir, '.claude', 'backup', claudeCopy), 'utf8'), oldClaude);
  assert.equal(readFileSync(join(dir, '.claude', 'backup', settingsCopy), 'utf8'), '{"old": true}\n');
  assert.equal(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'), readFileSync(join(c, 'templates', 'service-project', '.claude', 'settings.json'), 'utf8'));
  // .gitignore: свои строки на месте, недостающие из шаблона дописаны, без повторов.
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.ok(gi.startsWith('# моё\nmoi-fayl.txt\n.env*\n'), gi);
  for (const line of ['input/*', 'output/*', '__pycache__/']) assert.ok(gi.split('\n').includes(line), line);
  assert.equal(gi.split('\n').filter((l) => l === '.env*').length, 1);
  // service.json: порядок полей тот же, версия шаблона в конце.
  const sj = JSON.parse(readFileSync(join(dir, 'service.json'), 'utf8'));
  assert.deepEqual(Object.keys(sj), [...Object.keys(OLD_RUN), 'template_version']);
  assert.equal(sj.template_version, TEMPLATE_VERSION);
  assert.deepEqual(sj.moe_pole, { a: 1 });
  // Файлы человека не тронуты ни на байт.
  assert.deepEqual(hashes(dir, own), before);
  if (hasGit) {
    assert.ok(r.changed.includes('git'));
    assert.equal(gitOut(dir, 'branch', '--show-current'), 'main');
    assert.equal(gitOut(dir, 'log', '--format=%s'), 'Сервис до обновления кабинета');
    // Версия «до обновления»: вчерашние правила, без ключей и данных.
    assert.equal(gitOut(dir, 'show', 'HEAD:CLAUDE.md'), oldClaude.trim());
    const tracked = gitOut(dir, 'ls-files').split('\n');
    assert.ok(tracked.includes('main.py'), tracked.join(', '));
    assert.ok(!tracked.some((f) => f === '.env' || f.includes('input/') || f.includes('output/')), tracked.join(', '));
  }
});

test('upgrade: без «Уроков» правила как в шаблоне; повтор ничего не меняет и копий не плодит', () => {
  const { c, svcHome } = freshCabinet('upg-2');
  // Настоящий шаблон с разделом «Уроки»: раздел шаблона остаётся, когда у человека его нет.
  copyDir(join(ROOT, 'templates', 'service-project'), join(c, 'templates', 'service-project'));
  const dir = oldProject(svcHome, 'bez-urokov', OLD_RUN, { 'CLAUDE.md': '# Старые правила\nбез уроков\n', 'main.py': MAIN_PY() });
  const r = upgradeProject(c, dir);
  assert.equal(r.error, undefined, r.error);
  const tpl = readFileSync(join(c, 'templates', 'service-project', 'CLAUDE.md'));
  assert.ok(readFileSync(join(dir, 'CLAUDE.md')).equals(tpl));
  const backups = listFiles(join(dir, '.claude', 'backup'));
  assert.equal(backups.filter((n) => n.startsWith('CLAUDE-')).length, 1);
  // Свои уроки в настоящем шаблоне: раздел «Уроки» шаблона заменяется разделом человека.
  const merged = mergeLessons(Buffer.from('# x\n## Уроки\n- мой урок\n'), tpl).toString();
  assert.ok(merged.endsWith('## Уроки\n- мой урок\n') && merged.startsWith(tpl.toString().split('## Уроки')[0]));
  assert.equal(merged.split('## Уроки').length, 2);
  const again = upgradeProject(c, dir);
  assert.equal(again.error, undefined, again.error);
  assert.deepEqual(again.changed, []);
  assert.deepEqual(listFiles(join(dir, '.claude', 'backup')), backups);
  assert.ok(readFileSync(join(dir, 'CLAUDE.md')).equals(tpl));
  if (hasGit) assert.equal(gitOut(dir, 'rev-list', '--count', 'HEAD'), '1');
});

test('«подключи базу» у сервиса на компьютере: upgrade кладёт db.py, драйвер и db/001_init.sql; import db только с полем db', () => {
  const { c, svcHome } = freshCabinet('upg-db');
  const prog = 'import sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))\nfrom db import query\n';
  const dir = oldProject(svcHome, 'zayavki', OLD_RUN, { 'main.py': prog });
  // Без поля db: помощника базы нет, import db не из списка.
  assert.equal(upgradeProject(c, dir).error, undefined);
  assert.ok(!existsSync(join(dir, 'lib', 'db.py')));
  assert.ok(!existsSync(join(dir, 'lib', 'vendor')));
  assert.ok(checkProject(c, dir).program.some((x) => x.file === 'main.py' && /библиотека не из списка/.test(x.why)));
  // Поле db: помощник, драйвер и первый файл таблиц из шаблона сервиса для интернета.
  writeFileSync(join(dir, 'service.json'), JSON.stringify({ ...OLD_RUN, db: 'db/' }, null, 2));
  const r = upgradeProject(c, dir);
  assert.equal(r.error, undefined);
  for (const x of ['lib/db.py', 'lib/vendor', 'db/001_init.sql']) assert.ok(r.changed.includes(x), `${x} в ${r.changed}`);
  assert.ok(existsSync(join(dir, 'lib', 'vendor', 'pg8000')));
  const chk = checkProject(c, dir);
  assert.deepEqual(chk.program, []);
  assert.deepEqual(chk.problems, []);
  assert.equal(chk.info.db, true);
  // Свои таблицы человека повтор не трогает; свой db.py в корне перекрыл бы помощника.
  writeFileSync(join(dir, 'db', '001_init.sql'), '-- моё\n');
  upgradeProject(c, dir);
  assert.equal(readFileSync(join(dir, 'db', '001_init.sql'), 'utf8'), '-- моё\n');
  writeFileSync(join(dir, 'db.py'), '');
  assert.ok(checkProject(c, dir).problems.some((p) => p.startsWith('db.py в корне проекта')));
  // db не туда: замечание к service.json.
  writeFileSync(join(dir, 'service.json'), JSON.stringify({ ...OLD_RUN, db: 'dannye/' }, null, 2));
  assert.ok(checkProject(c, dir).problems.some((p) => p.startsWith('service.json: db:')));
});

test('upgrade: идёт расчёт → сервис пропущен, обновится в следующий раз', () => {
  const { c, svcHome } = freshCabinet('upg-3');
  const dir = oldProject(svcHome, 'schitaetsya', OLD_RUN, { 'CLAUDE.md': '# Старые\n', 'main.py': MAIN_PY(), 'output/.gitkeep': '' });
  writeFileSync(join(dir, 'output', LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), timeoutMs: 300000 }));
  const r = upgradeAll(c);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].skipped, 'идёт расчёт');
  assert.deepEqual(r.results[0].changed, []);
  assert.equal(r.message, 'Сервис «Сводка» сейчас считается: обновится при следующем обновлении кабинета.');
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '# Старые\n');
  assert.equal(existsSync(join(dir, '.git')), false);
  rmSync(join(dir, 'output', LOCK_FILE));
  assert.match(upgradeAll(c).message, /^Обновлены правила в 1 сервисе: Сводка\.$/);
});

test('upgrade: git на ветке master без origin → main; с origin ветка остаётся', (t) => {
  if (!hasGit) return t.skip('git нет');
  const { c, svcHome } = freshCabinet('upg-4');
  const id = ['-c', 'user.name=Тест', '-c', 'user.email=test@example.com'];
  const mk = (folder, origin) => {
    const dir = oldProject(svcHome, folder, OLD_RUN, { 'CLAUDE.md': '# Старые\n', 'main.py': MAIN_PY() });
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/master'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', [...id, 'commit', '-q', '-m', 'моя версия'], { cwd: dir });
    if (origin) spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/aigul/svodka.git'], { cwd: dir });
    return dir;
  };
  const local = mk('master-local', false);
  const pushed = mk('master-origin', true);
  const r1 = upgradeProject(c, local);
  assert.equal(r1.error, undefined, r1.error);
  assert.ok(r1.changed.includes('git: ветка main'), r1.changed.join(', '));
  assert.equal(gitOut(local, 'branch', '--show-current'), 'main');
  assert.equal(gitOut(local, 'log', '--format=%s'), 'моя версия');
  const r2 = upgradeProject(c, pushed);
  assert.equal(r2.error, undefined, r2.error);
  assert.equal(gitOut(pushed, 'branch', '--show-current'), 'master');
  // Папка из «новый сервис» (git init без версий): появляется первая версия.
  const fresh = oldProject(svcHome, 'bez-versiy', OLD_RUN, { 'main.py': MAIN_PY() });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh });
  assert.equal(upgradeProject(c, fresh).error, undefined);
  assert.equal(gitOut(fresh, 'log', '--format=%s'), 'Сервис до обновления кабинета');
});

test('upgrade-all: реестр и папка «Сервисы» без дублей; сломанный service.json: ошибка только у него', () => {
  const { c, svcHome } = freshCabinet('upg-5');
  const a = oldProject(svcHome, 'otpuska', { ...OLD_RUN, name: 'Отпуска' }, { 'CLAUDE.md': '# Старые\n', 'main.py': MAIN_PY() });
  const b = oldProject(svcHome, 'svetofor', { ...OLD_RUN, name: 'Светофор' }, { 'CLAUDE.md': '# Старые\n', 'main.py': MAIN_PY() });
  const broken = oldProject(svcHome, 'sloman', '{ "name": "Сломан", ', {});
  // Сервис в реестре кабинета лежит в другой папке; второй из «Сервисы» тоже в реестре (не дублируется).
  const elsewhere = oldProject(join(base, 'upg-5', 'Мои проекты'), 'svodka', { ...OLD_RUN, name: 'Сводка' }, { 'main.py': MAIN_PY() });
  writeFileSync(join(c, 'me', 'servisy.json'), JSON.stringify([
    { slug: 'svetofor', name: 'Светофор', path: b, kind: 'run', added_at: '2026-11-10T10:00:00Z' },
    { slug: 'svodka', name: 'Сводка', path: elsewhere, kind: 'run', added_at: '2026-11-10T10:00:00Z' },
  ]));
  const found = findProjects(c).map((p) => p.dir);
  assert.deepEqual(found, [b, elsewhere, a, broken]);
  const r = upgradeAll(c);
  const lines = r.message.split('\n');
  assert.equal(lines[0], 'Обновлены правила в 3 сервисах: Светофор, Сводка, Отпуска.');
  assert.equal(lines[1], 'Сервис «sloman» не обновлён: service.json повреждён или не в формате JSON.');
  assert.equal(lines.length, 2);
  for (const d of [a, b, elsewhere]) assert.equal(JSON.parse(readFileSync(join(d, 'service.json'), 'utf8')).template_version, TEMPLATE_VERSION);
  assert.equal(readFileSync(join(broken, 'service.json'), 'utf8'), '{ "name": "Сломан", ');
  // CLI: то же одной командой; повтор: обновлять нечего, ошибка сломанного остаётся (код 1).
  const cliAll = spawnSync(process.execPath, [join(c, 'tools', 'services.mjs'), 'upgrade-all'], { encoding: 'utf8' });
  assert.equal(cliAll.status, 1, cliAll.stdout);
  assert.equal(cliAll.stdout.trim(), 'Сервис «sloman» не обновлён: service.json повреждён или не в формате JSON.');
  rmSync(broken, { recursive: true, force: true });
  const ok = spawnSync(process.execPath, [join(c, 'tools', 'services.mjs'), 'upgrade-all'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /уже по новой версии/);
});

test('upgrade web: lib/vendor и public/ui из кабинета, каркас только недостающим, vercel.json курса, файлы человека целы', () => {
  const { c, svcHome } = freshCabinet('upg-6');
  const T = join(ROOT, 'templates', 'web-service');
  // Сервис после перевода: kind web, свои действия, страница и таблицы; lib и public/ui ещё нет.
  const dir = oldProject(svcHome, 'zayavki', { name: 'Заявки', about: '', kind: 'web', api: 'api/index.py', public: 'public/', db: 'db/' }, {
    'CLAUDE.md': `# Правила сервиса на компьютере\n\n${LESSONS}`,
    'api/index.py': `${readFileSync(join(T, 'api', 'index.py'), 'utf8')}\n# моя правка\n`,
    'public/index.html': `${readFileSync(join(T, 'public', 'index.html'), 'utf8')}\n<!-- моя страница -->\n`,
    'db/002_moi.sql': 'create table if not exists app.moi (id serial primary key, t text);\n',
    'input/zayavki.csv': 'ФИО;Дни\nА;5\n',
    '.env': 'SERVICE_ACCESS_CODE=kot-dom-les\n',
    'main.py': MAIN_PY(),
    'vercel.json': '{"old": true}\n',
    'lib/vendor/lishniy.py': 'x = 1\n',
    'public/ui/moy.css': '.moy {}\n',
  });
  const own = (r) => ['api', 'api/index.py', 'public', 'public/index.html', 'public/ui', 'public/ui/moy.css', 'db', 'input', '.env', 'main.py'].some((p) => r === p || r.startsWith(`${p}/`)) && !(r.startsWith('public/ui/') && r !== 'public/ui/moy.css');
  const before = hashes(dir, own);
  const r = upgradeProject(c, dir);
  assert.equal(r.error, undefined, r.error);
  for (const n of LIB_FILES_WEB) assert.ok(readFileSync(join(dir, 'lib', n)).equals(readFileSync(join(c, 'tools', n))), n);
  // lib/vendor: копия tools/vendor (без кэша Python), лишнее убрано.
  const skipCache = (r2) => !r2.split('/').includes('__pycache__') && !r2.endsWith('.pyc');
  assert.deepEqual(hashes(join(dir, 'lib', 'vendor'), skipCache), hashes(join(c, 'tools', 'vendor'), skipCache));
  assert.equal(existsSync(join(dir, 'lib', 'vendor', 'lishniy.py')), false);
  // public/ui: набор без витрины, brand.css из бренда (в этом кабинете бренда нет: пустой), свой файл на месте.
  for (const n of ['basecoat.css', 'kabinet.css', 'kabinet.js', 'tailwind.js', 'chart.js']) assert.ok(existsSync(join(dir, 'public', 'ui', n)), n);
  assert.equal(existsSync(join(dir, 'public', 'ui', 'demo.html')), false);
  assert.ok(existsSync(join(dir, 'public', 'ui', 'brand.css')));
  // Каркас: недостающее положено, своё не тронуто; в db уже есть таблицы: 001_init.sql не нужен.
  for (const n of ['requirements.txt', '.python-version']) assert.ok(readFileSync(join(dir, n)).equals(readFileSync(join(T, n))), n);
  assert.equal(existsSync(join(dir, 'db', '001_init.sql')), false);
  assert.ok(readFileSync(join(dir, 'vercel.json')).equals(readFileSync(join(T, 'vercel.json'))));
  assert.ok(listFiles(join(dir, '.claude', 'backup')).some((n) => /^vercel-\d{8}-\d{4}\.json$/.test(n)));
  // Правила и настройки вида web, «Уроки» человека байт в байт.
  const tplClaude = readFileSync(join(T, 'CLAUDE.md'), 'utf8');
  assert.ok(readFileSync(join(dir, 'CLAUDE.md')).equals(Buffer.from(tplClaude.slice(0, tplClaude.indexOf('## Уроки')) + LESSONS)));
  assert.ok(readFileSync(join(dir, '.claude', 'settings.json')).equals(readFileSync(join(T, '.claude', 'settings.json'))));
  assert.deepEqual(hashes(dir, own), before);
  // Проект проходит проверку кабинета; повтор ничего не меняет.
  const chk = checkProject(c, dir);
  assert.deepEqual([chk.problems, chk.program], [[], []]);
  assert.deepEqual(upgradeProject(c, dir).changed, []);
  // CLI: upgrade <папка>.
  const cliOne = spawnSync(process.execPath, [join(c, 'tools', 'services.mjs'), 'upgrade', dir], { encoding: 'utf8' });
  assert.equal(cliOne.status, 0, cliOne.stdout);
  assert.match(cliOne.stdout, /уже по новой версии/);
});

// ---------- сервис для интернета (kind web) ----------

test('new --kind web: шаблон web-service, lib, vendor, public/ui; check и add проходят; run отказывает', () => {
  const { c, svcHome } = freshCabinet('web-1');
  const r = spawnSync(process.execPath, [join(c, 'tools', 'services.mjs'), 'new', 'Заявки на отпуск', '--kind', 'web'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Сервис для интернета «Заявки на отпуск» создан/);
  assert.doesNotMatch(r.stdout, /main\.py/);
  const dir = join(svcHome, 'zayavki-na-otpusk');
  const sj = JSON.parse(readFileSync(join(dir, 'service.json'), 'utf8'));
  assert.equal(sj.name, 'Заявки на отпуск');
  assert.equal(sj.kind, 'web');
  assert.equal(sj.api, 'api/index.py');
  assert.equal(sj.template_version, TEMPLATE_VERSION);
  for (const f of ['api/index.py', 'public/index.html', 'vercel.json', 'db/001_init.sql', 'lib/web.py', 'lib/db.py', 'lib/web_dev.py', 'lib/vendor/pg8000/__init__.py', 'public/ui/kabinet.js', 'public/ui/brand.css', '.claude/settings.json', '.gitignore']) {
    assert.ok(existsSync(join(dir, f)), f);
  }
  assert.equal(existsSync(join(dir, 'main.py')), false);
  if (hasGit) assert.equal(gitOut(dir, 'branch', '--show-current'), 'main');
  const chk = spawnSync(process.execPath, [join(c, 'tools', 'services.mjs'), 'check', dir], { encoding: 'utf8' });
  assert.equal(chk.status, 0, chk.stdout);
  assert.match(chk.stdout, /сервис для интернета/);
  const add = spawnSync(process.execPath, [join(c, 'tools', 'services.mjs'), 'add', dir], { encoding: 'utf8' });
  assert.equal(add.status, 0, add.stdout);
  assert.doesNotMatch(add.stdout, /services\.mjs run/);
  assert.equal(readRegistry(c).list[0].kind, 'web');
  // Запуска нет: ошибка с кодом и отказ CLI с кодом 2.
  assert.throws(() => startServiceRun(c, 'zayavki-na-otpusk'), (e) => e.code === 'EWEB' && /нет кнопки «Запустить»: он работает по ссылке/.test(e.message));
  const run = spawnSync(process.execPath, [join(c, 'tools', 'services.mjs'), 'run', 'zayavki-na-otpusk'], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stdout);
  assert.match(run.stdout, /У сервиса для интернета нет кнопки «Запустить»/);
  // Неизвестный вид: код 2.
  assert.equal(spawnSync(process.execPath, [join(c, 'tools', 'services.mjs'), 'new', 'Х', '--kind', 'sayt'], { encoding: 'utf8' }).status, 2);
});

test('describeService web: для сайта своя страница, итог «Не опубликован» и «Опубликован: адрес», без «Запустить»', () => {
  const { c, svcHome } = freshCabinet('web-2');
  const made = createProject(c, 'Заявки', { kind: 'web', git: false });
  assert.equal(made.dir, join(realpathSync(svcHome), 'zayavki'));
  const { entry } = addService(c, made.dir);
  let d = describeService(c, entry);
  assert.equal(d.kind, 'page');
  assert.equal(d.web, true);
  assert.equal(d.run, false);
  assert.equal(d.page, 's/zayavki/');
  assert.equal(d.url, null);
  assert.equal(d.error, null);
  assert.equal(d.result.status, 'yellow');
  assert.equal(d.result.summary, 'Не опубликован: скажите «опубликуй сервис» в папке сервиса');
  assert.deepEqual(validateServiceResult(d.result), { ok: true, errors: [] });
  assert.equal(d.result.updated_at, new Date(statSync(join(made.dir, 'service.json')).mtimeMs).toISOString());
  const sj = JSON.parse(readFileSync(join(made.dir, 'service.json'), 'utf8'));
  writeFileSync(join(made.dir, 'service.json'), JSON.stringify({ ...sj, publish: { url: 'https://zayavki-aigul.vercel.app', published_at: '2026-11-12T06:30:00+05:00' } }, null, 2));
  d = describeService(c, entry);
  assert.equal(d.result.status, 'green');
  assert.equal(d.result.summary, 'Опубликован: https://zayavki-aigul.vercel.app');
  assert.equal(d.result.updated_at, '2026-11-12T06:30:00+05:00');
  assert.equal(d.url, 'https://zayavki-aigul.vercel.app');
  assert.deepEqual(validateServiceResult(d.result), { ok: true, errors: [] });
  // Адрес не http(s): не ссылка.
  writeFileSync(join(made.dir, 'service.json'), JSON.stringify({ ...sj, publish: { url: 'javascript:alert(1)' } }, null, 2));
  assert.equal(describeService(c, entry).url, null);
  const list = spawnSync(process.execPath, [join(c, 'tools', 'services.mjs'), 'list'], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stdout);
  assert.match(list.stdout, /сервис для интернета, кнопка «Открыть»/);
  assert.match(list.stdout, /Не опубликован/);
});
