"""База сервиса: Postgres в Supabase через пул соединений. Кабинет кладёт этот файл в lib/ проекта вида web
и сервиса на компьютере с базой (поле db в service.json, фраза «подключи базу»).

Подключение из переменной DATABASE_URL (её пишет node "<кабинет>/tools/web.mjs" secret в .env проекта, на Vercel
она заведена в настройках проекта). Переменной нет в окружении (сервис на компьютере запущен кнопкой
«Запустить»): берётся из .env в папке проекта. Таблицы сервиса лежат в схеме app: роль сервиса ищет их там
сама (search_path роли), писать app.<таблица> тоже можно.

    from db import query, execute, insert_rows, transaction

    rows = query("select tochka, vyruchka from tochki where data >= %s order by vyruchka desc", (start,))
    execute("update zapisi set status = %(status)s where id = %(id)s", {"status": "готово", "id": 5})
    insert_rows("tochki", ["tochka", "vyruchka"], [["Керуен", 100], ["Мега", 200]])
    with transaction():
        execute(...)
        execute(...)

Данные пользователя попадают в SQL только параметрами (%s с кортежем или %(имя)s со словарём), никогда
склейкой строк: это проверяет node "<кабинет>/tools/web.mjs" check.

Одно подключение на запрос к сервису: lib/web.py закрывает его в конце (close()). Программа сервиса на
компьютере держит одно подключение до конца запуска.
Для тестов кабинета WEB_DB_FAKE=1: вместо Postgres sqlite в памяти (схема app убирается из имён).
"""
import os
import re
import sqlite3
import ssl
import sys
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))

CONNECT_TIMEOUT = 5
QUERY_TIMEOUT = 8
NAME_RE = re.compile(r"^[a-z_][a-z0-9_]*$")
PARAM_RE = re.compile(r"%\((\w+)\)s|%s|%%")
BATCH = 500

_con = None
_fake = None
_in_tx = False


class DbError(Exception):
    """Понятная причина: строка по-русски (web.py отдаёт её как ошибку 400 через StopRun)."""


def _stop(message):
    try:
        from web import StopRun
    except ImportError:
        raise DbError(message)
    raise StopRun(message)


def fake_mode():
    return os.environ.get("WEB_DB_FAKE") == "1"


# ---------- подключение ----------

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def _database_url():
    """DATABASE_URL из окружения, иначе строка DATABASE_URL=... из .env проекта. Значение нигде не печатается."""
    url = os.environ.get("DATABASE_URL", "").strip()
    if url:
        return url
    try:
        lines = ENV_FILE.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return ""
    for line in lines:
        key, sep, value = line.strip().partition("=")
        if sep and key.strip() == "DATABASE_URL":
            return value.strip().strip('"').strip("'")
    return ""


def _connect_pg():
    url = _database_url()
    if not url:
        _stop("База не подключена: скажите Claude «подключи базу»")
    try:
        import pg8000.native
    except ImportError:
        _stop("Нет драйвера базы в lib/vendor: скажите Claude в кабинете «обнови кабинет»")
    u = urlsplit(url)
    if u.scheme not in ("postgres", "postgresql") or not u.hostname or not u.username:
        _stop("DATABASE_URL в .env не похож на адрес базы: скажите Claude «смени ключ базы»")
    qs = parse_qs(u.query)
    # sslmode=require, как у libpq: соединение шифруется, сертификат пула не сверяется.
    ctx = ssl.create_default_context()
    if (qs.get("sslmode") or ["require"])[0] in ("require", "prefer", "allow"):
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        con = pg8000.native.Connection(
            user=unquote(u.username),
            password=unquote(u.password or ""),
            host=u.hostname,
            port=u.port or 5432,
            database=(u.path or "/postgres").lstrip("/") or "postgres",
            ssl_context=ctx,
            timeout=CONNECT_TIMEOUT,
            application_name="ai-cabinet-web",
        )
    except Exception as e:  # сеть, пароль, база на паузе
        print(f"db: не подключилась: {type(e).__name__}: {e}", file=sys.stderr)
        _stop("База не отвечает: попробуйте через минуту. Не прошло: скажите Claude «подключи базу»")
    # Дальше запросы не дольше QUERY_TIMEOUT секунд.
    try:
        con._usock.settimeout(QUERY_TIMEOUT)
    except Exception:
        pass
    return con


def _connection():
    global _con
    if fake_mode():
        return _fake_connection()
    if _con is None:
        _con = _connect_pg()
    return _con


def close():
    """Закрыть подключение (web.py зовёт в конце каждого запроса). В тестовом режиме база остаётся."""
    global _con, _in_tx
    _in_tx = False
    if _con is not None:
        try:
            _con.close()
        except Exception:
            pass
        _con = None


# ---------- параметры ----------

def _named(sql, params):
    """%s и %(имя)s в :p1 и :имя для pg8000 (sqlite: те же имена). Возвращает (sql, словарь)."""
    params = params if params is not None else ()
    if isinstance(params, dict):
        values = dict(params)
        seq = None
    elif isinstance(params, (list, tuple)):
        values = {}
        seq = list(params)
    else:
        raise TypeError("параметры запроса: кортеж (для %s) или словарь (для %(имя)s)")
    pos = [0]

    def repl(m):
        if m.group(0) == "%%":
            return "%"
        if m.group(1):
            if seq is not None:
                raise TypeError("в запросе %(имя)s, значит параметры нужны словарём")
            if m.group(1) not in values:
                raise TypeError(f"нет параметра {m.group(1)}")
            return f":{m.group(1)}"
        if seq is None:
            raise TypeError("в запросе %s, значит параметры нужны кортежем")
        if pos[0] >= len(seq):
            raise TypeError("параметров меньше, чем %s в запросе")
        pos[0] += 1
        values[f"p{pos[0]}"] = seq[pos[0] - 1]
        return f":p{pos[0]}"

    out = PARAM_RE.sub(repl, sql)
    if seq is not None and pos[0] != len(seq):
        raise TypeError("параметров больше, чем %s в запросе")
    return out, values


# ---------- запросы ----------

def _run(sql, params):
    sql2, values = _named(sql, params)
    con = _connection()
    if fake_mode():
        cur = con.execute(_fake_sql(sql2), values)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchall() if cols else []
        if not _in_tx:
            con.commit()
        return cols, rows, cur.rowcount
    rows = con.run(sql2, **values) if values else con.run(sql2)
    cols = [c["name"] for c in (con.columns or [])]
    return cols, rows or [], con.row_count


def query(sql, params=()):
    """Строки запроса списком словарей: [{"столбец": значение, ...}]."""
    cols, rows, _ = _run(sql, params)
    return [dict(zip(cols, r)) for r in rows]


def execute(sql, params=()):
    """insert, update, delete: число затронутых строк."""
    _, _, count = _run(sql, params)
    return max(count or 0, 0)


def _check_name(name, what):
    parts = str(name).split(".")
    if len(parts) > 2 or not all(NAME_RE.match(p) for p in parts):
        raise ValueError(f"{what} {name!r}: только строчные латинские буквы, цифры и _, например zapisi")
    return ".".join(parts)


def insert_rows(table, columns, rows):
    """Пакетная вставка строк: insert_rows("zapisi", ["data", "summa"], [[...], ...]). Возвращает число строк."""
    table = _check_name(table, "таблица")
    cols = [_check_name(c, "столбец") for c in columns]
    if not cols:
        raise ValueError("нужен хотя бы один столбец")
    total = 0
    rows = [list(r) for r in rows]
    for r in rows:
        if len(r) != len(cols):
            raise ValueError(f"в строке {len(r)} значений, а столбцов {len(cols)}")
    for start in range(0, len(rows), BATCH):
        chunk = rows[start:start + BATCH]
        marks = ", ".join("(" + ", ".join(["%s"] * len(cols)) + ")" for _ in chunk)
        flat = tuple(v for r in chunk for v in r)
        total += execute(f"insert into {table} ({', '.join(cols)}) values {marks}", flat)
    return total


@contextmanager
def transaction():
    """Несколько запросов целиком или никак: with transaction(): ..."""
    global _in_tx
    con = _connection()
    if _in_tx:
        yield
        return
    _in_tx = True
    try:
        if fake_mode():
            con.execute("begin")
        else:
            con.run("START TRANSACTION")
        yield
        if fake_mode():
            con.commit()
        else:
            con.run("COMMIT")
    except BaseException:
        try:
            if fake_mode():
                con.rollback()
            else:
                con.run("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        _in_tx = False


# ---------- тестовая база (WEB_DB_FAKE=1) ----------

def _fake_connection():
    global _fake
    if _fake is None:
        _fake = sqlite3.connect(":memory:", check_same_thread=False, isolation_level=None)
    return _fake


def _fake_sql(sql):
    s = re.sub(r"\bapp\.", "", sql)
    s = re.sub(r"\b(big)?serial\s+primary\s+key\b", "integer primary key", s, flags=re.I)
    s = re.sub(r"\bnow\(\)", "CURRENT_TIMESTAMP", s, flags=re.I)
    return s


def fake_migrate(sql_text):
    """Миграция db/*.sql в тестовой базе: create schema и grant пропускаются."""
    con = _fake_connection()
    sql_text = re.sub(r"--[^\n]*", "", sql_text)
    for stmt in sql_text.split(";"):
        st = stmt.strip()
        if not st or re.match(r"^(create\s+schema|grant|revoke|alter\s+default|comment\s+on)\b", st, re.I):
            continue
        con.execute(_fake_sql(st))


def fake_reset():
    """Пустая тестовая база (для тестов)."""
    global _fake
    if _fake is not None:
        _fake.close()
    _fake = None


# ---------- проверка связи ----------

def check():
    """Связь с базой и таблицы сервиса: {"ok": True, "tables": [...]} или {"ok": False, "error": "..."}.
    Ключ базы не печатается. Запуск из папки проекта: python lib/db.py check (на Mac python3)."""
    try:
        if fake_mode():
            rows = query("select name as table_name from sqlite_master where type = 'table' order by name")
        else:
            rows = query("select table_name from information_schema.tables where table_schema = 'app' order by table_name")
        return {"ok": True, "tables": [r["table_name"] for r in rows]}
    except Exception as e:  # DbError, StopRun из web.py, сбой драйвера
        return {"ok": False, "error": str(e)}
    finally:
        close()


if __name__ == "__main__":
    import json

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    if sys.argv[1:] != ["check"]:
        print("Проверка связи с базой: python lib/db.py check", file=sys.stderr)
        sys.exit(2)
    result = check()
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["ok"] else 1)
