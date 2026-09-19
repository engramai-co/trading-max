from __future__ import annotations

import csv
import io
from decimal import Decimal

import pytest
from trading_max.analytics.cfd import (
    CfdDuplicateConflictError,
    CfdRecordTypeError,
    CfdSchemaError,
    analyse_cfd_ledger,
    combine_cfd_ledgers,
    parse_cfd_csv_bytes,
    parse_cfd_csv_text,
)


def _csv_text(headers: list[str], rows: list[dict[str, str]]) -> str:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


MINIMAL_HEADERS = [
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
    "Order type",
    "Intent",
    "Status",
    "Date created (UTC)",
    "Target price (instrument currency)",
    "Executed price (instrument currency)",
    "Exchange rate",
    "Interest rate (instrument currency)",
    "Amount (account currency)",
]

FULL_HEADERS = [
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
    "Order type",
    "Intent",
    "Status",
    "Date created (UTC)",
    "Date opened (UTC)",
    "Date closed (UTC)",
    "Average price (instrument currency)",
    "Close price (instrument currency)",
    "Target price (instrument currency)",
    "Executed price (instrument currency)",
    "Exchange rate",
    "Spread (account currency)",
    "Result (account currency)",
    "FX fee (account currency)",
    "Result after FX fee (account currency)",
    "Overnight interest (account currency)",
    "Dividend adjustment (account currency)",
    "Total result (account currency)",
    "Interest rate (instrument currency)",
    "Transaction ID",
    "Transaction type",
    "Amount (account currency)",
    "Ex-date",
    "Amount gross (account currency)",
    "Withholding tax (account currency)",
    "Amount net (account currency)",
]

LEGACY_HEADERS = [
    header for header in FULL_HEADERS if header != "Interest rate (instrument currency)"
] + ["Info"]


def _transaction(
    transaction_id: str,
    transaction_type: str,
    amount: str,
    *,
    date: str = "2026-01-01 00:00:00+00:00",
    info: str = "",
) -> dict[str, str]:
    return {
        "Record Type": "Transaction",
        "Date (UTC)": date,
        "Account currency": "GBP",
        "Transaction ID": transaction_id,
        "Transaction type": transaction_type,
        "Amount (account currency)": amount,
        "Info": info,
    }


def _closed(
    position_id: str,
    order_id: str,
    *,
    date: str,
    opened: str,
    direction: str,
    units: str,
    symbol: str,
    instrument_currency: str,
    average_price: str,
    exchange_rate: str,
    result: str,
    fx_fee: str,
    after_fx: str,
    embedded_overnight: str = "0",
    embedded_dividend: str = "0",
) -> dict[str, str]:
    return {
        "Record Type": "Closed position",
        "Date (UTC)": date,
        "Date opened (UTC)": opened,
        "Date closed (UTC)": date,
        "Account currency": "GBP",
        "Instrument": f"{symbol} instrument",
        "Symbol": symbol,
        "Instrument currency": instrument_currency,
        "Direction": direction,
        "Units": units,
        "Position ID": position_id,
        "Order ID": order_id,
        "Average price (instrument currency)": average_price,
        "Exchange rate": exchange_rate,
        "Result (account currency)": result,
        "FX fee (account currency)": fx_fee,
        "Result after FX fee (account currency)": after_fx,
        "Overnight interest (account currency)": embedded_overnight,
        "Dividend adjustment (account currency)": embedded_dividend,
        "Total result (account currency)": str(
            Decimal(after_fx) + Decimal(embedded_overnight) + Decimal(embedded_dividend)
        ),
    }


def _overnight(position_id: str, amount: str, *, date: str, symbol: str) -> dict[str, str]:
    return {
        "Record Type": "Overnight interest",
        "Date (UTC)": date,
        "Account currency": "GBP",
        "Instrument": f"{symbol} instrument",
        "Symbol": symbol,
        "Instrument currency": "GBP",
        "Direction": "Buy",
        "Units": "1",
        "Position ID": position_id,
        "Amount (account currency)": amount,
    }


def _dividend(position_id: str, amount: str, *, date: str, symbol: str) -> dict[str, str]:
    return {
        "Record Type": "Dividend adjustment",
        "Date (UTC)": date,
        "Account currency": "GBP",
        "Instrument": f"{symbol} instrument",
        "Symbol": symbol,
        "Instrument currency": "GBP",
        "Direction": "Buy",
        "Units": "1",
        "Position ID": position_id,
        "Amount gross (account currency)": amount,
        "Withholding tax (account currency)": "0",
        "Amount net (account currency)": amount,
    }


def _order(
    order_id: str,
    position_id: str,
    status: str,
    *,
    date: str,
    intent: str = "OPEN",
) -> dict[str, str]:
    return {
        "Record Type": "Order",
        "Date (UTC)": date,
        "Account currency": "GBP",
        "Instrument": "Synthetic instrument",
        "Symbol": "SYN",
        "Instrument currency": "GBP",
        "Direction": "Buy",
        "Units": "1",
        "Position ID": position_id,
        "Order ID": order_id,
        "Order type": "MARKET",
        "Intent": intent,
        "Status": status,
        "Date created (UTC)": date,
        "Executed price (instrument currency)": "10",
    }


def test_parser_accepts_three_observed_header_variants_and_preserves_provenance() -> None:
    minimal = parse_cfd_csv_bytes(
        (
            "\ufeff"
            + _csv_text(
                MINIMAL_HEADERS,
                [
                    _overnight(
                        "position-1", "-1.25", date="2026-08-02 21:00:00+00:00", symbol="SYN"
                    ),
                    _order("order-1", "position-1", "EXECUTED", date="2026-08-03 10:00:00+00:00"),
                ],
            )
        ).encode(),
        "minimal.csv",
    )
    full = parse_cfd_csv_text(
        _csv_text(
            [*FULL_HEADERS, "Future broker field"],
            [
                {
                    **_closed(
                        "position-2",
                        "order-2",
                        date="2026-07-01 12:00:00+00:00",
                        opened="2026-07-01 10:00:00+00:00",
                        direction="Buy",
                        units="2",
                        symbol="ABC",
                        instrument_currency="GBP",
                        average_price="10",
                        exchange_rate="1",
                        result="5",
                        fx_fee="-0.10",
                        after_fx="4.90",
                    ),
                    "Future broker field": "preserved",
                }
            ],
        ),
        "full.csv",
    )
    legacy = parse_cfd_csv_text(
        _csv_text(
            LEGACY_HEADERS,
            [
                _transaction(
                    "transaction-1",
                    "Transfer",
                    "25",
                    info="Transfer from Stocks ISA account",
                )
            ],
        ),
        "legacy.csv",
    )

    assert [event.record_type for event in minimal.events] == ["Overnight interest", "Order"]
    assert full.events[0].provenance[0].unknown_columns == (("Future broker field", "preserved"),)
    assert legacy.events[0].transaction_type == "Transfer"
    assert legacy.events[0].info == "Transfer from Stocks ISA account"
    assert full.to_dict()["latest_event_at"] == "2026-07-01T12:00:00Z"


def test_combine_deduplicates_repeated_and_overlapping_exports_with_stable_ids() -> None:
    first = parse_cfd_csv_text(
        _csv_text(LEGACY_HEADERS, [_transaction("transaction-1", "Deposit", "100")]),
        "first.csv",
    )
    second = parse_cfd_csv_text(
        _csv_text(LEGACY_HEADERS, [_transaction("transaction-1", "Deposit", "100")]),
        "overlap.csv",
    )

    ledger = combine_cfd_ledgers([first, second])

    assert ledger.raw_row_count == 2
    assert len(ledger.events) == 1
    assert ledger.duplicate_event_count == 1
    assert len(ledger.events[0].provenance) == 2
    assert ledger.events[0].event_id == first.events[0].event_id
    assert "duplicate CFD export content supplied: overlap.csv" in ledger.warnings


def test_combine_rejects_conflicting_broker_identity() -> None:
    first = parse_cfd_csv_text(
        _csv_text(LEGACY_HEADERS, [_transaction("transaction-1", "Deposit", "100")]),
        "first.csv",
    )
    conflicting = parse_cfd_csv_text(
        _csv_text(LEGACY_HEADERS, [_transaction("transaction-1", "Deposit", "101")]),
        "conflict.csv",
    )

    with pytest.raises(CfdDuplicateConflictError, match="canonical event ID"):
        combine_cfd_ledgers([first, conflicting])


@pytest.mark.parametrize(
    "field",
    ["Overnight interest (account currency)", "Dividend adjustment (account currency)"],
)
def test_combine_rejects_conflicting_embedded_closed_position_costs(field: str) -> None:
    row = _closed(
        "position-1",
        "close-1",
        date="2026-01-02T12:00:00Z",
        opened="2026-01-02T09:00:00Z",
        direction="Buy",
        units="1",
        symbol="AAA",
        instrument_currency="GBP",
        average_price="10",
        exchange_rate="1",
        result="10",
        fx_fee="0",
        after_fx="10",
    )
    conflict = {**row, field: "-2", "Total result (account currency)": "8"}
    first = parse_cfd_csv_text(_csv_text(LEGACY_HEADERS, [row]), "first.csv")
    conflicting = parse_cfd_csv_text(_csv_text(LEGACY_HEADERS, [conflict]), "conflict.csv")

    with pytest.raises(CfdDuplicateConflictError, match="canonical event ID"):
        combine_cfd_ledgers([first, conflicting])


@pytest.mark.parametrize(
    ("headers", "row", "error", "message"),
    [
        (
            ["Record Type", "Date (UTC)"],
            {"Record Type": "Transaction", "Date (UTC)": "2026-01-01T00:00:00Z"},
            CfdSchemaError,
            "Account currency",
        ),
        (
            ["Record Type", "Date (UTC)", "Account currency"],
            {
                "Record Type": "Mystery",
                "Date (UTC)": "2026-01-01T00:00:00Z",
                "Account currency": "GBP",
            },
            CfdRecordTypeError,
            "unknown Record Type",
        ),
        (
            [
                "Record Type",
                "Date (UTC)",
                "Account currency",
                "Transaction type",
                "Amount (account currency)",
            ],
            {
                "Record Type": "Transaction",
                "Date (UTC)": "2026-01-01T00:00:00Z",
                "Account currency": "GBP",
                "Transaction type": "Bonus",
                "Amount (account currency)": "1",
            },
            CfdRecordTypeError,
            "unknown Transaction type",
        ),
    ],
)
def test_parser_fails_loudly_for_missing_schema_and_unknown_types(
    headers: list[str],
    row: dict[str, str],
    error: type[Exception],
    message: str,
) -> None:
    with pytest.raises(error, match=message):
        parse_cfd_csv_text(_csv_text(headers, [row]), "invalid.csv")


def test_realised_analysis_separates_cash_flows_costs_trades_and_open_risk() -> None:
    rows = [
        _transaction("cash-1", "Deposit", "1000", date="2026-01-01 00:00:00+00:00"),
        _overnight("position-1", "-5", date="2026-01-02 09:00:00+00:00", symbol="AAA"),
        _dividend("position-1", "2", date="2026-01-02 10:00:00+00:00", symbol="AAA"),
        _closed(
            "position-1",
            "close-1",
            date="2026-01-02 12:00:00+00:00",
            opened="2026-01-02 09:00:00+00:00",
            direction="Buy",
            units="10",
            symbol="AAA",
            instrument_currency="GBP",
            average_price="10",
            exchange_rate="1",
            result="100",
            fx_fee="-2",
            after_fx="98",
            embedded_overnight="-5",
            embedded_dividend="2",
        ),
        _transaction(
            "cash-2",
            "Transfer",
            "200",
            date="2026-01-03 00:00:00+00:00",
            info="Transfer from Invest account",
        ),
        _transaction("cash-3", "Withdrawal", "-100", date="2026-01-04 00:00:00+00:00"),
        _transaction(
            "cash-4",
            "Adjustment",
            "10",
            date="2026-01-04 01:00:00+00:00",
            info="Negative Balance Protection",
        ),
        _overnight("position-2", "-3", date="2026-01-05 09:15:00+00:00", symbol="BBB"),
        _closed(
            "position-2",
            "close-2",
            date="2026-01-05 09:30:00+00:00",
            opened="2026-01-05 09:00:00+00:00",
            direction="Sell",
            units="4",
            symbol="BBB",
            instrument_currency="GBP",
            average_price="20",
            exchange_rate="1",
            result="-50",
            fx_fee="-1",
            after_fx="-51",
            embedded_overnight="-3",
        ),
        _closed(
            "position-3",
            "close-3",
            date="2026-01-20 09:00:00+00:00",
            opened="2026-01-10 09:00:00+00:00",
            direction="Buy",
            units="2",
            symbol="CCC",
            instrument_currency="USD",
            average_price="130",
            exchange_rate="1.3",
            result="20",
            fx_fee="0",
            after_fx="20",
        ),
        _order(
            "matched-order",
            "position-1",
            "EXECUTED",
            date="2026-01-02 11:59:00+00:00",
            intent="CLOSE",
        ),
        _order(
            "open-order",
            "position-open",
            "EXECUTED",
            date="2026-01-21 10:00:00+00:00",
        ),
        _order(
            "cancelled-order",
            "position-cancelled",
            "CANCELLED",
            date="2026-01-21 11:00:00+00:00",
        ),
    ]
    rows[7]["Direction"] = "Sell"
    parsed = parse_cfd_csv_text(_csv_text(LEGACY_HEADERS, rows), "synthetic.csv")
    analysis = analyse_cfd_ledger(combine_cfd_ledgers([parsed]))

    assert analysis.cash_flows.deposits == Decimal("1000")
    assert analysis.cash_flows.withdrawals == Decimal("-100")
    assert analysis.cash_flows.internal_transfers == Decimal("200")
    assert analysis.cash_flows.adjustments == Decimal("10")
    assert analysis.cash_flows.account_cash_flow == Decimal("1110")
    assert analysis.cash_flows.household_external_flow == Decimal("900")
    assert analysis.coverage.status == "available"
    assert analysis.coverage.raw_row_count == len(rows)
    assert analysis.money_outcome.status == "partial"
    assert analysis.money_outcome.ending_realised_cash_equity_proxy_gbp == Decimal("1171")
    assert analysis.money_outcome.true_nav_available is False
    assert analysis.strategy_risk.status == "unavailable"
    assert analysis.strategy_risk.twr_total_return is None

    assert analysis.realised_pnl.closed_gross_result == Decimal("70")
    assert analysis.realised_pnl.fx_fees == Decimal("-3")
    assert analysis.realised_pnl.closed_after_fx == Decimal("67")
    assert analysis.realised_pnl.overnight_interest == Decimal("-8")
    assert analysis.realised_pnl.dividend_adjustment == Decimal("2")
    assert analysis.realised_pnl.net_realised_pnl == Decimal("61")
    assert analysis.realised_pnl.max_realised_pnl_drawdown == Decimal("-54")
    assert analysis.realised_pnl.financing_drag_to_gross_ratio == Decimal("8") / Decimal("70")
    assert analysis.realised_pnl.financing_drag_to_net_ratio == Decimal("8") / Decimal("61")

    quality = analysis.trade_quality
    assert (quality.trade_count, quality.wins, quality.losses) == (3, 2, 1)
    assert quality.win_rate == Decimal(2) / Decimal(3)
    assert quality.payoff_ratio == (Decimal("57.5") / Decimal("54"))
    assert quality.profit_factor == Decimal("115") / Decimal("54")
    assert quality.expectancy == Decimal("61") / Decimal("3")
    assert quality.same_day_count == 2
    assert quality.under_one_hour_count == 1
    assert quality.best_trade_concentration == Decimal("95") / Decimal("115")
    assert quality.top_three_trade_concentration == Decimal(1)
    assert quality.net_without_best_trade == Decimal("-34")

    assert {
        bucket.key: bucket.net_realised_pnl for bucket in analysis.attribution.by_direction
    } == {
        "long": Decimal("115"),
        "short": Decimal("-54"),
    }
    assert {bucket.key for bucket in analysis.attribution.by_duration} == {
        "under_1_hour",
        "same_day_1_to_24_hours",
        "8_to_30_days",
    }
    assert {bucket.key for bucket in analysis.attribution.by_weekday} == {
        "Friday",
        "Monday",
        "Tuesday",
    }

    assert analysis.notional.total_closed_notional == Decimal("380")
    assert analysis.notional.average_closed_notional == Decimal("380") / Decimal("3")
    assert analysis.notional.net_realised_to_notional_ratio == Decimal("61") / Decimal("380")
    assert analysis.notional.financing_cost_to_notional_ratio == Decimal("8") / Decimal("380")
    assert analysis.notional.missing_notional_trade_count == 0
    assert analysis.structural_diagnostics.status == "available"
    assert analysis.structural_diagnostics.observable_only is True
    assert analysis.structural_diagnostics.psychology_inferred is False
    assert analysis.ending_risk.status == "unavailable"
    assert analysis.ending_risk.unmatched_executed_order_count == 1

    assert analysis.phases.status == "available"
    assert sum(
        (phase.account_cash_flow_gbp for phase in analysis.phases.items), Decimal(0)
    ) == Decimal("1110")
    assert sum(
        (phase.household_external_flow_gbp for phase in analysis.phases.items), Decimal(0)
    ) == Decimal("900")
    assert sum((phase.realised_pnl_gbp for phase in analysis.phases.items), Decimal(0)) == Decimal(
        "61"
    )
    assert all(phase.evidence_events for phase in analysis.phases.items)

    assert len(analysis.unmatched_executed_orders) == 1
    assert analysis.unmatched_executed_orders[0].order_id == "open-order"
    assert analysis.realised_series[-1].cumulative_realised_pnl == Decimal("61")
    assert analysis.realised_series[-1].cumulative_account_cash_flow == Decimal("1110")
    assert analysis.realised_series[-1].realised_cash_equity_proxy == Decimal("1171")
    assert any("standalone overnight" in warning for warning in analysis.warnings)
    assert any("current MTM is unavailable" in warning for warning in analysis.warnings)
    assert analysis.to_dict()["realised_pnl"]["net_realised_pnl"] == "61"


def test_embedded_costs_are_fallback_only_and_never_double_counted() -> None:
    closed = _closed(
        "position-1",
        "close-1",
        date="2026-01-02 12:00:00+00:00",
        opened="2026-01-02 09:00:00+00:00",
        direction="Buy",
        units="1",
        symbol="AAA",
        instrument_currency="GBP",
        average_price="10",
        exchange_rate="1",
        result="100",
        fx_fee="-2",
        after_fx="98",
        embedded_overnight="-5",
        embedded_dividend="2",
    )
    embedded_only = analyse_cfd_ledger(
        combine_cfd_ledgers([parse_cfd_csv_text(_csv_text(FULL_HEADERS, [closed]), "embedded.csv")])
    )
    standalone = analyse_cfd_ledger(
        combine_cfd_ledgers(
            [
                parse_cfd_csv_text(
                    _csv_text(
                        FULL_HEADERS,
                        [
                            closed,
                            _overnight(
                                "position-1",
                                "-5",
                                date="2026-01-02 09:00:00+00:00",
                                symbol="AAA",
                            ),
                            _dividend(
                                "position-1",
                                "2",
                                date="2026-01-02 10:00:00+00:00",
                                symbol="AAA",
                            ),
                        ],
                    ),
                    "standalone.csv",
                )
            ]
        )
    )

    assert embedded_only.realised_pnl.net_realised_pnl == Decimal("95")
    assert embedded_only.realised_series[-1].cumulative_realised_pnl == Decimal("95")
    assert standalone.realised_pnl.net_realised_pnl == Decimal("95")
    assert standalone.realised_series[-1].cumulative_realised_pnl == Decimal("95")


def test_empty_ledger_is_safe_and_does_not_invent_nav_or_twr() -> None:
    ledger = combine_cfd_ledgers([])
    analysis = analyse_cfd_ledger(ledger)

    assert ledger.events == ()
    assert analysis.currency is None
    assert analysis.realised_series == ()
    assert analysis.realised_pnl.net_realised_pnl == 0
    assert analysis.coverage.status == "unavailable"
    assert analysis.money_outcome.status == "unavailable"
    assert analysis.strategy_risk.status == "unavailable"
    assert analysis.phases.status == "unavailable"
    assert analysis.structural_diagnostics.status == "unavailable"
    assert analysis.ending_risk.status == "unavailable"
    assert "nav" not in analysis.to_dict()
    assert "twr" not in analysis.to_dict()


def _partial_close(
    order: str, *, day: int, units: str, overnight: str = "0", dividend: str = "0"
) -> dict[str, str]:
    return _closed(
        "partial",
        order,
        date=f"2026-01-{day:02d} 12:00:00+00:00",
        opened="2026-01-01 09:00:00+00:00",
        direction="Buy",
        units=units,
        symbol="AAA",
        instrument_currency="GBP",
        average_price="10",
        exchange_rate="1",
        result="100",
        fx_fee="0",
        after_fx="100",
        embedded_overnight=overnight,
        embedded_dividend=dividend,
    )


def _analyse_rows(rows: list[dict[str, str]], **kwargs):
    ledger = combine_cfd_ledgers(
        [parse_cfd_csv_text(_csv_text([*FULL_HEADERS, "Info"], rows), "synthetic.csv")]
    )
    return analyse_cfd_ledger(ledger, **kwargs)


def _assert_attribution_reconciles(analysis) -> None:
    for dimension in ("by_direction", "by_instrument", "by_duration", "by_date", "by_weekday"):
        buckets = getattr(analysis.attribution, dimension)
        assert (
            sum((bucket.net_realised_pnl for bucket in buckets), Decimal(0))
            == analysis.realised_pnl.net_realised_pnl
        )
        assert sum(bucket.trade_count for bucket in buckets) == analysis.trade_quality.trade_count


@pytest.mark.parametrize("cost_factory", [_overnight, _dividend])
@pytest.mark.parametrize("cost_value", ["-10", "10"])
def test_partial_close_cost_is_allocated_once_by_closed_quantity(cost_factory, cost_value) -> None:
    cost = cost_factory("partial", cost_value, date="2026-01-02 09:00:00+00:00", symbol="AAA")
    cost["Units"] = "10"
    first = _partial_close("one", day=3, units="4")
    second = _partial_close("two", day=5, units="6")
    analysis = _analyse_rows([second, cost, first])

    assert analysis.realised_pnl.net_realised_pnl == Decimal(200) + Decimal(cost_value)
    assert analysis.trade_quality.expectancy == (Decimal(200) + Decimal(cost_value)) / 2
    shares = analysis.cost_allocation["allocations"]
    assert [row["amount_gbp"] for row in shares] == [
        Decimal(cost_value) * Decimal("0.4"),
        Decimal(cost_value) * Decimal("0.6"),
    ]
    assert all(row["method"] == "holding_interval_units" for row in shares)
    assert analysis.cost_allocation["unallocated_costs_gbp"] == 0
    _assert_attribution_reconciles(analysis)


def test_partial_close_cost_timing_and_unclosed_units_remain_reconciled() -> None:
    before = _overnight("partial", "-2", date="2026-01-01 08:00:00+00:00", symbol="AAA")
    during = _overnight("partial", "-10", date="2026-01-02 09:00:00+00:00", symbol="AAA")
    during["Units"] = "10"
    between = _overnight("partial", "-6", date="2026-01-04 09:00:00+00:00", symbol="AAA")
    between["Units"] = "6"
    after = _overnight("partial", "-3", date="2026-01-06 09:00:00+00:00", symbol="AAA")
    analysis = _analyse_rows(
        [
            before,
            during,
            between,
            after,
            _partial_close("one", day=3, units="4"),
            _partial_close("two", day=5, units="6"),
        ]
    )
    assert analysis.realised_pnl.net_realised_pnl == 179
    assert analysis.trade_quality.expectancy == 92
    assert analysis.cost_allocation["unallocated_costs_gbp"] == -5
    _assert_attribution_reconciles(analysis)

    opening = _order("opening", "partial", "EXECUTED", date="2026-01-01 09:00:00+00:00")
    opening.update({"Symbol": "AAA", "Units": "10"})
    partial = _analyse_rows(
        [opening, during, _partial_close("one", day=3, units="4", overnight="-4")]
    )
    assert partial.realised_pnl.net_realised_pnl == 90
    assert partial.trade_quality.best_trade == 96
    assert partial.cost_allocation["unallocated_costs_gbp"] == -6
    _assert_attribution_reconciles(partial)


@pytest.mark.parametrize("cost_factory", [_overnight, _dividend])
def test_unpositioned_and_conflicting_costs_stay_in_totals(cost_factory) -> None:
    orphan = cost_factory("", "-3", date="2026-01-02 09:00:00+00:00", symbol="AAA")
    conflict = cost_factory("partial", "4", date="2026-01-02 10:00:00+00:00", symbol="BBB")
    conflict["Order ID"] = "one"
    analysis = _analyse_rows([orphan, conflict, _partial_close("one", day=3, units="4")])
    assert analysis.realised_pnl.net_realised_pnl == 101
    assert analysis.trade_quality.best_trade == 100
    assert analysis.cost_allocation["unallocated_costs_gbp"] == 1
    assert {row["method"] for row in analysis.cost_allocation["allocations"]} == {
        "no_matching_holding_interval",
        "unresolved_order_link",
    }
    _assert_attribution_reconciles(analysis)


def test_explicit_order_cost_link_uses_posted_after_close_fee_once() -> None:
    cost = _overnight("partial", "-5", date="2026-01-04 09:00:00+00:00", symbol="AAA")
    cost["Order ID"] = "one"
    analysis = _analyse_rows([cost, _partial_close("one", day=3, units="4", overnight="-5")])
    assert analysis.realised_pnl.net_realised_pnl == 95
    assert analysis.trade_quality.best_trade == 95
    assert analysis.realised_series[0].realised_pnl_change == 100
    assert analysis.realised_series[1].realised_pnl_change == -5
    assert analysis.cost_allocation["allocations"][0]["method"] == "order_id"
    _assert_attribution_reconciles(analysis)


def test_standalone_cost_does_not_suppress_unrelated_partial_close_embedded_fee() -> None:
    cost = _overnight("partial", "-3", date="2026-01-04 09:00:00+00:00", symbol="AAA")
    analysis = _analyse_rows(
        [
            cost,
            _partial_close("one", day=3, units="4", overnight="-5"),
            _partial_close("two", day=5, units="6", overnight="-3"),
        ]
    )
    assert analysis.realised_pnl.overnight_interest == -8
    assert analysis.realised_pnl.net_realised_pnl == 192
    assert analysis.trade_quality.expectancy == 96
    _assert_attribution_reconciles(analysis)


@pytest.mark.parametrize(
    "fee_day,embedded_value,reason",
    [(2, "-7", "embedded_standalone_amount_conflict"), (4, "-5", "ambiguous_embedded_overlap")],
)
def test_ambiguous_embedded_cost_preserves_other_metrics_without_inventing_pnl(
    fee_day, embedded_value, reason
) -> None:
    cost = _overnight("partial", "-5", date=f"2026-01-{fee_day:02d} 09:00:00+00:00", symbol="AAA")
    analysis = _analyse_rows(
        [cost, _partial_close("one", day=3, units="4", overnight=embedded_value)]
    )
    assert analysis.realised_pnl.net_realised_pnl is None
    assert analysis.realised_pnl.overnight_interest is None
    assert analysis.realised_pnl.closed_after_fx == 100
    assert analysis.cash_flows.account_cash_flow == 0
    assert analysis.trade_quality.trade_count == 1
    assert analysis.trade_quality.wins is None
    assert analysis.trade_quality.longest_win_streak is None
    assert analysis.attribution.status == "unavailable"
    assert analysis.phases.items == ()
    assert analysis.coverage.unavailable_reason == "cost_allocation_conflict"
    assert analysis.cost_allocation["conflicts"][0]["reason"] == reason


def test_cost_only_ledger_retains_unallocated_pnl_and_attribution() -> None:
    analysis = _analyse_rows([_overnight("", "-2", date="2026-01-02 09:00:00+00:00", symbol="AAA")])
    assert analysis.realised_pnl.net_realised_pnl == -2
    assert analysis.trade_quality.trade_count == 0
    assert analysis.cost_allocation["unallocated_costs_gbp"] == -2
    _assert_attribution_reconciles(analysis)


def test_foreign_cfd_uses_each_events_fx_and_deduplicates_embedded_native_cost() -> None:
    from trading_max.analytics.fx import FxQuote

    cash = _transaction("usd", "Deposit", "200")
    fee = _overnight("partial", "-10", date="2026-01-02 09:00:00+00:00", symbol="AAA")
    close = _partial_close("one", day=3, units="4", overnight="-10")
    for row in (cash, fee, close):
        row["Account currency"] = "USD"
        row["Instrument currency"] = "USD"

    def quote(currency, at):
        return FxQuote(currency, Decimal(1 if at.day == 2 else 2), at, "synthetic")

    analysis = _analyse_rows([cash, fee, close], fx_resolver=quote)
    assert analysis.currency == "GBP"
    assert analysis.cash_flows.deposits == 100
    assert analysis.realised_pnl.overnight_interest == -10
    assert analysis.realised_pnl.closed_after_fx == 50
    assert analysis.realised_pnl.net_realised_pnl == 40
    assert analysis.trade_quality.best_trade == 40
    assert analysis.money_outcome.ending_realised_cash_equity_proxy_gbp == 140
    assert len(analysis.fx_conversion["evidence"]) == 3
    _assert_attribution_reconciles(analysis)


def test_mixed_account_currencies_use_gbp_identity_pence_and_dated_fx() -> None:
    from trading_max.analytics.fx import FxQuote

    rows = [
        _transaction("gbp", "Deposit", "10"),
        _transaction("pence", "Deposit", "250"),
        _transaction("usd", "Deposit", "20"),
    ]
    rows[1]["Account currency"] = "GBp"
    rows[2]["Account currency"] = "USD"
    analysis = _analyse_rows(
        rows, fx_resolver=lambda currency, at: FxQuote(currency, Decimal(2), at, "synthetic")
    )
    assert analysis.currency == "GBP"
    assert analysis.coverage.status == "available"
    assert analysis.cash_flows.deposits == Decimal("22.5")
    assert analysis.fx_conversion["native_currencies"] == ["GBP", "GBX", "USD"]


@pytest.mark.parametrize(
    "instrument_currency,exchange_rate,expected", [("GBP", "0.8", "80"), ("GBp", "80", "80")]
)
def test_broker_gbp_cross_is_evidence_for_foreign_account(
    instrument_currency, exchange_rate, expected
) -> None:
    close = _partial_close("one", day=3, units="4")
    close.update(
        {
            "Account currency": "USD",
            "Instrument currency": instrument_currency,
            "Exchange rate": exchange_rate,
        }
    )
    analysis = _analyse_rows([close])
    assert analysis.realised_pnl.net_realised_pnl == Decimal(expected)
    assert analysis.fx_conversion["evidence"][0]["source"] == "broker-exchange-rate"


def test_missing_fx_is_local_and_never_treats_foreign_cross_as_gbp() -> None:
    close = _partial_close("one", day=3, units="4")
    close.update({"Account currency": "EUR", "Instrument currency": "USD", "Exchange rate": "1.1"})
    cash = _transaction("gbp", "Deposit", "100")
    analysis = _analyse_rows([cash, close])
    assert analysis.cash_flows.deposits == 100
    assert analysis.realised_pnl.closed_after_fx is None
    assert analysis.realised_pnl.net_realised_pnl is None
    assert analysis.trade_quality.trade_count == 1
    assert analysis.trade_quality.wins is None
    assert analysis.trade_quality.average_duration_hours == 51
    assert analysis.realised_series[0].realised_cash_equity_proxy == 100
    assert analysis.realised_series[-1].realised_cash_equity_proxy is None
    assert analysis.realised_series[-1].cumulative_account_cash_flow == 100
    assert analysis.money_outcome.unavailable_reason == "fx_unavailable"
    assert analysis.notional.total_closed_notional is None
    assert analysis.phases.status == "unavailable"


def test_missing_cash_fx_does_not_hide_validated_trade_metrics() -> None:
    cash = _transaction("usd", "Deposit", "100")
    cash["Account currency"] = "USD"
    analysis = _analyse_rows([cash, _partial_close("one", day=3, units="4")])
    assert analysis.cash_flows.deposits is None
    assert analysis.cash_flows.account_cash_flow is None
    assert analysis.realised_pnl.net_realised_pnl == 100
    assert analysis.trade_quality.wins == 1
    assert analysis.trade_quality.best_trade == 100
    assert analysis.realised_series[-1].cumulative_realised_pnl == 100
    assert analysis.money_outcome.ending_realised_cash_equity_proxy_gbp is None
    _assert_attribution_reconciles(analysis)


def test_uppercase_broker_record_names_parse_with_same_canonical_types() -> None:
    close = _partial_close("one", day=3, units="4")
    close["Record Type"] = "CLOSED_POSITION"
    cash = _transaction("gbp", "Deposit", "100")
    cash["Record Type"] = "TRANSACTION"
    analysis = _analyse_rows([close, cash])
    assert analysis.money_outcome.ending_realised_cash_equity_proxy_gbp == 200


def test_zero_standalone_does_not_hide_embedded_cost() -> None:
    fee = _overnight("partial", "0", date="2026-01-02 09:00:00+00:00", symbol="AAA")
    analysis = _analyse_rows([fee, _partial_close("one", day=3, units="4", overnight="-5")])
    assert analysis.realised_pnl.net_realised_pnl == 95
    assert analysis.trade_quality.best_trade == 95
    assert analysis.cost_allocation["conflicts"] == []
    _assert_attribution_reconciles(analysis)


@pytest.mark.parametrize("missing", ["both", "fee", "after"])
def test_closed_net_requires_enough_monetary_evidence(missing) -> None:
    close = _partial_close("one", day=3, units="4")
    close["FX fee (account currency)"] = "-2"
    close["Result after FX fee (account currency)"] = "98"
    if missing in {"both", "fee"}:
        close["FX fee (account currency)"] = ""
    if missing in {"both", "after"}:
        close["Result after FX fee (account currency)"] = ""
    analysis = _analyse_rows([close])
    assert analysis.realised_pnl.closed_gross_result == 100
    if missing == "both":
        assert analysis.realised_pnl.net_realised_pnl is None
        assert analysis.realised_pnl.fx_fees is None
        assert analysis.trade_quality.wins is None
        assert analysis.coverage.unavailable_reason == "monetary_data_unavailable"
        assert analysis.fx_conversion["status"] == "available"
    else:
        assert analysis.realised_pnl.net_realised_pnl == 98
        assert analysis.realised_pnl.fx_fees == -2


@pytest.mark.parametrize("tax", ["", "1", "-1", "0"])
def test_missing_dividend_net_does_not_treat_unknown_tax_as_zero(tax) -> None:
    dividend = _dividend("partial", "5", date="2026-01-02 09:00:00+00:00", symbol="AAA")
    dividend["Amount net (account currency)"] = ""
    dividend["Withholding tax (account currency)"] = tax
    analysis = _analyse_rows([dividend, _partial_close("one", day=3, units="4")])
    if tax == "0":
        assert analysis.realised_pnl.net_realised_pnl == 105
        assert analysis.trade_quality.best_trade == 105
    else:
        assert analysis.realised_pnl.net_realised_pnl is None
        assert analysis.realised_pnl.dividend_adjustment is None
        assert analysis.realised_pnl.closed_after_fx == 100
        assert analysis.trade_quality.best_trade is None
        assert analysis.coverage.unavailable_reason == "monetary_data_unavailable"
        assert analysis.cost_allocation["allocations"][0]["native_amount"] is None


def test_unknown_instrument_currency_does_not_invent_gbp_notional() -> None:
    close = _partial_close("one", day=3, units="4")
    close["Instrument currency"] = ""
    analysis = _analyse_rows([close])
    assert analysis.notional.missing_notional_trade_count == 1
    assert analysis.notional.total_closed_notional is None
    assert analysis.notional.average_closed_notional is None
    assert analysis.realised_pnl.net_realised_pnl == 100


def test_partial_cost_fx_slices_conserve_each_event_including_decimal_remainder() -> None:
    from trading_max.analytics.fx import FxQuote

    cost = _overnight("partial", "-1", date="2026-01-02 09:00:00+00:00", symbol="AAA")
    cost["Units"] = "3"
    rows = [cost, *[_partial_close(str(day), day=day, units="1") for day in (3, 4, 5)]]
    for row in rows:
        row["Account currency"] = "USD"
        row["Instrument currency"] = "USD"
    analysis = _analyse_rows(
        rows, fx_resolver=lambda currency, at: FxQuote(currency, Decimal(3), at, "synthetic")
    )
    shares = analysis.cost_allocation["allocations"]
    assert sum((row["native_amount"] for row in shares), Decimal(0)) == -1
    assert (
        sum((row["amount_gbp"] for row in shares), Decimal(0))
        == analysis.realised_pnl.overnight_interest
    )
    assert analysis.realised_pnl.overnight_interest == Decimal("-0.33333333")
    _assert_attribution_reconciles(analysis)


def test_financing_units_alone_do_not_prove_unclosed_quantity() -> None:
    fee = _overnight("partial", "-5", date="2026-01-02 09:00:00+00:00", symbol="AAA")
    fee["Units"] = "1"
    close = _partial_close("one", day=3, units="0.1", overnight="-5")
    analysis = _analyse_rows([fee, close])
    assert analysis.realised_pnl.net_realised_pnl == 95
    assert analysis.trade_quality.best_trade == 95
    assert analysis.cost_allocation["unallocated_costs_gbp"] == 0
    assert analysis.cost_allocation["conflicts"] == []
    _assert_attribution_reconciles(analysis)


def test_gbp_cost_micro_allocation_keeps_the_original_event_total() -> None:
    fee = _overnight("partial", "-1", date="2026-01-02 09:00:00+00:00", symbol="AAA")
    rows = [fee, *[_partial_close(str(day), day=day, units="1") for day in (3, 4, 5)]]
    analysis = _analyse_rows(rows)
    shares = analysis.cost_allocation["allocations"]
    assert [row["amount_gbp"] for row in shares] == [
        Decimal("-0.33333333"),
        Decimal("-0.33333333"),
        Decimal("-0.33333334"),
    ]
    assert sum((row["amount_gbp"] for row in shares), Decimal(0)) == -1
    assert analysis.realised_pnl.net_realised_pnl == 299
    assert analysis.realised_series[-1].cumulative_realised_pnl == 299
    _assert_attribution_reconciles(analysis)
