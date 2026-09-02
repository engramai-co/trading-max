from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

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
