// Помощники своей страницы сервиса (kind page): тема как в кабинете, данные из output, действия api.py,
// таблица результата, графики, уведомления. Подключается в <head> обычным <script src> до tailwind.js:
// тема ставится до первой отрисовки, а Tailwind получает цвета кабинета (bg-primary, text-muted-foreground).
// Страница лежит по адресу s/<slug>/page/, поэтому данные: ../output/<файл>, действия: ../api/<действие>.
(function (global) {
  'use strict';

  var doc = document;
  var root = doc.documentElement;

  // ---------- тема ----------

  // Выбор темы кабинета (prefs.js кабинета, тот же адрес, тот же localStorage): auto, light, dark.
  var THEME_KEY = 'kabinet-theme';
  var media = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;

  function chosenTheme() {
    try {
      var v = global.localStorage.getItem(THEME_KEY);
      if (v === 'light' || v === 'dark') return v;
    } catch (e) {
      // нет доступа к хранилищу: как в системе
    }
    return 'auto';
  }

  function applyTheme() {
    var t = chosenTheme();
    var dark = t === 'dark' || (t === 'auto' && Boolean(media && media.matches));
    root.classList.toggle('dark', dark);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  applyTheme();
  // Тему переключили в кабинете (в другой вкладке или вокруг этой страницы): меняем сразу.
  global.addEventListener('storage', function (e) {
    if (e.key === THEME_KEY) applyTheme();
  });
  if (media && media.addEventListener) media.addEventListener('change', applyTheme);

  // ---------- Tailwind: цвета кабинета в утилитах ----------

  var TW_COLORS = ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'primary',
    'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground',
    'destructive', 'border', 'input', 'ring', 'ok', 'ok-bg', 'warn', 'warn-bg', 'bad', 'bad-bg', 'none', 'none-bg',
    'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'];
  var tw = doc.createElement('style');
  tw.type = 'text/tailwindcss';
  tw.textContent =
    '@custom-variant dark (&:where(.dark, .dark *));\n@theme inline {\n' +
    TW_COLORS.map(function (c) {
      return '  --color-' + c + ': var(--' + c + ');';
    }).join('\n') +
    '\n  --radius-sm: calc(var(--radius) - 4px);\n  --radius-md: calc(var(--radius) - 2px);\n' +
    '  --radius-lg: var(--radius);\n  --radius-xl: calc(var(--radius) + 4px);\n}\n';
  (doc.head || root).appendChild(tw);

  // ---------- числа и даты ----------

  var nf = {};
  function formatter(digits) {
    if (!nf[digits]) nf[digits] = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return nf[digits];
  }

  // 1234567.8 → «1 234 568»; digits: знаков после запятой. Не число: пустая строка.
  function number(v, digits) {
    if (typeof v !== 'number' || !isFinite(v)) return v == null ? '' : String(v);
    return formatter(digits || 0).format(v);
  }

  function money(v, digits) {
    var s = number(v, digits);
    return s === '' ? '' : s + ' тг';
  }

  function percent(v, digits) {
    var s = number(v, digits == null ? 1 : digits);
    return s === '' ? '' : s + '%';
  }

  // ISO с часовым поясом → «09.11.2026 14:05»; без времени → «09.11.2026».
  function date(v) {
    var d = new Date(v);
    if (!v || isNaN(d.getTime())) return v == null ? '' : String(v);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var s = p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
    return /T\d/.test(String(v)) ? s + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : s;
  }

  // ---------- данные и действия ----------

  // Файл из output проекта (JSON): kabinet.data('svodka.json'). Нет файла (сервис ещё не запускали): null.
  function data(name) {
    return fetch('../output/' + encodeURIComponent(name), { cache: 'no-store' }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('Не удалось прочитать ' + name + ' (' + r.status + ').');
      return r.json();
    });
  }

  // Результат программы: output/result.json (title, updated_at, status, summary, columns, rows, ...).
  function result() {
    return data('result.json');
  }

  // Действие страницы из api.py: kabinet.action('files') или kabinet.action('delete', { name: '...' }).
  // Ответ: то, что вернула функция действия. Ошибка: Error с текстом для человека.
  function action(name, payload) {
    return fetch('../api/' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cabinet': '1' },
      body: JSON.stringify(payload == null ? {} : payload),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || 'Действие «' + name + '» не выполнилось (' + r.status + ').');
        return body;
      });
    });
  }

  // ---------- разметка ----------

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function target(where) {
    var e = typeof where === 'string' ? doc.querySelector(where) : where;
    if (!e) throw new Error('Нет элемента ' + where + ' на странице.');
    return e;
  }

  // Статусы кабинета: green, yellow, red, grey (нет данных), info (пометка).
  var BADGE = {
    green: ['badge badge-ok', 'зелёный'],
    yellow: ['badge badge-warn', 'жёлтый'],
    red: ['badge badge-bad', 'красный'],
    grey: ['badge badge-none', 'нет данных'],
    info: ['badge', ''],
  };

  // Отметка статуса: kabinet.badge('red') или kabinet.badge('info', 'разобрать вручную').
  function badge(status, text) {
    var b = BADGE[status] || BADGE.info;
    var e = el('span', b[0], text != null && text !== '' ? text : b[1] || status);
    if (b === BADGE.info) e.setAttribute('data-variant', 'outline');
    return e;
  }

  var cellNumber = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

  function cellText(v) {
    if (v === true) return 'да';
    if (v === false) return 'нет';
    // Дробь до двух знаков без лишних нулей: 210 359,3 и 80 970 в одном столбце.
    if (typeof v === 'number' && isFinite(v)) return cellNumber.format(v);
    return v == null ? '' : String(v);
  }

  // Таблица результата в элементе where: columns, rows, необязательно row_status и row_note (как карточка
  // кабинета). Числа справа, с пробелами между разрядами.
  function table(where, r) {
    var box = target(where);
    var columns = (r && Array.isArray(r.columns)) ? r.columns : [];
    var rows = (r && Array.isArray(r.rows)) ? r.rows : [];
    var status = r && Array.isArray(r.row_status) ? r.row_status : null;
    var note = r && Array.isArray(r.row_note) ? r.row_note : null;
    var marks = Boolean(status || note);
    var wrap = el('div', 'table-container');
    var t = el('table', 'table');
    var head = el('tr');
    if (marks) head.appendChild(el('th', null, 'Отметка'));
    var numeric = columns.map(function (_, i) {
      return rows.length > 0 && rows.every(function (row) { return row[i] == null || typeof row[i] === 'number'; });
    });
    columns.forEach(function (c, i) {
      head.appendChild(el('th', numeric[i] ? 'num' : null, c));
    });
    t.appendChild(el('thead')).appendChild(head);
    var body = t.appendChild(el('tbody'));
    rows.forEach(function (row, i) {
      var tr = body.appendChild(el('tr'));
      if (marks) {
        var td = tr.appendChild(el('td'));
        var st = status ? status[i] : null;
        var n = note ? note[i] : null;
        if (st || n) td.appendChild(badge(st || 'info', st === 'info' || !st ? n : null));
        if (n && st && st !== 'info') td.appendChild(el('div', 'text-muted-foreground text-xs mt-1', n));
      }
      columns.forEach(function (_, j) {
        tr.appendChild(el('td', numeric[j] ? 'num' : null, cellText(row[j])));
      });
    });
    wrap.appendChild(t);
    box.replaceChildren(wrap);
    return t;
  }

  // ---------- графики ----------

  // График Basecoat на Chart.js: подсказка при наведении, легенда, цвета и тема кабинета.
  // kabinet.chart('#prodazhi', { type: 'bar', data: [{ label: 'Мега 1', sum: 1200000 }],
  //   series: { sum: { label: 'Выручка, тг' } } })
  // type: bar, line, area, pie, doughnut; data: строки; labelKey: поле подписи (по умолчанию label);
  // series: поля-значения { поле: { label, color } }. Числа в подсказке с пробелами между разрядами.
  function chart(where, cfg) {
    cfg = cfg || {};
    if (!global.basecoat || !global.basecoat.chart) throw new Error('Графики не загрузились: нужны ui/chart.js и ui/basecoat-chart.js.');
    var canvas = target(where);
    var options = Object.assign({ locale: 'ru-RU' }, cfg.options || {});
    var type = cfg.type || 'bar';
    var area = type === 'area';
    // area: линия с заливкой цветом ряда, сверху плотнее, книзу прозрачнее (surface Basecoat).
    var series = {};
    Object.keys(cfg.series || {}).forEach(function (k) {
      var s = Object.assign({}, cfg.series[k]);
      if (area) {
        if (s.surface == null) s.surface = 'gradient';
        s.dataset = Object.assign({ fill: true }, s.dataset || {});
      }
      series[k] = s;
    });
    // Ось значений от нуля: иначе день с меньшей выручкой выглядит как обвал до нуля.
    if (type !== 'pie' && type !== 'doughnut') {
      var scales = Object.assign({}, options.scales);
      scales.y = Object.assign({ beginAtZero: true }, scales.y);
      options.scales = scales;
    }
    return global.basecoat.chart(canvas, {
      type: area ? 'line' : type,
      data: cfg.data || [],
      labelKey: cfg.labelKey,
      series: series,
      legend: cfg.legend != null ? cfg.legend : Object.keys(series).length > 1,
      options: options,
    });
  }

  // ---------- уведомления ----------

  // Короткое сообщение в углу: kabinet.toast('Файл загружен') или kabinet.toast('Не вышло', 'error').
  // kind: success, info, warning, error.
  function toast(text, kind, description) {
    var t = doc.getElementById('toaster');
    if (!t) {
      t = el('div', 'toaster');
      t.id = 'toaster';
      doc.body.appendChild(t);
    }
    if (!t.toast && global.basecoat) global.basecoat.initAll();
    if (t.toast) return t.toast({ category: kind || 'success', title: text, description: description });
    return null;
  }

  // Код страницы после загрузки всех скриптов набора: kabinet.ready(async () => { ... }).
  function ready(fn) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { fn(); });
    else fn();
  }

  global.kabinet = {
    ready: ready,
    data: data,
    result: result,
    action: action,
    table: table,
    badge: badge,
    chart: chart,
    toast: toast,
    number: number,
    money: money,
    percent: percent,
    date: date,
    theme: applyTheme,
  };
})(window);
