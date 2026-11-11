"""Демо-процесс «светофор точек продаж» (templates/processes/svetofor-tochek) на файлах кейса.

Запуск: python -m unittest discover -s tools/tests -p "test_*.py"
Эталон: неделя 02-08.11.2026 к 26.10-01.11.2026, 7 строк (6 точек и «Астана, Мега-1», записанная по-другому),
пороги падения 20% и 5%.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent.parent
DEMO = ROOT / "templates" / "processes" / "svetofor-tochek"
CASE_FILE = ROOT / "input" / "case" / "data" / "prodazhi_1c.csv"
NEXT_WEEK = ROOT / "input" / "case" / "data" / "prodazhi_1c_nedelya3.csv"
SLUG = "svetofor-tochek"


def load_demo():
    spec = importlib.util.spec_from_file_location("svetofor_demo", DEMO / "run.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class DemoNumbersTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_demo()
        cls.res = cls.mod.build_result([CASE_FILE])
        cls.col = {name: i for i, name in enumerate(cls.res["columns"])}

    def points(self, status):
        return sorted(r[0] for r, s in zip(self.res["rows"], self.res["row_status"]) if s == status)

    def row(self, point):
        found = [(r, s, n) for r, s, n in zip(self.res["rows"], self.res["row_status"], self.res["row_note"]) if r[0] == point]
        self.assertEqual(len(found), 1, point)
        return found[0]

    def test_weeks_from_data(self):
        self.assertEqual(self.mod.RED_DROP, 20)
        self.assertEqual(self.mod.YELLOW_DROP, 5)
        self.assertIn("Неделя 02.11-08.11.2026 к неделе 26.10-01.11.2026", self.res["summary"])
        self.assertEqual(self.res["columns"][1:3], ["Выручка 26.10-01.11.2026, тг", "Выручка 02.11-08.11.2026, тг"])

    def test_counts_match_reference(self):
        self.assertEqual(len(self.res["rows"]), 7)
        self.assertEqual(Counter(self.res["row_status"]), Counter({"red": 1, "yellow": 2, "grey": 1, "green": 2, "info": 1}))
        self.assertEqual(self.res["status"], "red")

    def test_points_match_reference(self):
        self.assertEqual(self.points("red"), ["Астана, Керуен"])
        self.assertEqual(self.points("yellow"), ["Астана, Мега 1", "Астана, Мега 2"])
        self.assertEqual(self.points("grey"), ["Астана, барахолка 2"])
        self.assertEqual(self.points("green"), ["Алматы, аэропорт (беспошлинная)", "Астана, барахолка 1"])
        self.assertEqual(self.points("info"), ["Астана, Мега-1"])  # ловушка: та же точка, записанная по-другому

    def test_sums_and_change(self):
        a, b, pct = self.col["Выручка 26.10-01.11.2026, тг"], self.col["Выручка 02.11-08.11.2026, тг"], self.col["Изменение, %"]
        expected = {
            "Астана, Керуен": (5586800, 2721900, -51.3),
            "Астана, Мега 2": (5086100, 4092800, -19.5),
            "Астана, Мега 1": (6175600, 5315700, -13.9),  # с повтором строки и возвратом, как в выгрузке
            "Алматы, аэропорт (беспошлинная)": (2086300, 2845200, 36.4),  # ловушка: сумма «н/д» в первой неделе
        }
        for point, (wa, wb, wp) in expected.items():
            r, _, _ = self.row(point)
            self.assertEqual((r[a], r[b], r[pct]), (wa, wb, wp), point)

    def test_days_without_data_are_grey(self):
        r, s, note = self.row("Астана, барахолка 2")
        self.assertEqual(s, "grey")
        self.assertEqual(note, "нет данных за 04.11, 05.11")

    def test_rows_sorted_by_urgency(self):
        order = {"red": 0, "yellow": 1, "grey": 2, "green": 3, "info": 4}
        ranks = [order[s] for s in self.res["row_status"]]
        self.assertEqual(ranks, sorted(ranks))

    def test_next_week_file_moves_the_weeks(self):
        res = self.mod.build_result([CASE_FILE, NEXT_WEEK])
        self.assertIn("Неделя 09.11-15.11.2026 к неделе 02.11-08.11.2026", res["summary"])
        self.assertEqual(len(res["rows"]), 7)

    def test_new_point_is_info(self):
        r, s, note = self.row("Астана, Мега-1")
        self.assertEqual((s, note, r[self.col["Изменение, %"]]), ("info", "новая точка", None))

    def test_schema_fields(self):
        r = self.res
        self.assertEqual(r["title"], "Светофор точек продаж")
        self.assertRegex(r["updated_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
        self.assertEqual(r["files"], [f"output/{SLUG}/svetofor.xlsx"])
        for row in r["rows"]:
            self.assertEqual(len(row), len(r["columns"]))
        self.assertEqual(len(r["row_status"]), 7)
        self.assertEqual(len(r["row_note"]), 7)
        self.assertNotRegex(json.dumps(r, ensure_ascii=False), "[‒-―]")

    def test_process_json(self):
        p = json.loads((DEMO / "process.json").read_text(encoding="utf-8"))
        self.assertEqual(p, {
            "title": "Светофор точек продаж",
            "phrase": "запусти светофор точек",
            "kind": "script",
            "input": f"input/{SLUG}/",
            "output": f"output/{SLUG}/",
        })


class DemoRunTests(unittest.TestCase):
    """Запуск как со страницы: из корня кабинета в папке с кириллицей и пробелом."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.cab = Path(self._tmp.name) / "Айгуль Н" / "ai-cabinet"
        (self.cab / "tools").mkdir(parents=True)
        shutil.copy(ROOT / "tools" / "read_table.py", self.cab / "tools")
        shutil.copytree(DEMO, self.cab / "processes" / SLUG)
        self.inp = self.cab / "input" / SLUG
        self.inp.mkdir(parents=True)
        self.out = self.cab / "output" / SLUG

    def tearDown(self):
        self._tmp.cleanup()

    def run_demo(self):
        return subprocess.run(
            [sys.executable, str(Path("processes") / SLUG / "run.py")],
            cwd=self.cab, capture_output=True, encoding="utf-8",
            env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        )

    def test_writes_result_and_excel(self):
        shutil.copy(CASE_FILE, self.inp)
        p = self.run_demo()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        res = json.loads((self.out / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(len(res["rows"]), 7)
        self.assertEqual(Counter(res["row_status"])["red"], 1)
        wb = openpyxl.load_workbook(self.out / "svetofor.xlsx", read_only=True)
        rows = list(wb.active.iter_rows(values_only=True))
        wb.close()
        self.assertEqual(len(rows), 8)
        self.assertIn("Точка", rows[0])
        self.assertIn("Статус", rows[0])
        self.assertEqual(sorted(f.name for f in self.out.iterdir()), ["result.json", "svetofor.xlsx"])
        self.assertIn("02.11-08.11.2026", p.stdout)

    def test_no_input_file(self):
        p = self.run_demo()
        self.assertEqual(p.returncode, 2)
        self.assertIn(f"input/{SLUG}", p.stdout + p.stderr)
        self.assertIn("prodazhi_1c.csv", p.stdout + p.stderr)
        self.assertRegex(p.stdout + p.stderr, "[А-Яа-я]")
        self.assertNotIn("Traceback", p.stdout + p.stderr)
        self.assertFalse((self.out / "result.json").exists())

    def test_wrong_columns(self):
        (self.inp / "prodazhi_1c.csv").write_text("Дата;Отделение;Займы\n02.11.2026;Отделение 1;100\n", encoding="utf-8")
        p = self.run_demo()
        self.assertEqual(p.returncode, 2)
        self.assertIn("«Точка»", p.stdout + p.stderr)
        self.assertNotIn("Traceback", p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main()
