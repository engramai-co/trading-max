from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from trading_max.analytics.lookthrough import FundHolding, FundSnapshot, RawFundHoldingsProvider
from trading_max.infrastructure.fund_holdings import (
    FundSpec,
    OfficialFundHoldingsProvider,
    _iso_date,
    fetch_vanguard,
)


def _snapshot(*, fetched_at: str, as_of: str = "2026-08-08") -> FundSnapshot:
    return FundSnapshot(
        ticker="XUSE",
        as_of=as_of,
        fetched_at=fetched_at,
        industry_as_of=as_of,
        cache_schema_version=2,
        holdings=[
            FundHolding(
                isin="US0378331005",
                ticker="AAPL",
                name="Apple Inc.",
                country="United States",
                industry="Information Technology",
                weight_pct=100,
            )
        ],
        country_weights={"United States": 100},
        industry_weights={"Information Technology": 100},
        source_url="https://issuer.example/xuse",
        issuer="iShares",
    )


def test_iso_date_does_not_swap_iso_month_and_day() -> None:
    assert _iso_date("2026-08-06") == "2026-08-06"


def test_provider_fetches_and_persists_missing_snapshot(tmp_path: Path) -> None:
    calls: list[str] = []

    def fetcher(ticker: str) -> FundSnapshot:
        calls.append(ticker)
        return _snapshot(fetched_at=datetime.now(UTC).isoformat())

    provider = OfficialFundHoldingsProvider(tmp_path, fetcher=fetcher)

    first = provider.fetch("xuse")
    second = provider.fetch("XUSE")

    assert first is not None
    assert second is not None
    assert calls == ["XUSE"]
    assert second.holdings[0].ticker == "AAPL"
    assert (tmp_path / "raw" / "fund-holdings" / "v4" / "IE000R4ZNTN3.json").is_file()


def test_provider_refreshes_expired_snapshot(tmp_path: Path) -> None:
    old = _snapshot(
        fetched_at=(datetime.now(UTC) - timedelta(days=2)).isoformat(),
        as_of="2026-08-06",
    )
    root = tmp_path / "raw" / "fund-holdings"
    root.mkdir(parents=True)
    legacy_payload = old.model_dump_json(
        by_alias=True, exclude={"fund_isin", "unweighted_holdings_count"}
    )
    (root / "XUSE.json").write_text(
        legacy_payload,
        encoding="utf-8",
    )
    refreshed = _snapshot(fetched_at=datetime.now(UTC).isoformat())
    provider = OfficialFundHoldingsProvider(
        tmp_path,
        max_age=timedelta(hours=18),
        fetcher=lambda _ticker: refreshed,
    )

    result = provider.fetch("XUSE")

    assert result is not None
    assert result.as_of == "2026-08-08"
    assert (root / "XUSE.json").read_text() == legacy_payload
    assert result.fund_isin == "IE000R4ZNTN3"
    assert RawFundHoldingsProvider(tmp_path).fetch("XUSE").as_of == "2026-08-08"


def test_provider_uses_stale_cache_when_issuer_is_temporarily_down(
    tmp_path: Path,
) -> None:
    old = _snapshot(
        fetched_at=(datetime.now(UTC) - timedelta(days=2)).isoformat(),
        as_of="2026-08-06",
    )
    root = tmp_path / "raw" / "fund-holdings"
    root.mkdir(parents=True)
    (root / "XUSE.json").write_text(
        old.model_dump_json(by_alias=True),
        encoding="utf-8",
    )

    def unavailable(_ticker: str) -> FundSnapshot:
        raise RuntimeError("issuer timeout")

    provider = OfficialFundHoldingsProvider(tmp_path, fetcher=unavailable)

    result = provider.fetch("XUSE")

    assert result is not None
    assert result.as_of == "2026-08-06"


def test_provider_does_not_hide_first_fetch_failure(tmp_path: Path) -> None:
    def unavailable(_ticker: str) -> FundSnapshot:
        raise RuntimeError("issuer timeout")

    provider = OfficialFundHoldingsProvider(tmp_path, fetcher=unavailable)

    try:
        provider.fetch("XUSE")
    except RuntimeError as exc:
        assert str(exc) == "issuer timeout"
    else:
        raise AssertionError("missing-cache issuer failure must be raised")


def test_provider_resolves_london_suffix_without_guessing_another_fund(tmp_path: Path):
    calls = []

    def fetcher(ticker):
        calls.append(ticker)
        return _snapshot(fetched_at=datetime.now(UTC).isoformat())

    provider = OfficialFundHoldingsProvider(tmp_path, fetcher=fetcher)
    assert provider.fetch("XUSE.L").ticker == "XUSE.L"
    assert provider.fetch("UNKNOWN.L") is None
    assert calls == ["XUSE"]


@pytest.mark.parametrize("incomplete", [False, True])
def test_vanguard_paginates_and_preserves_non_equity_weights(incomplete):
    import json

    pages = []

    def handler(request):
        assert request.headers["x-consumer-id"] == "uk2"
        cursor = json.loads(request.content)["variables"]["lastItemKey"]
        pages.append(cursor)
        second = cursor is not None
        return httpx.Response(
            200,
            json={
                "data": {
                    "borHoldings": [
                        {
                            "holdings": {
                                "items": [
                                    {
                                        "ticker": "USD" if second else "TEST",
                                        "issuerName": "Fixture",
                                        "securityType": "CRNY" if second else "EQ.STOCK",
                                        "marketValuePercentage": 2 if second else 98,
                                        "effectiveDate": "2026-08-31",
                                        "bloombergIsoCountry": "US",
                                        "gicsSectorDescription": None if second else "Industrials",
                                    }
                                ],
                                "totalHoldings": 3 if incomplete else 2,
                                "lastItemKey": None if second else "page-two",
                            }
                        }
                    ]
                }
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        spec = FundSpec("TEST", "", "Fixture fund", "Vanguard", "https://issuer.example", "1")
        if incomplete:
            with pytest.raises(ValueError, match="incomplete"):
                fetch_vanguard(client, spec)
        else:
            result = fetch_vanguard(client, spec)
            assert len(result.holdings) == 2
            assert result.weight_total_pct() == 100
            assert result.country_weights == {"United States": 98, "Cash & derivatives": 2}
            assert not result.holdings[1].is_security
        assert pages == [None, "page-two"]


def test_share_class_holdings_cache_is_shared_across_listings(tmp_path):
    from trading_max.reference import SecurityDescriptor

    calls = []

    def fetch(ticker):
        calls.append(ticker)
        return _snapshot(fetched_at=datetime.now(UTC).isoformat())

    provider = OfficialFundHoldingsProvider(tmp_path, fetcher=fetch)
    first = provider.fetch_security(SecurityDescriptor(ticker="SWDA.L", isin="IE00B4L5Y983"))
    second = provider.fetch_security(SecurityDescriptor(ticker="EUNL.DE", isin="IE00B4L5Y983"))
    assert first.fund_isin == second.fund_isin == "IE00B4L5Y983"
    assert second.ticker == "EUNL.DE"
    assert calls == ["SWDA"]
    assert provider.fetch("EQGB") is not None
    assert provider.fetch("EQQQ") is not None
    assert calls[-2:] == ["EQGB", "EQQQ"]


@pytest.mark.parametrize(
    ("unit", "expected"),
    [
        ("GBp", ("GBP", 100)),
        ("GBX", ("GBP", 100)),
        ("GBP", ("GBP", 1)),
        ("USD", ("USD", 1)),
        ("", ("", 1)),
    ],
)
def test_quote_units_do_not_apply_currency_conversion_to_pounds_or_dollars(unit, expected):
    from trading_max.reference.quote_units import major_quote_unit

    assert major_quote_unit(unit) == expected


def test_vanguard_profile_separates_fund_assets_and_issuer_tracking_error():
    import json

    from trading_max.infrastructure.fund_profiles import parse_vanguard_profile

    state = {
        "gpx.fund-facts": {
            "portId": "1",
            "facts": {
                "isin": {"value": "IE00BFMXXD54"},
                "currency": {"value": "USD"},
                "benchmark": {"value": "Test Net Total Return"},
                "ocf": {"value": "0.10"},
                "totalAssets": {
                    "value": "50",
                    "options": {"currency": "USD"},
                    "suffix": {"value": "B"},
                    "asOfDate": "2026-10-31",
                },
                "shareClassAssets": {
                    "value": "12.2",
                    "options": {"currency": "USD"},
                    "suffix": {"value": "B"},
                    "tooltip": {"value": "2026-10-31"},
                },
            },
        },
        "gpx.fund-page-heading": {"title": "Test UCITS ETF - (USD) Accumulating"},
        "1": {
            "b": {
                "data": {
                    "polarisAnalyticsHistory": [
                        {
                            "monthly": {
                                "volatility": {
                                    "fund": {
                                        "items": [
                                            {
                                                "codes": {
                                                    "ITRKERBF1Y": {
                                                        "effectiveDate": "2026-09-30",
                                                        "volatilityValue": "0.05",
                                                    },
                                                }
                                            }
                                        ]
                                    }
                                }
                            },
                        }
                    ]
                }
            }
        },
    }
    html = f'<script id="serverApp-state">{json.dumps(state)}</script>'
    profile, factsheet = parse_vanguard_profile(html, "https://issuer.example", "IE00BFMXXD54", "1")
    assert profile.fund_size.amount == 50e9
    assert profile.share_class_size.amount == 12.2e9
    assert profile.evidence["share_class_size"].effective_at == "2026-10-31"
    assert profile.tracking_error == 0.0005
    assert profile.evidence["tracking_error"].effective_at == "2026-09-30"
    assert profile.one_year is factsheet is None
    with pytest.raises(ValueError, match="identity mismatch"):
        parse_vanguard_profile(html, "https://issuer.example", "IE00BK5BQT80", "1")
