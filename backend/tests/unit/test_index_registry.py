from trading_max.domain.etf import FundEvidence, FundShareClass
from trading_max.reference.indices import INDEX_REGISTRY, issuer_benchmark_id


def test_benchmark_link_requires_issuer_evidence_and_does_not_claim_same_variant() -> None:
    profile = FundShareClass(
        isin="ZZ0000000001", issuer="Synthetic", index_name="MSCI World Index (Net)"
    )
    assert profile.benchmark_id is None
    profile.evidence["index_name"] = FundEvidence(
        source_url="https://example.invalid",
        fetched_at="2026-01-01",
        parser_version="synthetic",
        coverage="available",
    )
    assert profile.benchmark_id == "msci-world"
    assert INDEX_REGISTRY[profile.benchmark_id].basis == "price"
    assert issuer_benchmark_id("MSCI World GBP Hedged Index") is None
    assert issuer_benchmark_id("S&P 500 Equal Weight Index") is None


def test_proxies_and_unavailable_histories_are_explicit() -> None:
    assert INDEX_REGISTRY["topix"].symbol == "1306.T"
    assert INDEX_REGISTRY["topix"].kind == INDEX_REGISTRY["hang-seng-tech"].kind == "etf-price"
    assert INDEX_REGISTRY["ftse-all-world-etf"].benchmark == "ftse-all-world"
    assert INDEX_REGISTRY["ftse-all-world"].history_years == 0
    assert INDEX_REGISTRY["ftse-all-world"].symbol is None
    assert INDEX_REGISTRY["ftse-all-world"].rights == "licensed-source-required"
    assert INDEX_REGISTRY["msci-japan"].symbol is None
    assert INDEX_REGISTRY["dax"].basis == "total-return"


def test_index_quotes_never_come_from_listing_symbols():
    # An index card must quote an index; listing prices are only allowed when labelled as ETF prices.
    for spec in INDEX_REGISTRY.values():
        if spec.kind == "index" and spec.symbol is not None:
            assert spec.symbol.startswith("^"), (spec.id, spec.symbol)
