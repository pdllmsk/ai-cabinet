"""Светофор точек продаж: демо-процесс тренера на учебном кейсе Birinshi Lombard.

Читает все выгрузки продаж 1С (.csv) из input/svetofor-tochek/: столбцы «Дата», «Точка» и «Сумма».
Берёт последние 7 дней в данных и 7 дней перед ними, считает выручку каждой точки за обе недели
(возвраты из выгрузки уменьшают выручку), изменение, число продаж и средний чек последней недели
и кладёт в output/svetofor-tochek/:
  result.json   карточка процесса на странице «Мой кабинет»;
  svetofor.xlsx тот же список для Excel.

Красный: выручка упала больше чем на 20%. Жёлтый: упала на 5-20%. Зелёный: упала меньше чем на 5% или выросла.
У точки есть дни без продаж в одной из недель: «нет данных» (серый): падение может быть из-за пропуска в выгрузке.
Новая точка (продаж в первой неделе нет): пометка без цвета.
Недели берутся из дат в файлах, а не из даты компьютера: новая выгрузка рядом со старой даёт следующую неделю.

Запуск из папки кабинета: python processes/svetofor-tochek/run.py
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

SLUG = "svetofor-tochek"
TITLE = "Светофор точек продаж"
INPUT_EXAMPLE = "prodazhi_1c.csv"
RED_DROP = 20
YELLOW_DROP = 5

NOTES = {"red": f"упала больше {RED_DROP}%", "yellow": f"упала на {YELLOW_DROP}-{RED_DROP}%", "green": "в порядке",
         "grey": "нет данных", "info": "новая точка"}
ORDER = {"red": 0, "yellow": 1, "grey": 2, "green": 3, "info": 4}
FILLS = {"red": "FDECEB", "yellow": "FFF3D4", "green": "E8F5EB", "grey": "ECEEF1"}
# Столбец → как он называется в выгрузке (часть названия, без учёта регистра).
SOURCE = {"Дата": "дата", "Точка": "точка", "Сумма": "сумма"}

NO_OPENPYXL = "Не найдена библиотека openpyxl для Excel. Скажите Claude «проверь сетап»."


class StopRun(Exception):
    """Понятная человеку причина остановки: печатается по-русски, код выхода 2 (3: файл занят Excel)."""

    def __init__(self, message, code=2):
        super().__init__(message)
        self.code = code


def find_root():
    """Корень кабинета: ближайшая папка выше этого файла, где лежит tools/read_table.py."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "tools" / "read_table.py").is_file():
            return parent
    raise StopRun("Не найден tools/read_table.py: программа процесса должна лежать в папке кабинета.")


def load_reader():
    """tools/read_table.py: та же логика кодировок, шапок, чисел и дат, что и у просмотра таблиц в кабинете."""
    tools = str(find_root() / "tools")
    if tools not in sys.path:
        sys.path.insert(0, tools)
    import read_table
    return read_table


def norm(text):
    return re.sub(r"\s+", " ", str(text)).strip().lower()


def read_sales(paths):
    """Строки всех выгрузок: (дата, точка, сумма). Строки без даты, точки или суммы пропускаются."""
    rt = load_reader()
    sales = []
    for path in paths:
        try:
            data = rt.analyze(Path(path), None, 10 ** 6)
        except rt.UserError as e:
            raise StopRun(f"{Path(path).name}: {e}")
        cols = [norm(c) for c in data["columns"]]
        idx = {name: next((i for i, c in enumerate(cols) if wanted in c), None) for name, wanted in SOURCE.items()}
        if any(i is None for i in idx.values()):
            raise StopRun(f"В файле {Path(path).name} нет столбцов «Дата», «Точка» и «Сумма». "
                          "Нужна выгрузка продаж из 1С по точкам.")
        for row in data["rows"]:
            day = rt.to_date(row[idx["Дата"]])
            amount = rt.to_number(row[idx["Сумма"]])
            point = row[idx["Точка"]].strip()
            if day is None or amount is None or not point:
                continue
            sales.append((day, point, amount))
    if not sales:
        raise StopRun("В выгрузках нет ни одной строки с датой, точкой и суммой.")
    return sales


def evaluate(paths):
    """Точки со статусом по срочности (красные, жёлтые, без данных, зелёные, новые) и две недели расчёта."""
    sales = read_sales(paths)
    last = max(d for d, _, _ in sales)
    b0 = last - timedelta(days=6)
    a0 = b0 - timedelta(days=7)
    weeks = {"a": (a0, b0 - timedelta(days=1)), "b": (b0, last)}
    points = {}
    for day, point, amount in sales:
        if not a0 <= day <= last:
            continue
        p = points.setdefault(point, {"a": 0.0, "b": 0.0, "count": 0, "days": {"a": set(), "b": set()}})
        w = "b" if day >= b0 else "a"
        p[w] += amount
        p["days"][w].add(day)
        if w == "b" and amount > 0:
            p["count"] += 1
    items = []
    for n, (point, p) in enumerate(points.items()):
        a, b = round(p["a"], 2), round(p["b"], 2)
        pct = round((b - a) / a * 100, 1) if a > 0 else None
        gaps = [weeks[w][0] + timedelta(days=i) for w in ("a", "b") for i in range(7)
                if weeks[w][0] + timedelta(days=i) not in p["days"][w]]
        if not p["days"]["a"]:
            status, note = "info", NOTES["info"]
        elif gaps:
            status, note = "grey", "нет данных за " + ", ".join(f"{d:%d.%m}" for d in gaps)
        else:
            status = "red" if pct <= -RED_DROP else "yellow" if pct <= -YELLOW_DROP else "green"
            note = NOTES[status]
        items.append({"point": point, "a": a, "b": b, "pct": pct, "count": p["count"],
                      "avg": round(b / p["count"], 2) if p["count"] else None,
                      "status": status, "note": note, "n": n})
    items.sort(key=lambda x: (ORDER[x["status"]], x["pct"] if x["pct"] is not None else 0, x["n"]))
    return items, weeks


def period(week):
    return f"{week[0]:%d.%m}-{week[1]:%d.%m.%Y}"


def columns_for(weeks):
    return ["Точка", f"Выручка {period(weeks['a'])}, тг", f"Выручка {period(weeks['b'])}, тг",
            "Изменение, %", "Продаж за неделю", "Средний чек, тг"]


def row_values(item):
    return [item["point"], item["a"], item["b"], item["pct"], item["count"], item["avg"]]


def result_from(items, weeks):
    count = {s: sum(1 for x in items if x["status"] == s) for s in ORDER}
    status = "red" if count["red"] else "yellow" if count["yellow"] else "green"
    summary = (
        f"Неделя {period(weeks['b'])} к неделе {period(weeks['a'])}, точек {len(items)}. "
        f"Выручка упала больше {RED_DROP}%: {count['red']}. Упала на {YELLOW_DROP}-{RED_DROP}%: {count['yellow']}. "
        f"В порядке: {count['green']}. Нет данных за часть дней: {count['grey']}. Новые точки: {count['info']}."
    )
    return {
        "title": TITLE,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": status,
        "summary": summary,
        "columns": columns_for(weeks),
        "rows": [row_values(x) for x in items],
        "row_status": [x["status"] for x in items],
        "row_note": [x["note"] for x in items],
        "files": [f"output/{SLUG}/svetofor.xlsx"],
    }


def build_result(paths):
    return result_from(*evaluate(paths))


def replace_file(tmp, target):
    """Запись через временный файл: страница не увидит половину файла. Файл открыт в Excel: понятная ошибка."""
    try:
        os.replace(tmp, target)
    except PermissionError:
        tmp.unlink(missing_ok=True)
        raise StopRun(f"Файл output/{SLUG}/{target.name} открыт в другой программе. "
                      "Закройте его в Excel и запустите расчёт снова.", code=3)


def write_excel(items, weeks, target):
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill
    except ImportError:
        raise StopRun(NO_OPENPYXL)
    wb = Workbook()
    ws = wb.active
    ws.title = "Светофор"
    ws.append(columns_for(weeks) + ["Статус"])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for item in items:
        ws.append(row_values(item) + [item["note"]])
        fill = FILLS.get(item["status"])
        for i, cell in enumerate(ws[ws.max_row]):
            if fill:
                cell.fill = PatternFill("solid", fgColor=fill)
            if i in (1, 2, 5):
                cell.number_format = "# ##0"
    for letter, width in zip("ABCDEFG", (34, 24, 24, 14, 16, 18, 28)):
        ws.column_dimensions[letter].width = width
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    tmp = target.with_name(target.name + ".tmp")
    wb.save(tmp)
    replace_file(tmp, target)


def write_json(result, target):
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    replace_file(tmp, target)


def main():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    try:
        root = find_root()
        src = root / "input" / SLUG
        paths = sorted(p for p in src.glob("*.csv") if p.is_file()) if src.is_dir() else []
        if not paths:
            raise StopRun(f"Нет выгрузки продаж в папке input/{SLUG}. Положите туда файл .csv из 1С, например "
                          f"{INPUT_EXAMPLE} (учебный файл лежит в input/case/data), и запустите расчёт снова.")
        items, weeks = evaluate(paths)
        result = result_from(items, weeks)
        out = root / "output" / SLUG
        out.mkdir(parents=True, exist_ok=True)
        write_excel(items, weeks, out / "svetofor.xlsx")
        write_json(result, out / "result.json")
    except StopRun as e:
        print(str(e), file=sys.stderr)
        return e.code
    print(result["summary"])
    print(f"Готово: output/{SLUG}/result.json и output/{SLUG}/svetofor.xlsx")
    return 0


if __name__ == "__main__":
    sys.exit(main())
