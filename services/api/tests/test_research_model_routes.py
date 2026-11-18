import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
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
                        "listing": "US:TEST",
                        "shareUnit": "ordinary",
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
            quote=make_quote(
                "TEST", {"spot": 25, "currency": "USD"}, {"metrics": {"fullExchangeName": "NYSE"}}
            ),
            asset_type="EQUITY",
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
        full = client.post("/v2/research/TEST/valuation-preview", json=body)
        assert full.status_code == 200
        assert saved.json()["models"][0]["preview"]["scenarios"] == full.json()["scenarios"]
        assert (
            full.json()["scenarios"]["base"]["value"] == result.json()["scenarios"]["base"]["value"]
        )
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
                    "assumptions": {
                        "sharesOutstanding": 100,
                        "shareUnit": "ordinary",
                        "listing": "US:TEST" if symbol == "TEST" else "LSE:TEST",
                    },
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


def test_set_replace_and_clear_one_baseline_at_five_years_and_batch_spot(tmp_path):
    from trading_max.research.valuation_preview import (
        FrozenValuationBasis,
        ScenarioInputs,
        ValuationPreviewRequest,
        preview,
    )

    lens = _valuation_lens()
    store = ResearchJournalStore(tmp_path)
    basis = FrozenValuationBasis(
        ticker="TEST",
        quote_id="quote",
        data_version="version",
        spot=10,
        currency="USD",
        revenue=100,
        shares=10,
        start_margin=0.2,
    )
    inputs = ScenarioInputs(
        discount_rate=0.10,
        exit_fcf_multiple=12,
        share_cagr=0,
        revenue_cagr=0.1,
        target_fcf_margin=0.2,
    )
    req = ValuationPreviewRequest(
        horizon=10, scenarios=dict.fromkeys(("bear", "base", "bull"), inputs)
    )
    saved = preview(basis, req)
    store.save_model(saved)
    other = store.save_model(saved, "second view").models[0].id
    app = FastAPI()
    app.include_router(router)
    app.state.research_journal = store
    app.state.settings = SimpleNamespace(api_token="synthetic")
    row = lens.valuation
    with TestClient(app) as client:

        def select(model):
            return client.put(
                "/v1/research/TEST/models/baseline",
                json={"modelId": model},
                headers={"Authorization": "Bearer synthetic"},
            )

        assert (
            client.put("/v1/research/TEST/models/baseline", json={"modelId": saved.id}).status_code
            == 401
        )
        assert select(saved.id).json()["baselineModelId"] == saved.id
        assert select(other).json()["baselineModelId"] == other
        assert select("unknown").status_code == 404
        projected = ResearchJournalStore(tmp_path).overview_valuation(row)
        expected = preview(basis, req.model_copy(update={"horizon": 5})).scenarios["base"].value
        assert projected.ev5 == pytest.approx(expected)
        assert projected.ev5_upside == pytest.approx(expected / 25 - 1)
        assert projected.ev5 != saved.scenarios["base"].value
        assert len(store.load("TEST").models) == 2
        assert select(None).json()["baselineModelId"] is None
        assert store.overview_valuation(row) == row


@pytest.mark.parametrize("case", ["ordinary", "zero", "bank"])
def test_published_preview_client_and_family_aware_opt_in(tmp_path, case):
    lens = _valuation_lens()
    lens.valuation.assumptions["shareUnit"] = "ordinary"
    if case in {"zero", "bank"}:
        rows = (
            [{"index": "Net Income Common Stockholders", "2025-12-31": 12}]
            if case == "bank"
            else [{"index": "Total Revenue", "2025-12-31": 0}]
        )
        lens.financial_facts = build_financial_facts(
            {
                "incomeStatement": rows,
                "balanceSheet": [{"index": "Common Stock Equity", "2025-12-31": 100}],
            },
            {"financialCurrency": "USD"},
        )
        lens.valuation.scenarios = {}
        lens.valuation.assumptions["family"] = "residual-income" if case == "bank" else "cash-flow"
    app = FastAPI()
    app.include_router(router)
    app.state.research = SimpleNamespace(
        lens_snapshot=lambda *args: lens, held_position=lambda *args: None
    )
    app.state.store = SimpleNamespace(latest_manifest=lambda: object())
    app.state.research_journal = ResearchJournalStore(tmp_path)
    app.state.valuation_assumptions = ValuationAssumptionsStore(tmp_path)
    with TestClient(app) as client:
        path = "/research/TEST/valuation-preview"
        old = client.get("/v1" + path)
        if case == "ordinary":
            assert old.status_code == 200
            legacy = old.json()
            # The published client reads all three inputs and formats numeric worksheet fields.
            inputs = {key: legacy["scenarios"][key]["inputs"] for key in ("bear", "base", "bull")}
            for scenario in legacy["scenarios"].values():
                for year in scenario["years"]:
                    assert all(
                        isinstance(year[k], (float, int))
                        for k in ("growth", "revenue", "fcfMargin", "freeCashflow")
                    )
            posted = client.post("/v1" + path, json={"scenarios": inputs})
            assert posted.status_code == 200
            # Frozen response contract published at 3d152ecb.
            contract = json.loads(
                (Path(__file__).parent / "fixtures/valuation-preview-v1-schema.json").read_text()
            )
            for payload in (legacy, posted.json()):
                Draft202012Validator(contract).validate(payload)
        else:
            assert old.status_code == 422
        modern = client.get("/v2" + path)
        assert modern.status_code == 200, modern.text
        assert bool(modern.json()["scenarios"]) == (case != "zero")
        if case == "bank":
            assert modern.json()["scenarios"]["base"]["years"][0]["revenue"] is None


def test_overview_sets_and_clears_a_london_equity_baseline(research_root, tmp_path, typed_fixture):
    import json

    from trading_max.research.valuation_preview import (
        FrozenValuationBasis,
        ScenarioInputs,
        ValuationPreviewRequest,
        preview,
    )

    from services.api.trading_max_api.app import create_app
    from services.api.trading_max_api.config import Settings

    broker_file = next(research_root.rglob("broker_snapshot_metrics.json"))
    broker = json.loads(broker_file.read_text())
    broker["accounts"]["A"]["positions"][0].update(
        ticker="SYN", broker_ticker="SYNl_EQ", name="Synthetic plc", price_currency="GBX"
    )
    broker_file.write_text(json.dumps(broker))
    valuation_file = next(research_root.rglob("valuation_engine_v2_output_*.json"))
    valuation = json.loads(valuation_file.read_text())
    valuation["rows"][0].update(t="SYN.L", ccy="GBP", spot=25, ev5=30)
    valuation_file.write_text(json.dumps(valuation))
    root = tmp_path / "runtime"
    typed_fixture(research_root, ArtifactStore(root))
    app = create_app(
        Settings(
            data_root=root, api_token="fixture", embedded_worker=False, dashboard_prewarm_seconds=0
        )
    )
    basis = FrozenValuationBasis(
        ticker="SYN.L",
        quote_id="q",
        data_version="v",
        currency="GBP",
        spot=20,
        shares=10,
        revenue=100,
        start_margin=0.2,
    )
    params = ScenarioInputs(
        revenue_cagr=0, target_fcf_margin=0.2, discount_rate=0.1, exit_fcf_multiple=10, share_cagr=0
    )
    forecast = preview(
        basis, ValuationPreviewRequest(scenarios=dict.fromkeys(("bear", "base", "bull"), params))
    )
    saved = app.state.research_journal.save_model(forecast).models[0].id
    with TestClient(app) as client:
        for selected in (saved, None):
            response = client.put(
                "/v1/research/SYN.L/models/baseline",
                headers={"Authorization": "Bearer fixture"},
                json={"modelId": selected},
            )
            assert response.status_code == 200
            dashboard = client.get("/v1/dashboard/lens/overview?detail=summary").json()
            assert (
                next(h for h in dashboard["holdings"] if h["ticker"] == "SYN")["researchTicker"]
                == "SYN.L"
            )
            row = next(v for v in dashboard["valuations"] if v["ticker"] == "SYN.L")
            assert row.get("baselineModelId") == selected
            assert row["ev5Upside"] == pytest.approx(
                forecast.scenarios["base"].value / 25 - 1 if selected else 0.2
            )
