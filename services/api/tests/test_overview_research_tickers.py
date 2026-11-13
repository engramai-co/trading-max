from types import SimpleNamespace

from services.api.trading_max_api.routes.system import researched_holdings


def test_overview_keeps_research_rows_for_fund_listings_and_stocks():
    holdings = [
        SimpleNamespace(ticker="EQQQ", research_ticker="EQQQ.L"),
        SimpleNamespace(ticker="SYN", research_ticker=None),
    ]
    assert researched_holdings(holdings) == {"EQQQ", "EQQQ.L", "SYN"}
