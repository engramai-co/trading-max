from __future__ import annotations

from datetime import date

import pandas as pd
from trading_max.application.decision_stages import AccountDecisionStage
from trading_max.infrastructure import ContentAddressedArtifactStore


def test_the_benchmark_counts_closes_with_a_final_value_in_pounds(tmp_path) -> None:
    def loader(symbol: str, start: date, end: date) -> pd.DataFrame:
        # Today's bars are already there, the benchmark's and the exchange rate's.
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
    final = stage._market(start, end, pd.Timestamp("2026-11-05T00:30:00Z"))
    assert trading is not None and trading.index[-1] == pd.Timestamp("2026-11-03")
    # New York has closed, but the 4 Nov rate is final only once that day is over.
    assert closed is not None and closed.index[-1] == pd.Timestamp("2026-11-03")
    assert final is not None and final.index[-1] == pd.Timestamp("2026-11-04")


def test_the_benchmark_leaves_out_a_close_without_its_own_days_rate(tmp_path) -> None:
    gap = pd.Timestamp("2026-11-03")

    def loader(symbol: str, start: date, end: date) -> pd.DataFrame:
        index = pd.bdate_range(start, end)
        if symbol != "SPY":
            # The provider has no 3 Nov rate (yet); 2 Nov's is not 3 Nov's.
            return pd.DataFrame({"Close": 1.25}, index=index[index != gap])
        frame = pd.DataFrame({"Close": 500.0}, index=index)
        frame.attrs["exchange"] = "PCX"
        return frame

    stage = AccountDecisionStage(
        tmp_path, ContentAddressedArtifactStore(tmp_path / "artifacts"), history_loader=loader
    )
    market = stage._market(
        pd.Timestamp("2026-10-19"), pd.Timestamp("2026-11-04"), pd.Timestamp("2026-11-05T00:30:00Z")
    )
    assert market is not None and gap not in market.index
    assert market[pd.Timestamp("2026-11-02")] == market[pd.Timestamp("2026-11-04")] == 400.0
