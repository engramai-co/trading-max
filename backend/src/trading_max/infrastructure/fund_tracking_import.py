"""Normalize explicitly imported issuer files. This module does not fetch data."""

from __future__ import annotations

from calendar import month_abbr
from datetime import date, datetime
from io import BytesIO
from math import isfinite, sqrt
from statistics import stdev
from typing import Literal
from zipfile import ZipFile

from lxml import etree
from openpyxl import load_workbook

from trading_max.domain.contracts import DomainModel
from trading_max.reference.fund_benchmarks import FundBenchmark, fund_benchmark
from trading_max.reference.indices import INDEX_REGISTRY

from .index_valuation_archive import ValuationObservation

_ISHARES_DOWNLOAD = (
    "https://www.blackrock.com/varnish-api/uk-retail01-product-data/product-data/api/v1/"
    "get-fund-document?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=ishares-uk"
    "&locale=en_GB&portfolioId={}&component=fundDownloadV2&userType=individual"
)
_INVESCO_DOWNLOAD = (
    "https://dng-api.invesco.com/cache/v1/accounts/en_GB/shareclasses/IE00BYVTMW98/"
    "performance?idType=isin&loadType=initial"
)
_ISHARES_INPUTS = {
    "IE00BD1F4N50": ("285208", "MSCI USA MOMENTUM FACTOR NET INDEX"),
    "IE000R4ZNTN3": ("340748", "MSCI WORLD EX US NET INDEX"),
    "IE000I8KRLL9": (
        "319084",
        "MSCI ACWI IMI SEMICONDUCTORS SEMICONDUCTOR EQUIPMENT ESG SCREENED CAPPED",
    ),
}
_SPREADSHEET = "{urn:schemas-microsoft-com:office:spreadsheet}"
_MONTHS = {name: n for n, name in enumerate(month_abbr) if name}


class DailyTrackingPoint(DomainModel):
    date: date
    nav: float | None = None
    fund_return_level: float | None = None
    benchmark_level: float | None = None
    cumulative_difference: float | None = None
    rolling_tracking_error: float | None = None


class DailyTrackingSummary(DomainModel):
    first_date: date
    last_date: date
    common_observations: int
    daily_return_observations: int
    tracking_difference: float
    tracking_error: float | None = None


class DailyTracking(DomainModel):
    isin: str
    benchmark_id: str
    state: Literal["available", "insufficient-common-dates", "hedged-comparison-unconfirmed"]
    nav_currency: str
    benchmark_currency: str
    return_basis: Literal["net-total-return"] = "net-total-return"
    benchmark_unit: Literal["growth-of-10000", "index-points"]
    source_url: str
    points: list[DailyTrackingPoint]
    summary: DailyTrackingSummary | None = None


def download_url(isin: str) -> str | None:
    if source := _ISHARES_INPUTS.get(isin):
        return _ISHARES_DOWNLOAD.format(source[0])
    return _INVESCO_DOWNLOAD if isin == "IE00BYVTMW98" else None


def _day(raw) -> date | None:
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    text = " ".join(str(raw or "").replace("/", " ").replace(",", " ").split())
    if len(text.split()) >= 3:
        day, month, year = text.split()[-3:]
        try:
            return date(int(year), _MONTHS[month[:3].title()], int(day))
        except (KeyError, ValueError):
            return None
    return None


def _value(raw) -> float | None:
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = float(str(raw).replace(",", ""))
    except ValueError:
        return None
    return value if isfinite(value) and value > 0 else None


def _text(raw) -> str:
    return " ".join(str(raw or "").upper().replace("&", " ").split())


def _sheet_rows(root: etree._Element, name: str) -> list[list[str | None]]:
    for sheet in root.findall(_SPREADSHEET + "Worksheet"):
        if sheet.get(_SPREADSHEET + "Name") != name:
            continue
        rows = []
        for row in sheet.findall(f"{_SPREADSHEET}Table/{_SPREADSHEET}Row"):
            cells = []
            for cell in row.findall(_SPREADSHEET + "Cell"):
                number = int(cell.get(_SPREADSHEET + "Index", len(cells) + 1))
                if number < 1 or number > 256:
                    raise ValueError("invalid-issuer-column")
                cells.extend([None] * max(0, number - len(cells) - 1))
                cells.append(cell.findtext(_SPREADSHEET + "Data"))
            rows.append(cells)
        return rows
    raise ValueError("missing-issuer-sheet")


def _insert[T](rows: dict[date, T], day: date, value: T) -> None:
    if day in rows and rows[day] != value:
        raise ValueError("conflicting-issuer-observations")
    rows[day] = value


def _ishares(data: bytes, mapping: FundBenchmark) -> list[DailyTrackingPoint]:
    # Some official Excel XML files contain a bare ampersand in text cells.
    # Recover the syntax, disable all entity resolution, and verify the sheet,
    # exact share class, currency and paired return benchmark independently.
    root = etree.fromstring(
        data, parser=etree.XMLParser(recover=True, resolve_entities=False, no_network=True)
    )
    facts = {row[0]: row[1] for row in _sheet_rows(root, "Key Facts") if len(row) >= 2}
    expected = _ISHARES_INPUTS[mapping.isin][1]
    if (
        facts.get("ISIN") != mapping.isin
        or facts.get("Share Class Currency") != mapping.share_currency
        or _text(facts.get("Benchmark Index")) != expected
        or _text(facts.get("Use of Income")) != "ACCUMULATING"
    ):
        raise ValueError("issuer-share-class-or-benchmark-mismatch")
    nav = {}
    for row in _sheet_rows(root, "Historical NAVs"):
        if len(row) >= 2 and (day := _day(row[0])) and (value := _value(row[1])) is not None:
            _insert(nav, day, value)
    growth = _sheet_rows(root, "Growth of Hypothetical 10,000")
    if not growth or len(growth[0]) < 3 or _text(growth[0][2]) != expected:
        raise ValueError("issuer-return-benchmark-mismatch")
    returns = {}
    for row in growth[1:]:
        if row and (day := _day(row[0])) and day in nav:
            values = [_value(row[i]) if len(row) > i else None for i in (1, 2)]
            _insert(returns, day, values)
    return [
        DailyTrackingPoint(
            date=day,
            nav=value,
            fund_return_level=returns.get(day, (None, None))[0],
            benchmark_level=returns.get(day, (None, None))[1],
        )
        for day, value in sorted(nav.items())
    ]


def issuer_portfolio_valuation(
    tracking: DailyTracking,
    data: bytes,
    now: datetime,
) -> ValuationObservation | None:
    if tracking.isin not in _ISHARES_INPUTS:
        return None
    root = etree.fromstring(
        data, parser=etree.XMLParser(recover=True, resolve_entities=False, no_network=True)
    )
    try:
        source = {
            row[0]: row[1:]
            for row in _sheet_rows(root, "Portfolio Characteristics")
            if len(row) >= 3
        }
    except ValueError:
        return None
    pe, pe_date = source.get("P/E Ratio", (None, None))[:2]
    if (value := _value(pe)) is None or (day := _day(pe_date)) is None or day > now.date():
        return None
    pb, pb_date = source.get("P/B Ratio", (None, None))[:2]
    count, count_date = source.get("Number of Holdings", (None, None))[:2]
    size = _value(count) if _day(count_date) == day else None
    return ValuationObservation(
        index_id=tracking.benchmark_id,
        source_kind="fund-proxy",
        source_url=tracking.source_url,
        method="Issuer portfolio characteristics",
        as_of=day,
        recorded_at=now,
        pe=value,
        price_to_book=_value(pb) if _day(pb_date) == day else None,
        basket_size=int(size) if size is not None and size.is_integer() else None,
    )


def _invesco(data: bytes) -> list[DailyTrackingPoint]:
    with ZipFile(BytesIO(data)) as archive:
        if sum(item.file_size for item in archive.infolist()) > 30_000_000:
            raise ValueError("issuer-workbook-too-large")
    book = load_workbook(BytesIO(data), read_only=True, data_only=True)
    points = {}
    try:
        rows = iter(book["End of day data"].iter_rows(min_col=1, max_col=19, values_only=True))
        heading = None
        column = None
        for row in rows:
            if row[0:2] == ("Date", "Index"):
                label = "INVESCO EQQQ NASDAQ-100 UCITS ETF GBP HDG ACC"
                matches = [i for i, value in enumerate(heading or ()) if _text(value) == label]
                if len(matches) != 1 or _text(row[matches[0]]) != "NAV":
                    raise ValueError("issuer-share-class-or-benchmark-mismatch")
                column = matches[0]
                break
            heading = row
        if column is None:
            raise ValueError("missing-issuer-return-columns")
        for row in rows:
            if day := _day(row[0]):
                nav = _value(row[column])
                level = _value(row[1])
                if nav is not None or level is not None:
                    _insert(
                        points, day, DailyTrackingPoint(date=day, nav=nav, benchmark_level=level)
                    )
    finally:
        book.close()
    return [row for _, row in sorted(points.items())]


def _summarize(points: list[DailyTrackingPoint]) -> DailyTrackingSummary | None:
    common = [
        p for p in points if p.fund_return_level is not None and p.benchmark_level is not None
    ]
    if len(common) < 2:
        return None
    first, last = common[0], common[-1]
    years = (last.date - first.date).days / 365.2425
    returns = []
    previous = None
    rolling: list[float | None] = []
    for point in points:
        fund, bench = point.fund_return_level, point.benchmark_level
        delta = None
        if fund is not None and bench is not None:
            point.cumulative_difference = (
                fund / first.fund_return_level - bench / first.benchmark_level
            )
            if previous:
                delta = fund / previous[0] - bench / previous[1]
                returns.append(delta)
            previous = (fund, bench)
        else:
            previous = None
        rolling.append(delta)
        if delta is not None and len(rolling) >= 252:
            # A missing comparison date invalidates its adjacent daily returns.
            # Keep the time window fixed and disclose coverage in the summary.
            valid = [value for value in rolling[-252:] if value is not None]
            if len(valid) >= 225:
                point.rolling_tracking_error = stdev(valid) * sqrt(252)
    return DailyTrackingSummary(
        first_date=first.date,
        last_date=last.date,
        common_observations=len(common),
        daily_return_observations=len(returns),
        tracking_difference=(last.fund_return_level / first.fund_return_level) ** (1 / years)
        - (last.benchmark_level / first.benchmark_level) ** (1 / years),
        tracking_error=stdev(returns) * sqrt(252) if len(returns) >= 2 else None,
    )


def import_issuer_tracking(isin: str, data: bytes) -> DailyTracking:
    mapping = fund_benchmark(isin)
    source = download_url(isin)
    if not mapping or not source or not 0 < len(data) <= 15_000_000:
        raise ValueError("unsupported-issuer-file")
    index = INDEX_REGISTRY[mapping.benchmark_id]
    unconfirmed = mapping.relation == "unconfirmed"
    if not unconfirmed and (
        index.currency != mapping.share_currency
        or index.variant != "NR"
        or index.hedging != "unhedged"
        or mapping.hedged
        or mapping.relation != "exact"
    ):
        raise ValueError("unmatched-issuer-return-basis")
    points = _invesco(data) if unconfirmed else _ishares(data, mapping)
    if not points:
        raise ValueError("no-dated-issuer-observations")
    summary = None if unconfirmed else _summarize(points)
    return DailyTracking(
        isin=isin,
        benchmark_id=mapping.benchmark_id,
        state="hedged-comparison-unconfirmed"
        if unconfirmed
        else "available"
        if summary
        else "insufficient-common-dates",
        nav_currency=mapping.share_currency,
        benchmark_currency=index.currency,
        benchmark_unit="index-points" if unconfirmed else "growth-of-10000",
        source_url=source,
        points=points,
        summary=summary,
    )
