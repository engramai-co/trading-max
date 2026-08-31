from __future__ import annotations

import json
from pathlib import Path

from services.api.trading_max_api.valuation_assumptions import (
    ValuationAssumptionsStore,
    ValuationAssumptionsUpsertRequest,
    ValuationScenario,
)


def _seed(path: Path) -> Path:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "as_of": "2026-08-01",
                "revision": 1,
                "companies": [
                    {
                        "ticker": "BE",
                        "name": "Bloom Energy",
                        "source": "seed-v1",
                        "scenarios": {
                            "base": {"revenue_cagr": 0.15},
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def test_valuation_assumptions_store_seeds_then_persists_edits(
    tmp_path: Path,
) -> None:
    seed = _seed(tmp_path / "seed.json")
    store = ValuationAssumptionsStore(tmp_path / "state", seed_path=seed)

    seeded = store.load()
    assert seeded.companies[0].ticker == "BE"

    updated = store.upsert(
        "BE",
        ValuationAssumptionsUpsertRequest(
            scenarios={
                "base": ValuationScenario(revenue_cagr=0.20),
                "bear": ValuationScenario(revenue_cagr=0.05),
            },
            source="manual",
        ),
    )
    assert updated.revision == 2
    assert updated.as_of != seeded.as_of

    loaded = store.load()
    company = next(item for item in loaded.companies if item.ticker == "BE")
    assert company.source == "manual"
    assert company.scenarios["base"].revenue_cagr == 0.20
    payload = store.to_snapshot_payload()
    assert payload["companies"][0]["scenarios"]["bear"]["revenueCagr"] == 0.05
    history = store.history(10)
    assert len(history) == 1
    assert history[0].ticker == "BE"
    assert "base.revenueCagr" in history[0].changes
    assert history[0].changes["base.revenueCagr"]["before"] == 0.15
    assert history[0].changes["base.revenueCagr"]["after"] == 0.20

    unchanged = store.upsert(
        "BE",
        ValuationAssumptionsUpsertRequest(
            scenarios={
                "base": ValuationScenario(revenue_cagr=0.20),
                "bear": ValuationScenario(revenue_cagr=0.05),
            },
            source="manual",
        ),
    )
    assert len(store.history(10)) == 1
    assert unchanged.revision == 2

    renamed = store.upsert(
        "BE",
        ValuationAssumptionsUpsertRequest(
            scenarios={
                "base": ValuationScenario(revenue_cagr=0.20),
                "bear": ValuationScenario(revenue_cagr=0.05),
            },
            name="Bloom Energy Corp",
            source="manual",
        ),
    )
    assert renamed.revision == 3
    assert store.history(10)[0].changes["name"]["before"] == "Bloom Energy"
    assert store.history(10)[0].changes["name"]["after"] == "Bloom Energy Corp"

    source_only = store.upsert(
        "BE",
        ValuationAssumptionsUpsertRequest(
            scenarios={
                "base": ValuationScenario(revenue_cagr=0.20),
                "bear": ValuationScenario(revenue_cagr=0.05),
            },
            name="Bloom Energy Corp",
            source="reviewed",
        ),
    )
    assert source_only.revision == 4
    company = next(item for item in source_only.companies if item.ticker == "BE")
    assert company.source == "reviewed"
    assert store.history(10)[0].changes["source"]["after"] == "reviewed"


def test_valuation_assumptions_seed_covers_whole_watchlist(
    tmp_path: Path,
) -> None:
    store = ValuationAssumptionsStore(tmp_path / "state")
    state = store.load()
    assert len(state.companies) >= 50
    for company in state.companies:
        assert {"bear", "base", "bull"} <= set(company.scenarios)
