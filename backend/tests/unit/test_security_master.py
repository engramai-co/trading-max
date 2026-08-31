from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path

import pytest
from trading_max.reference import (
    GICS_VERSION,
    CatalogSecurityMaster,
    SecurityDescriptor,
    SecurityEntityRecord,
    SecurityMasterCatalog,
    canonical_security_type,
    classification_for_code,
    classification_for_profile,
    infer_gics_eligibility,
    is_fund_instrument,
    is_issuer_equity,
)
from trading_max.reference.enrichment import (
    EnrichmentCandidate,
    MarketSecurityProfile,
    OpenFigiSecurityIdentityProvider,
    SecurityIdentity,
    SecurityMasterEnricher,
    YahooFinanceSecurityProfileProvider,
)


def test_default_catalog_contains_no_company_assignments() -> None:
    master = CatalogSecurityMaster.default()

    assert master.catalog.records == []
    assert master.resolve(SecurityDescriptor(ticker="NVDA")).method == "unresolved"


@pytest.mark.parametrize(
    ("provider_type", "market_sector", "expected_type", "expected_eligibility"),
    [
        ("Common Stock", "Equity", "EQUITY", "eligible"),
        ("Depositary Receipt", "Equity", "EQUITY", "eligible"),
        ("Open-End Fund", "Equity", "ETF", "not-applicable"),
        ("Exchange Traded Fund", "Equity", "ETF", "not-applicable"),
        ("Note", "Govt", "GOVT", "not-applicable"),
        ("New Provider Type", "", "UNKNOWN", "pending"),
    ],
)
def test_provider_security_types_are_data_not_a_fixed_enum(
    provider_type: str,
    market_sector: str,
    expected_type: str,
    expected_eligibility: str,
) -> None:
    assert (
        canonical_security_type(
            provider_security_type=provider_type,
            market_sector=market_sector,
        )
        == expected_type
    )
    assert (
        infer_gics_eligibility(
            provider_security_type=provider_type,
            market_sector=market_sector,
        )
        == expected_eligibility
    )


def test_open_type_parser_routes_known_facts_without_rejecting_new_values() -> None:
    assert is_fund_instrument(provider_security_type2="Exchange Traded Note")
    assert is_issuer_equity(provider_security_type="Common Stock", market_sector="Equity")
    assert not is_fund_instrument(provider_security_type="New Provider Type")
    assert not is_issuer_equity(provider_security_type="New Provider Type")
    assert canonical_security_type(provider_security_type="New Provider Type") == "UNKNOWN"


def test_exact_identity_equity_type_outranks_colliding_market_search_etf() -> None:
    assert (
        canonical_security_type(
            quote_type="ETF",
            provider_security_type="Common Stock",
            provider_security_type2="Common Stock",
            market_sector="Equity",
        )
        == "EQUITY"
    )
    assert (
        infer_gics_eligibility(
            quote_type="ETF",
            provider_security_type="Common Stock",
            provider_security_type2="Common Stock",
            market_sector="Equity",
        )
        == "eligible"
    )


class _OpenFigiMappingResponse:
    status_code = 200

    def __init__(self) -> None:
        self.headers: dict[str, str] = {}

    def raise_for_status(self) -> None:
        return None

    def json(self) -> list[dict[str, object]]:
        return [
            {
                "data": [
                    {
                        "figi": "BBG000000001",
                        "compositeFIGI": "BBG000000002",
                        "shareClassFIGI": "BBG000000003",
                        "name": "ADYEN NV",
                        "ticker": "ADYEN",
                        "exchCode": "NA",
                        "marketSector": "Equity",
                        "securityType": "Common Stock",
                        "securityType2": "Common Stock",
                    }
                ]
            }
        ]


def test_openfigi_identity_provider_maps_isin_without_company_seed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_post(*_args: object, **kwargs: object) -> _OpenFigiMappingResponse:
        captured.update(kwargs)
        return _OpenFigiMappingResponse()

    monkeypatch.setattr(
        "trading_max.reference.enrichment.httpx.post",
        fake_post,
    )
    security = SecurityDescriptor(
        isin="NL0012969182",
        name="ADYEN",
    )

    result = OpenFigiSecurityIdentityProvider().resolve_many([security])

    assert captured["json"] == [{"idType": "ID_ISIN", "idValue": "NL0012969182"}]
    identity = next(iter(result.values()))
    assert identity.symbol == "ADYEN"
    assert identity.provider_security_type == "Common Stock"
    assert identity.market_sector == "Equity"


@pytest.mark.parametrize(
    (
        "security",
        "search_rows",
        "expected_symbol",
        "expected_industry",
    ),
    [
        (
            SecurityDescriptor(
                ticker="9999",
                name="NETEASE INC",
                isin="KYG6427A1022",
                country="China",
            ),
            {
                "KYG6427A1022": [
                    {
                        "symbol": "KYG6427A1022.SG",
                        "exchange": "STU",
                        "shortname": "NetEase Inc.",
                        "quoteType": "EQUITY",
                    },
                    {
                        "symbol": "9999.HK",
                        "exchange": "HKG",
                        "longname": "NetEase, Inc.",
                        "quoteType": "EQUITY",
                        "sector": "Communication Services",
                        "industry": "Electronic Gaming & Multimedia",
                    },
                ],
            },
            "9999.HK",
            "Electronic Gaming & Multimedia",
        ),
        (
            SecurityDescriptor(
                ticker="VWS",
                name="VESTAS WIND SYSTEMS A/S",
                isin="DK0061539921",
                country="Denmark",
            ),
            {
                "DK0061539921": [
                    {
                        "symbol": "VWS.CO",
                        "exchange": "CPH",
                        "longname": "Vestas Wind Systems A/S",
                        "quoteType": "EQUITY",
                        "sector": "Industrials",
                        "industry": "Specialty Industrial Machinery",
                    },
                    {
                        "symbol": "DK0061539921.SG",
                        "exchange": "STU",
                        "shortname": "Vestas Wind Systems AS",
                        "quoteType": "EQUITY",
                    },
                ],
            },
            "VWS.CO",
            "Specialty Industrial Machinery",
        ),
        (
            SecurityDescriptor(
                ticker="BMW",
                name="BAYERISCHE MOTOREN WERKE AG",
                isin="DE0005190003",
                country="Germany",
            ),
            {
                "DE0005190003": [
                    {
                        "symbol": "BMW.DE",
                        "exchange": "GER",
                        "longname": "Bayerische Motoren Werke Aktiengesellschaft",
                        "quoteType": "EQUITY",
                        "sector": "Consumer Cyclical",
                        "industry": "Auto Manufacturers",
                    },
                    {
                        "symbol": "BMW.F",
                        "exchange": "FRA",
                        "longname": "Bayerische Motoren Werke Aktiengesellschaft",
                        "quoteType": "EQUITY",
                        "sector": "Consumer Cyclical",
                        "industry": "Auto Manufacturers",
                    },
                ],
            },
            "BMW.F",
            "Auto Manufacturers",
        ),
    ],
)
def test_yahoo_profile_provider_resolves_global_listing_without_suffix_seed(
    monkeypatch: pytest.MonkeyPatch,
    security: SecurityDescriptor,
    search_rows: dict[str, list[dict[str, str]]],
    expected_symbol: str,
    expected_industry: str,
) -> None:
    class FakeSearch:
        def __init__(self, query: str, *, max_results: int) -> None:
            del max_results
            self.quotes = search_rows.get(query, [])

    monkeypatch.setattr(
        "trading_max.reference.enrichment.yf.Search",
        FakeSearch,
    )

    profile = YahooFinanceSecurityProfileProvider().resolve(security)

    assert profile is not None
    assert profile.symbol == expected_symbol
    assert profile.industry == expected_industry


def test_yahoo_profile_provider_rejects_ambiguous_unrelated_issuers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSearch:
        def __init__(self, query: str, *, max_results: int) -> None:
            del query, max_results
            self.quotes = [
                {
                    "symbol": "SAN.DE",
                    "exchange": "NYQ",
                    "longname": "Banco Santander S.A.",
                    "quoteType": "EQUITY",
                },
                {
                    "symbol": "SAN.PA",
                    "exchange": "PAR",
                    "longname": "Sanofi",
                    "quoteType": "EQUITY",
                },
            ]

    monkeypatch.setattr(
        "trading_max.reference.enrichment.yf.Search",
        FakeSearch,
    )

    assert (
        YahooFinanceSecurityProfileProvider().resolve(
            SecurityDescriptor(ticker="SAN", name="Unknown SAN issuer")
        )
        is None
    )


def test_yahoo_profile_provider_rejects_complete_but_unrelated_isin_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSearch:
        def __init__(self, query: str, *, max_results: int) -> None:
            del query, max_results
            self.quotes = [
                {
                    "symbol": "WRONG",
                    "exchange": "NYQ",
                    "longname": "Unrelated Complete Company",
                    "quoteType": "EQUITY",
                    "sector": "Technology",
                    "industry": "Software—Infrastructure",
                }
            ]

    monkeypatch.setattr(
        "trading_max.reference.enrichment.yf.Search",
        FakeSearch,
    )

    assert (
        YahooFinanceSecurityProfileProvider().resolve(
            SecurityDescriptor(
                ticker="VWS",
                name="Vestas Wind Systems A/S",
                isin="DK0061539921",
            )
        )
        is None
    )


def test_yahoo_profile_provider_prefers_isin_matched_global_equity_over_bare_etf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    search_rows = {
        "IT0003796171": [
            {
                "symbol": "PST.MI",
                "exchange": "MIL",
                "longname": "Poste Italiane S.p.A.",
                "quoteType": "EQUITY",
                "sector": "Industrials",
                "industry": "Conglomerates",
            }
        ],
        "PST": [
            {
                "symbol": "PST",
                "exchange": "PCX",
                "longname": "ProShares UltraShort 7-10 Year Treasury",
                "quoteType": "ETF",
            }
        ],
        "POSTE ITALIANE SPA": [
            {
                "symbol": "PITAF",
                "exchange": "PNK",
                "longname": "Poste Italiane S.p.A.",
                "quoteType": "EQUITY",
                "sector": "Industrials",
                "industry": "Conglomerates",
            }
        ],
    }

    class FakeSearch:
        def __init__(self, query: str, *, max_results: int) -> None:
            del max_results
            self.quotes = search_rows.get(query, [])

    monkeypatch.setattr(
        "trading_max.reference.enrichment.yf.Search",
        FakeSearch,
    )

    profile = YahooFinanceSecurityProfileProvider().resolve(
        SecurityDescriptor(
            ticker="PST",
            isin="IT0003796171",
            name="POSTE ITALIANE SPA",
            country="Italy",
        )
    )

    assert profile is not None
    assert profile.symbol == "PST.MI"
    assert profile.quote_type == "EQUITY"
    assert profile.industry == "Conglomerates"


def test_identity_merge_preserves_venue_qualified_market_profile_symbol() -> None:
    profile = MarketSecurityProfile(
        symbol="9999.HK",
        name="NetEase, Inc.",
        quote_type="EQUITY",
        exchange="HKG",
        sector="Communication Services",
        industry="Electronic Gaming & Multimedia",
        source="yahoo-finance",
        as_of="2026-08-13",
    )
    identity = SecurityIdentity(
        symbol="9999",
        name="NETEASE INC",
        exchange="HK",
        figi="BBG00P19DKZ6",
        composite_figi="BBG00P19DKX8",
        share_class_figi="BBG001S81WJ1",
        provider_security_type="Common Stock",
        provider_security_type2="Common Stock",
        market_sector="Equity",
        source="openfigi-v3",
        as_of="2026-08-13",
    )

    merged = SecurityMasterEnricher._profile_with_identity(profile, identity)

    assert merged.symbol == "9999.HK"
    assert merged.exchange == "HKG"
    assert merged.name == "NetEase, Inc."
    assert merged.figi == "BBG00P19DKZ6"
    assert merged.provider_security_type == "Common Stock"
    assert merged.source == "openfigi-v3+yahoo-finance"


class _IdentityOnlyProvider:
    def resolve_many(
        self,
        securities: object,
    ) -> dict[str, SecurityIdentity]:
        security = next(iter(securities))  # type: ignore[arg-type]
        return {
            security.isin: SecurityIdentity(
                symbol="PST",
                name="ProShares UltraShort 7-10 Year Treasury",
                figi="BBG00PST0001",
                composite_figi="BBG00PST0002",
                share_class_figi="BBG00PST0003",
                provider_security_type="Open-End Fund",
                provider_security_type2="Exchange Traded Fund",
                market_sector="Equity",
                source="openfigi-v3",
                as_of="2026-08-13",
            )
        }


class _NoProfileProvider:
    def resolve(self, security: SecurityDescriptor) -> None:
        del security


class _PosteIdentityProvider:
    def resolve_many(
        self,
        securities: object,
    ) -> dict[str, SecurityIdentity]:
        security = next(iter(securities))  # type: ignore[arg-type]
        return {
            security.isin: SecurityIdentity(
                symbol="PST",
                name="POSTE ITALIANE SPA",
                exchange="IM",
                figi="BBG009D5DPX1",
                composite_figi="BBG009D5DPW2",
                share_class_figi="BBG009D5DPV3",
                provider_security_type="Common Stock",
                provider_security_type2="Common Stock",
                market_sector="Equity",
                source="openfigi-v3",
                as_of="2026-08-13",
            )
        }


class _PosteProfileProvider:
    def resolve(self, security: SecurityDescriptor) -> MarketSecurityProfile:
        assert security.isin == "IT0003796171"
        return MarketSecurityProfile(
            symbol="PST.MI",
            name="Poste Italiane S.p.A.",
            quote_type="EQUITY",
            exchange="MIL",
            country="Italy",
            sector="Industrials",
            industry="Conglomerates",
            source="yahoo-finance",
            as_of="2026-08-13",
        )


def test_dynamic_refresh_repairs_cached_equity_misidentified_as_same_ticker_etf(
    tmp_path: Path,
) -> None:
    catalog_path = tmp_path / "reference" / "security-master.json"
    catalog_path.parent.mkdir(parents=True)
    catalog_path.write_text(
        json.dumps(
            {
                "schemaVersion": 3,
                "asOf": "2026-08-13",
                "records": [
                    {
                        "entityId": "fund:wrong-pst",
                        "canonicalTicker": "PST",
                        "entityName": "POSTE ITALIANE SPA",
                        "securityType": "ETF",
                        "providerSecurityType": "Common Stock",
                        "providerSecurityType2": "Common Stock",
                        "marketSector": "Equity",
                        "gicsEligibility": "not-applicable",
                        "tickerAliases": ["PST"],
                        "nameAliases": [
                            "POSTE ITALIANE SPA",
                            "ProShares UltraShort 7-10 Year Treasury",
                        ],
                        "isins": ["IT0003796171"],
                        "source": "openfigi-v3+yahoo-finance",
                        "asOf": "2026-08-13",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    report = SecurityMasterEnricher(
        tmp_path,
        provider=_PosteProfileProvider(),
        identity_provider=_PosteIdentityProvider(),
        target_coverage=1.0,
    ).enrich(
        [
            EnrichmentCandidate(
                security=SecurityDescriptor(
                    ticker="PST",
                    isin="IT0003796171",
                    name="POSTE ITALIANE SPA",
                    country="Italy",
                ),
                exposure_gbp=100,
            )
        ],
        exhaustive=True,
    )

    catalog = CatalogSecurityMaster.from_state_root(tmp_path)
    resolved = catalog.resolve(SecurityDescriptor(isin="IT0003796171"))

    assert report.attempted == 1
    assert report.classification_coverage_pct == 1.0
    assert len(catalog.catalog.records) == 1
    assert resolved.entity_id.startswith("issuer:")
    assert resolved.canonical_ticker == "PST.MI"
    assert resolved.security_type == "EQUITY"
    assert resolved.gics_eligibility == "eligible"
    assert resolved.gics is not None
    assert resolved.gics.sub_industry_code == "20105010"
    assert (
        "ProShares UltraShort 7-10 Year Treasury"
        not in next(iter(catalog.catalog.records)).name_aliases
    )


def test_identity_only_non_equity_is_persisted_without_business_profile(
    tmp_path: Path,
) -> None:
    report = SecurityMasterEnricher(
        tmp_path,
        provider=_NoProfileProvider(),
        identity_provider=_IdentityOnlyProvider(),
        target_coverage=1.0,
    ).enrich(
        [
            EnrichmentCandidate(
                security=SecurityDescriptor(
                    isin="US74347G3747",
                    name="ProShares UltraShort 7-10 Year Treasury",
                ),
                exposure_gbp=10,
            )
        ]
    )

    resolved = CatalogSecurityMaster.from_state_root(tmp_path).resolve(
        SecurityDescriptor(isin="US74347G3747")
    )
    assert resolved.security_type == "ETF"
    assert resolved.provider_security_type == "Open-End Fund"
    assert resolved.provider_security_type2 == "Exchange Traded Fund"
    assert resolved.gics_eligibility == "not-applicable"
    assert report.gics_not_applicable_exposure_gbp == 10
    assert report.gics_eligible_exposure_gbp == 0


@pytest.mark.parametrize(
    "broker_name",
    [
        "NVIDIA CORP USD0.001",
        "NVIDIA CORP USD 0.001",
        "NVIDIA CORPORATION ORD NPV",
    ],
)
def test_broker_name_denomination_suffix_resolves_to_dynamic_catalog_issuer(
    tmp_path: Path,
    broker_name: str,
) -> None:
    path = tmp_path / "reference" / "security-master.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "asOf": "2026-08-13",
                "records": [
                    {
                        "entityId": "issuer:nvidia",
                        "canonicalTicker": "NVDA",
                        "entityName": "NVIDIA Corporation",
                        "tickerAliases": ["NVDA"],
                        "nameAliases": ["NVIDIA Corporation"],
                        "source": "yahoo-finance",
                        "asOf": "2026-08-13",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    resolved = CatalogSecurityMaster.from_state_root(tmp_path).resolve(
        SecurityDescriptor(name=broker_name)
    )

    assert resolved.entity_id == "issuer:nvidia"
    assert resolved.canonical_ticker == "NVDA"
    assert resolved.method == "name"


def test_name_normalization_does_not_strip_non_trailing_currency_text(
    tmp_path: Path,
) -> None:
    path = tmp_path / "reference" / "security-master.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "records": [
                    {
                        "entityId": "issuer:usd-partners",
                        "canonicalTicker": "USD",
                        "entityName": "USD Partners LP",
                        "nameAliases": ["USD Partners LP"],
                        "source": "yahoo-finance",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    resolved = CatalogSecurityMaster.from_state_root(tmp_path).resolve(
        SecurityDescriptor(name="USD Partners LP")
    )

    assert resolved.entity_id == "issuer:usd-partners"
    assert resolved.method == "name"


def test_unresolved_securities_do_not_merge_on_ticker_alone_without_catalog() -> None:
    master = CatalogSecurityMaster(SecurityMasterCatalog())

    first = master.resolve(
        SecurityDescriptor(ticker="ABC", isin="US0000000001", name="Alpha Beta Corp")
    )
    second = master.resolve(
        SecurityDescriptor(ticker="ABC", isin="GB0000000002", name="Another Business Plc")
    )

    assert first.entity_id != second.entity_id
    assert first.method == second.method == "unresolved"


def test_local_catalog_resolves_provider_managed_entity(tmp_path: Path) -> None:
    path = tmp_path / "reference" / "security-master.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "asOf": "2026-08-14",
                "records": [
                    {
                        "entityId": "issuer:alphabet-inc",
                        "canonicalTicker": "GOOGL",
                        "entityName": "Alphabet",
                        "tickerAliases": ["GOOG", "GOOGL"],
                        "source": "licensed-provider",
                        "asOf": "2026-08-14",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    resolved = CatalogSecurityMaster.from_state_root(tmp_path).resolve(
        SecurityDescriptor(ticker="GOOG")
    )

    assert resolved.canonical_ticker == "GOOGL"
    assert resolved.source == "licensed-provider"


def test_private_override_catalog_can_correct_dynamic_identity(tmp_path: Path) -> None:
    path = tmp_path / "reference" / "security-master-overrides.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "records": [
                    {
                        "entityId": "issuer:alphabet",
                        "canonicalTicker": "GOOG",
                        "entityName": "Alphabet Inc",
                        "tickerAliases": ["GOOG", "GOOGL"],
                        "isins": ["US02079K1079", "US02079K3059"],
                        "source": "operator-reviewed",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    master = CatalogSecurityMaster.from_state_root(tmp_path)

    assert master.resolve(SecurityDescriptor(ticker="GOOG")).entity_id == "issuer:alphabet"
    assert master.resolve(SecurityDescriptor(ticker="GOOGL")).entity_id == "issuer:alphabet"


def test_catalog_allows_ambiguous_tickers_but_rejects_conflicting_exact_ids() -> None:
    records = [
        SecurityEntityRecord(
            entity_id="issuer:first",
            canonical_ticker="ABC",
            entity_name="First",
            ticker_aliases=["DUP"],
            isins=["US0000000001"],
            source="test",
        ),
        SecurityEntityRecord(
            entity_id="issuer:second",
            canonical_ticker="XYZ",
            entity_name="Second",
            ticker_aliases=["DUP"],
            isins=["US0000000001"],
            source="test",
        ),
    ]

    with pytest.raises(ValueError, match="security-master conflict for isin"):
        CatalogSecurityMaster(SecurityMasterCatalog(records=records))


def test_catalog_leaves_ambiguous_global_ticker_unresolved() -> None:
    master = CatalogSecurityMaster(
        SecurityMasterCatalog(
            records=[
                SecurityEntityRecord(
                    entity_id="issuer:santander",
                    canonical_ticker="SAN",
                    entity_name="Banco Santander S.A.",
                    ticker_aliases=["SAN"],
                    listings=[
                        {
                            "ticker": "SAN",
                            "exchange": "NYQ",
                            "isin": "US05964H1059",
                            "source": "test",
                        }
                    ],
                    source="test",
                ),
                SecurityEntityRecord(
                    entity_id="issuer:other-san",
                    canonical_ticker="SAN",
                    entity_name="San Holdings Inc.",
                    ticker_aliases=["SAN"],
                    listings=[
                        {
                            "ticker": "SAN",
                            "exchange": "TYO",
                            "isin": "JP0000000001",
                            "source": "test",
                        }
                    ],
                    source="test",
                ),
            ]
        )
    )

    assert master.resolve(SecurityDescriptor(ticker="SAN")).method == "unresolved"
    assert (
        master.resolve(SecurityDescriptor(ticker="SAN", exchange="NYQ")).entity_id
        == "issuer:santander"
    )
    assert (
        master.resolve(SecurityDescriptor(ticker="SAN", name="Banco Santander S.A.")).entity_id
        == "issuer:santander"
    )


class _ProfileProvider:
    def resolve(self, security: SecurityDescriptor) -> MarketSecurityProfile:
        profiles = {
            "US5949181045": (
                "MSFT",
                "Microsoft Corporation",
                "Software - Infrastructure",
                "software-infrastructure",
            ),
            "NL0010273215": (
                "ASML.AS",
                "ASML Holding N.V.",
                "Semiconductor Equipment & Materials",
                "semiconductor-equipment-materials",
            ),
        }
        symbol, name, industry, industry_key = profiles[security.isin]
        return MarketSecurityProfile(
            symbol=symbol,
            name=name,
            country="United States" if symbol == "MSFT" else "Netherlands",
            sector="Technology",
            industry=industry,
            industry_key=industry_key,
            as_of="2026-08-13",
        )


def test_dynamic_enrichment_resolves_isin_and_classifies_profile(tmp_path: Path) -> None:
    report = SecurityMasterEnricher(
        tmp_path,
        provider=_ProfileProvider(),
        target_coverage=1.0,
    ).enrich(
        [
            EnrichmentCandidate(
                security=SecurityDescriptor(
                    isin="US5949181045",
                    name="MICROSOFT CORP",
                ),
                exposure_gbp=800,
            ),
            EnrichmentCandidate(
                security=SecurityDescriptor(
                    isin="NL0010273215",
                    name="ASML HOLDING",
                ),
                exposure_gbp=200,
            ),
        ]
    )

    assert report.classification_coverage_pct == 1.0
    assert report.material_unclassified == []
    master = CatalogSecurityMaster.from_state_root(tmp_path)
    microsoft = master.resolve(SecurityDescriptor(isin="US5949181045"))
    asml = master.resolve(SecurityDescriptor(isin="NL0010273215"))
    assert microsoft.canonical_ticker == "MSFT"
    assert microsoft.gics == classification_for_profile(
        sector="Technology",
        industry="Software - Infrastructure",
        industry_key="software-infrastructure",
        as_of="2026-08-13",
    )
    assert asml.canonical_ticker == "ASML.AS"
    assert asml.gics is not None
    assert asml.gics.sub_industry_code == "45301010"


@pytest.mark.parametrize(
    ("industry", "expected_code"),
    [
        ("Banks—Regional", "40101015"),
        ("Conglomerates", "20105010"),
        ("Gold", "15104030"),
        ("Beverages—Non-Alcoholic", "30201030"),
        ("Utilities—Diversified", "55103010"),
        ("Apparel Retail", "25504010"),
        ("Insurance—Life", "40301020"),
        ("Medical Instruments & Supplies", "35101020"),
        ("Engineering & Construction", "20103010"),
        ("Insurance—Property & Casualty", "40301040"),
        ("Drug Manufacturers—Specialty & Generic", "35202010"),
        ("Oil & Gas Midstream", "10102040"),
        ("Building Products & Equipment", "20102010"),
        ("Insurance—Reinsurance", "40301050"),
        ("Auto Parts", "25101010"),
        ("REIT—Healthcare Facilities", "60105010"),
        ("Grocery Stores", "30101030"),
        ("Trucking", "20304030"),
        ("Copper", "15104025"),
        ("Consulting Services", "20202020"),
        ("Medical Care Facilities", "35102020"),
    ],
)
def test_provider_industries_map_to_current_gics_structure(
    industry: str,
    expected_code: str,
) -> None:
    classification = classification_for_profile(
        sector=None,
        industry=industry,
        as_of="2026-08-13",
    )

    assert classification is not None
    assert classification.version == GICS_VERSION == "2026"
    assert classification.sub_industry_code == expected_code


def test_current_gics_payment_processing_code_is_not_legacy_code() -> None:
    classification = classification_for_code(
        "40201060",
        source="test",
        as_of="2026-08-13",
    )

    assert classification is not None
    assert classification.sub_industry_code == "40201060"
    assert classification.sub_industry_name == "Transaction & Payment Processing Services"


class _CoverageProvider:
    def resolve(self, security: SecurityDescriptor) -> MarketSecurityProfile | None:
        if security.ticker == "MAPPED":
            return MarketSecurityProfile(
                symbol="MAPPED",
                name="Mapped Semiconductor",
                sector="Technology",
                industry="Semiconductors",
                as_of="2026-08-13",
            )
        if security.ticker == "UNMAPPED":
            return MarketSecurityProfile(
                symbol="UNMAPPED",
                name="Resolved But Unmapped",
                sector="Consumer Defensive",
                industry="Imaginary Provider Category",
                as_of="2026-08-13",
            )
        return None


class _RecordingIdentityProvider:
    def __init__(self) -> None:
        self.tickers: list[str] = []

    def resolve_many(
        self,
        securities: Iterable[SecurityDescriptor],
    ) -> dict[str, SecurityIdentity]:
        self.tickers = [security.ticker for security in securities]
        return {}


def test_identity_enrichment_obeys_profile_request_budget(tmp_path: Path) -> None:
    identity_provider = _RecordingIdentityProvider()

    report = SecurityMasterEnricher(
        tmp_path,
        provider=_CoverageProvider(),
        identity_provider=identity_provider,
        max_requests=2,
        target_coverage=1.0,
        max_workers=1,
    ).enrich(
        [
            EnrichmentCandidate(
                security=SecurityDescriptor(ticker="MAPPED", name="Mapped"),
                exposure_gbp=100,
            ),
            EnrichmentCandidate(
                security=SecurityDescriptor(ticker="UNMAPPED", name="Unmapped"),
                exposure_gbp=50,
            ),
            EnrichmentCandidate(
                security=SecurityDescriptor(ticker="DEFERRED", name="Deferred"),
                exposure_gbp=25,
            ),
        ],
        exhaustive=True,
    )

    assert identity_provider.tickers == ["MAPPED", "UNMAPPED"]
    assert report.attempted == 2
    assert report.deferred == 1


def test_enrichment_report_separates_unmapped_unresolved_and_deferred(
    tmp_path: Path,
) -> None:
    report = SecurityMasterEnricher(
        tmp_path,
        provider=_CoverageProvider(),
        max_requests=2,
        target_coverage=1.0,
        max_workers=1,
    ).enrich(
        [
            EnrichmentCandidate(
                security=SecurityDescriptor(ticker="MAPPED", name="Mapped"),
                exposure_gbp=100,
            ),
            EnrichmentCandidate(
                security=SecurityDescriptor(ticker="UNMAPPED", name="Unmapped"),
                exposure_gbp=50,
            ),
            EnrichmentCandidate(
                security=SecurityDescriptor(ticker="DEFERRED", name="Deferred"),
                exposure_gbp=25,
            ),
        ]
    )

    assert report.request_budget == 2
    assert report.attempted == 2
    assert report.deferred == 1
    assert report.classified_exposure_gbp == 100
    assert report.resolved_unclassified_exposure_gbp == 50
    assert report.unresolved_exposure_gbp == 25
    assert report.unexpanded_fund_exposure_gbp == 0
    assert report.gics_eligible_exposure_gbp == 175
    assert report.gics_not_applicable_exposure_gbp == 0
    assert {row["resolutionStatus"] for row in report.material_unclassified} == {
        "profile-unmapped",
        "unresolved",
    }


def test_dynamic_refresh_never_downgrades_official_gics_assignment(
    tmp_path: Path,
) -> None:
    path = tmp_path / "reference" / "security-master.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "records": [
                    {
                        "entityId": "issuer:microsoft",
                        "canonicalTicker": "MSFT",
                        "entityName": "Microsoft Corporation",
                        "tickerAliases": ["MSFT"],
                        "isins": ["US5949181045"],
                        "profileSector": "Technology",
                        "profileIndustry": "Software - Infrastructure",
                        "profileIndustryKey": "software-infrastructure",
                        "gics": {
                            "sectorCode": "45",
                            "sectorName": "Information Technology",
                            "industryGroupCode": "4510",
                            "industryGroupName": "Software & Services",
                            "industryCode": "451030",
                            "industryName": "Software",
                            "subIndustryCode": "45103020",
                            "subIndustryName": "Systems Software",
                            "source": "licensed-provider",
                            "version": "2025",
                            "method": "official",
                            "confidence": 1,
                        },
                        "source": "licensed-provider",
                        "asOf": "2026-08-13",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    report = SecurityMasterEnricher(
        tmp_path,
        provider=_ProfileProvider(),
        target_coverage=1.0,
    ).enrich(
        [
            EnrichmentCandidate(
                security=SecurityDescriptor(
                    isin="US5949181045",
                    name="MICROSOFT CORP",
                ),
                exposure_gbp=100,
            )
        ]
    )

    resolved = CatalogSecurityMaster.from_state_root(tmp_path).resolve(
        SecurityDescriptor(isin="US5949181045")
    )
    assert report.attempted == 0
    assert resolved.gics is not None
    assert resolved.gics.method == "official"
    assert resolved.gics.source == "licensed-provider"


class _ShareClassProvider:
    def resolve(self, security: SecurityDescriptor) -> MarketSecurityProfile:
        return MarketSecurityProfile(
            symbol=security.ticker,
            name=(
                "Alphabet Inc. Class A" if security.ticker == "GOOGL" else "Alphabet Inc. Class C"
            ),
            country="United States",
            sector="Communication Services",
            industry="Internet Content & Information",
            industry_key="internet-content-information",
            as_of="2026-08-13",
        )


def test_dynamic_enrichment_merges_share_classes_without_ticker_seed(
    tmp_path: Path,
) -> None:
    SecurityMasterEnricher(
        tmp_path,
        provider=_ShareClassProvider(),
        target_coverage=1.0,
    ).enrich(
        [
            EnrichmentCandidate(
                security=SecurityDescriptor(
                    ticker="GOOG",
                    isin="US02079K1079",
                    name="Alphabet Inc. Class C",
                ),
                exposure_gbp=60,
            ),
            EnrichmentCandidate(
                security=SecurityDescriptor(
                    ticker="GOOGL",
                    isin="US02079K3059",
                    name="Alphabet Inc. Class A",
                ),
                exposure_gbp=40,
            ),
        ]
    )

    master = CatalogSecurityMaster.from_state_root(tmp_path)
    goog = master.resolve(SecurityDescriptor(isin="US02079K1079"))
    googl = master.resolve(SecurityDescriptor(isin="US02079K3059"))
    assert goog.entity_id == googl.entity_id
    assert goog.gics is not None
    assert goog.gics.sub_industry_code == "50203010"


class _AmbiguousTickerProvider:
    def resolve(self, security: SecurityDescriptor) -> MarketSecurityProfile:
        if security.isin == "US05964H1059":
            return MarketSecurityProfile(
                symbol="SAN",
                name="Banco Santander S.A.",
                exchange="NYQ",
                country="Spain",
                sector="Financial Services",
                industry="Banks - Diversified",
                industry_key="banks-diversified",
                as_of="2026-08-13",
            )
        return MarketSecurityProfile(
            symbol="SAN",
            name="Sanofi",
            exchange="PAR",
            country="France",
            sector="Healthcare",
            industry="Drug Manufacturers - General",
            industry_key="drug-manufacturers-general",
            as_of="2026-08-13",
        )


def test_dynamic_enrichment_keeps_ambiguous_market_tickers_as_distinct_listings(
    tmp_path: Path,
) -> None:
    SecurityMasterEnricher(
        tmp_path,
        provider=_AmbiguousTickerProvider(),
        target_coverage=1.0,
    ).enrich(
        [
            EnrichmentCandidate(
                security=SecurityDescriptor(
                    ticker="SAN",
                    exchange="NYQ",
                    isin="US05964H1059",
                    name="Banco Santander S.A.",
                ),
                exposure_gbp=60,
            ),
            EnrichmentCandidate(
                security=SecurityDescriptor(
                    ticker="SAN",
                    exchange="PAR",
                    isin="FR0000120578",
                    name="Sanofi",
                ),
                exposure_gbp=40,
            ),
        ]
    )

    master = CatalogSecurityMaster.from_state_root(tmp_path)
    santander = master.resolve(SecurityDescriptor(isin="US05964H1059"))
    sanofi = master.resolve(SecurityDescriptor(isin="FR0000120578"))

    assert santander.entity_id != sanofi.entity_id
    assert master.resolve(SecurityDescriptor(ticker="SAN")).method == "unresolved"
    assert (
        master.resolve(SecurityDescriptor(ticker="SAN", exchange="NYQ")).entity_id
        == santander.entity_id
    )
    assert (
        master.resolve(SecurityDescriptor(ticker="SAN", exchange="PAR")).entity_id
        == sanofi.entity_id
    )
