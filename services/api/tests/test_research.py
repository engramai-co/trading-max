from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from services.api.trading_max_api import research as research_module
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.models import ArtifactInfo, SnapshotManifest
from services.api.trading_max_api.projections.broker import overlay_live_broker_snapshot
from services.api.trading_max_api.research import (
    ResearchLedger,
    _account_holdings,
    _business_day_age,
    _exchange_today,
    _freshness,
    _fundamentals_rows,
    _market_rows,
    _next_earnings_date,
    _normalized_earnings_calendar,
)
from services.api.trading_max_api.watchlist import WatchlistStore


def _synthetic_accounts() -> dict:
    """Canonical snapshot at 12:00, live overlay at 15:50, look-through from 12:00."""

    def account(fetched_at, held_value, held_price, fund_value, total):
        return {
            "fetched_at": fetched_at,
            "total_value_gbp": total,
            "investments_value_gbp": held_value + fund_value,
            "positions_status": "verified",
            "checks": {"positions_match_investments": True},
            "positions": [
                {
                    "ticker": "HELD",
                    "broker_ticker": "HELD_US_EQ",
                    "current_value_gbp": held_value,
                    "current_price": held_price,
                    "price_currency": "USD",
                },
                {
                    "ticker": "FUND.L",
                    "broker_ticker": "FUNDl_EQ",
                    "current_value_gbp": fund_value,
                    "current_price": 9500,
                    "price_currency": "GBX",
                },
            ],
        }

    return {
        "account/broker_snapshot_metrics.json": {
            "accounts": {"A": account("2026-11-04T12:00:01Z", 800.0, 200.0, 1000.0, 2000.0)}
        },
        "account/intraday/broker_values.json": {
            "accounts": {"A": account("2026-11-04T15:50:01Z", 700.0, 190.0, 1100.0, 1950.0)}
        },
        "account/lookthrough_metrics.json": {
            "positions": [
                {
                    "ticker": "HELD",
                    "valueGbp": 810.0,
                    "directValueGbp": 800.0,
                    "indirectValueGbp": 10.0,
                    "country": "United States",
                    "etfContributors": [{"ticker": "FUND", "valueGbp": 10.0}],
                },
                {
                    "ticker": "ONLYFUND",
                    "valueGbp": 50.0,
                    "directValueGbp": 0.0,
                    "indirectValueGbp": 50.0,
                    "etfContributors": [{"ticker": "FUND", "valueGbp": 50.0}],
                },
            ],
            "sources": [{"ticker": "FUND", "positionValueGbp": 1000.0, "asOf": "2026-11-02"}],
        },
    }


def test_held_securities_use_the_current_broker_basis(tmp_path):
    from services.api.trading_max_api.models import SecuritySearchResult

    store = ArtifactStore(tmp_path)
    watchlist = WatchlistStore(tmp_path)
    for ticker in ("HELD", "FUND.L", "ONLYFUND"):
        watchlist.add(
            SecuritySearchResult(
                ticker=ticker, name=ticker, exchange="NYSE", bloomberg_ticker="", figi=""
            )
        )
    payloads = _synthetic_accounts()
    ledger = ResearchLedger(store, watchlist)
    ledger._read_optional = lambda _manifest, key: payloads.get(key, {})
    manifest = SnapshotManifest(
        run_id="synthetic",
        scope="research",
        source="test",
        created_at=datetime.now(UTC),
        artifacts=[],
    )

    listing = {item.ticker: item for item in ledger.directory_instruments(manifest)}
    held = listing["HELD"]
    # Live values, not the 12:00 canonical or look-through values.
    assert held.held and held.direct_value_gbp == 700.0
    assert held.broker_price == 190.0 and held.broker_price_currency == "USD"
    assert held.broker_as_of == "2026-11-04T15:50:01Z" and held.broker_listing == "US:HELD"
    # The fund contribution is revalued with the fund: 10 × 1100 / 1000.
    assert held.exposure_gbp == 711.0
    fund = listing["FUND.L"]
    assert fund.broker_price == 95.0 and fund.broker_price_currency == "GBP"
    assert fund.exposure_gbp == 1100.0 and fund.broker_listing == "LSE:FUND"
    only_fund = listing["ONLYFUND"]
    assert not only_fund.held and only_fund.broker_price is None
    assert only_fund.broker_listing is None and only_fund.exposure_gbp == 55.0
    assert [item.exposure_gbp for item in ledger.instruments(manifest)] == [711.0, 1100.0, 55.0]

    impact = ledger.portfolio_impact("HELD", manifest)
    assert impact.direct_value_gbp == 700.0 and impact.indirect_value_gbp == 11.0
    assert impact.exposure_value_gbp == 711.0
    assert impact.total_value_gbp == 1950.0
    assert impact.allocation_pct == pytest.approx(711.0 / 1950.0)
    assert impact.holding_accounts == ["A"] and impact.as_of == "2026-11-04T15:50:01Z"
    assert impact.etf_contributors == [
        {"ticker": "FUND", "valueGbp": 11.0, "asOf": "2026-11-02", "sourceUrl": None}
    ]
    assert impact.country == "United States"
    assert ledger.held_position("HELD", manifest)["price"] == 190.0
    assert ledger.held_position("HELD", manifest)["listing"] == "US:HELD"
    assert ledger.held_position("ONLYFUND", manifest) is None

    # A fund sold since look-through no longer contributes.
    payloads["account/intraday/broker_values.json"]["accounts"]["A"]["positions"].pop()
    payloads["account/intraday/broker_values.json"]["accounts"]["A"]["investments_value_gbp"] = (
        700.0
    )
    holdings = _account_holdings(
        ledger._broker_snapshot(manifest), payloads["account/lookthrough_metrics.json"]
    )
    assert holdings["HELD"]["indirect"] == 0.0 and "FUND" not in holdings


def test_several_broker_lines_under_one_ticker_name_no_broker_price(tmp_path):
    from services.api.trading_max_api.models import SecuritySearchResult

    def position(code: str, value: float, price: float, currency: str) -> dict:
        # Both lines show the display ticker IAG; only the instrument code differs.
        return {
            "ticker": "IAG",
            "broker_ticker": code,
            "current_value_gbp": value,
            "current_price": price,
            "price_currency": currency,
        }

    broker = {
        "accounts": {
            "A": {
                "fetched_at": "2026-11-04T15:50:01Z",
                "positions": [position("IAG_US_EQ", 300.0, 4.2, "USD")],
            },
            "B": {
                "fetched_at": "2026-11-04T15:40:01Z",
                "positions": [position("IAGl_EQ", 200.0, 310.0, "GBX")],
            },
        }
    }
    watchlist = WatchlistStore(tmp_path)
    for ticker, exchange in (("IAG", "NYSE"), ("IAG.L", "LSE")):
        watchlist.add(
            SecuritySearchResult(
                ticker=ticker, name=ticker, exchange=exchange, bloomberg_ticker="", figi=""
            )
        )
    ledger = ResearchLedger(ArtifactStore(tmp_path), watchlist)
    ledger._read_optional = lambda _manifest, key: (
        broker if key == "account/broker_snapshot_metrics.json" else {}
    )
    manifest = SnapshotManifest(
        run_id="synthetic",
        scope="research",
        source="test",
        created_at=datetime.now(UTC),
        artifacts=[],
    )

    # The .L alias collapses both lines into one ticker: neither price is quoted.
    for item in ledger.directory_instruments(manifest):
        assert item.held and item.direct_value_gbp == 500.0
        assert item.broker_price is None and item.broker_listing is None
        assert ledger.held_position(item.ticker, manifest) is None
    # One instrument held in two accounts is one line, at its latest observation.
    broker["accounts"]["B"]["positions"] = [position("IAG_US_EQ", 200.0, 4.1, "USD")]
    listing = {item.ticker: item for item in ledger.directory_instruments(manifest)}
    assert listing["IAG"].broker_listing == "US:IAG" and listing["IAG"].broker_price == 4.2
    assert ledger.held_position("IAG.L", manifest)["listing"] == "US:IAG"


def test_next_earnings_date_is_one_date_and_never_past():
    today = date(2026, 11, 4)
    analyst = {
        "earningsEvents": [
            {"date": "2026-10-22", "status": "reported"},
            {"date": "2027-02-04", "status": "provider-estimate"},
            {"date": "2027-05-06", "status": "provider-estimate"},
        ]
    }
    stale_calendar = _normalized_earnings_calendar(
        {"calendar": {"Earnings Date": ["2026-10-22"]}}, today
    )
    assert stale_calendar is not None and stale_calendar["earningsDates"] == []
    assert stale_calendar["Earnings Date"] == ["2026-10-22"]
    window = _normalized_earnings_calendar(
        {"calendar": {"Earnings Date": ["2026-11-02", "2026-11-06"]}}, today
    )
    assert window is not None and window["earningsDates"] == ["2026-11-02", "2026-11-06"]
    assert _next_earnings_date(analyst, stale_calendar, today) == "2027-02-04"
    assert _next_earnings_date(None, stale_calendar, today) is None
    assert _next_earnings_date({"earningsEvents": []}, window, today) == "2026-11-06"
    reported_today = {"earningsEvents": [{"date": "2026-11-04", "status": "reported"}]}
    assert _next_earnings_date(reported_today, None, today) is None


def test_broker_price_keeps_the_time_its_positions_were_observed():
    payloads = _synthetic_accounts()
    live = payloads["account/intraday/broker_values.json"]["accounts"]["A"]
    # Fresh live totals whose positions failed reconciliation: the canonical
    # 12:00 positions stay, and so must their 12:00 time.
    live["positions_status"] = "unverified"
    broker = overlay_live_broker_snapshot(
        payloads["account/broker_snapshot_metrics.json"],
        payloads["account/intraday/broker_values.json"],
    )
    account = broker["accounts"]["A"]
    assert account["fetched_at"] == "2026-11-04T15:50:01Z"
    assert account["positions_observed_at"] == "2026-11-04T12:00:01Z"
    held = _account_holdings(broker, {})["HELD"]
    assert held["price"] == 200.0 and held["asOf"] == "2026-11-04T12:00:01Z"
    # Verified live positions carry the live time.
    live["positions_status"] = "verified"
    broker = overlay_live_broker_snapshot(
        payloads["account/broker_snapshot_metrics.json"],
        payloads["account/intraday/broker_values.json"],
    )
    held = _account_holdings(broker, {})["HELD"]
    assert held["price"] == 190.0 and held["asOf"] == "2026-11-04T15:50:01Z"


def _artifact_ref(key: str, sha: str) -> ArtifactInfo:
    return ArtifactInfo(
        key=key, source_path=key, size_bytes=1, sha256=sha, media_type="application/json"
    )


def test_analyst_lens_revision_follows_the_earnings_calendar(tmp_path):
    ledger = ResearchLedger(ArtifactStore(tmp_path), WatchlistStore(tmp_path))
    ledger._read_optional = lambda _manifest, _key: {}

    def manifest(earnings_sha: str) -> SnapshotManifest:
        return SnapshotManifest(
            run_id="synthetic",
            scope="research",
            source="test",
            created_at=datetime.now(UTC),
            artifacts=[
                _artifact_ref("research/analyst.json", "a" * 64),
                _artifact_ref("research/earnings.json", earnings_sha),
            ],
        )

    before = ledger.lens_revision(manifest("b" * 64), "analyst", "full")
    after = ledger.lens_revision(manifest("c" * 64), "analyst", "full")
    assert before != after


def test_report_dates_follow_the_exchange_calendar(tmp_path, monkeypatch):
    new_york = {"exchangeTimezoneName": "America/New_York"}
    just_after_utc_midnight = datetime(2026, 11, 5, 0, 1, tzinfo=UTC)
    assert _exchange_today(new_york, just_after_utc_midnight) == date(2026, 11, 4)
    assert _exchange_today({"exchangeTimezoneName": "Mars/Olympus"}, just_after_utc_midnight) == (
        date(2026, 11, 5)
    )
    assert _exchange_today(None, just_after_utc_midnight) == date(2026, 11, 5)

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return just_after_utc_midnight if tz is None else just_after_utc_midnight.astimezone(tz)

    monkeypatch.setattr(research_module, "datetime", Frozen)
    from services.api.trading_max_api.models import SecuritySearchResult

    watchlist = WatchlistStore(tmp_path)
    watchlist.add(
        SecuritySearchResult(
            ticker="TEST", name="Test", exchange="NYSE", bloomberg_ticker="", figi=""
        )
    )
    payloads = {
        "research/fundamentals.json": {"rows": [{"ticker": "TEST", "metrics": new_york}]},
        "research/earnings.json": {
            "rows": [{"ticker": "TEST", "calendar": {"Earnings Date": ["2026-11-04"]}}]
        },
        "research/analyst.json": {
            "rows": [
                {
                    "ticker": "TEST",
                    "analyst": {
                        "earningsEvents": [
                            {"date": "2026-11-04", "status": "provider-estimate"},
                            {"date": "2027-02-04", "status": "provider-estimate"},
                        ]
                    },
                }
            ]
        },
    }
    ledger = ResearchLedger(ArtifactStore(tmp_path), watchlist)
    ledger._read_optional = lambda _manifest, key: payloads.get(key, {})
    manifest = SnapshotManifest(
        run_id="synthetic",
        scope="research",
        source="test",
        created_at=Frozen.now(UTC),
        artifacts=[],
    )
    # 19:01 on 4 November in New York: today's report is still the next one, and
    # the calendar keeps today's window, in both the analyst and the overview lens.
    assert ledger.lens_snapshot("TEST", "analyst", manifest).next_earnings_date == "2026-11-04"
    overview = ledger.lens_snapshot("TEST", "overview", manifest, detail="summary")
    assert overview.next_earnings_date == "2026-11-04"
    assert overview.fundamentals["earningsCalendar"]["earningsDates"] == ["2026-11-04"]


def test_lens_quote_names_its_listing_and_exchange_sessions(tmp_path, monkeypatch):
    from services.api.trading_max_api.models import SecuritySearchResult

    # 15:00 in New York on the day after Thanksgiving, two hours after its early close.
    now = datetime(2026, 11, 27, 20, tzinfo=UTC)

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return now if tz is None else now.astimezone(tz)

    monkeypatch.setattr(research_module, "datetime", Frozen)
    watchlist = WatchlistStore(tmp_path)
    for ticker in ("IAG", "OLYM"):
        watchlist.add(
            SecuritySearchResult(
                ticker=ticker, name=ticker, exchange="", bloomberg_ticker="", figi=""
            )
        )
    payloads = {
        "research/fundamentals.json": {
            "rows": [
                {
                    "ticker": "IAG",
                    "metrics": {
                        "fullExchangeName": "NYSE",
                        "exchangeTimezoneName": "America/New_York",
                    },
                },
                {
                    "ticker": "OLYM",
                    "metrics": {
                        "fullExchangeName": "Olympus",
                        "exchangeTimezoneName": "Mars/Olympus",
                    },
                },
            ]
        },
    }
    ledger = ResearchLedger(ArtifactStore(tmp_path), watchlist)
    ledger._read_optional = lambda _manifest, key: payloads.get(key, {})
    manifest = SnapshotManifest(
        run_id="synthetic", scope="research", source="test", created_at=now, artifacts=[]
    )

    quote = ledger.lens_snapshot("IAG", "overview", manifest, detail="summary").context.quote
    assert quote.listing == "US:IAG"
    assert quote.schedule is not None and quote.schedule.calendar == "XNYS"
    sessions = {session.date: session for session in quote.schedule.sessions}
    assert "2026-11-26" not in sessions
    assert sessions["2026-11-27"].close == "2026-11-27T18:00:00Z"
    assert quote.schedule.until == "2026-12-08T14:30:00Z"
    unknown = ledger.lens_snapshot("OLYM", "overview", manifest, detail="summary").context.quote
    assert unknown.listing is None and unknown.schedule is None


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
    assert summary.technical_summary.score == full.technical.score
    assert summary.technical_summary.as_of == full.technical.as_of
    assert summary.technical_summary.score_explanation_state == "mismatch"
    assert summary.technical_summary.score_breakdown is None
    assert not hasattr(summary.technical_summary, "seasonality")
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
    assert compact.technical.score == summary.technical_summary.score
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


def test_technical_score_projection_preserves_published_values_and_missingness():
    from trading_max.research.technical_scoring import technical_score

    from services.api.trading_max_api.projections.research import technical_rows

    raw = {
        "ticker": "SYNTHETIC",
        "as_of": "2026-10-05",
        "price": 100,
        "moving_averages": {"sma20": 90, "sma50": 110},
        "momentum": {"rsi14": 45},
    }
    score, state = technical_score(raw)
    row = technical_rows({"rows": [{**raw, "technical_score": score, "technical_state": state}]})[0]
    assert row["score"] == score
    assert row["scoreExplanationState"] == "verified"
    assert row["scoreBreakdown"]["availableSignals"] == 3
    assert row["scoreBreakdown"]["score"] == score
    assert row["scoreBreakdown"]["groups"][2]["contribution"] is None
    assert technical_rows({"rows": [raw]})[0]["score"] is None
    mismatch = technical_rows({"rows": [{**raw, "technical_score": 99}]})[0]
    assert mismatch["score"] == 99
    assert mismatch["scoreExplanationState"] == "mismatch"
    assert mismatch["scoreBreakdown"] is None
    for invalid in (float("nan"), float("inf"), -1, 101):
        assert technical_rows({"rows": [{**raw, "technical_score": invalid}]})[0]["score"] is None


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
                        "Earnings Date": ["2099-09-01"],
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
    assert snapshot.fundamentals["earningsCalendar"]["earningsDates"] == ["2099-09-01"]
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
