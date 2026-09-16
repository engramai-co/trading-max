from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
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
    SecuritySearchError,
    SecuritySearchService,
    WatchlistStore,
    magnificent_seven_securities,
)


@pytest.fixture(autouse=True)
def offline_optional_search_sources(monkeypatch):
    monkeypatch.setattr(SecuritySearchService, "_quote_search", lambda self, query: [])

    def unavailable(*args, **kwargs):
        raise RuntimeError("Synthetic test: SEC unavailable")

    monkeypatch.setattr("services.api.trading_max_api.watchlist.httpx.get", unavailable)


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

    def __init__(self, corrected: str, payload: dict | list) -> None:
        self._corrected = corrected
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict | list:
        return self._payload


def _provider_response(body, rows_for_query):
    if isinstance(body, list):
        payload = [{"data": rows_for_query(job["idValue"])} for job in body]
    else:
        payload = {"data": rows_for_query(body["query"])}
    return _ScriptedOpenFigiResponse("", payload)


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
        def rows(query):
            requested.append(query)
            return [_candidate_row("GOOGL", "ALPHABET INC-CL A")] if query == "GOOGL" else []

        return _provider_response(kwargs["json"], rows)

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


def test_security_search_typo_proposes_a_verified_candidate_without_rewriting_query(
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
        return _provider_response(
            kwargs["json"],
            lambda query: (
                [
                    {
                        **_candidate_row("PLTR", "PALANTIR TECHNOLOGIES INC-A"),
                        "figi": "BBG000N7QR55",
                        "compositeFIGI": "BBG000N7QR55",
                    }
                ]
                if query == "PLTR"
                else []
            ),
        )

    monkeypatch.setattr(
        "services.api.trading_max_api.watchlist.httpx.post",
        scripted_post,
    )

    result = search.search("plantir")

    assert result.source == "openfigi"
    assert result.query == "plantir"
    assert result.corrected_query is None
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
                return {"rows": [{"t": "OLD", "spot": 1}]}
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


def _candidate_row(ticker: str, name: str) -> dict:
    return {
        "ticker": ticker,
        "name": name,
        "figi": f"BBGTEST{ticker}",
        "compositeFIGI": f"BBGTEST{ticker}",
        "exchCode": "US",
        "marketSector": "Equity",
        "securityType2": "Common Stock",
    }


def test_former_company_name_does_not_get_replaced_by_similar_unrelated_company(
    tmp_path, monkeypatch
):
    search = SecuritySearchService(WatchlistStore(tmp_path))
    search._index = (time.monotonic(), [("robostrategy, inc.", "BOT"), ("strategy inc", "MSTR")])
    monkeypatch.setattr(
        search,
        "_quote_search",
        lambda _: [
            {
                "symbol": "MIGA.SG",
                "longname": "MicroStrategy Inc",
                "shortname": "Strategy Inc.",
                "quoteType": "EQUITY",
                "exchange": "STU",
            },
            {
                "symbol": "MIGA.MU",
                "longname": "MicroStrategy Inc",
                "shortname": "Strategy Inc.                 R",
                "quoteType": "EQUITY",
                "exchange": "MUN",
            },
        ],
    )
    requested = []

    def provider(*args, **kwargs):
        def rows(query):
            requested.append(query)
            return [
                _candidate_row("BOT", "ROBOSTRATEGY INC"),
                _candidate_row("MSTR", "STRATEGY INC"),
            ]

        return _provider_response(kwargs["json"], rows)

    monkeypatch.setattr("services.api.trading_max_api.watchlist.httpx.post", provider)
    result = search.search("microstrategy", limit=3)

    assert result.query == "microstrategy"
    assert result.corrected_query is None
    assert [item.ticker for item in result.results] == ["MSTR"]
    assert requested == ["MSTR"]


def test_multiple_fuzzy_candidates_are_independently_verified(tmp_path, monkeypatch):
    search = SecuritySearchService(WatchlistStore(tmp_path))
    entries = [("Northstar Inc", "NSTR"), ("Northstart Corp", "NSTT"), ("Northstars Ltd", "NSTS")]
    search._index = (time.monotonic(), entries)
    rows = [_candidate_row(ticker, name) for name, ticker in entries]

    calls = []

    def provider(url, **kwargs):
        calls.append((url, kwargs["json"]))
        return _provider_response(
            kwargs["json"], lambda query: [*rows, _candidate_row("NSTRX", "Northstar Inc")]
        )

    monkeypatch.setattr("services.api.trading_max_api.watchlist.httpx.post", provider)
    result = search.search("northstr", limit=3)
    assert len(result.results) == 3
    assert result.results[0].ticker == "NSTR"
    assert {item.ticker for item in result.results} == {"NSTR", "NSTT", "NSTS"}
    assert result.corrected_query is None
    assert len(calls) == 1
    assert calls[0][0].endswith("/v3/mapping")
    assert len(calls[0][1]) == 3


def test_unverified_alias_is_not_presented_as_a_match(tmp_path, monkeypatch):
    search = SecuritySearchService(WatchlistStore(tmp_path))
    search._index = (time.monotonic(), [])
    monkeypatch.setattr(
        search,
        "_quote_search",
        lambda _: [
            {"symbol": "NEW", "longname": "Newbrand Inc", "quoteType": "EQUITY", "exchange": "NMS"},
        ],
    )

    def provider(*args, **kwargs):
        return _provider_response(
            kwargs["json"],
            lambda query: (
                []
                if query == "oldbrand"
                else [
                    _candidate_row("NEW", "Different Company Inc"),
                    _candidate_row("NEWX", "Newbrand Inc"),
                ]
            ),
        )

    monkeypatch.setattr("services.api.trading_max_api.watchlist.httpx.post", provider)
    assert search.search("oldbrand").results == []


def test_search_cache_respects_limit_query_text_and_current_watchlist(tmp_path, monkeypatch):
    store = WatchlistStore(tmp_path)
    search = SecuritySearchService(store)
    rows = [
        _candidate_row(ticker, name)
        for name, ticker in [
            ("Northstar Inc", "NSTR"),
            ("Northstart Corp", "NSTT"),
            ("Northstars Ltd", "NSTS"),
        ]
    ]
    calls = []

    def provider(*args, **kwargs):
        calls.append(kwargs["json"]["query"])
        return _ScriptedOpenFigiResponse("north", {"data": rows})

    monkeypatch.setattr("services.api.trading_max_api.watchlist.httpx.post", provider)
    first = search.search("north", limit=1)
    assert len(first.results) == 1
    store.add(first.results[0])
    second = search.search("NORTH", limit=3)
    assert second.query == "NORTH"
    assert len(second.results) == 3
    assert second.results[0].already_watched
    assert not second.results[1].already_watched
    store.remove(first.results[0].ticker)
    assert not search.search("north", limit=1).results[0].already_watched
    assert calls == ["north"]


@pytest.mark.parametrize("available", [True, False])
def test_stale_equity_index_refresh_uses_wall_clock_and_keeps_offline_fallback(
    tmp_path, monkeypatch, available
):
    search = SecuritySearchService(WatchlistStore(tmp_path), index_ttl=3600)
    search.index_path.write_text(json.dumps([{"name": "Oldbrand Inc", "ticker": "NEW"}]))
    stale_time = time.time() - 7200
    os.utime(search.index_path, (stale_time, stale_time))
    calls = []

    def provider(*args, **kwargs):
        calls.append(args[0])
        if not available:
            raise RuntimeError("Synthetic unavailable provider")
        return _ScriptedOpenFigiResponse("", {"0": {"title": "Newbrand Inc", "ticker": "NEW"}})

    monkeypatch.setattr("services.api.trading_max_api.watchlist.httpx.get", provider)
    entries = search._load_equity_index()
    assert entries == [("newbrand inc" if available else "oldbrand inc", "NEW")]
    assert len(calls) == 1
    assert search._load_equity_index() == entries
    assert len(calls) == 1


def test_mapping_rate_limit_is_retryable_and_not_cached_as_no_match(tmp_path, monkeypatch):
    search = SecuritySearchService(WatchlistStore(tmp_path))
    search._index = (time.monotonic(), [("Northstar Inc", "NSTR")])

    def limited(*args, **kwargs):
        request = httpx.Request("POST", args[0])
        return httpx.Response(429, request=request)

    monkeypatch.setattr("services.api.trading_max_api.watchlist.httpx.post", limited)
    with pytest.raises(SecuritySearchError):
        search.search("northstr")
    assert "northstr" not in search._cache
    monkeypatch.setattr(
        "services.api.trading_max_api.watchlist.httpx.post",
        lambda *args, **kwargs: _provider_response(
            kwargs["json"], lambda query: [_candidate_row("NSTR", "Northstar Inc")]
        ),
    )
    assert search.search("northstr").results[0].ticker == "NSTR"


def test_provider_brand_name_preserves_separate_share_classes(tmp_path, monkeypatch):
    search = SecuritySearchService(WatchlistStore(tmp_path))
    search._index = (time.monotonic(), [("Newbrand Inc", "NEWA"), ("Newbrand Inc", "NEWB")])
    monkeypatch.setattr(
        search,
        "_quote_search",
        lambda _: [
            {
                "symbol": "NEWA",
                "longname": "Newbrand Inc",
                "quoteType": "EQUITY",
                "exchange": "NMS",
            },
        ],
    )
    monkeypatch.setattr(
        "services.api.trading_max_api.watchlist.httpx.post",
        lambda *args, **kwargs: _provider_response(
            kwargs["json"],
            lambda query: [
                _candidate_row(
                    query, "Newbrand Inc-CL A" if query == "NEWA" else "Newbrand Inc-CL B"
                )
            ],
        ),
    )
    assert {item.ticker for item in search.search("oldbrand").results} == {"NEWA", "NEWB"}
