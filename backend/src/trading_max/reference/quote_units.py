"""Normalize quoted prices to major currency units at provider boundaries."""


def major_quote_unit(raw: str) -> tuple[str, int]:
    """Return the major currency and quote units per major unit."""
    unit = raw.strip()
    return ("GBP", 100) if unit in {"GBp", "GBX", "GBx"} else (unit.upper(), 1)
