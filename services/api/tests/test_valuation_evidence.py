from __future__ import annotations

import socket
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from trading_max.infrastructure import SqliteDatabase
from trading_max.research.estimate_history import (
    ConsensusEstimate,
    EstimateHistory,
    EstimateObservation,
)
from trading_max.research.valuation_evidence import (
    MAX_BATCH_CALLS,
    MAX_BATCH_ROWS,
    MAX_EVIDENCE_BYTES,
    AssumptionCitation,
    EvaluateValuationRequest,
    EvidenceBinding,
    EvidenceLimitError,
    EvidenceScopeError,
    FrozenValuationEvidence,
    Metric,
    ValuationEvidenceTools,
)

from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.routes.research import router
from services.api.trading_max_api.valuation_evidence import freeze_valuation_evidence
from services.api.trading_max_api.watchlist import WatchlistStore

AS_OF = datetime(2026, 2, 12, 18, tzinfo=UTC)
QUOTE_AT = AS_OF - timedelta(hours=1)
WORKSHEET_FIELDS = (
    "scenarios",
    "sensitivity",
    "impliedGrowth",
    "impliedGrowthBound",
    "impliedGrowthReason",
)
KEYS = frozenset(
    {
        "research/fundamentals.json",
        "research/financials.json",
        "research/valuation.json",
        "research/analyst.json",
        "research/market_snapshot.json",
    }
)


@dataclass(frozen=True)
class Issuer:
    ticker: str = "SYNM"
    quote_unit: str = "USD"
    reporting: str = "USD"
    raw_spot: float = 25
    quarterly_revenue: float = 1000
    quarterly_ocf: float = 150
    share_count: float = 100
    growth: float = 0.1
    fx: float | None = None
    restated: bool = False
    missing_quarter: bool = False
    industry: str = "Industrial Products"
    sector: str = "Industrials"

    @property
    def listing(self):
        return f"LSE:{self.ticker[:-2]}" if self.ticker.endswith(".L") else f"US:{self.ticker}"

    @property
    def quote_currency(self):
        return "GBP" if self.quote_unit == "GBp" else self.quote_unit


MATURE = Issuer()
HIGH_GROWTH = Issuer(
    ticker="SYNG", quarterly_revenue=1650, quarterly_ocf=265, growth=0.54, raw_spot=280
)
LONDON = Issuer(ticker="SYNL.L", quote_unit="GBp", reporting="GBP", raw_spot=2465)
ADR = Issuer(ticker="SYNA", reporting="EUR", raw_spot=71, fx=1.25, share_count=70)
RESTATED = replace(MATURE, restated=True)
GOLDEN_BASE_VALUES = {
    MATURE: (124.29026943587765, 127.83672512212551),
    HIGH_GROWTH: (995.3339189725551, 1909.6999839747023),
    LONDON: (124.29026943587765, 127.83672512212551),
    ADR: (221.94690970692443, 228.27986628950993),
    RESTATED: (119.81320340068228, 123.22666699869588),
}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def denied(*args, **kwargs):
        pytest.fail("network calls are forbidden in valuation evidence tests")

    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def _publish(store, issuer, *, created_at=None, inject=None):
    london = issuer.ticker.endswith(".L")
    quarters = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"]
    if issuer.missing_quarter:
        quarters.pop(1)
    revenues = dict.fromkeys(quarters, issuer.quarterly_revenue)
    if issuer.restated:
        revenues["2025-12-31"] *= 0.85
    financials = {
        "incomeStatement": [
            {
                "index": "Total Revenue",
                **{
                    f"{year}-12-31": issuer.quarterly_revenue * 4 * (0.9 ** (2025 - year))
                    for year in range(2022, 2026)
                },
            }
        ],
        "quarterlyIncomeStatement": [{"index": "Total Revenue", **revenues}],
        "quarterlyCashflow": [
            {"index": "Operating Cash Flow", **dict.fromkeys(quarters, issuer.quarterly_ocf)},
            {"index": "Capital Expenditure", **dict.fromkeys(quarters, -25)},
        ],
        "periodEvidence": [
            {
                "kind": "quarterly",
                "providerEnd": "2025-12-31",
                "actualEnd": "2025-12-31",
                "publishedAt": "2026-02-11T15:00:00Z"
                if issuer.restated
                else "2026-02-09T15:00:00Z",
                "url": "https://issuer.invalid/synthetic-filing",
                "accession": "0000000000-26-000001",
            }
        ],
    }
    fundamental = {
        "currency": issuer.quote_unit,
        "sector": issuer.sector,
        "industry": issuer.industry,
        "metrics": {
            "fullExchangeName": "LSE" if london else "NYSE",
            "exchangeTimezoneName": "Europe/London" if london else "America/New_York",
            "quoteType": "EQUITY",
            "financialCurrency": issuer.reporting,
            "regularMarketPrice": issuer.raw_spot,
            "regularMarketTime": QUOTE_AT.timestamp(),
            "forwardPE": 19,
            "targetMedianPrice": 2900 if london else 29,
            "forwardEps": 2.5,
        },
    }
    payloads = {
        "research/fundamentals.json": fundamental,
        "research/financials.json": {"financials": financials},
        "research/valuation.json": {
            "currency": issuer.quote_currency,
            "assumptions": {
                "sharesOutstanding": issuer.share_count,
                "shareUnit": "ordinary",
                "listing": issuer.listing,
                "fxRate": issuer.fx,
                "discountRate": 0.6,
                "discountRateInputs": {"costEquity": 0.1},
                "unapproved": "not tool evidence",
            },
        },
        "research/analyst.json": {
            "analyst": {
                "asOf": AS_OF.isoformat(),
                "revenueEstimate": [
                    {
                        "period": "+1y",
                        "endDate": "2027-12-31",
                        "avg": 4500,
                        "growth": 0.15,
                        "currency": issuer.reporting,
                    }
                ],
            },
        },
    }
    batches = {
        key: {
            "generated_at": AS_OF.isoformat(),
            "rows": [{"ticker": issuer.ticker, **payload}],
        }
        for key, payload in payloads.items()
    }
    if inject:
        inject(batches)
    artifacts = [
        store.immutable_artifacts.put_json(key=key, payload=batch) for key, batch in batches.items()
    ]
    snapshot = store.immutable_snapshots.publish(
        scope="research",
        source="synthetic",
        artifacts=artifacts,
        created_at=created_at,
    )
    return EvidenceBinding(
        workspace_id="synthetic-workspace",
        ticker=issuer.ticker,
        listing=issuer.listing,
        cutoff=snapshot.manifest.created_at + timedelta(minutes=1),
        snapshot_run_id=snapshot.manifest.run_id,
        permitted_fields=frozenset(Metric),
    )


def _request(issuer=MATURE, horizon=5, **fields):
    return EvaluateValuationRequest.model_validate(
        {
            "horizon": horizon,
            "scenarios": {
                name: {
                    "revenueCagr": issuer.growth + offset,
                    "targetFcfMargin": 0.16 + offset / 2,
                    "discountRate": 0.1 - offset / 4,
                    "exitFcfMultiple": 16 + offset * 20,
                    "shareCagr": 0.015,
                }
                for name, offset in (("bear", -0.05), ("base", 0), ("bull", 0.05))
            },
            **fields,
        }
    )


def _desk(store, issuer, request):
    app = FastAPI()
    app.include_router(router)
    app.state.store = store
    app.state.research = ResearchLedger(store, WatchlistStore(store.data_root))
    app.state.research_journal = SimpleNamespace()  # Any journal access fails.
    body = request.model_dump(mode="json", exclude={"citations"})
    with TestClient(app) as client:
        response = client.post(f"/v2/research/{issuer.ticker}/valuation-preview", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _equal(left, right):
    if isinstance(right, float):
        assert left == pytest.approx(right, rel=1e-12, abs=1e-12)
    elif isinstance(right, dict):
        assert left.keys() == right.keys()
        for key, value in right.items():
            _equal(left[key], value)
    elif isinstance(right, list):
        assert len(left) == len(right)
        for x, y in zip(left, right, strict=True):
            _equal(x, y)
    else:
        assert left == right


@pytest.mark.parametrize("horizon", [5, 10])
@pytest.mark.parametrize(
    "issuer",
    [MATURE, HIGH_GROWTH, LONDON, ADR, RESTATED],
    ids=[
        "mature-us",
        "high-growth",
        "london-pence",
        "adr-cross-currency",
        "restated",
    ],
)
def test_frozen_replay_matches_full_desk_worksheet(tmp_path, issuer, horizon):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, issuer)
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    tools = ValuationEvidenceTools(binding, frozen)
    basis = tools.get_valuation_basis()
    operating = tools.get_operating_evidence()
    expectations = tools.get_expectations_and_changes()
    market = tools.get_market_references()
    request = _request(issuer, horizon)
    evaluated = tools.evaluate_valuation(request)
    assert all(x.state == "available" for x in (basis, operating, expectations, market, evaluated))
    assert len(operating.items) == 41
    assert len(evaluated.sensitivity) == 25
    assert evaluated.projections["base"].value == pytest.approx(
        GOLDEN_BASE_VALUES[issuer][int(horizon == 10)],
        rel=1e-12,
        abs=1e-12,
    )
    assert evaluated.reverse_dcf.search_bounds == (-0.3, 0.8)
    assert "equity-cash-flow-proxy" in evaluated.warnings
    output = evaluated.model_dump(mode="json")
    reverse = output["reverseDcf"]
    actual = dict(
        zip(
            WORKSHEET_FIELDS,
            (
                output["projections"],
                output["sensitivity"],
                reverse["impliedGrowth"],
                reverse["bound"],
                reverse["reason"],
            ),
            strict=True,
        )
    )
    desk = _desk(store, issuer, request)
    _equal(actual, {key: desk[key] for key in WORKSHEET_FIELDS})
    assert evaluated.formula_version == desk["formulaVersion"]
    assert evaluated.preview_id.startswith("vp_")
    assert basis.basis.model_dump(exclude={"evidence"}) == {
        k: v for k, v in desk["basis"].items() if k != "evidence"
    }
    if issuer == LONDON:
        spot = next(row for row in basis.items if row.metric == Metric.SPOT)
        assert (spot.value, spot.currency, spot.native_quote_unit) == (24.65, "GBP", "GBp")
        assert next(row for row in market.items if row.metric == Metric.TARGET_MEDIAN).value == 29
    if issuer == ADR:
        assert basis.basis.revenue == 5000
        assert "cross-currency-stored-share-basis" in evaluated.warnings

    # No store is passed for replay, and every projected number and hash is identical.
    restored = FrozenValuationEvidence.model_validate_json(frozen.model_dump_json())
    assert ValuationEvidenceTools(binding, restored).evaluate_valuation(request) == evaluated


@pytest.mark.parametrize(
    ("issuer", "state", "reason", "missing_metric"),
    [
        (replace(ADR, fx=None), "missing", "currency-conversion-unavailable", Metric.FX),
        (
            replace(MATURE, missing_quarter=True),
            "missing",
            "complete-ttm-currency-and-share-count-required",
            Metric.REVENUE,
        ),
    ],
)
def test_missing_and_unsupported_do_not_project(tmp_path, issuer, state, reason, missing_metric):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, issuer)
    tools = ValuationEvidenceTools(binding, freeze_valuation_evidence(binding, snapshots=store))
    basis = tools.get_valuation_basis()
    result = tools.evaluate_valuation(_request())
    assert (basis.state, basis.reason, basis.basis) == (state, reason, None)
    assert (result.state, result.reason, result.preview_id, result.projections) == (
        state,
        reason,
        None,
        None,
    )
    if missing_metric is not None:
        row = next(row for row in basis.items if row.metric == missing_metric)
        assert row.state == "missing" and row.value is None


def test_restatement_creates_new_evidence_without_mutating_the_pinned_replay(tmp_path):
    store = ArtifactStore(tmp_path)
    original = _publish(store, MATURE)
    before = freeze_valuation_evidence(original, snapshots=store)
    updated = _publish(store, RESTATED)
    after = freeze_valuation_evidence(updated, snapshots=store)
    assert freeze_valuation_evidence(original, snapshots=store) == before
    before_tools, after_tools = (ValuationEvidenceTools(f.binding, f) for f in (before, after))
    basis_before, basis_after = (tool.get_valuation_basis() for tool in (before_tools, after_tools))
    revenue_before, revenue_after = (
        next(row for row in basis.items if row.metric == Metric.REVENUE)
        for basis in (basis_before, basis_after)
    )
    assert revenue_before.value == 4000 and revenue_after.value == 3850
    assert revenue_after.published_at > revenue_before.published_at
    assert revenue_after.version != revenue_before.version
    assert revenue_after.id != revenue_before.id
    assert ValuationEvidenceTools(original, before).evaluate_valuation(_request()).preview_id != (
        after_tools.evaluate_valuation(_request()).preview_id
    )
    with pytest.raises(EvidenceScopeError, match="citation"):
        after_tools.evaluate_valuation(
            _request(
                citations=[
                    {
                        "scenario": "base",
                        "assumption": "revenue_cagr",
                        "evidenceId": revenue_before.id,
                    }
                ]
            )
        )


@pytest.mark.parametrize(
    "extra",
    [
        {"ticker": "OTHER"},
        {"listing": "LSE:SYNM"},
        {"path": "../account/export"},
        {"query": "SELECT * FROM positions"},
        {"url": "https://issuer.invalid/quote"},
        {"workspaceId": "another-workspace"},
        {"snapshotRunId": "another-run"},
        {"references": [{"source": "https://issuer.invalid"}]},
    ],
)
def test_requests_cannot_carry_data_access_instructions(extra):
    with pytest.raises(ValidationError, match="Extra inputs"):
        _request(**extra)


@pytest.mark.parametrize(
    "payload",
    [
        {"field": "revenueCagr", "value": "0.15"},
        {"field": "revenueCagr", "value": float("nan")},
        {"field": "discountRate", "value": "SELECT rate FROM values"},
        {"field": "shareCagr", "value": "https://issuer.invalid/quote"},
        {"field": "path", "value": "../research"},
    ],
)
def test_scenario_parameters_are_strict_finite_numbers(payload):
    raw = _request().model_dump()
    raw["scenarios"]["base"][payload["field"]] = payload["value"]
    with pytest.raises(ValidationError):
        EvaluateValuationRequest.model_validate(raw)


def test_evidence_ids_and_permissions_are_validated(tmp_path):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, MATURE)
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    tools = ValuationEvidenceTools(binding, frozen)
    revenue = next(row for row in tools.get_valuation_basis().items if row.metric == Metric.REVENUE)
    citation = {"scenario": "base", "assumption": "revenue_cagr", "evidenceId": revenue.id}
    request = _request(citations=[citation])
    result = tools.evaluate_valuation(request)
    assert result.citations == request.citations
    assert frozen.resolve(revenue.id) == revenue
    assert revenue.id in result.basis_evidence_ids
    for bad in (
        {**citation, "assumption": "exit_fcf_multiple"},
        {**citation, "evidenceId": "ve_" + "0" * 64},
    ):
        with pytest.raises(EvidenceScopeError, match="citation"):
            tools.evaluate_valuation(_request(citations=[bad]))
    with pytest.raises(ValidationError):
        AssumptionCitation.model_validate({**citation, "evidenceId": "https://issuer.invalid"})
    with pytest.raises(EvidenceScopeError, match="binding"):
        ValuationEvidenceTools(binding.model_copy(update={"workspace_id": "elsewhere"}), frozen)
    with pytest.raises(ValidationError, match="evidence ID"):
        FrozenValuationEvidence.model_validate(
            frozen.model_dump(mode="json")
            | {"rows": [revenue.model_dump(mode="json") | {"value": 9}]}
        )
    restricted = binding.model_copy(update={"permitted_fields": frozenset({Metric.FORWARD_PE})})
    narrow = ValuationEvidenceTools(
        restricted, freeze_valuation_evidence(restricted, snapshots=store)
    )
    assert narrow.get_valuation_basis().reason == "fields-not-permitted"
    assert narrow.get_operating_evidence().items == ()
    assert [r.metric for r in narrow.get_market_references().items] == [Metric.FORWARD_PE]
    assert narrow.evaluate_valuation(_request()).preview_id is None
    with pytest.raises(EvidenceScopeError, match="citation"):
        narrow.evaluate_valuation(request)


def test_exact_listing_and_point_in_time_source_guards(tmp_path):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, LONDON)
    with pytest.raises(EvidenceScopeError, match="listing"):
        freeze_valuation_evidence(
            binding.model_copy(update={"listing": "US:SYNL"}), snapshots=store
        )
    alias = binding.model_copy(update={"ticker": "SYNL", "listing": "US:SYNL"})
    evidence = freeze_valuation_evidence(alias, snapshots=store)
    assert (
        ValuationEvidenceTools(alias, evidence).get_valuation_basis().reason
        == "listing-identity-unavailable"
    )
    with pytest.raises(ValidationError, match=r"snapshot_run_id|snapshotRunId"):
        freeze_valuation_evidence(
            binding.model_copy(update={"snapshot_run_id": "../../account"}),
            snapshots=object(),
        )
    with pytest.raises(EvidenceScopeError, match="cutoff"):
        freeze_valuation_evidence(
            binding.model_copy(update={"cutoff": AS_OF - timedelta(days=1)}), snapshots=store
        )

    def inject(batches):
        row = batches["research/financials.json"]["rows"][0]
        row["financials"]["periodEvidence"][0]["publishedAt"] = "2099-01-01T18:00:00Z"

    binding = _publish(store, MATURE, inject=inject)
    tools = ValuationEvidenceTools(binding, freeze_valuation_evidence(binding, snapshots=store))
    assert tools.get_valuation_basis().state == "missing"
    assert all(
        row.period.end != date(2025, 12, 31)
        or row.period.kind == "annual"
        or row.state == "missing"
        for row in tools.get_operating_evidence().items
    )
    # Match the injected date, not "2099": evidence IDs are hex digests and may contain those digits.
    assert "2099-01-01" not in tools.get_operating_evidence().model_dump_json()


def test_private_marks_and_legacy_market_projection_are_not_read(tmp_path):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, MATURE)
    manifest = store.load_manifest(binding.snapshot_run_id)
    private = [
        store.immutable_artifacts.put_json(
            key=key, payload={"rows": [{"t": MATURE.ticker, "spot": 9}]}
        )
        for key in ("account/broker_snapshot_metrics.json", "research/daily_market.json")
    ]
    manifest = store.publish_typed(
        scope="research",
        source="synthetic",
        artifacts=[
            *private,
            *(
                store.immutable_artifacts.get_json(store.artifact_id(ref))
                for ref in manifest.artifacts
            ),
        ],
    )
    binding = binding.model_copy(
        update={"snapshot_run_id": manifest.run_id, "cutoff": manifest.created_at}
    )
    read = []

    class PublicReader:
        load_manifest = store.load_manifest

        def read_json(self, run_id, key):
            assert run_id == binding.snapshot_run_id
            assert key in KEYS
            read.append(key)
            return store.read_json(run_id, key)

    frozen = freeze_valuation_evidence(binding, snapshots=PublicReader())
    assert set(read) == KEYS - {"research/market_snapshot.json"}
    assert ValuationEvidenceTools(binding, frozen).get_valuation_basis().basis.spot == 25
    assert "unapproved" not in frozen.model_dump_json()


def test_estimate_history_is_read_only_and_revisions_match_currency_period_and_cutoff(
    tmp_path, monkeypatch
):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, MATURE)
    manifest = store.load_manifest(binding.snapshot_run_id)
    database = SqliteDatabase(tmp_path / "synthetic.sqlite")
    history = EstimateHistory(database)

    def observation(days, eps, *, currency="USD", listing=MATURE.listing, slot="0y"):
        return EstimateObservation(
            ticker=MATURE.ticker,
            listing=listing,
            observed_at=manifest.created_at + timedelta(days=days),
            consensus=[
                ConsensusEstimate(
                    period=slot, period_end=date(2026, 12, 31), currency=currency, mean_eps=eps
                )
            ],
        )

    history.append(
        [
            observation(-7, 1.75, slot="+1y"),
            observation(-5, 8, currency="GBP"),
            observation(-2, 2),
            observation(-1, 9, listing="LSE:SYNM"),
            observation(1, 10),
        ]
    )

    # SQLite read marks in shared memory are volatile coordination bytes.
    def durable_bytes():
        return {
            path: path.read_bytes()
            for path in tmp_path.rglob("*")
            if path.is_file() and not path.name.endswith("-shm")
        }

    before = durable_bytes()
    queries = []
    database.connection.set_trace_callback(queries.append)

    def denied(*args, **kwargs):
        pytest.fail("a write method was reached")

    monkeypatch.setattr(Path, "write_bytes", denied)
    monkeypatch.setattr(Path, "write_text", denied)
    monkeypatch.setattr(ArtifactStore, "publish_typed", denied)
    monkeypatch.setattr(EstimateHistory, "append", denied)
    monkeypatch.setattr(EstimateHistory, "recover", denied)
    monkeypatch.setattr(SqliteDatabase, "transaction", denied)
    try:
        frozen = freeze_valuation_evidence(
            binding, snapshots=store, estimate_reader=history.valuation_window
        )
        tools = ValuationEvidenceTools(binding, frozen)
        items = tools.get_expectations_and_changes().items
        eps = next(r for r in items if r.metric == Metric.CONSENSUS_EPS and r.state == "available")
        delta = next(
            r for r in items if r.metric == Metric.CONSENSUS_EPS_CHANGE and r.state == "available"
        )
        assert (eps.value, eps.currency, eps.period.end) == (2.0, "USD", date(2026, 12, 31))
        assert delta.value == 0.25
        assert (
            next(r for r in items if r.metric == Metric.CONSENSUS_REVENUE_GROWTH_CHANGE).state
            == "missing"
        )
        assert tools.get_valuation_basis().state == "available"
        assert tools.get_market_references().state == "available"
        assert tools.get_operating_evidence().state == "available"
        assert tools.evaluate_valuation(_request()).state == "available"
        assert len(queries) == 1 and queries[0].startswith("SELECT")
        assert durable_bytes() == before
    finally:
        database.close()


def test_batch_and_frozen_limits(tmp_path):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, MATURE)
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    raw = frozen.model_dump(mode="json")
    with pytest.raises(ValidationError, match="at most 96"):
        FrozenValuationEvidence.model_validate(raw | {"rows": [raw["rows"][0]] * 97})

    tools = ValuationEvidenceTools(binding, frozen)
    evidence_result = tools.get_operating_evidence()
    size = len(evidence_result.model_dump_json().encode()) + 1
    allowed = (MAX_EVIDENCE_BYTES - 2) // size
    assert 1 <= allowed < MAX_BATCH_CALLS and allowed * len(evidence_result.items) < MAX_BATCH_ROWS
    for _ in range(allowed - 1):
        tools.get_operating_evidence()
    with pytest.raises(EvidenceLimitError, match="batch budget"):
        tools.get_operating_evidence()

    # Worksheet rows also count; repeated evaluations cannot bypass the budget.
    tools = ValuationEvidenceTools(binding, frozen)
    for _ in range(MAX_BATCH_ROWS // 55):
        assert tools.evaluate_valuation(_request(horizon=10)).state == "available"
    with pytest.raises(EvidenceLimitError, match="batch budget"):
        tools.evaluate_valuation(_request(horizon=10))

    tools = ValuationEvidenceTools(binding, frozen)
    # Use the empty catalog to exercise the call-count cap independently of bytes.
    empty = frozen.model_copy(update={"rows": ()})
    tools = ValuationEvidenceTools(binding, empty)
    for _ in range(MAX_BATCH_CALLS):
        tools.get_valuation_basis()
    with pytest.raises(EvidenceLimitError, match="batch budget"):
        tools.get_valuation_basis()


@pytest.mark.parametrize(
    ("spot", "target_margin", "bound", "warning"),
    [
        (1.0, 0.16, "below", "reverse-dcf-outside-bounds"),
        (10000.0, 0.16, "above", "reverse-dcf-outside-bounds"),
    ],
)
def test_reverse_dcf_reports_bounds_or_refuses_a_non_monotone_solve(
    tmp_path,
    spot,
    target_margin,
    bound,
    warning,
):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, replace(MATURE, raw_spot=spot))
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    request = _request().model_dump(mode="json")
    request["scenarios"]["base"]["targetFcfMargin"] = target_margin
    result = ValuationEvidenceTools(binding, frozen).evaluate_valuation(
        EvaluateValuationRequest.model_validate(request)
    )
    assert result.state == "available" and result.reverse_dcf.implied_growth is None
    assert result.reverse_dcf.bound == bound
    assert warning in result.warnings


def test_typed_public_market_fallback_keeps_date_only_precision(tmp_path):
    def inject(batches):
        metrics = batches["research/fundamentals.json"]["rows"][0]["metrics"]
        metrics.pop("regularMarketPrice")
        batches["research/market_snapshot.json"] = {
            "generated_at": AS_OF.isoformat(),
            "technical": {
                "rows": [
                    {"ticker": MATURE.ticker, "currency": "USD", "price": 23, "as_of": "2026-02-12"}
                ],
            },
        }

    store = ArtifactStore(tmp_path)
    binding = _publish(store, MATURE, inject=inject)
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    basis = ValuationEvidenceTools(binding, frozen).get_valuation_basis()
    assert basis.basis.spot == 23
    assert basis.basis.spot_as_of == "2026-02-12"
    spot = next(r for r in basis.items if r.metric == Metric.SPOT)
    assert spot.locator.dataset == "market" and spot.published_at is None


def test_frozen_byte_limit_is_independent_of_the_row_limit(tmp_path):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, MATURE)
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    raw = frozen.model_dump(mode="json")
    long_row = raw["rows"][0] | {
        "publishedAt": "2026-02-11T15:00:00.000001+00:00",
        "observedAt": "2026-02-12T15:00:00.000001+00:00",
        "version": "a" * 64,
        "locator": {
            "dataset": "financials",
            "field": "X" * 100,
            "accession": "0000000000-26-000001",
        },
        "counterCurrency": "GBP",
        "nativeQuoteUnit": "GBp",
    }
    with pytest.raises(ValidationError, match="byte limit"):
        FrozenValuationEvidence.model_validate(raw | {"rows": [long_row] * 96})


def test_date_only_filing_and_mismatched_fx_version(tmp_path):
    def inject(batches):
        row = batches["research/financials.json"]["rows"][0]
        row["financials"]["periodEvidence"][0]["publishedAt"] = AS_OF.date().isoformat()
        assumptions = batches["research/valuation.json"]["rows"][0]["assumptions"]
        assumptions["financialFactsVersion"] = "b" * 20

    store = ArtifactStore(tmp_path)
    binding = _publish(store, ADR, inject=inject)
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    basis = ValuationEvidenceTools(binding, frozen).get_valuation_basis()
    revenue = next(r for r in basis.items if r.metric == Metric.REVENUE)
    assert revenue.published_at == AS_OF.date()
    assert revenue.state == "available"
    assert basis.reason == "currency-conversion-unavailable"


@pytest.mark.parametrize("family", ["net-income", "residual-income", "cash-flow"])
def test_new_families_freeze_and_replay_the_same_desk_basis(tmp_path, family):
    def inject(batches):
        raw = batches["research/financials.json"]["rows"][0]["financials"]
        dates = raw["quarterlyIncomeStatement"][0].keys() - {"index"}
        raw["quarterlyIncomeStatement"].append(
            {"index": "Net Income Common Stockholders", **dict.fromkeys(dates, 100)}
        )
        raw["quarterlyBalanceSheet"] = [
            {"index": k, **dict.fromkeys(dates, n)}
            for k, n in [("Common Stock Equity", 2000), ("Cash And Cash Equivalents", 15)]
        ]
        if family == "residual-income":
            raw["quarterlyIncomeStatement"] = raw["quarterlyIncomeStatement"][1:]
        batches["research/valuation.json"]["rows"][0]["assumptions"]["family"] = family

    issuer = replace(MATURE, quarterly_ocf=-450)
    store = ArtifactStore(tmp_path)
    binding = _publish(store, issuer, inject=inject)
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    tools = ValuationEvidenceTools(binding, frozen)
    basis = tools.get_valuation_basis().basis
    assert basis.family == family
    raw = _request().model_dump()
    if family == "residual-income":
        raw["scenarios"] = {
            key: {"initialRoe": 0.15, "payout": 0, "discountRate": 0.1, "terminalPb": 1}
            for key in ("bear", "base", "bull")
        }
    req = EvaluateValuationRequest.model_validate(raw)
    result = tools.evaluate_valuation(req)
    desk = _desk(store, issuer, req)
    assert result.state == "available"
    _equal(result.projections["base"].model_dump(), desk["scenarios"]["base"])
    assert result.reverse_dcf.metric == desk["reverseMetric"]
    assert result.reverse_dcf.value == desk["reverseValue"]
    if family == "cash-flow":
        assert basis.start_margin < 0 and result.reverse_dcf.metric == "target-margin"
        assert result.projections["base"].years[0].financing > 0
    elif family == "net-income":
        assert basis.start_margin == 0.1
    else:
        assert basis.revenue is None
        assert basis.book_per_share == 20
        assert result.projections["base"].terminal_contribution == pytest.approx(1)


def test_missing_cash_is_disclosed_when_a_scenario_requires_funding(tmp_path):
    store = ArtifactStore(tmp_path)
    binding = _publish(store, replace(MATURE, quarterly_ocf=-500))
    tools = ValuationEvidenceTools(binding, freeze_valuation_evidence(binding, snapshots=store))
    assert tools.get_valuation_basis().basis.opening_cash is None
    assert tools.evaluate_valuation(_request()).reason == "opening-cash-required-for-burn"


@pytest.mark.parametrize("version", ["v1", "v2"])
@pytest.mark.parametrize("has_batch_price", [True, False])
def test_retained_ordinary_snapshot_upgrades_without_republishing(
    tmp_path, version, has_batch_price
):
    from services.api.trading_max_api.research_journal import ResearchJournalStore
    from services.api.trading_max_api.valuation_assumptions import ValuationAssumptionsStore

    def legacy(batches):
        row = batches["research/valuation.json"]["rows"][0]
        row["assumptions"].pop("shareUnit")
        row["assumptions"].pop("listing")
        row.update(
            source="trading-max-valuation-v5",
            method="levered-fcf-exit-scenarios",
            model_status="indicative",
            ev5=25,
            scenarios={
                key: {
                    field: params[field]
                    for field in (
                        "revenueCagr",
                        "targetFcfMargin",
                        "exitFcfMultiple",
                        "shareCagr",
                        "discountRate",
                    )
                }
                for key, params in _request().model_dump()["scenarios"].items()
            },
        )
        if not has_batch_price:
            # The previous desk could price a retained worksheet from its five inputs.
            for field in ("source", "method", "model_status", "ev5"):
                row.pop(field)

    store = ArtifactStore(tmp_path)
    binding = _publish(store, MATURE, inject=legacy)
    app = FastAPI()
    app.include_router(router)
    app.state.store = store
    app.state.research = ResearchLedger(store, WatchlistStore(tmp_path))
    app.state.research_journal = ResearchJournalStore(tmp_path)
    app.state.valuation_assumptions = ValuationAssumptionsStore(tmp_path)
    route = f"/{version}/research/{MATURE.ticker}/valuation-preview"
    with TestClient(app) as client:
        for response in (
            client.get(route),
            client.post(route, json=_request().model_dump(exclude={"citations"})),
        ):
            assert response.status_code == 200, response.text
            assert response.json()["basis"]["shares"] == MATURE.share_count
            assert response.json()["scenarios"]["base"]["value"] > 0
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    assert (
        ValuationEvidenceTools(binding, frozen).get_valuation_basis().basis.shares
        == MATURE.share_count
    )


@pytest.mark.parametrize("venue", [None, "OTC Markets", "NasdaqGS", "NYSE"])
def test_receipt_requires_its_reviewed_venue(tmp_path, venue):
    issuer = replace(MATURE, ticker="BABA", share_count=800)

    def inject(batches):
        metrics = batches["research/fundamentals.json"]["rows"][0]["metrics"]
        metrics["fullExchangeName"] = venue
        raw = batches["research/financials.json"]["rows"][0]["financials"]
        ends = raw["quarterlyIncomeStatement"][0].keys() - {"index"}
        raw["quarterlyBalanceSheet"] = [
            {"index": "Ordinary Shares Number", **dict.fromkeys(ends, 800)}
        ]

    store = ArtifactStore(tmp_path)
    binding = _publish(store, issuer, inject=inject)
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    basis = ValuationEvidenceTools(binding, frozen).get_valuation_basis().basis
    if venue == "NYSE":
        assert (basis.shares, basis.ordinary_per_receipt) == (100, 8)
    else:
        assert basis is None


def _batch_row(batches, issuer, listing):
    from trading_max.research.fundamentals import build_valuation

    fundamental = batches["research/fundamentals.json"]["rows"][0]
    fundamental["metrics"]["sharesOutstanding"] = issuer.share_count
    raw = batches["research/financials.json"]["rows"][0]["financials"]
    raw["evidence"] = {
        "listedShareUnits": {listing: "ordinary"},
        "shareUnitFiling": "https://issuer.invalid/cover",
    }
    batch = build_valuation(
        {
            "tickers": [issuer.ticker],
            "rows": [
                {"ticker": issuer.ticker, "price": issuer.raw_spot, "currency": issuer.quote_unit}
            ],
        },
        batches["research/fundamentals.json"],
        financials=batches["research/financials.json"],
    )
    row = batch.rows[0]
    batches["research/valuation.json"]["rows"] = [row]
    return row


@pytest.mark.parametrize(
    ("symbol", "venue", "zone", "ccy", "market"),
    [
        ("SYN-B.CO", "Copenhagen", "Europe/Copenhagen", "DKK", "XCSE"),
        ("SYN-B.ST", "Stockholm", "Europe/Stockholm", "SEK", "XSTO"),
        ("SYN.HE", "Helsinki", "Europe/Helsinki", "EUR", "XHEL"),
        ("SYN.OL", "Oslo", "Europe/Oslo", "NOK", "XOSL"),
        ("SYN.LS", "Lisbon", "Europe/Lisbon", "EUR", "XLIS"),
        ("SYN.VI", "Vienna", "Europe/Amsterdam", "EUR", "XWBO"),
        ("SYN.WA", "Warsaw", "Europe/Warsaw", "PLN", "XWAR"),
    ],
)
def test_local_ordinary_venue_serves_batch_and_preview(tmp_path, symbol, venue, zone, ccy, market):
    issuer = replace(MATURE, ticker=symbol, quote_unit=ccy, reporting=ccy)
    listing = f"{market}:{symbol}"
    result = {}

    def inject(batches):
        batches["research/fundamentals.json"]["rows"][0]["metrics"].update(
            fullExchangeName=venue, exchangeTimezoneName=zone
        )
        result.update(_batch_row(batches, issuer, listing))

    store = ArtifactStore(tmp_path)
    _publish(store, issuer, inject=inject)
    assert result["assumptions"]["listing"] == listing
    assert result["ev5"] > 0
    req = _request()
    desk = _desk(store, issuer, req)
    assert desk["basis"]["currency"] == ccy
    assert desk["basis"]["shares"] == issuer.share_count


@pytest.mark.parametrize("revenue", [None, 0, -200, 100])
@pytest.mark.parametrize("incomplete_latest", [False, True])
def test_residual_period_and_roe_ignore_revenue_in_batch_desk_and_evidence(
    tmp_path, revenue, incomplete_latest
):
    issuer = replace(MATURE, ticker="SOFI")
    result = {}

    def inject(batches):
        raw = batches["research/financials.json"]["rows"][0]["financials"]
        ends = raw["quarterlyIncomeStatement"][0].keys() - {"index"}
        inc = "Net Income Common Stockholders"
        book = "Common Stock Equity"
        raw["quarterlyIncomeStatement"] = [{"index": inc, **dict.fromkeys(ends, 25)}]
        if revenue is not None or incomplete_latest:
            raw["quarterlyIncomeStatement"].append(
                {
                    "index": "Total Revenue",
                    **dict.fromkeys(ends, 0 if incomplete_latest else revenue),
                }
            )
        if not incomplete_latest:
            raw["quarterlyBalanceSheet"] = [{"index": book, **dict.fromkeys(ends, 500)}]
        raw["incomeStatement"] = [{"index": inc, "2024-12-31": 100}]
        if revenue is not None:
            raw["incomeStatement"].append({"index": "Total Revenue", "2024-12-31": revenue})
        raw["balanceSheet"] = [{"index": book, "2024-12-31": 500}]
        result.update(_batch_row(batches, issuer, issuer.listing))

    store = ArtifactStore(tmp_path)
    binding = _publish(store, issuer, inject=inject)
    period = "annual:2024-12-31" if incomplete_latest else "ttm:2025-12-31"
    assert result["ev5"] is not None, result["model_warnings"]
    assert result["assumptions"]["periodId"] == period
    assert result["assumptions"]["reverseMetric"] == "initial-roe"
    req = EvaluateValuationRequest(
        scenarios={
            key: {"initialRoe": 0.2, "discountRate": 0.1, "terminalPb": 1, "payout": 0}
            for key in ("bear", "base", "bull")
        }
    )
    desk = _desk(store, issuer, req)
    frozen = freeze_valuation_evidence(binding, snapshots=store)
    tools = ValuationEvidenceTools(binding, frozen)
    basis = tools.get_valuation_basis().basis
    assert basis.period_id == desk["basis"]["periodId"] == period
    assert basis.period_choice == desk["basis"]["periodChoice"]
    scoped = binding.model_copy(
        update={"permitted_fields": binding.permitted_fields - {Metric.REVENUE}}
    )
    scoped_frozen = freeze_valuation_evidence(scoped, snapshots=store)
    scoped_basis = ValuationEvidenceTools(scoped, scoped_frozen).get_valuation_basis().basis
    assert (scoped_basis.period_id, scoped_basis.period_choice) == (
        basis.period_id,
        basis.period_choice,
    )
    evaluated = tools.evaluate_valuation(req)
    assert evaluated.reverse_dcf.metric == desk["reverseMetric"] == "initial-roe"
    _equal(evaluated.projections["base"].model_dump(), desk["scenarios"]["base"])
