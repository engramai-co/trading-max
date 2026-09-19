"""Build an isolated preview: mock broker inputs, live public market adapters.

The fixture contains only hypothetical account quantities and cash reserves.
Market prices, FX, research, classifications and fund holdings are fetched by
the application's real adapters. Nothing is copied from another snapshot.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "backend" / "src")]

MARKER = "BROKER_MOCK_ONLY"


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
    temporary.replace(path)


def prepare_destination(state: Path) -> None:
    """Never mix provider-backed preview data with old all-synthetic artifacts."""
    if state == ROOT or ROOT in state.parents:
        raise ValueError("preview runtime state must be outside the checkout")
    if (state / "SYNTHETIC_DEMO_ONLY").exists():
        raise ValueError("a fully synthetic preview cannot be reused; use a clean directory")
    if state.exists() and any(state.iterdir()) and not (state / MARKER).is_file():
        raise ValueError("destination is not a broker-only mock preview; use a clean directory")
    state.mkdir(parents=True, exist_ok=True)
    (state / MARKER).write_text(
        "Only Trading 212 account inputs are hypothetical. Market and research data use live "
        "provider adapters. Missing provider data must stay unavailable.\n"
    )


def fetch_market_inputs(symbol: str, start: str, cache: Path) -> tuple[str, dict]:
    """Fetch nominal prices; never manufacture a quote when the API fails."""
    import pandas as pd
    import yfinance as yf

    cached = cache / f"{symbol}.json"
    if cached.is_file():
        payload = json.loads(cached.read_text())
        age = datetime.now(UTC) - datetime.fromisoformat(payload["fetched_at"])
        if age.total_seconds() < 3600 and payload["source"] == "yahoo-finance":
            return symbol, payload
    ticker = yf.Ticker(symbol)
    history = ticker.history(start=start, auto_adjust=False, actions=True, timeout=20)
    if history.empty:
        raise ValueError(f"{symbol}: live daily price history unavailable")
    metadata = ticker.get_history_metadata()
    info = ticker.get_info()
    currency = str(metadata.get("currency") or info.get("currency") or "")
    currency = "GBX" if currency in {"GBp", "GBX"} else currency.upper()
    if not currency:
        raise ValueError(f"{symbol}: provider did not supply a currency")
    split = pd.to_numeric(history["Stock Splits"], errors="coerce").fillna(0).replace(0, 1)
    nominal = history["Close"] * split.shift(-1, fill_value=1).iloc[::-1].cumprod().iloc[::-1]
    # Current broker values use a real quote. The simulated execution prices
    # below use earlier observed closes, with no generated market-price path.
    quote = float(info.get("regularMarketPrice") or history["Close"].iloc[-1])
    if not math.isfinite(quote) or quote <= 0:
        raise ValueError(f"{symbol}: provider returned an invalid quote")
    payload = {
        "source": "yahoo-finance",
        "fetched_at": datetime.now(UTC).isoformat(),
        "quote_time": info.get("regularMarketTime"),
        "symbol": symbol,
        "name": info.get("longName") or info.get("shortName") or symbol,
        "currency": currency,
        "exchange": info.get("exchange", ""),
        "quote": quote,
        "daily": {stamp.date().isoformat(): float(value) for stamp, value in nominal.items()},
        "splits": {
            stamp.date().isoformat(): float(value)
            for stamp, value in history["Stock Splits"].items()
            if value
        },
    }
    write_json(cache / f"{symbol}.json", payload)
    print(f"Live quotes: {symbol} {quote:g} {currency}", flush=True)
    return symbol, payload


def prior_close(market: dict, day: str) -> float:
    available = [date for date in market["daily"] if date < day]
    if not available:
        raise ValueError(f"{market['symbol']}: no real price before simulated fill {day}")
    return market["daily"][max(available)]


def gbp_factor(currency: str, markets: dict, day: str | None = None) -> float:
    if currency == "GBP":
        return 1.0
    if currency == "GBX":
        return 100.0
    fx = markets[f"GBP{currency}=X"]
    return prior_close(fx, day) if day else fx["quote"]


def create_broker_inputs(state: Path, fixture: dict) -> tuple[tuple[str, ...], dict]:
    """Produce only the managed Trading 212 input boundary, not analytics."""
    import pandas as pd
    from trading_max.ingestion.brokers.trading212 import (
        ManagedAccountStore,
        reconcile_csv_files,
        snapshot_from_payload,
    )

    symbols = sorted({s for account in fixture["accounts"].values() for s in account["positions"]})
    research = tuple(dict.fromkeys([*symbols, *fixture.get("research_tickers", [])]))
    cache = state / "cache" / "preview-broker-marks"
    start = fixture["start_date"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        markets = dict(pool.map(lambda s: fetch_market_inputs(s, start, cache), research))
    currencies = {m["currency"] for m in markets.values()} - {"GBP", "GBX"}
    for currency in sorted(currencies):
        symbol, market = fetch_market_inputs(f"GBP{currency}=X", start, cache)
        markets[symbol] = market

    stamp = datetime.now(UTC).isoformat()
    for profile, account in fixture["accounts"].items():
        managed = ManagedAccountStore(profile, data_root=state / "trading212")
        events = []
        positions = []
        realised = 0.0

        def cash_event(action: str, day: str, total: float, rows=events) -> None:
            rows.append({"Action": action, "Time (UTC)": f"{day}T08:00:00Z", "Total": total})

        for symbol, quantity in account["positions"].items():
            quantity = float(quantity)
            market = markets[symbol]
            currency = market["currency"]
            # Explicitly refuse unsupported split scenarios; never silently
            # invent corporate actions or let a fixture change share identity.
            first_fill = fixture["fills"][0]["date"]
            if any(day >= first_fill for day in market["splits"]):
                raise ValueError(f"{symbol}: add split-aware broker fixture before building")
            cost = 0.0
            for fill in fixture["fills"]:
                day = fill["date"]
                shares = quantity * float(fill["fraction"])
                price = prior_close(market, day)
                fx = gbp_factor(currency, markets, day)
                total = shares * price / fx
                cost += total
                events.append(
                    {
                        "Action": "Market buy",
                        "Time (UTC)": f"{day}T14:40:00Z",
                        "Ticker": symbol,
                        "Name": market["name"],
                        "No. of shares": shares,
                        "Price / share": price,
                        "Currency (Price / share)": currency,
                        "Exchange rate": fx,
                        "Total": total,
                    }
                )
            current = quantity * market["quote"] / gbp_factor(currency, markets)
            positions.append(
                {
                    "instrument": {"ticker": symbol, "name": market["name"], "currency": currency},
                    "quantity": quantity,
                    "currentPrice": market["quote"],
                    "walletImpact": {
                        "currentValue": current,
                        "totalCost": cost,
                        "unrealizedProfitLoss": current - cost,
                    },
                }
            )
        if not math.isclose(sum(float(fill["fraction"]) for fill in fixture["fills"]), 1):
            raise ValueError("broker fill fractions must sum to one")
        for flow in account.get("cash_flows", []):
            cash_event(flow["action"], flow["date"], float(flow["amount"]))
        change = sum(-e["Total"] if e["Action"] == "Market buy" else e["Total"] for e in events)
        cash = float(account["cash_gbp"])
        cash_event("Deposit", fixture["deposit_date"], cash - change)
        for i, event in enumerate(events):
            event.update(
                {
                    "ID": f"mock-{profile}-{i}",
                    "Currency (Total)": "GBP",
                    "Currency conversion fee": 0,
                    "Result": 0,
                    "ISIN": "",
                }
            )
        path = managed.export_destination(
            report_id=1, start=pd.Timestamp(start).date(), end=datetime.now(UTC).date()
        )
        pd.DataFrame(events).sort_values("Time (UTC)").to_csv(path, index=False)
        investment = sum(p["walletImpact"]["currentValue"] for p in positions)
        cost = sum(p["walletImpact"]["totalCost"] for p in positions)
        summary = {
            "id": 1 if profile == "invest" else 2,
            "currency": "GBP",
            "totalValue": investment + cash,
            "cash": {"availableToTrade": cash},
            "investments": {
                "currentValue": investment,
                "totalCost": cost,
                "unrealizedProfitLoss": investment - cost,
                "realizedProfitLoss": realised,
            },
        }
        payload = {"fetched_at_utc": stamp, "account_summary": summary, "positions": positions}
        snapshot = snapshot_from_payload(profile, "demo", payload)
        reconciliation = reconcile_csv_files(path, snapshot.positions)
        managed.write_snapshot(payload)
        managed.register_export(
            path=path,
            environment="demo",
            report={"reportId": 1, "status": "Finished", "timeFrom": start, "timeTo": stamp},
            account_summary=summary,
            reconciliation=reconciliation,
        )
        print(
            f"Mock broker input: {profile}, {len(positions)} holdings, {len(events)} events",
            flush=True,
        )
    return research, markets


def initialize_preferences(state: Path, tickers: tuple[str, ...], markets: dict) -> None:
    from services.api.trading_max_api.models import UserProfilePatch, WatchlistItem, WatchlistState
    from services.api.trading_max_api.settings import SettingsRepository
    from services.api.trading_max_api.watchlist import WatchlistStore

    settings = SettingsRepository(state)
    try:
        settings.update_profile(
            UserProfilePatch(
                locale="zh",
                timezone="Europe/London",
                base_currency="GBP",
                account_labels={"A": "Invest", "B": "Stocks ISA", "C": "CFD"},
            ),
            actor="broker-preview",
        )
        settings.ensure_automation_preferences(
            nightly_enabled=False,
            intraday_enabled=False,
            performance_enabled=False,
            research_enabled=False,
        )
    finally:
        settings.close()
    WatchlistStore(state).save(
        WatchlistState(
            items=[
                WatchlistItem(
                    ticker=ticker,
                    name=markets[ticker]["name"],
                    exchange=markets[ticker]["exchange"],
                    bloomberg_ticker="",
                    figi="",
                    order=i,
                )
                for i, ticker in enumerate(tickers)
            ]
        )
    )


def build(state: Path, fixture: dict, *, resume: bool) -> None:
    from trading_max.application.runtime import TypedWorkerRuntime
    from trading_max.application.stages import StageContext
    from trading_max.domain.contracts import ArtifactRef

    from services.api.trading_max_api.typed_jobs import stage_plan

    checkpoint_path = state / "preview-build.json"
    if resume:
        checkpoint = json.loads(checkpoint_path.read_text())
        tickers = tuple(checkpoint["tickers"])
    else:
        tickers, markets = create_broker_inputs(state, fixture)
        initialize_preferences(state, tickers, markets)
        checkpoint = {
            "started_at": datetime.now(UTC).isoformat(),
            "tickers": list(tickers),
            "completed": {},
            "failures": {},
            "artifacts": {},
        }
        write_json(checkpoint_path, checkpoint)
    refs = {
        key: ArtifactRef.model_validate(value) for key, value in checkpoint["artifacts"].items()
    }
    # Older checkpoints identified outputs only by producer version. Preserve
    # that migration path, then keep explicit ownership for subsequent retries.
    outputs = checkpoint.setdefault(
        "stage_artifacts",
        {
            name: [key for key, ref in refs.items() if ref.producer_version == version]
            for name, version in checkpoint["completed"].items()
        },
    )
    runtime = TypedWorkerRuntime(state)
    registry = runtime.registry()
    # The production plan includes ordering requirements beyond stage-local
    # dependencies, such as the CFD ledger consuming current daily NAV.
    pending = [name for name, _ in stage_plan("all", skip_sync=True) if name != "snapshot.publish"]
    registry.validate_order(pending)
    changed_stages: set[str] = set()
    available_keys: set[str] = set()
    while pending:
        for name in pending[:1]:
            stage = registry.get(name)
            dependencies = set(stage.dependencies)
            if name == "accounts.cfd":
                dependencies.add("accounts.nav")
            if name == "accounts.performance":
                dependencies.add("research.technical")
            if (
                dependencies & changed_stages
                or checkpoint["completed"].get(name) != stage.version
                or name in checkpoint["failures"]
            ):
                print(f"Stage: {name}", flush=True)
                # Invalidation happens even if the replacement fails. A failed
                # refresh must not publish old outputs or let dependants reuse
                # results calculated from the now-invalidated inputs.
                changed_stages.add(name)
                for key in outputs.pop(name, []):
                    refs.pop(key, None)
                    available_keys.discard(key)
                checkpoint["completed"].pop(name, None)
                inputs = {key: ref for key, ref in refs.items() if key in available_keys}
                context = StageContext(
                    job_id="broker-preview",
                    scope="all",
                    skip_sync=True,
                    tickers=tickers,
                    inputs=inputs,
                    upstream_artifact_ids=tuple(ref.artifact_id for ref in inputs.values()),
                )
                try:
                    if failed := dependencies & checkpoint["failures"].keys():
                        raise RuntimeError(f"dependencies unavailable: {', '.join(sorted(failed))}")
                    result = stage.run(context)
                    refs.update({ref.key: ref for ref in result.artifacts})
                    outputs[name] = [ref.key for ref in result.artifacts]
                    checkpoint["completed"][name] = stage.version
                    checkpoint["failures"].pop(name, None)
                    for warning in result.warnings:
                        print(f"  Coverage: {warning}", flush=True)
                    print(f"  {len(result.artifacts)} artifacts", flush=True)
                except Exception as exc:
                    checkpoint["failures"][name] = str(exc)
                    print(f"  Unavailable: {name}: {exc}", flush=True)
                checkpoint["artifacts"] = {
                    key: ref.model_dump(mode="json", by_alias=False) for key, ref in refs.items()
                }
                write_json(checkpoint_path, checkpoint)
            if checkpoint["completed"].get(name) == stage.version:
                available_keys.update(key for key in outputs.get(name, []) if key in refs)
            pending.remove(name)
    refs = {key: ref for key, ref in refs.items() if key in available_keys}
    required = {
        "account/broker_snapshot_metrics.json",
        "research/technical.json",
        "research/fundamentals.json",
        "account/nav/valuation_history.json",
    }
    if missing := required - set(refs):
        raise RuntimeError(f"preview not published; required data unavailable: {sorted(missing)}")
    snapshot = runtime.snapshots.publish(
        scope="all", source="broker-mock-live-market", artifacts=list(refs.values())
    )
    write_json(
        state / "preview-provenance.json",
        {
            "run_id": snapshot.manifest.run_id,
            "published_at": datetime.now(UTC).isoformat(),
            "mock_boundary": "Trading 212 account inputs only",
            "market_and_research": "Production provider adapters; no synthetic fallback",
            "nav": "Production ledger replay with observed historical market and FX prices",
            "failures": checkpoint["failures"],
            "producers": {key: ref.producer_version for key, ref in refs.items()},
        },
    )
    from services.api.trading_max_api.watchlist import WatchlistStore

    watchlist = WatchlistStore(state)
    existing = watchlist.load()
    watchlist.save(
        existing.model_copy(
            update={
                "items": [
                    item.model_copy(
                        update={"status": "ready", "last_run_id": snapshot.manifest.run_id}
                    )
                    for item in existing.items
                ]
            }
        )
    )
    print(f"Published: {snapshot.manifest.run_id}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-root", type=Path, required=True)
    parser.add_argument("--broker-fixture", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    state = args.state_root.expanduser().resolve()
    prepare_destination(state)
    os.environ["TRADING_MAX_DATA_ROOT"] = str(state)
    build(state, json.loads(args.broker_fixture.read_text()), resume=args.resume)


if __name__ == "__main__":
    main()
