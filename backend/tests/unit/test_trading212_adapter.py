import base64
import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from trading_max.analytics import (
    PerformancePoint,
    account_snapshot_metrics,
    calculate_diluted_cost,
    calculate_performance,
    metrics_from_snapshot_file,
)
from trading_max.application import BrokerSyncRequest, Trading212BrokerSync
from trading_max.ingestion.brokers.trading212 import (
    REQUIRED_EXPORT_COLUMNS,
    BrokerPosition,
    ManagedAccountStore,
    Trading212Client,
    Trading212Credentials,
    Trading212CredentialsError,
    Trading212Error,
    Trading212ExportError,
    broker_snapshot_reconciliation,
    default_data_root,
    export_window,
    inspect_export_csv,
    reconcile_csv_files,
    reconcile_positions,
    snapshot_from_payload,
)

CSV_HEADER = (
    "Action,Time (UTC),ISIN,Ticker,Name,ID,No. of shares,Price / share,"
    "Exchange rate,Total,Currency conversion fee\n"
)


def _position_payload(
    ticker: str = "AAA_US_EQ",
    isin: str = "US0000000001",
    value: str = "100.00",
) -> dict[str, object]:
    return {
        "instrument": {
            "ticker": ticker,
            "name": "Alpha",
            "isin": isin,
            "currency": "USD",
        },
        "quantity": "2",
        "currentPrice": "50",
        "walletImpact": {
            "currentValue": value,
            "totalCost": "90.00",
            "unrealizedProfitLoss": "10.00",
            "fxImpact": "-1.25",
        },
    }


def _snapshot_payload(position_value: str = "100.00") -> dict[str, object]:
    return {
        "fetched_at_utc": "2026-08-07T12:00:00Z",
        "account_summary": {
            "id": 123,
            "currency": "GBP",
            "totalValue": "110.00",
            "cash": {"availableToTrade": "10.00"},
            "investments": {
                "currentValue": "100.00",
                "totalCost": "90.00",
                "realizedProfitLoss": "5.00",
                "unrealizedProfitLoss": "10.00",
            },
        },
        "positions": [_position_payload(value=position_value)],
    }


def _credentials() -> Trading212Credentials:
    return Trading212Credentials(
        profile="invest",
        api_key="key",
        api_secret="secret",
    )


def test_snapshot_contract_uses_decimal_and_accepts_broker_rounding() -> None:
    payload = _snapshot_payload(position_value="99.98")

    snapshot = snapshot_from_payload("invest", "live", payload)

    assert snapshot.account.investments_value == Decimal("100")
    assert snapshot.positions[0].ticker == "AAA"
    assert snapshot.positions[0].current_value_gbp == Decimal("99.98")
    assert snapshot.fetched_at == datetime(2026, 8, 7, 12, tzinfo=UTC)


def test_snapshot_reconciliation_uses_relative_tolerance_for_large_accounts() -> None:
    payload = _snapshot_payload(position_value="4159.34")
    summary = payload["account_summary"]
    assert isinstance(summary, dict)
    summary["totalValue"] = "4570.00"
    summary["cash"] = {"availableToTrade": "410.51"}
    summary["investments"]["currentValue"] = "4159.49"  # type: ignore[index]
    position = payload["positions"][0]
    assert isinstance(position, dict)
    position["walletImpact"]["currentValue"] = "4159.34"  # type: ignore[index]

    snapshot = snapshot_from_payload("invest", "live", payload)

    assert snapshot.account.investments_value == Decimal("4159.49")
    assert snapshot.positions[0].current_value_gbp == Decimal("4159.34")


def test_snapshot_reconciliation_fails_loudly_for_material_mismatch() -> None:
    with pytest.raises(Trading212Error, match=r"position_delta_gbp=-4\.00"):
        snapshot_from_payload("invest", "live", _snapshot_payload("96.00"))


def test_snapshot_reconciliation_allows_summary_only_intraday_value() -> None:
    snapshot = snapshot_from_payload(
        "invest",
        "live",
        _snapshot_payload("96.00"),
        require_positions_match=False,
    )

    reconciliation = broker_snapshot_reconciliation(snapshot)

    assert snapshot.account.total_value == Decimal("110.00")
    assert reconciliation.positions_match_investments is False
    assert reconciliation.cash_plus_investments_matches_total is True


def test_snapshot_reconciliation_never_allows_invalid_account_total() -> None:
    payload = _snapshot_payload()
    summary = payload["account_summary"]
    assert isinstance(summary, dict)
    summary["totalValue"] = "999.00"

    with pytest.raises(
        Trading212Error,
        match=r"cash_plus_investments_matches_total.*False",
    ):
        snapshot_from_payload(
            "invest",
            "live",
            payload,
            require_positions_match=False,
        )


def test_reconciliation_deduplicates_export_rows_and_uses_isin_identity() -> None:
    rows = [
        {
            "Action": "Market buy",
            "Time (UTC)": "2026-08-01 10:00:00",
            "ISIN": "US0000000001",
            "Ticker": "AAA",
            "ID": "buy-1",
            "No. of shares": "2",
            "Total": "20",
        },
        {
            "Action": "Market sell",
            "Time (UTC)": "2026-08-02 10:00:00",
            "ISIN": "US0000000001",
            "Ticker": "AAA",
            "ID": "sell-1",
            "No. of shares": "0.5",
            "Total": "6",
        },
        # Same export row appears in overlapping downloaded windows.
        {
            "Action": "Market buy",
            "Time (UTC)": "2026-08-01 10:00:00",
            "ISIN": "US0000000001",
            "Ticker": "AAA",
            "ID": "buy-1",
            "No. of shares": "2",
            "Total": "20",
        },
    ]
    result = reconcile_positions(
        rows,
        [
            BrokerPosition(
                ticker="AAA",
                broker_ticker="AAA_US_EQ",
                isin="US0000000001",
                quantity="1.5",
                current_price="10",
                current_value_gbp="15",
                total_cost_gbp="15",
                unrealized_profit_loss_gbp="0",
            )
        ],
    )

    assert result.status == "verified"
    assert result.ledger_instruments == 1
    assert result.api_instruments == 1
    assert result.differences == []


def test_reconciliation_conflicting_duplicate_id_is_rejected() -> None:
    row = {
        "Action": "Market buy",
        "Time (UTC)": "2026-08-01 10:00:00",
        "ISIN": "US0000000001",
        "Ticker": "AAA",
        "ID": "buy-1",
        "No. of shares": "2",
        "Total": "20",
    }
    conflicting = {**row, "No. of shares": "3"}

    with pytest.raises(Trading212Error, match="conflicting transaction"):
        reconcile_positions([row, conflicting], [])


def test_reconciliation_never_calls_incomplete_coverage_verified() -> None:
    result = reconcile_positions(
        [
            {
                "Action": "Market buy",
                "Time (UTC)": "2026-08-01 10:00:00",
                "ISIN": "US0000000001",
                "Ticker": "AAA",
                "ID": "buy-1",
                "No. of shares": "2",
                "Total": "20",
            }
        ],
        [],
        coverage="incomplete",
        coverage_note="opening balance has not been imported",
    )

    assert result.status == "unverified"
    assert result.coverage == "incomplete"
    assert "opening balance" in result.note


def test_reconciliation_marks_unsupported_corporate_action_unverified() -> None:
    result = reconcile_positions(
        [],
        [],
        coverage="unsupported_corporate_action",
    )

    assert result.status == "unverified"
    assert result.coverage == "unsupported_corporate_action"


def test_csv_reconciliation_reads_multiple_exports(tmp_path: Path) -> None:
    first = tmp_path / "first.csv"
    second = tmp_path / "second.csv"
    first.write_text(
        CSV_HEADER + "Market buy,2026-08-01 10:00:00,US0000000001,AAA,Alpha,buy-1,2,10,1,20,0\n",
        encoding="utf-8",
    )
    second.write_text(
        CSV_HEADER + "Market sell,2026-08-02 10:00:00,US0000000001,AAA,Alpha,sell-1,0.5,12,1,6,0\n",
        encoding="utf-8",
    )

    result = reconcile_csv_files(
        [first, second],
        [
            {
                "quantity": "1.5",
                "instrument": {"isin": "US0000000001", "ticker": "AAA_US_EQ"},
            }
        ],
    )

    assert result.status == "verified"


def test_position_reconciliation_accepts_closed_pre_window_opening_balance() -> None:
    result = reconcile_positions(
        [
            {
                "Action": "Market sell",
                "Time (UTC)": "2026-08-01 10:00:00",
                "ISIN": "US0000000001",
                "Ticker": "OLD",
                "ID": "sell-1",
                "No. of shares": "2",
            }
        ],
        [],
    )

    assert result.status == "verified"
    assert result.differences == []


def test_position_reconciliation_still_rejects_unmatched_live_position() -> None:
    result = reconcile_positions(
        [],
        [
            {
                "quantity": "2",
                "instrument": {"isin": "US0000000001", "ticker": "LIVE_US_EQ"},
            }
        ],
    )

    assert result.status == "mismatch"
    assert result.differences[0].instrument == "LIVE_US_EQ"


def test_client_blocks_order_methods_before_network_request() -> None:
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Trading212Client(_credentials(), http_client=http_client)
    with pytest.raises(Trading212Error, match="blocked non-read-only"):
        client._request_json(
            "POST",
            "/equity/orders/market",
            json_body={"ticker": "AAA_US_EQ", "quantity": 1},
        )
    assert calls == 0
    http_client.close()


def test_client_recovers_from_headerless_rate_limit_with_documented_backoff() -> None:
    calls = 0
    delays: list[float] = []

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls < 3:
            return httpx.Response(
                429,
                json={
                    "code": "BusinessException",
                    "context": {"type": "TooManyRequests"},
                },
            )
        return httpx.Response(200, json={"currency": "GBP"})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Trading212Client(
        _credentials(),
        http_client=http_client,
        sleep=delays.append,
    )

    assert client.account_summary()["currency"] == "GBP"
    assert calls == 3
    assert delays == [5.0, 10.0]
    http_client.close()


def test_client_honours_rate_limit_reset_header() -> None:
    calls = 0
    delays: list[float] = []

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                429,
                headers={"x-ratelimit-reset": "12"},
                json={"code": "BusinessException"},
            )
        return httpx.Response(200, json={"currency": "GBP"})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Trading212Client(
        _credentials(),
        http_client=http_client,
        sleep=delays.append,
    )

    assert client.account_summary()["currency"] == "GBP"
    assert delays == [12.0]
    http_client.close()


def test_cash_transactions_follow_query_only_cursor_and_stop_at_overlap() -> None:
    requests: list[str] = []
    delays: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if len(requests) == 1:
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "reference": "new",
                            "type": "TRANSFER",
                            "amount": -10,
                            "currency": "GBP",
                            "dateTime": "2026-01-02T10:00:00Z",
                        }
                    ],
                    "nextPagePath": "limit=50&cursor=older&time=2026-01-02T10:00:00Z",
                },
            )
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "reference": "known",
                        "type": "DEPOSIT",
                        "amount": 100,
                        "currency": "GBP",
                        "dateTime": "2025-01-02T10:00:00Z",
                    }
                ],
                "nextPagePath": "ignored",
            },
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Trading212Client(
        _credentials(),
        http_client=http_client,
        sleep=delays.append,
    )

    items = client.cash_transactions(stop_references=frozenset({"known"}))

    assert [item["reference"] for item in items] == ["new"]
    assert "cursor=older" in requests[1]
    assert delays == [10.1]
    http_client.close()


def test_cash_transactions_fail_on_repeated_pagination_cursor() -> None:
    next_page = "limit=50&cursor=repeated"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"items": [], "nextPagePath": next_page},
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Trading212Client(
        _credentials(),
        http_client=http_client,
        sleep=lambda _seconds: None,
    )

    with pytest.raises(Trading212Error, match="repeated a cursor"):
        client.cash_transactions()

    http_client.close()


def test_export_creation_retries_only_an_explicit_rate_limit() -> None:
    calls = 0
    delays: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.method == "POST"
        if calls == 1:
            return httpx.Response(
                429,
                json={
                    "code": "BusinessException",
                    "context": {"type": "TooManyRequests"},
                },
            )
        return httpx.Response(200, json={"reportId": 123})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Trading212Client(
        _credentials(),
        http_client=http_client,
        sleep=delays.append,
    )

    report_id = client.request_export(
        datetime(2025, 1, 1, tzinfo=UTC),
        datetime(2026, 8, 8, tzinfo=UTC),
    )

    assert report_id == 123
    assert calls == 2
    assert delays == [5.0]
    http_client.close()


def test_client_uses_basic_auth_for_api_reads_and_no_auth_for_signed_download(
    tmp_path: Path,
) -> None:
    requests: list[httpx.Request] = []
    expected_auth = "Basic " + base64.b64encode(b"key:secret").decode()

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/api/v0/equity/account/summary":
            assert request.headers.get("authorization") == expected_auth
            return httpx.Response(
                200,
                json={
                    "currency": "GBP",
                    "totalValue": "110",
                    "cash": {"availableToTrade": "10"},
                    "investments": {"currentValue": "100"},
                },
            )
        if request.url.host == "download.example":
            assert request.headers.get("authorization") is None
            return httpx.Response(200, content=(CSV_HEADER + "\n").encode())
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = Trading212Client(_credentials(), http_client=http_client)
    assert client.account_summary()["currency"] == "GBP"
    destination = tmp_path / "report.csv"
    client.download_export("https://download.example/report.csv", destination)
    assert destination.exists()
    assert len(requests) == 2
    http_client.close()


def test_client_normalizes_empty_finished_export_to_typed_zero_row_csv(
    tmp_path: Path,
) -> None:
    http_client = httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=b""))
    )
    client = Trading212Client(_credentials(), http_client=http_client)
    destination = tmp_path / "empty.csv"

    client.download_export("https://download.example/empty.csv", destination)

    metadata = inspect_export_csv(destination)
    assert metadata["row_count"] == 0
    assert set(metadata["columns"]) == REQUIRED_EXPORT_COLUMNS
    http_client.close()


def test_keychain_credentials_are_loaded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("T212_INVEST_API_KEY", "")
    monkeypatch.setenv("T212_INVEST_API_SECRET", "")
    with patch(
        "trading_max.ingestion.brokers.trading212._keychain_credentials",
        return_value=("keychain-key", "keychain-secret"),
    ):
        credentials = Trading212Credentials.from_sources("invest")
    assert credentials.api_key == "keychain-key"
    assert credentials.api_secret == "keychain-secret"


def test_isolated_installation_never_falls_back_to_global_keychain(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    isolated = "com.engram.trading-max.credentials.install-b"
    monkeypatch.setenv("TRADING_MAX_CREDENTIAL_SERVICE", isolated)

    from trading_max.ingestion.brokers.trading212 import _keychain_locations

    assert _keychain_locations("invest") == ((isolated, "trading212:invest"),)


def test_isolated_installation_ignores_ambient_environment_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "TRADING_MAX_CREDENTIAL_SERVICE",
        "com.engram.trading-max.credentials.install-b",
    )
    monkeypatch.setenv("T212_INVEST_API_KEY", "account-a-key")
    monkeypatch.setenv("T212_INVEST_API_SECRET", "account-a-secret")
    with (
        patch(
            "trading_max.ingestion.brokers.trading212._keychain_credentials",
            return_value=None,
        ),
        pytest.raises(Trading212CredentialsError, match="missing credentials"),
    ):
        Trading212Credentials.from_sources("invest")


def test_default_installation_preserves_legacy_lookup_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TRADING_MAX_CREDENTIAL_SERVICE", raising=False)

    from trading_max.ingestion.brokers.trading212 import _keychain_locations

    assert _keychain_locations("invest") == (
        ("com.engram.trading-max.credentials", "trading212:invest"),
        ("com.engram.trading-max.trading212", "invest"),
        ("portfolio-research-trading212-api", "invest"),
    )


def test_default_data_root_uses_trading_max_namespace(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delenv("T212_DATA_DIR", raising=False)
    with patch(
        "trading_max.ingestion.brokers.trading212.Path.home",
        return_value=tmp_path,
    ):
        assert default_data_root() == (tmp_path / ".local" / "share" / "trading-max" / "trading212")


def test_managed_store_restricts_manifest_to_data_root(tmp_path: Path) -> None:
    store = ManagedAccountStore("invest", data_root=tmp_path)
    outside = tmp_path.parent / "outside.csv"
    outside.write_text(CSV_HEADER + "\n", encoding="utf-8")

    with pytest.raises(Trading212ExportError, match="below T212_DATA_DIR"):
        store.register_export(
            path=outside,
            environment="live",
            report={},
            account_summary={},
            reconciliation={"status": "unverified"},
        )


def test_managed_store_deduplicates_cash_transactions(tmp_path: Path) -> None:
    store = ManagedAccountStore("invest", data_root=tmp_path)
    store.write_cash_transactions(
        [
            {"reference": "same", "dateTime": "2026-01-01", "amount": 1},
            {"reference": "same", "dateTime": "2026-01-02", "amount": 2},
        ]
    )

    assert store.read_cash_transactions() == [
        {"reference": "same", "dateTime": "2026-01-02", "amount": 2}
    ]


def test_export_window_does_not_create_future_end_timestamp() -> None:
    start, end = export_window(
        date(2026, 8, 1),
        date(2026, 8, 7),
        now=datetime(2026, 8, 7, 12, 30, tzinfo=UTC),
    )
    assert start == datetime(2026, 8, 1, tzinfo=UTC)
    assert end == datetime(2026, 8, 7, 12, 30, tzinfo=UTC)


class _FakeClient:
    def __init__(self, payload: dict[str, object], *, mismatch: bool = False) -> None:
        self.payload = payload
        self.mismatch = mismatch
        self.requested_export = False

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def snapshot(self, *, include_pending_orders: bool = False) -> dict[str, object]:
        return self.payload

    def request_export(self, time_from, time_to) -> int:
        self.requested_export = True
        return 7

    def wait_for_export(self, report_id: int) -> dict[str, object]:
        return {"reportId": report_id, "status": "Finished", "downloadLink": "fake"}

    def download_export(self, download_link: str, destination: Path) -> Path:
        shares = "1" if self.mismatch else "2"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            CSV_HEADER
            + f"Market buy,2026-08-01 10:00:00,US0000000001,AAA,Alpha,buy-1,{shares},10,1,20,0\n",
            encoding="utf-8",
        )
        return destination


class _SequenceSnapshotClient(_FakeClient):
    def __init__(self, payloads: list[dict[str, object]]) -> None:
        super().__init__(payloads[-1])
        self.payloads = payloads
        self.snapshot_calls = 0

    def snapshot(self, *, include_pending_orders: bool = False) -> dict[str, object]:
        payload = self.payloads[min(self.snapshot_calls, len(self.payloads) - 1)]
        self.snapshot_calls += 1
        return payload


class _MutableWindowClient(_FakeClient):
    def __init__(
        self,
        payload: dict[str, object],
        *,
        report_id: int,
        rows: list[str],
    ) -> None:
        super().__init__(payload)
        self.report_id = report_id
        self.rows = rows

    def request_export(self, time_from, time_to) -> int:
        self.requested_export = True
        return self.report_id

    def download_export(self, download_link: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(CSV_HEADER + "".join(self.rows), encoding="utf-8")
        return destination


def test_broker_sync_use_case_persists_only_verified_export(
    tmp_path: Path,
) -> None:
    fake = _FakeClient(_snapshot_payload())
    service = Trading212BrokerSync(
        credentials_factory=lambda _: _credentials(),
        client_factory=lambda _credentials, _environment: fake,
        store_factory=lambda profile: ManagedAccountStore(profile, data_root=tmp_path),
    )
    today = datetime.now(UTC).date()
    result = service.sync(
        BrokerSyncRequest(
            profile="invest",
            export_start=today,
            export_end=today,
            history_floor=today,
        )
    )

    assert result.reconciliation.status == "verified"
    assert fake.requested_export is True
    assert Path(result.snapshot_path).is_file()
    assert Path(result.export_path).is_file()
    assert (tmp_path / "invest" / "latest_export.json").is_file()


def test_broker_sync_refreshes_mutable_current_day_export(tmp_path: Path) -> None:
    today = datetime.now(UTC).date()
    first = _MutableWindowClient(
        _snapshot_payload(),
        report_id=7,
        rows=["Market buy,2026-08-01 10:00:00,US0000000001,AAA,Alpha,buy-1,2,10,1,20,0\n"],
    )
    store = ManagedAccountStore("invest", data_root=tmp_path)
    first_service = Trading212BrokerSync(
        credentials_factory=lambda _: _credentials(),
        client_factory=lambda _credentials, _environment: first,
        store_factory=lambda _profile: store,
    )
    request = BrokerSyncRequest(
        profile="invest",
        export_start=today,
        export_end=today,
        history_floor=today,
    )
    first_service.sync(request)

    time_from, time_to = export_window(today, today)
    store.save_pending(
        report_id=7,
        environment="live",
        time_from=time_from,
        time_to=time_to,
    )
    changed_payload = _snapshot_payload()
    changed_position = changed_payload["positions"][0]
    assert isinstance(changed_position, dict)
    changed_position["quantity"] = "3"
    second = _MutableWindowClient(
        changed_payload,
        report_id=8,
        rows=[
            "Market buy,2026-08-01 10:00:00,US0000000001,AAA,Alpha,buy-1,2,10,1,20,0\n",
            "Market buy,2026-08-27 14:00:00,US0000000001,AAA,Alpha,buy-2,1,10,1,10,0\n",
        ],
    )
    second_service = Trading212BrokerSync(
        credentials_factory=lambda _: _credentials(),
        client_factory=lambda _credentials, _environment: second,
        store_factory=lambda _profile: store,
    )

    result = second_service.sync(request)

    assert result.reconciliation.status == "verified"
    assert second.requested_export is True
    assert not store.pending_path.exists()
    manifest = json.loads(store.manifest_path.read_text(encoding="utf-8"))
    assert manifest["report"]["component_report_ids"] == [7, 8]


def test_broker_snapshot_only_does_not_start_history_export(tmp_path: Path) -> None:
    fake = _FakeClient(_snapshot_payload())
    service = Trading212BrokerSync(
        credentials_factory=lambda _: _credentials(),
        client_factory=lambda _credentials, _environment: fake,
        store_factory=lambda profile: ManagedAccountStore(profile, data_root=tmp_path),
    )

    payload = service.snapshot_only("invest")

    assert "account_summary" in payload
    assert fake.requested_export is False
    assert list((tmp_path / "invest" / "snapshots").glob("snapshot_*.json"))


def test_broker_snapshot_only_retries_then_persists_summary_only_value(
    tmp_path: Path,
) -> None:
    fake = _SequenceSnapshotClient(
        [_snapshot_payload(position_value="96.00"), _snapshot_payload(position_value="96.00")]
    )
    delays: list[float] = []
    service = Trading212BrokerSync(
        credentials_factory=lambda _: _credentials(),
        client_factory=lambda _credentials, _environment: fake,
        store_factory=lambda profile: ManagedAccountStore(profile, data_root=tmp_path),
        sleep=delays.append,
    )

    payload = service.snapshot_only(
        "invest",
        allow_unreconciled_positions=True,
        reconciliation_attempts=2,
    )

    assert payload["account_summary"]["totalValue"] == "110.00"  # type: ignore[index]
    assert fake.snapshot_calls == 2
    assert delays == [5.0]
    assert list((tmp_path / "invest" / "snapshots").glob("snapshot_*.json"))


def test_broker_snapshot_only_remains_strict_by_default(tmp_path: Path) -> None:
    fake = _FakeClient(_snapshot_payload(position_value="96.00"))
    service = Trading212BrokerSync(
        credentials_factory=lambda _: _credentials(),
        client_factory=lambda _credentials, _environment: fake,
        store_factory=lambda profile: ManagedAccountStore(profile, data_root=tmp_path),
    )

    with pytest.raises(Trading212Error, match=r"positions_match_investments.*False"):
        service.snapshot_only("invest")

    assert not list((tmp_path / "invest" / "snapshots").glob("snapshot_*.json"))


def test_broker_sync_strict_mode_does_not_register_mismatch(
    tmp_path: Path,
) -> None:
    fake = _FakeClient(_snapshot_payload(), mismatch=True)
    service = Trading212BrokerSync(
        credentials_factory=lambda _: _credentials(),
        client_factory=lambda _credentials, _environment: fake,
        store_factory=lambda profile: ManagedAccountStore(profile, data_root=tmp_path),
    )
    today = datetime.now(UTC).date()

    with pytest.raises(Trading212Error, match="strict broker reconciliation failed"):
        service.sync(
            BrokerSyncRequest(
                profile="invest",
                export_start=today,
                export_end=today,
                history_floor=today,
            )
        )

    assert not (tmp_path / "invest" / "latest_export.json").exists()
    assert not list((tmp_path / "invest" / "snapshots").glob("snapshot_*.json"))


class _BackfillClient(_FakeClient):
    def __init__(self, payload: dict[str, object]) -> None:
        super().__init__(payload)
        self.requested_windows: list[tuple[datetime, datetime]] = []
        self._report_id = 20

    def request_export(self, time_from, time_to) -> int:
        self.requested_windows.append((time_from, time_to))
        self._report_id += 1
        return self._report_id

    def download_export(self, download_link: str, destination: Path) -> Path:
        row_id = f"buy-{len(self.requested_windows)}"
        timestamp = "2025-09-01" if "from_2025" in destination.name else "2024-09-01"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            CSV_HEADER
            + f"Market buy,{timestamp} 10:00:00,US0000000001,AAA,Alpha,"
            + f"{row_id},1,10,1,10,0\n",
            encoding="utf-8",
        )
        return destination


class _CompleteHistoryClient(_BackfillClient):
    def download_export(self, download_link: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if len(self.requested_windows) == 1:
            destination.write_text(
                CSV_HEADER + "Market buy,2025-09-01 10:00:00,US0000000001,AAA,Alpha,"
                "buy-current,2,10,1,20,0\n",
                encoding="utf-8",
            )
        else:
            destination.write_text(CSV_HEADER, encoding="utf-8")
        return destination


def test_broker_sync_complete_history_crosses_inception_even_after_reconciliation(
    tmp_path: Path,
) -> None:
    fake = _CompleteHistoryClient(_snapshot_payload())
    service = Trading212BrokerSync(
        credentials_factory=lambda _: _credentials(),
        client_factory=lambda _credentials, _environment: fake,
        store_factory=lambda profile: ManagedAccountStore(profile, data_root=tmp_path),
    )

    result = service.sync(
        BrokerSyncRequest(
            profile="invest",
            export_start=date(2025, 8, 7),
            export_end=date(2026, 8, 7),
            history_floor=date(2020, 1, 1),
        )
    )

    assert result.reconciliation.status == "verified"
    assert len(fake.requested_windows) == 2
    manifest = json.loads((tmp_path / "invest" / "latest_export.json").read_text())
    assert manifest["report"]["time_from"].startswith("2024-08-07")
    assert manifest["csv"]["row_count"] == 1


def test_broker_sync_backfills_yearly_exports_until_positions_reconcile(
    tmp_path: Path,
) -> None:
    fake = _BackfillClient(_snapshot_payload())
    service = Trading212BrokerSync(
        credentials_factory=lambda _: _credentials(),
        client_factory=lambda _credentials, _environment: fake,
        store_factory=lambda profile: ManagedAccountStore(profile, data_root=tmp_path),
    )

    result = service.sync(
        BrokerSyncRequest(
            profile="invest",
            export_start=date(2025, 8, 7),
            export_end=date(2026, 8, 7),
            history_floor=date(2024, 8, 8),
        )
    )

    assert result.reconciliation.status == "verified"
    assert len(fake.requested_windows) == 2
    assert Path(result.export_path).name.endswith("_consolidated.csv")
    assert Path(result.export_path).read_text(encoding="utf-8").count("Market buy") == 2
    manifest = json.loads((tmp_path / "invest" / "latest_export.json").read_text())
    assert manifest["report"]["time_from"].startswith("2024-08-08")
    assert manifest["report"]["component_report_ids"] == [21, 22]


def test_account_analytics_contract_preserves_explicit_gbp_fields(
    tmp_path: Path,
) -> None:
    snapshot_path = tmp_path / "snapshot.json"
    snapshot_path.write_text(
        json.dumps(_snapshot_payload(position_value="99.98")),
        encoding="utf-8",
    )

    metrics = metrics_from_snapshot_file("invest", snapshot_path)

    assert metrics.source == str(snapshot_path)
    assert metrics.total_value_gbp == Decimal("110.00")
    assert metrics.position_value_gbp == Decimal("99.98")
    assert metrics.positions[0].ticker == "AAA"
    assert metrics.positions[0].price_currency == "USD"


def test_account_analytics_accepts_normalized_broker_snapshot() -> None:
    normalized = snapshot_from_payload("invest", "live", _snapshot_payload())

    metrics = account_snapshot_metrics("invest", normalized)

    assert metrics.checks == {
        "positions_match_investments": True,
        "cash_plus_investments_matches_total": True,
    }


def test_typed_diluted_cost_preserves_negative_cost_semantics() -> None:
    metrics = calculate_diluted_cost(
        {
            "gross_buy_cash": "100.00",
            "buy_fees": "2.00",
            "gross_sell_cash": "80.00",
            "sell_fees": "1.00",
            "distributions": "25.00",
        },
        "2",
    )

    assert metrics.diluted_cost_gbp == Decimal("-2.00")
    assert metrics.diluted_cost_per_share_gbp == Decimal("-1.00")
    assert metrics.net_buy_cash_out_gbp == Decimal("102.00")
    assert metrics.recovered_cash_gbp == Decimal("104.00")


def test_performance_excludes_external_cash_from_twr() -> None:
    points = [
        PerformancePoint(as_of=datetime(2026, 1, 1, tzinfo=UTC), value=100),
        PerformancePoint(
            as_of=datetime(2026, 1, 2, tzinfo=UTC),
            value=165,
            external_flow=50,
        ),
        PerformancePoint(as_of=datetime(2026, 1, 3, tzinfo=UTC), value=181.5),
    ]

    metrics = calculate_performance(points, periods_per_year=2)

    assert metrics.twr == pytest.approx(0.21)
    assert metrics.max_drawdown == pytest.approx(0.0)


def test_performance_keeps_a_single_baseline_unavailable() -> None:
    metrics = calculate_performance(
        [PerformancePoint(as_of=datetime(2026, 1, 1, tzinfo=UTC), value=100)]
    )

    assert metrics.periods == 0
    assert metrics.twr is None
    assert metrics.max_drawdown is None
    assert metrics.current_drawdown is None


def test_performance_drawdown_and_information_ratio_use_matching_intervals() -> None:
    points = [
        PerformancePoint(as_of=datetime(2026, 1, 1, tzinfo=UTC), value=100),
        PerformancePoint(as_of=datetime(2026, 1, 2, tzinfo=UTC), value=110),
        PerformancePoint(as_of=datetime(2026, 1, 3, tzinfo=UTC), value=105),
    ]

    metrics = calculate_performance(
        points,
        periods_per_year=2,
        benchmark_returns=[0.05, 0.0],
    )

    assert metrics.max_drawdown == pytest.approx(-5 / 110)
    assert metrics.current_drawdown == pytest.approx(-5 / 110)
    assert metrics.information_ratio is not None
    with pytest.raises(ValueError, match="must match"):
        calculate_performance(points, benchmark_returns=[0.05])
