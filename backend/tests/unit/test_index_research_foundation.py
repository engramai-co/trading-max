import json
from datetime import UTC, date, datetime
from io import BytesIO
from math import sqrt
from statistics import stdev
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

import pytest
from openpyxl import Workbook
from trading_max.infrastructure.eodhd_index_prices import EodhdError, EodhdIndexPrices
from trading_max.infrastructure.fund_tracking_import import import_issuer_tracking
from trading_max.infrastructure.index_valuation_archive import (
    archive_valuation,
    bottom_up_valuation,
)
from trading_max.infrastructure.sector_universe import SectorConstituent, SectorUniverse
from trading_max.reference.fund_benchmarks import fund_benchmark
from trading_max.reference.indices import INDEX_REGISTRY

NS = "{urn:schemas-microsoft-com:office:spreadsheet}"


def _tracking_workbook(benchmark="MSCI USA MOMENTUM FACTOR NET INDEX"):
    book = ET.Element(NS + "Workbook")
    for name, rows in {
        "Key Facts": [
            ["ISIN", "IE00BD1F4N50"],
            ["Share Class Currency", "USD"],
            ["Use of Income", "Accumulating"],
            ["Benchmark Index", benchmark],
        ],
        "Historical NAVs": [[f"{day:02d}/Jan/2026", str(9 + day)] for day in (5, 6, 7, 8, 9)],
        "Growth of Hypothetical 10,000": [
            ["", "Synthetic Fund", benchmark],
            ["Thu, 08 Jan 2026", "103", "100"],
            ["Fri, 09 Jan 2026", "104", "102"],
            ["Mon, 05 Jan 2026", "100", "100"],
            ["Tue, 06 Jan 2026", "102", "101"],
        ],
    }.items():
        sheet = ET.SubElement(book, NS + "Worksheet", {NS + "Name": name})
        table = ET.SubElement(sheet, NS + "Table")
        for values in rows:
            row = ET.SubElement(table, NS + "Row")
            for value in values:
                ET.SubElement(ET.SubElement(row, NS + "Cell"), NS + "Data").text = value
    return ET.tostring(book)


def test_issuer_tracking_checks_exact_variant_and_skips_gap():
    result = import_issuer_tracking("IE00BD1F4N50", _tracking_workbook())
    assert result.state == "available"
    assert result.points[2].nav == 16 and result.points[2].fund_return_level is None
    assert result.points[-1].cumulative_difference == pytest.approx(0.02)
    assert result.summary.common_observations == 4
    assert result.summary.daily_return_observations == 2
    assert result.summary.tracking_difference == pytest.approx(
        1.04 ** (365.2425 / 4) - 1.02 ** (365.2425 / 4)
    )
    assert result.summary.tracking_error == pytest.approx(
        stdev([0.01, 104 / 103 - 1.02]) * sqrt(252)
    )
    with pytest.raises(ValueError, match="mismatch"):
        import_issuer_tracking("IE00BD1F4N50", _tracking_workbook("Synthetic price index"))


def test_hedged_nav_and_raw_index_are_retained_without_false_pair():
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "End of day data"
    sheet.append([None, None, "Invesco EQQQ Nasdaq-100 UCITS ETF GBP Hdg Acc"])
    sheet.append(["Date", "Index", "NAV"])
    sheet.append([date(2026, 1, 5), 100, 25])
    sheet.append([date(2026, 1, 6), 101, 26])
    data = BytesIO()
    workbook.save(data)
    result = import_issuer_tracking("IE00BYVTMW98", data.getvalue())
    assert result.state == "hedged-comparison-unconfirmed"
    assert result.summary is None and result.points[0].cumulative_difference is None
    assert (result.nav_currency, result.benchmark_currency) == ("GBP", "USD")
    assert (result.points[0].nav, result.points[0].benchmark_level) == (25, 100)
    assert (
        fund_benchmark("IE000KCS7J59").benchmark_id == fund_benchmark("US4642872349").benchmark_id
    )
    assert INDEX_REGISTRY["msci-em"].variant == "PR"
    assert INDEX_REGISTRY[fund_benchmark("US4642872349").benchmark_id].variant == "NR"


def test_eodhd_budget_persists_and_daily_levels_use_unadjusted_close(tmp_path):
    now = datetime(2026, 1, 8, 23, tzinfo=UTC)
    calls = []

    def prices(symbol, key):
        calls.append((symbol, key))
        return [
            {"date": "2026-01-05", "close": 125, "adjusted_close": 990},
            {"date": "2026-01-06", "close": 129, "adjusted_close": 999},
        ]

    service = EodhdIndexPrices(tmp_path, prices)
    for _ in range(19):
        service.test("synthetic-secret", now)
    history = service.history(
        "TOPX.INDX", "synthetic-secret", now, ZoneInfo("Asia/Tokyo"), end=now.date()
    )
    assert history.closes == (125, 129) and history.granularity == "1d"
    another = EodhdIndexPrices(tmp_path, prices)
    assert another.history(
        "TOPX.INDX", "synthetic-secret", now, ZoneInfo("Asia/Tokyo"), end=now.date()
    )
    with pytest.raises(EodhdError, match="provider_rate_limited"):
        another.test("synthetic-secret", now)
    assert len(calls) == 20


def test_bottom_up_uses_point_in_time_earnings_and_weighted_harmonic_mean(tmp_path):
    now = datetime(2026, 3, 4, 23, tzinfo=UTC)
    members = [
        SectorConstituent(
            ticker=symbol,
            symbol=symbol,
            name=symbol,
            isin=isin,
            sector_code="00",
            sector_name="Synthetic",
            weight=weight,
        )
        for symbol, isin, weight in [
            ("AAA", "US0000000001", 0.6),
            ("BBB", "US0000000002", 0.3),
            ("CCC", "US0000000003", 0.1),
        ]
    ]
    basket = SectorUniverse(
        market="us",
        universe="Synthetic",
        fund="Synthetic ETF",
        fund_ticker="SYN",
        source_url="https://issuer.example",
        as_of="2026-03-03",
        fetched_at=now.isoformat(),
        constituents=members,
    )
    (tmp_path / "company_tickers.json").write_text(
        json.dumps(
            {str(n): {"ticker": row.symbol, "cik_str": n} for n, row in enumerate(members, 1)}
        )
    )
    for n, profit in [(1, 50), (2, 100)]:
        annual = {
            "start": "2025-01-01",
            "end": "2025-12-31",
            "filed": "2026-02-01",
            "val": profit,
            "form": "10-K",
        }
        shares = {"end": "2025-12-31", "filed": "2026-02-01", "val": 10, "form": "10-K"}
        data = {
            "cik": n,
            "facts": {
                "us-gaap": {
                    "NetIncomeLoss": {
                        "units": {"USD": [annual, {**annual, "filed": "2026-03-04", "val": 500}]}
                    }
                },
                "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [shares]}}},
            },
        }
        (tmp_path / f"CIK{n:010d}.json").write_text(json.dumps(data))
    row = bottom_up_valuation(tmp_path, "sp-500", basket, {"AAA": 50, "BBB": 50}, now.date(), now)
    assert row.coverage == pytest.approx(0.9)
    assert row.sample_size == 2 and row.basket_size == 3
    assert row.pe == pytest.approx(0.9 / (0.6 * 0.10 + 0.3 * 0.20))
    archive_valuation(tmp_path, row)
    archive_valuation(tmp_path, row.model_copy(update={"source_kind": "official", "pe": 22}))
    assert (tmp_path / "sp-500/us-bottom-up/2026-03-04.json").is_file()
    assert (tmp_path / "sp-500/official/2026-03-04.json").is_file()


def test_premium_requires_same_time_currency_and_unadjusted_market_price():
    from trading_max.infrastructure.fund_premium_discount import paired_premiums

    fields = (
        "isin,listing,market_at,nav_at,market_price,nav,price_currency,nav_currency,price_basis\n"
    )
    good = "IE00BYVTMW98,EQGB.L,2026-01-05T16:30:00+00:00,2026-01-05T11:30:00-05:00,505,5,GBp,GBP,unadjusted"
    wrong_time = good.replace("11:30:00", "11:31:00")
    wrong_currency = good.replace("GBp,GBP", "GBp,USD")
    adjusted = good.replace("unadjusted", "adjusted")
    points = paired_premiums(
        "IE00BYVTMW98",
        "EQGB.L",
        "https://issuer.example",
        fields + "\n".join([good, wrong_time, wrong_currency, adjusted]),
    ).points
    assert len(points) == 1 and points[0].premium == pytest.approx(0.01)
    assert points[0].price == 5.05 and points[0].currency == "GBP"
    with pytest.raises(ValueError, match="no-exact-time"):
        paired_premiums("IE00BYVTMW98", "EQGB.L", "https://issuer.example", fields + wrong_time)
