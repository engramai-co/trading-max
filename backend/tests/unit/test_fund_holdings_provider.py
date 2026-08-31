from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from trading_max.analytics.lookthrough import FundHolding, FundSnapshot
from trading_max.infrastructure.fund_holdings import (
    OfficialFundHoldingsProvider,
    _iso_date,
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
    assert (tmp_path / "raw" / "fund-holdings" / "XUSE.json").is_file()


def test_provider_refreshes_expired_snapshot(tmp_path: Path) -> None:
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
    refreshed = _snapshot(fetched_at=datetime.now(UTC).isoformat())
    provider = OfficialFundHoldingsProvider(
        tmp_path,
        max_age=timedelta(hours=18),
        fetcher=lambda _ticker: refreshed,
    )

    result = provider.fetch("XUSE")

    assert result is not None
    assert result.as_of == "2026-08-08"


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
