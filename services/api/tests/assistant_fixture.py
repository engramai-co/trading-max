"""Synthetic snapshot shared by assistant tests and the offline evaluation fixture."""

from dataclasses import replace
from datetime import UTC, datetime

from services.api.trading_max_api.agent import tools

DATES = ["2026-01-28", "2026-01-29", "2026-01-30", "2026-02-02", "2026-02-03"]
AS_OF = "2026-02-03T17:00:00Z"
STALE_NOW = datetime(2026, 3, 21, tzinfo=UTC)


def publication(
    store,
    *,
    invest_total=1000,
    long_research=False,
    with_cfd=True,
    research_note=None,
    created_at=None,
    extra_artifacts=None,
    extra_files=None,
):
    def account(code, total, ticker):
        return {
            "fetched_at": "2026-02-03T16:00:00Z",
            "total_value_gbp": total,
            "cash_gbp": 100,
            "investments_value_gbp": total - 100,
            "realized_profit_loss_gbp": 20,
            "unrealized_profit_loss_gbp": 10,
            "positions": [
                {
                    "ticker": ticker,
                    "name": "Synthetic " + code,
                    "quantity": 10,
                    "current_price": 90,
                    "price_currency": "GBP",
                    "current_value_gbp": total - 100,
                    "total_cost_gbp": total - 110,
                    "unrealized_profit_loss_gbp": 10,
                    "fx_impact_gbp": 0,
                }
            ],
        }

    invest, isa = account("Invest", invest_total, "TEST"), account("ISA", 420, "FICT")
    fund = {
        "ticker": "TEST",
        "currency": "USD",
        "name": "Synthetic issuer",
        "sector": "Technology",
        "metrics": {
            "fullExchangeName": "NYSE",
            "exchangeTimezoneName": "America/New_York",
            "quoteType": "EQUITY",
            "regularMarketPrice": 30,
            "regularMarketTime": datetime(2026, 2, 3, 16, tzinfo=UTC).timestamp(),
            "targetMedianPrice": 40,
        },
    }
    if research_note is not None:
        fund["metrics"]["researchNote"] = research_note
    if long_research:
        fund["metrics"]["longSyntheticStatements"] = [
            {"date": f"synthetic-{i}", "description": "synthetic-character-测试" * 240}
            for i in range(28)
        ]
    payloads = {
        tools.BROKER: {
            "generated_at_utc": "2026-02-03T16:00:00Z",
            "accounts": {"A": invest, "B": isa},
        },
        tools.LIVE: {
            "generated_at_utc": AS_OF,
            "accounts": {
                "A": {
                    "fetched_at": AS_OF,
                    "total_value_gbp": invest_total + 5,
                    "positions_status": "unverified",
                    "positions": [{"ticker": "NEVER", "current_value_gbp": 9999}],
                },
                "B": {
                    "fetched_at": AS_OF,
                    "investments_value_gbp": 320,
                    "positions_status": "verified",
                    "checks": {"positions_match_investments": True},
                    "positions": [{**isa["positions"][0], "current_price": 32}],
                },
            },
        },
        tools.LOOKTHROUGH: {
            "available": True,
            "lookthroughCoveragePct": 1,
            "investedValueGbp": 1220,
            "nonSecurityValueGbp": 0,
            "brokerAsOf": AS_OF,
            "countryAllocation": [
                {"country": "United States", "valueGbp": 1220, "allocationPct": 1}
            ],
            "industryAllocation": [
                {"industry": "Technology", "valueGbp": 1220, "allocationPct": 1}
            ],
            "positions": [
                {"name": "Issuer", "ticker": "TEST", "valueGbp": 1220, "allocationPct": 1}
            ],
        },
        tools.TECHNICAL: {
            "rows": [{"ticker": "TEST", "price": 30, "currency": "USD", "technical_score": 71}],
            "benchmark_currency": "GBP",
            "benchmark_return_basis": "adjusted_price_gbp",
            "benchmark_series": {
                "VOO": [{"date": day, "close": 100 + i * 2} for i, day in enumerate(DATES)]
            },
        },
        tools.FUNDAMENTALS: {"rows": [fund]},
        tools.VALUATION: {
            "rows": [
                {
                    "ticker": "TEST",
                    "currency": "USD",
                    "method": "dcf",
                    "assumptions": {"secret_private_scenario": "synthetic-never-output"},
                }
            ],
        },
        tools.COVERAGE: {
            "rows": [
                {
                    "ticker": "TEST",
                    "datasets": {
                        "technical": {"state": "stale", "lastSuccessfulAt": AS_OF},
                        "valuation": {"state": "available", "lastSuccessfulAt": AS_OF},
                        "options": {"state": "failed", "reason": "synthetic-no-output"},
                    },
                }
            ],
        },
        tools.OPTIONS: {"rows": [{"ticker": "OTHER", "expiry_count": 1}]},
        tools.DECISIONS: {
            "accounts": {
                "A": {
                    "status": "available",
                    "as_of": AS_OF,
                    "decisions": [
                        {
                            "ticker": "TEST",
                            "date": DATES[-1],
                            "side": "buy",
                            "kind": "B",
                            "quantity": 3,
                            "amount_gbp": 33,
                        }
                    ],
                },
                "B": {"status": "unavailable", "reason": "synthetic-no-output"},
            },
        },
    }
    payloads["account/exposure_history/2026-02-03.json"] = payloads[tools.LOOKTHROUGH]
    payloads[tools.TECHNICAL]["rows"][0]["price_series"] = [
        {
            "date": day,
            "close": close,
            "volume": 100 + i,
            "high": None,
            "low": None,
            "open": None,
            "sma20": None,
            "sma50": None,
            "sma200": None,
        }
        for i, (day, close) in enumerate(zip(DATES, [32, 32, 34, 33, 30], strict=True))
    ]
    payloads[tools.ANALYST] = {
        "rows": [
            {
                "ticker": "TEST",
                "analyst": {
                    "earningsEvents": [
                        {"date": DATES[-1], "id": "synthetic-report", "status": "reported"}
                    ]
                },
            }
        ]
    }
    payloads[tools.HISTORY_KEYS[3]] = {
        "points": [
            {
                "observed_at": "2025-12-01T12:00:00Z",
                "source": "reconstructed",
                "total_value_gbp": 800,
                "isa_value_gbp": 800,
            },
            {"observed_at": "2026-01-09T12:00:00Z", "total_value_gbp": 900, "isa_value_gbp": 900},
            {
                "observed_at": "2026-02-03T12:00:00Z",
                "total_value_gbp": 1500,
                "invest_value_gbp": 1000,
                "isa_value_gbp": 500,
            },
            {
                "observed_at": AS_OF,
                "total_value_gbp": 1420,
                "invest_value_gbp": 1000,
                "isa_value_gbp": 420,
            },
        ]
    }
    for key in tools.HISTORY_KEYS[5:]:
        payloads[key] = {
            "verified": True,
            "covered_from": "2025-12-01T00:00:00Z",
            "covered_until": AS_OF,
            "events": [],
        }
    if with_cfd:
        payloads.update(
            {
                tools.CFD: {
                    "ending_nav_gbp": 20,
                    "realized_profit_loss_gbp": -80,
                    "end": DATES[-1],
                },
                tools.CFD_LEDGER: {
                    "coverage_start": DATES[0],
                    "coverage_end": DATES[-1],
                    "latest_event_at": AS_OF,
                    "events": [
                        {
                            "symbol": "TEST",
                            "record_type": "closed_position",
                            "occurred_at": AS_OF,
                            "account_currency": "GBP",
                            "gross_result": "-1.23",
                            "provenance": [{"source_name": "synthetic-upload-never-output.csv"}],
                        }
                    ],
                },
            }
        )

    def nav(values):
        return "Date,SyntheticNAVGBP,ExternalFlowGBP,TWRWealth\n" + "".join(
            f"{day},{value},{100 if i == 3 else 0},{wealth}\n"
            for i, (day, (value, wealth)) in enumerate(zip(DATES, values, strict=True))
        )

    files = {
        tools.HISTORY_KEYS[0]: nav(
            [(900, 1), (950, 1.05), (950, 1.05), (1100, 1.10), (1000, 1.02)]
        ),
        tools.HISTORY_KEYS[1]: nav([(400, 1), (405, 1.01), (400, 1), (500, 1), (420, 0.84)]),
    }
    if with_cfd:
        files[tools.HISTORY_KEYS[2]] = (
            "Date,RealisedCashEquityProxyGBP,CumulativeAccountCashFlowGBP,"
            "CumulativeHouseholdExternalFlowGBP,CumulativeRealisedPnLGBP\n"
            + "".join(f"{day},{100 - i * 20},100,100,{-i * 20}\n" for i, day in enumerate(DATES))
        )
    if created_at is not None:
        # Valuation evidence uses these timestamps to bind observations to the
        # synthetic publication cutoff, independently of the wall clock.
        for key in (tools.FUNDAMENTALS, tools.VALUATION):
            payloads[key]["generated_at"] = AS_OF
    files.update(extra_files or {})
    payloads.update(extra_artifacts or {})
    backing = store.immutable_artifacts
    refs = [
        backing.put_json(key=key, payload=payload, as_of=AS_OF) for key, payload in payloads.items()
    ]
    refs.extend(
        backing.put_bytes(key=key, content=content.encode(), media_type="text/csv", as_of=AS_OF)
        for key, content in files.items()
    )
    if created_at is None:
        return store.publish_typed(scope="all", source="synthetic", artifacts=refs)
    timestamp = datetime.fromisoformat(AS_OF)
    store.immutable_snapshots.publish(
        scope="all",
        source="synthetic",
        artifacts=[
            replace(item, ref=item.ref.model_copy(update={"generated_at": timestamp}))
            for item in refs
        ],
        created_at=created_at,
    )
    return store.latest_manifest()
