"""Release-date multiples use only observations actually present in that filing.

A fiscal-period denominator and a daily point-in-time TTM denominator are
separate identities. Never backfill today's EPS into a historical price chart.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from .facts import number


def release_multiples(
    filings: list[dict[str, Any]], prices: list[dict[str, Any]], currency: str | None
) -> list[dict[str, Any]]:
    if not currency:
        return []
    prices = sorted(prices, key=lambda p: p["date"])
    output = []
    for filing in sorted(filings, key=lambda f: f["publishedAt"]):
        filed = str(filing["publishedAt"])[:10]
        # Unknown publication time is not midnight: use the NEXT observed session.
        price = next((p for p in prices if p["date"][:10] > filed), None)
        if (
            not price
            or (date.fromisoformat(price["date"][:10]) - date.fromisoformat(filed)).days > 7
        ):
            continue
        observations = filing.get("observations") or []
        candidates = [
            o
            for o in observations
            if o["metric"] == "eps"
            and o["kind"] == "annual"
            and o.get("currency") == currency
            and o["periodEnd"] <= filed
        ]
        if not candidates:
            continue
        observation = max(candidates, key=lambda o: o["periodEnd"])
        eps = number(observation["value"])
        point = {
            "publishedAt": filed,
            "priceDate": price["date"][:10],
            "periodEnd": observation["periodEnd"],
            "periodStart": observation["periodStart"],
            "eps": eps,
            "price": price["close"],
            "currency": currency,
            "pe": price["close"] / eps if eps is not None and eps > 0 else None,
            "state": "missing" if eps is None else "available" if eps > 0 else "notMeaningful",
            "basis": "filed-annual-diluted-eps / next-session-unadjusted-price",
            "url": filing["url"],
            "sourceVersion": filing["version"],
        }
        # Several documents on the same date do not manufacture extra samples.
        if not output or (output[-1]["publishedAt"], output[-1]["periodEnd"]) != (
            filed,
            point["periodEnd"],
        ):
            output.append(point)
    return output


def release_sales_multiples(
    filings: list[dict[str, Any]], prices: list[dict[str, Any]], currency: str | None
) -> list[dict[str, Any]]:
    """P/S at quarterly disclosures, using only revenue and shares filed by then.

    TTM revenue is annual + current fiscal YTD - prior fiscal YTD. Unlike EPS,
    revenue is additive; no weighted-share or annualized-quarter shortcut is used.
    All three periods must meet at the fiscal year boundary. Each observation
    keeps its own filed version so a later restatement cannot rewrite old points.
    """
    if not currency:
        return []
    prices = sorted(prices, key=lambda p: p["date"])
    known: dict[tuple, dict] = {}
    shares: dict[str, dict] = {}
    result = []
    day = date.fromisoformat
    for filing in sorted(filings, key=lambda f: f["publishedAt"]):
        if filing.get("form", "").removesuffix("/A") not in {"10-K", "10-Q"}:
            # Foreign ordinary shares cannot be divided into an ADR quote without
            # a historical conversion ratio.
            continue
        filed = str(filing["publishedAt"])[:10]
        end = filing.get("periodEnd")
        for raw in filing.get("observations", []):
            observation = {
                **raw,
                "url": filing["url"],
                "sourceVersion": filing["version"],
                "publishedAt": filed,
            }
            if raw["metric"] == "shares" and raw["date"] <= filed:
                shares[raw["date"]] = observation
            elif (
                raw["metric"] == "revenue"
                and raw.get("currency") == currency
                and raw["periodEnd"] <= filed
            ):
                known[(raw["periodStart"], raw["periodEnd"])] = observation
        if not end or end > filed:
            continue
        candidates = [
            o for o in known.values() if o["periodEnd"] == end and o.get("value") is not None
        ]
        if not candidates:
            continue
        current = min(candidates, key=lambda o: o["periodStart"])
        components = [current]
        if current["kind"] == "annual":
            revenue = current["value"]
        else:
            annuals = [
                o
                for o in known.values()
                if o["kind"] == "annual"
                and 0 < (day(current["periodStart"]) - day(o["periodEnd"])).days <= 8
                and o.get("value") is not None
            ]
            if not annuals:
                continue
            annual = max(annuals, key=lambda o: o["publishedAt"])
            prior = [
                o
                for o in known.values()
                if o["periodStart"] == annual["periodStart"]
                and abs((day(end) - day(o["periodEnd"])).days - 365) <= 14
                and abs(
                    (day(end) - day(current["periodStart"])).days
                    - (day(o["periodEnd"]) - day(o["periodStart"])).days
                )
                <= 14
                and o.get("value") is not None
            ]
            if len(prior) != 1:
                continue
            components = [annual, current, prior[0]]
            revenue = annual["value"] + current["value"] - prior[0]["value"]
        price = next((p for p in prices if p["date"][:10] > filed), None)
        share_date = max(shares, default=None)
        outstanding = shares.get(share_date) if share_date else None
        if not price or not outstanding or not outstanding.get("value") or revenue <= 0:
            continue
        if (day(price["date"][:10]) - day(filed)).days > 7 or (
            day(filed) - day(share_date)
        ).days > 120:
            continue
        split_factor = 1.0
        for session in prices:
            if share_date < session["date"][:10] <= price["date"][:10]:
                split_factor *= number(session.get("split")) or 1
        adjusted_shares = outstanding["value"] * split_factor
        result.append(
            {
                "publishedAt": filed,
                "priceDate": price["date"][:10],
                "periodEnd": end,
                "price": price["close"],
                "shares": adjusted_shares,
                "shareDate": share_date,
                "revenue": revenue,
                "currency": currency,
                "ps": price["close"] * adjusted_shares / revenue,
                "shareSplitAdjustment": split_factor,
                "basis": "filed-ttm-revenue / filed-common-shares / next-session-unadjusted-price",
                "url": filing["url"],
                "sourceVersion": filing["version"],
                "components": components,
                "shareEvidence": outstanding,
            }
        )
    # Duplicate/amended releases remain in original files, not extra percentile samples.
    return list({r["periodEnd"]: r for r in result}.values())
