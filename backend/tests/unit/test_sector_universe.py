from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from trading_max.infrastructure.sector_universe import (
    UNIVERSES,
    SectorUniverse,
    SectorUniverseProvider,
    UniverseSpec,
    parse_universe,
    provider_symbol,
)

NOW = datetime(2026, 11, 9, 9, tzinfo=UTC)


@pytest.mark.parametrize(
    ("market", "ticker", "exchange", "symbol"),
    [
        ("us", "AAPL", "NASDAQ", "AAPL"),
        ("us", "BRK B", "New York Stock Exchange Inc.", "BRK-B"),
        ("us", "BF.B", "New York Stock Exchange Inc.", "BF-B"),
        ("us", "CBOE", "Cboe BZX", "CBOE"),
        ("us", "HOLX", "NO MARKET (E.G. UNLISTED)", None),
        ("us", "XYZ", None, None),
        ("uk", "RR.", "London Stock Exchange", "RR.L"),
        ("uk", "BT.A", "London Stock Exchange", "BT-A.L"),
        ("uk", "HSBA", "London Stock Exchange", "HSBA.L"),
        ("uk", "SMT", None, "SMT.L"),
        ("hk", "700", "Hong Kong Exchanges And Clearing Ltd", "0700.HK"),
        ("hk", "9988", "Hong Kong Exchanges And Clearing Ltd", "9988.HK"),
        ("hk", None, "Hong Kong Exchanges And Clearing Ltd", None),
        ("hk", "2330", "Taiwan Stock Exchange", None),
        ("kr", "005930", "Korea Exchange (Stock Market)", "005930.KS"),
        ("kr", "196170", "Korea Exchange (Kosdaq)", "196170.KQ"),
        ("kr", "2079401G", "Korea Exchange (Stock Market)", None),
    ],
)
def test_provider_symbol_follows_each_markets_listing_convention(
    market: str, ticker: str | None, exchange: str | None, symbol: str | None
) -> None:
    assert provider_symbol(UNIVERSES[market], ticker, exchange) == symbol


def points(rows: list[dict[str, object]], *, as_of: str = "20261105") -> dict[str, object]:
    fields = (
        "ticker",
        "issueName",
        "isin",
        "exchange",
        "sectorName",
        "holdingPercent",
        "assetClass",
    )
    payload: dict[str, object] = {
        field: {"value": [row.get(field) for row in rows]} for field in fields
    }
    payload["asOfDate"] = {"value": as_of}
    return payload


def holding(
    ticker: str | None,
    weight: float,
    *,
    exchange: str | None = "Hong Kong Exchanges And Clearing Ltd",
    sector: str = "Financials",
    asset: str = "Equity",
    isin: str = "",
) -> dict[str, object]:
    return {
        "ticker": ticker,
        "issueName": f"SYNTHETIC  {ticker}",
        "isin": isin,
        "exchange": exchange,
        "sectorName": sector,
        "holdingPercent": weight,
        "assetClass": asset,
    }


def test_parse_universe_keeps_one_markets_equities_and_renormalises_weights() -> None:
    universe = parse_universe(
        UNIVERSES["hk"],
        points(
            [
                holding("700", 3.0, sector="Communication", isin="KYSYNTH00001"),
                holding("5", 1.0, isin="GBSYNTH00002"),
                holding("0005", 1.0, isin="GBSYNTH00002"),
                holding("2330", 9.0, exchange="Taiwan Stock Exchange"),
                holding("HKD", 0.5, exchange=None, asset="Cash", sector="Cash and/or Derivatives"),
                holding("88", 0.0001),
                holding(None, 0.0),
                holding("9999", 2.0, sector="Unclassified"),
            ]
        ),
        fetched_at=NOW,
    )

    assert universe.as_of == "2026-11-05"
    assert [(c.symbol, c.sector_code, c.weight) for c in universe.constituents] == [
        ("0700.HK", "50", pytest.approx(0.6)),
        ("0005.HK", "40", pytest.approx(0.4)),
    ]
    assert universe.constituents[0].name == "SYNTHETIC 700"
    assert universe.constituents[0].isin == "KYSYNTH00001"
    assert sum(c.weight for c in universe.constituents) == pytest.approx(1.0)
    assert {(item.ticker, item.reason) for item in universe.excluded} == {
        ("88", "residual holding"),
        ("", "not quoted on this market"),
        ("9999", "no GICS sector"),
    }


def test_parse_universe_records_other_exchanges_in_a_single_market_fund() -> None:
    universe = parse_universe(
        UNIVERSES["us"],
        points(
            [
                holding("AAA", 2.0, exchange="NASDAQ"),
                holding("CVR", 0.5, exchange="NO MARKET (E.G. UNLISTED)"),
            ]
        ),
        fetched_at=NOW,
    )
    assert [c.symbol for c in universe.constituents] == ["AAA"]
    assert [(item.ticker, item.reason) for item in universe.excluded] == [
        ("CVR", "not quoted on this market")
    ]


def test_parse_universe_rejects_incomplete_or_empty_holdings() -> None:
    broken = points([holding("700", 1.0)])
    broken["isin"] = {"value": []}
    with pytest.raises(ValueError, match="incomplete"):
        parse_universe(UNIVERSES["hk"], broken, fetched_at=NOW)
    with pytest.raises(ValueError, match="no hk constituents"):
        parse_universe(
            UNIVERSES["hk"],
            points([holding("2330", 1.0, exchange="Taiwan Stock Exchange")]),
            fetched_at=NOW,
        )


def synthetic_universe(spec: UniverseSpec, fetched_at: datetime) -> SectorUniverse:
    return parse_universe(
        spec,
        points([holding("1", 1.0, exchange="Hong Kong Exchanges And Clearing Ltd")]),
        fetched_at=fetched_at,
    )


def test_universe_provider_serves_a_fresh_cache_and_refreshes_a_stale_one(tmp_path: Path) -> None:
    clock = {"now": NOW}
    calls: list[str] = []

    def fetch(spec: UniverseSpec) -> SectorUniverse:
        calls.append(spec.market)
        return synthetic_universe(spec, clock["now"])

    provider = SectorUniverseProvider(tmp_path, fetcher=fetch, now=lambda: clock["now"])
    first = provider.get("hk")
    assert calls == ["hk"]
    path = tmp_path / "research-cache" / "sector-universe" / "hk.json"
    assert json.loads(path.read_text())["constituents"][0]["symbol"] == "0001.HK"

    clock["now"] = NOW + timedelta(hours=19)
    assert provider.get("hk") == first
    assert calls == ["hk"]

    clock["now"] = NOW + timedelta(hours=21)
    refreshed = SectorUniverseProvider(tmp_path, fetcher=fetch, now=lambda: clock["now"]).get("hk")
    assert calls == ["hk", "hk"]
    assert refreshed.fetched_at == clock["now"].isoformat()


def test_universe_provider_keeps_a_stale_cache_when_the_issuer_fails(tmp_path: Path) -> None:
    def fail(spec: UniverseSpec) -> SectorUniverse:
        raise RuntimeError("issuer unavailable")

    seeded = SectorUniverseProvider(
        tmp_path,
        fetcher=lambda spec: synthetic_universe(spec, NOW),
        now=lambda: NOW,
    ).get("hk")
    later = NOW + timedelta(days=3)

    assert SectorUniverseProvider(tmp_path, fetcher=fail, now=lambda: later).get("hk") == seeded
    with pytest.raises(RuntimeError, match="issuer unavailable"):
        SectorUniverseProvider(tmp_path, fetcher=fail, now=lambda: later).get("kr")


def test_japan_basket_uses_tokyo_listings_only() -> None:
    universe = parse_universe(
        UNIVERSES["jp"],
        points(
            [
                holding("7203", 3.0, exchange="Tokyo Stock Exchange"),
                holding("130A", 1.0, exchange="Tokyo Stock Exchange"),
                holding("7203", 5.0, exchange="Osaka Exchange"),
                holding("JPY", 0.4, exchange=None, asset="Cash"),
            ]
        ),
        fetched_at=NOW,
    )
    assert universe.universe == "MSCI Japan"
    assert universe.fund_ticker == "IJPN"
    assert [c.symbol for c in universe.constituents] == ["7203.T", "130A.T"]
    assert [c.weight for c in universe.constituents] == [0.75, 0.25]
