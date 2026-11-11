import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDir } from './copy-dir.mjs';
import { createSiteServer, listenFirstFree, listenFixed, describeListenError, portForUser, newPageToken, twinServer } from '../serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'templates', 'site');
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const T = `/${TOKEN}`;

function close(server) {
  return new Promise((res) => server.close(() => res()));
}

async function withServer(dir, fn) {
  const server = createSiteServer(dir, { token: TOKEN });
  const port = await listenFirstFree(server, { from: 18500, to: 18599 });
  try {
    return await fn(port);
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
}

// http.get без нормализации пути (fetch схлопывает /../).
function get(port, path) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port, path, agent: false }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () =>
          res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      })
      .on('error', rej);
  });
}

test('отдаёт index.html с text/html; charset=utf-8 и маркером', async () => {
  await withServer(SITE, async (port) => {
    const r = await get(port, `${T}/`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(r.body, /data-cabinet="ok"/);
  });
});

test('файл с кириллицей и пробелом в имени и в пути корня', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cab-'));
  try {
    const dir = join(tmp, 'Айгуль Н', 'site');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'тест страница.html'), '<p>привет</p>');
    await withServer(dir, async (port) => {
      const r = await get(port, encodeURI(`${T}/тест страница.html`));
      assert.equal(r.status, 200);
      assert.equal(r.body, '<p>привет</p>');
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('выход за корень запрещён', async () => {
  const secret = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  await withServer(SITE, async (port) => {
    for (const p of [`${T}/../../CLAUDE.md`, `${T}/%2e%2e%2f%2e%2e%2fCLAUDE.md`, `${T}/..%2f..%2fCLAUDE.md`, `${T}/../CLAUDE.md`, `${T}/..%2fCLAUDE.md`]) {
      const r = await get(port, p);
      // Буквальные /../ браузерный разбор адреса схлопывает до пути без токена: 403, тоже безопасно.
      assert.ok(r.status === 404 || (r.status === 403 && !p.includes('%')), `${p}: ${r.status}`);
      assert.ok(!r.body.includes(secret.trim().slice(0, 20)), p);
    }
  });
});

test('нет файла: 404 с русским текстом', async () => {
  await withServer(SITE, async (port) => {
    const r = await get(port, `${T}/net-takogo.html`);
    assert.equal(r.status, 404);
    assert.match(r.body, /[А-Яа-я]/);
  });
});

test('порт занят: берёт следующий', async () => {
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18700, '127.0.0.1', res));
  const server = createSiteServer(SITE, { token: TOKEN });
  try {
    const port = await listenFirstFree(server, { from: 18700, to: 18710 });
    assert.equal(port, 18701);
  } finally {
    await close(server);
    await close(blocker);
  }
});

test('все порты диапазона заняты: порт выбирает система', async () => {
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18720, '127.0.0.1', res));
  const server = createSiteServer(SITE, { token: TOKEN });
  try {
    const port = await listenFirstFree(server, { from: 18720, to: 18720 });
    assert.notEqual(port, 18720);
    assert.equal(server.address().port, port);
    assert.equal((await get(port, `${T}/`)).status, 200);
  } finally {
    server.closeAllConnections?.();
    await close(server);
    await close(blocker);
  }
});

test('диапазон занят и система не дала порт: русская ошибка с диапазоном', async () => {
  const server = createSiteServer(SITE, { token: TOKEN });
  server.listen = () => {
    process.nextTick(() => server.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })));
    return server;
  };
  await assert.rejects(
    listenFirstFree(server, { from: 18721, to: 18722 }),
    (e) => e instanceof Error && /18721/.test(e.message) && /[А-Яа-я]/.test(e.message),
  );
});

test('порт, зарезервированный системой (EACCES): пропускается', async () => {
  const server = createSiteServer(SITE, { token: TOKEN });
  const realListen = server.listen.bind(server);
  server.listen = (port, ...rest) => {
    if (port === 18730) {
      process.nextTick(() => server.emit('error', Object.assign(new Error('listen EACCES'), { code: 'EACCES' })));
      return server;
    }
    return realListen(port, ...rest);
  };
  try {
    assert.equal(await listenFirstFree(server, { from: 18730, to: 18735 }), 18731);
  } finally {
    await close(server);
  }
});

test('describeListenError: русские фразы с кодом в скобках', () => {
  for (const code of ['EADDRINUSE', 'EACCES', 'EPERM', 'EADDRNOTAVAIL', 'EWHATEVER']) {
    const m = describeListenError({ code, message: 'english text' }, 8080);
    assert.match(m, /[А-Яа-я]/, code);
    assert.ok(m.endsWith(`(${code})`), code);
    assert.ok(!m.includes('english text'), code);
  }
  assert.match(describeListenError({ code: 'EADDRINUSE' }, 8080), /занят.*--port 8081/);
  assert.ok(!describeListenError({ code: 'EADDRINUSE' }, 65535).includes('--port'));
  assert.match(describeListenError({ message: 'english' }, 80), /Не удалось/);
});

test('CLI --port на занятом порту: русское сообщение и exit 1', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'busy-'));
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18740, '127.0.0.1', res));
  try {
    // Копия кабинета во временной папке: сервер создаёт файлы участника из шаблонов, в репозитории их оставлять нельзя.
    copyDir(join(ROOT, 'tools'), join(tmp, 'tools'));
    copyDir(join(ROOT, 'templates'), join(tmp, 'templates'));
    const r = spawnSync(process.execPath, [join(tmp, 'tools', 'serve.mjs'), '--port', '18740'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /занят/);
    assert.match(r.stderr, /--port 18741/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await close(blocker);
  }
});

test('portForUser: стабилен, в диапазоне 20000-29999, без учёта регистра', () => {
  for (const name of ['dima', 'Айгуль', 'user1', 'user2', 'Администратор', 'a', '']) {
    const p = portForUser(name);
    assert.ok(Number.isInteger(p) && p >= 20000 && p <= 29999, `${name}: ${p}`);
    assert.equal(portForUser(name), p, name);
  }
  assert.equal(portForUser('Айгуль'), portForUser('айгуль'));
  assert.notEqual(portForUser('user1'), portForUser('user2'));
});

test('без токена в пути: 403 с русским текстом, файлы не отдаются', async () => {
  await withServer(SITE, async (port) => {
    for (const p of ['/', '/index.html', '/wrong-token/', `/${TOKEN.slice(0, -1)}x/`, `/${TOKEN}x/`]) {
      const r = await get(port, p);
      assert.equal(r.status, 403, p);
      assert.match(r.body, /только по своей ссылке/, p);
      assert.match(r.body, /Скажите Claude «открой страницу»\./, p);
      assert.doesNotMatch(r.body, /node|serve\.mjs|[\u2012-\u2015]/, p);
      assert.ok(!r.body.includes('data-cabinet'), p);
    }
  });
});

test('с токеном: 200; без слэша на конце: 301 на /<token>/', async () => {
  await withServer(SITE, async (port) => {
    assert.equal((await get(port, `${T}/`)).status, 200);
    assert.equal((await get(port, `${T}/index.html`)).status, 200);
    const r = await get(port, T);
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, `${T}/`);
  });
});

test('createSiteServer требует токен', () => {
  assert.throws(() => createSiteServer(SITE), /токен/i);
  assert.throws(() => createSiteServer(SITE, { token: '' }), /токен/i);
});

test('api-обработчик получает путь после /<token>/api/ и может ответить сам', async () => {
  const seen = [];
  const server = createSiteServer(SITE, {
    token: TOKEN,
    api: async (req, res, sub) => {
      seen.push(sub);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('api ok');
    },
  });
  const port = await listenFirstFree(server, { from: 18560, to: 18579 });
  try {
    const r = await get(port, `${T}/api/processes`);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'api ok');
    assert.deepEqual(seen, ['processes']);
    assert.equal((await get(port, '/api/processes')).status, 403);
  } finally {
    server.closeAllConnections?.();
    await close(server);
  }
});

test('listenFirstFree: начинает с start и идёт по кругу внутри диапазона', async () => {
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(18752, '127.0.0.1', res));
  const server = createSiteServer(SITE, { token: TOKEN });
  try {
    assert.equal(await listenFirstFree(server, { from: 18750, to: 18754, start: 18752 }), 18753);
  } finally {
    await close(server);
    await close(blocker);
  }
  const b2 = http.createServer();
  await new Promise((res) => b2.listen(18754, '127.0.0.1', res));
  const s2 = createSiteServer(SITE, { token: TOKEN });
  try {
    assert.equal(await listenFirstFree(s2, { from: 18750, to: 18754, start: 18754 }), 18750);
  } finally {
    await close(s2);
    await close(b2);
  }
});

// IPv6 на петле: есть ли [::1] в этой системе.
async function hasIpv6() {
  const probe = http.createServer();
  try {
    await new Promise((res, rej) => {
      probe.once('error', rej);
      probe.listen(0, '::1', res);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (probe.listening) await close(probe);
  }
}

function get6(port, path) {
  return new Promise((res, rej) => {
    http
      .get({ host: '::1', family: 6, port, path, agent: false }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      })
      .on('error', rej);
  });
}

test('newPageToken: 32 hex, каждый раз новый', () => {
  const a = newPageToken();
  const b = newPageToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.match(b, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('twin: тот же порт на 127.0.0.1 и [::1], на обоих тот же обработчик с токеном', async (t) => {
  if (!(await hasIpv6())) return t.skip('IPv6 на петле нет');
  const server = createSiteServer(SITE, { token: TOKEN });
  const twin = twinServer(server);
  try {
    const port = await listenFirstFree(server, { from: 18760, to: 18769, twin });
    assert.equal(twin.address().port, port);
    assert.equal(twin.address().address, '::1');
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal((await get6(port, `${T}/`)).status, 200);
    assert.equal((await get6(port, '/')).status, 403);
    assert.equal((await get(port, `${T}/`)).status, 200);
  } finally {
    for (const s of [server, twin]) {
      s.closeAllConnections?.();
      if (s.listening) await close(s);
    }
  }
});

test('[::1] того же порта занят чужой программой: порт пропускается на обоих адресах', async (t) => {
  if (!(await hasIpv6())) return t.skip('IPv6 на петле нет');
  // Чужая программа слушает только [::1]:18770 и ждёт адрес с токеном.
  const thief = http.createServer((req, res) => res.end('чужой'));
  await new Promise((res) => thief.listen(18770, '::1', res));
  const server = createSiteServer(SITE, { token: TOKEN });
  const twin = twinServer(server);
  try {
    const port = await listenFirstFree(server, { from: 18770, to: 18775, twin });
    assert.equal(port, 18771);
    assert.equal(twin.address().port, 18771);
    await assert.rejects(listenFixed(createSiteServer(SITE, { token: TOKEN }), 18770, { twin: twinServer(server) }), (e) => e.code === 'EADDRINUSE');
  } finally {
    for (const s of [server, twin, thief]) {
      s.closeAllConnections?.();
      if (s.listening) await close(s);
    }
  }
});

test('CLI: адрес с 127.0.0.1 и токеном, 403 без него; новый запуск: новый токен, старый получает 403', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const tmp = mkdtempSync(join(tmpdir(), 'cli-'));
  try {
    copyDir(join(ROOT, 'tools'), join(tmp, 'tools'));
    copyDir(join(ROOT, 'templates'), join(tmp, 'templates'));
    // Файл токена от прошлой версии кабинета: новый запуск его не читает и удаляет.
    mkdirSync(join(tmp, 'me'), { recursive: true });
    writeFileSync(join(tmp, 'me', 'page-token.txt'), `${TOKEN}\n`);
    const run = () =>
      new Promise((res, rej) => {
        const c = spawn(process.execPath, [join(tmp, 'tools', 'serve.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        c.stdout.on('data', (d) => {
          out += d;
          const m = /http:\/\/127\.0\.0\.1:(\d+)\/([0-9a-f]{32})\//.exec(out);
          if (m) res({ c, out, port: Number(m[1]), token: m[2] });
        });
        c.on('error', rej);
        c.on('close', () => rej(new Error(`serve завершился: ${out}`)));
      });
    const stop = async (x) => {
      x.c.removeAllListeners('close');
      const closed = new Promise((r) => x.c.once('close', r));
      x.c.kill();
      await closed;
    };
    const one = await run();
    try {
      assert.doesNotMatch(one.out, /localhost/);
      assert.notEqual(one.token, TOKEN);
      assert.equal((await get(one.port, `/${one.token}/`)).status, 200);
      assert.equal((await get(one.port, '/')).status, 403);
      assert.equal((await get(one.port, `/${TOKEN}/`)).status, 403);
      assert.ok(!existsSync(join(tmp, 'me', 'page-token.txt')), 'файл токена от прошлой версии остался');
      // Тот же номер на [::1] тоже держит страница: адрес localhost у браузера не уйдёт чужой программе.
      if (await hasIpv6()) assert.equal((await get6(one.port, `/${one.token}/`)).status, 200);
    } finally {
      await stop(one);
    }
    const two = await run();
    try {
      assert.notEqual(two.token, one.token);
      assert.equal((await get(two.port, `/${two.token}/`)).status, 200);
      // Старая вкладка со старым токеном на том же или другом порту ничего не получает.
      assert.equal((await get(two.port, `/${one.token}/`)).status, 403);
      assert.equal((await get(two.port, `/${one.token}/api/processes`)).status, 403);
      assert.ok(!existsSync(join(tmp, 'me', 'page-token.txt')), 'токен записан в файл');
    } finally {
      await stop(two);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ui: файл набора отдаётся; чужое расширение, вложенный путь и выход наружу: 404', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cab-ui-'));
  try {
    const ui = join(tmp, 'набор ui');
    mkdirSync(join(ui, 'sub'), { recursive: true });
    writeFileSync(join(ui, 'kabinet.js'), 'window.kabinet = {};');
    writeFileSync(join(ui, 'notes.txt'), 'заметка');
    writeFileSync(join(ui, 'sub', 'x.css'), ':root{}');
    writeFileSync(join(tmp, 'secret.css'), 'секрет снаружи');
    const server = createSiteServer(SITE, { token: TOKEN, ui });
    const port = await listenFirstFree(server, { from: 18600, to: 18619 });
    try {
      const js = await get(port, `${T}/ui/kabinet.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers['content-type'], /javascript/);
      assert.equal(js.body, 'window.kabinet = {};');
      for (const name of ['notes.txt', 'sub/x.css', 'sub%2fx.css', '..%2fsecret.css', '%2e%2e%2fsecret.css', '', 'kabinet.js.']) {
        const r = await get(port, `${T}/ui/${name}`);
        assert.equal(r.status, 404, name);
        assert.doesNotMatch(r.body, /заметка|секрет|:root/, name);
      }
      assert.equal((await get(port, '/ui/kabinet.js')).status, 403);
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ui/brand.css: переменные бренда под именами --brand-*; без бренда пустой файл', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cab-ui-'));
  try {
    const ui = join(tmp, 'ui');
    const brandDir = join(tmp, 'бренд');
    mkdirSync(ui);
    mkdirSync(brandDir);
    writeFileSync(join(brandDir, 'theme.css'), ':root { --accent: #123456; --accent-ink: #fff; color: var(--accent); }');
    let dir = brandDir;
    const server = createSiteServer(SITE, { token: TOKEN, ui, brand: async () => dir });
    const port = await listenFirstFree(server, { from: 18620, to: 18639 });
    try {
      const r = await get(port, `${T}/ui/brand.css`);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'text/css; charset=utf-8');
      assert.equal(r.body, ':root { --brand-accent: #123456; --brand-accent-ink: #fff; color: var(--brand-accent); }');
      dir = null;
      const empty = await get(port, `${T}/ui/brand.css`);
      assert.equal(empty.status, 200);
      assert.equal(empty.body, '');
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
