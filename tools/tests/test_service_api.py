"""Тесты tools/service_api.py (серверная часть своей страницы сервиса) и строки журнала в tools/llm.py.

Запуск: python -m unittest discover -s tools/tests -p "test_*.py"
Проект сервиса создаётся во временной папке с кириллицей и пробелом в имени; api.py запускается так же,
как его запускает кабинет: `python api.py <действие>` в папке проекта, запрос JSON в stdin, lib в PYTHONPATH.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent

API = '''from service_api import serve, StopRun, save_upload, remove_file, list_files


def upload(data, file):
    return {"file": save_upload(file)}


def delete(data, file):
    remove_file(data.get("name", ""), data.get("folder"))


def files(data, file):
    return {"files": [f["name"] for f in list_files(data.get("folder"))]}


def echo(data, file):
    return {"got": data, "file": file}


def stop(data, file):
    raise StopRun("Нет файла с продажами")


def crash(data, file):
    return {}["нет"]


serve({"upload": upload, "delete": delete, "files": files, "echo": echo, "stop": stop, "crash": crash})
'''


class ServiceApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="Сервис проверки "))
        self.proj = self.tmp / "Сервисы" / "svodka"
        (self.proj / "lib").mkdir(parents=True)
        (self.proj / "input").mkdir()
        (self.proj / "output").mkdir()
        shutil.copy(TOOLS / "service_api.py", self.proj / "lib" / "service_api.py")
        (self.proj / "api.py").write_text(API, encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, route, request=None, raw=None):
        env = {**os.environ, "PYTHONPATH": str(self.proj / "lib"), "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        body = raw if raw is not None else json.dumps(request or {}, ensure_ascii=False)
        p = subprocess.run([sys.executable, "api.py", route], input=body.encode("utf-8"), capture_output=True,
                           cwd=self.proj, env=env)
        return p.returncode, p.stdout.decode("utf-8"), p.stderr.decode("utf-8")

    def upload_file(self, name, text="Точка;Сумма\n"):
        up = self.proj / ".cabinet-upload"
        up.mkdir(exist_ok=True)
        part = up / f"{len(list(up.iterdir()))}.part"
        part.write_text(text, encoding="utf-8")
        return self.call("upload", {"route": "upload", "data": {}, "file": {"name": name, "path": f".cabinet-upload/{part.name}", "size": 1}})

    def test_dispatch_and_json(self):
        code, out, err = self.call("echo", {"data": {"город": "Астана"}})
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out), {"got": {"город": "Астана"}, "file": None})
        code, out, _ = self.call("delete", {"data": {"name": "нет.csv"}})
        self.assertEqual(code, 2)

    def test_unknown_route_stop_and_crash(self):
        code, _, err = self.call("nety")
        self.assertEqual(code, 2)
        self.assertIn("нет действия «nety»", err)
        code, _, err = self.call("stop")
        self.assertEqual((code, err.strip()), (2, "Нет файла с продажами"))
        code, _, err = self.call("crash")
        self.assertEqual(code, 1)
        self.assertEqual(len(err.strip().splitlines()), 1, "сбой одной строкой, без трейсбека")
        self.assertRegex(err, r"api\.py, строка \d+: KeyError")

    def test_bad_stdin(self):
        for raw in ("не json", "[1, 2]"):
            code, _, err = self.call("echo", raw=raw)
            self.assertEqual(code, 2, raw)
            self.assertIn("не прочитался", err)
        code, out, _ = self.call("echo", raw="")
        self.assertEqual((code, json.loads(out)), (0, {"got": {}, "file": None}))

    def test_upload_numbering_list_and_delete(self):
        self.assertEqual(json.loads(self.upload_file("Продажи.csv")[1]), {"file": "Продажи.csv"})
        self.assertEqual(json.loads(self.upload_file("Продажи.csv")[1]), {"file": "Продажи (2).csv"})
        self.assertEqual(json.loads(self.upload_file("../../Хитрое имя.csv")[1]), {"file": "Хитрое имя.csv"})
        (self.proj / "input" / ".скрытый").write_text("x", encoding="utf-8")
        (self.proj / "input" / "~$Продажи.csv").write_text("x", encoding="utf-8")
        code, out, _ = self.call("files")
        self.assertEqual(sorted(json.loads(out)["files"]), ["Продажи (2).csv", "Продажи.csv", "Хитрое имя.csv"])
        code, _, _ = self.call("delete", {"data": {"name": "Продажи (2).csv"}})
        self.assertEqual(code, 0)
        self.assertFalse((self.proj / "input" / "Продажи (2).csv").exists())
        for name in ("../api.py", ".скрытый", "", "/etc/passwd", "..\\api.py"):
            code, _, err = self.call("delete", {"data": {"name": name}})
            self.assertEqual(code, 2, name)
        self.assertTrue((self.proj / "api.py").exists())
        self.assertEqual(self.upload_file("~$временный.xlsx")[0], 2)

    def test_folders_only_input_and_output(self):
        (self.proj / "output" / "otchet.xlsx").write_text("x", encoding="utf-8")
        code, out, _ = self.call("files", {"data": {"folder": "output"}})
        self.assertEqual(json.loads(out)["files"], ["otchet.xlsx"])
        for folder in ("lib", "..", str(self.tmp)):
            code, _, err = self.call("files", {"data": {"folder": folder}})
            self.assertEqual(code, 2, folder)
            self.assertIn("только с папками input и output", err)
        code, _, _ = self.call("delete", {"data": {"name": "service_api.py", "folder": "lib"}})
        self.assertEqual(code, 2)
        self.assertTrue((self.proj / "lib" / "service_api.py").exists())

    def test_upload_without_file(self):
        code, _, err = self.call("upload", {"data": {}})
        self.assertEqual(code, 2)
        self.assertIn("файл не загружен", err)
        code, _, err = self.call("upload", {"file": {"name": "a.csv", "path": "../../чужой.csv", "size": 1}})
        self.assertEqual(code, 2)


class LlmJournalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="Журнал кабинета "))
        sys.path.insert(0, str(TOOLS))
        import llm
        self.llm = llm
        self.saved = {k: os.environ.get(k) for k in ("CABINET_JOURNAL", "CABINET_SERVICE", "AI_CABINET_CLAUDE", "PATH")}

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        sys.path.remove(str(TOOLS))
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_blocked_call_written_without_values(self):
        journal = self.tmp / "journal" / "2026-10.jsonl"
        os.environ["CABINET_JOURNAL"] = str(journal)
        os.environ["CABINET_SERVICE"] = "svodka"
        with self.assertRaises(self.llm.LLMBlocked):
            self.llm.ask("Сводка", "Иванов Иван Петрович, +7 701 123 45 67")
        lines = [json.loads(l) for l in journal.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertEqual((line["event"], line["service"], line["ok"]), ("model", "svodka", False))
        self.assertIn("телефон: 1", line["reason"])
        text = journal.read_text(encoding="utf-8")
        self.assertNotIn("Иванов", text)
        self.assertNotIn("701", text)

    def test_no_claude_written_and_no_journal_without_variable(self):
        journal = self.tmp / "j.jsonl"
        os.environ["CABINET_JOURNAL"] = str(journal)
        os.environ.pop("AI_CABINET_CLAUDE", None)
        os.environ["PATH"] = str(self.tmp)
        with self.assertRaises(self.llm.LLMUnavailable):
            self.llm.ask("Сводка за неделю", "итого 1200")
        self.assertEqual(json.loads(journal.read_text(encoding="utf-8"))["reason"], "нет Claude для сервисов")
        os.environ.pop("CABINET_JOURNAL")
        journal.unlink()
        with self.assertRaises(self.llm.LLMUnavailable):
            self.llm.ask("Сводка за неделю", "итого 1200")
        self.assertFalse(journal.exists())


if __name__ == "__main__":
    unittest.main()
