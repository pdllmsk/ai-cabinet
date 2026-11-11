// Запущен ли модуль напрямую (node файл.mjs), в том числе через ссылку или junction.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(importMetaUrl);
  try {
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return resolve(process.argv[1]) === self;
  }
}
