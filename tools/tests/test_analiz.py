"""Тесты tools/analiz.py («Аналитика таблиц»): паспорт, отборы, группировка, меры, сравнение периодов, соединение,
ошибки, история, Excel с графиком, вопрос словами с подменённой моделью, пример (demo).

Кабинет для тестов собирается во временной папке с кириллицей и пробелом в пути («Айгуль Н/ai-cabinet»).
Модель подменяется файлом tools/llm.py в этом кабинете: настоящий Claude в тестах не зовётся.

Запуск: python -m unittest discover -s tools/tests -p "test_*.py"
"""

import csv
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import date
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
ROOT = TOOLS.parent
CASE = ROOT / "input" / "case" / "data"
SALES = CASE / "prodazhi_1c.csv"
YEAR = CASE / "prodazhi_1c_god.csv"
DEMO_SPEC = ROOT / "templates" / "analiz" / "demo-zapros.json"

try:
    import openpyxl
    HAVE_OPENPYXL = True
except ImportError:
    HAVE_OPENPYXL = False


def load_module():
    spec = importlib.util.spec_from_file_location("analiz_under_test", TOOLS / "analiz.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


A = load_module()

# Подмена tools/llm.py: проверка ловит «Иванов», «Петров» и 12 цифр подряд; ответы модели из FAKE_LLM_ANSWERS
# по очереди, вызовы пишутся в FAKE_LLM_LOG.
FAKE_LLM = r'''
import json, os, re

class LLMBlocked(Exception):
    pass

class LLMUnavailable(Exception):
    pass

def check(text):
    found = []
    if re.search(r"Тестов|Примеров|Выдумкин", text):
        found.append("ФИО: 1")
    if re.search(r"(?<!\d)\d{12}(?!\d)", text):
        found.append("ИИН или БИН: 1")
    return found

def ask(prompt, payload="", model="sonnet"):
    log = os.environ.get("FAKE_LLM_LOG")
    calls = []
    if log and os.path.exists(log):
        with open(log, encoding="utf-8") as f:
            calls = json.load(f)
    calls.append({"prompt": prompt, "payload": payload, "model": model})
    if log:
        with open(log, "w", encoding="utf-8") as f:
            json.dump(calls, f, ensure_ascii=False)
    mode = os.environ.get("FAKE_LLM", "")
    if mode == "unavailable":
        raise LLMUnavailable("claude не найден")
    if mode == "blocked":
        found = check(payload)
        raise LLMBlocked("в модель ушли бы персональные данные: " + "; ".join(found or ["ФИО: 1"]))
    answers = json.loads(os.environ.get("FAKE_LLM_ANSWERS", "[]"))
    return answers[min(len(calls), len(answers)) - 1] if answers else ""
'''

SMALL = """Дата;Город;Товар;Кол-во;Цена
01.09.2026;Астана;Золото 585;10;245
02.09.2026;Астана;Серебро 925;20,5;298
2026-09-03;Караганда;Платина;30;312
04.09.2026;Караганда;Золото 585;;245
05.09.2026;Павлодар;Газ;1 000;115
06.09.2026;павлодар ;Золото 585;;245
"""


class Cab:
    """Кабинет во временной папке: tools (с подменённой моделью или настоящей), шаблон примера, input/analiz."""

    def __init__(self, fake_llm=True, case_files=(SALES,)):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "Айгуль Н" / "ai-cabinet"
        shutil.copytree(TOOLS, self.root / "tools", ignore=shutil.ignore_patterns("tests", "__pycache__"))
        if fake_llm:
            (self.root / "tools" / "llm.py").write_text(FAKE_LLM, encoding="utf-8")
        (self.root / "templates" / "analiz").mkdir(parents=True)
        shutil.copy(DEMO_SPEC, self.root / "templates" / "analiz" / DEMO_SPEC.name)
        case = self.root / "input" / "case" / "data"
        case.mkdir(parents=True)
        for f in case_files:
            shutil.copy(f, case / f.name)
        self.inp = self.root / "input" / "analiz"
        self.inp.mkdir(parents=True)
        self.out = self.root / "output" / "analiz"
        self.log = Path(self.tmp.name) / "llm-log.json"

    def close(self):
        self.tmp.cleanup()

    def put(self, name, text=None, src=None, encoding="utf-8"):
        p = self.inp / name
        p.parent.mkdir(parents=True, exist_ok=True)
        if src is not None:
            shutil.copy(src, p)
        else:
            p.write_text(text, encoding=encoding)
        return p

    def run(self, *args, stdin=None, answers=None, mode=None):
        env = dict(os.environ, PYTHONIOENCODING="utf-8", FAKE_LLM_LOG=str(self.log))
        env.pop("FAKE_LLM", None)
        if answers is not None:
            env["FAKE_LLM_ANSWERS"] = json.dumps(answers, ensure_ascii=False)
        if mode:
            env["FAKE_LLM"] = mode
        p = subprocess.run([sys.executable, "-X", "utf8", str(self.root / "tools" / "analiz.py"), *map(str, args)],
                           cwd=str(self.root), capture_output=True, encoding="utf-8", input=stdin, env=env)
        return p.returncode, p.stdout, p.stderr

    def ok(self, *args, **kw):
        code, out, err = self.run(*args, **kw)
        if code != 0:
            raise AssertionError(f"код {code}: {out}\n{err}")
        return json.loads(out)

    def fail(self, code_expected, *args, **kw):
        code, out, err = self.run(*args, **kw)
        if code != code_expected:
            raise AssertionError(f"ждали код {code_expected}, пришёл {code}: {out}\n{err}")
        lines = [ln for ln in err.splitlines() if ln.strip()]
        assert len(lines) == 1, f"ошибка должна быть одной строкой: {err!r}"
        assert "Traceback" not in err + out
        return lines[0], json.loads(out)

    def spec_file(self, spec):
        p = Path(self.tmp.name) / f"zapros-{time.time_ns()}.json"
        p.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
        return p

    def history(self):
        return json.loads((self.out / "history.json").read_text(encoding="utf-8"))

    def calls(self):
        return json.loads(self.log.read_text(encoding="utf-8")) if self.log.exists() else []


def sales_independent(path):
    """Независимый подсчёт по учебной выгрузке: выручка продаж по точкам за две недели (сумма «н/д» не число)."""
    text = path.read_bytes().decode("cp1251")
    rows = list(csv.reader(io.StringIO(text), delimiter=";"))
    head = next(i for i, r in enumerate(rows) if r and r[0] == "Дата")
    cols = rows[head]
    di, ai, oi, qi = (cols.index(n) for n in ("Дата", "Точка", "Операция", "Сумма, тг"))
    weeks = {}
    for r in rows[head + 1:]:
        if len(r) <= qi or r[oi] != "Продажа":
            continue
        d, m, y = (int(x) for x in r[di].split("."))
        day = date(y, m, d)
        w = 0 if date(2026, 10, 26) <= day <= date(2026, 11, 1) else 1 if date(2026, 11, 2) <= day <= date(2026, 11, 8) else None
        if w is None:
            continue
        try:
            q = float(r[qi].replace("\u00a0", "").replace(" ", "").replace(",", "."))
        except ValueError:
            continue
        weeks.setdefault(r[ai].strip(), [0.0, 0.0])[w] += q
    return weeks


# ---------- разбор чисел и дат ----------

class Parsing(unittest.TestCase):
    def test_numbers(self):
        cases = {"1 234,5": 1234.5, "1\u00a0234,50": 1234.5, "1.234,56": 1234.56, "1,234.56": 1234.56,
                 "1,234,567": 1234567.0, "-40": -40.0, "15%": 15.0, "0": 0.0, "20,5": 20.5}
        for text, want in cases.items():
            self.assertEqual(A.parse_number(text), want, text)
        for text in ("abc", "07.09.2026", "", "1e5", "Золото 585"):
            self.assertIsNone(A.parse_number(text), text)

    def test_dates(self):
        cases = {"07.09.2026": date(2026, 9, 7), "2026-09-07": date(2026, 9, 7), "7/9/2026": date(2026, 9, 7),
                 "2026-09-07 10:30:00": date(2026, 9, 7), "14.10.26": date(2026, 10, 14),
                 "14.09.2026 0:00:00": date(2026, 9, 14)}
        for text, want in cases.items():
            self.assertEqual(A.parse_date(text), want, text)
        for text in ("31.02.2026", "бессрочно", "до 31.12.2026", "46272"):
            self.assertIsNone(A.parse_date(text), text)

    def test_column_types(self):
        self.assertEqual(A.profile("Дата", ["07.09.2026", "2026-09-08", ""]).typ, A.DATE)
        self.assertEqual(A.profile("Сумма", ["1 234,5", "10", "-3"]).typ, A.NUM)
        self.assertEqual(A.profile("Точка", ["Точка-01", "Точка-02"]).typ, A.TEXT)
        excel = A.profile("Дата отгрузки", ["46272", "46273"])  # даты Excel числами
        self.assertEqual(excel.typ, A.DATE)
        self.assertEqual(excel.vals[0], date(2026, 9, 7))
        self.assertEqual(A.profile("Количество", ["46272", "46273"]).typ, A.NUM)

    def test_no_dash_in_texts(self):
        self.assertEqual(A.no_dash("неделя \u2014 к прошлой"), "неделя - к прошлой")
        src = (TOOLS / "analiz.py").read_text(encoding="utf-8")
        for ch in "\u2012\u2013\u2014\u2015":
            self.assertNotIn(ch, src, f"в analiz.py есть тире U+{ord(ch):04X}")


# ---------- паспорт ----------

class Passport(unittest.TestCase):
    def setUp(self):
        self.c = Cab()
        self.addCleanup(self.c.close)

    def test_types_ranges_values_and_hidden(self):
        lines = ["Дата;Отдел;Сотрудник;Комментарий;Сумма;Код"]
        for i in range(40):
            day = f"{i % 28 + 1:02d}.09.2026" if i % 2 else f"2026-09-{i % 28 + 1:02d}"
            comment = "звонил Тестов Тест Тестович" if i == 3 else "без замечаний"
            lines.append(f"{day};{['Продажи', 'Закупки', 'Бухгалтерия'][i % 3]};Сотрудник {i % 4};{comment};"
                         f"{1000 + i} {i:03d},50;КОД-{i:04d}")
        self.c.put("отчёт за сентябрь.csv", "\n".join(lines) + "\n", encoding="cp1251")
        p = self.c.ok("passport")
        self.assertEqual(p["dir"], "input/analiz")
        f = p["files"][0]
        self.assertEqual(f["file"], "отчёт за сентябрь.csv")
        s = f["sheets"][0]
        self.assertEqual(s["rows"], 40)
        cols = {c["name"]: c for c in s["columns"]}
        self.assertEqual(cols["Дата"]["type"], "дата")
        self.assertEqual((cols["Дата"]["first"], cols["Дата"]["last"]), ("2026-09-01", "2026-09-28"))
        self.assertEqual(cols["Сумма"]["type"], "число")
        self.assertEqual((cols["Сумма"]["min"], cols["Сумма"]["max"]), (1000000.5, 1039039.5))
        self.assertEqual(cols["Отдел"]["values"], ["Бухгалтерия", "Закупки", "Продажи"])
        self.assertEqual(cols["Сотрудник"]["values"], "значения скрыты")  # столбец о людях
        self.assertEqual(cols["Комментарий"]["values"], "значения скрыты")  # проверка нашла ФИО
        self.assertEqual(cols["Код"]["distinct"], 40)
        self.assertNotIn("values", cols["Код"])  # больше 30 разных: значений нет
        text = json.dumps(p, ensure_ascii=False)
        for leak in ("КОД-0007", "Иванов", "Сотрудник 1", "без замечаний"):
            self.assertNotIn(leak, text)

    @unittest.skipUnless(HAVE_OPENPYXL, "нет openpyxl")
    def test_xlsx_sheets_title_and_excel_dates(self):
        from datetime import datetime
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Продажи"
        ws.append(["Отчёт о продажах за сентябрь"])
        ws.append([])
        ws.append(["Дата", "Точка", "Сумма"])
        ws.append([datetime(2026, 9, 7), "Точка-01", 100.5])
        ws.append([datetime(2026, 9, 8), "Точка-02", 200])
        wb.create_sheet("Пустой")
        ws3 = wb.create_sheet("Справочник")
        ws3.append(["Точка", "Город"])
        ws3.append(["Точка-01", "Астана"])
        wb.save(self.c.inp / "книга.xlsx")
        p = self.c.ok("passport")
        sheets = {s["sheet"]: s for s in p["files"][0]["sheets"]}
        self.assertEqual(set(sheets), {"Продажи", "Пустой", "Справочник"})
        sales = {c["name"]: c for c in sheets["Продажи"]["columns"]}
        self.assertEqual(sales["Дата"]["type"], "дата")
        self.assertEqual((sales["Дата"]["first"], sales["Дата"]["last"]), ("2026-09-07", "2026-09-08"))
        self.assertEqual(sales["Сумма"]["max"], 200)
        self.assertEqual(sheets["Продажи"]["title"], ["Отчёт о продажах за сентябрь"])
        self.assertEqual(sheets["Пустой"].get("note"), "нет данных")
        self.assertEqual(sheets["Справочник"]["rows"], 1)

    def test_text_mode_old_xls_and_empty(self):
        self.assertIn("пока нет таблиц", self.c.ok("passport")["warnings"][0])
        self.c.put("старый.xls", "x")
        self.c.put(SALES.name, src=SALES)
        p = self.c.ok("passport")
        self.assertEqual(p["skipped"][0]["file"], "старый.xls")
        self.assertIn(".xls", p["skipped"][0]["reason"])
        code, out, err = self.c.run("passport", "--text")
        self.assertEqual(code, 0, err)
        self.assertIn("prodazhi_1c.csv: строк 280", out)
        self.assertIn("Операция: текст, разных 2: Возврат; Продажа", out)

    def test_reads_only_input_analiz(self):
        line, _ = self.c.fail(2, "passport", "--dir", "input/case")
        self.assertIn("только из папки input/analiz", line)
        sub = self.c.inp / "кейс"
        sub.mkdir()
        shutil.copy(SALES, sub / SALES.name)
        p = self.c.ok("passport", "--dir", "input/analiz/кейс")
        self.assertEqual(p["files"][0]["file"], SALES.name)
        # Файл кейса вне input/analiz запрос не видит.
        line, _ = self.c.fail(2, "run", self.c.spec_file({"table": "prodazhi_1c_god.csv"}))
        self.assertIn("нет в папке input/analiz", line)


@unittest.skipUnless((TOOLS / "llm.py").exists(), "нет tools/llm.py")
class PassportRealCheck(unittest.TestCase):
    """С настоящей проверкой tools/llm.py: ФИО в справочнике скрыты, паспорт учебной выгрузки и инструкция проходят."""

    def setUp(self):
        self.c = Cab(fake_llm=False)
        self.addCleanup(self.c.close)

    def test_real_check(self):
        self.c.put(SALES.name, src=SALES)
        self.c.put("люди.csv", "Подразделение;Ответственный за смену;Смена\nТочка-01;Выдумкин Вымысел;1\n"
                              "Точка-02;Примерова Проба Примеровна;2\n", encoding="utf-8")
        code, out, err = self.c.run("passport")
        self.assertEqual(code, 0, err)
        p = json.loads(out)
        files = {f["file"]: f for f in p["files"]}
        cols = {c["name"]: c for c in files["люди.csv"]["sheets"][0]["columns"]}
        self.assertEqual(cols["Ответственный за смену"]["values"], "значения скрыты")
        self.assertEqual(cols["Подразделение"]["values"], ["Точка-01", "Точка-02"])
        import importlib
        sys.path.insert(0, str(self.c.root / "tools"))
        try:
            llm = importlib.import_module("llm")
            mod = load_module()
            payload = "Паспорт данных: " + mod.passport_for_model(p) + "\n\nВопрос человека: продажи по Точка"
            self.assertEqual(llm.check(mod.PROMPT + "\n" + payload), [])
        finally:
            sys.path.remove(str(self.c.root / "tools"))
            sys.modules.pop("llm", None)


# ---------- отборы, группировка, меры ----------

class Engine(unittest.TestCase):
    def setUp(self):
        self.c = Cab()
        self.addCleanup(self.c.close)
        self.c.put("малая.csv", SMALL)

    def ex(self, **spec):
        spec.setdefault("table", "малая.csv")
        return A.execute(self.c.root, spec)

    def count(self, *filters):
        return self.ex(filters=list(filters))["totals"]["Строк"]

    def test_each_filter_operator(self):
        f = lambda col, op, value: {"col": col, "op": op, "value": value}
        self.assertEqual(self.count(f("Город", "=", "Астана")), 2)
        self.assertEqual(self.count(f("Город", "=", "ПАВЛОДАР")), 2)  # без учёта регистра и пробелов
        self.assertEqual(self.count(f("Город", "!=", "Астана")), 4)
        self.assertEqual(self.count(f("Кол-во", ">", 20)), 3)
        self.assertEqual(self.count(f("Кол-во", "<", "20")), 1)
        self.assertEqual(self.count(f("Кол-во", ">=", "20,5")), 3)
        self.assertEqual(self.count(f("Кол-во", "<=", 30)), 3)
        self.assertEqual(self.count(f("Товар", "in", ["Золото 585", "платина"])), 4)
        self.assertEqual(self.count(f("Товар", "not_in", ["Золото 585", "Платина"])), 2)
        self.assertEqual(self.count(f("Товар", "contains", "О")), 4)  # Золото, Серебро: без учёта регистра
        self.assertEqual(self.count(f("Дата", "between", ["2026-09-02", "2026-09-04"])), 3)
        self.assertEqual(self.count(f("Дата", "between", ["02.09.2026", "04.09.2026"])), 3)
        self.assertEqual(self.count(f("Дата", ">", "2026-09-04")), 2)
        self.assertEqual(self.count(f("Дата", "=", "2026-09-03")), 1)
        self.assertEqual(self.count(f("Город", "=", "Караганда"), f("Товар", "=", "Платина")), 1)

    def test_group_by_and_measures(self):
        r = self.ex(group_by=["Город"], measures=[
            {"col": "Кол-во", "agg": "sum", "as": "Сумма"},
            {"col": "Кол-во", "agg": "avg", "as": "Среднее"},
            {"col": "Кол-во", "agg": "count", "as": "Заполнено"},
            {"col": "Товар", "agg": "count_distinct", "as": "Товаров"},
            {"col": "Кол-во", "agg": "min", "as": "Мин"},
            {"col": "Кол-во", "agg": "max", "as": "Макс"},
            {"col": "Дата", "agg": "max", "as": "Последняя дата"}])
        self.assertEqual(r["columns"], ["Город", "Сумма", "Среднее", "Заполнено", "Товаров", "Мин", "Макс", "Последняя дата"])
        self.assertEqual(r["column_types"][-1], "дата")
        rows = {row[0]: row[1:] for row in r["rows"]}
        self.assertEqual(rows["Астана"], [30.5, 15.25, 2, 2, 10, 20.5, "2026-09-02"])
        self.assertEqual(rows["Караганда"], [30, 30, 1, 2, 30, 30, "2026-09-04"])
        self.assertEqual(rows["Павлодар"], [1000, 1000, 1, 2, 1000, 1000, "2026-09-06"])
        self.assertEqual([row[0] for row in r["rows"]], ["Павлодар", "Астана", "Караганда"])  # по первой мере, больше сверху
        self.assertEqual(r["total_rows"], 3)
        self.assertEqual(r["totals"]["Сумма"], 1060.5)
        self.assertEqual(r["totals"]["Товаров"], 4)
        self.assertIn("Павлодар (1 000)", r["summary"])

    def test_unreadable_numbers_are_skipped_with_note(self):
        lines = ["Точка;Сумма"] + [f"Точка-0{i % 2 + 1};{i}" for i in range(1, 20)] + ["Точка-01;н/д"]
        self.c.put("сумма.csv", "\n".join(lines) + "\n")
        r = self.ex(table="сумма.csv", measures=[{"col": "Сумма", "agg": "sum", "as": "Сумма"}])
        self.assertEqual(r["rows"], [[190]])
        self.assertIn("Пропущено 1 строк: не число в «Сумма».", r["notes"])
        r = self.ex(table="сумма.csv", filters=[{"col": "Сумма", "op": ">", "value": 17}])
        self.assertEqual(r["totals"]["Строк"], 2)
        self.assertTrue(any("не число в 1 строках" in n for n in r["notes"]))

    def test_group_by_two_three_and_limit_sort(self):
        r = self.ex(group_by=["Город", "Товар"], measures=[{"agg": "count", "as": "Строк"}],
                    sort={"by": "Строк", "desc": True}, limit=2)
        self.assertEqual(r["total_rows"], 6)
        self.assertEqual(len(r["rows"]), 2)
        self.assertTrue(any("первые 2" in n for n in r["notes"]))
        r = self.ex(group_by=["Город", "Товар", "Цена"], sort={"by": "Город"})
        self.assertEqual(r["rows"][0][:2], ["Астана", "Золото 585"])
        with self.assertRaises(A.Stop) as e:
            self.ex(group_by=["Город", "Товар", "Цена", "Дата"])
        self.assertIn("не больше чем по 3", str(e.exception))
        r = self.ex(limit=500)
        self.assertTrue(any("200" in n for n in r["notes"]))

    def test_group_by_period(self):
        r = self.ex(group_by=[{"col": "Дата", "period": "week"}], measures=[{"agg": "count", "as": "Строк"}])
        self.assertEqual(r["columns"][0], "Дата (неделя)")
        self.assertEqual(r["rows"], [["2026-08-31", 6]])  # 01-06.09.2026: неделя с понедельника 31.08
        r = self.ex(group_by=[{"col": "Дата", "period": "month"}])
        self.assertEqual(r["rows"], [["2026-09", 6]])

    def test_no_group_by(self):
        r = self.ex(measures=[{"col": "Кол-во", "agg": "sum"}])
        self.assertEqual(r["columns"], ["Кол-во"])
        self.assertEqual(r["rows"], [[1060.5]])
        self.assertEqual(r["summary"], "Кол-во: 1 060,5.")

    def test_join(self):
        self.c.put("продажи.csv", "Точка;Сумма\nТочка-01;100\nТочка-02;50\nточка-01 ;25\nТочка-09;5\n")
        self.c.put("справочник.csv", "Код точки;Город;Директор\nТочка-01;Астана;x\nТочка-02;Караганда;y\nТочка-02;Павлодар;z\n")
        r = self.ex(table="продажи.csv",
                    join={"table": "справочник.csv", "sheet": None, "on": [["Точка", "Код точки"]], "cols": ["Город"]},
                    group_by=["Город"], measures=[{"col": "Сумма", "agg": "sum", "as": "Сумма"}])
        rows = {row[0]: row[1] for row in r["rows"]}
        self.assertEqual(rows, {"Астана": 125, "Караганда": 50, "(пусто)": 5})
        self.assertTrue(any("пара нашлась для 3 строк из 4" in n for n in r["notes"]))
        self.assertTrue(any("ключ повторяется в 1 строках" in n for n in r["notes"]))
        # отбор по столбцу из второй таблицы: соединение до отборов
        r = self.ex(table="продажи.csv", join={"table": "справочник.csv", "on": [["Точка", "Код точки"]],
                                                "cols": ["Город"]},
                    filters=[{"col": "Город", "op": "=", "value": "Астана"}], measures=[{"col": "Сумма", "agg": "sum"}])
        self.assertEqual(r["rows"], [[125]])

    def test_errors(self):
        with self.assertRaises(A.Stop) as e:
            self.ex(measures=[{"col": "Колво", "agg": "sum"}])
        msg = str(e.exception)
        self.assertIn("столбца «Колво» нет", msg)
        self.assertIn("Похожие: «Кол-во»", msg)
        with self.assertRaises(A.Stop) as e:
            self.ex(filters=[{"col": "Город", "op": "=", "value": "Алматы"}])
        self.assertIn("строк не нашлось", str(e.exception))
        self.assertIn("Астана", str(e.exception))  # подсказка: какие значения есть
        with self.assertRaises(A.Stop) as e:
            self.ex(measures=[{"col": "Город", "agg": "sum"}])
        self.assertIn("считается по числам", str(e.exception))
        with self.assertRaises(A.Stop) as e:
            self.ex(filters=[{"col": "Город", "op": ">", "value": "А"}])
        self.assertIn("для чисел и дат", str(e.exception))
        with self.assertRaises(A.Stop) as e:
            self.ex(filters=[{"col": "Город", "op": "like", "value": "А"}])
        self.assertIn("оператора «like» нет", str(e.exception))
        with self.assertRaises(A.Stop) as e:
            self.ex(filters=[{"col": "Дата", "op": "=", "value": "вчера"}])
        self.assertIn("не дата", str(e.exception))
        with self.assertRaises(A.Stop) as e:
            self.ex(table="нет такой.csv")
        self.assertIn("Есть: малая.csv", str(e.exception))

    def test_cli_errors_are_one_line(self):
        line, j = self.c.fail(2, "run", self.c.spec_file({"table": "малая.csv",
                                                          "measures": [{"col": "Сумма", "agg": "sum"}]}))
        self.assertIn("столбца «Сумма» нет", line)
        self.assertEqual(j["error"], line)
        line, _ = self.c.fail(2, "run", self.c.spec_file({"table": "малая.csv",
                                                          "filters": [{"col": "Товар", "op": "=", "value": "Кофе"}]}))
        self.assertIn("строк не нашлось", line)
        line, _ = self.c.fail(2, "run", "-", stdin="{не json")
        self.assertIn("не читается как JSON", line)
        line, _ = self.c.fail(2, "неизвестно")
        self.assertIn("Не понял команду", line)
        self.assertFalse((self.c.out / "history.json").exists())  # ошибки в историю не пишутся


# ---------- сравнение периодов на учебной выгрузке ----------

class Compare(unittest.TestCase):
    def setUp(self):
        self.c = Cab()
        self.addCleanup(self.c.close)
        self.c.put(SALES.name, src=SALES)
        self.spec = json.loads(DEMO_SPEC.read_text(encoding="utf-8"))

    def test_compare_matches_independent_count(self):
        r = A.execute(self.c.root, self.spec)
        want = sales_independent(SALES)
        self.assertEqual(r["columns"], ["Точка", "Выручка A", "Выручка B", "Изменение", "Изменение, %"])
        self.assertEqual(r["total_rows"], len(want))
        for point, a, b, d, pct in r["rows"]:
            wa, wb = want[point]
            self.assertAlmostEqual(a, wa, places=1, msg=point)
            self.assertAlmostEqual(b, wb, places=1, msg=point)
            self.assertAlmostEqual(d, wb - wa, places=1, msg=point)
            if wa:
                self.assertAlmostEqual(pct, round((wb - wa) / wa * 100, 1), places=1, msg=point)
            else:
                self.assertIsNone(pct)
        ta = sum(v[0] for v in want.values())
        tb = sum(v[1] for v in want.values())
        self.assertAlmostEqual(r["totals"]["Выручка A"], ta, places=1)
        self.assertAlmostEqual(r["totals"]["Выручка B"], tb, places=1)
        self.assertAlmostEqual(r["totals"]["Изменение, %"], round((tb - ta) / ta * 100, 1), places=1)
        pcts = [row[4] for row in r["rows"] if row[4] is not None]
        self.assertEqual(pcts, sorted(pcts))  # sort по «Изменение, %» по возрастанию, пустые в конце
        self.assertIsNone(r["rows"][-1][4])  # «Астана, Мега-1» есть только во второй неделе
        self.assertIn("Сильнее всего упало: Астана, барахолка 2", r["summary"])
        self.assertTrue(any("строк 279 из 280" in n for n in r["notes"]))
        self.assertIn("Пропущено 1 строк: не число в «Сумма, тг».", r["notes"])

    def test_compare_without_groups_and_errors(self):
        spec = dict(self.spec, group_by=[], sort=None)
        r = A.execute(self.c.root, spec)
        self.assertEqual(len(r["rows"]), 1)
        want = sales_independent(SALES)
        self.assertAlmostEqual(r["rows"][0][0], sum(v[0] for v in want.values()), places=1)
        with self.assertRaises(A.Stop) as e:
            A.execute(self.c.root, dict(self.spec, compare={"col": "Дата", "a": ["2026-10-26", "2026-11-03"],
                                                             "b": ["2026-11-02", "2026-11-08"]}))
        self.assertIn("пересекаются", str(e.exception))
        with self.assertRaises(A.Stop) as e:
            A.execute(self.c.root, dict(self.spec, compare={"col": "Дата", "a": ["2025-01-01", "2025-01-07"],
                                                             "b": ["2025-01-08", "2025-01-14"]}))
        self.assertIn("с 26.10.2026 по 08.11.2026", str(e.exception))
        with self.assertRaises(A.Stop):
            A.execute(self.c.root, dict(self.spec, compare={"col": "Точка", "a": ["1", "2"], "b": ["3", "4"]}))


# ---------- история, вывод, Excel ----------

class HistoryAndExcel(unittest.TestCase):
    def setUp(self):
        self.c = Cab()
        self.addCleanup(self.c.close)
        self.c.put(SALES.name, src=SALES)

    def test_run_history_and_stdout_limit(self):
        spec = {"question": "Выручка по дням и точкам", "table": SALES.name, "group_by": ["Дата", "Точка"],
                "measures": [{"col": "Сумма, тг", "agg": "sum", "as": "Выручка"}]}
        r = self.c.ok("run", self.c.spec_file(spec))
        self.assertTrue(r["id"].startswith("q-"))
        self.assertEqual(r["rows_shown"], 30)
        self.assertEqual(len(r["rows"]), 30)  # в разговор не больше 30 строк
        self.assertGreater(r["total_rows"], 70)
        self.assertEqual(r["rows_in_history"], r["total_rows"])
        h = self.c.history()
        self.assertEqual(h[0]["id"], r["id"])
        self.assertEqual(len(h[0]["rows"]), r["total_rows"])  # полный ответ в истории
        self.assertEqual(h[0]["rows"][0][:2], ["2026-10-26", "Астана, Мега 1"])  # даты по порядку
        r2 = self.c.ok("run", "-", stdin=json.dumps(dict(spec, group_by=["Точка"]), ensure_ascii=False))
        h = self.c.ok("history")
        self.assertEqual([e["id"] for e in h], [r2["id"], r["id"]])  # новые сверху
        self.assertNotEqual(r2["id"], r["id"])
        self.assertEqual(len(self.c.ok("history", "--limit", "1")), 1)
        for key in ("id", "question", "spec", "columns", "rows", "total_rows", "totals", "notes", "summary"):
            self.assertIn(key, h[0])
        code, out, err = self.c.run("run", self.c.spec_file(spec), "--text")
        self.assertEqual(code, 0, err)
        self.assertIn("Дата | Точка | Выручка", out)

    def test_people_hidden_in_chat_full_in_history(self):
        self.c.put("смены.csv", "Сотрудник;Сумма\nСмена Альфа;10\nСмена Бета;20\nСмена Альфа;5\n")
        r = self.c.ok("run", self.c.spec_file({"table": "смены.csv", "group_by": ["Сотрудник"],
                                               "measures": [{"col": "Сумма", "agg": "sum"}]}))
        self.assertEqual([row[0] for row in r["rows"]], ["скрыто", "скрыто"])
        self.assertTrue(any("скрыты" in n for n in r["notes"]))
        self.assertNotIn("Альфа", r["summary"])
        h = self.c.history()[0]
        self.assertEqual(sorted(row[0] for row in h["rows"]), ["Смена Альфа", "Смена Бета"])

    @unittest.skipUnless(HAVE_OPENPYXL, "нет openpyxl")
    def test_excel_bar_and_line(self):
        from openpyxl.chart import BarChart, LineChart
        demo = json.loads(DEMO_SPEC.read_text(encoding="utf-8"))
        r = self.c.ok("run", self.c.spec_file(demo))
        x = self.c.ok("excel", r["id"])
        path = self.c.out / f"{r['id']}.xlsx"
        self.assertTrue(path.is_file())
        self.assertEqual(x["file"], f"output/analiz/{r['id']}.xlsx")
        self.assertEqual(x["chart"], "столбики")
        wb = openpyxl.load_workbook(path)
        ws = wb.active
        self.assertEqual(ws["A1"].value, demo["question"])
        self.assertEqual([c.value for c in ws[4]], ["Точка", "Выручка A", "Выручка B", "Изменение", "Изменение, %"])
        self.assertEqual(ws.cell(5, 1).value, r["rows"][0][0])
        self.assertEqual(len(ws._charts), 1)
        self.assertIsInstance(ws._charts[0], BarChart)
        wb.close()
        r = self.c.ok("run", self.c.spec_file({"table": SALES.name, "group_by": ["Дата"],
                                               "measures": [{"col": "Сумма, тг", "agg": "sum", "as": "Выручка"}]}))
        x = self.c.ok("excel", r["id"])
        self.assertEqual(x["chart"], "линия")
        wb = openpyxl.load_workbook(self.c.out / f"{r['id']}.xlsx")
        ws = wb.active
        self.assertIsInstance(ws._charts[0], LineChart)
        self.assertEqual(ws.cell(5, 1).value.date(), date(2026, 10, 26))  # дата, не текст
        wb.close()
        line, _ = self.c.fail(2, "excel", "q-19990101-000000")
        self.assertIn("нет в истории", line)
        line, _ = self.c.fail(2, "excel", "../../секрет")
        self.assertIn("не похоже на номер ответа", line)
        self.assertEqual(sorted(p.name for p in self.c.out.iterdir() if p.name.endswith(".tmp.xlsx")), [])


# ---------- вопрос словами (модель подменена) ----------

class Ask(unittest.TestCase):
    def setUp(self):
        self.c = Cab()
        self.addCleanup(self.c.close)
        self.c.put(SALES.name, src=SALES)
        self.spec = json.loads(DEMO_SPEC.read_text(encoding="utf-8"))
        self.q = "Как изменилась выручка по точкам за последнюю неделю к предыдущей?"

    def test_success_with_code_fence(self):
        answer = "Вот запрос:\n```json\n" + json.dumps({k: v for k, v in self.spec.items() if k != "question"},
                                                          ensure_ascii=False, indent=2) + "\n```"
        r = self.c.ok("ask", self.q, answers=[answer])
        self.assertEqual(r["question"], self.q)
        self.assertEqual(r["columns"][0], "Точка")
        self.assertEqual(r["total_rows"], 7)
        self.assertEqual(self.c.history()[0]["source"], "ask")
        calls = self.c.calls()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["model"], "sonnet")
        payload = calls[0]["payload"]
        self.assertIn("Паспорт данных", payload)
        self.assertIn(self.q, payload)
        self.assertIn("Сумма, тг", payload)
        for row_value in ("234 100,00", "234100.0", "2,66"):  # строки файла в модель не идут
            self.assertNotIn(row_value, payload)
        self.assertIn("need_rows", calls[0]["prompt"])

    def test_retry_after_wrong_column(self):
        bad = dict(self.spec, measures=[{"col": "Выручка", "agg": "sum", "as": "Выручка"}])
        r = self.c.ok("ask", self.q, answers=[json.dumps(bad, ensure_ascii=False), json.dumps(self.spec, ensure_ascii=False)])
        self.assertEqual(r["total_rows"], 7)
        calls = self.c.calls()
        self.assertEqual(len(calls), 2)
        self.assertIn("столбца «Выручка» нет", calls[1]["payload"])

    def test_need_rows(self):
        line, j = self.c.fail(5, "ask", "О чём жалуются клиенты?",
                              answers=['{"need_rows": true, "why": "нужно читать тексты жалоб"}'])
        self.assertIn("обезличьте файл анонимайзером с воркшопа 2", line)
        self.assertTrue(j["need_rows"])
        self.assertFalse((self.c.out / "history.json").exists())

    def test_unavailable_code_3(self):
        line, j = self.c.fail(3, "ask", self.q, mode="unavailable")
        self.assertEqual(line, "На этом компьютере Claude для страницы недоступен. Задайте вопрос Claude во вкладке Code: "
                               f"«проанализируй таблицу: {self.q}»")
        self.assertTrue(j["llm_unavailable"])

    def test_blocked_code_4(self):
        line, j = self.c.fail(4, "ask", "Сколько продал Тестов Тест Тестович?", mode="blocked")
        self.assertIn("персональные данные", line)
        self.assertTrue(j["blocked"])

    def test_cannot_and_garbage(self):
        line, _ = self.c.fail(2, "ask", "Какая погода?", answers=['{"cannot": true, "why": "в таблицах нет погоды"}'])
        self.assertIn("в таблицах нет погоды", line)
        line, _ = self.c.fail(2, "ask", self.q, answers=["не знаю"])
        self.assertIn("не запросом JSON", line)

    def test_no_tables(self):
        (self.c.inp / SALES.name).unlink()
        line, _ = self.c.fail(2, "ask", self.q, answers=["{}"])
        self.assertIn("нет таблиц", line)
        self.assertEqual(self.c.calls(), [])  # модель не звали


# ---------- пример ----------

class Demo(unittest.TestCase):
    def setUp(self):
        self.c = Cab()
        self.addCleanup(self.c.close)

    def test_demo_twice_no_duplicates(self):
        for _ in range(2):
            code, out, err = self.c.run("demo")
            self.assertEqual(code, 0, err)
            self.assertIn("Готово: пример ответа на странице «Аналитика таблиц».", out)
            self.assertIn("Выручка: A (26.10.2026-01.11.2026)", out)
        self.assertEqual([p.name for p in self.c.inp.iterdir()], [SALES.name])
        h = self.c.history()
        self.assertEqual(len(h), 1)
        self.assertTrue(h[0]["demo"])
        self.assertEqual(h[0]["question"], "Как изменилась выручка по точкам за последнюю неделю к предыдущей?")

    def test_demo_keeps_own_file(self):
        own = self.c.put(SALES.name, "Дата;Сумма\n01.09.2026;5\n")
        self.c.put("своё.csv", "А;Б\n1;2\n")
        self.c.ok("run", self.c.spec_file({"table": "своё.csv"}))
        code, out, err = self.c.run("demo")
        self.assertEqual(code, 0, err)
        self.assertEqual(own.read_text(encoding="utf-8"), "Дата;Сумма\n01.09.2026;5\n")  # чужой файл не тронут
        copy = self.c.inp / "prodazhi_1c (пример).csv"
        self.assertEqual(copy.read_bytes(), SALES.read_bytes())
        h = self.c.history()
        self.assertEqual(len(h), 2)
        self.assertEqual(h[0]["table"], copy.name)
        code, out, err = self.c.run("demo")
        self.assertEqual(code, 0, err)
        self.assertEqual(len(list(self.c.inp.iterdir())), 3)  # копия не повторяется
        self.assertEqual(len(self.c.history()), 2)


# ---------- скорость на годовой выгрузке ----------

@unittest.skipUnless(YEAR.exists(), "нет годовой выгрузки")
class Speed(unittest.TestCase):
    def test_year_file_seconds(self):
        c = Cab(case_files=())
        self.addCleanup(c.close)
        c.put(YEAR.name, src=YEAR)
        t0 = time.time()
        p = c.ok("passport")
        t1 = time.time()
        self.assertEqual(p["files"][0]["sheets"][0]["rows"], 8031)
        r = c.ok("run", c.spec_file({"table": YEAR.name, "group_by": [{"col": "Дата", "period": "month"}, "Точка"],
                                     "measures": [{"col": "Сумма, тг", "agg": "sum", "as": "Выручка"}]}))
        t2 = time.time()
        pairs = set()
        text = YEAR.read_bytes().decode("cp1251")
        for row in csv.reader(io.StringIO(text), delimiter=";"):
            if len(row) > 3 and row[0][:2].isdigit() and row[0][2:3] == ".":
                pairs.add((row[0][3:], row[1]))
        self.assertEqual(r["total_rows"], len(pairs))
        self.assertLess(t1 - t0, 15, "паспорт годовой выгрузки дольше 15 секунд")
        self.assertLess(t2 - t1, 15, "запрос по годовой выгрузке дольше 15 секунд")
        self.assertAlmostEqual(sum(row[2] for row in c.history()[0]["rows"]), 1208157900, places=0)


if __name__ == "__main__":
    unittest.main()
