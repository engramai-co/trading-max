"""Wire-shaped inputs and results for the Returns & Risk calculations."""

from typing import Literal, NotRequired, Required, TypedDict

type Range = Literal["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "2Y", "ALL"]
type Scope = Literal["total", "invest", "isa", "household", "cfd"]
type Number = int | float
type NullableNumber = Number | None
type Series = list[float | None]


class NavPoint(TypedDict, total=False):
    """The history API's camelCase record; the endpoint omits absent fields."""

    date: Required[str]
    intraday: bool
    valuationSource: Literal["broker", "reconstructed"] | None
    flowStatus: Literal["daily_official", "verified", "unverified"]
    invest: NullableNumber
    isa: NullableNumber
    cfd: NullableNumber
    total: NullableNumber
    household: NullableNumber
    investTwr: NullableNumber
    isaTwr: NullableNumber
    totalTwr: NullableNumber
    investDrawdown: NullableNumber
    isaDrawdown: NullableNumber
    totalDrawdown: NullableNumber
    cfdProxyDrawdown: NullableNumber
    investNetContributionsGbp: NullableNumber
    isaNetContributionsGbp: NullableNumber
    totalNetContributionsGbp: NullableNumber
    cfdNetContributionsGbp: NullableNumber
    householdNetContributionsGbp: NullableNumber
    investNetPnlGbp: NullableNumber
    isaNetPnlGbp: NullableNumber
    totalNetPnlGbp: NullableNumber
    cfdNetPnlGbp: NullableNumber
    householdNetPnlGbp: NullableNumber
    investPnlDrawdownGbp: NullableNumber
    isaPnlDrawdownGbp: NullableNumber
    totalPnlDrawdownGbp: NullableNumber
    cfdPnlDrawdownGbp: NullableNumber
    householdPnlDrawdownGbp: NullableNumber
    householdInternalTransferCounterflowGbp: NullableNumber
    householdUnmatchedInternalTransferGbp: NullableNumber
    householdTransferMatchStatus: Literal["verified", "partial"] | None
    cfdOvernightInterestGbp: NullableNumber
    cfdNetRealisedPnlGbp: NullableNumber
    cadenceSeconds: int | None
    priceCadenceSeconds: int | None
    modelPriceCadenceSeconds: int | None
    includesExtendedHours: bool | None
    modelAt: str | None
    investModelValueGbp: NullableNumber
    isaModelValueGbp: NullableNumber


class HistoryInput(TypedDict):
    runId: str
    brokerAsOf: str
    dataRevision: str
    nav: NotRequired[list[NavPoint]]
    intradayNav: NotRequired[list[NavPoint]]


class HistorySelection(TypedDict):
    range: Range
    scope: Scope


class HistoryWindow(TypedDict, total=False):
    startDay: str
    endDay: str


class CalendarTimeline(TypedDict):
    categories: list[str]
    rowIndexes: list[int | None]
    anchors: list[bool]
    displayIntervalMinutes: NotRequired[int]


class CoverageRange(TypedDict):
    start: str
    end: str
    startIndex: int
    endIndex: int


class Coverage(TypedDict):
    categoryCount: int
    firstObservedAt: str | None
    firstObservedIndex: int | None
    gaps: list[CoverageRange]
    lastObservedAt: str | None
    lastObservedIndex: int | None
    observedCount: int
    observedRanges: list[CoverageRange]
    status: Literal["complete", "partial", "single", "empty"]


class PortfolioHistory(HistoryWindow):
    points: list[NavPoint]
    source: Literal["intraday", "daily"]
    fallback: bool
    timeline: CalendarTimeline
    coverage: Coverage
    pendingCashFlows: bool
    cashFlowCutoffAt: str | None
    latestObservationAt: str | None
    reconstructedCount: int
    carriedCfdValue: NullableNumber


class DrawdownObservation(TypedDict):
    date: str
    estimated: bool


class MoneyDrawdownEpisode(TypedDict):
    peak: DrawdownObservation
    trough: DrawdownObservation
    recovery: DrawdownObservation | None


class Money(TypedDict):
    opening: float | None
    ending: float | None
    contributions: float | None
    pnl: float | None
    maxDrawdown: float | None
    drawdownEpisode: MoneyDrawdownEpisode | None
    pnls: Series
    pnlPercents: Series
    drawdown: Series
    drawdownPercents: Series
    periodFlows: Series
    valueChanges: Series
    valueChangePercents: Series


class PreparedAmounts(TypedDict):
    history: PortfolioHistory
    money: Money


class PreparedHistory(PreparedAmounts):
    runId: str
    dataRevision: str
    sourceCount: int


class IndexedDrawdownEpisode(TypedDict):
    peak: int
    trough: int
    depth: Number
    recovery: int | None
    state: Literal["recovered", "open", "interrupted"]


class ReturnPeriod(TypedDict):
    key: str
    start: str
    end: str
    value: float | None
    partial: bool


class ReturnPeriods(TypedDict):
    years: list[str]
    months: list[ReturnPeriod]
    quarters: list[ReturnPeriod]
    annual: list[ReturnPeriod]


class BenchmarkPricePoint(TypedDict):
    date: str
    close: NotRequired[NullableNumber]
    price: NotRequired[NullableNumber]


class BenchmarkLine(TypedDict):
    name: str
    values: list[float]


class BenchmarkComparison(TypedDict):
    points: list[NavPoint]
    comparisons: list[BenchmarkLine]
    missing: bool
