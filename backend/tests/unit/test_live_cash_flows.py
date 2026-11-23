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
    refreshed = collect(25, scope="accounts")
    assert set(refreshed) == {"account/nav/valuation_history.json", "account/nav/market_data.json"}
    assert refreshed["account/nav/market_data.json"].payload["baseline"] == "yahoo"
    ledger.write_text("changed synthetic ledger")
    assert len(collect(30)) == 1


def movement(amount="50.00", at="2026-09-17T09:05:00Z", kind="DEPOSIT", **updates):
    return {
        "reference": f"synthetic-{kind.lower()}-{at}",
        "type": kind,
        "amount": amount,
        "currency": "GBP",
        "dateTime": at,
        **updates,
    }


def live(*items, fetched_at="2026-09-17T09:10:05Z", complete=True):
    return {"fetched_at": fetched_at, "complete": complete, "items": list(items)}


def test_live_deposit_that_explains_the_whole_cash_change_is_reconciled_at_once():
    original = history()
    current = account("2026-09-17T09:10:00Z", cash_gbp="60.00", total_value_gbp="160.00")

    extended = extend_live_cash_flows(
        original, current, "fixture", baselines=[account()], live_cash=live(movement())
    )

    assert extended is not None
    assert extended.covered_until == datetime(2026, 9, 17, 9, 10, tzinfo=UTC)
    assert extended.events[:-1] == original.events
    assert extended.events[-1].occurred_at == datetime(2026, 9, 17, 9, 5, tzinfo=UTC)
    assert extended.events[-1].amount_gbp == 50
    assert extended.account_state_digest == account_state_digest(current)
    assert original.account_state_digest == account_state_digest(account())
    assert len(original.events) == 1


def test_live_withdrawal_and_transfer_are_signed_like_the_ledger():
    current = account("2026-09-17T09:10:00Z", cash_gbp="1.50")
    extended = extend_live_cash_flows(
        history(),
        current,
        "fixture",
        baselines=[account()],
        live_cash=live(
            movement("-6.00", kind="WITHDRAW"),
            movement("-2.50", at="2026-09-17T09:06:00Z", kind="TRANSFER"),
        ),
    )
    assert extended is not None
    assert [event.amount_gbp for event in extended.events[1:]] == [-6, -2.5]


@pytest.mark.parametrize(
    ("updates", "baselines", "cash"),
    [
        ({"live_cash": live(movement("40.00"))}, None, "60.00"),
        (
            {"live_cash": live(movement(), movement("0.12", kind="INTEREST_ON_FREE_CASH"))},
            None,
            "60.12",
        ),
        ({"live_cash": live(movement(), movement("-1.00", kind="FEE"))}, None, "59.00"),
        ({"live_cash": live(movement(currency="USD"))}, None, "60.00"),
        ({"live_cash": live(movement(), complete=False)}, None, "60.00"),
        ({"live_cash": live(movement(), fetched_at="2026-09-17T09:09:59Z")}, None, "60.00"),
        ({"live_cash": live(movement(at="2026-08-31T23:59:59Z"))}, None, "60.00"),
        ({"live_cash": live(movement("50.005"))}, None, "60.005"),
        ({"live_cash": live("not a movement")}, None, "60.00"),
        ({"live_cash": live(movement(dateTime="2026-09-17T09:05:00"))}, None, "60.00"),
        ({"live_cash": live()}, None, "60.00"),
        ({"live_cash": None}, None, "60.00"),
        ({"live_cash": live(movement())}, [], "60.00"),
        ({"live_cash": live(movement())}, [account(cash_gbp="11.00")], "60.00"),
    ],
)
def test_live_cash_changes_without_an_exact_deposit_explanation_wait_for_the_ledger(
    updates, baselines, cash
):
    current = account("2026-09-17T09:10:00Z", cash_gbp=cash)
    assert (
        extend_live_cash_flows(
            history(),
            current,
            "fixture",
            baselines=[account()] if baselines is None else baselines,
            **updates,
        )
        is None
    )


def test_a_trade_with_a_deposit_waits_for_the_ledger():
    current = account(
        "2026-09-17T09:10:00Z",
        cash_gbp="60.00",
        positions=[{"isin": "SYNTHETIC", "quantity": "3"}],
    )
    assert (
        extend_live_cash_flows(
            history(), current, "fixture", baselines=[account()], live_cash=live(movement())
        )
        is None
    )


def test_a_changed_ledger_blocks_live_deposit_reconciliation():
    current = account("2026-09-17T09:10:00Z", cash_gbp="60.00")
    assert (
        extend_live_cash_flows(
            history(), current, "new-ledger", baselines=[account()], live_cash=live(movement())
        )
        is None
    )


def test_movements_after_the_value_wait_and_earlier_live_deposits_are_not_counted_twice():
    later = movement("20.00", at="2026-09-17T09:12:00Z")
    first_value = account("2026-09-17T09:10:00Z", cash_gbp="60.00")
    first = extend_live_cash_flows(
        history(), first_value, "fixture", baselines=[account()], live_cash=live(later, movement())
    )
    assert first is not None
    assert [event.amount_gbp for event in first.events[1:]] == [50]

    second_value = account("2026-09-17T09:20:00Z", cash_gbp="80.00")
    second = extend_live_cash_flows(
        first,
        second_value,
        "fixture",
        baselines=[first_value],
        live_cash=live(later, movement(), fetched_at="2026-09-17T09:20:04Z"),
    )
    assert second is not None
    assert [event.amount_gbp for event in second.events[1:]] == [50, 20]
    assert second.covered_until == datetime(2026, 9, 17, 9, 20, tzinfo=UTC)


def test_intraday_publication_reconciles_a_live_deposit_for_that_account_only(
    tmp_path, monkeypatch
):
    import trading_max.application.live_cash_flows as flows
    from trading_max.ingestion.brokers.trading212 import ManagedAccountStore

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
    seeds += [
        artifacts.put_json(
            key=f"account/intraday/{profile}.json",
            payload=account(),
            kind="account_intraday_value",
            producer_version="fixture",
        )
        for profile in ("invest", "isa")
    ]
    snapshots.publish(scope="intraday", source="fixture", artifacts=seeds)
    ManagedAccountStore("invest", data_root=tmp_path / "trading212").write_live_cash_transactions(
        fetched_at=datetime(2026, 9, 17, 9, 10, 5, tzinfo=UTC),
        items=[movement()],
        complete=True,
    )
    values = [
        artifacts.put_json(
            key=f"account/intraday/{profile}.json",
            payload=account(f"2026-09-17T09:10:0{index}Z", cash_gbp=cash),
            kind="account_intraday_value",
            producer_version="fixture",
        )
        for index, (profile, cash) in enumerate((("invest", "60.00"), ("isa", "11.00")))
    ]

    result = AccountIntradayNavStage(artifacts, snapshots, state_root=tmp_path).run(
        StageContext(
            job_id="live-deposit",
            scope="intraday",
            upstream_artifact_ids=tuple(value.ref.artifact_id for value in values),
        )
    )

    published = {ref.key: artifacts.get_json(ref.artifact_id) for ref in result.artifacts}
    invest = published["account/nav/cash_flows_a.json"]
    assert invest.payload["covered_until"] == "2026-09-17T09:10:00Z"
    assert [event["amount_gbp"] for event in invest.payload["events"]] == [100, 50]
    assert "1 live broker deposit or withdrawal" in invest.ref.quality.coverage
    # The ISA cash changed without a matching movement: it waits for the ledger.
    assert "account/nav/cash_flows_b.json" not in published
