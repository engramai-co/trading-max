"""Resolve, persist, classify, and refresh the local research watchlist."""

from __future__ import annotations

import difflib
import json
import os
import re
import tempfile
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

import httpx
from trading_max.reference import (
    CatalogSecurityMaster,
    SecurityDescriptor,
    infer_gics_eligibility,
)
from trading_max.research import TaxonomyCatalog, TaxonomyWorkflowDecision

from .artifacts import ArtifactStore
from .models import (
    GicsClassification,
    SecuritySearchResponse,
    SecuritySearchResult,
    SnapshotManifest,
    WatchlistCategory,
    WatchlistItem,
    WatchlistState,
)

if TYPE_CHECKING:
    from .security_entity_resolution import WebEntityResolution

OPENFIGI_SEARCH_URL = "https://api.openfigi.com/v3/search"
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
EQUITY_INDEX_CACHE_TTL_SECONDS = 7 * 24 * 3600
TICKER_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9.-]{0,14}$")


def magnificent_seven_securities() -> list[SecuritySearchResult]:
    """Return the default research universe for an ETF-only portfolio.

    FIGIs are intentionally left empty.  They are provider-owned identifiers
    and are enriched by the security-master pipeline rather than embedded as
    an opaque application seed.  ``WatchlistStore`` still deduplicates these
    entries by canonical ticker.
    """

    return [
        SecuritySearchResult(
            ticker=ticker,
            name=name,
            exchange=exchange,
            bloomberg_ticker=f"{ticker} US Equity",
            figi="",
            security_type="EQUITY",
            identity_source="default-watchlist",
        )
        for ticker, name, exchange in (
            ("AAPL", "Apple Inc.", "NASDAQ"),
            ("MSFT", "Microsoft Corporation", "NASDAQ"),
            ("AMZN", "Amazon.com, Inc.", "NASDAQ"),
            ("GOOGL", "Alphabet Inc. Class A", "NASDAQ"),
            ("META", "Meta Platforms, Inc.", "NASDAQ"),
            ("NVDA", "NVIDIA Corporation", "NASDAQ"),
            ("TSLA", "Tesla, Inc.", "NASDAQ"),
        )
    ]


class SecuritySearchError(RuntimeError):
    pass


def _canonical_ticker(value: str) -> str:
    ticker = value.strip().upper()
    return ticker[:-2] if ticker.endswith(".L") else ticker


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                indent=2,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


def _atomic_state(path: Path, state: WatchlistState) -> None:
    _atomic_json(path, state.model_dump(mode="json", by_alias=True))


class WatchlistStore:
    def __init__(self, data_root: Path) -> None:
        self.path = data_root / "watchlist.json"
        self.bootstrap_path = data_root / "watchlist-bootstrap.json"
        self.reference_paths = (
            data_root / "reference" / "security-master.json",
            data_root / "reference" / "security-master-overrides.json",
        )
        self._lock = threading.RLock()
        self._cache_signature: tuple[tuple[int, int, int] | None, ...] | None = None
        self._cache: WatchlistState | None = None
        self.ensure()

    @staticmethod
    def _path_signature(path: Path) -> tuple[int, int, int] | None:
        try:
            stat = path.stat()
        except FileNotFoundError:
            return None
        return (stat.st_ino, stat.st_mtime_ns, stat.st_size)

    def _state_signature(self) -> tuple[tuple[int, int, int] | None, ...]:
        return (
            self._path_signature(self.path),
            *(self._path_signature(path) for path in self.reference_paths),
        )

    def _remember(self, state: WatchlistState) -> None:
        self._cache = state.model_copy(deep=True)
        self._cache_signature = self._state_signature()

    def revision(self) -> str:
        """Return a cheap cross-process cache key for the effective watchlist."""

        self.load()
        return ":".join(
            "missing" if signature is None else ",".join(map(str, signature))
            for signature in self._state_signature()
        )

    def _bootstrap_completed(self) -> bool:
        return self.bootstrap_path.is_file()

    def _mark_bootstrap_completed(self, source: str) -> None:
        if self._bootstrap_completed():
            return
        _atomic_json(
            self.bootstrap_path,
            {
                "schemaVersion": 1,
                "completedAt": datetime.now(UTC).isoformat(),
                "source": source,
            },
        )

    @staticmethod
    def _initial_state() -> WatchlistState:
        return WatchlistState(
            schema_version=4,
            classification_system="Trading Max LLM taxonomy",
            classification_level="Research theme",
            categories=[],
            research_themes=[],
            items=[],
        )

    @staticmethod
    def _use_llm_taxonomy(state: WatchlistState) -> None:
        """Make the Trading Max research taxonomy the active grouping.

        GICS remains attached to each instrument as reference metadata, but it
        is no longer allowed to drive the watchlist UI or persistence model.
        Pending classification is workflow state, not a semantic category.
        """

        themes = [
            theme
            for theme in (state.research_themes or state.categories)
            if theme.id != "new-ideas"
        ]
        theme_ids = {theme.id for theme in themes}
        state.categories = [
            theme.model_copy(update={"taxonomy": "llm-taxonomy"}) for theme in themes
        ]
        state.categories.sort(key=lambda category: (category.order, category.id))
        for index, category in enumerate(state.categories, start=1):
            category.order = index
        for item in state.items:
            theme_id = item.research_theme_id
            if theme_id not in theme_ids:
                theme_id = None
            if theme_id is not None:
                item.research_theme_id = theme_id
                item.category_id = theme_id
                item.taxonomy_status = "assigned"
                theme = next(theme for theme in themes if theme.id == theme_id)
                item.taxonomy_label_zh = theme.label_zh
                item.taxonomy_label_en = theme.label_en
            else:
                item.research_theme_id = None
                item.category_id = ""
                if item.taxonomy_status == "assigned":
                    item.taxonomy_status = "unclassified"
                item.taxonomy_label_zh = None
                item.taxonomy_label_en = None
        state.classification_system = "Trading Max LLM taxonomy"
        state.classification_level = "Research theme"
        state.research_themes = [theme.model_copy() for theme in state.categories]
        state.schema_version = 4

    def _migrate(self, state: WatchlistState) -> bool:
        if state.schema_version >= 4:
            before = state.model_dump(mode="json", by_alias=True)
            self._use_llm_taxonomy(state)
            return before != state.model_dump(mode="json", by_alias=True)

        themes = [
            theme
            for theme in (state.research_themes or state.categories)
            if theme.id != "new-ideas"
        ]
        theme_ids = {category.id for category in themes}
        for item in state.items:
            theme_id = item.research_theme_id
            if theme_id not in theme_ids and item.category_id in theme_ids:
                theme_id = item.category_id
            if theme_id not in theme_ids:
                theme_id = None
            item.research_theme_id = theme_id
            item.category_id = theme_id or ""
            item.taxonomy_status = "assigned" if theme_id else "unclassified"

        state.research_themes = themes
        state.categories = [
            category.model_copy(update={"taxonomy": "llm-taxonomy"}) for category in themes
        ]
        state.classification_system = "Trading Max LLM taxonomy"
        state.classification_level = "Research theme"
        state.schema_version = 4
        return True

    def _sync_reference_metadata(self, state: WatchlistState) -> bool:
        """Consume the durable security master; never publish into it."""

        master = CatalogSecurityMaster.from_state_root(self.path.parent)
        changed = False
        for item in state.items:
            resolved = master.resolve(
                SecurityDescriptor(
                    ticker=item.ticker,
                    name=item.name,
                    figi=item.figi,
                    composite_figi=item.composite_figi,
                    share_class_figi=item.share_class_figi,
                )
            )
            gics = (
                GicsClassification.model_validate(
                    resolved.gics.model_dump(mode="json", by_alias=True)
                )
                if resolved.gics is not None
                else None
            )
            if item.gics != gics:
                item.gics = gics
                changed = True
        return changed

    def ensure(self) -> WatchlistState:
        with self._lock:
            if self.path.is_file():
                return self.load()
            state = self._initial_state()
            _atomic_state(self.path, state)
            self._remember(state)
            return state

    def load(self) -> WatchlistState:
        with self._lock:
            if not self.path.is_file():
                return self.ensure()
            signature = self._state_signature()
            if self._cache is not None and self._cache_signature == signature:
                return self._cache.model_copy(deep=True)
            state = WatchlistState.model_validate_json(self.path.read_text(encoding="utf-8"))
            migrated = self._migrate(state)
            reference_updated = self._sync_reference_metadata(state)
            if migrated or reference_updated:
                state.updated_at = datetime.now(UTC)
                _atomic_state(self.path, state)
            if state.items:
                self._mark_bootstrap_completed("existing-watchlist")
            self._remember(state)
            return state

    def save(self, state: WatchlistState) -> WatchlistState:
        with self._lock:
            state.updated_at = datetime.now(UTC)
            _atomic_state(self.path, state)
            self._remember(state)
            return state

    def categories(self) -> list[WatchlistCategory]:
        return sorted(self.load().categories, key=lambda item: (item.order, item.id))

    def items(self) -> list[WatchlistItem]:
        state = self.load()
        category_order = {item.id: item.order for item in state.categories}
        return sorted(
            state.items,
            key=lambda item: (
                category_order.get(item.category_id, 10_000),
                item.order,
                item.ticker,
            ),
        )

    def tickers(self) -> list[str]:
        return [item.ticker for item in self.items()]

    def add(
        self,
        security: SecuritySearchResult,
        category_id: str = "",
    ) -> WatchlistItem:
        ticker = _canonical_ticker(security.ticker)
        if not TICKER_PATTERN.fullmatch(ticker):
            raise ValueError(f"invalid ticker: {security.ticker}")
        with self._lock:
            state = self.load()
            existing = next(
                (
                    item
                    for item in state.items
                    if item.ticker == ticker or (bool(security.figi) and item.figi == security.figi)
                ),
                None,
            )
            if existing is not None:
                return existing
            category_ids = {category.id for category in state.categories}
            selected_category = category_id if category_id in category_ids else ""
            category_items = [item for item in state.items if item.category_id == selected_category]
            now = datetime.now(UTC)
            item = WatchlistItem(
                ticker=ticker,
                name=security.name.strip() or ticker,
                exchange=security.exchange.strip() or "US",
                bloomberg_ticker=(security.bloomberg_ticker.strip() or f"{ticker} US Equity"),
                figi=security.figi.strip(),
                composite_figi=security.composite_figi.strip(),
                share_class_figi=security.share_class_figi.strip(),
                gics=security.gics,
                category_id=selected_category,
                research_theme_id=selected_category or None,
                taxonomy_status="assigned" if selected_category else "classifying",
                order=max((entry.order for entry in category_items), default=0) + 1,
                status="pending",
                added_at=now,
                updated_at=now,
            )
            state.items.append(item)
            self.save(state)
            self._mark_bootstrap_completed("manual-add")
            return item

    def seed_if_empty(
        self,
        securities: list[SecuritySearchResult],
        category_id: str = "",
    ) -> list[WatchlistItem]:
        """Atomically seed a first-run watchlist without replacing user state.

        This method is deliberately a no-op as soon as one item exists.  It is
        therefore safe to call during every research-job admission while
        preserving manual additions, removals, ordering, and taxonomy choices.
        """

        with self._lock:
            state = self.load()
            if state.items or self._bootstrap_completed():
                return []

            category_ids = {category.id for category in state.categories}
            selected_category = category_id if category_id in category_ids else ""
            now = datetime.now(UTC)
            seeded: list[WatchlistItem] = []
            seen_tickers: set[str] = set()
            seen_figis: set[str] = set()
            for security in securities:
                ticker = _canonical_ticker(security.ticker)
                if not TICKER_PATTERN.fullmatch(ticker):
                    raise ValueError(f"invalid ticker: {security.ticker}")
                figi = security.figi.strip()
                if ticker in seen_tickers or (figi and figi in seen_figis):
                    continue
                seen_tickers.add(ticker)
                if figi:
                    seen_figis.add(figi)
                seeded.append(
                    WatchlistItem(
                        ticker=ticker,
                        name=security.name.strip() or ticker,
                        exchange=security.exchange.strip() or "US",
                        bloomberg_ticker=(
                            security.bloomberg_ticker.strip() or f"{ticker} US Equity"
                        ),
                        figi=figi,
                        composite_figi=security.composite_figi.strip(),
                        share_class_figi=security.share_class_figi.strip(),
                        gics=security.gics,
                        category_id=selected_category,
                        research_theme_id=selected_category or None,
                        taxonomy_status="assigned" if selected_category else "classifying",
                        order=len(seeded) + 1,
                        status="pending",
                        added_at=now,
                        updated_at=now,
                    )
                )

            if seeded:
                state.items.extend(seeded)
                self.save(state)
                self._mark_bootstrap_completed("automatic-first-run")
            return seeded

    def remove(self, ticker: str) -> WatchlistItem:
        canonical = _canonical_ticker(ticker)
        with self._lock:
            state = self.load()
            item = next(
                (entry for entry in state.items if entry.ticker == canonical),
                None,
            )
            if item is None:
                raise KeyError(f"watchlist ticker not found: {canonical}")
            state.items = [entry for entry in state.items if entry.ticker != canonical]
            self.save(state)
            return item

    def move(self, ticker: str, category_id: str) -> WatchlistItem:
        canonical = _canonical_ticker(ticker)
        with self._lock:
            state = self.load()
            if category_id not in {category.id for category in state.categories}:
                raise ValueError(f"unknown watchlist category: {category_id}")
            item = next(
                (entry for entry in state.items if entry.ticker == canonical),
                None,
            )
            if item is None:
                raise KeyError(f"watchlist ticker not found: {canonical}")
            category_items = [
                entry
                for entry in state.items
                if entry.category_id == category_id and entry.ticker != canonical
            ]
            item.category_id = category_id
            item.research_theme_id = category_id
            item.taxonomy_status = "assigned"
            category = next(entry for entry in state.categories if entry.id == category_id)
            item.taxonomy_label_zh = category.label_zh
            item.taxonomy_label_en = category.label_en
            item.order = (
                max(
                    (entry.order for entry in category_items),
                    default=0,
                )
                + 1
            )
            item.updated_at = datetime.now(UTC)
            self.save(state)
            return item

    def set_status(
        self,
        tickers: list[str],
        status: str,
        *,
        last_run_id: str | None = None,
        error: str | None = None,
    ) -> None:
        selected = {_canonical_ticker(ticker) for ticker in tickers}
        if not selected:
            return
        with self._lock:
            state = self.load()
            now = datetime.now(UTC)
            changed = False
            for item in state.items:
                if item.ticker not in selected:
                    continue
                item.status = status  # type: ignore[assignment]
                item.updated_at = now
                item.last_run_id = last_run_id or item.last_run_id
                item.last_error = error
                changed = True
            if changed:
                self.save(state)

    def apply_taxonomy_workflow(
        self,
        decision: TaxonomyWorkflowDecision,
        catalog: TaxonomyCatalog,
    ) -> None:
        """Apply one audited workflow decision without changing GICS metadata."""

        ticker = _canonical_ticker(decision.instrument.ticker)
        with self._lock:
            state = self.load()
            item = next((entry for entry in state.items if entry.ticker == ticker), None)
            if item is None:
                return
            state.categories = [
                WatchlistCategory(
                    id=theme.id,
                    label_zh=theme.label_zh,
                    label_en=theme.label_en,
                    description_zh=theme.description_zh,
                    description_en=theme.description_en,
                    order=theme.order,
                    taxonomy="llm-taxonomy",
                )
                for theme in catalog.themes
                if theme.id != "new-ideas"
            ]
            state.categories.sort(key=lambda category: (category.order, category.id))
            state.research_themes = [category.model_copy() for category in state.categories]
            item.taxonomy_status = decision.status
            # A no-provider decision is an auditable absence, not a completed
            # judgment at the current taxonomy version. Keeping its version unset
            # lets a later configured provider retry exactly once against the
            # current catalog without inventing a special queue category.
            item.taxonomy_version = (
                None
                if decision.status != "assigned"
                and decision.provider == "deterministic"
                and not decision.judgments
                else catalog.taxonomy_version
            )
            item.taxonomy_decision_id = decision.decision_id
            item.updated_at = datetime.now(UTC)
            if decision.status == "assigned" and decision.assigned_taxonomy_id:
                theme = next(
                    (
                        entry
                        for entry in state.categories
                        if entry.id == decision.assigned_taxonomy_id
                    ),
                    None,
                )
                if theme is None:
                    item.taxonomy_status = "needs-review"
                    item.research_theme_id = None
                    item.category_id = ""
                    item.taxonomy_label_zh = None
                    item.taxonomy_label_en = None
                else:
                    item.research_theme_id = theme.id
                    item.category_id = theme.id
                    item.taxonomy_label_zh = theme.label_zh
                    item.taxonomy_label_en = theme.label_en
                    item.order = (
                        max(
                            (
                                entry.order
                                for entry in state.items
                                if entry.ticker != ticker and entry.category_id == theme.id
                            ),
                            default=0,
                        )
                        + 1
                    )
            else:
                item.research_theme_id = None
                item.category_id = ""
                item.taxonomy_label_zh = None
                item.taxonomy_label_en = None
            state.schema_version = 4
            self.save(state)

    def reconcile(
        self,
        manifest: SnapshotManifest,
        store: ArtifactStore,
        tickers: list[str],
    ) -> None:
        selected = {_canonical_ticker(ticker) for ticker in tickers}
        try:
            market = store.read_json(
                manifest.run_id,
                "research/market_snapshot.json",
            )
        except FileNotFoundError:
            market = {}
        if not market:
            try:
                market = store.read_json(manifest.run_id, "research/daily_market.json")
            except FileNotFoundError:
                market = {}
        try:
            technical = store.read_json(manifest.run_id, "research/technical.json")
        except FileNotFoundError:
            technical = {}
        typed_technical = market.get("technical")
        if isinstance(typed_technical, dict):
            market_rows = {
                _canonical_ticker(str(row.get("ticker") or "")): row
                for row in typed_technical.get("rows", [])
                if isinstance(row, dict)
            }
        else:
            market_rows = {
                _canonical_ticker(str(row.get("t") or row.get("ticker") or "")): row
                for row in market.get("rows", [])
                if isinstance(row, dict)
            }
        market_tickers = set(market_rows)
        technical_tickers = {
            _canonical_ticker(str(row.get("ticker") or row.get("t") or ""))
            for row in technical.get("rows", [])
            if isinstance(row, dict)
        }
        failures = technical.get("failures", {})
        with self._lock:
            state = self.load()
            now = datetime.now(UTC)
            changed = False
            for item in state.items:
                if item.ticker not in selected:
                    continue
                has_market = item.ticker in market_tickers
                has_technical = item.ticker in technical_tickers
                if item.research_theme_id not in {category.id for category in state.categories}:
                    item.research_theme_id = None
                item.category_id = item.research_theme_id or ""
                if has_market and has_technical:
                    item.status = "ready"
                    item.last_error = None
                elif has_market or has_technical:
                    item.status = "partial"
                    item.last_error = (
                        str(failures.get(item.ticker))
                        if isinstance(failures, dict) and failures.get(item.ticker)
                        else None
                    )
                else:
                    item.status = "failed"
                    item.last_error = (
                        str(failures.get(item.ticker))
                        if isinstance(failures, dict) and failures.get(item.ticker)
                        else "Research completed without a usable market or technical row"
                    )
                item.updated_at = now
                item.last_run_id = manifest.run_id
                changed = True
            if changed:
                self.save(state)


class SecuritySearchService:
    def __init__(
        self,
        watchlist: WatchlistStore,
        *,
        timeout: float = 10.0,
        cache_ttl: float = 600.0,
        index_path: Path | None = None,
        index_ttl: float = EQUITY_INDEX_CACHE_TTL_SECONDS,
        security_master: CatalogSecurityMaster | None = None,
        entity_resolver: Callable[[str], WebEntityResolution | None] | None = None,
    ) -> None:
        self.watchlist = watchlist
        self.timeout = timeout
        self.cache_ttl = cache_ttl
        self.index_path = index_path or watchlist.path.parent / "us_equities_index.json"
        self.index_ttl = index_ttl
        self.security_master = security_master or CatalogSecurityMaster.from_state_root(
            watchlist.path.parent
        )
        self.entity_resolver = entity_resolver
        self._cache: dict[str, tuple[float, SecuritySearchResponse]] = {}
        self._lock = threading.Lock()
        self._index: tuple[float, list[tuple[str, str]]] | None = None

    def _existing_result(
        self,
        item: WatchlistItem,
    ) -> SecuritySearchResult:
        return self._enrich_result(
            SecuritySearchResult(
                ticker=item.ticker,
                name=item.name,
                exchange=item.exchange,
                bloomberg_ticker=item.bloomberg_ticker,
                figi=item.figi,
                composite_figi=item.composite_figi,
                share_class_figi=item.share_class_figi,
                already_watched=True,
            )
        )

    def _enrich_result(self, result: SecuritySearchResult) -> SecuritySearchResult:
        # A refresh can update the catalog without restarting the API process.
        self.security_master = CatalogSecurityMaster.from_state_root(self.watchlist.path.parent)
        resolved = self.security_master.resolve(
            SecurityDescriptor(
                ticker=result.ticker,
                name=result.name,
                figi=result.figi,
                composite_figi=result.composite_figi,
                share_class_figi=result.share_class_figi,
            )
        )
        return result.model_copy(
            update={
                "entity_id": resolved.entity_id,
                "canonical_ticker": resolved.canonical_ticker,
                "gics": (
                    GicsClassification.model_validate(
                        resolved.gics.model_dump(mode="json", by_alias=True)
                    )
                    if resolved.gics is not None
                    else None
                ),
                "resolution_method": resolved.method,
                "resolution_confidence": resolved.confidence,
                "identity_source": resolved.source,
            }
        )

    def _load_equity_index(self) -> list[tuple[str, str]]:
        """Return [(name, ticker)] for US common equities, cached on disk.

        The SEC company tickers file is a plain public dataset; it is fetched
        lazily so the first typo-tolerant search can still work without any
        bundled data, and refreshed weekly.
        """
        cached = self._index
        if cached is not None and time.monotonic() - cached[0] < self.index_ttl:
            return cached[1]
        try:
            if self.index_path.exists():
                age = time.monotonic() - self.index_path.stat().st_mtime
                if age < self.index_ttl:
                    payload = json.loads(self.index_path.read_text(encoding="utf-8"))
                    entries = [
                        (str(item.get("name") or "").casefold(), str(item.get("ticker") or ""))
                        for item in payload
                        if isinstance(item, dict) and item.get("ticker") and item.get("name")
                    ]
                    self._index = (time.monotonic(), entries)
                    return entries
            response = httpx.get(
                SEC_TICKERS_URL,
                headers={
                    "User-Agent": "Trading Max research contact@engramai.co",
                    "Accept-Encoding": "gzip",
                },
                timeout=self.timeout,
            )
            response.raise_for_status()
            rows = response.json()
            entries: list[tuple[str, str]] = []
            for value in rows.values():
                if not isinstance(value, dict):
                    continue
                name = str(value.get("title") or "").strip()
                ticker = str(value.get("ticker") or "").strip().upper()
                if not name or not TICKER_PATTERN.fullmatch(ticker):
                    continue
                entries.append((name.casefold(), ticker))
            entries.sort(key=lambda item: item[0])
            payload = [{"name": name, "ticker": ticker} for name, ticker in entries]
            self.index_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.index_path.with_suffix(".json.tmp")
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            temporary.replace(self.index_path)
            self._index = (time.monotonic(), entries)
            return entries
        except Exception:
            # A missing index only disables typo correction; normal search
            # still works, so failures here are deliberately non-fatal.
            self._index = (time.monotonic(), [])
            return []

    def _openfigi_results(self, normalized: str, limit: int) -> list[SecuritySearchResult]:
        """Run one OpenFIGI search and normalise its rows."""
        try:
            response = httpx.post(
                OPENFIGI_SEARCH_URL,
                json={
                    "query": normalized,
                    "exchCode": "US",
                    "marketSecDes": "Equity",
                },
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "User-Agent": "Trading Max-Portfolio/0.1",
                },
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise SecuritySearchError(f"OpenFIGI search failed: {exc}") from exc

        watched = {item.ticker: item for item in self.watchlist.items()}
        watched_figis = {item.figi for item in self.watchlist.items()}
        results: list[SecuritySearchResult] = []
        seen: set[str] = set()
        for raw in payload.get("data", []):
            if not isinstance(raw, dict):
                continue
            ticker = _canonical_ticker(str(raw.get("ticker") or ""))
            figi = str(raw.get("compositeFIGI") or raw.get("figi") or "")
            composite_figi = str(raw.get("compositeFIGI") or "")
            share_class_figi = str(raw.get("shareClassFIGI") or "")
            provider_security_type = str(raw.get("securityType") or "")
            security_type = str(raw.get("securityType2") or "")
            if (
                not ticker
                or not figi
                or not TICKER_PATTERN.fullmatch(ticker)
                or infer_gics_eligibility(
                    provider_security_type=provider_security_type,
                    provider_security_type2=security_type,
                    market_sector=str(raw.get("marketSector") or "Equity"),
                )
                == "not-applicable"
                or figi in seen
            ):
                continue
            seen.add(figi)
            existing = watched.get(ticker)
            results.append(
                self._enrich_result(
                    SecuritySearchResult(
                        ticker=ticker,
                        name=str(raw.get("name") or ticker).strip(),
                        exchange=str(raw.get("exchCode") or "US"),
                        bloomberg_ticker=f"{ticker} US Equity",
                        figi=figi,
                        composite_figi=composite_figi,
                        share_class_figi=share_class_figi,
                        security_type=security_type,
                        already_watched=bool(existing or figi in watched_figis),
                    )
                )
            )
        results.sort(
            key=lambda item: (
                item.ticker.casefold() != normalized.casefold(),
                not item.name.casefold().startswith(normalized.casefold()),
                item.ticker,
            )
        )
        return results

    def _typo_corrected_results(
        self,
        normalized: str,
        limit: int,
    ) -> tuple[str, list[SecuritySearchResult]] | None:
        """Find a close company-name match and re-query with the corrected name."""
        entries = self._load_equity_index()
        if not entries:
            return None
        query = normalized.casefold()
        if len(query) < 3:
            return None
        # Full legal names dilute the similarity score, so also index the first
        # word (the brand name). A typo like "plantir" then matches "palantir"
        # instead of losing to the "technologies inc" suffix.
        keys: list[tuple[str, str]] = []
        seen_keys: set[str] = set()
        for name, _ in entries:
            for key in {name, name.split()[0] if name.split() else name}:
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                keys.append((key, name))
        key_names = [key for key, _ in keys]
        matches = difflib.get_close_matches(query, key_names, n=3, cutoff=0.72)
        if not matches:
            return None
        key_to_name = dict(keys)
        corrected_key = matches[0]
        corrected = key_to_name[corrected_key]
        if corrected == query:
            return None
        results = self._openfigi_results(corrected, limit)
        if not results:
            return None
        return corrected, results

    def search(self, query: str, limit: int = 8) -> SecuritySearchResponse:
        normalized = " ".join(query.strip().split())
        if len(normalized) < 2:
            return SecuritySearchResponse(
                query=normalized,
                source="watchlist",
                results=[],
            )
        cache_key = normalized.casefold()
        with self._lock:
            cached = self._cache.get(cache_key)
            if cached and time.monotonic() - cached[0] < self.cache_ttl:
                return cached[1]

        local = [
            self._existing_result(item)
            for item in self.watchlist.items()
            if cache_key in item.ticker.casefold()
            or cache_key in item.name.casefold()
            or cache_key in item.bloomberg_ticker.casefold()
            or cache_key in item.figi.casefold()
        ]
        exact_local = [item for item in local if item.ticker.casefold() == cache_key]
        if exact_local:
            response = SecuritySearchResponse(
                query=normalized,
                source="watchlist",
                results=exact_local[:limit],
            )
            with self._lock:
                self._cache[cache_key] = (time.monotonic(), response)
            return response

        try:
            results = self._openfigi_results(normalized, limit)
        except SecuritySearchError as exc:
            if local:
                return SecuritySearchResponse(
                    query=normalized,
                    source="watchlist",
                    results=local[:limit],
                )
            raise exc

        combined: list[SecuritySearchResult] = []
        combined_seen: set[str] = set()
        for item in [*local, *results]:
            if item.figi in combined_seen:
                continue
            combined_seen.add(item.figi)
            combined.append(item)
        if not combined:
            corrected = self._typo_corrected_results(normalized, limit)
            if corrected is not None:
                corrected_query, corrected_results = corrected
                result = SecuritySearchResponse(
                    query=normalized,
                    source="openfigi",
                    corrected_query=corrected_query,
                    results=corrected_results[:limit],
                )
                with self._lock:
                    self._cache[cache_key] = (time.monotonic(), result)
                return result
            if self.entity_resolver is not None:
                resolution = self.entity_resolver(normalized)
                if resolution is not None:
                    resolved_results: list[SecuritySearchResult] = []
                    resolved_figis: set[str] = set()
                    for resolved_query in resolution.search_queries:
                        try:
                            candidates = self._openfigi_results(resolved_query, limit)
                        except SecuritySearchError:
                            continue
                        for candidate in candidates:
                            if candidate.figi in resolved_figis:
                                continue
                            resolved_figis.add(candidate.figi)
                            resolved_results.append(candidate)
                    if resolved_results:
                        result = SecuritySearchResponse(
                            query=normalized,
                            source="openfigi",
                            corrected_query=resolution.company_name,
                            results=resolved_results[:limit],
                        )
                        with self._lock:
                            self._cache[cache_key] = (time.monotonic(), result)
                        return result
        result = SecuritySearchResponse(
            query=normalized,
            source="openfigi",
            results=combined[:limit],
        )
        with self._lock:
            self._cache[cache_key] = (time.monotonic(), result)
        return result
