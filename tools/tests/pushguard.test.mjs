import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_MARK, HOOK_TEXT, NO_PUSH_URL, TEMPLATE_REPO_RE, ensurePushGuard, hookWithGuard, pushGuardState } from '../pushguard.mjs';

const TEMPLATE_URL = 'https://github.com/pdllmsk/ai-cabinet.git';

function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Кабинет с origin шаблона курса. Сеть не нужна: адрес GitHub подменяется на папку (insteadOf), а сама папка
// лежит по пути .../pdllmsk/ai-cabinet.git, как настоящий адрес.
function makeCabinet({ origin = TEMPLATE_URL } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pushguard-'));
  const bare = join(base, 'remote', 'pdllmsk', 'ai-cabinet.git');
  mkdirSync(bare, { recursive: true });
  git(bare, ['init', '-q', '--bare', '-b', 'main']);
  const seed = join(base, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  writeFileSync(join(seed, 'README.md'), 'кабинет\n');
  git(seed, ['add', '-A']);
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v1']);
  git(seed, ['push', '-q', bare, 'main']);
  const cab = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(cab, { recursive: true });
  git(cab, ['init', '-q', '-b', 'main']);
  git(cab, ['config', `url.${bare}.insteadOf`, TEMPLATE_URL]);
  git(cab, ['remote', 'add', 'origin', origin]);
  git(cab, ['fetch', '-q', 'origin']);
  git(cab, ['reset', '-q', '--hard', 'origin/main']);
  git(cab, ['branch', '-q', '--set-upstream-to=origin/main', 'main']);
  return { base, cab, seed, bare };
}

test('pushguard: адрес шаблона узнаётся во всех видах, чужой нет', () => {
  for (const u of [TEMPLATE_URL, 'https://github.com/pdllmsk/ai-cabinet', 'git@github.com:pdllmsk/ai-cabinet.git', 'https://github.com/PDLLMSK/ai-cabinet/']) {
    assert.ok(TEMPLATE_REPO_RE.test(u), u);
  }
  for (const u of ['https://github.com/pdllmsk/ai-cabinet-2.git', 'https://github.com/me/ai-cabinet.git', 'https://gitlab.com/x/y.git']) {
    assert.ok(!TEMPLATE_REPO_RE.test(u), u);
  }
});

test('pushguard: ставит pushurl и хук, push падает, fetch и обновление работают, повтор ничего не меняет', () => {
  const { base, cab, seed, bare } = makeCabinet();
  try {
    const r = ensurePushGuard(cab);
    assert.equal(r.status, 'set');
    const st = pushGuardState(cab);
    assert.equal(st.pushurl, NO_PUSH_URL);
    assert.equal(st.hook, true);
    assert.equal(st.origin, TEMPLATE_URL);

    writeFileSync(join(cab, 'mine.txt'), 'моё');
    git(cab, ['add', '-A']);
    git(cab, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'моё']);
    const push = git(cab, ['push', 'origin', 'main']);
    assert.notEqual(push.code, 0, push.out);
    assert.equal(git(bare, ['log', '--oneline', 'main']).out.trim().split('\n').length, 1);

    // Новая версия курса приходит как раньше.
    git(cab, ['reset', '-q', '--hard', 'origin/main']);
    writeFileSync(join(seed, 'README.md'), 'кабинет v2\n');
    git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'v2']);
    git(seed, ['push', '-q', bare, 'main']);
    assert.equal(git(cab, ['fetch', '-q']).code, 0);
    assert.equal(git(cab, ['merge', '-q', '--ff-only', '@{u}']).code, 0);
    assert.equal(readFileSync(join(cab, 'README.md'), 'utf8'), 'кабинет v2\n');

    assert.equal(ensurePushGuard(cab).status, 'ok');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('pushguard: pushurl сняли, хук всё равно не пускает и говорит по-русски', () => {
  const { base, cab } = makeCabinet();
  try {
    ensurePushGuard(cab);
    git(cab, ['config', '--unset', 'remote.origin.pushurl']);
    const push = git(cab, ['push', 'origin', 'main']);
    assert.notEqual(push.code, 0);
    assert.ok(push.out.includes(HOOK_TEXT), push.out);
    // Следующий вызов возвращает pushurl.
    assert.equal(ensurePushGuard(cab).status, 'set');
    assert.equal(pushGuardState(cab).pushurl, NO_PUSH_URL);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('pushguard: свой хук человека сохраняется, наш блок после #!', () => {
  const { base, cab } = makeCabinet();
  try {
    const file = join(cab, '.git', 'hooks', 'pre-push');
    mkdirSync(join(cab, '.git', 'hooks'), { recursive: true });
    writeFileSync(file, '#!/bin/bash\necho мой хук\n');
    chmodSync(file, 0o755);
    ensurePushGuard(cab);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith(`#!/bin/bash\n${HOOK_MARK}\n`), text);
    assert.ok(text.endsWith('echo мой хук\n'));
    assert.equal(hookWithGuard(text), text);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('pushguard: чужой origin, кабинет автора и папка без .git не трогаются', () => {
  const { base, cab } = makeCabinet({ origin: 'https://github.com/someone/my-repo.git' });
  try {
    assert.equal(ensurePushGuard(cab).status, 'other');
    assert.equal(pushGuardState(cab).pushurl, null);
    assert.equal(pushGuardState(cab).hook, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const b = makeCabinet();
  try {
    git(b.cab, ['config', 'ai-cabinet.author', 'true']);
    assert.equal(ensurePushGuard(b.cab).status, 'other');
    assert.equal(pushGuardState(b.cab).pushurl, null);
  } finally {
    rmSync(b.base, { recursive: true, force: true });
  }
  const plain = mkdtempSync(join(tmpdir(), 'pushguard-nogit-'));
  try {
    assert.equal(ensurePushGuard(plain).status, 'nogit');
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('pushguard: git не записал настройку, ошибка одной строкой', () => {
  const { base, cab } = makeCabinet();
  try {
    // Читать настройки можно, записать нельзя.
    const exec = (root, args) =>
      args[1] === '--get' && args[2] === 'remote.origin.url' ? { code: 0, stdout: TEMPLATE_URL } : { code: 1, stdout: '' };
    const r = ensurePushGuard(cab, { exec });
    assert.equal(r.status, 'error');
    assert.ok(!r.message.includes('\n'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('pushguard: AI_CABINET_NO_PUSHGUARD=1 ничего не ставит (тесты на папке шаблона)', () => {
  const { base, cab } = makeCabinet();
  try {
    assert.equal(ensurePushGuard(cab, { env: { AI_CABINET_NO_PUSHGUARD: '1' } }).status, 'other');
    assert.equal(pushGuardState(cab).pushurl, null);
    assert.equal(pushGuardState(cab).hook, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
