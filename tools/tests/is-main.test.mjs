import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HELPER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'is-main.mjs');

test('isMain: прямой запуск и запуск через ссылку true, импорт false', () => {
  const base = mkdtempSync(join(tmpdir(), 'ism-'));
  try {
    const real = join(base, 'Айгуль Н');
    mkdirSync(real);
    const script = join(real, 'm.mjs');
    writeFileSync(
      script,
      `import { isMain } from ${JSON.stringify(pathToFileURL(HELPER).href)};\nconsole.log(isMain(import.meta.url));\n`,
    );
    const link = join(base, 'ссылка');
    symlinkSync(real, link, 'junction');
    const run = (p, cwd) => spawnSync(process.execPath, [p], { encoding: 'utf8', cwd }).stdout.trim();
    assert.equal(run(script, base), 'true');
    assert.equal(run(join(link, 'm.mjs'), base), 'true');
    const other = join(base, 'o.mjs');
    writeFileSync(other, `import ${JSON.stringify(pathToFileURL(script).href)};\n`);
    assert.equal(run(other, base), 'false');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
