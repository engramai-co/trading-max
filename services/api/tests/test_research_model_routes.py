from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from trading_max.research.facts import ResearchContext, build_financial_facts, make_quote

from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.dashboard_models import ResearchLensSnapshot
from services.api.trading_max_api.projections.research import valuation_rows
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.research_journal import ResearchJournalStore
from services.api.trading_max_api.routes.research import router
from services.api.trading_max_api.valuation_assumptions import ValuationAssumptionsStore
from services.api.trading_max_api.watchlist import WatchlistStore


@pytest.mark.parametrize(
    "revenues", [[100, 120, 110, 80], [100, 80, 200, 110], [100, 120, 80, 400]]
)
def test_typed_model_preview_save_and_note_flow(tmp_path, revenues):
    ends = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"]
    raw = {
        "incomeStatement": [
            {
                "index": "Total Revenue",
                **dict(
                    zip(
                        ["2022-12-31", "2023-12-31", "2024-12-31", "2025-12-31"],
                        revenues,
                        strict=True,
                    )
                ),
            }
        ],
        "quarterlyIncomeStatement": [{"index": "Total Revenue", **dict.fromkeys(ends, 1000)}],
        "quarterlyCashflow": [
            {"index": "Operating Cash Flow", **dict.fromkeys(ends, 100)},
            {"index": "Capital Expenditure", **dict.fromkeys(ends, -10)},
        ],
    }
    facts = build_financial_facts(raw, {"financialCurrency": "USD"})
    inputs = {
        "revenueCagr": 0.1,
        "targetFcfMargin": 0.15,
        "discountRate": 0.1,
        "exitFcfMultiple": 15,
        "shareCagr": 0,
    }
    valuation = valuation_rows(
        {
            "rows": [
                {
                    "ticker": "TEST",
                    "price": 25,
                    "currency": "USD",
                    "assumptions": {
                        "sharesOutstanding": 100,
                        "assumptionSource": "sector-template",
                    },
                    "scenarios": dict.fromkeys(("bear", "base", "bull"), inputs),
                }
            ]
        }
    )[0]
    lens = ResearchLensSnapshot(
        ticker="TEST",
        view="valuation",
        run_id="fixture",
        generated_at=datetime.now(UTC).isoformat(),
        financial_facts=facts,
        context=ResearchContext(
            quote=make_quote("TEST", {"spot": 25, "currency": "USD"}, {}), asset_type="EQUITY"
        ),
        valuation=valuation,
    )
    app = FastAPI()
    app.include_router(router)
    app.state.settings = SimpleNamespace(api_token="synthetic-test-token")
    app.state.research = SimpleNamespace(
        lens_snapshot=lambda *args: lens, held_position=lambda *args: None
    )
    app.state.store = SimpleNamespace(latest_manifest=lambda: object())
    app.state.valuation_assumptions = ValuationAssumptionsStore(tmp_path)
    app.state.research_journal = ResearchJournalStore(tmp_path)
    original_assumptions = app.state.valuation_assumptions.load()
    with TestClient(app) as client:
        default = client.get("/v1/research/TEST/valuation-preview")
        assert default.status_code == 200, default.text
        assert default.json()["defaultSource"] == "sector-template"
        refs = default.json()["references"]
        assert len(refs) == 3
        assert refs[1]["source"] == "historical-revenue-cagr"
        expected = (revenues[-1] / revenues[0]) ** (365.25 / 1096) - 1
        assert refs[1]["referenceValue"] == pytest.approx(expected)
        assert refs[1]["value"] == default.json()["scenarios"]["base"]["inputs"]["revenueCagr"]
        assert len(refs[1]["evidence"]) == 2
        assert refs[1]["period"] == "FY2022 → FY2025"
        body = {
            "horizon": 10,
            "dataVersion": default.json()["basis"]["dataVersion"],
            "scenarios": dict.fromkeys(("bear", "base", "bull"), inputs),
        }
        result = client.post("/v1/research/TEST/valuation-preview", json=body)
        assert result.status_code == 200
        assert len(result.json()["scenarios"]["base"]["years"]) == 10
        assert client.get("/v1/research/TEST/journal").json()["models"] == []
        assert client.post("/v1/research/TEST/models", json=body).status_code == 401
        saved = client.post(
            "/v1/research/TEST/models",
            json={**body, "reason": "Growth converges to the historical range"},
            headers={"Authorization": "Bearer synthetic-test-token"},
        )
        assert saved.status_code == 200, saved.text
        assert len(saved.json()["models"]) == 1
        assert saved.json()["models"][0]["reason"] == "Growth converges to the historical range"
        assert saved.json()["models"][0]["preview"]["scenarios"] == result.json()["scenarios"]
        reopened = client.get("/v1/research/TEST/valuation-preview")
        assert reopened.status_code == 200
        assert reopened.json()["horizon"] == 10
        assert reopened.json()["defaultSource"] == "saved-model"
        assert reopened.json()["scenarios"]["base"]["inputs"]["revenueCagr"] == 0.1
        assert app.state.valuation_assumptions.load() == original_assumptions
        assert reopened.json()["references"] == []
        conflict = client.post(
            "/v1/research/TEST/valuation-preview", json={**body, "dataVersion": "old"}
        )
        assert conflict.status_code == 409


EXCHANGES = {
    "TEST": {"fullExchangeName": "NYSE", "exchangeTimezoneName": "America/New_York"},
    "TEST.L": {"fullExchangeName": "LSE", "exchangeTimezoneName": "Europe/London"},
}


def _valuation_lens(symbol: str = "TEST", unit: str = "USD") -> ResearchLensSnapshot:
    """A valuation lens quoting `symbol` at 25 on its exchange, in `unit`."""

    currency = "GBP" if unit == "GBp" else unit
    ends = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"]
    facts = build_financial_facts(
        {
            "quarterlyIncomeStatement": [{"index": "Total Revenue", **dict.fromkeys(ends, 1000)}],
            "quarterlyCashflow": [
                {"index": "Operating Cash Flow", **dict.fromkeys(ends, 100)},
                {"index": "Capital Expenditure", **dict.fromkeys(ends, -10)},
            ],
        },
        {"financialCurrency": currency},
    )
    inputs = {
        "revenueCagr": 0.1,
        "targetFcfMargin": 0.15,
        "discountRate": 0.1,
        "exitFcfMultiple": 15,
        "shareCagr": 0,
    }
    valuation = valuation_rows(
        {
            "rows": [
                {
                    "ticker": symbol,
                    "price": 25,
                    "currency": currency,
                    "assumptions": {"sharesOutstanding": 100},
                    "scenarios": dict.fromkeys(("bear", "base", "bull"), inputs),
                }
            ]
        }
    )[0]
    quote = make_quote(symbol, {"spot": 25}, {"currency": unit, "metrics": EXCHANGES[symbol]})
    return ResearchLensSnapshot(
        ticker=symbol,
        view="valuation",
        run_id="fixture",
        generated_at=datetime.now(UTC).isoformat(),
        financial_facts=facts,
        context=ResearchContext(quote=quote, asset_type="EQUITY"),
        valuation=valuation,
    )


def test_valuation_preview_prices_held_securities_at_the_broker_price(tmp_path):
    lens = _valuation_lens()
    position = {
        "price": 20.0,
        "currency": "USD",
        "asOf": "2026-11-04T15:50:01Z",
        "listing": "US:TEST",
    }
    positions = {"TEST": position}
    app = FastAPI()
    app.include_router(router)
    app.state.settings = SimpleNamespace(api_token="synthetic-test-token")
    app.state.research = SimpleNamespace(
        lens_snapshot=lambda *args: lens,
        held_position=lambda ticker, _manifest: positions.get(ticker),
    )
    app.state.store = SimpleNamespace(latest_manifest=lambda: object())
    app.state.valuation_assumptions = ValuationAssumptionsStore(tmp_path)
    app.state.research_journal = ResearchJournalStore(tmp_path)
    with TestClient(app) as client:
        held = client.get("/v1/research/TEST/valuation-preview").json()
        assert held["basis"]["spot"] == 20.0
        assert held["basis"]["spotSource"] == "broker"
        assert held["basis"]["spotAsOf"] == "2026-11-04T15:50:01Z"
        base = held["scenarios"]["base"]
        assert base["upside"] == pytest.approx(base["value"] / 20.0 - 1)
        # A broker price in another currency never replaces the quote.
        position["currency"] = "GBP"
        other = client.get("/v1/research/TEST/valuation-preview").json()
        assert other["basis"]["spot"] == 25
        assert other["basis"]["spotSource"] == "quote"
        positions.clear()
        quoted = client.get("/v1/research/TEST/valuation-preview").json()
        assert quoted["basis"]["spotSource"] == "quote"
        # Broker refreshes keep the data version, so edits in progress stay valid.
        assert quoted["basis"]["dataVersion"] == held["basis"]["dataVersion"]


@pytest.mark.parametrize(
    ("symbol", "unit", "lines", "spot"),
    [
        # The same listing: the broker price.
        ("TEST", "USD", [("TEST_US_EQ", 20.0, "USD")], 20.0),
        # London pence: the broker line is in pounds, like the research quote.
        ("TEST.L", "GBp", [("TESTl_EQ", 2000.0, "GBX")], 20.0),
        ("TEST.L", "USD", [("TESTl_EQ", 20.0, "USD")], 20.0),
        # The same currency on another listing: the research quote.
        ("TEST", "USD", [("TESTl_EQ", 20.0, "USD")], 25.0),
        ("TEST.L", "USD", [("TEST_US_EQ", 20.0, "USD")], 25.0),
        # Several lines under one ticker: none stands for the quote's listing.
        ("TEST", "USD", [("TEST_US_EQ", 20.0, "USD"), ("TESTl_EQ", 21.0, "USD")], 25.0),
        # An unknown line: the listing cannot be confirmed.
        ("TEST", "USD", [("", 20.0, "USD")], 25.0),
    ],
)
def test_valuation_preview_uses_the_broker_price_only_for_the_same_listing(
    tmp_path, symbol, unit, lines, spot
):
    broker = {
        "accounts": {
            "A": {
                "fetched_at": "2026-11-04T15:50:01Z",
                "positions": [
                    {
                        "ticker": "TEST",
                        "broker_ticker": code,
                        "current_value_gbp": 100.0,
                        "current_price": price,
                        "price_currency": currency,
                    }
                    for code, price, currency in lines
                ],
            }
        }
    }
    ledger = ResearchLedger(ArtifactStore(tmp_path), WatchlistStore(tmp_path))
    ledger._read_optional = lambda _manifest, key: (
        broker if key == "account/broker_snapshot_metrics.json" else {}
    )
    lens = _valuation_lens(symbol, unit)
    app = FastAPI()
    app.include_router(router)
    app.state.settings = SimpleNamespace(api_token="synthetic-test-token")
    app.state.research = SimpleNamespace(
        lens_snapshot=lambda *args: lens, held_position=ledger.held_position
    )
    app.state.store = SimpleNamespace(latest_manifest=lambda: object())
    app.state.valuation_assumptions = ValuationAssumptionsStore(tmp_path)
    app.state.research_journal = ResearchJournalStore(tmp_path)
    with TestClient(app) as client:
        basis = client.get(f"/v1/research/{symbol}/valuation-preview").json()["basis"]
    assert basis["spot"] == pytest.approx(spot)
    assert basis["spotSource"] == ("broker" if spot == 20.0 else "quote")
