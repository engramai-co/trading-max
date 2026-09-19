from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import pandas as pd
import pytest
from trading_max.analytics.historical_nav import (
    HistoricalNavError,
    _candidate_symbols,
    _resolve_price_series,
    reconstruct_historical_nav,
)


def _export(path: Path) -> Path:
    pd.DataFrame(
        [
            {
                "Action": "Deposit",
                "Time (UTC)": "2026-01-02T08:00:00Z",
                "ISIN": "",
                "Ticker": "",
                "Name": "",
                "ID": "deposit-1",
                "No. of shares": None,
                "Price / share": None,
                "Currency (Price / share)": "",
                "Exchange rate": None,
                "Total": 100.0,
                "Currency conversion fee": 0.0,
                "Result": 0.0,
            },
            {
                "Action": "Market buy",
                "Time (UTC)": "2026-01-05T15:00:00Z",
                "ISIN": "US0000000001",
                "Ticker": "AAA",
                "Name": "AAA Corp",
                "ID": "buy-1",
                "No. of shares": 10.0,
                "Price / share": 10.0,
                "Currency (Price / share)": "USD",
                "Exchange rate": 2.0,
                "Total": 50.0,
                "Currency conversion fee": 0.0,
                "Result": 0.0,
            },
        ]
    ).to_csv(path, index=False)
    return path


def _history(symbol: str, _start, _end) -> pd.DataFrame:
    if symbol == "GBPUSD=X":
        return pd.DataFrame(
            {"Close": [2.0, 2.0, 2.0], "Stock Splits": [0.0, 0.0, 0.0]},
            index=pd.to_datetime(["2026-01-02", "2026-01-05", "2026-01-06"]),
        )
    if symbol == "AAA":
        return pd.DataFrame(
            {"Close": [10.0, 12.0], "Stock Splits": [0.0, 0.0]},
            index=pd.to_datetime(["2026-01-05", "2026-01-06"]),
        )
    return pd.DataFrame()


def _account(*, quantity: float = 10.0) -> dict:
    return {
        "fetched_at": "2026-01-06T20:00:00Z",
        "total_value_gbp": 110.0,
        "cash_gbp": 50.0,
        "investments_value_gbp": 60.0,
        "positions": [
            {
                "ticker": "AAA",
                "isin": "US0000000001",
                "quantity": quantity,
                "price_currency": "USD",
            }
        ],
    }


def test_cash_flow_timeline_preserves_timing_and_reconciles_daily_amounts(tmp_path):
    path = _export(tmp_path / "ledger.csv")
    rows = pd.read_csv(path).fillna("").to_dict("records")
    for stamp, amount in [("2026-01-06T12:00:00Z", -10), ("2026-01-06T15:00:00Z", 20)]:
        rows.append(
            {
                **rows[0],
                "ID": stamp,
                "Action": "Deposit" if amount > 0 else "Withdrawal",
                "Time (UTC)": stamp,
                "Total": amount,
            }
        )
    pd.DataFrame(rows).to_csv(path, index=False)
    account = {**_account(), "cash_gbp": 60, "total_value_gbp": 120}
    result = reconstruct_historical_nav(export_path=path, account=account, history_loader=_history)
    assert result.cash_flows.verified
    assert [event.occurred_at.hour for event in result.cash_flows.events] == [8, 12, 15]
    assert [event.amount_gbp for event in result.cash_flows.events] == [100, -10, 20]
    daily = list(csv.DictReader(io.StringIO(result.content.decode())))
    assert sum(float(row["ExternalFlowGBP"]) for row in daily) == sum(
        event.amount_gbp for event in result.cash_flows.events
    )


def test_nav_refresh_reuses_reconciled_cash_flows_but_rechecks_changed_cash(tmp_path, monkeypatch):
    from trading_max.application.nav_stages import AccountNavStage
    from trading_max.application.stages import StageContext
    from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore

    export = _export(tmp_path / "ledger.csv")
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    snapshots = SnapshotStore(tmp_path)
    calls = []

    def prices(symbol, start, end):
        calls.append(symbol)
        return _history(symbol, start, end)

    stage = AccountNavStage(artifacts, snapshots, history_loader=prices)
    monkeypatch.setattr(stage, "_historical_export", lambda _profile: export)

    def refresh(account):
        inputs = [
            artifacts.put_json(
                key=f"account/{profile}.json",
                payload=account,
                kind="account",
                producer_version="fixture",
            ).ref
            for profile in ("invest", "isa")
        ]
        result = stage.run(
            StageContext(
                job_id="refresh",
                scope="accounts",
                upstream_artifact_ids=tuple(ref.artifact_id for ref in inputs),
            )
        )
        snapshots.publish(scope="accounts", source="fixture", artifacts=list(result.artifacts))
        return [
            artifacts.get_json(ref.artifact_id).payload
            for ref in result.artifacts
            if ref.kind == "account_cash_flows"
        ]

    initial = refresh(_account())
    assert calls and all(flow["verified"] for flow in initial)
    calls.clear()
    marked = {
        **_account(),
        "fetched_at": "2026-01-07T20:00:00Z",
        "total_value_gbp": 120,
        "investments_value_gbp": 70,
    }
    advanced = refresh(marked)
    assert not calls  # Changing prices alone must not reload all historical prices.
    assert all(flow["covered_until"] == marked["fetched_at"] for flow in advanced)
    assert [flow["events"] for flow in advanced] == [flow["events"] for flow in initial]

    # A changed cash balance at the same timestamp is not a mark-only refresh.
    checked = refresh({**marked, "cash_gbp": 75, "total_value_gbp": 145})
    assert calls
    assert all(not flow["verified"] for flow in checked)


def test_usd_quote_currency_still_discovers_london_listing() -> None:
    assert _candidate_symbols("GOO3", "USD") == ("GOO3", "GOO3.L")


@pytest.mark.parametrize(
    "ticker,currency", [("EIMI.L", "USD"), ("IGLT.L", "GBX"), ("AAA.DE", "EUR")]
)
def test_explicit_provider_venue_does_not_receive_another_suffix(
    ticker: str, currency: str
) -> None:
    assert _candidate_symbols(ticker, currency) == (ticker,)


def test_refresh_after_offline_gap_backfills_prices_and_preserves_broker_marks(
    tmp_path, monkeypatch
):
    from trading_max.application.nav_stages import AccountNavStage
    from trading_max.application.stages import StageContext
    from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore

    export = _export(tmp_path / "ledger.csv")
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    snapshots = SnapshotStore(tmp_path)
    calls = []

    def prices(symbol, start, end):
        calls.append(symbol)
        frame = _history(symbol, start, end)
        if symbol in {"AAA", "GBPUSD=X"}:
            later = pd.DataFrame(
                {"Close": [14, 16, 18] if symbol == "AAA" else [2, 2, 2], "Stock Splits": 0.0},
                index=pd.to_datetime(["2026-01-07", "2026-01-08", "2026-01-09"]),
            )
            frame = pd.concat([frame, later])
            return frame.loc[: end.isoformat()]
        return frame

    stage = AccountNavStage(artifacts, snapshots, history_loader=prices)
    monkeypatch.setattr(stage, "_historical_export", lambda _profile: export)

    def refresh(account):
        inputs = [
            artifacts.put_json(key=f"account/{profile}.json", payload=account)
            for profile in ("invest", "isa")
        ]
        result = stage.run(
            StageContext(
                job_id="refresh",
                scope="accounts",
                upstream_artifact_ids=tuple(item.ref.artifact_id for item in inputs),
            )
        )
        snapshots.publish(scope="accounts", source="fixture", artifacts=result.artifacts)
        ref = next(ref for ref in result.artifacts if ref.key == "account/nav/daily_nav_a.csv")
        return list(
            csv.DictReader(io.StringIO(artifacts.get_bytes(ref.artifact_id).path.read_text()))
        )

    first = refresh({**_account(), "total_value_gbp": 111, "investments_value_gbp": 61})
    assert first[-1]["ValuationSource"] == "broker_native"
    calls.clear()
    rows = refresh(
        {
            **_account(),
            "fetched_at": "2026-01-09T20:00:00Z",
            "total_value_gbp": 145,
            "investments_value_gbp": 95,
        }
    )
    by_date = {row["Date"]: row for row in rows}
    assert calls
    assert float(by_date["2026-01-07"]["SyntheticNAVGBP"]) == 120
    assert float(by_date["2026-01-08"]["SyntheticNAVGBP"]) == 130
    assert by_date["2026-01-07"]["ValuationSource"] == "synthetic_reconstruction"
    assert float(by_date["2026-01-06"]["SyntheticNAVGBP"]) == 111
    assert by_date["2026-01-06"]["ValuationSource"] == "broker_native"
    assert float(by_date["2026-01-09"]["SyntheticNAVGBP"]) == 145
    assert by_date["2026-01-09"]["ValuationSource"] == "broker_native"
    assert float(by_date["2026-01-09"]["TWRWealth"]) == pytest.approx(1.45)


def test_eur_quote_currency_discovers_provider_venue_candidates() -> None:
    assert _candidate_symbols("HY9H", "EUR") == (
        "HY9H",
        "HY9H.F",
        "HY9H.DE",
        "HY9H.AS",
        "HY9H.PA",
        "HY9H.MI",
        "HY9H.L",
    )


def test_reconstruction_preserves_weekend_broker_dates(tmp_path: Path) -> None:
    from trading_max.analytics.nav import append_valuation

    export = _export(tmp_path / "ledger.csv")
    first = reconstruct_historical_nav(
        export_path=export, account=_account(), history_loader=_history
    )
    weekend = append_valuation(
        first.content.decode(), date="2026-01-10", value=113, cash=50, invested=63
    )
    result = reconstruct_historical_nav(
        export_path=export,
        account={
            **_account(),
            "fetched_at": "2026-01-11T12:00:00Z",
            "total_value_gbp": 114,
            "investments_value_gbp": 64,
        },
        history_loader=_history,
        previous_nav=weekend,
    )
    rows = {row["Date"]: row for row in csv.DictReader(io.StringIO(result.content.decode()))}
    assert rows["2026-01-10"]["ValuationSource"] == "broker_native"
    assert float(rows["2026-01-10"]["SyntheticNAVGBP"]) == 113
    assert rows["2026-01-11"]["ValuationSource"] == "broker_native"
    assert float(rows["2026-01-11"]["SyntheticNAVGBP"]) == 114
    assert rows["2026-01-09"]["ValuationSource"] == "synthetic_reconstruction"


@pytest.mark.parametrize("event_time", ["2026-01-10T12:00:00Z", "2026-01-09T22:00:00Z"])
@pytest.mark.parametrize("amount", [100.0, -40.0])
def test_later_cash_flow_belongs_after_retained_broker_observation(
    tmp_path: Path, event_time: str, amount: float
) -> None:
    export = _export(tmp_path / "ledger.csv")

    def prices(symbol, _start, end):
        if symbol not in {"GBPUSD=X", "AAA"}:
            return pd.DataFrame()
        return pd.DataFrame(
            {"Close": 2.0 if symbol == "GBPUSD=X" else 10.0, "Stock Splits": 0.0},
            index=pd.bdate_range("2026-01-02", end),
        )

    account = {
        **_account(),
        "fetched_at": "2026-01-09T20:00:00Z",
        "investments_value_gbp": 50.0,
        "total_value_gbp": 100.0,
    }
    prior = reconstruct_historical_nav(export_path=export, account=account, history_loader=prices)
    ledger = pd.read_csv(export).fillna("").to_dict("records")
    ledger.append(
        {
            **ledger[0],
            "ID": "later-flow",
            "Action": "Deposit" if amount > 0 else "Withdrawal",
            "Time (UTC)": event_time,
            "Total": amount,
        }
    )
    pd.DataFrame(ledger).to_csv(export, index=False)
    current = {
        **account,
        "fetched_at": "2026-01-12T20:00:00Z",
        "cash_gbp": 50.0 + amount,
        "total_value_gbp": 100.0 + amount,
    }
    result = reconstruct_historical_nav(
        export_path=export, account=current, history_loader=prices, previous_nav=prior.content
    )
    rows = {row["Date"]: row for row in csv.DictReader(io.StringIO(result.content.decode()))}
    assert result.performance_eligible
    assert result.valuation_timing_verified
    assert float(rows["2026-01-09"]["SyntheticNAVGBP"]) == 100.0
    assert rows["2026-01-09"]["ObservedAt"] == "2026-01-09T20:00:00+00:00"
    assert float(rows["2026-01-09"]["ExternalFlowGBP"]) == 0.0
    assert float(rows["2026-01-12"]["ExternalFlowGBP"]) == amount
    expected_weight = (
        pd.Timestamp(current["fetched_at"]) - pd.Timestamp(event_time)
    ).total_seconds() / (
        pd.Timestamp(current["fetched_at"]) - pd.Timestamp(account["fetched_at"])
    ).total_seconds()
    assert float(rows["2026-01-12"]["WeightedExternalFlowGBP"]) == pytest.approx(
        amount * expected_weight
    )
    assert result.cash_flows.events[-1].accounting_date.isoformat() == "2026-01-12"
    for row in rows.values():
        if row["TWRWealth"]:
            assert float(row["TWRWealth"]) == pytest.approx(1.0)
        assert float(row["Drawdown"]) == pytest.approx(0.0)

    # An older CSV has no intraday timestamp. Weekend ordering is still known,
    # but a Friday flow cannot be placed around Friday's retained native mark.
    legacy_rows = list(csv.DictReader(io.StringIO(prior.content.decode())))
    legacy_output = io.StringIO()
    writer = csv.DictWriter(legacy_output, fieldnames=list(legacy_rows[0]))
    writer.writeheader()
    writer.writerows({**row, "ObservedAt": ""} for row in legacy_rows)
    legacy_result = reconstruct_historical_nav(
        export_path=export,
        account=current,
        history_loader=prices,
        previous_nav=legacy_output.getvalue().encode(),
    )
    legacy = list(csv.DictReader(io.StringIO(legacy_result.content.decode())))
    if event_time.startswith("2026-01-09"):
        assert not legacy_result.performance_eligible
        assert not legacy_result.valuation_timing_verified
        assert all(
            row["PerformanceStatus"] == "unverified_broker_observation_time" for row in legacy
        )
        assert all(
            row["DailyReturn"] == row["TWRWealth"] == row["Drawdown"] == "" for row in legacy
        )
        retained = next(row for row in legacy if row["Date"] == "2026-01-09")
        assert retained["ValuationSource"] == "broker_native"
        assert float(retained["SyntheticNAVGBP"]) == 100.0
        assert retained["ObservedAt"] == ""
    else:
        assert legacy_result.performance_eligible
        assert float(legacy[-1]["TWRWealth"]) == pytest.approx(1.0)


def test_cash_flow_at_midnight_observation_has_no_at_risk_time(tmp_path: Path) -> None:
    export = _export(tmp_path / "ledger.csv")
    ledger = pd.read_csv(export).fillna("").to_dict("records")
    ledger.append({**ledger[0], "ID": "midnight-flow", "Time (UTC)": "2026-01-06T00:00:00Z"})
    pd.DataFrame(ledger).to_csv(export, index=False)
    result = reconstruct_historical_nav(
        export_path=export,
        account={
            **_account(),
            "fetched_at": "2026-01-06T00:00:00Z",
            "cash_gbp": 150.0,
            "investments_value_gbp": 50.0,
            "total_value_gbp": 200.0,
        },
        history_loader=_history,
    )
    row = list(csv.DictReader(io.StringIO(result.content.decode())))[-1]
    assert result.performance_eligible
    assert float(row["ExternalFlowGBP"]) == 100.0
    assert float(row["WeightedExternalFlowGBP"]) == 0.0
    assert float(row["DailyReturn"]) == 0.0
    assert float(row["TWRWealth"]) == 1.0


def test_exact_isin_cross_listings_precede_guessed_provider_symbols() -> None:
    assert _candidate_symbols(
        "3LGP",
        "GBX",
        isin="XS2675292309",
    )[:3] == ("3LGP.L", "3LAL.L", "3LGE.L")
    assert _candidate_symbols(
        "TS3E",
        "EUR",
        isin="XS2399365043",
    )[:4] == ("TS3E.DE", "TS3E.L", "3TSM.L", "TSM3.L")
    assert (
        _candidate_symbols(
            "HY9H",
            "EUR",
            isin="US78392B1070",
        )[0]
        == "HY9H.F"
    )


def test_ledger_ticker_rename_beats_stale_reused_broker_display_ticker() -> None:
    days = pd.bdate_range("2026-08-17", "2026-08-19")
    cash_fx = pd.DataFrame({"GBP": 1.0, "USD": 1.3}, index=days)
    rows = pd.DataFrame(
        {
            "Action": ["Market buy"],
            "BusinessDate": pd.to_datetime(["2026-08-17"]),
            "TradePrice": [570.0],
            "Shares": [1.0],
            "TotalN": [570.0 / 1.3],
            "TotalCurrency": ["GBP"],
            "Ticker": ["CURRENT"],
        }
    )

    def history(symbol: str, _start, _end) -> pd.DataFrame:
        closes = {
            "STALE": [45.0, 46.0, 47.0],
            "CURRENT": [570.0, 575.0, 580.0],
        }
        if symbol not in closes:
            return pd.DataFrame()
        return pd.DataFrame(
            {
                "Close": closes[symbol],
                "Stock Splits": [0.0, 0.0, 0.0],
            },
            index=days,
        )

    symbol, prices = _resolve_price_series(
        ticker="STALE",
        currency="USD",
        isin="US0000000009",
        rows=rows,
        start=days[0].date(),
        end=days[-1].date(),
        gbpusd=cash_fx["USD"],
        cash_fx=cash_fx,
        history_loader=history,
        allow_trade_only=False,
    )

    assert symbol == "CURRENT"
    assert prices.loc["2026-08-17"] == 570.0 / 1.3


def test_cross_listing_must_reconcile_to_broker_trade_economics() -> None:
    days = pd.bdate_range("2026-02-10", "2026-02-12")
    cash_fx = pd.DataFrame({"GBP": 1.0, "USD": 1.3}, index=days)
    rows = pd.DataFrame(
        {
            "Action": ["Market buy"],
            "BusinessDate": pd.to_datetime(["2026-02-10"]),
            "TradePrice": [13100.0],
            "Shares": [1.0],
            "TotalN": [131.0],
            "TotalCurrency": ["GBP"],
        }
    )

    def history(symbol: str, _start, _end) -> pd.DataFrame:
        if symbol != "3LAL.L":
            return pd.DataFrame()
        return pd.DataFrame(
            {
                "Close": [170.3, 175.5, 182.0],
                "Stock Splits": [0.0, 0.0, 0.0],
            },
            index=days,
        )

    symbol, prices = _resolve_price_series(
        ticker="3LGP",
        currency="GBX",
        isin="XS2675292309",
        rows=rows,
        start=days[0].date(),
        end=days[-1].date(),
        gbpusd=cash_fx["USD"],
        cash_fx=cash_fx,
        history_loader=history,
        allow_trade_only=False,
    )

    assert symbol == "3LAL.L"
    assert prices.loc["2026-02-10"] == 131.0


def test_eur_market_history_is_reconciled_in_gbp() -> None:
    days = pd.bdate_range("2026-05-07", "2026-05-26")
    cash_fx = pd.DataFrame(
        {"GBP": 1.0, "EUR": 1.2},
        index=days,
    )
    rows = pd.DataFrame(
        {
            "Action": ["Market buy", "Market sell"],
            "BusinessDate": pd.to_datetime(["2026-05-07", "2026-05-26"]),
            "TradePrice": [960.0, 1200.0],
            "Shares": [1.0, 1.0],
            "TotalN": [800.0, 1000.0],
            "TotalCurrency": ["GBP", "GBP"],
        }
    )

    def history(symbol: str, _start, _end) -> pd.DataFrame:
        if symbol != "HY9H.F":
            return pd.DataFrame()
        return pd.DataFrame(
            {
                "Close": [960.0, 1080.0, 1200.0],
                "Stock Splits": [0.0, 0.0, 0.0],
            },
            index=pd.to_datetime(["2026-05-07", "2026-05-15", "2026-05-26"]),
        )

    symbol, prices = _resolve_price_series(
        ticker="HY9H",
        currency="EUR",
        rows=rows,
        start=pd.Timestamp("2026-05-01").date(),
        end=pd.Timestamp("2026-05-26").date(),
        gbpusd=pd.Series(1.3, index=days),
        cash_fx=cash_fx,
        history_loader=history,
        allow_trade_only=False,
    )

    assert symbol == "HY9H.F"
    assert prices.loc["2026-05-07"] == 800.0
    assert prices.loc["2026-05-15"] == 900.0
    assert prices.loc["2026-05-26"] == 1000.0


def test_exact_listing_spreads_illiquid_gdr_return_across_market_dates(
    tmp_path: Path,
) -> None:
    export_path = tmp_path / "gdr.csv"
    pd.DataFrame(
        [
            {
                "Action": "Deposit",
                "Time (UTC)": "2026-05-07T08:00:00Z",
                "ID": "deposit",
                "Total": 1000.0,
                "Currency (Total)": "GBP",
                "Currency conversion fee": 0.0,
                "Currency (Currency conversion fee)": "",
                "Exchange rate": None,
                "Result": 0.0,
            },
            {
                "Action": "Market buy",
                "Time (UTC)": "2026-05-07T10:00:00Z",
                "ISIN": "US78392B1070",
                "Ticker": "HY9H",
                "Name": "SK hynix GDR 144A/Reg S 1",
                "ID": "buy",
                "No. of shares": 1.0,
                "Price / share": 1000.0,
                "Currency (Price / share)": "EUR",
                "Total": 800.0,
                "Currency (Total)": "GBP",
                "Currency conversion fee": 0.0,
                "Currency (Currency conversion fee)": "",
                "Exchange rate": None,
                "Result": 0.0,
            },
            {
                "Action": "Market sell",
                "Time (UTC)": "2026-05-12T10:00:00Z",
                "ISIN": "US78392B1070",
                "Ticker": "HY9H",
                "Name": "SK hynix GDR 144A/Reg S 1",
                "ID": "sell",
                "No. of shares": 1.0,
                "Price / share": 1200.0,
                "Currency (Price / share)": "EUR",
                "Total": 960.0,
                "Currency (Total)": "GBP",
                "Currency conversion fee": 0.0,
                "Currency (Currency conversion fee)": "",
                "Exchange rate": None,
                "Result": 0.0,
            },
        ]
    ).to_csv(export_path, index=False)
    days = pd.bdate_range("2026-05-07", "2026-05-13")

    def history(symbol: str, _start, _end) -> pd.DataFrame:
        if symbol == "GBPUSD=X":
            return pd.DataFrame(
                {"Close": 1.3, "Stock Splits": 0.0},
                index=days,
            )
        if symbol == "GBPEUR=X":
            return pd.DataFrame(
                {"Close": 1.25, "Stock Splits": 0.0},
                index=days,
            )
        if symbol == "HY9H.F":
            return pd.DataFrame(
                {
                    "Close": [1000.0, 1100.0, 1150.0, 1200.0, 1200.0],
                    "Stock Splits": 0.0,
                },
                index=days,
            )
        return pd.DataFrame()

    result = reconstruct_historical_nav(
        export_path=export_path,
        account={
            "fetched_at": "2026-05-13T20:00:00Z",
            "total_value_gbp": 1160.0,
            "cash_gbp": 1160.0,
            "investments_value_gbp": 0.0,
            "positions": [],
        },
        history_loader=history,
    )
    rows = list(csv.DictReader(io.StringIO(result.content.decode())))
    returns = [float(row["DailyReturn"]) for row in rows if row["DailyReturn"]]

    assert result.symbols == {"isin:US78392B1070": "HY9H.F"}
    assert max(returns) < 0.1
    assert float(rows[-1]["TWRWealth"]) == 1.16


def test_closed_position_market_history_stops_after_final_trade(tmp_path: Path) -> None:
    export_path = tmp_path / "closed.csv"
    pd.DataFrame(
        [
            {
                "Action": "Deposit",
                "Time (UTC)": "2026-01-02T08:00:00Z",
                "ID": "deposit",
                "Total": 100.0,
                "Currency (Total)": "GBP",
                "Currency conversion fee": 0.0,
                "Result": 0.0,
            },
            {
                "Action": "Market buy",
                "Time (UTC)": "2026-01-05T15:00:00Z",
                "ISIN": "US0000000002",
                "Ticker": "CLOSED",
                "Name": "Closed Corp",
                "ID": "buy",
                "No. of shares": 10.0,
                "Price / share": 10.0,
                "Currency (Price / share)": "USD",
                "Total": 50.0,
                "Currency (Total)": "GBP",
            },
            {
                "Action": "Market sell",
                "Time (UTC)": "2026-01-06T15:00:00Z",
                "ISIN": "US0000000002",
                "Ticker": "CLOSED",
                "Name": "Closed Corp",
                "ID": "sell",
                "No. of shares": 10.0,
                "Price / share": 12.0,
                "Currency (Price / share)": "USD",
                "Total": 60.0,
                "Currency (Total)": "GBP",
            },
        ]
    ).to_csv(export_path, index=False)
    days = pd.bdate_range("2026-01-02", "2026-01-12")
    requested_ends = []

    def history(symbol: str, _start, end) -> pd.DataFrame:
        if symbol == "GBPUSD=X":
            return pd.DataFrame(
                {"Close": 2.0, "Stock Splits": 0.0},
                index=days,
            )
        if symbol == "CLOSED":
            requested_ends.append(end)
            if end != pd.Timestamp("2026-01-06").date():
                return pd.DataFrame()
            return pd.DataFrame(
                {
                    "Close": [10.0, 12.0],
                    "Stock Splits": [0.0, 0.0],
                },
                index=pd.to_datetime(["2026-01-05", "2026-01-06"]),
            )
        return pd.DataFrame()

    result = reconstruct_historical_nav(
        export_path=export_path,
        account={
            "fetched_at": "2026-01-12T20:00:00Z",
            "total_value_gbp": 110.0,
            "cash_gbp": 110.0,
            "investments_value_gbp": 0.0,
            "positions": [],
        },
        history_loader=history,
    )

    assert result.symbols == {"isin:US0000000002": "CLOSED"}
    assert requested_ends == [pd.Timestamp("2026-01-06").date()]


def test_closed_position_retries_full_window_for_later_forward_split(tmp_path: Path) -> None:
    export_path = tmp_path / "forward-split.csv"
    pd.DataFrame(
        [
            {
                "Action": "Deposit",
                "Time (UTC)": "2026-01-02T08:00:00Z",
                "ID": "deposit",
                "Total": 100.0,
                "Currency (Total)": "GBP",
                "Currency conversion fee": 0.0,
                "Result": 0.0,
            },
            {
                "Action": "Market buy",
                "Time (UTC)": "2026-01-05T15:00:00Z",
                "ISIN": "US0000000003",
                "Ticker": "FORWARD",
                "Name": "Forward Split Corp",
                "ID": "buy",
                "No. of shares": 1.0,
                "Price / share": 100.0,
                "Currency (Price / share)": "USD",
                "Total": 100.0,
                "Currency (Total)": "GBP",
            },
            {
                "Action": "Market sell",
                "Time (UTC)": "2026-01-06T15:00:00Z",
                "ISIN": "US0000000003",
                "Ticker": "FORWARD",
                "Name": "Forward Split Corp",
                "ID": "sell",
                "No. of shares": 1.0,
                "Price / share": 120.0,
                "Currency (Price / share)": "USD",
                "Total": 120.0,
                "Currency (Total)": "GBP",
            },
        ]
    ).to_csv(export_path, index=False)
    days = pd.bdate_range("2026-01-02", "2026-01-12")
    requested_ends = []

    def history(symbol: str, _start, end) -> pd.DataFrame:
        if symbol == "GBPUSD=X":
            return pd.DataFrame(
                {"Close": 1.0, "Stock Splits": 0.0},
                index=days,
            )
        if symbol == "FORWARD":
            requested_ends.append(end)
            if end == pd.Timestamp("2026-01-06").date():
                return pd.DataFrame(
                    {
                        "Close": [10.0, 12.0],
                        "Stock Splits": [0.0, 0.0],
                    },
                    index=pd.to_datetime(["2026-01-05", "2026-01-06"]),
                )
            return pd.DataFrame(
                {
                    "Close": [10.0, 12.0, 11.5],
                    "Stock Splits": [0.0, 0.0, 10.0],
                },
                index=pd.to_datetime(["2026-01-05", "2026-01-06", "2026-01-09"]),
            )
        return pd.DataFrame()

    result = reconstruct_historical_nav(
        export_path=export_path,
        account={
            "fetched_at": "2026-01-12T20:00:00Z",
            "total_value_gbp": 120.0,
            "cash_gbp": 120.0,
            "investments_value_gbp": 0.0,
            "positions": [],
        },
        history_loader=history,
    )

    assert result.symbols == {"isin:US0000000003": "FORWARD"}
    assert requested_ends == [
        pd.Timestamp("2026-01-06").date(),
        pd.Timestamp("2026-01-12").date(),
    ]


def test_reconstructs_cash_flow_adjusted_history_and_broker_native_terminal_point(
    tmp_path: Path,
) -> None:
    result = reconstruct_historical_nav(
        export_path=_export(tmp_path / "export.csv"),
        account=_account(),
        history_loader=_history,
    )

    rows = list(csv.DictReader(io.StringIO(result.content.decode())))
    assert result.observations == 3
    assert result.symbols == {"isin:US0000000001": "AAA"}
    assert rows[0]["ExternalFlowGBP"] == "100.00000000"
    assert rows[-1]["SyntheticNAVGBP"] == "110.00000000"
    assert rows[-1]["ValuationSource"] == "broker_native"
    assert float(rows[-1]["DailyReturn"]) == 0.1
    assert float(rows[-1]["TWRWealth"]) == 1.1


def test_reconstruction_fails_when_ledger_does_not_explain_live_quantity(
    tmp_path: Path,
) -> None:
    try:
        reconstruct_historical_nav(
            export_path=_export(tmp_path / "export.csv"),
            account=_account(quantity=11.0),
            history_loader=_history,
        )
    except HistoricalNavError as exc:
        assert "terminal quantity" in str(exc)
    else:
        raise AssertionError("partial transaction history must fail loudly")


def test_cash_only_broker_adjustments_are_pnl_not_external_flows(tmp_path: Path) -> None:
    path = _export(tmp_path / "export.csv")
    frame = pd.read_csv(path)
    frame.loc[len(frame)] = {
        "Action": "ADR Fee",
        "Time (UTC)": "2026-01-06T12:00:00Z",
        "No. of shares": 3.0,
        "ID": "fee-1",
        "Total": -0.25,
    }
    frame.to_csv(path, index=False)
    account = _account()
    account["cash_gbp"] = 49.75
    account["total_value_gbp"] = 109.75

    result = reconstruct_historical_nav(
        export_path=path,
        account=account,
        history_loader=_history,
    )
    rows = list(csv.DictReader(io.StringIO(result.content.decode())))

    assert rows[-1]["ExternalFlowGBP"] == "0.00000000"
    assert rows[-1]["CashGBP"] == "49.75000000"


def test_trade_total_is_fee_inclusive_and_not_deducted_twice(tmp_path: Path) -> None:
    path = _export(tmp_path / "export.csv")
    frame = pd.read_csv(path)
    frame.loc[frame["Action"].eq("Market buy"), "Currency conversion fee"] = 1.0
    frame.loc[frame["Action"].eq("Market buy"), "Total"] = 51.0
    frame.to_csv(path, index=False)
    account = _account()
    account["cash_gbp"] = 49.0
    account["total_value_gbp"] = 109.0

    result = reconstruct_historical_nav(
        export_path=path,
        account=account,
        history_loader=_history,
    )
    rows = list(csv.DictReader(io.StringIO(result.content.decode())))

    assert rows[-1]["CashGBP"] == "49.00000000"
    assert result.terminal_cash_gap_gbp == 0.0


def test_unexported_cash_events_suppress_performance_instead_of_guessing(
    tmp_path: Path,
) -> None:
    account = _account()
    account["cash_gbp"] = 40.0
    account["total_value_gbp"] = 100.0

    result = reconstruct_historical_nav(
        export_path=_export(tmp_path / "export.csv"),
        account=account,
        history_loader=_history,
    )
    rows = list(csv.DictReader(io.StringIO(result.content.decode())))

    assert result.broker_anchor_cash_adjustment_gbp == -10.0
    assert result.performance_eligible is False
    assert rows[0]["CashGBP"] == "100.00000000"
    assert rows[-1]["CashGBP"] == "40.00000000"
    assert rows[-1]["SyntheticNAVGBP"] == "100.00000000"
    assert all(row["DailyReturn"] == "" for row in rows)
    assert all(row["TWRWealth"] == "" for row in rows)
    assert all(row["Drawdown"] == "" for row in rows)


def test_two_pence_cumulative_cash_rounding_remains_performance_eligible(
    tmp_path: Path,
) -> None:
    account = _account()
    account["cash_gbp"] = 50.02
    account["total_value_gbp"] = 110.02

    result = reconstruct_historical_nav(
        export_path=_export(tmp_path / "export.csv"),
        account=account,
        history_loader=_history,
    )

    assert round(result.terminal_cash_gap_gbp, 2) == 0.02
    assert result.performance_eligible is True


def test_official_wallet_transfer_completes_cash_history(tmp_path: Path) -> None:
    account = _account()
    account["cash_gbp"] = 40.0
    account["total_value_gbp"] = 100.0
    sidecar = tmp_path / "cash_transactions.json"
    sidecar.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "type": "TRANSFER",
                        "amount": -10.0,
                        "currency": "GBP",
                        "reference": "transfer-1",
                        "dateTime": "2026-01-06T10:00:00Z",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    result = reconstruct_historical_nav(
        export_path=_export(tmp_path / "export.csv"),
        account=account,
        history_loader=_history,
        cash_transactions_path=sidecar,
    )
    rows = list(csv.DictReader(io.StringIO(result.content.decode())))

    assert result.terminal_cash_gap_gbp == 0.0
    assert result.performance_eligible is True
    assert rows[-1]["ExternalFlowGBP"] == "-10.00000000"
    assert rows[-1]["DailyReturn"] != ""


def test_official_wallet_transfer_already_in_csv_is_not_counted_twice(
    tmp_path: Path,
) -> None:
    path = _export(tmp_path / "export.csv")
    frame = pd.read_csv(path)
    frame.loc[len(frame)] = {
        "Action": "Withdrawal",
        "Time (UTC)": "2026-01-06T10:00:00Z",
        "ID": "withdrawal-1",
        "Total": -10.0,
    }
    frame.to_csv(path, index=False)
    sidecar = tmp_path / "cash_transactions.json"
    sidecar.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "type": "TRANSFER",
                        "amount": -10.0,
                        "currency": "GBP",
                        "reference": "same-transfer-1",
                        "dateTime": "2026-01-06T10:00:00Z",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    account = _account()
    account["cash_gbp"] = 40.0
    account["total_value_gbp"] = 100.0

    result = reconstruct_historical_nav(
        export_path=path,
        account=account,
        history_loader=_history,
        cash_transactions_path=sidecar,
    )
    rows = list(csv.DictReader(io.StringIO(result.content.decode())))

    assert result.terminal_cash_gap_gbp == 0.0
    assert result.performance_eligible is True
    assert rows[-1]["ExternalFlowGBP"] == "-10.00000000"


def test_wallet_conversion_and_usd_settlement_are_not_external_gbp_flows(
    tmp_path: Path,
) -> None:
    path = _export(tmp_path / "export.csv")
    frame = pd.read_csv(path)
    buy = frame["Action"].eq("Market buy")
    frame.loc[buy, "Exchange rate"] = 1.0
    frame.loc[buy, "Total"] = 100.0
    frame.loc[buy, "Currency (Total)"] = "USD"
    frame.to_csv(path, index=False)
    sidecar = tmp_path / "cash_transactions.json"
    sidecar.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "type": "WITHDRAW",
                        "amount": -50.0,
                        "currency": "GBP",
                        "reference": "conversion-from-gbp",
                        "dateTime": "2026-01-05T14:00:00Z",
                    },
                    {
                        "type": "DEPOSIT",
                        "amount": 100.0,
                        "currency": "USD",
                        "reference": "conversion-to-usd",
                        "dateTime": "2026-01-05T14:00:00Z",
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    result = reconstruct_historical_nav(
        export_path=path,
        account=_account(),
        history_loader=_history,
        cash_transactions_path=sidecar,
    )
    rows = list(csv.DictReader(io.StringIO(result.content.decode())))

    assert result.performance_eligible is True
    assert result.terminal_cash_gap_gbp == 0.0
    assert rows[1]["CashGBP"] == "50.00000000"
    assert rows[1]["ExternalFlowGBP"] == "0.00000000"
    assert rows[-1]["MarketValueGBP"] == "60.00000000"
