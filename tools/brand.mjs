// Папка бренда страницы кабинета: логотип и цвета компании. Бренд курса лежит в templates/brand/ (встроен
// в репозиторий). Ищется по порядку, берётся первая папка, где есть хотя бы один файл бренда:
//   1. site/brand/ в кабинете (своё оформление участника);
//   2. на Windows %PUBLIC%\ai-cabinet-brand\ (обычно C:\Users\Public\ai-cabinet-brand, общая для сервера);
//   3. папка из переменной окружения AI_CABINET_BRAND_DIR (тесты, Mac);
//   4. templates/brand/ (бренд курса, приходит с кабинетом).
// Файлы: theme.css (переменные цветов страницы), logo.svg или logo.png, необязательно brand.json ({"name": "..."}).
// Страница берёт их по адресу brand/<файл>; сервер отдаёт только .css, .svg, .png и .json из найденной папки.
// Запуск: node tools/brand.mjs (какая папка найдена и что в ней).
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const BRAND_FILES = ['theme.css', 'logo.svg', 'logo.png', 'brand.json'];
export const BRAND_EXT = new Set(['.css', '.svg', '.png', '.json']);
export const BRAND_ENV = 'AI_CABINET_BRAND_DIR';
const PUBLIC_DIR_NAME = 'ai-cabinet-brand';

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// Папки, где ищется бренд, по порядку.
export function brandCandidates(root, { env = process.env, platform = process.platform } = {}) {
  const list = [join(resolve(root), 'site', 'brand')];
  if (platform === 'win32') {
    const pub = env.PUBLIC || `${env.SystemDrive || 'C:'}\\Users\\Public`;
    list.push(join(pub, PUBLIC_DIR_NAME));
  }
  if (env[BRAND_ENV]) list.push(resolve(env[BRAND_ENV]));
  list.push(join(resolve(root), 'templates', 'brand'));
  return list;
}

// Файлы бренда в папке (из BRAND_FILES).
export function brandFiles(dir) {
  return BRAND_FILES.filter((f) => isFile(join(dir, f)));
}

// Первая папка бренда, где есть хотя бы один файл бренда, или null: страница в нейтральных цветах.
export function findBrandDir(root, opts) {
  for (const dir of brandCandidates(root, opts)) {
    if (isDir(dir) && brandFiles(dir).length) return dir;
  }
  return null;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = findBrandDir(root);
  if (!dir) {
    console.log('Папка бренда не найдена: страница в нейтральных цветах. Где искал:');
    for (const c of brandCandidates(root)) console.log(`  ${c}`);
    return;
  }
  console.log(`Папка бренда: ${dir}`);
  console.log(`Файлы: ${brandFiles(dir).join(', ')}`);
}

if (isMain(import.meta.url)) {
  main();
}
