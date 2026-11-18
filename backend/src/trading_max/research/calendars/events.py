"""Date precision, identifiers and bilingual names for published calendar entries."""

from calendar import monthrange
from datetime import date, datetime, time
from hashlib import sha256
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from .catalog import CalendarSource


def window_bounds(day, end=None):
    """Month-precision events overlap a window without claiming a particular day."""
    first, last = str(day), str(end or day)
    if len(first) == 7:
        first += "-01"
    if len(last) == 7:
        year, month = map(int, last.split("-"))
        last += f"-{monthrange(year, month)[1]}"
    return first, last


class CalendarEvent(BaseModel):
    id: str
    market: str
    publisher: str
    title_en: str
    title_zh: str
    date: date | str
    end_date: date | str | None = None
    instant: datetime | None = None
    timezone: str
    status: Literal["provisional", "finalised", "cancelled", "postponed"]
    source_url: str
    time_source_url: str | None = None
    credit: str
    licence_url: str | None = None


def event(
    source: CalendarSource,
    en: str,
    zh: str,
    day: date | str,
    *,
    identity=None,
    clock: time | None = None,
    end=None,
    status="finalised",
    url=None,
    time_source_url=None,
) -> CalendarEvent:
    digest = sha256(
        f"{source.market}|{source.publisher}|{identity or (en, day)}".encode()
    ).hexdigest()[:24]
    return CalendarEvent(
        id=digest,
        market=source.market,
        publisher=source.publisher,
        title_en=en,
        title_zh=zh,
        date=day,
        end_date=end,
        instant=datetime.combine(day, clock, ZoneInfo(source.zone)) if clock is not None else None,
        timezone=source.zone,
        status=status,
        source_url=url or source.url,
        time_source_url=time_source_url,
        credit=source.credit,
        licence_url=source.licence_url,
    )


# Calendar metadata only. Each publisher's original title is also preserved.
FAMILIES = (
    ("adjusted hicp", "经季节调整的调和消费者价格指数"),
    ("producer price", "生产者价格指数"),
    ("house price", "房价指数"),
    ("consumer price", "消费者价格指数"),
    ("inflation", "通胀数据"),
    ("hicp", "调和消费者价格指数"),
    ("gross domestic product", "国内生产总值"),
    ("gdp", "国内生产总值"),
    ("personal income and outlays", "个人收入与支出"),
    ("retail", "零售数据"),
    ("durable goods", "耐用品订单"),
    ("industrial production", "工业生产"),
    ("unemployment", "失业数据"),
    ("employment", "就业数据"),
    ("job openings", "职位空缺"),
    ("job vacancy", "职位空缺"),
    ("labour", "劳动力市场数据"),
    ("wages", "工资数据"),
    ("balance of payments", "国际收支"),
    ("trade", "贸易数据"),
    ("construction", "建筑业数据"),
    ("manufactur", "制造业数据"),
    ("inventor", "库存数据"),
    ("housing", "住房数据"),
    ("home sales", "住房销售"),
    ("government debt", "政府债务"),
    ("government deficit", "政府赤字"),
    ("money", "货币统计"),
    ("services", "服务业数据"),
    ("industrial activity", "工业活动"),
    ("foreign direct investment", "外国直接投资"),
    ("population", "人口统计"),
    ("business", "企业统计"),
    ("economic sentiment", "经济景气指数"),
    ("sector accounts", "部门账户"),
    ("investment", "投资数据"),
)


def family(title: str) -> str | None:
    lowered = title.casefold()
    return next((zh for substring, zh in FAMILIES if substring in lowered), None)
