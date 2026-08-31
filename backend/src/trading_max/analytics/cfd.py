"""Deterministic Trading 212 CFD CSV parsing and realised analytics.

The module is deliberately side-effect free: callers provide in-memory CSV
content, and no broker export or canonical ledger is persisted here.  Trading
212 CFD exports do not contain daily marked-to-market equity, so every curve
and drawdown in this module is explicitly realised-only.
"""

from __future__ import annotations

import csv
import hashlib
import io
import statistics
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, fields, replace
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

PARSER_VERSION = "trading212-cfd-csv-v1"
CALCULATION_VERSION = "cfd-realised-analysis-v2"

type CfdRecordType = Literal[
    "Transaction",
    "Closed position",
    "Overnight interest",
    "Dividend adjustment",
    "Order",
]

_RECORD_TYPES: dict[str, CfdRecordType] = {
    "transaction": "Transaction",
    "closed position": "Closed position",
    "overnight interest": "Overnight interest",
    "dividend adjustment": "Dividend adjustment",
    "order": "Order",
}
_TRANSACTION_TYPES = {
    "deposit": "Deposit",
    "withdrawal": "Withdrawal",
    "transfer": "Transfer",
    "adjustment": "Adjustment",
}

# Exact broker headings are retained in provenance.  Aliases are only used to
# resolve canonical fields so parsing never depends on column position.
_HEADERS: dict[str, tuple[str, ...]] = {
    "record_type": ("Record Type",),
    "occurred_at": ("Date (UTC)", "Time (UTC)"),
    "account_currency": ("Account currency",),
    "instrument": ("Instrument",),
    "symbol": ("Symbol",),
    "instrument_currency": ("Instrument currency",),
    "direction": ("Direction",),
    "units": ("Units",),
    "position_id": ("Position ID",),
    "order_id": ("Order ID",),
    "order_type": ("Order type",),
    "intent": ("Intent",),
    "status": ("Status",),
    "created_at": ("Date created (UTC)",),
    "opened_at": ("Date opened (UTC)",),
    "closed_at": ("Date closed (UTC)",),
    "average_price": ("Average price (instrument currency)",),
    "close_price": ("Close price (instrument currency)",),
    "executed_price": ("Executed price (instrument currency)",),
    "exchange_rate": ("Exchange rate",),
    "result": ("Result (account currency)",),
    "fx_fee": ("FX fee (account currency)",),
    "result_after_fx": ("Result after FX fee (account currency)",),
    "embedded_overnight": ("Overnight interest (account currency)",),
    "embedded_dividend": ("Dividend adjustment (account currency)",),
    "total_result": ("Total result (account currency)",),
    "transaction_id": ("Transaction ID",),
    "transaction_type": ("Transaction type",),
    "amount": ("Amount (account currency)",),
    "dividend_gross": ("Amount gross (account currency)",),
    "withholding_tax": ("Withholding tax (account currency)",),
    "dividend_net": ("Amount net (account currency)",),
    "info": ("Info",),
}
_KNOWN_HEADERS = frozenset(header.casefold() for aliases in _HEADERS.values() for header in aliases)


class CfdCsvError(ValueError):
    """Base class for a rejected Trading 212 CFD CSV."""


class CfdSchemaError(CfdCsvError):
    """Raised when required columns or values are missing or malformed."""


class CfdRecordTypeError(CfdCsvError):
    """Raised when a record or transaction subtype is not understood."""


class CfdDuplicateConflictError(CfdCsvError):
    """Raised when one broker identity describes different economic events."""


def _json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, Decimal):
        return str(value)
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    return value


class _Serializable:
    """Small JSON-safe serialization contract shared by public dataclasses."""

    def to_dict(self) -> dict[str, Any]:
        return {field.name: _json_value(getattr(self, field.name)) for field in fields(self)}


@dataclass(frozen=True, slots=True)
class CfdEventProvenance(_Serializable):
    source_name: str
    row_number: int
    raw_columns: tuple[tuple[str, str], ...]
    unknown_columns: tuple[tuple[str, str], ...]


@dataclass(frozen=True, slots=True)
class CfdEvent(_Serializable):
    event_id: str
    record_type: CfdRecordType
    occurred_at: datetime
    account_currency: str
    instrument: str | None = None
    symbol: str | None = None
    instrument_currency: str | None = None
    direction: str | None = None
    units: Decimal | None = None
    position_id: str | None = None
    order_id: str | None = None
    transaction_id: str | None = None
    transaction_type: str | None = None
    order_type: str | None = None
    order_intent: str | None = None
    order_status: str | None = None
    created_at: datetime | None = None
    opened_at: datetime | None = None
    closed_at: datetime | None = None
    average_price: Decimal | None = None
    close_price: Decimal | None = None
    executed_price: Decimal | None = None
    exchange_rate: Decimal | None = None
    amount: Decimal | None = None
    gross_result: Decimal | None = None
    fx_fee: Decimal | None = None
    result_after_fx_fee: Decimal | None = None
    embedded_overnight_interest: Decimal | None = None
    embedded_dividend_adjustment: Decimal | None = None
    broker_total_result: Decimal | None = None
    dividend_gross: Decimal | None = None
    withholding_tax: Decimal | None = None
    dividend_net: Decimal | None = None
    notional_account_currency: Decimal | None = None
    info: str | None = None
    provenance: tuple[CfdEventProvenance, ...] = ()


@dataclass(frozen=True, slots=True)
class CfdFileSummary(_Serializable):
    source_name: str
    file_sha256: str
    schema_columns: tuple[str, ...]
    raw_row_count: int
    event_count: int
    coverage_start: datetime | None
    coverage_end: datetime | None
    latest_event_at: datetime | None
    warnings: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CfdParsedFile(_Serializable):
    source_name: str
    file_sha256: str
    parser_version: str
    schema_columns: tuple[str, ...]
    raw_row_count: int
    events: tuple[CfdEvent, ...]
    coverage_start: datetime | None
    coverage_end: datetime | None
    latest_event_at: datetime | None
    warnings: tuple[str, ...] = ()

    def summary(self) -> CfdFileSummary:
        return CfdFileSummary(
            source_name=self.source_name,
            file_sha256=self.file_sha256,
            schema_columns=self.schema_columns,
            raw_row_count=self.raw_row_count,
            event_count=len(self.events),
            coverage_start=self.coverage_start,
            coverage_end=self.coverage_end,
            latest_event_at=self.latest_event_at,
            warnings=self.warnings,
        )


@dataclass(frozen=True, slots=True)
class CfdLedger(_Serializable):
    parser_version: str
    source_files: tuple[CfdFileSummary, ...]
    raw_row_count: int
    events: tuple[CfdEvent, ...]
    duplicate_event_count: int
    coverage_start: datetime | None
    coverage_end: datetime | None
    latest_event_at: datetime | None
    account_currencies: tuple[str, ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CfdCashFlowSummary(_Serializable):
    deposits: Decimal
    withdrawals: Decimal
    internal_transfers: Decimal
    adjustments: Decimal
    account_cash_flow: Decimal
    household_external_flow: Decimal


@dataclass(frozen=True, slots=True)
class CfdRealisedPnlSummary(_Serializable):
    closed_gross_result: Decimal
    fx_fees: Decimal
    closed_after_fx: Decimal
    overnight_interest: Decimal
    dividend_adjustment: Decimal
    net_realised_pnl: Decimal
    financing_drag_to_gross_ratio: Decimal | None
    financing_drag_to_net_ratio: Decimal | None
    max_realised_pnl_drawdown: Decimal


@dataclass(frozen=True, slots=True)
class CfdTradeQuality(_Serializable):
    trade_count: int
    wins: int
    losses: int
    breakeven: int
    win_rate: Decimal | None
    average_win: Decimal | None
    average_loss: Decimal | None
    payoff_ratio: Decimal | None
    profit_factor: Decimal | None
    expectancy: Decimal | None
    average_duration_hours: Decimal | None
    median_duration_hours: Decimal | None
    same_day_count: int
    under_one_hour_count: int
    best_trade: Decimal | None
    worst_trade: Decimal | None
    longest_win_streak: int
    longest_loss_streak: int
    best_trade_concentration: Decimal | None
    top_three_trade_concentration: Decimal | None
    net_without_best_trade: Decimal | None


@dataclass(frozen=True, slots=True)
class CfdAttributionBucket(_Serializable):
    key: str
    trade_count: int
    net_realised_pnl: Decimal


@dataclass(frozen=True, slots=True)
class CfdAttribution(_Serializable):
    by_direction: tuple[CfdAttributionBucket, ...]
    by_instrument: tuple[CfdAttributionBucket, ...]
    by_duration: tuple[CfdAttributionBucket, ...]
    by_date: tuple[CfdAttributionBucket, ...]
    by_weekday: tuple[CfdAttributionBucket, ...]


@dataclass(frozen=True, slots=True)
class CfdRealisedPoint(_Serializable):
    occurred_at: datetime
    event_id: str
    record_type: str
    realised_pnl_change: Decimal
    cumulative_realised_pnl: Decimal
    account_cash_flow_change: Decimal
    cumulative_account_cash_flow: Decimal
    realised_cash_equity_proxy: Decimal
    realised_pnl_drawdown: Decimal


@dataclass(frozen=True, slots=True)
class CfdNotionalSummary(_Serializable):
    total_closed_notional: Decimal
    average_closed_notional: Decimal | None
    net_realised_to_notional_ratio: Decimal | None
    financing_cost_to_notional_ratio: Decimal | None
    missing_notional_trade_count: int


@dataclass(frozen=True, slots=True)
class CfdUnmatchedExecutedOrder(_Serializable):
    event_id: str
    order_id: str | None
    position_id: str | None
    occurred_at: datetime
    symbol: str | None
    direction: str | None
    intent: str | None


@dataclass(frozen=True, slots=True)
class CfdReviewCoverage(_Serializable):
    status: Literal["available", "partial", "unavailable"]
    unavailable_reason: str | None
    currency: str | None
    start_date: datetime | None
    end_date: datetime | None
    raw_row_count: int
    event_count: int
    duplicate_event_count: int
    imported_file_count: int
    parser_version: str


@dataclass(frozen=True, slots=True)
class CfdMoneyOutcome(_Serializable):
    status: Literal["available", "partial", "unavailable"]
    unavailable_reason: str | None
    source: str
    opening_realised_cash_equity_proxy_gbp: Decimal
    ending_realised_cash_equity_proxy_gbp: Decimal
    deposits_gbp: Decimal
    withdrawals_gbp: Decimal
    internal_transfers_gbp: Decimal
    adjustments_gbp: Decimal
    account_cash_flow_gbp: Decimal
    household_external_flow_gbp: Decimal
    net_realised_pnl_gbp: Decimal
    max_realised_pnl_drawdown_gbp: Decimal
    current_realised_pnl_drawdown_gbp: Decimal
    true_nav_available: bool = False


@dataclass(frozen=True, slots=True)
class CfdStrategyRisk(_Serializable):
    status: Literal["unavailable"]
    unavailable_reason: str
    true_nav_available: bool
    twr_total_return: None = None
    sharpe: None = None
    sortino: None = None
    calmar: None = None
    information_ratio: None = None
    annualized_volatility: None = None
    max_drawdown_rate: None = None
    current_drawdown_rate: None = None


@dataclass(frozen=True, slots=True)
class CfdPhaseEvidence(_Serializable):
    type: str
    occurred_at: datetime
    amount_gbp: Decimal
    detail: str


@dataclass(frozen=True, slots=True)
class CfdPhaseContributor(_Serializable):
    key: str
    event_count: int
    realised_pnl: Decimal


@dataclass(frozen=True, slots=True)
class CfdPhase(_Serializable):
    phase_id: str
    classification: str
    start_date: datetime
    end_date: datetime
    opening_realised_cash_equity_proxy_gbp: Decimal
    ending_realised_cash_equity_proxy_gbp: Decimal
    account_cash_flow_gbp: Decimal
    household_external_flow_gbp: Decimal
    realised_pnl_gbp: Decimal
    max_realised_pnl_drawdown_gbp: Decimal
    ending_realised_pnl_drawdown_gbp: Decimal
    top_contributors: tuple[CfdPhaseContributor, ...]
    top_detractors: tuple[CfdPhaseContributor, ...]
    evidence_events: tuple[CfdPhaseEvidence, ...]


@dataclass(frozen=True, slots=True)
class CfdPhases(_Serializable):
    status: Literal["available", "unavailable"]
    unavailable_reason: str | None
    method: str
    method_version: str
    items: tuple[CfdPhase, ...]


@dataclass(frozen=True, slots=True)
class CfdStructuralDiagnostics(_Serializable):
    status: Literal["available", "partial", "unavailable"]
    unavailable_reason: str | None
    observable_only: bool
    psychology_inferred: bool
    total_closed_notional: Decimal
    average_closed_notional: Decimal | None
    net_realised_to_notional_ratio: Decimal | None
    financing_cost_to_notional_ratio: Decimal | None
    best_trade_concentration: Decimal | None
    top_three_trade_concentration: Decimal | None
    net_without_best_trade: Decimal | None
    by_direction: tuple[CfdAttributionBucket, ...]
    missing_notional_trade_count: int


@dataclass(frozen=True, slots=True)
class CfdEndingRisk(_Serializable):
    status: Literal["unavailable"]
    unavailable_reason: str
    true_mtm_available: bool
    unmatched_executed_order_count: int
    warnings: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CfdAnalysis(_Serializable):
    currency: str | None
    event_count: int
    coverage_start: datetime | None
    coverage_end: datetime | None
    coverage: CfdReviewCoverage
    money_outcome: CfdMoneyOutcome
    strategy_risk: CfdStrategyRisk
    phases: CfdPhases
    cash_flows: CfdCashFlowSummary
    realised_pnl: CfdRealisedPnlSummary
    trade_quality: CfdTradeQuality
    attribution: CfdAttribution
    realised_series: tuple[CfdRealisedPoint, ...]
    notional: CfdNotionalSummary
    structural_diagnostics: CfdStructuralDiagnostics
    ending_risk: CfdEndingRisk
    unmatched_executed_orders: tuple[CfdUnmatchedExecutedOrder, ...]
    warnings: tuple[str, ...]
    calculation_version: str = CALCULATION_VERSION


def _header_lookup(fieldnames: Iterable[str]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for header in fieldnames:
        normalized = header.strip().casefold()
        if not normalized:
            raise CfdSchemaError("CFD CSV contains a blank column heading")
        if normalized in lookup:
            raise CfdSchemaError(f"CFD CSV contains a duplicate column heading: {header!r}")
        lookup[normalized] = header
    return lookup


def _resolve_header(lookup: Mapping[str, str], canonical: str) -> str | None:
    for alias in _HEADERS[canonical]:
        if resolved := lookup.get(alias.casefold()):
            return resolved
    return None


def _row_value(row: Mapping[str, str], lookup: Mapping[str, str], canonical: str) -> str:
    header = _resolve_header(lookup, canonical)
    return (row.get(header, "") if header else "").strip()


def _require_header(lookup: Mapping[str, str], canonical: str, *, context: str) -> None:
    if _resolve_header(lookup, canonical) is None:
        expected = " or ".join(repr(item) for item in _HEADERS[canonical])
        raise CfdSchemaError(f"{context} requires column {expected}")


def _require_value(value: str, *, field: str, context: str) -> str:
    if not value:
        raise CfdSchemaError(f"{context} is missing required value {field!r}")
    return value


def _decimal(value: str, *, field: str, context: str, required: bool = False) -> Decimal | None:
    if not value:
        if required:
            raise CfdSchemaError(f"{context} is missing required numeric value {field!r}")
        return None
    normalized = value.replace(",", "").replace("£", "").strip()
    if normalized.startswith("(") and normalized.endswith(")"):
        normalized = f"-{normalized[1:-1]}"
    try:
        return Decimal(normalized)
    except InvalidOperation as exc:
        raise CfdSchemaError(f"{context} contains invalid decimal {field!r}: {value!r}") from exc


def _timestamp(value: str, *, field: str, context: str, required: bool = False) -> datetime | None:
    if not value:
        if required:
            raise CfdSchemaError(f"{context} is missing required timestamp {field!r}")
        return None
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise CfdSchemaError(f"{context} contains invalid timestamp {field!r}: {value!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _normalized_optional(value: str) -> str | None:
    return value or None


def _notional_account_currency(
    *,
    units: Decimal | None,
    average_price: Decimal | None,
    exchange_rate: Decimal | None,
    instrument_currency: str | None,
    account_currency: str,
) -> Decimal | None:
    if units is None or average_price is None:
        return None
    notional = abs(units * average_price)
    instrument_code = (instrument_currency or "").upper()
    account_code = account_currency.upper()
    if instrument_code in {"GBX", "GBPENCE", "GBP PENCE"} and account_code == "GBP":
        return notional / Decimal(100)
    if not instrument_code or instrument_code == account_code:
        return notional
    if exchange_rate is None or exchange_rate == 0:
        return None
    # Trading 212 exports quote Exchange rate as instrument-currency units per
    # account-currency unit (for example USD per GBP), hence division.
    return notional / exchange_rate


def _event_identity(record_type: CfdRecordType, values: Mapping[str, Any]) -> str:
    transaction_id = values.get("transaction_id")
    order_id = values.get("order_id")
    position_id = values.get("position_id")
    occurred_at = values["occurred_at"]
    if record_type == "Transaction" and transaction_id:
        identity = f"transaction|{transaction_id}"
    elif record_type == "Order" and order_id:
        identity = f"order|{order_id}"
    elif record_type == "Closed position" and position_id and order_id:
        identity = f"closed|{position_id}|{order_id}"
    elif record_type == "Closed position" and position_id:
        identity = f"closed|{position_id}|{occurred_at.isoformat()}"
    else:
        components = [
            record_type,
            occurred_at.isoformat(),
            values.get("account_currency"),
            position_id,
            order_id,
            values.get("instrument"),
            values.get("symbol"),
            values.get("direction"),
            values.get("units"),
            values.get("amount"),
            values.get("dividend_net"),
            values.get("gross_result"),
        ]
        identity = "|".join("" if item is None else str(item) for item in components)
    return "cfd_" + hashlib.sha256(identity.encode()).hexdigest()[:32]


def _validate_type_headers(
    record_type: CfdRecordType, lookup: Mapping[str, str], *, context: str
) -> None:
    required = {
        "Transaction": ("transaction_type", "amount"),
        "Closed position": (
            "position_id",
            "opened_at",
            "closed_at",
            "direction",
            "units",
            "result",
        ),
        "Overnight interest": ("position_id", "amount"),
        "Dividend adjustment": ("position_id",),
        "Order": ("order_id", "status", "intent"),
    }[record_type]
    for canonical in required:
        _require_header(lookup, canonical, context=context)
    if record_type == "Dividend adjustment" and not (
        _resolve_header(lookup, "dividend_net") or _resolve_header(lookup, "dividend_gross")
    ):
        raise CfdSchemaError(
            f"{context} requires 'Amount net (account currency)' or "
            "'Amount gross (account currency)'"
        )


def _parse_event(
    row: Mapping[str, str],
    lookup: Mapping[str, str],
    *,
    source_name: str,
    row_number: int,
) -> tuple[CfdEvent, tuple[str, ...]]:
    context = f"{source_name} row {row_number}"
    raw_record_type = _require_value(
        _row_value(row, lookup, "record_type"), field="Record Type", context=context
    )
    record_type = _RECORD_TYPES.get(raw_record_type.casefold())
    if record_type is None:
        raise CfdRecordTypeError(f"{context} has unknown Record Type {raw_record_type!r}")
    _validate_type_headers(record_type, lookup, context=context)

    occurred_at = _timestamp(
        _row_value(row, lookup, "occurred_at"),
        field="Date (UTC)",
        context=context,
        required=True,
    )
    if occurred_at is None:  # pragma: no cover - guarded by required=True
        raise CfdSchemaError(f"{context} is missing Date (UTC)")
    account_currency = _require_value(
        _row_value(row, lookup, "account_currency"),
        field="Account currency",
        context=context,
    ).upper()
    transaction_type = _normalized_optional(_row_value(row, lookup, "transaction_type"))
    if record_type == "Transaction":
        transaction_type = _require_value(
            transaction_type or "", field="Transaction type", context=context
        )
        normalized_transaction_type = _TRANSACTION_TYPES.get(transaction_type.casefold())
        if normalized_transaction_type is None:
            raise CfdRecordTypeError(f"{context} has unknown Transaction type {transaction_type!r}")
        transaction_type = normalized_transaction_type

    amount = _decimal(
        _row_value(row, lookup, "amount"),
        field="Amount (account currency)",
        context=context,
        required=record_type in {"Transaction", "Overnight interest"},
    )
    dividend_gross = _decimal(
        _row_value(row, lookup, "dividend_gross"),
        field="Amount gross (account currency)",
        context=context,
    )
    dividend_net = _decimal(
        _row_value(row, lookup, "dividend_net"),
        field="Amount net (account currency)",
        context=context,
    )
    if record_type == "Dividend adjustment" and dividend_net is None:
        dividend_net = dividend_gross
    if record_type == "Dividend adjustment" and dividend_net is None:
        raise CfdSchemaError(f"{context} has no dividend amount")

    units = _decimal(
        _row_value(row, lookup, "units"),
        field="Units",
        context=context,
        required=record_type == "Closed position",
    )
    average_price = _decimal(
        _row_value(row, lookup, "average_price"),
        field="Average price (instrument currency)",
        context=context,
    )
    exchange_rate = _decimal(
        _row_value(row, lookup, "exchange_rate"), field="Exchange rate", context=context
    )
    instrument_currency = _normalized_optional(_row_value(row, lookup, "instrument_currency"))
    values: dict[str, Any] = {
        "record_type": record_type,
        "occurred_at": occurred_at,
        "account_currency": account_currency,
        "instrument": _normalized_optional(_row_value(row, lookup, "instrument")),
        "symbol": _normalized_optional(_row_value(row, lookup, "symbol")),
        "instrument_currency": instrument_currency,
        "direction": _normalized_optional(_row_value(row, lookup, "direction")),
        "units": units,
        "position_id": _normalized_optional(_row_value(row, lookup, "position_id")),
        "order_id": _normalized_optional(_row_value(row, lookup, "order_id")),
        "transaction_id": _normalized_optional(_row_value(row, lookup, "transaction_id")),
        "transaction_type": transaction_type,
        "order_type": _normalized_optional(_row_value(row, lookup, "order_type")),
        "order_intent": _normalized_optional(_row_value(row, lookup, "intent")),
        "order_status": _normalized_optional(_row_value(row, lookup, "status")),
        "created_at": _timestamp(
            _row_value(row, lookup, "created_at"), field="Date created (UTC)", context=context
        ),
        "opened_at": _timestamp(
            _row_value(row, lookup, "opened_at"),
            field="Date opened (UTC)",
            context=context,
            required=record_type == "Closed position",
        ),
        "closed_at": _timestamp(
            _row_value(row, lookup, "closed_at"),
            field="Date closed (UTC)",
            context=context,
            required=record_type == "Closed position",
        ),
        "average_price": average_price,
        "close_price": _decimal(
            _row_value(row, lookup, "close_price"),
            field="Close price (instrument currency)",
            context=context,
        ),
        "executed_price": _decimal(
            _row_value(row, lookup, "executed_price"),
            field="Executed price (instrument currency)",
            context=context,
        ),
        "exchange_rate": exchange_rate,
        "amount": amount,
        "gross_result": _decimal(
            _row_value(row, lookup, "result"),
            field="Result (account currency)",
            context=context,
            required=record_type == "Closed position",
        ),
        "fx_fee": _decimal(
            _row_value(row, lookup, "fx_fee"),
            field="FX fee (account currency)",
            context=context,
        ),
        "result_after_fx_fee": _decimal(
            _row_value(row, lookup, "result_after_fx"),
            field="Result after FX fee (account currency)",
            context=context,
        ),
        "embedded_overnight_interest": _decimal(
            _row_value(row, lookup, "embedded_overnight"),
            field="Overnight interest (account currency)",
            context=context,
        ),
        "embedded_dividend_adjustment": _decimal(
            _row_value(row, lookup, "embedded_dividend"),
            field="Dividend adjustment (account currency)",
            context=context,
        ),
        "broker_total_result": _decimal(
            _row_value(row, lookup, "total_result"),
            field="Total result (account currency)",
            context=context,
        ),
        "dividend_gross": dividend_gross,
        "withholding_tax": _decimal(
            _row_value(row, lookup, "withholding_tax"),
            field="Withholding tax (account currency)",
            context=context,
        ),
        "dividend_net": dividend_net,
        "notional_account_currency": _notional_account_currency(
            units=units,
            average_price=average_price,
            exchange_rate=exchange_rate,
            instrument_currency=instrument_currency,
            account_currency=account_currency,
        ),
        "info": _normalized_optional(_row_value(row, lookup, "info")),
    }
    if record_type == "Closed position" and values["result_after_fx_fee"] is None:
        values["result_after_fx_fee"] = (values["gross_result"] or Decimal(0)) + (
            values["fx_fee"] or Decimal(0)
        )

    if record_type in {"Closed position", "Overnight interest"}:
        _require_value(values["position_id"] or "", field="Position ID", context=context)
    if record_type == "Closed position":
        _require_value(values["direction"] or "", field="Direction", context=context)
    if record_type == "Order":
        _require_value(values["order_id"] or "", field="Order ID", context=context)
        values["order_status"] = _require_value(
            values["order_status"] or "", field="Status", context=context
        ).upper()
        if values["order_intent"]:
            values["order_intent"] = values["order_intent"].upper()

    warnings: list[str] = []
    if record_type == "Closed position":
        expected_after_fx = (values["gross_result"] or Decimal(0)) + (
            values["fx_fee"] or Decimal(0)
        )
        if abs(values["result_after_fx_fee"] - expected_after_fx) > Decimal("0.01"):
            warnings.append(f"{context}: Result after FX fee does not reconcile to Result + FX fee")
    if record_type == "Transaction" and transaction_type == "Transfer" and not values["info"]:
        warnings.append(
            f"{context}: internal Transfer has no Info value describing the counter-account"
        )

    raw_columns = tuple((str(key), value or "") for key, value in row.items())
    unknown_columns = tuple(
        (str(key), value or "")
        for key, value in row.items()
        if str(key).casefold() not in _KNOWN_HEADERS and (value or "").strip()
    )
    provenance = CfdEventProvenance(
        source_name=source_name,
        row_number=row_number,
        raw_columns=raw_columns,
        unknown_columns=unknown_columns,
    )
    event_id = _event_identity(record_type, values)
    return CfdEvent(event_id=event_id, provenance=(provenance,), **values), tuple(warnings)


def parse_cfd_csv_bytes(content: bytes, source_name: str) -> CfdParsedFile:
    """Parse one Trading 212 CFD export from bytes without filesystem writes."""

    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CfdCsvError(f"{source_name} is not valid UTF-8 CSV") from exc
    return _parse_cfd_csv(
        text, source_name=source_name, file_sha256=hashlib.sha256(content).hexdigest()
    )


def parse_cfd_csv_text(content: str, source_name: str) -> CfdParsedFile:
    """Parse one Trading 212 CFD export from text without filesystem writes."""

    encoded = content.encode("utf-8")
    return _parse_cfd_csv(
        content.lstrip("\ufeff"),
        source_name=source_name,
        file_sha256=hashlib.sha256(encoded).hexdigest(),
    )


def _parse_cfd_csv(content: str, *, source_name: str, file_sha256: str) -> CfdParsedFile:
    reader = csv.DictReader(io.StringIO(content, newline=""))
    if reader.fieldnames is None:
        raise CfdSchemaError(f"{source_name} has no CSV header")
    schema_columns = tuple(header.strip() for header in reader.fieldnames)
    lookup = _header_lookup(schema_columns)
    for required in ("record_type", "occurred_at", "account_currency"):
        _require_header(lookup, required, context=source_name)

    events: list[CfdEvent] = []
    warnings: list[str] = []
    for row_number, raw_row in enumerate(reader, start=2):
        if None in raw_row:
            raise CfdSchemaError(f"{source_name} row {row_number} has more values than columns")
        row = {str(key).strip(): value or "" for key, value in raw_row.items()}
        if not any(value.strip() for value in row.values()):
            continue
        event, event_warnings = _parse_event(
            row, lookup, source_name=source_name, row_number=row_number
        )
        events.append(event)
        warnings.extend(event_warnings)

    if not events:
        raise CfdSchemaError(f"{source_name} contains no CFD records")
    timestamps = [event.occurred_at for event in events]
    return CfdParsedFile(
        source_name=source_name,
        file_sha256=file_sha256,
        parser_version=PARSER_VERSION,
        schema_columns=schema_columns,
        raw_row_count=len(events),
        events=tuple(events),
        coverage_start=min(timestamps),
        coverage_end=max(timestamps),
        latest_event_at=max(timestamps),
        warnings=tuple(warnings),
    )


def _event_economic_identity(event: CfdEvent) -> tuple[Any, ...]:
    common = (event.record_type, event.occurred_at, event.account_currency)
    if event.record_type == "Transaction":
        return (*common, event.transaction_id, event.transaction_type, event.amount)
    if event.record_type == "Order":
        return (
            *common,
            event.order_id,
            event.position_id,
            event.order_status,
            event.order_intent,
            event.direction,
            event.units,
            event.executed_price,
        )
    if event.record_type == "Closed position":
        return (
            *common,
            event.position_id,
            event.order_id,
            event.direction,
            event.units,
            event.gross_result,
            event.fx_fee,
            event.result_after_fx_fee,
        )
    # Unkeyed standalone events use all economic fields in event_id itself.
    return (*common, event.event_id)


def combine_cfd_ledgers(files: Iterable[CfdParsedFile]) -> CfdLedger:
    """Combine parsed files and stably deduplicate overlapping broker events."""

    parsed_files = tuple(files)
    if not parsed_files:
        return CfdLedger(
            parser_version=PARSER_VERSION,
            source_files=(),
            raw_row_count=0,
            events=(),
            duplicate_event_count=0,
            coverage_start=None,
            coverage_end=None,
            latest_event_at=None,
            account_currencies=(),
        )
    versions = {parsed.parser_version for parsed in parsed_files}
    if versions != {PARSER_VERSION}:
        raise CfdSchemaError(f"cannot combine CFD parser versions: {sorted(versions)}")

    by_id: dict[str, CfdEvent] = {}
    duplicate_count = 0
    warnings = [warning for parsed in parsed_files for warning in parsed.warnings]
    seen_file_hashes: set[str] = set()
    for parsed in parsed_files:
        if parsed.file_sha256 in seen_file_hashes:
            warnings.append(f"duplicate CFD export content supplied: {parsed.source_name}")
        seen_file_hashes.add(parsed.file_sha256)
        for event in parsed.events:
            existing = by_id.get(event.event_id)
            if existing is None:
                by_id[event.event_id] = event
                continue
            if _event_economic_identity(existing) != _event_economic_identity(event):
                raise CfdDuplicateConflictError(
                    f"conflicting CFD rows share canonical event ID {event.event_id}"
                )
            duplicate_count += 1
            provenance = tuple(dict.fromkeys((*existing.provenance, *event.provenance)))
            by_id[event.event_id] = replace(existing, provenance=provenance)

    events = tuple(sorted(by_id.values(), key=lambda event: (event.occurred_at, event.event_id)))
    timestamps = [event.occurred_at for event in events]
    return CfdLedger(
        parser_version=PARSER_VERSION,
        source_files=tuple(parsed.summary() for parsed in parsed_files),
        raw_row_count=sum(parsed.raw_row_count for parsed in parsed_files),
        events=events,
        duplicate_event_count=duplicate_count,
        coverage_start=min(timestamps) if timestamps else None,
        coverage_end=max(timestamps) if timestamps else None,
        latest_event_at=max(timestamps) if timestamps else None,
        account_currencies=tuple(sorted({event.account_currency for event in events})),
        warnings=tuple(dict.fromkeys(warnings)),
    )


def _zero_if_none(value: Decimal | None) -> Decimal:
    return value if value is not None else Decimal(0)


def _closed_after_fx(event: CfdEvent) -> Decimal:
    if event.result_after_fx_fee is not None:
        return event.result_after_fx_fee
    return _zero_if_none(event.gross_result) + _zero_if_none(event.fx_fee)


def _standalone_by_position(
    events: Iterable[CfdEvent], record_type: CfdRecordType
) -> dict[str, Decimal]:
    result: dict[str, Decimal] = defaultdict(Decimal)
    for event in events:
        if event.record_type != record_type or not event.position_id:
            continue
        amount = event.amount if record_type == "Overnight interest" else event.dividend_net
        result[event.position_id] += _zero_if_none(amount)
    return dict(result)


def _trade_result(
    event: CfdEvent,
    overnight_by_position: Mapping[str, Decimal],
    dividend_by_position: Mapping[str, Decimal],
) -> Decimal:
    result = _closed_after_fx(event)
    position_id = event.position_id or ""
    result += overnight_by_position.get(
        position_id, _zero_if_none(event.embedded_overnight_interest)
    )
    result += dividend_by_position.get(
        position_id, _zero_if_none(event.embedded_dividend_adjustment)
    )
    return result


def _ratio(numerator: Decimal, denominator: Decimal) -> Decimal | None:
    return numerator / denominator if denominator != 0 else None


def _decimal_mean(values: list[Decimal]) -> Decimal | None:
    return sum(values, Decimal(0)) / len(values) if values else None


def _longest_streak(results: list[Decimal], *, winning: bool) -> int:
    longest = current = 0
    for result in results:
        matches = result > 0 if winning else result < 0
        current = current + 1 if matches else 0
        longest = max(longest, current)
    return longest


def _duration_hours(event: CfdEvent) -> Decimal | None:
    if event.opened_at is None or event.closed_at is None:
        return None
    return Decimal(str((event.closed_at - event.opened_at).total_seconds())) / Decimal(3600)


def _duration_bucket(event: CfdEvent) -> str:
    hours = _duration_hours(event)
    if hours is None:
        return "unknown"
    if hours < 1:
        return "under_1_hour"
    if hours < 24:
        return "same_day_1_to_24_hours"
    if hours < 24 * 8:
        return "1_to_7_days"
    if hours < 24 * 31:
        return "8_to_30_days"
    return "31_days_or_more"


def _canonical_direction(direction: str | None) -> str:
    normalized = (direction or "").strip().casefold()
    if normalized in {"buy", "long"}:
        return "long"
    if normalized in {"sell", "short"}:
        return "short"
    return normalized or "unknown"


def _attribution_buckets(
    trades: list[tuple[CfdEvent, Decimal]], key_function: Callable[[CfdEvent], str]
) -> tuple[CfdAttributionBucket, ...]:
    values: dict[str, list[Decimal]] = defaultdict(list)
    for event, result in trades:
        values[str(key_function(event))].append(result)
    return tuple(
        CfdAttributionBucket(key=key, trade_count=len(results), net_realised_pnl=sum(results))
        for key, results in sorted(values.items(), key=lambda item: (-sum(item[1]), item[0]))
    )


def _cash_flows(events: Iterable[CfdEvent]) -> CfdCashFlowSummary:
    totals = defaultdict(Decimal)
    for event in events:
        if event.record_type == "Transaction" and event.transaction_type:
            totals[event.transaction_type] += _zero_if_none(event.amount)
    return CfdCashFlowSummary(
        deposits=totals["Deposit"],
        withdrawals=totals["Withdrawal"],
        internal_transfers=totals["Transfer"],
        adjustments=totals["Adjustment"],
        account_cash_flow=sum(totals.values(), Decimal(0)),
        household_external_flow=totals["Deposit"] + totals["Withdrawal"],
    )


def _realised_series(
    events: tuple[CfdEvent, ...],
    overnight_by_position: Mapping[str, Decimal],
    dividend_by_position: Mapping[str, Decimal],
) -> tuple[CfdRealisedPoint, ...]:
    cumulative_pnl = Decimal(0)
    cumulative_cash_flow = Decimal(0)
    running_max = Decimal(0)
    points: list[CfdRealisedPoint] = []
    for event in events:
        pnl_change = Decimal(0)
        cash_change = Decimal(0)
        if event.record_type == "Closed position":
            pnl_change = _closed_after_fx(event)
            position_id = event.position_id or ""
            if position_id not in overnight_by_position:
                pnl_change += _zero_if_none(event.embedded_overnight_interest)
            if position_id not in dividend_by_position:
                pnl_change += _zero_if_none(event.embedded_dividend_adjustment)
        elif event.record_type == "Overnight interest":
            pnl_change = _zero_if_none(event.amount)
        elif event.record_type == "Dividend adjustment":
            pnl_change = _zero_if_none(event.dividend_net)
        elif event.record_type == "Transaction":
            cash_change = _zero_if_none(event.amount)
        else:
            continue
        cumulative_pnl += pnl_change
        cumulative_cash_flow += cash_change
        running_max = max(running_max, cumulative_pnl)
        points.append(
            CfdRealisedPoint(
                occurred_at=event.occurred_at,
                event_id=event.event_id,
                record_type=event.record_type,
                realised_pnl_change=pnl_change,
                cumulative_realised_pnl=cumulative_pnl,
                account_cash_flow_change=cash_change,
                cumulative_account_cash_flow=cumulative_cash_flow,
                realised_cash_equity_proxy=cumulative_cash_flow + cumulative_pnl,
                realised_pnl_drawdown=cumulative_pnl - running_max,
            )
        )
    return tuple(points)


def _trade_quality(trades: list[tuple[CfdEvent, Decimal]]) -> CfdTradeQuality:
    results = [result for _, result in trades]
    wins = [result for result in results if result > 0]
    losses = [result for result in results if result < 0]
    durations = [
        duration for event, _ in trades if (duration := _duration_hours(event)) is not None
    ]
    total = sum(results, Decimal(0))
    sorted_positive = sorted(wins, reverse=True)
    best = max(results) if results else None
    return CfdTradeQuality(
        trade_count=len(results),
        wins=len(wins),
        losses=len(losses),
        breakeven=len(results) - len(wins) - len(losses),
        win_rate=_ratio(Decimal(len(wins)), Decimal(len(results))),
        average_win=_decimal_mean(wins),
        average_loss=_decimal_mean(losses),
        payoff_ratio=(
            _ratio(_decimal_mean(wins) or Decimal(0), abs(_decimal_mean(losses) or Decimal(0)))
            if wins and losses
            else None
        ),
        profit_factor=_ratio(sum(wins, Decimal(0)), abs(sum(losses, Decimal(0)))),
        expectancy=_decimal_mean(results),
        average_duration_hours=_decimal_mean(durations),
        median_duration_hours=(Decimal(str(statistics.median(durations))) if durations else None),
        same_day_count=sum(duration < 24 for duration in durations),
        under_one_hour_count=sum(duration < 1 for duration in durations),
        best_trade=best,
        worst_trade=min(results) if results else None,
        longest_win_streak=_longest_streak(results, winning=True),
        longest_loss_streak=_longest_streak(results, winning=False),
        best_trade_concentration=(
            _ratio(best, sum(wins, Decimal(0))) if best is not None and best > 0 else None
        ),
        top_three_trade_concentration=(
            _ratio(sum(sorted_positive[:3], Decimal(0)), sum(wins, Decimal(0)))
            if sorted_positive
            else None
        ),
        net_without_best_trade=total - best if best is not None else None,
    )


def _unmatched_executed_orders(
    events: tuple[CfdEvent, ...],
) -> tuple[CfdUnmatchedExecutedOrder, ...]:
    closed_position_ids = {
        event.position_id
        for event in events
        if event.record_type == "Closed position" and event.position_id
    }
    result = []
    for event in events:
        if event.record_type != "Order" or (event.order_status or "").upper() != "EXECUTED":
            continue
        if event.position_id and event.position_id in closed_position_ids:
            continue
        result.append(
            CfdUnmatchedExecutedOrder(
                event_id=event.event_id,
                order_id=event.order_id,
                position_id=event.position_id,
                occurred_at=event.occurred_at,
                symbol=event.symbol,
                direction=event.direction,
                intent=event.order_intent,
            )
        )
    return tuple(result)


def _phase_state(
    *,
    opening_proxy: Decimal,
    cash_flow: Decimal,
    realised_pnl: Decimal,
    previous_drawdown: Decimal,
    ending_drawdown: Decimal,
) -> str:
    large_flow_threshold = max(Decimal(100), abs(opening_proxy) * Decimal("0.25"))
    if abs(cash_flow) >= large_flow_threshold:
        return "large_cash_flow"
    if realised_pnl < 0 and ending_drawdown < previous_drawdown:
        return "drawdown_formation"
    if realised_pnl > 0 and previous_drawdown < 0 and ending_drawdown > previous_drawdown:
        return "drawdown_recovery"
    if realised_pnl > 0:
        return "profit_phase"
    if realised_pnl < 0:
        return "loss_phase"
    if cash_flow != 0:
        return "cash_flow_phase"
    return "flat_phase"


def _phase_contributors(
    points: Iterable[CfdRealisedPoint],
    event_by_id: Mapping[str, CfdEvent],
) -> tuple[tuple[CfdPhaseContributor, ...], tuple[CfdPhaseContributor, ...]]:
    totals: dict[str, Decimal] = defaultdict(Decimal)
    counts: dict[str, int] = defaultdict(int)
    for point in points:
        if point.realised_pnl_change == 0:
            continue
        event = event_by_id[point.event_id]
        key = event.symbol or event.instrument or event.record_type
        totals[key] += point.realised_pnl_change
        counts[key] += 1
    buckets = [
        CfdPhaseContributor(key=key, event_count=counts[key], realised_pnl=value)
        for key, value in totals.items()
    ]
    contributors = tuple(
        sorted(
            (bucket for bucket in buckets if bucket.realised_pnl > 0),
            key=lambda bucket: (-bucket.realised_pnl, bucket.key),
        )[:3]
    )
    detractors = tuple(
        sorted(
            (bucket for bucket in buckets if bucket.realised_pnl < 0),
            key=lambda bucket: (bucket.realised_pnl, bucket.key),
        )[:3]
    )
    return contributors, detractors


def _phase_evidence(points: list[CfdRealisedPoint]) -> tuple[CfdPhaseEvidence, ...]:
    first = points[0]
    last = points[-1]
    largest_pnl = max(points, key=lambda point: abs(point.realised_pnl_change))
    trough = min(points, key=lambda point: point.realised_pnl_drawdown)
    largest_flow = max(points, key=lambda point: abs(point.account_cash_flow_change))
    candidates = [
        CfdPhaseEvidence(
            type="phase_start",
            occurred_at=first.occurred_at,
            amount_gbp=first.realised_pnl_change,
            detail="first canonical event in this deterministic phase",
        ),
        CfdPhaseEvidence(
            type="largest_absolute_realised_change",
            occurred_at=largest_pnl.occurred_at,
            amount_gbp=largest_pnl.realised_pnl_change,
            detail="largest absolute realised P&L event in this phase",
        ),
        CfdPhaseEvidence(
            type="realised_drawdown_trough",
            occurred_at=trough.occurred_at,
            amount_gbp=trough.realised_pnl_drawdown,
            detail="lowest cumulative realised-P&L drawdown in this phase",
        ),
    ]
    if largest_flow.account_cash_flow_change != 0:
        candidates.append(
            CfdPhaseEvidence(
                type="largest_account_cash_flow",
                occurred_at=largest_flow.occurred_at,
                amount_gbp=largest_flow.account_cash_flow_change,
                detail="largest account cash-flow event in this phase",
            )
        )
    if last.event_id != first.event_id:
        candidates.append(
            CfdPhaseEvidence(
                type="phase_end",
                occurred_at=last.occurred_at,
                amount_gbp=last.realised_pnl_change,
                detail="last canonical event in this deterministic phase",
            )
        )
    seen: set[tuple[str, str]] = set()
    evidence: list[CfdPhaseEvidence] = []
    for item in candidates:
        identity = (item.type, item.occurred_at.isoformat())
        if identity not in seen:
            seen.add(identity)
            evidence.append(item)
    return tuple(evidence)


def _cfd_phases(
    series: tuple[CfdRealisedPoint, ...],
    events: tuple[CfdEvent, ...],
) -> CfdPhases:
    method = "daily realised money-state machine; contiguous equal states form phases"
    if len(series) < 2:
        return CfdPhases(
            status="unavailable",
            unavailable_reason=(
                "deterministic CFD phase segmentation requires at least two realised/cash events"
            ),
            method=method,
            method_version=CALCULATION_VERSION,
            items=(),
        )

    event_by_id = {event.event_id: event for event in events}
    daily: list[dict[str, Any]] = []
    for point in series:
        day = point.occurred_at.date()
        if not daily or daily[-1]["day"] != day:
            opening = (
                point.realised_cash_equity_proxy
                - point.realised_pnl_change
                - point.account_cash_flow_change
            )
            daily.append(
                {
                    "day": day,
                    "opening_proxy": opening,
                    "ending_proxy": point.realised_cash_equity_proxy,
                    "cash_flow": point.account_cash_flow_change,
                    "realised_pnl": point.realised_pnl_change,
                    "ending_drawdown": point.realised_pnl_drawdown,
                    "points": [point],
                }
            )
        else:
            daily[-1]["ending_proxy"] = point.realised_cash_equity_proxy
            daily[-1]["cash_flow"] += point.account_cash_flow_change
            daily[-1]["realised_pnl"] += point.realised_pnl_change
            daily[-1]["ending_drawdown"] = point.realised_pnl_drawdown
            daily[-1]["points"].append(point)

    previous_drawdown = Decimal(0)
    for observation in daily:
        observation["classification"] = _phase_state(
            opening_proxy=observation["opening_proxy"],
            cash_flow=observation["cash_flow"],
            realised_pnl=observation["realised_pnl"],
            previous_drawdown=previous_drawdown,
            ending_drawdown=observation["ending_drawdown"],
        )
        previous_drawdown = observation["ending_drawdown"]

    groups: list[list[dict[str, Any]]] = []
    for observation in daily:
        if not groups or groups[-1][-1]["classification"] != observation["classification"]:
            groups.append([observation])
        else:
            groups[-1].append(observation)

    phases: list[CfdPhase] = []
    for index, group in enumerate(groups, start=1):
        points = [point for observation in group for point in observation["points"]]
        event_ids = {point.event_id for point in points}
        household_flow = sum(
            (
                event.amount or Decimal(0)
                for event in events
                if event.event_id in event_ids
                and event.record_type == "Transaction"
                and event.transaction_type in {"Deposit", "Withdrawal"}
            ),
            Decimal(0),
        )
        contributors, detractors = _phase_contributors(points, event_by_id)
        phases.append(
            CfdPhase(
                phase_id=f"cfd-phase-{index}",
                classification=group[0]["classification"],
                start_date=points[0].occurred_at,
                end_date=points[-1].occurred_at,
                opening_realised_cash_equity_proxy_gbp=group[0]["opening_proxy"],
                ending_realised_cash_equity_proxy_gbp=group[-1]["ending_proxy"],
                account_cash_flow_gbp=sum(
                    (observation["cash_flow"] for observation in group), Decimal(0)
                ),
                household_external_flow_gbp=household_flow,
                realised_pnl_gbp=sum(
                    (observation["realised_pnl"] for observation in group), Decimal(0)
                ),
                max_realised_pnl_drawdown_gbp=min(point.realised_pnl_drawdown for point in points),
                ending_realised_pnl_drawdown_gbp=points[-1].realised_pnl_drawdown,
                top_contributors=contributors,
                top_detractors=detractors,
                evidence_events=_phase_evidence(points),
            )
        )
    return CfdPhases(
        status="available",
        unavailable_reason=None,
        method=method,
        method_version=CALCULATION_VERSION,
        items=tuple(phases),
    )


def analyse_cfd_ledger(ledger: CfdLedger) -> CfdAnalysis:
    """Calculate realised-only CFD cash, P&L, trade, and risk diagnostics."""

    events = ledger.events
    closed = [event for event in events if event.record_type == "Closed position"]
    overnight_by_position = _standalone_by_position(events, "Overnight interest")
    dividend_by_position = _standalone_by_position(events, "Dividend adjustment")
    trades = [
        (event, _trade_result(event, overnight_by_position, dividend_by_position))
        for event in closed
    ]
    closed_gross = sum((_zero_if_none(event.gross_result) for event in closed), Decimal(0))
    fx_fees = sum((_zero_if_none(event.fx_fee) for event in closed), Decimal(0))
    closed_after_fx = sum((_closed_after_fx(event) for event in closed), Decimal(0))
    standalone_overnight = sum(
        (
            _zero_if_none(event.amount)
            for event in events
            if event.record_type == "Overnight interest"
        ),
        Decimal(0),
    )
    embedded_overnight_fallback = sum(
        (
            _zero_if_none(event.embedded_overnight_interest)
            for event in closed
            if (event.position_id or "") not in overnight_by_position
        ),
        Decimal(0),
    )
    standalone_dividends = sum(
        (
            _zero_if_none(event.dividend_net)
            for event in events
            if event.record_type == "Dividend adjustment"
        ),
        Decimal(0),
    )
    embedded_dividend_fallback = sum(
        (
            _zero_if_none(event.embedded_dividend_adjustment)
            for event in closed
            if (event.position_id or "") not in dividend_by_position
        ),
        Decimal(0),
    )
    effective_overnight = standalone_overnight + embedded_overnight_fallback
    effective_dividends = standalone_dividends + embedded_dividend_fallback
    net_realised = closed_after_fx + effective_overnight + effective_dividends
    financing_drag = abs(min(effective_overnight, Decimal(0)))
    series = _realised_series(events, overnight_by_position, dividend_by_position)
    max_drawdown = min((point.realised_pnl_drawdown for point in series), default=Decimal(0))
    notionals = [
        event.notional_account_currency
        for event in closed
        if event.notional_account_currency is not None
    ]
    total_notional = sum(notionals, Decimal(0))
    unmatched = _unmatched_executed_orders(events)
    cash_flows = _cash_flows(events)
    trade_quality = _trade_quality(trades)
    phases = _cfd_phases(series, events)

    warnings = list(ledger.warnings)
    if events:
        warnings.append(
            "CFD exports do not provide daily broker equity or open-position MTM; money and "
            "drawdown fields are realised-only proxies and strategy TWR/risk metrics are unavailable"
        )
    if len(ledger.account_currencies) > 1:
        warnings.append(
            "multiple account currencies are present; aggregate currency analytics are not comparable"
        )
    if unmatched:
        warnings.append(
            "executed orders without a matching closed-position event may be open or outside coverage; "
            "current MTM is unavailable"
        )
    if any(
        event.embedded_overnight_interest and (event.position_id or "") in overnight_by_position
        for event in closed
    ):
        warnings.append(
            "embedded closed-position overnight totals were not added because standalone overnight "
            "events are authoritative"
        )
    if any(
        event.embedded_dividend_adjustment and (event.position_id or "") in dividend_by_position
        for event in closed
    ):
        warnings.append(
            "embedded closed-position dividend totals were not added because standalone dividend "
            "events are authoritative"
        )

    attribution = CfdAttribution(
        by_direction=_attribution_buckets(
            trades, lambda event: _canonical_direction(event.direction)
        ),
        by_instrument=_attribution_buckets(
            trades, lambda event: event.symbol or event.instrument or "unknown"
        ),
        by_duration=_attribution_buckets(trades, _duration_bucket),
        by_date=_attribution_buckets(
            trades, lambda event: (event.closed_at or event.occurred_at).date().isoformat()
        ),
        by_weekday=_attribution_buckets(
            trades, lambda event: (event.closed_at or event.occurred_at).strftime("%A")
        ),
    )
    return CfdAnalysis(
        currency=ledger.account_currencies[0] if len(ledger.account_currencies) == 1 else None,
        event_count=len(events),
        coverage_start=ledger.coverage_start,
        coverage_end=ledger.coverage_end,
        coverage=CfdReviewCoverage(
            status=(
                "unavailable"
                if not events
                else "available"
                if len(ledger.account_currencies) == 1
                else "partial"
            ),
            unavailable_reason=(
                "no canonical CFD events are available"
                if not events
                else (
                    "multiple account currencies prevent one comparable aggregate currency"
                    if len(ledger.account_currencies) > 1
                    else None
                )
            ),
            currency=(
                ledger.account_currencies[0] if len(ledger.account_currencies) == 1 else None
            ),
            start_date=ledger.coverage_start,
            end_date=ledger.coverage_end,
            raw_row_count=ledger.raw_row_count,
            event_count=len(events),
            duplicate_event_count=ledger.duplicate_event_count,
            imported_file_count=len(ledger.source_files),
            parser_version=ledger.parser_version,
        ),
        money_outcome=CfdMoneyOutcome(
            status="partial" if events else "unavailable",
            unavailable_reason=(
                "realised cash-equity proxy excludes open-position MTM and true broker equity"
                if events
                else "no canonical CFD events are available"
            ),
            source="realised_cash_equity_proxy",
            opening_realised_cash_equity_proxy_gbp=Decimal(0),
            ending_realised_cash_equity_proxy_gbp=(
                series[-1].realised_cash_equity_proxy if series else Decimal(0)
            ),
            deposits_gbp=cash_flows.deposits,
            withdrawals_gbp=cash_flows.withdrawals,
            internal_transfers_gbp=cash_flows.internal_transfers,
            adjustments_gbp=cash_flows.adjustments,
            account_cash_flow_gbp=cash_flows.account_cash_flow,
            household_external_flow_gbp=cash_flows.household_external_flow,
            net_realised_pnl_gbp=net_realised,
            max_realised_pnl_drawdown_gbp=max_drawdown,
            current_realised_pnl_drawdown_gbp=(
                series[-1].realised_pnl_drawdown if series else Decimal(0)
            ),
        ),
        strategy_risk=CfdStrategyRisk(
            status="unavailable",
            unavailable_reason=(
                "Trading 212 CFD CSV exports lack daily broker equity and open-position MTM; "
                "TWR, Sharpe, Sortino, Calmar, IR, volatility, and percentage drawdown are not "
                "mathematically available"
            ),
            true_nav_available=False,
        ),
        phases=phases,
        cash_flows=cash_flows,
        realised_pnl=CfdRealisedPnlSummary(
            closed_gross_result=closed_gross,
            fx_fees=fx_fees,
            closed_after_fx=closed_after_fx,
            overnight_interest=effective_overnight,
            dividend_adjustment=effective_dividends,
            net_realised_pnl=net_realised,
            financing_drag_to_gross_ratio=_ratio(financing_drag, abs(closed_gross)),
            financing_drag_to_net_ratio=_ratio(financing_drag, abs(net_realised)),
            max_realised_pnl_drawdown=max_drawdown,
        ),
        trade_quality=trade_quality,
        attribution=attribution,
        realised_series=series,
        notional=CfdNotionalSummary(
            total_closed_notional=total_notional,
            average_closed_notional=_decimal_mean(notionals),
            net_realised_to_notional_ratio=_ratio(net_realised, total_notional),
            financing_cost_to_notional_ratio=_ratio(financing_drag, total_notional),
            missing_notional_trade_count=len(closed) - len(notionals),
        ),
        structural_diagnostics=CfdStructuralDiagnostics(
            status=(
                "unavailable"
                if not trades
                else "partial"
                if len(closed) != len(notionals)
                else "available"
            ),
            unavailable_reason=(
                "closed positions are unavailable for leverage and concentration diagnostics"
                if not trades
                else (
                    f"{len(closed) - len(notionals)} closed positions lack reliable notional"
                    if len(closed) != len(notionals)
                    else None
                )
            ),
            observable_only=True,
            psychology_inferred=False,
            total_closed_notional=total_notional,
            average_closed_notional=_decimal_mean(notionals),
            net_realised_to_notional_ratio=_ratio(net_realised, total_notional),
            financing_cost_to_notional_ratio=_ratio(financing_drag, total_notional),
            best_trade_concentration=trade_quality.best_trade_concentration,
            top_three_trade_concentration=trade_quality.top_three_trade_concentration,
            net_without_best_trade=trade_quality.net_without_best_trade,
            by_direction=attribution.by_direction,
            missing_notional_trade_count=len(closed) - len(notionals),
        ),
        ending_risk=CfdEndingRisk(
            status="unavailable",
            unavailable_reason=(
                "the export does not contain a complete current open-position snapshot, margin "
                "state, or mark-to-market equity"
            ),
            true_mtm_available=False,
            unmatched_executed_order_count=len(unmatched),
            warnings=(
                (
                    f"{len(unmatched)} executed orders are unmatched to a closed position; they are "
                    "risk hints only"
                ),
            )
            if unmatched
            else (
                "no unmatched executed orders were found, but the export still cannot prove that "
                "current open-position risk is zero",
            ),
        ),
        unmatched_executed_orders=unmatched,
        warnings=tuple(dict.fromkeys(warnings)),
    )


__all__ = [
    "CALCULATION_VERSION",
    "PARSER_VERSION",
    "CfdAnalysis",
    "CfdAttribution",
    "CfdAttributionBucket",
    "CfdCashFlowSummary",
    "CfdCsvError",
    "CfdDuplicateConflictError",
    "CfdEvent",
    "CfdEventProvenance",
    "CfdFileSummary",
    "CfdLedger",
    "CfdNotionalSummary",
    "CfdParsedFile",
    "CfdRealisedPnlSummary",
    "CfdRealisedPoint",
    "CfdRecordTypeError",
    "CfdSchemaError",
    "CfdTradeQuality",
    "CfdUnmatchedExecutedOrder",
    "analyse_cfd_ledger",
    "combine_cfd_ledgers",
    "parse_cfd_csv_bytes",
    "parse_cfd_csv_text",
]
