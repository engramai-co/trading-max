from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from trading_max.domain import InstrumentId
from trading_max.research import (
    TaxonomyCatalog,
    TaxonomyTheme,
    TaxonomyWorkflowDecision,
)

from services.api.trading_max_api.classification import (
    classification_for_profile,
)
from services.api.trading_max_api.models import SecuritySearchResult, SnapshotManifest
from services.api.trading_max_api.security_entity_resolution import WebEntityResolution
from services.api.trading_max_api.watchlist import (
    SecuritySearchService,
    WatchlistStore,
    magnificent_seven_securities,
)


class _OpenFigiResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {
            "data": [
                {
                    "figi": "BBG000BPH459",
                    "compositeFIGI": "BBG000BPH459",
                    "name": "MICROSOFT CORP",
                    "ticker": "MSFT",
                    "exchCode": "US",
                    "marketSector": "Equity",
                    "securityType2": "Common Stock",
                }
            ]
        }


class _EmptyOpenFigiResponse(_OpenFigiResponse):
    def json(self) -> dict:
        return {"data": []}


class _ScriptedOpenFigiResponse:
    """Returns an empty OpenFIGI payload unless the corrected name is queried."""

    def __init__(self, corrected: str, payload: dict) -> None:
        self._corrected = corrected
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


def test_new_install_starts_with_empty_dynamic_watchlist(tmp_path: Path) -> None:
    watchlist = WatchlistStore(tmp_path)
    items = watchlist.items()

    assert items == []
    state = watchlist.load()
    assert state.classification_system == "Trading Max LLM taxonomy"
    assert state.classification_level == "Research theme"
    assert state.schema_version == 4
    assert state.research_themes == []
    assert state.categories == []


def test_cached_watchlist_observes_atomic_writes_from_another_store(tmp_path: Path) -> None:
    reader = WatchlistStore(tmp_path)
    assert reader.items() == []
    initial_revision = reader.revision()

    writer = WatchlistStore(tmp_path)
    writer.add(
        SecuritySearchResult(
            ticker="GOOGL",
            name="Alphabet Inc. Class A",
            exchange="NASDAQ",
            bloomberg_ticker="GOOGL US Equity",
            figi="",
            security_type="EQUITY",
            identity_source="test",
        )
    )

    assert [item.ticker for item in reader.items()] == ["GOOGL"]
    assert reader.revision() != initial_revision


def test_first_run_seed_is_atomic_and_never_replaces_user_watchlist(tmp_path: Path) -> None:
    watchlist = WatchlistStore(tmp_path)

    seeded = watchlist.seed_if_empty(magnificent_seven_securities())

    assert [item.ticker for item in seeded] == [
        "AAPL",
        "MSFT",
        "AMZN",
        "GOOGL",
        "META",
        "NVDA",
        "TSLA",
    ]
    assert len(seeded) == 7
    assert watchlist.bootstrap_path.is_file()
    assert (
        watchlist.seed_if_empty(
            [
                SecuritySearchResult(
                    ticker="BE",
                    name="Bloom Energy Corp",
                    exchange="NYSE",
                    bloomberg_ticker="BE US Equity",
                    figi="",
                )
            ]
        )
        == []
    )
    assert [item.ticker for item in watchlist.items()] == [
        "AAPL",
        "MSFT",
        "AMZN",
        "GOOGL",
        "META",
        "NVDA",
        "TSLA",
    ]

    for ticker in list(watchlist.tickers()):
        watchlist.remove(ticker)
    assert watchlist.items() == []
    assert watchlist.seed_if_empty(magnificent_seven_securities()) == []


def test_legacy_theme_state_migrates_to_llm_taxonomy_without_losing_theme(
    tmp_path: Path,
) -> None:
    (tmp_path / "watchlist.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "categories": [
                    {
                        "id": "silicon-ip",
                        "labelZh": "芯片设计与 IP",
                        "labelEn": "Silicon & IP",
                    }
                ],
                "items": [
                    {
                        "ticker": "MRVL",
                        "name": "Marvell Technology Inc",
                        "exchange": "NASDAQ",
                        "bloombergTicker": "MRVL US Equity",
                        "figi": "BBG00ZXBJ153",
                        "categoryId": "silicon-ip",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    item = WatchlistStore(tmp_path).items()[0]

    assert item.category_id == "silicon-ip"
    assert item.research_theme_id == "silicon-ip"
    assert item.gics is None


def test_legacy_new_ideas_migrates_to_unclassified_without_losing_instrument(
    tmp_path: Path,
) -> None:
    (tmp_path / "watchlist.json").write_text(
        json.dumps(
            {
                "schemaVersion": 3,
                "categories": [
                    {
                        "id": "new-ideas",
                        "labelZh": "新想法",
                        "labelEn": "New ideas",
                        "taxonomy": "llm-taxonomy",
                    }
                ],
                "researchThemes": [
                    {
                        "id": "new-ideas",
                        "labelZh": "新想法",
                        "labelEn": "New ideas",
                        "taxonomy": "llm-taxonomy",
                    }
                ],
                "items": [
                    {
                        "ticker": "GOOGL",
                        "name": "Alphabet Inc Class A",
                        "exchange": "NASDAQ",
                        "bloombergTicker": "GOOGL US Equity",
                        "figi": "BBG009S39JX6",
                        "categoryId": "new-ideas",
                        "researchThemeId": "new-ideas",
                        "status": "ready",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    state = WatchlistStore(tmp_path).load()

    assert [item.ticker for item in state.items] == ["GOOGL"]
    item = state.items[0]
    assert item.status == "ready"
    assert item.category_id == ""
    assert item.research_theme_id is None
    assert item.taxonomy_status == "unclassified"
    assert all(category.id != "new-ideas" for category in state.categories)
    assert all(theme.id != "new-ideas" for theme in state.research_themes)


def test_profile_classification_maps_to_gics_sub_industry() -> None:
    classification = classification_for_profile(
        "MSFT",
        "Technology",
        "Software - Infrastructure",
    )

    assert classification is not None
    assert classification.sub_industry_code == "45103020"
    assert classification.sub_industry_name == "Systems Software"


def test_security_search_accepts_company_name_or_ticker(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watchlist = WatchlistStore(tmp_path)
    search = SecuritySearchService(watchlist)
    monkeypatch.setattr(
        "services.api.trading_max_api.watchlist.httpx.post",
        lambda *args, **kwargs: _OpenFigiResponse(),
    )

    result = search.search("Microsoft")

    assert result.source == "openfigi"
    assert result.results[0].ticker == "MSFT"
    assert result.results[0].figi == "BBG000BPH459"
    assert result.results[0].bloomberg_ticker == "MSFT US Equity"


def test_security_search_uses_web_entity_resolution_only_after_empty_provider_search(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watchlist = WatchlistStore(tmp_path)
    requested: list[str] = []

    def openfigi(*args, **kwargs):
        query = kwargs["json"]["query"]
        requested.append(query)
        if query != "GOOGL":
            return _EmptyOpenFigiResponse()
        response = _OpenFigiResponse()
        response.json = lambda: {
            "data": [
                {
                    "figi": "BBG009S39JX6",
                    "compositeFIGI": "BBG009S39JX6",
                    "name": "ALPHABET INC-CL A",
                    "ticker": "GOOGL",
                    "exchCode": "US",
                    "marketSector": "Equity",
                    "securityType2": "Common Stock",
                }
            ]
        }
        return response

    monkeypatch.setattr("services.api.trading_max_api.watchlist.httpx.post", openfigi)
    search = SecuritySearchService(
        watchlist,
        entity_resolver=lambda _: WebEntityResolution(
            company_name="Alphabet Inc.",
            search_queries=("GOOGL",),
        ),
    )

    result = search.search("google")

    assert result.corrected_query == "Alphabet Inc."
    assert [item.ticker for item in result.results] == ["GOOGL"]
    assert requested[0] == "google"
    assert "GOOGL" in requested


def test_security_search_resolves_alphabet_share_classes_to_one_entity(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watchlist = WatchlistStore(tmp_path)
    override_path = tmp_path / "reference" / "security-master-overrides.json"
    override_path.parent.mkdir(parents=True)
    override_path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "records": [
                    {
                        "entityId": "issuer:alphabet-inc",
                        "canonicalTicker": "GOOG",
                        "entityName": "Alphabet Inc.",
                        "tickerAliases": ["GOOG", "GOOGL"],
                        "isins": ["US02079K1079", "US02079K3059"],
                        "source": "operator-reviewed",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    search = SecuritySearchService(watchlist)

    class _AlphabetResponse:
        def raise_for_status(self) -> None:
            return None

        @staticmethod
        def json() -> dict:
            return {
                "data": [
                    {
                        "ticker": "GOOGL",
                        "name": "Alphabet Inc. Class A",
                        "exchCode": "US",
                        "figi": "BBG009S3NB30",
                        "compositeFIGI": "BBG009S3NB30",
                        "shareClassFIGI": "BBG001SQCQC5",
                        "securityType2": "Common Stock",
                    },
                    {
                        "ticker": "GOOG",
                        "name": "Alphabet Inc. Class C",
                        "exchCode": "US",
                        "figi": "BBG009S3NB21",
                        "compositeFIGI": "BBG009S3NB21",
                        "shareClassFIGI": "BBG001SQKGD7",
                        "securityType2": "Common Stock",
                    },
                ]
            }

    monkeypatch.setattr(
        "services.api.trading_max_api.watchlist.httpx.post",
        lambda *args, **kwargs: _AlphabetResponse(),
    )

    result = search.search("Alphabet")

    assert {item.ticker for item in result.results} == {"GOOG", "GOOGL"}
    assert {item.entity_id for item in result.results} == {"issuer:alphabet-inc"}
    assert {item.canonical_ticker for item in result.results} == {"GOOG"}
    assert all(item.gics is None for item in result.results)
    assert all(item.gics.sector_code == "50" for item in result.results if item.gics)


def test_security_search_typo_correction_requeries_with_corrected_name(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watchlist = WatchlistStore(tmp_path)
    index = tmp_path / "us_equities_index.json"
    index.write_text(
        json.dumps(
            [
                {"name": "Palantir Technologies Inc-A", "ticker": "PLTR"},
                {"name": "Apple Inc.", "ticker": "AAPL"},
            ]
        ),
        encoding="utf-8",
    )
    search = SecuritySearchService(watchlist, index_path=index)

    def scripted_post(url, **kwargs):
        query = kwargs["json"]["query"]
        if query.casefold() == "plantir":
            return _EmptyOpenFigiResponse()
        return _ScriptedOpenFigiResponse(
            corrected=query,
            payload={
                "data": [
                    {
                        "figi": "BBG000N7QR55",
                        "compositeFIGI": "BBG000N7QR55",
                        "name": "PALANTIR TECHNOLOGIES INC-A",
                        "ticker": "PLTR",
                        "exchCode": "US",
                        "marketSector": "Equity",
                        "securityType2": "Common Stock",
                    }
                ]
            },
        )

    monkeypatch.setattr(
        "services.api.trading_max_api.watchlist.httpx.post",
        scripted_post,
    )

    result = search.search("plantir")

    assert result.source == "openfigi"
    assert result.corrected_query == "palantir technologies inc-a"
    assert result.results[0].ticker == "PLTR"
    assert result.results[0].figi == "BBG000N7QR55"


def test_security_search_without_index_skips_typo_correction(
    tmp_path: Path,
    monkeypatch,
) -> None:
    watchlist = WatchlistStore(tmp_path)
    search = SecuritySearchService(
        watchlist,
        index_path=tmp_path / "missing-index.json",
    )
    monkeypatch.setattr(
        "services.api.trading_max_api.watchlist.httpx.post",
        lambda *args, **kwargs: _EmptyOpenFigiResponse(),
    )
    monkeypatch.setattr(
        "services.api.trading_max_api.watchlist.httpx.get",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("network unavailable")),
    )

    result = search.search("plantir")

    assert result.source == "openfigi"
    assert result.corrected_query is None
    assert result.results == []


def test_existing_ticker_resolves_without_remote_search(tmp_path: Path) -> None:
    watchlist = WatchlistStore(tmp_path)
    watchlist.add(
        SecuritySearchResult(
            ticker="MRVL",
            name="Marvell Technology Inc",
            exchange="NASDAQ",
            bloomberg_ticker="MRVL US Equity",
            figi="BBG00ZXBJ153",
        )
    )
    result = SecuritySearchService(watchlist).search("MRVL")

    assert result.source == "watchlist"
    assert result.results[0].ticker == "MRVL"
    assert result.results[0].already_watched is True


def test_audited_taxonomy_decision_assigns_without_changing_reference_metadata(
    tmp_path: Path,
) -> None:
    watchlist = WatchlistStore(tmp_path)
    watchlist.add(
        SecuritySearchResult(
            ticker="MSFT",
            name="Microsoft Corp",
            exchange="NASDAQ",
            bloomberg_ticker="MSFT US Equity",
            figi="BBG000BPH459",
        )
    )
    catalog = TaxonomyCatalog(
        taxonomy_version=2,
        themes=[
            TaxonomyTheme(
                id="cloud-software-security",
                label_zh="云软件与安全",
                label_en="Cloud Software & Security",
            )
        ],
    )
    decision = TaxonomyWorkflowDecision(
        decision_id="taxonomy-msft-audited",
        instrument=InstrumentId(
            ticker="MSFT",
            exchange="NASDAQ",
            bloomberg_ticker="MSFT US Equity",
            figi="BBG000BPH459",
        ),
        taxonomy_version=2,
        status="assigned",
        outcome="assign_existing",
        assigned_taxonomy_id="cloud-software-security",
        assigned_label_zh="云软件与安全",
        assigned_label_en="Cloud Software & Security",
        confidence=0.93,
        input_hash="a" * 64,
    )

    watchlist.apply_taxonomy_workflow(decision, catalog)

    state = watchlist.load()
    item = next(item for item in state.items if item.ticker == "MSFT")
    assert item.category_id == "cloud-software-security"
    assert item.research_theme_id == "cloud-software-security"
    assert item.taxonomy_status == "assigned"
    assert item.taxonomy_version == 2
    assert item.taxonomy_decision_id == "taxonomy-msft-audited"
    assert state.categories[0].id == "cloud-software-security"


def test_reconcile_accepts_typed_market_snapshot(tmp_path: Path) -> None:
    class TypedStore:
        def read_json(self, _run_id: str, key: str) -> dict:
            if key == "research/daily_market.json":
                raise FileNotFoundError(key)
            if key == "research/market_snapshot.json":
                return {"technical": {"rows": [{"ticker": "BE", "price": 25}]}}
            if key == "research/technical.json":
                return {"rows": [{"ticker": "BE"}], "warnings": []}
            raise FileNotFoundError(key)

    watchlist = WatchlistStore(tmp_path)
    watchlist.add(
        SecuritySearchResult(
            ticker="BE",
            name="Bloom Energy Corp",
            exchange="NYSE",
            bloomberg_ticker="BE US Equity",
            figi="BBG001BBH6X2",
        )
    )
    manifest = SnapshotManifest(
        run_id="fixture",
        scope="research",
        source="test",
        created_at=datetime.now(UTC),
        artifacts=[],
    )
    watchlist.reconcile(manifest, TypedStore(), ["BE"])

    assert next(item for item in watchlist.items() if item.ticker == "BE").status == "ready"
