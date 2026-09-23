"""Project immutable snapshot artifacts into dashboard-compatible data."""

from __future__ import annotations

from contextlib import suppress

from .artifacts import ArtifactStore
from .models import SnapshotManifest
from .projections.broker import overlay_live_broker_snapshot
from .projections.nav import intraday_nav_points, latest_daily_return, latest_twr, nav_series
from .projections.research import option_rows, technical_rows, valuation_rows
from .projections.values import JsonObject, nullable_number, number_value


def _risk_metrics(raw: JsonObject) -> JsonObject:
    benchmark = str(raw.get("benchmark_ticker") or "VOO")
    return {
        "sharpe": nullable_number(raw.get("sharpe_sonia")),
        "sortino": nullable_number(raw.get("sortino_sonia")),
        "calmar": nullable_number(raw.get("calmar_ratio")),
        "informationRatio": nullable_number(raw.get("information_ratio")),
        "volatility": nullable_number(raw.get("annualized_volatility")),
        "maxDrawdown": nullable_number(raw.get("max_drawdown")),
        "currentDrawdown": nullable_number(raw.get("current_drawdown")),
        "benchmarkReturn": nullable_number(raw.get("benchmark_total_return")),
        "twr": nullable_number(raw.get("twr_total_return")),
        "annualizedReturn": nullable_number(raw.get("annualized_return")),
        "benchmark": "VOO" if benchmark == "VUAG" else benchmark,
    }


def _benchmark_series(raw: JsonObject) -> dict[str, list[JsonObject]]:
    result: dict[str, list[JsonObject]] = {}
    payload = raw.get("benchmark_series")
    if not isinstance(payload, dict):
        return result
    for ticker, raw_points in payload.items():
        if not isinstance(raw_points, list):
            continue
        points: list[JsonObject] = []
        for point in raw_points:
            if not isinstance(point, dict):
                continue
            date = str(point.get("date") or "")
            close = nullable_number(point.get("close"))
            if date and close is not None:
                points.append({"date": date, "close": close})
        if points:
            result[str(ticker).upper()] = points
    return result


def _empty_lookthrough(
    *,
    invested_value: float,
    cash_value: float,
) -> JsonObject:
    """Keep older immutable snapshots readable before their next full refresh."""
    return {
        "available": False,
        "generatedAt": None,
        "brokerAsOf": None,
        "investedValueGbp": invested_value,
        "cashValueGbp": cash_value,
        "directValueGbp": 0.0,
        "etfValueGbp": 0.0,
        "lookthroughValueGbp": 0.0,
        "nonSecurityValueGbp": invested_value,
        "lookthroughCoveragePct": 0.0,
        "underlyingCount": 0,
        "countryBasis": "country of risk / official fund geography",
        "countryAllocation": [],
        "industryBasis": "official fund sector allocation / direct equity sector",
        "industryAllocation": [],
        "gicsSubIndustryBasis": ("GICS sub-industry assigned by the versioned security master"),
        "gicsCoveragePct": 0.0,
        "gicsPortfolioCoveragePct": 0.0,
        "gicsEligibleValueGbp": 0.0,
        "gicsClassifiedValueGbp": 0.0,
        "gicsPendingValueGbp": 0.0,
        "gicsNotApplicableValueGbp": invested_value,
        "gicsSubIndustryAllocation": [],
        "positions": [],
        "sources": [],
    }


def _normalize_account_analysis_payload(payload: JsonObject) -> JsonObject:
    """Project legacy immutable account-analysis values onto the current contract."""

    accounts = payload.get("accounts")
    if not isinstance(accounts, dict):
        return payload

    normalized_accounts: JsonObject = {}
    changed = False
    for code, raw_account in accounts.items():
        if not isinstance(raw_account, dict):
            normalized_accounts[code] = raw_account
            continue
        account = dict(raw_account)
        if account.get("accountType") == "historical-cfd":
            account["accountType"] = "cfd-imported"
        elif account.get("account_type") == "historical-cfd":
            account["account_type"] = "cfd-imported"
        if str(code).upper() == "C" and account.get("name") != "CFD":
            account["name"] = "CFD"
        changed = changed or account != raw_account
        normalized_accounts[code] = account

    if not changed:
        return payload
    return {**payload, "accounts": normalized_accounts}


def build_dashboard_data(
    store: ArtifactStore,
    manifest: SnapshotManifest | None = None,
    *,
    include_history: bool = True,
) -> JsonObject:
    manifest = manifest or store.latest_manifest()
    if manifest is None:
        raise FileNotFoundError("no snapshot has been published")
    run_id = manifest.run_id
    broker = store.read_json(run_id, "account/broker_snapshot_metrics.json")
    try:
        live_broker = store.read_json(run_id, "account/intraday/broker_values.json")
    except (FileNotFoundError, TypeError, ValueError):
        live_broker = None
    broker = overlay_live_broker_snapshot(broker, live_broker)
    account_codes = tuple(code for code in ("A", "B") if code in broker["accounts"])
    synthetic = store.read_json(run_id, "account/synthetic_nav_metrics.json")
    policy_raw = store.read_json(run_id, "account/policy_metrics.json")
    # Account refreshes are independently publishable.  A fresh installation
    # therefore has a useful portfolio snapshot before its first research run.
    # Keep the account dashboard available and expose empty research summaries
    # until that separately versioned scope has been published.
    try:
        technical_raw = store.read_json(run_id, "research/technical.json")
    except FileNotFoundError:
        technical_raw = {"as_of": "", "rows": []}
    try:
        valuation_raw = store.read_json(run_id, "research/valuation.json")
    except FileNotFoundError:
        valuation_raw = {"as_of": "", "rows": []}
    try:
        options_raw = store.read_json(run_id, "research/options.json")
    except FileNotFoundError:
        options_raw = technical_raw
    # The canonical broker snapshot defines the participating accounts. An
    # unconnected account has no NAV, while a missing connected NAV is an error.
    account_nav = {
        code: store.read_text(run_id, f"account/nav/daily_nav_{code.lower()}.csv")
        for code in account_codes
    }
    nav_a, nav_b = account_nav.get("A", ""), account_nav.get("B", "")
    try:
        nav_c = store.read_text(run_id, "account/nav/daily_nav_c.csv")
    except FileNotFoundError:
        nav_c = None
    try:
        cfd_metrics_raw = store.read_json(run_id, "account/cfd_metrics.json")
    except FileNotFoundError:
        cfd_metrics_raw = None
    try:
        cfd_analysis_raw = store.read_json(run_id, "account/cfd_analysis.json")
    except FileNotFoundError:
        cfd_analysis_raw = None
    intraday_nav = None
    cash_flows: dict[str, JsonObject] = {}
    if include_history:
        try:
            intraday_nav = store.read_json(
                run_id,
                "account/nav/valuation_history.json",
            )
        except (FileNotFoundError, TypeError, ValueError):
            try:
                intraday_nav = store.read_json(run_id, "account/nav/intraday_anchors.json")
            except (FileNotFoundError, TypeError, ValueError):
                intraday_nav = None
        for profile, code in (("invest", "a"), ("isa", "b")):
            with suppress(FileNotFoundError, TypeError, ValueError):
                cash_flows[profile] = store.read_json(run_id, f"account/nav/cash_flows_{code}.json")
    try:
        account_analysis_raw = store.read_json(run_id, "account/analysis_metrics.json")
    except FileNotFoundError:
        account_analysis_raw = {}
    else:
        # Immutable snapshots can outlive the API vocabulary that produced
        # them. Keep the snapshot readable without rewriting source evidence.
        account_analysis_raw = _normalize_account_analysis_payload(account_analysis_raw)
    try:
        account_reviews_raw = store.read_json(run_id, "account/account_reviews.json")
    except FileNotFoundError:
        account_reviews_raw = {}
    try:
        realized_report = store.read_json(run_id, "account/realized_metrics.json")
    except FileNotFoundError:
        realized_report = {}
    try:
        capital_recovery = store.read_json(run_id, "account/capital_recovery.json")
    except FileNotFoundError:
        capital_recovery = None

    total_value = sum(
        number_value(broker["accounts"][account].get("total_value_gbp"))
        for account in account_codes
    )
    total_invested = sum(
        number_value(broker["accounts"][account].get("investments_value_gbp"))
        for account in account_codes
    )
    total_cash = sum(
        number_value(broker["accounts"][account].get("cash_gbp")) for account in account_codes
    )
    try:
        lookthrough = store.read_json(run_id, "account/lookthrough_metrics.json")
    except FileNotFoundError:
        lookthrough = _empty_lookthrough(
            invested_value=total_invested,
            cash_value=total_cash,
        )
    else:
        # Older immutable snapshots predate the industry allocation. Keep them
        # readable rather than coupling dashboard deployment to a full rerun.
        lookthrough.setdefault(
            "industryBasis", "official fund sector allocation / direct equity sector"
        )
        lookthrough.setdefault("industryAllocation", [])
        lookthrough.setdefault(
            "gicsSubIndustryBasis",
            "GICS sub-industry assigned by the versioned security master",
        )
        lookthrough.setdefault("gicsCoveragePct", 0.0)
        lookthrough.setdefault(
            "gicsPortfolioCoveragePct",
            lookthrough.get("gicsCoveragePct", 0.0),
        )
        lookthrough.setdefault("gicsEligibleValueGbp", 0.0)
        lookthrough.setdefault("gicsClassifiedValueGbp", 0.0)
        lookthrough.setdefault("gicsPendingValueGbp", 0.0)
        lookthrough.setdefault("gicsNotApplicableValueGbp", 0.0)
        lookthrough.setdefault("gicsSubIndustryAllocation", [])
    try:
        diluted_cost_raw = store.read_json(run_id, "account/diluted_cost_metrics.json")
    except FileNotFoundError:
        diluted_cost_by_key: dict[tuple[str, str], JsonObject] = {}
    else:
        diluted_cost_by_key = {
            (str(row.get("account")), str(row.get("ticker"))): row
            for row in diluted_cost_raw.get("holdings", [])
            if isinstance(row, dict)
        }
    holdings: list[JsonObject] = []
    for account in account_codes:
        for position in broker["accounts"][account].get("positions", []):
            current = number_value(position.get("current_value_gbp"))
            cost = number_value(position.get("total_cost_gbp"))
            quantity = number_value(position.get("quantity"))
            current_price = number_value(position.get("current_price"))
            price_currency = str(position.get("price_currency") or "GBP")
            diluted_cost = diluted_cost_by_key.get(
                (account, str(position.get("ticker"))),
                {},
            )
            diluted_cost_per_share_gbp = nullable_number(
                diluted_cost.get("diluted_cost_per_share_gbp")
            )
            snapshot_fx_rate_native_per_gbp: float | None = None
            if price_currency == "GBP":
                snapshot_fx_rate_native_per_gbp = 1.0
            elif quantity and current and current_price:
                current_price_gbp = current / quantity
                if current_price_gbp:
                    snapshot_fx_rate_native_per_gbp = current_price / current_price_gbp
            diluted_cost_per_share_native = (
                diluted_cost_per_share_gbp * snapshot_fx_rate_native_per_gbp
                if diluted_cost_per_share_gbp is not None
                and snapshot_fx_rate_native_per_gbp is not None
                else None
            )
            holdings.append(
                {
                    "account": account,
                    "ticker": str(position.get("ticker")),
                    "name": str(position.get("name")),
                    "quantity": quantity,
                    "currentPrice": current_price,
                    "priceCurrency": price_currency,
                    "dilutedCostGbp": nullable_number(diluted_cost.get("diluted_cost_gbp")),
                    "dilutedCostPerShareGbp": diluted_cost_per_share_gbp,
                    "dilutedCostPerShareNative": diluted_cost_per_share_native,
                    "dilutedCostCurrency": price_currency,
                    "snapshotFxRateNativePerGbp": snapshot_fx_rate_native_per_gbp,
                    "fxImpactGbp": nullable_number(position.get("fx_impact_gbp")),
                    "currentValueGbp": current,
                    "costGbp": cost,
                    "pnlGbp": number_value(position.get("unrealized_profit_loss_gbp")),
                    "pnlPct": current / cost - 1.0 if cost else 0.0,
                    "allocationPct": current / total_value if total_value else 0.0,
                }
            )
    holdings.sort(key=lambda item: item["currentValueGbp"], reverse=True)

    account_names = {"A": "Invest", "B": "Stocks ISA"}
    daily_returns = {
        "A": latest_daily_return(nav_a),
        "B": latest_daily_return(nav_b),
    }
    cumulative_returns = {
        "A": latest_twr(nav_a),
        "B": latest_twr(nav_b),
    }
    accounts: list[JsonObject] = []
    for code in account_codes:
        raw = broker["accounts"][code]
        risk = synthetic[code]
        total = number_value(raw.get("total_value_gbp"))
        flows = number_value(risk.get("net_external_flows_gbp"))
        accounts.append(
            {
                "code": code,
                "name": account_names[code],
                "profile": str(raw.get("profile") or ""),
                "asOf": str(raw.get("fetched_at") or raw.get("fetched_at_utc") or ""),
                "totalValueGbp": total,
                "cashGbp": number_value(raw.get("cash_gbp")),
                "investedGbp": number_value(raw.get("investments_value_gbp")),
                "totalCostGbp": number_value(raw.get("total_cost_gbp")),
                "realizedPnlGbp": number_value(raw.get("realized_profit_loss_gbp")),
                "unrealizedPnlGbp": number_value(raw.get("unrealized_profit_loss_gbp")),
                "netExternalFlowsGbp": flows,
                "capitalDeltaGbp": total - flows,
                # Account headline return is sourced from the canonical NAV
                # ledger, not a downstream risk-metrics derivative.
                "twr": cumulative_returns[code],
                "dailyReturn": daily_returns[code],
                "accountType": "investable",
                "isInvestable": True,
                "navQuality": "synthetic_market_nav",
            }
        )

    cfd_raw = cfd_metrics_raw or synthetic.get("C")
    cfd_summary: JsonObject | None = None
    if isinstance(cfd_raw, dict):
        cfd_value = nullable_number(cfd_raw.get("ending_nav_gbp"))
        cfd_realized = nullable_number(
            cfd_raw.get("realized_profit_loss_gbp", cfd_raw.get("period_net_gbp")),
        )
        cfd_summary = {
            "code": "C",
            "name": "CFD",
            "profile": "CFD",
            "asOf": str(cfd_raw.get("last_event_date") or cfd_raw.get("end") or ""),
            "endingValueGbp": cfd_value,
            "netExternalFlowsGbp": nullable_number(cfd_raw.get("net_external_flows_gbp")),
            "realizedPnlGbp": cfd_realized,
            "reconciliationGapGbp": nullable_number(cfd_raw.get("reconciliation_gap_gbp")),
            "reconciliationStatus": str(cfd_raw.get("reconciliation_status") or "unknown"),
            "closedPositions": int(number_value(cfd_raw.get("closed_positions"))),
            "overnightChargesGbp": nullable_number(cfd_raw.get("overnight_charges_gbp")),
            "closedGrossPnlGbp": nullable_number(cfd_raw.get("closed_gross_pnl_gbp")),
            "fxFeesGbp": nullable_number(cfd_raw.get("fx_fees_gbp")),
            "closedAfterFxPnlGbp": nullable_number(cfd_raw.get("closed_after_fx_pnl_gbp")),
            "dividendAdjustmentsGbp": nullable_number(cfd_raw.get("dividend_adjustments_gbp")),
            "netRealisedPnlGbp": nullable_number(cfd_raw.get("realized_profit_loss_gbp")),
            "financingToGrossRatio": nullable_number(cfd_raw.get("financing_to_gross_ratio")),
            "financingToNetRatio": nullable_number(cfd_raw.get("financing_to_net_ratio")),
            "pnlSharpeProxy": nullable_number(cfd_raw.get("pnl_sharpe_proxy")),
            "maxDrawdownGbp": nullable_number(cfd_raw.get("max_drawdown_gbp")),
            "navQuality": str(cfd_raw.get("nav_quality") or "realized_cash_equity_proxy"),
            "trueNavAvailable": bool(cfd_raw.get("true_nav_available", False)),
            "source": str(cfd_raw.get("source") or ""),
            "warning": str(cfd_raw.get("warning") or ""),
            # Keep freshness semantics explicit even for legacy/synthetic CFD
            # artifacts that predate the import-status payload.
            "staleAfterDays": 14,
            "isStale": False,
            "accountStatus": "active",
            "staleRemindersEnabled": True,
        }
        import_status = cfd_raw.get("import_status")
        if not isinstance(import_status, dict) and isinstance(cfd_analysis_raw, dict):
            import_status = cfd_analysis_raw.get("import_status")
        if isinstance(import_status, dict):
            cfd_summary.update(
                {
                    "importedFiles": int(number_value(import_status.get("imported_files"))),
                    "lastImportedAt": import_status.get("last_imported_at"),
                    "coverageStartDate": import_status.get("coverage_start_date"),
                    "coverageEndDate": import_status.get("coverage_end_date"),
                    "latestEventAt": import_status.get("latest_event_at"),
                    "staleAfterDays": int(
                        number_value(import_status.get("stale_after_days"), 14.0)
                    ),
                    "isStale": bool(import_status.get("is_stale", False)),
                    "accountStatus": str(import_status.get("account_status") or "active"),
                    "staleRemindersEnabled": bool(
                        import_status.get("stale_reminders_enabled", True)
                    ),
                }
            )
        accounts.append(
            {
                "code": "C",
                "name": "CFD",
                "profile": "CFD",
                "asOf": cfd_summary["asOf"],
                "totalValueGbp": cfd_value,
                "cashGbp": cfd_value,
                "investedGbp": 0.0,
                "totalCostGbp": 0.0,
                "realizedPnlGbp": cfd_realized,
                "unrealizedPnlGbp": 0.0,
                "netExternalFlowsGbp": cfd_summary["netExternalFlowsGbp"],
                "capitalDeltaGbp": (
                    cfd_value - cfd_summary["netExternalFlowsGbp"]
                    if cfd_value is not None and cfd_summary["netExternalFlowsGbp"] is not None
                    else None
                ),
                "twr": None,
                "dailyReturn": None,
                "accountType": "cfd-imported",
                "isInvestable": False,
                "navQuality": cfd_summary["navQuality"],
            }
        )

    latest_model_return = (
        sum(
            (account["dailyReturn"] or 0.0) * account["totalValueGbp"]
            for account in accounts
            if account["isInvestable"]
        )
        / total_value
        if total_value
        else 0.0
    )
    technical = technical_rows(technical_raw)
    valuations = valuation_rows(valuation_raw)
    research_as_of = max(
        str(technical_raw.get("as_of") or ""),
        str(valuation_raw.get("as_of") or ""),
    )
    updated = manifest.created_at.isoformat()
    account_analysis_accounts = dict(account_analysis_raw.get("accounts") or {})
    account_analysis_details = dict(account_analysis_raw.get("details") or {})
    if cfd_summary is None:
        # A legacy immutable artifact may contain a retired CFD summary even
        # when this installation has no active CFD import. Do not make that
        # evidence look like an available current account.
        account_analysis_accounts.pop("C", None)
        account_analysis_details.pop("C", None)

    return {
        "generatedAt": updated,
        "brokerAsOf": str(broker.get("generated_at_utc") or ""),
        "researchAsOf": research_as_of,
        "totalValueGbp": total_value,
        "householdTotalValueGbp": (
            None
            if cfd_summary and cfd_summary["endingValueGbp"] is None
            else total_value + (cfd_summary["endingValueGbp"] if cfd_summary else 0.0)
        ),
        "totalCashGbp": total_cash,
        "totalInvestedGbp": total_invested,
        "totalUnrealizedPnlGbp": sum(account["unrealizedPnlGbp"] for account in accounts),
        "latestModelDayReturn": latest_model_return,
        "accounts": accounts,
        "accountAnalysis": account_analysis_accounts,
        "accountReviews": account_reviews_raw.get("accounts", {}),
        "accountReport": {
            "realized": realized_report,
            "policy": policy_raw,
            "nav": synthetic,
            "analysis": account_analysis_details,
            "capitalRecovery": capital_recovery,
        },
        "cfd": cfd_summary,
        "cfdReview": cfd_analysis_raw,
        "holdings": holdings,
        # Compatible resolution projections. Intraday now includes both
        # reconstructed and observed valuations, with explicit provenance.
        # Neither source certifies cash-flow-adjusted returns.
        "nav": nav_series(nav_a, nav_b, nav_c),
        "intradayNav": intraday_nav_points(intraday_nav, cash_flows),
        "risk": {code: _risk_metrics(synthetic[code]) for code in account_codes},
        "benchmarkSeries": _benchmark_series(technical_raw),
        "technical": technical,
        "options": option_rows(options_raw),
        "valuations": valuations,
        "lookthrough": lookthrough,
        "policy": {
            "winRate": nullable_number((policy_raw.get("a_campaign") or {}).get("win_rate")),
            "payoff": nullable_number((policy_raw.get("a_campaign") or {}).get("payoff")),
            "profitFactor": nullable_number(
                (policy_raw.get("a_campaign") or {}).get("profit_factor")
            ),
            "expectancy": nullable_number((policy_raw.get("a_campaign") or {}).get("expectancy")),
            "isaBuckets": [
                {
                    "bucket": str(row.get("Bucket")),
                    "realizedNet": nullable_number(row.get("realized_net")),
                    "turnover": nullable_number(row.get("gross_turnover")),
                    "compliance": number_value(row.get("q90_compliance")),
                }
                for row in policy_raw.get("b_policy", [])
            ],
        },
    }
