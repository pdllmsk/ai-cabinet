# Программа процесса: два документа Word

Справка к операции «добавить процесс» и к фразе «доработай <процесс>» для процесса, который сверяет документ с образцом: договор поставщика с типовой формой, документ с шаблоном. Общие правила, схема результата, «разобрать вручную», основа и блок «Шаблон Word» лежат в `.claude/skills/add-process/programma.md`. Собери программу так: основа, блок «Шаблон Word» (из него этот блок берёт чтение Word), блок «Два документа Word» ниже, пример `main` ниже.

Оба файла лежат в `input/<имя>/`. Типовую форму программа узнаёт по части имени файла (`FORM_PART`, её подтверждает человек), второй файл Word считается договором.

## Настрой под форму человека

Перед записью программы посмотри текст формы (шаг 3 операции) и поправь в блоке:

- `BLANK_RE`: как в форме написаны поля для заполнения. Уже знает `[дата]`, `<дата>`, `{дата}`, `____`, `……`, `......`, `«___»`, пустые кавычки «» и подчёркнутые пробелы (их программа читает как `__`, в тексте формы они видны пробелами). Поле записано иначе: допиши его вид в `BLANK_RE`, иначе каждое заполненное поле станет отличием;
- `FORM_NOTES`: слова служебной пометки формы, которую в договор не переносят («Типовая форма ...», «Образец ...», «Утверждена приказом ...»). Абзац формы без номера с этими словами не сравнивается;
- `PARTIES` и `CARD`: как договор называет стороны и где искать условия для карточки.

## Правило сверки

Его же простыми словами объясняй человеку.

- Документ делится на разделы по заголовкам. Заголовок: абзац в стиле «Заголовок» (и с нумерацией списком Word), короткая строка «4. Название» или «IV. Название» без точки в конце, «4. Название.» с точкой, если за ней идут пункты 4.1, 4.2 или её номер следует за номером предыдущего раздела, строка «Приложение ...». Первый заголовок без номера до первого пункта считается названием документа. Всё до первого раздела называется шапкой (название, место и дата, стороны).
- Номер пункта программа берёт из текста («4.2.»). Абзац без номера (и пункт с нумерацией списком Word: номера в тексте нет) получает номер вида «11, абз. 1», в шапке «шапка, абз. 1».
- Разделы сопоставляются по заголовку без номера (арабского или римского) и без точки в конце: большие и маленькие буквы, пробелы, ё и кавычки не важны. После удалённого раздела номера следующих разделов сдвигаются, и это отличием не считается: пункт 10.1 формы стоит в договоре под номером 9.1 и «совпадает».
- Заголовки пары разделов тоже сравниваются, без номера и по тем же правилам, что пункты: правка в заголовке даёт строку с номером раздела («4», «10/9») и статусом «изменён» или «изменён (мелкая правка)». Так видна правка в строке «4. Срок действия один год.» договора с одноуровневыми пунктами, которую программа приняла за заголовок раздела.
- Таблица условий «условие | значение» (один-два столбца с текстом) в русском договоре: каждая строка сверяется как пункт раздела, где стоит таблица, текстом «условие: значение», по тем же статусам. Номер такой строки: раздел и условие из левого столбца, «4, «Условие оплаты»»; то же условие ещё раз в разделе: «4, «Срок» (2)». Казахские названия и имена в русской таблице («ТОО «Қазақстан Темір Жолы»») не мешают. Спецификация (в первой строке количество, цена, сумма) остаётся таблицей и проверяется отдельно. Строка реквизитов не сравнивается: название в левой ячейке начинается целым словом с БИН, ИИН, ИИК, БИК, IBAN, Телефон, E-mail, Подпись, М.П., Реквизиты, Наименование организации, поставщика или покупателя; «Адрес» и «Банк» только сами по себе (можно с двоеточием) или «Адрес юридический», «Фактический адрес», «Банк получателя», «Банк плательщика». «Срок подписания акта», «Наименование товара», «Адрес доставки», «Банк-гарант» сравниваются. Таблица из одних строк реквизитов пропускается целиком. Ограничения: до первого раздела таблица с длинными условиями слева (больше 80 знаков) или с нумерацией пунктов в ячейках («1.1. ...», «4. ...») считается текстом договора в таблице и как таблица условий не читается; таблица со столбцом на казахском, язык которой не определить, тоже. Такие таблицы не пропадают молча: строка «часть текста в таблицах в два столбца не прочитана» с подсказкой (ниже), карточка жёлтая.
- Договор на двух языках в таблицах в два столбца (русский и казахский текст рядом, одной таблицей или по таблице на раздел): программа читает русский текст по порядку строк, по тем же правилам заголовков и пунктов. Язык столбцов определяется один раз по всем таким таблицам документа: другой столбец на казахском (казахских букв ә ғ қ ң ө ұ ү һ і от 6 на 100 и есть казахские служебные слова: және, мен, осы, үшін, бойынша ...), а в русском казахских букв хотя бы в пять раз меньше. Русский текст с казахскими названиями и именами казахским не считается. Поэтому короткий раздел из одного пункта тоже читается. Строка во всю ширину таблицы (название, заголовок раздела на двух языках) даёт русскую часть: «4. Цена / 4. Баға» → «4. Цена»; таблица в один столбец (заголовок приложения) тоже. Русская таблица в договоре на двух языках (условия, реквизиты, и с казахскими названиями и именами) читается так же, как в русском договоре: строками «условие: значение» (ниже), а если она не такого вида, абзацами слева направо. Короткая таблица раздела читается по русскому столбцу документа, если её столбец на казахской стороне похож на казахский текст (казахские буквы в словах со строчной буквы; имена и названия с заглавной не в счёт), а слева не короткие подписи условий. Таблица, где слева короткие подписи («Условие оплаты», «Адрес доставки»: до восьми слов, без номера пункта и без точки в конце), это таблица условий: строчные казахские слова в значениях («көшесі», «даңғылы» в адресах) её двуязычной не делают, и она сверяется строками «условие: значение». Таблицы с данными (спецификация: больше двух столбцов, числа) читаются как таблицы. В итоге фраза «Договор двуязычный: сверялся русский текст.» Язык столбцов не определить (оба столбца без казахских букв или оба с ними): программа не угадывает. Таблица в два столбца с текстом, которая так и осталась непрочитанной (не договор на двух языках, не таблица условий, не одни реквизиты, не спецификация), не пропадает молча: сверка неполная, строка в «разобрать вручную» с подсказкой (ниже).
- Пункты внутри пары разделов сопоставляются по тексту, номер пункта не важен. Одинаковые пункты служат опорой; пункт, который стоит между теми же опорами и совпадает по словам хотя бы на 30%, «изменён». Пары не перекрещиваются: удалённый пункт и новый пункт в другом месте раздела остаются «удалён» и «добавлен». Пункта формы нет в договоре: «удалён»; пункта договора нет в форме: «добавлен»; раздела формы нет в договоре: «удалён» одной строкой на весь раздел.
- Поле формы для заполнения совпадает с текстом договора на его месте: заполненные номер, дата, поставщик, сумма и реквизиты отличием не считаются. Поле не заполнено, заполнено длиннее 80 знаков или несколькими фразами (туда могли дописать условие): пункт «совпадает», но уходит человеку с причиной.
- «Изменён (мелкая правка)»: слова текста совпадают на 90% и больше, числа те же, слова «не», «ни», «нет», «без», «более», «менее», «больше», «меньше», «свыше» и названия сторон те же. Например, «3 (трёх) рабочих дней» и «трёх рабочих дней». Числа словами программа узнаёт по списку `NUMBER_WORDS`; число прописью в скобках после цифр считается тем же числом. «Не более» вместо «не менее», «Покупатель» вместо «Поставщик», «не вправе» вместо «вправе»: «изменён».
- Каждый пункт с отличием уходит в «разобрать вручную» с причиной «оценить риск: решает юрист». Отличие находит программа, оценивает его человек.
- Если разделы не распознаны (весь текст оказался в шапке или пункты стоят до первого заголовка) или вне таблиц нет текста (договор свёрстан таблицей, и русский столбец не найден), сверка неполная: строка в «разобрать вручную», карточка жёлтая. Строка «вне таблиц нет текста» кончается подсказкой: «Выход: положите в папку процесса русский текст договора отдельным документом Word с нумерованными разделами.»

## Цифры и карточка условий

- Спецификация: количество × цена по каждой строке, итог по строкам против строки «Итого» или «Всего» (слово может стоять в любой ячейке строки, и в объединённой), сумма договора из пункта карточки «Сумма» (в типовой форме 4.1) против пересчёта; количества спецификации против технической спецификации по наименованию товара. Числа вида `46 400 000,00` (между разрядами бывает неразрывный пробел) читает `number()` из основы.
- Человеку уходят: число, которое не прочиталось; спецификация без строки итога; несколько итоговых строк («Итого без НДС», «НДС 12 %», «Итого с НДС»): какую из них сверять с пересчётом и с суммой договора, решает человек, программа показывает пересчёт.
- Карточка условий: стороны по словам «именуемое в дальнейшем «Поставщик»» (`PARTIES`), номер и дата из шапки, остальное по списку `CARD`: текст пункта, найденного по заголовку раздела или по словам в тексте. Не нашлось: «[нет данных]» и строка в «разобрать вручную».
- Карточка жёлтая, если цифры не сходятся или сверка неполная.

## Раздел sverka

`по строкам`: только пункты с отличием, ключ «пункт формы / пункт договора»: «4.2», если номер тот же, иначе «10.1/9.1», «нет/4.4», «9/нет»; раздел без номера называется заголовком целиком, как в документе («Приложение 1. Спецификация/нет»), абзац без номера как выше («11, абз. 1/10, абз. 1»), изменённый заголовок раздела номером раздела («4», «10/9»), строка таблицы условий разделом и условием («4, «Условие оплаты»»). Значение: статус («изменён», «изменён (мелкая правка)», «добавлен», «удалён»). Совпавшие пункты в `по строкам` не пишутся: эталон скилла и есть его таблица отличий. Пункт с отличием лежит в «разобрать вручную» ради оценки риска; в `по строкам` у него статус, который программа определила сама.

`итоги`: изменено, добавлено, удалено, мелких правок, разница спецификации (итог в документе минус пересчёт; несколько итоговых строк или нет строки итога: нет числа).

```python
# --- Два документа Word: документ против образца (договор поставщика против типовой формы) ---
# Чтение Word (load_docx, word_parts), NO_DATA и money берёт из блока «Шаблон Word»: он стоит в программе выше.
import difflib

FORM_PART = "forma"  # часть имени файла типовой формы в input/<имя>/, её подтвердил человек; второй .docx: договор
FORM_NOTES = ["типовая форма"]  # служебная пометка формы (абзац без номера с этими словами): не сравнивается
PARTIES = ["Поставщик", "Покупатель"]  # стороны, как их называет договор: «именуемое в дальнейшем «Поставщик»»
# Карточка условий: (строка карточки, где искать, слова). «раздел»: все пункты раздела с этими словами
# в заголовке; «пункт»: первый пункт с ними в тексте. Регистр и ё не важны, варианты слов через |.
CARD = [
    ("Предмет", "пункт", "обязуется поставить"),
    ("Сумма", "пункт", "сумма договора"),
    ("Оплата", "пункт", "оплачивает|предоплат"),
    ("Срок поставки", "пункт", "срок поставки"),
    ("Неустойки", "раздел", "ответственность"),
    ("Срок действия", "раздел", "срок действия"),
    ("Споры", "раздел", "споров"),
]
SUM_CARD = "Сумма"  # строка карточки с суммой договора: её сверяем с пересчётом спецификации
SPEC_SECTION, TECH_SECTION = "спецификац", "техническ"  # слова в заголовках разделов со спецификациями
MATCH, CHANGED, MINOR_EDIT = "совпадает", "изменён", "изменён (мелкая правка)"
ADDED, DELETED = "добавлен", "удалён"
MINOR = 0.9  # мелкая правка: слова совпадают на 90% и больше, числа и слова SENSE_WORDS и PARTIES те же
PAIR_MIN = 0.3  # пункт между совпавшими пунктами: пара «изменён», если слова совпадают хотя бы на 30%
SENSE_WORDS = {"не", "ни", "нет", "без", "более", "менее", "больше", "меньше", "свыше"}  # их замена меняет смысл
FIELD_MAX = 80  # поле формы, заполненное длиннее (или несколькими фразами), проверяет человек
HEAD, FOOT = "шапка", "колонтитулы"
SKIP = "пропустить"  # table_points: таблица остаётся таблицей молча
KAZAKH_LETTERS = set("әғқңөұүһіӘҒҚҢӨҰҮҺІ")  # буквы казахского алфавита, которых нет в русском
# Служебные слова казахского текста: по ним казахский столбец отличается от русского с казахскими именами.
KAZAKH_WORDS = {"және", "мен", "бен", "пен", "осы", "үшін", "бойынша", "арқылы", "тиіс", "немесе", "туралы",
                "дейін", "кейін", "сәйкес", "бұл", "оның", "тарапынан", "болып", "болса", "қажет"}
HINT = "Выход: положите в папку процесса русский текст договора отдельным документом Word с нумерованными разделами."
# Строка реквизитов в таблице: название в левой ячейке начинается с этого слова (целым словом); «Адрес» и «Банк»
# только сами по себе (можно с двоеточием) или «Адрес юридический», «Банк получателя» и подобные.
# Такая строка не сверяется; таблица из одних таких строк пропускается целиком.
REQUISITES_RE = re.compile(
    r"\s*(?:(?:БИН|ИИН|ИИК|БИК|БСН|ЖСК|IBAN|Телефон|E-?mail|Подпись|М\.\s?П\.|Реквизиты|"
    r"Наименование\s+(?:организации|поставщика|покупателя))(?!\w)"
    r"|(?:(?:юридический|фактический|почтовый)\s+)?(?:Адрес|Банк)"
    r"(?:\s+(?:юридический|фактический|почтовый|получателя|плательщика))?\s*(?::|$))", re.I)
# Поле формы для заполнения: [дата], <дата>, {дата}, ____, ……, ......, «___», «»; подчёркнутые пробелы: «__».
BLANK_RE = re.compile(r"\[[^\[\]]*\]|<[^<>]*>|\{[^{}]*\}|_{2,}|…+|\.{3,}|«[\s_.…]*»")
POINT_RE = re.compile(r"(\d+(?:\.\d+)+)\.?\s+(.+)", re.S)  # «4.2. Покупатель ...»
SECTION_RE = re.compile(r"(?:(?i:раздел)\s+)?(\d+|[IVXLCІХ]+)\.?\s+(\D.*)", re.S)  # «4. Цена ...», «IV. Цена ...»
APPENDIX_RE = re.compile(r"приложение\s*(?:№\s*)?\d+\s*[.:]\s*\S", re.I)  # «Приложение 1. Спецификация.»
TOTAL_RE = re.compile(r"итог|всего")  # начало ячейки строки итога спецификации
SUMMARY_RE = re.compile(r"итог|всего|ндс|в том числе|в т\.\s?ч")  # итоговые строки: итог, НДС, «в том числе»
# Конец фразы внутри поля: «;» или точка и заглавная буква (кроме сокращений «г. Астана», «ул. Абая» и инициалов).
BREAK_RE = re.compile(r";|(?<!\b[а-яa-z])(?<!\b[а-яa-z]{2})(?<!\b[а-яa-z]{3})[.!?]\s+[А-ЯA-Z](?!\.)")
DOC_NO_RE = re.compile(r"№\s*([^\s,]+)")
DATE_RE = re.compile(r"\d{1,2}\.\d{1,2}\.\d{4}|«?\d{1,2}»?\s+(?:января|февраля|марта|апреля|мая|июня|июля|"
                     r"августа|сентября|октября|ноября|декабря)\s+\d{4}", re.I)
PARTY_RE = re.compile(r"([^,]+?),\s*(?:именуем\w*\s+)?(?:в\s+дальнейшем|далее)\s+«([^»]+)»", re.I)
NUM_RE = re.compile(r"\d{1,3}(?:\s\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?")  # где в тексте число; читает его number()
SPELLED_RE = re.compile(r"(\d)\s*\([^()\d]*\)")  # «3 (трёх)»: пропись в скобках повторяет число
NUMBER_WORDS = {w: n for n, forms in (
    (1, "один одного одной"), (2, "два две двух"), (3, "три трех"), (4, "четыре четырех"), (5, "пять пяти"),
    (6, "шесть шести"), (7, "семь семи"), (8, "восемь восьми"), (9, "девять девяти"), (10, "десять десяти"),
    (14, "четырнадцать четырнадцати"), (15, "пятнадцать пятнадцати"), (20, "двадцать двадцати"),
    (30, "тридцать тридцати"), (60, "шестьдесят шестидесяти"), (90, "девяносто"),
) for w in forms.split()}
PATTERNS = {}  # текст пункта формы: образец для сравнения


def two_documents():
    """(типовая форма, договор): самые свежие файлы Word в input/<имя>/, форма по части имени FORM_PART."""
    folder = ROOT / "input" / SLUG
    docs = [p for p in folder.glob("*") if p.is_file() and p.suffix.lower() == ".docx"
            and not p.name.startswith(("~$", "."))]
    forms = [p for p in docs if FORM_PART.lower() in p.name.lower()]
    others = [p for p in docs if p not in forms]
    if not forms:
        raise StopRun(f"В папке input/{SLUG} нет типовой формы: файла Word, в имени которого есть «{FORM_PART}». "
                      "Положите её и запустите расчёт снова.")
    if not others:
        raise StopRun(f"В папке input/{SLUG} нет договора: второго файла Word рядом с формой. "
                      "Положите его и запустите расчёт снова.")
    form, doc = (max(group, key=lambda p: max(p.stat().st_mtime, p.stat().st_ctime)) for group in (forms, others))
    return form, doc


def plain(text):
    """Текст для сравнения: ё как е, без кавычек, пробелы по одному, без точки в конце; регистр как в документе."""
    t = re.sub(r"[«»\"“”„']", "", str(text).replace("ё", "е").replace("Ё", "Е"))
    return " ".join(t.split()).strip(" .,;:")


def norm(text):
    """То же строчными буквами: так сравниваются заголовки, слова и столбцы."""
    return plain(text).lower()


def tokens(text):
    return re.findall(r"\w+", norm(text))


def blank_pattern(form_text):
    """Текст формы как образец: на месте поля для заполнения любой текст, регистр не важен."""
    if form_text not in PATTERNS:
        pieces = plain(BLANK_RE.sub("\x00", form_text)).split("\x00")
        PATTERNS[form_text] = re.compile("(.+?)".join(re.escape(p) for p in pieces), re.S | re.I)
    return PATTERNS[form_text]


def same_text(form_text, doc_text):
    """Пункт договора совпадает с пунктом формы: тот же текст, поля формы чем-то заполнены."""
    return blank_pattern(form_text).fullmatch(plain(doc_text)) is not None


def field_problems(form_text, doc_text):
    """Поля формы, которые человеку стоит посмотреть: не заполнены, заполнены длиннее FIELD_MAX
    или несколькими фразами (туда могли дописать условие)."""
    m = blank_pattern(form_text).fullmatch(plain(doc_text))
    if m is None:
        return []
    out = []
    for name, fill in zip(BLANK_RE.findall(form_text), m.groups()):
        if BLANK_RE.fullmatch(fill.strip()):
            out.append(f"поле {name} не заполнено")
        elif len(fill) > FIELD_MAX or BREAK_RE.search(fill):
            out.append(f"поле {name} заполнено длинным текстом или несколькими фразами: нет ли в нём новых условий")
    return out


def numbers_in(text):
    """Числа текста по возрастанию: цифрами (читает number из основы) и словами из NUMBER_WORDS."""
    t = SPELLED_RE.sub(r"\1", str(text).lower().replace("ё", "е"))
    found = [number(m.group()) for m in NUM_RE.finditer(t)]
    found += [NUMBER_WORDS[w] for w in re.findall(r"[^\W\d_]+", t) if w in NUMBER_WORDS]
    return sorted(n for n in found if n is not None)


def sense_of(text):
    """Слова, замена которых меняет смысл пункта: SENSE_WORDS и названия сторон в любом падеже."""
    stems = [norm(p).rstrip("ьй") for p in PARTIES]
    words = tokens(text)
    return sorted([w for w in words if w in SENSE_WORDS] + [s for w in words for s in stems if w.startswith(s)])


def pair_status(form_text, doc_text):
    """(похожесть по словам от 0 до 1, статус) пары пунктов формы и договора."""
    if same_text(form_text, doc_text):
        return 1.0, MATCH
    bare = BLANK_RE.sub(" ", form_text)
    score = difflib.SequenceMatcher(None, tokens(bare), tokens(doc_text), autojunk=False).ratio()
    minor = score >= MINOR and numbers_in(bare) == numbers_in(doc_text) and sense_of(bare) == sense_of(doc_text)
    return score, (MINOR_EDIT if minor else CHANGED)


def text_of(el):
    """Текст абзаца или ячейки целиком (и в полях, ссылках, элементах управления), пробелы по одному.
    Подчёркнутые пробелы и табуляция (поле формы «на линии») становятся «__»."""
    from docx.oxml.ns import qn
    w_t, w_tab, w_br, w_rpr, w_u = qn("w:t"), qn("w:tab"), qn("w:br"), qn("w:rPr"), qn("w:u")
    parts = []
    for n in el.iter(w_t, w_tab, w_br):
        s = (n.text or "") if n.tag == w_t else " "
        rpr = n.getparent().find(w_rpr)
        u = rpr.find(w_u) if rpr is not None else None
        line = u is not None and u.get(qn("w:val")) != "none" and n.tag != w_br
        parts.append("__" if line and not s.strip() else s)
    return " ".join("".join(parts).split())


def row_cells(tr):
    """Ячейки строки таблицы по столбцам: объединённая ячейка (gridSpan) занимает свои столбцы, текст в первом."""
    from docx.oxml.ns import qn
    cells = []
    trpr = tr.find(qn("w:trPr"))
    before = trpr.find(qn("w:gridBefore")) if trpr is not None else None
    if before is not None:
        cells += [""] * int(before.get(qn("w:val")) or 0)
    for tc in tr.findall(qn("w:tc")):
        tcpr = tc.find(qn("w:tcPr"))
        span = tcpr.find(qn("w:gridSpan")) if tcpr is not None else None
        cells += [text_of(tc)] + [""] * (int(span.get(qn("w:val")) or 1) - 1 if span is not None else 0)
    return cells


def kazakh_share(text):
    """Доля букв казахского алфавита (ә ғ қ ң ө ұ ү һ і) среди всех букв текста."""
    letters = [c for c in text if c.isalpha()]
    return sum(c in KAZAKH_LETTERS for c in letters) / len(letters) if letters else 0.0


def kazakh_column(text):
    """Столбец на казахском: казахских букв от 6 на 100 и есть казахские служебные слова (және, осы, үшін ...).
    Русский текст с казахскими названиями и именами («ТОО «Қазақстан Темір Жолы», «Нұрланов Ғалым») не такой."""
    return kazakh_share(text) >= 0.06 and any(w in KAZAKH_WORDS for w in re.findall(r"\w+", text.lower()))


def looks_kazakh(text):
    """Похоже на казахский текст, и короткий, без служебных слов: kazakh_column или казахские буквы в словах
    со строчной буквы от 3 на 100. Имена и названия пишутся с заглавной и в счёт не идут."""
    lower = " ".join(w for w in re.findall(r"[^\W\d_]+", text) if w[0].islower())
    return kazakh_column(text) or kazakh_share(lower) >= 0.03


def ru_column(texts):
    """Номер русского столбца по текстам двух столбцов: другой столбец на казахском (kazakh_column), в этом
    казахских букв хотя бы в пять раз меньше. Язык не определить: None."""
    share = [kazakh_share(t) for t in texts]
    return next((k for k in (0, 1) if kazakh_column(texts[1 - k]) and share[k] * 5 <= share[1 - k]), None)


def russian_part(el):
    """Абзац строки во всю ширину таблицы без казахской части: «4. Цена / 4. Баға» → «4. Цена»."""
    return " / ".join(x for x in re.split(r"\s+/\s+", text_of(el)) if kazakh_share(x) < 0.02)


def condition_labels(rows):
    """Левые ячейки таблицы: короткие русские подписи условий («Условие оплаты», «Адрес доставки»): до восьми
    слов, без номера пункта, без точки после слова в конце, не казахский текст. Так выглядит таблица условий,
    а не текст на двух языках."""
    left = [text_of(cells[0]) for cells in rows if len(cells) == 2]
    return any(left) and not looks_kazakh(" ".join(left)) and all(
        len(t.split()) <= 8 and not re.match(r"\d+(?:\.\d+)*\.?\s", t) and not re.search(r"\w\w[.!?]$", t) for t in left)


def two_column_text(tables):
    """Договор на двух языках в таблицах в два столбца (целиком или по таблице на раздел). Возвращает
    {таблица: [(абзац или вложенная таблица, текст абзаца или None)]}; таблицу не из плана читает table_points.
    Язык столбцов определяется по всем таким таблицам документа вместе; таблица, где язык виден сам, читается
    по своему русскому столбцу. Строка во всю ширину (название, заголовок раздела на двух языках) даёт русскую
    часть. Короткая таблица читается по русскому столбцу документа, если её столбец на казахской стороне похож
    на казахский (looks_kazakh) и слева не короткие подписи (condition_labels); иначе это русская таблица (и
    таблица условий, где в значениях строчные казахские слова: «көшесі», «даңғылы» в адресах), и её, как
    в русском договоре, читает table_points.
    В документе на двух языках таблица в один столбец (заголовок приложения) даёт русскую часть.
    Таблицы с данными (больше двух столбцов, числа) остаются таблицами."""
    from docx.oxml.ns import qn
    w_tr, w_tc, w_p, w_tbl = qn("w:tr"), qn("w:tc"), qn("w:p"), qn("w:tbl")

    def children(tc):  # абзацы и вложенные таблицы ячейки по порядку
        return [el for el in tc.iter(w_p, w_tbl) if next(el.iterancestors(w_tc)) is tc]

    found, singles = [], []
    for tbl in tables:
        rows = [tr.findall(w_tc) for tr in tbl.findall(w_tr)]
        if not rows or any(len(cells) > 2 for cells in rows):
            continue
        if not any(len(cells) == 2 for cells in rows):
            singles.append((tbl, rows))
            continue
        cols = [" ".join(text_of(cells[k]) for cells in rows if len(cells) == 2) for k in (0, 1)]
        if min(sum(c.isalpha() for c in col) for col in cols) >= 10:  # текст в обоих столбцах, не числа
            found.append((tbl, rows, cols))
    doc_ru = ru_column([" ".join(f[2][k] for f in found) for k in (0, 1)])
    plan = {}
    for tbl, rows, cols in found:
        own = ru_column(cols)
        if own is not None:
            take = [own]
        elif doc_ru is not None and looks_kazakh(cols[1 - doc_ru]) and not condition_labels(rows):
            take = [doc_ru]  # короткая таблица на двух языках: язык по документу
        else:
            continue  # русская таблица (и таблица условий с казахскими адресами) или язык не определить: table_points
        out = []
        for cells in rows:
            if len(cells) == 1:  # строка во всю ширину: только русская часть
                out += [(el, russian_part(el) if el.tag == w_p else None) for el in children(cells[0])]
            else:
                out += [(el, text_of(el) if el.tag == w_p else None) for k in take for el in children(cells[k])]
        plan[tbl] = out
    if doc_ru is not None:  # документ на двух языках: таблица в один столбец тоже по-русски
        for tbl, rows in singles:
            plan[tbl] = [(el, russian_part(el) if el.tag == w_p else None) for cells in rows for el in children(cells[0])]
    return plan


def table_points(tbl, in_section):
    """Таблица условий «условие | значение» строками-пунктами: [(условие, «условие: значение»)].
    SKIP: таблица остаётся таблицей молча (больше двух столбцов, один столбец, без текста, спецификация: в первой
    строке два слова из «количество», «цена», «сумма», «ед.»; одни строки реквизитов). None: таблица в два
    столбца с текстом, которую не прочитать: столбец на казахском (kazakh_column, язык не определить) или,
    до первого раздела (in_section False), длинные условия слева (больше 80 знаков) или нумерация пунктов
    в ячейках («1.1. ...», «4. ...»): это текст договора в таблице. О ней говорит строка «разобрать вручную».
    Строка реквизитов (REQUISITES_RE по левой ячейке) пропускается."""
    from docx.oxml.ns import qn
    rows = [[text_of(tc) for tc in tr.findall(qn("w:tc"))] for tr in tbl.findall(qn("w:tr"))]
    if not rows or any(len(r) > 2 for r in rows) or not any(len(r) == 2 for r in rows):
        return SKIP
    if sum(c.isalpha() for c in " ".join(" ".join(r) for r in rows)) < 10:
        return SKIP
    if sum(w in norm(" ".join(rows[0])) for w in ("количеств", "цена", "сумма", "ед.")) >= 2:
        return SKIP
    points = [(" ".join(r[0].split()[:8]), ": ".join(c for c in r if c))
              for r in rows if any(r) and not REQUISITES_RE.match(r[0])]
    if not points:
        return SKIP  # одни реквизиты: таблица не сверяется, как раньше
    if any(kazakh_column(" ".join(r[k] for r in rows if len(r) == 2)) for k in (0, 1)):
        return None  # столбец на казахском, а язык таблицы не определить
    if not in_section and (any(len(r[0]) > 80 for r in rows if len(r) == 2)
                           or any(re.match(r"\d+(?:\.\d+)*\.\s+\D", c) for r in rows for c in r)):
        return None  # до первого раздела: текст договора в таблице, не таблица условий
    return points


def is_heading(p, text, point_after, prev):
    """Заголовок раздела: стиль «Заголовок»; короткая строка «4. Название», «IV. Название», «Приложение ...»
    без точки в конце; «4. Название.» с точкой, если следом идут пункты 4.1, 4.2 (point_after: номер следующего
    пункта) или если номер идёт за номером предыдущего раздела prev и в строке не больше семи слов."""
    if POINT_RE.fullmatch(text):
        return False
    style = (p.style.name if p.style is not None else "").lower()
    if style.startswith(("heading", "заголовок", "title")):
        return True
    m = SECTION_RE.fullmatch(text)
    if len(text) > 100 or not (m or text.lower().startswith("приложение")):
        return False
    if not text.endswith(".") or APPENDIX_RE.match(text):
        return True
    if m is None or not m.group(1).isdigit():
        return False
    after = (point_after() or "").startswith(m.group(1) + ".")
    return after or (prev.isdigit() and int(m.group(1)) == int(prev) + 1 and len(text.split()) <= 7)


def read_document(path, notes=()):
    """Документ Word по разделам: [{"label", "key", "heading", "title", "items": [(номер, текст, абзац)], "tables"}].
    До первого раздела шапка, колонтитулы и сноски: свой раздел в конце. Номер пункта из текста («4.2.»),
    абзац без номера: «<раздел>, абз. N». notes: слова служебных пометок, такие абзацы без номера пропускаются.
    Текст в таблицах в два столбца на двух языках читается по русскому столбцу; у шапки счётчики таких таблиц:
    "bilingual" (прочитан русский текст) и "unclear" (таблица с текстом не прочитана: язык не определить)."""
    docx = load_docx()
    from docx.oxml.ns import qn
    from docx.text.paragraph import Paragraph
    try:
        document = docx.Document(path)
    except Exception:
        raise StopRun(f"Файл {path.name} не открывается как документ Word. "
                      "Откройте его в Word, сохраните как .docx и запустите расчёт снова.")

    def section(label, key, heading, title=""):
        return {"label": label, "key": key, "heading": heading, "title": title, "items": [], "tables": [], "plain": 0}

    w_p, w_tbl = qn("w:p"), qn("w:tbl")
    flow = []  # (абзац или таблица, часть документа, основной ли это текст, текст абзаца; у таблицы None)
    bilingual = unclear = 0
    bilingual_doc = False  # в документе есть таблицы на двух языках
    for part in word_parts(document):
        root = part.element if hasattr(part, "element") else None
        if root is None:
            continue
        in_body = str(part.partname).endswith("document.xml")
        tops = [el for el in root.iter(w_p, w_tbl) if next(el.iterancestors(w_tbl), None) is None]
        plan = two_column_text([el for el in tops if el.tag == w_tbl]) if in_body else {}
        bilingual_doc = bilingual_doc or bool(plan)
        for el in tops:
            if el in plan:  # договор на двух языках: вместо таблицы её русский текст
                bilingual += 1
                flow += [(x, part, True, text) for x, text in plan[el]]
            else:
                flow.append((el, part, in_body, text_of(el) if el.tag == w_p else None))

    def point_after(k):  # номер первого пункта после абзаца k: «4.1» за строкой «4. Название.»
        return next((POINT_RE.fullmatch(t).group(1) for *_x, t in flow[k + 1:] if t and POINT_RE.fullmatch(t)), None)

    body, tail = [section(HEAD, HEAD, "")], section(FOOT, FOOT, "")
    title_done = seen_point = False
    for k, (el, part, in_body, text) in enumerate(flow):
        here = body[-1] if in_body else tail
        if text is None:
            points = table_points(el, len(body) > 1) if in_body else SKIP
            if points is None and bilingual_doc and not looks_kazakh(text_of(el)):
                # русская таблица в договоре на двух языках, не «условие | значение»: абзацы слева направо
                for tc in el.iter(qn("w:tc")):
                    for p in tc.findall(qn("w:p")):
                        if text_of(p):
                            here["plain"] += 1
                            here["items"].append((f"{here['label']}, абз. {here['plain']}", text_of(p), text_of(p)))
                continue
            if not isinstance(points, list):  # спецификация, реквизиты, данные; None: текст, который не прочитать
                unclear += points is None
                here["tables"].append([row_cells(tr) for tr in el.findall(qn("w:tr"))])
                continue
            used = {n for n, _t, _a in here["items"]}
            for label, line in points:  # таблица условий: строка таблицы как пункт раздела
                base = no = f"{here['label']}, «{label}»"
                n = 1
                while no in used:  # то же условие ещё раз в разделе: «4, «Срок» (2)»
                    n += 1
                    no = f"{base} ({n})"
                used.add(no)
                here["items"].append((no, line, line))
            continue
        point = POINT_RE.fullmatch(text)
        if not text or (not point and any(norm(n) in norm(text) for n in notes)):
            continue
        if in_body and is_heading(Paragraph(el, part), text, lambda: point_after(k), body[-1]["label"]):
            m = SECTION_RE.fullmatch(text)
            if m or title_done or seen_point or text.lower().startswith("приложение"):
                title = m.group(2) if m else text
                body.append(section(m.group(1) if m else text, norm(title), text, title))
                continue
            title_done = True  # первый заголовок без номера до первого пункта: название документа, оно в шапке
        if point:
            seen_point = True
            here["items"].append((point.group(1), point.group(2), text))
        else:
            here["plain"] += 1
            here["items"].append((f"{here['label']}, абз. {here['plain']}", text, text))
    body[0].update(bilingual=bilingual, unclear=unclear)
    return body + ([tail] if tail["items"] else [])


def layout_problems(sections):
    """Почему сверка документа неполная: текст только в таблицах или разделы не распознаны. Пусто: всё прочитано."""
    unclear = sections[0].get("unclear", 0)
    no_sections = not any(s["items"] for s in sections[1:] if s["label"] != FOOT)
    if not any(s["items"] for s in sections) or (unclear and no_sections):
        how = "таблицей в два столбца, язык столбцов не определить" if unclear else "таблицей"
        return [f"вне таблиц нет текста (документ свёрстан {how}): пункты не сравнивались, сверьте документ вручную. "
                + HINT]
    if unclear:  # таблица в два столбца с текстом не прочитана: язык не определить или текст до первого раздела
        return [f"часть текста в таблицах в два столбца не прочитана (таблиц: {unclear}): "
                "эти пункты не сравнивались, сверьте их вручную. " + HINT]
    if no_sections or any(POINT_RE.fullmatch(a) for _n, _t, a in sections[0]["items"]):
        return ["разделы не распознаны (нет заголовков «4. Название» или стиля «Заголовок»): "
                "пункты сравнивались как одна шапка, сверьте разделы вручную"]
    return []


def pair_sections(form, doc):
    """{раздел договора: раздел формы} по заголовку без номера; чуть изменённый заголовок по похожести от 0,8."""
    pairs = {}
    for i, fs in enumerate(form):
        j = next((j for j, ds in enumerate(doc) if j not in pairs and ds["key"] == fs["key"]), None)
        if j is not None:
            pairs[j] = i
    near = sorted(((difflib.SequenceMatcher(None, fs["key"], ds["key"]).ratio(), i, j)
                   for i, fs in enumerate(form) for j, ds in enumerate(doc)), reverse=True)
    for score, i, j in near:
        if score >= 0.8 and j not in pairs and i not in pairs.values():
            pairs[j] = i
    return pairs


def pair_items(fitems, ditems):
    """Пары пунктов двух разделов по тексту, номер не важен: [(пункт формы или None, пункт договора или None,
    статус)] по порядку договора. Одинаковые пункты служат опорой, пункты между ними сопоставляются
    по похожести слов; пары не перекрещиваются."""
    used, dtok = set(), []
    for j, d in enumerate(ditems):
        i = next((i for i, f in enumerate(fitems) if i not in used and same_text(f[1], d[1])), None)
        if i is not None:
            used.add(i)
        dtok.append(i if i is not None else -1 - j)
    out, left_f, left_d = [], [], []
    opcodes = difflib.SequenceMatcher(None, list(range(len(fitems))), dtok, autojunk=False).get_opcodes()
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "equal":
            out += [(i, j, MATCH) for i, j in zip(range(i1, i2), range(j1, j2))]
            continue
        block = []
        scored = sorted(((pair_status(fitems[i][1], ditems[j][1]), i, j)
                         for i in range(i1, i2) for j in range(j1, j2)), reverse=True)
        for (score, status), i, j in scored:
            free = all(i != a and j != b and (i < a) == (j < b) for a, b, _s in block)
            if score >= PAIR_MIN and free:
                block.append((i, j, status))
        out += block
        left_f += [i for i in range(i1, i2) if all(i != a for a, _b, _s in block)]
        left_d += [j for j in range(j1, j2) if all(j != b for _a, b, _s in block)]
    for i in left_f:  # пункт переставлен в другое место раздела: тот же текст, «совпадает»
        j = next((j for j in left_d if same_text(fitems[i][1], ditems[j][1])), None)
        if j is None:
            out.append((i, None, DELETED))
        else:
            out.append((i, j, MATCH))
            left_d.remove(j)
    out += [(None, j, ADDED) for j in left_d]

    def place(row):  # по порядку договора; удалённый пункт сразу за тем, что стоял перед ним в форме
        i, j, _status = row
        if j is not None:
            return j, 0, 0
        return max((jj for ii, jj, _s in out if ii is not None and jj is not None and ii < i), default=-1), 1, i
    return sorted(out, key=place)


def compare_documents(form, doc):
    """Строки сверки по порядку договора: (пункт формы, пункт договора, ключ, статус, текст формы, текст договора,
    что проверить в заполненных полях или None). Ключ «4.2», если номер в форме и договоре тот же, иначе
    «10.1/9.1», «нет/4.4», «9/нет». Раздела формы нет в договоре: одна строка «удалён»; раздела договора
    нет в форме: одна строка «добавлен»."""
    pairs = pair_sections(form, doc)
    rows, done = [], set()

    def key(f, d):
        return f if f == d else f"{f or 'нет'}/{d or 'нет'}"

    def whole(s):
        return " ".join([s["heading"]] + [a for _n, _t, a in s["items"]]).strip()

    def deleted_before(k):
        for i in range(k):
            if i not in done and i not in pairs.values():
                done.add(i)
                rows.append((form[i]["label"], None, key(form[i]["label"], None), DELETED, whole(form[i]), None, None))

    for j, ds in enumerate(doc):
        if j not in pairs:
            rows.append((None, ds["label"], key(None, ds["label"]), ADDED, None, whole(ds), None))
            continue
        fs = form[pairs[j]]
        deleted_before(pairs[j])
        if fs["title"] or ds["title"]:  # заголовок пары разделов без номера: правка в нём тоже отличие
            status = pair_status(fs["title"], ds["title"])[1]
            if status != MATCH:
                rows.append((fs["label"], ds["label"], key(fs["label"], ds["label"]), status,
                             fs["heading"], ds["heading"], None))
        for i, jj, status in pair_items(fs["items"], ds["items"]):
            f = fs["items"][i] if i is not None else (None, None, None)
            d = ds["items"][jj] if jj is not None else (None, None, None)
            note = "; ".join(field_problems(f[1], d[1])) if status == MATCH else ""
            rows.append((f[0], d[0], key(f[0], d[0]), status, f[2], d[2], note or None))
    deleted_before(len(form))
    return rows


def contract_card(doc):
    """Карточка условий договора: [(условие, текст или None)]; None: в договоре не нашлось."""
    head = [a for _n, _t, a in doc[0]["items"]]
    parties = {}
    for text in head:
        for m in PARTY_RE.finditer(text):
            parties.setdefault(norm(m.group(2)), re.sub(r"^и\s+", "", m.group(1).strip()))
    doc_no = next((m.group(1) for m in map(DOC_NO_RE.search, head) if m), None)
    date = next((m.group() for m in map(DATE_RE.search, head) if m), None)
    card = [(p, parties.get(norm(p))) for p in PARTIES] + [("Номер", doc_no), ("Дата", date)]
    for name, where, words in CARD:
        found = [a for s in doc[1:] for _n, _t, a in s["items"]
                 if re.search(norm(words), norm(s["heading"] if where == "раздел" else a))]
        card.append((name, " ".join(found if where == "раздел" else found[:1]) or None))
    return card


def spec_table(doc, word, skip=""):
    """Первая таблица раздела, в заголовке которого есть word (и нет skip): строки, первая из них шапка."""
    for s in doc:
        title = norm(s["heading"])
        if word in title and not (skip and skip in title) and s["tables"]:
            return s["tables"][0]
    return None


def column(head, *words):
    return next((i for i, c in enumerate(head) if any(w in norm(c) for w in words)), None)


def diff(a, b):
    return round(a - b, 2) if a is not None and b is not None else None


def amount_text(v):
    """Количество для итога: 80000 → «80 000», нет числа: «нет»."""
    return "нет" if v is None else money(v).removesuffix(",00")


def check_spec(doc, sum_text):
    """Спецификация: количество × цена по каждой строке, итог, сумма договора (пункт sum_text) против пересчёта;
    количества против технической спецификации по наименованию товара. Словарь: rows и tech (строки листов),
    diff (итог в документе минус пересчёт), problems (что не сходится), unread [(что, почему)] человеку."""
    res = {"rows": [], "tech": [], "diff": None, "problems": [], "unread": []}
    spec, tech = spec_table(doc, SPEC_SECTION, TECH_SECTION), spec_table(doc, TECH_SECTION)
    products = []
    if spec is None:
        res["unread"].append(("спецификация", "нет раздела спецификации с таблицей"))
    else:
        head, body = spec[0], spec[1:]
        col = [column(head, "товар", "наименован"), column(head, "количеств"), column(head, "цена"), column(head, "сумма")]
        if None in col:
            res["unread"].append(("спецификация", "нет столбца товара, количества, цены или суммы: " + ", ".join(head)))
            body = []
        calcs, totals = [], []  # totals: итоговые строки («Итого», «НДС», «Итого с НДС») как в документе
        for cells in body:
            cells = cells + [""] * len(head)  # строка короче шапки
            name, (q, p, s) = cells[col[0]], [number(cells[c]) for c in col[1:]]
            label = next((c for c in cells if SUMMARY_RE.match(norm(c))), None)
            if label is not None:
                totals.append((label, s, cells[col[3]]))
                continue
            if not name:
                continue
            bad = [f"{h} «{cells[c]}»" for h, c, v in zip(("количество", "цена", "сумма"), col[1:], (q, p, s)) if v is None]
            if bad:
                res["unread"].append((f"спецификация, {name}", "не число: " + ", ".join(bad)))
            calc = round(q * p, 2) if q is not None and p is not None else None
            calcs.append(calc)
            products.append((name, q))
            res["rows"].append([name, q, p, s, calc, diff(s, calc)])
        total_calc = round(sum(calcs), 2) if calcs and None not in calcs else None
        point = POINT_RE.fullmatch(sum_text or "")
        label41 = f"Сумма договора, п. {point.group(1)}" if point else "Сумма договора"
        # сумма: самое большое число цифрами в тексте пункта без его номера (прописью не считается)
        amounts = [n for n in map(number, NUM_RE.findall(point.group(2) if point else sum_text or "")) if n is not None]
        amount = max(amounts, default=None)
        if sum_text and amount is None:
            res["unread"].append((label41, "в тексте пункта нет суммы числом"))
        one_total = len(totals) == 1 and TOTAL_RE.match(norm(totals[0][0]))
        if one_total:
            label, total_doc, raw = totals[0]
            if total_doc is None:
                res["unread"].append((f"спецификация, {label}", f"сумма не числом: «{raw}»"))
            res["diff"] = diff(total_doc, total_calc)
            res["rows"] += [[label, None, None, total_doc, total_calc, res["diff"]],
                            [label41, None, None, amount, total_calc, diff(amount, total_calc)]]
        elif totals:  # «Итого без НДС», «НДС», «Итого с НДС»: какой итог с чем сверять, решает человек
            res["rows"] += [[label, None, None, s, None, None] for label, s, _raw in totals]
            res["rows"] += [["Итого по пересчёту", None, None, None, total_calc, None],
                            [label41, None, None, amount, None, None]]
            res["unread"].append(("спецификация", "несколько итоговых строк (" + ", ".join(t[0] for t in totals)
                                  + f"): какую сверять с пересчётом {money(total_calc) or 'нет'} и с суммой "
                                  "договора, решает человек"))
        else:
            if products:
                res["unread"].append(("спецификация", "нет строки «Итого» или «Всего»: итог документа не с чем сверить"))
            res["rows"] += [["Итого по пересчёту", None, None, None, total_calc, None],
                            [label41, None, None, amount, total_calc, diff(amount, total_calc)]]
        res["problems"] += [f"{r[0]}: {money(r[3])} при пересчёте {money(r[4])}" for r in res["rows"] if r[5]]
    if tech is None:
        res["unread"].append(("техническая спецификация", "нет раздела технической спецификации с таблицей"))
        return res
    head, body = tech[0], tech[1:]
    ci, cq = column(head, "товар", "наименован"), column(head, "количеств")
    if ci is None or cq is None:
        res["unread"].append(("техническая спецификация", "нет столбца товара или количества: " + ", ".join(head)))
        body = []
    qty, seen = {norm(n): q for n, q in products}, set()
    for cells in body:
        cells = cells + [""] * len(head)
        name, t = cells[ci], number(cells[cq])
        if not name or any(SUMMARY_RE.match(norm(c)) for c in cells):
            continue
        if t is None:
            res["unread"].append((f"техническая спецификация, {name}", f"количество не числом: «{cells[cq]}»"))
        seen.add(norm(name))
        res["tech"].append([name, qty.get(norm(name)), t, diff(qty.get(norm(name)), t)])
    res["tech"] += [[n, q, None, None] for n, q in products if norm(n) not in seen]
    if products:
        res["problems"] += [f"{n}: в спецификации {amount_text(s)}, в технической {amount_text(t)}"
                            for n, s, t, d in res["tech"] if d != 0]
    return res
```

Пример `main` для сверки двух документов (договор поставщика против типовой формы):

```python
def main():
    form_path, doc_path = two_documents()
    form, doc = read_document(form_path, FORM_NOTES), read_document(doc_path)
    rows = compare_documents(form, doc)  # (пункт формы, пункт договора, ключ, статус, текст формы, текст договора, поля)
    card = contract_card(doc)
    spec = check_spec(doc, dict(card).get(SUM_CARD))
    layout = [(path, why) for path, sections in ((form_path, form), (doc_path, doc)) for why in layout_problems(sections)]
    out_cols = ["Пункт", "Что", "Типовая форма", "Договор"]
    manual = [([f"документ: {path.name}", None, None, None], why) for path, why in layout]
    for _f, _d, k, st, ft, dt, note in rows:
        if st != MATCH:  # отличие находит программа, риск оценивает человек
            manual.append(([k, st, ft, dt], "оценить риск: решает юрист"))
        elif note:  # поле формы заполнено так, что стоит посмотреть
            manual.append(([k, st, ft, dt], note))
    manual += [([f"карточка: {n}", NO_DATA, None, None], "не нашлось в договоре") for n, v in card if v is None]
    manual += [([what, None, None, None], why) for what, why in spec["unread"]]
    same = [[k, st, ft, dt] for _f, _d, k, st, ft, dt, note in rows if st == MATCH and not note]
    count = {st: sum(1 for r in rows if r[3] == st) for st in (CHANGED, MINOR_EDIT, ADDED, DELETED)}
    files = [
        write_excel("sverka-dogovora.xlsx", {
            "Отличия": (["Пункт формы", "Пункт договора", "Что", "Типовая форма", "Договор", "Проверить"],
                        [[f or "нет", d or "нет", st, ft, dt, note] for f, d, _k, st, ft, dt, note in rows]),
            "Спецификация": (["Товар", "Количество", "Цена", "В договоре", "Пересчёт", "Разница"], spec["rows"]),
            "Техспецификация": (["Товар", "В спецификации", "В технической спецификации", "Разница"], spec["tech"]),
            "Карточка условий": (["Условие", "Значение"], [[n, NO_DATA if v is None else v] for n, v in card]),
        }),
        write_manual(out_cols, manual),
    ]
    summary = (f"Договор {doc_path.name} против формы {form_path.name}: изменено {count[CHANGED]}, "
               f"мелких правок {count[MINOR_EDIT]}, добавлено {count[ADDED]}, удалено {count[DELETED]}. ")
    if doc[0]["bilingual"]:
        summary += "Договор двуязычный: сверялся русский текст. "
    elif form[0]["bilingual"]:
        summary += "Типовая форма двуязычная: сверялся русский текст. "
    if layout:
        summary += "Сверка неполная: документ прочитан не целиком, смотрите «разобрать вручную». "
    if spec["problems"]:
        summary += "Цифры не сходятся: " + "; ".join(spec["problems"]) + ". "
    elif spec["rows"]:
        summary += "Цифры спецификации сходятся. "
    summary += f"Разобрать вручную: {len(manual)} (файл razobrat-vruchnuyu.xlsx)."
    result = {
        "title": TITLE,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "status": "yellow" if spec["problems"] or layout else "green",  # тревога по скиллу: цифры, неполная сверка
        "summary": summary,
        "columns": out_cols,
        "rows": [values for values, _why in manual] + same,  # «разобрать вручную» первыми
        "row_status": ["info"] * len(manual) + [None] * len(same),
        "row_note": [MANUAL] * len(manual) + [None] * len(same),
        "files": files,
        "sverka": {
            "итоги": {"изменено": count[CHANGED], "добавлено": count[ADDED], "удалено": count[DELETED],
                      "мелких правок": count[MINOR_EDIT], "разница спецификации": spec["diff"]},
            "по строкам": {k: st for _f, _d, k, st, *_x in rows if st != MATCH},
        },
    }
    write_result(result)
    print(result["summary"])
```
