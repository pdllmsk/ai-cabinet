# Набор интерфейса для своей страницы сервиса

Каталог для Claude в проекте сервиса. Своя страница (`page/index.html`) собирается только из этого набора: так все страницы сервисов выглядят как кабинет, работают без интернета и сами переключают светлую и тёмную тему вслед за кабинетом.

Набор раздаёт кабинет из своей папки `tools/ui` по адресу `ui/`. Страница лежит по адресу `s/<сервис>/page/`, поэтому путь к набору всегда `../../../ui/<файл>`. Файлы набора в проект не копируй.

| Файл | Что это |
|---|---|
| `basecoat.css` | компоненты Basecoat 1.1 (вид shadcn): кнопки, карточки, поля, таблица, вкладки, сообщения |
| `brand.css` | цвет компании из бренда кабинета (переменные `--brand-*`), его собирает кабинет |
| `kabinet.css` | цвета кабинета для Basecoat, статусы, плитка `stat`, числа в таблице |
| `kabinet.js` | помощники `kabinet.*` и тема; подключается до `tailwind.js` |
| `tailwind.js` | утилиты Tailwind 4 прямо в браузере: `flex`, `grid`, `gap-4`, `text-sm`, `bg-muted` |
| `chart.js`, `basecoat-chart.js` | графики (Chart.js 4.5 и обёртка Basecoat) |
| `basecoat.js` | поведение вкладок, уведомлений и других компонентов |

Витрина всех компонентов: адрес кабинета `ui/demo.html` (откройте страницу кабинета и допишите `ui/demo.html` после последней `/`).

## Правила

- Только этот набор: компоненты Basecoat, утилиты Tailwind и помощники `kabinet.*`. Свои библиотеки, шрифты и ссылки на CDN нельзя.
- Цвета только токенами: классы Basecoat, утилиты с цветами кабинета (`bg-card`, `text-muted-foreground`, `border-border`, `text-ok`, `bg-bad-bg`) или `var(--токен)` в своём CSS. Нельзя `#hex`, `rgb()`, названия цветов и `style` с цветом: в тёмной теме и с другим брендом они сломаются.
- Графики только через `kabinet.chart`, таблица результата через `kabinet.table`, данные через `kabinet.data` и `kabinet.result`, действия `api.py` через `kabinet.action`.
- Код страницы внутри `kabinet.ready(...)`: к этому моменту загружены графики и компоненты.
- Числа для человека через `kabinet.number`, `kabinet.money`, `kabinet.percent`, даты через `kabinet.date`: пробелы между разрядами, запятая в дробях.
- Нужен компонент, которого нет в каталоге: смотри витрину `ui/demo.html` и документацию Basecoat 1.1 (basecoatui.com), разметку бери оттуда. Своих компонентов с нуля не делай.

## Заготовка page/index.html

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Название сервиса</title>
  <link rel="stylesheet" href="../../../ui/basecoat.css">
  <link rel="stylesheet" href="../../../ui/brand.css">
  <link rel="stylesheet" href="../../../ui/kabinet.css">
  <script src="../../../ui/kabinet.js"></script>
  <script src="../../../ui/tailwind.js"></script>
  <script src="../../../ui/chart.js" defer></script>
  <script src="../../../ui/basecoat.js" defer></script>
  <script src="../../../ui/basecoat-chart.js" defer></script>
</head>
<body>
  <main class="mx-auto max-w-6xl px-4 py-6 flex flex-col gap-6">
    <header>
      <h1 class="text-2xl font-semibold">Название сервиса</h1>
      <p class="text-muted-foreground text-sm" id="period"></p>
    </header>
    <div class="alert" id="empty" hidden>
      <h2>Расчёта ещё нет</h2>
      <section>Положите файл в папку input проекта и нажмите «Запустить» над страницей.</section>
    </div>
    <div class="card"><section id="table"></section></div>
  </main>
  <script>
    kabinet.ready(async () => {
      const r = await kabinet.result();
      if (!r) { document.getElementById('empty').hidden = false; return; }
      document.getElementById('period').textContent = r.summary;
      kabinet.table('#table', r);
    });
  </script>
</body>
</html>
```

Порядок подключения важен: стили `basecoat.css`, `brand.css`, `kabinet.css`; потом `kabinet.js` и `tailwind.js` без `defer` (тема и цвета до первой отрисовки); потом `chart.js`, `basecoat.js`, `basecoat-chart.js` с `defer`.

## Раскладка

| Что | Когда | Разметка |
|---|---|---|
| колонка страницы | всегда | `<main class="mx-auto max-w-6xl px-4 py-6 flex flex-col gap-6">` |
| сетка плиток | 2-4 числа рядом | `<section class="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">` |
| два блока рядом | два графика | `<section class="grid gap-4 lg:grid-cols-2">` |
| строка кнопок | действия | `<div class="flex flex-wrap gap-2">` |

На телефоне всё в одну колонку: сетки начинай с `grid-cols-1` и добавляй столбцы от `sm:`, `md:`, `lg:`.

## Компоненты

### Кнопка

Действие на странице. Основная одна на блок, остальные `outline` или `ghost`. Удаление: `destructive` и `confirm(...)`.

```html
<button type="button" class="btn">Пересчитать</button>
<button type="button" class="btn" data-variant="outline">Скачать Excel</button>
<button type="button" class="btn" data-variant="ghost" data-size="sm">Сбросить</button>
<button type="button" class="btn" data-variant="destructive">Удалить файл</button>
<a class="btn" data-variant="link" href="../output/svodka.xlsx">svodka.xlsx</a>
```

`data-variant`: нет (основная), `secondary`, `outline`, `ghost`, `destructive`, `link`. `data-size`: `sm`, `lg`, `icon`.

### Карточка

Блок с заголовком: график, таблица, форма.

```html
<div class="card">
  <header>
    <h2>Выручка по точкам</h2>
    <p>Две последние недели, тг.</p>
  </header>
  <section>...</section>
  <footer class="flex gap-2">...</footer>
</div>
```

### Плитка с числом

Главные итоги наверху страницы. `stat-delta` с `up` зелёный, с `down` красный, без них серый.

```html
<div class="card"><section class="stat">
  <span class="stat-label">Выручка за неделю</span>
  <span class="stat-value" id="s-sum"></span>
  <span class="stat-delta down" id="d-sum"></span>
</section></div>
```

### Отметка статуса

Цвет строки или итога, как в кабинете: `badge-ok` зелёный, `badge-warn` жёлтый, `badge-bad` красный, `badge-none` нет данных; пометка `data-variant="outline"`. Из кода: `kabinet.badge('red')`, `kabinet.badge('info', 'разобрать вручную')`.

```html
<span class="badge badge-bad">красный</span>
<span class="badge" data-variant="outline">разобрать вручную</span>
```

### Сообщение

Итог, предупреждение, пустое состояние. Ошибка: `data-variant="destructive"`.

```html
<div class="alert">
  <h2>Расчёт за 02.11-08.11</h2>
  <section>Одна строка не разобрана, она в таблице с пометкой.</section>
</div>
```

### Поля

Фильтры и ввод. Поле с подписью в `.field`.

```html
<div class="field">
  <label for="f-point">Точка</label>
  <select class="select w-full" id="f-point"><option>Все точки</option></select>
</div>
<div class="field">
  <label for="f-q">Поиск</label>
  <input class="input" id="f-q" type="text" placeholder="Название">
</div>
<label class="label gap-3"><input type="checkbox" role="switch" class="input"> Только падение</label>
```

### Вкладки

Несколько видов одних данных. `aria-selected` и `hidden` у первой вкладки и панели ставь в разметке, переключает `basecoat.js`.

```html
<div class="tabs" id="vid">
  <nav role="tablist" aria-orientation="horizontal">
    <button type="button" role="tab" id="t1-tab" aria-controls="t1" aria-selected="true" tabindex="0">По точкам</button>
    <button type="button" role="tab" id="t2-tab" aria-controls="t2" aria-selected="false" tabindex="0">По дням</button>
  </nav>
  <div role="tabpanel" id="t1" aria-labelledby="t1-tab" tabindex="-1" aria-selected="true">...</div>
  <div role="tabpanel" id="t2" aria-labelledby="t2-tab" tabindex="-1" aria-selected="false" hidden>...</div>
</div>
```

### Таблица

Таблица результата: `kabinet.table('#table', r)`. Своя таблица: та же разметка.

```html
<div class="table-container">
  <table class="table">
    <thead><tr><th>Точка</th><th class="num">Выручка, тг</th></tr></thead>
    <tbody><tr><td>Мега 1</td><td class="num">5 668 600</td></tr></tbody>
  </table>
</div>
```

### График

Холст в карточке, данные из файла `output/*.json`, который пишет программа.

```html
<div class="card"><section><canvas id="c-points"></canvas></section></div>
```

```js
kabinet.chart('#c-points', {
  type: 'bar',
  data: svodka.by_point,                     // [{ label: 'Мега 1', week1: 6175600, week2: 5668600 }]
  series: { week1: { label: '26.10-01.11' }, week2: { label: '02.11-08.11' } },
});
```

`type`: `bar` (сравнение), `line` (ход во времени), `area` (ход во времени с заливкой), `doughnut` и `pie` (доли, до 5 частей). Подсказка при наведении, легенда при двух рядах и больше, цвета рядов из токенов `--chart-1..5`.

### Уведомление

Короткий ответ на действие: `kabinet.toast('Файл загружен')`, ошибка: `kabinet.toast('Не вышло', 'error', e.message)`.

## Помощники kabinet.*

| Помощник | Что делает |
|---|---|
| `kabinet.ready(fn)` | запускает код страницы, когда загружен весь набор |
| `await kabinet.data('svodka.json')` | JSON из `output/` проекта; файла нет: `null` |
| `await kabinet.result()` | `output/result.json` (то же, что `data('result.json')`) |
| `await kabinet.action('files', {...})` | действие из `api.py` (POST `../api/<имя>` с `X-Cabinet`); ошибка: `Error` с текстом для человека |
| `kabinet.table(where, r)` | таблица по `columns`, `rows`, `row_status`, `row_note`, как карточка кабинета; числа справа |
| `kabinet.chart(where, cfg)` | график: `type`, `data`, `series`, `labelKey` (поле подписи, по умолчанию `label`), `legend`, `options` (Chart.js) |
| `kabinet.badge(status, text)` | отметка `green`, `yellow`, `red`, `grey`, `info` |
| `kabinet.toast(text, kind, description)` | уведомление; `kind`: `success`, `info`, `warning`, `error` |
| `kabinet.number(v, digits)` | `1234567.8` → `1 234 568` |
| `kabinet.money(v, digits)` | `1234567.8` → `1 234 568 тг` |
| `kabinet.percent(v, digits)` | `-21.8` → `-21,8%` |
| `kabinet.date(v)` | ISO → `09.11.2026` или `09.11.2026 14:05` |

Ошибку загрузки покажи человеку строкой на странице: `try { ... } catch (e) { el.textContent = e.message; }`.
