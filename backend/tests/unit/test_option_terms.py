import math
from datetime import UTC, date, datetime

import numpy as np
import pandas as pd
import pytest
from trading_max.research.option_terms import chain_availability, contract_terms
from trading_max.research.technical import _clean_contracts, _gamma_profile, _option_gex


def test_standard_equity_expiry_uses_exchange_close_and_dst():
    terms = contract_terms(
        "TEST260918C00100000", "REGULAR", "TEST", "EQUITY", "NMS", date(2026, 9, 18)
    )
    assert terms["multiplier"] == 100
    assert terms["expiry_instant"] == "2026-09-18T20:00:00+00:00"
    adjusted = contract_terms(
        "TEST1260918C00100000", "REGULAR", "TEST", "EQUITY", "NMS", date(2026, 9, 18)
    )
    assert adjusted["multiplier"] is None
    unknown_market = contract_terms(
        "TEST260918C00100000", "REGULAR", "TEST", "EQUITY", "LSE", date(2026, 9, 18)
    )
    assert unknown_market["expiry_instant"] is None


def test_same_day_capture_expiry_and_missing_terms_are_distinct():
    raw = pd.DataFrame(
        {
            "contractSymbol": ["TEST260918C00100000"],
            "contractSize": ["REGULAR"],
            "strike": [100],
            "openInterest": [0],
            "impliedVolatility": [0.2],
        }
    )
    before = _clean_contracts(
        raw,
        "call",
        date(2026, 9, 18),
        captured_at=datetime(2026, 9, 18, 19, tzinfo=UTC),
        underlying="TEST",
        asset_type="EQUITY",
        exchange="NMS",
        risk_free_rate=0.04,
        dividend_yield=0,
    )
    assert before.iloc[0].years == pytest.approx(1 / (365 * 24))
    assert _option_gex(before, 100).iloc[0] == 0
    before.loc[0, "years"] = 0
    assert math.isnan(_option_gex(before, 100).iloc[0])
    assert _gamma_profile(before, 100) == ([], None)
    before.loc[0, "years"] = 0.1
    before.loc[0, "open_interest"] = np.nan
    assert math.isnan(_option_gex(before, 100).iloc[0])


def test_gamma_multiplier_scaling_and_rate_requirement():
    raw = pd.DataFrame(
        {
            "strike": [100, 100],
            "iv": [0.2, 0.2],
            "years": [0.25, 0.25],
            "side": ["call", "call"],
            "open_interest": [20, 20],
            "multiplier": [100, 150],
            "risk_free_rate": [0.04, 0.04],
            "dividend_yield": [0, 0],
        }
    )
    gex = _option_gex(raw, 100)
    assert gex.iloc[1] / gex.iloc[0] == pytest.approx(1.5)
    d1 = (0.04 + 0.5 * 0.2**2) * 0.25 / (0.2 * math.sqrt(0.25))
    expected = (
        math.exp(-d1 * d1 / 2)
        / math.sqrt(2 * math.pi)
        / (100 * 0.2 * math.sqrt(0.25))
        * 20
        * 100
        * 100**2
        * 0.01
    )
    assert gex.iloc[0] == pytest.approx(expected)
    raw.loc[0, "risk_free_rate"] = np.nan
    assert math.isnan(_option_gex(raw, 100).iloc[0])


def test_chain_mode_is_decided_at_server_time_without_rewriting_capture():
    rows = [{"expiry": "2026-09-18", "expiryInstant": "2026-09-18T20:00:00+00:00"}]
    assert (
        chain_availability("2026-09-18T19:00:00Z", rows, datetime(2026, 9, 18, 19, 30, tzinfo=UTC))[
            "state"
        ]
        == "current"
    )
    assert (
        chain_availability("2026-09-18T19:00:00Z", rows, datetime(2026, 9, 18, 20, 1, tzinfo=UTC))[
            "currentExpiries"
        ]
        == []
    )
    assert (
        chain_availability("2026-09-08T19:00:00Z", rows, datetime(2026, 9, 18, 19, 30, tzinfo=UTC))[
            "state"
        ]
        == "historical"
    )
