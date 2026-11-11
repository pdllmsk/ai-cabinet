// Сервис «Аналитика таблиц»: чистые функции для страницы analiz.html. Данные на входе, HTML-строка на выходе.
// Страница подключает файл обычным <script src="analiz.js"> и получает window.AnalizRender.
// Паспорт и ответы приходят от движка tools/analiz.py через сервер кабинета (tools/analiz-api.mjs).
// График рисуется здесь же, в SVG, из таблицы ответа: без библиотек и без интернета.
(function (global) {
  'use strict';

  var ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var MAX_BARS = 30;
  var MAX_POINTS = 400;
  var MAX_VALUES = 30;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return ENTITIES[c];
    });
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function first(obj, keys) {
    if (!isObj(obj)) return undefined;
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
    }
    return undefined;
  }

  // ---------- числа и даты ----------

  // Число из ячейки: число как есть, строка вида «1 234,5» или «-12.3» тоже; иначе null.
  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    var s = v.replace(/\s/g, '').replace(',', '.');
    if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
    return parseFloat(s);
  }

  // Дата из ячейки: «2026-09-07», «2026-09-07T00:00:00», «2026-09» (месяц), «07.09.2026»; иначе null.
  // Возвращает миллисекунды UTC: для оси графика хватает дня.
  function toDate(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim();
    var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
    var y, mo, d;
    if (m) {
      y = +m[1];
      mo = +m[2];
      d = m[3] ? +m[3] : 1;
    } else {
      m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
      if (!m) return null;
      d = +m[1];
      mo = +m[2];
      y = +m[3];
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d);
  }

  function fmtDate(ms, mode) {
    var d = new Date(ms);
    var dd = pad(d.getUTCDate());
    var mm = pad(d.getUTCMonth() + 1);
    var yy = d.getUTCFullYear();
    if (mode === 'month') return mm + '.' + yy;
    if (mode === 'short') return dd + '.' + mm;
    return dd + '.' + mm + '.' + yy;
  }

  // Число для человека: запятая в дробной части, пробелы между тысячами (от 1 000; plain: без них, для годов),
  // не больше digits знаков после запятой.
  function formatNumber(n, digits, plain) {
    var max = digits == null ? 2 : digits;
    try {
      return n.toLocaleString('ru-RU', { maximumFractionDigits: max, useGrouping: !plain && Math.abs(n) >= 1000 });
    } catch (e) {
      return String(Math.round(n * Math.pow(10, max)) / Math.pow(10, max)).replace('.', ',');
    }
  }

  // Короткая подпись на графике: 1,25 млн, 12 345, 12,3.
  function shortNumber(n) {
    var abs = Math.abs(n);
    if (abs >= 1e9) return formatNumber(n / 1e9, 2) + ' млрд';
    if (abs >= 1e6) return formatNumber(n / 1e6, 2) + ' млн';
    return formatNumber(n, abs >= 100 ? 0 : abs >= 10 ? 1 : 2);
  }

  // 2026-10-22T14:05:09 → 22.10.2026 14:05 по часам компьютера.
  function formatTime(iso) {
    if (!iso) return '';
    var d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(iso);
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // Ячейка таблицы: число по-русски, дата ДД.ММ.ГГГГ, да/нет, пусто для null. plain: число без пробелов (годы).
  function cellText(v, plain) {
    if (v === true) return 'да';
    if (v === false) return 'нет';
    if (v == null) return '';
    if (typeof v === 'number') return isFinite(v) ? formatNumber(v, 2, plain) : '';
    if (typeof v === 'string') {
      var iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00(?::00)?)?$/.exec(v);
      if (iso) return iso[3] + '.' + iso[2] + '.' + iso[1];
      return v;
    }
    return String(v);
  }

  // ---------- паспорт данных ----------

  var TYPE_NAMES = {
    number: 'число', numeric: 'число', int: 'число', integer: 'число', float: 'число', 'число': 'число',
    date: 'дата', datetime: 'дата', 'дата': 'дата',
    text: 'текст', string: 'текст', str: 'текст', 'текст': 'текст',
  };
  var TYPE_CLASS = { 'число': 't-num', 'дата': 't-date', 'текст': 't-text' };

  function baseName(p) {
    return String(p).split(/[\\/]/).pop();
  }

  function asList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v) return [v];
    return [];
  }

  function normColumn(c) {
    if (typeof c === 'string') return { name: c, type: '', info: '' };
    if (!isObj(c)) return null;
    var name = first(c, ['name', 'col', 'column', 'title']);
    var rawType = String(first(c, ['type', 'kind']) || '').toLowerCase();
    var type = TYPE_NAMES[rawType] || rawType;
    var info = '';
    var lo = first(c, ['min', 'first', 'date_min', 'from']);
    var hi = first(c, ['max', 'last', 'date_max', 'to']);
    if (type === 'дата') {
      lo = first(c, ['first', 'min', 'date_min', 'from']);
      hi = first(c, ['last', 'max', 'date_max', 'to']);
      if (lo != null && hi != null) info = 'с ' + cellText(lo) + ' по ' + cellText(hi);
    } else if (type === 'число') {
      if (lo != null && hi != null) info = 'от ' + cellText(lo) + ' до ' + cellText(hi);
    }
    var values = first(c, ['values', 'categories']);
    var hidden = c.values_hidden === true || c.hidden === true || (typeof values === 'string' && /скрыт/i.test(values));
    if (!info) {
      if (hidden) info = 'значения скрыты';
      else if (Array.isArray(values) && values.length) {
        var shown = values.slice(0, MAX_VALUES).map(cellText).join(', ');
        info = values.length > MAX_VALUES ? shown + ' и ещё ' + (values.length - MAX_VALUES) : shown;
      } else {
        var distinct = first(c, ['distinct', 'unique', 'n_unique', 'n_values']);
        if (typeof distinct === 'number') info = 'разных значений: ' + formatNumber(distinct, 0);
      }
    }
    var extra = [];
    if (typeof c.empty === 'number' && c.empty > 0) extra.push('пустых: ' + formatNumber(c.empty, 0));
    if (typeof c.unreadable === 'number' && c.unreadable > 0) extra.push('не читается: ' + formatNumber(c.unreadable, 0));
    var note = first(c, ['note', 'comment']);
    if (typeof note === 'string' && note) extra.push(note);
    return { name: name == null ? '' : String(name), type: type, info: info, extra: extra.join(', '), hidden: hidden };
  }

  function normSheet(s, fallbackName) {
    if (typeof s === 'string') return { name: s, rows: null, columns: [], error: '' };
    if (!isObj(s)) return null;
    var rows = first(s, ['rows', 'row_count', 'n_rows', 'total_rows', 'rows_count']);
    var cols = first(s, ['columns', 'cols']);
    // title у движка: строки над шапкой таблицы, это не имя листа.
    var name = first(s, ['sheet', 'sheet_name']);
    if (name == null && s !== fallbackName) name = first(s, ['name']);
    var title = asList(s.title).filter(function (t) { return typeof t === 'string' && t.trim(); }).join(' ');
    return {
      name: name == null ? '' : String(name),
      rows: typeof rows === 'number' ? rows : toNumber(rows),
      columns: (Array.isArray(cols) ? cols : []).map(normColumn).filter(Boolean),
      error: typeof s.error === 'string' ? s.error : '',
      note: typeof s.note === 'string' ? s.note : '',
      title: title,
    };
  }

  // Паспорт в общий вид: { files: [{ name, error, sheets: [{ name, rows, columns: [{ name, type, info }] }] }], notes }.
  // Принимает разные написания полей движка: files или tables, sheets или столбцы прямо у файла.
  function normalizePassport(p) {
    var list = Array.isArray(p) ? p : first(p, ['files', 'tables']);
    var files = (Array.isArray(list) ? list : []).map(function (f) {
      if (typeof f === 'string') return { name: baseName(f), error: '', sheets: [], sizeKb: null };
      if (!isObj(f)) return null;
      var name = first(f, ['file', 'name', 'table']);
      if (name == null && typeof f.path === 'string') name = baseName(f.path);
      var sheets;
      if (Array.isArray(f.sheets)) {
        sheets = f.sheets.map(function (s) { return normSheet(s, null); }).filter(Boolean);
      } else {
        var one = normSheet(f, f);
        one.name = typeof f.sheet === 'string' ? f.sheet : '';
        sheets = [one];
      }
      return {
        name: name == null ? '' : String(name).replace(/\\/g, '/'),
        error: typeof f.error === 'string' ? f.error : '',
        sheets: sheets,
        sizeKb: typeof f.size_kb === 'number' ? f.size_kb : null,
      };
    }).filter(Boolean);
    var notes = asList(first(p, ['warnings', 'notes', 'warning']))
      .map(function (n) { return typeof n === 'string' ? n : isObj(n) ? first(n, ['text', 'message']) : null; })
      .filter(function (n) { return typeof n === 'string' && n; });
    // Пропущенные файлы (не читаются, ссылка наружу): имя и причина. Движок повторяет их в warnings строкой
    // «Файл «...» не прочитан: ...»: такие строки не дублируем.
    var skipped = (Array.isArray(p && p.skipped) ? p.skipped : []).map(function (k) {
      if (typeof k === 'string') return { file: k, reason: '' };
      if (!isObj(k)) return null;
      return { file: k.file == null ? '' : String(k.file), reason: typeof k.reason === 'string' ? k.reason.trim() : '' };
    }).filter(Boolean);
    notes = notes.filter(function (n) {
      for (var i = 0; i < skipped.length; i++) if (n.indexOf('Файл «' + skipped[i].file + '» не прочитан') === 0) return false;
      return true;
    });
    // Подсказка движка «пока нет таблиц» не нужна: пустое состояние страница показывает сама.
    if (!files.length) notes = notes.filter(function (n) { return !/пока нет таблиц/.test(n); });
    return { files: files, skipped: skipped, notes: notes };
  }

  function skippedText(k) {
    return k.file + (k.reason ? ': ' + k.reason.replace(/[.\s]+$/, '') : '');
  }

  function rowsText(n) {
    return typeof n === 'number' ? 'строк: ' + formatNumber(n, 0) : '';
  }

  function sizeText(kb) {
    if (typeof kb !== 'number') return '';
    return kb >= 1024 ? formatNumber(kb / 1024, 1) + ' МБ' : formatNumber(Math.max(kb, 1), 0) + ' КБ';
  }

  function renderColumns(cols, note) {
    if (!cols.length) return '<p class="hint">' + esc(note || 'Столбцы не найдены.') + '</p>';
    var body = cols.map(function (c) {
      var cls = TYPE_CLASS[c.type];
      var type = c.type ? '<span class="type ' + (cls || 't-other') + '">' + esc(c.type) + '</span>' : '';
      var info = (c.info ? esc(c.info) : '') + (c.extra ? '<span class="col-extra">' + (c.info ? '; ' : '') + esc(c.extra) + '</span>' : '');
      return '<tr><td class="col-name">' + esc(c.name) + '</td><td>' + type + '</td><td class="col-info' + (c.hidden ? ' muted' : '') + '">' + info + '</td></tr>';
    }).join('');
    return '<div class="table-wrap cols"><table><thead><tr><th>Столбец</th><th>Тип</th><th>Что внутри</th></tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  // Ни файлов, ни пропущенных: папка правда пустая.
  var EMPTY_DATA =
    '<div class="empty-data"><p class="empty-title">Папка с данными пока пустая.</p>' +
    '<p>Загрузите свои файлы Excel (xlsx) или CSV: кнопка «Загрузить файлы» или перетащите их в этот блок. ' +
    'Можно и через папку <b>input/analiz</b> в кабинете: нажмите «Открыть папку с данными», скопируйте туда файлы и нажмите «Обновить». ' +
    'Файлов и листов может быть сколько угодно.</p></div>';

  // Кнопка-корзина у файла: удалить файл из данных прямо со страницы. file: путь как в паспорте.
  var ICON_TRASH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
  function deleteButton(file) {
    if (!file) return '';
    return '<button type="button" class="file-del" data-delete="' + esc(file) + '" title="Удалить файл" aria-label="Удалить файл «' + esc(file) + '»">' + ICON_TRASH + '</button>';
  }

  // Файлы есть, но ни один не прочитан: имя и причина, что сделать, и корзина у каждого.
  function renderUnreadable(skipped) {
    return '<div class="empty-data"><p class="empty-title">Файлы есть, но не читаются.</p>' +
      '<ul class="skipped">' + skipped.map(function (k) {
        return '<li><span>' + esc(skippedText(k)) + '</span>' + deleteButton(k.file) + '</li>';
      }).join('') + '</ul>' +
      '<p>Откройте файл в Excel и сохраните как .xlsx, затем «Обновить». Ненужный файл удалите корзиной.</p></div>';
  }

  function renderPassport(p) {
    var data = normalizePassport(p);
    var lines = data.notes.slice();
    if (data.files.length) {
      data.skipped.forEach(function (k) {
        lines.push('Не прочитан файл ' + skippedText(k) + '. Откройте его в Excel и сохраните как .xlsx, затем «Обновить».');
      });
    }
    var notes = lines.length
      ? '<ul class="notes">' + lines.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>'
      : '';
    if (!data.files.length) return (data.skipped.length ? renderUnreadable(data.skipped) : EMPTY_DATA) + notes;
    var totalRows = 0;
    var sheetCount = 0;
    data.files.forEach(function (f) {
      f.sheets.forEach(function (s) {
        sheetCount += 1;
        if (typeof s.rows === 'number') totalRows += s.rows;
      });
    });
    var open = data.files.length <= 2;
    var head =
      '<p class="data-sum">Файлов: ' + data.files.length + (sheetCount > data.files.length ? ', листов: ' + sheetCount : '') +
      (totalRows ? ', строк всего: ' + formatNumber(totalRows, 0) : '') + '. Строки файлов остаются на компьютере.</p>';
    var files = data.files.map(function (f) {
      var meta = [];
      if (f.sheets.length > 1) meta.push('листов: ' + f.sheets.length);
      else if (f.sheets.length === 1) {
        if (f.sheets[0].rows != null) meta.push(rowsText(f.sheets[0].rows));
        meta.push('столбцов: ' + f.sheets[0].columns.length);
      }
      if (f.sizeKb !== null) meta.push(sizeText(f.sizeKb));
      var inner = f.error
        ? '<p class="error">' + esc(f.error) + '</p>'
        : f.sheets.map(function (s) {
            var title = s.name
              ? '<h4 class="sheet">Лист «' + esc(s.name) + '»' + (f.sheets.length > 1 && s.rows != null ? '<span class="sheet-meta">' + rowsText(s.rows) + ', столбцов: ' + s.columns.length + '</span>' : '') + '</h4>'
              : '';
            var above = s.title ? '<p class="sheet-title">Над таблицей: ' + esc(s.title) + '</p>' : '';
            return title + above + (s.error ? '<p class="error">' + esc(s.error) + '</p>' : renderColumns(s.columns, s.note));
          }).join('');
      return '<details class="file"' + (open ? ' open' : '') + '><summary><span class="file-name">' + esc(f.name || 'файл') + '</span>' +
        (meta.length ? '<span class="file-meta">' + esc(meta.join(', ')) + '</span>' : '') + deleteButton(f.name) + '</summary>' + inner + '</details>';
    }).join('');
    return head + notes + files;
  }

  // ---------- ответы ----------

  function answerKey(a) {
    if (!isObj(a)) return '';
    if (a.id !== undefined && a.id !== null && a.id !== '') return 'id:' + a.id;
    return 'q:' + (a.question || '') + '|' + (a.time || '');
  }

  function columnsOf(a) {
    return Array.isArray(a.columns) ? a.columns.map(function (c) { return c == null ? '' : String(c); }) : [];
  }

  function rowsOf(a) {
    return Array.isArray(a.rows) ? a.rows.filter(Array.isArray) : [];
  }

  // Столбец числовой: есть хотя бы одно число, остальные значения пустые или тоже числа.
  function isNumericColumn(rows, i) {
    var seen = false;
    for (var r = 0; r < rows.length; r++) {
      var v = rows[r][i];
      if (v == null || v === '') continue;
      if (toNumber(v) === null) return false;
      seen = true;
    }
    return seen;
  }

  // Столбец годов (целые 1900-2100): без пробела между тысячами, «2026», а не «2 026».
  function isYearColumn(rows, i) {
    var seen = false;
    for (var r = 0; r < rows.length; r++) {
      var v = rows[r][i];
      if (v == null) continue;
      if (typeof v !== 'number' || v % 1 !== 0 || v < 1900 || v > 2100) return false;
      seen = true;
    }
    return seen;
  }

  function renderTable(a) {
    var cols = columnsOf(a);
    var rows = rowsOf(a);
    if (!cols.length) return '';
    var num = cols.map(function (c, i) { return isNumericColumn(rows, i); });
    var years = cols.map(function (c, i) { return isYearColumn(rows, i); });
    var td = function (v, i) { return '<td' + (num[i] ? ' class="num"' : '') + '>' + esc(cellText(v, years[i])) + '</td>'; };
    var head = cols.map(function (c, i) { return '<th' + (num[i] ? ' class="num"' : '') + '>' + esc(c) + '</th>'; }).join('');
    var body = rows.map(function (row) {
      return '<tr>' + cols.map(function (c, i) { return td(row[i], i); }).join('') + '</tr>';
    }).join('');
    var foot = '';
    if (isObj(a.totals)) {
      var any = cols.some(function (c) { return a.totals[c] !== undefined; });
      if (any) {
        foot = '<tfoot><tr>' + cols.map(function (c, i) {
          if (a.totals[c] !== undefined) return td(a.totals[c], i);
          return i === 0 ? '<td class="total-label">Итого</td>' : '<td></td>';
        }).join('') + '</tr></tfoot>';
      }
    }
    return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody>' + foot + '</table></div>';
  }

  // Сколько первых столбцов подписывают строку: group_columns движка, иначе текстовые столбцы до первого числового.
  function labelCount(a, cols, rows) {
    var g = a.group_columns;
    if (typeof g === 'number' && g >= 1 && g < cols.length) return Math.floor(g);
    var n = 1;
    while (n < cols.length - 1 && !isNumericColumn(rows, n)) n++;
    return n;
  }

  function rowLabel(r, g) {
    var parts = [];
    for (var i = 0; i < g; i++) {
      var t = cellText(r[i]);
      if (t) parts.push(t);
    }
    return parts.join(' · ');
  }

  // Что можно нарисовать: подписи из первых столбцов (группы), числовые столбцы после них, дата ли подпись.
  function chartInfo(a) {
    var cols = columnsOf(a);
    var rows = rowsOf(a);
    var g = labelCount(a, cols, rows);
    var measures = [];
    for (var i = g; i < cols.length; i++) if (isNumericColumn(rows, i)) measures.push(i);
    var dates = g === 1 && rows.length > 0 && rows.every(function (r) { return toDate(r[0]) !== null; });
    var preferred = -1;
    for (var j = 0; j < measures.length; j++) {
      if (/изменение,\s*%/i.test(cols[measures[j]])) preferred = measures[j];
    }
    return { columns: cols, rows: rows, groups: g, measures: measures, isDate: dates, best: preferred !== -1 ? preferred : measures.length ? measures[0] : -1 };
  }

  function pctSuffix(name) {
    return /%/.test(name) ? ' %' : '';
  }

  function trimLabel(s, max) {
    var t = String(s);
    return t.length > max ? t.slice(0, Math.max(1, max - 1)) + '…' : t;
  }

  // Шаг шкалы: 1, 2, 2,5 или 5, умноженные на степень десяти.
  function niceTicks(lo, hi, count) {
    if (lo === hi) {
      if (lo === 0) hi = 1;
      else {
        var d = Math.abs(lo) * 0.1;
        lo -= d;
        hi += d;
      }
    }
    var raw = (hi - lo) / Math.max(1, count);
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var f = raw / p;
    var step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    var start = Math.floor(lo / step + 1e-9) * step;
    var end = Math.ceil(hi / step - 1e-9) * step;
    var list = [];
    for (var k = 0; start + k * step <= end + step / 2 && k < 50; k++) list.push(+(start + k * step).toPrecision(12));
    return { lo: start, hi: end, list: list };
  }

  var W = 960;

  function svgOpen(h, label) {
    return '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + h + '" width="' + W + '" height="' + h + '" role="img" aria-label="' + esc(label) + '" preserveAspectRatio="xMinYMin meet">';
  }

  // Прямоугольник со скруглёнными углами только у конца значения (от нуля к значению).
  function barPathV(x, w, y0, y1) {
    var r = Math.min(4, w / 2, Math.abs(y0 - y1));
    var s = y1 < y0 ? 1 : -1;
    return 'M' + x + ',' + y0 + 'V' + (y1 + s * r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 + 'H' + (x + w - r) +
      'Q' + (x + w) + ',' + y1 + ' ' + (x + w) + ',' + (y1 + s * r) + 'V' + y0 + 'Z';
  }

  function barPathH(y, h, x0, x1) {
    var r = Math.min(4, h / 2, Math.abs(x1 - x0));
    var s = x1 > x0 ? 1 : -1;
    return 'M' + x0 + ',' + y + 'H' + (x1 - s * r) + 'Q' + x1 + ',' + y + ' ' + x1 + ',' + (y + r) + 'V' + (y + h - r) +
      'Q' + x1 + ',' + (y + h) + ' ' + (x1 - s * r) + ',' + (y + h) + 'H' + x0 + 'Z';
  }

  function r1(n) {
    return Math.round(n * 10) / 10;
  }

  // Столбики: до 12 коротких подписей, иначе полосы с подписями слева (так подписи читаются целиком).
  function barsSvg(points, name) {
    var suffix = pctSuffix(name);
    var vals = points.map(function (p) { return p.v; });
    var minV = Math.min.apply(null, vals.concat([0]));
    var maxV = Math.max.apply(null, vals.concat([0]));
    var longest = points.reduce(function (m, p) { return Math.max(m, String(p.label).length); }, 0);
    var plotW = W - 72 - 16;
    var band = plotW / points.length;
    var label = name;
    if (points.length <= 12 && longest * 7.6 <= band - 6) {
      var H = 380;
      var M = { l: 72, r: 16, t: 30, b: 46 };
      var plotH = H - M.t - M.b;
      var span = maxV - minV || 1;
      var t = niceTicks(minV < 0 ? minV - span * 0.12 : 0, maxV > 0 ? maxV + span * 0.1 : 0, 5);
      var y = function (v) { return r1(M.t + ((t.hi - v) / (t.hi - t.lo)) * plotH); };
      var out = svgOpen(H, label);
      t.list.forEach(function (v) {
        out += '<line class="grid" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
        out += '<text class="axis" x="' + (M.l - 10) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(shortNumber(v) + suffix) + '</text>';
      });
      var bw = Math.min(64, band * 0.62);
      points.forEach(function (p, i) {
        var x = r1(M.l + band * i + (band - bw) / 2);
        var y0 = y(0);
        var y1 = y(p.v);
        var text = shortNumber(p.v) + suffix;
        out += '<g class="mark"><title>' + esc(p.label + ': ' + formatNumber(p.v, 2) + suffix) + '</title>';
        out += '<rect class="hit" x="' + r1(M.l + band * i) + '" y="' + M.t + '" width="' + r1(band) + '" height="' + plotH + '"/>';
        if (p.v !== 0) out += '<path class="bar" d="' + barPathV(x, r1(bw), y0, y1) + '"/>';
        out += '<text class="value" x="' + r1(x + bw / 2) + '" y="' + (p.v < 0 ? y1 + 17 : y1 - 8) + '" text-anchor="middle">' + esc(text) + '</text>';
        out += '<text class="cat" x="' + r1(x + bw / 2) + '" y="' + (H - M.b + 22) + '" text-anchor="middle">' + esc(p.label) + '</text></g>';
      });
      out += '<line class="zero" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
      return out + '</svg>';
    }
    var rowH = 30;
    var barH = 18;
    var top = 6;
    var Hh = top * 2 + points.length * rowH;
    var labelW = Math.max(90, Math.min(300, longest * 7.4 + 18));
    var maxChars = Math.floor((labelW - 18) / 7.4);
    var valW = 86;
    var hasNeg = minV < 0;
    var hasPos = maxV > 0;
    var xa = labelW + (hasNeg ? valW : 4);
    var xb = W - (hasPos || !hasNeg ? valW : 12);
    var lo = minV;
    var hi = maxV === minV ? minV + 1 : maxV;
    var x = function (v) { return r1(xa + ((v - lo) / (hi - lo)) * (xb - xa)); };
    var o = svgOpen(Hh, label);
    points.forEach(function (p, i) {
      var yTop = top + i * rowH;
      var cy = yTop + rowH / 2;
      var x0 = x(0);
      var x1 = x(p.v);
      o += '<g class="mark"><title>' + esc(p.label + ': ' + formatNumber(p.v, 2) + suffix) + '</title>';
      o += '<rect class="hit" x="0" y="' + yTop + '" width="' + W + '" height="' + rowH + '"/>';
      o += '<text class="cat" x="' + (labelW - 12) + '" y="' + (cy + 4.5) + '" text-anchor="end">' + esc(trimLabel(p.label, maxChars)) + '</text>';
      if (p.v !== 0) o += '<path class="bar" d="' + barPathH(r1(cy - barH / 2), barH, x0, x1) + '"/>';
      o += '<text class="value" x="' + (p.v < 0 ? x1 - 7 : x1 + 7) + '" y="' + (cy + 4.5) + '" text-anchor="' + (p.v < 0 ? 'end' : 'start') + '">' + esc(shortNumber(p.v) + suffix) + '</text></g>';
    });
    o += '<line class="zero" x1="' + x(0) + '" x2="' + x(0) + '" y1="' + (top - 2) + '" y2="' + (Hh - top + 2) + '"/>';
    return o + '</svg>';
  }

  // Линия по датам первого столбца: ось времени, до 8 подписей дат, точки, подписаны последняя и самая большая.
  function lineSvg(points, name) {
    var suffix = pctSuffix(name);
    var H = 360;
    var M = { l: 76, r: 30, t: 30, b: 44 };
    var plotW = W - M.l - M.r;
    var plotH = H - M.t - M.b;
    var vals = points.map(function (p) { return p.v; });
    var minV = Math.min.apply(null, vals);
    var maxV = Math.max.apply(null, vals);
    var span = maxV - minV || Math.abs(maxV) || 1;
    var lo = minV >= 0 && minV <= maxV * 0.5 ? 0 : minV - span * 0.08;
    var t = niceTicks(lo, maxV + span * 0.12, 5);
    var t0 = points[0].t;
    var t1 = points[points.length - 1].t;
    var x = function (ms) { return r1(M.l + (t1 === t0 ? plotW / 2 : ((ms - t0) / (t1 - t0)) * plotW)); };
    var y = function (v) { return r1(M.t + ((t.hi - v) / (t.hi - t.lo)) * plotH); };
    var monthly = points.every(function (p) { return new Date(p.t).getUTCDate() === 1; }) && points.length > 1;
    var sameYear = new Date(t0).getUTCFullYear() === new Date(t1).getUTCFullYear();
    var mode = monthly ? 'month' : sameYear ? 'short' : 'full';
    var out = svgOpen(H, name);
    t.list.forEach(function (v) {
      out += '<line class="grid" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      out += '<text class="axis" x="' + (M.l - 10) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(shortNumber(v) + suffix) + '</text>';
    });
    // Подписи дат с ровным шагом от последней даты назад (последняя видна всегда), не больше 8.
    var step = Math.max(1, Math.ceil((points.length - 1) / 7));
    for (var idx = points.length - 1; idx >= 0; idx -= step) {
      var anchor = idx === 0 ? 'start' : idx === points.length - 1 ? 'end' : 'middle';
      out += '<text class="cat" x="' + x(points[idx].t) + '" y="' + (H - M.b + 24) + '" text-anchor="' + anchor + '">' + esc(fmtDate(points[idx].t, mode)) + '</text>';
    }
    if (lo < 0 && t.hi > 0) out += '<line class="zero" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    out += '<line class="base" x1="' + M.l + '" x2="' + (W - M.r) + '" y1="' + (M.t + plotH) + '" y2="' + (M.t + plotH) + '"/>';
    var d = points.map(function (p, j) { return (j ? 'L' : 'M') + x(p.t) + ',' + y(p.v); }).join('');
    out += '<path class="line" d="' + d + '"/>';
    var bandW = plotW / Math.max(1, points.length - 1);
    var maxIdx = vals.indexOf(maxV);
    points.forEach(function (p, j) {
      out += '<g class="mark"><title>' + esc(fmtDate(p.t, 'full') + ': ' + formatNumber(p.v, 2) + suffix) + '</title>';
      out += '<rect class="hit" x="' + r1(x(p.t) - bandW / 2) + '" y="' + M.t + '" width="' + r1(bandW) + '" height="' + plotH + '"/>';
      if (points.length <= 60) out += '<circle class="dot" cx="' + x(p.t) + '" cy="' + y(p.v) + '" r="4"/>';
      out += '</g>';
    });
    var labelled = [points.length - 1];
    if (maxIdx !== points.length - 1) labelled.push(maxIdx);
    // Подпись над точкой; если линия приходит к точке сверху (соседи выше), под точкой: так она не пересекает линию.
    labelled.forEach(function (j) {
      var p = points[j];
      var near = [points[j - 1], points[j + 1]].filter(Boolean);
      var below = near.length > 0 && near.every(function (q) { return q.v > p.v; });
      var anchor = j === points.length - 1 ? 'end' : j === 0 ? 'start' : 'middle';
      var ty = below ? Math.min(y(p.v) + 22, M.t + plotH - 4) : y(p.v) - 12;
      out += '<text class="value" x="' + x(p.t) + '" y="' + ty + '" text-anchor="' + anchor + '">' + esc(shortNumber(p.v) + suffix) + '</text>';
    });
    return out + '</svg>';
  }

  // График ответа: SVG и подписи вокруг. measure: номер числового столбца (по умолчанию самый подходящий).
  function renderChart(a, measure) {
    var info = chartInfo(a);
    if (!info.measures.length) return '<p class="hint">Для графика нужен столбец с числами, а в этом ответе его нет.</p>';
    var col = info.measures.indexOf(measure) !== -1 ? measure : info.best;
    var name = info.columns[col];
    var points = [];
    var missing = [];
    info.rows.forEach(function (r) {
      var v = toNumber(r[col]);
      if (v === null) {
        missing.push(rowLabel(r, info.groups) || '(пусто)');
        return;
      }
      if (info.isDate) points.push({ t: toDate(r[0]), v: v, label: cellText(r[0]) });
      else points.push({ v: v, label: rowLabel(r, info.groups) || '(пусто)' });
    });
    if (points.length < 2) return '<p class="hint">Для графика нужно хотя бы две строки с числами.</p>';
    var note = '';
    var svg;
    if (info.isDate) {
      points.sort(function (p, q) { return p.t - q.t; });
      if (points.length > MAX_POINTS) {
        note = 'На графике первые ' + MAX_POINTS + ' дат из ' + points.length + '.';
        points = points.slice(0, MAX_POINTS);
      }
      svg = lineSvg(points, name);
    } else {
      if (points.length > MAX_BARS) {
        note = 'На графике первые ' + MAX_BARS + ' строк из ' + points.length + ', как в таблице.';
        points = points.slice(0, MAX_BARS);
      }
      svg = barsSvg(points, name);
    }
    if (missing.length) {
      var shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? ' и ещё ' + (missing.length - 5) : '');
      note = (note ? note + ' ' : '') + 'Без числа в «' + name + '», на графике нет: ' + shown + '.';
    }
    var by = info.columns.slice(0, info.groups);
    var title = esc(name) + ' <span class="chart-by">по ' + (by.length > 1 ? 'столбцам «' + by.map(esc).join('», «') : 'столбцу «' + esc(by[0])) + '»</span>';
    var select = '';
    if (info.measures.length > 1) {
      select = '<label class="measure">Показатель <select data-measure="' + esc(answerKey(a)) + '">' + info.measures.map(function (i) {
        return '<option value="' + i + '"' + (i === col ? ' selected' : '') + '>' + esc(info.columns[i]) + '</option>';
      }).join('') + '</select></label>';
    }
    return '<div class="chart-head"><p class="chart-title">' + title + '</p>' + select + '</div>' +
      '<div class="chart-box">' + svg + '</div>' + (note ? '<p class="hint">' + esc(note) + '</p>' : '');
  }

  // Ответ из истории карточкой. state: { chart: true/false, measure: номер столбца, excel: { busy, error, url, file } }.
  function renderAnswer(a, state) {
    if (!isObj(a)) return '';
    var st = state || {};
    var key = answerKey(a);
    var rows = rowsOf(a);
    var parts = [];
    var when = a.time || a.created;
    parts.push('<div class="answer-head"><h3 class="question">' + esc(a.question || 'Вопрос без текста') + '</h3>' +
      (when ? '<span class="when">' + esc(formatTime(when)) + '</span>' : '') + '</div>');
    if (typeof a.error === 'string' && a.error) parts.push('<p class="run-error">' + esc(a.error) + '</p>');
    if (a.summary) parts.push('<p class="summary">' + esc(a.summary) + '</p>');
    // Таблицу ответа на странице не показываем: итог, график по кнопке, Excel с таблицей.
    var notes = asList(a.notes).filter(function (n) { return typeof n === 'string' && n && !/^Показаны первые/.test(n); });
    if (notes.length) {
      parts.push('<div class="notes-box"><p class="notes-title">Примечания</p><ul class="notes">' + notes.map(function (n) {
        return '<li>' + esc(n) + '</li>';
      }).join('') + '</ul></div>');
    }
    var hasTable = columnsOf(a).length > 0 && rows.length > 0;
    if (hasTable) {
      var ex = st.excel || {};
      var canExcel = a.id !== undefined && a.id !== null && a.id !== '';
      var msg = '';
      if (ex.busy) msg = '<span class="action-msg">Готовлю файл Excel…</span>';
      else if (ex.error) msg = '<span class="action-msg error">' + esc(ex.error) + '</span>';
      else if (ex.url) msg = '<span class="action-msg">Файл готов: <a href="' + esc(ex.url) + '" download>' + esc(ex.file || 'Excel') + '</a></span>';
      parts.push('<div class="answer-actions">' +
        '<button type="button" class="btn" data-chart="' + esc(key) + '" aria-expanded="' + (st.chart ? 'true' : 'false') + '">' + (st.chart ? 'Скрыть график' : 'Построить график') + '</button>' +
        '<button type="button" class="btn" data-excel="' + esc(key) + '"' + (ex.busy || !canExcel ? ' disabled' : '') + '>Скачать Excel с графиком</button>' + msg + '</div>');
      if (st.chart) parts.push('<div class="chart">' + renderChart(a, st.measure) + '</div>');
    }
    return '<article class="card answer" data-key="' + esc(key) + '">' + parts.join('') + '</article>';
  }

  // Последний ответ целиком, прошлые компактным списком с прокруткой: строка с вопросом, временем
  // и итогом, по щелчку раскрывается весь ответ (state.open). filter: часть вопроса из поля поиска над ответами,
  // строки без совпадения скрыты.
  function renderAnswers(items, states, total, filter) {
    var list = Array.isArray(items) ? items.filter(isObj) : [];
    if (!list.length) return '<p class="empty">Ответов пока нет. Задайте первый вопрос выше.</p>';
    var s = states || {};
    var more = typeof total === 'number' && total > list.length
      ? '<p class="hint">Показаны последние ' + list.length + ' ответов из ' + total + '. Все ответы лежат в output/analiz/history.json.</p>'
      : '';
    var html = renderAnswer(list[0], s[answerKey(list[0])]);
    var rest = list.slice(1);
    if (!rest.length) return html + more;
    var needle = typeof filter === 'string' ? filter.trim().toLowerCase() : '';
    var found = 0;
    var rows = rest.map(function (a) {
      var key = answerKey(a);
      var st = s[key] || {};
      var hit = !needle || String(a.question || '').toLowerCase().indexOf(needle) !== -1;
      if (hit) found += 1;
      var when = a.time || a.created;
      return '<details class="hist-item" data-key="' + esc(key) + '"' + (st.open ? ' open' : '') + (hit ? '' : ' hidden') + '>' +
        '<summary class="hist-row"><span class="hist-q">' + esc(a.question || 'Вопрос без текста') + '</span>' +
        (when ? '<span class="hist-when">' + esc(formatTime(when)) + '</span>' : '') +
        (a.summary ? '<span class="hist-sum">' + esc(a.summary) + '</span>' : a.error ? '<span class="hist-sum hist-err">' + esc(a.error) + '</span>' : '') +
        '</summary>' + renderAnswer(a, st) + '</details>';
    }).join('');
    return html + '<section class="history" aria-labelledby="history-title"><h3 class="history-title" id="history-title">Прошлые вопросы <span class="history-count">' + rest.length + '</span></h3>' +
      '<div class="history-list">' + rows + (needle && !found ? '<p class="hint history-none">Таких вопросов нет.</p>' : '') + '</div></section>' + more;
  }

  // Что сказать, если на вопрос не ответили. status и body: ответ сервера на api/analiz/ask.
  function renderAskProblem(status, body, question) {
    var b = isObj(body) ? body : {};
    var phrase = typeof b.phrase === 'string' && b.phrase ? b.phrase : 'проанализируй таблицу: ' + (question || '');
    var copy = '<div class="phrase"><input class="phrase-input" id="phrase" type="text" readonly value="' + esc(phrase) + '" aria-label="Фраза для Claude">' +
      '<button type="button" class="btn" data-copy="phrase">Скопировать</button></div>';
    if (b.code === 'ENOCLAUDE') {
      return '<div class="notice"><p><b>Отсюда спросить не получилось:</b> на этом компьютере страница не может обратиться к Claude. ' +
        'Задайте вопрос Claude во вкладке <b>Code</b>: он посчитает так же, на вашем компьютере, и ответ появится ниже, в «Ответах». ' +
        'Скопируйте фразу и отправьте её в разговор в папке кабинета:</p>' + copy + '</div>';
    }
    if (b.code === 'EPERSONAL') {
      return '<div class="notice notice-red"><p><b>Вопрос не отправлен.</b> ' + esc(b.error || 'Запрос не прошёл проверку перед моделью.') + '</p>' +
        '<p class="hint">В модель ничего не ушло. Оставьте в папке только нужные таблицы и спросите снова.</p></div>';
    }
    if (b.code === 'EROWS') {
      return '<div class="notice"><p>' + esc(b.error || 'Для этого вопроса нужно читать текст строк.') + '</p>' +
        '<p class="hint">Страница считает по описанию данных и текст строк не читает. Claude во вкладке <b>Code</b> прочитает их сам. ' +
        'Скопируйте фразу и отправьте её в разговор в папке кабинета:</p>' + copy + '</div>';
    }
    if (b.code === 'EENGINE') {
      return '<div class="notice"><p>' + esc(b.error || 'Не получилось ответить на вопрос.') + '</p>' +
        '<p class="hint">Попробуйте спросить иначе: назовите столбцы и период так, как они записаны в «Ваших данных».</p></div>';
    }
    if (b.code === 'ETIMEOUT') {
      return '<div class="notice notice-red"><p>' + esc(b.error || 'Вопрос считался слишком долго.') + '</p>' + copy + '</div>';
    }
    if (status === 404) {
      return '<p class="run-error">Страница кабинета запущена до обновления. Скажите Claude «открой страницу» в новом разговоре.</p>';
    }
    return '<p class="run-error">' + esc(b.error || 'Не получилось ответить на вопрос.') + '</p>';
  }

  global.AnalizRender = {
    esc: esc,
    toNumber: toNumber,
    toDate: toDate,
    cellText: cellText,
    formatNumber: formatNumber,
    formatTime: formatTime,
    normalizePassport: normalizePassport,
    renderPassport: renderPassport,
    answerKey: answerKey,
    chartInfo: chartInfo,
    renderTable: renderTable,
    renderChart: renderChart,
    renderAnswer: renderAnswer,
    renderAnswers: renderAnswers,
    renderAskProblem: renderAskProblem,
  };
})(window);
