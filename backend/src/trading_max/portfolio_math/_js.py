"""Numeric and timestamp semantics shared with the TypeScript reference."""

import re
from datetime import UTC, datetime, timedelta
from math import floor, isfinite

DAY_MS = 86_400_000
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# ECMAScript WhiteSpace + LineTerminator (which do not include U+0085).
_JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_RADIX = re.compile(r"0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)")
DATE_ONLY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_DATE = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[Tt ]([0-9]{2}):([0-9]{2})"
    r"(?::([0-9]{2})(?:\.([0-9]+))?)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?)?"
)
_EXACT = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])"
)


def numeric(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip(_JS_WHITESPACE)
        if _RADIX.fullmatch(value):
            try:
                value = int(value, 0)
            except ValueError:
                return None
        elif not _DECIMAL.fullmatch(value):
            return None
    elif not isinstance(value, int | float):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return (number or 0.0) if isfinite(number) else None


def epoch_ms(value: datetime) -> int:
    # Avoid floating point timestamp rounding for fractional milliseconds.
    elapsed = value - EPOCH
    return elapsed.days * DAY_MS + elapsed.seconds * 1000 + elapsed.microseconds // 1000


def _parse_iso(value: str, *, exact: bool) -> int | None:
    match = _DATE.fullmatch(value)
    if match is None:
        return None
    year, month, day, hour, minute, second = (int(part or 0) for part in match.groups()[:6])
    fraction, offset = match.group(7, 8)
    ms = int((fraction or "")[:3].ljust(3, "0"))
    if not 1 <= day <= 31 or minute >= 60 or second >= 60 or hour > 24:
        return None
    if hour == 24 and (exact or minute or second or (fraction and fraction.strip("0"))):
        return None
    offset_minutes = 0
    if offset and offset not in {"Z", "z"}:
        zone = offset[1:].replace(":", "")
        hh, mm = int(zone[:2]), int(zone[2:])
        if hh >= 24 or mm >= 60:
            return None
        offset_minutes = (hh * 60 + mm) * (-1 if offset.startswith("-") else 1)
    try:
        # V8 normalizes days 29–31 beyond month end and permits midnight at 24:00
        # in Date.parse. exactInstant round trips the wall clock and rejects this.
        base = datetime(year, month, day if exact else 1, tzinfo=UTC)
        return epoch_ms(base) + (
            (0 if exact else day - 1) * DAY_MS
            + ((hour * 60 + minute - offset_minutes) * 60 + second) * 1000
            + ms
        )
    except ValueError:
        return None


def parse_date(value: str) -> int | None:
    """Parse ISO snapshot dates; ambiguous offsetless times use UTC."""
    return _parse_iso(value, exact=False)


def exact_instant(value: str) -> int | None:
    """Parse the explicitly offset wall-clock form accepted by prepared.ts."""
    return _parse_iso(value, exact=True) if _EXACT.fullmatch(value) else None


def at_ms(value: int) -> datetime:
    return EPOCH + timedelta(milliseconds=value)


def iso_ms(value: int) -> str:
    return at_ms(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def js_round(value: float) -> int:
    lower = floor(value)
    return lower + (value - lower >= 0.5)
