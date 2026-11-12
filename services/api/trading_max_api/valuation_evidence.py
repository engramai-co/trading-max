"""Capture valuation evidence from a pinned local research publication."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from typing import Any, Literal, Protocol

from trading_max.research.estimate_history import EstimateObservation, EstimatePeriod
from trading_max.research.facts import (
    FinancialPeriod,
    MetricObservation,
    build_financial_facts,
    fingerprint,
    make_quote,
    number,
)
from trading_max.research.fundamentals import _sector_profile
from trading_max.research.valuation_evidence import (
    EvidenceBinding,
    EvidenceGroup,
    EvidenceItem,
    EvidenceLimitError,
    EvidenceLocator,
    EvidencePeriod,
    EvidenceScopeError,
    EvidenceValue,
    FrozenValuationEvidence,
    Metric,
    evidence_item,
    publication_within,
)

from .models import SnapshotManifest
from .research import (
    CURRENT_MARKET_KEY,
    _analyst_rows,
    _financials_rows,
    _fundamentals_rows,
    _market_rows,
)

_MAX_SOURCE_BYTES = 16 * 1024 * 1024
_FORECAST_SLOTS: tuple[EstimatePeriod, ...] = ("0q", "+1q", "0y", "+1y")
_STATEMENT_METRICS = (
    Metric.REVENUE,
    Metric.FREE_CASHFLOW,
    Metric.FCF_MARGIN,
    Metric.STATEMENT_SHARES,
    Metric.REVENUE_GROWTH,
)


class SnapshotReader(Protocol):
    def load_manifest(self, run_id: str) -> SnapshotManifest: ...
    def read_json(self, run_id: str, key: str) -> dict[str, Any]: ...


class EstimateReader(Protocol):
    def __call__(
        self, ticker: str, listing: str, *, cutoff: datetime
    ) -> Sequence[EstimateObservation]: ...


@dataclass(frozen=True)
class _Row:
    data: dict
    observed_at: datetime
    version: str
    retained: bool = False


def _instant(value: Any) -> datetime | None:
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.astimezone(UTC)
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.astimezone(UTC) if parsed.tzinfo is not None else None
    except ValueError:
        return None


def _day(value: Any) -> date | None:
    try:
        return date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _currency(value: Any) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"[A-Z]{3}", value) else None


def _positive(value: Any) -> float | None:
    n = number(value)
    return n if n is not None and n > 0 else None


def _read_row(
    reader: SnapshotReader,
    manifest: SnapshotManifest,
    binding: EvidenceBinding,
    key: str,
    parse_rows: Callable[[dict], list[dict]],
) -> _Row | None:
    ref = next((ref for ref in manifest.artifacts if ref.key == key), None)
    if ref is None:
        return None
    if ref.size_bytes > _MAX_SOURCE_BYTES:
        raise EvidenceLimitError("valuation source artifact exceeds the byte limit")
    generated = _instant(ref.generated_at)
    if generated is not None and generated > manifest.created_at:
        return None
    try:
        raw = reader.read_json(manifest.run_id, key)
    except FileNotFoundError:
        return None
    # Only the typed market input contains a public technical quote. The
    # legacy daily-market projection could contain account-derived fields.
    technical = raw.get("technical")
    if key == CURRENT_MARKET_KEY and not isinstance(technical, dict):
        return None
    rows = [r for r in parse_rows(raw) if str(r.get("ticker", "")).upper() == binding.ticker]
    if len(rows) > 1:
        raise EvidenceScopeError("ambiguous source row for the bound ticker")
    if not rows:
        return None
    container = technical if key == CURRENT_MARKET_KEY else raw
    clocks = container.get("rowClocks")
    clock = clocks.get(binding.ticker, {}) if isinstance(clocks, dict) else {}
    if clocks is not None and not clock:
        return None
    observed = (
        _instant(clock.get("lastSuccessfulAt") or clock.get("fetchedAt"))
        if clock
        else _instant(container.get("generated_at") or raw.get("generated_at")) or generated
    )
    if observed is None or observed > manifest.created_at or observed > binding.cutoff:
        return None
    if clock and clock.get("state") not in {"available", "stale"}:
        return None
    row = rows[0]
    if row.get("listing") is not None and row["listing"] != binding.listing:
        raise EvidenceScopeError("source listing mismatch")
    if key == "research/valuation.json":
        # The batch can also contain user scenarios. Do not retain them or
        # include them in any source version sent with public evidence.
        stored = row.get("assumptions") or {}
        row = {
            "currency": row.get("currency"),
            "assumptions": {
                "sharesOutstanding": stored.get("sharesOutstanding"),
                "fxRate": stored.get("fxRate"),
                "financialFactsVersion": stored.get("financialFactsVersion"),
                "discountRateInputs": {
                    "costEquity": (stored.get("discountRateInputs") or {}).get("costEquity"),
                },
            },
        }
    return _Row(row, observed, fingerprint(row), clock.get("state") == "stale")


class _Capture:
    def __init__(self, binding: EvidenceBinding, publication_time: datetime) -> None:
        self.binding = binding
        self.publication_time = publication_time
        self.rows: list[EvidenceItem] = []

    def add(
        self,
        group: EvidenceGroup,
        metric: Metric,
        value: Any,
        *,
        row: _Row | None,
        dataset: Literal[
            "financials", "fundamentals", "valuation", "market", "analyst", "pe-archive"
        ],
        field: str,
        period: EvidencePeriod | None = None,
        published_at: datetime | date | None = None,
        currency: str | None = None,
        counter_currency: str | None = None,
        native_quote_unit: str | None = None,
        accession: str | None = None,
        basis: str,
        unit: str,
        source: str,
        quality: Literal["observed", "derived", "recovered"] = "observed",
    ) -> None:
        if metric not in self.binding.permitted_fields:
            return
        if not publication_within(published_at, row.observed_at if row else self.publication_time):
            row, published_at, accession = None, None, None
        observed = row.observed_at if row else None
        value = number(value) if observed is not None else None
        item = EvidenceValue(
            ticker=self.binding.ticker,
            listing=self.binding.listing,
            group=group,
            metric=metric,
            basis=basis,
            period=period or EvidencePeriod(kind="spot"),
            currency=_currency(currency),
            counter_currency=_currency(counter_currency),
            native_quote_unit=native_quote_unit
            if native_quote_unit in {"GBp", "GBX", "GBx"}
            else _currency(native_quote_unit),
            unit=unit,
            source=source,
            locator=EvidenceLocator(dataset=dataset, field=field, accession=accession),
            published_at=published_at,
            observed_at=observed,
            version=row.version if row else None,
            state="available" if value is not None else "missing",
            quality="unavailable" if value is None else "retained" if row.retained else quality,
            value=value,
        )
        self.rows.append(evidence_item(self.binding, item))


def _statement(
    capture: _Capture,
    group: EvidenceGroup,
    metric: Metric,
    row: _Row | None,
    period: FinancialPeriod | None,
    obs: MetricObservation | None,
    *,
    currency: str | None,
) -> None:
    refs = obs.evidence if obs else []
    stamps = [_instant(ref.published_at) or _day(ref.published_at) for ref in refs]
    # Keep the latest known component publication for cutoff enforcement. No
    # timestamp is invented for an unreported or provider-only field.
    published = max(
        (stamp for stamp in stamps if stamp is not None),
        key=lambda stamp: (
            stamp if isinstance(stamp, datetime) else datetime.combine(stamp, time.max, UTC)
        ),
        default=None,
    )
    accession = refs[0].accession if len(refs) == 1 else None
    if not isinstance(accession, str) or not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession):
        accession = None
    locator = refs[0].field if len(refs) == 1 else metric.value
    if not re.fullmatch(r"[A-Za-z0-9_.+() -]{1,100}", locator):
        locator = metric.value
    period_end = _day(period.actual_end or period.provider_end) if period else None
    # An unavailable period may not disclose future dates at an older cutoff.
    observed_at = row.observed_at if row else capture.publication_time
    if (period_end and period_end > observed_at.date()) or not publication_within(
        published, observed_at
    ):
        if group != EvidenceGroup.BASIS:
            return
        row, period, obs, period_end, published, accession, locator = (
            None,
            None,
            None,
            None,
            None,
            None,
            metric.value,
        )
    value = obs.value if obs and obs.state == "available" else None
    if group == EvidenceGroup.BASIS:
        if metric == Metric.REVENUE:
            value = _positive(value)
        if currency is None or (obs and obs.currency != currency):
            value = None
    capture.add(
        group,
        metric,
        value,
        row=row,
        dataset="financials",
        field=locator,
        accession=accession,
        period=EvidencePeriod(
            kind=period.kind if period else "ttm",
            start=_day(period.actual_start) if period else None,
            end=period_end,
            component_ends=tuple(
                date.fromisoformat(component.split(":", 1)[1]) for component in period.components
            )
            if period
            else (),
        ),
        published_at=published,
        currency=obs.currency if obs else currency,
        basis=obs.basis if obs else "statement-derived",
        unit=obs.unit if obs else "currency",
        source="yahoo-finance-financials",
        quality="derived"
        if period and (period.kind == "ttm" or (obs and obs.formula))
        else "observed",
    )


def _revenue_expectations(capture: _Capture, row: _Row | None) -> None:
    analyst = row.data.get("analyst") or {} if row else {}
    estimates = analyst.get("revenueEstimate") or []
    for slot in _FORECAST_SLOTS:
        matched = [
            r
            for r in estimates
            if isinstance(r, dict) and (r.get("period") or r.get("index")) == slot
        ]
        estimate = matched[0] if len(matched) == 1 else {}
        period = EvidencePeriod(
            kind="forecast", end=_day(estimate.get("endDate")), forecast_slot=slot
        )
        stamp = _instant(estimate.get("asOf") or analyst.get("asOf"))
        currency = _currency(estimate.get("currency"))
        usable = (
            row is not None
            and period.end is not None
            and stamp is not None
            and stamp <= row.observed_at
        )
        for metric, field, value, unit in (
            (
                Metric.CONSENSUS_REVENUE,
                "avg",
                estimate.get("avg") if currency else None,
                "currency",
            ),
            (Metric.CONSENSUS_REVENUE_GROWTH, "growth", estimate.get("growth"), "ratio"),
        ):
            capture.add(
                EvidenceGroup.EXPECTATIONS,
                metric,
                value if usable else None,
                row=row,
                dataset="analyst",
                field="revenueEstimate." + field,
                period=period if usable else EvidencePeriod(kind="forecast", forecast_slot=slot),
                currency=currency if usable and unit == "currency" else None,
                basis="provider-consensus",
                unit=unit,
                source="yahoo-finance-consensus",
            )
    # The existing point-in-time archive tracks EPS, not revenue forecasts.
    capture.add(
        EvidenceGroup.EXPECTATIONS,
        Metric.CONSENSUS_REVENUE_GROWTH_CHANGE,
        None,
        row=None,
        dataset="analyst",
        field="revenueEstimate.growth",
        basis="same-fiscal-period-revision",
        unit="ratio-point",
        source="yahoo-finance-consensus",
        period=EvidencePeriod(kind="forecast"),
    )


def _eps_expectations(capture: _Capture, history: EstimateReader | None, cutoff: datetime) -> None:
    binding = capture.binding
    if not {Metric.CONSENSUS_EPS, Metric.CONSENSUS_EPS_CHANGE} & binding.permitted_fields:
        return
    observations = tuple(history(binding.ticker, binding.listing, cutoff=cutoff)) if history else ()
    if len(observations) > 16:
        raise EvidenceLimitError("valuation archive window exceeds the row limit")
    if any(
        (row.ticker, row.listing) != (binding.ticker, binding.listing) or row.observed_at > cutoff
        for row in observations
    ):
        raise EvidenceScopeError("archive observation does not match the binding")
    observations = sorted(observations, key=lambda row: row.observed_at, reverse=True)
    latest = observations[0] if observations else None
    for slot in _FORECAST_SLOTS:
        estimate = next((e for e in latest.consensus if e.period == slot), None) if latest else None
        end = estimate.period_end if estimate else None
        currency = _currency(estimate.currency) if estimate else None
        current = number(estimate.mean_eps) if estimate and end and currency else None
        earlier = (
            next(
                (
                    (row, n)
                    for row in observations[1:]
                    if row.observed_at < latest.observed_at
                    for prior in row.consensus
                    if prior.period_end == end and prior.currency == currency
                    if (n := number(prior.mean_eps)) is not None
                ),
                None,
            )
            if latest and current is not None
            else None
        )
        period = EvidencePeriod(kind="forecast", end=end, forecast_slot=slot)
        capture.add(
            EvidenceGroup.EXPECTATIONS,
            Metric.CONSENSUS_EPS,
            current,
            row=_Row({}, latest.observed_at, fingerprint(latest.model_dump())) if latest else None,
            dataset="pe-archive",
            field="consensus.meanEps",
            period=period,
            currency=currency,
            basis="provider-consensus",
            unit="perShare",
            source="yahoo-finance-consensus",
            quality="recovered" if latest and latest.recovered else "observed",
        )
        capture.add(
            EvidenceGroup.EXPECTATIONS,
            Metric.CONSENSUS_EPS_CHANGE,
            current - earlier[1] if earlier and current is not None else None,
            row=_Row(
                {}, latest.observed_at, fingerprint([latest.model_dump(), earlier[0].model_dump()])
            )
            if latest and earlier
            else None,
            dataset="pe-archive",
            field="consensus.meanEps.change",
            period=period,
            currency=currency,
            basis="same-fiscal-period-revision",
            unit="perShare",
            source="yahoo-finance-consensus",
            quality="recovered"
            if earlier and (latest.recovered or earlier[0].recovered)
            else "derived",
        )


def freeze_valuation_evidence(
    binding: EvidenceBinding,
    *,
    snapshots: SnapshotReader,
    estimate_reader: EstimateReader | None = None,
) -> FrozenValuationEvidence:
    """Read only public artifacts for one exact listing and snapshot. No live fallback."""
    binding = EvidenceBinding.model_validate(binding.model_dump(mode="json"))
    manifest = snapshots.load_manifest(binding.snapshot_run_id)
    if manifest.run_id != binding.snapshot_run_id or manifest.created_at > binding.cutoff:
        raise EvidenceScopeError("snapshot does not match the binding or is newer than the cutoff")
    capture = _Capture(binding, manifest.created_at)
    fundamental = _read_row(
        snapshots, manifest, binding, "research/fundamentals.json", _fundamentals_rows
    )
    market = _read_row(snapshots, manifest, binding, CURRENT_MARKET_KEY, _market_rows)
    data = fundamental.data if fundamental else {}
    metrics = data.get("metrics") or {}
    quote = make_quote(binding.ticker, market.data if market else {}, data)
    if quote.session != "regular":
        # A fallback price and timestamp must come from the same public row.
        quote = make_quote(
            binding.ticker,
            market.data if market else {},
            {**data, "metrics": {**metrics, "regularMarketTime": None}},
        )
    if quote.listing is not None and quote.listing != binding.listing:
        raise EvidenceScopeError("quote listing mismatch")
    if quote.listing is None:
        return FrozenValuationEvidence(binding=binding, eligibility="unknown", rows=())
    quote_type = str(metrics.get("quoteType", "")).upper()
    if quote_type in {"ETF", "MUTUALFUND"}:
        eligibility = "fund"
    elif quote_type != "EQUITY":
        eligibility = "unknown"
    else:
        industry = str(data.get("industry") or metrics.get("industry") or "")
        sector = str(data.get("sector") or metrics.get("sector") or "")
        profile, _ = _sector_profile(sector, industry)
        eligibility = (
            "financial"
            if (
                profile.method == "analyst"
                or "financial" in sector.lower()
                or any(word in industry.lower() for word in ("banks", "banking", "insurance"))
            )
            else "equity"
        )

    financials = _read_row(
        snapshots, manifest, binding, "research/financials.json", _financials_rows
    )
    raw = (financials.data.get("financials") or {}) if financials else {}
    facts = build_financial_facts(raw, metrics, period_evidence=raw.get("periodEvidence"))
    periods = {p.id: p for p in facts.periods}
    values = {(o.period_id, o.metric): o for o in facts.observations}
    ttm = periods.get(facts.latest_ttm)
    report, quoted = _currency(facts.currency), _currency(quote.currency)
    for metric in (Metric.REVENUE, Metric.FREE_CASHFLOW):
        _statement(
            capture,
            EvidenceGroup.BASIS,
            metric,
            financials,
            ttm,
            values.get((facts.latest_ttm, metric)),
            currency=report,
        )

    recent = [
        period
        for kind in ("annual", "quarterly")
        for period in sorted(
            (p for p in periods.values() if p.kind == kind), key=lambda p: p.provider_end
        )[-4:]
    ]
    for period in [*recent, *([ttm] if ttm else [])]:
        metrics_for_period = (
            (Metric.REVENUE, Metric.FREE_CASHFLOW, Metric.CASH_FROM_OPERATIONS, Metric.CAPEX)
            if period.kind == "quarterly"
            else _STATEMENT_METRICS
        )
        for metric in metrics_for_period:
            _statement(
                capture,
                EvidenceGroup.OPERATING,
                metric,
                financials,
                period,
                values.get((period.id, metric)),
                currency=report,
            )

    valuation = _read_row(
        snapshots, manifest, binding, "research/valuation.json", _fundamentals_rows
    )
    stored = valuation.data.get("assumptions") or {} if valuation else {}
    valuation_currency = valuation.data.get("currency") if valuation else None
    aligned = quoted is not None and valuation_currency == quoted
    market_matches = market is not None and market.data.get("currency") == quoted
    quote_row = fundamental if quote.session == "regular" else market if market_matches else None
    quote_day = _day(quote.as_of)
    quote_stamp = _instant(quote.as_of) if quote_day is None else None
    if quote_row is None or (
        quote_stamp > quote_row.observed_at
        if quote_stamp
        else quote_day is None or quote_day > quote_row.observed_at.date()
    ):
        quote_row, quote_stamp, quote_day = None, None, None
    capture.add(
        EvidenceGroup.BASIS,
        Metric.SPOT,
        _positive(quote.price) if quoted else None,
        row=quote_row,
        dataset="fundamentals" if quote.session == "regular" else "market",
        field="regularMarketPrice" if quote.session == "regular" else "price",
        period=EvidencePeriod(
            kind="spot",
            end=quote_stamp.date() if quote_stamp else quote_day,
        ),
        published_at=quote_stamp,
        currency=quoted,
        native_quote_unit=quote.quote_unit,
        basis="public-quote",
        unit="perShare",
        source="yahoo-finance",
    )
    capture.add(
        EvidenceGroup.BASIS,
        Metric.SHARES,
        _positive(stored.get("sharesOutstanding")) if aligned else None,
        row=valuation,
        dataset="valuation",
        field="assumptions.sharesOutstanding",
        basis="listing-shares",
        unit="shares",
        source="research-valuation",
    )
    identity_fx = report is not None and report == quoted
    fx_facts_version = stored.get("financialFactsVersion")
    fx_matches = (
        aligned and report and (fx_facts_version is None or fx_facts_version == facts.version)
    )
    capture.add(
        EvidenceGroup.BASIS,
        Metric.FX,
        1 if identity_fx else _positive(stored.get("fxRate")) if fx_matches else None,
        row=fundamental if identity_fx else valuation,
        dataset="fundamentals" if identity_fx else "valuation",
        field="financialCurrency" if identity_fx else "assumptions.fxRate",
        currency=report,
        counter_currency=quoted,
        basis="identity-fx" if identity_fx else "stored-valuation-fx",
        unit="fx",
        source="currency-identity" if identity_fx else "research-valuation",
        quality="derived",
    )
    analyst = _read_row(snapshots, manifest, binding, "research/analyst.json", _analyst_rows)
    _revenue_expectations(capture, analyst)
    _eps_expectations(capture, estimate_reader, manifest.created_at)

    for metric, field in (
        (Metric.FORWARD_PE, "forwardPE"),
        (Metric.TRAILING_PE, "trailingPE"),
        (Metric.FORWARD_EPS, "forwardEps"),
        (Metric.TRAILING_EPS, "trailingEps"),
        (Metric.PRICE_TO_SALES, "priceToSalesTrailing12Months"),
        (Metric.PRICE_TO_BOOK, "priceToBook"),
        (Metric.EV_TO_EBITDA, "enterpriseToEbitda"),
    ):
        eps = metric in {Metric.FORWARD_EPS, Metric.TRAILING_EPS}
        # Vendor EPS has no documented currency/unit identity in this batch.
        # Do not attach the quote's currency and silently make it comparable.
        capture.add(
            EvidenceGroup.MARKET,
            metric,
            metrics.get(field) if not eps else None,
            row=fundamental,
            dataset="fundamentals",
            field=field,
            basis="vendor-context",
            unit="perShare" if eps else "multiple",
            source="yahoo-finance",
        )
    target = _positive(metrics.get("targetMedianPrice"))
    if quote.quote_unit in {"GBp", "GBX"} and target is not None:
        target /= 100
    capture.add(
        EvidenceGroup.MARKET,
        Metric.TARGET_MEDIAN,
        target if quoted else None,
        row=fundamental,
        dataset="fundamentals",
        field="targetMedianPrice",
        currency=quoted,
        native_quote_unit=quote.quote_unit,
        basis="analyst-target",
        unit="perShare",
        source="yahoo-finance",
    )
    capture.add(
        EvidenceGroup.MARKET,
        Metric.COST_OF_EQUITY,
        (stored.get("discountRateInputs") or {}).get("costEquity"),
        row=valuation,
        dataset="valuation",
        field="assumptions.discountRateInputs.costEquity",
        basis="cost-of-equity-proxy",
        unit="ratio",
        source="research-valuation",
        quality="derived",
    )
    return FrozenValuationEvidence(
        binding=binding,
        eligibility=eligibility,
        facts_version=facts.version,
        quote_id=quote.id,
        rows=tuple(capture.rows),
    )
