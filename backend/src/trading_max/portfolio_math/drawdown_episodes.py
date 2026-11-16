"""Recoveries for the return chart's already-calculated drawdown series."""

from collections.abc import Sequence
from math import isfinite

from .types import IndexedDrawdownEpisode, NullableNumber


def drawdown_episodes(values: Sequence[NullableNumber]) -> list[IndexedDrawdownEpisode]:
    episodes: list[IndexedDrawdownEpisode] = []
    peak = -1
    active: IndexedDrawdownEpisode | None = None
    for index, depth in enumerate(values):
        if depth is None or not isfinite(depth):
            if active:
                episodes.append({**active, "state": "interrupted"})
            active = None
            peak = -1
        elif depth >= 0:
            if active:
                episodes.append({**active, "recovery": index, "state": "recovered"})
            active = None
            peak = index
        elif peak >= 0 and (not active or depth < active["depth"]):
            active = {
                "peak": peak,
                "depth": depth,
                "trough": index,
                "recovery": None,
                "state": "open",
            }
    if active:
        episodes.append(active)
    return episodes


def deepest_drawdown(values: Sequence[NullableNumber]) -> IndexedDrawdownEpisode | None:
    """The first deepest observed episode, or None when none exists."""
    return min(drawdown_episodes(values), key=lambda entry: entry["depth"], default=None)
