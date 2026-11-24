"""Integration and ordering tests for the dedicated live-collection worker lane."""

from __future__ import annotations

import csv
import json
import threading
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from functools import partial
from pathlib import Path

import httpx
import pandas as pd
import pytest
from trading_max.analytics.accounts import latest_snapshot_path
from trading_max.analytics.cash_flow_history import (
    AccountCashFlow,
    AccountCashFlowHistory,
    account_state_digest,
)
from trading_max.analytics.day_attribution import (
    AccountBaseline,
    AccountDayAttribution,
    BaselinePosition,
    DayAttribution,
    DayBaseline,
    PositionContribution,
    WindowAttribution,
    WindowBaselines,
)
from trading_max.analytics.intraday import IntradayAnchor, IntradayAnchorSeries
from trading_max.application import (
    AccountIntradayNavStage,
    AccountNavStage,
    AccountSnapshotStage,
    BrokerSyncStage,
    StageContext,
    TypedWorkerRuntime,
)
from trading_max.application.broker_sync import Trading212BrokerSync
from trading_max.application.decision_stages import AccountDecisionStage
from trading_max.application.live_cash_flows import ledger_digest
from trading_max.application.research_stages import TypedPublishSnapshotStage
from trading_max.domain import JobStatus
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SnapshotStore,
    SqliteDatabase,
    SqliteJobQueue,
)
from trading_max.ingestion.brokers.trading212 import (
    ManagedAccountStore,
    Trading212Client,
    Trading212Credentials,
    Trading212HTTPError,
    Trading212RateLimiter,
)
from trading_max.reference import (
    SecurityEntityRecord,
    SecurityMasterCatalog,
    classification_for_code,
)
from trading_max.worker import (
    LIVE_LANE_TRIGGERS,
    MAIN_LANE_TRIGGERS,
    DurableWorker,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def _credentials(profile: str) -> Trading212Credentials:
    return Trading212Credentials(
        profile=profile,
        api_key=f"synthetic-key-{profile}",
        api_secret="synthetic-secret",
    )


def _raw_broker_snapshot(
    *,
    fetched_at: datetime,
    invested: str,
    cash: str = "0",
    position_value: str | None = None,
    quantity: str = "1",
    cost: str = "90",
) -> dict:
    total = str(Decimal(invested) + Decimal(cash))
    pos_val = position_value if position_value is not None else invested
    unrealized = str(Decimal(invested) - Decimal(cost))
    return {
        "fetched_at_utc": fetched_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "account_summary": {
            "id": 1001,
            "currency": "GBP",
            "totalValue": total,
            "cash": {
                "availableToTrade": cash,
                "reservedForOrders": "0",
                "inPies": "0",
            },
            "investments": {
                "currentValue": invested,
                "totalCost": cost,
                "realizedProfitLoss": "0",
                "unrealizedProfitLoss": unrealized,
            },
        },
        "positions": [
            {
                "instrument": {
                    "ticker": "BE_US_EQ",
                    "name": "Bloom Energy",
                    "isin": "US0937121079",
                    "currency": "USD",
                },
                "quantity": quantity,
                "currentPrice": "100",
                "averagePricePaid": "90",
                "walletImpact": {
                    "currency": "GBP",
                    "currentValue": pos_val,
                    "totalCost": cost,
                    "unrealizedProfitLoss": unrealized,
                    "fxImpact": "0",
                },
            }
        ],
    }


def _export_csv(
    *, buy_shares: str = "1", deposit_gbp: str = "90", extra_deposit: bool = False
) -> str:
    rows = [
        "ID,Action,Time (UTC),ISIN,Ticker,Name,No. of shares,Price / share,"
        "Currency (Price / share),Exchange rate,Result,Currency (Result),Total,"
        "Currency (Total),Currency conversion fee",
        f"dep-1,Deposit,2026-11-10T09:00:00Z,,,,,,,,,,{deposit_gbp},GBP,0",
        f"buy-1,Market buy,2026-11-10T15:00:00Z,US0937121079,BE,Bloom Energy,"
        f"{buy_shares},112.5,USD,1.25,,,90,GBP,0",
    ]
    if extra_deposit:
        rows.append("dep-2,Deposit,2026-11-23T14:55:00Z,,,,,,,,,,10,GBP,0")
    return "\n".join(rows) + "\n"


def _seed_security_master(root: Path) -> None:
    as_of = date.today().isoformat()
    path = root / "reference" / "security-master.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        SecurityMasterCatalog(
            as_of=as_of,
            records=[
                SecurityEntityRecord(
                    entity_id="isin:US0937121079",
                    canonical_ticker="BE",
                    entity_name="Bloom Energy Corporation",
                    security_type="EQUITY",
                    provider_security_type="Common Stock",
                    market_sector="Equity",
                    gics_eligibility="eligible",
                    ticker_aliases=["BE", "BE_US_EQ"],
                    name_aliases=["Bloom Energy", "Bloom Energy Corporation"],
                    isins=["US0937121079"],
                    profile_sector="Industrials",
                    profile_industry="Electrical Equipment & Parts",
                    gics=classification_for_code(
                        "20104010",
                        source="test-fixture",
                        as_of=as_of,
                    ),
                    source="test-fixture",
                    as_of=as_of,
                )
            ],
        ).model_dump_json(by_alias=True),
        encoding="utf-8",
    )


class _ControlledClock:
    def __init__(self, start: datetime) -> None:
        self._lock = threading.Lock()
        self.current = start
        self.monotonic_value = 1000.0
        self.slept: list[float] = []

    def now(self) -> datetime:
        with self._lock:
            return self.current

    def advance(self, *, seconds: float) -> datetime:
        with self._lock:
            self.current += timedelta(seconds=seconds)
            self.monotonic_value += seconds
            return self.current

    def monotonic(self) -> float:
        with self._lock:
            return self.monotonic_value

    def wall_clock(self) -> float:
        with self._lock:
            return self.current.timestamp()

    def sleep(self, seconds: float) -> None:
        with self._lock:
            self.slept.append(seconds)
            self.current += timedelta(seconds=seconds)
            self.monotonic_value += seconds


def test_live_and_main_lanes_share_trading212_rate_limiter_across_threads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = _ControlledClock(datetime(2026, 11, 23, 15, 0, tzinfo=UTC))
    seen_limiters: list[Trading212RateLimiter] = []
    requests: list[str] = []
    raw = _raw_broker_snapshot(fetched_at=clock.now(), invested="100")

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        if request.url.path == "/api/v0/equity/account/summary":
            return httpx.Response(200, json=raw["account_summary"])
        if request.url.path == "/api/v0/equity/positions":
            return httpx.Response(200, json=raw["positions"])
        if request.url.path == "/api/v0/equity/history/transactions":
            # Main lane triggers an account-wide 429 cooldown.
            return httpx.Response(429, headers={"Retry-After": "120"})
        raise AssertionError(f"unexpected path: {request.url.path}")

    sync = Trading212BrokerSync(
        credentials_factory=_credentials,
        store_factory=lambda profile: ManagedAccountStore(
            profile, data_root=tmp_path / "trading212"
        ),
        sleep=clock.sleep,
    )
    runtime = TypedWorkerRuntime(tmp_path, broker_sync=sync)
    registry = runtime.registry()
    stage = registry.get("broker.sync")
    assert isinstance(stage, BrokerSyncStage)
    stage.profiles = ("invest",)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        real_client = Trading212Client

        def build_client(credentials, *, environment, sleep, rate_limiter):
            seen_limiters.append(rate_limiter)
            return real_client(
                credentials,
                environment=environment,
                http_client=http_client,
                sleep=sleep,
                monotonic=clock.monotonic,
                wall_clock=clock.wall_clock,
                jitter=lambda: 0.0,
                rate_limiter=rate_limiter,
            )

        monkeypatch.setattr("trading_max.application.broker_sync.Trading212Client", build_client)
        # Main lane hits a 120s account-wide 429 cooldown on cash_transactions.
        with pytest.raises(Exception, match="120 seconds"):
            stage.run(StageContext(job_id="main-sync", scope="accounts", trigger="reconciliation"))

        requests_before_live = list(requests)
        # Live lane runs on another thread against the same registry; it must
        # observe the shared cooldown immediately without issuing another HTTP call.
        live_error: list[Exception] = []

        def run_live() -> None:
            try:
                stage.run(StageContext(job_id="live-sync", scope="intraday", trigger="intraday"))
            except Exception as exc:
                live_error.append(exc)

        thread = threading.Thread(target=run_live)
        thread.start()
        thread.join(timeout=5)
        assert not thread.is_alive()

    assert len(seen_limiters) == 2
    assert seen_limiters[0] is seen_limiters[1]
    assert len(live_error) == 1
    assert isinstance(live_error[0].__cause__, Trading212HTTPError)
    assert "120 seconds" in str(live_error[0])
    # Live lane did not send a single extra request during the active cooldown.
    assert requests == requests_before_live


def test_concurrent_private_snapshot_writes_do_not_collide(tmp_path: Path) -> None:
    store = ManagedAccountStore("invest", data_root=tmp_path / "trading212")
    same_second = datetime(2026, 11, 23, 15, 0, 0, tzinfo=UTC)
    barrier = threading.Barrier(6)
    errors: list[Exception] = []

    def writer(index: int) -> None:
        try:
            barrier.wait(timeout=5)
            for iteration in range(15):
                payload = _raw_broker_snapshot(
                    fetched_at=same_second,
                    invested=str(100 + index + iteration),
                )
                store.write_snapshot(payload, intraday=index % 2 == 1)
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert errors == []
    assert all(not thread.is_alive() for thread in threads)
    paths = sorted(store.snapshots_dir.iterdir())
    assert [path.name for path in paths] == [
        "snapshot_20261123T150000Z.json",
        "snapshot_20261123T150000Z_live.json",
    ]
    for path in paths:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        assert loaded["fetched_at_utc"] == "2026-11-23T15:00:00Z"
    assert latest_snapshot_path("invest", data_root=tmp_path / "trading212") == paths[1]


def test_account_snapshot_stage_binds_to_its_own_job_broker_sync_artifact(tmp_path: Path) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    store = ManagedAccountStore("invest", data_root=tmp_path / "trading212")
    # Main lane synced a reconciled snapshot at 15:00 and emitted raw/trading212/invest.json.
    main_raw = _raw_broker_snapshot(
        fetched_at=datetime(2026, 11, 23, 15, 0, 0, tzinfo=UTC),
        invested="100",
    )
    store.write_snapshot(main_raw)
    from trading_max.ingestion.brokers.trading212 import snapshot_from_payload

    main_broker_ref = artifacts.put_json(
        key="raw/trading212/invest.json",
        payload=snapshot_from_payload("invest", "live", main_raw).model_dump(
            mode="json", by_alias=False
        ),
        kind="broker_snapshot",
        producer_version="broker-sync-v4",
    ).ref

    # Meanwhile the live lane writes a NEWER, UNRECONCILED snapshot on disk at 15:10.
    live_unreconciled = _raw_broker_snapshot(
        fetched_at=datetime(2026, 11, 23, 15, 10, 0, tzinfo=UTC),
        invested="115",
        position_value="95",
    )
    store.write_snapshot(live_unreconciled)
    live_broker_ref = artifacts.put_json(
        key="raw/trading212/invest.json",
        payload=live_unreconciled,
        kind="broker_snapshot",
        producer_version="broker-sync-v4",
    ).ref

    stage = AccountSnapshotStage(tmp_path, artifacts, profiles=(("A", "invest"),))

    # Main lane reads its own 15:00 reconciled artifact and is unaffected by the 15:10 disk write.
    main_result = stage.run(
        StageContext(
            job_id="main-job",
            scope="accounts",
            trigger="reconciliation",
            upstream_artifact_ids=(main_broker_ref.artifact_id,),
        )
    )
    main_refs = {ref.key: ref for ref in main_result.artifacts}
    main_account = artifacts.get_json(main_refs["account/invest.json"].artifact_id).payload
    assert main_account["fetched_at"].startswith("2026-11-23T15:00:00")
    assert main_account["total_value_gbp"] == "100"
    assert main_account["checks"]["positions_match_investments"] is True

    # Live lane reads its own 15:10 artifact (summary-authoritative, unreconciled positions).
    live_result = stage.run(
        StageContext(
            job_id="live-job",
            scope="intraday",
            trigger="intraday",
            upstream_artifact_ids=(live_broker_ref.artifact_id,),
        )
    )
    live_refs = {ref.key: ref for ref in live_result.artifacts}
    live_account = artifacts.get_json(live_refs["account/intraday/invest.json"].artifact_id).payload
    assert live_account["fetched_at"].startswith("2026-11-23T15:10:00")
    assert live_account["total_value_gbp"] == "115"
    assert live_account["positions_status"] == "unreconciled"


def test_publication_lock_reentrant_and_serializes_concurrent_disjoint_publishes(
    tmp_path: Path,
) -> None:
    store_a = SnapshotStore(tmp_path)
    store_b = SnapshotStore(tmp_path)
    seed = store_a.artifacts.put_json(key="seed.json", payload={"ok": True})
    # Reentrant lock on a single thread must not deadlock.
    with store_a.publication_lock(), store_a.publication_lock():
        store_a.publish(scope="accounts", source="seed", artifacts=[seed])

    main_art = store_a.artifacts.put_json(
        key="account/broker_snapshot_metrics.json", payload={"v": 1}
    )
    live_art = store_b.artifacts.put_json(
        key="account/intraday/broker_values.json", payload={"v": 2}
    )

    stage_a = TypedPublishSnapshotStage(store_a.artifacts, store_a)
    stage_b = TypedPublishSnapshotStage(store_b.artifacts, store_b)

    lock_acquired = threading.Event()
    allow_release = threading.Event()
    second_entered_wait = threading.Event()

    def run_a() -> None:
        with store_a.publication_lock():
            lock_acquired.set()
            assert allow_release.wait(timeout=5)
            stage_a.run(
                StageContext(
                    job_id="main",
                    scope="accounts",
                    trigger="reconciliation",
                    upstream_artifact_ids=(main_art.ref.artifact_id,),
                )
            )

    def run_b() -> None:
        assert lock_acquired.wait(timeout=5)
        second_entered_wait.set()
        stage_b.run(
            StageContext(
                job_id="live",
                scope="intraday",
                trigger="intraday",
                upstream_artifact_ids=(live_art.ref.artifact_id,),
            )
        )

    t1 = threading.Thread(target=run_a)
    t2 = threading.Thread(target=run_b)
    t1.start()
    t2.start()
    assert second_entered_wait.wait(timeout=5)
    allow_release.set()
    t1.join(timeout=5)
    t2.join(timeout=5)

    latest = store_a.latest()
    assert latest is not None
    keys = {ref.key for ref in latest.manifest.artifacts}
    assert {
        "seed.json",
        "account/broker_snapshot_metrics.json",
        "account/intraday/broker_values.json",
    } <= keys


@pytest.mark.parametrize("publish_order", ["live_first", "main_first"])
def test_concurrent_publish_merges_valuation_history_in_both_orders(
    tmp_path: Path, publish_order: str
) -> None:
    store = SnapshotStore(tmp_path)
    artifacts = store.artifacts
    t1500 = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)
    t1510 = datetime(2026, 11, 23, 15, 10, tzinfo=UTC)
    t1520 = datetime(2026, 11, 23, 15, 20, tzinfo=UTC)

    # Seed snapshot has 15:00 broker point + stale reconstructed point at 15:10.
    seed_series = IntradayAnchorSeries(
        generated_at=t1510,
        interval_seconds=600,
        retention_days=210,
        points=[
            IntradayAnchor(
                observed_at=t1500,
                bucket_at=t1500,
                invest_value_gbp=100,
                isa_value_gbp=200,
                total_value_gbp=300,
                source="broker",
            ),
            IntradayAnchor(
                observed_at=t1510,
                bucket_at=t1510,
                invest_value_gbp=99,
                isa_value_gbp=199,
                total_value_gbp=298,
                source="reconstructed",
            ),
        ],
    )
    seed_ref = artifacts.put_json(
        key="account/nav/valuation_history.json",
        payload=seed_series.model_dump(mode="json", by_alias=False),
        kind="intraday_nav",
    ).ref
    store.publish(scope="accounts", source="seed", artifacts=[seed_ref])

    # Live lane read seed_ref and added a 15:20 broker point.
    live_series = IntradayAnchorSeries(
        generated_at=t1520,
        interval_seconds=600,
        retention_days=210,
        points=[
            *seed_series.points,
            IntradayAnchor(
                observed_at=t1520,
                bucket_at=t1520,
                invest_value_gbp=118,
                isa_value_gbp=212,
                total_value_gbp=330,
                source="broker",
            ),
        ],
    )
    live_ref = artifacts.put_json(
        key="account/nav/valuation_history.json",
        payload=live_series.model_dump(mode="json", by_alias=False),
        kind="intraday_nav",
        dependency_artifact_ids=[seed_ref.artifact_id],
    ).ref

    # Main lane ALSO read seed_ref (before live published), replaced reconstructed
    # points (removing stale 15:10, adding model comparison on 15:00 and a fresh
    # reconstructed point at 14:50).
    t1450 = datetime(2026, 11, 23, 14, 50, tzinfo=UTC)
    main_series = IntradayAnchorSeries(
        generated_at=t1500,
        interval_seconds=600,
        retention_days=210,
        points=[
            IntradayAnchor(
                observed_at=t1450,
                bucket_at=t1450,
                invest_value_gbp=98,
                isa_value_gbp=197,
                total_value_gbp=295,
                source="reconstructed",
            ),
            IntradayAnchor(
                observed_at=t1500,
                bucket_at=t1500,
                invest_value_gbp=100,
                isa_value_gbp=200,
                total_value_gbp=300,
                source="broker",
                model_at=t1500,
                invest_model_value_gbp=100.5,
                isa_model_value_gbp=200.5,
            ),
        ],
    )
    main_ref = artifacts.put_json(
        key="account/nav/valuation_history.json",
        payload=main_series.model_dump(mode="json", by_alias=False),
        kind="intraday_nav",
        dependency_artifact_ids=[seed_ref.artifact_id],
    ).ref

    stage = TypedPublishSnapshotStage(artifacts, store)
    live_ctx = StageContext(
        job_id="live",
        scope="intraday",
        trigger="intraday",
        upstream_artifact_ids=(live_ref.artifact_id,),
    )
    main_ctx = StageContext(
        job_id="main",
        scope="accounts",
        trigger="reconciliation",
        upstream_artifact_ids=(main_ref.artifact_id,),
    )
    if publish_order == "live_first":
        stage.run(live_ctx)
        stage.run(main_ctx)
    else:
        stage.run(main_ctx)
        stage.run(live_ctx)

    latest = store.latest()
    assert latest is not None
    final_ref = next(
        ref for ref in latest.manifest.artifacts if ref.key == "account/nav/valuation_history.json"
    )
    final_series = IntradayAnchorSeries.model_validate(
        artifacts.get_json(final_ref.artifact_id).payload
    )
    by_bucket = {point.bucket_at: point for point in final_series.points}
    assert set(by_bucket) == {t1450, t1500, t1520}
    assert by_bucket[t1450].source == "reconstructed"
    assert by_bucket[t1500].source == "broker"
    assert by_bucket[t1500].invest_model_value_gbp == 100.5
    assert by_bucket[t1520].source == "broker"
    assert by_bucket[t1520].total_value_gbp == 330


def test_concurrent_publish_cash_flow_precedence_rules(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path)
    artifacts = store.artifacts
    stage = TypedPublishSnapshotStage(artifacts, store)
    t1450 = datetime(2026, 11, 23, 14, 50, tzinfo=UTC)
    t1500 = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)
    t1520 = datetime(2026, 11, 23, 15, 20, tzinfo=UTC)
    base_event = AccountCashFlow(
        occurred_at=datetime(2026, 11, 10, 9, tzinfo=UTC),
        accounting_date=date(2026, 11, 10),
        amount_gbp=90.0,
    )
    deposit_event = AccountCashFlow(
        occurred_at=datetime(2026, 11, 23, 14, 55, tzinfo=UTC),
        accounting_date=date(2026, 11, 23),
        amount_gbp=10.0,
    )

    def make_flows(
        *, digest: str, state: str, covered_until: datetime, events: list[AccountCashFlow], deps=()
    ):
        model = AccountCashFlowHistory(
            covered_from=datetime(2026, 11, 10, 9, tzinfo=UTC),
            covered_until=covered_until,
            verified=True,
            events=events,
            source_digest=digest,
            account_state_digest=state,
        )
        return artifacts.put_json(
            key="account/nav/cash_flows_a.json",
            payload=model.model_dump(mode="json", by_alias=False),
            kind="account_cash_flows",
            dependency_artifact_ids=list(deps),
        ).ref

    seed = make_flows(digest="ledger-1", state="state-1", covered_until=t1450, events=[base_event])
    store.publish(scope="accounts", source="seed", artifacts=[seed])

    # 1) Main reconciles new ledger-2; Live then publishes a stale extension on ledger-1.
    main_d2 = make_flows(
        digest="ledger-2",
        state="state-2",
        covered_until=t1500,
        events=[base_event, deposit_event],
    )
    live_stale_d1 = make_flows(
        digest="ledger-1",
        state="state-1",
        covered_until=t1520,
        events=[base_event],
        deps=(seed.artifact_id,),
    )
    stage.run(
        StageContext(
            job_id="main-d2",
            scope="accounts",
            trigger="reconciliation",
            upstream_artifact_ids=(main_d2.artifact_id,),
        )
    )
    stage.run(
        StageContext(
            job_id="live-stale",
            scope="intraday",
            trigger="intraday",
            upstream_artifact_ids=(live_stale_d1.artifact_id,),
        )
    )
    published = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in store.latest().manifest.artifacts
            if ref.key == "account/nav/cash_flows_a.json"
        )
    ).payload
    assert published["source_digest"] == "ledger-2"
    assert len(published["events"]) == 2

    # 2) Live extends ledger-2 mark-only to 15:20; Main finishes on identical ledger-2 at 15:00.
    live_mark_d2 = make_flows(
        digest="ledger-2",
        state="state-2",
        covered_until=t1520,
        events=[base_event, deposit_event],
        deps=(main_d2.artifact_id,),
    )
    stage.run(
        StageContext(
            job_id="live-mark",
            scope="intraday",
            trigger="intraday",
            upstream_artifact_ids=(live_mark_d2.artifact_id,),
        )
    )
    stage.run(
        StageContext(
            job_id="main-same-d2",
            scope="accounts",
            trigger="reconciliation",
            upstream_artifact_ids=(main_d2.artifact_id,),
        )
    )
    published = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in store.latest().manifest.artifacts
            if ref.key == "account/nav/cash_flows_a.json"
        )
    ).payload
    assert published["source_digest"] == "ledger-2"
    assert published["covered_until"] == "2026-11-23T15:20:00Z"

    # 3) Main reconciles a brand-new ledger-3 at 15:00 -> replaces Live's 15:20 ledger-2.
    main_d3 = make_flows(
        digest="ledger-3",
        state="state-3",
        covered_until=t1500,
        events=[base_event, deposit_event],
    )
    stage.run(
        StageContext(
            job_id="main-d3",
            scope="accounts",
            trigger="reconciliation",
            upstream_artifact_ids=(main_d3.artifact_id,),
        )
    )
    published = artifacts.get_json(
        next(
            ref.artifact_id
            for ref in store.latest().manifest.artifacts
            if ref.key == "account/nav/cash_flows_a.json"
        )
    ).payload
    assert published["source_digest"] == "ledger-3"
    assert published["covered_until"] == "2026-11-23T15:00:00Z"


def test_concurrent_publish_attribution_never_regresses_day_or_opening(tmp_path: Path) -> None:
    store = SnapshotStore(tmp_path)
    artifacts = store.artifacts
    stage = TypedPublishSnapshotStage(artifacts, store)
    day = date(2026, 11, 23)
    t0800 = datetime(2026, 11, 23, 8, 0, tzinfo=UTC)
    t0900 = datetime(2026, 11, 23, 9, 0, tzinfo=UTC)
    t1500 = datetime(2026, 11, 23, 15, 0, tzinfo=UTC)
    t1520 = datetime(2026, 11, 23, 15, 20, tzinfo=UTC)

    pos = [
        BaselinePosition(
            key="BE_US_EQ",
            isin="US0937121079",
            ticker="BE",
            name="Bloom Energy",
            quantity=Decimal("1"),
            value_gbp=Decimal("100"),
        )
    ]

    def put_attribution(
        *,
        opening_at: datetime,
        as_of: datetime,
        contrib: str,
        include_b: bool = True,
    ):
        baselines = {"A": AccountBaseline(captured_at=opening_at, positions=pos)}
        accounts = {
            "A": AccountDayAttribution(
                since=opening_at,
                as_of=as_of,
                contributions=[
                    PositionContribution(
                        ticker="BE",
                        name="Bloom Energy",
                        instrument="BE_US_EQ",
                        contribution_gbp=Decimal(contrib),
                    )
                ],
            )
        }
        if include_b:
            baselines["B"] = AccountBaseline(captured_at=opening_at, positions=pos)
            accounts["B"] = accounts["A"]
        day_base = DayBaseline(day=day, accounts=baselines)
        day_attr = DayAttribution(day=day, accounts=accounts)
        win_base = WindowBaselines(days=[day_base])
        win_attr = WindowAttribution(start_day=date(2026, 11, 17), day=day, accounts=accounts)
        return [
            artifacts.put_json(
                key="account/attribution/day_baseline.json",
                payload=day_base.model_dump(mode="json", by_alias=False),
            ).ref,
            artifacts.put_json(
                key="account/attribution/day.json",
                payload=day_attr.model_dump(mode="json", by_alias=False),
            ).ref,
            artifacts.put_json(
                key="account/attribution/window_baselines.json",
                payload=win_base.model_dump(mode="json", by_alias=False),
            ).ref,
            artifacts.put_json(
                key="account/attribution/window.json",
                payload=win_attr.model_dump(mode="json", by_alias=False),
            ).ref,
        ]

    live_refs = put_attribution(opening_at=t0800, as_of=t1520, contrib="18.00")
    stage.run(
        StageContext(
            job_id="live-1520",
            scope="intraday",
            trigger="intraday",
            upstream_artifact_ids=tuple(ref.artifact_id for ref in live_refs),
        )
    )
    stale_main_refs = put_attribution(opening_at=t0900, as_of=t1500, contrib="5.00")
    stage.run(
        StageContext(
            job_id="main-1500",
            scope="accounts",
            trigger="reconciliation",
            upstream_artifact_ids=tuple(ref.artifact_id for ref in stale_main_refs),
        )
    )

    by_key = {ref.key: ref for ref in store.latest().manifest.artifacts}
    day_base = artifacts.get_json(
        by_key["account/attribution/day_baseline.json"].artifact_id
    ).payload
    day_attr = artifacts.get_json(by_key["account/attribution/day.json"].artifact_id).payload
    win_attr = artifacts.get_json(by_key["account/attribution/window.json"].artifact_id).payload
    assert day_base["accounts"]["A"]["captured_at"] == "2026-11-23T08:00:00Z"
    assert day_attr["accounts"]["A"]["as_of"] == "2026-11-23T15:20:00Z"
    assert day_attr["accounts"]["A"]["contributions"][0]["contribution_gbp"] == "18.00"
    assert win_attr["accounts"]["A"]["as_of"] == "2026-11-23T15:20:00Z"


def test_twenty_minute_reconciliation_does_not_block_ten_minute_live_collection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Completion test: simulate a 20-minute export wait while live collects every 10-minute slot."""

    def daily_history(symbol: str, start: date, end: date) -> pd.DataFrame:
        close = 1.25 if symbol == "GBPUSD=X" else 125.0
        return pd.DataFrame({"Close": close}, index=pd.bdate_range(start, end))

    class _FakeIntradayLoader:
        def history(self, symbol: str, _start: datetime, _end: datetime) -> pd.DataFrame:
            idx = pd.date_range(
                "2026-11-23 14:40:00+00:00",
                "2026-11-23 15:20:00+00:00",
                freq="10min",
            )
            close = 1.25 if symbol == "GBPUSD=X" else 125.0
            frame = pd.DataFrame({"Close": close}, index=idx)
            frame.attrs["cadence_seconds"] = 600
            frame.attrs["price_cadence_seconds"] = 600
            return frame

    monkeypatch.setattr(
        "trading_max.application.runtime.AccountNavStage",
        partial(AccountNavStage, history_loader=daily_history),
    )
    monkeypatch.setattr(
        "trading_max.application.runtime.AccountDecisionStage",
        partial(AccountDecisionStage, history_loader=daily_history, events_loader=lambda _: []),
    )

    _seed_security_master(tmp_path)
    t1450 = datetime(2026, 11, 23, 14, 50, 0, tzinfo=UTC)
    t1500 = datetime(2026, 11, 23, 15, 0, 0, tzinfo=UTC)
    t1510 = datetime(2026, 11, 23, 15, 10, 0, tzinfo=UTC)
    t1520 = datetime(2026, 11, 23, 15, 20, 0, tzinfo=UTC)
    monkeypatch.setattr(
        BrokerSyncStage, "_window", staticmethod(lambda: (date(2025, 11, 23), t1500.date()))
    )
    monkeypatch.setenv("TRADING_MAX_BROKER_EXPORT_FLOOR", "2025-11-23")
    monkeypatch.setenv("T212_ENVIRONMENT", "live")

    # Seed initial state at 14:50 with verified export, daily NAV, cash flows, and 14:50 anchor.
    initial_csv = _export_csv(extra_deposit=False)
    for profile in ("invest", "isa"):
        account_store = ManagedAccountStore(profile, data_root=tmp_path / "trading212")
        initial_raw = _raw_broker_snapshot(
            fetched_at=t1450,
            invested="100" if profile == "invest" else "200",
            cash="0",
        )
        account_store.write_snapshot(initial_raw)
        account_store.write_cash_transactions(
            [
                {
                    "reference": f"init-{profile}",
                    "type": "DEPOSIT",
                    "amount": "90.00",
                    "currency": "GBP",
                    "dateTime": "2026-11-10T09:00:00Z",
                }
            ]
        )
        export_path = account_store.exports_dir / f"initial_{profile}.csv"
        export_path.write_text(initial_csv, encoding="utf-8")
        account_store.register_export(
            path=export_path,
            environment="live",
            report={
                "reportId": 1,
                "componentReportIds": [1],
                "status": "Finished",
                "timeFrom": "2026-11-01T00:00:00Z",
                "timeTo": "2026-11-23T14:50:00Z",
                "dataIncluded": "seed",
            },
            account_summary=initial_raw["account_summary"],
            reconciliation={"status": "verified", "coverage": "complete"},
        )

    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    snapshots = SnapshotStore(tmp_path, artifacts=artifacts)
    seed_refs = []
    for code, profile, val in (("a", "invest", 100), ("b", "isa", 200)):
        seed_refs.append(
            artifacts.put_bytes(
                key=f"account/nav/daily_nav_{code}.csv",
                content=(
                    b"Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
                    b"WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown,"
                    b"ValuationSource,ObservedAt,PerformanceStatus\n"
                    + f"2026-11-20,0,{val},{val},0,0,0,1,0,broker_native,2026-11-20T20:00:00Z,eligible\n".encode()
                ),
                kind="nav_series",
                media_type="text/csv",
                producer_version=AccountNavStage.version,
            ).ref
        )
        broker_root = tmp_path / "trading212"
        export_p = broker_root / profile / "exports" / f"initial_{profile}.csv"
        cash_p = broker_root / profile / "cash_transactions.json"
        seed_account = {
            "fetched_at": t1450.isoformat(),
            "cash_gbp": "0",
            "positions_status": "verified",
            "positions": [{"isin": "US0937121079", "ticker": "BE", "quantity": "1"}],
            "total_value_gbp": str(val),
        }
        seed_flows = AccountCashFlowHistory(
            covered_from=datetime(2026, 11, 10, 9, tzinfo=UTC),
            covered_until=t1450,
            verified=True,
            events=[
                AccountCashFlow(
                    occurred_at=datetime(2026, 11, 10, 9, tzinfo=UTC),
                    accounting_date=date(2026, 11, 10),
                    amount_gbp=90.0,
                )
            ],
            source_digest=ledger_digest((export_p, cash_p)),
            account_state_digest=account_state_digest(seed_account),
        )
        seed_refs.append(
            artifacts.put_json(
                key=f"account/nav/cash_flows_{code}.json",
                payload=seed_flows.model_dump(mode="json", by_alias=False),
                kind="account_cash_flows",
                producer_version=AccountNavStage.version,
            ).ref
        )
    seed_history = IntradayAnchorSeries(
        generated_at=t1450,
        interval_seconds=600,
        retention_days=210,
        points=[
            IntradayAnchor(
                observed_at=t1450,
                bucket_at=t1450,
                invest_value_gbp=100.0,
                isa_value_gbp=200.0,
                total_value_gbp=300.0,
                invest_cash_gbp=0.0,
                isa_cash_gbp=0.0,
                source="broker",
            )
        ],
    )
    seed_refs.append(
        artifacts.put_json(
            key="account/nav/valuation_history.json",
            payload=seed_history.model_dump(mode="json", by_alias=False),
            kind="intraday_nav",
            producer_version=AccountIntradayNavStage.version,
        ).ref
    )
    snapshots.publish(scope="accounts", source="seed", artifacts=seed_refs)

    # Synthetic clock and broker backend shared by BOTH lanes via one Trading212BrokerSync.
    clock = _ControlledClock(t1500)
    export_waiting = threading.Event()
    release_export = threading.Event()
    rate_limiters_by_profile: dict[str, set[int]] = {"invest": set(), "isa": set()}
    limiter_lock = threading.Lock()
    reconciled_csv = _export_csv(extra_deposit=True)

    # Values per timestamp so each 10-minute slot and the reconciliation are distinct.
    values_by_slot: dict[datetime, tuple[str, str, str]] = {
        t1500: ("105", "205", "10"),  # live 15:00 -> invest=115, isa=215, total=330
        t1510: ("112", "208", "10"),  # live 15:10 -> invest=122, isa=218, total=340
        t1520: ("118", "212", "10"),  # live 15:20 -> invest=128, isa=222, total=350
    }

    class _FakeBrokerClient:
        def __init__(
            self,
            profile: str,
            rate_limiter: Trading212RateLimiter,
        ) -> None:
            self.profile = profile
            self.rate_limiter = rate_limiter
            with limiter_lock:
                rate_limiters_by_profile[profile].add(id(rate_limiter))

        def __enter__(self) -> _FakeBrokerClient:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def _pace(self, endpoint: tuple[str, str]) -> None:
            wait = self.rate_limiter.reserve(endpoint, clock.monotonic(), 0.0)
            if wait > 0:
                clock.advance(seconds=wait)
                self.rate_limiter.reserve(endpoint, clock.monotonic(), 0.0)

        def snapshot(self, *, include_pending_orders: bool = False) -> dict:
            self._pace(("GET", "/equity/account/summary"))
            self._pace(("GET", "/equity/positions"))
            now = clock.now()
            bucket = datetime.fromtimestamp(
                int(now.timestamp()) - int(now.timestamp()) % 600, tz=UTC
            )
            inv_val, isa_val, cash_val = values_by_slot.get(bucket, ("100", "200", "10"))
            # Distinguish the main reconciliation's 15:00 snapshot (invested=100, cash=10 -> 110;
            # isa invested=200, cash=10 -> 210) from live 15:00 (105+10=115, 205+10=215).
            if threading.current_thread().name == "main-lane-thread":
                invested = "100" if self.profile == "invest" else "200"
            else:
                invested = inv_val if self.profile == "invest" else isa_val
            return _raw_broker_snapshot(
                fetched_at=now,
                invested=invested,
                cash=cash_val,
            )

        def cash_transactions(self, *, stop_references: frozenset[str] = frozenset()) -> list[dict]:
            self._pace(("GET", "/equity/history/transactions"))
            return [
                {
                    "reference": f"dep-2-{self.profile}",
                    "type": "DEPOSIT",
                    "amount": "10.00",
                    "currency": "GBP",
                    "dateTime": "2026-11-23T14:55:00Z",
                }
            ]

        def recent_cash_transactions(
            self, *, stop_references: frozenset[str]
        ) -> tuple[list[dict], bool]:
            self._pace(("GET", "/equity/history/transactions"))
            return (
                [
                    {
                        "reference": f"dep-2-{self.profile}",
                        "type": "DEPOSIT",
                        "amount": "10.00",
                        "currency": "GBP",
                        "dateTime": "2026-11-23T14:55:00Z",
                    }
                ],
                True,
            )

        def request_export(self, _time_from, _time_to) -> int:
            self._pace(("POST", "/equity/history/exports"))
            return 101 if self.profile == "invest" else 102

        def wait_for_export(self, report_id: int) -> dict:
            self._pace(("GET", "/equity/history/exports"))
            if self.profile == "invest":
                # Simulate the 20-minute Trading 212 export wait while live lane runs!
                export_waiting.set()
                assert release_export.wait(timeout=10), "timed out waiting for live slots"
            return {
                "reportId": report_id,
                "status": "Finished",
                "timeFrom": "2025-11-23T00:00:00Z",
                "timeTo": "2026-11-23T23:59:59Z",
                "downloadLink": f"https://synthetic.local/export/{report_id}.csv",
                "dataIncluded": "synthetic",
            }

        def download_export(self, _download_link: str, destination: Path) -> Path:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(reconciled_csv, encoding="utf-8")
            return destination

    sync = Trading212BrokerSync(
        credentials_factory=_credentials,
        store_factory=lambda profile: ManagedAccountStore(
            profile, data_root=tmp_path / "trading212"
        ),
        sleep=clock.sleep,
    )
    sync.client_factory = lambda credentials, environment: _FakeBrokerClient(
        credentials.profile,
        sync.rate_limiter(credentials.profile, environment),
    )

    runtime = TypedWorkerRuntime(
        tmp_path,
        broker_sync=sync,
        intraday_history_loader_factory=lambda: _FakeIntradayLoader(),
    )
    registry = runtime.registry()

    main_db = SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS)
    live_db = SqliteDatabase(tmp_path / "trading_max.db", migrations_dir=MIGRATIONS)
    main_queue = SqliteJobQueue(main_db)
    live_queue = SqliteJobQueue(live_db)

    main_worker = DurableWorker(
        main_queue,
        registry,
        worker_id="worker-prod",
        allowed_triggers=MAIN_LANE_TRIGGERS,
    )
    live_worker = DurableWorker(
        live_queue,
        registry,
        worker_id="worker-prod-live",
        allowed_triggers=LIVE_LANE_TRIGGERS,
    )

    reconciliation_stages = [
        (name, registry.get(name).version)
        for name in (
            "broker.sync",
            "accounts.snapshot",
            "reference.security_master",
            "portfolio.lookthrough",
            "accounts.diluted_cost",
            "accounts.policy",
            "accounts.capital_recovery",
            "accounts.nav",
            "accounts.intraday_nav",
            "accounts.day_attribution",
            "accounts.cfd",
            "accounts.performance",
            "accounts.review",
            "accounts.decisions",
            "snapshot.publish",
        )
    ]
    live_stages = [
        (name, registry.get(name).version)
        for name in (
            "broker.sync",
            "accounts.snapshot",
            "accounts.intraday_nav",
            "accounts.day_attribution",
            "snapshot.publish",
        )
    ]

    main_thread: threading.Thread | None = None
    try:
        # 1) Enqueue full reconciliation at 15:00 and run main lane in its own thread.
        reconciliation = main_queue.enqueue(
            "accounts",
            trigger="reconciliation",
            skip_sync=False,
            scheduled_for=t1500,
            stages=reconciliation_stages,
        )
        main_errors: list[Exception] = []

        def run_main_lane() -> None:
            try:
                assert main_worker.run_once() is True
            except Exception as exc:
                main_errors.append(exc)

        main_thread = threading.Thread(target=run_main_lane, name="main-lane-thread")
        main_thread.start()
        assert export_waiting.wait(timeout=10), "reconciliation never reached export wait"
        assert main_queue.get(reconciliation.job_id).status == JobStatus.RUNNING

        # 2) While reconciliation waits 20 simulated minutes for the export,
        #    run the 15:00, 15:10, and 15:20 live slots on the dedicated live lane!
        live_job_ids: list[str] = []
        for slot_time, expected_total in (
            (t1500, 330.0),
            (t1510, 340.0),
            (t1520, 350.0),
        ):
            delta = (slot_time + timedelta(seconds=5) - clock.now()).total_seconds()
            if delta > 0:
                clock.advance(seconds=delta)
            live_job = live_queue.enqueue(
                "live",
                trigger="live",
                skip_sync=False,
                scheduled_for=slot_time,
                stages=live_stages,
            )
            live_job_ids.append(live_job.job_id)
            assert live_worker.run_once() is True
            finished_live = live_queue.get(live_job.job_id)
            assert finished_live.status == JobStatus.SUCCEEDED, finished_live.error_message
            # Reconciliation is STILL waiting on the export while live already published!
            assert main_queue.get(reconciliation.job_id).status == JobStatus.RUNNING
            mid_latest = snapshots.latest()
            assert mid_latest is not None
            mid_history_ref = next(
                ref
                for ref in mid_latest.manifest.artifacts
                if ref.key == "account/nav/valuation_history.json"
            )
            mid_series = IntradayAnchorSeries.model_validate(
                artifacts.get_json(mid_history_ref.artifact_id).payload
            )
            mid_by_bucket = {p.bucket_at: p for p in mid_series.points if p.source == "broker"}
            assert slot_time in mid_by_bucket
            assert mid_by_bucket[slot_time].total_value_gbp == expected_total

        # 3) Release the 20-minute export wait and let reconciliation finish.
        release_export.set()
        main_thread.join(timeout=15)
        assert not main_thread.is_alive()
        assert main_errors == []

        reconciled_job = main_queue.get(reconciliation.job_id)
        assert reconciled_job.status == JobStatus.SUCCEEDED, reconciled_job.error_message
        assert all(live_queue.get(job_id).status == JobStatus.SUCCEEDED for job_id in live_job_ids)

        # 4) Verify both lanes shared the exact same Trading 212 rate limiter per profile.
        assert len(rate_limiters_by_profile["invest"]) == 1
        assert len(rate_limiters_by_profile["isa"]) == 1

        # 5) Verify the final published snapshot preserved BOTH every 10-minute live
        #    value point AND the complete reconciliation result without overwrites!
        final = snapshots.latest()
        assert final is not None
        by_key = {ref.key: ref for ref in final.manifest.artifacts}

        # Every 10-minute slot between 14:50 and 15:20 has its exact broker value point.
        final_history = IntradayAnchorSeries.model_validate(
            artifacts.get_json(by_key["account/nav/valuation_history.json"].artifact_id).payload
        )
        broker_points = {p.bucket_at: p for p in final_history.points if p.source == "broker"}
        assert set(broker_points) == {t1450, t1500, t1510, t1520}
        assert broker_points[t1450].total_value_gbp == 300.0
        assert broker_points[t1500].total_value_gbp == 330.0
        assert broker_points[t1510].total_value_gbp == 340.0
        assert broker_points[t1520].total_value_gbp == 350.0
        # Reconstructed comparison points from reconciliation are also retained!
        assert any(
            p.source == "reconstructed" or p.model_at is not None for p in final_history.points
        )

        # Live account totals (15:20) were NOT overwritten by reconciliation.
        live_values = artifacts.get_json(
            by_key["account/intraday/broker_values.json"].artifact_id
        ).payload
        assert Decimal(live_values["accounts"]["A"]["total_value_gbp"]) == Decimal("128")
        assert Decimal(live_values["accounts"]["B"]["total_value_gbp"]) == Decimal("222")
        assert live_values["accounts"]["A"]["fetched_at"].startswith("2026-11-23T15:20")
        raw_main = artifacts.get_json(by_key["raw/trading212/invest.json"].artifact_id).payload
        raw_live = artifacts.get_json(by_key["raw/trading212/live/invest.json"].artifact_id).payload
        assert raw_main["fetched_at"] == "2026-11-23T15:00:00Z"
        assert raw_live["fetched_at_utc"].startswith("2026-11-23T15:20")

        # Reconciliation canonical accounts, daily NAV, cash flows, and performance are present!
        canonical = artifacts.get_json(
            by_key["account/broker_snapshot_metrics.json"].artifact_id
        ).payload
        assert Decimal(canonical["accounts"]["A"]["total_value_gbp"]) == Decimal("110")
        assert Decimal(canonical["accounts"]["B"]["total_value_gbp"]) == Decimal("210")
        assert canonical["accounts"]["A"]["checks"]["positions_match_investments"] is True
        assert canonical["accounts"]["B"]["checks"]["positions_match_investments"] is True

        for code, profile in (("a", "invest"), ("b", "isa")):
            nav_path = artifacts.get_bytes(
                by_key[f"account/nav/daily_nav_{code}.csv"].artifact_id
            ).path
            with nav_path.open(encoding="utf-8") as handle:
                nav_rows = {row["Date"]: row for row in csv.DictReader(handle)}
            assert "2026-11-23" in nav_rows
            assert float(nav_rows["2026-11-23"]["ExternalFlowGBP"]) == 10.0

            flows = artifacts.get_json(
                by_key[f"account/nav/cash_flows_{code}.json"].artifact_id
            ).payload
            assert flows["verified"] is True
            assert len(flows["events"]) == 2
            assert any(event["amount_gbp"] == 10.0 for event in flows["events"])
            from trading_max.ingestion.brokers.trading212 import (
                latest_cash_transactions_path,
                latest_export_path,
            )

            expected_digest = ledger_digest(
                (
                    latest_export_path(profile, data_root=tmp_path / "trading212"),
                    latest_cash_transactions_path(profile, data_root=tmp_path / "trading212"),
                )
            )
            assert flows["source_digest"] == expected_digest

        assert "account/capital_recovery.json" in by_key
        assert "account/performance_a.json" in by_key
        assert "account/performance_b.json" in by_key
        assert "account/lookthrough_metrics.json" in by_key

        # Day attribution stayed at 15:20 and did not regress to 15:00.
        day_attr = artifacts.get_json(by_key["account/attribution/day.json"].artifact_id).payload
        assert day_attr["accounts"]["A"]["as_of"].startswith("2026-11-23T15:20")
    finally:
        release_export.set()
        if main_thread is not None:
            main_thread.join(timeout=15)
        main_worker.close()
        live_worker.close()
        main_db.close()
        live_db.close()


@pytest.mark.parametrize("publish_latest_first", [False, True])
def test_publication_recalculates_from_earliest_opening_and_latest_observation(
    tmp_path: Path, publish_latest_first: bool
) -> None:
    from trading_max.application.nav_stages import AccountDayAttributionStage

    snapshots = SnapshotStore(tmp_path)
    artifacts = snapshots.artifacts
    attribution = AccountDayAttributionStage(artifacts, snapshots)
    publish = TypedPublishSnapshotStage(artifacts, snapshots)

    def prepare(*, live: bool, fetched_at: str, value: str | None) -> StageContext:
        scope, trigger = ("intraday", "intraday") if live else ("accounts", "reconciliation")
        prefix = "account/intraday" if live else "account"
        account = artifacts.put_json(
            key=f"{prefix}/invest.json",
            payload={
                "fetched_at": fetched_at,
                "positions": [{"ticker": "BE", "quantity": "1", "current_value_gbp": value}]
                if value is not None
                else None,
            },
        ).ref
        selection = artifacts.put_json(
            key="account/selection.json", payload={"profiles": ["invest"]}
        ).ref
        context = StageContext(
            job_id=scope,
            scope=scope,
            trigger=trigger,
            upstream_artifact_ids=(selection.artifact_id, account.artifact_id),
        )
        result = attribution.run(context)
        return StageContext(
            job_id=scope,
            scope=scope,
            trigger=trigger,
            upstream_artifact_ids=(
                *context.upstream_artifact_ids,
                *(ref.artifact_id for ref in result.artifacts),
            ),
        )

    # Both stages see an empty manifest and use their own first observation as an opening.
    early = prepare(live=False, fetched_at="2026-11-23T15:00:00Z", value="100")
    latest = prepare(live=True, fetched_at="2026-11-23T15:20:00Z", value="118")
    summary = prepare(live=True, fetched_at="2026-11-23T15:10:00Z", value=None)
    for context in (latest, early) if publish_latest_first else (early, latest):
        publish.run(context)
    publish.run(summary)

    by_key = {ref.key: ref.artifact_id for ref in snapshots.latest().manifest.artifacts}
    opening = artifacts.get_json(by_key["account/attribution/day_baseline.json"]).payload[
        "accounts"
    ]["A"]
    assert opening["captured_at"] == "2026-11-23T15:00:00Z"
    for key in ("account/attribution/day.json", "account/attribution/window.json"):
        row = artifacts.get_json(by_key[key]).payload["accounts"]["A"]
        assert row["since"] == "2026-11-23T15:00:00Z"
        assert row["as_of"] == "2026-11-23T15:20:00Z"
        assert row["contributions"][0]["contribution_gbp"] == "18.00"
