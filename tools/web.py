"""Сервер сервиса вида web: адреса /api, код доступа, ответ JSON. Кабинет кладёт этот файл в lib/ проекта.

Студент пишет только функции-действия в api/index.py:

    from web import serve, StopRun, read_upload
    from db import query

    def tochki(data, file):
        return {"rows": query("select tochka, vyruchka from tochki order by vyruchka desc")}

    class handler(serve({"tochki": tochki})):  # Vercel ищет класс handler
        pass

Адреса:
    GET  /api/health          {"ok": true}, без кода доступа
    POST /api/login           {"code": "..."}: верный код ставит cookie на 90 дней
    POST /api/<действие>      только с cookie; тело JSON (до 1 МБ) или файл (до 4 МБ, заголовок X-File-Name);
                              функция действия fn(data, file) возвращает словарь, он уходит ответом JSON

Код доступа: в окружении SERVICE_ACCESS_CODE_HASH (pbkdf2$200000$<соль>$<хэш>, пишет web.mjs code) и
SERVICE_COOKIE_SECRET (подпись cookie). Нет их: сервис отвечает 503 и данных не отдаёт.
Локально (WEB_DEV=1, lib/web_dev.py) cookie без Secure: страница открывается по http://127.0.0.1.
"""
import datetime as _dt
import decimal
import hashlib
import hmac
import json
import os
import re
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

LIB = Path(__file__).resolve().parent
sys.path.insert(0, str(LIB / "vendor"))

COOKIE = "svc"
COOKIE_DAYS = 90
JSON_LIMIT = 1024 * 1024
FILE_LIMIT = 4 * 1024 * 1024
ACTION_RE = re.compile(r"^[a-z0-9-]{1,40}$")
LOGIN_FAILS = 10
LOGIN_WINDOW = 600
PBKDF2_ITER = 200000

_fails = {}
_fails_lock = threading.Lock()


class StopRun(Exception):
    """Понятная человеку причина: ответ 400 {"error": "<текст>"}."""


# ---------- код доступа и cookie ----------

def norm_code(code):
    """Код из трёх слов: без учёта регистра, пробелы и подчёркивания как дефис."""
    return "-".join(re.split(r"[\s_\-]+", str(code or "").strip().lower())).strip("-")


def hash_code(code, salt=None, iterations=PBKDF2_ITER):
    salt = salt or os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac("sha256", norm_code(code).encode("utf-8"), salt.encode("ascii"), iterations)
    return f"pbkdf2${iterations}${salt}${dk.hex()}"


def check_code(code, stored):
    try:
        kind, iters, salt, want = str(stored).split("$")
        iters = int(iters)
    except ValueError:
        return False
    if kind != "pbkdf2" or iters < 1000:
        return False
    got = hashlib.pbkdf2_hmac("sha256", norm_code(code).encode("utf-8"), salt.encode("ascii"), iters).hex()
    return hmac.compare_digest(got, want)


def _secrets():
    code_hash = os.environ.get("SERVICE_ACCESS_CODE_HASH", "").strip()
    secret = os.environ.get("SERVICE_COOKIE_SECRET", "").strip()
    return (code_hash, secret) if code_hash and secret else (None, None)


def _sign(expiry, code_hash, secret):
    # Подпись зависит от хэша кода: «смени код доступа» выключает старые cookie.
    msg = f"{expiry}|{code_hash}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def make_cookie_value(code_hash, secret, now=None):
    expiry = int((now if now is not None else time.time()) + COOKIE_DAYS * 86400)
    return f"{expiry}.{_sign(expiry, code_hash, secret)}"


def cookie_ok(value, code_hash, secret, now=None):
    try:
        expiry_s, sig = str(value).split(".", 1)
        expiry = int(expiry_s)
    except ValueError:
        return False
    if expiry < (now if now is not None else time.time()):
        return False
    return hmac.compare_digest(sig, _sign(expiry, code_hash, secret))


def _too_many(ip, now):
    with _fails_lock:
        recent = [t for t in _fails.get(ip, []) if now - t < LOGIN_WINDOW]
        _fails[ip] = recent
        return len(recent) >= LOGIN_FAILS


def _fail(ip, now):
    with _fails_lock:
        _fails.setdefault(ip, []).append(now)


def reset_limits():
    """Для тестов: забыть ошибки входа."""
    with _fails_lock:
        _fails.clear()


# ---------- ответ JSON ----------

def _jsonable(v):
    if isinstance(v, decimal.Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray, memoryview)):
        return None
    if isinstance(v, (set, tuple)):
        return list(v)
    return str(v)


def to_json(data):
    return json.dumps(data, ensure_ascii=False, default=_jsonable, allow_nan=False).encode("utf-8")


# ---------- загрузка Excel ----------

def read_upload(file, sheet=None, limit=10 ** 6):
    """Таблица из загруженного файла (Excel или CSV): {"columns": [...], "rows": [[текст, ...]], ...}.
    Файл нигде не сохраняется: временная копия удаляется сразу после чтения."""
    if not file or not file.get("data"):
        raise StopRun("Файл не пришёл: выберите файл Excel или CSV и загрузите снова")
    try:
        import read_table
    except ImportError:
        raise StopRun("В папке lib нет read_table.py: скажите Claude в кабинете «обнови кабинет»")
    suffix = Path(file.get("name") or "file.xlsx").suffix.lower() or ".xlsx"
    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(file["data"])
        try:
            return read_table.analyze(Path(tmp), sheet, limit)
        except read_table.UserError as e:
            raise StopRun(str(e))
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


# ---------- сервер ----------

def _close_db():
    db = sys.modules.get("db")
    if db is not None and hasattr(db, "close"):
        try:
            db.close()
        except Exception:
            pass


def serve(actions):
    """Класс обработчика запросов для Vercel (handler в api/index.py) и для lib/web_dev.py."""
    for name, fn in actions.items():
        if not ACTION_RE.match(name) or name in ("health", "login") or not callable(fn):
            raise ValueError(f"действие {name!r}: имя из строчных латинских букв, цифр и дефиса, функция fn(data, file)")
    table = dict(actions)

    class handler(BaseHTTPRequestHandler):
        server_version = "service"
        sys_version = ""

        def log_message(self, fmt, *args):  # журнал Vercel и окно web_dev: только ошибки
            pass

        # -- ответы --
        def _send(self, status, data, cookie=None):
            body = to_json(data)
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if cookie:
                self.send_header("Set-Cookie", cookie)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _route(self):
            parts = urlsplit(self.path)
            path = unquote(parts.path)
            route = path[len("/api/"):] if path.startswith("/api/") else None
            if route in ("index", "index.py", ""):
                route = (parse_qs(parts.query).get("route") or [route])[0]
            return route, parts.query

        def _ip(self):
            fwd = self.headers.get("X-Forwarded-For", "")
            return fwd.split(",")[0].strip() if fwd else (self.client_address[0] if self.client_address else "?")

        def _cookie(self):
            raw = self.headers.get("Cookie", "")
            for part in raw.split(";"):
                k, sep, v = part.strip().partition("=")
                if sep and k == COOKIE:
                    return v
            return None

        def _read(self, limit):
            try:
                size = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                size = -1
            if size < 0 or size > limit:
                return None
            return self.rfile.read(size) if size else b""

        # -- методы --
        def do_GET(self):
            route, _ = self._route()
            try:
                if route == "health":
                    return self._send(200, {"ok": True})
                if route is None:
                    return self._send(404, {"error": "Такой страницы нет"})
                return self._send(405, {"error": "Действия сервиса вызываются запросом POST"})
            finally:
                _close_db()

        do_HEAD = do_GET

        def do_POST(self):
            try:
                self._post()
            except Exception:
                traceback.print_exc(file=sys.stderr)
                try:
                    self._send(500, {"error": "Сбой сервиса, подробности в журнале"})
                except Exception:
                    pass
            finally:
                _close_db()

        def _post(self):
            route, query = self._route()
            if route is None:
                return self._send(404, {"error": "Такой страницы нет"})
            code_hash, secret = _secrets()
            if route == "login":
                return self._login(code_hash, secret)
            if not ACTION_RE.match(route or ""):
                return self._send(404, {"error": "Такого действия у сервиса нет"})
            if not code_hash:
                return self._send(503, {"error": "Сервис не настроен: нет кода доступа"})
            if not cookie_ok(self._cookie(), code_hash, secret):
                return self._send(401, {"error": "Нужен код доступа"})
            if route not in table:
                return self._send(404, {"error": "Такого действия у сервиса нет"})
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            file = None
            data = {k: v[0] for k, v in parse_qs(query).items()}
            if ctype == "application/octet-stream":
                body = self._read(FILE_LIMIT)
                if body is None:
                    return self._send(413, {"error": "Файл больше 4 МБ: сохраните в Excel только нужный лист и загрузите снова"})
                name = unquote(self.headers.get("X-File-Name") or "") or "file"
                file = {"name": Path(name.replace("\\", "/")).name, "data": body}
            else:
                body = self._read(JSON_LIMIT)
                if body is None:
                    return self._send(413, {"error": "Слишком большой запрос (больше 1 МБ)"})
                if body.strip():
                    try:
                        parsed = json.loads(body.decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        return self._send(400, {"error": "Запрос не в формате JSON"})
                    if not isinstance(parsed, dict):
                        return self._send(400, {"error": "Нужен объект JSON"})
                    data.update(parsed)
            try:
                out = table[route](data, file)
            except StopRun as e:
                return self._send(400, {"error": str(e)})
            if out is None:
                out = {"ok": True}
            if not isinstance(out, dict):
                raise TypeError(f"действие {route} вернуло {type(out).__name__}, а нужен словарь")
            return self._send(200, out)

        def _login(self, code_hash, secret):
            if not code_hash:
                return self._send(503, {"error": "Сервис не настроен: нет кода доступа"})
            ip = self._ip()
            now = time.time()
            if _too_many(ip, now):
                return self._send(429, {"error": "Слишком много попыток. Подождите 10 минут"})
            body = self._read(4096)
            try:
                code = json.loads((body or b"{}").decode("utf-8")).get("code", "")
            except (ValueError, UnicodeDecodeError, AttributeError):
                code = ""
            if not check_code(code, code_hash):
                _fail(ip, now)
                return self._send(401, {"error": "Код не подходит"})
            secure = "" if os.environ.get("WEB_DEV") == "1" else "; Secure"
            cookie = f"{COOKIE}={make_cookie_value(code_hash, secret)}; Path=/; HttpOnly{secure}; SameSite=Lax; Max-Age={COOKIE_DAYS * 86400}"
            return self._send(200, {"ok": True}, cookie=cookie)

    return handler
