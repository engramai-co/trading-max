"""Append mock closes and reopens, priced from real market history, to a broker preview."""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "backend" / "src")]

from tools.build_broker_preview import fetch_market_inputs, gbp_factor, prior_close  # noqa: E402


def close_and_reopen(
    payload: dict, rows: list[dict], trades: list[dict], markets: dict, *, batch: str, profile: str
) -> tuple[dict, list[dict]]:
    """Keep share quantities, but realize the old cost basis and open a new campaign."""
    updated = copy.deepcopy(payload)
    events = copy.deepcopy(rows)
    positions = {p["instrument"]["ticker"]: p for p in updated["positions"]}
    ids = {str(row.get("ID")) for row in events}
    expected = {
        f"mock-{batch}-{profile}-{i}-{side}" for i in range(len(trades)) for side in ("sell", "buy")
    }
    if expected <= ids:
        return updated, events
    if expected & ids:
        raise ValueError("partial mock trade batch; restore its input backup before retrying")
    if len({trade["ticker"] for trade in trades}) != len(trades):
        raise ValueError("each security can be closed once per batch")
    cash = float(updated["account_summary"]["cash"]["availableToTrade"])
    realised = float(updated["account_summary"]["investments"].get("realizedProfitLoss") or 0)
    last_observation = datetime.fromisoformat(payload["fetched_at_utc"].replace("Z", "+00:00"))
    for i, trade in enumerate(trades):
        symbol = trade["ticker"]
        close = datetime.fromisoformat(trade["closed_at"].replace("Z", "+00:00"))
        reopen = datetime.fromisoformat(trade["reopened_at"].replace("Z", "+00:00"))
        if not last_observation < close < reopen <= datetime.now(UTC):
            raise ValueError(
                "mock fills must follow existing observations and close before reopening"
            )
        position = positions[symbol]
        quantity = float(position["quantity"])
        if not math.isfinite(quantity) or quantity <= 0:
            raise ValueError("mock campaign requires a positive existing position")
        market = markets[symbol]
        currency = position["instrument"]["currency"]
        if market["currency"] != currency or any(
            last_observation.date().isoformat() < day <= reopen.date().isoformat()
            for day in market.get("splits", {})
        ):
            raise ValueError("currency change or split requires an explicit broker fixture")
        old_cost = float(position["walletImpact"]["totalCost"])
        for side, stamp in (("sell", close), ("buy", reopen)):
            day = stamp.date().isoformat()
            price = prior_close(market, day)
            factor = gbp_factor(currency, markets, day)
            total = quantity * price / factor
            if not math.isfinite(total) or total <= 0:
                raise ValueError("a real, positive execution price and FX rate are required")
            result = total - old_cost if side == "sell" else 0.0
            events.append(
                {
                    "ID": f"mock-{batch}-{profile}-{i}-{side}",
                    "Action": f"Market {side}",
                    "Time (UTC)": stamp.isoformat(),
                    "Ticker": symbol,
                    "Name": market["name"],
                    "ISIN": "",
                    "No. of shares": quantity,
                    "Price / share": price,
                    "Currency (Price / share)": currency,
                    "Exchange rate": factor,
                    "Total": total,
                    "Currency (Total)": "GBP",
                    "Result": result,
                    "Currency conversion fee": 0,
                }
            )
            cash += total if side == "sell" else -total
            realised += result
            if side == "buy":
                position["walletImpact"]["totalCost"] = total
    # Reconcile the complete chronological wallet, including overlapping trades.
    balance = 0.0
    for row in sorted(events, key=lambda r: str(r["Time (UTC)"])):
        balance += (-1 if "buy" in str(row["Action"]).lower() else 1) * float(row["Total"])
        if balance < -0.02:
            raise ValueError("mock trades would overdraw the account")
    if not math.isclose(balance, cash, abs_tol=0.02):
        raise ValueError("mock cash does not reconcile to the complete broker ledger")
    summary = updated["account_summary"]
    summary["cash"]["availableToTrade"] = cash
    summary["investments"]["realizedProfitLoss"] = realised
    summary["investments"]["totalCost"] = sum(
        p["walletImpact"]["totalCost"] for p in updated["positions"]
    )
    return updated, events


def extend_preview(state: Path, fixture: dict) -> None:
    import pandas as pd
    from trading_max.ingestion.brokers.trading212 import (
        ManagedAccountStore,
        latest_export_path,
        reconcile_csv_files,
        snapshot_from_payload,
    )

    if (
        state == ROOT
        or ROOT in state.parents
        or not (state / "BROKER_MOCK_ONLY").is_file()
        or (state / "SYNTHETIC_DEMO_ONLY").exists()
    ):
        raise ValueError("an external broker-only mock preview is required")
    inputs = {}
    exports = {}
    for profile in fixture["accounts"]:
        if profile not in {"invest", "isa"}:
            raise ValueError("unsupported preview account")
        inputs[profile] = json.loads(
            sorted((state / "trading212" / profile / "snapshots").glob("snapshot_*.json"))[
                -1
            ].read_text()
        )
        path = latest_export_path(profile, data_root=state / "trading212")
        if path is None:
            raise ValueError("complete existing broker history is required")
        exports[profile] = pd.read_csv(path).fillna("").to_dict("records")
    prefix = f"mock-{fixture['batch_id']}-"
    if all(
        sum(str(row.get("ID", "")).startswith(prefix) for row in exports[p])
        == len(fixture["accounts"][p]) * 2
        for p in inputs
    ):
        print("Mock trade batch already installed; inputs preserved.")
        return
    symbols = {p["instrument"]["ticker"] for raw in inputs.values() for p in raw["positions"]}
    currencies = {
        p["instrument"]["currency"] for raw in inputs.values() for p in raw["positions"]
    } - {"GBP", "GBX"}
    symbols.update(f"GBP{c}=X" for c in currencies)
    with ThreadPoolExecutor(max_workers=4) as pool:
        markets = dict(
            pool.map(
                lambda symbol: fetch_market_inputs(
                    symbol, fixture["history_start"], state / "cache" / "preview-broker-marks"
                ),
                sorted(symbols),
            )
        )
    stamp = datetime.now(UTC).isoformat()
    prepared = []
    with TemporaryDirectory(prefix="broker-preview-") as temporary:
        for profile, raw in inputs.items():
            payload, events = close_and_reopen(
                raw,
                exports[profile],
                fixture["accounts"][profile],
                markets,
                batch=fixture["batch_id"],
                profile=profile,
            )
            for p in payload["positions"]:
                symbol, currency = p["instrument"]["ticker"], p["instrument"]["currency"]
                if markets[symbol]["currency"] != currency:
                    raise ValueError("quote currency changed")
                p["currentPrice"] = markets[symbol]["quote"]
                wallet = p["walletImpact"]
                wallet["currentValue"] = (
                    p["quantity"] * p["currentPrice"] / gbp_factor(currency, markets)
                )
                wallet["unrealizedProfitLoss"] = wallet["currentValue"] - wallet["totalCost"]
            summary = payload["account_summary"]
            total = sum(p["walletImpact"]["currentValue"] for p in payload["positions"])
            summary["totalValue"] = total + summary["cash"]["availableToTrade"]
            summary["investments"]["currentValue"] = total
            summary["investments"]["unrealizedProfitLoss"] = (
                total - summary["investments"]["totalCost"]
            )
            payload["fetched_at_utc"] = stamp
            payload["mock_trade_batch"] = fixture["batch_id"]
            candidate = Path(temporary) / f"{profile}.csv"
            pd.DataFrame(events).sort_values("Time (UTC)").to_csv(candidate, index=False)
            snapshot = snapshot_from_payload(profile, "demo", payload)
            reconciliation = reconcile_csv_files(candidate, snapshot.positions)
            if reconciliation.status != "verified":
                raise ValueError(f"{profile}: mock closing trades failed reconciliation")
            prepared.append(
                (
                    profile,
                    payload,
                    candidate.read_bytes(),
                    reconciliation,
                    min(r["Time (UTC)"] for r in events)[:10],
                )
            )
        for profile, _, _, _, first_day in prepared:
            destination = ManagedAccountStore(
                profile, data_root=state / "trading212"
            ).export_destination(
                report_id=fixture["report_id"],
                start=pd.Timestamp(first_day).date(),
                end=datetime.now(UTC).date(),
            )
            if destination.exists():
                raise ValueError("mock report destination already exists")
        # Validate both accounts before changing any managed input; old exports
        # and snapshots remain available for rollback. Preferences are untouched.
        for profile, payload, content, reconciliation, first_day in prepared:
            managed = ManagedAccountStore(profile, data_root=state / "trading212")
            destination = managed.export_destination(
                report_id=fixture["report_id"],
                start=pd.Timestamp(first_day).date(),
                end=datetime.now(UTC).date(),
            )
            if destination.exists():
                raise ValueError("mock report destination already exists")
            destination.write_bytes(content)
            managed.write_snapshot(payload)
            managed.register_export(
                path=destination,
                environment="demo",
                report={
                    "reportId": fixture["report_id"],
                    "status": "Finished",
                    "timeFrom": first_day,
                    "timeTo": stamp,
                },
                account_summary=payload["account_summary"],
                reconciliation=reconciliation,
            )
    print(
        json.dumps(
            {
                "mock_boundary": "Trading 212 only",
                "closed_campaigns": {p: len(ts) for p, ts in fixture["accounts"].items()},
                "market_provider": "yahoo-finance",
                "observed_at": stamp,
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-root", type=Path, required=True)
    parser.add_argument("--broker-fixture", type=Path, required=True)
    args = parser.parse_args()
    extend_preview(
        args.state_root.expanduser().resolve(), json.loads(args.broker_fixture.read_text())
    )
