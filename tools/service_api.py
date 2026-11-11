"""Серверная часть сервиса для его своей страницы в кабинете. Файл кладёт кабинет в lib/ проекта: не меняйте.

Своя страница (page/index.html) зовёт fetch('../api/<действие>', ...). Кабинет запускает `python api.py <действие>`
в папке проекта, запрос приходит в функцию действия, её ответ (словарь) уходит странице JSON. Пример api.py:

    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
    from service_api import serve, StopRun, save_upload, remove_file, list_files

    def upload(data, file):            # file: {"name", "path", "size"}: файл со страницы
        return {"file": save_upload(file)}

    def delete(data, file):            # data: JSON со страницы
        remove_file(data.get("name", ""))
        return {"ok": True}

    def files(data, file):
        return {"files": list_files()}

    serve({"upload": upload, "delete": delete, "files": files})

Понятная ошибка для человека: raise StopRun("...") одной строкой по-русски, страница получит её в поле error.
Действие работает только с папками input/ и output/ проекта.
"""
import json
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

__all__ = ["serve", "StopRun", "HERE", "INPUT", "OUTPUT", "save_upload", "remove_file", "list_files"]

HERE = Path.cwd()
INPUT = HERE / "input"
OUTPUT = HERE / "output"
WIN_RESERVED = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(10)} | {f"lpt{i}" for i in range(10)}


class StopRun(Exception):
    """Понятная причина одной строкой: страница покажет её человеку."""


def _fail(message, code):
    sys.stderr.write(str(message).replace("\n", " ").strip() + "\n")
    sys.stderr.flush()
    sys.exit(code)


def _folder(folder):
    base = Path(folder) if folder is not None else INPUT
    base = base if base.is_absolute() else HERE / base
    real = base.resolve()
    if real not in (INPUT.resolve(), OUTPUT.resolve()) and INPUT.resolve() not in real.parents and OUTPUT.resolve() not in real.parents:
        raise StopRun("действие работает только с папками input и output проекта")
    return real


def _clean_name(name):
    name = str(name or "").replace("\\", "/").split("/")[-1].strip()
    name = "".join(c for c in name if c >= " " and c not in '<>:"|?*')
    name = name.lstrip(". ").rstrip(". ")
    if not name or name.startswith("~$") or name.split(".")[0].lower() in WIN_RESERVED:
        raise StopRun("у файла неподходящее имя: переименуйте его и загрузите снова")
    return name[:150]


def save_upload(file, folder=None):
    """Файл, загруженный со страницы, в папку (по умолчанию input/) под своим именем; занято: «имя (2).xlsx».
    Ответ: итоговое имя."""
    if not isinstance(file, dict) or not file.get("path"):
        raise StopRun("файл не загружен: выберите файл и попробуйте снова")
    src = (HERE / str(file["path"])).resolve()
    if HERE.resolve() not in src.parents or not src.is_file():
        raise StopRun("загруженный файл не найден: попробуйте загрузить снова")
    target_dir = _folder(folder)
    target_dir.mkdir(parents=True, exist_ok=True)
    name = _clean_name(file.get("name"))
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    for n in range(1, 1000):
        candidate = name if n == 1 else (f"{stem} ({n}).{ext}" if ext else f"{stem} ({n})")
        target = target_dir / candidate
        if not target.exists():
            os.replace(src, target)
            return candidate
    raise StopRun("слишком много файлов с таким именем")


def remove_file(name, folder=None):
    """Удалить файл из папки (по умолчанию input/): только имя файла или путь внутри папки, без «..»."""
    base = _folder(folder)
    parts = str(name or "").replace("\\", "/").split("/")
    if not name or any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        raise StopRun("такой файл удалить нельзя")
    target = base.joinpath(*parts)
    if target.is_symlink() or base not in target.resolve().parents:
        raise StopRun("такой файл удалить нельзя")
    if not target.is_file():
        raise StopRun(f"файла «{name}» уже нет")
    try:
        target.unlink()
    except PermissionError:
        raise StopRun(f"файл «{name}» открыт в Excel или другой программе: закройте его и попробуйте снова")


def list_files(folder=None):
    """Файлы папки (по умолчанию input/): [{"name", "size", "modified"}], новые сверху, без скрытых."""
    base = _folder(folder)
    out = []
    if not base.is_dir():
        return out
    for p in base.rglob("*"):
        rel = p.relative_to(base)
        if any(part.startswith(".") or part.startswith("~$") for part in rel.parts) or not p.is_file() or p.is_symlink():
            continue
        st = p.stat()
        out.append({"name": rel.as_posix(), "size": st.st_size,
                    "modified": datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(timespec="seconds")})
    return sorted(out, key=lambda f: f["modified"], reverse=True)


def serve(handlers):
    """Выполнить действие из командной строки (его имя даёт кабинет) и напечатать ответ JSON."""
    route = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        # Кабинет присылает запрос в stdin; запуск руками из папки проекта (`python api.py files`) идёт без запроса.
        raw = "" if sys.stdin is None or sys.stdin.isatty() else sys.stdin.buffer.read().decode("utf-8")
        request = json.loads(raw) if raw.strip() else {}
        if not isinstance(request, dict):
            raise ValueError("не объект")
    except (ValueError, UnicodeDecodeError):
        _fail("запрос от кабинета не прочитался", 2)
    handler = handlers.get(route) if isinstance(handlers, dict) else None
    if not callable(handler):
        _fail(f"у сервиса нет действия «{route}»", 2)
    data = request.get("data") if isinstance(request.get("data"), dict) else {}
    file = request.get("file") if isinstance(request.get("file"), dict) else None
    try:
        result = handler(data, file)
        text = json.dumps({"ok": True} if result is None else result, ensure_ascii=False, allow_nan=False)
    except StopRun as e:
        _fail(e, 2)
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)
        where = f"{Path(tb[-1].filename).name}, строка {tb[-1].lineno}: " if tb else ""
        _fail(f"{where}{type(e).__name__}: {e}", 1)
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.flush()
    sys.exit(0)
