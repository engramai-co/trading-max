from datetime import UTC, datetime

import pytest
from trading_max.analytics.cash_flow_history import (
    AccountCashFlowHistory,
    account_state_digest,
    extend_live_cash_flows,
)
from trading_max.application import AccountIntradayNavStage, StageContext
from trading_max.application.live_cash_flows import ledger_digest
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore


def account(stamp="2026-09-17T09:00:00Z", **updates):
    return {
        "fetched_at": stamp,
        "cash_gbp": "10.00",
        "positions_status": "verified",
        "positions": [{"isin": "SYNTHETIC", "quantity": "2"}],
        "total_value_gbp": "110.00",
        **updates,
    }


def history(digest="fixture"):
    return AccountCashFlowHistory(
        covered_from=datetime(2026, 9, 1, tzinfo=UTC),
        covered_until=datetime(2026, 9, 17, 9, tzinfo=UTC),
        verified=True,
        events=[
            {
                "occurred_at": "2026-09-01T00:00:00Z",
                "accounting_date": "2026-09-01",
                "amount_gbp": 100,
            }
        ],
        source_digest=digest,
        account_state_digest=account_state_digest(account()),
    )


def test_price_only_live_update_extends_existing_cash_flow_evidence():
    original = history()
    changed = account("2026-09-17T09:10:01Z", total_value_gbp="115.00")
    extended = extend_live_cash_flows(original, changed, "fixture")
    assert extended is not None
    assert extended.covered_until == datetime(2026, 9, 17, 9, 10, 1, tzinfo=UTC)
    assert extended.events == original.events
    assert original.covered_until.hour == 9 and original.covered_until.minute == 0


@pytest.mark.parametrize(
    "updates",
    [
        {"cash_gbp": "11.00"},
        {"positions": [{"isin": "SYNTHETIC", "quantity": "3"}]},
        {"positions_status": "unreconciled"},
        {"positions": None},
        {"cash_gbp": None},
        {"fetched_at": "2026-09-17T08:59:00Z"},
    ],
)
def test_live_marks_never_certify_a_changed_or_unavailable_account(updates):
    assert (
        extend_live_cash_flows(history(), {**account("2026-09-17T09:10:00Z"), **updates}, "fixture")
        is None
    )


def test_ledger_changes_and_unverified_history_require_reconciliation():
    current = account("2026-09-17T09:10:00Z")
    assert extend_live_cash_flows(history(), current, "new-ledger") is None
    assert (
        extend_live_cash_flows(history().model_copy(update={"verified": False}), current, "fixture")
        is None
    )
    assert (
        extend_live_cash_flows(
            history().model_copy(update={"account_state_digest": ""}), current, "fixture"
        )
        is None
    )


def test_intraday_publication_advances_each_account_independently_without_market_history(
    tmp_path, monkeypatch
):
    import trading_max.application.live_cash_flows as flows

    ledger = tmp_path / "ledger.csv"
    ledger.write_text("synthetic ledger")
    monkeypatch.setattr(flows, "latest_export_path", lambda *_args, **_kwargs: ledger)
    monkeypatch.setattr(flows, "latest_cash_transactions_path", lambda *_args, **_kwargs: None)
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    snapshots = SnapshotStore(tmp_path)
    digest = ledger_digest((ledger, None))
    seeds = [
        artifacts.put_json(
            key=f"account/nav/cash_flows_{code}.json",
            payload=history(digest).model_dump(mode="json"),
            kind="account_cash_flows",
            producer_version="fixture",
        )
        for code in ("a", "b")
    ]
    snapshots.publish(scope="accounts", source="fixture", artifacts=seeds)
    stage = AccountIntradayNavStage(artifacts, snapshots, state_root=tmp_path)

    def collect(minute, scope="intraday", **updates):
        accounts = [
            artifacts.put_json(
                key=f"account/intraday/{profile}.json",
                payload=account(
                    f"2026-09-17T09:{minute:02d}:0{index}Z", **(updates if index == 0 else {})
                ),
                kind="account_intraday_value",
                producer_version="fixture",
            )
            for index, profile in enumerate(("invest", "isa"))
        ]
        result = stage.run(
            StageContext(
                job_id=f"live-{minute}",
                scope=scope,
                upstream_artifact_ids=tuple(a.ref.artifact_id for a in accounts),
            )
        )
        previous = {ref.key: ref for ref in snapshots.latest().manifest.artifacts}
        previous.update({ref.key: ref for ref in result.artifacts})
        snapshots.publish(scope="intraday", source="fixture", artifacts=list(previous.values()))
        return {ref.key: artifacts.get_json(ref.artifact_id) for ref in result.artifacts}

    first = collect(10, total_value_gbp="120.00")
    assert len(first) == 3
    a = first["account/nav/cash_flows_a.json"]
    assert a.payload["covered_until"] == "2026-09-17T09:10:00Z"
    assert first["account/nav/cash_flows_b.json"].payload["covered_until"] == "2026-09-17T09:10:01Z"
    assert len(a.ref.dependency_artifact_ids) == 2
    assert (
        first["account/nav/valuation_history.json"].payload["points"][-1]["flow_status"]
        == "unverified"
    )
    second = collect(20, cash_gbp="20.00", total_value_gbp="130.00")
    assert "account/nav/cash_flows_a.json" not in second
    assert (
        second["account/nav/cash_flows_b.json"].payload["covered_until"] == "2026-09-17T09:20:01Z"
    )
    assert artifacts.get_json(a.ref.artifact_id).payload == a.payload
    # A full refresh has its own freshly reconciled flow artifacts. The
    # intraday stage must not replace those with evidence from an older snapshot.
    assert len(collect(25, scope="accounts")) == 1
    ledger.write_text("changed synthetic ledger")
    assert len(collect(30)) == 1
