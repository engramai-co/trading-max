"""Fictional holdings and sector movements for the bundled demonstration."""

from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from services.api.trading_max_api.sector_models import (
    SectorBoard,
    SectorBreadth,
    SectorGroup,
    SectorGrouping,
    SectorLeader,
    SectorMarketCode,
    SectorMember,
    SectorSource,
)
from services.api.trading_max_api.sector_monitor import SectorBoardStore
from services.api.trading_max_api.sector_sessions import latest_session

# Names and tickers are recognizable; all weights, prices and account data are invented.
# (sector code, name, representative symbol and company, weight %, session move %)
SECTORS = (
    ("45", "Information Technology", "NVDA", "NVIDIA", 30, 1.24),
    ("40", "Financials", "JPM", "JPMorgan Chase", 14, -0.36),
    ("35", "Health Care", "LLY", "Eli Lilly", 11, 0.52),
    ("25", "Consumer Discretionary", "AMZN", "Amazon", 11, 0.88),
    ("50", "Communication Services", "GOOGL", "Alphabet", 10, 0.34),
    ("20", "Industrials", "BE", "Bloom Energy", 8, -0.72),
    ("30", "Consumer Staples", "PG", "Procter & Gamble", 6, 0.12),
    ("10", "Energy", "XOM", "Exxon Mobil", 4, -1.08),
    ("55", "Utilities", "NEE", "NextEra Energy", 2, 0.42),
    ("60", "Real Estate", "PLD", "Prologis", 2, 0.01),
    ("15", "Materials", "LIN", "Linde", 2, -0.18),
)
EU_SECTORS = (
    ("40", "Financials", "EUSYN40.SW", "Synthetic European Bank", 24, 0.86),
    ("20", "Industrials", "EUSYN20.DE", "Synthetic Engineering", 18, -0.42),
    ("35", "Health Care", "EUSYN35.CO", "Synthetic Life Sciences", 15, 1.12),
    ("30", "Consumer Staples", "EUSYN30.L", "Synthetic Foods", 9, -0.27),
    ("45", "Information Technology", "EUSYN45.AS", "Synthetic Semiconductors", 8, 0.71),
    ("25", "Consumer Discretionary", "EUSYN25.PA", "Synthetic Retail", 7, -0.52),
    ("10", "Energy", "EUSYN10.L", "Synthetic Energy", 6, 0.33),
    ("55", "Utilities", "EUSYN55.MC", "Synthetic Utilities", 5, 0.18),
    ("15", "Materials", "EUSYN15.ST", "Synthetic Materials", 4, -0.46),
    ("50", "Communication Services", "EUSYN50.DE", "Synthetic Telecom", 3, -0.68),
    ("60", "Real Estate", "EUSYN60.BR", "Synthetic Properties", 1, 0.08),
)
# (ticker, name, quantity, GBP value, GBP cost, sector; None means a fund)
INVEST = (
    ("BE", "Bloom Energy", 2, 320, 280, "20"),
    ("NVDA", "NVIDIA", 2, 230, 185, "45"),
    ("MSFT", "Microsoft", 0.5, 155, 140, "45"),
    ("GOOGL", "Alphabet", 1, 115, 128, "50"),
    ("AAPL", "Apple", 0.5, 95, 105, "45"),
    ("JPM", "JPMorgan Chase", 0.5, 85, 78, "40"),
)
ISA = (
    ("VWRP", "Vanguard FTSE All-World", 2, 250, 230, None),
    ("VUAG", "Vanguard S&P 500", 2, 190, 170, None),
    ("XUSE", "iShares MSCI World ex-USA", 25, 150, 160, None),
    ("EIMI", "iShares Core MSCI Emerging Markets", 4, 110, 105, None),
)


def seed_accounts(report: Path, as_of: datetime) -> dict[str, tuple[float, float]]:
    broker_path = report / "broker_snapshot_metrics.json"
    broker = json.loads(broker_path.read_text(encoding="utf-8"))
    broker["as_of"] = broker["generated_at_utc"] = as_of.isoformat()
    funds = []
    direct = []
    industries = defaultdict(float)
    sector_names = {code: name for code, name, *_ in SECTORS}
    totals = {}
    for code, holdings in (("A", INVEST), ("B", ISA)):
        account = broker["accounts"][code]
        cash = account["cash_gbp"]
        positions = []
        for ticker, name, quantity, value, cost, sector in holdings:
            is_fund = sector is None
            positions.append(
                {
                    "ticker": ticker,
                    "name": name,
                    "quantity": quantity,
                    "current_price": round(value / quantity * (1 if is_fund else 1.25), 4),
                    "price_currency": "GBP" if is_fund else "USD",
                    "current_value_gbp": value,
                    "total_cost_gbp": cost,
                    "unrealized_profit_loss_gbp": value - cost,
                }
            )
            if is_fund:
                funds.append({"ticker": ticker})
            else:
                direct.append(
                    {
                        "isin": None,
                        "ticker": ticker,
                        "name": name,
                        "country": "United States",
                        "valueGbp": value,
                        "directValueGbp": value,
                        "indirectValueGbp": 0,
                        "etfContributors": [],
                    }
                )
                industries[sector_names[sector]] += value
        invested = sum(position["current_value_gbp"] for position in positions)
        cost = sum(position["total_cost_gbp"] for position in positions)
        account.update(
            fetched_at_utc=as_of.isoformat(),
            positions=positions,
            investments_value_gbp=invested,
            total_value_gbp=invested + cash,
            total_cost_gbp=cost,
            unrealized_profit_loss_gbp=invested - cost,
        )
        totals[code.lower()] = (invested + cash, cash)
    broker_path.write_text(json.dumps(broker), encoding="utf-8")

    # The fixture has no fund constituent files. Report only the direct exposure it covers.
    direct_value = sum(row["valueGbp"] for row in direct)
    cash_value = sum(cash for _, cash in totals.values())
    invested_value = sum(total for total, _ in totals.values()) - cash_value
    for row in direct:
        row["allocationPct"] = row["valueGbp"] / direct_value
    path = report / "lookthrough_metrics.json"
    lookthrough = json.loads(path.read_text(encoding="utf-8"))
    lookthrough.update(
        generatedAt=as_of.isoformat(),
        brokerAsOf=as_of.isoformat(),
        investedValueGbp=invested_value,
        cashValueGbp=cash_value,
        directValueGbp=direct_value,
        etfValueGbp=invested_value - direct_value,
        lookthroughValueGbp=direct_value,
        nonSecurityValueGbp=0,
        lookthroughCoveragePct=direct_value / invested_value,
        underlyingCount=len(direct),
        countryBasis="Synthetic demo · direct holdings",
        countryAllocation=[
            {
                "country": "United States",
                "valueGbp": direct_value,
                "allocationPct": 1,
                "isNonCountry": False,
            }
        ],
        industryBasis="Synthetic demo · direct holdings",
        industryAllocation=[
            {
                "industry": industry,
                "valueGbp": value,
                "allocationPct": value / direct_value,
                "isNonIndustry": False,
            }
            for industry, value in industries.items()
        ],
        positions=direct,
        fundPositions=funds,
    )
    path.write_text(json.dumps(lookthrough), encoding="utf-8")
    diluted_path = report / "diluted_cost_metrics.json"
    diluted = json.loads(diluted_path.read_text(encoding="utf-8"))
    diluted["holdings"][0].update(diluted_cost_gbp=180, diluted_cost_per_share_gbp=90)
    diluted_path.write_text(json.dumps(diluted), encoding="utf-8")
    return totals


def seed_sector_board(destination: Path, end: date) -> None:
    next_day = datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=UTC)
    store = SectorBoardStore(destination)
    _seed_sector_market(store, "us", next_day, SECTORS)
    _seed_sector_market(store, "eu", next_day, EU_SECTORS)


def _seed_sector_market(
    store: SectorBoardStore,
    market: SectorMarketCode,
    next_day: datetime,
    rows: tuple[tuple[str, str, str, str, int, float], ...],
) -> None:
    session = latest_session(market, next_day)
    if session is None:
        raise ValueError(
            f"Cannot find a {market.upper()} sector demo session for the requested date"
        )
    times = [session.open + (session.close - session.open) * (n / 24) for n in range(25)]
    groups = []
    for i, (code, name, symbol, company, pct_weight, pct_move) in enumerate(rows):
        change = pct_move / 100
        weight = pct_weight / 100
        groups.append(
            SectorGroup(
                key=code,
                name=name,
                weight=weight,
                change=change,
                member_count=1,
                breadth=SectorBreadth(
                    up=int(change > 0.0005),
                    flat=int(abs(change) <= 0.0005),
                    down=int(change < -0.0005),
                ),
                leader=SectorLeader(symbol=symbol, name=company, change=change),
                path=[
                    change * n / 24 + math.sin(n * math.pi / 24) * math.sin((n + i) / 3) * 0.003
                    for n in range(24)
                ]
                + [change],
                members=[
                    SectorMember(
                        symbol=symbol,
                        name=company,
                        change=change,
                        weight=weight,
                        research_ticker="BE" if symbol == "BE" else None,
                    )
                ],
            )
        )
    store.save(
        SectorBoard(
            market=market,
            session_date=session.date,
            as_of=session.close,
            fetched_at=session.close,
            complete=True,
            times=times,
            member_count=len(groups),
            priced_count=len(groups),
            source=SectorSource(
                universe=f"Synthetic {market.upper()} sector sample",
                fund="Trading Max demo",
                fund_ticker="",
                url="",
                as_of=session.date,
                prices="Synthetic",
            ),
            groupings=[SectorGrouping(kind="gics", groups=groups)],
        )
    )
