#!/usr/bin/env python3
"""«Аналитика таблиц»: ответы на вопросы к своим таблицам. Считает программа на этом компьютере,
строки файлов в модель не уходят никогда.

    python tools/analiz.py passport [--dir input/analiz] [--text]   паспорт данных: файлы, листы, столбцы
    python tools/analiz.py run <запрос.json | - > [--text]           выполнить запрос JSON, ответ в историю
    python tools/analiz.py ask "<вопрос>"                             вопрос словами: модель видит только паспорт
    python tools/analiz.py excel <id>                                 Excel с таблицей и графиком из ответа истории
    python tools/analiz.py history [--limit N]                        история ответов, новые сверху
    python tools/analiz.py demo                                       пример: учебная выгрузка и готовый ответ

Читает только таблицы из input/analiz/ (xlsx, csv, txt; через read_table.py), пишет только в output/analiz/
(история history.json и файлы Excel). Исключение одно: demo кладёт копию учебной выгрузки в input/analiz/,
если такой копии там ещё нет, и чужие файлы не перезаписывает. В модель (только ask, через llm.py)
уходят паспорт и вопрос. Запрос JSON описан в плане «Аналитика таблиц»: table, sheet,
filters, group_by, measures, compare, join, sort, limit.

Вывод для программ: JSON в stdout. Ошибка: одна строка по-русски в stderr и {"error": ...} в stdout.
Коды выхода: 0 готово; 2 ошибка в запросе или в данных; 3 Claude для страницы недоступен; 4 запрос не прошёл
проверку llm.py (слишком большой объём); 5 вопрос требует читать текст строк (это делает Claude во вкладке Code).
Только стандартная библиотека и openpyxl.
"""

import argparse
import contextlib
import difflib
import json
import operator
import os
import re
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import read_table as rt  # noqa: E402

try:
    import llm  # модель: tools/llm.py
except Exception:  # нет файла или он не загрузился: модель недоступна
    llm = None

MODEL = "sonnet"
MAX_LIMIT = 200          # строк ответа в истории
SHOWN = 30               # строк ответа в stdout (в разговор и в модель)
MAX_VALUES = 30          # значений справочника в паспорте
MAX_GROUP_BY = 3
HISTORY_MAX = 100        # ответов в истории
READ_LIMIT = 2_000_000   # строк одной таблицы
BIG_ROWS = 300_000       # мягкое предупреждение о большом объёме
BIG_MB = 50
PASSPORT_CHARS = 40_000  # паспорт для модели: не больше (проверка llm.py пропускает до 60 000 знаков вместе с инструкцией)
TABLE_EXT = rt.CSV_EXT | rt.XLSX_EXT
OPS = ("=", "!=", ">", "<", ">=", "<=", "in", "not_in", "contains", "between")
AGGS = ("sum", "avg", "count", "count_distinct", "min", "max")
PERIODS = {"day": "день", "week": "неделя", "month": "месяц", "quarter": "квартал", "year": "год"}
NUM, DATE, TEXT, PERIOD = "число", "дата", "текст", "период"
KIND = {NUM: "числовой столбец", DATE: "столбец дат", TEXT: "текстовый столбец", PERIOD: "столбец периодов"}
EMPTY_LABEL = "(пусто)"  # группа строк, где в столбце группировки ничего нет (или нет пары при соединении)
DEMO_SOURCE = ("input", "case", "data", "prodazhi_1c.csv")
DEMO_SPEC = ("templates", "analiz", "demo-zapros.json")
ID_RE = re.compile(r"^q-[0-9A-Za-z-]{1,40}$")
class Stop(rt.UserError):
    """Понятная человеку ошибка: одна строка по-русски, код выхода (2 по умолчанию) и поля для JSON."""

    def __init__(self, message, code=2, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


# ---------- числа и даты ----------

EMPTY = {"", "-", "\u2013", "\u2014", "--"}
NUM_STRICT = re.compile(r"^[-+]?\d+(?:\.\d+)?$")
THOUSANDS_DOT = re.compile(r"^[-+]?\d{1,3}(?:\.\d{3})+$")
THOUSANDS_COMMA = re.compile(r"^[-+]?\d{1,3}(?:,\d{3})+$")
SPACES = re.compile(r"[\s\u00a0\u202f\u2009]+")
TIME_TAIL = r"(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?"
DATE_DMY = re.compile(r"^(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})" + TIME_TAIL + "$")
DATE_YMD = re.compile(r"^(\d{4})[-./](\d{1,2})[-./](\d{1,2})" + TIME_TAIL + "$")
DATE_NAME = re.compile(r"дат|date|день|период", re.I)
EXCEL_EPOCH = date(1899, 12, 30)


def is_empty(text):
    return text is None or str(text).strip() in EMPTY


def parse_number(text):
    """Число из ячейки: «1 234,5», «1234.5», «1.234,56», «1,234.56», «15%» (15). Не число: None."""
    if text is None:
        return None
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        return float(text)
    t = SPACES.sub("", str(text))
    if t.endswith("%"):
        t = t[:-1]
    if not t:
        return None
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".") if t.rfind(",") > t.rfind(".") else t.replace(",", "")
    elif THOUSANDS_COMMA.match(t) and t.count(",") > 1:
        t = t.replace(",", "")
    elif THOUSANDS_DOT.match(t) and t.count(".") > 1:
        t = t.replace(".", "")
    else:
        t = t.replace(",", ".")
    return float(t) if NUM_STRICT.match(t) else None


def parse_date(text):
    """Дата из ячейки: ДД.ММ.ГГГГ (и ДД.ММ.ГГ, ДД/ММ/ГГГГ), ГГГГ-ММ-ДД, со временем или без. Не дата: None."""
    if text is None:
        return None
    if isinstance(text, datetime):
        return text.date()
    if isinstance(text, date):
        return text
    t = str(text).strip()
    m = DATE_DMY.match(t)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
    else:
        m = DATE_YMD.match(t)
        if not m:
            return None
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return date(y, mo, d)
    except ValueError:
        return None


def excel_serial(x):
    return EXCEL_EPOCH + timedelta(days=int(x))


def norm(text):
    return " ".join(str(text).split()).lower().replace("ё", "е")


def label(text):
    return " ".join(str(text).split())


def no_dash(text):
    """Тексты для человека без длинных и средних тире: только дефис."""
    return re.sub(r"\s*[\u2012-\u2015]\s*", " - ", str(text)).replace("  ", " ")


# ---------- форматирование ----------

def clean_number(x, digits=2):
    if x is None:
        return None
    x = round(float(x), digits)
    if x == 0:
        return 0
    return int(x) if x == int(x) and abs(x) < 1e15 else x


def fmt_ru(x, digits=2):
    """Число для человека: 1 234 567,5."""
    if x is None:
        return "нет данных"
    x = clean_number(x, digits)
    if isinstance(x, int):
        return f"{x:,}".replace(",", " ")
    whole, frac = f"{x:,.{digits}f}".split(".")
    frac = frac.rstrip("0")
    whole = whole.replace(",", " ")
    return f"{whole},{frac}" if frac else whole


def fmt_pct(x):
    if x is None:
        return "нет данных"
    return ("+" if x > 0 else "") + fmt_ru(x, 1) + "%"


def fmt_date(d):
    return d.strftime("%d.%m.%Y")


def json_value(v, typ):
    if v is None:
        return None
    if isinstance(v, date):
        return v.isoformat()
    if typ == NUM or isinstance(v, float):
        return clean_number(v)
    return v


# ---------- таблицы ----------

class Column:
    __slots__ = ("name", "typ", "vals", "raw", "bad", "empty", "_keys", "serial")

    def __init__(self, name, typ, vals, raw, bad, empty, serial=False):
        self.name, self.typ, self.vals, self.raw = name, typ, vals, raw
        self.bad, self.empty, self.serial = bad, empty, serial
        self._keys = None

    @property
    def keys(self):
        """Ключи для отбора и группировки: текст без учёта регистра и лишних пробелов, числа и даты как есть."""
        if self._keys is None:
            self._keys = [norm(v) if v is not None else None for v in self.vals] if self.typ == TEXT else self.vals
        return self._keys

    def is_bad(self, i):
        return self.vals[i] is None and not is_empty(self.raw[i])


def profile(name, raw):
    """Тип столбца по значениям: дата, число или текст (90% непустых значений читаются)."""
    filled = [v for v in raw if not is_empty(v)]
    n = len(filled)
    empty = len(raw) - n
    if not n:
        return Column(name, TEXT, [None] * len(raw), raw, 0, empty)
    step = max(1, n // 400)
    sample = filled[::step]
    need_for = {DATE: 0.75, NUM: 0.9}  # дата: в реестрах бывает «бессрочно»; число: коды вида «А-12» остаются текстом

    def share(fn):
        return sum(1 for v in sample if fn(v) is not None) / len(sample)

    order = sorted(((share(parse_date), DATE), (share(parse_number), NUM)), key=lambda p: -p[0])
    for s, typ in order:
        need = need_for[typ]
        if s < need:
            continue
        fn = parse_date if typ == DATE else parse_number
        vals = [None if is_empty(v) else fn(v) for v in raw]
        ok = sum(1 for v in vals if v is not None)
        if ok >= need * n:
            if typ == NUM and DATE_NAME.search(name) and all(
                    v is None or (v == int(v) and 20000 <= v <= 80000) for v in vals):
                vals = [None if v is None else excel_serial(v) for v in vals]
                return Column(name, DATE, vals, raw, n - ok, empty, serial=True)
            return Column(name, typ, vals, raw, n - ok, empty)
    return Column(name, TEXT, [None if is_empty(v) else label(v) for v in raw], raw, 0, empty)


class Table:
    """Лист или CSV: названия столбцов и строки (текст ячеек из read_table), типы столбцов по запросу."""

    def __init__(self, file, sheet, res):
        self.file, self.sheet, self.res = file, sheet, res
        self.columns = dedupe(res.get("columns") or [])
        self.rows = res.get("rows") or []
        self.n = len(self.rows)
        self._cols = {}

    @property
    def title(self):
        return f"{self.file}, лист «{self.sheet}»" if self.sheet else self.file

    def column(self, i):
        c = self._cols.get(i)
        if c is None:
            c = self._cols[i] = profile(self.columns[i], [r[i] if i < len(r) else "" for r in self.rows])
        return c


def dedupe(cols):
    seen, out = {}, []
    for c in cols:
        k = norm(c)
        seen[k] = seen.get(k, 0) + 1
        out.append(c if seen[k] == 1 else f"{c} ({seen[k]})")
    return out


def input_dir(root, sub=None):
    base = (root / "input" / "analiz").resolve()
    if not sub:
        return base
    p = Path(sub)
    p = (p if p.is_absolute() else root / p).resolve()
    if p != base and base not in p.parents:
        raise Stop(f"Таблицы для «Аналитика таблиц» читаются только из папки input/analiz, а не из «{sub}».")
    return p


def output_dir(root):
    out = root / "output" / "analiz"
    out.mkdir(parents=True, exist_ok=True)
    real, top = out.resolve(), root.resolve()
    if top not in real.parents:
        raise Stop("Папка output/analiz ведёт за пределы кабинета: ответы туда не записываются.")
    return out


def list_files(base):
    """Таблицы в папке и подпапках: (имя относительно папки, путь). Временные файлы Excel (~$) и скрытые пропускаются,
    ссылки за пределы папки тоже."""
    if not base.is_dir():
        return [], []
    found, skipped = [], []
    for p in sorted(base.rglob("*"), key=lambda q: str(q).lower()):
        rel = p.relative_to(base).as_posix()
        if any(part.startswith((".", "~$")) for part in p.relative_to(base).parts) or not p.is_file():
            continue
        ext = p.suffix.lower()
        if ext not in TABLE_EXT and ext != ".xls":
            continue
        if base not in p.resolve().parents:
            skipped.append({"file": rel, "reason": "ссылка на файл вне папки input/analiz, не читается"})
            continue
        found.append((rel, p))
    return found, skipped


def read_sheets(path, sheet=None, all_sheets=False):
    """Таблицы файла через read_table: CSV одна, xlsx по листу (все листы для паспорта)."""
    ext = rt.check_file(path)
    if ext in rt.CSV_EXT:
        return [(None, rt.read_csv(path, READ_LIMIT))]
    wb = rt.open_book(path)
    try:
        names = list(wb.sheetnames)
        if all_sheets:
            wanted = range(len(names))
        elif sheet is None or sheet == "":
            wanted = None
        else:
            wanted = [rt.resolve_sheet(names, sheet)]
        out = []
        for si in (wanted if wanted is not None else range(len(names))):
            merges, warn = rt.sheet_merges(path, si)
            res = rt.scan(rt.iter_sheet_rows(wb[names[si]]), merges, READ_LIMIT)
            res["warnings"] = [warn] if warn else []
            if wanted is None and res["columns"] and res["data_rows"]:
                return [(names[si], res)]  # лист не указан: первый лист с данными
            out.append((names[si], res))
        return out[:1] if wanted is None else out
    finally:
        wb.close()


def find_table(root, name, sheet):
    base = input_dir(root)
    files, _ = list_files(base)
    if not files:
        raise Stop("В папке input/analiz нет таблиц: положите туда файлы Excel (.xlsx) или CSV и спросите снова.")
    if not name:
        if len(files) == 1:
            name = files[0][0]
        else:
            raise Stop("В запросе не указана таблица (table). Есть: " + ", ".join(r for r, _ in files) + ".")
    w = norm(str(name).replace("\\", "/"))
    match = [f for f in files if norm(f[0]) == w] or [f for f in files if norm(f[1].name) == w] \
        or [f for f in files if norm(f[1].stem) == w]
    if len(match) != 1:
        listing = ", ".join(r for r, _ in files)
        if not match:
            raise Stop(f"Таблицы «{name}» нет в папке input/analiz. Есть: {listing}.")
        raise Stop(f"Под «{name}» подходят несколько файлов, укажите путь из паспорта: {listing}.")
    rel, path = match[0]
    sheets = read_sheets(path, sheet)
    if not sheets or not sheets[0][1]["columns"]:
        raise Stop(f"В таблице «{rel}» нет данных.")
    sh_name, res = sheets[0]
    return Table(rel, sh_name, res)


def find_col(columns, wanted, where, notes=None):
    """Столбец по названию: точно (без учёта регистра и лишних пробелов), иначе единственный, где есть эти слова."""
    if not isinstance(wanted, str) or not wanted.strip():
        raise Stop(f"{where}: нужно название столбца строкой, а пришло «{wanted}».")
    w = norm(wanted)
    keys = [norm(c) for c in columns]
    exact = [i for i, k in enumerate(keys) if k == w]
    if exact:
        return exact[0]
    part = [i for i, k in enumerate(keys) if w in k]
    if len(part) == 1:
        if notes is not None:
            notes.append(f"«{wanted}» понят как столбец «{columns[part[0]]}».")
        return part[0]
    near = difflib.get_close_matches(w, keys, n=3, cutoff=0.5)
    near = [columns[keys.index(k)] for k in near] or [columns[i] for i in part[:3]]
    hint = (" Похожие: " + ", ".join(f"«{c}»" for c in near) + ".") if near else ""
    raise Stop(f"{where}: столбца «{wanted}» нет.{hint} Столбцы: " + ", ".join(columns) + ".")


# ---------- паспорт ----------

def col_passport(c):
    d = {"name": c.name, "type": c.typ}
    if c.empty:
        d["empty"] = c.empty
    if c.bad:
        d["unreadable"] = c.bad
    present = [v for v in c.vals if v is not None]
    if c.typ == NUM and present:
        lo, hi = min(present), max(present)
        d["min"], d["max"] = clean_number(lo), clean_number(hi)
    elif c.typ == DATE and present:
        d["first"], d["last"] = min(present).isoformat(), max(present).isoformat()
        if c.serial:
            d["excel_dates"] = True
    elif c.typ == TEXT:
        first = {}
        for v in present:
            k = norm(v)
            if k not in first:
                first[k] = v
                if len(first) > MAX_VALUES:
                    break
        d["distinct"] = len(first) if len(first) <= MAX_VALUES else len(set(norm(v) for v in present))
        if len(first) <= MAX_VALUES and first:
            labels = sorted(first.values(), key=norm)
            d["values"] = labels
    return d


def passport(root, sub=None):
    base = input_dir(root, sub)
    files, skipped = list_files(base)
    out = {"dir": base.relative_to(root.resolve()).as_posix() if root.resolve() in base.parents else str(base),
           "files": [], "skipped": skipped, "warnings": [], "total_rows": 0}
    if not base.is_dir() or not (files or skipped):
        out["warnings"].append("В папке input/analiz пока нет таблиц: положите туда файлы Excel (.xlsx) или CSV.")
    size = 0
    for rel, path in files:
        try:
            sheets = read_sheets(path, all_sheets=True)
        except rt.UserError as e:
            skipped.append({"file": rel, "reason": " ".join(str(e).split())})
            continue
        except Exception as e:
            skipped.append({"file": rel, "reason": f"файл не читается ({type(e).__name__})"})
            continue
        size += path.stat().st_size
        f = {"file": rel, "type": "xlsx" if path.suffix.lower() in rt.XLSX_EXT else "csv",
             "size_kb": round(path.stat().st_size / 1024), "sheets": []}
        for name, res in sheets:
            t = Table(rel, name, res)
            s = {"sheet": name, "rows": t.n}
            if not t.columns:
                s["note"] = "нет данных"
                f["sheets"].append(s)
                continue
            above = [" ".join(c for c in row)[:150] for row in res.get("above_header", [])[:3]]
            if above:
                s["title"] = above
            s["columns"] = [col_passport(t.column(i)) for i in range(len(t.columns))]
            out["total_rows"] += t.n
            f["sheets"].append(s)
        out["files"].append(f)
    for sk in skipped:
        out["warnings"].append(f"Файл «{sk['file']}» не прочитан: {sk['reason']}")
    if out["total_rows"] > BIG_ROWS or size > BIG_MB * 1024 * 1024:
        out["warnings"].append(f"Данных много ({fmt_ru(out['total_rows'])} строк): ответ может считаться дольше обычного. "
                               "Уберите из input/analiz файлы, которые не нужны для вопросов.")
    return out


def passport_for_model(p):
    """Паспорт одной строкой JSON (без строк таблиц): в модель. Длинный: без списков значений."""
    files = []
    for f in p["files"]:
        for s in f["sheets"]:
            if s.get("columns"):
                t = {"table": f["file"], "sheet": s["sheet"], "rows": s["rows"], "columns": s["columns"]}
                if s.get("title"):
                    t["title"] = s["title"]
                files.append(t)
    text = json.dumps(files, ensure_ascii=False, separators=(",", ":"))
    if len(text) > PASSPORT_CHARS:
        slim = [{**t, "columns": [{k: v for k, v in c.items() if k != "values"} for c in t["columns"]]} for t in files]
        text = json.dumps(slim, ensure_ascii=False, separators=(",", ":"))
    if len(text) > PASSPORT_CHARS:
        raise Stop("В папке input/analiz слишком много таблиц и столбцов для одного вопроса: "
                   "оставьте там только нужные файлы и спросите снова.")
    return text


def passport_text(p):
    out = []
    for f in p["files"]:
        for s in f["sheets"]:
            where = f["file"] + (f", лист «{s['sheet']}»" if s["sheet"] else "")
            if not s.get("columns"):
                out.append(f"{where}: нет данных")
                continue
            out.append(f"{where}: строк {fmt_ru(s['rows'])}")
            for c in s["columns"]:
                line = f"  {c['name']}: {c['type']}"
                if "min" in c:
                    line += f", от {fmt_ru(c['min'])} до {fmt_ru(c['max'])}"
                if "first" in c:
                    line += f", с {fmt_date(date.fromisoformat(c['first']))} по {fmt_date(date.fromisoformat(c['last']))}"
                if "distinct" in c:
                    line += f", разных {c['distinct']}"
                if isinstance(c.get("values"), list):
                    line += ": " + "; ".join(c["values"])
                elif c.get("values"):
                    line += f", {c['values']}"
                if c.get("unreadable"):
                    line += f", не читается в {c['unreadable']} строках"
                out.append(line)
    out += p["warnings"]
    return "\n".join(out)


# ---------- запрос ----------

def show_value(v):
    if isinstance(v, (list, tuple)):
        return ", ".join(show_value(x) for x in v)
    return f"«{v}»" if isinstance(v, str) else str(v)


def as_list(x):
    if x is None:
        return []
    return list(x) if isinstance(x, (list, tuple)) else [x]


def conv_value(col, value, where):
    """Значение отбора к типу столбца."""
    if col.typ == NUM:
        v = parse_number(value) if not isinstance(value, bool) else None
        if v is None:
            raise Stop(f"{where}: «{value}» не число, а «{col.name}» числовой столбец.")
        return v
    if col.typ == DATE:
        v = parse_date(value)
        if v is None:
            raise Stop(f"{where}: «{value}» не дата, а «{col.name}» столбец дат. Даты пишите так: 2026-09-14.")
        return v
    return norm(value)


def make_filter(col, op, value, where):
    """Проверка строки по номеру: True, если строка проходит отбор."""
    keys = col.keys
    if op not in OPS:
        raise Stop(f"{where}: оператора «{op}» нет. Есть: " + " ".join(OPS) + ".")
    if op == "contains":
        w = norm(value)
        raw = col.raw
        return lambda i: w in norm(raw[i])
    if op in ("in", "not_in"):
        if not isinstance(value, (list, tuple)) or not value:
            raise Stop(f"{where}: для «{op}» нужен список значений, например [\"Золото 585\", \"Серебро 925\"].")
        allowed = {conv_value(col, v, where) for v in value}
        if op == "in":
            return lambda i: keys[i] in allowed
        return lambda i: keys[i] not in allowed
    if op == "between":
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            raise Stop(f"{where}: для «between» нужен список из двух значений [от, до].")
        if col.typ == TEXT:
            raise Stop(f"{where}: «between» подходит для чисел и дат, а «{col.name}» текстовый столбец.")
        lo, hi = conv_value(col, value[0], where), conv_value(col, value[1], where)
        if lo > hi:
            lo, hi = hi, lo
        return lambda i: keys[i] is not None and lo <= keys[i] <= hi
    if isinstance(value, (list, tuple)):
        raise Stop(f"{where}: для «{op}» нужно одно значение; для списка есть in и not_in.")
    if op in ("=", "!="):
        v = conv_value(col, value, where) if not (col.typ == TEXT and is_empty(value)) else None
        if op == "=":
            return lambda i: keys[i] == v
        return lambda i: keys[i] != v
    if col.typ == TEXT:
        raise Stop(f"{where}: «{op}» подходит для чисел и дат, а «{col.name}» текстовый столбец. "
                   "Для текста есть = != in not_in contains.")
    v = conv_value(col, value, where)
    fn = {">": operator.gt, "<": operator.lt, ">=": operator.ge, "<=": operator.le}[op]
    return lambda i: keys[i] is not None and fn(keys[i], v)


def period_key(d, period):
    if d is None:
        return None
    if period == "week":
        return d - timedelta(days=d.weekday())
    if period == "month":
        return date(d.year, d.month, 1)
    if period == "quarter":
        return date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)
    if period == "year":
        return date(d.year, 1, 1)
    return d


def period_label(k, period):
    if k is None:
        return None
    if period == "month":
        return f"{k.year}-{k.month:02d}"
    if period == "quarter":
        return f"{k.year}, {(k.month - 1) // 3 + 1} кв."
    if period == "year":
        return str(k.year)
    return k.isoformat()


class Acc:
    """Накопитель меры по группе."""
    __slots__ = ("agg", "s", "n", "lo", "hi", "seen")

    def __init__(self, agg):
        self.agg, self.s, self.n, self.lo, self.hi = agg, 0.0, 0, None, None
        self.seen = set() if agg == "count_distinct" else None

    def add(self, v):
        if v is None:
            return
        if self.agg in ("sum", "avg"):
            self.s += v
        elif self.agg == "count_distinct":
            self.seen.add(v)
        elif self.agg in ("min", "max"):
            self.lo = v if self.lo is None or v < self.lo else self.lo
            self.hi = v if self.hi is None or v > self.hi else self.hi
        self.n += 1

    def value(self):
        a = self.agg
        if a == "sum":
            return self.s
        if a == "avg":
            return self.s / self.n if self.n else None
        if a == "count":
            return self.n
        if a == "count_distinct":
            return len(self.seen)
        return self.lo if a == "min" else self.hi


AGG_NAMES = {"sum": "{c}", "avg": "Среднее, {c}", "count": "Заполнено, {c}", "count_distinct": "Разных, {c}",
             "min": "Мин., {c}", "max": "Макс., {c}"}


def validate_spec(spec):
    if not isinstance(spec, dict):
        raise Stop("Запрос должен быть объектом JSON: {\"table\": ..., \"group_by\": [...], \"measures\": [...]}.")
    for key in ("filters", "group_by", "measures"):
        if spec.get(key) is not None and not isinstance(spec.get(key), (list, tuple, str, dict)):
            raise Stop(f"В запросе «{key}» должен быть списком.")
    for key in ("compare", "join"):
        if spec.get(key) is not None and not isinstance(spec.get(key), dict):
            raise Stop(f"В запросе «{key}» должен быть объектом или null.")


def do_join(root, t, cols, j, notes):
    """Левое соединение: к строкам основной таблицы столбцы cols из второй, первая пара по ключам on."""
    right = find_table(root, j.get("table"), j.get("sheet"))
    on = j.get("on") or []
    if isinstance(on, (list, tuple)) and len(on) == 2 and all(isinstance(x, str) for x in on):
        on = [on]
    if not on or not all(isinstance(p, (list, tuple)) and len(p) == 2 for p in on):
        raise Stop("Соединение (join): «on» нужен списком пар [[\"столбец слева\", \"столбец справа\"]].")
    names = list(cols)
    left_keys, right_keys = [], []
    for a, b in on:
        left_keys.append(cols[names[find_col(names, a, 'Соединение, столбец слева', notes)]])
        right_keys.append(right.column(find_col(right.columns, b, f"Соединение, таблица «{right.title}»", notes)))
    want = as_list(j.get("cols")) or [c for c in right.columns
                                       if norm(c) not in {norm(k.name) for k in right_keys}]
    right_cols = [right.column(find_col(right.columns, c, f"Соединение, таблица «{right.title}»", notes)) for c in want]

    def key_of(cs, i):
        out = []
        for c in cs:
            v = c.vals[i]
            if v is None and is_empty(c.raw[i]):
                return None
            if isinstance(v, date):
                out.append(v.isoformat())
            elif isinstance(v, float):
                out.append(repr(clean_number(v, 6)))
            else:
                p = parse_number(c.raw[i])
                out.append(repr(clean_number(p, 6)) if p is not None else norm(c.raw[i]))
        return tuple(out)

    index, dups = {}, 0
    for i in range(right.n):
        k = key_of(right_keys, i)
        if k is None:
            continue
        if k in index:
            dups += 1
        else:
            index[k] = i
    match = [index.get(key_of(left_keys, i)) for i in range(t.n)]
    miss = sum(1 for m in match if m is None)
    for rc in right_cols:
        name = rc.name if norm(rc.name) not in {norm(n) for n in cols} else f"{rc.name} ({right.file})"
        cols[name] = Column(name, rc.typ, [rc.vals[m] if m is not None else None for m in match],
                            [rc.raw[m] if m is not None else "" for m in match], 0, 0, rc.serial)
    notes.append(f"Соединение с «{right.title}»: пара нашлась для {fmt_ru(t.n - miss)} строк из {fmt_ru(t.n)}.")
    if dups:
        notes.append(f"В «{right.title}» ключ повторяется в {fmt_ru(dups)} строках: взята первая строка с этим ключом.")


def execute(root, spec):
    """Выполнить запрос: результат (словарь ответа без id и времени)."""
    validate_spec(spec)
    notes = []
    t = find_table(root, spec.get("table"), spec.get("sheet"))
    cols = {name: None for name in t.columns}
    for i, name in enumerate(t.columns):
        cols[name] = _LazyCol(t, i)
    join = spec.get("join")
    if join:
        cols = {n: (c.get() if isinstance(c, _LazyCol) else c) for n, c in cols.items()}
        do_join(root, t, cols, join, notes)
    names = list(cols)

    def col(name, where):
        n = names[find_col(names, name, where, notes)]
        c = cols[n]
        if isinstance(c, _LazyCol):
            c = cols[n] = c.get()
        return c

    # отборы
    rows = range(t.n)
    tests, described = [], []
    for k, f in enumerate(as_list(spec.get("filters")), 1):
        if not isinstance(f, dict):
            raise Stop(f"Отбор {k}: нужен объект {{\"col\": ..., \"op\": ..., \"value\": ...}}.")
        where = f"Отбор {k}"
        c = col(f.get("col"), where)
        op = str(f.get("op", "=")).strip().lower()
        tests.append((c, op, f.get("value"), make_filter(c, op, f.get("value"), where)))
        described.append(f"{c.name} {op} {show_value(f.get('value'))}")
    selected = [i for i in rows if all(test(i) for _, _, _, test in tests)] if tests else list(rows)
    if tests:
        notes.append(f"Отбор ({'; '.join(described)}): строк {fmt_ru(len(selected))} из {fmt_ru(t.n)}.")
        for c, op, _, _ in tests:
            if c.typ in (NUM, DATE) and op not in ("contains",):
                bad = sum(1 for i in rows if c.is_bad(i))
                if bad:
                    kind = "не число" if c.typ == NUM else "не дата"
                    notes.append(f"В «{c.name}» {kind} в {fmt_ru(bad)} строках: в отбор по этому столбцу не вошли.")
    if not selected:
        raise Stop(empty_message(t, tests, described))

    # периоды сравнения
    cmp = spec.get("compare")
    labels_ab = None
    if cmp:
        cc = col(cmp.get("col"), "Сравнение (compare)")
        if cc.typ not in (DATE, NUM):
            raise Stop(f"Сравнение (compare): «{cc.name}» не столбец дат и не числовой. Сравнивать периоды можно по дате.")
        rng = []
        for side in ("a", "b"):
            v = cmp.get(side)
            if not isinstance(v, (list, tuple)) or len(v) != 2:
                raise Stop(f"Сравнение (compare): «{side}» нужен списком [от, до], например [\"2026-09-07\", \"2026-09-13\"].")
            lo, hi = (conv_value(cc, x, f"Сравнение, период {side.upper()}") for x in v)
            rng.append((min(lo, hi), max(lo, hi)))
        (a1, a2), (b1, b2) = rng
        if a1 <= b2 and b1 <= a2:
            raise Stop("Сравнение (compare): периоды A и B пересекаются, задайте их без общих дат.")
        cmp_keys = cc.keys

        def period_of(i):
            v = cmp_keys[i]
            if v is None:
                return None
            return 0 if a1 <= v <= a2 else 1 if b1 <= v <= b2 else None

        fmt = (lambda d: fmt_date(d)) if cc.typ == DATE else (lambda x: fmt_ru(x))
        labels_ab = (f"{fmt(a1)}-{fmt(a2)}", f"{fmt(b1)}-{fmt(b2)}")
        before = len(selected)
        per = [period_of(i) for i in selected]
        cnt = (per.count(0), per.count(1))
        selected = [i for i, p in zip(selected, per) if p is not None]
        notes.append(f"Периоды: A {labels_ab[0]} (строк {fmt_ru(cnt[0])}), B {labels_ab[1]} (строк {fmt_ru(cnt[1])}).")
        if not selected:
            rng_note = ""
            present = [v for v in cmp_keys if v is not None]
            if present:
                rng_note = f" В «{cc.name}» данные с {fmt(min(present))} по {fmt(max(present))}."
            raise Stop(f"В периодах сравнения строк нет (после отбора было {fmt_ru(before)}).{rng_note}")
        for side, n in zip("AB", cnt):
            if not n:
                notes.append(f"В периоде {side} строк нет: его значения пустые или 0.")

    # группировка
    gspec = as_list(spec.get("group_by"))
    if len(gspec) > MAX_GROUP_BY:
        raise Stop(f"Группировать можно не больше чем по {MAX_GROUP_BY} столбцам, а в запросе {len(gspec)}.")
    groups = []  # (Column, period, имя в ответе, тип в ответе)
    for g in gspec:
        period = None
        if isinstance(g, dict):
            period = g.get("period")
            g = g.get("col")
        c = col(g, "Группировка (group_by)")
        if period:
            if period not in PERIODS:
                raise Stop(f"Группировка по «{c.name}»: период «{period}» не знаю. Есть: " + ", ".join(PERIODS) + ".")
            if c.typ != DATE:
                raise Stop(f"Группировка по «{c.name}» с периодом: нужен столбец дат.")
            if period == "day":
                period = None
        out_name = f"{c.name} ({PERIODS[period]})" if period else c.name
        out_type = c.typ if not period else (DATE if period == "week" else PERIOD)
        groups.append((c, period, out_name, out_type))

    # меры
    mspec = as_list(spec.get("measures")) or [{"agg": "count", "as": "Строк"}]
    measures = []  # (Column или None, agg, as)
    for k, m in enumerate(mspec, 1):
        if not isinstance(m, dict):
            raise Stop(f"Мера {k}: нужен объект {{\"col\": ..., \"agg\": \"sum\", \"as\": ...}}.")
        agg = str(m.get("agg", "sum")).strip().lower()
        if agg not in AGGS:
            raise Stop(f"Мера {k}: «{agg}» не знаю. Есть: " + " ".join(AGGS) + ".")
        c = None
        if m.get("col") not in (None, "", "*"):
            c = col(m.get("col"), f"Мера {k}")
        elif agg != "count":
            raise Stop(f"Мера {k}: для «{agg}» нужен столбец (col).")
        if agg in ("sum", "avg") and c.typ != NUM:
            raise Stop(f"Мера {k}: «{agg}» считается по числам, а «{c.name}» {KIND[c.typ]}. "
                       "Для текста подойдут count и count_distinct.")
        if agg in ("min", "max") and c.typ == TEXT:
            raise Stop(f"Мера {k}: «{agg}» считается по числам и датам, а «{c.name}» текстовый столбец.")
        name = m.get("as") or (AGG_NAMES[agg].format(c=c.name) if c else "Строк")
        measures.append((c, agg, str(name)))

    # проход по строкам
    nper = 2 if cmp else 1
    table = {}
    total = [[Acc(agg) for _, agg, _ in measures] for _ in range(nper)]
    first_label = {}
    gk = [(c.keys, c.vals, period) for c, period, _, _ in groups]
    mv = [(c.keys if (c is not None and agg == "count_distinct") else c.vals if c is not None else None, c)
          for c, agg, _ in measures]
    bad = [0] * len(measures)
    for i in selected:
        p = period_of(i) if cmp else 0
        key = []
        for keys, vals, period in gk:
            key.append(period_key(vals[i], period) if period else keys[i])
        key = tuple(key)
        accs = table.get(key)
        if accs is None:
            accs = table[key] = [[Acc(agg) for _, agg, _ in measures] for _ in range(nper)]
            first_label[key] = tuple(vals[i] for _, vals, _ in gk)
        for j, (vals, c) in enumerate(mv):
            if vals is None:
                v = 1
            else:
                v = vals[i]
                if v is None and c.is_bad(i):
                    bad[j] += 1
            if measures[j][1] == "count" and c is not None:
                v = None if is_empty(c.raw[i]) else 1
            accs[p][j].add(v)
            total[p][j].add(v)
    for j, n in enumerate(bad):
        c, agg, _ = measures[j]
        if n and agg not in ("count", "count_distinct"):
            kind = "не число" if c.typ == NUM else "не дата"
            note = f"Пропущено {fmt_ru(n)} строк: {kind} в «{c.name}»."
            if note not in notes:
                notes.append(note)

    # столбцы ответа
    columns = [name for _, _, name, _ in groups]
    types = [typ for _, _, _, typ in groups]
    value_cols = []  # (имя, тип, функция от накопителей)

    def mtype(c, agg):
        return c.typ if agg in ("min", "max") and c is not None and c.typ == DATE else NUM

    single = len(measures) == 1
    for j, (c, agg, name) in enumerate(measures):
        if not cmp:
            value_cols.append((name, mtype(c, agg), lambda a, j=j: a[0][j].value()))
            continue
        value_cols.append((f"{name} A", mtype(c, agg), lambda a, j=j: a[0][j].value()))
        value_cols.append((f"{name} B", mtype(c, agg), lambda a, j=j: a[1][j].value()))
        if mtype(c, agg) == NUM:
            dn = "Изменение" if single else f"Изменение {name}"
            value_cols.append((dn, NUM, lambda a, j=j: change(a[0][j].value(), a[1][j].value())))
            value_cols.append((dn + ", %", NUM, lambda a, j=j: change_pct(a[0][j].value(), a[1][j].value())))
    columns += [n for n, _, _ in value_cols]
    types += [typ for _, typ, _ in value_cols]
    if len({norm(c) for c in columns}) != len(columns):
        raise Stop("Названия столбцов ответа повторяются: задайте мерам разные «as», не как у столбцов группировки. "
                   "Столбцы ответа: " + ", ".join(columns) + ".")

    out_rows = []
    for key, accs in table.items():
        row = []
        for (c, period, _, typ), lab, k in zip(groups, first_label[key], key):
            if period:
                row.append(period_label(k, period))
            elif lab is None:
                row.append(EMPTY_LABEL if typ == TEXT else None)
            else:
                row.append(lab)
        row += [fn(accs) for _, _, fn in value_cols]
        out_rows.append(row)

    # сортировка
    srt = spec.get("sort")
    if isinstance(srt, list):
        srt = srt[0] if srt else None
    if isinstance(srt, str):
        srt = {"by": srt}
    if srt and srt.get("by"):
        si = find_col(columns, srt["by"], "Сортировка (sort)", notes)
        desc = bool(srt.get("desc", False))
    elif groups and groups[0][3] in (DATE, PERIOD):
        si, desc = 0, False
    elif cmp and any(n.startswith("Изменение") for n in columns):
        si, desc = next(k for k, n in enumerate(columns) if n.startswith("Изменение")), False
    elif groups:
        si, desc = len(groups), True
    else:
        si, desc = None, False
    if si is not None:
        keyed = [(r[si] is None, r) for r in out_rows]
        present = [r for missing, r in keyed if not missing]
        missing = [r for m, r in keyed if m]
        if si < len(groups) and groups[si][1]:  # период: по ключу, не по подписи
            order = {period_label(k[si], groups[si][1]): k[si] for k in table}
            present.sort(key=lambda r: order.get(r[si]), reverse=desc)
        else:
            present.sort(key=lambda r: norm(r[si]) if isinstance(r[si], str) else r[si], reverse=desc)
        out_rows = present + missing

    total_rows = len(out_rows)
    rows_json = [[json_value(v, typ) for v, typ in zip(r, types)] for r in out_rows]
    limit = spec.get("limit")
    if limit is None or limit == "":
        limit = MAX_LIMIT
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise Stop(f"«limit» должен быть числом строк, а пришло «{limit}».")
    if limit < 1:
        raise Stop("«limit» должен быть больше нуля.")
    if limit > MAX_LIMIT:
        notes.append(f"Ответ ограничен {MAX_LIMIT} строками.")
        limit = MAX_LIMIT
    if total_rows > limit:
        notes.append(f"Показаны первые {limit} строк ответа из {fmt_ru(total_rows)}.")

    totals = {}
    for (name, typ, fn) in value_cols:
        totals[name] = json_value(fn(total), typ)
    if spec.get("note"):
        notes.insert(0, "Допущение: " + no_dash(label(spec["note"])))

    result = {
        "question": label(spec.get("question") or ""),
        "spec": spec,
        "table": t.file,
        "sheet": t.sheet,
        "columns": columns,
        "column_types": types,
        "group_columns": len(groups),
        "rows": rows_json,
        "total_rows": total_rows,
        "totals": totals,
        "periods": {"A": labels_ab[0], "B": labels_ab[1]} if labels_ab else None,
        "notes": notes,
    }
    result["summary"] = summarize(result, measures, single)
    result["rows"] = rows_json[:limit]
    return result


class _LazyCol:
    """Столбец таблицы, тип которого определяется при первом обращении."""
    __slots__ = ("t", "i")

    def __init__(self, t, i):
        self.t, self.i = t, i

    def get(self):
        return self.t.column(self.i)


def change(a, b):
    if a is None or b is None:
        return None
    return b - a


def change_pct(a, b):
    if a is None or b is None or a == 0:
        return None
    return round((b - a) / abs(a) * 100, 1)


def empty_message(t, tests, described):
    msg = f"По запросу строк не нашлось: отбор ({'; '.join(described)}) оставил 0 строк из {fmt_ru(t.n)}."
    for c, op, value, _ in tests:
        if c.typ == TEXT and op in ("=", "in"):
            have = {norm(v) for v in c.vals if v is not None}
            wanted = as_list(value)
            if any(norm(w) not in have for w in wanted):
                labels = sorted({v for v in c.vals if v is not None}, key=norm)
                if len({norm(v) for v in labels}) <= MAX_VALUES:
                    msg += f" В «{c.name}» есть значения: " + ", ".join(dict.fromkeys(labels)) + "."
                else:
                    msg += f" Значений «{c.name}» больше {MAX_VALUES}, не перечисляю."
        if c.typ in (NUM, DATE):
            present = [v for v in c.vals if v is not None]
            if present:
                f = fmt_date if c.typ == DATE else fmt_ru
                msg += f" В «{c.name}» значения с {f(min(present))} по {f(max(present))}."
    return msg


def summarize(r, measures, single):
    """Одна строка итога по ответу."""
    cols, rows, totals, g = r["columns"], r["rows"], r["totals"], r["group_columns"]
    if not measures:
        return ""
    name = measures[0][2]
    def lab(row):
        return " / ".join(fmt_cell(v) for v in row[:g])

    if r["periods"]:
        a, b = totals.get(f"{name} A"), totals.get(f"{name} B")
        dn = "Изменение" if single else f"Изменение {name}"
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            text = (f"{name}: A ({r['periods']['A']}) {fmt_ru(a)}, B ({r['periods']['B']}) {fmt_ru(b)}, "
                    f"изменение {fmt_ru(b - a)} ({fmt_pct(change_pct(a, b))}).")
        else:
            text = f"{name}: A ({r['periods']['A']}), B ({r['periods']['B']})."
        if g and dn + ", %" in cols:
            pi = cols.index(dn + ", %")
            withp = [row for row in rows if row[pi] is not None]
            if withp:
                lo = min(withp, key=lambda row: row[pi])
                hi = max(withp, key=lambda row: row[pi])
                if lo[pi] < 0:
                    text += f" Сильнее всего упало: {lab(lo)} ({fmt_pct(lo[pi])})."
                if hi[pi] > 0:
                    text += f" Больше всего выросло: {lab(hi)} ({fmt_pct(hi[pi])})."
        return text
    total = totals.get(name)
    tv = fmt_cell(total)
    if not g:
        return f"{name}: {tv}."
    mi = cols.index(name)
    withv = [row for row in rows if isinstance(row[mi], (int, float))]
    text = f"Групп: {fmt_ru(r['total_rows'])} по «{' / '.join(cols[:g])}»; {name} всего {tv}."
    if withv and measures[0][1] in ("sum", "count", "count_distinct", "avg", "max", "min"):
        top = max(withv, key=lambda row: row[mi])
        text += f" Больше всего: {lab(top)} ({fmt_ru(top[mi])})."
    return text


def fmt_cell(v):
    if v is None:
        return "нет данных"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return fmt_ru(v)
    if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", v):
        return fmt_date(date.fromisoformat(v))
    return str(v)


# ---------- история ----------

@contextlib.contextmanager
def history_lock(out):
    lock = out / ".history.lock"
    deadline = time.time() + 15
    while True:
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            break
        except OSError:
            try:
                if time.time() - lock.stat().st_mtime > 60:
                    lock.unlink()
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                raise Stop("История ответов занята другим расчётом: повторите через минуту.")
            time.sleep(0.1)
    try:
        yield
    finally:
        try:
            lock.unlink()
        except OSError:
            pass


def read_history(out):
    path = out / "history.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        broken = out / f"history.broken-{datetime.now():%Y%m%d-%H%M%S}.json"
        try:
            path.replace(broken)
        except OSError:
            pass
        return []
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


def write_atomic(path, data):
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(data, encoding="utf-8")
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows: файл читает другая программа
            time.sleep(0.1)
    try:
        tmp.unlink()
    except OSError:
        pass
    raise Stop(f"Не удалось записать {path.name}: файл занят другой программой. Повторите через минуту.")


def new_id(existing):
    now = datetime.now()
    base = f"q-{now:%Y%m%d-%H%M%S}"
    qid, n = base, 1
    while qid in existing:
        n += 1
        qid = f"{base}-{n}"
    return qid


def save(root, result, source, demo=False):
    out = output_dir(root)
    with history_lock(out):
        items = read_history(out)
        if demo:
            items = [e for e in items if not e.get("demo")]
        entry = {"id": new_id({e.get("id") for e in items}), "time": datetime.now().isoformat(timespec="seconds"),
                 "source": source, **result}
        if demo:
            entry["demo"] = True
        items.insert(0, entry)
        write_atomic(out / "history.json", json.dumps(items[:HISTORY_MAX], ensure_ascii=False, indent=1))
    return entry


def for_chat(entry):
    """Ответ для stdout (разговор, модель): не больше 30 строк."""
    e = dict(entry)
    rows = e["rows"][:SHOWN]
    e["rows"] = rows
    e["rows_shown"] = len(rows)
    e["rows_in_history"] = len(entry["rows"])
    return e


def text_answer(e):
    out = []
    if e.get("question"):
        out.append(f"Вопрос: {e['question']}")
    out.append(e.get("summary", ""))
    out.append(" | ".join(e["columns"]))
    for r in e["rows"]:
        out.append(" | ".join(fmt_cell(v) for v in r))
    if e["rows_in_history"] < e["total_rows"] or e["rows_shown"] < e["rows_in_history"]:
        out.append(f"... строк в ответе {e['total_rows']}, на странице «Аналитика таблиц» до {MAX_LIMIT}.")
    for n in e["notes"]:
        out.append(f"Заметка: {n}")
    out.append(f"Ответ {e['id']} записан в историю.")
    return "\n".join(out)


# ---------- Excel ----------

def make_excel(root, qid):
    if not isinstance(qid, str) or not ID_RE.match(qid):
        raise Stop(f"«{qid}» не похоже на номер ответа (вида q-20261029-223015).")
    out = output_dir(root)
    entry = next((e for e in read_history(out) if e.get("id") == qid), None)
    if entry is None:
        raise Stop(f"Ответа {qid} нет в истории.")
    import openpyxl
    from openpyxl.chart import BarChart, LineChart, Reference
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    cols, types, rows = entry["columns"], entry.get("column_types") or [], entry["rows"]
    g = entry.get("group_columns", 0)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Ответ"
    ws["A1"] = entry.get("question") or "Ответ"
    ws["A1"].font = Font(bold=True, size=13)
    ws["A2"] = entry.get("summary", "")
    ws["A2"].alignment = Alignment(wrap_text=False)
    head = 4
    fill = PatternFill("solid", fgColor="DDE7F0")
    for j, name in enumerate(cols, 1):
        cell = ws.cell(head, j, name)
        cell.font = Font(bold=True)
        cell.fill = fill
        cell.alignment = Alignment(wrap_text=True, vertical="top")
    for i, r in enumerate(rows, head + 1):
        for j, (v, typ) in enumerate(zip(r, types + [None] * len(r)), 1):
            cell = ws.cell(i, j)
            if typ == DATE and isinstance(v, str):
                try:
                    cell.value = date.fromisoformat(v)
                    cell.number_format = "DD.MM.YYYY"
                    continue
                except ValueError:
                    pass
            cell.value = v
            if isinstance(v, float):
                cell.number_format = "0.0" if cols[j - 1].endswith(", %") else "#,##0.00"
            elif isinstance(v, int):
                cell.number_format = "#,##0"
    last = head + len(rows)
    totals = entry.get("totals") or {}
    if g and rows and totals:
        tr = last + 1
        ws.cell(tr, 1, "Итого").font = Font(bold=True)
        for j, name in enumerate(cols, 1):
            if j > g and totals.get(name) is not None:
                v = totals[name]
                c = ws.cell(tr, j, v)
                c.font = Font(bold=True)
                if isinstance(v, (int, float)):
                    c.number_format = "0.0" if name.endswith(", %") else "#,##0.00" if isinstance(v, float) else "#,##0"
    for j, name in enumerate(cols, 1):
        width = max([len(str(name))] + [len(fmt_cell(r[j - 1])) for r in rows[:200]]) + 2
        ws.column_dimensions[get_column_letter(j)].width = min(max(width, 10), 40)
    ws.freeze_panes = ws.cell(head + 1, 1)

    # график: категории из столбцов группировки, ряды из числовых столбцов (без изменения при сравнении)
    series = [j for j, (name, typ) in enumerate(zip(cols, types), 1)
              if j > g and typ == NUM and not name.startswith("Изменение") and not name.endswith(", %")]
    if rows and series:
        is_line = bool(g) and types[0] in (DATE, PERIOD)
        chart = LineChart() if is_line else BarChart()
        if not is_line:
            chart.type = "col"
            chart.grouping = "clustered"
        chart.title = (entry.get("question") or "Ответ")[:90]
        chart.height, chart.width = 9, max(16, min(32, 2 + len(rows) * 0.9))
        for j in series[:6]:
            chart.add_data(Reference(ws, min_col=j, max_col=j, min_row=head, max_row=last), titles_from_data=True)
        if g:
            chart.set_categories(Reference(ws, min_col=1, max_col=g, min_row=head + 1, max_row=last))
        chart.x_axis.delete = False
        chart.y_axis.delete = False
        if is_line and types[0] == DATE:
            chart.x_axis.number_format = "DD.MM.YYYY"
        chart.legend.position = "b"
        ws.add_chart(chart, ws.cell(last + 4, 1).coordinate)

    path = out / f"{qid}.xlsx"
    tmp = out / f".{qid}.{os.getpid()}.tmp.xlsx"
    try:
        wb.save(tmp)
        os.replace(tmp, path)
    except PermissionError:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise Stop(f"Файл {qid}.xlsx открыт в Excel: закройте его и нажмите «Скачать Excel» ещё раз.")
    return {"id": qid, "file": f"output/analiz/{qid}.xlsx", "path": str(path),
            "chart": "линия" if (rows and series and bool(g) and types[0] in (DATE, PERIOD)) else
            "столбики" if rows and series else "нет"}


# ---------- вопрос словами ----------

PROMPT = """Ты помогаешь программе «Аналитика таблиц». Человек задал вопрос о своих таблицах. Переведи его в запрос JSON, по которому программа сама посчитает ответ на компьютере человека.
Ты видишь только паспорт данных: файлы, листы, столбцы, их типы, диапазоны и значения коротких справочников. Строк таблиц ты не видишь и ничего не выдумываешь.

Ответь одним объектом JSON, без пояснений вокруг. Поля запроса:
- "table": имя файла точно как в паспорте; "sheet": имя листа из паспорта или null.
- "filters": список отборов {"col": столбец, "op": оператор, "value": значение}. Операторы: = != > < >= <= in not_in contains between. Для in и not_in значение списком, для between список [от, до] включительно. Даты пиши как ГГГГ-ММ-ДД. Текст сравнивается без учёта регистра.
- "group_by": до трёх столбцов. Для столбца дат можно {"col": столбец, "period": "week"} (периоды day, week, month, quarter, year).
- "measures": список мер {"col": столбец, "agg": функция, "as": название в ответе}. Функции: sum avg count count_distinct min max. sum и avg только по числовым столбцам. count без col считает строки.
- "compare": null или сравнение двух периодов {"col": столбец дат, "a": [от, до], "b": [от, до]}, A более ранний. Тогда для меры в ответе столбцы «<as> A», «<as> B», «Изменение», «Изменение, %» (при нескольких мерах «Изменение <as>» и «Изменение <as>, %»).
- "join": null или {"table": вторая таблица, "sheet": null, "on": [["столбец слева", "столбец справа"]], "cols": [столбцы второй таблицы]}: левое соединение до отборов.
- "sort": {"by": название столбца ответа, "desc": true или false}; "limit": число строк ответа, до 200.
- "note": одна короткая фраза по-русски о допущениях: какие периоды и отборы ты выбрал и почему.

Правила:
- Названия столбцов и таблиц бери точно из паспорта. Нужного столбца нет: не подставляй похожий по смыслу без пометки в note.
- «Последняя неделя», «прошлый месяц» и подобное отсчитывай от последней даты в данных (поле last в паспорте), если в вопросе нет своей даты. Неделя: с понедельника по воскресенье.
- Если в справочнике есть значения вроде «Возврат», «Сторно», «Отмена», реши, нужен ли отбор для вопроса, и напиши об этом в note.
- Если для ответа нужно читать смысл текста в строках (комментарии, жалобы, описания), ответь {"need_rows": true, "why": "коротко почему"}. Итоги по людям (ФИО, сотрудники, клиенты) считай обычным запросом.
- Если по этим таблицам ответить нельзя (нет нужных данных), ответь {"cannot": true, "why": "чего не хватает"}.
- В текстах не используй длинное и среднее тире, только дефис."""


def parse_model_json(text):
    t = (text or "").strip()
    t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
    t = re.sub(r"\s*```\s*$", "", t)
    dec = json.JSONDecoder()
    for m in re.finditer(r"\{", t):
        try:
            obj, _ = dec.raw_decode(t, m.start())
        except ValueError:
            continue
        if isinstance(obj, dict):
            return obj
    raise Stop("Модель ответила не запросом JSON. Попробуйте задать вопрос по-другому.")


def call_model(question, payload):
    if llm is None or not hasattr(llm, "ask"):
        raise Stop(unavailable_msg(question), 3, llm_unavailable=True, reason="нет tools/llm.py",
                   phrase=f"проанализируй таблицу: {question}")
    try:
        return llm.ask(PROMPT, payload, model=MODEL)
    except Exception as e:
        kind = type(e).__name__
        reason = " ".join(str(e).split())
        if kind == "LLMBlocked":
            raise Stop(f"Вопрос не отправлен в модель: {reason}", 4, blocked=True)
        if kind == "LLMUnavailable":
            raise Stop(unavailable_msg(question), 3, llm_unavailable=True, reason=reason,
                       phrase=f"проанализируй таблицу: {question}")
        raise Stop(unavailable_msg(question), 3, llm_unavailable=True, reason=f"{kind}: {reason}",
                   phrase=f"проанализируй таблицу: {question}")


def unavailable_msg(question):
    return ("На этом компьютере Claude для страницы недоступен. Задайте вопрос Claude во вкладке Code: "
            f"«проанализируй таблицу: {question}»")


def ask(root, question):
    question = label(question or "")
    if not question:
        raise Stop("Вопрос пустой: напишите, что посчитать по таблицам.")
    p = passport(root)
    if not any(s.get("columns") for f in p["files"] for s in f["sheets"]):
        raise Stop("В папке input/analiz нет таблиц: положите туда файлы Excel (.xlsx) или CSV и спросите снова.")
    base = f"Паспорт данных: {passport_for_model(p)}\n\nВопрос человека: {question}"
    payload, last_error = base, None
    for attempt in range(2):
        spec = parse_model_json(call_model(question, payload))
        if spec.get("need_rows"):
            why = no_dash(label(spec.get("why") or "нужно читать строки")).rstrip(". ")
            raise Stop(f"Для этого вопроса нужно читать текст строк ({why}): задайте его Claude во вкладке Code: "
                       f"«проанализируй таблицу: {question}».", 5, need_rows=True, why=why,
                       phrase=f"проанализируй таблицу: {question}")
        if spec.get("cannot"):
            raise Stop("По этим таблицам ответить нельзя: "
                       + no_dash(label(spec.get("why") or "нет нужных данных")).rstrip(". ") + ".",
                       cannot=True)
        spec["question"] = question
        try:
            result = execute(root, spec)
            return save(root, result, "ask")
        except Stop as e:
            if e.code != 2 or attempt:
                raise
            last_error = str(e)
            payload = (f"{base}\n\nТвой прошлый запрос: {json.dumps(spec, ensure_ascii=False)}\n"
                       f"Программа ответила ошибкой: {last_error}\nИсправь запрос.")
    raise Stop(last_error or "Не удалось посчитать ответ.")


# ---------- пример ----------

def demo(root):
    src = root.joinpath(*DEMO_SOURCE)
    spec_path = root.joinpath(*DEMO_SPEC)
    if not src.is_file() or not spec_path.is_file():
        raise Stop("Нет файлов примера (учебной выгрузки или готового запроса): скажите Claude «обнови кабинет».")
    spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
    base = root / "input" / "analiz"
    base.mkdir(parents=True, exist_ok=True)
    data = src.read_bytes()
    name = None
    files, _ = list_files(base.resolve())
    for rel, p in files:
        if p.stat().st_size == len(data) and p.read_bytes() == data:
            name = rel
            break
    if name is None:
        stem, ext = src.stem, src.suffix
        candidates = [src.name] + [f"{stem} (пример{'' if k == 1 else ' ' + str(k)}){ext}" for k in range(1, 50)]
        for cand in candidates:
            try:
                with open(base / cand, "xb") as f:  # только новый файл: чужой не перезаписывается
                    f.write(data)
                name = cand
                break
            except FileExistsError:
                continue
        if name is None:
            raise Stop("Не удалось положить пример в input/analiz: имена заняты.")
    spec["table"] = name
    result = execute(root, spec)
    entry = save(root, result, "demo", demo=True)
    return entry, name


# ---------- вход ----------

class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Stop("Не понял команду. Так: python tools/analiz.py passport | run <запрос.json> | "
                   "ask \"вопрос\" | excel <id> | history | demo")


def load_spec(arg):
    if arg == "-":
        text = sys.stdin.buffer.read().decode("utf-8-sig")
    elif arg.lstrip().startswith("{"):
        text = arg
    else:
        p = Path(arg)
        if not p.is_absolute() and not p.exists():
            p = ROOT / p
        if not p.is_file():
            raise Stop(f"Файл запроса не найден: {arg}")
        text = p.read_text(encoding="utf-8-sig")
    try:
        return json.loads(text)
    except ValueError as e:
        raise Stop(f"Запрос не читается как JSON: {e.msg}, строка {e.lineno}, знак {e.colno}.")


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=1))


def main(argv=None, root=None):
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    root = Path(root) if root else ROOT
    ap = Parser(prog="analiz.py", description="Проанализируй таблицу: ответы по таблицам из input/analiz.")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("passport")
    p.add_argument("--dir")
    p.add_argument("--text", action="store_true")
    p = sub.add_parser("run")
    p.add_argument("spec")
    p.add_argument("--text", action="store_true")
    p = sub.add_parser("ask")
    p.add_argument("question", nargs="+")
    p.add_argument("--text", action="store_true")
    p = sub.add_parser("excel")
    p.add_argument("id")
    p = sub.add_parser("history")
    p.add_argument("--limit", type=int, default=50)
    sub.add_parser("demo")
    try:
        a = ap.parse_args(argv)
        if a.cmd == "passport":
            pp = passport(root, a.dir)
            print(passport_text(pp) if a.text else json.dumps(pp, ensure_ascii=False, indent=1))
        elif a.cmd == "run":
            spec = load_spec(a.spec)
            e = for_chat(save(root, execute(root, spec), "run"))
            print(text_answer(e)) if a.text else emit(e)
        elif a.cmd == "ask":
            q = " ".join(a.question)
            if q == "-":
                q = sys.stdin.buffer.read().decode("utf-8-sig")
            e = for_chat(ask(root, q))
            print(text_answer(e)) if a.text else emit(e)
        elif a.cmd == "excel":
            emit(make_excel(root, a.id))
        elif a.cmd == "history":
            emit(read_history(output_dir(root))[:max(0, a.limit)])
        elif a.cmd == "demo":
            e, name = demo(root)
            print("Готово: пример ответа на странице «Аналитика таблиц».")
            print(e["summary"])
        else:
            raise Stop("Не понял команду. Так: python tools/analiz.py passport | run <запрос.json> | "
                       "ask \"вопрос\" | excel <id> | history | demo")
        return 0
    except rt.UserError as e:
        code = getattr(e, "code", 2)
        msg = " ".join(str(e).split())
        print(msg, file=sys.stderr)
        print(json.dumps({"error": msg, "code": code, **getattr(e, "extra", {})}, ensure_ascii=False))
        return code
    except Exception as e:  # без трейсбека для человека
        msg = f"Не удалось посчитать: {type(e).__name__}: {' '.join(str(e).split())}"
        print(msg, file=sys.stderr)
        print(json.dumps({"error": msg, "code": 2}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
