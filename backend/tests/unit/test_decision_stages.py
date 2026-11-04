from __future__ import annotations

from datetime import date

import pandas as pd
from trading_max.application.decision_stages import AccountDecisionStage
from trading_max.infrastructure import ContentAddressedArtifactStore


def test_the_benchmark_counts_completed_closes_only(tmp_path) -> None:
    def loader(symbol: str, start: date, end: date) -> pd.DataFrame:
        # Today's bar is already there while New York trades.
        index = pd.bdate_range(start, end)
        frame = pd.DataFrame({"Close": 500.0 if symbol == "SPY" else 1.25}, index=index)
        if symbol == "SPY":
            frame.attrs["exchange"] = "PCX"
        return frame

    stage = AccountDecisionStage(
        tmp_path, ContentAddressedArtifactStore(tmp_path / "artifacts"), history_loader=loader
    )
    start, end = pd.Timestamp("2026-10-19"), pd.Timestamp("2026-11-04")
    trading = stage._market(start, end, pd.Timestamp("2026-11-04T15:10:00Z"))
    closed = stage._market(start, end, pd.Timestamp("2026-11-04T21:30:00Z"))
    assert trading is not None and trading.index[-1] == pd.Timestamp("2026-11-03")
    assert closed is not None and closed.index[-1] == pd.Timestamp("2026-11-04")
