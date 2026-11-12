// node tools/web.mjs: проверка сервиса для интернета, личные данные, ключ базы, код доступа, .env, страница на
// компьютере, состояние, план перевода. Временные папки в профиле с кириллицей и пробелом («Айгуль Н»).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import {
  accessCodeHash,
  accessCodeOk,
  checkWebProject,
  columnPiiKind,
  findPii,
  guessType,
  loadWords,
  main,
  makeCode,
  makeSecret,
  migratePlan,
  normCode,
  parseEnv,
  readEnv,
  roleName,
  saveAccount,
  scramVerifier,
  sqlFileProblems,
  sqlProblems,
  startDev,
  stopDev,
  valuePiiKind,
  verifyWeb,
  firstAction,
  usesModel,
  webStatus,
  writeEnv,
} from '../web.mjs';
import { findPython } from '../processes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = ['web.py', 'db.py', 'web_dev.py', 'read_table.py'];
const REF = 'abcdefghijklmnopqrst';
const HOST = 'aws-0-eu-central-1.pooler.supabase.com';

let base;
let home;
let python;
let n = 0;

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'web-mjs-'));
  home = join(base, 'Айгуль Н', 'Сервисы');
  mkdirSync(home, { recursive: true });
  python = await findPython(ROOT);
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

// Копия шаблона сервиса для интернета с lib, как её кладёт кабинет.
function webProject(name = `servis-${++n}`, { vendor = false } = {}) {
  const dir = join(home, name);
  copyDir(join(ROOT, 'templates', 'web-service'), dir);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  for (const f of LIB) copyFileSync(join(ROOT, 'tools', f), join(dir, 'lib', f));
  if (vendor) copyDir(join(ROOT, 'tools', 'vendor'), join(dir, 'lib', 'vendor'));
  return dir;
}

const run = (argv) => main(argv, { root: ROOT, cwd: base });
const py = (code, args = []) =>
  spawnSync(python, ['-I', '-c', code, ...args], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });

// ---------- SCRAM и код доступа ----------

test('SCRAM-SHA-256: StoredKey и ServerKey совпадают с scramp из tools/vendor', () => {
  const password = randomBytes(32).toString('base64url');
  const salt = randomBytes(16);
  const v = scramVerifier(password, salt, 4096);
  const m = /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(v);
  assert.ok(m, v);
  assert.equal(Buffer.from(m[1], 'base64').toString('hex'), salt.toString('hex'));
  const code = `
import base64, sys
sys.path.insert(0, sys.argv[1])
import scramp
salt, stored, server, i = scramp.ScramMechanism("SCRAM-SHA-256").make_auth_info(sys.argv[2], iteration_count=4096, salt=bytes.fromhex(sys.argv[3]))
print(base64.b64encode(stored).decode() + ":" + base64.b64encode(server).decode() + ":" + str(i))
`;
  const r = py(code, [join(ROOT, 'tools', 'vendor'), password, salt.toString('hex')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${m[2]}:${m[3]}:4096`);
  // Новая соль по умолчанию: другой verifier от того же пароля.
  assert.notEqual(scramVerifier(password), scramVerifier(password));
});

test('хэш кода доступа совпадает с web.py check_code, норм. код как norm_code', () => {
  const hash = accessCodeHash('River-LAMP sun');
  assert.match(hash, /^pbkdf2\$200000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(normCode('  River-LAMP__sun '), 'river-lamp-sun');
  const code = `
import sys
sys.path.insert(0, sys.argv[1])
import web
print(web.check_code(sys.argv[2], sys.argv[3]), web.check_code("river-lamp-moon", sys.argv[3]), web.hash_code(sys.argv[2], "00ff"))
`;
  const r = py(code, [join(ROOT, 'tools'), 'river lamp SUN', hash]);
  assert.equal(r.status, 0, r.stderr);
  const [ok, bad, pyHash] = r.stdout.trim().split(' ');
  assert.equal(ok, 'True');
  assert.equal(bad, 'False');
  assert.equal(pyHash, accessCodeHash('river-lamp-sun', '00ff'));
  assert.ok(accessCodeOk('river-lamp-sun', hash));
  assert.ok(!accessCodeOk('river-lamp-moon', hash));
});

test('словарь кодов: ровно 1000 разных простых слов, без тире в текстах web.mjs', () => {
  const lines = readFileSync(join(ROOT, 'tools', 'words.txt'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1000);
  assert.equal(new Set(lines).size, 1000);
  for (const w of lines) assert.match(w, /^[a-z]{3,7}$/);
  assert.equal(loadWords(ROOT).length, 1000);
  for (const f of ['web.mjs', 'words.txt']) {
    assert.doesNotMatch(readFileSync(join(ROOT, 'tools', f), 'utf8'), /[‒-―]/, f);
  }
});

// ---------- .env ----------

test('writeEnv: чужие ключи и комментарии остаются, ключи заменяются на месте, файл 0600', () => {
  const dir = join(home, 'env-test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), '# мой комментарий\nOPENAI=keep-me\nDATABASE_URL=old\n\nOTHER="x y"\nDATABASE_URL=dup\n');
  writeEnv(dir, { DATABASE_URL: 'new', SERVICE_COOKIE_SECRET: 'abc' });
  const text = readFileSync(join(dir, '.env'), 'utf8');
  assert.equal(text, '# мой комментарий\nOPENAI=keep-me\nDATABASE_URL=new\n\nOTHER="x y"\nSERVICE_COOKIE_SECRET=abc\n');
  const env = readEnv(dir);
  assert.equal(env.get('OTHER'), 'x y');
  assert.equal(env.get('DATABASE_URL'), 'new');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
  assert.throws(() => writeEnv(dir, { 'BAD KEY': '1' }));
  assert.throws(() => writeEnv(dir, { GOOD: 'a\nb' }));
  assert.deepEqual([...parseEnv('export A=1\nA=2\n#B=3\n')], [['A', '1']]);
});

// ---------- code и secret ----------

test('code: идемпотентен, --rotate меняет код, хэш в .env сходится', async () => {
  const dir = webProject();
  const first = await run(['code', dir, '--json']);
  assert.equal(first.code, 0, first.text);
  const a = JSON.parse(first.text);
  assert.match(a.code, /^[a-z]{3,7}-[a-z]{3,7}-[a-z]{3,7}$/);
  const again = JSON.parse((await run(['code', dir, '--json'])).text);
  assert.equal(again.code, a.code);
  assert.equal(again.hash, a.hash);
  const env = readEnv(dir);
  assert.equal(env.get('SERVICE_ACCESS_CODE'), a.code);
  assert.ok(accessCodeOk(a.code, env.get('SERVICE_ACCESS_CODE_HASH')));
  // Подпись cookie появляется вместе с кодом (вход на компьютере до базы) и дальше не меняется.
  const cookieSecret = env.get('SERVICE_COOKIE_SECRET');
  assert.ok(cookieSecret && cookieSecret.length >= 32);
  const rotated = makeCode(ROOT, dir, { rotate: true });
  assert.notEqual(rotated.code, a.code);
  assert.equal(readEnv(dir).get('SERVICE_ACCESS_CODE'), rotated.code);
  assert.ok(accessCodeOk(rotated.code, readEnv(dir).get('SERVICE_ACCESS_CODE_HASH')));
  assert.equal(readEnv(dir).get('SERVICE_COOKIE_SECRET'), cookieSecret);
});

test('secret: DATABASE_URL с ref и host, пароль не в SQL, без --rotate пароль прежний', async () => {
  const dir = webProject('Мой сервис-продаж');
  const role = roleName(dir);
  assert.equal(role, 'app_moy_servis_prodazh');
  const r1 = await run(['secret', dir, '--ref', REF, '--host', HOST, '--json']);
  assert.equal(r1.code, 0, r1.text);
  const s1 = JSON.parse(r1.text);
  assert.equal(s1.role, role);
  const env = readEnv(dir);
  assert.equal(env.get('DATABASE_URL'), s1.database_url);
  const u = new URL(s1.database_url);
  assert.equal(decodeURIComponent(u.username), `${role}.${REF}`);
  assert.equal(u.hostname, HOST);
  assert.equal(u.port, '6543');
  assert.equal(u.searchParams.get('sslmode'), 'require');
  const password = decodeURIComponent(u.password);
  assert.equal(Buffer.from(password, 'base64url').length, 32);
  assert.ok(!s1.sql.includes(password));
  assert.match(s1.sql, /create role app_moy_servis_prodazh login password 'SCRAM-SHA-256\$4096:/);
  assert.match(s1.sql, /alter role app_moy_servis_prodazh set search_path = app, public;/);
  assert.match(s1.sql, /alter role app_moy_servis_prodazh set statement_timeout = '8s';/);
  assert.match(s1.sql, /revoke all on schema app from anon, authenticated;/);
  const cookie = env.get('SERVICE_COOKIE_SECRET');
  assert.ok(cookie && cookie.length >= 43);
  assert.equal(s1.cookie_secret, cookie);
  const s2 = makeSecret(dir, { ref: REF, host: HOST });
  assert.equal(s2.database_url, s1.database_url);
  assert.equal(s2.changed, false);
  assert.equal(s2.cookie_secret, cookie);
  assert.equal(readEnv(dir).get('SERVICE_COOKIE_SECRET'), cookie);
  const s3 = makeSecret(dir, { ref: REF, host: HOST, port: 5432, rotate: true });
  assert.notEqual(decodeURIComponent(new URL(s3.database_url).password), password);
  assert.equal(new URL(s3.database_url).port, '5432');
  assert.equal(readEnv(dir).get('SERVICE_COOKIE_SECRET'), cookie);
  const bad = await run(['secret', dir, '--host', HOST]);
  assert.equal(bad.code, 2);
});

// ---------- check ----------

test('check: шаблон без замечаний, без lib/web.py замечание «обнови кабинет»', async () => {
  const dir = webProject();
  assert.deepEqual(checkWebProject(ROOT, dir), { ok: true, kind: 'web', problems: [] });
  const r = await run(['check', dir, '--json']);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(JSON.parse(r.text), { ok: true, problems: [] });
  rmSync(join(dir, 'lib', 'web.py'));
  const c = checkWebProject(ROOT, dir);
  assert.equal(c.ok, false);
  assert.ok(c.problems.some((p) => p.file === 'lib/web.py' && /обнови кабинет/.test(p.why)));
});

test('check: ловит каждую запрещённую конструкцию с файлом и строкой', () => {
  const dir = webProject();
  const api = join(dir, 'api', 'index.py');
  const code = readFileSync(api, 'utf8').replace(
    'class handler(serve(',
    [
      'def bad1(data, file):',
      '    return {"rows": query(f"select * from app.zapisi where id = {data[\'id\']}")}',
      '',
      'def bad2(data, file):',
      '    return {"rows": query("select * from app.zapisi where id = %s" % data["id"])}',
      '',
      'def bad3(data, file):',
      '    execute("delete from app.zapisi where id = " + str(data["id"]))',
      '',
      'def bad4(data, file):',
      '    return {"rows": query(',
      '        "select * from app.zapisi where nazvanie = \'{}\'".format(data["n"]),',
      '    )}',
      '',
      'def good(data, file):',
      '    sql = """select * from app.zapisi where a = %s + 1"""',
      '    return {"rows": query("select * from app.zapisi where id = %s and summa > %(s)s", (data["id"],))}',
      '',
      'class handler(serve(',
    ].join('\n'),
  );
  writeFileSync(api, code);
  const lineOf = (needle) => code.split('\n').findIndex((l) => l.includes(needle)) + 1;
  writeFileSync(join(dir, 'helpers.py'), 'import socket\nfrom llm import ask\nimport subprocess\n# import socket\n');
  writeFileSync(
    join(dir, 'public', 'index.html'),
    readFileSync(join(dir, 'public', 'index.html'), 'utf8').replace('</head>', '<script src="https://cdn.example.com/x.js"></script>\n<link rel="stylesheet" href="//fonts.example.com/a.css">\n</head>'),
  );
  writeFileSync(join(dir, 'public', 'extra.css'), 'body { color: red; }\n@import url("https://cdn.example.com/b.css");\n');
  writeFileSync(
    join(dir, 'db', '002_bad.sql'),
    ['-- create table public.ok_in_comment (id int);', 'drop schema app cascade;', 'grant select on app.zapisi to anon;', 'create table zapisi2 (id int);', 'create index idx on public.t (id);', 'create role hacker;', 'create table app.ok (id int);', "grant usage on schema public to app_x;"].join('\n'),
  );
  const c = checkWebProject(ROOT, dir);
  assert.equal(c.ok, false);
  const has = (file, line, re) => assert.ok(c.problems.some((p) => p.file === file && p.line === line && re.test(p.why)), `${file}:${line} ${re}\n${JSON.stringify(c.problems, null, 1)}`);
  has('api/index.py', lineOf('query(f"'), /f-строка/);
  has('api/index.py', lineOf('" % data'), /оператор %/);
  has('api/index.py', lineOf('execute("delete'), /оператор \+/);
  has('api/index.py', lineOf('def bad4') + 1, /\.format/);
  assert.ok(!c.problems.some((p) => p.file === 'api/index.py' && p.line >= lineOf('def good')), 'параметры и строки в тройных кавычках не замечания');
  has('helpers.py', 1, /socket/);
  has('helpers.py', 2, /модель/);
  has('helpers.py', 3, /запуск программ/);
  assert.ok(!c.problems.some((p) => p.file === 'helpers.py' && p.line === 4));
  const htmlLine = readFileSync(join(dir, 'public', 'index.html'), 'utf8').split('\n').findIndex((l) => l.includes('cdn.example.com/x.js')) + 1;
  has('public/index.html', htmlLine, /скрипт с чужого сайта/);
  assert.ok(c.problems.some((p) => p.file === 'public/index.html' && /стиль или шрифт/.test(p.why)));
  has('public/extra.css', 2, /стиль с чужого сайта/);
  has('db/002_bad.sql', 2, /drop schema/);
  has('db/002_bad.sql', 3, /anon/);
  has('db/002_bad.sql', 4, /вне схемы app/);
  has('db/002_bad.sql', 5, /вне схемы app/);
  has('db/002_bad.sql', 6, /роль/);
  assert.ok(!c.problems.some((p) => p.file === 'db/002_bad.sql' && [1, 7, 8].includes(p.line)), JSON.stringify(c.problems));
});

test('check: формат .format в многострочном вызове помечается строкой вызова', () => {
  const src = 'x = 1\nrows = db.query(\n    "select {}"\n    .format(x),\n    (),\n)\ndef query(sql, params=()):\n    return sql + "x"\n';
  assert.deepEqual(sqlProblems(src).map((p) => [p.line, p.glue]), [[2, 'format']]);
  assert.deepEqual(sqlProblems('query("""a + b % c""", (1,))\nquery(r"x" "y")\n'), []);
  assert.deepEqual(sqlProblems("insert_rows(F'app.{t}', cols, rows)\n").map((p) => p.glue), ['fstring']);
  assert.deepEqual(sqlFileProblems('create table if not exists app.a (id int);\nalter table app.a add column b text;\n'), []);
});

test('check в CLI: проблемы код 1, не web код 2, нет папки код 2', async () => {
  const dir = webProject();
  writeFileSync(join(dir, 'db', '003.sql'), 'create table public.x (id int);\n');
  const bad = await run(['check', dir]);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /db\/003\.sql, строка 1: таблица public\.x вне схемы app/);
  const runDir = join(home, `run-${++n}`);
  copyDir(join(ROOT, 'templates', 'service-project'), runDir);
  assert.equal((await run(['check', runDir])).code, 2);
  assert.equal((await run(['check', join(home, 'нет-такой')])).code, 2);
  assert.equal((await run(['непонятно'])).code, 2);
});

// ---------- pii ----------

test('pii: ИИН, телефон и почта по значениям, столбцы по словарю, чистый файл без находок', async () => {
  assert.equal(columnPiiKind('ФИО клиента'), 'ФИО');
  assert.equal(columnPiiKind('E-mail'), 'почта');
  assert.equal(columnPiiKind('telefon'), 'телефон');
  assert.equal(columnPiiKind('Дата рождения'), 'дата рождения');
  assert.equal(columnPiiKind('Наименование'), null);
  assert.equal(valuePiiKind('870101300123'), 'ИИН');
  assert.equal(valuePiiKind('+7 (701) 123-45-67'), 'телефон');
  assert.equal(valuePiiKind('8 701 123 45 67'), 'телефон');
  assert.equal(valuePiiKind('aigul@example.kz'), 'почта');
  assert.equal(valuePiiKind('234 100,00'), null);
  assert.equal(valuePiiKind('87 500 000 000,00'), null);

  const dir = webProject();
  writeFileSync(join(dir, 'input', 'klienty.csv'), 'Клиент;Номер;Контакт;Сумма\nК-1;870101300123;+7 701 123 45 67;100\nК-2;-;aigul@example.kz;200\n');
  writeFileSync(join(dir, 'db', '002_klienty.sql'), 'create table if not exists app.klienty (\n  id serial primary key,\n  fio text,\n  telefon text,\n  summa numeric(14, 2),\n  constraint x unique (fio)\n);\n');
  const r = await findPii(ROOT, dir, { python });
  const got = r.found.map((x) => `${x.where}|${x.column}|${x.kind}`).sort();
  assert.deepEqual(got, [
    'db/002_klienty.sql|fio|ФИО',
    'db/002_klienty.sql|telefon|телефон',
    'input/klienty.csv|Контакт|почта',
    'input/klienty.csv|Контакт|телефон',
    'input/klienty.csv|Номер|ИИН',
  ]);
  const cli = await run(['pii', dir, '--json']);
  assert.equal(cli.code, 1);
  assert.equal(JSON.parse(cli.text).found.length, 5);

  const clean = webProject();
  writeFileSync(join(clean, 'input', 'prodazhi.csv'), 'Точка;Сумма\nМега;234 100,00\nКеруен;12\n');
  const ok = await run(['pii', clean, '--json']);
  assert.equal(ok.code, 0, ok.text);
  assert.deepEqual(JSON.parse(ok.text), { found: [], unread: [] });
});

// ---------- status и save-account ----------

test('status: вид, публикация и какие ключи есть, без значений', async () => {
  const dir = webProject();
  makeCode(ROOT, dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = await run(['status', dir, '--json']);
  assert.equal(r.code, 0, r.text);
  const s = JSON.parse(r.text);
  assert.equal(s.kind, 'web');
  assert.equal(s.template_version, '2026-11-12');
  assert.equal(s.published, false);
  assert.deepEqual(s.env, { DATABASE_URL: false, SERVICE_ACCESS_CODE: true, SERVICE_ACCESS_CODE_HASH: true, SERVICE_COOKIE_SECRET: true });
  assert.ok(!r.text.includes(readEnv(dir).get('SERVICE_ACCESS_CODE')));
  assert.equal(s.git.repo, true);
  assert.equal(s.git.remote, null);
  assert.equal(s.git.dirty, true);
  const svc = JSON.parse(readFileSync(join(dir, 'service.json'), 'utf8'));
  svc.publish = { url: 'https://moy-servis.vercel.app' };
  writeFileSync(join(dir, 'service.json'), JSON.stringify(svc));
  assert.equal((await webStatus(dir)).published, true);
});

test('save-account пишет me/publikaciya.json кабинета', () => {
  const cab = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(cab, { recursive: true });
  const d = saveAccount(cab, { github: 'aigul-n', vercelTeam: 'team_e4Y8abc', supabaseOrg: 'uqjajvttsouimsktxwxd' });
  const saved = JSON.parse(readFileSync(join(cab, 'me', 'publikaciya.json'), 'utf8'));
  assert.deepEqual(saved, d);
  assert.equal(saved.region, 'eu-central-1');
  assert.ok(!Number.isNaN(Date.parse(saved.checked_at)));
  assert.throws(() => saveAccount(cab, { github: 'bad login', vercelTeam: 'x', supabaseOrg: 'y' }));
});

// ---------- migrate-plan ----------

test('migrate-plan: таблица по выгрузке продаж со столбцами и типами', async () => {
  const dir = join(home, `svodka-${++n}`);
  copyDir(join(ROOT, 'templates', 'service-project'), dir);
  mkdirSync(join(dir, 'input'), { recursive: true });
  copyFileSync(join(ROOT, 'input', 'case', 'data', 'prodazhi_1c.csv'), join(dir, 'input', 'prodazhi_1c.csv'));
  const r = await run(['migrate-plan', dir, '--json']);
  assert.equal(r.code, 0, r.text);
  const plan = JSON.parse(r.text);
  assert.equal(plan.tables.length, 1);
  const t = plan.tables[0];
  assert.equal(t.table, 'prodazhi_1c');
  assert.equal(t.file, 'input/prodazhi_1c.csv');
  const types = Object.fromEntries(t.columns.map((c) => [c.name, c.type]));
  assert.equal(types.data, 'date');
  assert.equal(types.tochka, 'text');
  assert.equal(types.summa_tg, 'numeric');
  assert.equal(types.kolichestvo, 'numeric');
  assert.match(t.sql, /^create table if not exists app\.prodazhi_1c \(\n {2}id serial primary key,/);
  assert.equal(plan.page, false);
  assert.equal(plan.api, false);
  assert.equal(plan.llm, false, 'каркас main.py держит ask_model про запас, но модель не зовёт');
  assert.equal(guessType(['1', 'н/д', '2,5']), 'numeric');
  assert.equal((await migratePlan(ROOT, dir, { python })).tables.length, 1);
  assert.equal((await run(['migrate-plan', webProject()])).code, 2);
  // Отдельным процессом, как зовут скиллы: поиск Python не должен зависать на круговом импорте (check.mjs).
  const cli = spawnSync(process.execPath, [join(ROOT, 'tools', 'web.mjs'), 'migrate-plan', dir, '--json'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(cli.status, 0, `${cli.stdout}${cli.stderr}`);
  assert.equal(JSON.parse(cli.stdout).tables.length, 1);
});

test('usesModel: вызов llm.ask( или ask_model( вне самой функции ask_model', () => {
  const tpl = readFileSync(join(ROOT, 'templates', 'service-project', 'main.py'), 'utf8');
  assert.equal(usesModel(tpl), false);
  assert.equal(usesModel(`${tpl}\n\ndef extra():\n    text, why = ask_model("Кратко", "данные")\n`), true);
  assert.equal(usesModel('import llm\nprint(llm.ask("вопрос"))\n'), true);
  assert.equal(usesModel('def ask_model(a,\n              b=""):\n    return llm.ask(a, b)\n\n# ask_model("x")\nprint(1)\n'), false);
  assert.equal(usesModel('import llm\n'), false);
});

test('firstAction: первое действие из serve({...})', () => {
  assert.equal(firstAction(readFileSync(join(ROOT, 'templates', 'web-service', 'api', 'index.py'), 'utf8')), 'zapisi');
  assert.equal(firstAction('handler = serve({\n  "otchet-den": f,\n})'), 'otchet-den');
  assert.equal(firstAction('x = 1'), null);
});

test('check пропускает папку old/', () => {
  const dir = webProject();
  mkdirSync(join(dir, 'old'), { recursive: true });
  writeFileSync(join(dir, 'old', 'main.py'), 'import subprocess\nimport llm\n');
  assert.equal(checkWebProject(ROOT, dir).ok, true);
});

// ---------- dev ----------

function request(url, { method = 'GET', body, cookie } = {}) {
  return new Promise((done, fail) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (data) req.write(data);
    req.end();
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

test('dev: страница шаблона на компьютере, вход по коду, один процесс на проект', { timeout: 60000 }, async () => {
  const dir = webProject(`dev-${++n}`, { vendor: true });
  const { code } = makeCode(ROOT, dir);
  writeEnv(dir, { SERVICE_COOKIE_SECRET: randomBytes(32).toString('base64url') });
  let pid = null;
  try {
    const first = await startDev(ROOT, dir, { python, env: { WEB_DB_FAKE: '1' } });
    pid = first.pid;
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(first.already, false);
    assert.equal((await request(`${first.url}api/health`)).status, 200);
    assert.equal((await request(`${first.url}api/zapisi`, { method: 'POST', body: {} })).status, 401);
    const login = await request(`${first.url}api/login`, { method: 'POST', body: { code: code.toUpperCase() } });
    assert.equal(login.status, 200, login.text);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const rows = await request(`${first.url}api/zapisi`, { method: 'POST', body: {}, cookie });
    assert.equal(rows.status, 200, rows.text);
    assert.ok(Array.isArray(JSON.parse(rows.text).rows));
    const second = await startDev(ROOT, dir, { python, env: { WEB_DB_FAKE: '1' } });
    assert.deepEqual(second, { url: first.url, pid: first.pid, already: true });
    const [a, b] = await Promise.all([startDev(ROOT, dir, { python }), startDev(ROOT, dir, { python })]);
    assert.equal(a.pid, first.pid);
    assert.equal(b.pid, first.pid);
    const st = await run(['status', dir, '--json']);
    assert.equal(JSON.parse(st.text).dev.url, first.url);

    // verify: по адресу из --url, затем по подменённому publish.url; лишние файлы в git и пустой publish видны.
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    const v1 = JSON.parse((await run(['verify', dir, '--url', first.url, '--json'])).text);
    const byId = (v) => Object.fromEntries(v.checks.map((c) => [c.id, c.ok]));
    assert.deepEqual(byId(v1), { 'git-files': true, publish: false, health: true, closed: true }, JSON.stringify(v1));
    const svc = JSON.parse(readFileSync(join(dir, 'service.json'), 'utf8'));
    svc.publish = { url: first.url, github: 'aigul-n/dev', vercel_project: 'dev', supabase_ref: REF, published_at: '2026-11-12T07:00:00+05:00', db_host: HOST };
    writeFileSync(join(dir, 'service.json'), JSON.stringify(svc, null, 2));
    const v2 = await run(['verify', dir, '--json']);
    assert.equal(v2.code, 0, v2.text);
    assert.equal(JSON.parse((await run(['status', dir, '--json'])).text).publish.db_host, HOST);
    spawnSync('git', ['add', '-f', '.env'], { cwd: dir });
    const v3 = await run(['verify', dir, '--json']);
    assert.equal(v3.code, 1);
    assert.match(JSON.parse(v3.text).checks.find((c) => c.id === 'git-files').detail, /\.env/);
    spawnSync('git', ['rm', '-q', '--cached', '.env'], { cwd: dir });

    // Автоматический API Supabase: пустой ответ закрыт, строки в ответе: замечание.
    let restRows = '[]';
    const fake = http.createServer((req, res) => {
      res.writeHead(req.headers.apikey === 'anon-key' && req.url.startsWith('/rest/v1/zapisi') ? 200 : 403, { 'Content-Type': 'application/json' });
      res.end(restRows);
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    try {
      const env = { SUPABASE_URL: `http://127.0.0.1:${fake.address().port}`, SUPABASE_ANON_KEY: 'anon-key' };
      const ok = await verifyWeb(dir, { env });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.ok(ok.checks.some((c) => c.id === 'supabase-rest' && c.ok));
      restRows = '[{"id":1}]';
      const leak = await verifyWeb(dir, { env });
      assert.equal(leak.ok, false);
      assert.ok(leak.checks.some((c) => c.id === 'supabase-rest' && !c.ok));
    } finally {
      fake.close();
    }
  } finally {
    const r = await stopDev(dir);
    if (pid) assert.equal(r.stopped, true);
  }
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false, 'процесс страницы остановлен');
  assert.equal((await stopDev(dir)).stopped, false);
});

test('check: вход строкой handler = serve(...) Vercel не находит, нужен класс', () => {
  const dir = webProject();
  const api = join(dir, 'api', 'index.py');
  writeFileSync(api, readFileSync(api, 'utf8').replace(/class handler\(serve\((\{[^}]*\})\)\):\n\s+"""[^\n]*\n/, 'handler = serve($1)\n'));
  const r = checkWebProject(ROOT, dir);
  assert.ok(r.problems.some((p) => p.why.includes('class handler')), JSON.stringify(r.problems));
});
