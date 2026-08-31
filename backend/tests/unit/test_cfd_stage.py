from __future__ import annotations

import csv
import io
from pathlib import Path

from trading_max.application.cfd_stages import CfdAccountStage
from trading_max.application.runtime import TypedWorkerRuntime
from trading_max.application.stages import StageContext
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore
from trading_max.ingestion.cfd_imports import CfdImportStore

HEADERS = [
    "Record Type",
    "Date (UTC)",
    "Account currency",
    "Instrument",
    "Symbol",
    "Instrument currency",
    "Direction",
    "Units",
    "Position ID",
    "Order ID",
    "Date opened (UTC)",
    "Date closed (UTC)",
    "Average price (instrument currency)",
    "Exchange rate",
    "Result (account currency)",
    "FX fee (account currency)",
    "Result after FX fee (account currency)",
    "Overnight interest (account currency)",
    "Dividend adjustment (account currency)",
    "Total result (account currency)",
    "Transaction ID",
    "Transaction type",
    "Amount (account currency)",
    "Info",
]


def _stage_csv(*, transfer_amount: str = "50") -> bytes:
    rows = [
        {
            "Record Type": "Transaction",
            "Date (UTC)": "2026-01-01T00:00:00Z",
            "Account currency": "GBP",
            "Transaction ID": "deposit-1",
            "Transaction type": "Deposit",
            "Amount (account currency)": "100",
        },
        {
            "Record Type": "Transaction",
            "Date (UTC)": "2026-01-01T01:00:00Z",
            "Account currency": "GBP",
            "Transaction ID": "transfer-1",
            "Transaction type": "Transfer",
            "Amount (account currency)": transfer_amount,
            "Info": "Transfer from Invest account",
        },
        {
            "Record Type": "Overnight interest",
            "Date (UTC)": "2026-01-02T09:00:00Z",
            "Account currency": "GBP",
            "Instrument": "Synthetic",
            "Symbol": "SYN",
            "Instrument currency": "GBP",
            "Direction": "Buy",
            "Units": "1",
            "Position ID": "position-1",
            "Amount (account currency)": "-2",
        },
        {
            "Record Type": "Closed position",
            "Date (UTC)": "2026-01-03T12:00:00Z",
            "Date opened (UTC)": "2026-01-02T08:00:00Z",
            "Date closed (UTC)": "2026-01-03T12:00:00Z",
            "Account currency": "GBP",
            "Instrument": "Synthetic",
            "Symbol": "SYN",
            "Instrument currency": "GBP",
            "Direction": "Buy",
            "Units": "1",
            "Position ID": "position-1",
            "Order ID": "close-1",
            "Average price (instrument currency)": "10",
            "Exchange rate": "1",
            "Result (account currency)": "10",
            "FX fee (account currency)": "-1",
            "Result after FX fee (account currency)": "9",
            "Overnight interest (account currency)": "-2",
            "Dividend adjustment (account currency)": "0",
            "Total result (account currency)": "7",
        },
    ]
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=HEADERS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode()


def _context(
    upstream: tuple[str, ...] = (),
    *,
    scope: str = "accounts",
) -> StageContext:
    return StageContext(job_id="job", scope=scope, upstream_artifact_ids=upstream)


def _nav_dependencies(artifacts: ContentAddressedArtifactStore) -> tuple[str, ...]:
    header = (
        "Date,SyntheticNAVGBP,ExternalFlowGBP,WeightedExternalFlowGBP,"
        "DailyReturn,TWRWealth,Drawdown\n"
    )
    invest = artifacts.put_bytes(
        key="account/nav/daily_nav_a.csv",
        content=(header + "2026-01-01,50,-50,-50,,1,0\n").encode(),
        kind="nav_series",
        media_type="text/csv",
        producer_version="test",
    )
    isa = artifacts.put_bytes(
        key="account/nav/daily_nav_b.csv",
        content=(header + "2026-01-01,0,0,0,,1,0\n").encode(),
        kind="nav_series",
        media_type="text/csv",
        producer_version="test",
    )
    return (invest.ref.artifact_id, isa.ref.artifact_id)


def test_cfd_stage_skips_safely_when_no_import_exists(tmp_path: Path) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")

    result = CfdAccountStage(tmp_path / "state", artifacts).run(_context())

    assert result.artifacts == ()
    assert result.warnings == ()
    assert result.metadata == {"cfd_imported": False}


def test_cfd_stage_runs_after_snapshot_and_before_performance_and_publish(
    tmp_path: Path,
) -> None:
    names = list(TypedWorkerRuntime(tmp_path).registry().names())

    assert names.index("accounts.snapshot") < names.index("accounts.cfd")
    assert names.index("accounts.nav") < names.index("accounts.cfd")
    assert names.index("accounts.cfd") < names.index("accounts.performance")
    assert names.index("accounts.cfd") < names.index("snapshot.publish")


def test_cfd_stage_publishes_typed_realised_proxy_artifacts(tmp_path: Path) -> None:
    state_root = tmp_path / "state"
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    CfdImportStore(state_root).import_bytes("synthetic.csv", _stage_csv())
    upstream = _nav_dependencies(artifacts)

    result = CfdAccountStage(state_root, artifacts).run(_context(upstream))

    refs = {ref.key: ref for ref in result.artifacts}
    assert set(refs) == {
        "account/cfd_ledger.json",
        "account/cfd_analysis.json",
        "account/cfd_metrics.json",
        "account/nav/daily_nav_c.csv",
    }
    assert result.metadata == {"cfd_imported": True}

    ledger = artifacts.get_json(refs["account/cfd_ledger.json"].artifact_id).payload
    analysis = artifacts.get_json(refs["account/cfd_analysis.json"].artifact_id).payload
    metrics = artifacts.get_json(refs["account/cfd_metrics.json"].artifact_id).payload
    assert len(ledger["events"]) == 4
    assert analysis["event_count"] == 4
    assert analysis["realised_pnl"]["net_realised_pnl"] == "7"
    assert analysis["import_status"]["unique_events"] == 4
    assert metrics["true_nav_available"] is False
    assert metrics["nav_quality"] == "realised_cash_equity_proxy"
    assert metrics["ending_nav_gbp"] == "157"
    assert metrics["net_external_flows_gbp"] == "100"
    assert metrics["account_cash_flows_gbp"] == "150"
    assert metrics["realized_profit_loss_gbp"] == "7"
    assert metrics["pnl_sharpe_proxy"] is None
    assert "twr" not in metrics

    nav_ref = refs["account/nav/daily_nav_c.csv"]
    nav_text = artifacts.get_bytes(nav_ref.artifact_id).path.read_text(encoding="utf-8")
    nav_rows = list(csv.DictReader(io.StringIO(nav_text)))
    assert nav_rows[-1]["NavQuality"] == "realised_cash_equity_proxy"
    assert nav_rows[-1]["TrueNavAvailable"] == "false"
    assert nav_rows[-1]["RealisedCashEquityProxyGBP"] == "157"
    assert nav_rows[-1]["CumulativeAccountCashFlowGBP"] == "150"
    assert nav_rows[-1]["CumulativeHouseholdExternalFlowGBP"] == "100"
    assert nav_rows[-1]["CumulativeInternalTransferCounterflowGBP"] == "50"
    assert nav_rows[-1]["CumulativeMatchedInternalTransferCounterflowGBP"] == "50"
    assert nav_rows[-1]["CumulativeUnmatchedInternalTransferGBP"] == "0"
    assert nav_rows[-1]["HouseholdTransferMatchStatus"] == "verified"
    assert "TWR" not in nav_text
    assert nav_ref.quality.status == "warning"
    assert any("excludes open-position MTM" in warning for warning in nav_ref.quality.warnings)


def test_isolated_cfd_stage_reuses_latest_immutable_account_nav(tmp_path: Path) -> None:
    state_root = tmp_path / "state"
    artifacts = ContentAddressedArtifactStore(state_root / "artifacts")
    nav_ids = _nav_dependencies(artifacts)
    SnapshotStore(state_root).publish(
        scope="accounts",
        source="test:verified-account-boundary",
        artifacts=[artifacts.get_ref(artifact_id) for artifact_id in nav_ids],
    )
    CfdImportStore(state_root).import_bytes("synthetic.csv", _stage_csv())

    result = CfdAccountStage(state_root, artifacts).run(_context(scope="cfd"))

    refs = {ref.key: ref for ref in result.artifacts}
    assert set(refs) == {
        "account/cfd_ledger.json",
        "account/cfd_analysis.json",
        "account/cfd_metrics.json",
        "account/nav/daily_nav_c.csv",
    }
    nav_text = artifacts.get_bytes(refs["account/nav/daily_nav_c.csv"].artifact_id).path.read_text(
        encoding="utf-8"
    )
    latest = list(csv.DictReader(io.StringIO(nav_text)))[-1]
    assert latest["CumulativeMatchedInternalTransferCounterflowGBP"] == "50"


def test_labelled_internal_transfer_is_included_when_exact_match_is_partial(
    tmp_path: Path,
) -> None:
    state_root = tmp_path / "state"
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    CfdImportStore(state_root).import_bytes(
        "synthetic.csv",
        _stage_csv(transfer_amount="60"),
    )

    result = CfdAccountStage(state_root, artifacts).run(_context(_nav_dependencies(artifacts)))

    refs = {ref.key: ref for ref in result.artifacts}
    nav_text = artifacts.get_bytes(refs["account/nav/daily_nav_c.csv"].artifact_id).path.read_text(
        encoding="utf-8"
    )
    latest = list(csv.DictReader(io.StringIO(nav_text)))[-1]
    assert latest["CumulativeInternalTransferCounterflowGBP"] == "60"
    assert latest["CumulativeMatchedInternalTransferCounterflowGBP"] == "0"
    assert latest["CumulativeUnmatchedInternalTransferGBP"] == "60"
    assert latest["HouseholdTransferMatchStatus"] == "partial"
    assert any(
        "included as a labelled household-internal counterflow" in warning
        for warning in result.warnings
    )

    metrics = artifacts.get_json(refs["account/cfd_metrics.json"].artifact_id).payload
    assert "included as a labelled household-internal counterflow" in metrics["warning"]
