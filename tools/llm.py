"""Модель (Claude) внутри сервисов кабинета: только через этот модуль, с проверкой данных перед отправкой.

Сервисы кабинета могут использовать модель, но всё, что уходит в модель, сначала проверяется
на персональные и чувствительные данные. Нашлось: ничего не отправляется, человек видит причину.
Модель зовётся через Claude Code командной строки на этом компьютере (`claude -p`, от подписки человека,
без ключей), в пустой временной папке и без инструментов: модель не видит файлов кабинета.

    python tools/llm.py status            есть ли на компьютере Claude для сервисов
    python tools/llm.py check <файл>      что нашла бы проверка в тексте файла (сами значения не печатаются)

В программе процесса: `import llm` (как `read_table`), затем `llm.ask(инструкция, данные)`.
Строки файлов человека в модель не отправляйте: передавайте устройство данных и итоги.
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

UP = "А-ЯЁӘҒҚҢӨҰҮҺІ"
LOW = "а-яёәғқңөұүһі"
SURNAME_END = r"(?:ов|ев|ёв|ин|ын|ова|ева|ёва|ина|ына|ский|ская|цкий|цкая|енко|ук|юк|ко|ич|ян|ли|ұлы|қызы|бекова|беков)"


class LLMBlocked(Exception):
    """В данных для модели нашлись персональные или чувствительные данные: ничего не отправлено."""


class LLMUnavailable(Exception):
    """На этом компьютере нет Claude для сервисов (или он не вошёл в учётку)."""


PATTERNS = [
    ("ИИН или БИН", re.compile(r"(?<!\d)\d{12}(?!\d)")),
    ("телефон", re.compile(r"(?<![\d.,])(?:\+7|8)[\s\-(]{0,2}7\d{2}[\s\-)]{0,2}\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?![\d.,])")),
    ("e-mail", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")),
    ("IBAN", re.compile(r"\bKZ\d{2}[0-9A-Z]{16}\b", re.I)),
    ("номер карты", re.compile(r"(?<![\d.,])(?:\d{4}[ \-]){3}\d{4}(?![\d.,])")),
    ("ФИО", re.compile(rf"(?<![{UP}{LOW}])[{UP}][{LOW}]+{SURNAME_END}\s+[{UP}][{LOW}]{{2,}}(?:\s+[{UP}][{LOW}]+(?:вич|вна|ична|ұлы|қызы))?(?![{LOW}])")),
    ("ФИО с инициалами", re.compile(rf"(?<![{UP}{LOW}])[{UP}][{LOW}]{{2,}}\s+[{UP}]\.\s?[{UP}]\.")),
]

# Похоже на строки таблицы: много строк подряд с разделителями и числами. Модели нужны устройство и итоги.
ROW_LINE = re.compile(r"^(?:[^\n;|\t]*[;|\t]){2,}[^\n]*\d")
ROWS_LIMIT = 40


def check(text):
    """Находки проверки: список строк вида «телефон: 2». Пустой список: можно отправлять."""
    text = text or ""
    found = []
    for name, rx in PATTERNS:
        n = len(rx.findall(text))
        if n:
            found.append(f"{name}: {n}")
    rows = sum(1 for line in text.splitlines() if ROW_LINE.match(line))
    if rows > ROWS_LIMIT:
        found.append(f"строки таблицы: {rows} (в модель отправляйте устройство данных и итоги, не строки)")
    if len(text) > MAX_CHARS:
        found.append(f"слишком большой объём: {len(text)} знаков (больше {MAX_CHARS})")
    return found


def _journal(ok, chars, reason=""):
    """Строка в журнал кабинета (файл даёт кабинет переменной CABINET_JOURNAL): было ли обращение к модели,
    прошла ли проверка и сколько знаков. Сам текст в журнал не пишется. Нет переменной или не записалось: молча."""
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
    """Ответ модели текстом. Сначала проверка инструкции и данных; нашлось что-то: LLMBlocked, ничего не отправлено."""
    found = check(f"{prompt}\n{payload}")
    chars = len(prompt or "") + len(payload or "")
    if found:
        _journal(False, chars, "проверка: " + "; ".join(found))
        raise LLMBlocked("В модель ушли бы персональные или чувствительные данные: " + "; ".join(found)
                         + ". Ничего не отправлено. Обезличьте данные анонимайзером или отправьте только итоги.")
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
        print("Проверка: можно отправлять." if not found else "Проверка не пропустит: " + "; ".join(found))
        return 0 if not found else 1
    print(__doc__.strip().splitlines()[0])
    print("Команды: status | check <файл>")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
