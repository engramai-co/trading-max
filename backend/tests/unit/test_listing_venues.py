from itertools import combinations_with_replacement, product

from trading_max.research.venues import VenueClaim, resolve_venue


def test_all_pairs_of_explicit_claims_preserve_listing_identity_in_either_order():
    values = {
        "symbol": ("SYN.F", "SYN.DE"),
        "mic": ("XFRA", "XETR"),
        "yahoo": ("FRA", "GER"),
        "fundamentals": ("Frankfurt", "XETRA"),
        "openfigi": ("GF", "GY"),
        "name": ("Frankfurt Stock Exchange", None),
    }
    for left, right in combinations_with_replacement(values, 2):
        for a, b, observed in product((0, 1, None), (0, 1, None), ("SYN", "SYNTH")):
            claims = [
                VenueClaim(kind, values[kind][idx] if idx is not None else None, owner)
                for kind, idx, owner in ((left, a, "SYN"), (right, b, observed))
            ]
            known = {idx for idx, claim in zip((a, b), claims, strict=True) if claim.value}
            expected = (
                frozenset(("XFRA", "XETR")[i] for i in known) if len(known) == 1 else frozenset()
            )
            for pair in (claims, claims[::-1]):
                result = resolve_venue("SYN", *pair)
                assert (result.venues, result.conflict) == (expected, len(known) > 1), pair


def test_market_defaults_are_local_to_the_claimed_symbol_and_namespaces_are_disjoint():
    for source, value in (
        ("symbol", "SYN.L"),
        ("mic", "XLON"),
        ("yahoo", "LSE"),
        ("fundamentals", "LSE"),
        ("openfigi", "LN"),
        ("name", "London"),
    ):
        for owner in ("SYN", "SYN.L"):
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
