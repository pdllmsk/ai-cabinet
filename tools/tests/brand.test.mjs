import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { BRAND_ENV, brandCandidates, findBrandDir } from '../brand.mjs';
import { createCabinetServer, listenFirstFree } from '../serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const T = `/${TOKEN}`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

let base;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'brand-'));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

// Папка с файлами: { 'theme.css': '...', ... }. Путь с кириллицей и пробелом, как в профиле Windows.
function folder(name, files = {}) {
  const dir = join(base, 'Айгуль Н', name);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

test('порядок поиска: site/brand, на Windows %PUBLIC%\\ai-cabinet-brand, затем AI_CABINET_BRAND_DIR, бренд курса последним', () => {
  const root = join(base, 'Айгуль Н', 'кабинет');
  assert.deepEqual(brandCandidates(root, { env: {}, platform: 'darwin' }), [join(root, 'site', 'brand'), join(root, 'templates', 'brand')]);
  assert.deepEqual(brandCandidates(root, { env: { [BRAND_ENV]: '/x/y', PUBLIC: '/pub' }, platform: 'linux' }), [
    join(root, 'site', 'brand'),
    resolve('/x/y'),
    join(root, 'templates', 'brand'),
  ]);
  assert.deepEqual(brandCandidates(root, { env: { [BRAND_ENV]: '/x/y', PUBLIC: '/pub' }, platform: 'win32' }), [
    join(root, 'site', 'brand'),
    join('/pub', 'ai-cabinet-brand'),
    resolve('/x/y'),
    join(root, 'templates', 'brand'),
  ]);
  // Без переменной PUBLIC: папка Public на системном диске.
  const [, pub] = brandCandidates(root, { env: {}, platform: 'win32' });
  assert.ok(pub.startsWith('C:\\Users\\Public'), pub);
  assert.ok(pub.endsWith('ai-cabinet-brand'), pub);
});

test('findBrandDir: первая папка, где есть файл бренда; пустая и несуществующая пропускаются', () => {
  const root = folder('кабинет 1');
  const pub = folder('Public 1');
  const own = folder('свой бренд 1', { 'theme.css': ':root{}' });
  const env = { PUBLIC: pub, [BRAND_ENV]: own };
  // Нигде нет файлов бренда: нейтральная страница.
  assert.equal(findBrandDir(root, { env: {}, platform: 'win32' }), null);
  assert.equal(findBrandDir(root, { env: { [BRAND_ENV]: join(base, 'нет такой') }, platform: 'darwin' }), null);
  // Только переменная окружения.
  assert.equal(findBrandDir(root, { env, platform: 'win32' }), own);
  // Папка Public на Windows важнее переменной; не на Windows она не ищется.
  folder('Public 1/ai-cabinet-brand', { 'logo.svg': SVG });
  assert.equal(findBrandDir(root, { env, platform: 'win32' }), join(pub, 'ai-cabinet-brand'));
  assert.equal(findBrandDir(root, { env, platform: 'darwin' }), own);
  // Пустая site/brand (или с чужими файлами) не перекрывает общую папку.
  mkdirSync(join(root, 'site', 'brand'), { recursive: true });
  writeFileSync(join(root, 'site', 'brand', 'zametka.txt'), 'не файл бренда');
  assert.equal(findBrandDir(root, { env, platform: 'win32' }), join(pub, 'ai-cabinet-brand'));
  // site/brand с файлом бренда важнее всех.
  writeFileSync(join(root, 'site', 'brand', 'brand.json'), '{"name": "Своё"}');
  assert.equal(findBrandDir(root, { env, platform: 'win32' }), join(root, 'site', 'brand'));
  // Файл вместо папки не считается папкой бренда.
  const file = join(base, 'Айгуль Н', 'файл.css');
  writeFileSync(file, ':root{}');
  assert.equal(findBrandDir(folder('кабинет 2'), { env: { [BRAND_ENV]: file }, platform: 'darwin' }), null);
});

// http.get без нормализации пути (fetch схлопывает /../).
function get(port, path, method = 'GET') {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rej);
    req.end();
  });
}

async function withCabinet(brand, fn) {
  const cab = folder(`кабинет ${Math.random().toString(16).slice(2, 8)}`);
  copyDir(join(ROOT, 'templates', 'site'), join(cab, 'site'));
  writeFileSync(join(cab, 'CLAUDE.md'), 'секретные правила кабинета');
  const server = createCabinetServer(cab, { token: TOKEN, brand });
  const port = await listenFirstFree(server, { from: 18800, to: 18899 });
  try {
    return await fn(port, cab);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  }
}

test('сервер: theme.css, logo.svg, logo.png, brand.json из папки бренда с кириллицей и пробелом в пути', async () => {
  const dir = folder('бренд компании', {
    'theme.css': ':root { --accent: #123456; }',
    'logo.svg': SVG,
    'logo.png': 'PNG',
    'brand.json': '{"name": "Компания"}',
  });
  await withCabinet(() => dir, async (port) => {
    const css = await get(port, `${T}/brand/theme.css`);
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.match(css.body, /--accent: #123456/);
    const svg = await get(port, `${T}/brand/logo.svg`);
    assert.equal(svg.status, 200);
    assert.equal(svg.headers['content-type'], 'image/svg+xml');
    // SVG, открытый отдельной вкладкой, не выполняет скрипты в адресе страницы.
    assert.equal(svg.headers['content-security-policy'], 'sandbox');
    assert.equal(svg.headers['x-content-type-options'], 'nosniff');
    assert.equal(svg.headers['cache-control'], 'no-store');
    assert.equal((await get(port, `${T}/brand/logo.png`)).headers['content-type'], 'image/png');
    const json = await get(port, `${T}/brand/brand.json`);
    assert.equal(json.status, 200);
    assert.deepEqual(JSON.parse(json.body), { name: 'Компания' });
    // HEAD тоже чтение; запись нельзя.
    assert.equal((await get(port, `${T}/brand/theme.css`, 'HEAD')).status, 200);
    assert.equal((await get(port, `${T}/brand/theme.css`, 'POST')).status, 405);
    // Страница рядом работает как обычно.
    const page = await get(port, `${T}/`);
    assert.equal(page.status, 200);
    assert.match(page.body, /href="brand\/theme\.css"/);
  });
});

test('сервер: без токена или с чужим токеном файлы бренда не отдаются', async () => {
  const dir = folder('бренд токен', { 'theme.css': ':root{}', 'logo.svg': SVG });
  await withCabinet(() => dir, async (port) => {
    for (const p of ['/brand/theme.css', '/brand/logo.svg', `/${TOKEN.slice(0, -1)}0/brand/theme.css`]) {
      const r = await get(port, p);
      assert.equal(r.status, 403, p);
      assert.doesNotMatch(r.body, /:root/, p);
    }
  });
});

test('сервер: из папки бренда только .css, .svg, .png, .json; вложенные папки и скрытые файлы нет', async () => {
  const dir = folder('бренд расширения', {
    'theme.css': ':root{}',
    'script.js': 'alert(1)',
    'page.html': '<p>страница</p>',
    'notes.txt': 'заметка',
    'README.md': '# readme',
    'photo.jpg': 'JPG',
    '.hidden.css': ':root{}',
    'theme.css.bak': ':root{}',
  });
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'x.css'), ':root{}');
  // Папка с именем файла бренда: не отдаётся и не открывает свой index.html.
  mkdirSync(join(dir, 'papka.css'), { recursive: true });
  writeFileSync(join(dir, 'papka.css', 'index.html'), '<p>индекс</p>');
  await withCabinet(() => dir, async (port) => {
    for (const name of ['script.js', 'page.html', 'notes.txt', 'README.md', 'photo.jpg', '.hidden.css', 'theme.css.bak',
      'sub/x.css', 'sub%2fx.css', 'papka.css', 'papka.css/index.html', '', 'theme.css%00.js', 'theme.css.']) {
      const r = await get(port, `${T}/brand/${name}`);
      assert.equal(r.status, 404, name);
      assert.match(r.body, /[А-Яа-я]/, name);
      assert.doesNotMatch(r.body, /alert|страница|заметка|readme|индекс|JPG/, name);
    }
    assert.equal((await get(port, `${T}/brand`)).status, 404);
  });
});

test('сервер: выход за папку бренда (.., %2e%2e, обратная косая) не отдаёт файлы снаружи', async () => {
  const dir = folder('бренд выход', { 'theme.css': ':root{}' });
  writeFileSync(join(dirname(dir), 'secret.css'), 'секрет снаружи');
  await withCabinet(() => dir, async (port, cab) => {
    writeFileSync(join(cab, 'site', 'secret.json'), '"секрет сайта"');
    for (const p of [
      `${T}/brand/../secret.css`,
      `${T}/brand/..%2fsecret.css`,
      `${T}/brand/%2e%2e%2fsecret.css`,
      `${T}/brand/%2e%2e/secret.css`,
      `${T}/brand/..%5csecret.css`,
      `${T}/brand/..%5c..%5cCLAUDE.md`,
      `${T}/brand/%2e%2e%2f%2e%2e%2fCLAUDE.md`,
      `${T}/brand/${encodeURIComponent(join(dirname(dir), 'secret.css'))}`,
    ]) {
      const r = await get(port, p);
      // Буквальное /../ и %2e%2e разбор адреса схлопывает до пути в site/: там такого файла нет, тоже 404.
      assert.ok([403, 404].includes(r.status), `${p}: ${r.status}`);
      assert.doesNotMatch(r.body, /секрет|секретные/, p);
    }
  });
});

test('сервер: ссылка из папки бренда наружу не отдаётся, ссылка внутри папки отдаётся', async (t) => {
  const dir = folder('бренд ссылки', { 'theme.css': ':root{}', 'logo.svg': SVG });
  const outside = join(dirname(dir), 'снаружи.css');
  writeFileSync(outside, 'секрет снаружи');
  try {
    symlinkSync(outside, join(dir, 'evil.css'));
    symlinkSync(join(dir, 'logo.svg'), join(dir, 'alias.svg'));
  } catch (e) {
    return t.skip(`символические ссылки на файлы недоступны (${e.code})`);
  }
  await withCabinet(() => dir, async (port) => {
    const evil = await get(port, `${T}/brand/evil.css`);
    assert.equal(evil.status, 404);
    assert.doesNotMatch(evil.body, /секрет/);
    assert.equal((await get(port, `${T}/brand/alias.svg`)).status, 200);
  });
});

test('сервер: папки бренда нет: 404 на brand/, страница отдаётся; папку можно положить без перезапуска', async () => {
  let dir = null;
  await withCabinet(() => dir, async (port) => {
    const r = await get(port, `${T}/brand/theme.css`);
    assert.equal(r.status, 404);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal((await get(port, `${T}/`)).status, 200);
    dir = folder('бренд позже', { 'theme.css': ':root{--accent:#000}' });
    assert.equal((await get(port, `${T}/brand/theme.css`)).status, 200);
  });
});

test('сервер по умолчанию ищет бренд в site/brand кабинета; там тоже только файлы бренда', async () => {
  await withCabinet(undefined, async (port, cab) => {
    assert.equal((await get(port, `${T}/brand/theme.css`)).status, 404);
    mkdirSync(join(cab, 'site', 'brand'), { recursive: true });
    writeFileSync(join(cab, 'site', 'brand', 'theme.css'), ':root{--accent:#010203}');
    writeFileSync(join(cab, 'site', 'brand', 'x.js'), 'alert(1)');
    const r = await get(port, `${T}/brand/theme.css`);
    assert.equal(r.status, 200);
    assert.match(r.body, /#010203/);
    for (const p of [`${T}/brand/x.js`, `${T}/BRAND/x.js`, `${T}/Brand/x.js`]) {
      assert.equal((await get(port, p)).status, 404, p);
    }
  });
});

test('CLI brand.mjs: называет найденную папку и файлы или где искал', () => {
  const cab = folder('кабинет cli');
  copyDir(join(ROOT, 'tools'), join(cab, 'tools'));
  const dir = folder('бренд cli', { 'theme.css': ':root{}', 'logo.svg': SVG });
  // Папка Public без бренда: на Windows, где бренд уже лежит в C:\Users\Public, тест не зависит от него.
  const env = { ...process.env, [BRAND_ENV]: dir, PUBLIC: folder('Public cli') };
  let r = spawnSync(process.execPath, [join(cab, 'tools', 'brand.mjs')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`Папка бренда: ${dir}`), r.stdout);
  assert.match(r.stdout, /Файлы: theme\.css, logo\.svg/);
  delete env[BRAND_ENV];
  r = spawnSync(process.execPath, [join(cab, 'tools', 'brand.mjs')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Папка бренда не найдена: страница в нейтральных цветах/);
  assert.ok(r.stdout.includes(join(cab, 'site', 'brand')), r.stdout);
  assert.doesNotMatch(r.stdout, /[\u2012-\u2015]/);
});

test('бренд курса в templates/brand: файлы на месте; без других папок кабинет берёт его', () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const f of ['logo.svg', 'theme.css', 'brand.json']) assert.ok(existsSync(join(repo, 'templates', 'brand', f)), f);
  const root = join(base, 'кабинет с брендом курса');
  mkdirSync(join(root, 'templates', 'brand'), { recursive: true });
  writeFileSync(join(root, 'templates', 'brand', 'theme.css'), ':root{}');
  assert.equal(findBrandDir(root, { env: {}, platform: 'darwin' }), join(root, 'templates', 'brand'));
  // Своя папка участника важнее бренда курса.
  mkdirSync(join(root, 'site', 'brand'), { recursive: true });
  writeFileSync(join(root, 'site', 'brand', 'logo.svg'), '<svg/>');
  assert.equal(findBrandDir(root, { env: {}, platform: 'darwin' }), join(root, 'site', 'brand'));
});
