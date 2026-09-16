from services.api.trading_max_api.security_search_matching import (
    company_key,
    index_candidates,
    match_score,
    merge_candidates,
    quote_candidates,
)


def test_similarity_is_not_company_identity():
    assert match_score("microstrategy", "RoboStrategy, Inc.") == 0
    assert match_score("mircosoft", "Microsoft Corporation") > 0.82
    assert match_score("plantir", "Palantir Technologies Inc-A") > 0.82
    assert match_score("zzzzz", "Northstar Inc", "NSTR") == 0
    assert match_score("appl", "Apple Inc", "AAPL") > match_score(
        "appl", "Applied Materials Inc", "AMAT"
    )


def test_common_legal_and_share_class_suffixes_do_not_affect_name_comparison():
    assert company_key("Example Inc-CL A") == company_key("Example Incorporated")
    assert company_key("Example Inc.                 R") == "example"


def test_fuzzy_search_keeps_three_candidates_and_exact_ticker_first():
    entries = [
        ("Northstar Inc", "NSTR"),
        ("Northstart Corp", "NSTT"),
        ("Northstars Ltd", "NSTS"),
        ("Northstone Inc", "NSTN"),
    ]
    candidates = index_candidates("northstr", entries)
    assert len(candidates) == 3
    assert {item.ticker for item in candidates} == {"NSTR", "NSTT", "NSTS"}
    assert index_candidates("NSTN", entries)[0].ticker == "NSTN"


def test_provider_aliases_require_equities_and_never_convert_foreign_symbols_to_us():
    candidates = quote_candidates(
        "oldbrand",
        [
            {"symbol": "NEW", "longname": "Newbrand Inc", "quoteType": "EQUITY", "exchange": "NMS"},
            {
                "symbol": "OB.DE",
                "longname": "Oldbrand Inc",
                "shortname": "Newbrand Inc.",
                "quoteType": "EQUITY",
                "exchange": "GER",
            },
            {
                "symbol": "OB3.L",
                "longname": "3x Oldbrand ETF",
                "quoteType": "ETF",
                "exchange": "LSE",
            },
            {
                "symbol": "OBL.DE",
                "longname": "Leverage Shares Oldbrand ETP",
                "shortname": "Leverage Shares PLC",
                "quoteType": "EQUITY",
                "exchange": "GER",
            },
        ],
    )
    assert {item.query for item in candidates} == {"NEW", "newbrand"}
    assert {item.ticker for item in candidates} == {"NEW", ""}
    assert len(merge_candidates(candidates + candidates)) == 2


def test_short_completion_and_provider_relevance_beat_alphabetical_ticker_order():
    entries = [
        ("Applied Materials Inc", "AMAT"),
        ("Applied Aerospace & Defense", "AADX"),
        ("Apple Inc", "AAPL"),
        ("Applied Digital Corp", "APLD"),
    ]
    quotes = [
        {"symbol": ticker, "longname": name, "quoteType": "EQUITY", "exchange": "NMS"}
        for name, ticker in [
            ("Apple Inc", "AAPL"),
            ("Applied Materials Inc", "AMAT"),
            ("Applied Digital Corp", "APLD"),
        ]
    ]
    candidates = merge_candidates(
        [*index_candidates("appl", entries), *quote_candidates("appl", quotes)]
    )
    assert [item.ticker for item in candidates] == ["AAPL", "AMAT", "APLD"]
    exact = merge_candidates(
        [*index_candidates("AAPL", entries), *quote_candidates("AAPL", quotes)]
    )
    assert [item.ticker for item in exact] == ["AAPL"]
