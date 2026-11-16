from services.api.trading_max_api.security_search_matching import (
    company_key,
    index_candidates,
    match_score,
    merge_candidates,
    quote_candidates,
    same_issuer,
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


def test_listing_name_names_issuer_through_listing_forms_contractions_and_width_cuts():
    # Synthetic OpenFIGI-style names. A depositary receipt cut to the width limit
    # drops trailing words or ends with a cut word.
    assert same_issuer(
        "NORTHSTAR MICROCHIP-SP ADR", "Northstar Microchip Manufacturing Company Limited"
    )
    assert same_issuer("NORTHSTAR ENTERTAINM-SP ADR", "Northstar Entertainment Group")
    assert same_issuer(
        "INTL NORTHSTAR MACHINES CORP", "International Northstar Machines Corporation"
    )
    assert same_issuer("NEWBRAND HOLDING NV-NY REG SHS", "Newbrand Holding N.V.")
    assert same_issuer("CAFE NORTHSTAR SA-SPON ADR", "Café Northstar S.A.")
    assert same_issuer("NORTHSTAR & NEWBRAND CO/THE", "The Northstar and Newbrand Company")
    assert same_issuer("NORTHSTAR HOLDINGS LTD/CAYMAN ISL-A", "Northstar Holdings Ltd.")


def test_listing_name_does_not_turn_a_related_or_similar_issuer_into_identity():
    # A legal form shows the listing name was not cut, so missing words differ.
    assert not same_issuer("NORTHSTAR BANCO SA-SPON ADR", "Northstar Banco (Chile) S.A.")
    # A short name had room for the next word.
    assert not same_issuer("NORTHSTAR CAPITAL", "Northstar Capital Lending Fund")
    assert not same_issuer("NORTHSTAR CO/THE", "Northstar Consolidated, Inc.")
    # A shared generic word is not enough, and listings never add words.
    assert not same_issuer("NEW HOLDINGS INC-ADR", "Newbrand Holdings Inc.")
    assert not same_issuer("NORTHSTAR NEWBRAND PARTNERS PLC", "Northstar Inc.")
    assert not same_issuer("DIFFERENT COMPANY INC", "Newbrand Inc")


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
