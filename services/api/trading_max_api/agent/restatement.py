"""Check that a Chinese restatement keeps to the English sentence it restates.

A restatement may repeat only what its sentence states. Two deterministic checks
back this up. Every quantity in the Chinese line, as a whole (value, sign,
percentage, scale and currency), must equal a quantity in the sentence. The line
must be substantive Chinese: no other scripts, no copied English, and every
Latin-script word must come from the sentence. Anything the checks cannot read is
rejected; the reader can retry.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

MAX_LENGTH = 200
MIN_CHINESE = 4

_HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
# A Latin-script word or name, including names with digits such as 5G or A17.
_WORD = re.compile(r"[A-Za-z0-9\u00c0-\u024f]+(?:['&+-][A-Za-z0-9\u00c0-\u024f]+)*")
_PERCENT_MARK = "\ue000"
# Scripts and symbols a Chinese restatement of an English sentence may contain.
_ALLOWED = re.compile(
    r"[\u3400-\u4dbf\u4e00-\u9fffA-Za-z\u00c0-\u024f0-9\s"
    r".,;:!?()'\"&/%+\-−$€£¥·•‧°®™–—…“”‘’、。《》「」『』【】〈〉﹏~]"
)
_LINK_OR_MARKUP = re.compile(r"https?:|www\.|[<>{}\[\]\\`*#|]", re.IGNORECASE)


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


# English ------------------------------------------------------------------

_EN_WORDS = {
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
} | {
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
    "hundred": 100,
    "dozen": 12,
}
_EN_ORDINALS = dict(
    zip(
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
        range(1, 11),
        strict=True,
    )
)
_EN_SCALES = {
    "hundred": 100,
    "thousand": 10**3,
    "million": 10**6,
    "billion": 10**9,
    "trillion": 10**12,
}
_EN_ATTACHED_SCALES = {"k": 10**3, "m": 10**6, "mn": 10**6, "bn": 10**9, "tn": 10**12}
_SCALE_WORDS = _EN_SCALES | _EN_ATTACHED_SCALES
# Words that put a count of one or two in the sentence without a numeral.
_EN_ONE = {"a", "an", "one", "single", "each", "every"}
_EN_TWO = {"two", "both", "pair", "dual"}
_EN_MONTHS = {
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
# Currencies are compared by family: a dollar figure may be any dollar.
_EN_CURRENCY_BEFORE = re.compile(
    r"(?:(US|HK|A|C|S|NZ)?\$|(€)|(£)|(¥)|\b(USD|EUR|GBP|JPY|CNY|RMB|HKD)\s?)$"
)
_EN_CURRENCY_AFTER = re.compile(
    r"^\s?(dollars?|euros?|pounds?|sterling|yen|yuan|renminbi|USD|EUR|GBP|JPY|CNY|RMB|HKD)\b",
    re.IGNORECASE,
)
_FAMILIES = {
    "$": "dollar",
    "us": "dollar",
    "hk": "dollar",
    "a": "dollar",
    "c": "dollar",
    "s": "dollar",
    "nz": "dollar",
    "usd": "dollar",
    "hkd": "dollar",
    "dollar": "dollar",
    "dollars": "dollar",
    "€": "euro",
    "eur": "euro",
    "euro": "euro",
    "euros": "euro",
    "£": "pound",
    "gbp": "pound",
    "pound": "pound",
    "pounds": "pound",
    "sterling": "pound",
    "¥": "yen-yuan",
    "jpy": "yen",
    "yen": "yen",
    "cny": "yuan",
    "rmb": "yuan",
    "yuan": "yuan",
    "renminbi": "yuan",
}
_EN_PERCENT = re.compile(r"^\s?(?:%|per\s?cent\b|percent\b)", re.IGNORECASE)
_EN_SCALE_WORD = re.compile(r"^\s?(thousand|million|billion|trillion|mn|bn|tn)\b", re.IGNORECASE)


def _en_currency(before: str, after: str) -> str | None:
    if match := _EN_CURRENCY_BEFORE.search(before):
        token = next(group for group in match.groups() if group) if any(match.groups()) else "$"
        return _FAMILIES.get(token.lower(), "dollar")
    if match := _EN_CURRENCY_AFTER.match(after):
        return _FAMILIES[match.group(1).lower()]
    return None


def english_quantities(sentence: str) -> list[Quantity]:
    """Numbers the sentence states, in digits or words, with their scale and kind."""
    found: list[Quantity] = []
    for match in re.finditer(r"(?<![\d.,])\d+(?:,\d{3})*(?:\.\d+)?", sentence):
        start, end = match.span()
        before, rest = sentence[:start], sentence[end:]
        if before[-1:].isalpha():
            continue  # Part of a name such as A17.
        letters = re.match(r"[A-Za-z]+", rest)
        scale = 1
        if letters:
            suffix = letters.group().lower()
            if suffix in _EN_ATTACHED_SCALES:
                scale = _EN_ATTACHED_SCALES[suffix]
            elif suffix not in {"st", "nd", "rd", "th", "s"}:
                continue  # Part of a name such as 5G.
            rest = rest[letters.end() :]
        if word := _EN_SCALE_WORD.match(rest):
            scale *= _SCALE_WORDS[word.group(1).lower()]
            rest = rest[word.end() :]
        value = _number(match.group())
        if value is None:
            continue
        sign = before[-1:]
        negative = sign in {"-", "−"} and not before[-2:-1].isalnum()
        found.append(
            Quantity(
                value * scale,
                negative,
                bool(_EN_PERCENT.match(rest)),
                _en_currency(before.rstrip("-−+"), rest),
            )
        )
    compounds = re.compile(
        r"\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-"
        r"(one|two|three|four|five|six|seven|eight|nine)\b",
        re.IGNORECASE,
    )
    for match in compounds.finditer(sentence):
        value = Decimal(sum(_EN_WORDS[part.lower()] for part in match.groups()))
        if word := _EN_SCALE_WORD.match(sentence[match.end() :]):
            value *= _SCALE_WORDS[word.group(1).lower()]
        found.append(Quantity(value))
    sentence = compounds.sub(" ", sentence)
    words = re.findall(r"[A-Za-z]+", sentence)
    for index, word in enumerate(words):
        lower = word.lower()
        following = words[index + 1].lower() if index + 1 < len(words) else ""
        value: int | float | None = None
        if lower in _EN_WORDS:
            value = _EN_WORDS[lower]
        elif lower in _EN_ORDINALS:
            value = _EN_ORDINALS[lower]
        elif lower == "half":
            value = 0.5
        elif word in _EN_MONTHS:
            value = _EN_MONTHS[word]
        if lower in _EN_ONE:
            found.append(Quantity(Decimal(1)))
            if following in _EN_SCALES:
                found.append(Quantity(Decimal(_EN_SCALES[following])))
        if lower in _EN_TWO:
            found.append(Quantity(Decimal(2)))
        if value is not None:
            amount = Decimal(str(value))
            if following in _EN_SCALES:
                amount *= _EN_SCALES[following]
            percent = following in {"percent"}
            found.append(Quantity(amount, percent=percent))
    return found


# Chinese ------------------------------------------------------------------

_ZH_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_ZH_UNITS = {"十": 10, "百": 100, "千": 1000}
_ZH_SCALES = {"十": 10, "百": 100, "千": 1000, "万": 10**4, "亿": 10**8}
# Words containing numeral characters that state no quantity.
_ZH_NOT_QUANTITIES = (
    "一系列",
    "一站式",
    "一体",
    "一些",
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
_ZH_CURRENCIES = {
    "美元": "dollar",
    "美金": "dollar",
    "港元": "dollar",
    "港币": "dollar",
    "加元": "dollar",
    "澳元": "dollar",
    "新元": "dollar",
    "欧元": "euro",
    "英镑": "pound",
    "日元": "yen",
    "人民币": "yuan",
    "元": "yuan",
}
# English scale words that may follow digits in a Chinese line, as in 12 billion.
_LATIN_SCALES = r"(?<![A-Za-z])(?i:hundred|thousand|million|billion|trillion|mn|bn|tn)(?![A-Za-z])"
_ZH_NUMBER = re.compile(
    r"(?P<digits>\d+(?:,\d{3}(?!\d))*(?:\.\d+)?)"
    r"(?P<scale>\s*[十百千万亿]+|\s*" + _LATIN_SCALES + ")?"
    r"|(?P<han>[零〇一二两三四五六七八九十百千万亿]+)"
)
_LATIN_SCALE = re.compile(_LATIN_SCALES)
_ZH_CURRENCY_AFTER = re.compile(r"^\s*(" + "|".join(_ZH_CURRENCIES) + ")")
_ZH_CURRENCY_BEFORE = re.compile(r"(?:(?:US|HK)?\$|€|£|¥)\s*$")


def _small(text: str) -> int | None:
    """A Chinese numeral below ten thousand, such as 二十 or 一千零五."""
    total, number = 0, None
    for char in text:
        if char in _ZH_DIGITS:
            if number:
                return None  # Two digits without a unit between them.
            number = _ZH_DIGITS[char]
        elif char in _ZH_UNITS:
            if number == 0:
                return None
            total += (1 if number is None else number) * _ZH_UNITS[char]
            number = None
        else:
            return None
    return total + (number or 0)


def chinese_number(text: str) -> int | None:
    """Read a Chinese numeral; None when its reading is not unambiguous."""
    if not text:
        return None
    if all(char in _ZH_DIGITS and char != "两" for char in text):
        # Digit by digit only for years such as 二〇〇七; 一二 could mean one or two.
        if len(text) == 1:
            return _ZH_DIGITS[text]
        return int("".join(str(_ZH_DIGITS[char]) for char in text)) if len(text) >= 3 else None
    for marker, scale, limit in (("亿", 10**8, 10**8), ("万", 10**4, 10**4)):
        if marker in text:
            head, _, tail = text.rpartition(marker)
            high = chinese_number(head) if marker == "亿" else _small(head)
            low = chinese_number(tail) if tail else 0
            if not head or high is None or low is None or low >= limit:
                return None
            return high * scale + low
    return _small(text)


def chinese_quantities(text: str) -> list[Quantity] | None:
    """Quantities in a Chinese line, or None when any of them cannot be read."""
    # Digits inside a name such as 5G are part of the name, which is checked as a word.
    # A scale word stays to be read with its number.
    text = _WORD.sub(
        lambda match: (
            " " * len(match.group())
            if _is_word(match.group()) and not _LATIN_SCALE.fullmatch(match.group())
            else match.group()
        ),
        text,
    )
    for word in _ZH_NOT_QUANTITIES:
        text = text.replace(word, " " * len(word))
    text = text.replace("百分之", _PERCENT_MARK * 3)
    found: list[Quantity] = []
    read: list[tuple[int, int]] = []
    for word in ("一半", "半数"):
        while word in text:
            found.append(Quantity(Decimal("0.5")))
            text = text.replace(word, " " * len(word), 1)
    for match in _ZH_NUMBER.finditer(text):
        before, after = text[: match.start()], text[match.end() :]
        read.append(match.span())
        if match.group("digits"):
            value = _number(match.group("digits"))
            if value is None:
                return None
            scale = (match.group("scale") or "").strip()
            if scale[:1] in _ZH_SCALES:
                for char in scale:
                    value *= _ZH_SCALES[char]
            elif scale:
                value *= _SCALE_WORDS[scale.lower()]
        else:
            number = chinese_number(match.group("han"))
            if number is None:
                return None
            value = Decimal(number)
        percent = before.rstrip().endswith(_PERCENT_MARK) or after.lstrip().startswith("%")
        sign = before.rstrip(_PERCENT_MARK).rstrip()[-1:]
        negative = sign == "负" or (sign in {"-", "−"} and not before.rstrip()[:-1][-1:].isalnum())
        currency = None
        if found_after := _ZH_CURRENCY_AFTER.match(after):
            currency = _ZH_CURRENCIES[found_after.group(1)]
        elif symbol := _ZH_CURRENCY_BEFORE.search(before):
            currency = _FAMILIES.get(symbol.group().strip()[-1:], "dollar")
        found.append(Quantity(value, negative, percent, currency))
    # A scale word away from digits, as in 十二 billion, cannot be read.
    if any(
        not any(start <= word.start() < end for start, end in read)
        for word in _LATIN_SCALE.finditer(text)
    ):
        return None
    return found


def _same_currency(english: str | None, chinese: str | None) -> bool:
    if chinese is None:
        return True
    if english is None:
        return False
    return english == chinese or {english, chinese} <= {"yen-yuan", "yen", "yuan"}


def _quantities_agree(zh: str, sentence: str) -> bool:
    chinese = chinese_quantities(zh)
    if chinese is None:
        return False
    english = english_quantities(sentence)
    return all(
        any(
            source.value == quantity.value
            and source.negative == quantity.negative
            and source.percent == quantity.percent
            and _same_currency(source.currency, quantity.currency)
            for source in english
        )
        for quantity in chinese
    )


def _word(word: str) -> str:
    return word.casefold().removesuffix("'s").rstrip("'-")


def _is_word(token: str) -> bool:
    return any(char.isalpha() for char in token)


def _is_name(token: str) -> bool:
    return any(char.isupper() or char.isdigit() for char in token)


def _words(text: str) -> list[str]:
    return [token for token in _WORD.findall(text) if _is_word(token)]


def faithful(zh: str, sentence: str) -> bool:
    """Accept substantive Chinese that repeats only the sentence's quantities and names."""
    if not zh.strip() or len(zh.strip()) > MAX_LENGTH or "\n" in zh.strip():
        return False
    text = unicodedata.normalize("NFKC", zh.strip())
    if _LINK_OR_MARKUP.search(text) or not all(_ALLOWED.match(char) for char in text):
        return False
    source = _words(sentence)
    source_words = {_word(word) for word in source}
    names = {_word(word) for word in source if _is_name(word)}
    latin = _words(text)
    if any(_word(word) not in source_words for word in latin):
        return False
    han = len(_HAN.findall(text))
    # Names keep their spelling. Any other English word, however it is capitalised, is
    # untranslated text.
    untranslated = sum(len(word) for word in latin if not (_is_name(word) and _word(word) in names))
    translatable = sum(len(word) for word in source if not _is_name(word))
    if han < MIN_CHINESE or han < 2 * untranslated or han < math.ceil(translatable / 10):
        return False
    return _quantities_agree(text, sentence)
