"""Действия сервиса для страницы public/index.html. На Vercel это вход в сервис, на компьютере его запускает
lib/web_dev.py. Сервер, код доступа и подключение к базе в lib/ (их кладёт кабинет): здесь только действия.

Действие: функция fn(data, file) -> словарь. data: что прислала страница (JSON), file: загруженный файл
({"name": ..., "data": байты}) или None. Понятная ошибка для человека: raise StopRun("текст").
SQL только с параметрами: query("... where id = %s", (id,)), никогда склейкой строк.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from web import serve, StopRun, read_upload  # noqa: E402
from db import query, execute, insert_rows  # noqa: E402


def zapisi(data, file):
    """Список записей для таблицы на странице."""
    rows = query("select id, nazvanie, summa, sozdano from app.zapisi order by id desc limit 200")
    return {
        "columns": ["№", "Название", "Сумма", "Создано"],
        "rows": [[r["id"], r["nazvanie"], r["summa"], r["sozdano"]] for r in rows],
    }


def dobav(data, file):
    """Новая запись из формы на странице."""
    nazvanie = str(data.get("nazvanie", "")).strip()
    if not nazvanie:
        raise StopRun("Напишите название")
    try:
        summa = float(str(data.get("summa", "0")).replace(" ", "").replace(",", ".") or 0)
    except ValueError:
        raise StopRun("Сумма должна быть числом")
    execute("insert into app.zapisi (nazvanie, summa) values (%s, %s)", (nazvanie[:200], summa))
    return {"ok": True}


def zagruzka(data, file):
    """Загрузка Excel: строки файла в таблицу. Файл нигде не хранится."""
    table = read_upload(file)
    cols = [str(c).strip().lower() for c in table["columns"]]
    if "название" not in cols or "сумма" not in cols:
        raise StopRun("В файле нужны столбцы «Название» и «Сумма»")
    i, j = cols.index("название"), cols.index("сумма")
    rows = []
    for r in table["rows"]:
        name = str(r[i]).strip() if i < len(r) else ""
        if not name:
            continue
        try:
            summa = float(str(r[j]).replace(" ", "").replace(",", ".")) if j < len(r) and str(r[j]).strip() else 0
        except ValueError:
            raise StopRun(f"Сумма «{r[j]}» у «{name}» не число")
        rows.append([name[:200], summa])
    return {"added": insert_rows("app.zapisi", ["nazvanie", "summa"], rows)}


# Vercel ищет в файле класс с именем handler: именно так, классом, а не строкой handler = ...
class handler(serve({"zapisi": zapisi, "dobav": dobav, "zagruzka": zagruzka})):
    """Вход сервиса: Vercel и lib/web_dev.py берут отсюда все действия."""
