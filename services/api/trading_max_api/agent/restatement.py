"""Check that a Chinese restatement keeps to the English sentence it restates.

The check fails closed: a line it cannot read with certainty is rejected, and the
reader can retry.

Quantities. Each quantity in the line is read whole, with its sign, percentage,
scale and currency, and must equal a quantity of the sentence. English numbers are
read as whole phrases, so "one million" is one quantity and never also one. When
the sentence states a number that cannot be read exactly, such as "millions", the
line may state none. Chinese numerals must be standard: financial numerals (壹,
贰), colloquial forms (一千五) and approximate ones (十几, 数百) are rejected. A
currency in the line must be the currency the sentence names; a bare $, ¥ or 元
names none.

Language. The line must be substantive Chinese. Latin script may only repeat names
the sentence writes, verbatim. Capitals mark a name only in a sentence written in
sentence case; a sentence in title case names nothing.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from functools import cache
from itertools import product

MAX_LENGTH = 200
MIN_CHINESE = 4
# Letters of the sentence, beyond the names the line keeps, per required Han character.
LETTERS_PER_HAN = 10

_HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_LATIN = "A-Za-z\u00c0-\u024f"
# A Latin-script word or name, including names with digits (5G, A17) or dots (Amazon.com).
_WORD = re.compile(rf"[{_LATIN}0-9]+(?:['’&+.-][{_LATIN}0-9]+)*")
_PERCENT_MARK = "\ue000"
_ALLOWED = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fffA-Za-z\u00c0-\u024f0-9\s"
    r".,;:!?()'\"&/%+\-−$€£¥₹₩·•‧°®™–—…“”‘’、。《》「」『』【】〈〉﹏~]"
)
_LINK_OR_MARKUP = re.compile(r"https?:|www\.|[<>{}\[\]\\`*#|]", re.IGNORECASE)
_LINE_BREAK = re.compile(r"[\r\n\u2028\u2029]")
# Full-width punctuation that NFKC would make ASCII stays a Chinese separator.
_CHINESE_PUNCTUATION = str.maketrans(dict.fromkeys("，：；！？（）", "、"))


@dataclass(frozen=True)
class Quantity:
    value: Decimal
    negative: bool = False
    percent: bool = False
    currency: str | None = None


def _number(text: str) -> Decimal | None:
    try:
        return Decimal(text.replace(",", ""))
    except InvalidOperation:
        return None


def _letters(word: str) -> int:
    return sum(char.isalpha() for char in word)


# Currencies --------------------------------------------------------------------

# Currencies by identity. A bare $, ¥ or 元 names no particular currency, and "?" is
# one the check does not know.
_CODES = {
    code: code
    for code in [
        "USD",
        "HKD",
        "TWD",
        "AUD",
        "CAD",
        "SGD",
        "NZD",
        "EUR",
        "GBP",
        "JPY",
        "CNY",
        "CHF",
        "INR",
        "KRW",
    ]
}
_CODES["RMB"] = "CNY"
_DOLLARS = {
    "": "$",
    "US": "USD",
    "U.S.": "USD",
    "HK": "HKD",
    "NT": "TWD",
    "A": "AUD",
    "AU": "AUD",
    "C": "CAD",
    "CA": "CAD",
    "S": "SGD",
    "NZ": "NZD",
}
_SYMBOLS = {"€": "EUR", "£": "GBP", "¥": "¥", "₹": "INR", "₩": "KRW"}
_PREFIX = re.compile(
    r"(?:(?<![A-Za-z.])(?P<dollar>U\.S\.|[A-Z]{1,3})?\$|(?P<symbol>[€£¥₹₩])"
    r"|(?<![A-Za-z])(?P<code>" + "|".join(_CODES) + r"))\s*$"
)
_EN_SUFFIX = tuple(
    (re.compile(rf"\s?(?:{pattern})\b", re.IGNORECASE), currency)
    for pattern, currency in (
        (r"U\.?S\.? dollars?", "USD"),
        (r"Hong Kong dollars?", "HKD"),
        (r"(?:New )?Taiwan dollars?", "TWD"),
        (r"Australian dollars?", "AUD"),
        (r"Canadian dollars?", "CAD"),
        (r"Singapore dollars?", "SGD"),
        (r"New Zealand dollars?", "NZD"),
        (r"dollars?", "$"),
        (r"euros?", "EUR"),
        (r"pounds? sterling|sterling", "GBP"),
        (r"pounds?", "?"),
        (r"yen", "JPY"),
        (r"yuan|renminbi", "CNY"),
        (r"Swiss francs?", "CHF"),
        (r"francs?", "?"),
        (r"Indian rupees?", "INR"),
        (r"rupees?", "?"),
        (r"won", "KRW"),
        *_CODES.items(),
    )
)
_ZH_CURRENCIES = {
    "美元": "USD",
    "美金": "USD",
    "港元": "HKD",
    "港币": "HKD",
    "新台币": "TWD",
    "台币": "TWD",
    "澳元": "AUD",
    "澳币": "AUD",
    "加元": "CAD",
    "加币": "CAD",
    "新加坡元": "SGD",
    "新元": "SGD",
    "新币": "SGD",
    "新西兰元": "NZD",
    "纽元": "NZD",
    "欧元": "EUR",
    "英镑": "GBP",
    "日元": "JPY",
    "日圆": "JPY",
    "円": "JPY",
    "人民币元": "CNY",
    "人民币": "CNY",
    "瑞士法郎": "CHF",
    "法郎": "?",
    "印度卢比": "INR",
    "卢比": "?",
    "韩元": "KRW",
    "美分": "?",
    "块": "?",
    "元": "元",
} | _CODES
_ZH_SUFFIX = re.compile(
    r"\s*(" + "|".join(sorted(_ZH_CURRENCIES, key=len, reverse=True)) + r")(?![A-Za-z])"
)
_ZH_RMB = re.compile(r"人民币\s*$")


def _prefix_currency(before: str) -> tuple[str | None, int]:
    """The currency written just before a number, and where it starts."""
    match = _PREFIX.search(before)
    if not match:
        return None, len(before)
    if match.group("symbol"):
        return _SYMBOLS[match.group("symbol")], match.start()
    if match.group("code"):
        return _CODES[match.group("code")], match.start()
    return _DOLLARS.get(match.group("dollar") or "", "?"), match.start()


def _one_currency(*currencies: str | None) -> str | None:
    named = {currency for currency in currencies if currency is not None}
    if named == {"CNY", "元"}:
        return "CNY"
    if len(named) > 1:
        return "?"
    return named.pop() if named else None


def _same_currency(source: str | None, line: str | None) -> bool:
    """A currency in the line must be the currency the sentence names."""
    if line is None:
        return True
    if line == "$":
        return source == "USD"
    if line in ("¥", "元"):
        return source == "CNY"
    return line == source and line != "?"


# Signs -------------------------------------------------------------------------

# A sign or a word of decline written just before a quantity is part of it.
_EN_NEGATIVE = re.compile(
    r"(?:(?<![0-9A-Za-z])[-−–—]"
    r"|\b(?:minus|negative|fell|declined|decreased|dropped|down|(?:decline|decrease|drop|fall) of)"
    r"(?:\s+by)?(?:\s+(?:about|approximately|around|nearly|almost|roughly|some|over"
    r"|more than|less than|to))?)$",
    re.IGNORECASE,
)
_ZH_NEGATIVE = re.compile(
    rf"(?:(?<![0-9{_LATIN}])[-−–—]|负|减少|减|降低|下降|降|下跌|跌)\s*了?\s*"
    r"(?:约|近|逾|超过|大约|将近|达|至|到)?$"
)


# English -----------------------------------------------------------------------

_UNITS = {
    word: value
    for value, word in enumerate(
        [
            "zero",
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
            "eleven",
            "twelve",
            "thirteen",
            "fourteen",
            "fifteen",
            "sixteen",
            "seventeen",
            "eighteen",
            "nineteen",
        ]
    )
}
_TENS = {
    word: 10 * value
    for value, word in enumerate(
        ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"], start=2
    )
}
_LARGE = {"thousand": 10**3, "million": 10**6, "billion": 10**9, "trillion": 10**12}
_SCALE_WORDS = {"hundred": 100, **_LARGE, "mn": 10**6, "bn": 10**9, "tn": 10**12}
_ABBREVIATED = {"k": 10**3, "m": 10**6, "mn": 10**6, "bn": 10**9, "tn": 10**12}
_ORDINALS = {
    word: value
    for value, word in enumerate(
        [
            "first",
            "second",
            "third",
            "fourth",
            "fifth",
            "sixth",
            "seventh",
            "eighth",
            "ninth",
            "tenth",
        ],
        start=1,
    )
}
# Numbers without an exact value: the sentence states a quantity the check cannot read.
_VAGUE = {"hundreds", "thousands", "millions", "billions", "trillions", "dozens", "tens", "scores"}
_PARTS = {"half", "halves", "thirds", "quarter", "quarters", "fourths", "fifths", "dozen"}
_MONTHS = {
    name: number
    for number, names in enumerate(
        (
            ("January", "Jan"),
            ("February", "Feb"),
            ("March", "Mar"),
            ("April", "Apr"),
            ("May",),
            ("June", "Jun"),
            ("July", "Jul"),
            ("August", "Aug"),
            ("September", "Sep", "Sept"),
            ("October", "Oct"),
            ("November", "Nov"),
            ("December", "Dec"),
        ),
        start=1,
    )
    for name in names
}
_EN_DIGITS = re.compile(r"(?<![\w.,])\d+(?:,\d{3})*(?:\.\d+)?")
_EN_SCALE = re.compile(r"\s?(hundred|thousand|million|billion|trillion|mn|bn|tn)\b", re.IGNORECASE)
_EN_PERCENT = re.compile(r"\s?(?:%|per\s?cent\b|percent\b)", re.IGNORECASE)
_EN_WORDS = re.compile(r"[A-Za-z]+(?:-[A-Za-z]+)*")


def _word_value(word: str) -> int | None:
    """0 to 99 written as one word, such as seven, forty or twenty-five."""
    if word in _UNITS:
        return _UNITS[word]
    if word in _TENS:
        return _TENS[word]
    tens, _, unit = word.partition("-")
    if tens in _TENS and 0 < _UNITS.get(unit, 0) < 10:
        return _TENS[tens] + _UNITS[unit]
    return None


def _numeric(word: str) -> bool:
    return (
        _word_value(word) is not None
        or word in _SCALE_WORDS
        or word in _ORDINALS
        or word in _VAGUE
        or word in _PARTS
    )


def _phrase_value(words: list[str]) -> Decimal | None:
    """The exact value of a spelled-out number, or None when it has none."""
    if words in (["half"], ["a", "half"]):
        return Decimal("0.5")
    total, group, largest, last = 0, None, None, ""
    for position, word in enumerate(words):
        value = _word_value(word)
        if word in ("a", "an"):
            if position:
                return None
            group, last = 1, "a"
        elif word == "and":
            if last != "hundred":
                return None
            last = "and"
        elif value is not None:
            if last in ("", "large"):
                group = value
            elif group is not None and (
                (last in ("hundred", "and") and group % 100 == 0)
                or (last == "tens" and word in _UNITS and 0 < value < 10)
            ):
                group += value
            else:
                return None
            last = "tens" if word in _TENS else "unit"
        elif word == "hundred":
            if last not in ("a", "unit") or group is None or not 1 <= group <= 9:
                return None
            group, last = group * 100, "hundred"
        elif word in _LARGE:
            if group is None or (largest is not None and _LARGE[word] >= largest):
                return None
            total += group * _LARGE[word]
            group, largest, last = None, _LARGE[word], "large"
        elif word == "dozen":
            if last not in ("a", "unit", "tens") or group is None:
                return None
            group, last = group * 12, "dozen"
        else:
            return None
    if last == "and":
        return None
    return Decimal(total + (group or 0))


def _phrase_end(words: list[re.Match[str]], index: int, sentence: str) -> int:
    """Where a spelled-out number that starts at index ends; index when none starts there."""

    def word(position: int) -> str:
        return words[position].group().lower()

    def adjacent(position: int) -> bool:
        return (
            position < len(words)
            and sentence[words[position - 1].end() : words[position].start()].isspace()
        )

    first = word(index)
    following = word(index + 1) if adjacent(index + 1) else ""
    if not (
        _word_value(first) is not None
        or first in ("hundred", "dozen", "half", *_LARGE)
        or (first in ("a", "an") and following in ("hundred", "dozen", "half", *_LARGE))
    ):
        return index
    end = index + 1
    while adjacent(end):
        current, previous = word(end), word(end - 1)
        after = word(end + 1) if adjacent(end + 1) else ""
        if (
            _word_value(current) is not None
            or current in ("hundred", "dozen", "half", "point", *_LARGE)
            or (current == "and" and (_word_value(after) is not None or after in ("a", "an")))
            or (current in ("a", "an") and previous in ("and", "half"))
        ):
            end += 1
        else:
            break
    return end


def english_quantities(sentence: str) -> tuple[list[Quantity], bool]:
    """The sentence's quantities, and whether it states a number that cannot be read exactly."""
    found: list[Quantity] = []
    unreadable = False

    def add(value: Decimal | int, start: int, end: int) -> None:
        before, after = sentence[:start], sentence[end:]
        currency, cut = _prefix_currency(before)
        percent = bool(_EN_PERCENT.match(after))
        if not percent:
            for pattern, named in _EN_SUFFIX:
                if pattern.match(after):
                    currency = _one_currency(currency, named)
                    break
        negative = bool(_EN_NEGATIVE.search(before[:cut].rstrip()))
        found.append(Quantity(Decimal(value), negative, percent, currency))

    # Words such as million that belong to a number written in digits.
    read: list[tuple[int, int]] = []
    for match in _EN_DIGITS.finditer(sentence):
        start, end = match.span()
        if re.search(r"[A-Za-z]-$", sentence[:start]):
            continue  # Part of a name such as COVID-19.
        value = _number(match.group())
        if value is None:
            unreadable = True
            continue
        if letters := re.match(r"[A-Za-z]+", sentence[end:]):
            suffix = letters.group().lower()
            if suffix in _ABBREVIATED:
                value *= _ABBREVIATED[suffix]
            elif suffix not in ("st", "nd", "rd", "th", "s"):
                continue  # Part of a name such as 5G.
            end += letters.end()
        if scale := _EN_SCALE.match(sentence, end):
            value *= _SCALE_WORDS[scale.group(1).lower()]
            end = scale.end()
        read.append((start, end))
        add(value, start, end)

    words = list(_EN_WORDS.finditer(sentence))
    index = 0
    while index < len(words):
        match = words[index]
        word = match.group().lower()
        if any(start <= match.start() < end for start, end in read):
            index += 1
            continue
        if "-" in word and _word_value(word) is None:
            head, *rest = word.split("-")
            value = _word_value(head)
            if value is None:
                value = _ORDINALS.get(head)
            if any(_numeric(part) for part in rest):
                unreadable = True  # one-third, twenty-first
            elif value is not None:
                add(value, *match.span())  # three-year, second-largest
            index += 1
            continue
        if word in _VAGUE:
            unreadable = True
            index += 1
            continue
        end = _phrase_end(words, index, sentence)
        if end > index:
            phrase = _phrase_value(
                [words[position].group().lower() for position in range(index, end)]
            )
            if phrase is None:
                unreadable = True
            else:
                add(phrase, match.start(), words[end - 1].end())
            index = end
            continue
        if word in ("a", "an", "single"):
            add(1, *match.span())
        elif word in ("both", "dual", "twice"):
            add(2, *match.span())
        elif word in _ORDINALS:
            add(_ORDINALS[word], *match.span())
        elif match.group() in _MONTHS:
            add(_MONTHS[match.group()], *match.span())
        index += 1
    return found, unreadable


# Chinese -----------------------------------------------------------------------

_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_DIGIT_NAMES = "零一二三四五六七八九"
# Financial, traditional and colloquial numerals the check does not read.
_VARIANT_NUMERALS = frozenset("壹贰貳叁參叄弎肆伍陆陸柒捌玖拾佰仟萬億兩廿卅卌皕幺俩倆仨")
# Words containing numeral characters that state no quantity.
_ZH_NOT_QUANTITIES = (
    "一系列",
    "一站式",
    "一方面",
    "一体",
    "一些",
    "一切",
    "一样",
    "统一",
    "唯一",
    "之一",
    "进一步",
    "一起",
    "一直",
    "一般",
    "一致",
    "一定",
    "同一",
    "一流",
    "二手",
    "二维码",
    "三维",
    "零售",
    "零部件",
    "零配件",
    "零件",
    "零食",
    "百货",
    "百分比",
    "百分点",
    "万物",
    "万维网",
    "千瓦",
    "千米",
    "千克",
)
_ZH_SCALES = {
    "十": 10,
    "百": 100,
    "千": 10**3,
    "万": 10**4,
    "亿": 10**8,
    "十万": 10**5,
    "百万": 10**6,
    "千万": 10**7,
    "十亿": 10**9,
    "百亿": 10**10,
    "千亿": 10**11,
    "万亿": 10**12,
}
_ZH_NUMBER = re.compile(
    r"(?P<digits>\d+(?:,\d{3}(?!\d))*(?:\.\d+)?)(?P<scale>\s*[十百千万亿]+)?"
    r"|(?P<han>[零〇一二两三四五六七八九十百千万亿]+)"
)
# Approximate numerals such as 十几, 几百 or 数十.
_ZH_VAGUE = re.compile(r"几|数\s*[十百千万亿个家种项名位款座所条]")


def _spellings(value: int, initial: bool) -> set[str]:
    """Standard spellings of 1 to 9,999, such as 十二, 二百零五 or 两千."""
    places: list[list[str]] = []
    started = skipped = False
    for digit, unit in zip(
        (value // 1000 % 10, value // 100 % 10, value // 10 % 10, value % 10),
        ("千", "百", "十", ""),
        strict=True,
    ):
        if not digit:
            skipped = skipped or started
            continue
        names = [_DIGIT_NAMES[digit]]
        if digit == 2 and unit in ("千", "百"):
            names.append("两")
        if digit == 1 and unit == "十" and initial and not started:
            names.append("")  # 十二 as well as 一十二
        zero = "零" if skipped else ""
        places.append([zero + name + unit for name in names])
        started, skipped = True, False
    return {"".join(choice) for choice in product(*places)}


@cache
def _small_numerals(initial: bool) -> dict[str, int]:
    """Numerals below 10,000; only one that opens a number may start with a bare 十."""
    numerals = {
        spelling: value for value in range(1, 10_000) for spelling in _spellings(value, initial)
    }
    if initial:
        numerals |= {"零": 0, "〇": 0, "两": 2}
    return numerals


def _numeral(text: str, initial: bool) -> int | None:
    for marker, scale in (("亿", 10**8), ("万", 10**4)):
        if marker in text:
            head, _, tail = text.partition(marker)
            high = _numeral(head, initial) if marker == "亿" else _small_numerals(initial).get(head)
            low = _lower(tail, scale)
            if not high or low is None:
                return None
            return high * scale + low
    return _small_numerals(initial).get(text)


def _lower(tail: str, scale: int) -> int | None:
    """The part after 万 or 亿. Unless it fills the next place down, 零 must open it."""
    if not tail:
        return 0
    zero = tail.startswith("零")
    value = _numeral(tail[1:] if zero else tail, initial=False)
    if not value or value >= scale or zero != (value < scale // 10):
        return None
    return value


def chinese_number(text: str) -> int | None:
    """A Chinese numeral in standard form, or None for any other form."""
    return _numeral(text, initial=True)


def _han_number(numeral: str, after: str) -> int | None:
    # A year may be written digit by digit, as in 二〇〇七年.
    if len(numeral) == 4 and after.startswith("年") and all(char in _DIGITS for char in numeral):
        return int("".join(str(_DIGITS[char]) for char in numeral))
    return chinese_number(numeral)


def chinese_quantities(text: str) -> list[Quantity] | None:
    """Quantities in a Chinese line, or None when any of them cannot be read exactly."""
    if any(char in _VARIANT_NUMERALS for char in text):
        return None
    # Digits inside a Latin-script name such as 5G belong to the name.
    blank = _WORD.sub(
        lambda match: " " * len(match.group()) if _letters(match.group()) else match.group(),
        text,
    ).replace("几乎", "  ")
    if _ZH_VAGUE.search(blank):
        return None
    for word in _ZH_NOT_QUANTITIES:
        blank = blank.replace(word, " " * len(word))
    blank = blank.replace("百分之", _PERCENT_MARK * 3)
    found: list[Quantity] = []
    for word in ("一半", "半数"):
        found.extend(Quantity(Decimal("0.5")) for _ in range(blank.count(word)))
        blank = blank.replace(word, " " * len(word))
    for match in _ZH_NUMBER.finditer(blank):
        start, end = match.span()
        if match.group("digits"):
            value = _number(match.group("digits"))
            scale = (match.group("scale") or "").strip()
            if value is None or (scale and scale not in _ZH_SCALES):
                return None
            value *= _ZH_SCALES.get(scale, 1)
        else:
            number = _han_number(match.group("han"), blank[end:])
            if number is None:
                return None
            value = Decimal(number)
        percent = blank[:start].rstrip().endswith(_PERCENT_MARK) or blank[end:].lstrip().startswith(
            "%"
        )
        prefix, cut = _prefix_currency(text[:start])
        if prefix is None and (rmb := _ZH_RMB.search(text[:start])):
            prefix, cut = "CNY", rmb.start()
        suffix = None
        if not percent and (named := _ZH_SUFFIX.match(text, end)):
            suffix = _ZH_CURRENCIES[named.group(1)]
        sign = blank[:cut].rstrip().rstrip(_PERCENT_MARK).rstrip()
        found.append(
            Quantity(
                value,
                bool(_ZH_NEGATIVE.search(sign)),
                percent,
                _one_currency(prefix, suffix),
            )
        )
    return found


def _same_quantity(source: Quantity, line: Quantity) -> bool:
    return (
        source.value == line.value
        and source.negative == line.negative
        and source.percent == line.percent
        and _same_currency(source.currency, line.currency)
    )


def _quantities_agree(text: str, sentence: str) -> bool:
    chinese = chinese_quantities(text)
    if chinese is None:
        return False
    english, unreadable = english_quantities(sentence)
    if chinese and unreadable:
        return False
    return all(any(_same_quantity(source, quantity) for source in english) for quantity in chinese)


# Names -------------------------------------------------------------------------

# Words that a sentence in sentence case keeps in lower case after its first word.
_FUNCTION_WORDS = frozenset(
    [
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "has",
        "have",
        "in",
        "into",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "that",
        "the",
        "their",
        "these",
        "this",
        "through",
        "to",
        "was",
        "were",
        "which",
        "with",
    ]
)
# Lower-case words that may join two parts of a name, as in Bank of America.
_CONNECTORS = frozenset({"and", "of", "the", "de", "du", "des", "der", "la", "le", "van", "von"})
# Company suffixes that a comma may separate from the name, as in Example, Inc.
_SUFFIXES = frozenset(
    {
        "Inc",
        "Incorporated",
        "Corp",
        "Corporation",
        "Co",
        "Company",
        "Ltd",
        "Limited",
        "LLC",
        "LP",
        "L.P",
        "plc",
        "PLC",
        "SA",
        "S.A",
        "AG",
        "NV",
        "N.V",
        "SE",
        "AB",
        "ASA",
        "Oyj",
        "SpA",
        "S.p.A",
        "KGaA",
        "Holdings",
        "Group",
    }
)
_JOINED = re.compile(r"\s+(?:&\s+)?")
_SUFFIX_GAP = re.compile(r"\.?,\s*")


def _name_like(word: str) -> bool:
    return (
        word[0].isupper()
        or any(char.isupper() for char in word[1:])
        or (any(char.isdigit() for char in word) and any(char.isalpha() for char in word))
    )


def _sentence_case(words: list[str]) -> bool:
    """Whether the sentence keeps ordinary words in lower case, so capitals can mark names."""
    alphabetic = [word for word in words if _letters(word)]
    if not any(word.islower() for word in alphabetic):
        return False
    return not any(
        word[0].isupper() and word[1:].islower() and word.lower() in _FUNCTION_WORDS
        for word in alphabetic[1:]
    )


def name_spans(sentence: str) -> list[list[str]]:
    """Names the sentence writes, word by word, such as Widget Cloud or Example, Inc."""
    matches = list(_WORD.finditer(sentence))
    if not _sentence_case([match.group() for match in matches]):
        return []
    spans: list[list[str]] = []
    span: list[str] = []
    pending: list[str] = []
    opens = False

    def close() -> None:
        nonlocal span, pending
        named = [word for word in span if _letters(word)]
        # A sentence capitalises its first word, which alone is no evidence of a name.
        if named and (
            not opens
            or len(named) > 1
            or any(char.isupper() or char.isdigit() for char in span[0][1:])
        ):
            spans.append(span)
        span, pending = [], []

    for index, match in enumerate(matches):
        word = match.group()
        if span:
            gap = sentence[matches[index - 1].end() : match.start()]
            joined = _JOINED.fullmatch(gap) or (word in _SUFFIXES and _SUFFIX_GAP.fullmatch(gap))
            if not joined:
                close()
        if _letters(word) and _name_like(word):
            if not span:
                opens = index == 0
            span.extend(pending)
            pending = []
            span.append(word)
        elif span and not _letters(word) and not pending:
            span.append(word)  # Microsoft 365, January 2007
        elif span and word in _CONNECTORS:
            pending.append(word)
        else:
            close()
    close()
    return spans


def latin_runs(text: str) -> list[list[str]]:
    """The line's Latin-script words, in runs that only spaces or & separate."""
    runs: list[list[str]] = []
    run: list[str] = []
    matches = list(_WORD.finditer(text))
    for index, match in enumerate(matches):
        if run and not _JOINED.fullmatch(text[matches[index - 1].end() : match.start()]):
            runs.append(run)
            run = []
        run.append(match.group())
    if run:
        runs.append(run)
    trimmed = []
    for words in runs:
        named = [position for position, word in enumerate(words) if _letters(word)]
        if named:
            trimmed.append(words[named[0] : named[-1] + 1])
    return trimmed


def _within(run: list[str], span: list[str]) -> bool:
    return any(span[start : start + len(run)] == run for start in range(len(span) - len(run) + 1))


def faithful(zh: str, sentence: str) -> bool:
    """Accept substantive Chinese that repeats only the sentence's quantities and names."""
    line = zh.strip()
    if not line or len(line) > MAX_LENGTH or _LINE_BREAK.search(line):
        return False
    text = unicodedata.normalize("NFKC", line.translate(_CHINESE_PUNCTUATION))
    source = unicodedata.normalize("NFKC", sentence)
    if _LINK_OR_MARKUP.search(text) or not all(_ALLOWED.match(char) for char in text):
        return False
    spans = name_spans(source)
    kept = 0
    for run in latin_runs(text):
        if not any(_within(run, span) for span in spans):
            return False
        kept += sum(_letters(word) for word in run)
    names = sum(_letters(word) for span in spans for word in span)
    letters = sum(_letters(word) for word in _WORD.findall(source))
    needed = math.ceil(max(0, letters - min(kept, names)) / LETTERS_PER_HAN)
    if len(_HAN.findall(text)) < max(MIN_CHINESE, needed):
        return False
    return _quantities_agree(text, source)
