"""Serve the broker-only mock preview with a working, real-data refresh worker.

Only broker.sync is replaced. All account, NAV, market and research stages use
the production registry. The process stops its worker when the API exits.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "backend" / "src")]


def live_quote(symbol: str) -> dict:
    import yfinance as yf

    info = yf.Ticker(symbol).get_info()
    currency = str(info.get("currency") or "")
    currency = "GBX" if currency in {"GBp", "GBX"} else currency.upper()
    quotes = []
    now = datetime.now(UTC).timestamp()
    for session in ("regular", "pre", "post"):
        price = float(info.get(f"{session}MarketPrice") or 0)
        stamp = float(info.get(f"{session}MarketTime") or 0)
        if math.isfinite(price) and price > 0 and 0 < stamp <= now:
            quotes.append({"price": price, "currency": currency, "as_of": stamp})
    if not currency or not quotes:
        raise ValueError(f"{symbol}: live quote unavailable; broker preview was not refreshed")
    return max(quotes, key=lambda quote: quote["as_of"])


def refresh_broker_inputs(state: Path, *, quote_loader=live_quote) -> dict:
    from trading_max.ingestion.brokers.trading212 import ManagedAccountStore, snapshot_from_payload

    if not (state / "BROKER_MOCK_ONLY").is_file() or (state / "SYNTHETIC_DEMO_ONLY").exists():
        raise ValueError("a broker-only mock preview state is required")
    inputs = {}
    for profile in ("invest", "isa"):
        paths = sorted((state / "trading212" / profile / "snapshots").glob("snapshot_*.json"))
        inputs[profile] = json.loads(paths[-1].read_text())
    symbols = {p["instrument"]["ticker"] for raw in inputs.values() for p in raw["positions"]}
    currencies = {
        p["instrument"]["currency"] for raw in inputs.values() for p in raw["positions"]
    } - {"GBP", "GBX"}
    symbols.update(f"GBP{currency}=X" for currency in currencies)
    with ThreadPoolExecutor(max_workers=4) as pool:
        quotes = dict(zip(sorted(symbols), pool.map(quote_loader, sorted(symbols)), strict=True))
    for symbol, quote in quotes.items():
        if not math.isfinite(float(quote["price"])) or float(quote["price"]) <= 0:
            raise ValueError(f"{symbol}: invalid market quote")
    stamp = datetime.now(UTC).isoformat()
    updated = {}
    for profile, raw in inputs.items():
        payload = copy.deepcopy(raw)
        for position in payload["positions"]:
            symbol = position["instrument"]["ticker"]
            currency = position["instrument"]["currency"]
            quote = quotes[symbol]
            if currency != quote["currency"]:
                raise ValueError(f"{symbol}: quote currency changed; reconcile broker inputs first")
            factor = (
                1
                if currency == "GBP"
                else 100
                if currency == "GBX"
                else quotes[f"GBP{currency}=X"]["price"]
            )
            value = float(position["quantity"]) * quote["price"] / factor
            position["currentPrice"] = quote["price"]
            wallet = position["walletImpact"]
            wallet["currentValue"] = value
            wallet["unrealizedProfitLoss"] = value - float(wallet["totalCost"])
        investment = sum(p["walletImpact"]["currentValue"] for p in payload["positions"])
        summary = payload["account_summary"]
        summary["totalValue"] = investment + float(summary["cash"]["availableToTrade"])
        summary["investments"]["currentValue"] = investment
        summary["investments"]["unrealizedProfitLoss"] = investment - float(
            summary["investments"]["totalCost"]
        )
        payload["fetched_at_utc"] = stamp
        payload["market_quote_times"] = {symbol: quote["as_of"] for symbol, quote in quotes.items()}
        snapshot_from_payload(profile, "demo", payload)
        updated[profile] = payload
    # Validate every quote and both accounts before writing any new broker input.
    for profile, payload in updated.items():
        ManagedAccountStore(profile, data_root=state / "trading212").write_snapshot(payload)
    return {
        "mock_boundary": "Trading 212 inputs only",
        "market_provider": "yahoo-finance",
        "quote_count": len(quotes),
        "observed_at": stamp,
    }


class BrokerPreviewStage:
    name = "broker.sync"
    version = "broker-preview-live-quotes-v2"
    required_for = frozenset({"all", "accounts", "intraday"})
    dependencies: tuple[str, ...] = ()

    def __init__(self, state: Path):
        self.state = state

    def run(self, context):
        from trading_max.application.stages import StageResult

        return StageResult(metadata=refresh_broker_inputs(self.state))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8424)
    args = parser.parse_args()
    state = args.state_root.expanduser().resolve()
    if not (state / "BROKER_MOCK_ONLY").is_file() or (state / "SYNTHETIC_DEMO_ONLY").exists():
        raise ValueError("serve only a built broker-only mock preview")
    os.environ["TRADING_MAX_DATA_ROOT"] = str(state)
    os.environ["TRADING_MAX_LOG_DIR"] = str(state / "logs")
    import uvicorn
    from trading_max.application.stages import StageRegistry

    from services.api.trading_max_api.app import create_app
    from services.api.trading_max_api.config import Settings
    from services.api.trading_max_api.credentials import InMemoryCredentialStore

    app = create_app(
        Settings(
            data_root=state,
            api_port=args.port,
            embedded_worker=False,
            llm_provider="deepseek",
            allowed_origins=("http://127.0.0.1:3415", "http://127.0.0.1:3416"),
        ),
        credential_store=InMemoryCredentialStore(),
    )
    jobs = app.state.jobs
    jobs.registry = StageRegistry(
        [
            BrokerPreviewStage(state) if name == "broker.sync" else jobs.registry.get(name)
            for name in jobs.registry.names()
        ]
    )
    jobs._worker = jobs._build_worker(worker_id="broker-preview-worker", lease_seconds=90)
    jobs._worker_thread = threading.Thread(target=jobs._run_embedded_worker, daemon=True)
    jobs._worker_thread.start()
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
