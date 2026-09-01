"""Pure, side-effect-free Trading 212 ledger primitives.

The durable account stages pass approved export paths into these functions.
This module deliberately contains no report writing, plotting, or path
discovery.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

IDENTITY_COLUMNS = (
    "Action",
    "Time (UTC)",
    "Ticker",
    "No. of shares",
    "Price / share",
    "Total",
)


def is_buy(action: object) -> bool:
    return "buy" in str(action).lower()


def is_sell(action: object) -> bool:
    return "sell" in str(action).lower()


def is_stock_split_close(action: object) -> bool:
    return str(action).strip().lower() == "stock split close"


def is_stock_split_open(action: object) -> bool:
    return str(action).strip().lower() == "stock split open"


def is_dividend(action: object) -> bool:
    return "dividend" in str(action).lower()


def _json_safe(value: object) -> object:
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def load_transactions(paths: Iterable[Path]) -> pd.DataFrame:
    """Load official exports and deduplicate overlapping transaction IDs.

    A repeated ID with different economic identity is rejected. Rows without
    IDs are deduplicated by their complete source row, matching the broker
    export's immutable-row semantics.
    """

    source_paths = tuple(Path(path).expanduser().resolve() for path in paths)
    if not source_paths:
        raise FileNotFoundError("no Trading 212 exports were supplied")
    missing = [path for path in source_paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(
            "missing Trading 212 export(s): " + ", ".join(str(path) for path in missing)
        )
    frames = [pd.read_csv(path) for path in source_paths]
    combined = pd.concat(frames, ignore_index=True, sort=False)
    required = {"Action", "Time (UTC)", "Ticker", "No. of shares", "Total"}
    missing_columns = sorted(required - set(combined.columns))
    if missing_columns:
        raise ValueError(f"Trading 212 export is missing columns: {missing_columns}")

    source_columns = list(combined.columns)
    if "ID" in combined:
        normalized = combined["ID"].astype("string").str.strip()
        has_id = normalized.notna() & normalized.ne("")
        keyed = combined.loc[has_id].copy()
        unkeyed = combined.loc[~has_id].copy()
        keyed["_normalized_id"] = normalized.loc[has_id]
        identity = [column for column in IDENTITY_COLUMNS if column in keyed]
        duplicates = keyed[keyed["_normalized_id"].duplicated(keep=False)]
        for transaction_id, rows in duplicates.groupby("_normalized_id"):
            if len(rows.drop_duplicates(subset=identity)) != 1:
                raise ValueError(f"conflicting rows for transaction ID {transaction_id}")
        keyed = keyed.drop_duplicates("_normalized_id", keep="last").drop(columns="_normalized_id")
        unkeyed = unkeyed.drop_duplicates(subset=source_columns, keep="last")
        combined = pd.concat([keyed, unkeyed], ignore_index=True, sort=False)
    else:
        combined = combined.drop_duplicates(subset=source_columns, keep="last")

    combined["Time"] = pd.to_datetime(combined["Time (UTC)"], utc=True, errors="coerce")
    if combined["Time"].isna().any():
        raise ValueError("Trading 212 export contains an invalid Time (UTC) value")
    combined["Shares"] = pd.to_numeric(combined["No. of shares"], errors="coerce")
    combined["PriceN"] = (
        pd.to_numeric(combined["Price / share"], errors="coerce")
        if "Price / share" in combined
        else pd.Series(float("nan"), index=combined.index)
    )
    combined["TotalN"] = pd.to_numeric(combined["Total"], errors="coerce").fillna(0.0)
    combined["FeeN"] = pd.to_numeric(
        combined.get("Currency conversion fee", 0), errors="coerce"
    ).fillna(0.0)
    combined["ResultN"] = pd.to_numeric(combined.get("Result", 0), errors="coerce").fillna(0.0)
    return combined.sort_values("Time").reset_index(drop=True)


def transaction_marker_rows(
    account_transactions: Mapping[str, pd.DataFrame],
    known_positions: Iterable[Mapping[str, object]],
) -> list[dict[str, Any]]:
    """Aggregate real broker fills into B/S/T markers for researched holdings.

    The marker vocabulary follows the convention used by Chinese broker apps:
    B means buy-only, S means sell-only, and T means both directions occurred
    for the same security on the same UTC trading date. Known position ISINs
    and broker tickers resolve historical aliases; otherwise the immutable
    broker-export ticker is retained so a previously held watchlist security
    can still expose its real fill history.
    """

    ticker_aliases: dict[str, str] = {}
    isin_aliases: dict[str, str] = {}
    for position in known_positions:
        canonical = _normalized_security_value(position.get("ticker"))
        if not canonical:
            continue
        for value in (position.get("ticker"), position.get("broker_ticker")):
            alias = _normalized_security_value(value)
            if alias:
                ticker_aliases[alias] = canonical
        isin = _normalized_security_value(position.get("isin"))
        if isin:
            isin_aliases[isin] = canonical

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for account, transactions in account_transactions.items():
        for _, row in transactions.iterrows():
            action = row.get("Action")
            side = "buy" if is_buy(action) else "sell" if is_sell(action) else None
            if side is None:
                continue
            isin = _normalized_security_value(row.get("ISIN"))
            raw_ticker = _normalized_security_value(row.get("Ticker"))
            ticker = isin_aliases.get(isin) or ticker_aliases.get(raw_ticker) or raw_ticker
            if not ticker:
                continue
            timestamp = row.get("Time")
            if not isinstance(timestamp, pd.Timestamp) or pd.isna(timestamp):
                continue
            key = (ticker, timestamp.strftime("%Y-%m-%d"))
            marker = grouped.setdefault(
                key,
                {
                    "ticker": ticker,
                    "date": key[1],
                    "accounts": set(),
                    "buy_orders": 0,
                    "sell_orders": 0,
                    "buy_quantity": 0.0,
                    "sell_quantity": 0.0,
                    "buy_price_quantity": 0.0,
                    "sell_price_quantity": 0.0,
                    "buy_priced_quantity": 0.0,
                    "sell_priced_quantity": 0.0,
                },
            )
            marker["accounts"].add(str(account).strip().lower())
            marker[f"{side}_orders"] += 1
            quantity = row.get("Shares")
            quantity_value = abs(float(quantity)) if pd.notna(quantity) else 0.0
            marker[f"{side}_quantity"] += quantity_value
            price = row.get("PriceN")
            if pd.notna(price) and quantity_value > 0:
                marker[f"{side}_price_quantity"] += float(price) * quantity_value
                marker[f"{side}_priced_quantity"] += quantity_value

    rows: list[dict[str, Any]] = []
    for marker in grouped.values():
        has_buys = marker["buy_orders"] > 0
        has_sells = marker["sell_orders"] > 0
        kind = "T" if has_buys and has_sells else "B" if has_buys else "S"
        buy_priced_quantity = marker.pop("buy_priced_quantity")
        sell_priced_quantity = marker.pop("sell_priced_quantity")
        buy_price_quantity = marker.pop("buy_price_quantity")
        sell_price_quantity = marker.pop("sell_price_quantity")
        marker["kind"] = kind
        marker["accounts"] = sorted(marker["accounts"])
        marker["buy_quantity"] = round(marker["buy_quantity"], 8)
        marker["sell_quantity"] = round(marker["sell_quantity"], 8)
        marker["buy_average_price"] = (
            round(buy_price_quantity / buy_priced_quantity, 8) if buy_priced_quantity else None
        )
        marker["sell_average_price"] = (
            round(sell_price_quantity / sell_priced_quantity, 8) if sell_priced_quantity else None
        )
        rows.append(marker)
    return sorted(rows, key=lambda row: (row["date"], row["ticker"]))


@dataclass
class Campaign:
    """One open or closed cash campaign reconstructed from broker rows."""

    ticker: str
    name: str
    start: pd.Timestamp
    buy_orders: int = 0
    sell_orders: int = 0
    gross_buy_cash: float = 0.0
    buy_fees: float = 0.0
    gross_sell_cash: float = 0.0
    sell_fees: float = 0.0
    distributions: float = 0.0
    gross_result: float = 0.0
    corporate_actions: int = 0

    @property
    def buy_cash_out(self) -> float:
        return self.gross_buy_cash + self.buy_fees

    @property
    def recovered_cash(self) -> float:
        return self.gross_sell_cash - self.sell_fees + self.distributions

    @property
    def realized_net(self) -> float:
        return self.gross_result - self.buy_fees - self.sell_fees


def _normalized_security_value(value: object) -> str:
    """Return a stable uppercase security identifier component."""

    if value is None or pd.isna(value):
        return ""
    text = str(value).strip().upper()
    return "" if text in {"", "NAN", "<NA>"} else text


def _security_identity(*, isin: object, ticker: object) -> str | None:
    """Resolve a durable security identity, preferring ISIN over ticker."""

    normalized_isin = _normalized_security_value(isin)
    if normalized_isin:
        return f"isin:{normalized_isin}"
    normalized_ticker = _normalized_security_value(ticker)
    if normalized_ticker:
        return f"ticker:{normalized_ticker}"
    return None


def _transaction_identity(row: pd.Series) -> str | None:
    return _security_identity(
        isin=row.get("ISIN"),
        ticker=row.get("Ticker"),
    )


def _position_identity(position: dict[str, Any]) -> str | None:
    return _security_identity(
        isin=position.get("isin"),
        ticker=position.get("ticker"),
    )


def _reconstruct_campaigns_by_identity(
    transactions: pd.DataFrame,
) -> tuple[list[dict[str, Any]], dict[str, tuple[Campaign, float]]]:
    """Reconstruct campaigns using ISIN-first durable security identity.

    Split close/open rows are treated as a corporate action inside one
    campaign. Initial sells without an in-window buy are treated as the close
    of pre-window opening inventory and excluded from campaign metrics; any
    remaining live position still has to reconcile to an open campaign later.
    """

    closed: list[dict[str, Any]] = []
    opened: dict[str, tuple[Campaign, float]] = {}
    security_rows = transactions.copy()
    security_rows["_SecurityIdentity"] = security_rows.apply(
        _transaction_identity,
        axis=1,
    )
    security_rows = security_rows[security_rows["_SecurityIdentity"].notna()]
    for identity, group in security_rows.groupby("_SecurityIdentity", sort=False):
        position = 0.0
        current: Campaign | None = None
        for _, row in group.sort_values("Time").iterrows():
            action = str(row["Action"])
            shares = float(row["Shares"]) if pd.notna(row["Shares"]) else 0.0
            row_ticker = _normalized_security_value(row.get("Ticker"))
            row_name = str(row.get("Name") or "").strip()
            if current is not None:
                if row_ticker:
                    current.ticker = row_ticker
                if row_name:
                    current.name = row_name
            if is_stock_split_close(action):
                if current is not None:
                    position -= shares
                    current.corporate_actions += 1
                    if abs(position) <= 1e-7:
                        position = 0.0
                continue
            if is_stock_split_open(action):
                if current is not None:
                    position += shares
                    current.corporate_actions += 1
                continue
            if is_buy(action):
                if current is None:
                    current = Campaign(
                        ticker=row_ticker or str(identity),
                        name=row_name or row_ticker or str(identity),
                        start=row["Time"],
                    )
                position += shares
                current.buy_orders += 1
                current.gross_buy_cash += float(row["TotalN"])
                current.buy_fees += float(row["FeeN"])
                continue
            if is_sell(action):
                if current is None:
                    continue
                position -= shares
                current.sell_orders += 1
                current.gross_sell_cash += float(row["TotalN"])
                current.sell_fees += float(row["FeeN"])
                current.gross_result += float(row["ResultN"])
                if position <= 1e-7:
                    closed.append(
                        {
                            "Ticker": current.ticker,
                            "Name": current.name,
                            "Start": current.start,
                            "End": row["Time"],
                            "DurationDays": (row["Time"] - current.start).total_seconds() / 86400,
                            "BuyOrders": current.buy_orders,
                            "SellOrders": current.sell_orders,
                            "BuyNotional": current.gross_buy_cash,
                            "SellNotional": current.gross_sell_cash,
                            "GrossResult": current.gross_result,
                            "Fees": current.buy_fees + current.sell_fees,
                            "NetResult": current.realized_net,
                            "CorporateActions": current.corporate_actions,
                        }
                    )
                    current = None
                    position = 0.0
                continue
            if is_dividend(action) and current is not None:
                current.distributions += float(row["TotalN"])
        if current is not None:
            opened[str(identity)] = (current, position)
    return closed, opened


def reconstruct_campaigns(
    transactions: pd.DataFrame,
) -> tuple[list[dict[str, Any]], dict[str, tuple[Campaign, float]]]:
    """Reconstruct campaigns while preserving ticker-keyed public output.

    Campaign continuity is resolved by ISIN when the broker export provides
    one, so ticker renames do not split one economic position. The open-campaign
    mapping remains keyed by the latest ticker for backward compatibility.
    """

    closed, opened_by_identity = _reconstruct_campaigns_by_identity(transactions)
    opened_by_ticker: dict[str, tuple[Campaign, float]] = {}
    for campaign, quantity in opened_by_identity.values():
        if campaign.ticker in opened_by_ticker:
            raise ValueError(f"ambiguous open campaigns for ticker {campaign.ticker}")
        opened_by_ticker[campaign.ticker] = (campaign, quantity)
    return closed, opened_by_ticker


def _open_campaign_entry_for_position(
    opened: dict[str, tuple[Campaign, float]],
    position: dict[str, Any],
) -> tuple[str, Campaign, float]:
    """Find an open campaign and its durable identity for one position."""

    identity = _position_identity(position)
    if identity is not None and identity in opened:
        campaign, quantity = opened[identity]
        return identity, campaign, quantity

    ticker = _normalized_security_value(position.get("ticker"))
    ticker_matches = [
        (key, value)
        for key, value in opened.items()
        if _normalized_security_value(value[0].ticker) == ticker
    ]
    if len(ticker_matches) == 1:
        matched_identity, (campaign, quantity) = ticker_matches[0]
        return matched_identity, campaign, quantity
    if len(ticker_matches) > 1:
        raise ValueError(f"ambiguous open campaigns for ticker {ticker}")
    raise KeyError(identity or f"ticker:{ticker}")


def summarize_campaigns(
    closed: list[dict[str, Any]],
    transactions: pd.DataFrame,
) -> dict[str, Any]:
    """Summarize realized campaign quality without exposing NaN values."""

    values = [float(row.get("NetResult") or 0.0) for row in closed]
    wins = [value for value in values if value > 0]
    losses = [value for value in values if value < 0]
    gross_wins = sum(wins)
    gross_losses = -sum(losses)
    return {
        "closed_campaigns": len(closed),
        "win_rate": sum(value > 0 for value in values) / len(values) if values else None,
        "avg_win": sum(wins) / len(wins) if wins else None,
        "avg_loss": sum(losses) / len(losses) if losses else None,
        "payoff": sum(wins) / len(wins) / (-sum(losses) / len(losses)) if wins and losses else None,
        "profit_factor": gross_wins / gross_losses if gross_losses else None,
        "expectancy": sum(values) / len(values) if values else None,
        "turnover": float(transactions["TotalN"].abs().sum()),
        "best": [
            _json_safe(row)
            for row in sorted(
                closed,
                key=lambda row: float(row.get("NetResult") or 0.0),
                reverse=True,
            )[:5]
        ],
        "worst": [
            _json_safe(row)
            for row in sorted(
                closed,
                key=lambda row: float(row.get("NetResult") or 0.0),
            )[:5]
        ],
    }


def policy_metrics(
    transactions_by_account: dict[str, pd.DataFrame],
) -> dict[str, Any]:
    """Build the dashboard-compatible Invest/ISA policy artifact."""

    summaries: dict[str, dict[str, Any]] = {}
    closed_by_account: dict[str, list[dict[str, Any]]] = {}
    for account_code, transactions in transactions_by_account.items():
        closed, _ = reconstruct_campaigns(transactions)
        closed_by_account[account_code] = closed
        summaries[account_code] = summarize_campaigns(closed, transactions)
    isa = summaries.get("B", {})
    isa_rows = closed_by_account.get("B", [])
    return {
        "schema_version": 2,
        "accounts": summaries,
        "a_campaign": summaries.get("A", {}),
        "b_policy": [
            {
                "Bucket": "All ISA trades",
                "sell_orders": len(isa_rows),
                "realized_net": sum(float(row.get("NetResult") or 0.0) for row in isa_rows),
                "gross_turnover": isa.get("turnover", 0.0),
                "q90_compliance": None,
            }
        ],
        "method": (
            "Campaigns are reconstructed from deduplicated official Trading 212 "
            "exports; stock split close/open legs remain in one campaign."
        ),
    }


def diluted_cost_rows(
    account_code: str,
    transactions: pd.DataFrame,
    positions: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Calculate the negative-capable cash basis for current holdings."""

    _, opened = _reconstruct_campaigns_by_identity(transactions)
    rows: list[dict[str, Any]] = []
    for position in positions:
        ticker = str(position.get("ticker") or "")
        try:
            _, campaign, ledger_quantity = _open_campaign_entry_for_position(opened, position)
        except KeyError:
            raise ValueError(f"{account_code}/{ticker}: no open campaign found") from None
        quantity = float(position.get("quantity") or 0.0)
        if abs(ledger_quantity - quantity) > 1e-6:
            raise ValueError(
                f"{account_code}/{ticker}: ledger quantity {ledger_quantity} "
                f"!= broker quantity {quantity}"
            )
        diluted = campaign.buy_cash_out - campaign.recovered_cash
        rows.append(
            {
                "account": account_code,
                "ticker": ticker,
                "name": str(position.get("name") or campaign.name),
                "quantity": quantity,
                "diluted_cost_gbp": diluted,
                "diluted_cost_per_share_gbp": (diluted / quantity if quantity > 1e-7 else None),
                "net_buy_cash_out_gbp": campaign.buy_cash_out,
                "recovered_cash_gbp": campaign.recovered_cash,
                "capital_recovery_ratio": (
                    campaign.recovered_cash / campaign.buy_cash_out
                    if campaign.buy_cash_out
                    else None
                ),
            }
        )
    return rows


def capital_recovery_rows(
    account_code: str,
    transactions: pd.DataFrame,
    positions: Iterable[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Calculate recovery metrics and explicit ledger/holding checks."""

    _, opened = _reconstruct_campaigns_by_identity(transactions)
    holdings = list(positions)
    ledger_identities = set(opened)
    broker_identities: set[str] = set()
    for position in holdings:
        try:
            identity, _, _ = _open_campaign_entry_for_position(opened, position)
        except KeyError:
            identity = _position_identity(position)
        if identity is not None:
            broker_identities.add(identity)
    checks: list[dict[str, Any]] = [
        {
            "account": account_code,
            "check": "open_security_set",
            "actual": sorted(ledger_identities),
            "expected": sorted(broker_identities),
            "difference": sorted(ledger_identities ^ broker_identities),
            "status": "OK" if ledger_identities == broker_identities else "FAIL",
        }
    ]
    rows: list[dict[str, Any]] = []
    for position in holdings:
        ticker = str(position.get("ticker") or "")
        try:
            _, campaign, ledger_quantity = _open_campaign_entry_for_position(opened, position)
        except KeyError:
            raise ValueError(f"{account_code}/{ticker}: no open campaign found") from None
        quantity = float(position.get("quantity") or 0.0)
        checks.append(
            {
                "account": account_code,
                "check": f"quantity_{ticker}",
                "actual": ledger_quantity,
                "expected": quantity,
                "difference": ledger_quantity - quantity,
                "status": ("OK" if abs(ledger_quantity - quantity) <= 1e-6 else "FAIL"),
            }
        )
        value = float(position.get("current_value_gbp") or 0.0)
        recovered = campaign.recovered_cash
        gap = max(campaign.buy_cash_out - recovered, 0.0)
        rows.append(
            {
                "Account": account_code,
                "Ticker": ticker,
                "Name": str(position.get("name") or campaign.name),
                "Quantity": quantity,
                "PriceGBP": value / quantity if quantity > 1e-7 else 0.0,
                "MarketValueGBP": value,
                "BuyOrders": campaign.buy_orders,
                "SellOrders": campaign.sell_orders,
                "NetBuyCashOutGBP": campaign.buy_cash_out,
                "NetSellCashInGBP": campaign.gross_sell_cash - campaign.sell_fees,
                "DistributionsGBP": campaign.distributions,
                "RecoveredCashGBP": recovered,
                "CapitalRecoveryRatio": (
                    recovered / campaign.buy_cash_out if campaign.buy_cash_out else None
                ),
                "CapitalGapGBP": gap,
                "RecoveryBreakevenPriceGBP": (gap / quantity if quantity > 1e-7 else None),
                "EconomicPnLGBP": recovered + value - campaign.buy_cash_out,
                "EconomicReturnOnCash": (
                    (recovered + value - campaign.buy_cash_out) / campaign.buy_cash_out
                    if campaign.buy_cash_out
                    else None
                ),
                "CapitalRecoveryStatus": (
                    "本金已收回（现金回收口径）"
                    if gap <= 0.01
                    else "接近收回（≥90%）"
                    if recovered / campaign.buy_cash_out >= 0.9
                    else "部分回收"
                ),
                "CorporateActions": campaign.corporate_actions,
            }
        )
    return rows, checks


__all__ = [
    "IDENTITY_COLUMNS",
    "Campaign",
    "capital_recovery_rows",
    "diluted_cost_rows",
    "is_buy",
    "is_dividend",
    "is_sell",
    "is_stock_split_close",
    "is_stock_split_open",
    "load_transactions",
    "policy_metrics",
    "reconstruct_campaigns",
    "summarize_campaigns",
    "transaction_marker_rows",
]
