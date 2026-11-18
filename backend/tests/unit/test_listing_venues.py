from itertools import combinations_with_replacement, product

import pytest
from trading_max.research.venues import VenueClaim, resolve_venue


def test_all_pairs_of_claims_agree_conflict_or_are_missing_for_one_or_two_listings():
    # Each column names the same venue in the source's own namespace. The two
    # broad claims describe the whole market, so neither implies a calendar.
    values = {
        "symbol": ("SYN.F", "SYN.T"),
        "mic": ("XFRA", "XTKS"),
        "yahoo": ("FRA", "JPX"),
        "fundamentals": ("Frankfurt", "Tokyo"),
        "openfigi": ("GF", "JT"),
        "name": ("Frankfurt Stock Exchange", "Tokyo Stock Exchange"),
        "region": ("GR", "JP"),
        "market": ("GR", "JP"),
    }
    markets = ({"XFRA", "XETR"}, {"XTKS", "XOSE"})
    exact = ({"XFRA"}, {"XTKS"})
    for left, right in combinations_with_replacement(values, 2):
        for a, b, observed in product((0, 1, None), (0, 1, None), ("SYN", "ALIAS")):
            entries = [(left, a, "SYN"), (right, b, observed)]
            claims = [
                VenueClaim(kind, values[kind][idx] if idx is not None else None, owner)
                for kind, idx, owner in entries
            ]
            owners_with_evidence = {
                owner for kind, idx, owner in entries if idx is not None and kind != "market"
            }
            applicable = [
                (markets if kind in {"market", "region"} else exact)[idx]
                for kind, idx, owner in entries
                if idx is not None and (kind != "market" or owner not in owners_with_evidence)
            ]
            venues = set.intersection(*applicable) if applicable else set()
            has_exact = any(
                idx is not None and kind not in {"market", "region"} for kind, idx, _ in entries
            )
            calendar = next(iter(venues)) if venues and has_exact else None
            for pair in (claims, claims[::-1]):
                result = resolve_venue("SYN", *pair)
                assert (result.venues, result.conflict, result.calendar) == (
                    venues,
                    bool(applicable and not venues),
                    calendar,
                ), pair


def test_market_defaults_are_local_to_the_claimed_symbol_and_namespaces_are_disjoint():
    for source, value in (
        ("symbol", "SYN.L"),
        ("mic", "XLON"),
        ("yahoo", "LSE"),
        ("fundamentals", "LSE"),
        ("openfigi", "LN"),
        ("name", "London"),
    ):
        for owner in ("SYN", "ALIAS"):
            claim = VenueClaim(source, value, owner)
            default = VenueClaim("market", "US", "SYN")
            result = resolve_venue("SYN", claim, default)
            assert result.conflict == (owner != "SYN")
            assert result.calendar == ("XLON" if owner == "SYN" else None)
    assert resolve_venue("SYN.L", VenueClaim("market", "US")).venues == {"XLON"}
    assert resolve_venue("SYN.BO", VenueClaim("openfigi", "BO")).conflict
    assert resolve_venue("SYN.BO", VenueClaim("openfigi", "IB")).venues == {"XBOM"}
    for source in ("mic", "yahoo", "fundamentals"):
        assert not resolve_venue("SYN", VenueClaim(source, "BO")).venues
    assert not resolve_venue("SYN", VenueClaim("openfigi", "LSE")).venues


def test_unknown_provider_codes_withhold_timing_on_a_qualified_listing():
    for source in ("yahoo", "mic", "fundamentals"):
        assert resolve_venue("SYN.L", VenueClaim(source, "UNVERIFIED")).calendar is None
    assert resolve_venue("SYN.L", VenueClaim("market", "US")).calendar == "XLON"


@pytest.mark.parametrize(
    ("source", "ny", "london"),
    [
        ("mic", "XNYS", "XLON"),
        ("yahoo", "NYQ", "LSE"),
        ("fundamentals", "NYSE", "LSE"),
        ("openfigi", "UN", "LN"),
        ("name", "ARCA", "London"),
    ],
)
def test_qualified_claim_owner_retains_its_suffix(source, ny, london):
    assert resolve_venue("SYN", VenueClaim(source, ny, "SYN.L")).conflict
    assert resolve_venue("SYN", VenueClaim(source, london, "SYN.L")).venues == {"XLON"}
    assert resolve_venue("SYN", VenueClaim(source, None, "SYN.L")).venues == {"XLON"}


def test_unknown_region_does_not_enter_a_provider_namespace():
    assert not resolve_venue("SYN", VenueClaim("region", "LSE")).venues
