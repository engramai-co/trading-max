from types import SimpleNamespace

from services.api.trading_max_api import research_funds
from services.api.trading_max_api.research_funds import FundResearchService, parse_ishares_page


def page(nav_currency="USD", index_currency="USD"):
    return f"""<table><tr><th><span class="label" data-id="keyFundFacts-isin-label">ISIN</span></th><td>TEST00000001</td></tr>
    <tr><th><span class="label" data-id="keyFundFacts-emeaMgt-label">Fee</span></th><td>0.20%</td></tr></table>
    <table><thead><tr><th>2024</th><th>2025</th></tr></thead><tbody>
    <tr webqc-datapoint="annualNav"><th>Fund {nav_currency}</th><td>10.0</td><td>—</td></tr>
    <tr webqc-datapoint="benchmarkAnnual"><th>Index {index_currency}<button title="Index: Example Net Total Return"></button></th><td>10.3</td><td>4.0</td></tr></tbody></table>"""


def test_fund_nav_tracking_only_compares_matching_currency_and_complete_years():
    result = parse_ishares_page(page())
    assert result["isin"] == "TEST00000001"
    assert result["expense_ratio"] == 0.002
    assert result["index_name"] == "Example Net Total Return"
    assert [r["year"] for r in result["annual_returns"]] == [2024]
    assert abs(result["annual_returns"][0]["tracking_difference"] + 0.003) < 1e-10
    assert parse_ishares_page(page(index_currency="EUR"))["annual_returns"] == []


def test_profile_fields_survive_api_alias_normalization(tmp_path, monkeypatch):
    monkeypatch.setitem(
        research_funds.BUILTIN_FUND_ADAPTERS,
        "TEST",
        SimpleNamespace(
            issuer="iShares", isin="TEST00000001", source_url="https://issuer.example/fund"
        ),
    )
    monkeypatch.setattr(
        research_funds.httpx,
        "get",
        lambda *a, **kw: SimpleNamespace(text=page(), raise_for_status=lambda: None),
    )
    service = FundResearchService(tmp_path)
    service.provider = SimpleNamespace(fetch=lambda ticker: None)
    result = service.get("TEST", {})
    assert result.expense_ratio == 0.002
    assert result.return_currency == "USD"
    assert len(result.annual_returns) == 1
    assert service.get("TEST", {}).model_dump() == result.model_dump()


def test_current_ishares_facts_keep_share_class_identity_and_separate_asset_sizes():
    from trading_max.infrastructure.fund_profiles import parse_ishares_profile

    for isin in ("IE00B4L5Y983", "IE00BKM4GZ66"):
        html = f"""<h1>Test iShares UCITS ETF</h1><table><tbody>
        <tr data-id="keyFundFacts-row-isin"><th class="caption"><div class="caption-wrapper">
        <span class="oneds-body-m-compact" data-id="keyFundFacts-isin-label">ISIN</span></div>
        </th><td data-id="keyFundFacts-isin-data"><span>{isin}</span></td></tr>
        <tr><th><span data-id="keyFundFacts-totalNetAssets-label">Net Assets of Share Class</span>
        <div data-id="keyFundFacts-totalNetAssets-asOf">as of 11/Nov/2026</div>
        </th><td>USD <span>23,440</span></td></tr>
        <tr><th><span data-id="keyFundFacts-totalNetAssetsFundLevel-label">Net Assets of Fund</span>
        </th><td>USD <span>33,440</span></td></tr>
        </tbody></table>"""
        fund = parse_ishares_profile(html, "https://issuer.example/fund")
        assert fund.isin == isin
        assert fund.share_class_size.amount == 23440
        assert fund.share_class_size.currency == "USD"
        assert fund.fund_size.amount == 33440
        assert fund.evidence["share_class_size"].effective_at == "2026-11-11"
        assert fund.evidence["replication"].coverage == "missing"


def test_held_fund_lenses_use_same_published_reading_without_issuer_io():
    from datetime import UTC, datetime

    from trading_max.analytics.etf_details import ETFDetail, etf_detail_key, etf_holdings_key
    from trading_max.analytics.etf_projection import (
        ETF_SUMMARY_KEY,
        ETFOverlap,
        ETFPortfolio,
        ETFReading,
        ETFTracking,
    )
    from trading_max.analytics.lookthrough import FundSnapshot

    from services.api.trading_max_api.routes.research import research_fund
    from services.api.trading_max_api.routes.system import dashboard_etfs

    stamp = datetime.now(UTC).date().isoformat()
    isin = "IE0032077012"
    reading = ETFReading(
        isin=isin,
        tickers=["EQQQ"],
        holdings_state="available",
        tracking=ETFTracking(state="available", difference_pp=-0.50, period_end=stamp),
        overlap=ETFOverlap(
            state="available",
            value=0.51,
            dates_valid=True,
            fund_holdings_date=stamp,
            portfolio_as_of=stamp,
        ),
    )
    calls = []
    payloads = {
        ETF_SUMMARY_KEY: ETFPortfolio(funds=[reading]).model_dump(),
        etf_detail_key(isin): ETFDetail(reading=reading).model_dump(),
        etf_holdings_key(isin): FundSnapshot(
            ticker="EQQQ", fund_isin=isin, as_of=stamp
        ).model_dump(),
    }

    def read(run_id, key):
        assert run_id == "synthetic"
        calls.append(key)
        return payloads[key]

    store = SimpleNamespace(
        load_manifest=lambda run_id: SimpleNamespace(run_id=run_id), read_json=read
    )
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(store=store)))
    summary = dashboard_etfs(request, "synthetic")
    assert calls == [ETF_SUMMARY_KEY]
    assert summary.run_id == "synthetic"
    fund = research_fund("EQQQ.L", request, run_id="synthetic", detail="profile")
    assert fund.reading == summary.funds[0]
    assert fund.holdings is None
    assert fund.one_year_tracking.difference_pp == -0.50
