"""Образцы программы процесса из скилла add-process: основа, словарь, шаблон Word (programma.md),
два документа Word, сверка договора с типовой формой (programma-dva-dokumenta.md).

Каждый образец собирается в программу так, как велит справка: основа, блок, пример main. Программа
запускается как программа процесса, её result.json проверяет node tools/processes.mjs list (та же схема,
что у карточки), а сверку со скиллом node tools/processes.mjs compare.

Запуск: python -m unittest discover -s tools/tests -p "test_*.py"
"""

import copy
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
ROOT = TOOLS.parent
GUIDE = ROOT / ".claude" / "skills" / "add-process" / "programma.md"
GUIDE_DVA = ROOT / ".claude" / "skills" / "add-process" / "programma-dva-dokumenta.md"
CASE = ROOT / "input" / "case" / "data"
FIXTURES = Path(__file__).resolve().parent / "fixtures"  # обращения клиентов и договоры для проверок (выдуманы)
NODE = shutil.which("node")

try:
    import openpyxl  # noqa: F401
    import docx  # noqa: F401
    HAVE_LIBS = True
except ImportError:
    HAVE_LIBS = False


def blocks():
    found = re.findall(r"```python\n(.*?)```", GUIDE.read_text(encoding="utf-8"), re.S)
    found_dva = re.findall(r"```python\n(.*?)```", GUIDE_DVA.read_text(encoding="utf-8"), re.S)
    assert len(found) == 7, f"в programma.md нужны 7 образцов, найдено {len(found)}"
    assert len(found_dva) == 2, f"в programma-dva-dokumenta.md нужны 2 образца, найдено {len(found_dva)}"
    named = {}
    for b in found + found_dva:
        if b.startswith('"""<Название процесса>'):
            named["base"] = b
        elif b.startswith("# --- Словарь"):
            named["slovar"] = b
        elif b.startswith("# --- Шаблон Word"):
            named["word"] = b
        elif b.startswith("# --- Данные из интернета"):
            named["net"] = b
        elif b.startswith("try:\n    import llm"):
            named["model"] = b
        elif "slovar = load_slovar()" in b and b.startswith("def main():"):
            named["main_slovar"] = b
        elif "fill_docx(" in b and b.startswith("def main():"):
            named["main_word"] = b
        elif b.startswith("# --- Два документа Word"):
            named["dva"] = b
        elif "two_documents(" in b and b.startswith("def main():"):
            named["main_dva"] = b
    assert len(named) == 9, f"в справке нужны 9 образцов, найдено {sorted(named)}"
    return named


def compose(*extra):
    """Основа без своего main, затем блоки и пример main перед запуском."""
    b = blocks()
    base = b["base"].replace("<имя>", "proba").replace("<Название процесса>", "Проба")
    if not extra:
        return base
    head, sep, tail = base.partition("\ndef main():")
    assert sep, "в основе нет def main()"
    run_part = tail[tail.index("\nif __name__"):]
    return head + "\n" + "\n\n".join(b[name] for name in extra) + "\n" + run_part


class Cabinet:
    def __init__(self, code):
        self.tmp = tempfile.TemporaryDirectory()
        self.cab = Path(self.tmp.name) / "Айгуль Н" / "ai-cabinet"
        shutil.copytree(TOOLS, self.cab / "tools", ignore=shutil.ignore_patterns("tests", "__pycache__"))
        self.proc = self.cab / "processes" / "proba"
        self.proc.mkdir(parents=True)
        (self.proc / "run.py").write_text(code, encoding="utf-8")
        (self.proc / "process.json").write_text(json.dumps(
            {"title": "Проба", "phrase": "запусти пробу", "kind": "script"}, ensure_ascii=False), encoding="utf-8")
        self.input = self.cab / "input" / "proba"
        self.input.mkdir(parents=True)
        self.out = self.cab / "output" / "proba"

    def close(self):
        self.tmp.cleanup()

    def run(self):
        return subprocess.run([sys.executable, str(self.proc / "run.py")], cwd=self.cab,
                              capture_output=True, encoding="utf-8")

    def result(self):
        return json.loads((self.out / "result.json").read_text(encoding="utf-8"))

    def module(self):
        """Программа как модуль: её функции для проверки по отдельности."""
        spec = importlib.util.spec_from_file_location(f"run_proba_{id(self)}", self.proc / "run.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def node(self, *args):
        r = subprocess.run([NODE, str(self.cab / "tools" / "processes.mjs"), *args], cwd=self.cab,
                           capture_output=True, encoding="utf-8")
        return r.returncode, r.stdout + r.stderr


def manual_rows(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True)
    try:
        return [list(r) for r in wb.active.iter_rows(values_only=True)]
    finally:
        wb.close()


@unittest.skipUnless(HAVE_LIBS, "нет openpyxl или python-docx")
class Base(unittest.TestCase):
    def run_base(self, rows, limit=None):
        code = compose()
        if limit is not None:
            code, n = re.subn(r"^LIMIT = .*$", f"LIMIT = {limit}", code, flags=re.M)
            self.assertEqual(n, 1, "в образце нет строки LIMIT = ...")
        c = Cabinet(code)
        self.addCleanup(c.close)
        lines = ["Точка;Сумма"] + [f"Точка-{i:02d};{i * 10}" for i in range(1, rows + 1)]
        (c.input / "sales.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
        proc = c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return c, c.result()

    def test_all_rows_no_warning(self):
        c, r = self.run_base(5)
        self.assertNotIn("Внимание", r["summary"])
        self.assertNotIn("пополни словарь", r["summary"])  # процесс без словаря: совета нет
        self.assertIn("sales.csv", r["summary"])
        self.assertIn("Разобрать вручную: 0", r["summary"])

    def test_truncated_rows_warned_in_summary(self):
        _, r = self.run_base(5, limit=3)
        self.assertIn("Внимание: в файле 5 строк, посчитаны первые 3.", r["summary"])

    def test_manual_file_written_even_empty(self):
        c, r = self.run_base(2)
        self.assertEqual(r["files"], ["output/proba/razobrat-vruchnuyu.xlsx"])
        rows = manual_rows(c.out / "razobrat-vruchnuyu.xlsx")
        self.assertEqual(rows[0], ["Точка", "Сумма", "Почему"])
        self.assertEqual(rows[1][0], "Всё разобрано программой.")
        self.assertIn("sverka", r)

    def test_number_digits_only(self):
        c = Cabinet(compose())
        self.addCleanup(c.close)
        m = c.module()
        self.assertEqual(m.number("1 234,5"), 1234.5)
        self.assertEqual(m.number("374\u00a0433,50"), 374433.5)
        self.assertEqual(m.number("-12"), -12.0)
        for bad in ("nan", "inf", "-inf", "1_000", "1e5", "", "н/д", "1.2.3"):
            self.assertIsNone(m.number(bad), bad)

    def test_no_input_clear_stop(self):
        c = Cabinet(compose())
        self.addCleanup(c.close)
        proc = c.run()
        self.assertEqual(proc.returncode, 2)
        self.assertIn("В папке input/proba нет файла", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)


SLOVAR = {
    "оценка и выкуп": ["оценка", "оценщик", "оценили", "выкуп", "проба 585", "вес изделия", "кепіл"],
    "обслуживание и персонал": ["оператор", "кассир", "нахамил", "нагрубил", "очередь", "вежлив"],
    "оплата и касса": ["чек", "списали", "терминал", "оплата", "касса", "qr"],
    "ювелирный салон": ["кольцо", "серьги", "цепь", "витрина"],
    "программа лояльности": ["бонус", "карта лояльности", "акция"],
    "чистота и санузлы": ["туалет", "санузел", "санузл", "грязно", "дәретхана"],
    "проценты и сроки": ["процент", "ставка", "продление", "просрочка", "пеня"],
    "благодарность": ["спасибо", "благодар", "рахмет"],
}


def guide_slovar_example():
    """Пример slovar.json из раздела «Словарь» справки: в нём слова срочности по умолчанию."""
    text = GUIDE.read_text(encoding="utf-8")
    part = text[text.index("## Словарь"):]
    return json.loads(re.search(r"```json\n(.*?)```", part, re.S).group(1))


@unittest.skipUnless(HAVE_LIBS, "нет openpyxl или python-docx")
class Slovar(unittest.TestCase):
    def setUp(self):
        self.c = Cabinet(compose("slovar", "main_slovar"))
        self.addCleanup(self.c.close)
        (self.c.proc / "slovar.json").write_text(json.dumps(SLOVAR, ensure_ascii=False), encoding="utf-8")

    def with_urgent(self, extra=None):
        """Словарь теста и слова срочности по умолчанию из справки, как их берёт Claude."""
        m = self.c.module()
        urgent = guide_slovar_example()[m.URGENT]
        (self.c.proc / "slovar.json").write_text(json.dumps(dict(SLOVAR, **{m.URGENT: urgent}, **(extra or {})),
                                                            ensure_ascii=False), encoding="utf-8")
        return m

    def run_case(self, name):
        for old in self.c.input.glob("*"):
            old.unlink()
        shutil.copy(FIXTURES / name, self.c.input / name)
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return self.c.result()

    def test_word_rule(self):
        m = self.c.module()
        s = m.load_slovar()
        cls = lambda t: m.classify(t, s)[0]
        self.assertEqual(m.stem("бонусы"), "бонус")
        self.assertEqual(m.stem("касса"), "касс")
        self.assertEqual(m.stem("очередь"), "очеред")
        self.assertEqual(m.stem("мыло"), "мыл")
        self.assertEqual(m.stem("чек"), "чек")
        self.assertEqual(cls("Почему бонусов так мало?"), "программа лояльности")
        self.assertEqual(cls("QR не сканируется"), "оплата и касса")
        self.assertEqual(cls("Номер бирки QRZ на изделии"), m.MANUAL)  # «qr» только целым словом
        self.assertEqual(cls("Проба-585 не подтвердилась"), "оценка и выкуп")  # фраза «проба 585»
        self.assertEqual(cls("КЕПІЛГЕ алынған сақина"), "оценка и выкуп")  # регистр, казахский
        self.assertEqual(cls("Дәретханада қағаз жоқ"), "чистота и санузлы")
        self.assertEqual(cls("Ещё раз про бонусы"), "программа лояльности")
        # Найденные слова словаря: по ним человек видит, почему строка в теме.
        self.assertEqual(m.classify("Почему бонусов мало и акция не работает?", s),
                         ("программа лояльности", "", ["бонус", "акция"]))

    def test_manual_reasons(self):
        m = self.c.module()
        s = m.load_slovar()
        self.assertEqual(m.classify("", s), (m.MANUAL, "пустой текст", []))
        self.assertEqual(m.classify("Работаете ли вы в воскресенье?", s), (m.MANUAL, "нет слов из словаря", []))
        # Салон 1 слово, персонал 2: тема персонал по перевесу, пометка не та, что у ничьей.
        self.assertEqual(m.classify("Кольцо не подошло, а оператор нагрубил", s),
                         ("обслуживание и персонал", "тема по перевесу слов, есть и «ювелирный салон»",
                          ["оператор", "нагрубил"]))

    def test_tie_goes_to_manual(self):
        """Поровну сильных слов у двух тем и больше: строку решает человек, «разобрать вручную» с пометкой
        «две темы: X, Y» (темы по месту в тексте; одно слово в двух темах: по алфавиту)."""
        m = self.c.module()
        s = m.load_slovar()
        self.assertEqual(m.classify("Кольцо не подошло, а оператор молчал", s),
                         (m.MANUAL, "две темы: ювелирный салон, обслуживание и персонал", ["кольцо", "оператор"]))
        self.assertEqual(m.classify("Оператор молчал, а кольцо не подошло", s)[:2],
                         (m.MANUAL, "две темы: обслуживание и персонал, ювелирный салон"))
        cat, why, _ = m.classify("Туалет грязный, кольцо не подошло, оператор молчал", s)
        self.assertEqual((cat, why), ("чистота и санузлы",  # чистота 2 слова: не ничья, тема остаётся
                                      "тема по перевесу слов, есть и «ювелирный салон», «обслуживание и персонал»"))
        cat, why, _ = m.classify("Ставка высокая, кольцо не подошло, кассир молчал", s)
        self.assertEqual((cat, why.split(":")[0]), (m.MANUAL, "несколько тем"))
        both = dict(s, **{"ювелирный салон": s["ювелирный салон"] + [("экран", m.roots("экран"))],
                          "оплата и касса": s["оплата и касса"] + [("экран", m.roots("экран"))]})
        self.assertEqual(m.classify("Экран погас", both)[:2], (m.MANUAL, "две темы: оплата и касса, ювелирный салон"))

    def test_stem_word_families(self):
        """Основа у слова словаря и у слова текста одна: слово в обычной форме находит другие формы."""
        m = self.c.module()
        families = [
            "зарядка зарядки зарядные зарядку", "витрина витрины витрине витрин витринами",
            "бонус бонусы бонусов бонусами", "касса кассу кассе кассой", "грязь грязи грязный грязно грязная",
            "золото золота золотом золотая золотой", "наличные наличными наличных наличка",
            "благодарность благодарю благодарим", "очередь очереди очередью очередей",
            "оплата оплату оплатой оплатить", "сотрудник сотрудника сотрудники сотрудникам", "мыло мыла мылом",
            "кассир кассира кассиру кассиры", "балл баллы баллов балла",
        ]
        # Слово словаря в обычной форме (первое) находит остальные: казахские окончания, суффикс, короткое слово.
        from_base = ["командировка командировки командировочные", "дәретхана дәретханада дәретханасы",
                     "кепіл кепілге кепілдің", "ұпай ұпайлар ұпайлары", "газ газом газовой газа",
                     "запах запаха запахом", "пол пола полу полы", "сок сока соки",
                     "қызмет қызметі қызметке қызметтің", "кезек кезекте кезекке", "утечка утечку утечки",
                     "иіс иісі", "залог залога залогом", "касса кассовый", "бонус бонусная", "сервис сервиса",
                     "цена ценам", "карта картами", "разбавлен разбавленный разбавленное", "качество качественный"]
        for fam in families + from_base:
            words = fam.split()
            pairs = [(a, b) for a in words for b in words] if fam in families else [(words[0], b) for b in words]
            for entry, text in pairs:
                with self.subTest(entry=entry, text=text):
                    slovar = {"тема": [(entry, m.roots(entry))]}
                    self.assertEqual(m.classify(text, slovar)[0], "тема")
        self.assertEqual(m.stem("зарядные"), m.stem("зарядка"))
        self.assertEqual(m.stem("золотая"), m.stem("золото"))
        for short in ("газ", "чек", "сок", "qr"):  # до трёх букв слово не укорачивается
            self.assertEqual(m.stem(short), short)
        self.assertEqual(m.stem("машина"), "машин")  # корень на -н не режется до гласной
        # Другое слово с тем же началом не находится: после слова словаря должно идти окончание.
        others = [("цепь", "Купил сок и печенье"), ("запах", "Записался на оценку"), ("qr", "QRZ бирка"),
                  ("балл", "баллон"), ("газ", "газету"), ("газ", "газон"), ("газ", "газель"),
                  ("газ", "газированная"), ("витрина", "витраж"), ("пол", "полицию"),
                  ("пол", "полный"), ("пол", "полка"), ("пол", "получил"), ("сок", "сокол"), ("сок", "сокращение"),
                  ("қызмет", "қызметкер"), ("касса", "кассир"), ("балл", "баллада"), ("бонус", "бонусник"),
                  ("карта", "картон"), ("карта", "картофель"), ("акция", "акционер"), ("вода", "водитель"),
                  ("кот", "который"), ("чай", "чайка"), ("цена", "ценник"), ("мойка", "мойщик"), ("кофе", "кофейня")]
        for entry, text in others:
            with self.subTest(entry=entry, text=text):
                self.assertEqual(m.classify(text, {"тема": [(entry, m.roots(entry))]})[0], m.MANUAL)

    def test_broken_slovar_clear_stop(self):
        (self.c.proc / "slovar.json").write_text('{"тема": ["слово",]}', encoding="utf-8")
        shutil.copy(FIXTURES / "obrashcheniya.xlsx", self.c.input / "obrashcheniya.xlsx")
        proc = self.c.run()
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("Словарь processes/proba/slovar.json испорчен (строка 1)", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)
        (self.c.proc / "slovar.json").unlink()
        proc = self.c.run()
        self.assertEqual(proc.returncode, 2)
        self.assertIn("Нет словаря processes/proba/slovar.json", proc.stderr)

    def test_case_file_card_manual_list_and_check(self):
        r = self.run_case("obrashcheniya.xlsx")
        self.assertEqual(len(r["rows"]), 40)
        self.assertEqual(r["status"], "green")  # в словаре нет раздела срочности: строк «срочно» нет
        self.assertFalse(r["summary"].startswith("Срочно"))
        rows = r["sverka"]["по строкам"]
        on_card = [(row[0], st, n) for row, st, n in zip(r["rows"], r["row_status"], r["row_note"])]
        manual = [i for i, (num, _, _) in enumerate(on_card) if rows[num] == "разобрать вручную"]
        self.assertTrue(manual, "в файле есть строки без слов из словаря")
        self.assertEqual(manual, list(range(len(manual))), "строки «разобрать вручную» идут первыми")
        self.assertTrue(all(on_card[i][1] == "info" for i in manual))
        notes = [on_card[i][2] for i in manual]
        ties = [n for n in notes if n.startswith(("две темы: ", "несколько тем: "))]
        self.assertTrue(ties, "в файле есть строки, где поровну слов двух тем")
        link = "есть ссылка: проверьте, не реклама ли"
        self.assertEqual(dict((num, n) for num, _, n in on_card)["12"], link)  # «Выиграйте iPhone ... bit.ly/...»
        self.assertTrue(all(n in ("разобрать вручную", link) or n in ties for n in notes), notes)
        rest = on_card[len(manual):]
        self.assertTrue(all(n.startswith("тема по перевесу слов, есть и «") for _, s, n in rest if s == "info"))
        self.assertTrue(any(s == "info" for _, s, n in rest), "в файле есть строки с перевесом одной темы")
        self.assertTrue(all(n is None for _, s, n in rest if s is None))
        self.assertIn(f"Разобрать вручную: {len(manual)}, из них две темы {len(ties)}, только общие слова 0, "
                      "отрицание 0, ссылка 1 (файл razobrat-vruchnuyu.xlsx)", r["summary"])
        self.assertIn("output/proba/razobrat-vruchnuyu.xlsx", r["files"])
        # Совет на новую неделю в итоге карточки процесса со словарём.
        self.assertTrue(r["summary"].endswith("Новый файл: скажите Claude «пополни словарь процесса Проба»."),
                        r["summary"])
        listed = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        self.assertEqual(len(listed), len(manual) + 1)
        self.assertEqual(sorted(row[-1] for row in listed[1:] if row[-1] != "нет слов из словаря"), sorted(ties + [link]))
        self.assertEqual(len(rows), 40)
        self.assertEqual(rows["38"], "повтор")  # повтор обращения 16 того же отделения
        self.assertEqual(rows["40"], "повтор")
        self.assertEqual(r["sverka"]["итоги"], {"обращений": 40, "повторов": 2})
        self.assertEqual(r["sverka"]["срочно"], [])
        self.assertEqual(sum(r["sverka"]["по категориям"].values()), 40 - 2 - len(manual))
        # В Excel результата у каждой строки слова словаря, по которым она попала в тему.
        table = sheet(self.c.out / "obrashcheniya-po-temam.xlsx", "Обращения")
        self.assertEqual(table[0], ["№", "Отделение", "Тема", "Текст", "Найдено по слову", "Пометка"])
        by_num = {row[0]: row for row in table[1:]}
        self.assertEqual(by_num["5"][2:5], ["программа лояльности", "Почему бонусы сгорают так быстро? Не успел потратить.",
                                            "бонус"])
        self.assertEqual(by_num["38"][4:], [None, "повтор, посчитан один раз"])
        self.assertIn(by_num[r["rows"][0][0]][5], ["нет слов из словаря", link] + ties)
        if not NODE:
            return
        code, out = self.c.node("list")
        self.assertEqual(code, 0, out)
        self.assertIn("Результат:", out)
        self.assertNotIn("Ошибка", out)
        etalon = {k: r["sverka"][k] for k in ("итоги", "по категориям")}
        etalon["по строкам"] = dict(rows)
        first = r["rows"][0][0]  # строка «разобрать вручную»: у скилла своя тема
        etalon["по строкам"][first] = "другое"
        etalon["по категориям"] = dict(etalon["по категориям"], **{"другое": 1})
        (self.c.out / "etalon-skilla.json").write_text(json.dumps(etalon, ensure_ascii=False), encoding="utf-8")
        code, out = self.c.node("compare", "proba")
        self.assertEqual(code, 0, out)
        self.assertIn("кроме", out)

    def test_urgent_words_default_in_guide(self):
        """Раздел срочности в примере словаря справки: основы, а не формы; утечка газа и падение человека;
        «плохо» только фразой. Срочность не тема; в пометке слова самого текста. Правил про топливо нет."""
        m = self.c.module()
        example = guide_slovar_example()
        self.assertIn(m.URGENT, example)
        urgent = example[m.URGENT]
        for word in ("утечк", "запах газа", "дым", "огон", "огн", "искр", "пожар", "взрыв", "травм", "упал", "упала",
                     "потерял сознание", "стало плохо", "плохо стало", "опасн", "газ иісі", "өрт", "түтін", "жарыл",
                     "жарақат", "құлады", "есінен танды"):
            self.assertIn(word, urgent)
        for word in ("плохо", "пролил", "разлив", "запах бенз", "запах топлив", "лопнул шланг"):
            self.assertNotIn(word, urgent)
        for name in ("SUBSTANCES", "SPILLS", "SMOKE", "HISS"):
            self.assertFalse(hasattr(m, name), name)
        s = dict(m.load_slovar(), **{m.URGENT: [(w, m.roots(w)) for w in urgent]})
        self.assertEqual(m.classify("Пахнет газом у входа", s)[0], m.MANUAL)
        self.assertEqual(m.urgent_words("Пахнет газом у входа", s), ["пахнет газом"])
        self.assertEqual(m.urgent_words("Касса сломана", s), [])
        self.assertEqual(m.urgent_words("Отделениеде газ иісі шығады", s), ["газ иісі"])
        self.assertEqual(m.urgent_words("Пахнет газом, похоже на утечку", s), ["пахнет газом", "утечку"])
        # Без раздела срочности ни слов, ни правила о переломе: процесс не про обращения.
        self.assertEqual(m.urgent_words("Пахнет газом у кассы, клиент сломал ногу", m.load_slovar()), [])

    def test_urgent_word_families_red(self):
        """Слова срочности ищутся по основе, шире слов темы: формы опасности не теряются. Лишняя срочная строка
        допустима, пропущенная нет."""
        m = self.with_urgent()
        s = m.load_slovar()
        red = ["утечку", "утекает", "упал", "упала", "упали", "потерял сознание", "потеряла сознание", "стало плохо",
               "плохо стало", "травмировался", "травмирован", "взрывоопасно", "взорвался", "огня", "огнём", "огонь",
               "искрит", "дымится", "задымление", "возгорания", "пожарный", "угрожал", "срочное", "құлады",
               "есінен танды", "уланды", "уланып қалдым", "төбелесіп", "қаупі бар", "қауіпті", "өрттен", "түтіні",
               "ұшқындады", "жарылыстан", "жарақаттанды", "шұғыл"]
        for text in red:
            with self.subTest(text=text):
                self.assertTrue(m.urgent_words(text, s), text)
        for text in ("искра у розетки", "искры летят", "искрение в щитке", "опасно ходить"):
            with self.subTest(text=text):
                self.assertTrue(m.urgent_words(text, s), text)
        # «плохо» одно не срочно; «запах» без газа тоже; короткая основа только с начала слова;
        # «искренне» начинается как «искры», но о другом: строка благодарности не красная.
        for text in ("Плохо обслужили", "Запах в отделении", "Отделение закрыто", "Записал номер",
                     "Запасной ключ", "Табло не горит", "Сдачу дали плохо посчитанную", "Пролили кофе на стойку",
                     "Искренне благодарю кассира", "Искренний сервис, спасибо", "Искренняя благодарность"):
            with self.subTest(text=text):
                self.assertEqual(m.urgent_words(text, s), [], text)

    def test_urgent_formulations_not_in_dictionary_red(self):
        """Срочные строки, которых в словаре нет дословно (формы, порядок слов, казахский, смешанный): все красные.
        Не меньше десяти из них найдены местом, которое не совпадает с записью словаря целиком."""
        m = self.with_urgent()
        s = m.load_slovar()
        entries = {e.lower() for e, _ in s[m.URGENT]}
        formulations = [
            "Газом пахнет на всё отделение",
            "Двое детей упали у кассы на мокром полу",
            "Женщине стало плохо в очереди",
            "Плохо стало пожилому клиенту у окна выкупа",
            "Покупательница потеряла сознание у витрины",
            "Кассир упала в обморок",
            "Газ иісі шығып тұр",
            "Кісі құлады, жедел жәрдем шақырыңыз",
            "Әйел есінен танды кассаның жанында",
            "Бөлімшеден түтін шығып тұр",
            "Розетка у кассы искрит",
            "Задымление в отделении, дышать нечем",
            "Клиент угрожал оценщику расправой",
            "Двое подрались в очереди на выкуп",
            "Огнём полыхнула урна у входа",
            "Утечка газа в отделении!",
            "Охранника ударили у входа",
            "Клиент травмировался о стеклянную витрину",
        ]
        not_verbatim = []
        for text in formulations:
            with self.subTest(text=text):
                found = m.urgent_words(text, s)
                self.assertTrue(found, text)
                if any(f.lower() not in entries for f in found):
                    not_verbatim.append(text)
        self.assertGreaterEqual(len(not_verbatim), 10, sorted(set(formulations) - set(not_verbatim)))

    def test_review_urgent_sentences_red(self):
        """Срочные фразы (огонь, насилие, здоровье, утечка газа, казахский): все красные."""
        m = self.with_urgent()
        s = m.load_slovar()
        sentences = [
            "У кассы сильно пахнет газом, голова кружится",
            "В отделении что-то горит у потолка",
            "Из-под капота повалил чёрный дым прямо у входа",
            "Розетка у витрины искрит и трещит",
            "Дед поскользнулся и грохнулся, не встаёт",
            "Девочка в очереди упала в обморок",
            "Двое мужчин подрались у кассы, один с ножом",
            "Охранник сказал, что убьёт меня",
            "Мужчина грозился поджечь отделение",
            "Газ иісі шықты, бас айналады",
            "Қызметкер құлап қалды",
            "Бөлімшеден түтін шығып жатыр",
            "Көлікте от шықты",
            "Чувствую запах, как будто что-то жгут, едкий",
            "Клиент потерял сознание у входа",
            "Пахнет газом на всё отделение",
        ]
        for text in sentences:
            with self.subTest(text=text):
                self.assertTrue(m.urgent_words(text, s), text)
        more = ["горит проводка", "загорелось", "загорелась машина", "горят шины", "воспламенилось", "сгорела машина",
                "пламя над кассой", "жанып жатыр", "көлік жанды", "убью", "убьёт", "поджечь", "избили", "ударил",
                "бьёт током", "током ударило", "без сознания", "мне плохо", "ему плохо", "ей плохо",
                "сердце прихватило", "скорую вызвали", "ранен", "умер", "кровь на полу", "задохнулся", "угорел",
                "бомба", "оружие у охранника", "талып қалды", "есінен айырылды", "ұрды"]
        for text in more:
            with self.subTest(text=text):
                self.assertTrue(m.urgent_words(text, s), text)
        # Лампа и табло не пожар: «не горит», «горит лампочка», «загорелся чек двигателя», «шам жанды».
        # «От всего сердца» в благодарности не сердечный приступ; «плохо» одно не срочно.
        for text in ("цены просто горят", "Огонь, а не цены", "лампа горит тускло", "Табло не горит",
                     "Свет в туалете горит тускло", "загорелся чек двигателя", "горят цены на золото",
                     "Табло с курсом не горит", "Не горит освещение над витриной", "Горит лампочка на терминале",
                     "Через 20 км загорелся чек двигателя", "Сгорела лампочка в туалете", "Шам жанды",
                     "Спасибо от всего сердца", "Плохо обслужили", "Сердечное спасибо кассиру"):
            with self.subTest(text=text):
                self.assertEqual(m.urgent_words(text, s), [], text)

    def test_broken_bone_with_context(self):
        """«Сломал» срочно только с частью тела рядом (не дальше двух слов): «сломал ногу», «аяғы сынды»;
        «сломался терминал» не срочно. Протечка и нож в срочность не входят: «течёт кран», «ножницы»."""
        m = self.with_urgent()
        s = m.load_slovar()
        for text in ("Мужчина сломал ногу у входа", "Кассир сломала палец о дверь", "Сломали ребро в драке",
                     "Руку сломал на мокром полу", "У клиента сломана нога", "Аяғы сынды", "Қолы сынған"):
            with self.subTest(text=text):
                self.assertTrue(m.urgent_words(text, s), text)
        for text in ("Сломался терминал", "Терминал сломался", "Сломали замок на витрине", "Сломал карту при оплате",
                     "Течь крыши в отделении", "Протечка в туалете", "Течёт кран в туалете", "Купил ножницы",
                     "Замок на цепи сломан"):
            with self.subTest(text=text):
                self.assertEqual(m.urgent_words(text, s), [], text)

    def test_rereview_urgent_sentences_red(self):
        """Все срочные фразы красные: огонь рядом с чеком и экраном, тление, гарь, дурнота, драка, утечка газа,
        казахские формы, огонь рядом с тем, что горит («касса горит» с ценами и лампой рядом)."""
        m = self.with_urgent()
        s = m.load_slovar()
        sentences = """Касса дымит и пахнет паленым
Из-под капота у клиента пошёл дым прямо у отделения
Не горит, а дымит щиток
Лампа горит и искрит
У кассы 2 горит чек
Загорелась проводка рядом с экраном
Касса горит, чек не пробили
Горит табло, и воняет гарью
Мужчина упал в отделении, не встаёт
Клиенту стало дурно возле кассы
Бөлімшеден түтін шығып жатыр
Біреу есінен танып қалды
Клиент ударился головой и кровь идет
Двое дерутся у входа, один с ножом
Детектор показывает утечку газа в подсобке
Касса полыхает
Пылает мусорный контейнер возле отделения
Электрощит трещит и пахнет жжёным
Пахнет жженой проводкой в кассовой зоне
Машина вспыхнула у входа
Женщине поплохело на жаре
Сотрудник порезал руку, кровотечение
Бөлімшеде от жанып тұр
Мотор загорелся на парковке
Электричество замкнуло, пошёл дым
Мне плохо, кружится голова
Сломана нога у посетителя в отделении
Клиент подвернул ногу и упал в обморок
Угрожали кассиру расправой
Горит касса рядом с экраном
Горит провод у щитка освещения
У кассы не горит, но дымит
Горит свет и пахнет паленой проводкой
Не горит касса, но искры
Горит табло у кассы, внутри пламя
Загорелась панель, экран чёрный
Горит мусорный бак рядом с освещением
У входа горит куча листвы, освещение плохое
Автомат с кофе загорелся, экран треснул
Горит светофор? нет, горит машина
Рядом с чеком загорелась бумага
Проводка не горит а тлеет
Тлеет проводка
Не загорелась машина, только дымилась
Тосқауыл жанып кетті
Касса вспыхнула
Замыкание в щитке
Паленым пахнет в кассовой зоне
Клиенту дурно
Щиток тлеет
Клиент потерял сознание и упал
Есінен танып қалды
Машина жанды
Қоқыс жәшігінен от шықты
Он нас убьёт
Хотел поджечь отделение
Кассира избили
Охранник ударил клиента
Клиента бьёт током от терминала
Клиент без сознания
Ему плохо в отделении
Горит касса, цены не важны, звоните 101
Горит касса, цены на золото, звоните 101
Цены горят и горит проводка
Загорелась касса, привет, звоните 101
Горит касса, цена ошибки
Касса горит, лампа рядом
Горит касса цены не важны звоните 101
горит касса цены не важны
Касса горит цены
Касса горит, цены
загорелась машина цены на золото
загорелась машина, цены на золото
Проводка горит лампа рядом
лампа горит у кассы дым""".split("\n")
        self.assertGreaterEqual(len(sentences), 70)
        for text in sentences:
            with self.subTest(text=text):
                self.assertTrue(m.urgent_words(text, s), text)

    def test_rereview_ordinary_and_metaphors(self):
        """Обычные жалобы (20): лишних срочных не больше трёх. Здесь две, принятые: «Дым от шашлыков у входа
        мешает дышать» («дым») и «Процент горит» («горит» не рядом с ценами). Огонь и взрыв в переносном смысле не срочные: «цены горят», «взорвало цены»,
        «пламенный привет», «сгорел на работе»; «горит тускло» о свете тоже."""
        m = self.with_urgent()
        s = m.load_slovar()
        ordinary = """Чай в зоне ожидания слишком горячий, обжёг язык
Огонь, а не цены, золото дорогое
Дым от шашлыков у входа мешает дышать
Скидка на серьги не применилась
Свет в туалете горит тускло, ничего не видно
Кофе пролили на стойку, пришлось ждать
Золото подорожало, цены просто горят
Газета не продается, закончились на кассе
Лампа в зале мигает, горит тускло
Серебро стоит дорого, дороже чем у конкурентов
Горячая линия не отвечает
Принтер выдал чек слишком медленно, чек горячий
Взорвало цены, золото подорожало
Сгорел на работе из-за очереди на выкуп
Пламенный привет кассиру Айгуль
Течет кран в туалете
Запах в туалете
Процент горит, надо успеть продлить
Цепь порвалась, замок слабый
Оценщик был не в духе""".split("\n")
        self.assertEqual(len(ordinary), 20)
        red = [t for t in ordinary if m.urgent_words(t, s)]
        self.assertLessEqual(len(red), 3, red)
        self.assertEqual(red, ["Дым от шашлыков у входа мешает дышать", "Процент горит, надо успеть продлить"])

    def test_review_ordinary_complaints_few_urgent(self):
        """Обычные жалобы клиентов ломбарда: лишних срочных нет. «Пахнет в туалете», «течёт кран», «пролили кофе»
        без газа и людей не срочно."""
        m = self.with_urgent()
        s = m.load_slovar()
        ordinary = [
            "Оценщик занизил вес изделия", "Кассир нахамил, невежливый", "Чек не дали", "Не вежливый оператор",
            "В туалете грязно", "Не только высокий процент, но и очередь огромная", "Терминал не работает",
            "Бонусы не начислили", "Очередь на кассе огромная", "Золото дорогое, цены выросли",
            "Проба не та, что в квитанции", "Ставка выше, чем в договоре", "Карта не принимается, оплата не прошла",
            "Кофе в зоне ожидания невкусный", "Продление не прошло, начислили пеню", "Пахнет в туалете плохо",
            "Запах в отделении несвежий", "Касса не работает", "Цепь порвалась через неделю", "Не работает кондиционер",
            "Сотрудник не вежлив", "Искренне благодарю за сервис", "Очень долго течёт кофе из автомата", "Сдачу не вернули",
            "Пролили кофе на стойку", "Кольцо поцарапано в витрине",
        ]
        self.assertEqual(len(ordinary), 26)
        red = [t for t in ordinary if m.urgent_words(t, s)]
        self.assertEqual(red, [])

    def test_urgent_rows_case_week1(self):
        """Неделя 1: строка 30 (пахнет газом и утечка у кассы) срочная, красная, первая на карточке. Ещё две
        срочные: 27 «Пол в отделении мокрый, без таблички, чуть не упал.» («упал»: отрицание срочность не снимает;
        без темы, поэтому выше) и 31 «угрожал оценщику». Строка 1 «отвлекался на телефон» не срочная."""
        self.with_urgent()
        r = self.run_case("obrashcheniya.xlsx")
        hot = r["sverka"]["срочно"]
        self.assertEqual(hot, ["30", "27", "31"])  # у 30 два места: «пахнет газом» и «утечку»
        self.assertEqual(r["status"], "red")
        self.assertTrue(r["summary"].startswith("Срочно: 3 (№ 30, 27, 31). Обращений 40"), r["summary"])
        self.assertEqual(r["rows"][0][0], "30")
        self.assertEqual(r["rows"][0][2], "оплата и касса")  # тема своя: «касса», срочность не тема
        self.assertEqual(r["row_status"][:3], ["red", "red", "red"])
        self.assertEqual(r["row_note"][0], "срочно: пахнет газом, утечку")
        self.assertEqual(r["row_note"][1], "срочно: упал; разобрать вручную")  # мокрый пол: слов темы нет
        self.assertNotIn("red", r["row_status"][3:])
        self.assertEqual(r["sverka"]["по строкам"]["30"], "оплата и касса")
        book = self.c.out / "obrashcheniya-po-temam.xlsx"
        self.assertEqual(sheet_names(book)[0], "Срочно")
        urgent_sheet = sheet(book, "Срочно")
        self.assertEqual(urgent_sheet[0], ["№", "Отделение", "Тема", "Текст", "Слово срочности"])
        self.assertEqual([row[0] for row in urgent_sheet[1:]], ["30", "27", "31"])
        self.assertEqual(urgent_sheet[1][4], "пахнет газом, утечку")
        table = {row[0]: row for row in sheet(book, "Обращения")[1:]}
        self.assertEqual(table["30"][4:], ["касса", "срочно: пахнет газом, утечку"])
        self.assertEqual(table["14"][4:], [None, "нет слов из словаря"])

    def test_urgent_rows_case_week2(self):
        """Неделя 2, словарь недели 1: строка 10 (стало плохо, скорая) срочная и первая. Лишняя срочная одна
        (принцип «лучше лишнее»): 9 «Фонари у входа не светят, вечером опасно.» («опасн»). «Кофе пролили на
        стойку» не срочно: правила о проливе больше нет."""
        self.with_urgent()
        r = self.run_case("obrashcheniya_nedelya2.xlsx")
        hot = r["sverka"]["срочно"]
        self.assertEqual(hot, ["10", "9"])
        self.assertEqual(r["rows"][0][0], "10")
        self.assertEqual(r["row_status"][0], "red")
        self.assertEqual(r["row_note"][0], "срочно: стало плохо, скорую")
        self.assertEqual(r["rows"][0][2], "обслуживание и персонал")  # тема своя: «очередь»
        self.assertTrue(r["summary"].startswith("Срочно: 2 (№ 10, 9)."), r["summary"])

    def test_negation_does_not_decide_topic(self):
        """Слово темы с «не» перед ним или «емес» после тему не решает: нет других сильных слов, строка
        в «разобрать вручную» с пометкой «отрицание: «не вежлив»». «Нет», «без», «жоқ» говорят, что предмета нет:
        тема та же. Срочность отрицание не снимает."""
        m = self.c.module()
        data = {"благодарность": ["спасибо", "вежлив", "сыпайы"], "обслуживание и персонал": ["оператор", "нагрубил"],
                "чистота и санузлы": ["туалет", "чисто"], "оплата и касса": ["чек"],
                "ювелирный салон": ["цепь", "витрина"], m.URGENT: ["упал"]}
        (self.c.proc / "slovar.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        s = m.load_slovar()
        self.assertEqual(m.classify("Кассир был не вежлив", s)[:2], (m.MANUAL, "отрицание: «не вежлив»"))
        self.assertEqual(m.classify("Кассир не вежливый, и в туалете не чисто", s)[:2],
                         ("чистота и санузлы", ""))  # «туалет» сильное, отрицаемые слова тему не дают
        self.assertEqual(m.classify("Не вежливо и не чисто", s)[:2],
                         (m.MANUAL, "отрицание: «не вежливо», «не чисто»"))
        self.assertEqual(m.classify("Кассир сыпайы емес", s)[:2], (m.MANUAL, "отрицание: «сыпайы емес»"))
        # Одно усиление между «не» и словом: «не очень вежливо» тоже отрицание.
        for word in ("очень", "слишком", "совсем", "особо", "сильно"):
            with self.subTest(word=word):
                self.assertEqual(m.classify(f"Кассир не {word} вежлив", s)[:2],
                                 (m.MANUAL, f"отрицание: «не {word} вежлив»"))
        # Отсутствие не отрицание: жалоба на то, чего нет, остаётся в своей теме.
        self.assertEqual(m.classify("Дали без чека", s)[:2], ("оплата и касса", ""))
        self.assertEqual(m.classify("Чек жоқ", s)[:2], ("оплата и касса", ""))
        self.assertEqual(m.classify("Нет цепей нужной длины", s)[:2], ("ювелирный салон", ""))
        self.assertEqual(m.classify("В салоне нет цепи без замка", s)[:2], ("ювелирный салон", ""))
        # Сильное слово рядом: тема по нему, отрицаемое слово темы не даёт и «есть и» не называет.
        self.assertEqual(m.classify("Оператор не вежлив", s)[:2], ("обслуживание и персонал", ""))
        self.assertEqual(m.classify("В туалете не чисто", s)[:2], ("чистота и санузлы", ""))
        # Слово и с отрицанием, и без: без отрицания оно считается.
        self.assertEqual(m.classify("Сначала было не чисто, потом стало чисто", s)[:2], ("чистота и санузлы", ""))
        self.assertEqual(m.urgent_words("Чуть не упал на мокром полу", s), ["упал"])

    def test_link_goes_to_manual_unless_ad_word(self):
        """Строка со ссылкой (http, https, www., bit.ly, t.me, wa.me) уходит в «разобрать вручную» с пометкой
        «есть ссылка: проверьте, не реклама ли». Есть слово темы с «!» (признак рекламы): строка в этой теме."""
        m = self.c.module()
        data = {"другое": ["выиграйте!", "вакансия"], "оплата и касса": ["карта", "чек"]}
        (self.c.proc / "slovar.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        s = m.load_slovar()
        link = "есть ссылка: проверьте, не реклама ли"
        self.assertEqual(m.classify("Выиграйте iPhone! Переходите по ссылке bit.ly/x и введите номер карты", s),
                         ("другое", "", ["выиграйте!"]))
        for text in ("Получите золото: https://free.example и введите данные карты", "Наш чек на www.zoloto.kz",
                     "Пишите в t.me/zoloto_bot", "Ответим в wa.me/77001234567", "Акция тут: http://x.kz",
                     "Канал tg://resolve?domain=zoloto, чек", "Наш канал в t.me, карта", "Чек на сайте zoloto.kz",
                     "Подробнее: example.com", "Карта: promo.ru/x", "Скидки на sale.net", "Чек: shop.org", "bit.ly карта",
                     "Пиши на me.me"):
            with self.subTest(text=text):
                self.assertEqual(m.classify(text, s)[:2], (m.MANUAL, link))
        self.assertEqual(m.classify("Чек не пришёл на почту", s)[:2], ("оплата и касса", ""))
        # Число с точкой не ссылка: «4.5», «205.50», «т.д.».
        for text in ("Чек на 205.50 тенге", "Оценка 4.5, карта прошла", "Чек и т.д.", "Чек, ул.Абая 10"):
            with self.subTest(text=text):
                self.assertEqual(m.classify(text, s)[0], "оплата и касса")

    def test_urgent_word_from_skill_and_key_spelling(self):
        """Слово срочности из скилла человека дописывается в тот же раздел; имя раздела без учёта регистра,
        и короткое имя «срочно» (как раздел эталона) тоже раздел срочности, не тема."""
        m = self.c.module()
        for key in ("Срочно (не тема)", "срочно", "Срочно"):
            with self.subTest(key=key):
                data = dict(SLOVAR, **{key: ["угрож"]})
                (self.c.proc / "slovar.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                s = m.load_slovar()
                self.assertIn(m.URGENT, s)
                self.assertNotIn(key, s)
                self.assertEqual(m.urgent_words("Клиент угрожал оценщику расправой", s), ["угрожал"])
                self.assertEqual(m.classify("Клиент угрожал оценщику расправой", s)[0], "оценка и выкуп")

    def test_weak_words_go_to_manual(self):
        """Слабое (общее) слово с «?» в конце тему не решает: строка, где нашлись только слабые слова, уходит
        в «разобрать вручную» с пометкой «только общее слово: «касса»»; рядом с сильным словом не мешает."""
        m = self.c.module()
        weak = dict(SLOVAR, **{"оплата и касса": ["чек", "списали", "терминал", "оплата", "касса?"],
                               "ювелирный салон": ["кольцо", "серьги", "цепь", "витрина?"]})
        (self.c.proc / "slovar.json").write_text(json.dumps(weak, ensure_ascii=False), encoding="utf-8")
        s = m.load_slovar()
        self.assertEqual(m.classify("Девушка на кассе бросила сдачу", s),
                         (m.MANUAL, "только общее слово: «касса»", ["касса?"]))
        self.assertEqual(m.classify("На кассе не дали чек", s), ("оплата и касса", "", ["чек", "касса?"]))
        self.assertEqual(m.classify("У витрины на кассе", s)[:2], (m.MANUAL, "только общие слова: «витрина», «касса»"))
        # Слабое слово не тянет в ничью: сильных слов по одному у персонала и чистоты.
        self.assertEqual(m.classify("Кассир молчал, у витрины грязно", s)[:2],
                         (m.MANUAL, "две темы: обслуживание и персонал, чистота и санузлы"))
        # Слабое слово другой темы рядом с сильным: тема по сильному, пометка перевеса.
        self.assertEqual(m.classify("Кассир нагрубил на кассе", s)[:2],
                         ("обслуживание и персонал", "тема по перевесу слов, есть и «оплата и касса»"))
        shutil.copy(FIXTURES / "obrashcheniya.xlsx", self.c.input / "obrashcheniya.xlsx")
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        notes = dict(zip((row[0] for row in r["rows"]), zip(r["row_status"], r["row_note"])))
        self.assertEqual(notes["35"], ("info", "только общее слово: «касса»"))  # окно кассы закрыто
        self.assertEqual(r["sverka"]["по строкам"]["35"], "разобрать вручную")
        self.assertEqual(notes["36"], (None, None))  # «оплату» и «касса»: есть сильное слово
        self.assertEqual(notes["9"], (None, None))  # «терминал» не слабое
        weak_rows = sum(1 for _, n in notes.values() if n and n.startswith("только общ"))
        self.assertIn(f"только общие слова {weak_rows}, отрицание 0, ссылка 1 (файл razobrat-vruchnuyu.xlsx)", r["summary"])
        listed = {row[0]: row[-1] for row in manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")[1:]}
        self.assertEqual(listed["35"], "только общее слово: «касса»")
        # Слова словаря по строкам для подсказки сверке: все темы, «?» на месте.
        self.assertEqual(r["sverka"]["найдено"]["4"], {"обслуживание и персонал": ["очередь"],
                                                       "оплата и касса": ["касса?"], "ювелирный салон": ["цепь"]})
        table = {row[0]: row for row in sheet(self.c.out / "obrashcheniya-po-temam.xlsx", "Обращения")[1:]}
        self.assertEqual(table["35"][2:], ["разобрать вручную", table["35"][3], "касса?", "только общее слово: «касса»"])
        # Без раздела срочности листа «Срочно» нет: пустой лист читался бы как «срочного нет».
        self.assertNotIn("Срочно", sheet_names(self.c.out / "obrashcheniya-po-temam.xlsx"))
        self.assertFalse(r["summary"].startswith("Срочно"))


def sheet_names(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True)
    try:
        return wb.sheetnames
    finally:
        wb.close()


@unittest.skipUnless(HAVE_LIBS, "нет openpyxl или python-docx")
class Word(unittest.TestCase):
    def setUp(self):
        self.c = Cabinet(compose("word", "main_word"))
        self.addCleanup(self.c.close)

    def texts(self, path):
        import docx
        d = docx.Document(path)
        m = self.c.module()
        return [p.text for p in m.paragraphs(d)], d

    def make_template(self, with_table=True):
        """Шаблон, где Word разбил поле на куски, поле в таблице и в колонтитуле, поле-таблица."""
        import docx
        d = docx.Document()
        p = d.add_paragraph()
        p.add_run("Кому: {{Наименование ")
        r = p.add_run("поставщика}}")
        r.bold = True
        d.add_paragraph("Сумма: {{Сумма}} тенге, дата {{дата}}.")
        if with_table:
            d.add_paragraph("{{Таблица}}")
        t = d.add_table(rows=1, cols=1)
        t.cell(0, 0).text = "Подпись: {{Фамилия И. О.}}"
        d.sections[0].header.is_linked_to_previous = False
        d.sections[0].header.paragraphs[0].text = "Исх. от {{дата}}"
        d.save(self.c.proc / "shablon.docx")

    def test_fill_fields_split_runs_tables_header(self):
        self.make_template()
        m = self.c.module()
        path, missing = m.fill_docx({"Наименование поставщика": "ТОО «Ромашка»", "дата": "09.11.2026",
                                     "Сумма": m.money(1250000), "Таблица": [["Документ", "Сумма"], ["№ 41", "6 195 000,00"]]},
                                    "pismo-01.docx")
        self.assertEqual(path, "output/proba/pismo-01.docx")
        self.assertEqual(missing, ["Фамилия И. О."])
        texts, d = self.texts(self.c.out / "pismo-01.docx")
        self.assertIn("Кому: ТОО «Ромашка»", texts)
        self.assertIn("Сумма: 1 250 000,00 тенге, дата 09.11.2026.", texts)
        self.assertIn("Подпись: [нет данных]", texts)
        self.assertIn("Исх. от 09.11.2026", texts)
        self.assertNotIn("{{Таблица}}", texts)
        self.assertEqual([c.text for c in d.tables[0].rows[1].cells], ["№ 41", "6 195 000,00"])
        self.assertFalse(any("{{" in t for t in texts))

    def test_first_page_and_even_headers_content_control_and_formatting(self):
        """Бланк с отдельным колонтитулом первой страницы, поле в элементе управления содержимым,
        поле, разбитое на куски с разным оформлением: всё заполнено, жирный и курсив вне поля на месте."""
        import docx
        from docx.oxml import parse_xml
        from docx.oxml.ns import nsdecls
        d = docx.Document()
        p = d.add_paragraph()
        a = p.add_run("Жирное начало ")
        a.bold = True
        p.add_run("и поле {{Наименование ")
        b = p.add_run("поставщика}}")
        b.italic = True
        c = p.add_run(" и курсивный хвост")
        c.italic = True
        s = d.sections[0]
        s.different_first_page_header_footer = True
        s.first_page_header.paragraphs[0].text = "Бланк, исх. от {{дата}}"
        d.settings.odd_and_even_pages_header_footer = True
        s.even_page_footer.paragraphs[0].text = "Чётная страница {{дата}}"
        d.element.body.insert(0, parse_xml(
            f'<w:sdt {nsdecls("w")}><w:sdtContent><w:p><w:r><w:t>В элементе: {{{{дата}}}}</w:t></w:r></w:p></w:sdtContent></w:sdt>'))
        d.save(self.c.proc / "shablon.docx")
        m = self.c.module()
        _, missing = m.fill_docx({"Наименование поставщика": "ТОО «Ромашка»", "дата": "09.11.2026"}, "pismo-01.docx")
        self.assertEqual(missing, [])
        out = docx.Document(self.c.out / "pismo-01.docx")
        sec = out.sections[0]
        self.assertEqual(sec.first_page_header.paragraphs[0].text, "Бланк, исх. от 09.11.2026")
        self.assertEqual(sec.even_page_footer.paragraphs[0].text, "Чётная страница 09.11.2026")
        texts, _ = self.texts(self.c.out / "pismo-01.docx")
        self.assertIn("В элементе: 09.11.2026", texts)
        runs = [(r.text, r.bold, r.italic) for r in out.paragraphs[0].runs if r.text]
        self.assertEqual(runs[0], ("Жирное начало ", True, None))
        self.assertEqual(runs[1], ("и поле ТОО «Ромашка»", None, None))
        self.assertEqual(runs[-1], (" и курсивный хвост", None, True))

    def test_field_out_of_reach_goes_to_missing(self):
        """Поле там, куда замена не достаёт (перемещённый текст в режиме правок): документ человеку."""
        import docx
        from docx.oxml import parse_xml
        from docx.oxml.ns import nsdecls
        d = docx.Document()
        d.add_paragraph("Обычное {{дата}}")
        d.element.body.insert(0, parse_xml(
            f'<w:p {nsdecls("w")}><w:moveTo w:id="1" w:author="a"><w:r><w:t>Перенесено {{{{Подпись}}}}</w:t></w:r></w:moveTo></w:p>'))
        d.save(self.c.proc / "shablon.docx")
        m = self.c.module()
        _, missing = m.fill_docx({"дата": "09.11.2026"}, "pismo-01.docx")
        self.assertEqual(missing, ["Подпись"])

    def test_table_field_inside_cell_keeps_paragraph_after(self):
        import docx
        d = docx.Document()
        t = d.add_table(rows=1, cols=1)
        t.cell(0, 0).text = "{{Таблица}}"
        d.save(self.c.proc / "shablon.docx")
        m = self.c.module()
        m.fill_docx({"Таблица": [["Документ", "Сумма"], ["№ 41", "1"]]}, "pismo-01.docx")
        out = docx.Document(self.c.out / "pismo-01.docx")
        tc = out.tables[0].cell(0, 0)._tc
        kids = [k.tag.split("}")[1] for k in tc if not k.tag.endswith("}tcPr")]
        self.assertEqual(kids, ["tbl", "p"])  # ячейка кончается абзацем, иначе Word считает файл испорченным
        self.assertEqual(out.tables[0].cell(0, 0).tables[0].cell(1, 0).text, "№ 41")

    def test_template_from_person_file_brackets_become_fields(self):
        shutil.copy(CASE / "shablon_otcheta.docx", self.c.input / "template.docx")
        code = (self.c.proc / "run.py").read_text(encoding="utf-8").replace('SOURCE_TEMPLATE = ""', 'SOURCE_TEMPLATE = "template.docx"')
        (self.c.proc / "run.py").write_text(code, encoding="utf-8")
        m = self.c.module()
        m.ensure_template()
        texts, _ = self.texts(self.c.proc / "shablon.docx")
        joined = "\n".join(texts)
        self.assertIn("{{Получатель}}", joined)
        self.assertIn("Исх. № ____ от {{дата}}", joined)
        self.assertNotIn("[", joined)
        before = (self.c.proc / "shablon.docx").read_bytes()
        m.ensure_template()  # готовый шаблон не переделывается: человек мог поправить его в Word
        self.assertEqual((self.c.proc / "shablon.docx").read_bytes(), before)

    def test_template_from_skill_text(self):
        m = self.c.module()
        m.ensure_template()
        texts, _ = self.texts(self.c.proc / "shablon.docx")
        self.assertEqual(texts, m.SHABLON_TEXT)

    def write_rows(self):
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["Поставщик", "Сумма"])
        ws.append(["ТОО «Ромашка»", 1250000])
        ws.append(["ТОО «Василёк»", None])
        wb.save(self.c.input / "rashozhdeniya.xlsx")

    def edit_program(self, old, new):
        code = (self.c.proc / "run.py").read_text(encoding="utf-8")
        self.assertEqual(code.count(old), 1, f"в образце нет ровно одной строки {old!r}")
        (self.c.proc / "run.py").write_text(code.replace(old, new), encoding="utf-8")

    def type_into_template(self, old, new):
        """Человек открыл shablon.docx в Word и напечатал своё вместо поля."""
        import docx
        d = docx.Document(self.c.proc / "shablon.docx")
        m = self.c.module()
        found = [p for p in m.paragraphs(d) if old in p.text]
        self.assertTrue(found, f"в шаблоне нет {old}")
        for p in found:
            p.runs[0].text = p.text.replace(old, new)
            for r in p.runs[1:]:
                r.text = ""
        d.save(self.c.proc / "shablon.docx")

    def test_example_main_one_document_per_row(self):
        self.write_rows()
        self.make_template(with_table=False)
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        # Подписи в программе нет: пока поле в шаблоне, каждое письмо человеку.
        self.assertEqual(r["row_status"], ["info", "info"])
        texts, _ = self.texts(self.c.out / "pismo-01.docx")
        self.assertIn("Подпись: [нет данных]", texts)
        rows = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        self.assertEqual([x[-1] for x in rows[1:]], ["поля с пометкой: Фамилия И. О.", "поля с пометкой: Сумма, Фамилия И. О."])
        # Человек один раз напечатал подпись в шаблоне вместо поля: дальше она обычный текст.
        self.type_into_template("{{Фамилия И. О.}}", "А. Иванов")
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        self.assertEqual(r["row_status"], ["info", None])
        self.assertEqual(r["rows"][0][0], "ТОО «Василёк»")
        self.assertIn("Разобрать вручную: 1", r["summary"])
        self.assertEqual(r["sverka"]["документов"], 2)
        # Ключевое значение документа пишется всегда; «разобрать вручную» только на карточке и в списке Excel.
        self.assertEqual(r["sverka"]["по строкам"], {"ТОО «Василёк»": "[нет данных]", "ТОО «Ромашка»": "1 250 000,00"})
        self.assertTrue((self.c.out / "pismo-01.docx").is_file() and (self.c.out / "pismo-02.docx").is_file())
        texts, _ = self.texts(self.c.out / "pismo-01.docx")
        self.assertIn("Подпись: А. Иванов", texts)
        texts, _ = self.texts(self.c.out / "pismo-02.docx")
        self.assertIn("Сумма: [нет данных] тенге, дата 09.11.2026.", texts)
        rows = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        self.assertEqual(rows[1][-1], "поля с пометкой: Сумма")
        if NODE:
            code, out = self.c.node("list")
            self.assertEqual(code, 0, out)
            self.assertNotIn("Ошибка", out)
            code, out = self.c.node("compare", "proba")  # эталона нет, но проверка программы прошла
            self.assertEqual(code, 2, out)
            self.assertNotIn("нельзя", out)

    def test_skill_marker_field_keeps_document_manual(self):
        """Поле, которое скилл помечает «[уточнить: ...]», отдаёт письмо человеку и при вписанной подписи."""
        self.write_rows()
        self.make_template(with_table=False)
        self.c.module().ensure_template()
        self.type_into_template("{{Фамилия И. О.}}", "А. Иванов")
        import docx
        d = docx.Document(self.c.proc / "shablon.docx")
        d.add_paragraph("Ответить до: {{Срок ответа}}")
        d.save(self.c.proc / "shablon.docx")
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        self.assertEqual(r["row_status"], ["info", "info"])
        texts, _ = self.texts(self.c.out / "pismo-01.docx")
        self.assertIn("Ответить до: [уточнить: срок ответа]", texts)
        rows = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        self.assertEqual([x[-1] for x in rows[1:]], ["поля с пометкой: Срок ответа", "поля с пометкой: Срок ответа, Сумма"])

    def test_marker_from_skill_documents_go_to_manual(self):
        """Скилл пишет «[уточнить]»: та же пометка у полей без данных, письма с ней человеку."""
        self.write_rows()
        self.make_template(with_table=False)
        self.edit_program('NO_DATA = "[нет данных]"', 'NO_DATA = "[уточнить]"')
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        self.assertEqual(r["row_status"], ["info", "info"])
        self.assertIn("Разобрать вручную: 2", r["summary"])
        self.assertEqual(r["sverka"]["по строкам"], {"ТОО «Ромашка»": "1 250 000,00", "ТОО «Василёк»": "[уточнить]"})
        texts, _ = self.texts(self.c.out / "pismo-01.docx")
        self.assertIn("Подпись: [уточнить]", texts)
        texts, _ = self.texts(self.c.out / "pismo-02.docx")
        self.assertIn("Сумма: [уточнить] тенге, дата 09.11.2026.", texts)
        rows = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        self.assertEqual([x[-1] for x in rows[1:]], ["поля с пометкой: Фамилия И. О.", "поля с пометкой: Сумма, Фамилия И. О."])

    def test_marker_in_value_or_template_text(self):
        """Пометка с пояснением в значении поля и пометка в самом тексте шаблона: документ тоже человеку."""
        self.make_template(with_table=False)
        m = self.c.module()
        values = {"Наименование поставщика": "ТОО «Ромашка»", "дата": "09.11.2026", "Сумма": "1 250 000,00",
                  "Фамилия И. О.": "[уточнить: подписант]"}
        _, missing = m.fill_docx(values, "pismo-01.docx")
        self.assertEqual(missing, ["Фамилия И. О."])
        texts, _ = self.texts(self.c.out / "pismo-01.docx")
        self.assertIn("Подпись: [уточнить: подписант]", texts)
        _, missing = m.fill_docx(dict(values, **{"Фамилия И. О.": "А. Иванов [1]"}), "pismo-02.docx")
        self.assertEqual(missing, [])  # скобки без пометки: не пометка
        import docx
        d = docx.Document(self.c.proc / "shablon.docx")
        d.add_paragraph("Срок оплаты: [уточнить: срок оплаты]. Договор: [нет данных]")
        d.save(self.c.proc / "shablon.docx")
        _, missing = m.fill_docx(dict(values, **{"Фамилия И. О.": "А. Иванов"}), "pismo-03.docx")
        self.assertEqual(missing, ["[нет данных]", "[уточнить: срок оплаты]"])

    @unittest.skipUnless(NODE, "нет node")
    def test_drafts_check_compares_key_values(self):
        """Сверка черновиков сравнивает ключевые значения документов и тогда, когда у документов пометка
        (подпись ещё не вписана): эталон из настоящих значений, одно неверное: сверка не пройдена. Все верные:
        пройдена, а почему документы у человека, объясняют пометка на карточке и список Excel."""
        self.write_rows()
        self.make_template(with_table=False)
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        self.assertEqual(r["row_status"], ["info", "info"])  # подпись не вписана: оба письма человеку
        self.assertEqual(r["row_note"], ["разобрать вручную", "разобрать вручную"])
        rows = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        self.assertEqual([x[-1] for x in rows[1:]], ["поля с пометкой: Фамилия И. О.", "поля с пометкой: Сумма, Фамилия И. О."])
        etalon = self.c.out / "etalon-skilla.json"

        def compare(values):
            etalon.write_text(json.dumps({"документов": 2, "по строкам": values}, ensure_ascii=False), encoding="utf-8")
            return self.c.node("compare", "proba")

        code, out = compare({"ТОО «Ромашка»": "1 300 000,00", "ТОО «Василёк»": "[нет данных]"})
        self.assertEqual(code, 1, out)
        self.assertIn("По строкам: совпало 1 из 2.", out)
        self.assertIn("ТОО «Ромашка»: в эталоне «1 300 000,00», у программы «1 250 000,00»", out)
        self.assertIn("Итог сверки: расхождений 1.", out)
        code, out = compare({"ТОО «Ромашка»": 1250000, "ТОО «Василёк»": "[нет данных]"})
        self.assertEqual(code, 0, out)
        self.assertIn("По строкам: совпало 2 из 2.", out)
        self.assertIn("Документов: 2, как в эталоне.", out)
        self.assertTrue(out.rstrip().endswith("Итог сверки: результат программы совпал с эталоном."), out)
        self.assertNotIn("словарь", out)

    @unittest.skipUnless(NODE, "нет node")
    def test_samples_pass_program_check(self):
        """Образцы справки и программа демо не содержат того, что сверка запрещает программе процесса."""
        demo = (ROOT / "templates" / "processes" / "svetofor-tochek" / "run.py").read_text(encoding="utf-8")
        for parts in ((), ("slovar", "main_slovar"), ("word", "main_word"), ("slovar", "word", "main_word"),
                      ("word", "dva", "main_dva"), demo):
            c = Cabinet(parts if isinstance(parts, str) else compose(*parts))
            self.addCleanup(c.close)
            code, out = c.node("compare", "proba")
            self.assertNotIn("нельзя", out, "демо" if isinstance(parts, str) else parts)


def sheet(path, name):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True)
    try:
        return [list(r) for r in wb[name].iter_rows(values_only=True)]
    finally:
        wb.close()


# Отличия договора поставщика от типовой формы (задача 9 кейса): то, что программа должна найти сама.
CASE9_DIFFS = {
    "4.2": "изменён",
    "нет/4.4": "добавлен",
    "5.2": "изменён (мелкая правка)",
    "6.1": "изменён",
    "6.2": "изменён",
    "9/нет": "удалён",
}
FORM_FILE, DOC_FILE = "dogovor_tipovaya_forma.docx", "dogovor_postavshchika.docx"
RISK = "оценить риск: решает юрист"
HINT = "Выход: положите в папку процесса русский текст договора отдельным документом Word с нумерованными разделами."
KZ = ["Тараптар осы шарттың талаптарын орындауға міндетті.", "Жеткізуші тауарды уақытында жеткізеді.",
      "Сатып алушы тауар құнын төлейді.", "Дауларды тараптар келіссөз арқылы шешеді."]


KZ_FILL = "Тараптар шарттың талаптарын орындауға міндетті және жауапты "
KZ_RUS_LETTERS = str.maketrans("әғқңөұүһіӘҒҚҢӨҰҮҺІ", "агкноуухиАГКНОУУХИ")  # казахский текст русскими буквами


def mirror(text):
    """Казахский текст длиной с русский абзац."""
    return (KZ_FILL * (len(text) // len(KZ_FILL) + 1))[:max(len(text), 20)]


def paragraphs_before_spec(d):
    """Абзацы до первой таблицы (спецификации) и сама таблица."""
    from docx.oxml.ns import qn
    body = d.element.body
    first = next(e for e in body if e.tag == qn("w:tbl"))
    paras = []
    for e in body:
        if e is first:
            break
        if e.tag == qn("w:p"):
            paras.append(e)
    return paras, first


def merged_row(table, text):
    """Строка таблицы во всю ширину (ячейки объединены) с одним абзацем."""
    row = table.add_row()
    cell = row.cells[0].merge(row.cells[1])
    for extra in cell.paragraphs[1:]:
        extra._p.getparent().remove(extra._p)
    cell.paragraphs[0].text = text
    return row


def bilingual_sections(merged_title=False, merged_headings=False, kz=mirror, ru_left=False):
    """Название договора над таблицами, текст до спецификации: по таблице в два столбца на раздел (казахский
    слева, русский справа). merged_title: первая строка во всю ширину с названием на двух языках;
    merged_headings: заголовок раздела строкой во всю ширину «4. Название / казахский заголовок»;
    ru_left: русский столбец слева."""
    def fn(d):
        from docx.oxml.ns import qn
        paras, first = paragraphs_before_spec(d)
        groups = [[]]
        for p in paras[1:]:  # название документа остаётся над таблицами
            style = p.find(f"{qn('w:pPr')}/{qn('w:pStyle')}")
            heading = style is not None and style.get(qn("w:val")) == "Heading2"
            if heading and groups[-1]:
                groups.append([])
            groups[-1].append((p, heading))
        for k, group in enumerate(groups):
            table = d.add_table(rows=0, cols=2)
            if merged_title and k == 0:
                merged_row(table, "ДОГОВОР ПОСТАВКИ ЮВЕЛИРНЫХ КОМПЛЕКТУЮЩИХ / ЗЕРГЕРЛІК БӨЛШЕКТЕРДІ ЖЕТКІЗУ ШАРТЫ")
            for p, heading in group:
                text = "".join(x.text or "" for x in p.iter(qn("w:t")))
                if heading and merged_headings:
                    merged_row(table, f"{text} / {kz(text)}")
                    p.getparent().remove(p)
                    continue
                cells = table.add_row().cells
                ru, other = (cells[0], cells[1]) if ru_left else (cells[1], cells[0])
                ru._tc.append(p)
                other.paragraphs[0].text = kz(text)
            first.addprevious(table._tbl)
    return fn


def two_column_table(rows, after=None):
    """Таблица в два столбца по строкам rows: после абзаца, который начинается с after, или в конце текста."""
    def fn(d):
        table = d.add_table(rows=0, cols=2)
        for left, right in rows:
            cells = table.add_row().cells
            cells[0].text, cells[1].text = left, right
        if after:
            next(p for p in d.paragraphs if p.text.startswith(after))._p.addnext(table._tbl)
        else:
            body = d.element.body
            body.insert(len(body) - 1, table._tbl)  # перед свойствами раздела документа
    return fn


def kazakh_names_table(prepay):
    """Русская таблица условий с казахскими названиями и именами (проба ревью), предоплата prepay процентов."""
    return (("Условие оплаты", f"Предоплата {prepay} процентов стоимости партии, остаток после приёмки товара на складе"),
            ("Срок поставки партии", "Не позднее пяти календарных дней с даты заявки покупателя"),
            ("Грузополучатель", "ТОО «Қазақстан Темір Жолы», г. Қарағанды"),
            ("Контактное лицо", "Нұрланов Ғалым Қайратұлы"))


def conditions(prepay, after=None):
    """Таблица условий «условие | значение», как в пробе ревью: предоплата prepay процентов."""
    return two_column_table((
        ("Условие оплаты", f"Предоплата {prepay} процентов стоимости партии, остаток после приёмки товара на складе"),
        ("Срок поставки партии", "Не позднее пяти календарных дней с даты заявки покупателя")), after)


def bilingual(russian_left=False, one_row=False, other=None, mixed=False, merged_title=False):
    """Текст до первой таблицы (спецификации) в таблицу в два столбца: русский абзац и рядом казахский
    (other(текст): свой текст второго столбца; mixed: казахская фраза и в русском столбце; merged_title:
    сверху строка во всю ширину с названием на двух языках). По строке на абзац или всё в одной строке."""
    def fn(d):
        from docx.oxml.ns import qn
        body = d.element.body
        first = next(e for e in body if e.tag == qn("w:tbl"))
        paras = []
        for e in body:
            if e is first:
                break
            if e.tag == qn("w:p"):
                paras.append(e)
        table = d.add_table(rows=1 if one_row else len(paras), cols=2)
        for k, p in enumerate(paras):
            cells = table.rows[0 if one_row else k].cells
            ru, kz = (cells[0], cells[1]) if russian_left else (cells[1], cells[0])
            text = "".join(x.text or "" for x in p.iter(qn("w:t")))
            ru._tc.append(p)
            if mixed:
                ru.add_paragraph(KZ[k % len(KZ)])
            kz.add_paragraph(other(text) if other else KZ[k % len(KZ)])
        if merged_title:
            row = merged_row(table, "ДОГОВОР ПОСТАВКИ ЮВЕЛИРНЫХ КОМПЛЕКТУЮЩИХ / ЗЕРГЕРЛІК БӨЛШЕКТЕРДІ ЖЕТКІЗУ ШАРТЫ")
            table._tbl.remove(row._tr)
            table.rows[0]._tr.addprevious(row._tr)
        first.addprevious(table._tbl)
    return fn


def set_text(p, text):
    """Текст абзаца одним куском, с оформлением первого куска."""
    if p.runs:
        p.runs[0].text = text
        for r in p.runs[1:]:
            r._r.getparent().remove(r._r)
    else:
        p.add_run(text)


def case_variant(name, dst, change=None):
    """Копия договора из fixtures, изменённая функцией change(документ)."""
    import docx
    d = docx.Document(str(FIXTURES / name))
    if change:
        change(d)
    d.save(str(dst))
    return dst


def headings(change):
    """Правка заголовков разделов (стиль Heading 2): change(абзац, номер, название)."""
    def fn(d):
        for p in d.paragraphs:
            m = re.match(r"(\d+)\.\s+(.*)", p.text)
            if p.style.name == "Heading 2" and m:
                change(p, int(m.group(1)), m.group(2))
    return fn


@unittest.skipUnless(HAVE_LIBS, "нет openpyxl или python-docx")
class TwoDocuments(unittest.TestCase):
    def setUp(self):
        self.c = Cabinet(compose("word", "dva", "main_dva"))
        self.addCleanup(self.c.close)

    def put_case(self, *names):
        for name in names or (FORM_FILE, DOC_FILE):
            shutil.copy(FIXTURES / name, self.c.input / name)

    def run_variant(self, change_form=None, change_doc=None):
        """Программа на копиях файлов кейса с правками; result.json."""
        case_variant(FORM_FILE, self.c.input / FORM_FILE, change_form)
        case_variant(DOC_FILE, self.c.input / DOC_FILE, change_doc)
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return self.c.result()

    def spec_of(self, change_doc):
        """Проверка спецификации договора кейса с правкой."""
        m = self.c.module()
        doc = m.read_document(case_variant(DOC_FILE, self.c.input / DOC_FILE, change_doc))
        return m.check_spec(doc, dict(m.contract_card(doc)).get(m.SUM_CARD))

    def test_rule_blanks_numbers_minor_edit(self):
        m = self.c.module()
        self.assertTrue(m.same_text("г. Астана, [дата]", "г. Астана, 18.09.2026"))
        self.assertTrue(m.same_text("Исх. № ____ от «___» ________ 20__ г.", "Исх. № 41 от «18» сентября 2026 г."))
        self.assertTrue(m.same_text("Сумма «  » тенге", "Сумма «120 000» тенге"))
        for blank in ("<срок>", "{срок}", "……", "......", "«...»"):
            self.assertTrue(m.same_text(f"Срок поставки: {blank} дней.", "Срок поставки: 5 дней."), blank)
        self.assertTrue(m.same_text("Цена «ТОВАРА» фиксируется", "цена товара  фиксируется."))  # регистр, кавычки, пробелы
        self.assertFalse(m.same_text("г. Астана, [дата]", "г. Алматы, 18.09.2026"))
        self.assertEqual(m.numbers_in("составляет 46\u00a0400\u00a0000,00 тенге"), [46400000.0])
        self.assertEqual(m.numbers_in("в течение 3 (трёх) рабочих дней"), m.numbers_in("в течение трёх рабочих дней"))
        self.assertEqual(m.numbers_in("120 200 000 (сто двадцать миллионов двести тысяч) тенге"), [120200000.0])
        _, st = m.pair_status("уведомляет в течение 3 (трёх) рабочих дней.", "уведомляет в течение трёх рабочих дней.")
        self.assertEqual(st, "изменён (мелкая правка)")
        # Числа, отрицание, «более/менее», сторона: смысл другой, это не мелкая правка.
        for before, after in (
            ("неустойку 0,1 % в день, но не более 10 % от стоимости партии.",
             "неустойку 0,1 % в день, но не более 5 % от стоимости партии."),
            ("неустойку 0,1 % в день, но не более 10 % от стоимости непоставленного Товара по договору.",
             "неустойку 0,1 % в день, но не менее 10 % от стоимости непоставленного Товара по договору."),
            ("За просрочку поставки Поставщик уплачивает неустойку 0,1 % от стоимости непоставленного Товара за каждый день",
             "За просрочку поставки Покупатель уплачивает неустойку 0,1 % от стоимости непоставленного Товара за каждый день"),
            ("Поставщик вправе расторгнуть договор в одностороннем порядке, уведомив другую сторону за 30 дней.",
             "Поставщик не вправе расторгнуть договор в одностороннем порядке, уведомив другую сторону за 30 дней."),
        ):
            score, st = m.pair_status(before, after)
            self.assertGreaterEqual(score, m.MINOR, after)
            self.assertEqual(st, "изменён", after)

    def test_field_filled_with_clause_goes_to_person(self):
        m = self.c.module()
        suspicious = (
            ("Поставщик: [наименование, БИН, адрес, банковские реквизиты].",
             "Поставщик: ТОО «X». Стороны договорились, что раздел 6 не применяется."),
            ("3.2. Срок поставки партии: [срок] с даты заявки.",
             "3.2. Срок поставки партии: 5 календарных дней, при этом Поставщик вправе в одностороннем порядке "
             "продлить срок поставки на 30 дней с даты заявки."),
            ("4.1. Общая сумма договора составляет [сумма] тенге с учётом НДС и определяется Спецификацией.",
             "4.1. Общая сумма договора составляет 120 200 000 тенге без учёта НДС; НДС уплачивается Покупателем "
             "сверх суммы, сумма в тенге с учётом НДС и определяется Спецификацией."),
        )
        for form, doc in suspicious:
            self.assertTrue(m.same_text(form, doc), doc)  # текст формы на месте, отличием не считается
            problems = m.field_problems(form, doc)
            self.assertEqual(len(problems), 1, doc)
            self.assertIn("нет ли в нём новых условий", problems[0])
        fine = (
            ("г. Астана, [дата]", "г. Астана, 18.09.2026"),
            ("в лице [должность], действующего", "в лице директора Иванова А. Б., действующего"),
            ("Покупатель: ТОО «Ювелирный дом», [адрес].", "Покупатель: ТОО «Ювелирный дом», г. Астана, ул. Абая, 10."),
            ("составляет [сумма] тенге", "составляет 120 200 000 (сто двадцать миллионов двести тысяч) тенге"),
        )
        for form, doc in fine:
            self.assertEqual(m.field_problems(form, doc), [], doc)
        self.assertEqual(m.field_problems("г. Астана, [дата]", "г. Астана, [дата]"), ["поле [дата] не заполнено"])

    def test_spec_numbers_not_read_go_to_person(self):
        m = self.c.module()
        head = ["№", "Товар", "Ед.", "Количество", "Цена за ед.", "Сумма"]
        doc = [
            {"heading": "", "items": [], "tables": []},
            {"heading": "Приложение 1. Спецификация", "items": [], "tables": [[
                head, ["1", "Замок карабин 925", "шт", "200 000", "228,00", "45 600 000,00"],
                ["2", "Замок пружинный 925", "шт", "[количество]", "279,00", "н/д"]]]},
            {"heading": "Приложение 2. Техническая спецификация", "items": [], "tables": [[
                ["Товар", "Количество"], ["Замок карабин 925", "200 000"]]]},
        ]
        res = m.check_spec(doc, "4.1. Общая сумма договора составляет сто двадцать миллионов тенге.")
        unread = dict(res["unread"])
        self.assertEqual(unread["спецификация, Замок пружинный 925"], "не число: количество «[количество]», сумма «н/д»")
        self.assertEqual(unread["Сумма договора, п. 4.1"], "в тексте пункта нет суммы числом")  # прописью не считается
        self.assertIn("нет строки «Итого» или «Всего»", unread["спецификация"])
        self.assertEqual(res["rows"][0], ["Замок карабин 925", 200000, 228, 45600000, 45600000, 0])
        self.assertEqual(res["rows"][-2], ["Итого по пересчёту", None, None, None, None, None])  # пропуск: не пересчитать
        self.assertIsNone(res["diff"])
        self.assertEqual(res["tech"], [["Замок карабин 925", 200000, 200000, 0], ["Замок пружинный 925", None, None, None]])

    def test_spec_totals_vsego_merged_missing_vat(self):
        def vsego(d):  # «Всего» в столбце №, ячейка товара пустая
            row = d.tables[0].rows[-1]
            set_text(row.cells[0].paragraphs[0], "Всего")
            set_text(row.cells[1].paragraphs[0], "")
        res = self.spec_of(vsego)
        self.assertIn(["Всего", None, None, 120200000, 118200000, 2000000], res["rows"])
        self.assertEqual(res["diff"], 2000000)

        def merged(d):  # «Итого» в ячейке, объединённой на пять столбцов
            row = d.tables[0].rows[-1]
            cell = row.cells[0].merge(row.cells[4])
            for p in cell.paragraphs[1:]:
                p._p.getparent().remove(p._p)
            set_text(cell.paragraphs[0], "Итого")
        res = self.spec_of(merged)
        self.assertIn(["Итого", None, None, 120200000, 118200000, 2000000], res["rows"])
        self.assertEqual(res["unread"], [])

        def no_total(d):
            tr = d.tables[0].rows[-1]._tr
            tr.getparent().remove(tr)
        res = self.spec_of(no_total)
        self.assertIsNone(res["diff"])
        self.assertIn("нет строки «Итого» или «Всего»", dict(res["unread"])["спецификация"])
        self.assertIn(["Сумма договора, п. 4.1", None, None, 120200000, 118200000, 2000000], res["rows"])

        def vat(d):  # «Итого без НДС», «НДС 12 %», «Итого с НДС»
            t = d.tables[0]
            last = t.rows[-1]._tr
            for _ in range(2):
                last.addnext(copy.deepcopy(last))
            for row, (name, value) in zip(t.rows[-3:], (("Итого без НДС", "107 321 428,57"), ("НДС 12 %", "12 878 571,43"),
                                                        ("Итого с НДС", "120 200 000,00"))):
                set_text(row.cells[1].paragraphs[0], name)
                set_text(row.cells[5].paragraphs[0], value)
        res = self.spec_of(vat)
        self.assertIsNone(res["diff"])
        note = dict(res["unread"])["спецификация"]
        self.assertIn("несколько итоговых строк (Итого без НДС, НДС 12 %, Итого с НДС)", note)
        self.assertIn("118 200 000,00", note)
        self.assertEqual([p for p in res["problems"] if "НДС" in p], [])  # строки НДС товаром не считаются
        self.assertIn("Колечко соединительное 925: 46 400 000,00 при пересчёте 44 400 000,00", res["problems"])

    def test_headings_auto_numbered_roman_and_final_dot(self):
        """Номер раздела списком Word, римский номер, «4. Название.» с точкой без стиля: тот же разбор."""
        romans = "I II III IV V VI VII VIII IX X XI".split()

        def dot(p, n, title):
            p.style = p.part.document.styles["Normal"]
            set_text(p, f"{n}. {title}.")
        variants = {
            "нумерация списком": (headings(lambda p, n, title: set_text(p, title)), "Конфиденциальность/нет"),
            "римские номера": (headings(lambda p, n, title: set_text(p, f"{romans[n - 1]}. {title}")), "IX/нет"),
            "точка в конце": (headings(dot), "9/нет"),
        }
        for name, (change, deleted) in variants.items():
            with self.subTest(name):
                r = self.run_variant(change, change)
                expected = {k: v for k, v in CASE9_DIFFS.items() if k != "9/нет"} | {deleted: "удалён"}
                self.assertEqual(r["sverka"]["по строкам"], expected)
                self.assertEqual(r["sverka"]["итоги"]["удалено"], 1)
                status = {row[0]: row[1] for row in r["rows"]}
                self.assertEqual(status["10.1/9.1"], "совпадает")
                self.assertFalse([row for row in r["rows"] if str(row[0]).startswith(("документ:", "карточка:"))])
                self.assertIn("Сумма договора, п. 4.1: 120 200 000,00 при пересчёте 118 200 000,00", r["summary"])

    def test_sections_not_found_go_to_person(self):
        def plain_headings(p, n, title):  # заголовок обычным жирным текстом, без номера и стиля
            p.style = p.part.document.styles["Normal"]
            set_text(p, title.upper())
            p.runs[0].bold = True
        r = self.run_variant(headings(plain_headings), headings(plain_headings))
        self.assertEqual(r["status"], "yellow")
        self.assertIn("Сверка неполная", r["summary"])
        why = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        self.assertTrue(any(row[0] == f"документ: {DOC_FILE}" and "разделы не распознаны" in row[-1] for row in why))

    def test_contract_in_table_goes_to_person(self):
        """Договор свёрстан таблицей в один столбец: вне таблиц текста нет, подсказка, что делать."""
        def in_table(d):
            paras, first = paragraphs_before_spec(d)
            table = d.add_table(rows=1, cols=1)
            for p in paras:
                table.rows[0].cells[0]._tc.append(p)
            first.addprevious(table._tbl)
        r = self.run_variant(in_table, in_table)
        self.assertEqual(r["status"], "yellow")
        self.assertIn("Сверка неполная", r["summary"])
        self.assertEqual(r["sverka"]["по строкам"], {})
        why = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        row = next(row for row in why if row[0] == f"документ: {DOC_FILE}")
        self.assertIn("вне таблиц нет текста", row[-1])
        self.assertTrue(row[-1].endswith(HINT), row[-1])

    def test_bilingual_two_columns_read_by_russian_column(self):
        """Договор на двух языках в два столбца: программа читает русский столбец, отличия те же, что у кейса 9."""
        variants = {
            "оба двуязычные": (bilingual(), bilingual(russian_left=True, one_row=True)),
            "только договор": (None, bilingual()),
            "только форма": (bilingual(one_row=True), None),
            "название строкой во всю ширину": (bilingual(merged_title=True), bilingual(merged_title=True)),
            "по таблице на раздел": (bilingual_sections(), bilingual_sections()),
            "по разделам, заголовки и название во всю ширину": (
                bilingual_sections(merged_title=True, merged_headings=True),
                bilingual_sections(merged_title=True, merged_headings=True)),
            "форма одной таблицей, договор по разделам": (bilingual(), bilingual_sections(merged_headings=True)),
        }
        for name, (change_form, change_doc) in variants.items():
            with self.subTest(name):
                r = self.run_variant(change_form, change_doc)
                self.assertEqual(r["sverka"]["по строкам"], CASE9_DIFFS)
                self.assertEqual(r["sverka"]["итоги"]["разница спецификации"], 2000000)
                self.assertNotIn("Сверка неполная", r["summary"])
                phrase = "Договор двуязычный: сверялся русский текст." if change_doc else \
                    "Типовая форма двуязычная: сверялся русский текст."
                self.assertIn(phrase, r["summary"])
                manual = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")[1:]
                self.assertEqual(len(manual), len(CASE9_DIFFS) + 2, manual)  # как у кейса 9: отличия и два поля
                card = dict(sheet(self.c.out / "sverka-dogovora.xlsx", "Карточка условий")[1:])
                self.assertEqual(card["Номер"], "ПС-2026/118")
                self.assertNotIn("[нет данных]", card.values())

    def test_bilingual_language_unclear_goes_to_person(self):
        """Оба столбца на русском (или оба с казахскими буквами): язык не определить, не угадывать."""
        for name, change in (("оба русские", bilingual(other=lambda text: text)), ("оба с казахскими", bilingual(mixed=True)),
                             ("казахский русскими буквами", bilingual(other=lambda text: KZ[0].translate(KZ_RUS_LETTERS)))):
            with self.subTest(name):
                r = self.run_variant(None, change)
                self.assertEqual(r["status"], "yellow")
                self.assertNotIn("двуязычный", r["summary"])
                why = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
                row = next(row for row in why if row[0] == f"документ: {DOC_FILE}")
                self.assertIn("вне таблиц нет текста", row[-1])
                self.assertIn("язык столбцов не определить", row[-1])
                self.assertTrue(row[-1].endswith(HINT), row[-1])

    def test_bilingual_short_section_change_is_seen(self):
        """По таблице на раздел, раздел 7 из одного короткого пункта: правка «один год» → «три года» видна."""
        def short(years):
            def fn(d):
                p = next(p for p in d.paragraphs if p.text.startswith("7.1."))
                set_text(p, f"7.1. Договор действует {years}.")
                bilingual_sections(merged_headings=True)(d)
            return fn
        r = self.run_variant(short("один год"), short("три года"))
        self.assertEqual(r["sverka"]["по строкам"], dict(CASE9_DIFFS, **{"7.1": "изменён"}))
        self.assertNotIn("Сверка неполная", r["summary"])
        self.assertIn("Договор двуязычный: сверялся русский текст.", r["summary"])

    def test_bilingual_unread_tables_are_loud(self):
        """Казахский столбец набран русскими буквами: язык не определить. Название над таблицами прочитано,
        пункты нет: строка «вне таблиц нет текста» с подсказкой, без слов, что пункты сравнивались."""
        change = bilingual_sections(merged_headings=True, kz=lambda text: mirror(text).translate(KZ_RUS_LETTERS))
        r = self.run_variant(change, change)
        self.assertEqual(r["status"], "yellow")
        why = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        row = next(row for row in why if row[0] == f"документ: {DOC_FILE}")
        self.assertIn("вне таблиц нет текста (документ свёрстан таблицей в два столбца, язык столбцов не определить)",
                      row[-1])
        self.assertNotIn("сравнивались как", row[-1])
        self.assertTrue(row[-1].endswith(HINT), row[-1])
        # Часть таблиц прочитана по русскому столбцу, часть нет: тоже громко, с подсказкой.
        m = self.c.module()
        sections = [{"label": "шапка", "items": [("шапка, абз. 1", "т", "т")], "unclear": 2, "bilingual": 5},
                    {"label": "1", "items": [("1.1", "т", "1.1. т")]}]
        problems = m.layout_problems(sections)
        self.assertEqual(len(problems), 1)
        self.assertIn("не прочитана", problems[0])
        self.assertTrue(problems[0].endswith(HINT))

    def test_conditions_table_compared_row_by_row(self):
        """Таблица «условие | значение» в русском договоре: строки сверяются как пункты раздела, где она стоит.
        Предоплата 30 процентов в форме, 100 в договоре: «изменён» и человеку, остальные строки совпадают."""
        for name, after, key in (("в конце, как в пробе ревью", None, "Приложение 2. Техническая спецификация"),
                                 ("в разделе 4", "4.3.", "4")):
            with self.subTest(name):
                r = self.run_variant(conditions(30, after), conditions(100, after))
                key = f"{key}, «Условие оплаты»"
                self.assertEqual(r["sverka"]["по строкам"], dict(CASE9_DIFFS, **{key: "изменён"}))
                status = {row[0]: row[1] for row in r["rows"]}
                self.assertEqual(status[key.replace("Условие оплаты", "Срок поставки партии")], "совпадает")
                manual = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")[1:]
                row = next(row for row in manual if row[0] == key)
                self.assertIn("Предоплата 30 процентов", row[2])
                self.assertIn("Предоплата 100 процентов", row[3])
                self.assertEqual(row[-1], RISK)
                self.assertNotIn("Сверка неполная", r["summary"])
                tech = sheet(self.c.out / "sverka-dogovora.xlsx", "Техспецификация")
                self.assertEqual(len(tech), 5)  # техспецификация в том же разделе читается как раньше

    def test_conditions_table_with_kazakh_names(self):
        """Русская таблица условий с казахскими названиями и именами (проба ревью): не договор на двух языках,
        сверяется построчно, предоплата 30 и 100 процентов: «изменён»."""
        r = self.run_variant(two_column_table(kazakh_names_table(30)), two_column_table(kazakh_names_table(100)))
        key = "Приложение 2. Техническая спецификация, «Условие оплаты»"
        self.assertEqual(r["sverka"]["по строкам"], dict(CASE9_DIFFS, **{key: "изменён"}))
        status = {row[0]: row[1] for row in r["rows"]}
        self.assertEqual(status["Приложение 2. Техническая спецификация, «Контактное лицо»"], "совпадает")
        self.assertNotIn("двуязычн", r["summary"])
        self.assertNotIn("Сверка неполная", r["summary"])
        m = self.c.module()
        self.assertFalse(m.kazakh_column("ТОО «Қазақстан Темір Жолы», г. Қарағанды Нұрланов Ғалым Қайратұлы"))
        self.assertTrue(m.kazakh_column(" ".join(KZ)))

    def test_russian_table_in_bilingual_contract(self):
        """Договор на двух языках по разделам и в разделе 4 русская таблица условий с казахскими именами (пробы
        ревью «a»: русский столбец справа, «b»: слева). Таблица сверяется построчно: «4, «Условие оплаты»» изменён."""
        def contract(prepay, ru_left):
            def fn(d):
                bilingual_sections(merged_headings=True, ru_left=ru_left)(d)
                section4 = next(t for t in d.tables if any("4.3. " in c.text for row in t.rows for c in row.cells))
                table = d.add_table(rows=0, cols=2)
                for left, right in kazakh_names_table(prepay):
                    cells = table.add_row().cells
                    cells[0].text, cells[1].text = left, right
                section4._tbl.addnext(table._tbl)
            return fn
        for name, ru_left in (("a: русский справа", False), ("b: русский слева", True)):
            with self.subTest(name):
                r = self.run_variant(contract(30, ru_left), contract(100, ru_left))
                self.assertEqual(r["sverka"]["по строкам"], dict(CASE9_DIFFS, **{"4, «Условие оплаты»": "изменён"}))
                status = {row[0]: row[1] for row in r["rows"]}
                self.assertEqual(status["4, «Контактное лицо»"], "совпадает")
                self.assertIn("Договор двуязычный: сверялся русский текст.", r["summary"])
                self.assertNotIn("Сверка неполная", r["summary"])
        # Русская таблица не вида «условие | значение» (длинный текст до первого раздела): абзацы слева направо.
        long_text = ("Поставщик обязуется поставлять Товар партиями в соответствии с заявками Покупателя и "
                     "обеспечивать его качество на всём протяжении срока действия договора")

        def top(days):
            def fn(d):
                bilingual_sections(merged_headings=True)(d)
                two_column_table(((long_text, f"Покупатель обязуется принимать и оплачивать Товар в течение {days} дней"),),
                                 after="Договор поставки")(d)
            return fn
        r = self.run_variant(top(30), top(10))
        self.assertEqual(r["sverka"]["по строкам"], dict(CASE9_DIFFS, **{"шапка, абз. 3": "изменён"}))
        self.assertNotIn("Сверка неполная", r["summary"])
        m = self.c.module()
        self.assertFalse(m.looks_kazakh("ТОО «Қазақстан Темір Жолы», г. Қарағанды Нұрланов Ғалым Қайратұлы"))
        self.assertTrue(m.looks_kazakh("Шарт бір жыл әрекет етеді."))  # коротко и без служебных слов

    def test_conditions_with_kazakh_addresses_in_bilingual_contract(self):
        """Договор на двух языках, русский столбец слева; в разделе 4 русская таблица условий, в адресах строчные
        казахские слова («көшесі», «даңғылы»). Слева короткие подписи: это таблица условий, не текст на двух
        языках, и правка значения видна: предоплата 30 и 100 процентов, «4, «Условие оплаты»» изменён."""
        rows = lambda prepay: (("Условие оплаты", f"Предоплата {prepay} процентов стоимости партии"),
                               ("Адрес доставки", "Астана қ., Қабанбай батыр даңғылы, 12, қойма"),
                               ("Адрес склада", "Қарағанды қ., Бұқар жырау көшесі, 5"))

        def contract(prepay):
            def fn(d):
                bilingual_sections(merged_headings=True, ru_left=True)(d)
                section4 = next(t for t in d.tables if any("4.3. " in c.text for row in t.rows for c in row.cells))
                table = d.add_table(rows=0, cols=2)
                for left, right in rows(prepay):
                    cells = table.add_row().cells
                    cells[0].text, cells[1].text = left, right
                section4._tbl.addnext(table._tbl)
            return fn
        r = self.run_variant(contract(30), contract(100))
        self.assertEqual(r["sverka"]["по строкам"], dict(CASE9_DIFFS, **{"4, «Условие оплаты»": "изменён"}))
        status = {row[0]: row[1] for row in r["rows"]}
        self.assertEqual(status["4, «Адрес доставки»"], "совпадает")
        self.assertIn("Договор двуязычный: сверялся русский текст.", r["summary"])
        self.assertNotIn("Сверка неполная", r["summary"])
        m = self.c.module()
        self.assertTrue(m.looks_kazakh(" ".join(v for _k, v in rows(30))))  # значения похожи на казахский текст

    def test_unread_two_column_table_is_loud(self):
        """Таблица в два столбца с длинным текстом до первого раздела русского договора не читается: строка
        «часть текста в таблицах в два столбца не прочитана» с подсказкой, карточка жёлтая."""
        long_text = ("Поставщик обязуется поставлять Товар партиями в соответствии с заявками Покупателя и "
                     "обеспечивать его качество на всём протяжении срока действия договора")
        change = two_column_table(((long_text, "Покупатель обязуется принимать и оплачивать Товар в сроки договора"),),
                                  after="г. Астана")
        r = self.run_variant(change, change)
        self.assertEqual(r["sverka"]["по строкам"], CASE9_DIFFS)
        self.assertIn("Сверка неполная", r["summary"])
        why = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")
        row = next(row for row in why if row[0] == f"документ: {DOC_FILE}")
        self.assertIn("часть текста в таблицах в два столбца не прочитана", row[-1])
        self.assertTrue(row[-1].endswith(HINT), row[-1])

    def test_repeated_condition_keys(self):
        """Одно условие дважды в таблице: вторая строка «4, «Срок» (2)»."""
        def table(second):
            return two_column_table((("Срок", "Поставка в течение пяти дней"), ("Срок", second)), after="4.3.")
        r = self.run_variant(table("Оплата в течение тридцати дней"), table("Оплата в течение десяти дней"))
        self.assertEqual(r["sverka"]["по строкам"], dict(CASE9_DIFFS, **{"4, «Срок» (2)": "изменён"}))
        status = {row[0]: row[1] for row in r["rows"]}
        self.assertEqual(status["4, «Срок»"], "совпадает")

    def test_requisites_rows_skipped_one_by_one(self):
        """Строка реквизитов (БИН, ИИК, Адрес, Подпись, М.П. в названии условия) не сверяется; строка
        «Срок подписания акта» читается: «подписания» не реквизит. Таблица из одних реквизитов пропускается."""
        def mixed(prepay, bin_no):
            return two_column_table((
                ("Условие оплаты", f"Предоплата {prepay} процентов стоимости партии"),
                ("Срок подписания акта", "В течение трёх рабочих дней с даты поставки партии"),
                ("Наименование товара", "Колечко соединительное 925" if prepay == 30 else "Замок карабин 925"),
                ("Наименование поставщика", "ТОО «Зергер-Сервис»" if prepay == 30 else "ТОО «Алтын Компонент»"),
                ("Адрес доставки", "склад Покупателя, г. Астана" if prepay == 30 else "склад Поставщика, г. Караганда"),
                ("Банк-гарант", "АО «Банк А»" if prepay == 30 else "АО «Банк Б»"),
                ("Адрес:", "г. Астана" if prepay == 30 else "г. Караганда"),
                ("Банк получателя", "АО «Народный банк»" if prepay == 30 else "АО «Kaspi Bank»"),
                ("БИН поставщика", bin_no)), after="4.3.")
        r = self.run_variant(mixed(30, "111111111111"), mixed(100, "123456789012"))
        self.assertEqual(r["sverka"]["по строкам"], dict(CASE9_DIFFS, **{
            "4, «Условие оплаты»": "изменён", "4, «Наименование товара»": "изменён",
            "4, «Адрес доставки»": "изменён", "4, «Банк-гарант»": "изменён"}))
        status = {row[0]: row[1] for row in r["rows"]}
        self.assertEqual(status["4, «Срок подписания акта»"], "совпадает")
        self.assertFalse([k for k in status if "БИН" in str(k) or "поставщика" in str(k)])
        manual = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")[1:]
        self.assertFalse([row for row in manual if "БИН" in str(row[0])])
        self.assertFalse([k for k in r["sverka"]["по строкам"] if "БИН" in k])

        def requisites(bin_no):
            return two_column_table((("БИН", bin_no), ("ИИК", "KZ12345678901234567890"),
                                     ("Банк", "АО «Народный банк Казахстана»"), ("Адрес", "г. Астана, ул. Кенесары, 40"),
                                     ("Подпись", "_________ Иванов И. И."), ("М.П.", "")))
        r = self.run_variant(requisites("111111111111"), requisites("123456789012"))
        self.assertEqual(r["sverka"]["по строкам"], CASE9_DIFFS)
        self.assertNotIn("Сверка неполная", r["summary"])
        self.assertEqual(len(manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")), len(CASE9_DIFFS) + 2 + 1)
        m = self.c.module()
        for label in ("БИН", "Банк:", "Банк", "Адрес", "Адрес: г. Астана", "Адрес юридический", "Юридический адрес",
                      "Банк получателя", "Банк плательщика:", "E-mail", "М.П.", "Реквизиты сторон",
                      "Наименование организации", "Наименование поставщика", "наименование покупателя:"):
            self.assertTrue(m.REQUISITES_RE.match(label), label)
        for label in ("Срок подписания акта", "Банковская гарантия", "Адресная доставка", "Условие оплаты",
                      "Наименование товара", "Наименование", "Адрес доставки", "Банк-гарант"):
            self.assertFalse(m.REQUISITES_RE.match(label), label)

    def test_paired_heading_text_change(self):
        """Одноуровневые пункты «4. Срок действия один год.» программа берёт за заголовок раздела.
        Правка в такой строке («один год и более») видна: строка раздела «изменён» и человеку."""
        def contract(last):
            import docx
            d = docx.Document()
            d.add_paragraph("Договор оказания услуг № [номер]", style="Heading 1")
            d.add_paragraph("г. Астана, [дата]")
            for n, title, point in ((1, "Предмет договора", "Исполнитель оказывает услуги по заявкам Заказчика."),
                                    (2, "Цена услуг", "Цена услуг указана в Приложении 1."),
                                    (3, "Порядок оплаты", "Заказчик оплачивает услуги в течение 30 дней.")):
                d.add_paragraph(f"{n}. {title}")
                d.add_paragraph(f"{n}.1. {point}")
            d.add_paragraph(f"4. Срок действия {last}.")
            d.add_paragraph("5. Споры решаются в суде г. Астаны.")
            return d
        contract("один год").save(self.c.input / FORM_FILE)
        doc = contract("один год и более")
        doc.paragraphs[1].text = "г. Астана, 18.09.2026"
        doc.save(self.c.input / DOC_FILE)
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        self.assertEqual(r["sverka"]["по строкам"], {"4": "изменён"})
        self.assertEqual(r["sverka"]["итоги"]["изменено"], 1)
        manual = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")[1:]
        row = next(row for row in manual if row[0] == "4")
        self.assertEqual(row[1:], ["изменён", "4. Срок действия один год.", "4. Срок действия один год и более.", RISK])
        m = self.c.module()
        self.assertEqual(m.pair_status("Срок действия договора", "СРОК ДЕЙСТВИЯ ДОГОВОРА")[1], "совпадает")

    def test_form_blank_styles_and_underlined_spaces(self):
        """Поля формы в другом виде: [..] заменены на <..>, {..}, ……, точки, подчёркнутые пробелы. Отличия те же."""
        def blanks(write):
            def fn(d):
                for p in d.paragraphs:
                    if "[" in p.text:
                        parts = re.split(r"\[[^\]]*\]", p.text)
                        for r in list(p.runs):
                            r._r.getparent().remove(r._r)
                        for k, part in enumerate(parts):
                            p.add_run(part)
                            if k < len(parts) - 1:
                                write(p)
            return fn

        def underline(p):
            p.add_run("            ").underline = True
        for name, write in (("<..>", lambda p: p.add_run("<указать>")), ("{..}", lambda p: p.add_run("{сумма}")),
                            ("……", lambda p: p.add_run("…………")), ("точки", lambda p: p.add_run("...........")),
                            ("подчёркнутые пробелы", underline)):
            with self.subTest(name):
                r = self.run_variant(blanks(write))
                self.assertEqual(r["sverka"]["по строкам"], CASE9_DIFFS)

    def test_pairs_do_not_cross(self):
        """5.1 удалён, новый 5.3 о приёмке после 5.2: «удалён» и «добавлен», не «изменён» крест-накрест."""
        def change(d):
            p51 = next(p for p in d.paragraphs if p.text.startswith("5.1."))
            p52 = next(p for p in d.paragraphs if p.text.startswith("5.2."))
            p51._p.getparent().remove(p51._p)
            new = copy.deepcopy(p52._p)
            p52._p.addnext(new)
            from docx.text.paragraph import Paragraph
            set_text(Paragraph(new, p52._parent), "5.3. Приёмка производится представителем Покупателя на основании доверенности.")
        r = self.run_variant(None, change)
        rows = r["sverka"]["по строкам"]
        self.assertEqual(rows["5.1/нет"], "удалён")
        self.assertEqual(rows["нет/5.3"], "добавлен")
        self.assertEqual(rows["5.2"], "изменён (мелкая правка)")

    def test_no_form_clear_stop(self):
        self.put_case(DOC_FILE)
        proc = self.c.run()
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("нет типовой формы", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)

    def test_case_9_contract_against_form(self):
        self.put_case()
        proc = self.c.run()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        r = self.c.result()
        status = {row[0]: row[1] for row in r["rows"]}
        self.assertEqual({k: v for k, v in status.items() if v != "совпадает"}, CASE9_DIFFS)
        # После удалённого раздела 9 разделы 10 и 11 формы стоят в договоре под номерами 9 и 10: не отличие.
        self.assertEqual(status["10.1/9.1"], "совпадает")
        self.assertEqual(status["11, абз. 1/10, абз. 1"], "совпадает")
        self.assertEqual(status["11, абз. 2/10, абз. 2"], "совпадает")
        # Заполненные поля формы (номер, дата, поставщик, сумма, реквизиты) не отличие.
        for key in ("шапка, абз. 1", "шапка, абз. 2", "шапка, абз. 3", "4.1"):
            self.assertEqual(status[key], "совпадает", key)
        # Человеку: шесть отличий (риск) и два поля реквизитов, заполненных несколькими фразами.
        n = len(CASE9_DIFFS) + 2
        self.assertEqual(r["row_status"], ["info"] * n + [None] * (len(r["rows"]) - n))
        self.assertEqual(r["row_note"][:n], ["разобрать вручную"] * n)
        manual = manual_rows(self.c.out / "razobrat-vruchnuyu.xlsx")[1:]
        self.assertEqual(sorted(row[0] for row in manual if row[-1] == RISK), sorted(CASE9_DIFFS))
        self.assertEqual([row[0] for row in manual if row[-1] != RISK], ["11, абз. 1/10, абз. 1", "11, абз. 2/10, абз. 2"])
        self.assertTrue(all("нет ли в нём новых условий" in row[-1] for row in manual if row[-1] != RISK))
        self.assertEqual(r["sverka"]["по строкам"], CASE9_DIFFS)
        self.assertEqual(r["sverka"]["итоги"], {"изменено": 3, "добавлено": 1, "удалено": 1, "мелких правок": 1,
                                                "разница спецификации": 2000000})
        self.assertEqual(r["status"], "yellow")  # цифры не сходятся
        self.assertNotIn("Сверка неполная", r["summary"])
        self.assertIn(f"Разобрать вручную: {n} (файл razobrat-vruchnuyu.xlsx)", r["summary"])

        book = self.c.out / "sverka-dogovora.xlsx"
        self.assertIn("output/proba/sverka-dogovora.xlsx", r["files"])
        spec = {row[0]: row[1:] for row in sheet(book, "Спецификация")[1:]}
        self.assertEqual(spec["Колечко соединительное 925"], [150000, 296, 46400000, 44400000, 2000000])
        self.assertEqual(spec["Замок карабин 925"][-1], 0)
        self.assertEqual(spec["Итого"][2:], [120200000, 118200000, 2000000])
        self.assertEqual(spec["Сумма договора, п. 4.1"][2:], [120200000, 118200000, 2000000])
        tech = sheet(book, "Техспецификация")
        self.assertEqual([row for row in tech[1:] if row[-1] != 0], [["Замок пружинный 925", 80000, 85000, -5000]])
        self.assertEqual(len(tech), 5)
        card = dict(sheet(book, "Карточка условий")[1:])
        self.assertEqual(card["Поставщик"], "ТОО «Алтын Компонент»")
        self.assertEqual(card["Покупатель"], "ТОО «Ювелирный дом»")
        self.assertEqual(card["Номер"], "ПС-2026/118")
        self.assertEqual(card["Дата"], "18.09.2026")
        self.assertIn("31 декабря 2026", card["Срок действия"])
        self.assertIn("г. Астана", card["Споры"])
        self.assertIn("120 200 000", card["Сумма"])
        self.assertIn("предоплату 50 %", card["Оплата"])
        self.assertNotIn("[нет данных]", card.values())

        if not NODE:
            return
        code, out = self.c.node("list")
        self.assertEqual(code, 0, out)
        self.assertNotIn("Ошибка", out)
        etalon = {"по строкам": CASE9_DIFFS, "итоги": {"изменено": 3, "добавлено": 1, "удалено": 1,
                                                       "мелких правок": 1, "разница спецификации": "2 000 000,00"}}
        (self.c.out / "etalon-skilla.json").write_text(json.dumps(etalon, ensure_ascii=False), encoding="utf-8")
        code, out = self.c.node("compare", "proba")
        self.assertEqual(code, 0, out)
        self.assertIn("Итог сверки: результат программы совпал с эталоном.", out)
        self.assertNotIn("Внимание", out)


if __name__ == "__main__":
    unittest.main()


class Net(unittest.TestCase):
    """Блок «Данные из интернета»: сайт не ответил или ответил ошибкой: понятная причина, код 2."""

    def compose_net(self, url):
        b = blocks()
        base = b["base"].replace("<имя>", "proba").replace("<Название процесса>", "Проба")
        head, sep, tail = base.partition("\ndef main():")
        self.assertTrue(sep)
        run_part = tail[tail.index("\nif __name__"):]
        main = f"def main():\n    fetch({url!r})\n"
        return head + "\n" + b["net"] + "\n" + main + run_part

    def test_site_not_answering_clear_stop(self):
        import socket
        with socket.socket() as srv:  # свободный порт, на нём никто не слушает
            srv.bind(("127.0.0.1", 0))
            port = srv.getsockname()[1]
        c = Cabinet(self.compose_net(f"http://127.0.0.1:{port}/prices"))
        self.addCleanup(c.close)
        r = c.run()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("не ответил", r.stdout + r.stderr)
        self.assertNotIn("Traceback", r.stdout + r.stderr)

    def test_site_error_code_clear_stop(self):
        import http.server
        import threading

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        c = Cabinet(self.compose_net(f"http://127.0.0.1:{srv.server_address[1]}/prices"))
        self.addCleanup(c.close)
        r = c.run()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("ответил ошибкой 404", r.stdout + r.stderr)
