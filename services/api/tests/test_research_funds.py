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
