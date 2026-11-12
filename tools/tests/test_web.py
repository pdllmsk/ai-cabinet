"""Тесты tools/web.py (сервер сервиса вида web): код доступа, cookie, действия, пределы, ошибки.

Запуск: python -m unittest discover -s tools/tests -p "test_*.py"
Сервер поднимается в этом же процессе на 127.0.0.1 (как lib/web_dev.py), база подменена (WEB_DB_FAKE=1).
"""

import http.client
import json
import os
import sys
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))

import web  # noqa: E402
import db  # noqa: E402

CODE = "river-lamp-sun"


def actions():
    def echo(data, file):
        return {"got": data, "file": None if file is None else {"name": file["name"], "size": len(file["data"])}}

    def stop(data, file):
        raise web.StopRun("Нет файла с продажами")

    def boom(data, file):
        raise RuntimeError("секретная подробность")

    def rows(data, file):
        return {"rows": db.query("select nazvanie, summa from app.zapisi order by nazvanie")}

    return {"echo": echo, "stop": stop, "boom": boom, "rows": rows}


class Server:
    def __init__(self, handler):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
            h.setdefault("Content-Type", "application/json")
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        raw = r.read()
        c.close()
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError:
            data = None
        return r.status, data, r


class WebTest(unittest.TestCase):
    def setUp(self):
        self.env = dict(os.environ)
        os.environ["SERVICE_ACCESS_CODE_HASH"] = web.hash_code(CODE, iterations=1000)
        os.environ["SERVICE_COOKIE_SECRET"] = "s" * 43
        os.environ["WEB_DB_FAKE"] = "1"
        os.environ.pop("WEB_DEV", None)
        web.reset_limits()
        db.fake_reset()
        db.fake_migrate((TOOLS.parent / "templates" / "web-service" / "db" / "001_init.sql").read_text(encoding="utf-8"))
        db.insert_rows("app.zapisi", ["nazvanie", "summa"], [["Керуен", 100], ["Мега", 250.5]])
        self.s = Server(web.serve(actions()))

    def tearDown(self):
        self.s.close()
        os.environ.clear()
        os.environ.update(self.env)

    def login(self, code=CODE):
        st, data, r = self.s.req("POST", "/api/login", {"code": code})
        cookie = (r.getheader("Set-Cookie") or "").split(";")[0]
        return st, data, cookie, r.getheader("Set-Cookie") or ""

    def test_health_без_кода(self):
        st, data, _ = self.s.req("GET", "/api/health")
        self.assertEqual((st, data), (200, {"ok": True}))

    def test_действие_без_cookie_401(self):
        st, data, _ = self.s.req("POST", "/api/echo", {"a": 1})
        self.assertEqual(st, 401)
        self.assertEqual(data["error"], "Нужен код доступа")
        # Имена действий без входа не выдаются.
        self.assertEqual(self.s.req("POST", "/api/nety-takogo", {})[0], 401)

    def test_вход_и_действие(self):
        st, data, cookie, raw = self.login("  River LAMP  sun ")
        self.assertEqual(st, 200)
        self.assertIn("HttpOnly", raw)
        self.assertIn("Secure", raw)
        self.assertIn("SameSite=Lax", raw)
        self.assertIn("Max-Age=7776000", raw)
        st, data, _ = self.s.req("POST", "/api/echo?x=1", {"a": "б"}, {"Cookie": cookie})
        self.assertEqual(st, 200)
        self.assertEqual(data["got"], {"x": "1", "a": "б"})
        st, data, _ = self.s.req("POST", "/api/rows", {}, {"Cookie": cookie})
        self.assertEqual(data["rows"], [{"nazvanie": "Керуен", "summa": 100}, {"nazvanie": "Мега", "summa": 250.5}])
        self.assertEqual(self.s.req("POST", "/api/nety-takogo", {}, {"Cookie": cookie})[0], 404)
        self.assertEqual(self.s.req("POST", "/api/%D0%9F%D0%9B%D0%9E%D0%A5%D0%9E", {}, {"Cookie": cookie})[0], 404)

    def test_локально_cookie_без_secure(self):
        os.environ["WEB_DEV"] = "1"
        _, _, _, raw = self.login()
        self.assertNotIn("Secure", raw)

    def test_неверный_код_и_429(self):
        for _ in range(10):
            st, data, _, _ = self.login("wrong-code-here")
            self.assertEqual(st, 401)
        st, data, _, _ = self.login()
        self.assertEqual(st, 429)

    def test_подделанная_и_истёкшая_cookie(self):
        _, _, cookie, _ = self.login()
        name, value = cookie.split("=", 1)
        expiry, sig = value.split(".")
        forged = f"{name}={int(expiry) + 1000}.{sig}"
        self.assertEqual(self.s.req("POST", "/api/echo", {}, {"Cookie": forged})[0], 401)
        h = os.environ["SERVICE_ACCESS_CODE_HASH"]
        sec = os.environ["SERVICE_COOKIE_SECRET"]
        old = web.make_cookie_value(h, sec, now=time.time() - 91 * 86400)
        self.assertFalse(web.cookie_ok(old, h, sec))
        self.assertEqual(self.s.req("POST", "/api/echo", {}, {"Cookie": f"svc={old}"})[0], 401)
        # Новый код доступа выключает прежние cookie.
        os.environ["SERVICE_ACCESS_CODE_HASH"] = web.hash_code("other-code-now", iterations=1000)
        self.assertEqual(self.s.req("POST", "/api/echo", {}, {"Cookie": cookie})[0], 401)

    def test_stoprun_и_сбой(self):
        _, _, cookie, _ = self.login()
        st, data, _ = self.s.req("POST", "/api/stop", {}, {"Cookie": cookie})
        self.assertEqual((st, data), (400, {"error": "Нет файла с продажами"}))
        st, data, _ = self.s.req("POST", "/api/boom", {}, {"Cookie": cookie})
        self.assertEqual(st, 500)
        self.assertNotIn("секретная", json.dumps(data, ensure_ascii=False))

    def test_пределы_тела_и_файл(self):
        _, _, cookie, _ = self.login()
        # Размер из заголовка больше предела: сервер отвечает 413, тело не читает.
        big = {"Cookie": cookie, "Content-Type": "application/json", "Content-Length": str(web.JSON_LIMIT + 10)}
        self.assertEqual(self.s.req("POST", "/api/echo", b"{}", big)[0], 413)
        st, data, _ = self.s.req("POST", "/api/echo", b"PK\x03\x04data", {
            "Cookie": cookie, "Content-Type": "application/octet-stream", "X-File-Name": "%D0%9F%D1%80%D0%BE%D0%B4%D0%B0%D0%B6%D0%B8.xlsx"})
        self.assertEqual(st, 200)
        self.assertEqual(data["file"], {"name": "Продажи.xlsx", "size": 8})
        huge = {"Cookie": cookie, "Content-Type": "application/octet-stream", "Content-Length": str(web.FILE_LIMIT + 1)}
        self.assertEqual(self.s.req("POST", "/api/echo", b"x", huge)[0], 413)
        self.assertEqual(self.s.req("POST", "/api/echo", b"[1]", {"Cookie": cookie, "Content-Type": "application/json"})[0], 400)

    def test_без_хэша_503(self):
        del os.environ["SERVICE_ACCESS_CODE_HASH"]
        self.assertEqual(self.s.req("POST", "/api/echo", {})[0], 503)
        self.assertEqual(self.login()[0], 503)
        self.assertEqual(self.s.req("GET", "/api/health")[0], 200)

    def test_маршрут_через_index(self):
        # Vercel может передать путь функции как /api/index?route=<действие>.
        self.assertEqual(self.s.req("GET", "/api/index?route=health")[0], 200)

    def test_код_и_хэш(self):
        h = web.hash_code(CODE)
        self.assertTrue(h.startswith("pbkdf2$200000$"))
        self.assertTrue(web.check_code("RIVER LAMP SUN", h))
        self.assertFalse(web.check_code("river-lamp-moon", h))
        self.assertFalse(web.check_code(CODE, "мусор"))

    def test_имена_действий(self):
        with self.assertRaises(ValueError):
            web.serve({"Плохо": lambda d, f: {}})
        with self.assertRaises(ValueError):
            web.serve({"login": lambda d, f: {}})


if __name__ == "__main__":
    unittest.main()
