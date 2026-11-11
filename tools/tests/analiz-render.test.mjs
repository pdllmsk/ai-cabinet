// Страница сервиса «Аналитика таблиц»: analiz.js (паспорт, ответы, график SVG) в песочнице, как render.js,
// разметка analiz.html и карточка-ссылка на главной странице.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'templates', 'site');
const PAGE = readFileSync(join(SITE, 'analiz.html'), 'utf8');

const window = {};
runInNewContext(readFileSync(join(SITE, 'analiz.js'), 'utf8'), { window });
const R = window.AnalizRender;

const ANSWER = {
  id: 'otvet-1',
  question: 'Как изменились продажи по Точка за последнюю неделю к предыдущей?',
  spec: { table: 'sales.csv' },
  columns: ['Точка', 'Сумма A', 'Сумма B', 'Изменение', 'Изменение, %'],
  rows: [
    ['Точка-01', 10500.5, 9800, -700.5, -6.67],
    ['Точка-02', 8200, 9020, 820, 10],
    ['Точка-03', 12000, 12000, 0, 0],
  ],
  total_rows: 12,
  totals: { 'Сумма A': 30700.5, 'Сумма B': 30820, Изменение: 119.5, 'Изменение, %': 0.39 },
  notes: ['пропущено 2 строки: не число в «Сумма»'],
  summary: 'Сеть: +0,4% за неделю, сильнее всего упала Точка-01.',
  time: '2026-10-29T22:15:00',
};

const count = (html, re) => (html.match(new RegExp(re.source, 'g')) ?? []).length;

// ---------- паспорт ----------

test('паспорт: файлы, листы, столбцы с типами, число строк, значения и «значения скрыты»', () => {
  const html = R.renderPassport({
    files: [
      {
        file: 'sales.csv',
        sheets: [
          {
            sheet: null,
            rows: 1312,
            columns: [
              { name: 'Дата', type: 'date', first: '2026-09-07', last: '2026-09-20' },
              { name: 'Сумма, тг', type: 'number', min: 0, max: 2340.8 },
              { name: 'Точка', type: 'text', values: ['Точка-01', 'Точка-02'] },
              { name: 'Оператор', type: 'text', values_hidden: true },
            ],
          },
        ],
      },
      { file: 'kniga.xlsx', sheets: [{ sheet: 'Январь', rows: 10, columns: ['А'] }, { sheet: 'Февраль', rows: 12, columns: ['А'] }] },
    ],
    warnings: ['Файл sales.csv большой: 1 312 строк.'],
  });
  assert.match(html, /Файлов: 2, листов: 3, строк всего: 1\u00a0334\./);
  assert.match(html, /<span class="file-name">sales\.csv<\/span>/);
  assert.match(html, /строк: 1\u00a0312, столбцов: 4/);
  assert.match(html, /<span class="type t-date">дата<\/span>/);
  assert.match(html, /с 07\.09\.2026 по 20\.09\.2026/);
  assert.match(html, /<span class="type t-num">число<\/span><\/td><td class="col-info">от 0 до 2\u00a0340,8/);
  assert.match(html, /Точка-01, Точка-02/);
  assert.match(html, /col-info muted">значения скрыты/);
  assert.match(html, /Лист «Январь»/);
  assert.match(html, /Лист «Февраль»/);
  assert.match(html, /<li>Файл sales\.csv большой/);
  assert.equal(count(html, /<details class="file" open>/), 2);
});

test('паспорт в виде движка analiz.py: размер, строки над шапкой, пустые ячейки, пропущенные файлы', () => {
  const html = R.renderPassport({
    dir: 'input/analiz',
    files: [
      {
        file: 'prodazhi_1c.csv',
        type: 'csv',
        size_kb: 2048,
        sheets: [
          {
            sheet: null,
            rows: 1312,
            title: ['Продажи ювелирных изделий по Точка за период 07.09.2026 - 20.09.2026'],
            columns: [
              { name: 'Дата', type: 'дата', first: '2026-09-07', last: '2026-09-20' },
              { name: 'Сумма, тг', type: 'число', empty: 3, min: 0, max: 2340.8 },
              { name: 'Точка', type: 'текст', distinct: 12, values: ['Точка-01', 'Точка-02'] },
              { name: 'Комментарий', type: 'текст', distinct: 900 },
            ],
          },
        ],
      },
      { file: 'pusto.xlsx', type: 'xlsx', size_kb: 0, sheets: [{ sheet: 'Лист1', rows: 0, note: 'нет данных' }] },
    ],
    skipped: [{ file: 'bityi.xlsx', reason: 'файл не читается (BadZipFile)' }],
    warnings: [],
    total_rows: 1312,
  });
  assert.match(html, /строк: 1\u00a0312, столбцов: 4, 2 МБ/);
  assert.match(html, /Над таблицей: Продажи ювелирных изделий по Точка/);
  assert.match(html, /от 0 до 2\u00a0340,8<span class="col-extra">; пустых: 3<\/span>/);
  assert.match(html, /разных значений: 900/);
  assert.match(html, /Лист «Лист1»/);
  assert.match(html, /<p class="hint">нет данных<\/p>/);
  assert.match(html, /<li>Не прочитан файл bityi\.xlsx: файл не читается \(BadZipFile\)\. Откройте его в Excel и сохраните как \.xlsx, затем «Обновить»\.<\/li>/);
  assert.doesNotMatch(html, /Папка с данными пока пустая|Файлы есть, но не читаются/);
  // Пустая папка в виде движка: своя подсказка страницы, без повтора подсказки движка.
  const empty = R.renderPassport({ files: [], skipped: [], warnings: ['В папке input/analiz пока нет таблиц: положите туда файлы Excel (.xlsx) или CSV.'] });
  assert.match(empty, /Папка с данными пока пустая/);
  assert.match(empty, /«Загрузить файлы» или перетащите их в этот блок/);
  assert.doesNotMatch(empty, /пока нет таблиц/);
});

test('паспорт: файлы есть, но ни один не прочитан → имя, причина и что сделать, а не «пустая папка»', () => {
  // Как отвечает движок: skipped и та же причина строкой в warnings.
  const html = R.renderPassport({
    files: [],
    skipped: [{ file: 'Продажи октябрь.xlsx', reason: 'файл не читается (ValueError).' }, { file: 'старый.csv', reason: 'ссылка на файл вне папки input/analiz, не читается' }],
    warnings: ['Файл «Продажи октябрь.xlsx» не прочитан: файл не читается (ValueError).', 'Файл «старый.csv» не прочитан: ссылка на файл вне папки input/analiz, не читается'],
  });
  assert.doesNotMatch(html, /Папка с данными пока пустая/);
  assert.match(html, /<p class="empty-title">Файлы есть, но не читаются\.<\/p><ul class="skipped">/);
  assert.match(html, /<li><span>Продажи октябрь\.xlsx: файл не читается \(ValueError\)<\/span><button type="button" class="file-del" data-delete="Продажи октябрь\.xlsx" title="Удалить файл"/);
  assert.match(html, /<li><span>старый\.csv: ссылка на файл вне папки input\/analiz, не читается<\/span><button type="button" class="file-del" data-delete="старый\.csv"/);
  assert.match(html, /<p>Откройте файл в Excel и сохраните как \.xlsx, затем «Обновить»\. Ненужный файл удалите корзиной\.<\/p>/);
  assert.doesNotMatch(html, /не прочитан:/, 'причина не повторяется строкой движка');
  // Имя из данных экранируется.
  assert.match(R.renderPassport({ files: [], skipped: [{ file: '<b>.csv', reason: 'x' }] }), /&lt;b&gt;\.csv: x/);
  // Строка вместо объекта и пропуск без причины.
  assert.match(R.renderPassport({ files: [], skipped: ['a.csv'] }), /<li><span>a\.csv<\/span><button type="button" class="file-del" data-delete="a\.csv"/);
});

test('паспорт: файлов нет → подсказка, куда положить; другие написания полей тоже понимаются', () => {
  for (const empty of [{ files: [] }, {}, null, []]) {
    const html = R.renderPassport(empty);
    assert.match(html, /Папка с данными пока пустая/);
    assert.match(html, /input\/analiz/);
    assert.match(html, /«Открыть папку с данными»/);
  }
  const flat = R.normalizePassport({ tables: [{ name: 'a.csv', rows: 5, columns: [{ col: 'X', type: 'число' }] }, 'b.xlsx', { file: 'c.csv', error: 'Не читается' }] });
  assert.equal(flat.files.length, 3);
  assert.equal(flat.files[0].name, 'a.csv');
  assert.equal(flat.files[0].sheets[0].rows, 5);
  assert.equal(flat.files[0].sheets[0].columns[0].name, 'X');
  assert.equal(flat.files[0].sheets[0].columns[0].type, 'число');
  assert.equal(flat.files[1].name, 'b.xlsx');
  assert.match(R.renderPassport({ files: [{ file: 'c.csv', error: 'Не читается <b>' }] }), /<p class="error">Не читается &lt;b&gt;<\/p>/);
  // Много файлов: свёрнуты, длинный список значений обрезается.
  const many = R.renderPassport({ files: [1, 2, 3].map((i) => ({ file: `f${i}.csv`, rows: 1, columns: [{ name: 'Т', type: 'text', values: Array.from({ length: 40 }, (_, k) => `v${k}`) }] })) });
  assert.equal(count(many, /<details class="file">/), 3);
  assert.match(many, /v29 и ещё 10/);
});

// ---------- ответ ----------

test('ответ: вопрос, время, итог без таблицы, примечания, кнопки', () => {
  const html = R.renderAnswer(ANSWER, {});
  assert.match(html, /<article class="card answer" data-key="id:otvet-1">/);
  assert.match(html, /<h3 class="question">Как изменились продажи по Точка/);
  assert.match(html, /<span class="when">29\.10\.2026 22:15<\/span>/);
  assert.match(html, /<p class="summary">Сеть: \+0,4% за неделю/);
  assert.doesNotMatch(html, /<table/);  // таблицу ответа не показываем, только итог, график и Excel
  assert.match(html, /<p class="notes-title">Примечания<\/p><ul class="notes"><li>пропущено 2 строки/);
  assert.match(html, /<button type="button" class="btn" data-chart="id:otvet-1" aria-expanded="false">Построить график<\/button>/);
  assert.match(html, /<button type="button" class="btn" data-excel="id:otvet-1">Скачать Excel с графиком<\/button>/);
  assert.doesNotMatch(html, /<svg/);
  // Знак минус обычный дефис: без тире и «настоящего минуса».
  assert.doesNotMatch(html, /[\u2012-\u2015\u2212]/);
});

test('ответ: годы без пробела между тысячами, остальные числа с пробелом от 1 000; у CSV нет «Листа»', () => {
  const html = R.renderTable({ columns: ['Год', 'Сумма'], rows: [[2025, 7413.1], [2026, 17203]] });
  assert.match(html, /<td class="num">2025<\/td><td class="num">7\u00a0413,1<\/td>/);
  assert.match(html, /<td class="num">2026<\/td><td class="num">17\u00a0203<\/td>/);
  const csv = R.renderPassport({ files: [{ file: 'a.csv', sheets: [{ sheet: null, rows: 2, title: ['Отчёт за сентябрь'], columns: [{ name: 'А', type: 'текст' }] }] }] });
  assert.doesNotMatch(csv, /Лист «/);
  assert.match(csv, /Над таблицей: Отчёт за сентябрь/);
});

test('ответ: текст из данных экранируется; без номера ответа Excel недоступен; ошибка и пустой ответ', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const html = R.renderAnswer({ question: evil, columns: [evil], rows: [[evil]], summary: evil, notes: [evil] }, {});
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  assert.match(html, /data-excel="q:[^"]*" disabled>/);
  const err = R.renderAnswer({ id: 'e', question: 'вопрос', error: 'Нет столбца «Сумма»' }, {});
  assert.match(err, /<p class="run-error">Нет столбца «Сумма»<\/p>/);
  assert.doesNotMatch(err, /data-chart/);
  assert.match(R.renderAnswers([]), /Ответов пока нет/);
  assert.match(R.renderAnswers([ANSWER], {}, 70), /Показаны последние 1 ответов из 70/);
});

test('ответ: состояния кнопки Excel (готовлю, ошибка, файл готов со ссылкой)', () => {
  assert.match(R.renderAnswer(ANSWER, { excel: { busy: true } }), /data-excel="id:otvet-1" disabled>.*Готовлю файл Excel/);
  assert.match(R.renderAnswer(ANSWER, { excel: { error: 'Нет openpyxl' } }), /class="action-msg error">Нет openpyxl/);
  assert.match(
    R.renderAnswer(ANSWER, { excel: { url: 'output/analiz/otvet-1.xlsx', file: 'otvet-1.xlsx' } }),
    /Файл готов: <a href="output\/analiz\/otvet-1\.xlsx" download>otvet-1\.xlsx<\/a>/,
  );
});

// ---------- график ----------

test('график: столбики для категорий, по умолчанию «Изменение, %», выбор показателя, минус ниже нуля', () => {
  const html = R.renderAnswer(ANSWER, { chart: true });
  assert.match(html, /aria-expanded="true">Скрыть график/);
  assert.match(html, /<div class="chart">/);
  assert.match(html, /<p class="chart-title">Изменение, % <span class="chart-by">по столбцу «Точка»<\/span>/);
  assert.match(html, /<select data-measure="id:otvet-1">/);
  assert.match(html, /<option value="4" selected>Изменение, %<\/option>/);
  assert.match(html, /<svg class="chart-svg" viewBox="0 0 960 380"/);
  // Нулевое значение без столбика, остальные со своим столбиком; подписи категорий снизу.
  assert.equal(count(html, /<path class="bar"/), 2);
  assert.equal(count(html, /<text class="cat"[^>]*text-anchor="middle">Точка-0\d<\/text>/), 3);
  assert.match(html, /<title>Точка-01: -6,67 %<\/title>/);
  assert.match(html, /<line class="zero"/);
  const gap = R.renderChart({ columns: ['Точка', 'Изменение, %'], rows: [['Точка-01', 5], ['Точка №7', null], ['Точка-02', -3]] });
  assert.match(gap, /Без числа в «Изменение, %», на графике нет: Точка №7\./);
  const litry = R.renderChart(ANSWER, 1);
  assert.match(litry, /<option value="1" selected>Сумма A<\/option>/);
  assert.match(litry, /<title>Точка-01: 10\u00a0500,5<\/title>/);
});

test('график: длинные подписи и много строк → полосы с подписями слева, не больше 30', () => {
  const rows = Array.from({ length: 45 }, (_, i) => [`Точка на трассе Алматы - Бишкек № ${i + 1}`, 100 + i]);
  const html = R.renderChart({ columns: ['Точка', 'Сумма'], rows });
  assert.equal(count(html, /<path class="bar"/), 30);
  assert.match(html, /<text class="cat" x="\d+(\.\d+)?" y="[\d.]+" text-anchor="end">Точка на трассе/);
  assert.match(html, /На графике первые 30 строк из 45, как в таблице\./);
  assert.doesNotMatch(html, /<select/);
  // Отрицательные значения: полосы влево от нуля, подпись значения слева от конца полосы.
  const neg = R.renderChart({ columns: ['Точка', 'Изменение'], rows: Array.from({ length: 13 }, (_, i) => [`Точка-${i + 1}`, i === 0 ? -50 : 30 + i]) });
  assert.equal(count(neg, /<path class="bar"/), 13);
  assert.match(neg, /<text class="value" x="[\d.]+" y="[\d.]+" text-anchor="end">-50<\/text>/);
  assert.match(neg, /<text class="value" x="[\d.]+" y="[\d.]+" text-anchor="start">42<\/text>/);
  // Две длинные подписи помещаются под столбиками: столбики.
  const two = R.renderChart({ columns: ['Номенклатура', 'Изменение'], rows: [['Сереброное золото летнее', -50], ['Золото Золото 585 класса К4', 30]] });
  assert.match(two, /viewBox="0 0 960 380"/);
});

test('график: первый столбец дата → линия по времени с точками и подписями дат', () => {
  const rows = Array.from({ length: 14 }, (_, i) => [`2026-09-${String(7 + i).padStart(2, '0')}`, 1000 + i * 37.5]);
  const html = R.renderChart({ columns: ['Дата', 'Сумма'], rows: rows.reverse() });
  assert.match(html, /<path class="line" d="M/);
  assert.equal(count(html, /<circle class="dot"/), 14);
  // Подписи дат с ровным шагом от последней: 20.09, 18.09, ..., 08.09 (не больше 8, соседние не слипаются).
  const dates = [...html.matchAll(/<text class="cat"[^>]*>(\d\d\.\d\d)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(dates, ['20.09', '18.09', '16.09', '14.09', '12.09', '10.09', '08.09']);
  assert.match(html, /<title>20\.09\.2026: 1\u00a0487,5<\/title>/);
  assert.doesNotMatch(html, /<path class="bar"/);
  const months = R.renderChart({ columns: ['Месяц', 'Сумма'], rows: [['2025-10', 5], ['2025-11', 7], ['2026-01', 6]] });
  assert.match(months, />10\.2025<\/text>/);
  assert.match(months, /<path class="line"/);
});

test('график: две группы (group_columns) → подпись строки из обеих, показатель после них', () => {
  const a = {
    columns: ['Точка', 'Золото', 'Сумма'],
    group_columns: 2,
    rows: [['Точка-01', 'Золото 585', 100], ['Точка-01', 'Платина', 50], ['Точка-02', 'Золото 585', 70]],
  };
  const html = R.renderChart(a);
  assert.match(html, /по столбцам «Точка», «Золото»/);
  assert.match(html, /<title>Точка-01 · Золото 585: 100<\/title>/);
  assert.equal(count(html, /<path class="bar"/), 3);
});

test('график: нет чисел или одна строка → понятная подсказка вместо пустого рисунка', () => {
  assert.match(R.renderChart({ columns: ['Точка', 'Тема'], rows: [['Точка-01', 'текст'], ['Точка-02', 'ещё']] }), /нужен столбец с числами/);
  assert.match(R.renderChart({ columns: ['Точка', 'Сумма'], rows: [['Точка-01', 5]] }), /хотя бы две строки/);
  // Числа строкой тоже рисуются.
  assert.match(R.renderChart({ columns: ['Точка', 'Сумма'], rows: [['Точка-01', '1 234,5'], ['Точка-02', '17']] }), /<path class="bar"/);
});

// ---------- вопрос не получился ----------

test('нет claude (код 3): подсказка про вкладку Code с готовой фразой и кнопкой «Скопировать»', () => {
  const html = R.renderAskProblem(503, { code: 'ENOCLAUDE', phrase: 'проанализируй таблицу: сумма по "Точка"' }, 'сумма по "Точка"');
  assert.match(html, /вкладке <b>Code<\/b>/);
  assert.match(html, /value="проанализируй таблицу: сумма по &quot;Точка&quot;"/);
  assert.match(html, /data-copy="phrase">Скопировать</);
  assert.match(R.renderAskProblem(503, { code: 'ENOCLAUDE' }, 'вопрос'), /value="проанализируй таблицу: вопрос"/);
});

test('проверка ПД (код 4): причина от движка и подсказка обезличить; прочие ошибки текстом', () => {
  const pd = R.renderAskProblem(422, { code: 'EPERSONAL', error: 'в модель ушли бы персональные данные: ИИН' }, 'q');
  assert.match(pd, /Вопрос не отправлен\.<\/b> в модель ушли бы персональные данные: ИИН/);
  assert.match(pd, /анонимайзером с воркшопа 2/);
  assert.match(R.renderAskProblem(422, { code: 'EENGINE', error: 'Нет столбца <x>' }, 'q'), /<div class="notice"><p>Нет столбца &lt;x&gt;<\/p>/);
  assert.match(R.renderAskProblem(422, { code: 'EROWS', error: 'Этот вопрос требует строк с текстом' }, 'q'), /<div class="notice"><p>Этот вопрос требует строк/);
  assert.match(R.renderAskProblem(500, { error: 'Python не найден' }, 'q'), /<p class="run-error">Python не найден<\/p>/);
  assert.match(R.renderAskProblem(504, { code: 'ETIMEOUT', error: 'долго', phrase: 'проанализируй таблицу: q' }, 'q'), /data-copy="phrase"/);
  assert.match(R.renderAskProblem(404, {}, 'q'), /запущена до обновления/);
});

// ---------- разметка страниц ----------

test('analiz.html: заголовок, бренд как на главной, ссылка на кабинет, только относительные ссылки, без интернета', () => {
  assert.match(PAGE, /data-cabinet="ok"/);
  assert.match(PAGE, /<title>Аналитика таблиц<\/title>/);
  assert.match(PAGE, /<h1>Аналитика таблиц<\/h1>/);
  // Каркас как на главной: меню слева, пункт «Аналитика таблиц» подсвечен, «Все сервисы» ведёт на главную.
  assert.match(PAGE, /<nav class="side" id="side" aria-label="Меню кабинета">/);
  assert.match(PAGE, /<a class="nav-item" id="nav-all" href="\.\/">[\s\S]*?Все сервисы<\/span><\/a>/);
  assert.match(PAGE, /<a class="nav-item" href="analiz\.html" aria-current="page">[\s\S]*?Аналитика таблиц<\/span><\/a>/);
  assert.match(PAGE, /<div class="nav-group" id="nav-mine" hidden>/);
  assert.match(PAGE, /Как добавить сервис[\s\S]*Откройте Claude во вкладке <b>Code<\/b> в новой папке и скажите <b>«новый сервис»<\/b>: Claude создаст проект\. Когда сервис готов, скажите <b>«добавь в кабинет»<\/b>\./);
  assert.match(PAGE, /<span class="nav-current" id="nav-current">Аналитика таблиц<\/span>/);
  assert.doesNotMatch(PAGE, /class="back"/);
  assert.ok(PAGE.indexOf('id="side"') < PAGE.indexOf('id="data-card"'), 'меню слева от содержимого');
  // Меню и раскладка такие же, как на главной: одни и те же правила CSS.
  const index = readFileSync(join(SITE, 'index.html'), 'utf8');
  const block = (html, from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  assert.equal(block(PAGE, '  /* Каркас', '  .help b'), block(index, '  /* Каркас', '  .help b'));
  assert.equal(block(PAGE, '  /* Узкий экран', '  @media (max-width: 640px)'), block(index, '  /* Узкий экран', '  @media (max-width: 640px)'));
  assert.match(PAGE, /<script src="render\.js"><\/script>\s*<script src="analiz\.js"><\/script>/);
  // Загрузка файлов: кнопка, выбор нескольких файлов нужных типов, блок принимает перетаскивание.
  assert.match(PAGE, /<button type="button" class="btn btn-accent" id="upload">Загрузить файлы<\/button>/);
  assert.match(PAGE, /<input type="file" id="file-input" multiple accept="\.xlsx,\.xlsm,\.csv,\.txt" hidden>/);
  assert.match(PAGE, /<section class="card drop-zone" id="data-card"/);
  for (const needle of ["fetch('api/analiz/upload'", "'Content-Type': 'application/octet-stream'", "'X-File-Name': encodeURIComponent(name)", "'drop'", "'dragover'"]) {
    assert.ok(PAGE.includes(needle), needle);
  }
  assert.doesNotMatch(PAGE, /[\u2012-\u2015]/);
  assert.match(PAGE, /<\/style>\s*<link rel="stylesheet" href="brand\/theme\.css">/);
  assert.match(PAGE, /<img class="brand-logo" id="brand-logo" alt="" hidden>/);
  for (const needle of ["'brand/logo.svg'", "'brand/logo.png'", "fetch('brand/brand.json'"]) assert.ok(PAGE.includes(needle), needle);
  for (const v of ['--accent:', '--accent-ink:', '--accent-dark:', '--accent-dark-ink:', '--link:', '--stripe:', '--logo-height:']) {
    assert.ok(PAGE.includes(v), v);
  }
  // Адрес страницы содержит секретную часть: ни одной ссылки от корня сайта и ни одного внешнего ресурса.
  assert.doesNotMatch(PAGE, /(src|href|action)="(\/|https?:|\/\/)/);
  assert.doesNotMatch(PAGE, /fetch\(['"`]\//);
  assert.doesNotMatch(PAGE, /@import|url\(/);
  assert.doesNotMatch(PAGE, /https?:\/\//);
  for (const needle of ["'X-Cabinet': '1'", "'Content-Type': 'application/json'", "method: 'POST'", "'api/analiz/' + path", "call('passport')", "call('history')", "call('ask'", "call('excel'", "call('open-folder'"]) {
    assert.ok(PAGE.includes(needle), needle);
  }
  for (const block of ['Ваши данные', 'Открыть папку с данными', 'Ваш вопрос', '>Спросить<', 'Считаю…', 'Ответы']) assert.ok(PAGE.includes(block), block);
  assert.ok(PAGE.includes('maxlength="1000"'), 'длина вопроса ограничена и на странице');
  const js = readFileSync(join(SITE, 'analiz.js'), 'utf8');
  assert.doesNotMatch(js, /https?:\/\/|fetch\(|import\s/);
});

test('главная: «Аналитика таблиц» в меню и первой карточкой в сетке, ссылки относительные', () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  assert.match(html, /<a class="nav-item" href="analiz\.html">/);
  const w = {};
  runInNewContext(readFileSync(join(SITE, 'render.js'), 'utf8'), { window: w });
  const grid = w.CabinetRender.renderPage([{ slug: 'a', title: 'А', kind: 'script', result: null }]);
  assert.ok(grid.indexOf('<a class="tile tile-service" href="analiz.html">') !== -1, 'нет карточки-ссылки');
  assert.ok(grid.indexOf('tile-service') < grid.indexOf('data-slug="a"'), 'карточка перед процессами');
  assert.doesNotMatch(html + grid, /(src|href)="(\/|https?:|\/\/)/);
});

// ---------- скрипт страницы в песочнице ----------

function stub(extra = {}) {
  return {
    hidden: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    value: '',
    on: {},
    addEventListener(type, fn) {
      this.on[type] = fn;
    },
    focus() {},
    ...extra,
  };
}

// Скрипт страницы (первый встроенный <script>) с подставными DOM, fetch и таймерами.
function pageSandbox(respond) {
  const code = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const ids = ['passport', 'answers', 'ask-form', 'question', 'ask', 'busy', 'ask-msg', 'folder-msg', 'open-folder', 'refresh', 'upload', 'file-input', 'data-card'];
  const el = Object.fromEntries(ids.map((id) => [id, stub()]));
  const classes = new Set();
  el['data-card'].classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c) };
  el['file-input'].click = () => {
    el['file-input'].clicked = (el['file-input'].clicked ?? 0) + 1;
  };
  const calls = [];
  const winOn = {};
  const document = { getElementById: (id) => el[id] ?? null, visibilityState: 'visible', addEventListener() {} };
  const sandbox = {
    window: {
      AnalizRender: R,
      addEventListener(type, fn) {
        winOn[type] = fn;
      },
    },
    document,
    navigator: {},
    fetch: (url, opts = {}) => {
      calls.push({ url, opts });
      return respond(url, opts);
    },
    setTimeout: () => 0,
    setInterval: () => 1,
    clearInterval() {},
    Date,
    JSON,
    Promise,
    Number,
    String,
    Array,
  };
  runInNewContext(code, sandbox);
  return { el, calls, winOn, classes };
}

const json = (status, data) => Promise.resolve({ status, ok: status < 300, json: () => Promise.resolve(data) });
const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

test('страница: при открытии паспорт и история с заголовком X-Cabinet по относительным адресам', async () => {
  const p = pageSandbox((url) =>
    url === 'api/analiz/passport' ? json(200, { ok: true, passport: { files: [] } }) : json(200, { ok: true, items: [ANSWER], total: 1 }),
  );
  await settle();
  assert.deepEqual(p.calls.map((c) => c.url).sort(), ['api/analiz/history', 'api/analiz/passport']);
  for (const c of p.calls) assert.equal(c.opts.headers['X-Cabinet'], '1');
  assert.match(p.el.passport.innerHTML, /Папка с данными пока пустая/);
  assert.match(p.el.answers.innerHTML, /data-key="id:otvet-1"/);
});

test('страница: «Спросить» шлёт вопрос JSON-ом; код 3 показывает фразу для вкладки Code; пустой вопрос не уходит', async () => {
  let askBody = null;
  const p = pageSandbox((url, opts) => {
    if (url === 'api/analiz/ask') {
      askBody = opts;
      return json(503, { code: 'ENOCLAUDE', error: 'нет claude', phrase: 'проанализируй таблицу: сумма по Точка' });
    }
    return url === 'api/analiz/passport' ? json(200, { passport: { files: [] } }) : json(200, { items: [], total: 0 });
  });
  await settle();
  p.el.question.value = '   ';
  p.el['ask-form'].on.submit({ preventDefault() {} });
  await settle();
  assert.equal(askBody, null);
  assert.match(p.el['ask-msg'].innerHTML, /Напишите вопрос/);
  p.el.question.value = 'сумма по Точка';
  p.el['ask-form'].on.submit({ preventDefault() {} });
  assert.equal(p.el.ask.disabled, true, 'кнопка неактивна, пока считается');
  assert.equal(p.el.busy.hidden, false, 'виден индикатор «Считаю…»');
  await settle();
  assert.equal(askBody.method, 'POST');
  assert.equal(askBody.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(askBody.body), { question: 'сумма по Точка' });
  assert.match(p.el['ask-msg'].innerHTML, /value="проанализируй таблицу: сумма по Точка"/);
  assert.equal(p.el.ask.disabled, false);
  assert.equal(p.el.busy.hidden, true);
  assert.equal(p.el.question.value, 'сумма по Точка', 'вопрос остаётся в поле');
});

test('страница: удачный ответ перечитывает историю и очищает поле; три неудачи подряд останавливают страницу', async () => {
  let history = [];
  const p = pageSandbox((url) => {
    if (url === 'api/analiz/ask') {
      history = [ANSWER];
      return json(200, { ok: true, answer: ANSWER });
    }
    return url === 'api/analiz/passport' ? json(200, { passport: { files: [] } }) : json(200, { items: history, total: history.length });
  });
  await settle();
  p.el.question.value = ANSWER.question;
  p.el['ask-form'].on.submit({ preventDefault() {} });
  await settle();
  assert.equal(p.el.question.value, '');
  assert.match(p.el.answers.innerHTML, /data-key="id:otvet-1"/);

  const down = pageSandbox(() => Promise.reject(new TypeError('Failed to fetch')));
  await settle();
  down.el.refresh.on.click();
  await settle();
  assert.match(down.el.answers.innerHTML, /Страница остановлена/);
  assert.equal(down.el.ask.disabled, true);
  const n = down.calls.length;
  down.el.refresh.on.click();
  down.el['ask-form'].on.submit({ preventDefault() {} });
  await settle();
  assert.equal(down.calls.length, n, 'после остановки запросов нет');
});

// ---------- загрузка файлов со страницы ----------

const fakeFile = (name, size = 10) => ({ name, size });
const dragEvent = (files) => ({ preventDefault() {}, dataTransfer: { types: ['Files'], files, dropEffect: '' } });

test('загрузка: «Загрузить файлы» открывает выбор; файлы по одному, имя в X-File-Name, тело файла как есть; паспорт перечитывается', async () => {
  const uploads = [];
  const p = pageSandbox((url, opts) => {
    if (url === 'api/analiz/upload') {
      uploads.push(opts);
      const name = decodeURIComponent(opts.headers['X-File-Name']);
      if (name === 'Продажи.xlsx') return json(200, { ok: true, file: 'Продажи (2).xlsx', renamed: true });
      return json(200, { ok: true, file: name, renamed: false });
    }
    return url === 'api/analiz/passport' ? json(200, { passport: { files: [] } }) : json(200, { items: [], total: 0 });
  });
  await settle();
  p.el.upload.on.click();
  assert.equal(p.el['file-input'].clicked, 1);
  const a = fakeFile('Продажи.xlsx');
  const b = fakeFile('Точка сентябрь.csv');
  p.el['file-input'].files = [a, b];
  p.el['file-input'].on.change();
  assert.equal(p.el.upload.disabled, true, 'кнопка неактивна, пока идёт загрузка');
  await settle();
  assert.equal(uploads.length, 2);
  for (const o of uploads) {
    assert.equal(o.method, 'POST');
    assert.equal(o.headers['X-Cabinet'], '1');
    assert.equal(o.headers['Content-Type'], 'application/octet-stream');
  }
  assert.equal(uploads[0].headers['X-File-Name'], encodeURIComponent('Продажи.xlsx'));
  assert.equal(uploads[0].body, a);
  assert.equal(uploads[1].body, b);
  assert.equal(p.el['file-input'].value, '', 'выбор сброшен: тот же файл можно выбрать снова');
  assert.equal(p.el['folder-msg'].hidden, false);
  assert.match(p.el['folder-msg'].textContent, /^Загружено: Продажи \(2\)\.xlsx, Точка сентябрь\.csv\. Файл «Продажи\.xlsx» уже был в папке, новый сохранён как «Продажи \(2\)\.xlsx»\.$/);
  assert.equal(p.calls.filter((c) => c.url === 'api/analiz/passport').length, 2, 'паспорт перечитан после загрузки');
  assert.equal(p.el.upload.disabled, false);
});

test('загрузка: не те файлы и больше 50 МБ не отправляются; ошибка сервера показывается; файлы, брошенные на страницу, загружаются', async () => {
  const uploads = [];
  const p = pageSandbox((url, opts) => {
    if (url === 'api/analiz/upload') {
      uploads.push(decodeURIComponent(opts.headers['X-File-Name']));
      return json(413, { code: 'EBIG', error: 'Файл «big.csv» не загружен. Файл больше 50 МБ.' });
    }
    return url === 'api/analiz/passport' ? json(200, { passport: { files: [] } }) : json(200, { items: [], total: 0 });
  });
  await settle();
  const drop = p.winOn.drop;
  assert.equal(typeof drop, 'function', 'страница принимает брошенные файлы');
  p.winOn.dragenter(dragEvent([]));
  assert.ok(p.classes.has('dragover'), 'блок «Ваши данные» подсвечен');
  drop(dragEvent([fakeFile('virus.exe'), fakeFile('staryi.xls'), fakeFile('ogromnyi.xlsx', 50 * 1024 * 1024 + 1), fakeFile('big.csv')]));
  assert.ok(!p.classes.has('dragover'));
  await settle();
  assert.deepEqual(uploads, ['big.csv'], 'на сервер ушёл только подходящий файл');
  const msg = p.el['folder-msg'].textContent;
  assert.match(msg, /Файл «virus\.exe» не загружен: подходят Excel \(\.xlsx, \.xlsm\) и CSV \(\.csv, \.txt\)\./);
  assert.match(msg, /Файл «staryi\.xls» не загружен/);
  assert.match(msg, /Файл «ogromnyi\.xlsx» не загружен: он больше 50 МБ\./);
  assert.match(msg, /Файл «big\.csv» не загружен\. Файл больше 50 МБ\./);
  assert.doesNotMatch(msg, /Загружено/);
  assert.equal(p.calls.filter((c) => c.url === 'api/analiz/passport').length, 1, 'ничего не загрузилось: паспорт не перечитывается');
  // Перетаскивают не файлы (текст, ссылку): страница не мешает.
  let prevented = false;
  p.winOn.drop({ preventDefault: () => (prevented = true), dataTransfer: { types: ['text/plain'] } });
  assert.equal(prevented, false);
});

// ---------- меню на странице «Аналитика таблиц» ----------

const NOT_FOUND = () => json(404, { error: 'Такого адреса у страницы нет.' });

function menuSandbox(respond, services = NOT_FOUND) {
  const code = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const w = { addEventListener(type, fn) { w.on[type] = fn; }, on: {} };
  runInNewContext(readFileSync(join(SITE, 'render.js'), 'utf8'), { window: w });
  const el = { 'nav-mine': stub({ hidden: true }), 'nav-list': stub(), side: stub({ className: 'side' }), 'nav-toggle': stub() };
  el['nav-toggle'].attrs = { 'aria-expanded': 'false' };
  el['nav-toggle'].getAttribute = (k) => el['nav-toggle'].attrs[k];
  el['nav-toggle'].setAttribute = (k, v) => (el['nav-toggle'].attrs[k] = v);
  const calls = [];
  const document = { getElementById: (id) => el[id] ?? null, visibilityState: 'visible' };
  const fetch = (url, opts) => (calls.push(url), url.startsWith('api/services') ? services(url, opts) : respond(url, opts));
  runInNewContext(code, { window: w, document, fetch, Error, Array, String, Promise });
  return { el, calls, w };
}

test('«Аналитика таблиц»: меню «Мои сервисы» из api/processes, ссылки на главную с подробным видом', async () => {
  const list = [{ slug: 'svetofor-tochek', title: 'Светофор точек продаж', kind: 'script', result: { status: 'green' } }];
  const m = menuSandbox(() => json(200, list));
  await settle();
  assert.deepEqual(m.calls, ['api/processes', 'api/services']);
  assert.equal(m.el['nav-mine'].hidden, false);
  assert.match(m.el['nav-list'].innerHTML, /<a class="nav-item" href="\.\/#p=svetofor-tochek"><span class="dot dot-green"/);
  // Вернулись на вкладку: список перечитан; адреса api/services нет (404), его больше не спрашивают.
  m.w.on.focus();
  await settle();
  assert.deepEqual(m.calls, ['api/processes', 'api/services', 'api/processes']);
  // Кнопка «Меню» на узком экране.
  m.el['nav-toggle'].on.click();
  assert.equal(m.el.side.className, 'side open');
  m.el['nav-toggle'].on.click();
  assert.equal(m.el.side.className, 'side');

  const none = menuSandbox(() => json(200, []));
  await settle();
  assert.equal(none.el['nav-mine'].hidden, true, 'своих сервисов нет: раздела нет');

  // Встроенные проекты рядом с процессами, ссылка на главную с #s=<slug>.
  const both = menuSandbox(() => json(200, list), () => json(200, [{ slug: 'karta-tochki', name: 'Карта Точка', kind: 'page' }]));
  await settle();
  assert.match(both.el['nav-list'].innerHTML, /href="\.\/#p=svetofor-tochek"[\s\S]*<a class="nav-item" href="\.\/#s=karta-tochki"><span class="dot dot-none"[\s\S]*Карта Точка/);

  const down = menuSandbox(() => Promise.reject(new TypeError('Failed to fetch')));
  await settle();
  down.w.on.focus();
  await settle();
  assert.equal(down.calls.filter((u) => u === 'api/processes').length, 1, 'после неудачи меню больше не спрашивает');
  assert.equal(down.el['nav-mine'].hidden, true);
});

test('ответы: последний целиком, прошлые строками списка с прокруткой, раскрытие и поиск по вопросу', () => {
  const items = [1, 2, 3, 4].map((i) => ({ id: String(i), question: i === 3 ? 'Сколько <Серебро 925>?' : `Вопрос ${i}`, time: `2026-10-30T0${i}:00:00`, summary: `Итог ${i}`, columns: ['A'], rows: [[i]] }));
  const html = R.renderAnswers(items, {}, 4);
  assert.equal((html.match(/<article class="card answer"/g) || []).length, 4, 'у каждой строки весь ответ внутри');
  assert.ok(html.indexOf('<article class="card answer" data-key="id:1">') < html.indexOf('<section class="history"'), 'последний ответ сверху, целиком');
  assert.match(html, /<h3 class="history-title" id="history-title">Прошлые вопросы <span class="history-count">3<\/span><\/h3>/);
  assert.match(html, /<details class="hist-item" data-key="id:2"><summary class="hist-row"><span class="hist-q">Вопрос 2<\/span><span class="hist-when">[^<]+<\/span><span class="hist-sum">Итог 2<\/span><\/summary>/);
  assert.match(html, /<span class="hist-q">Сколько &lt;Серебро 925&gt;\?<\/span>/, 'вопрос экранируется');
  // Раскрытая строка остаётся раскрытой.
  assert.match(R.renderAnswers(items, { 'id:3': { open: true } }, 4), /<details class="hist-item" data-key="id:3" open>/);
  // Поиск: без учёта регистра, только по прошлым вопросам; ничего не нашлось → подсказка.
  const f = R.renderAnswers(items, {}, 4, 'аи-95');
  assert.match(f, /data-key="id:2" hidden>/);
  assert.match(f, /data-key="id:3">/);
  assert.match(f, /data-key="id:4" hidden>/);
  assert.match(f, /data-key="id:1">/, 'последний ответ не прячется');
  assert.match(R.renderAnswers(items, {}, 4, 'нет такого'), /Таких вопросов нет\./);
  // Один ответ: без списка прошлых.
  assert.doesNotMatch(R.renderAnswers(items.slice(0, 1), {}, 1), /history/);
});
