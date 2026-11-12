"""Сервис вида web на этом компьютере: та же страница public/ и те же действия api/index.py, что на Vercel.

Запуск из папки проекта: python lib/web_dev.py [--port N]  (на Mac python3). Его же запускает
node "<кабинет>/tools/web.mjs" dev и кнопка «Показать на компьютере» в кабинете.
Ключи берутся из .env проекта в окружение этой программы, на экран не печатаются.
Страница только для этого компьютера: адрес 127.0.0.1. Остановить: Ctrl+C или закрыть окно.
"""
import importlib.util
import os
import socket
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

LIB = Path(__file__).resolve().parent
PROJECT = LIB.parent
PUBLIC = PROJECT / "public"
PORTS = range(8700, 8800)
TYPES = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
}


def read_env(path):
    """Строки ИМЯ=значение из .env в окружение (уже заданные переменные не меняются)."""
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return []
    keys = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        key = key.strip()
        if sep and key and key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")
            keys.append(key)
    return keys


def load_handler():
    sys.path.insert(0, str(LIB))
    entry = PROJECT / "api" / "index.py"
    spec = importlib.util.spec_from_file_location("service_api_index", entry)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    handler = getattr(mod, "handler", None)
    if handler is None:
        raise SystemExit("В api/index.py нет класса handler: class handler(serve({...})): скажите Claude «почини сервис».")
    return handler


def static_file(path):
    """Файл из public/ по адресу или None: без «..», скрытых файлов и ссылок наружу."""
    rel = unquote(urlsplit(path).path).lstrip("/")
    if rel == "" or rel.endswith("/"):
        rel += "index.html"
    parts = rel.split("/")
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        return None
    f = (PUBLIC / Path(*parts)).resolve()
    try:
        f.relative_to(PUBLIC.resolve())
    except ValueError:
        return None
    return f if f.is_file() else None


def make_dev_handler(base):
    class Dev(base):
        def _static(self):
            f = static_file(self.path)
            if f is None:
                body = "Такой страницы нет".encode("utf-8")
                self.send_response(404)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
                return
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", TYPES.get(f.suffix.lower(), "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            if urlsplit(self.path).path.startswith("/api/"):
                return super().do_GET()
            return self._static()

        def do_HEAD(self):
            return self.do_GET()

    return Dev


def free_port():
    for port in PORTS:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("Все адреса 8700-8799 на этом компьютере заняты: закройте другие страницы сервисов.")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    port = None
    if "--port" in argv:
        try:
            port = int(argv[argv.index("--port") + 1])
        except (IndexError, ValueError):
            raise SystemExit("Укажите номер после --port, например --port 8701")
    read_env(PROJECT / ".env")
    os.environ["WEB_DEV"] = "1"
    os.chdir(PROJECT)
    if os.environ.get("WEB_DB_FAKE") == "1":
        import db
        for sql in sorted((PROJECT / "db").glob("*.sql")):
            db.fake_migrate(sql.read_text(encoding="utf-8"))
    server = ThreadingHTTPServer(("127.0.0.1", port or free_port()), make_dev_handler(load_handler()))
    server.daemon_threads = True
    print(f"Страница работает: http://127.0.0.1:{server.server_address[1]}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
