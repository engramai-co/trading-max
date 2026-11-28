"""Select observations from the same sector board or regional map that was inspected."""

import json
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import Field, field_validator

from ..index_models import GlobalMapMarket
from ..sector_models import SectorGroupingKind, SectorMarketCode
from ..sector_sessions import MARKETS
from . import events, tools
from .overview_roles import line
from .roles import LinkedObservation, PageRole, RoleContext, RoleTools, bind_selection


class MarketContext(RoleContext):
    observed: str = Field(max_length=40)

    @field_validator("observed")
    @classmethod
    def observed_instant(cls, value):
        if datetime.fromisoformat(value).utcoffset() is None:
            raise ValueError("Market observations need an offset")
        return value


class RegionalMapContext(MarketContext):
    variant_fields = frozenset({"market"})
    market: GlobalMapMarket | None = None


class SectorContext(MarketContext):
    market: SectorMarketCode | Literal["global"]
    grouping: SectorGroupingKind
    sector: str = Field(min_length=1, max_length=80, pattern=r"^[\w .&/-]+$")


def market_sector(ctx: tools.Context, args: SectorContext):
    """Inspect a matching regional or world sector at the observed board timestamp."""
    read = tools._Read(ctx.deps, "market_sector", args, "market")
    sources = ctx.deps.page_sources
    stamp = datetime.fromisoformat(args.observed)
    if sources and args.market == "global":
        board = sources.world()
        if board and board.as_of == stamp and not board.prices_stale and args.grouping == "gics":
            sector = next((s for s in board.sectors if s.gics == args.sector), None)
            if sector:
                return read.result(
                    data={
                        "day": str(board.reference_date),
                        "name": sector.name,
                        "move": sector.move,
                        "weight": sector.weight,
                        "weights_as_of": str(board.weights_as_of) if board.weights_as_of else None,
                        "weight_stale": board.weights_stale,
                        "contribution": sector.contribution,
                    }
                )
    elif sources:
        board = sources.board(args.market)
        if board and board.market == args.market and board.fetched_at == stamp:
            group = next(
                (
                    s
                    for g in board.groupings
                    if g.kind == args.grouping
                    for s in g.groups
                    if s.key == args.sector
                ),
                None,
            )
            if group:
                exposure = None
                if {"broker_total", "invest", "isa"}.issubset(
                    ctx.deps.allowed_scopes
                ) and board.exposure_basis_gbp:
                    exposure = group.exposure_gbp
                return read.result(
                    data={
                        "day": board.session_date,
                        "name": group.name,
                        "move": group.change,
                        "breadth": group.breadth.model_dump(),
                        "exposure": exposure,
                        "leader": group.leader.model_dump() if group.leader else None,
                        "news_ticker": next(
                            (
                                m.research_ticker
                                for m in group.members
                                if group.leader and m.symbol == group.leader.symbol
                            ),
                            None,
                        ),
                    }
                )
    return read.missing("board_observation_changed")


def sector_headline(ctx: tools.Context, args: SectorContext):
    """Read the selected sector leader's published headline as of the inspected board."""
    read = tools._Read(ctx.deps, "sector_headline", args, "market")
    if not {"broker_total", "invest", "isa"}.issubset(ctx.deps.allowed_scopes):
        return read.missing("headline_unavailable")
    board = market_sector(ctx, args).get("data") or {}
    if not (ticker := board.get("news_ticker")) or not (day := board.get("day")):
        return read.missing("headline_unavailable")
    if args.market == "global":
        return read.missing("headline_unavailable")
    query = events.EventArgs(ticker=ticker, scope="broker_total", start=day, end=day, limit=20)
    zone = ZoneInfo(MARKETS[args.market].timezone)
    while True:
        event = events.event_data(ctx.deps, query, upcoming=False, session_zone=zone)
        data = event.get("data") or {}
        row = next(
            (
                r
                for r in data.get("items", [])
                if r.get("kind") == "news"
                and r.get("publisher")
                and r.get("source_url")
                and (
                    not r.get("instant")
                    or datetime.fromisoformat(r["instant"]) <= datetime.fromisoformat(args.observed)
                )
            ),
            None,
        )
        cursor = data.get("next_cursor")
        if row or cursor is None:
            break
        query = query.model_copy(update={"cursor": cursor})
    if not row:
        return read.missing("headline_unavailable")
    return {
        **read.result(data={"items": [row], "day": day, "ticker": ticker}),
        "sources": event["sources"],
        "quality": event["quality"],
    }


def sector_facts(read: RoleTools, context: SectorContext):
    result = read.read(market_sector, {})
    data = result.get("data") or {}
    if not data:
        return []
    day = data["day"]
    if context.market == "global":
        figures = [
            data["weight"],
            data["weights_as_of"],
            data["weight_stale"],
            data["contribution"],
        ]
    else:
        breadth = data["breadth"]
        figures = [breadth["up"], breadth["flat"], breadth["down"], data["exposure"]]
    board_record = json.dumps([day, data["name"], data["move"], *figures])
    facts = []

    def add(section, zh, en, source="market"):
        facts.append(
            line(
                section,
                zh,
                en,
                result,
                source,
                "market_sector",
                metric=section,
                boardRecord=board_record,
                **context.model_dump(exclude_none=True),
            )
        )

    if (move := data.get("move")) is not None:
        add(
            "move",
            f"{day}，板块涨跌 {move:+.2%}。",
            f"The sector moved {move:+.2%} in the {day} session.",
        )
    if (breadth := data.get("breadth")) and sum(breadth.values()):
        up, flat, down = breadth["up"], breadth["flat"], breadth["down"]
        add(
            "breadth",
            f"有报价的成分中，{up} 家上涨、{flat} 家持平、{down} 家下跌。",
            f"Among quoted constituents, {up} rose, {flat} were flat and {down} fell.",
        )
    if (exposure := data.get("exposure")) is not None:
        add(
            "exposure",
            f"按板块成分匹配的组合敞口为 £{exposure:,.2f}。",
            f"Portfolio exposure matched to these constituents was £{exposure:,.2f}.",
            "exposure",
        )
    if (weight := data.get("weight")) is not None and data.get("weights_as_of"):
        stale_zh, stale_en = (
            ("（权重待更新）", " (stale weights)") if data["weight_stale"] else ("", "")
        )
        add(
            "weight",
            f"MSCI World (SWDA) 截至 {data['weights_as_of']} 的权重为 {weight:.2%}{stale_zh}。",
            f"The MSCI World (SWDA) weight was {weight:.2%} on {data['weights_as_of']}{stale_en}.",
        )
    if (contribution := data.get("contribution")) is not None and not data["weight_stale"]:
        add(
            "contribution",
            f"对 MSCI World 的估算贡献为 {contribution * 100:+.2f} 个百分点。",
            f"Estimated contribution to MSCI World was {contribution * 100:+.2f} pp.",
        )
    if data.get("news_ticker"):
        event = read.read(sector_headline, {})
        if items := (event.get("data") or {}).get("items"):
            row = items[0]
            ticker = data["news_ticker"]
            lead = line(
                "news",
                f"{day} · {ticker} 相关新闻：{row['title_zh']}",
                f"{day} · {ticker} headline: {row['title_en']}",
                event,
                "publisher",
                "sector_headline",
                ticker=ticker,
                metric="headline",
                start=day,
                end=day,
                url=row["source_url"],
                **({"instant": row["instant"]} if row.get("instant") else {}),
                **context.model_dump(),
            )
            lead.evidence.publisher = row["publisher"][:80]
            facts.append(lead)
    return facts


def global_map(ctx: tools.Context, args: RegionalMapContext):
    """Read one published global session and its estimated ACWI contributions."""
    read = tools._Read(ctx.deps, "global_map", args, "market")
    board = ctx.deps.page_sources.regions() if ctx.deps.page_sources else None
    if (
        not board
        or not board.as_of
        or board.as_of != datetime.fromisoformat(args.observed)
        or board.prices_stale
    ):
        return read.missing("map_observation_changed")
    rows = {
        r.market: r.contribution for r in board.rows if not r.not_open and not board.weights_stale
    }
    return read.result(
        data={
            "day": str(board.reference_date),
            "markets": [
                {
                    "market": m.market,
                    "move": m.move,
                    "not_open": m.not_open,
                    "contribution": rows.get(m.market),
                }
                for m in board.markets
                if args.market is None or m.market == args.market
            ],
        }
    )


def map_facts(read: RoleTools, context: RegionalMapContext):
    result = read.read(global_map, {})
    data = result.get("data") or {}
    if not data.get("markets"):
        return []
    variants = {}
    for row in data["markets"]:
        market = row["market"]
        selection = context.model_copy(update={"market": market})
        variant = read.for_variant(selection).read(global_map, {})
        if markets := (variant.get("data") or {}).get("markets"):
            variants[market] = (markets[0], variant)
    # Each selected editorial angle covers every market in the inspected map.
    facts = []
    for section in ("contribution", "move"):
        item = line(
            section,
            "市场贡献" if section == "contribution" else "本地行情",
            "Contribution to MSCI ACWI" if section == "contribution" else "Local index move",
            result,
            "market",
            "global_map",
            metric=section,
            **context.model_dump(exclude_none=True),
        )
        for m, variant in variants.values():
            day = variant["data"]["day"]
            if m["not_open"]:
                zh, en = (
                    f"{day} 参考时段内本地市场尚未开盘。",
                    f"The local market had not opened in the {day} reference session.",
                )
            elif section == "contribution" and (pp := m["contribution"]) is not None:
                zh, en = (
                    f"{day} 对 MSCI ACWI 的估算贡献为 {pp * 100:+.2f} 个百分点。",
                    f"Estimated contribution to MSCI ACWI on {day} was {pp * 100:+.2f} pp.",
                )
            elif (move := m["move"]) is not None:
                zh, en = (
                    f"{day} 本地指数涨跌 {move:+.2%}。",
                    f"The local index moved {move:+.2%} on {day}.",
                )
            else:
                zh, en = (
                    f"{day} 缺少本地指数报价。",
                    f"A local index quote was unavailable on {day}.",
                )
            item.variants[m["market"]] = LinkedObservation(
                zh=zh,
                en=en,
                evidence=item.evidence.model_copy(
                    update={
                        "evidence_id": variant["evidence_id"],
                        "arguments": {
                            **item.evidence.arguments,
                            "market": m["market"],
                            "boardRecord": json.dumps(
                                [day, m["move"], m["not_open"], m["contribution"]]
                            ),
                        },
                    }
                ),
            )
        # The model sees the observations behind both editorial angles in one run.
        item.en += ". " + " ".join(
            f"{market.upper()}: {value.en}" for market, value in item.variants.items()
        )
        facts.append(item)
    return facts


class MarketRole(PageRole):
    @property
    def cache_id(self) -> str:
        return "board-record:" + super().cache_id


MARKET_ROLES = (
    MarketRole(
        "market-sector",
        "sectors",
        frozenset({"market_sector", "sector_headline"}),
        SectorContext,
        "Choose one observation from each section, up to four. Keep news as a separate dated lead, never an explanation for a move.",
        sector_facts,
        data_version=lambda reader, _: "exchange-session-v2:" + reader.deps.snapshot_id,
        tool_bindings=bind_selection("market_sector", "sector_headline"),
    ),
    MarketRole(
        "market-map",
        "sectors",
        frozenset({"global_map"}),
        RegionalMapContext,
        "Order the two regional-map angles by relevance, starting with estimated contribution where published.",
        map_facts,
        tool_bindings=bind_selection("global_map"),
    ),
)
