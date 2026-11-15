"""The research desk's index lenses; the portfolio is joined only on the server."""

from __future__ import annotations

from collections import defaultdict
from contextlib import suppress
from datetime import date, datetime, timedelta
from functools import lru_cache

import pandas as pd
from pydantic import Field
from trading_max.infrastructure.fund_tracking_import import DailyTracking
from trading_max.reference.fund_benchmarks import FUND_BENCHMARKS, FundBenchmark
from trading_max.reference.indices import INDEX_REGISTRY, IndexSpec
from trading_max.research.facts import number
from trading_max.research.fund_references import us_fund
from trading_max.research.listing import broker_listing
from trading_max.research.technical import analyze_ticker

from .dashboard_models import TechnicalScoreSummary
from .etf_snapshot import read_etf_detail, read_etf_portfolio
from .index_models import (
    IndexBasket,
    IndexComposition,
    IndexConstituent,
    IndexContribution,
    IndexExposure,
    IndexLens,
    IndexProduct,
    IndexQuote,
    IndexResearch,
)
from .indices import BROKER_KEY, IndexService, index_identity
from .models import ApiModel
from .projections.research import technical_rows

_LOOKTHROUGH = "account/lookthrough_metrics.json"


def _relationship(spec: IndexSpec, mapping: FundBenchmark):
    target = INDEX_REGISTRY[mapping.benchmark_id]
    compare = INDEX_REGISTRY.get(mapping.comparison_id or "")
    if target.id == spec.id and mapping.relation != "unconfirmed":
        return "same-benchmark", "exact"
    if target.family == spec.family:
        return (
            "same-family",
            "unconfirmed" if mapping.relation == "unconfirmed" else "same-family-other-variant",
        )
    if compare and compare.family == spec.family:
        return (
            "related" if mapping.relation == "related-different-structure" else "similar",
            mapping.relation,
        )
    return None


def _products(service: IndexService, spec: IndexSpec, run_id: str | None, *, full: bool):
    holdings = {}
    position_value = defaultdict(float)
    if run_id:
        with suppress(FileNotFoundError):
            broker = service.store.read_json(run_id, BROKER_KEY)
            for account in broker.get("accounts", {}).values():
                for position in account.get("positions", []):
                    isin = position.get("isin")
                    value = number(position.get("current_value_gbp"))
                    if not isin or value is None or value <= 0:
                        continue
                    position_value[isin] += value
                    holdings.setdefault(isin, position)
    readings = (
        {row.isin: row for row in read_etf_portfolio(service.store, run_id).funds} if run_id else {}
    )
    products = []
    for mapping in FUND_BENCHMARKS.values():
        relationship = _relationship(spec, mapping)
        if relationship is None:
            continue
        group, relation = relationship
        held = holdings.get(mapping.isin)
        reading = readings.get(mapping.isin)
        reference = us_fund(mapping.ticker) if mapping.domicile == "US" else None
        holding_ticker = held.get("ticker") if held else None
        if (
            held
            and (listing := broker_listing(held.get("broker_ticker")))
            and listing.startswith("LSE:")
        ):
            holding_ticker = listing.removeprefix("LSE:") + ".L"
        ticker = holding_ticker or (
            mapping.ticker + ".L" if mapping.domicile == "IE" else mapping.ticker
        )
        profile = None
        if full and run_id and reading:
            with suppress(FileNotFoundError):
                detail = read_etf_detail(service.store, run_id, mapping.isin, include_holdings=True)
                profile = detail.holdings.profile if detail.holdings else None
        difference = None
        if full and relation == "exact":
            local = (
                service.root.parent.parent
                / "reference"
                / "fund-tracking"
                / (mapping.isin + ".json")
            )
            with suppress(OSError, ValueError):
                data = DailyTracking.model_validate_json(local.read_bytes())
                if data.isin == mapping.isin and data.benchmark_id == spec.id and data.summary:
                    difference = data.summary.tracking_difference
        size = (profile.share_class_size or profile.fund_size) if profile else None
        products.append(
            IndexProduct(
                isin=mapping.isin,
                ticker=ticker,
                name=(reading.name if reading else None)
                or (held.get("name") if held else None)
                or (reference.name if reference else None)
                or mapping.ticker,
                benchmark_id=mapping.benchmark_id,
                group="held" if held else group,
                relationship=relation,
                evidence_url=mapping.evidence_url,
                evidence_date=mapping.evidence_date,
                share_currency=mapping.share_currency,
                domicile=mapping.domicile,
                hedged=mapping.hedged,
                expense_ratio=(profile.expense_ratio if profile else None)
                or (reading.expense_ratio if reading else None),
                replication=profile.replication if profile else None,
                income_use=(profile.income_use if profile else None)
                or (reading.income_use if reading else None),
                size=size.amount if size else None,
                size_currency=size.currency if size else None,
                size_basis=("share-class" if profile.share_class_size else "fund")
                if size
                else None,
                tracking_difference=difference,
                value_gbp=round(position_value[mapping.isin], 2) if held else None,
            )
        )
    order = {"held": 0, "same-benchmark": 1, "same-family": 2, "similar": 3, "related": 4}
    return sorted(
        products,
        key=lambda row: (
            order[row.group],
            row.domicile != "IE",
            -float(row.value_gbp or 0),
            row.ticker,
        ),
    )


def _london(ticker: str, spec: IndexSpec) -> str:
    return ticker if spec.scope != "uk" or ticker.endswith(".L") else ticker + ".L"


def _listed_basket(service: IndexService, spec: IndexSpec, basket: IndexBasket, *, full: bool):
    ids = {}
    if spec.basket:
        with suppress(Exception):
            universe = service.universes.get(spec.basket)
            if universe.as_of == basket.holdings_date:
                ids = {row.symbol: row for row in universe.constituents}
    rows = []
    for member in sorted(basket.members, key=lambda row: -row.weight):
        if member.weight <= 0:
            continue
        description = ids.get(member.key)
        rows.append(
            IndexConstituent(
                ticker=_london(member.key, spec),
                name=member.name,
                isin=description.isin or None if description else None,
                weight=member.weight,
                move=member.contribution / member.weight
                if member.contribution is not None
                else None,
                contribution=member.contribution,
                industry=description.sector_name if description else None,
            )
        )
    members_with_quotes = [row for row in rows if row.move is not None]
    highs = (
        service.depth.new_highs_lows(
            spec.scope, basket.session_date, {row.ticker for row in members_with_quotes}
        )
        if full
        else None
    )
    waterfall = []
    if basket.estimated_move is not None:
        waterfall = [*basket.laggards, *basket.leaders]
        rest = basket.estimated_move - sum(item.contribution or 0 for item in waterfall)
        waterfall.append(
            IndexContribution(
                key="rest",
                name="Other covered constituents",
                weight=max(0, basket.coverage - sum(row.weight for row in waterfall)),
                contribution=rest,
            )
        )
        if basket.residual is not None:
            waterfall.append(
                IndexContribution(
                    key="residual",
                    name="Reconciliation residual",
                    weight=0,
                    contribution=basket.residual,
                )
            )
    return IndexComposition(
        source=basket.fund,
        source_url=basket.source_url,
        holdings_date=basket.holdings_date,
        session_date=basket.session_date,
        as_of=basket.as_of,
        coverage=basket.coverage,
        basket_basis="market-proxy" if basket.proxy_universe else "issuer-portfolio",
        weighting="price" if spec.id == "nikkei-225" else "cap" if spec.basket else "other",
        members=rows,
        up=basket.breadth.up,
        flat=basket.breadth.flat,
        down=basket.breadth.down,
        uncovered=len(rows) - len(members_with_quotes),
        highs_52w=highs[0] if highs else None,
        lows_52w=highs[1] if highs else None,
        eligible_52w=highs[2] if highs else None,
        equal_weight_move=(
            sum(row.move for row in members_with_quotes) / len(members_with_quotes)
            if members_with_quotes
            else None
        ),
        cap_weight_move=basket.estimated_move,
        total_move=basket.estimated_move + basket.residual
        if basket.estimated_move is not None and basket.residual is not None
        else None,
        waterfall=waterfall,
    )


def _issuer_basket(service: IndexService, spec: IndexSpec, run_id: str) -> IndexComposition | None:
    for mapping in FUND_BENCHMARKS.values():
        if (
            mapping.domicile != "IE"
            or mapping.relation != "exact"
            or INDEX_REGISTRY[mapping.benchmark_id].family != spec.family
        ):
            continue
        try:
            snapshot = read_etf_detail(service.store, run_id, mapping.isin).holdings
        except FileNotFoundError:
            continue
        if not snapshot or not snapshot.as_of:
            continue
        folded: dict[str, IndexConstituent] = {}
        for member in snapshot.holdings:
            if not member.is_equity:
                continue
            key = member.isin or member.ticker
            if not key:
                continue
            if key in folded:
                folded[key].weight += member.weight_pct / 100
                continue
            folded[key] = IndexConstituent(
                ticker=member.ticker or member.isin,
                name=member.name,
                isin=member.isin or None,
                weight=member.weight_pct / 100,
                industry=member.industry,
                country=member.country,
            )
        if folded:
            return IndexComposition(
                source=mapping.ticker,
                source_url=snapshot.source_url or mapping.evidence_url,
                holdings_date=snapshot.as_of,
                basket_basis="issuer-portfolio",
                members=sorted(folded.values(), key=lambda row: -row.weight),
            )
    return None


class _NikkeiComponent(ApiModel):
    ticker: str = Field(pattern=r"^[0-9A-Z]{4,5}\.T$")
    name: str
    isin: str | None = None
    prior_adjusted_price: float = Field(gt=0, allow_inf_nan=False)
    move: float | None = Field(default=None, ge=-1, allow_inf_nan=False)


class _NikkeiWeights(ApiModel):
    holdings_date: date
    session_date: date
    as_of: datetime
    index_as_of: datetime | None = None
    index_move: float | None = Field(default=None, ge=-1, allow_inf_nan=False)
    members: list[_NikkeiComponent] = Field(min_length=225, max_length=225)


def _nikkei_basket(service: IndexService) -> IndexComposition | None:
    path = service.root.parent.parent / "reference" / "index-constituents" / "nikkei-225.json"
    try:
        data = _NikkeiWeights.model_validate_json(path.read_bytes())
    except (OSError, ValueError):
        return None
    if (
        data.as_of.tzinfo is None
        or data.as_of > service.now()
        or data.holdings_date > data.session_date
        or len({item.ticker for item in data.members}) != len(data.members)
    ):
        return None
    normalizer = sum(row.prior_adjusted_price for row in data.members)
    rows = sorted(
        [
            IndexConstituent(
                ticker=row.ticker,
                name=row.name,
                isin=row.isin,
                weight=row.prior_adjusted_price / normalizer,
                move=row.move,
                contribution=row.move * row.prior_adjusted_price / normalizer
                if row.move is not None
                else None,
            )
            for row in data.members
        ],
        key=lambda row: -row.weight,
    )
    priced = [row for row in rows if row.move is not None]
    total = sum(row.contribution for row in priced)
    reconciles = (
        data.index_move is not None
        and data.index_as_of
        and data.index_as_of.tzinfo
        and abs(data.index_as_of - data.as_of) <= timedelta(minutes=5)
    )
    waterfall = []
    if priced:
        ranked = sorted(priced, key=lambda row: row.contribution)
        extremes = [
            *[r for r in ranked if r.contribution < 0][:5],
            *[r for r in reversed(ranked) if r.contribution > 0][:5],
        ]
        waterfall = [
            IndexContribution(
                key=row.ticker, name=row.name, weight=row.weight, contribution=row.contribution
            )
            for row in extremes
        ]
        waterfall.append(
            IndexContribution(
                key="rest",
                name="Other covered constituents",
                weight=max(
                    0, sum(row.weight for row in priced) - sum(row.weight for row in extremes)
                ),
                contribution=total - sum(row.contribution for row in extremes),
            )
        )
        if reconciles:
            waterfall.append(
                IndexContribution(
                    key="residual",
                    name="Price-weighted reconciliation residual",
                    weight=0,
                    contribution=data.index_move - total,
                )
            )
    return IndexComposition(
        source="Nikkei",
        source_url="https://indexes.nikkei.co.jp/nkave/data/index.en.html",
        holdings_date=data.holdings_date.isoformat(),
        session_date=data.session_date.isoformat(),
        as_of=data.as_of,
        coverage=sum(row.weight for row in priced),
        basket_basis="official",
        weighting="price",
        members=rows,
        up=sum(row.move > 0.0005 for row in priced),
        flat=sum(abs(row.move) <= 0.0005 for row in priced),
        down=sum(row.move < -0.0005 for row in priced),
        uncovered=len(rows) - len(priced),
        equal_weight_move=sum(row.move for row in priced) / len(priced) if priced else None,
        price_weight_move=total if priced else None,
        total_move=data.index_move if reconciles and priced else None,
        waterfall=waterfall,
    )


def _exposure(service: IndexService, run_id: str, members: list[IndexConstituent]):
    known = {row.isin for row in members if row.isin}
    if not known:
        return None
    try:
        account = service.store.read_json(run_id, _LOOKTHROUGH)
    except FileNotFoundError:
        return None
    as_of = account.get("brokerAsOf")
    if not as_of or not account.get("available"):
        return None
    direct = indirect = 0.0
    matched = set()
    for row in account.get("positions", []):
        isin = row.get("isin")
        if isin not in known:
            continue
        matched.add(isin)
        direct += number(row.get("directValueGbp")) or 0
        indirect += number(row.get("indirectValueGbp")) or 0
    return IndexExposure(
        as_of=as_of,
        direct_gbp=round(direct, 2),
        look_through_gbp=round(indirect, 2),
        total_gbp=round(direct + indirect, 2),
        matched_isins=len(matched),
    )


@lru_cache(maxsize=96)
def _score(index_id: str, currency: str, rows: tuple[tuple[datetime, float], ...]):
    if len(rows) < 50:
        return None
    frame = pd.DataFrame(
        {
            "Close": [row[1] for row in rows],
            "High": float("nan"),
            "Low": float("nan"),
            "Volume": float("nan"),
        },
        index=pd.DatetimeIndex([row[0] for row in rows]),
    )
    frame.attrs["asset_type"] = "INDEX"
    artifact = analyze_ticker(
        index_id, index_id, frame, {}, currency=currency, requested_period="1y"
    )
    row = technical_rows({"rows": [artifact.model_dump(by_alias=False)]})[0]
    return TechnicalScoreSummary.model_validate(row)


def index_research(service: IndexService, spec: IndexSpec, lens: IndexLens) -> IndexResearch:
    identity = next(
        (item for item in service.catalog() if item.id == spec.id), index_identity(spec)
    )
    response = IndexResearch(index=identity, depth="L1" if identity.history_years else "L0")
    manifest = service.store.latest_manifest()
    run_id = manifest.run_id if manifest else None
    family = INDEX_REGISTRY.get(spec.family, spec)
    price_index = family if family.variant == "PR" else spec if spec.variant == "PR" else None
    if lens in {"overview", "tracking"}:
        response.products = _products(service, spec, run_id, full=lens == "tracking")
    if lens in {"overview", "constituents"}:
        context = service.context(spec if spec.basket else family)
        basket = context.basket
        response.valuation = context.valuation
        composition = (
            _listed_basket(service, spec, basket, full=lens == "constituents")
            if basket
            else _issuer_basket(service, spec, run_id)
            if run_id
            else None
        )
        if spec.id == "nikkei-225":
            composition = _nikkei_basket(service)
        if composition:
            response.depth = "L2"
            if run_id and composition.basket_basis != "market-proxy":
                response.exposure = _exposure(service, run_id, composition.members)
            response.composition = (
                composition
                if lens == "constituents"
                else composition.model_copy(
                    update={"members": composition.members[:10], "waterfall": []},
                )
            )
    if lens == "overview":
        quote = None
        if spec.market_visible and spec.symbol:
            quote = next(
                (row for row in service.market(spec.scope).quotes if row.index.id == spec.id), None
            )
        dated = service.history(spec, "1Y", False)
        if (quote is None or quote.level is None) and dated.points:
            last = dated.points[-1]
            quote = IndexQuote(
                index=identity,
                level=last.value,
                as_of=last.at,
                session_date=last.at.date().isoformat(),
                state="stale" if dated.state == "stale" else "observed",
            )
            if len(dated.points) > 1 and dated.display_interval == "1d":
                quote.change = last.value / dated.points[-2].value - 1
        response.quote = quote
        if len(dated.points) > 1 and response.depth == "L0":
            response.depth = "L1"
        if price_index and price_index.kind == "index":
            basis = (
                dated if price_index.id == spec.id else service.history(price_index, "1Y", False)
            )
            if basis.source_interval == "1d":
                with suppress(ValueError, IndexError):
                    response.technical = _score(
                        price_index.id,
                        price_index.currency or "",
                        tuple((row.at, row.value) for row in basis.points),
                    )
    return response
