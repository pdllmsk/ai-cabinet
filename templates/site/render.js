// Страница «Мой кабинет»: сетка карточек сервисов, подробный вид процесса или встроенного проекта и пункты меню
// «Мои сервисы». Чистые функции: данные на входе, HTML-строка на выходе. Страница подключает файл обычным
// <script src="render.js"> и получает window.CabinetRender; страница «Аналитика таблиц» берёт отсюда пункты меню.
(function (global) {
  'use strict';

  var STATUS_LABEL = { red: 'красный', yellow: 'жёлтый', green: 'зелёный' };
  var ROW_LABEL = { red: 'красный', yellow: 'жёлтый', green: 'зелёный', grey: 'нет данных', info: '' };
  var ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return ENTITIES[c];
    });
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // 2026-10-22T14:05:09 → 22.10.2026 14:05 по часам компьютера.
  function formatTime(iso) {
    var d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(iso);
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function cellText(v) {
    if (v === true) return 'да';
    if (v === false) return 'нет';
    return v == null ? '' : String(v);
  }

  // Карточки из двух источников: процессы кабинета (api/processes) и встроенные проекты сервисов (api/services,
  // у них source: 'service'). Ключ карточки и адрес подробного вида у источников свои: '#p=<slug>' и '#s=<slug>'.
  function isService(p) {
    return Boolean(p) && p.source === 'service';
  }

  function itemKey(p) {
    return (isService(p) ? 's:' : 'p:') + p.slug;
  }

  function titleOf(p) {
    var t = p.title != null && p.title !== '' ? p.title : p.name;
    return t != null && t !== '' ? t : p.slug;
  }

  // Ссылка на файл результата, каждая часть пути кодируется. Процесс: только output/<slug>/... кабинета.
  // Встроенный проект: только output/... своего проекта, страница отдаёт их по адресу s/<slug>/output/...
  function fileHref(path, p) {
    var parts = String(path).replace(/\\/g, '/').split('/');
    var slug = p.slug;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '' || parts[i] === '.' || parts[i] === '..' || parts[i].indexOf(':') !== -1) return null;
    }
    if (isService(p)) {
      if (parts.length < 2 || parts[0] !== 'output') return null;
      return ['s', slug].concat(parts).map(encodeURIComponent).join('/');
    }
    if (parts.length < 3 || parts[0] !== 'output' || parts[1] !== slug) return null;
    return parts.map(encodeURIComponent).join('/');
  }

  function renderTable(r) {
    var columns = Array.isArray(r.columns) ? r.columns : [];
    var rows = Array.isArray(r.rows) ? r.rows : [];
    if (!columns.length && !rows.length) return '';
    var status = Array.isArray(r.row_status) ? r.row_status : null;
    var note = Array.isArray(r.row_note) ? r.row_note : null;
    var marks = Boolean(status || note);
    var head = (marks ? '<th class="mark">Отметка</th>' : '') + columns.map(function (c) {
      return '<th>' + esc(c) + '</th>';
    }).join('');
    var body = rows.map(function (row, i) {
      var st = status && ROW_LABEL.hasOwnProperty(status[i]) ? status[i] : null;
      var label = (note && note[i]) || (st ? ROW_LABEL[st] : '');
      var cells = (Array.isArray(row) ? row : []).map(function (v) {
        return '<td>' + esc(cellText(v)) + '</td>';
      }).join('');
      return (st ? '<tr class="row-' + st + '">' : '<tr>') + (marks ? '<td class="mark">' + esc(label) + '</td>' : '') + cells + '</tr>';
    }).join('');
    return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function renderFiles(r, p) {
    var links = (Array.isArray(r.files) ? r.files : []).map(function (f) {
      var href = fileHref(f, p);
      if (!href) return '';
      var name = String(f).replace(/\\/g, '/').split('/').pop();
      return '<a href="' + esc(href) + '" download>' + esc(name) + '</a>';
    }).filter(Boolean);
    return links.length ? '<p class="files">Файлы: ' + links.join(', ') + '</p>' : '';
  }

  // Кнопка «Запустить»: процесс kind script (data-run) или встроенный проект с программой (kind run или поле run,
  // data-run-service). Пока идёт расчёт, кнопка неактивна.
  function canRun(p) {
    if (isService(p)) return p.kind === 'run' || Boolean(p.run);
    return p.kind === 'script';
  }

  function runButton(p) {
    var attr = (isService(p) ? 'data-run-service="' : 'data-run="') + esc(p.slug) + '"';
    return p.running
      ? '<button type="button" class="run" ' + attr + ' disabled>идёт расчёт…</button>'
      : '<button type="button" class="run" ' + attr + '>Запустить</button>';
  }

  // Своя страница встроенного проекта (kind page): «Открыть» на карточке ведёт в подробный вид, где
  // страница показана внутри кабинета как есть (рамку ставит index.html). В подробном виде ссылка «В новой вкладке»
  // на саму страницу s/<slug>/. Ссылки относительные.
  function openLink(p, cls) {
    if (!isService(p) || p.kind !== 'page') return '';
    return '<a class="' + cls + '" href="' + esc(detailHref(p)) + '">Открыть</a>';
  }

  function tabLink(p, cls) {
    if (!isService(p) || p.kind !== 'page') return '';
    return '<a class="' + cls + '" href="s/' + esc(encodeURIComponent(p.slug)) + '/" target="_blank" rel="noopener">В новой вкладке</a>';
  }

  // «Редактировать»: ссылка из ui.edit(p) (страница строит её через prefs.js: новый разговор во вкладке Code
  // приложения Claude в папке сервиса или папка в VS Code). Нет ссылки: кнопки нет.
  function editLink(p, ui, cls, inner) {
    var href = ui && typeof ui.edit === 'function' ? ui.edit(p) : null;
    if (!href) return '';
    return '<a class="' + cls + '" href="' + esc(href) + '" title="Редактировать в Claude" aria-label="Редактировать «' + esc(titleOf(p)) + '»">' + inner + '</a>';
  }

  var ICON_EDIT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

  // В шапке подробной карточки: «Запустить», «В новой вкладке», «Редактировать» или подсказка с фразой (процесс kind claude).
  function renderActions(p, ui) {
    var html = (canRun(p) ? runButton(p) : '') + tabLink(p, 'btn open') + editLink(p, ui, 'btn edit', ICON_EDIT + '<span>Редактировать</span>');
    if (html) return '<div class="actions">' + html + '</div>';
    if (!isService(p) && p.kind === 'claude') {
      return '<div class="actions"><p class="hint">Запуск фразой в Claude: «' + esc(p.phrase) + '»</p></div>';
    }
    return '';
  }

  // p: { slug, title, phrase, kind, result, error, running } из api/processes или
  // { source: 'service', slug, name, kind, result, error, running, path } из api/services.
  // ui.message: короткий текст об ошибке запуска с этой страницы; ui.edit(p): ссылка «Редактировать» или null.
  // Своя страница (kind page): итог и таблицу показывает сама страница под карточкой, здесь только шапка и время.
  function renderCard(p, ui) {
    var r = p.result;
    var page = isService(p) && p.kind === 'page';
    var html = '<article class="card' + (page ? ' card-page' : '') + '" data-slug="' + esc(p.slug) + '"><div class="card-head"><div class="card-title"><h2>' + esc(titleOf(p)) + '</h2>';
    if (r && STATUS_LABEL.hasOwnProperty(r.status)) {
      html += '<span class="badge badge-' + r.status + '">' + STATUS_LABEL[r.status] + '</span>';
    }
    html += '</div>' + renderActions(p, ui) + '</div>';
    if (ui && ui.message) html += '<p class="run-error" role="alert">' + esc(ui.message) + '</p>';
    if (r) {
      html += '<p class="updated">обновлено ' + esc(formatTime(r.updated_at)) + '</p>';
      if (!page) {
        if (r.summary) html += '<p class="summary">' + esc(r.summary) + '</p>';
        html += renderTable(r) + renderFiles(r, p);
      }
    } else if (!p.error) {
      html += '<p class="updated">' + (isService(p) && !canRun(p) ? 'результата пока нет' : 'ещё не запускался') + '</p>';
    }
    if (p.error) html += '<p class="error">Ошибка: ' + esc(p.error) + '</p>';
    return html + '</article>';
  }

  // ---------- сетка сервисов и меню ----------

  // Подробный вид открывается хешем в адресе (#p=<slug> процесс, #s=<slug> встроенный проект), без перезагрузки.
  // Адрес страницы содержит секретную часть, поэтому ссылки только относительные: base '' на главной,
  // './' на других страницах.
  function detailHref(p, base) {
    return (base || '') + (isService(p) ? '#s=' : '#p=') + encodeURIComponent(p.slug);
  }

  // '#p=svetofor-tochek' → 'p:svetofor-tochek', '#s=svodka' → 's:svodka'; другой хеш → null.
  function keyFromHash(hash) {
    var h = String(hash == null ? '' : hash);
    var m = /^#([ps])=(.+)$/.exec(h);
    if (!m) return null;
    try {
      return m[1] + ':' + decodeURIComponent(m[2]);
    } catch (e) {
      return null;
    }
  }

  function findItem(list, key) {
    if (!Array.isArray(list) || key == null) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && itemKey(list[i]) === key) return list[i];
    return null;
  }

  function statusOf(p) {
    var r = p && p.result;
    return r && STATUS_LABEL.hasOwnProperty(r.status) ? r.status : null;
  }

  var ICON_TABLE = '<svg width="24" height="24" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="20" height="18" rx="3"/><path d="M3 10h20M10 10v12"/><path d="M14.5 18.5v-3M17.5 18.5v-5M20.5 18.5v-2"/></svg>';
  var ICON_PROCESS = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="4.5" cy="18" r="1.5"/></svg>';
  var ICON_PAGE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r="0.6"/><path d="M8 14h8M8 17h5"/></svg>';

  // Карточка сервиса «Аналитика таблиц» (страница analiz.html): в сетке всегда первая. С карандашом (ui.edit дал
  // ссылку) карточка не ссылка целиком: ссылка внутри ссылки не работает, поэтому название, «Открыть»
  // и карандаш отдельными ссылками.
  var ANALIZ_ITEM = { source: 'builtin', slug: 'analiz', title: 'Аналитика таблиц' };
  function renderServiceTile(ui) {
    var edit = editLink(ANALIZ_ITEM, ui, 'tile-edit', ICON_EDIT);
    if (edit) {
      return '<article class="tile tile-service"><div class="tile-top"><span class="tile-icon" aria-hidden="true">' + ICON_TABLE + '</span>' + edit + '</div>' +
        '<h2 class="tile-title"><a href="analiz.html">Аналитика таблиц</a></h2>' +
        '<p class="tile-desc">Вопрос своим таблицам словами, строки не уходят с компьютера</p>' +
        '<div class="tile-actions"><a class="btn" href="analiz.html">Открыть</a></div></article>';
    }
    return '<a class="tile tile-service" href="analiz.html">' +
      '<span class="tile-top"><span class="tile-icon" aria-hidden="true">' + ICON_TABLE + '</span></span>' +
      '<span class="tile-title">Аналитика таблиц</span>' +
      '<span class="tile-desc">Вопрос своим таблицам словами, строки не уходят с компьютера</span>' +
      '<span class="tile-actions"><span class="btn">Открыть</span></span></a>';
  }

  // Компактная карточка процесса или встроенного проекта: название, статус цветом, время запуска, итог в две
  // строки (без итога: описание проекта), «Запустить», «Открыть» (своя страница) и «Подробнее».
  function renderTile(p, ui) {
    var r = p.result;
    var st = statusOf(p);
    var href = esc(detailHref(p));
    var page = isService(p) && p.kind === 'page';
    var html = '<article class="tile" data-slug="' + esc(p.slug) + '"' + (isService(p) ? ' data-source="service"' : '') + '><div class="tile-top">' +
      '<span class="tile-icon tile-icon-' + (st || 'none') + '" aria-hidden="true">' + (page ? ICON_PAGE : ICON_PROCESS) + '</span>';
    if (st) html += '<span class="badge badge-' + st + '">' + STATUS_LABEL[st] + '</span>';
    html += editLink(p, ui, 'tile-edit', ICON_EDIT);
    html += '</div><h2 class="tile-title"><a href="' + href + '">' + esc(titleOf(p)) + '</a></h2>';
    if (r) html += '<p class="tile-when">обновлено ' + esc(formatTime(r.updated_at)) + '</p>';
    else if (!p.error && canRun(p)) html += '<p class="tile-when">ещё не запускался</p>';
    if (r && r.summary) html += '<p class="tile-sum" title="' + esc(r.summary) + '">' + esc(r.summary) + '</p>';
    else if (isService(p) && p.about) html += '<p class="tile-sum tile-about">' + esc(p.about) + '</p>';
    if (p.error) html += '<p class="tile-error">Ошибка: ' + esc(p.error) + '</p>';
    if (ui && ui.message) html += '<p class="run-error tile-msg" role="alert">' + esc(ui.message) + '</p>';
    html += '<div class="tile-actions">' + (canRun(p) ? runButton(p) : '') + openLink(p, 'btn open');
    if (!isService(p) && p.kind === 'claude') html += '<p class="hint tile-hint">Запуск фразой в Claude: «' + esc(p.phrase) + '»</p>';
    // У своей страницы «Открыть» и есть подробный вид: «Подробнее» не дублируем.
    return html + (page ? '' : '<a class="btn more" href="' + href + '">Подробнее</a>') + '</div></article>';
  }

  // Пункты меню «Мои сервисы»: название и цветная точка статуса (идёт расчёт: точка цвета компании).
  // activeKey: ключ карточки, открытой справа ('p:<slug>' или 's:<slug>'); base: '' на главной, './' на других.
  function renderNav(list, activeKey, base) {
    return (Array.isArray(list) ? list : []).map(function (p) {
      var st = p.running ? 'run' : statusOf(p);
      var label = p.running ? 'идёт расчёт' : st ? STATUS_LABEL[st] : 'ещё нет результата';
      return '<a class="nav-item" href="' + esc(detailHref(p, base)) + '"' + (itemKey(p) === activeKey ? ' aria-current="page"' : '') + '>' +
        '<span class="dot dot-' + (st || 'none') + '" aria-hidden="true"></span>' +
        '<span class="nav-label">' + esc(titleOf(p)) + '<span class="sr-only">, ' + label + '</span></span></a>';
    }).join('');
  }

  // Список встроенных проектов из api/services (список или объект со списком services/items) с пометкой
  // source: 'service'; записи без строки slug пропускаются.
  function servicesFrom(data) {
    var list = Array.isArray(data) ? data : data && typeof data === 'object' ? data.services || data.items : null;
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || typeof s !== 'object' || typeof s.slug !== 'string' || !s.slug) continue;
      var copy = {};
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) copy[k] = s[k];
      copy.source = 'service';
      out.push(copy);
    }
    return out;
  }

  // Правая часть главной. view.key: карточка из адреса ('p:<slug>', 's:<slug>') → её подробный вид со ссылкой
  // «← Все сервисы»; иначе сетка: «Аналитика таблиц», процессы и встроенные проекты. Своих сервисов нет: в сетке
  // только «Аналитика таблиц» (без подсказки). messages: { ключ: текст } для карточек, где
  // запуск не удался. view.edit(p): ссылка «Редактировать» или null.
  function renderPage(list, messages, view) {
    var items = Array.isArray(list) ? list : [];
    var open = findItem(items, view && view.key);
    if (open) {
      return '<div class="detail"><p class="crumbs"><a class="back" href="#">← Все сервисы</a></p>' +
        renderCard(open, { message: messages && messages[itemKey(open)], edit: view && view.edit }) + '</div>';
    }
    return '<div class="grid">' + renderServiceTile({ edit: view && view.edit }) + items.map(function (p) {
      return renderTile(p, { message: messages && messages[itemKey(p)], edit: view && view.edit });
    }).join('') + '</div>';
  }

  global.CabinetRender = {
    renderCard: renderCard,
    renderTile: renderTile,
    renderNav: renderNav,
    renderPage: renderPage,
    formatTime: formatTime,
    keyFromHash: keyFromHash,
    itemKey: itemKey,
    findItem: findItem,
    servicesFrom: servicesFrom,
  };
})(window);
