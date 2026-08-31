"""Project immutable snapshot artifacts into dashboard-compatible data."""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime
from math import isfinite
from typing import Any

from .artifacts import ArtifactStore
from .models import SnapshotManifest

JsonObject = dict[str, Any]


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed


def _nullable(value: Any) -> float | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rows(text: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text)))


def _nav_series(
    a_text: str,
    b_text: str,
    c_text: str | None = None,
) -> list[JsonObject]:
    account_rows = {
        "invest": {row["Date"]: row for row in _rows(a_text)},
        "isa": {row["Date"]: row for row in _rows(b_text)},
    }
    cfd_rows = {str(row["Date"]): row for row in _rows(c_text or "") if row.get("Date")}
    dates = sorted(set(account_rows["invest"]) | set(account_rows["isa"]) | set(cfd_rows))
    states: dict[str, JsonObject] = {
        account: {
            "started": False,
            "nav": None,
            "netContributionsGbp": 0.0,
            "netPnlGbp": None,
            "pnlPeakGbp": 0.0,
            "pnlDrawdownGbp": None,
            "twr": None,
            "drawdown": None,
        }
        for account in ("invest", "isa")
    }
    cfd_state: JsonObject = {
        "nav": None,
        "drawdown": None,
        "accountContributionsGbp": None,
        "householdExternalGbp": 0.0,
        "internalTransferCounterflowGbp": 0.0,
        "unmatchedInternalTransferGbp": 0.0,
        "householdTransferMatchStatus": None,
        "netPnlGbp": None,
        "overnightInterestGbp": None,
        "netRealisedPnlGbp": None,
    }
    previous_total_nav: float | None = None
    total_net_contributions = 0.0
    total_pnl_peak = 0.0
    total_wealth = 1.0
    total_peak = 1.0
    household_pnl_peak = 0.0
    result: list[JsonObject] = []

    for date in dates:
        daily_external_flow = 0.0
        daily_weighted_flow = 0.0
        for account in ("invest", "isa"):
            row = account_rows[account].get(date)
            if row is None:
                continue
            state = states[account]
            state["started"] = True
            state["nav"] = _nullable(row.get("SyntheticNAVGBP"))
            external_flow = _nullable(row.get("ExternalFlowGBP")) or 0.0
            weighted_flow = _nullable(row.get("WeightedExternalFlowGBP")) or 0.0
            state["netContributionsGbp"] = float(state["netContributionsGbp"]) + external_flow
            nav = state["nav"]
            if nav is not None:
                pnl = float(nav) - float(state["netContributionsGbp"])
                state["netPnlGbp"] = pnl
                state["pnlPeakGbp"] = max(float(state["pnlPeakGbp"]), pnl, 0.0)
                state["pnlDrawdownGbp"] = pnl - float(state["pnlPeakGbp"])
            twr_wealth = _nullable(row.get("TWRWealth"))
            if twr_wealth is not None:
                state["twr"] = twr_wealth - 1.0
            drawdown = _nullable(row.get("Drawdown"))
            if drawdown is not None:
                state["drawdown"] = drawdown
            daily_external_flow += external_flow
            daily_weighted_flow += weighted_flow

        cfd_row = cfd_rows.get(date)
        if cfd_row is not None:
            cfd_state["nav"] = _nullable(
                cfd_row.get("RealisedCashEquityProxyGBP") or cfd_row.get("SyntheticNAVGBP")
            )
            cfd_state["drawdown"] = _nullable(
                cfd_row.get("RealisedPnLDrawdownGBP") or cfd_row.get("CFDProxyDrawdownGBP")
            )
            cfd_state["accountContributionsGbp"] = _nullable(
                cfd_row.get("CumulativeAccountCashFlowGBP")
            )
            cfd_state["householdExternalGbp"] = (
                _nullable(cfd_row.get("CumulativeHouseholdExternalFlowGBP")) or 0.0
            )
            cfd_state["internalTransferCounterflowGbp"] = (
                _nullable(
                    cfd_row.get("CumulativeInternalTransferCounterflowGBP")
                    or cfd_row.get("CumulativeMatchedInternalTransferCounterflowGBP")
                )
                or 0.0
            )
            cfd_state["unmatchedInternalTransferGbp"] = (
                _nullable(cfd_row.get("CumulativeUnmatchedInternalTransferGBP")) or 0.0
            )
            cfd_state["householdTransferMatchStatus"] = (
                str(cfd_row.get("HouseholdTransferMatchStatus") or "").strip() or None
            )
            cfd_state["netPnlGbp"] = _nullable(cfd_row.get("CumulativeRealisedPnLGBP"))
            cfd_state["overnightInterestGbp"] = _nullable(
                cfd_row.get("CumulativeOvernightInterestGBP")
            )
            cfd_state["netRealisedPnlGbp"] = cfd_state["netPnlGbp"]

        active_navs = [
            float(state["nav"])
            for state in states.values()
            if state["started"] and state["nav"] is not None
        ]
        total = sum(active_navs) if active_navs else None
        total_net_contributions += daily_external_flow
        total_net_pnl = None if total is None else total - total_net_contributions
        if total_net_pnl is not None:
            total_pnl_peak = max(total_pnl_peak, total_net_pnl, 0.0)
        total_pnl_drawdown = None if total_net_pnl is None else total_net_pnl - total_pnl_peak

        # Calculate the combined strategy return directly from aggregate NAV and
        # aggregate external cash flow.  This avoids inception-day distortions
        # caused by averaging account-level returns when one account has not yet
        # established a return denominator.  Exact Invest↔ISA transfers cancel
        # at the portfolio boundary, including their timing weight.
        combined_return: float | None = None
        if previous_total_nav is not None and total is not None:
            if abs(daily_external_flow) <= 1e-9:
                daily_weighted_flow = 0.0
            denominator = previous_total_nav + daily_weighted_flow
            if previous_total_nav > 0 and denominator > 0:
                combined_return = (total - previous_total_nav - daily_external_flow) / denominator
        if combined_return is not None:
            total_wealth *= 1.0 + combined_return
            total_peak = max(total_peak, total_wealth)
        previous_total_nav = total

        invest_state = states["invest"]
        isa_state = states["isa"]
        cfd = cfd_state["nav"]
        household = (
            None if total is None and cfd is None else float(total or 0.0) + float(cfd or 0.0)
        )
        household_net_contributions = (
            None
            if household is None
            else (total_net_contributions if total is not None else 0.0)
            + float(cfd_state["householdExternalGbp"] or 0.0)
            + float(cfd_state["internalTransferCounterflowGbp"] or 0.0)
        )
        household_net_pnl = (
            None
            if household is None or household_net_contributions is None
            else household - household_net_contributions
        )
        if household_net_pnl is not None:
            household_pnl_peak = max(household_pnl_peak, household_net_pnl, 0.0)
        household_pnl_drawdown = (
            None if household_net_pnl is None else household_net_pnl - household_pnl_peak
        )
        result.append(
            {
                "date": date,
                "intraday": False,
                "flowStatus": "daily_official",
                "invest": invest_state["nav"] if invest_state["started"] else None,
                "isa": isa_state["nav"] if isa_state["started"] else None,
                "cfd": cfd,
                "total": total,
                "household": household,
                "investNetContributionsGbp": (
                    invest_state["netContributionsGbp"] if invest_state["started"] else None
                ),
                "isaNetContributionsGbp": (
                    isa_state["netContributionsGbp"] if isa_state["started"] else None
                ),
                "totalNetContributionsGbp": (
                    total_net_contributions if total is not None else None
                ),
                "cfdNetContributionsGbp": cfd_state["accountContributionsGbp"],
                "householdNetContributionsGbp": household_net_contributions,
                "householdInternalTransferCounterflowGbp": cfd_state[
                    "internalTransferCounterflowGbp"
                ],
                "householdUnmatchedInternalTransferGbp": cfd_state["unmatchedInternalTransferGbp"],
                "householdTransferMatchStatus": cfd_state["householdTransferMatchStatus"],
                "investNetPnlGbp": invest_state["netPnlGbp"],
                "isaNetPnlGbp": isa_state["netPnlGbp"],
                "totalNetPnlGbp": total_net_pnl,
                "cfdNetPnlGbp": cfd_state["netPnlGbp"],
                "householdNetPnlGbp": household_net_pnl,
                "investPnlDrawdownGbp": invest_state["pnlDrawdownGbp"],
                "isaPnlDrawdownGbp": isa_state["pnlDrawdownGbp"],
                "totalPnlDrawdownGbp": total_pnl_drawdown,
                "cfdPnlDrawdownGbp": cfd_state["drawdown"],
                "householdPnlDrawdownGbp": household_pnl_drawdown,
                "cfdOvernightInterestGbp": cfd_state["overnightInterestGbp"],
                "cfdNetRealisedPnlGbp": cfd_state["netRealisedPnlGbp"],
                "investTwr": invest_state["twr"],
                "isaTwr": isa_state["twr"],
                "totalTwr": None if combined_return is None else total_wealth - 1.0,
                "investDrawdown": invest_state["drawdown"],
                "isaDrawdown": isa_state["drawdown"],
                "totalDrawdown": (
                    None if combined_return is None else total_wealth / total_peak - 1.0
                ),
                "cfdProxyDrawdown": cfd_state["drawdown"],
            }
        )
    return result


def _intraday_nav_points(payload: JsonObject | None) -> list[JsonObject]:
    """Project rolling broker anchors into the dashboard NAV shape."""

    if not isinstance(payload, dict):
        return []
    points: list[JsonObject] = []
    for raw in payload.get("points", []):
        if not isinstance(raw, dict):
            continue
        observed = raw.get("observed_at")
        if not observed:
            continue
        invest = _nullable(raw.get("invest_value_gbp"))
        isa = _nullable(raw.get("isa_value_gbp"))
        total = _nullable(raw.get("total_value_gbp"))
        if invest is None or isa is None or total is None:
            continue
        points.append(
            {
                "date": str(observed),
                "intraday": True,
                "flowStatus": str(raw.get("flow_status") or "unverified"),
                "invest": invest,
                "isa": isa,
                "cfd": None,
                "total": total,
                "household": total,
                "investTwr": None,
                "isaTwr": None,
                "totalTwr": None,
                "investDrawdown": None,
                "isaDrawdown": None,
                "totalDrawdown": None,
                "cfdProxyDrawdown": None,
            }
        )
    return points


def _latest_daily_return(text: str) -> float | None:
    for row in reversed(_rows(text)):
        value = _nullable(row.get("DailyReturn"))
        if value is not None:
            return value
    return None


def _latest_twr(text: str) -> float | None:
    """Read the canonical cumulative TWR produced by the NAV ledger."""
    for row in reversed(_rows(text)):
        wealth = _nullable(row.get("TWRWealth"))
        if wealth is not None:
            return wealth - 1.0
    return None


def _risk_metrics(raw: JsonObject) -> JsonObject:
    benchmark = str(raw.get("benchmark_ticker") or "VOO")
    return {
        "sharpe": _nullable(raw.get("sharpe_sonia")),
        "sortino": _nullable(raw.get("sortino_sonia")),
        "calmar": _nullable(raw.get("calmar_ratio")),
        "informationRatio": _nullable(raw.get("information_ratio")),
        "volatility": _nullable(raw.get("annualized_volatility")),
        "maxDrawdown": _nullable(raw.get("max_drawdown")),
        "currentDrawdown": _nullable(raw.get("current_drawdown")),
        "benchmarkReturn": _nullable(raw.get("benchmark_total_return")),
        "twr": _nullable(raw.get("twr_total_return")),
        "annualizedReturn": _nullable(raw.get("annualized_return")),
        "benchmark": "VOO" if benchmark == "VUAG" else benchmark,
    }


def _technical_rows(raw: JsonObject) -> list[JsonObject]:
    result: list[JsonObject] = []
    for row in raw.get("rows", []):
        momentum = row.get("momentum") or {}
        macd = momentum.get("macd") or {}
        moving = row.get("moving_averages") or {}
        structure = row.get("structure") or {}
        returns = row.get("returns") or {}
        strength = row.get("trend_strength") or {}
        coverage = row.get("history_coverage") or {}
        adr = row.get("adr_research")
        result.append(
            {
                "ticker": str(row.get("ticker")),
                "asOf": str(row.get("as_of") or raw.get("as_of") or ""),
                "currency": str(row.get("currency") or "USD"),
                "historyCoverage": {
                    "requestedPeriod": str(coverage.get("requested_period") or ""),
                    "availableSessions": _number(coverage.get("available_sessions")),
                    "firstSession": str(coverage.get("first_session") or ""),
                    "lastSession": str(coverage.get("last_session") or ""),
                    "complete": bool(coverage.get("complete", True)),
                    "warning": coverage.get("warning"),
                },
                "adrResearch": (
                    {
                        "securityType": str(adr.get("security_type") or "ADR"),
                        "adrTicker": str(adr.get("adr_ticker") or ""),
                        "primaryTicker": str(adr.get("primary_ticker") or ""),
                        "depositary": str(adr.get("depositary") or ""),
                        "ordinarySharesPerAdr": _number(adr.get("ordinary_shares_per_adr")),
                        "adrPerOrdinaryShare": _number(adr.get("adr_per_ordinary_share")),
                        "adrSpotUsd": _number(adr.get("adr_spot_usd")),
                        "primarySpot": _number(adr.get("primary_spot")),
                        "primaryCurrency": str(adr.get("primary_currency") or ""),
                        "fxLocalPerUsd": _number(adr.get("fx_local_per_usd")),
                        "parityUsd": _number(adr.get("parity_usd")),
                        "premiumToParity": _number(adr.get("premium_to_parity")),
                        "availableSessions": _number(adr.get("available_sessions")),
                        "firstTradeSession": str(adr.get("first_trade_session") or ""),
                        "averageVolume20d": _number(adr.get("average_volume_20d")),
                        "averageDollarVolume20d": _number(adr.get("average_dollar_volume_20d")),
                        "arbitrageAssumption": str(adr.get("arbitrage_assumption") or "none"),
                        "warning": str(adr.get("warning") or ""),
                        "ratioSource": str(adr.get("ratio_source") or ""),
                    }
                    if isinstance(adr, dict)
                    else None
                ),
                "price": _number(row.get("price")),
                "score": _number(row.get("technical_score")),
                "state": str(row.get("technical_state") or "—"),
                "rsi": _nullable(momentum.get("rsi14")),
                "macd": _nullable(macd.get("line")),
                "macdSignal": _nullable(macd.get("signal")),
                "macdHistogram": _nullable(macd.get("histogram")),
                "sma20": _nullable(moving.get("sma20")),
                "sma50": _nullable(moving.get("sma50")),
                "sma200": _nullable(moving.get("sma200")),
                "support20": _nullable(structure.get("support20")),
                "resistance20": _nullable(structure.get("resistance20")),
                "drawdown52w": _nullable(structure.get("drawdown_from_52w_high")),
                "return20d": _nullable(returns.get("r_20d")),
                "return63d": _nullable(returns.get("r_63d")),
                "atrPct": _nullable(strength.get("atr14_pct")),
                "seasonality": [
                    dict(item) for item in row.get("seasonality", []) if isinstance(item, dict)
                ],
                "seasonalityCoverage": {
                    "basis": str((row.get("seasonality_coverage") or {}).get("basis") or ""),
                    "firstSession": str(
                        (row.get("seasonality_coverage") or {}).get("first_session") or ""
                    ),
                    "lastSession": str(
                        (row.get("seasonality_coverage") or {}).get("last_session") or ""
                    ),
                    "dailySessions": _number(
                        (row.get("seasonality_coverage") or {}).get("daily_sessions")
                    ),
                    "monthlyObservations": _number(
                        (row.get("seasonality_coverage") or {}).get("monthly_observations")
                    ),
                },
                "signals": [str(item) for item in row.get("signals", [])],
            }
        )
    return result


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
            close = _nullable(point.get("close"))
            if date and close is not None:
                points.append({"date": date, "close": close})
        if points:
            result[str(ticker).upper()] = points
    return result


def _option_rows(raw: JsonObject) -> list[JsonObject]:
    result: list[JsonObject] = []
    raw_entries = raw.get("rows")
    entries = (
        raw_entries if isinstance(raw_entries, list) else list((raw.get("options") or {}).values())
    )
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        aggregate = entry.get("aggregate") or {}
        gamma = entry.get("gamma_proxy") or {}
        expiry_rows = entry.get("expiries") or []
        contract_rows = entry.get("contracts") or []
        result.append(
            {
                "ticker": str(entry.get("ticker")),
                "spot": _number(entry.get("spot")),
                "expiryCount": _number(entry.get("expiry_count")),
                "capturedAt": str(entry.get("captured_at") or entry.get("captured_at_utc") or ""),
                "putCallOiRatio": _nullable(aggregate.get("put_call_oi_ratio")),
                "callWall": _nullable((aggregate.get("call_oi_wall") or {}).get("strike")),
                "putWall": _nullable((aggregate.get("put_oi_wall") or {}).get("strike")),
                "maxPain": _nullable(aggregate.get("max_pain_proxy")),
                "netGex": _nullable(aggregate.get("net_gex_1pct_proxy")),
                "gammaRegime": (
                    str(gamma.get("gamma_regime")) if gamma.get("gamma_regime") else None
                ),
                "gammaFlip": _nullable(gamma.get("gamma_flip_proxy")),
                "gammaProfile": [
                    {
                        "spot": _number(point.get("spot")),
                        "netGex": _number(point.get("net_gex_1pct")),
                    }
                    for point in gamma.get("profile", [])
                ],
                "expiries": [
                    {
                        "expiry": str(row.get("expiry") or ""),
                        "daysToExpiry": _nullable(row.get("days_to_expiry")),
                        "callOpenInterest": _nullable(row.get("call_open_interest")),
                        "putOpenInterest": _nullable(row.get("put_open_interest")),
                        "putCallOiRatio": _nullable(row.get("put_call_oi_ratio")),
                        "callVolume": _nullable(row.get("call_volume")),
                        "putVolume": _nullable(row.get("put_volume")),
                        "callIv": _nullable(row.get("call_oi_weighted_iv")),
                        "putIv": _nullable(row.get("put_oi_weighted_iv")),
                        "callWall": _nullable((row.get("call_oi_wall") or {}).get("strike")),
                        "putWall": _nullable((row.get("put_oi_wall") or {}).get("strike")),
                        "maxPain": _nullable(row.get("max_pain_proxy")),
                    }
                    for row in expiry_rows
                    if isinstance(row, dict)
                ],
                "contracts": [
                    {
                        "expiry": str(row.get("expiry") or ""),
                        "side": str(row.get("side") or ""),
                        "contractSymbol": (
                            str(row.get("contract_symbol")) if row.get("contract_symbol") else None
                        ),
                        "strike": _number(row.get("strike")),
                        "lastPrice": _nullable(row.get("last_price")),
                        "bid": _nullable(row.get("bid")),
                        "ask": _nullable(row.get("ask")),
                        "openInterest": _nullable(row.get("open_interest")),
                        "volume": _nullable(row.get("volume")),
                        "impliedVolatility": _nullable(row.get("iv")),
                        "inTheMoney": bool(row.get("in_the_money", False)),
                    }
                    for row in contract_rows
                    if isinstance(row, dict) and row.get("side") in {"call", "put"}
                ],
            }
        )
    return result


def _valuation_rows(raw: JsonObject) -> list[JsonObject]:
    result: list[JsonObject] = []
    for row in raw.get("rows", []):
        if not isinstance(row, dict):
            continue
        lenses = row.get("lenses") or {}
        spot = _number(row.get("price") if "price" in row else row.get("spot"))
        ev5 = _nullable(row.get("ev5"))
        ev10 = _nullable(row.get("ev10"))
        result.append(
            {
                "ticker": str(row.get("ticker") or row.get("t") or ""),
                "asOf": str(row.get("as_of") or raw.get("as_of") or ""),
                "currency": str(row.get("currency") or row.get("ccy") or "USD"),
                "spot": spot,
                "ev5": ev5,
                "ev10": ev10,
                "analystMedian": _nullable(row.get("med")),
                "impliedGrowth": _nullable(row.get("impl")),
                "baseGrowth": _nullable(row.get("base_g")),
                "verdict": str(row.get("verdict") or "—"),
                "trailingPe": _nullable(lenses.get("trailingPE")),
                "forwardPe": _nullable(lenses.get("forwardPE")),
                "priceToSales": _nullable(lenses.get("priceToSalesTrailing12Months")),
                "priceToBook": _nullable(lenses.get("priceToBook")),
                "enterpriseToEbitda": _nullable(lenses.get("enterpriseToEbitda")),
                "ev5Upside": ev5 / spot - 1.0 if ev5 is not None and spot else None,
                "ev10Upside": (ev10 / spot - 1.0 if ev10 is not None and spot else None),
                "modelStatus": str(row.get("model_status") or "—"),
                "modelWarnings": row.get("model_warnings") or [],
                "method": str(row.get("method") or ""),
                "reportedGrowth": _nullable(row.get("reported_g")),
                "impliedGrowthBound": str(row.get("implBound") or "") or None,
                "valueRange": row.get("valueRange") or {},
                "valueRange10": row.get("valueRange10") or {},
                "scenarios": row.get("scenarios") or {},
                "terminalCheck": row.get("terminalCheck") or {},
                "sensitivity": row.get("sensitivity") or None,
            }
        )
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


def _observed_at(account: JsonObject) -> datetime | None:
    raw = account.get("fetched_at") or account.get("fetched_at_utc")
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def _verified_live_positions(account: JsonObject) -> list[JsonObject] | None:
    """Return live positions only when the payload still reconciles locally."""

    checks = account.get("checks")
    positions = account.get("positions")
    if (
        account.get("positions_status") != "verified"
        or not isinstance(checks, dict)
        or checks.get("positions_match_investments") is not True
        or not isinstance(positions, list)
    ):
        return None

    investments = _nullable(account.get("investments_value_gbp"))
    if investments is None or not isfinite(investments):
        return None
    normalized: list[JsonObject] = []
    position_value = 0.0
    for raw_position in positions:
        if not isinstance(raw_position, dict):
            return None
        current_value = _nullable(raw_position.get("current_value_gbp"))
        if current_value is None or not isfinite(current_value):
            return None
        position_value += current_value
        normalized.append(raw_position)

    tolerance = _nullable(account.get("position_tolerance_gbp"))
    if tolerance is None or not isfinite(tolerance) or tolerance < 0:
        tolerance = max(0.02, abs(investments) * 0.0005)
    if abs(position_value - investments) > tolerance + 1e-9:
        return None
    return normalized


def _overlay_live_broker_snapshot(
    canonical: JsonObject,
    live: JsonObject | None,
) -> JsonObject:
    """Overlay fresh broker totals and reconciliation-safe live positions."""

    if not isinstance(live, dict):
        return canonical
    canonical_accounts = canonical.get("accounts")
    live_accounts = live.get("accounts")
    if not isinstance(canonical_accounts, dict) or not isinstance(live_accounts, dict):
        return canonical

    merged_accounts = dict(canonical_accounts)
    overlaid = False
    for code in ("A", "B"):
        raw_canonical = canonical_accounts.get(code)
        raw_live = live_accounts.get(code)
        if not isinstance(raw_canonical, dict) or not isinstance(raw_live, dict):
            continue
        canonical_time = _observed_at(raw_canonical)
        live_time = _observed_at(raw_live)
        if live_time is None or (canonical_time is not None and live_time < canonical_time):
            continue

        account = dict(raw_canonical)
        for key in (
            "profile",
            "fetched_at",
            "source",
            "total_value_gbp",
            "cash_gbp",
            "investments_value_gbp",
            "position_value_gbp",
            "position_delta_gbp",
            "position_tolerance_gbp",
            "positions_status",
            "checks",
        ):
            if key in raw_live:
                account[key] = raw_live[key]
        live_positions = _verified_live_positions(raw_live)
        if live_positions is not None:
            account["positions"] = live_positions
        # When live positions are absent or fail reconciliation, deliberately
        # leave the previous canonical verified positions in place.
        merged_accounts[code] = account
        overlaid = True

    if not overlaid:
        return canonical
    merged = {**canonical, "accounts": merged_accounts}
    if live.get("generated_at_utc"):
        merged["generated_at_utc"] = live["generated_at_utc"]
    return merged


def build_dashboard_data(
    store: ArtifactStore,
    manifest: SnapshotManifest | None = None,
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
    broker = _overlay_live_broker_snapshot(broker, live_broker)
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
    nav_a = store.read_text(run_id, "account/nav/daily_nav_a.csv")
    nav_b = store.read_text(run_id, "account/nav/daily_nav_b.csv")
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
    try:
        intraday_nav = store.read_json(
            run_id,
            "account/nav/intraday_anchors.json",
        )
    except (FileNotFoundError, TypeError, ValueError):
        intraday_nav = None
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
        _number(broker["accounts"][account].get("total_value_gbp")) for account in ("A", "B")
    )
    total_invested = sum(
        _number(broker["accounts"][account].get("investments_value_gbp")) for account in ("A", "B")
    )
    total_cash = sum(_number(broker["accounts"][account].get("cash_gbp")) for account in ("A", "B"))
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
    for account in ("A", "B"):
        for position in broker["accounts"][account].get("positions", []):
            current = _number(position.get("current_value_gbp"))
            cost = _number(position.get("total_cost_gbp"))
            quantity = _number(position.get("quantity"))
            current_price = _number(position.get("current_price"))
            price_currency = str(position.get("price_currency") or "GBP")
            diluted_cost = diluted_cost_by_key.get(
                (account, str(position.get("ticker"))),
                {},
            )
            diluted_cost_per_share_gbp = _nullable(diluted_cost.get("diluted_cost_per_share_gbp"))
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
                    "dilutedCostGbp": _nullable(diluted_cost.get("diluted_cost_gbp")),
                    "dilutedCostPerShareGbp": diluted_cost_per_share_gbp,
                    "dilutedCostPerShareNative": diluted_cost_per_share_native,
                    "dilutedCostCurrency": price_currency,
                    "snapshotFxRateNativePerGbp": snapshot_fx_rate_native_per_gbp,
                    "fxImpactGbp": _nullable(position.get("fx_impact_gbp")),
                    "currentValueGbp": current,
                    "costGbp": cost,
                    "pnlGbp": _number(position.get("unrealized_profit_loss_gbp")),
                    "pnlPct": current / cost - 1.0 if cost else 0.0,
                    "allocationPct": current / total_value if total_value else 0.0,
                }
            )
    holdings.sort(key=lambda item: item["currentValueGbp"], reverse=True)

    account_names = {"A": "Invest", "B": "Stocks ISA"}
    daily_returns = {
        "A": _latest_daily_return(nav_a),
        "B": _latest_daily_return(nav_b),
    }
    cumulative_returns = {
        "A": _latest_twr(nav_a),
        "B": _latest_twr(nav_b),
    }
    accounts: list[JsonObject] = []
    for code in ("A", "B"):
        raw = broker["accounts"][code]
        risk = synthetic[code]
        total = _number(raw.get("total_value_gbp"))
        flows = _number(risk.get("net_external_flows_gbp"))
        accounts.append(
            {
                "code": code,
                "name": account_names[code],
                "profile": str(raw.get("profile") or ""),
                "asOf": str(raw.get("fetched_at") or raw.get("fetched_at_utc") or ""),
                "totalValueGbp": total,
                "cashGbp": _number(raw.get("cash_gbp")),
                "investedGbp": _number(raw.get("investments_value_gbp")),
                "totalCostGbp": _number(raw.get("total_cost_gbp")),
                "realizedPnlGbp": _number(raw.get("realized_profit_loss_gbp")),
                "unrealizedPnlGbp": _number(raw.get("unrealized_profit_loss_gbp")),
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
        cfd_value = _number(cfd_raw.get("ending_nav_gbp"))
        cfd_realized = _number(
            cfd_raw.get("realized_profit_loss_gbp"),
            _number(cfd_raw.get("period_net_gbp")),
        )
        cfd_summary = {
            "code": "C",
            "name": "CFD",
            "profile": "CFD",
            "asOf": str(cfd_raw.get("last_event_date") or cfd_raw.get("end") or ""),
            "endingValueGbp": cfd_value,
            "netExternalFlowsGbp": _number(cfd_raw.get("net_external_flows_gbp")),
            "realizedPnlGbp": cfd_realized,
            "reconciliationGapGbp": _number(cfd_raw.get("reconciliation_gap_gbp")),
            "reconciliationStatus": str(cfd_raw.get("reconciliation_status") or "unknown"),
            "closedPositions": int(_number(cfd_raw.get("closed_positions"))),
            "overnightChargesGbp": _number(cfd_raw.get("overnight_charges_gbp")),
            "closedGrossPnlGbp": _nullable(cfd_raw.get("closed_gross_pnl_gbp")),
            "fxFeesGbp": _nullable(cfd_raw.get("fx_fees_gbp")),
            "closedAfterFxPnlGbp": _nullable(cfd_raw.get("closed_after_fx_pnl_gbp")),
            "dividendAdjustmentsGbp": _nullable(cfd_raw.get("dividend_adjustments_gbp")),
            "netRealisedPnlGbp": _nullable(cfd_raw.get("realized_profit_loss_gbp")),
            "financingToGrossRatio": _nullable(cfd_raw.get("financing_to_gross_ratio")),
            "financingToNetRatio": _nullable(cfd_raw.get("financing_to_net_ratio")),
            "pnlSharpeProxy": _nullable(cfd_raw.get("pnl_sharpe_proxy")),
            "maxDrawdownGbp": _number(cfd_raw.get("max_drawdown_gbp")),
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
                    "importedFiles": int(_number(import_status.get("imported_files"))),
                    "lastImportedAt": import_status.get("last_imported_at"),
                    "coverageStartDate": import_status.get("coverage_start_date"),
                    "coverageEndDate": import_status.get("coverage_end_date"),
                    "latestEventAt": import_status.get("latest_event_at"),
                    "staleAfterDays": int(_number(import_status.get("stale_after_days"), 14.0)),
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
                "capitalDeltaGbp": cfd_value - cfd_summary["netExternalFlowsGbp"],
                "twr": None,
                "dailyReturn": None,
                "accountType": "cfd-imported",
                "isInvestable": False,
                "navQuality": cfd_summary["navQuality"],
            }
        )

    latest_model_return = (
        sum((account["dailyReturn"] or 0.0) * account["totalValueGbp"] for account in accounts)
        / total_value
        if total_value
        else 0.0
    )
    technical = _technical_rows(technical_raw)
    valuations = _valuation_rows(valuation_raw)
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
        "householdTotalValueGbp": total_value
        + (cfd_summary["endingValueGbp"] if cfd_summary else 0.0),
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
        # Keep canonical daily NAV and unverified broker intraday anchors as
        # separate contract fields. Mixing them made long-horizon NAV charts
        # silently change frequency and allowed raw value changes to masquerade
        # as short-range performance.
        "nav": _nav_series(nav_a, nav_b, nav_c),
        "intradayNav": _intraday_nav_points(intraday_nav),
        "risk": {
            "A": _risk_metrics(synthetic["A"]),
            "B": _risk_metrics(synthetic["B"]),
        },
        "benchmarkSeries": _benchmark_series(technical_raw),
        "technical": technical,
        "options": _option_rows(options_raw),
        "valuations": valuations,
        "lookthrough": lookthrough,
        "policy": {
            "winRate": _number((policy_raw.get("a_campaign") or {}).get("win_rate")),
            "payoff": _number((policy_raw.get("a_campaign") or {}).get("payoff")),
            "profitFactor": _number((policy_raw.get("a_campaign") or {}).get("profit_factor")),
            "expectancy": _number((policy_raw.get("a_campaign") or {}).get("expectancy")),
            "isaBuckets": [
                {
                    "bucket": str(row.get("Bucket")),
                    "realizedNet": _number(row.get("realized_net")),
                    "turnover": _number(row.get("gross_turnover")),
                    "compliance": _number(row.get("q90_compliance")),
                }
                for row in policy_raw.get("b_policy", [])
            ],
        },
    }
