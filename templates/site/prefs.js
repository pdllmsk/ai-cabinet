// Настройки страницы в этом браузере: тема (как в системе, светлая, тёмная) и где редактировать сервисы
// (приложение Claude или VS Code). Подключается в <head> обычным <script src="prefs.js"> до стилей страницы:
// тема ставится до первой отрисовки, без вспышки светлого фона. Хранится в localStorage браузера; нет доступа
// к нему (частное окно, запрет): работают значения по умолчанию.
(function (global) {
  'use strict';

  var THEME_KEY = 'kabinet-theme';
  var EDITOR_KEY = 'kabinet-editor';
  var THEMES = { auto: true, light: true, dark: true };
  var EDITORS = { claude: true, vscode: true };
  var root = document.documentElement;

  // Без доступа к хранилищу выбор живёт в памяти: действует до перезагрузки страницы.
  var memory = {};

  function read(key, allowed, fallback) {
    var v = memory[key];
    try {
      var stored = global.localStorage.getItem(key);
      if (stored !== null) v = stored;
    } catch (e) {
      // берём из памяти
    }
    return allowed[v] ? v : fallback;
  }

  function write(key, value) {
    memory[key] = value;
    try {
      global.localStorage.setItem(key, value);
    } catch (e) {
      // осталось в памяти
    }
  }

  function systemDark() {
    return Boolean(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // Тема, которая видна сейчас: 'light' или 'dark'.
  function shownTheme() {
    var t = read(THEME_KEY, THEMES, 'auto');
    return t === 'auto' ? (systemDark() ? 'dark' : 'light') : t;
  }

  function apply() {
    var t = read(THEME_KEY, THEMES, 'auto');
    if (t === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    var dark = shownTheme() === 'dark';
    // .dk: видна тёмная тема (выбрана или из системы); по нему dark.css правит цвета, записанные в правилах страниц.
    if (dark) root.classList.add('dk');
    else root.classList.remove('dk');
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.title = dark ? 'Светлая тема' : 'Тёмная тема';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function setTheme(t) {
    if (!THEMES[t]) return;
    write(THEME_KEY, t);
    apply();
  }

  // Ссылка «Редактировать»: новый разговор во вкладке Code приложения Claude в папке folder (claude://code/new,
  // приложение спросит, доверяете ли вы папке) или папка в VS Code. prompt: начало просьбы в поле ввода.
  function editHref(folder, prompt, editor) {
    if (!folder) return null;
    var path = String(folder);
    if ((editor || read(EDITOR_KEY, EDITORS, 'claude')) === 'vscode') {
      var p = path.replace(/\\/g, '/');
      return 'vscode://file' + (p.charAt(0) === '/' ? '' : '/') + encodeURI(p);
    }
    return 'claude://code/new?folder=' + encodeURIComponent(path) + (prompt ? '&q=' + encodeURIComponent(prompt) : '');
  }

  apply();
  if (global.matchMedia) {
    var mq = global.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', apply);
  }
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', function () {
      setTheme(shownTheme() === 'dark' ? 'light' : 'dark');
    });
  });

  global.CabinetPrefs = {
    theme: function () { return read(THEME_KEY, THEMES, 'auto'); },
    setTheme: setTheme,
    editor: function () { return read(EDITOR_KEY, EDITORS, 'claude'); },
    setEditor: function (e) { if (EDITORS[e]) write(EDITOR_KEY, e); },
    editHref: editHref,
  };
})(window);
