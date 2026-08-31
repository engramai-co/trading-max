from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest


@pytest.fixture
def seed_watchlist():
    """Add only the securities explicitly required by one test.

    Production installations intentionally have no bundled company universe.
    Tests must declare their own reference fixtures instead of depending on a
    hidden watchlist seed.
    """

    from services.api.trading_max_api.models import SecuritySearchResult

    securities = {
        "BE": SecuritySearchResult(
            ticker="BE",
            name="Bloom Energy Corp",
            exchange="NYSE",
            bloomberg_ticker="BE US Equity",
            figi="BBG001BBH6X2",
        ),
        "TSM": SecuritySearchResult(
            ticker="TSM",
            name="Taiwan Semiconductor Manufacturing Co Ltd",
            exchange="NYSE",
            bloomberg_ticker="TSM US Equity",
            figi="BBG000BD8ZK0",
        ),
    }

    def seed(store, *tickers: str) -> None:
        for ticker in tickers:
            store.add(securities[ticker])

    return seed


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def seed_typed_snapshot_from_fixture(research_root: Path, store) -> object:
    """Translate the test fixture into the same typed contract as the worker.

    The fixture intentionally retains the historical source shape so dashboard
    adapters keep coverage for migrations, but the API under test only sees
    immutable content-addressed artifacts.
    """

    report = research_root / "accounts" / "outputs" / "three-account-report"
    artifacts = []

    def add_json(
        key: str,
        path: Path,
        *,
        kind: str = "account",
        producer: str = "fixture-v1",
        payload: object | None = None,
    ) -> None:
        raw = payload if payload is not None else json.loads(path.read_text(encoding="utf-8"))
        value = raw if isinstance(raw, dict) else {}
        artifacts.append(
            store.immutable_artifacts.put_json(
                key=key,
                payload=value,
                kind=kind,
                as_of=str(value.get("as_of") or value.get("data_as_of") or "2026-08-01"),
                producer_version=producer,
            )
        )

    def add_bytes(key: str, path: Path, *, kind: str = "account") -> None:
        artifacts.append(
            store.immutable_artifacts.put_bytes(
                key=key,
                content=path.read_bytes(),
                kind=kind,
                media_type="text/csv",
                producer_version="fixture-v1",
            )
        )

    for key, relative in (
        ("account/broker_snapshot_metrics.json", "broker_snapshot_metrics.json"),
        ("account/policy_metrics.json", "policy_metrics.json"),
        ("account/realized_metrics.json", "realized_metrics.json"),
        ("account/analysis_metrics.json", "account_analysis_metrics.json"),
        ("account/lookthrough_metrics.json", "lookthrough_metrics.json"),
        ("account/diluted_cost_metrics.json", "diluted_cost_metrics.json"),
    ):
        path = report / relative
        if path.is_file():
            add_json(key, path)
    for key, relative in (
        ("account/synthetic_nav_metrics.json", "yahoo_nav/synthetic_nav_metrics.json"),
        ("account/capital_recovery.json", "capital_recovery/capital_recovery_summary.json"),
    ):
        path = report / relative
        if path.is_file():
            add_json(key, path)
    for code in ("a", "b", "c"):
        path = report / "yahoo_nav" / f"daily_nav_{code}.csv"
        if path.is_file():
            add_bytes(f"account/nav/daily_nav_{code}.csv", path, kind="nav_series")

    research = research_root / "research"

    def latest(prefix: str) -> Path | None:
        candidates = sorted(research.rglob(f"{prefix}*.json"))
        return candidates[-1] if candidates else None

    daily = latest("daily_refresh_")
    earnings = latest("earnings_refresh_")
    assumptions = latest("valuation_assumptions_")
    technical = latest("technical_analysis_")
    valuation = latest("valuation_engine_v2_output")
    fundamentals = latest("fundamentals_analysis_")
    financials = latest("financials_")
    if daily:
        add_json("research/daily_market.json", daily, kind="market", producer="daily-refresh-v1")
    if earnings:
        earnings_payload = json.loads(earnings.read_text(encoding="utf-8"))
        add_json(
            "research/earnings.json", earnings, kind="earnings", producer="earnings-refresh-v1"
        )
        add_json(
            "research/sources.json",
            earnings,
            kind="sources",
            producer="source-ledger-v1",
            payload={
                "schema_version": 1,
                "as_of": earnings_payload.get("as_of"),
                "source_hierarchy": earnings_payload.get("source_hierarchy"),
                "sources": earnings_payload.get("sources", {}),
            },
        )
    if assumptions:
        add_json(
            "research/valuation_assumptions.json",
            assumptions,
            kind="assumptions",
            producer="valuation-assumptions-v1",
        )
    if technical:
        technical_payload = json.loads(technical.read_text(encoding="utf-8"))
        add_json(
            "research/technical.json", technical, kind="technical", producer="technical-analysis-v1"
        )
        add_json(
            "research/options.json",
            technical,
            kind="options",
            producer="options-proxy-v1",
            payload={
                "schema_version": 1,
                "as_of": technical_payload.get("as_of"),
                "source": technical_payload.get("source"),
                "options": technical_payload.get("options", {}),
            },
        )
    if valuation:
        add_json(
            "research/valuation.json", valuation, kind="valuation", producer="valuation-engine-v2"
        )
    if fundamentals:
        add_json(
            "research/fundamentals.json",
            fundamentals,
            kind="fundamentals",
            producer="fundamentals-v1",
        )
    if financials:
        add_json(
            "research/financials.json", financials, kind="financials", producer="financials-v1"
        )
    published = store.immutable_snapshots.publish(
        scope="all",
        source="typed-fixture",
        artifacts=artifacts,
    )
    return store._api_manifest(published.manifest)


@pytest.fixture
def typed_fixture():
    return seed_typed_snapshot_from_fixture


@pytest.fixture
def research_root(tmp_path: Path) -> Path:
    root = tmp_path / "research"
    report = root / "accounts" / "outputs" / "three-account-report"
    yahoo = report / "yahoo_nav"
    account_scripts = root / "accounts" / "scripts"
    scripts = root / "pipeline" / "scripts"
    account_scripts.mkdir(parents=True)
    scripts.mkdir(parents=True)
    (scripts / "refresh_dashboard.py").write_text(
        "from pathlib import Path\n"
        "\n"
        "root = Path(__file__).resolve().parents[2]\n"
        "research = root / 'research'\n"
        "for prefix in ('daily_refresh_', 'technical_analysis_', 'valuation_engine_v2_output_'):\n"
        "    for path in research.rglob(f'{prefix}*.json'):\n"
        "        path.touch()\n"
        'print("fixture refresh complete")\n',
        encoding="utf-8",
    )
    for name in (
        "trading212_sync.py",
        "export_broker_snapshot_metrics.py",
        "analyze_account_policies.py",
        "build_account_analysis_metrics.py",
        "audit_capital_recovery.py",
        "reconstruct_yahoo_nav.py",
        "build_lookthrough_analysis.py",
    ):
        (account_scripts / name).write_text(
            f'print("fixture {name} complete")\n',
            encoding="utf-8",
        )

    write_json(
        report / "broker_snapshot_metrics.json",
        {
            "generated_at_utc": "2026-08-01T20:00:00Z",
            "accounts": {
                "A": {
                    "profile": "invest",
                    "fetched_at_utc": "2026-08-01T19:00:00Z",
                    "total_value_gbp": 1200,
                    "cash_gbp": 200,
                    "investments_value_gbp": 1000,
                    "total_cost_gbp": 900,
                    "realized_profit_loss_gbp": 50,
                    "unrealized_profit_loss_gbp": 100,
                    "positions": [
                        {
                            "ticker": "BE",
                            "name": "Bloom Energy",
                            "quantity": 5,
                            "current_price": 260,
                            "price_currency": "USD",
                            "current_value_gbp": 1000,
                            "total_cost_gbp": 900,
                            "unrealized_profit_loss_gbp": 100,
                            "fx_impact_gbp": -7.5,
                        }
                    ],
                },
                "B": {
                    "profile": "isa",
                    "fetched_at_utc": "2026-08-01T19:00:00Z",
                    "total_value_gbp": 800,
                    "cash_gbp": 100,
                    "investments_value_gbp": 700,
                    "total_cost_gbp": 700,
                    "realized_profit_loss_gbp": 0,
                    "unrealized_profit_loss_gbp": 0,
                    "positions": [
                        {
                            "ticker": "XUSE",
                            "name": "World ex-USA",
                            "quantity": 100,
                            "current_price": 7,
                            "price_currency": "GBP",
                            "current_value_gbp": 700,
                            "total_cost_gbp": 700,
                            "unrealized_profit_loss_gbp": 0,
                        }
                    ],
                },
            },
        },
    )
    write_json(
        report / "diluted_cost_metrics.json",
        {
            "schema_version": 1,
            "holdings": [
                {
                    "account": "A",
                    "ticker": "BE",
                    "diluted_cost_gbp": 321.85,
                    "diluted_cost_per_share_gbp": 64.37,
                }
            ],
        },
    )
    risk = {
        "sharpe_sonia": 0.5,
        "sortino_sonia": 0.7,
        "calmar_ratio": 0.4,
        "information_ratio": 0.2,
        "annualized_volatility": 0.25,
        "max_drawdown": -0.2,
        "current_drawdown": -0.1,
        "benchmark_total_return": 0.1,
        "twr_total_return": 0.2,
        "annualized_return": 0.18,
        "benchmark_ticker": "VUAG",
        "net_external_flows_gbp": 1000,
    }
    write_json(yahoo / "synthetic_nav_metrics.json", {"A": risk, "B": risk})
    write_json(
        report / "policy_metrics.json",
        {
            "a_campaign": {
                "win_rate": 0.5,
                "payoff": 1.5,
                "profit_factor": 1.2,
                "expectancy": 4.2,
            },
            "b_policy": [
                {
                    "Bucket": "Core funds",
                    "realized_net": 10,
                    "gross_turnover": 100,
                    "q90_compliance": 0.8,
                }
            ],
        },
    )
    write_json(
        report / "lookthrough_metrics.json",
        {
            "schemaVersion": 1,
            "available": True,
            "generatedAt": "2026-08-01T20:00:00Z",
            "brokerAsOf": "2026-08-01T20:00:00Z",
            "investedValueGbp": 1700,
            "cashValueGbp": 300,
            "directValueGbp": 1000,
            "etfValueGbp": 700,
            "lookthroughValueGbp": 1698,
            "nonSecurityValueGbp": 2,
            "lookthroughCoveragePct": 0.9988,
            "underlyingCount": 104,
            "countryBasis": "country of risk / official fund geography",
            "countryAllocation": [
                {
                    "country": "United States",
                    "valueGbp": 1200,
                    "allocationPct": 0.7059,
                    "isNonCountry": False,
                }
            ],
            "industryBasis": "official fund sector allocation / direct equity sector",
            "industryAllocation": [
                {
                    "industry": "Industrials",
                    "valueGbp": 1000,
                    "allocationPct": 0.5882,
                    "isNonIndustry": False,
                },
                {
                    "industry": "Information Technology",
                    "valueGbp": 700,
                    "allocationPct": 0.4118,
                    "isNonIndustry": False,
                },
            ],
            "positions": [
                {
                    "isin": "US0937121079",
                    "ticker": "BE",
                    "name": "Bloom Energy",
                    "country": "United States",
                    "valueGbp": 1000,
                    "allocationPct": 0.5882,
                    "directValueGbp": 1000,
                    "indirectValueGbp": 0,
                    "etfContributors": [],
                }
            ],
            "sources": [],
        },
    )
    write_json(
        report / "realized_metrics.json",
        {
            "C": {
                "period_net_gbp": -20,
                "closed_positions": 2,
                "source": "fixture.csv",
            }
        },
    )
    write_json(
        report / "account_analysis_metrics.json",
        {
            "schemaVersion": 1,
            "accounts": {
                "A": {
                    "account": "A",
                    "name": "Invest",
                    "accountType": "investable",
                    "metricQuality": "realized_trade_proxy",
                    "period_net": 42.0,
                    "win_rate": 0.5,
                    "profit_factor": 1.2,
                    "riskNote": "fixture",
                }
            },
        },
    )
    csv_text = (
        "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
        "WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
        "2026-07-30,100,900,1000,1000,1000,,,\n"
        "2026-07-31,100,910,1010,0,0,0.01,1.01,0\n"
        "2026-08-01,100,920,1020,0,0,0.00990099,1.02,0\n"
    )
    yahoo.mkdir(parents=True, exist_ok=True)
    (yahoo / "daily_nav_a.csv").write_text(csv_text, encoding="utf-8")
    (yahoo / "daily_nav_b.csv").write_text(csv_text, encoding="utf-8")
    research = root / "research" / "2026-08-01"
    today = datetime.now(UTC).date().isoformat()
    write_json(
        research / "technical_analysis_2026-08-01.json",
        {
            "as_of": today,
            "benchmark_series": {
                "VOO": [
                    {"date": "2026-08-01", "close": 100.0},
                    {"date": today, "close": 101.5},
                ],
                "QQQ": [
                    {"date": "2026-08-01", "close": 200.0},
                    {"date": today, "close": 204.0},
                ],
                "VT": [
                    {"date": "2026-08-01", "close": 120.0},
                    {"date": today, "close": 121.0},
                ],
            },
            "rows": [
                {
                    "ticker": "BE",
                    "as_of": today,
                    "price": 200,
                    "technical_score": 45,
                    "technical_state": "中性",
                    "momentum": {
                        "rsi14": 50,
                        "macd": {"line": 1, "signal": 0.5, "histogram": 0.5},
                    },
                    "moving_averages": {"sma20": 190, "sma50": 180, "sma200": 150},
                    "structure": {
                        "support20": 180,
                        "resistance20": 220,
                        "drawdown_from_52w_high": -0.1,
                    },
                    "returns": {"r_20d": 0.1, "r_63d": 0.2},
                    "trend_strength": {"atr14_pct": 0.05},
                    "signals": ["fixture"],
                }
            ],
            "options": {
                "BE": {
                    "ticker": "BE",
                    "spot": 200,
                    "expiry_count": 2,
                    "captured_at_utc": f"{today}T18:00:00Z",
                    "aggregate": {
                        "put_call_oi_ratio": 0.8,
                        "call_oi_wall": {"strike": 220},
                        "put_oi_wall": {"strike": 180},
                        "max_pain_proxy": 195,
                        "net_gex_1pct_proxy": 12345,
                    },
                    "gamma_proxy": {
                        "gamma_regime": "positive",
                        "gamma_flip_proxy": 185,
                        "profile": [
                            {"spot": 180, "net_gex_1pct": -100},
                            {"spot": 200, "net_gex_1pct": 100},
                        ],
                    },
                }
            },
        },
    )
    write_json(
        research / "daily_refresh_2026-08-01.json",
        {
            "as_of": today,
            "rows": [
                {
                    "t": "BE",
                    "ccy": "USD",
                    "spot": 200,
                    "ev": 5000,
                    "fpe": 30,
                    "med": 230,
                    "aup": 0.15,
                    "day": 0.02,
                    "mdl": 220,
                    "held": True,
                }
            ],
        },
    )
    write_json(
        research / "earnings_refresh_2026-08-01.json",
        {
            "as_of": "2026-08-01",
            "source_hierarchy": "company IR release",
            "sources": {
                "be_q2_release": "https://example.com/be-q2",
            },
            "companies": {
                "BE": {
                    "period": "Q2 2026",
                    "valuation_note": "Guidance was reaffirmed.",
                    "fy2026_guidance": {"revenue": "$3.1bn-$3.3bn"},
                }
            },
            "valuation_overrides": [],
            "semi_valuation_overrides": [],
        },
    )
    write_json(
        research / "valuation_assumptions_2026-08-01.json",
        {
            "schema_version": 1,
            "as_of": "2026-08-01",
            "companies": [{"ticker": "BE"}],
        },
    )
    write_json(
        research / "valuation_engine_v2_output_2026-08-01.json",
        {
            "as_of": "2026-08-01",
            "rows": [
                {
                    "t": "BE",
                    "ccy": "USD",
                    "spot": 200,
                    "ev5": 220,
                    "ev10": 250,
                    "med": 230,
                    "impl": 0.2,
                    "base_g": 0.15,
                    "verdict": "fixture",
                }
            ],
        },
    )
    write_json(
        research / "fundamentals_analysis_2026-08-01.json",
        {
            "as_of": today,
            "rows": [
                {
                    "ticker": "BE",
                    "metrics": {
                        "currency": "USD",
                        "marketCap": 20_000_000_000,
                        "forwardPE": 30,
                        "grossMargins": 0.32,
                        "operatingMargins": 0.12,
                        "revenueGrowth": 0.18,
                        "freeCashflow": 250_000_000,
                    },
                }
            ],
        },
    )
    write_json(
        research / "financials_2026-08-01.json",
        {
            "as_of": today,
            "rows": [
                {
                    "ticker": "BE",
                    "financials": {
                        "incomeStatement": [
                            {
                                "index": "Total Revenue",
                                "2025-12-31": 1_500_000_000,
                                "2026-12-31": 1_800_000_000,
                            }
                        ],
                        "balanceSheet": [],
                        "cashflow": [],
                    },
                }
            ],
        },
    )
    return root
