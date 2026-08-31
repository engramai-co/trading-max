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
