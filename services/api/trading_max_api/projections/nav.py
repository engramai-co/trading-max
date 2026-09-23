"""Pure daily and intraday NAV projections shared by all dashboard readers."""

from __future__ import annotations

from ..portfolio_cashflows import CashFlowTimeline
from .values import JsonObject, csv_rows, nullable_number


def _performance_eligible(row: dict[str, str]) -> bool:
    # Legacy CSVs have no status. An explicit rejection must never be revived
    # by recomputing performance from the same uncertain NAV/flow inputs.
    return str(row.get("PerformanceStatus") or "").strip() in {"", "eligible"}


def nav_series(
    a_text: str,
    b_text: str,
    c_text: str | None = None,
) -> list[JsonObject]:
    account_rows = {
        "invest": {row["Date"]: row for row in csv_rows(a_text)},
        "isa": {row["Date"]: row for row in csv_rows(b_text)},
    }
    cfd_rows = {str(row["Date"]): row for row in csv_rows(c_text or "") if row.get("Date")}
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
        "started": False,
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
    performance_valid = dict.fromkeys(states, True)
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
            performance_valid[account] &= _performance_eligible(row)
            state["started"] = True
            state["nav"] = nullable_number(row.get("SyntheticNAVGBP"))
            external_flow = nullable_number(row.get("ExternalFlowGBP")) or 0.0
            weighted_flow = nullable_number(row.get("WeightedExternalFlowGBP")) or 0.0
            state["netContributionsGbp"] = float(state["netContributionsGbp"]) + external_flow
            nav = state["nav"]
            if nav is not None:
                pnl = float(nav) - float(state["netContributionsGbp"])
                state["netPnlGbp"] = pnl
                state["pnlPeakGbp"] = max(float(state["pnlPeakGbp"]), pnl, 0.0)
                state["pnlDrawdownGbp"] = pnl - float(state["pnlPeakGbp"])
            twr_wealth = nullable_number(row.get("TWRWealth"))
            if twr_wealth is not None:
                state["twr"] = twr_wealth - 1.0
            drawdown = nullable_number(row.get("Drawdown"))
            if drawdown is not None:
                state["drawdown"] = drawdown
            if not performance_valid[account]:
                state["twr"] = None
                state["drawdown"] = None
            daily_external_flow += external_flow
            daily_weighted_flow += weighted_flow

        cfd_row = cfd_rows.get(date)
        if cfd_row is not None:
            cfd_state["started"] = True
            cfd_state["nav"] = nullable_number(
                cfd_row.get("RealisedCashEquityProxyGBP") or cfd_row.get("SyntheticNAVGBP")
            )
            cfd_state["drawdown"] = nullable_number(
                cfd_row.get("RealisedPnLDrawdownGBP") or cfd_row.get("CFDProxyDrawdownGBP")
            )
            cfd_state["accountContributionsGbp"] = nullable_number(
                cfd_row.get("CumulativeAccountCashFlowGBP")
            )
            # An absent legacy column differs from an explicitly unavailable
            # converted amount. Never turn missing FX into a zero cash flow.
            cfd_state["householdExternalGbp"] = nullable_number(
                cfd_row.get("CumulativeHouseholdExternalFlowGBP", "0")
            )
            cfd_state["internalTransferCounterflowGbp"] = nullable_number(
                cfd_row.get(
                    "CumulativeInternalTransferCounterflowGBP",
                    cfd_row.get("CumulativeMatchedInternalTransferCounterflowGBP", "0"),
                )
            )
            cfd_state["unmatchedInternalTransferGbp"] = nullable_number(
                cfd_row.get("CumulativeUnmatchedInternalTransferGBP", "0")
            )
            cfd_state["householdTransferMatchStatus"] = (
                str(cfd_row.get("HouseholdTransferMatchStatus") or "").strip() or None
            )
            cfd_state["netPnlGbp"] = nullable_number(cfd_row.get("CumulativeRealisedPnLGBP"))
            cfd_state["overnightInterestGbp"] = nullable_number(
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
        total_performance_valid = all(performance_valid.values())
        if total_performance_valid and previous_total_nav is not None and total is not None:
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
        cfd_value_available = not cfd_state["started"] or cfd is not None
        cfd_flows_available = all(
            cfd_state[key] is not None
            for key in ("householdExternalGbp", "internalTransferCounterflowGbp")
        )
        household = (
            None
            if not cfd_value_available or (total is None and cfd is None)
            else float(total or 0.0) + float(cfd or 0.0)
        )
        household_net_contributions = (
            None
            if household is None or not cfd_flows_available
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
        point = result[-1]
        point["flowStatus"] = "daily_official" if total_performance_valid else "unverified"
        for account, valid in performance_valid.items():
            if not valid:
                for suffix in ("NetContributionsGbp", "NetPnlGbp", "PnlDrawdownGbp"):
                    point[f"{account}{suffix}"] = None
        if not total_performance_valid:
            for scope in ("total", "household"):
                for suffix in ("NetContributionsGbp", "NetPnlGbp", "PnlDrawdownGbp"):
                    point[f"{scope}{suffix}"] = None
    return result


def intraday_nav_points(
    payload: JsonObject | None,
    cash_flows: dict[str, JsonObject] | None = None,
) -> list[JsonObject]:
    """Project unified valuations, retaining provenance and native precision."""

    if not isinstance(payload, dict):
        return []
    flows = {
        profile: CashFlowTimeline((cash_flows or {}).get(profile)) for profile in ("invest", "isa")
    }
    points: list[JsonObject] = []
    for raw in payload.get("points", []):
        if not isinstance(raw, dict):
            continue
        observed = raw.get("observed_at")
        if not observed:
            continue
        invest = nullable_number(raw.get("invest_value_gbp"))
        isa = nullable_number(raw.get("isa_value_gbp"))
        total = nullable_number(raw.get("total_value_gbp"))
        if (invest is None and isa is None) or total is None:
            continue
        invest_flow = (
            flows["invest"].at(raw.get("invest_observed_at") or observed)
            if invest is not None
            else None
        )
        isa_flow = (
            flows["isa"].at(raw.get("isa_observed_at") or observed) if isa is not None else None
        )
        selected_flows = [
            flow for value, flow in ((invest, invest_flow), (isa, isa_flow)) if value is not None
        ]
        total_flow = (
            sum(selected_flows) if all(flow is not None for flow in selected_flows) else None
        )
        points.append(
            {
                "date": str(observed),
                "intraday": True,
                "valuationSource": str(raw.get("source") or "broker"),
                "cadenceSeconds": int(raw.get("cadence_seconds") or 600),
                "priceCadenceSeconds": raw.get("price_cadence_seconds"),
                "includesExtendedHours": raw.get("includes_extended_hours"),
                "modelAt": raw.get("model_at"),
                "modelPriceCadenceSeconds": raw.get("model_price_cadence_seconds"),
                "investModelValueGbp": nullable_number(raw.get("invest_model_value_gbp")),
                "isaModelValueGbp": nullable_number(raw.get("isa_model_value_gbp")),
                "flowStatus": "verified"
                if total_flow is not None
                else str(raw.get("flow_status") or "unverified"),
                "investNetContributionsGbp": invest_flow,
                "isaNetContributionsGbp": isa_flow,
                "totalNetContributionsGbp": total_flow,
                "investNetPnlGbp": invest - invest_flow if invest_flow is not None else None,
                "isaNetPnlGbp": isa - isa_flow if isa_flow is not None else None,
                "totalNetPnlGbp": total - total_flow if total_flow is not None else None,
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


def latest_daily_return(text: str) -> float | None:
    rows = csv_rows(text)
    if any(not _performance_eligible(row) for row in rows):
        return None
    for row in reversed(rows):
        value = nullable_number(row.get("DailyReturn"))
        if value is not None:
            return value
    return None


def latest_twr(text: str) -> float | None:
    """Read the canonical cumulative TWR produced by the NAV ledger."""
    rows = csv_rows(text)
    if any(not _performance_eligible(row) for row in rows):
        return None
    for row in reversed(rows):
        wealth = nullable_number(row.get("TWRWealth"))
        if wealth is not None:
            return wealth - 1.0
    return None
