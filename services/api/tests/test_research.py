from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.models import SnapshotManifest
from services.api.trading_max_api.research import (
    ResearchLedger,
    _business_day_age,
    _freshness,
    _fundamentals_rows,
    _market_rows,
)
from services.api.trading_max_api.watchlist import WatchlistStore


def test_lightweight_lenses_preserve_values_and_keep_full_details_available(
    research_root, tmp_path, typed_fixture, seed_watchlist
):
    store = ArtifactStore(tmp_path / "runtime")
    manifest = typed_fixture(research_root, store)
    watchlist = WatchlistStore(tmp_path / "runtime")
    seed_watchlist(watchlist, "BE")
    ledger = ResearchLedger(store, watchlist)
    full = ledger.lens_snapshot("BE", "overview", manifest)
    summary = ledger.lens_snapshot("BE", "overview", manifest, detail="summary")
    assert summary.market == full.market
    assert summary.context == full.context
    assert summary.technical is None and summary.valuation is None
    assert summary.portfolio_impact == full.portfolio_impact
    assert (
        summary.research_evidence.get("filings")
        == (full.research_evidence.get("filings") or [])[:3]
    )
    if full.financial_facts:
        assert all(
            o in full.financial_facts.observations for o in summary.financial_facts.observations
        )
    technical = ledger.lens_snapshot("BE", "technical", manifest)
    compact = ledger.lens_snapshot("BE", "technical", manifest, detail="summary")
    assert compact.technical.price == technical.technical.price
    assert compact.technical.rsi == technical.technical.rsi
    financials = ledger.lens_snapshot("BE", "fundamentals", manifest)
    display = ledger.lens_snapshot("BE", "fundamentals", manifest, detail="summary")
    assert display.financial_facts == financials.financial_facts
    assert display.research_evidence == financials.research_evidence
    assert display.financials is None
    documents = ledger.lens_snapshot("BE", "ledger", manifest, detail="documents")
    assert not documents.timeline and not documents.financial_facts
    assert documents.research_evidence.get("filings") == financials.research_evidence.get("filings")
    notebook = ledger.lens_snapshot("BE", "ledger", manifest, detail="summary")
    assert not notebook.timeline and not notebook.financial_facts


def test_another_issuer_does_not_change_financial_input_version(
    research_root, tmp_path, typed_fixture, seed_watchlist
):
    store = ArtifactStore(tmp_path / "runtime")
    manifest = typed_fixture(research_root, store)
    watchlist = WatchlistStore(tmp_path / "runtime")
    seed_watchlist(watchlist, "BE")
    ledger = ResearchLedger(store, watchlist)
    before = ledger.lens_snapshot("BE", "fundamentals", manifest).financial_facts
    payload = ledger._read_optional(manifest, "research/financials.json")
    added = store.immutable_artifacts.put_json(
        key="research/financials.json",
        payload={
            **payload,
            "rows": [*(payload.get("rows") or []), {"ticker": "OTHER", "financials": {}}],
        },
    )
    previous = store.immutable_snapshots.latest()
    store.immutable_snapshots.publish(
        scope="research",
        source="synthetic-other-issuer",
        artifacts=[ref for ref in previous.manifest.artifacts if ref.key != added.ref.key]
        + [added.ref],
    )
    after = ledger.lens_snapshot("BE", "fundamentals", store.latest_manifest()).financial_facts
    assert after.version == before.version
    assert after.observations == before.observations


@pytest.mark.parametrize("quote_currency", ["GBP", "USD", "", "GBp"])
def test_research_quote_metadata_and_listing_identity_are_consistent(tmp_path, quote_currency):
    from services.api.trading_max_api.models import SecuritySearchResult

    store = ArtifactStore(tmp_path)
    watchlist = WatchlistStore(tmp_path)
    watchlist.add(
        SecuritySearchResult(
            ticker="FUND.L", name="Synthetic Fund", exchange="LSE", bloomberg_ticker="", figi=""
        )
    )
    payloads = {
        "research/market_snapshot.json": {
            "technical": {
                "rows": [
                    {"ticker": "FUND.L", "price": 100, "currency": "USD" if quote_currency else ""}
                ]
            }
        },
        "research/technical.json": {
            "rows": [
                {
                    "ticker": "FUND.L",
                    "price": 100,
                    "as_of": "2026-01-01",
                    "price_series": [
                        {
                            "date": "2026-01-01",
                            "close": 100,
                            **dict.fromkeys(
                                ["open", "high", "low", "volume", "sma20", "sma50", "sma200"]
                            ),
                        }
                    ],
                }
            ]
        },
        "research/fundamentals.json": {
            "rows": [
                {
                    "ticker": "FUND.L",
                    "currency": quote_currency,
                    "metrics": {"targetMedianPrice": 120, "enterpriseValue": 5000},
                }
            ]
        },
        "account/broker_snapshot_metrics.json": {
            "accounts": {"A": {"positions": [{"ticker": "FUND.L"}]}}
        },
        "account/lookthrough_metrics.json": {"positions": [{"ticker": "FUND", "valueGbp": 250}]},
    }
    manifest = SnapshotManifest(
        run_id="synthetic",
        scope="research",
        source="test",
        created_at=datetime.now(UTC),
        artifacts=[],
    )
    ledger = ResearchLedger(store, watchlist)
    reads = []

    def read(_manifest, key):
        reads.append(key)
        return payloads.get(key, {})

    ledger._read_optional = read
    listing = ledger.directory_instruments(manifest)[0]
    assert listing.held and listing.exposure_gbp == 250
    assert not any(key.startswith("research/") for key in reads)
    lens = ledger.lens_snapshot("FUND.L", "valuation", manifest)
    assert lens.ticker == "FUND.L"
    expected_currency = "GBP" if quote_currency == "GBp" else quote_currency
    assert lens.market["currency"] == expected_currency
    assert lens.market["analystMedian"] == (1.2 if quote_currency == "GBp" else 120)
    assert lens.market["enterpriseValue"] == 5000
    # Valuation now reconciles statement cash flow before model preview.
    assert "research/options.json" not in reads
    prices = ledger.price_series("FUND.L", manifest)
    assert prices.ticker == "FUND.L" and prices.currency == expected_currency
    assert prices.points[0].close == 100
    assert ledger.lens_snapshot("FUND", "valuation", manifest).ticker == "FUND.L"
    payloads["account/lookthrough_metrics.json"] = {"positions": []}
    payloads["account/broker_snapshot_metrics.json"]["accounts"]["A"]["positions"][0][
        "current_value_gbp"
    ] = 375
    assert ledger.directory_instruments(manifest)[0].exposure_gbp == 375


def test_research_ledger_builds_ticker_snapshot_and_provenance(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    seed_watchlist,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    manifest = typed_fixture(research_root, store)
    watchlist = WatchlistStore(tmp_path / "runtime")
    seed_watchlist(watchlist, "BE")
    ledger = ResearchLedger(store, watchlist)

    overview = ledger.overview(manifest, ticker="BE")

    assert overview.selected is not None
    assert overview.selected.market is not None
    assert overview.selected.market["spot"] == 200
    assert overview.selected.technical is not None
    assert overview.selected.valuation is not None
    assert overview.selected.options is not None
    assert overview.selected.latest_event is not None
    assert overview.selected.latest_event.sources[0]["name"] == "be_q2_release"
    assert overview.selected.portfolio_impact.exposure_value_gbp == 1000
    assert overview.selected.portfolio_impact.allocation_pct == 0.5
    assert overview.models[0].model_version == "valuation-engine-v2"
    assert "portfolio" in {alert.alert_type for alert in overview.alerts}
    assert "valuation" not in {alert.alert_type for alert in overview.alerts}


def test_research_freshness_is_per_artifact(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    manifest = typed_fixture(research_root, store)
    ledger = ResearchLedger(store, WatchlistStore(tmp_path / "runtime"))

    status = ledger.status(
        manifest,
        now=datetime(2026, 8, 2, 12, tzinfo=UTC),
    )

    by_kind = {artifact.kind: artifact for artifact in status.artifacts}
    assert by_kind["market"].freshness == "fresh"
    assert by_kind["options"].freshness == "fresh"
    assert by_kind["valuation"].data_as_of == "2026-08-01"


def test_typed_market_supersedes_legacy_market_for_values_and_freshness(
    tmp_path: Path,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    legacy = store.immutable_artifacts.put_json(
        key="research/daily_market.json",
        payload={
            "as_of": "2026-08-06",
            "rows": [{"t": "BE", "spot": 228.96, "ccy": "USD"}],
        },
        kind="market",
        as_of="2026-08-06",
        producer_version="legacy-import-v1",
    )
    current = store.immutable_artifacts.put_json(
        key="research/market_snapshot.json",
        payload={
            "as_of": "2026-09-02",
            "technical": {"rows": [{"ticker": "BE", "price": 209.52, "currency": "USD"}]},
        },
        kind="market",
        as_of="2026-09-02",
        producer_version="market-snapshot-v5",
    )
    store.immutable_snapshots.publish(
        scope="research",
        source="test",
        artifacts=[legacy, current],
    )
    manifest = store.latest_manifest()
    assert manifest is not None
    ledger = ResearchLedger(store, WatchlistStore(tmp_path / "runtime"))

    snapshot = ledger.ticker_snapshot("BE", manifest)
    status = ledger.status(manifest, now=datetime(2026, 9, 3, 12, tzinfo=UTC))

    assert snapshot.market is not None
    assert snapshot.market["spot"] == 209.52
    assert snapshot.market["asOf"] == "2026-09-02"
    assert status.overall_freshness == "fresh"
    assert [artifact.key for artifact in status.artifacts] == ["research/market_snapshot.json"]


def test_timeline_deduplicates_account_only_snapshots(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    latest = store.immutable_snapshots.latest()
    assert latest is not None
    account_refs = [ref for ref in latest.manifest.artifacts if ref.key.startswith("account/")]
    store.immutable_snapshots.publish(
        scope="accounts",
        source="account-only",
        artifacts=account_refs,
    )
    ledger = ResearchLedger(store, WatchlistStore(tmp_path / "runtime"))

    assert len(ledger.timeline("BE")) == 1
    assert len(ledger.models("BE")) == 1


def test_valuation_scenario_alerts_fire_below_bear_and_above_bull(
    tmp_path: Path,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    valuation = store.immutable_artifacts.put_json(
        key="research/valuation.json",
        payload={
            "as_of": "2026-08-01",
            "rows": [
                {
                    "ticker": "VRT",
                    "price": 50.0,
                    "spot": 50.0,
                    "ev5": 100.0,
                    "ev10": 120.0,
                    "model_status": "ready",
                    "valueRange": {"bear": 100.0, "base": 200.0, "bull": 300.0},
                }
            ],
        },
        kind="valuation",
        as_of="2026-08-01",
    )
    store.immutable_snapshots.publish(
        scope="research",
        source="test",
        artifacts=[valuation],
    )
    manifest = store.latest_manifest()
    assert manifest is not None
    ledger = ResearchLedger(store, WatchlistStore(tmp_path / "runtime"))

    alerts = ledger.alerts("VRT", manifest)

    assert any(alert.alert_id == "VRT:valuation:below-bear" for alert in alerts)

    valuation_high = store.immutable_artifacts.put_json(
        key="research/valuation.json",
        payload={
            "as_of": "2026-08-01",
            "rows": [
                {
                    "ticker": "VRT",
                    "price": 400.0,
                    "spot": 400.0,
                    "ev5": 100.0,
                    "ev10": 120.0,
                    "model_status": "ready",
                    "valueRange": {"bear": 100.0, "base": 200.0, "bull": 300.0},
                }
            ],
        },
        kind="valuation",
        as_of="2026-08-01",
    )
    store.immutable_snapshots.publish(
        scope="research",
        source="test",
        artifacts=[valuation_high],
    )
    manifest_high = store.latest_manifest()
    assert manifest_high is not None

    alerts_high = ledger.alerts("VRT", manifest_high)
    assert any(alert.alert_id == "VRT:valuation:above-bull" for alert in alerts_high)


def test_research_snapshot_exposes_analyst_payload(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    analyst = store.immutable_artifacts.put_json(
        key="research/analyst.json",
        payload={
            "as_of": "2026-08-01",
            "rows": [
                {
                    "ticker": "VRT",
                    "analyst": {"priceTargets": {"mean": 120.0}},
                }
            ],
        },
        kind="analyst",
        as_of="2026-08-01",
    )
    store.immutable_snapshots.publish(
        scope="research",
        source="test",
        artifacts=[analyst],
    )
    manifest = store.latest_manifest()
    assert manifest is not None
    ledger = ResearchLedger(store, WatchlistStore(tmp_path / "runtime"))

    snapshot = ledger.ticker_snapshot("VRT", manifest)
    assert snapshot.analyst == {"priceTargets": {"mean": 120.0}}


def test_research_snapshot_exposes_financials_payload(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    financials = store.immutable_artifacts.put_json(
        key="research/financials.json",
        payload={
            "as_of": "2026-08-01",
            "rows": [
                {
                    "ticker": "VRT",
                    "financials": {
                        "incomeStatement": [{"index": "Total Revenue", "2026-01-31": 100.0}]
                    },
                }
            ],
        },
        kind="financials",
        as_of="2026-08-01",
    )
    store.immutable_snapshots.publish(
        scope="research",
        source="test",
        artifacts=[financials],
    )
    manifest = store.latest_manifest()
    assert manifest is not None
    ledger = ResearchLedger(store, WatchlistStore(tmp_path / "runtime"))

    snapshot = ledger.ticker_snapshot("VRT", manifest)
    assert snapshot.financials is not None
    assert snapshot.financials["incomeStatement"][0]["index"] == "Total Revenue"


def test_market_freshness_uses_business_days() -> None:
    assert (
        _business_day_age(
            datetime(2026, 7, 31, tzinfo=UTC).date(),
            datetime(2026, 8, 3, tzinfo=UTC).date(),
        )
        == 1
    )


def test_freshness_falls_back_for_new_artifact_kinds() -> None:
    from services.api.trading_max_api.models import ArtifactInfo

    artifact = ArtifactInfo(
        key="research/new_signal.json",
        sourcePath="sha256/" + "a" * 64,
        sizeBytes=10,
        sha256="a" * 64,
        kind="new_signal",
        mediaType="application/json",
        generatedAt=datetime(2026, 8, 8, tzinfo=UTC),
        dataAsOf="2026-08-08",
    )

    age, freshness = _freshness(
        artifact,
        datetime(2026, 8, 8, 12, tzinfo=UTC),
    )

    assert age == 0
    assert freshness == "fresh"


def test_typed_market_and_fundamentals_rows_are_readable() -> None:
    market = _market_rows(
        {
            "as_of": "2026-08-07",
            "technical": {"rows": [{"ticker": "BE", "price": 25.0, "currency": "USD"}]},
        }
    )
    fundamentals = _fundamentals_rows(
        {
            "rows": [
                {
                    "ticker": "BE",
                    "metrics": {"forwardPE": 18.5},
                    "source": "yahoo-finance",
                }
            ]
        }
    )

    assert market == [
        {
            "ticker": "BE",
            "currency": "USD",
            "spot": 25.0,
            "held": False,
            "asOf": "2026-08-07",
        }
    ]
    assert fundamentals[0]["metrics"]["forwardPE"] == 18.5


def test_typed_research_ledger_reports_complete_instrument_coverage(
    tmp_path: Path,
    seed_watchlist,
) -> None:
    watchlist = WatchlistStore(tmp_path / "runtime")
    seed_watchlist(watchlist, "BE")
    ledger = ResearchLedger(None, watchlist)  # type: ignore[arg-type]
    payloads = {
        "research/daily_market.json": {},
        "research/market_snapshot.json": {
            "as_of": "2026-08-07",
            "technical": {"rows": [{"ticker": "BE", "price": 25.0}]},
        },
        "research/technical.json": {
            "rows": [
                {
                    "ticker": "BE",
                    "seasonality": [
                        {
                            "month": 1,
                            "meanReturn": 0.05,
                            "hitRate": 0.67,
                        }
                    ],
                    "seasonality_coverage": {
                        "basis": "full-listing-history",
                        "first_session": "2018-01-02",
                        "last_session": "2026-08-07",
                        "daily_sessions": 2160,
                        "monthly_observations": 102,
                    },
                }
            ],
        },
        "research/valuation.json": {
            "rows": [{"ticker": "BE", "price": 25.0}],
        },
        "research/options.json": {
            "rows": [{"ticker": "BE", "spot": 25.0}],
        },
        "research/fundamentals.json": {
            "rows": [{"ticker": "BE", "metrics": {"forwardPE": 18.5}}],
        },
        "research/earnings.json": {
            "rows": [
                {
                    "ticker": "BE",
                    "calendar": {
                        "Earnings Date": ["2026-09-01"],
                        "Earnings Average": 0.25,
                    },
                }
            ],
        },
        "account/broker_snapshot_metrics.json": {
            "accounts": {"A": {"positions": []}, "B": {"positions": []}}
        },
        "account/lookthrough_metrics.json": {},
    }
    ledger._read_optional = lambda _manifest, key: payloads.get(key, {})

    items = ledger.instruments(
        SnapshotManifest(
            run_id="fixture",
            scope="research",
            source="test",
            created_at=datetime.now(UTC),
            artifacts=[],
        )
    )
    be = next(item for item in items if item.ticker == "BE")

    assert be.status == "ready"
    assert be.has_market is True
    assert be.has_technical is True
    assert be.has_options is True
    assert be.has_valuation is True
    assert be.has_fundamentals is True
    assert be.has_earnings is True
    snapshot = ledger.ticker_snapshot(
        "BE",
        SnapshotManifest(
            run_id="fixture",
            scope="research",
            source="test",
            created_at=datetime.now(UTC),
            artifacts=[],
        ),
    )
    assert snapshot.market is not None
    assert snapshot.market["spot"] == 25.0
    assert snapshot.fundamentals is not None
    assert snapshot.fundamentals["earningsCalendar"]["earningsDates"] == ["2026-09-01"]
    assert snapshot.fundamentals["seasonality"][0]["month"] == 1
    assert snapshot.fundamentals["seasonalityCoverage"]["firstSession"] == "2018-01-02"
    assert snapshot.fundamentals["seasonalityCoverage"]["monthlyObservations"] == 102
    assert snapshot.latest_event is not None


def test_typed_earnings_rows_create_a_research_event(tmp_path: Path) -> None:
    watchlist = WatchlistStore(tmp_path / "runtime")
    ledger = ResearchLedger(None, watchlist)  # type: ignore[arg-type]
    ledger._read_optional = lambda _manifest, key: (
        {
            "as_of": "2026-08-07",
            "rows": [{"ticker": "BE", "calendar": {}}],
        }
        if key == "research/earnings.json"
        else {}
    )
    manifest = SnapshotManifest(
        run_id="fixture",
        scope="research",
        source="test",
        created_at=datetime.now(UTC),
        artifacts=[],
    )

    events = ledger.events("BE", manifest)

    assert len(events) == 1
    assert events[0].event_type == "earnings"
