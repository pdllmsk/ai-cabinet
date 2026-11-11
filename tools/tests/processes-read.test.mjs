// node tools/processes.mjs read <slug> <файл> (скилл файлом и документ Word) и compare <slug> (сверка со скиллом).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { copyDir } from './copy-dir.mjs';
import { compareWithEtalon, programProblems, skillCommandLines, zipEntries } from '../processes.mjs';
import { hasSkillCommand } from '../../.claude/hooks/guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let base, cab;

// Архив zip, как его делает скачивание скилла: deflate, имена в UTF-8.
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(n, 8);
  end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Встроенная команда собирается из частей: этот файл сам не должен выглядеть как скилл с командой.
const BANG = '!';
const TICK = '`';
const CMD_LINE = `Сегодня: ${BANG}${TICK}date${TICK}`;
const BLOCK_LINE = `${TICK.repeat(3)}${BANG}`;
const FIX_NOTE = 'Для Claude: перед правкой программы или словаря напишите человеку текстом ответа: «Поправляю программу, нажмите «Allow» (разрешить).»';

const SKILL = `---
name: razbor-obrashcheniy
description: Разбор обращений клиентов по темам. Фраза «разбери обращения».
---

# Разбор обращений

Разложи обращения из файла по темам: качество золота, обслуживание, оплата, другое.
`;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'read-'));
  cab = join(base, 'Айгуль Н', 'ai-cabinet');
  mkdirSync(cab, { recursive: true });
  copyDir(join(ROOT, 'tools'), join(cab, 'tools'));
  rmSync(join(cab, 'tools', 'tests'), { recursive: true, force: true });
  const inp = join(cab, 'input', 'razbor');
  mkdirSync(inp, { recursive: true });
  writeFileSync(join(inp, 'SKILL.md'), SKILL);
  writeFileSync(join(inp, 'chuzhoy skill.md'), `${SKILL}\n${CMD_LINE}\n\n${BLOCK_LINE}\nls\n${TICK.repeat(3)}\n`);
  writeFileSync(
    join(inp, 'razbor-obrashcheniy.zip'),
    makeZip({
      'razbor-obrashcheniy/': '',
      'razbor-obrashcheniy/SKILL.md': SKILL,
      'razbor-obrashcheniy/reference/temy.md': `# Темы\n\nкачество золота: золото, золото\n${CMD_LINE}\n`,
      'razbor-obrashcheniy/scripts/build.py': 'import openpyxl\nprint("сводка по темам")\n',
      'razbor-obrashcheniy/assets/logo.png': 'PNG',
      '__MACOSX/razbor-obrashcheniy/._SKILL.md': 'мусор',
    }),
  );
  writeFileSync(join(inp, 'razbor.skill'), makeZip({ 'SKILL.md': SKILL }));
  writeFileSync(join(inp, 'bez-skilla.zip'), makeZip({ 'readme.txt': 'просто текст' }));
  writeFileSync(join(inp, 'bityi.zip'), Buffer.from('это не архив'));
  writeFileSync(join(inp, 'pismo.docx'), readFileSync(join(ROOT, 'input', 'case', 'data', 'shablon_otcheta.docx')));
  writeFileSync(join(inp, 'dannye.xlsx'), readFileSync(join(ROOT, 'input', 'case', 'data', 'ostatki_1c.xlsx')));
});

after(() => rmSync(base, { recursive: true, force: true }));

function cli(...args) {
  const r = spawnSync(process.execPath, [join(cab, 'tools', 'processes.mjs'), ...args], { cwd: cab, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('read: скилл .md без встроенных команд', () => {
  const r = cli('read', 'razbor', 'SKILL.md');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Файл SKILL\.md:/);
  assert.match(r.out, /Разложи обращения из файла по темам/);
  assert.match(r.out, /Встроенных команд нет\.$/m);
});

test('read: встроенные команды скилла показаны с номерами строк (и строка, и блок)', () => {
  const r = cli('read', 'razbor', 'chuzhoy', 'skill.md');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Встроенные команды: 2\. Они выполнятся сами при запуске скилла, без вопроса:/);
  assert.match(r.out, /chuzhoy skill\.md, строка 10: Сегодня: !`date`/);
  assert.match(r.out, /chuzhoy skill\.md, строка 12: ```!/);
  assert.deepEqual(skillCommandLines('Важно! Не трогайте файл.\nКоманда `ls` без восклицательного знака.'), []);
});

test('read и сторож узнают встроенную команду одинаково: «Готово! `файл`» через пробел не команда', () => {
  const texts = [
    CMD_LINE,
    `${BLOCK_LINE}\nls\n${TICK.repeat(3)}`,
    `${TICK.repeat(3)} \t${BANG}`,
    `Готово${BANG} ${TICK}output/a.xlsx${TICK} сохранён`,
    `Готово${BANG}\t${TICK}файл${TICK}`,
    `${BANG}${TICK}${TICK}`,
    'Важно! Не трогайте файл.',
    'Команда `ls` без восклицательного знака.',
    `строка 1\nстрока 2: ${BANG}${TICK}whoami${TICK}`,
  ];
  const differ = texts.filter((text) => (skillCommandLines(text).length > 0) !== hasSkillCommand(text));
  assert.deepEqual(differ, []);
  assert.deepEqual(skillCommandLines(`Готово${BANG} ${TICK}output/a.xlsx${TICK} сохранён`), []);
});

test('read: архив .zip скилла: список файлов, SKILL.md и тексты, текст программы из scripts без запуска, команды из всех текстов', () => {
  const r = cli('read', 'razbor', 'razbor-obrashcheniy.zip');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Архив razbor-obrashcheniy\.zip, файлов 4: razbor-obrashcheniy\/SKILL\.md, razbor-obrashcheniy\/reference\/temy\.md, razbor-obrashcheniy\/scripts\/build\.py, razbor-obrashcheniy\/assets\/logo\.png\./);
  assert.match(r.out, /Текст razbor-obrashcheniy\/SKILL\.md:\n---\nname: razbor-obrashcheniy/);
  assert.match(r.out, /Текст razbor-obrashcheniy\/reference\/temy\.md:/);
  assert.match(r.out, /Программа razbor-obrashcheniy\/scripts\/build\.py из архива \(только текст: программу из архива не запускают, это файл извне\):\nimport openpyxl\nprint\("сводка по темам"\)/);
  assert.match(r.out, /Остальные файлы архива \(razbor-obrashcheniy\/assets\/logo\.png\) здесь не показаны\./);
  assert.match(r.out, /Встроенные команды: 1\.[^\n]*\n {2}razbor-obrashcheniy\/reference\/temy\.md, строка 4: Сегодня: !`date`/);
});

test('read: .skill это тот же архив', () => {
  const r = cli('read', 'razbor', 'razbor.skill');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Текст SKILL\.md:/);
  assert.match(r.out, /Встроенных команд нет\./);
});

test('read: документ Word: текст по абзацам, без проверки команд', () => {
  const r = cli('read', 'razbor', 'pismo.docx');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Документ Word pismo\.docx/);
  assert.match(r.out, /^\[Получатель\]$/m);
  assert.match(r.out, /Исх\. № ____ от \[дата\]/);
  assert.doesNotMatch(r.out, /Встроенн/);
  const real = zipEntries(readFileSync(join(cab, 'input', 'razbor', 'pismo.docx'))).map((e) => e.name);
  assert.ok(real.includes('word/document.xml'));
});

test('read: понятные отказы: нет SKILL.md, битый архив, таблица, путь с папками, нет файла, нет имени', () => {
  const cases = [
    [['read', 'razbor', 'bez-skilla.zip'], /в архиве нет файла SKILL\.md/],
    [['read', 'razbor', 'bityi.zip'], /bityi\.zip не читается/],
    [['read', 'razbor', 'dannye.xlsx'], /python tools\/read_table\.py/],
    [['read', 'razbor', '../razbor/SKILL.md'], /только имя файла/],
    [['read', 'razbor', 'net.md'], /Нет файла input\/razbor\/net\.md\. Файлы в папке input\/razbor: /],
    [['read', 'razbor'], /Укажите файл/],
    [['read', 'Razbor', 'SKILL.md'], /Имя папки процесса/],
  ];
  for (const [args, re] of cases) {
    const r = cli(...args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, re, args.join(' '));
    assert.doesNotMatch(r.out, /at .*processes\.mjs/);
  }
});

test('skills: свои скиллы с описанием, скиллы курса и папки без SKILL.md не показываются', () => {
  const sk = join(cab, '.claude', 'skills');
  let r = cli('skills');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Своих скиллов в кабинете нет, только скиллы курса\./);
  for (const [name, text] of [
    ['add-process', '---\nname: add-process\ndescription: курс\n---\n'],
    ['razbor-obrashcheniy', '---\nname: razbor-obrashcheniy\ndescription: Разбирает обращения по темам.\n---\n# Текст\n'],
    ['bez-opisaniya', '# Скилл без шапки\n'],
  ]) {
    mkdirSync(join(sk, name), { recursive: true });
    writeFileSync(join(sk, name, 'SKILL.md'), text);
  }
  mkdirSync(join(sk, 'pustaya'), { recursive: true });
  r = cli('skills');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trim(), ['Свои скиллы в кабинете: 2. Текст скилла: .claude/skills/<папка>/SKILL.md.', '- bez-opisaniya', '- razbor-obrashcheniy: Разбирает обращения по темам.'].join('\n'));
});

// ---------- compare ----------

const ETALON = {
  'скилл': 'razbor-obrashcheniy',
  'файл': 'obrashcheniya.xlsx',
  'итоги': { 'обращений': 5, 'тенге': 12345.6 },
  'по категориям': { 'оборудование': 2, 'другое': 2 },
  'по строкам': { 1: 'оборудование', 2: 'другое', 3: 'оборудование', 4: 'другое', 5: 'повтор' },
};

test('compareWithEtalon: всё совпало, числа с точностью эталона, регистр и ё не важны', () => {
  const r = compareWithEtalon(ETALON, {
    'итоги': { 'Обращений': 5, 'тенге': 12345.63 },
    'по категориям': { 'Оборудование': 2, 'другое': 2 },
    'по строкам': { '1': 'оборудование', '2': 'Другое', '3': 'оборудование', '4': 'другое', '5': 'повтор' },
  });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.lines.at(-1), 'Итог сверки: результат программы совпал с эталоном.');
  assert.ok(r.lines.includes('По строкам: совпало 5 из 5.'));
});

test('compareWithEtalon: строки в «разобрать вручную» и разница в категориях, которую они объясняют, не расхождение', () => {
  const r = compareWithEtalon(ETALON, {
    'итоги': { 'обращений': 5, 'тенге': 12345.6 },
    'по категориям': { 'оборудование': 2, 'разобрать вручную': 2 },
    'по строкам': { 1: 'оборудование', 2: 'разобрать вручную', 3: 'оборудование', 4: 'разобрать вручную', 5: 'повтор' },
  });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.manual, 2);
  const text = r.lines.join('\n');
  assert.match(text, /Программа отправила в «разобрать вручную»: 2\.\n {2}2: в эталоне «другое»\n {2}4: в эталоне «другое»/);
  assert.match(text, /«другое»: в эталоне 2, у программы 0, разница 2 в «разобрать вручную»/);
  assert.equal(r.lines.at(-1), 'Итог сверки: результат программы совпал с эталоном, кроме 2 строк в «разобрать вручную».');
});

test('compareWithEtalon: другая категория, другой итог, лишняя категория, документы → расхождения, код 1', () => {
  const r = compareWithEtalon({ ...ETALON, 'документов': 3 }, {
    'итоги': { 'обращений': 5, 'тенге': 12345.7 },
    'по категориям': { 'оборудование': 1, 'другое': 2, 'чистота': 1 },
    'по строкам': { 1: 'чистота', 2: 'другое', 3: 'оборудование', 4: 'другое', 5: 'повтор', 6: 'другое' },
    'документов': 2,
  });
  assert.equal(r.code, 1);
  const text = r.lines.join('\n');
  assert.match(text, /Другой результат у программы: 1\.\n {2}1: в эталоне «оборудование», у программы «чистота»/);
  assert.match(text, /Есть у программы, нет в эталоне: 1: 6\./);
  assert.match(text, /«тенге»: в эталоне 12345,6, у программы 12345,7/);
  assert.match(text, /«чистота»: в эталоне нет, у программы 1/);
  assert.match(text, /Документов: в эталоне 3, у программы 2\./);
  assert.match(r.lines.at(-1), /^Итог сверки: расхождений 6\. Поправьте словарь или программу/);
});

test('compareWithEtalon: эталон по части большого файла: строки вне эталона не расхождение, итоги по всему файлу сравниваются', () => {
  const r = compareWithEtalon(
    { 'строк в эталоне': 2, 'по строкам': { 1: 'оборудование', 2: 'другое' }, 'итоги': { 'обращений': 3 }, 'по категориям': { 'другое': 1 } },
    { 'итоги': { 'обращений': 3 }, 'по строкам': { 1: 'оборудование', 2: 'другое', 3: 'другое' } },
  );
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.differences, 0);
  const text = r.lines.join('\n');
  assert.match(text, /По строкам: совпало 2 из 2\./);
  assert.match(text, /Не входят в эталон: 1 строк или групп программы \(эталон по первым 2\), их не сравниваем\./);
  assert.match(text, /Эталон по части файла: «по категориям» по всему файлу с ним не сравнить, не сравниваем\./);
  assert.match(text, /Итоги: совпали все \(1\)\./);
  assert.equal(r.lines.at(-1), 'Итог сверки: результат программы совпал с эталоном.');
  // Итог по всему файлу в эталоне по части файла тоже сверяется: другой итог у программы → расхождение.
  const wrongTotal = compareWithEtalon(
    { 'строк в эталоне': 2, 'по строкам': { 1: 'оборудование', 2: 'другое' }, 'итоги': { 'обращений': 3 } },
    { 'итоги': { 'обращений': 4 }, 'по строкам': { 1: 'оборудование', 2: 'другое', 3: 'другое' } },
  );
  assert.equal(wrongTotal.code, 1);
  assert.match(wrongTotal.lines.join('\n'), /«обращений»: в эталоне 3, у программы 4/);
  // Без пометки о части файла лишняя строка остаётся расхождением.
  const full = compareWithEtalon({ 'по строкам': { 1: 'оборудование', 2: 'другое' } }, { 'по строкам': { 1: 'оборудование', 2: 'другое', 3: 'другое' } });
  assert.equal(full.code, 1);
});

// Сводная: сумма по Точка и виду золота, ключ группы «Точка-01 / Золото 585».
const groups = (n, shift = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`Точка-${String(i + 1).padStart(3, '0')} / Золото 585`, 100 + i + (i === 0 ? shift : 0)]));
const sum = (g) => Math.round(Object.values(g).reduce((a, b) => a + b, 0) * 10) / 10;

test('compareWithEtalon: сводная до 300 групп: все группы в «по категориям», неверная группа или итог → расхождение', () => {
  const g = groups(47);
  const etalon = { 'итоги': { 'тенге': sum(g) }, 'по категориям': g };
  const ok = compareWithEtalon(etalon, { 'итоги': { 'тенге': sum(g) }, 'по категориям': { ...g } });
  assert.equal(ok.code, 0, ok.lines.join('\n'));
  assert.ok(ok.lines.includes('По категориям: совпали все (47).'));
  const wrongGroup = compareWithEtalon(etalon, { 'итоги': { 'тенге': sum(g) }, 'по категориям': groups(47, 5) });
  assert.equal(wrongGroup.code, 1);
  assert.match(wrongGroup.lines.join('\n'), /«Точка-001 \/ Золото 585»: в эталоне 100, у программы 105/);
  const wrongTotal = compareWithEtalon(etalon, { 'итоги': { 'тенге': sum(g) + 7 }, 'по категориям': { ...g } });
  assert.equal(wrongTotal.code, 1);
  assert.match(wrongTotal.lines.join('\n'), /Итоги: не совпало 1 из 1\./);
});

test('compareWithEtalon: сводная больше 300 групп: первые 100 групп в «по строкам» и итоги по всему файлу', () => {
  const all = groups(350);
  const first = Object.fromEntries(Object.entries(all).slice(0, 100));
  const etalon = { 'строк в эталоне': 100, 'итоги': { 'тенге': sum(all), 'групп': 350 }, 'по строкам': first };
  const ok = compareWithEtalon(etalon, { 'итоги': { 'тенге': sum(all), 'групп': 350 }, 'по строкам': { ...all } });
  assert.equal(ok.code, 0, ok.lines.join('\n'));
  const text = ok.lines.join('\n');
  assert.match(text, /По строкам: совпало 100 из 100\./);
  assert.match(text, /Не входят в эталон: 250 строк или групп программы \(эталон по первым 100\), их не сравниваем\./);
  assert.match(text, /Итоги: совпали все \(2\)\./);
  // Программа ошиблась в группе за пределами первых 100: её видно по итогу по всему файлу.
  const tail = { ...all, 'Точка-300 / Золото 585': all['Точка-300 / Золото 585'] + 50 };
  const wrongTotal = compareWithEtalon(etalon, { 'итоги': { 'тенге': sum(tail), 'групп': 350 }, 'по строкам': tail });
  assert.equal(wrongTotal.code, 1, wrongTotal.lines.join('\n'));
  assert.match(wrongTotal.lines.join('\n'), /«тенге»: в эталоне/);
  assert.match(wrongTotal.lines.at(-1), /^Итог сверки: расхождений 1\./);
  const wrongGroup = compareWithEtalon(etalon, { 'итоги': { 'тенге': sum(all), 'групп': 350 }, 'по строкам': { ...all, 'Точка-001 / Золото 585': 1 } });
  assert.equal(wrongGroup.code, 1);
});

test('compareWithEtalon: эталон по части файла без итогов → предупреждение, что сверены только строки', () => {
  const r = compareWithEtalon({ 'строк в эталоне': 2, 'по строкам': { 1: 'а', 2: 'б' } }, { 'по строкам': { 1: 'а', 2: 'б', 3: 'а' } });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.ok(r.lines.includes('В эталоне нет итогов: сверены только строки.'), r.lines.join('\n'));
  const withTotals = compareWithEtalon({ 'строк в эталоне': 2, 'итоги': { 'строк': 3 }, 'по строкам': { 1: 'а', 2: 'б' } }, { 'итоги': { 'строк': 3 }, 'по строкам': { 1: 'а', 2: 'б', 3: 'а' } });
  assert.ok(!withTotals.lines.some((l) => l.startsWith('В эталоне нет итогов')));
  const whole = compareWithEtalon({ 'по строкам': { 1: 'а' } }, { 'по строкам': { 1: 'а' } });
  assert.ok(!whole.lines.some((l) => l.startsWith('В эталоне нет итогов')));
});

test('compareWithEtalon: две темы в эталоне «X / Y»: программа взяла любую из двух → совпало, третью → расхождение', () => {
  const etalon = {
    'по категориям': { 'оплата и касса': 2, 'минимаркет и кафе': 1 },
    'по строкам': { 1: 'оплата и касса', 2: 'Оплата и касса / Минимаркет и кафе', 3: 'минимаркет и кафе' },
  };
  // Программа взяла вторую тему: строка совпала, счёт по темам сдвинут на эту строку и тоже совпал.
  const second = compareWithEtalon(etalon, {
    'по категориям': { 'оплата и касса': 1, 'минимаркет и кафе': 2 },
    'по строкам': { 1: 'оплата и касса', 2: 'минимаркет и кафе', 3: 'минимаркет и кафе' },
  });
  assert.equal(second.code, 0, second.lines.join('\n'));
  assert.ok(second.lines.includes('По строкам: совпало 3 из 3.'));
  assert.ok(second.lines.includes('По категориям: совпали все (2).'), second.lines.join('\n'));
  assert.ok(second.lines.includes('Две темы в эталоне: 1, программа взяла одну из них.'), second.lines.join('\n'));
  const first = compareWithEtalon(etalon, {
    'по категориям': { 'оплата и касса': 2, 'минимаркет и кафе': 1 },
    'по строкам': { 1: 'оплата и касса', 2: 'оплата и касса', 3: 'минимаркет и кафе' },
  });
  assert.equal(first.code, 0, first.lines.join('\n'));
  const other = compareWithEtalon(etalon, {
    'по категориям': { 'оплата и касса': 1, 'минимаркет и кафе': 1, 'оборудование': 1 },
    'по строкам': { 1: 'оплата и касса', 2: 'оборудование', 3: 'минимаркет и кафе' },
  });
  assert.equal(other.code, 1);
  assert.match(other.lines.join('\n'), /2: в эталоне «Оплата и касса \/ Минимаркет и кафе», у программы «оборудование»/);
  // Строка с двумя темами в «разобрать вручную»: разница в категории первой темы объясняется ею.
  const manual = compareWithEtalon(etalon, {
    'по категориям': { 'оплата и касса': 1, 'минимаркет и кафе': 1 },
    'по строкам': { 1: 'оплата и касса', 2: 'разобрать вручную', 3: 'минимаркет и кафе' },
  });
  assert.equal(manual.code, 0, manual.lines.join('\n'));
  assert.equal(manual.manual, 1);
});

test('compareWithEtalon: срочные строки: пропуск срочной строки эталона → расхождение, лишняя срочная → не расхождение', () => {
  const etalon = { 'по строкам': { 1: 'оборудование', 2: 'другое', 3: 'оплата и касса' }, 'срочно': ['1'] };
  const rows = { 1: 'оборудование', 2: 'другое', 3: 'оплата и касса' };
  const ok = compareWithEtalon(etalon, { 'по строкам': rows, 'срочно': ['1'] });
  assert.equal(ok.code, 0, ok.lines.join('\n'));
  assert.ok(ok.lines.includes('Срочные строки: совпали все (1).'), ok.lines.join('\n'));
  // Программа не отметила срочной строку, которую скилл назвал срочной: сверка не пройдена, даже если тема верна.
  const missed = compareWithEtalon(etalon, { 'по строкам': rows, 'срочно': [] });
  assert.equal(missed.code, 1, missed.lines.join('\n'));
  assert.ok(missed.lines.includes('Срочные строки: программа не отметила срочной 1 из 1: 1. Добавьте в раздел «срочно (не тема)» слово об опасности из этой строки.'), missed.lines.join('\n'));
  assert.equal(missed.lines.at(-1), 'Итог сверки: расхождений 1. Поправьте словарь или программу и запустите снова.');
  assert.equal(missed.lines.at(-2), FIX_NOTE);
  const noSection = compareWithEtalon(etalon, { 'по строкам': rows });
  assert.equal(noSection.code, 1);
  // Срочная строка в «разобрать вручную» по теме: срочность всё равно сверяется, это не расхождение.
  const manualHot = compareWithEtalon(etalon, { 'по строкам': { ...rows, 1: 'разобрать вручную' }, 'срочно': [1] });
  assert.equal(manualHot.code, 0, manualHot.lines.join('\n'));
  // Лишняя срочная строка: строкой в выводе, не расхождение.
  const extra = compareWithEtalon(etalon, { 'по строкам': rows, 'срочно': ['1', '3'] });
  assert.equal(extra.code, 0, extra.lines.join('\n'));
  assert.ok(extra.lines.includes('Программа отметила срочными ещё 1: 3. Это не расхождение: срочное лучше проверить лишний раз.'), extra.lines.join('\n'));
  // Эталон по части файла: срочные строки вне эталона не сравниваются.
  const part = compareWithEtalon(
    { 'строк в эталоне': 2, 'итоги': { 'строк': 3 }, 'по строкам': { 1: 'оборудование', 2: 'другое' }, 'срочно': [] },
    { 'итоги': { 'строк': 3 }, 'по строкам': rows, 'срочно': ['3'] },
  );
  assert.equal(part.code, 0, part.lines.join('\n'));
  assert.ok(part.lines.includes('Срочные строки: совпали все (0).'), part.lines.join('\n'));
  assert.ok(!part.lines.some((l) => l.startsWith('Программа отметила срочными')));
  // Только раздел «срочно» в эталоне: сравнивать есть что.
  const only = compareWithEtalon({ 'срочно': ['5'] }, { 'срочно': ['5'] });
  assert.equal(only.code, 0, only.lines.join('\n'));
});

test('compareWithEtalon: в эталоне нет раздела «срочно», а программа отмечает срочные → сказано, что не сверены', () => {
  const r = compareWithEtalon({ 'по строкам': { 1: 'а', 2: 'б' } }, { 'по строкам': { 1: 'а', 2: 'б' }, 'срочно': ['1'] });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.ok(r.lines.includes('В эталоне нет раздела «срочно»: срочные строки программы (1: 1) не сверены.'), r.lines.join('\n'));
  const none = compareWithEtalon({ 'по строкам': { 1: 'а' } }, { 'по строкам': { 1: 'а' }, 'срочно': [] });
  assert.ok(!none.lines.some((l) => l.includes('нет раздела «срочно»')));
});

test('compareWithEtalon: срочно: номера строк числом и с «№», пустые списки, эталон по части только со срочными', () => {
  const keys = compareWithEtalon({ 'по строкам': { 1: 'а' }, 'срочно': [48, '№ 13'] }, { 'по строкам': { 1: 'а' }, 'срочно': ['48', '13'] });
  assert.equal(keys.code, 0, keys.lines.join('\n'));
  const empty = compareWithEtalon({ 'по строкам': { 1: 'а' }, 'срочно': [] }, { 'по строкам': { 1: 'а' } });
  assert.ok(empty.lines.includes('Срочные строки: совпали все (0).'));
  const part = compareWithEtalon({ 'строк в эталоне': 100, 'срочно': ['5'] }, { 'срочно': ['5'] });
  assert.equal(part.code, 0);
  assert.ok(part.lines.includes('В эталоне нет итогов: сверены только строки.'));
});

test('compareWithEtalon: «X / Y» две темы только у классификации: значение черновика с « / » сверяется целиком', () => {
  // Черновик: ключевое значение адресата с « / », у программы только его часть → расхождение, не «две темы».
  const draft = compareWithEtalon({ 'по строкам': { 1: 'ТОО Альфа / филиал Бета' } }, { 'по строкам': { 1: 'ТОО Альфа' } });
  assert.equal(draft.code, 1, draft.lines.join('\n'));
  assert.ok(!draft.lines.some((l) => l.startsWith('Две темы')));
  // Классификация, но части не темы эталона: тоже целиком.
  const notTopics = compareWithEtalon(
    { 'по категориям': { 'а': 1 }, 'по строкам': { 1: 'а', 2: 'а / б-12' } },
    { 'по категориям': { 'а': 2 }, 'по строкам': { 1: 'а', 2: 'а' } },
  );
  assert.equal(notTopics.code, 1, notTopics.lines.join('\n'));
  // Вторая тема встречается только второй (в «по категориям» её нет): тема по строкам эталона, принимается.
  const second = compareWithEtalon(
    { 'по категориям': { 'а': 2 }, 'по строкам': { 1: 'а', 2: 'а / б', 3: 'б' } },
    { 'по категориям': { 'а': 1, 'б': 2 }, 'по строкам': { 1: 'а', 2: 'б', 3: 'б' } },
  );
  assert.ok(second.lines.includes('Две темы в эталоне: 1, программа взяла одну из них.'), second.lines.join('\n'));
});

test('compareWithEtalon: слабые слова: слово темы стоит в строке другой темы в эталоне → подсказка, не расхождение', () => {
  const etalon = { 'по категориям': { 'оплата': 1, 'персонал': 1, 'кафе': 1 }, 'по строкам': { 1: 'оплата', 2: 'персонал', 3: 'кафе / оплата', 4: 'повтор' } };
  const program = {
    'по категориям': { 'оплата': 1, 'персонал': 1, 'кафе': 1 },
    'по строкам': { 1: 'оплата', 2: 'персонал', 3: 'кафе', 4: 'повтор' },
    'найдено': {
      1: { 'оплата': ['касса', 'чек'] },
      2: { 'персонал': ['кассир'], 'оплата': ['касса', 'чек?'] },
      3: { 'кафе': ['кофе'], 'оплата': ['касса'] },
    },
  };
  const r = compareWithEtalon(etalon, program);
  assert.equal(r.code, 0, r.lines.join('\n'));
  // «касса» в строке 2 (персонал) чужая; в строке 3 в эталоне две темы, «оплата» одна из них; «чек?» уже слабое.
  assert.ok(r.lines.includes('Слабые слова (стоят в строках другой темы в эталоне), пометьте их «?» в словаре: «касса» (оплата): 2.'), r.lines.join('\n'));
  assert.equal(r.lines.filter((l) => l === FIX_NOTE).length, 1);
  const none = compareWithEtalon(etalon, { ...program, 'найдено': { 1: { 'оплата': ['касса'] } } });
  assert.ok(!none.lines.some((l) => l.startsWith('Слабые слова')));
  assert.ok(!none.lines.includes(FIX_NOTE), 'править нечего: напоминания нет');
  // Слабые слова и расхождение сразу: напоминание всё равно одно, перед итогом.
  const both = compareWithEtalon(etalon, { ...program, 'по строкам': { ...program['по строкам'], 1: 'персонал' } });
  assert.equal(both.code, 1);
  assert.equal(both.lines.filter((l) => l.includes('Поправляю программу')).length, 1, both.lines.join('\n'));
  assert.equal(both.lines.at(-2), FIX_NOTE);
});

test('compareWithEtalon: больше 20% строк в «разобрать вручную» → предупреждение, не расхождение; словарь, только если он есть', () => {
  const e = { 'по строкам': { 1: 'а', 2: 'б', 3: 'а', 4: 'б', 5: 'а' } };
  const sent = { 'по строкам': { 1: 'а', 2: 'разобрать вручную', 3: 'а', 4: 'разобрать вручную', 5: 'а' } };
  const r = compareWithEtalon(e, sent, { slovar: true });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.ok(r.lines.includes('Внимание: в «разобрать вручную» ушло 2 из 5 строк. Проверьте словарь: скорее всего, в нём не хватает слов.'));
  // Без словаря (сводная, черновики) о словаре ни слова; программа по темам пишет «найдено»: словарь есть.
  const plain = compareWithEtalon(e, sent);
  assert.ok(plain.lines.includes('Внимание: в «разобрать вручную» ушло 2 из 5 строк. Причины в списке «разобрать вручную».'), plain.lines.join('\n'));
  assert.ok(!plain.lines.some((l) => l.includes('словар')), plain.lines.join('\n'));
  const found = compareWithEtalon(e, { ...sent, 'найдено': { 1: { 'а': ['слово'] } } });
  assert.ok(found.lines.some((l) => l.includes('Проверьте словарь')));
  const few = compareWithEtalon(e, { 'по строкам': { 1: 'а', 2: 'разобрать вручную', 3: 'а', 4: 'б', 5: 'а' } });
  assert.ok(!few.lines.some((l) => l.startsWith('Внимание')));
});

test('programProblems: запуск программ, eval, абсолютные пути; комментарии, обычные строки и интернет не трогает', () => {
  const bad = [
    'import subprocess',
    'os.system("del *")',
    'v = eval(text)',
    'data = open("/Users/aigul/secret.txt").read()',
    'p = "C:\\\\Users\\\\secret.xlsx"',
    'home = Path.home()',
    'shutil.rmtree(ROOT)',
  ];
  for (const line of bad) assert.equal(programProblems(line).length, 1, line);
  const good = ['from urllib.request import urlopen, Request', 'import requests', 'from http import client', 'import json, ssl, html', 'from html.parser import HTMLParser', '# subprocess не нужен', 'r = re.compile(r"\\d+")', 'out = OUT / "result.json"', 'tmp.unlink(missing_ok=True)', 's.replace("\\\\", "/")', 'os.replace(tmp, target)'];
  for (const line of good) assert.deepEqual(programProblems(line), [], line);
});

// Обходы проверки из финального ревью v1.2 и похожие: каждый ловится. Программа процесса подключает только
// библиотеки из списка, os только как os.path и os.replace, функции по имени не достаёт.
test('programProblems: обходы ревью (from os import, asyncio, pty, runpy, posix_spawn, builtins.exec) и похожие ловятся', () => {
  const bypasses = {
    'from os import system': 'from os import system\nsystem("del *")',
    'from os import (system)': 'from os import (\n    path,\n    system,\n)',
    'asyncio.create_subprocess_exec': 'import asyncio\nasyncio.run(asyncio.create_subprocess_exec("cmd"))',
    'pty.spawn': 'import pty\npty.spawn("sh")',
    runpy: 'import runpy\nrunpy.run_path("x.py")',
    'os.posix_spawn': 'import os\nos.posix_spawn(exe, ["sh"], {})',
    'builtins.exec': 'import builtins\nbuiltins.exec("print(1)")',
    '__builtins__': 'f = __builtins__["ex" + "ec"]',
    'getattr(os, ...)': 'import os\ngetattr(os, "sys" + "tem")("ls")',
    '__import__': 'm = __import__("subprocess")',
    'globals()': 'f = globals()["__builtins__"]',
    importlib: 'import importlib\nimportlib.import_module("subprocess")',
    'os.remove': 'import os\nos.remove(ROOT / "input" / "x.xlsx")',
    'import os as': 'import os as o\no.system("ls")',
    'import через ;': 'import json; import shutil',
    'import через \\': 'import json, \\\n    shutil',
    'sys.modules': 'import sys\nsys.modules["os"].system("ls")',
    '__subclasses__': 'x = ().__class__.__base__.__subclasses__()',
    'путь вверх ..': 'data = (ROOT / ".." / "secret.txt").read_text()',
    'from . import': 'from . import secret',
    'import shutil': 'import shutil\nshutil.copy("a", "b")',
  };
  const missed = Object.entries(bypasses).filter(([, code]) => programProblems(code).length === 0).map(([name]) => name);
  assert.deepEqual(missed, []);
  // Обычные программы: импорты из списка, os.path и os.replace, hasattr, open файла из ROOT.
  const ok = [
    'import json, re, sys\nfrom datetime import date, datetime\nfrom pathlib import Path',
    'import os\nimport os.path\nfrom os import path\nfrom os.path import join\nos.path.join("a", "b")\nos.replace(tmp, target)',
    'import csv, math, decimal, collections, itertools, difflib, unicodedata, zipfile, io, statistics, functools, string',
    'from openpyxl import Workbook\nfrom openpyxl.styles import Font\nimport docx\nfrom docx.oxml.ns import qn\nimport read_table',
    'root = part.element if hasattr(part, "element") else None',
    'with open(ROOT / "input" / SLUG / "a.csv", encoding="utf-8") as f:\n    pass',
    'raise StopRun("нет файла") from None',
    'if __name__ == "__main__":\n    main()',
  ];
  for (const code of ok) assert.deepEqual(programProblems(code), [], code);
});

test('compare: запрещённое в программе процесса закрывает «готово» (код 1), даже без эталона и при совпадении', () => {
  const slug = 'opasno';
  const dir = join(cab, 'processes', slug);
  const out = join(cab, 'output', slug);
  mkdirSync(dir, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(dir, 'process.json'), JSON.stringify({ title: 'Опасно', phrase: 'запусти опасно', kind: 'script' }));
  writeFileSync(join(dir, 'run.py'), 'import json\nimport subprocess\nsubprocess.run(["curl", "x"])\n');
  let r = cli('compare', slug);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Эталона нет/);
  assert.match(r.out, /В программе processes\/opasno\/run\.py есть то, что программе процесса нельзя/);
  assert.match(r.out, /строка 2: запуск программ: import subprocess/);
  const sverka = { 'по строкам': { 1: 'а' } };
  writeFileSync(join(out, 'etalon-skilla.json'), JSON.stringify(sverka));
  writeFileSync(join(out, 'result.json'), JSON.stringify({ title: 'Опасно', updated_at: '2026-10-22T10:00:00+05:00', status: 'green', summary: 'x', columns: [], rows: [], sverka }));
  r = cli('compare', slug);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Итог сверки: результат программы совпал с эталоном\./);
  assert.match(r.out, /Итог проверки программы: уберите это из программы, «готово» нельзя\.$/m);
  assert.equal(r.out.split('\n').filter((l) => l === FIX_NOTE).length, 1, r.out);
  // Запрещённое и расхождение сразу: напоминание про окно одно.
  writeFileSync(join(out, 'result.json'), JSON.stringify({ title: 'Опасно', updated_at: '2026-10-22T10:00:00+05:00', status: 'green', summary: 'x', columns: [], rows: [], sverka: { 'по строкам': { 1: 'б' } } }));
  r = cli('compare', slug);
  assert.equal(r.code, 1, r.out);
  assert.equal(r.out.split('\n').filter((l) => l.includes('Поправляю программу')).length, 1, r.out);
  writeFileSync(join(out, 'result.json'), JSON.stringify({ title: 'Опасно', updated_at: '2026-10-22T10:00:00+05:00', status: 'green', summary: 'x', columns: [], rows: [], sverka }));
  writeFileSync(join(dir, 'run.py'), 'import json\nprint("ok")\n');
  r = cli('compare', slug);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /нельзя/);
});

test('compare: эталон и result.json из файлов; нет эталона, нет sverka, пустой эталон → код 2', () => {
  const out = join(cab, 'output', 'razbor');
  mkdirSync(join(cab, 'processes', 'razbor'), { recursive: true });
  writeFileSync(join(cab, 'processes', 'razbor', 'process.json'), JSON.stringify({ title: 'Разбор обращений', phrase: 'запусти разбор обращений', kind: 'script' }));
  mkdirSync(out, { recursive: true });
  let r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /Эталона нет: output\/razbor\/etalon-skilla\.json, нет файла/);
  writeFileSync(join(out, 'etalon-skilla.json'), JSON.stringify(ETALON));
  r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /Результата программы нет/);
  const result = { title: 'Разбор обращений', updated_at: '2026-10-22T10:00:00+05:00', status: 'green', summary: 'x', columns: [], rows: [] };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result));
  r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /нет раздела sverka/);
  writeFileSync(join(out, 'result.json'), JSON.stringify({ ...result, sverka: { 'итоги': ETALON['итоги'], 'по категориям': ETALON['по категориям'], 'по строкам': ETALON['по строкам'] } }));
  r = cli('compare', 'razbor');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Сверка «Разбор обращений»: эталон output\/razbor\/etalon-skilla\.json \(файл obrashcheniya\.xlsx\), программа output\/razbor\/result\.json от 22\.10\.2026/);
  writeFileSync(join(out, 'etalon-skilla.json'), JSON.stringify({ 'скилл': 'x' }));
  r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /В эталоне нет ни одного раздела/);
  writeFileSync(join(out, 'etalon-skilla.json'), '{ битый');
  r = cli('compare', 'razbor');
  assert.equal(r.code, 2);
  assert.match(r.out, /повреждён/);
});

test('programProblems: блок «Данные из интернета» из справки проходит проверку программы', () => {
  const guide = readFileSync(join(ROOT, '.claude', 'skills', 'add-process', 'programma.md'), 'utf8');
  // На Windows git отдаёт файлы с CRLF: перевод строки любой.
  const block = /```python\r?\n(# --- Данные из интернета ---[\s\S]*?)```/.exec(guide);
  assert.ok(block, 'в справке нет блока «Данные из интернета»');
  assert.deepEqual(programProblems(block[1]), []);
});

test('programProblems: модель только через tools/llm.py; прямые API моделей помечаются', () => {
  const guide = readFileSync(join(ROOT, '.claude', 'skills', 'add-process', 'programma.md'), 'utf8');
  const block = /```python\r?\n(try:\r?\n    import llm[\s\S]*?)```/.exec(guide);
  assert.ok(block, 'в справке нет блока «Модель внутри программы»');
  assert.deepEqual(programProblems(block[1]), []);
  assert.deepEqual(programProblems('import llm\nans = llm.ask("Кратко", "итоги")'), []);
  for (const bad of ['url = "https://api.anthropic.com/v1/messages"', 'import openai', 'r = requests.post("https://api.openai.com/v1/chat")']) {
    assert.ok(programProblems(bad).some((x) => x.why.includes('tools/llm.py')), bad);
  }
});
