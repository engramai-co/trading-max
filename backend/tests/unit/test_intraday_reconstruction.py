from datetime import UTC, datetime

import pandas as pd
import pytest
from trading_max.analytics.intraday import IntradayAnchor, merge_valuation_history
from trading_max.analytics.intraday_reconstruction import (
    IntradayPrices,
    _combined_marks,
    _marks,
    completed_prices,
    reconstruct_intraday_account,
)


def ledger(tmp_path, events):
    rows = []
    for index, (action, stamp, quantity, amount, price) in enumerate(events):
        rows.append(
            {
                "Action": action,
                "Time (UTC)": f"2026-09-04T{stamp}:00Z",
                "Ticker": "TEST" if quantity is not None else "",
                "ISIN": "GB0000000001" if quantity is not None else "",
                "No. of shares": quantity,
                "Total": amount,
                "Currency (Total)": "GBP",
                "Price / share": price,
                "Currency (Price / share)": "GBP",
                "Exchange rate": 1,
                "Currency conversion fee": 0,
                "Result": 0,
                "ID": f"event-{index}",
            }
        )
    path = tmp_path / "ledger.csv"
    pd.DataFrame(rows).to_csv(path, index=False)
    return path


def prices(symbol, start, end, interval):
    index = pd.date_range("2026-09-04T08:00Z", "2026-09-04T17:00Z", freq="5min")
    return IntradayPrices(pd.Series(10.0, index=index), "GBP", 3600 if interval == "1h" else 300)


def reconstruct(tmp_path, events, quantity, loader=prices, **kwargs):
    return reconstruct_intraday_account(
        export_path=ledger(tmp_path, events),
        account={
            "fetched_at": "2026-09-04T17:00:00Z",
            "positions": [
                {
                    "isin": "GB0000000001",
                    "ticker": "TEST",
                    "quantity": quantity,
                    "price_currency": "GBP",
                },
            ]
            if quantity
            else [],
        },
        history_loader=loader,
        fine_history_start=pd.Timestamp("2026-09-04T08:00Z"),
        **kwargs,
    )


def test_timestamped_buy_and_sell_do_not_change_earlier_holdings(tmp_path):
    events = [
        ("Deposit", "08:00", None, 100, None),
        ("Market buy", "14:35", 5, 50, 10),
        ("Market sell", "15:05", 2, 20, 10),
    ]
    rows = reconstruct(tmp_path, events, 3)
    assert rows.loc["2026-09-04T14:30Z", "cash"] == 100
    assert rows.loc["2026-09-04T14:40Z", "cash"] == 50
    assert rows.loc["2026-09-04T15:10Z", "cash"] == 70
    assert (rows.value == 100).all()


def test_deposit_changes_value_at_event_time_and_is_not_return(tmp_path):
    rows = reconstruct(
        tmp_path,
        [
            ("Deposit", "08:00", None, 100, None),
            ("Market buy", "09:00", 5, 50, 10),
            ("Deposit", "14:35", None, 200, None),
        ],
        5,
    )
    assert rows.loc["2026-09-04T14:30Z", "value"] == 100
    assert rows.loc["2026-09-04T14:40Z", "value"] == 300
    assert "twr" not in rows.columns


def test_missing_quotes_suppress_value_without_zeroing_a_position(tmp_path):
    def missing(symbol, start, end, interval):
        return IntradayPrices(pd.Series(dtype=float), "GBP", 300)

    rows = reconstruct(
        tmp_path,
        [
            ("Deposit", "08:00", None, 100, None),
            ("Market buy", "09:00", 5, 50, 10),
        ],
        5,
        missing,
    )
    assert not rows.empty
    assert rows.index.max() < pd.Timestamp("2026-09-04T09:00Z")
    assert (rows.value == 100).all()


def test_completed_bars_never_look_ahead_and_respect_early_close():
    frame = pd.DataFrame(
        {"Close": [10, 20], "Stock Splits": [0, 0]},
        index=pd.to_datetime(["2026-09-04T14:30Z", "2026-09-04T15:30Z"]),
    )
    quotes = completed_prices(
        frame,
        "GBP",
        "1h",
        ((pd.Timestamp("2026-09-04T14:30Z"), pd.Timestamp("2026-09-04T16:00Z")),),
    )
    assert quotes.close.index.tolist() == [
        pd.Timestamp("2026-09-04T15:30Z"),
        pd.Timestamp("2026-09-04T16:00Z"),
    ]
    assert quotes.close.loc[:"2026-09-04T15:00Z"].empty


def test_split_adjustment_uses_nominal_price_and_ledger_quantity(tmp_path):
    def split_prices(symbol, start, end, interval):
        index = pd.date_range("2026-09-04T08:00Z", "2026-09-04T17:00Z", freq="5min")
        values = [10 if stamp < pd.Timestamp("2026-09-04T14:00Z") else 5 for stamp in index]
        return IntradayPrices(pd.Series(values, index=index), "GBP", 300)

    rows = reconstruct(
        tmp_path,
        [
            ("Deposit", "08:00", None, 100, None),
            ("Market buy", "09:00", 5, 50, 10),
            ("Stock split close", "14:00", 5, 0, None),
            ("Stock split open", "14:00", 10, 0, None),
        ],
        10,
        split_prices,
    )
    assert (rows.value == 100).all()
    frame = pd.DataFrame(
        {"Close": [5, 5], "Stock Splits": [0, 2]},
        index=pd.to_datetime(["2026-09-03T14:00Z", "2026-09-04T14:00Z"]),
    )
    assert completed_prices(frame, "GBP", "5m").close.tolist() == [10, 5]


def test_terminal_quantity_mismatch_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="reconcile"):
        reconstruct(
            tmp_path, [("Deposit", "08:00", None, 100, None), ("Market buy", "09:00", 5, 50, 10)], 6
        )


def test_rejected_quote_alias_does_not_reduce_good_data_to_hourly(tmp_path, monkeypatch):
    import trading_max.analytics.intraday_reconstruction as module

    monkeypatch.setattr(
        module, "_candidate_symbols_from_ledger", lambda *args, **kwargs: ("MISSING", "TEST")
    )

    def loader(symbol, start, end, interval):
        if symbol == "MISSING":
            return IntradayPrices(pd.Series(dtype=float), "", 3600)
        return prices(symbol, start, end, interval)

    rows = reconstruct(
        tmp_path,
        [("Deposit", "08:00", None, 100, None), ("Market buy", "09:00", 5, 50, 10)],
        5,
        loader,
    )
    assert rows.loc["2026-09-04T14:40Z", "cadence"] == 600
    assert rows.loc["2026-09-04T14:40Z", "value"] == 100


def test_hourly_prices_value_every_ten_minutes_without_interpolation(tmp_path):
    def loader(symbol, start, end, interval):
        if interval == "5m":
            return IntradayPrices(pd.Series(dtype=float), "GBP", 300)
        index = pd.date_range("2026-09-04T08:00Z", "2026-09-04T17:00Z", freq="1h")
        return IntradayPrices(
            pd.Series([10.0 if s.hour < 14 else 12.0 for s in index], index=index), "GBP", 3600
        )

    rows = reconstruct(
        tmp_path,
        [
            ("Deposit", "08:00", None, 100, None),
            ("Market buy", "09:00", 5, 50, 10),
            ("Deposit", "14:35", None, 20, None),
        ],
        5,
        loader,
    )
    held = rows.loc["2026-09-04T09:00Z":]
    assert (held.index.to_series().diff().dropna() == pd.Timedelta(minutes=10)).all()
    assert (held.cadence == 600).all()
    assert (held.price_cadence == 3600).all()
    assert rows.loc["2026-09-04T13:50Z", "value"] == 100
    assert rows.loc["2026-09-04T14:00Z", "value"] == 110
    assert rows.loc["2026-09-04T14:30Z", "value"] == 110
    assert rows.loc["2026-09-04T14:40Z", "value"] == 130


def test_open_session_quote_gap_is_not_filled_with_a_stale_price(tmp_path):
    def loader(symbol, start, end, interval):
        index = pd.to_datetime(["2026-09-04T08:00Z", "2026-09-04T09:00Z", "2026-09-04T17:00Z"])
        return IntradayPrices(
            pd.Series(10.0, index=index),
            "GBP",
            3600 if interval == "1h" else 300,
            ((pd.Timestamp("2026-09-04T08:00Z"), pd.Timestamp("2026-09-04T17:00Z")),),
        )

    rows = reconstruct(
        tmp_path,
        [("Deposit", "08:00", None, 100, None), ("Market buy", "09:00", 5, 50, 10)],
        5,
        loader,
    )
    assert rows.loc["2026-09-04T12:00Z":"2026-09-04T16:00Z"].empty
    assert rows.iloc[-1].value == 100


def test_foreign_cash_and_holdings_use_event_time_fx(tmp_path):
    export = ledger(
        tmp_path,
        [
            ("Deposit", "08:00", None, 200, None),
            ("Market buy", "09:00", 5, 100, 20),
            ("Deposit", "14:35", None, 50, None),
        ],
    )
    frame = pd.read_csv(export)
    frame["Currency (Total)"] = "USD"
    frame["Currency (Price / share)"] = "USD"
    frame.to_csv(export, index=False)

    def loader(symbol, start, end, interval):
        index = pd.date_range("2026-09-04T08:00Z", "2026-09-04T17:00Z", freq="5min")
        values = (
            [2 if stamp < pd.Timestamp("2026-09-04T14:40Z") else 4 for stamp in index]
            if symbol == "GBPUSD=X"
            else [20.0] * len(index)
        )
        return IntradayPrices(pd.Series(values, index=index), "USD", 300)

    rows = reconstruct_intraday_account(
        export_path=export,
        account={
            "fetched_at": "2026-09-04T17:00Z",
            "positions": [
                {"isin": "GB0000000001", "ticker": "TEST", "quantity": 5, "price_currency": "USD"}
            ],
        },
        history_loader=loader,
        fine_history_start=pd.Timestamp("2026-09-04T08:00Z"),
    )
    assert rows.loc["2026-09-04T14:30Z", "value"] == 100
    assert rows.loc["2026-09-04T14:40Z", "value"] == 62.5
    assert rows.loc["2026-09-04T14:40Z", "cash"] == 37.5


def test_older_window_keeps_ten_minute_valuations(tmp_path):
    export = ledger(
        tmp_path, [("Deposit", "08:00", None, 100, None), ("Market buy", "09:00", 5, 50, 10)]
    )
    rows = reconstruct_intraday_account(
        export_path=export,
        account={
            "fetched_at": "2026-09-04T17:00Z",
            "positions": [
                {"isin": "GB0000000001", "ticker": "TEST", "quantity": 5, "price_currency": "GBP"}
            ],
        },
        history_loader=prices,
        fine_history_start=pd.Timestamp("2026-09-05T08:00Z"),
    )
    assert rows.loc["2026-09-04T14:40Z", "cadence"] == 600
    assert rows.loc["2026-09-04T14:40Z", "price_cadence"] == 3600


def test_full_refresh_reconstruction_and_live_collector_publish_the_same_history(
    tmp_path, monkeypatch
):
    import trading_max.application.nav_stages as stages
    from trading_max.application.stages import StageContext
    from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore

    export = ledger(
        tmp_path, [("Deposit", "08:00", None, 100, None), ("Market buy", "09:00", 5, 50, 10)]
    )
    monkeypatch.setattr(stages, "latest_export_path", lambda *args, **kwargs: export)
    artifacts, snapshots = (
        ContentAddressedArtifactStore(tmp_path / "artifacts"),
        SnapshotStore(tmp_path),
    )
    refs = []
    for profile in ("invest", "isa"):
        refs.append(
            artifacts.put_json(
                key=f"account/{profile}.json",
                payload={
                    "fetched_at": "2026-09-04T17:00:03Z",
                    "total_value_gbp": 100,
                    "cash_gbp": 50,
                    "positions": [
                        {
                            "isin": "GB0000000001",
                            "ticker": "TEST",
                            "quantity": 5,
                            "price_currency": "GBP",
                        }
                    ],
                },
                kind="account",
                producer_version="fixture",
            ).ref
        )
    result = stages.AccountIntradayNavStage(
        artifacts, snapshots, state_root=tmp_path, history_loader_factory=lambda: prices
    ).run(
        StageContext(
            job_id="full",
            scope="accounts",
            upstream_artifact_ids=tuple(ref.artifact_id for ref in refs),
        )
    )
    assert result.artifacts[0].key == "account/nav/valuation_history.json"
    payload = artifacts.get_json(result.artifacts[0].artifact_id).payload
    assert len(payload["points"]) > 10
    assert payload["points"][-1]["source"] == "broker"
    assert payload["points"][-1]["invest_model_value_gbp"] == 100
    snapshots.publish(scope="accounts", source="fixture", artifacts=[*refs, *result.artifacts])
    repeated = stages.AccountIntradayNavStage(artifacts, snapshots).run(
        StageContext(
            job_id="live",
            scope="intraday",
            upstream_artifact_ids=tuple(ref.artifact_id for ref in refs),
        )
    )
    current = artifacts.get_json(repeated.artifacts[0].artifact_id).payload
    assert current["points"] == payload["points"]


def anchor(source, value, date="2026-09-04T15:00:00+00:00"):
    stamp = datetime.fromisoformat(date)
    return IntradayAnchor(
        observed_at=stamp,
        bucket_at=stamp,
        invest_value_gbp=value,
        isa_value_gbp=100,
        total_value_gbp=value + 100,
        invest_cash_gbp=10,
        isa_cash_gbp=10,
        source=source,
        cadence_seconds=600,
        price_cadence_seconds=3600 if source == "reconstructed" else None,
    )


def test_either_producer_order_keeps_broker_value_and_model_comparison():
    broker, model = anchor("broker", 102), anchor("reconstructed", 101)
    for items in ([broker, model], [model, broker]):
        result = merge_valuation_history(None, items, generated_at=broker.observed_at)
        assert len(result.points) == 1
        point = result.points[0]
        assert point.source == "broker" and point.invest_value_gbp == 102
        assert point.invest_model_value_gbp == 101
        assert point.model_price_cadence_seconds == 3600
        assert point.flow_status == "unverified"
        repeated = merge_valuation_history(result, items, generated_at=broker.observed_at)
        assert repeated == result


def test_full_replay_removes_rejected_models_without_erasing_broker_records():
    broker = anchor("broker", 102)
    previous = merge_valuation_history(
        None,
        [
            anchor("reconstructed", 101, "2026-09-04T14:50:00+00:00"),
            broker,
            anchor("reconstructed", 110),
        ],
        generated_at=broker.observed_at,
    )
    result = merge_valuation_history(
        previous, [], generated_at=broker.observed_at, replace_reconstructed=True
    )
    assert result.points == [broker]
    assert previous.points[-1].invest_model_value_gbp == 110
    assert previous.points[0].source == "reconstructed"


def test_full_replay_replaces_old_finer_model_with_new_valid_estimate():
    stamp = datetime(2026, 9, 4, 15, tzinfo=UTC)
    old = anchor("reconstructed", 110).model_copy(update={"price_cadence_seconds": 300})
    previous = merge_valuation_history(None, [old], generated_at=stamp)
    new = anchor("reconstructed", 101)
    result = merge_valuation_history(
        previous, [new], generated_at=stamp, replace_reconstructed=True
    )
    assert result.points == [new]
    assert (
        merge_valuation_history(result, [new], generated_at=stamp, replace_reconstructed=True)
        == result
    )


def test_three_month_retention_and_future_observations():
    now = datetime(2026, 9, 4, 15, tzinfo=UTC)
    points = [
        anchor("broker", 100, "2026-06-04T15:00:00+00:00"),
        anchor("reconstructed", 102),
        anchor("reconstructed", 103, "2026-09-05T15:00:00+00:00"),
    ]
    result = merge_valuation_history(None, points, generated_at=now)
    assert len(result.points) == 2
    assert result.retention_days == 120
    assert all(point.observed_at <= now for point in result.points)


def test_extended_bars_complete_at_each_session_boundary():
    def stamp(value):
        return pd.Timestamp(f"2026-09-04T{value}Z")

    regular = ((stamp("13:30"), stamp("20:00")),)
    boundaries = (
        (stamp("08:00"), stamp("13:30")),
        *regular,
        (stamp("20:00"), stamp("00:00") + pd.Timedelta(days=1)),
    )
    frame = pd.DataFrame(
        {"Close": [10, 11, 12], "Stock Splits": [0, 0, 0]},
        index=pd.to_datetime([stamp("13:00"), stamp("19:30"), stamp("23:00")]),
    )
    result = completed_prices(frame, "USD", "1h", regular, bar_sessions=boundaries)
    assert result.close.index.tolist() == [
        stamp("13:30"),
        stamp("20:00"),
        stamp("00:00") + pd.Timedelta(days=1),
    ]
    assert result.sessions == boundaries
    assert result.close.loc[: stamp("13:20")].empty


def test_fresh_hourly_trade_beats_stale_fine_trade_outside_regular_session(tmp_path):
    def loader(symbol, start, end, interval):
        if interval == "1h":
            index = pd.date_range("2026-09-04T08:00Z", "2026-09-04T17:00Z", freq="1h")
            values = [10 if s.hour < 14 else 12 for s in index]
        else:
            index = pd.to_datetime(["2026-09-04T08:00Z", "2026-09-04T13:05Z", "2026-09-04T17:00Z"])
            values = [10, 10, 12]
        return IntradayPrices(
            pd.Series(values, index=index),
            "GBP",
            3600 if interval == "1h" else 300,
            ((pd.Timestamp("2026-09-04T09:00Z"), pd.Timestamp("2026-09-04T12:00Z")),),
        )

    rows = reconstruct(
        tmp_path,
        [("Deposit", "08:00", None, 100, None), ("Market buy", "09:00", 5, 50, 10)],
        5,
        loader,
    )
    assert rows.loc["2026-09-04T13:50Z", "value"] == 100
    assert rows.loc["2026-09-04T14:00Z", "value"] == 110
    assert rows.loc["2026-09-04T14:40Z", "value"] == 110
    assert rows.loc["2026-09-04T14:40Z", "price_cadence"] == 3600


def test_session_opens_before_first_hourly_bar_completes():
    sessions = (
        (pd.Timestamp("2026-09-04T08:00Z"), pd.Timestamp("2026-09-04T16:00Z")),
        (pd.Timestamp("2026-09-07T08:00Z"), pd.Timestamp("2026-09-07T16:00Z")),
    )
    prices = IntradayPrices(
        pd.Series([100.0], index=pd.to_datetime(["2026-09-04T16:00Z"])),
        "GBP",
        3600,
        sessions,
    )
    times = pd.to_datetime(["2026-09-06T12:00Z", "2026-09-07T07:50Z", "2026-09-07T08:00Z"])
    values = _marks(prices, times)
    assert values.iloc[:2].tolist() == [100, 100]
    assert pd.isna(values.iloc[2])


def test_fresher_fine_quote_is_used_within_existing_hourly_fallback_budget():
    sessions = (
        (pd.Timestamp("2026-09-04T08:00Z"), pd.Timestamp("2026-09-04T16:00Z")),
        (pd.Timestamp("2026-09-07T08:00Z"), pd.Timestamp("2026-09-07T16:00Z")),
    )
    hourly = IntradayPrices(
        pd.Series([100.0], index=pd.to_datetime(["2026-09-04T16:00Z"])), "GBP", 3600, sessions
    )
    fine = IntradayPrices(
        pd.Series([90.0], index=pd.to_datetime(["2026-09-07T08:15Z"])), "GBP", 300, sessions
    )
    times = pd.to_datetime(["2026-09-07T08:40Z", "2026-09-07T10:20Z"])
    values, currency, precision = _combined_marks(hourly, fine, times)
    assert values.iloc[0] == 90
    assert currency == "GBP"
    assert precision.iloc[0] == 3600
    assert pd.isna(values.iloc[1])


def test_minute_only_data_does_not_acquire_an_hourly_freshness_allowance():
    fine = IntradayPrices(
        pd.Series([90.0], index=pd.to_datetime(["2026-09-07T08:15Z"])), "GBP", 300
    )
    empty = IntradayPrices(pd.Series(dtype=float), "GBP", 3600)
    values, _, _ = _combined_marks(empty, fine, pd.to_datetime(["2026-09-07T08:40Z"]))
    assert values.isna().all()


def test_missing_full_session_cannot_be_carried_into_the_next_night():
    sessions = (
        (pd.Timestamp("2026-09-03T08:00Z"), pd.Timestamp("2026-09-03T16:00Z")),
        (pd.Timestamp("2026-09-04T08:00Z"), pd.Timestamp("2026-09-04T16:00Z")),
    )
    prices = IntradayPrices(
        pd.Series([100.0], index=pd.to_datetime(["2026-09-03T16:00Z"])), "GBP", 3600, sessions
    )
    values = _marks(prices, pd.to_datetime(["2026-09-04T17:00Z"]))
    assert values.isna().all()


def test_extended_sessions_apply_the_same_freshness_gate():
    regular = ((pd.Timestamp("2026-09-07T13:30Z"), pd.Timestamp("2026-09-07T20:00Z")),)
    extended = (
        (pd.Timestamp("2026-09-07T08:00Z"), pd.Timestamp("2026-09-07T13:30Z")),
        *regular,
        (pd.Timestamp("2026-09-07T20:00Z"), pd.Timestamp("2026-09-08T00:00Z")),
    )
    frame = pd.DataFrame(
        {"Close": [100.0], "Stock Splits": [0]},
        index=pd.to_datetime(["2026-09-04T23:55Z"]),
    )
    quotes = completed_prices(frame, "USD", "5m", regular, bar_sessions=extended)
    assert _marks(quotes, pd.to_datetime(["2026-09-07T08:10Z"])).isna().all()


def test_combining_quotes_normalizes_pence_and_never_uses_a_future_mark():
    hourly = IntradayPrices(
        pd.Series([1000.0], index=pd.to_datetime(["2026-09-07T08:00Z"])), "GBX", 3600
    )
    fine = IntradayPrices(
        pd.Series([11.0, 99.0], index=pd.to_datetime(["2026-09-07T08:05Z", "2026-09-07T08:15Z"])),
        "GBP",
        300,
    )
    values, currency, precision = _combined_marks(
        hourly, fine, pd.to_datetime(["2026-09-07T08:00Z", "2026-09-07T08:10Z"])
    )
    assert values.tolist() == [10, 11]
    assert currency == "GBP"
    assert precision.tolist() == [3600, 300]


def test_session_freshness_accepts_calendar_offsets_across_dst():
    sessions = (
        (pd.Timestamp("2026-10-30T09:30-04:00"), pd.Timestamp("2026-10-30T16:00-04:00")),
        (pd.Timestamp("2026-11-02T09:30-05:00"), pd.Timestamp("2026-11-02T16:00-05:00")),
    )
    prices = IntradayPrices(
        pd.Series([100.0], index=pd.to_datetime(["2026-10-30T20:00Z"])), "USD", 3600, sessions
    )
    values = _marks(prices, pd.to_datetime(["2026-11-01T12:00Z", "2026-11-02T14:40Z"]))
    assert values.iloc[0] == 100
    assert pd.isna(values.iloc[1])


def test_extended_cache_refetches_regular_only_history_and_keeps_short_pre_bar(
    tmp_path, monkeypatch
):
    import hashlib

    from trading_max.analytics import intraday_reconstruction as module

    start, end = pd.Timestamp("2026-09-04T08:00Z"), pd.Timestamp("2026-09-04T16:00Z")
    calls = []

    class Ticker:
        def __init__(self, symbol):
            pass

        def history(self, **kwargs):
            calls.append(kwargs)
            return pd.DataFrame(
                {"Close": [11.0, 12.0], "Stock Splits": [0.0, 0.0]},
                index=pd.to_datetime(["2026-09-04T13:00Z", "2026-09-04T13:30Z"]),
            )

        def get_history_metadata(self):
            return {
                "currency": "USD",
                "tradingPeriods": pd.DataFrame(
                    {
                        "pre_start": [start],
                        "pre_end": [pd.Timestamp("2026-09-04T13:30Z")],
                        "start": [pd.Timestamp("2026-09-04T13:30Z")],
                        "end": [pd.Timestamp("2026-09-04T20:00Z")],
                        "post_start": [pd.Timestamp("2026-09-04T20:00Z")],
                        "post_end": [pd.Timestamp("2026-09-05T00:00Z")],
                    }
                ),
            }

    monkeypatch.setattr(module.yf, "Ticker", Ticker)
    old = tmp_path / (hashlib.sha256(b"TEST:1h:v1").hexdigest()[:24] + ".json")
    old.write_text('{"regular_only": true}')
    loader = module.CachedIntradayPriceLoader(tmp_path)
    quotes = loader("TEST", start, end, "1h")
    assert len(calls) == 1 and calls[0]["prepost"] is True
    assert quotes.close.loc["2026-09-04T13:30Z"] == 11
    assert quotes.close.loc["2026-09-04T14:30Z"] == 12
    # A new process can reuse the extended cache, including shortened boundaries.
    again = module.CachedIntradayPriceLoader(tmp_path)("TEST", start, end, "1h")
    pd.testing.assert_series_equal(again.close, quotes.close, check_names=False)
    assert len(calls) == 1
    assert old.read_text() == '{"regular_only": true}'


def test_extended_backfill_replaces_regular_only_model_but_never_broker():
    regular = anchor("reconstructed", 100).model_copy(update={"price_cadence_seconds": 300})
    extended = anchor("reconstructed", 110).model_copy(update={"includes_extended_hours": True})
    result = merge_valuation_history(
        None, [regular, extended, regular], generated_at=regular.observed_at
    )
    assert result.points == [extended]
    broker = anchor("broker", 111)
    result = merge_valuation_history(result, [broker, extended], generated_at=broker.observed_at)
    assert result.points[0].invest_value_gbp == 111
    assert result.points[0].invest_model_value_gbp == 110
