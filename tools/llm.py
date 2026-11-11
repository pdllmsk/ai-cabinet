"""Модель (Claude) внутри сервисов кабинета: через этот модуль, с записью обращений в журнал кабинета.

Правила компании разрешают отправлять в модель данные как есть: персональные и коммерческие данные не
фильтруются. Не пропускается только слишком большой объём (больше MAX_CHARS знаков).
Модель зовётся через Claude Code командной строки на этом компьютере (`claude -p`, от подписки человека,
без ключей), в пустой временной папке и без инструментов: модель не видит файлов кабинета.

    python tools/llm.py status            есть ли на компьютере Claude для сервисов
    python tools/llm.py check <файл>      пройдёт ли текст файла по объёму

В программе процесса: `import llm` (как `read_table`), затем `llm.ask(инструкция, данные)`.
"""
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

__all__ = ["check", "ask", "available", "LLMBlocked", "LLMUnavailable"]

TIMEOUT = 120
MAX_CHARS = 60000


class LLMBlocked(Exception):
    """Запрос не отправлен в модель: слишком большой объём."""


class LLMUnavailable(Exception):
    """На этом компьютере нет Claude для сервисов (или он не вошёл в учётку)."""


def check(text):
    """Находки проверки: список строк с причиной. Пустой список: можно отправлять. Проверяется только объём."""
    text = text or ""
    found = []
    if len(text) > MAX_CHARS:
        found.append(f"слишком большой объём: {len(text)} знаков (больше {MAX_CHARS})")
    return found


def _journal(ok, chars, reason=""):
    """Строка в журнал кабинета (файл даёт кабинет переменной CABINET_JOURNAL): было ли обращение к модели,
    ушёл ли запрос и сколько знаков. Сам текст в журнал не пишется. Нет переменной или не записалось: молча."""
    path = os.environ.get("CABINET_JOURNAL")
    if not path:
        return
    try:
        user = getpass.getuser()
    except Exception:
        user = ""
    line = {"at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "user": user,
            "service": os.environ.get("CABINET_SERVICE", ""), "event": "model", "ok": ok, "chars": chars}
    if reason:
        line["reason"] = reason
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _find_claude():
    path = os.environ.get("AI_CABINET_CLAUDE")
    if path and os.path.isfile(path):
        return path
    for name in ("claude", "claude.exe", "claude.cmd"):
        found = shutil.which(name)
        if found:
            return found
    return None


def available():
    """Путь к Claude командной строки или None."""
    return _find_claude()


def ask(prompt, payload="", model="sonnet", timeout=TIMEOUT):
    """Ответ модели текстом. Слишком большой объём: LLMBlocked, ничего не отправлено."""
    found = check(f"{prompt}\n{payload}")
    chars = len(prompt or "") + len(payload or "")
    if found:
        _journal(False, chars, "проверка: " + "; ".join(found))
        raise LLMBlocked("Запрос не отправлен в модель: " + "; ".join(found)
                         + ". Отправьте меньше данных: нужные столбцы, строки или итоги.")
    exe = _find_claude()
    if not exe:
        _journal(False, chars, "нет Claude для сервисов")
        raise LLMUnavailable("На этом компьютере нет Claude командной строки для сервисов. "
                             "Задайте вопрос Claude во вкладке Code.")
    args = [exe, "-p", "--model", model, "--output-format", "text", "--tools", "", "--strict-mcp-config",
            "--setting-sources", "project,local"]
    if exe.lower().endswith((".cmd", ".bat")):
        args = [os.environ.get("COMSPEC", "cmd.exe"), "/c"] + args
    text = prompt if not payload else f"{prompt}\n\n{payload}"
    _journal(True, chars)
    with tempfile.TemporaryDirectory(prefix="cabinet-llm-") as empty:
        try:
            r = subprocess.run(args, input=text, capture_output=True, encoding="utf-8", errors="replace",
                               cwd=empty, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise LLMUnavailable(f"Claude не ответил за {timeout} секунд. Попробуйте ещё раз или задайте вопрос во вкладке Code.")
        except OSError as e:
            raise LLMUnavailable(f"Не удалось запустить Claude: {e}. Задайте вопрос во вкладке Code.")
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip().splitlines()
        first = err[0] if err else f"код {r.returncode}"
        if re.search(r"log ?in|auth|credential|войд", first, re.I):
            raise LLMUnavailable(f"Claude на этом компьютере не вошёл в учётку: {first}. Задайте вопрос во вкладке Code.")
        raise LLMUnavailable(f"Claude ответил ошибкой: {first}")
    return (r.stdout or "").strip()


def main(argv):
    if len(argv) >= 1 and argv[0] == "status":
        exe = _find_claude()
        print(f"Claude для сервисов: {exe}" if exe else "Claude для сервисов на этом компьютере не найден: вопросы задавайте во вкладке Code.")
        return 0
    if len(argv) == 2 and argv[0] == "check":
        try:
            with open(argv[1], encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError as e:
            print(f"Файл не читается: {e}")
            return 2
        found = check(text)
        print("Проверка: можно отправлять." if not found else "Не отправится: " + "; ".join(found))
        return 0 if not found else 1
    print(__doc__.strip().splitlines()[0])
    print("Команды: status | check <файл>")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
