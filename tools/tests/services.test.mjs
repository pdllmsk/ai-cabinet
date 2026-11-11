// node tools/services.mjs new | check | run | add | remove | list: сервисы-проекты вне кабинета, реестр me/servisy.json.
// Временный кабинет в профиле с кириллицей и пробелом («Айгуль Н»), проекты в папке «Сервисы» рядом с ним.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { classify } from '../../.claude/hooks/guard.mjs';
import {
  addService,
  checkProject,
  isProjectOutputFile,
  LIB_FILES,
  listServices,
  readRegistry,
  slugify,
  startServiceRun,
  validateServiceResult,
} from '../services.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

test('кабинет разрешает node tools/services.mjs: settings.json и сторож', () => {
  const s = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.permissions.allow.includes('Bash(node tools/services.mjs*)'));
  const ctx = { tool: 'Bash', cwds: [ROOT], roots: [ROOT], mode: 'acceptEdits' };
  for (const cmd of ['node tools/services.mjs list', 'node tools/services.mjs run svodka-prodazh', 'node tools/services.mjs add "C:\\Users\\Айгуль Н\\Documents\\Сервисы\\svodka"']) {
    assert.equal(classify(cmd, ctx), null, cmd);
  }
  assert.notEqual(classify('node tools/services.mjs list; echo x > processes/x/run.py', ctx), null);
});
