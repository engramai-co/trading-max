from __future__ import annotations

import pandas as pd
from trading_max.research.technical import history_coverage


def frame(
    dates: list[str],
    closes: list[float],
    volumes: list[float],
    timezone: str,
) -> pd.DataFrame:
    index = pd.DatetimeIndex(dates).tz_localize(timezone)
    return pd.DataFrame(
        {
            "Open": closes,
            "High": [value * 1.1 for value in closes],
            "Low": [value * 0.9 for value in closes],
            "Close": closes,
            "Volume": volumes,
        },
        index=index,
    )


def test_short_adr_history_is_explicitly_incomplete_without_backfill() -> None:
    adr = frame(
        ["2026-07-10", "2026-07-13", "2026-07-14"],
        [60, 63, 61],
        [20_000, 21_000, 22_000],
        "America/New_York",
    )

    coverage = history_coverage("SKHY", adr, "3y")

    assert coverage["available_sessions"] == 3
    assert coverage["complete"] is False
    assert coverage["first_session"] == "2026-07-10"
    assert coverage["last_session"] == "2026-07-14"
    assert "only 3 genuine trading sessions" in coverage["warning"]
