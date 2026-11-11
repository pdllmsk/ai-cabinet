// Копирование папки для тестов. Системное копирование папок целиком в Node 22 на Windows падает на кириллице в пути.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}
