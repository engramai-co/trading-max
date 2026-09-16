import json

import pytest

from tools.build_broker_preview import MARKER, prepare_destination, prior_close
from tools.serve_broker_preview import refresh_broker_inputs


def test_preview_rejects_existing_unmarked_data(tmp_path):
    (tmp_path / "portfolio.json").write_text("existing account state")
    with pytest.raises(ValueError, match="clean directory"):
        prepare_destination(tmp_path)
    assert (tmp_path / "portfolio.json").read_text() == "existing account state"
    assert not (tmp_path / MARKER).exists()


def test_preview_rejects_old_synthetic_state_even_with_new_marker(tmp_path):
    (tmp_path / "SYNTHETIC_DEMO_ONLY").touch()
    (tmp_path / MARKER).touch()
    with pytest.raises(ValueError, match="fully synthetic"):
        prepare_destination(tmp_path)


def test_preview_marks_new_external_state_and_allows_resume(tmp_path):
    prepare_destination(tmp_path)
    assert (tmp_path / MARKER).is_file()
    prepare_destination(tmp_path)


def test_simulated_fill_uses_an_observed_past_price_or_fails():
    market = {"symbol": "TEST", "daily": {"2026-01-02": 12, "2026-01-05": 18}}
    assert prior_close(market, "2026-01-05") == 12
    with pytest.raises(ValueError, match="no real price"):
        prior_close(market, "2026-01-02")


@pytest.mark.parametrize("missing", [False, True])
def test_preview_refresh_uses_quotes_and_never_publishes_partial_accounts(tmp_path, missing):
    from trading_max.ingestion.brokers.trading212 import ManagedAccountStore

    prepare_destination(tmp_path)
    for profile in ("invest", "isa"):
        ManagedAccountStore(profile, data_root=tmp_path / "trading212").write_snapshot(
            {
                "fetched_at_utc": "2026-01-01T00:00:00Z",
                "account_summary": {
                    "currency": "GBP",
                    "totalValue": 90,
                    "cash": {"availableToTrade": 10},
                    "investments": {
                        "currentValue": 80,
                        "totalCost": 70,
                        "realizedProfitLoss": 0,
                        "unrealizedProfitLoss": 10,
                    },
                },
                "positions": [
                    {
                        "instrument": {"ticker": "TEST", "name": "Fixture", "currency": "USD"},
                        "quantity": 2,
                        "currentPrice": 50,
                        "walletImpact": {
                            "currentValue": 80,
                            "totalCost": 70,
                            "unrealizedProfitLoss": 10,
                        },
                    }
                ],
            }
        )

    def quote(symbol):
        if missing and symbol == "GBPUSD=X":
            raise ValueError("FX unavailable")
        return {"price": 1.25 if symbol == "GBPUSD=X" else 60, "currency": "USD", "as_of": 1}

    if missing:
        with pytest.raises(ValueError, match="FX unavailable"):
            refresh_broker_inputs(tmp_path, quote_loader=quote)
        assert len(list(tmp_path.glob("trading212/*/snapshots/*.json"))) == 2
    else:
        refresh_broker_inputs(tmp_path, quote_loader=quote)
        for profile in ("invest", "isa"):
            path = sorted(tmp_path.glob(f"trading212/{profile}/snapshots/*.json"))[-1]
            result = json.loads(path.read_text())
            assert result["account_summary"]["totalValue"] == 106
            assert result["positions"][0]["walletImpact"]["totalCost"] == 70
            assert result["positions"][0]["quantity"] == 2


@pytest.mark.parametrize(
    "regular,pre,post,expected", [(100, 200, 90, 12), (300, 200, 290, 10), (300, 200, 400, 13)]
)
def test_live_preview_uses_newest_session_quote(monkeypatch, regular, pre, post, expected):
    import yfinance as yf

    from tools.serve_broker_preview import live_quote

    class Ticker:
        def __init__(self, symbol):
            pass

        def get_info(self):
            return {
                "currency": "USD",
                "regularMarketPrice": 10,
                "regularMarketTime": regular,
                "preMarketPrice": 12,
                "preMarketTime": pre,
                "postMarketPrice": 13,
                "postMarketTime": post,
            }

    monkeypatch.setattr(yf, "Ticker", Ticker)
    assert live_quote("TEST")["price"] == expected
