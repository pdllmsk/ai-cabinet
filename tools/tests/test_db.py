"""Тесты tools/db.py (база сервиса вида web): параметры, insert_rows, транзакция, подключение по DATABASE_URL.

Запуск: python -m unittest discover -s tools/tests -p "test_*.py"
Postgres не нужен: подключение подменяется записывающим объектом, тестовая база sqlite (WEB_DB_FAKE=1).
"""

import os
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))

import db  # noqa: E402
import web  # noqa: E402


class FakePg:
    """Подключение pg8000.native: запоминает запросы и параметры."""

    def __init__(self):
        self.calls = []
        self.columns = [{"name": "a"}, {"name": "b"}]
        self.row_count = 3
        self.closed = False

    def run(self, sql, **params):
        self.calls.append((sql, params))
        return [[1, "x"]]

    def close(self):
        self.closed = True


class DbParamsTest(unittest.TestCase):
    def setUp(self):
        self.env = dict(os.environ)
        os.environ.pop("WEB_DB_FAKE", None)
        self.pg = FakePg()
        self._orig = db._connect_pg
        db._connect_pg = lambda: self.pg
        db.close()

    def tearDown(self):
        db._connect_pg = self._orig
        db.close()
        os.environ.clear()
        os.environ.update(self.env)

    def test_параметры_позиционные_и_по_имени(self):
        rows = db.query("select a, b from t where x = %s and y like %s", (5, "%к%"))
        self.assertEqual(rows, [{"a": 1, "b": "x"}])
        self.assertEqual(self.pg.calls[-1], ("select a, b from t where x = :p1 and y like :p2", {"p1": 5, "p2": "%к%"}))
        db.execute("update t set s = %(s)s where id = %(id)s", {"s": "готово", "id": 7})
        self.assertEqual(self.pg.calls[-1], ("update t set s = :s where id = :id", {"s": "готово", "id": 7}))
        self.assertEqual(db.execute("delete from t"), 3)
        self.assertEqual(self.pg.calls[-1], ("delete from t", {}))

    def test_ошибки_параметров(self):
        with self.assertRaises(TypeError):
            db.query("select %s, %s", (1,))
        with self.assertRaises(TypeError):
            db.query("select %s", (1, 2))
        with self.assertRaises(TypeError):
            db.query("select %(a)s", (1,))
        with self.assertRaises(TypeError):
            db.query("select %s", "строка вместо кортежа")

    def test_insert_rows_пакетами_и_имена(self):
        db.insert_rows("app.zapisi", ["nazvanie", "summa"], [["a", 1], ["b", 2]])
        sql, params = self.pg.calls[-1]
        self.assertEqual(sql, "insert into app.zapisi (nazvanie, summa) values (:p1, :p2), (:p3, :p4)")
        self.assertEqual(params, {"p1": "a", "p2": 1, "p3": "b", "p4": 2})
        for bad_table, bad_cols in [("zapisi; drop table x", ["a"]), ("Zapisi", ["a"]), ("a.b.c", ["a"]), ("zapisi", ["a b"]), ("zapisi", ["a\"--"])]:
            with self.assertRaises(ValueError):
                db.insert_rows(bad_table, bad_cols, [[1]])
        with self.assertRaises(ValueError):
            db.insert_rows("zapisi", ["a", "b"], [[1]])
        self.pg.calls.clear()
        db.insert_rows("zapisi", ["a"], [[i] for i in range(db.BATCH + 1)])
        self.assertEqual(len(self.pg.calls), 2)

    def test_транзакция(self):
        with db.transaction():
            db.execute("insert into t values (%s)", (1,))
        self.assertEqual([c[0] for c in self.pg.calls], ["START TRANSACTION", "insert into t values (:p1)", "COMMIT"])
        self.pg.calls.clear()
        with self.assertRaises(RuntimeError):
            with db.transaction():
                raise RuntimeError("x")
        self.assertEqual([c[0] for c in self.pg.calls], ["START TRANSACTION", "ROLLBACK"])

    def test_close(self):
        db.query("select 1")
        db.close()
        self.assertTrue(self.pg.closed)


class DbConnectTest(unittest.TestCase):
    def setUp(self):
        self.env = dict(os.environ)
        os.environ.pop("WEB_DB_FAKE", None)
        db.close()

    def tearDown(self):
        db.close()
        os.environ.clear()
        os.environ.update(self.env)

    def test_нет_database_url(self):
        os.environ.pop("DATABASE_URL", None)
        with self.assertRaises(web.StopRun) as e:
            db.query("select 1")
        self.assertIn("опубликуй сервис", str(e.exception))

    def test_адрес_разбирается(self):
        import pg8000.native
        seen = {}
        orig = pg8000.native.Connection

        class Rec:
            def __init__(self, **kw):
                seen.update(kw)
                self._usock = None

        pg8000.native.Connection = Rec
        try:
            os.environ["DATABASE_URL"] = "postgresql://app_svetofor.abcdefghijklmnop:p%40ss%2Fw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require"
            db._connect_pg()
        finally:
            pg8000.native.Connection = orig
        self.assertEqual(seen["user"], "app_svetofor.abcdefghijklmnop")
        self.assertEqual(seen["password"], "p@ss/w")
        self.assertEqual(seen["host"], "aws-0-eu-central-1.pooler.supabase.com")
        self.assertEqual(seen["port"], 6543)
        self.assertEqual(seen["database"], "postgres")
        self.assertIsNotNone(seen["ssl_context"])
        self.assertEqual(seen["timeout"], db.CONNECT_TIMEOUT)

    def test_нет_связи_понятная_ошибка(self):
        os.environ["DATABASE_URL"] = "postgresql://u:p@127.0.0.1:1/postgres"
        with self.assertRaises(web.StopRun) as e:
            db.query("select 1")
        self.assertIn("не отвечает", str(e.exception))


class DbFakeTest(unittest.TestCase):
    def setUp(self):
        self.env = dict(os.environ)
        os.environ["WEB_DB_FAKE"] = "1"
        db.fake_reset()
        db.fake_migrate((TOOLS.parent / "templates" / "web-service" / "db" / "001_init.sql").read_text(encoding="utf-8"))

    def tearDown(self):
        db.fake_reset()
        os.environ.clear()
        os.environ.update(self.env)

    def test_шаблон_работает_на_тестовой_базе(self):
        self.assertEqual(db.insert_rows("app.zapisi", ["nazvanie", "summa"], [["a", 1], ["b", 2]]), 2)
        db.execute("insert into app.zapisi (nazvanie, summa) values (%s, %s)", ("c", 3))
        rows = db.query("select nazvanie from app.zapisi where summa >= %(m)s order by id", {"m": 2})
        self.assertEqual([r["nazvanie"] for r in rows], ["b", "c"])
        with self.assertRaises(RuntimeError):
            with db.transaction():
                db.execute("delete from app.zapisi")
                raise RuntimeError("откат")
        self.assertEqual(len(db.query("select id from app.zapisi")), 3)


if __name__ == "__main__":
    unittest.main()
