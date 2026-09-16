from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from trading_max.research.facts import ResearchContext, build_financial_facts, make_quote

from services.api.trading_max_api.dashboard import _valuation_rows
from services.api.trading_max_api.dashboard_models import ResearchLensSnapshot
from services.api.trading_max_api.research_journal import ResearchJournalStore
from services.api.trading_max_api.routes.research import router
from services.api.trading_max_api.valuation_assumptions import ValuationAssumptionsStore


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
    valuation = _valuation_rows(
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
    app.state.research = SimpleNamespace(lens_snapshot=lambda *args: lens)
    app.state.store = SimpleNamespace(latest_manifest=lambda: object())
    app.state.valuation_assumptions = ValuationAssumptionsStore(tmp_path)
    app.state.research_journal = ResearchJournalStore(tmp_path)
    original_assumptions = app.state.valuation_assumptions.load()
    with TestClient(app) as client:
        default = client.get("/v1/research/TEST/valuation-preview")
        assert default.status_code == 200, default.text
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
            json=body,
            headers={"Authorization": "Bearer synthetic-test-token"},
        )
        assert saved.status_code == 200, saved.text
        assert len(saved.json()["models"]) == 1
        reopened = client.get("/v1/research/TEST/valuation-preview")
        assert reopened.status_code == 200
        assert reopened.json()["horizon"] == 10
        assert reopened.json()["scenarios"]["base"]["inputs"]["revenueCagr"] == 0.1
        assert app.state.valuation_assumptions.load() == original_assumptions
        assert reopened.json()["references"] == []
        conflict = client.post(
            "/v1/research/TEST/valuation-preview", json={**body, "dataVersion": "old"}
        )
        assert conflict.status_code == 409
