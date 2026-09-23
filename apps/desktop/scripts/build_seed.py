"""Generate portable, entirely synthetic typed-contract data at build time."""

from __future__ import annotations

import csv
import importlib.util
import json
import math
import sqlite3
import sys
import tempfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT), str(ROOT / "backend/src")]


def main(destination: Path) -> None:
    if destination.exists() and any(destination.iterdir()):
        raise SystemExit("Build synthetic fixtures into an empty destination")

    from preview_data import PreviewPrices

    from services.api.trading_max_api.artifacts import ArtifactStore
    from services.api.trading_max_api.models import SecuritySearchResult
    from services.api.trading_max_api.watchlist import WatchlistStore

    spec = importlib.util.spec_from_file_location(
        "preview_test_fixture", ROOT / "services/api/tests/conftest.py"
    )
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    with tempfile.TemporaryDirectory(prefix="trading-max-desktop-fixture-") as temp:
        research = fixture.research_root.__wrapped__(Path(temp))
        report = research / "accounts/outputs/three-account-report"
        end = date(2026, 9, 21)
        daily_values = {}
        initial_values = {}
        for path in research.rglob("*.json"):
            path.write_text(
                path.read_text().replace("2026-08-01", end.isoformat()), encoding="utf-8"
            )
        for path in research.rglob("technical_analysis_*.json"):
            data = json.loads(path.read_text())
            for row in data["rows"]:
                if row["ticker"] == "BE":
                    row["currency"] = "USD"
                    row["price_series"] = [
                        p.model_dump(mode="json", by_alias=True)
                        for p in PreviewPrices().get("BE", "1d").points
                    ]
            path.write_text(json.dumps(data), encoding="utf-8")
        for code, final, cash in (("a", 1200, 200), ("b", 800, 100)):
            path = report / "yahoo_nav" / f"daily_nav_{code}.csv"
            values = []
            for day in range(211):
                stamp = end - timedelta(days=210 - day)
                if stamp.weekday() >= 5:
                    continue
                ratio = 0.82 + day / 210 * 0.18 + math.sin(day / 15) * 0.025
                values.append((stamp, ratio))
            last_ratio = values[-1][1]
            peak = 0
            daily_values[code] = []
            with path.open("w", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow(
                    [
                        "Date",
                        "CashGBP",
                        "MarketValueGBP",
                        "SyntheticNAVGBP",
                        "ExternalFlowGBP",
                        "WeightedExternalFlowGBP",
                        "DailyReturn",
                        "TWRWealth",
                        "Drawdown",
                    ]
                )
                initial = final * values[0][1] / last_ratio
                initial_values[code] = initial
                previous = initial
                for i, (stamp, ratio) in enumerate(values):
                    value = round(final * ratio / last_ratio, 2)
                    daily_values[code].append((stamp, value))
                    peak = max(peak, value)
                    writer.writerow(
                        [
                            stamp.isoformat(),
                            cash,
                            round(value - cash, 2),
                            value,
                            initial if i == 0 else 0,
                            initial if i == 0 else 0,
                            value / previous - 1 if i else 0,
                            value / initial,
                            value / peak - 1,
                        ]
                    )
                    previous = value
        destination.mkdir(parents=True, exist_ok=True)
        store = ArtifactStore(destination)
        fixture.seed_typed_snapshot_from_fixture(research, store)
        # These are explicitly generated observations, not interpolated real records.
        points = []
        for index, (day, invest_end) in enumerate(daily_values["a"]):
            isa_end = daily_values["b"][index][1]
            invest_start = daily_values["a"][max(0, index - 1)][1]
            isa_start = daily_values["b"][max(0, index - 1)][1]
            cadence = 600 if (end - day).days < 21 else 3600
            for seconds in range(0, 14 * 3600 + 1, cadence):
                fraction = seconds / (14 * 3600)
                stamp = datetime.combine(day, datetime.min.time(), tzinfo=UTC) + timedelta(
                    hours=6, seconds=seconds
                )
                wave = math.sin(fraction * math.pi * 4) * 2
                invest = round(invest_start + (invest_end - invest_start) * fraction + wave, 2)
                isa = round(isa_start + (isa_end - isa_start) * fraction + wave * 0.5, 2)
                points.append(
                    {
                        "observed_at": stamp.isoformat(),
                        "bucket_at": stamp.isoformat(),
                        "invest_value_gbp": invest,
                        "isa_value_gbp": isa,
                        "total_value_gbp": round(invest + isa, 2),
                        "invest_cash_gbp": 200,
                        "isa_cash_gbp": 100,
                        "source": "broker",
                        "cadence_seconds": cadence,
                        "flow_status": "verified",
                    }
                )
        extra = [
            store.immutable_artifacts.put_json(
                key="account/nav/valuation_history.json",
                payload={
                    "schema_version": 2,
                    "generated_at": points[-1]["observed_at"],
                    "interval_seconds": 600,
                    "retention_days": 210,
                    "points": points,
                },
                kind="intraday_nav",
                producer_version="desktop-synthetic-v1",
            )
        ]
        first = points[0]["observed_at"]
        last = points[-1]["observed_at"]
        for code in ("a", "b"):
            extra.append(
                store.immutable_artifacts.put_json(
                    key=f"account/nav/cash_flows_{code}.json",
                    payload={
                        "covered_from": first,
                        "covered_until": last,
                        "verified": True,
                        "events": [
                            {
                                "occurred_at": first,
                                "accounting_date": first[:10],
                                "amount_gbp": initial_values[code],
                            }
                        ],
                    },
                    kind="cash_flows",
                    producer_version="desktop-synthetic-v1",
                )
            )
        store.immutable_snapshots.publish(
            scope="all",
            source="desktop-synthetic-preview",
            artifacts=[*store.immutable_snapshots.latest().manifest.artifacts, *extra],
        )
        WatchlistStore(destination).add(
            SecuritySearchResult(
                ticker="BE",
                name="Bloom Energy · Synthetic preview",
                exchange="NYSE",
                bloomberg_ticker="BE US Equity",
                figi="BBG001BBH6X2",
            )
        )
        (destination / "DESKTOP_SYNTHETIC_DATA.json").write_text(
            json.dumps(
                {
                    "source": "generated test contract fixtures",
                    "real_broker_data": False,
                    "market_data": "synthetic",
                    "as_of": end.isoformat(),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        for path in destination.rglob("*.db"):
            with sqlite3.connect(path) as db:
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
