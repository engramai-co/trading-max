"""MSCI World USD price indices, grouped by current GICS codes."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class WorldIndustryIndex:
    gics: str
    code: int | None
    name: str
    name_zh: str

    @property
    def level(self) -> Literal["sector", "group"]:
        return "sector" if len(self.gics) == 2 else "group"

    @property
    def symbol(self) -> str | None:
        return f"^{self.code}-USD-STRD" if self.code else None


WORLD_INDUSTRY_INDICES = (
    WorldIndustryIndex("10", 106796, "Energy", "能源"),
    WorldIndustryIndex("15", 106797, "Materials", "原材料"),
    WorldIndustryIndex("20", 106798, "Industrials", "工业"),
    WorldIndustryIndex("25", 106799, "Consumer Discretionary", "非必需消费"),
    WorldIndustryIndex("30", 106800, "Consumer Staples", "必需消费"),
    WorldIndustryIndex("35", 106801, "Health Care", "医疗保健"),
    WorldIndustryIndex("40", 106802, "Financials", "金融"),
    WorldIndustryIndex("45", 106803, "Information Technology", "信息技术"),
    WorldIndustryIndex("50", 106804, "Communication Services", "通信服务"),
    WorldIndustryIndex("55", 106805, "Utilities", "公用事业"),
    # MSCI discontinued the old industry-group-derived series (106824) in 2023.
    WorldIndustryIndex("60", 132085, "Real Estate", "房地产"),
    WorldIndustryIndex("1010", 106806, "Energy", "能源"),
    WorldIndustryIndex("1510", 106807, "Materials", "原材料"),
    WorldIndustryIndex("2010", 106809, "Capital Goods", "资本品"),
    WorldIndustryIndex("2020", 106811, "Commercial & Professional Services", "商业与专业服务"),
    WorldIndustryIndex("2030", 106810, "Transportation", "运输"),
    WorldIndustryIndex("2510", 106812, "Automobiles & Components", "汽车与零部件"),
    WorldIndustryIndex("2520", 106902, "Consumer Durables & Apparel", "耐用消费品与服装"),
    WorldIndustryIndex("2530", 106814, "Consumer Services", "消费者服务"),
    WorldIndustryIndex(
        "2550", 106815, "Consumer Discretionary Distribution & Retail", "非必需消费品分销与零售"
    ),
    WorldIndustryIndex(
        "3010", 106838, "Consumer Staples Distribution & Retail", "必需消费品分销与零售"
    ),
    WorldIndustryIndex("3020", 106817, "Food, Beverage & Tobacco", "食品、饮料与烟草"),
    WorldIndustryIndex("3030", 106813, "Household & Personal Products", "家庭与个人用品"),
    WorldIndustryIndex("3510", 106820, "Health Care Equipment & Services", "医疗设备与服务"),
    WorldIndustryIndex(
        "3520", 106819, "Pharmaceuticals, Biotechnology & Life Sciences", "制药、生物科技与生命科学"
    ),
    WorldIndustryIndex("4010", 106821, "Banks", "银行"),
    WorldIndustryIndex("4020", 106823, "Financial Services", "金融服务"),
    WorldIndustryIndex("4030", 106822, "Insurance", "保险"),
    WorldIndustryIndex("4510", 106826, "Software & Services", "软件与服务"),
    WorldIndustryIndex("4520", 106825, "Technology Hardware & Equipment", "科技硬件与设备"),
    WorldIndustryIndex(
        "4530", 778418, "Semiconductors & Semiconductor Equipment", "半导体与半导体设备"
    ),
    WorldIndustryIndex("5010", 106827, "Telecommunication Services", "电信服务"),
    WorldIndustryIndex("5020", 106816, "Media & Entertainment", "媒体与娱乐"),
    WorldIndustryIndex("5510", 106828, "Utilities", "公用事业"),
    # No verified Yahoo USD price series for either current Real Estate group.
    WorldIndustryIndex(
        "6010", None, "Equity Real Estate Investment Trusts", "权益型房地产投资信托"
    ),
    WorldIndustryIndex("6020", None, "Real Estate Management & Development", "房地产管理与开发"),
)
