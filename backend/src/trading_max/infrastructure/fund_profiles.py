"""Issuer adapters for share-class facts and documented performance."""

from __future__ import annotations

import math
import re
from calendar import monthrange
from datetime import UTC, date, datetime
from io import BytesIO
from typing import Any

from bs4 import BeautifulSoup
from pypdf import PdfReader

from trading_max.domain.etf import (
    FundEvidence,
    FundListing,
    FundReturnPair,
    FundReturnYear,
    FundShareClass,
    FundSize,
)
from trading_max.reference.quote_units import major_quote_unit

from .fund_downloads import as_of_date

ISHARES_VERSION = "ishares-facts-v2"
INVESCO_VERSION = "invesco-facts-v1"
HSBC_VERSION = "hsbc-facts-v1"
FACTS = (
    "index_name",
    "benchmark_currency",
    "benchmark_hedging",
    "share_currency",
    "base_currency",
    "income_use",
    "methodology",
    "replication",
    "domicile",
    "inception",
    "fund_size",
    "share_class_size",
    "expense_ratio",
    "fee_basis",
    "hedging",
    "rebalance_frequency",
    "index_rules",
    "tracking_error",
    "listings",
)


def optional_date(value: Any) -> str | None:
    try:
        stamp = str(value)
        if re.fullmatch(r"\d{8}", stamp):
            return date.fromisoformat(stamp).isoformat()
        return as_of_date(value)
    except (ValueError, TypeError):
        return None


def amount(value: Any) -> float | None:
    try:
        result = float(str(value).strip().replace(",", "").replace("%", ""))
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _size(raw: str) -> FundSize | None:
    match = re.fullmatch(r"([A-Z]{3})\s+([\d,.]+)([mb]?)", raw.strip(), re.I)
    if not match:
        return None
    value = amount(match[2])
    if value is None:
        return None
    return FundSize(
        amount=value * {"m": 1e6, "b": 1e9, "": 1}[match[3].lower()], currency=match[1].upper()
    )


def evidence(
    source: str,
    version: str,
    effective: str | None,
    present: bool,
    *,
    fetched: str = "",
    failed: bool = False,
) -> FundEvidence:
    return FundEvidence(
        source_url=source,
        effective_at=effective,
        fetched_at=fetched or datetime.now(UTC).isoformat(),
        parser_version=version,
        coverage="failed" if failed else "available" if present else "missing",
    )


def _profile(
    isin: str, issuer: str, source: str, version: str, values: dict, dates: dict
) -> FundShareClass:
    now = datetime.now(UTC).isoformat()
    if listings := values.get("listings"):
        values = {**values, "listings": list({line.key: line for line in listings}.values())}
    return FundShareClass(
        isin=isin,
        issuer=issuer,
        **values,
        evidence={
            field: evidence(
                source,
                version,
                dates.get(field),
                bool(value is not None and value != []),
                fetched=now,
            )
            for field in FACTS
            for value in (values.get(field),)
        },
    )


def empty_profile(isin: str, issuer: str, source: str, name: str) -> FundShareClass:
    return _profile(isin, issuer, source, "issuer-profile-v1", {"name": name}, {})


def _listing(
    *,
    isin: str,
    ticker: str,
    mic: str,
    exchange: str,
    unit: str,
    listed: str,
    source: str,
    version: str,
) -> FundListing:
    currency, _ = major_quote_unit(unit)
    listed_at = optional_date(listed)
    return FundListing(
        isin=isin,
        ticker=ticker.upper(),
        mic=mic,
        exchange=exchange,
        source=source,
        as_of=listed_at or "",
        quote_unit=unit or None,
        quote_currency=currency or None,
        evidence=evidence(source, version, listed_at, bool(currency)),
    )


ISHARES_MIC = {
    "London Stock Exchange": "XLON",
    "Borsa Italiana": "XMIL",
    "Deutsche Boerse Xetra": "XETR",
    "Euronext Amsterdam": "XAMS",
    "Euronext Paris": "XPAR",
    "SIX Swiss Exchange": "XSWX",
    "Bolsa Mexicana De Valores": "XMEX",
    "Bolsa De Valores De Colombia": "XBOG",
}


def parse_ishares_profile(html: str, source: str) -> FundShareClass:
    soup = BeautifulSoup(html, "html.parser")
    facts, dates = {}, {}
    for label in soup.select('[data-id^="keyFundFacts-"][data-id$="-label"]'):
        row = label.find_parent("tr")
        value = row.select_one("td") if row else None
        key = str(label.get("data-id")).removeprefix("keyFundFacts-").removesuffix("-label")
        if value:
            raw = value.get_text(" ", strip=True)
            if raw not in {"", "-", "—"}:
                if key == "isin" and key in facts and facts[key] != raw:
                    raise ValueError("conflicting share-class ISIN")
                facts[key] = raw
            stamp = row.select_one('[data-id$="-asOf"], .as-of-date')
            if stamp:
                dates[key] = optional_date(stamp.get_text(" ", strip=True).removeprefix("as of "))
    mapping = {
        "index_name": "indexSeriesName",
        "share_currency": "seriesBaseCurrencyCode",
        "base_currency": "baseCurrencyCode",
        "income_use": "useOfProfitsCode",
        "replication": "productStructure",
        "methodology": "fundMethodologyTypeCode",
        "domicile": "domicile",
        "inception": "inceptionDate",
        "rebalance_frequency": "rebalanceFrequency",
    }
    values: dict[str, Any] = {key: facts.get(field) for key, field in mapping.items()}
    field_dates = {key: dates.get(field) for key, field in mapping.items()}
    for name, key in (
        ("fund_size", "totalNetAssetsFundLevel"),
        ("share_class_size", "totalNetAssets"),
    ):
        values[name] = _size(facts.get(key, ""))
        field_dates[name] = dates.get(key)
    fee = amount(facts.get("emeaMgt"))
    if fee is not None:
        values.update(expense_ratio=fee / 100, fee_basis="TER")
        field_dates.update(expense_ratio=dates.get("emeaMgt"), fee_basis=dates.get("emeaMgt"))
    name = soup.select_one("h1")
    if name and facts.get("seriesBaseCurrencyCode"):
        # The selected share class is identified by the facts-table ISIN. iShares
        # labels currency-hedged share classes as such in its product name.
        values["name"] = name.get_text(" ", strip=True)
        values["hedging"] = (
            facts["seriesBaseCurrencyCode"]
            if re.search(r"\bhedged\b", values["name"], re.I)
            else "unhedged"
        )
    listings = []
    for row in soup.select('[data-id="listings-table"] tbody tr'):
        cells = [cell.get_text(" ", strip=True) for cell in row.select("td")]
        if len(cells) != 7:
            continue
        exchange, ticker, unit, listed, _, _, ric = cells
        if exchange in ISHARES_MIC and ticker not in {"", "-"}:
            listings.append(
                _listing(
                    isin=facts.get("isin", ""),
                    ticker=ric if ric not in {"", "-"} else ticker,
                    mic=ISHARES_MIC[exchange],
                    exchange=exchange,
                    unit=unit,
                    listed=listed,
                    source=source,
                    version=ISHARES_VERSION,
                )
            )
    values["listings"] = listings
    if (error := amount(facts.get("trackingError"))) is not None:
        values["tracking_error"] = error / 100
        field_dates["tracking_error"] = dates.get("trackingError")
    nav = soup.select_one('tr[webqc-datapoint="annualNav"]')
    benchmark = soup.select_one('tr[webqc-datapoint="benchmarkAnnual"]')
    if (
        nav
        and benchmark
        and nav.th
        and benchmark.th
        and nav.find_parent("table") is benchmark.find_parent("table")
    ):
        years = [cell.get_text(strip=True) for cell in nav.find_parent("table").select("thead th")]
        nav_currency = re.search(r"\b([A-Z]{3})\b", nav.th.get_text(" ", strip=True))
        index_currency = re.search(r"\b([A-Z]{3})\b", benchmark.th.get_text(" ", strip=True))
        hint = benchmark.select_one('button[title^="Index: "]')
        if hint:
            values["index_name"] = hint["title"].removeprefix("Index: ")
        if index_currency:
            values["benchmark_currency"] = index_currency[1]
            if values["index_name"]:
                values["benchmark_hedging"] = (
                    index_currency[1]
                    if re.search(r"\bhedged\b", values["index_name"], re.I)
                    else "unhedged"
                )
        nums = [amount(cell.get_text(strip=True)) for cell in nav.select("td")]
        refs = [amount(cell.get_text(strip=True)) for cell in benchmark.select("td")]
        if (
            nav_currency
            and index_currency
            and nav_currency[1] == index_currency[1]
            and (
                not values.get("hedging")
                or values.get("hedging") == values.get("benchmark_hedging")
            )
            and len(years) == len(nums) == len(refs)
        ):
            values["annual_returns"] = [
                FundReturnYear(
                    year=int(y),
                    nav_return=n / 100,
                    benchmark_return=b / 100,
                    tracking_difference=(n - b) / 100,
                )
                for y, n, b in zip(years, nums, refs, strict=True)
                if re.fullmatch(r"\d{4}", y) and n is not None and b is not None
            ]
            values["return_currency"] = nav_currency[1]
            values["return_basis"] = (
                "Issuer-published NAV total return with income reinvested and benchmark total return."
            )
    return _profile(facts.get("isin", ""), "iShares", source, ISHARES_VERSION, values, field_dates)


def parse_ishares_one_year(
    payload: dict, profile: FundShareClass, product_id: str, source: str
) -> FundReturnPair | None:
    if str(payload.get("productId")) != product_id:
        raise ValueError("iShares performance product mismatch")
    points = payload["componentsByNameMap"]["performance"]["containersByNameMap"]["returns"][
        "subContainersByNameMap"
    ]["average"]["dataPointsByNameMap"]

    def get(key: str) -> Any:
        return points.get(key, {}).get("value")

    if get("indexName") != profile.index_name:
        raise ValueError("iShares performance benchmark mismatch")
    stamp = optional_date(get("asOfDate"))
    values = get("oneYearAnnualized") or []
    series = get("returnTypes") or []
    currencies = get("returnsByCurrency") or {}
    if len(series) != len(values):
        return None
    paired = dict(zip(series, values, strict=True))
    nav, index = amount(paired.get("navSourced")), amount(paired.get("benchmarkSourced"))
    nav_currency, benchmark_currency = (
        currencies.get("navSourced"),
        currencies.get("benchmarkSourced"),
    )
    if stamp and nav is not None and index is not None and nav_currency and benchmark_currency:
        return FundReturnPair(
            period_end=stamp,
            nav_return=nav / 100,
            benchmark_return=index / 100,
            nav_currency=nav_currency,
            benchmark_currency=benchmark_currency,
            nav_hedging=profile.hedging,
            benchmark_hedging=profile.benchmark_hedging,
            evidence=evidence(source, ISHARES_VERSION, stamp, True),
        )
    return None


def parse_invesco_profile(payload: dict, isin: str, source: str) -> FundShareClass:
    if (payload.get("aliases") or {}).get("isin") != isin:
        raise ValueError("Invesco share-class ISIN mismatch")
    account = payload.get("account") or {}
    indexes = payload.get("benchmarkRelationships") or []
    index = indexes[0] if len(indexes) == 1 else {}
    frequency = payload.get("distributionFrequency")
    values = {
        "name": payload.get("shareClassFullName"),
        "index_name": index.get("benchmarkFullName"),
        "benchmark_currency": index.get("baseCurrency"),
        "share_currency": payload.get("shareClassCurrency"),
        "base_currency": account.get("currency"),
        "domicile": account.get("domicileCountry"),
        "inception": payload.get("shareClassInceptionDate"),
        "replication": payload.get("replicationMethod"),
        "income_use": (
            "Accumulating" if frequency == "Accumulating" else "Distributing" if frequency else None
        ),
    }
    if payload.get("hedgedIndicator") is False:
        values["hedging"] = "unhedged"
    elif payload.get("hedgedIndicator") is True:
        values["hedging"] = payload.get("hedgedCurrencyCode")
    if values["index_name"]:
        values["benchmark_hedging"] = (
            values["benchmark_currency"]
            if re.search(r"\bhedged\b", values["index_name"], re.I)
            else "unhedged"
        )
    values["listings"] = [
        _listing(
            isin=isin,
            ticker=line.get("listingRic") or line["listingTicker"],
            mic=line["listingExchangeCode"],
            exchange=line.get("listingExchangeName", ""),
            unit=line.get("listingCurrency", ""),
            listed=line.get("listingDate", ""),
            source=source,
            version=INVESCO_VERSION,
        )
        for line in payload.get("shareclassListings") or []
        if line.get("listingIsin") == isin
        and line.get("listingExchangeCode")
        and (line.get("listingRic") or line.get("listingTicker"))
    ]
    stamp = optional_date(payload.get("effectiveDate"))
    return _profile(isin, "Invesco", source, INVESCO_VERSION, values, dict.fromkeys(FACTS, stamp))


def parse_hsbc_profile(pages: list[str], isin: str, name: str, source: str) -> FundShareClass:
    """Read HEMC's monthly NAV and reference benchmark from the existing factsheet."""
    cover = pages[0] if pages else ""
    performance = pages[1] if len(pages) > 1 else ""
    values = {"name": name}
    stamp = None
    pair = None
    header = (
        r"^.*\bMonthly report (\d{1,2} [A-Za-z]+ \d{4})\s*\|[^|\n]+\|"
        r"\s*([A-Z]{3})( Hedged)? \(Acc\)[ \t]*$"
    )
    cover_header = re.search(header, cover, re.M)
    performance_header = re.search(header, performance, re.M)
    if (
        re.findall(r"^ISIN[ \t]+([A-Z0-9]{12})[ \t]*$", cover, re.M) == [isin]
        and cover_header
        and performance_header
        and cover_header.groups() == performance_header.groups()
    ):
        stamp = optional_date(cover_header[1])
        share = re.search(r"^Share class base currency[ \t]+([A-Z]{3})\b", cover, re.M)
        base = re.search(r"^Fund base currency[ \t]+([A-Z]{3})\b", cover, re.M)
        index = re.search(
            r"^Index name[ \t]+(100% MSCI Emerging Markets Net)[ \t]*$", performance, re.M
        )
        currency = re.search(r"^Index currency[ \t]+([A-Z]{3})\b", performance, re.M)
        # The HSBC fund supplement distinguishes the base-currency USD class
        # from explicitly hedged classes. NDUEEGF is the unhedged net index.
        if share and cover_header[2] == share[1]:
            values["share_currency"] = share[1]
            if cover_header[3]:
                values["hedging"] = share[1]
            elif base and base[1] == share[1] == "USD":
                values["hedging"] = "unhedged"
        if base:
            values["base_currency"] = base[1]
        if (
            index
            and currency
            and re.search(r"^Benchmark type[ \t]+Total Return[ \t]*$", performance, re.M)
            and re.search(r"^TR Index Bloomberg Ticker[ \t]+NDUEEGF[ \t]*$", performance, re.M)
        ):
            values.update(
                index_name=index[1], benchmark_currency=currency[1], benchmark_hedging="unhedged"
            )
        if (
            stamp
            and values.get("share_currency")
            and values.get("hedging")
            and values.get("benchmark_currency")
            and re.search(
                r"calculated in the share class base currency,\s*dividend reinvested,\s*net\s+of fees",
                performance,
            )
            and (returns := _hsbc_rolling_returns(performance, stamp)) is not None
        ):
            pair = FundReturnPair(
                period_end=stamp,
                nav_return=returns[0],
                benchmark_return=returns[1],
                nav_currency=values["share_currency"],
                benchmark_currency=values["benchmark_currency"],
                nav_hedging=values.get("hedging"),
                benchmark_hedging=values.get("benchmark_hedging"),
                evidence=evidence(source, HSBC_VERSION, stamp, True),
            )
    profile = _profile(
        isin, "HSBC Asset Management", source, HSBC_VERSION, values, dict.fromkeys(FACTS, stamp)
    )
    profile.one_year = pair
    profile.evidence["one_year"] = (
        pair.evidence if pair else evidence(source, HSBC_VERSION, stamp, False)
    )
    return profile


def _hsbc_rolling_returns(text: str, stamp: str) -> tuple[float, float] | None:
    table = re.search(
        r"^Rolling performance \(%\)[ \t]*\n([\d/\s-]+)\n"
        r"Fund[ \t]+([^\n]+)\nReference Benchmark[ \t]+([^\n]+)",
        text,
        re.M,
    )
    if not table:
        return None
    periods = re.findall(r"(\d{2}/\d{2}/\d{2})\s*-\s*(\d{2}/\d{2}/\d{2})", table[1])
    nav_values, benchmark_values = table[2].split(), table[3].split()
    if not periods or len(periods) != len(nav_values) or len(periods) != len(benchmark_values):
        return None
    try:
        start, end = (
            datetime.strptime(raw, "%d/%m/%y").replace(tzinfo=UTC).date() for raw in periods[0]
        )
    except ValueError:
        return None
    if (
        end.isoformat() != stamp
        or start.year != end.year - 1
        or start.month != end.month
        or any(d.day != monthrange(d.year, d.month)[1] for d in (start, end))
    ):
        return None
    nav, benchmark = amount(nav_values[0]), amount(benchmark_values[0])
    return (nav / 100, benchmark / 100) if nav is not None and benchmark is not None else None


def apply_invesco_factsheet(profile: FundShareClass, content: bytes, source: str) -> FundShareClass:
    text = PdfReader(BytesIO(content)).pages[0].extract_text(extraction_mode="layout")
    if not re.search(rf"\bISIN code\s+{re.escape(profile.isin)}\b", text):
        raise ValueError("Invesco factsheet ISIN mismatch")
    date_match = re.search(r"Cumulative performance as at (\d+ \w+ \d{4}) \(%\)", text)
    stamp = optional_date(date_match[1]) if date_match else None
    if not stamp:
        raise ValueError("Invesco factsheet period end unavailable")
    updates: dict[str, Any] = {}
    facts = dict(profile.evidence)
    fee = re.search(r"Ongoing charge\s*\d*\s+([\d.]+)%\s*p\.a\.", text)
    if fee:
        updates.update(expense_ratio=float(fee[1]) / 100, fee_basis="OCF")
    size = re.search(r"Fund size\s+([A-Z]{3}\s+[\d,.]+[mb]?)", text)
    if size:
        updates["fund_size"] = _size(size[1])
    if "About the index" in text:
        section = text.split("About the index", 1)[1].split("Past performance does not predict", 1)[
            0
        ]
        rules = " ".join(
            columns[1].strip()
            for line in section.splitlines()
            if len(columns := re.split(r"\s{8,}", line.strip(), maxsplit=1)) == 2
        )
        description = rules.split("On 5 April 2011", 1)[0].strip()
        if re.match(r"The .+ Index .+ includes", description) or re.match(
            r"The .+ Index includes", description
        ):
            updates["index_rules"] = description
    for key, value in updates.items():
        facts[key] = evidence(source, INVESCO_VERSION, stamp, value is not None)
    basis = re.search(r"inclusive of net\s+reinvested income.*?in ([A-Z]{3})\.", text, re.S)
    index_code = re.search(r"Index Bloomberg ticker\s+(\w+)", text)
    if not (basis and index_code and index_code[1] == "NNDX" and profile.benchmark_currency):
        return profile.model_copy(update={**updates, "evidence": facts})
    nav_currency, index_currency = basis[1], profile.benchmark_currency
    number_pattern = r"(-?\d+(?:\.\d+)?)"
    section = text.split("Cumulative performance as at ", 1)[1].split(
        "Calendar year performance", 1
    )[0]
    pair = re.search(
        r"\bETF\s+" + number_pattern + r"[^\n]*\n[^\n]*?\bIndex\s+" + number_pattern, section
    )
    if pair:
        updates["one_year"] = FundReturnPair(
            period_end=stamp,
            nav_return=float(pair[1]) / 100,
            benchmark_return=float(pair[2]) / 100,
            nav_currency=nav_currency,
            benchmark_currency=index_currency,
            nav_hedging=profile.hedging,
            benchmark_hedging=profile.benchmark_hedging,
            evidence=evidence(source, INVESCO_VERSION, stamp, True),
        )
    if nav_currency == index_currency and profile.hedging == profile.benchmark_hedging:
        section = text.split("Calendar year performance", 1)[-1].split("Standardised rolling", 1)[0]
        years_match = re.search(r"((?:20\d\d\s+){2,}20\d\d)", section)
        if years_match:
            years = years_match[1].split()
            nav = re.search(r"\bETF\s+((?:-?\d+\.\d+\s+)*-?\d+\.\d+)", section)
            idx = re.search(r"\bIndex\s+((?:-?\d+\.\d+\s+)*-?\d+\.\d+)", section)
            if nav and idx and len(years) == len(nav[1].split()) == len(idx[1].split()):
                updates["annual_returns"] = [
                    FundReturnYear(
                        year=int(y),
                        nav_return=n / 100,
                        benchmark_return=b / 100,
                        tracking_difference=(n - b) / 100,
                    )
                    for y, n, b in zip(
                        years, map(float, nav[1].split()), map(float, idx[1].split()), strict=True
                    )
                ]
                updates["return_currency"] = nav_currency
                updates["return_basis"] = (
                    "Issuer-published NAV total return with net income reinvested and benchmark total return."
                )
    return profile.model_copy(update={**updates, "evidence": facts})


VANGUARD_VERSION = "vanguard-facts-v1"


def parse_vanguard_profile(
    html: str, source: str, isin: str, product_id: str
) -> tuple[FundShareClass, str | None]:
    import json
    from html import unescape

    from .fund_downloads import issuer_url

    soup = BeautifulSoup(html, "html.parser")
    script = soup.select_one("script#serverApp-state")
    if not script or not script.string:
        raise ValueError("Vanguard facts state absent")
    state = json.loads(script.string)
    root = state["gpx.fund-facts"]
    heading = state["gpx.fund-page-heading"]
    facts = root["facts"]
    if str(root.get("portId")) != product_id or facts["isin"]["value"] != isin:
        raise ValueError("Vanguard share-class identity mismatch")

    def get(key):
        return facts.get(key, {}).get("value")

    title = heading.get("title") or ""
    currency = get("currency")
    benchmark = unescape(get("benchmark") or "") or None
    fee = amount(get("ocf"))
    values = {
        "name": title or None,
        "index_name": benchmark,
        "share_currency": currency,
        "replication": get("investmentMethod"),
        "inception": get("inceptionDate"),
        "domicile": get("domicile"),
        "income_use": next(
            (word for word in ("Accumulating", "Distributing") if word in title), None
        ),
        "hedging": (currency if re.search(r"\bhedged\b", title, re.I) else "unhedged")
        if title
        else None,
        "expense_ratio": fee / 100 if fee is not None else None,
        "fee_basis": "OCF" if fee is not None else None,
    }
    dates = {}
    for key, label in (("fund_size", "totalAssets"), ("share_class_size", "shareClassAssets")):
        raw = facts.get(label) or {}
        assets_currency = raw.get("options", {}).get("currency")
        size = amount(raw.get("value"))
        scale = {"M": 1e6, "B": 1e9}.get(raw.get("suffix", {}).get("value"))
        if size is not None and scale and assets_currency:
            values[key] = FundSize(amount=size * scale, currency=assets_currency)
            dates[key] = optional_date(raw.get("asOfDate") or raw.get("tooltip", {}).get("value"))
    listings = []
    errors = []
    for entry in state.values():
        if not isinstance(entry, dict) or not isinstance(entry.get("b"), dict):
            continue
        data = entry["b"].get("data") or {}
        for fund in data.get("funds") or []:
            profile = fund.get("profile") or {}
            ids = {
                item.get("altIdCode"): item.get("altIdValue")
                for item in profile.get("identifiers") or []
            }
            if ids.get("ISIN") != isin:
                continue
            for line in profile.get("listings") or []:
                ids = {
                    item.get("altIdCode"): item.get("altIdValue")
                    for item in line.get("identifiers") or []
                }
                ticker = ids.get("RIC") or ids.get("TIDM")
                mic = line.get("stockExchangeMarketIdentifierCode")
                if ticker and mic and ids.get("ISIN") == isin:
                    listings.append(
                        _listing(
                            isin=isin,
                            ticker=ticker,
                            mic=mic,
                            exchange=line.get("exchange") or "",
                            unit=line.get("fundCurrency") or "",
                            listed=line.get("fundClientMarketAvailabilityDate") or "",
                            source=source,
                            version=VANGUARD_VERSION,
                        )
                    )
        for analytics in data.get("polarisAnalyticsHistory") or []:
            items = ((analytics.get("monthly") or {}).get("volatility") or {}).get("fund") or {}
            for item in items.get("items") or []:
                error = (item.get("codes") or {}).get("ITRKERBF1Y") or {}
                stamp, value = (
                    optional_date(error.get("effectiveDate")),
                    amount(error.get("volatilityValue")),
                )
                if stamp and value is not None:
                    errors.append((stamp, value))
    values["listings"] = list({(line.mic, line.ticker): line for line in listings}.values())
    if errors:
        stamp, tracking_error = max(errors)
        values["tracking_error"] = tracking_error / 100
        dates["tracking_error"] = stamp
    docs = heading.get("relatedDocuments") or []
    factsheet = next(
        (
            issuer_url(doc["path"], "https://fund-docs.vanguard.com")
            for doc in docs
            if doc.get("type") == "FS"
            and doc.get("languageCode") == "EN"
            and "GB" in (doc.get("countryCodes") or [])
            and doc.get("path")
        ),
        None,
    )
    return _profile(isin, "Vanguard", source, VANGUARD_VERSION, values, dates), factsheet


def apply_vanguard_factsheet(
    profile: FundShareClass, content: bytes, source: str
) -> FundShareClass:
    pages = PdfReader(BytesIO(content)).pages
    first = pages[0].extract_text(extraction_mode="layout")
    if not re.search(rf"\b{re.escape(profile.isin)}\b", first):
        raise ValueError("Vanguard factsheet ISIN mismatch")
    text = "\n".join(page.extract_text(extraction_mode="layout") for page in pages[:2])
    stamp = re.search(r"closing NAV as at (\d+ \w+ \d{4})\.", text)
    basis = re.search(r"All performance is calculated in ([A-Z]{3}), net of fees", text)
    benchmark = re.search(r"^Benchmark\s+[—–-]\s*(.+)$", text, re.M)
    if not (stamp and basis and benchmark and benchmark[1].strip() == profile.index_name):
        return profile
    as_of = optional_date(stamp[1])
    section = text.split("Annualised performance", 1)[-1].split("reinvestment", 1)[0]
    row = r"^\s*{label}\s+(.*)$"
    nav = re.search(row.format(label="Fund"), section, re.M)
    index = re.search(row.format(label="Benchmark"), section, re.M)
    if not (as_of and nav and index and "1 year" in section):
        return profile

    def percentages(line: str):
        return re.findall(r"-?\d+(?:\.\d+)?%|—", line)

    nav_values, benchmark_values = percentages(nav[1]), percentages(index[1])
    if len(nav_values) != len(benchmark_values) or len(nav_values) < 4:
        return profile
    nav_return, index_return = amount(nav_values[3]), amount(benchmark_values[3])
    if nav_return is None or index_return is None:
        return profile
    currency = basis[1]
    hedging = currency if re.search(r"\bhedged\b", profile.index_name or "", re.I) else "unhedged"
    profile.one_year = FundReturnPair(
        period_end=as_of,
        nav_return=nav_return / 100,
        benchmark_return=index_return / 100,
        nav_currency=currency,
        benchmark_currency=currency,
        nav_hedging=profile.hedging,
        benchmark_hedging=hedging,
        evidence=evidence(source, VANGUARD_VERSION, as_of, True),
    )
    return profile
