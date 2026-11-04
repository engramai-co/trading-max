from trading_max.research.facts import make_quote
from trading_max.research.listing import broker_listing, quote_listing

NEW_YORK = {"fullExchangeName": "NYSE", "exchangeTimezoneName": "America/New_York"}
LONDON = {"fullExchangeName": "LSE", "exchangeTimezoneName": "Europe/London"}


def test_broker_instruments_name_their_market():
    assert broker_listing("IAG_US_EQ") == "US:IAG"
    assert broker_listing("IAGl_EQ") == "LSE:IAG"
    assert broker_listing("goo3l_EQ") == "LSE:GOO3"
    # Markets the display ticker keeps in the code, and missing codes, are unknown.
    assert broker_listing("SAPd_EQ") is None
    assert broker_listing("_US_EQ") is None
    assert broker_listing("") is None and broker_listing(None) is None


def test_research_quotes_name_the_listing_their_exchange_quotes():
    assert quote_listing("IAG.L", "LSE", "Europe/London") == "LSE:IAG"
    assert quote_listing("IAG", "NYSE", "America/New_York") == "US:IAG"
    assert quote_listing("AAPL", "NasdaqGS", "America/New_York") == "US:AAPL"
    # A bare symbol is a US listing only when its exchange says so.
    assert quote_listing("IAG", None, None) is None
    assert quote_listing("IAG", "LSE", "Europe/London") is None
    assert quote_listing("SHOP.TO", "Toronto", "America/Toronto") is None
    assert quote_listing("SAP.DE", "XETRA", "Europe/Berlin") is None


def test_quotes_carry_their_listing():
    london = make_quote("IAG.L", {"spot": 3.1}, {"currency": "GBp", "metrics": LONDON})
    assert london.listing == "LSE:IAG" and london.currency == "GBP"
    assert make_quote("IAG", {"spot": 4.2, "currency": "USD"}, {"metrics": NEW_YORK}).listing == (
        "US:IAG"
    )
    assert make_quote("IAG", {"spot": 4.2, "currency": "USD"}, {}).listing is None
