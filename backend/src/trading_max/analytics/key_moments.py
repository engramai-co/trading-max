"""Rank dated, checkable events against observed daily bars in a visible range."""

from bisect import bisect_left
from collections import defaultdict
from collections.abc import Iterable
from math import isfinite
from statistics import fmean, pstdev

VOLUME_SESSIONS = 20


def _value(raw):
    return (
        float(raw)
        if isinstance(raw, (int, float)) and not isinstance(raw, bool) and isfinite(raw)
        else None
    )


def key_moments(bars: list[dict], events: Iterable[dict], start: str, end: str) -> list[dict]:
    by_day = defaultdict(list)
    for event in events:
        if start <= event["date"] <= end and event not in by_day[event["date"]]:
            by_day[event["date"]].append(event)
    readings = []
    for index, bar in enumerate(bars):
        day = bar["date"]
        if not start <= day <= end:
            continue
        prior = bars[index - 1] if index else {}
        opening, close = _value(prior.get("close")), _value(bar.get("close"))
        move = (
            (close - opening) / opening if opening and opening > 0 and close is not None else None
        )
        window = [_value(p.get("volume")) for p in bars[max(0, index - VOLUME_SESSIONS) : index]]
        volume = _value(bar.get("volume"))
        z = None
        if (
            volume is not None
            and len(window) == VOLUME_SESSIONS
            and all(v is not None and v >= 0 for v in window)
        ):
            deviation = pstdev(window)
            if deviation > 0:
                z = (volume - fmean(window)) / deviation
        readings.append({"date": day, "move_fraction": move, "volume_z_score": z})

    # Ordinal ranks put a percentage move and a standardised volume on comparable scales.
    fields = ("move_fraction", "volume_z_score")
    magnitudes = {
        key: sorted(-abs(r[key]) for r in readings if r[key] is not None) for key in fields
    }
    candidates = []
    for row in readings:
        if not by_day.get(row["date"]):
            continue
        ranks = [
            1 + bisect_left(magnitudes[key], -abs(row[key]))
            for key in fields
            if row[key] is not None and row[key] != 0
        ]
        if ranks:
            all_events = by_day[row["date"]]
            candidates.append(
                {
                    **row,
                    "unusual_rank": min(ranks),
                    "events": all_events[:6],
                    "event_count": len(all_events),
                }
            )
    return sorted(candidates, key=lambda row: (row["unusual_rank"], row["date"]))[:3]
